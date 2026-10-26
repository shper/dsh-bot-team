# Runtime research — mapping bot_team "bots" onto real DSH agents

Install: DSH 0.2.1-rc.3 (desktop). Packages under `D = /Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai`.
Method: host `cordis_inspect_query` (Service/Event/Config) for live contracts + package `README.md`/`lib/index.js` read via the `read` tool.
Evidence limit: shipped packages omit `lib/types/**/*.d.ts` (`read D/dsh-agent/lib/types/index.d.ts` fails; same for agent-loop/agent-preset), so exact declarations
come from the live inspect provider's typert reflection; behaviour from READMEs and compiled `lib/index.js` (line refs below).

## 1. Agent creation — exact options and what a plugin can choose

`Service.listService("agentLoop")` / `"agents"`:
```ts
interface AgentOptions { provider?: string; model?: string; reasoningEffort?: ReasoningEffortId; maxTokens?: number }
interface CreateAgentOptions { readonly sessionId: SessionId; readonly parentAgent?: Agent;
  readonly meta?: { readonly cwd?: string; readonly parentSession?: SessionId; readonly isSeeded?: boolean;
    readonly origin?: 'subagent'; readonly delegationDepth?: number; readonly agentPreset?: string };
  readonly inheritedEventCount?: SessionLogOffset; readonly seed?: readonly SessionEvent[];
  readonly agentOptions?: AgentOptions; readonly signal?: AbortSignal; readonly setup?: AgentSetup }
type AgentSetup = (agentCtx: Context, agent: Agent) => AgentSetupCommit | Promise<AgentSetupCommit | void> | void;
interface AgentSetupCommit { commit(): void }
interface ResumeAgentOptions { readonly resumeSessionId: SessionId; readonly parentAgent?: Agent;
  readonly agentOptions?: AgentOptions; readonly signal?: AbortSignal; readonly setup?: AgentSetup }
interface AgentHandle { agent: Agent; dispose(): Promise<void> }
interface AgentFactory { createAgent(ownerCtx, options): Promise<AgentHandle>; resume(ownerCtx, options): Promise<AgentHandle> }
// ctx.agents: create(options) → AgentHandle; resume(options); get(id); list(); roots(); isOwnedBy(id, owner)
// ctx.agentLoop: create(id, options?, meta?); createAgent(ownerCtx, options); resume(ownerCtx, options)
```
Evidence: `D/dsh-agent/README.md:30-43` (`parentAgent` = runtime child; omit for a runtime root), `D/dsh-agent-loop/README.md:59-69`,
`D/dsh-agent-loop/lib/index.js:1893-1941` (createAgent → setup runs before publish, `parentAgent` → `agents.enter`).
- **Per-bot model**: yes, `agentOptions:{provider, model, reasoningEffort?, maxTokens?}`; loop validates the route via `ctx.llm.prepareCall`
  and records it in `request/header` (`D/dsh-agent-loop/README.md:91-95`).
- **Per-bot preset**: set `meta.agentPreset` (recorded in `SessionHeader.agentPreset`) and bind in `setup` with
  `await ctx.agentPresets.mount(agentCtx, presetId)` — exactly what the GUI does: `D/dsh-api-session-controller/lib/index.js:351-364`
  `composeAgent()` → `setup: (agentCtx, agent) => { installSelection(agent); await presets.mount(agentCtx, resolvedId) }`, then `:511-526`
  passes `meta.agentPreset`. Direct `ctx.agents.create` callers must mount it themselves.
- **cwd / parent**: `meta.cwd` (absolute); `parentAgent` for a runtime child, plus `meta.parentSession` + `origin:'subagent'` +
  `delegationDepth` for durable lineage. `ownerCtx` (calling fiber) owns the lifecycle.
- **Initial message / title / session id**: `sessionId` is caller-supplied; no initial-message field — drive with `agent.followup(...)`
  after creation (or `seed` events). Title is not a creation option; it is a session event folded by `ctx.sessionTitle` /
  `sessionController.rename` (ordinary sessions only).
- **Root vs Web-GUI list**: `agents.roots()` = no owning agent → ordinary sidebar row (`SessionSummary` has no `origin`). Children carry
  `SessionHeader.parentSession/origin:'subagent'`; `SessionSummary` exposes `parentSessionId?/origin?` and the subagent UI nests them under the
  parent catalog. The API session controller fences subagent-owned sessions from ordinary remotes (`apiSessionSubagentOwnershipError`,
  `session/agent-busy`; `D/dsh-api-session-controller/lib/index.js:365-368,394,419`).
- **Without a calling user session?** Yes: `ctx.agents.create({sessionId, ...})` needs only the caller's Cordis context for ownership. For a GUI group,
  the host half can pass `sessionController.resolveAgent(sessionId)` (ordinary session) as `parentAgent`, or create a root "group container" via
  `sessionController.create({cwd, agentPreset})`.

## 2. Agent control and observing bot replies

Public `Agent` surface (documented; the inspect projection only shows the base `{ readonly id: SessionId }`):
```ts
agent.ctx        // agent-scoped Context: tools, prompt sections, listeners, restrictions (unwinds on dispose)
agent.session    // Session: durable log (.header, .append, .snapshotEvents, .deriveMessages, projections)
agent.status     // 'idle' | 'running'
agent.inbox      // structural Inbox: nextTurn/nextStep, append/prepend/replace/remove/clear/splice
agent.followup({ content, source })   // queue ordinary next-turn prompt AND wake the driver
agent.steer({ content, source })      // next-step input at nearest step boundary AND wake
agent.inject({ content, source })     // model-facing context WITHOUT waking; lands in next admitted step
agent.cancel(cause?, { keepInbox?: boolean })   // abort active activity; default also clears pending inbox
agent.whenIdle()                      // Promise resolved after whole agent quiescence
```
Evidence: `D/dsh-agent/README.md:45-67` (followup/steer/inject/whenIdle semantics), `:174-178` (cancel clears inbox by default);
`Event.listEvents("agent/status")` → `AgentStatus = 'idle' | 'running'`.
**Turn-completion observation** (event-driven, no polling): `ctx.on('session/event', (session, event) => …)`, contract
`'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void` (post-commit). Filter `session.id`, then use
`SessionEventMap` (verbatim from `Service.listService("sessions")`):
```ts
'turn/end': { turn: number; reason: TurnEndReason }  // completed|aborted|blocked|error|max-tokens|interrupted|forked
'assistant/message': { turn; step; message: AssistantMessage; stream: AssistantStreamRecord[];
                       usage?: TokenUsage; interrupted?: true }
'assistant/attempt': { turn; step; stream: AssistantStreamRecord[] }   // retried/aborted attempts
'user/message': UserMessage
```
Final bot text = last `assistant/message` before a `turn/end` with `reason.kind === 'completed'`: `data.message.content` text blocks
`{ type:'text', text }` (`D/dsh-agent/README.md:50-52`). Live typing: `'agent/assistant-stream'(payload:{agent, frame: AssistantStreamFrame})`
with `AssistantStreamFrame = {type:'start',attemptId,revision,turn,step} | {type:'chunk',…,index,time,chunk:StreamChunk} |
{type:'end',…,index,outcome:{kind:'committed',eventType:'assistant/message'|'assistant/attempt',seq} | {kind:'abandoned'}}`; presentation-only,
the durable `assistant/message` is the replay source (`D/dsh-agent/README.md:67`). Non-polling waits: `await agent.whenIdle()` or await a
`turn/end` listener; managed tasks have `activation.result` and `ctx.subagents.waitForChildren(parent)` (§6).

## 3. Model selection

```ts
ctx.agentDefaultModel.currentSelection(): ModelSelection          // deployment default (detached)
ctx.agentDefaultModel.saveSelection(next: ModelSelection)         // profile write via config editor
// ModelSelection = { provider: string; model: string; reasoningEffort?: ReasoningEffortId }
//   (D/dsh-agent-default-model/README.md:48-57; SessionSelectModelRequest extends ModelSelection)
ctx.sessionController.modelCatalog(): Promise<ModelCatalog>
// = { default: ModelSelection; routableProviders: string[];
//     groups: {id,name,models:{id,name,description?,reasoning?:{efforts,defaultEffort?}}[]}[]; failures: [] }
ctx.llm.listProviders(): LlmProviderInfo[]; await ctx.llm.listModels(provider): LlmModelInfo[];
await ctx.llm.resolveModelInfo(provider, model): LlmResolvedModelInfo
```
Per-session override: `ctx.sessionController.selectModel({sessionId, provider, model, reasoningEffort?})` validates against the live catalog,
resumes an ordinary Session, appends durable `model/selection`, and calls `installModelSelection(agent.ctx, selection)` from
`@deepseek-ai/dsh-agent` (adds a `[model changed: …]` notice on the next request); default save runs in background
(`D/dsh-api-session-controller/README.md:89-91`, implementation `lib/index.js:303,312-315`; notice rule `D/dsh-agent/README.md:143`).
For a live bot whose model changes after creation, intercept the per-step waterfall `'agent/request'(payload, next): Promise<LlmCallConfig>`
and return `{ ...await next(), provider, model, reasoningEffort }` (`Event.listEvents`).
`subagentModelSelection.current()` is the host delegation setting; tool `agentOptions` / `provider.agentRouteDefaults` overlay it
(`D/dsh-tool-subagent/README.md:45-53,74-78`).
Answers: per-bot model = creation-time `agentOptions` (primary), dynamic = `agent/request` interceptor; `sessionController.selectModel` is for
ordinary GUI sessions only (fenced from subagent-owned sessions, §1). **A preset cannot pin a model** — `PresetDefinition` has no model field.
Dropdown data: use `sessionController.modelCatalog()`.

## 4. Agent presets

```ts
ctx.agentPresets.register(definition: PresetDefinition): Promise<() => Promise<void>>
resolve(id?): Promise<AgentPreset>; list(); mount(ctx: Context, id?): Promise<AgentPreset>
select(agent: Agent, agentPreset: string): Promise<string>   // blank session only; logs agent-preset/selected
composeFrom(ctx, parent); composedPreset(ctx); serviceFor(agent, name); recompose(ctx, id); acquireScope(id?)
interface PresetDefinition { id: string; name?: string; description?: string; order?: number;
  plugins: readonly (Omit<EntryOptions,'id'|'disabled'> & { id?; disabled? })[] }
```
Evidence: `Service.listService("agentPresets")`; YAML row shape `{id, name?, description?, order?, plugins}`
(`D/dsh-agent-preset/README.md:28-48`); presets are child Cordis plugin lists, eagerly loaded, edits affect new Agents
(`D/dsh-agent-preset-registry/README.md:28-60`).
- **Plugin-defined preset**: yes — `ctx.agentPresets.register({id, plugins})`; shipped alternative is a bundle patch inserting a
  `@deepseek-ai/dsh-agent-preset` row (`D/dsh-agent-preset-registry/README.md:48`).
- **Persona / tools / model**: persona text yes via a `@deepseek-ai/dsh-system-prompt` row config (`personaPrefix`/`personaSuffix`,
  `D/dsh-system-prompt/README.md:35-52`) or any section-registering plugin; tool set yes via tool rows/restriction plugins; **model no** (§3).
- **Select at creation**: `meta.agentPreset` + `setup` mount (§1); `sessionController.create({agentPreset})`; blank live agent via
  `agentPresets.select(agent,id)`. `select` refuses after a turn started (`agent-preset/locked`); choice is durable
  (`agent-preset/selected`, projection `agentPreset`; `D/dsh-agent-preset-registry/lib/index.js:46-58,750-770`). Live Agents keep their
  mounted revision; new Agents read current definitions.

## 5. Persona / instructions (AGENT.md, SOUL.md)

**AGENTS.md**: `@deepseek-ai/dsh-agent-instructions` injects one durable baseline user-role message from `$DSH_HOME/AGENTS.md`,
`<agentsHome>/AGENTS.md`, then the project chain (`AGENTS.md`, `CLAUDE.md`, optional local overlays) broad→specific; candidates configurable
(`instructionFileCandidates`, default `['AGENTS.md','CLAUDE.md']`). Refresh is **touch-driven only** (first-party read/write/edit reaching a deeper
dir, or resume) — no watcher (`D/dsh-agent-instructions/README.md:28-40,52-68,219-221`). There is **no SOUL.md** in shipped packages and no
per-agent instruction-file option; `AGENT.md` (singular) is not a default candidate.
**General injection API** — `ctx.systemPrompt` (Service contract):
```ts
section(section: PromptSection): () => void        context(context: PromptContext): () => void
variable(name, provider: (ctx: AssembleContext) => string | undefined): () => void
tools(provider); suppressRuntimeContext(); getSectionOrder(name); getContextOrder(name);
refreshContext(assembly, context?); assemble(context?): Promise<PromptAssembly>
interface PromptSection { readonly name: string; readonly order: number;
  readonly text: string | ((context: AssembleContext) => string); readonly interpolate?: boolean; readonly complete?: boolean }
interface PromptContext { readonly name; readonly order; readonly text: string | ((context: AssembleContext) => string);
  readonly interpolate?; readonly required? }
```
Registering through `agent.ctx` scopes to that agent; same-name scoped shadows global; text providers are evaluated per assembly
(`D/dsh-system-prompt/README.md:28,54-78`; `AssembleContext = { scope?, signal? }`).
**Recommended bot persona**: in `CreateAgentOptions.setup`, `agentCtx.systemPrompt.section({ name:'bot-team:persona:'+botId, order:100,
text: () => readBotPersonaFile(botId) })` — the function re-reads the user-edited file at each assembly, so edits apply on the bot's next step
without restart (cost: prompt-prefix/KV-cache invalidation, `D/dsh-system-prompt/README.md:152-168`). Alternatives: preset rows at creation
(stable composition, no hot edit); `agent.inject()` for per-task durable user-role context; cwd-per-bot `AGENTS.md` (user-editable but stale
until resume/touch); `systemPrompt.context()` text function (same reload, delivered as sourced user-role snapshot). DSH deliberately has no
end-user prompt-editing API (`D/dsh-system-prompt/README.md:176-178`), so bot_team owns that UX.

## 6. Subagent service — exact provider contract; should bots use it?

```ts
// ctx.subagents
registerProvider(provider: SubagentProvider): () => void; getProvider(name); list()
startActivation(spec: SubagentActivationSpec & { childId: SessionId }): Promise<SubagentActivation & { messageId }>
sendMessage(sender: Agent, targetId: SessionId, content: ContentBlock[], options: { signal }): Promise<MessageId>
interrupt(targetSessionId, authority); waitForChildren(parent: Agent): Promise<boolean>
listChildren(parentSessionId, signal?): Promise<SubagentCatalogEntry[]>; listDescendants(rootSessionId, signal?)
drainChildren(parent, childIds); drainDescendants(parents); prompt(request); interruptByParent(child, parent, 'continuable')
interface SubagentProvider { readonly name: string; readonly capabilities: SubagentCapabilities;
  readonly inheritsParentContext: boolean;
  readonly agentRouteDefaults?: Readonly<{ provider: string; model: string }>;
  start?(request: ResolvedSubagentStartRequest): Promise<SubagentRun>;                 // external backend
  prepareContinuable?(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec> } // local backend
// SubagentCapabilities = { agentOptions, agentPreset, outputSchema, depthLimit: boolean }
interface SubagentStartRequest { cwd?; agentPreset?; label?; prompt: ContentBlock[]; parent: Agent; signal;
  agentOptions?: AgentOptions; outputSchema?; maxDepth? }
interface ContinuableCreateRequest { cwd; sessionId; parent: Agent; signal }
interface ContinuableCreateSpec { seed?: readonly SessionEvent[] }
interface SubagentActivation { childId; messageId?; result: Promise<SubagentResult>; dispose() }
```
Evidence: `Service.listService("subagents")`; `D/dsh-subagent/README.md:59-73` (local vs external, presets, messaging, discovery,
`maxDepth` default 1, `maxActiveSubagents` default 8), `:91-113` ("Local providers supply only `prepareContinuable()`"),
`D/dsh-subagent-spawn-in-process/README.md:46-56` (provider `spawn`; independent `agentPreset`; inherits cwd/provider/model unless
`request.agentOptions` overrides), `D/dsh-subagent-fork-in-process/README.md:50-58` (`fork` seeds completed parent turns).
- **Own SubagentProvider?** Yes (`registerProvider`, effect-scoped), but a local provider only returns a seed — the manager builds the child from the
  caller's `SubagentStartRequest`, so the provider cannot add model/persona by itself. Call `startActivation({provider:'spawn', delivery:'caller',
  request:{parent, prompt, agentOptions, agentPreset}})` for managed tasks; for a persistent chat bot, create once via `ctx.agents.create` and drive
  with `followup/steer` (activations are per-task, capacity-limited, and `delivery:'parent'` posts completion notices into the parent).
- **Presentation**: children are not roots; `SessionHeader.parentSession/origin:'subagent'` + parent-owned `subagent/catalog` projection make them
  discoverable under the parent (`listChildren`/`listDescendants`), external children are leaves; cold resume needs persistence + Session query
  (`D/dsh-subagent/README.md:61-69,139-141`). API session controller refuses to manage them as ordinary sessions (§1), so bot_team drives them
  through Agent/subagent APIs, not GUI session remotes.
- **Do not reuse Team as-is**: live `@deepseek-ai/dsh-experimental-agent-team` is the closest precedent (Lead + durable child teammates + roster/tasks),
  but `SpawnTeammateRequest` is only `{name, description, prompt, context:'fresh'|'fork', provider, signal}` — no per-teammate model/preset/persona
  (`Service.listService("agentTeams")`; `D/dsh-experimental-agent-team/README.md:60-64,126`). Borrow the durable-child pattern, not the service.

## Recommendation

Bot = one durable child Agent created by our Host plugin: `ctx.agents.create({ sessionId: minted, parentAgent: <group owner Agent>,
meta:{ cwd, parentSession: owner.id, origin:'subagent', delegationDepth:1, agentPreset? }, agentOptions:{provider, model}, setup })`; `setup` =
(1) `agentPresets.mount(agentCtx, presetId)` if we ship a preset, (2) `agentCtx.systemPrompt.section(...text: () => readBotFiles(botId))` for the
SOUL/persona reload, (3) optional `agentCtx.on('agent/request', …)` dynamic model pin, (4) optional `agentCtx.tools.restrict(...)` tool set. Drive with
`agent.followup`/`steer` (wake) or `inject` (no wake); observe with `ctx.on('session/event')` (`assistant/message` + `turn/end.completed`), live
typing with `agent/assistant-stream`; keep the `AgentHandle` for `whenIdle()` and teardown. The group page is a Client plugin whose Host half exposes
`@Remote` methods; it can resolve the human session's live Agent via `sessionController.resolveAgent(sessionId)` and mint bots as its children, or manage
an ordinary "group container" via `sessionController.create({cwd, agentPreset})`.
Risks: (1) children die with the parent Agent — mint stable `sessionId`s and `ctx.agents.resume` on plugin start; (2) activation capacity/depth limits if
we use activations (`maxActiveSubagents` 8, `maxDepth` 1); (3) subagent-owned sessions are fenced from GUI session remotes — all bot control lives in our
plugin API; (4) persona edits invalidate prompt-prefix cache; (5) full Agent `.d.ts` not shipped — pin 0.2.1-rc.3 and re-run inspect on upgrade.

## Open questions

1. Which parent owns the bots: the human session (nested under its subagent UI, fenced from GUI session APIs) vs a dedicated root "group container" session
   (bots as its children; sidebar filtering needed) vs root bots (visible in sidebar)? Affects isolation, teardown and list UX.
2. `followup` (own turn per bot) vs `steer` (shared turn) for multi-bot  fan-out, and ordering/injection semantics when several bots are @-mentioned in one message.
3. Should the group surface reuse `sessionController.follow` (carries durable records + `assistant-stream` frames, `SessionFollowFrame`/`SessionAssistantStreamFrame`)
   instead of a custom Host stream? Needs a client-side Session address for a child.
4. Per-bot tool UX: preset-per-bot vs `ctx.tools.restrict` on `agent.ctx`; confirm desired model/tool matrix before implementation.
5. Persona file convention/format (AGENT.md/SOUL.md are our conventions; DSH has no SOUL.md) and reload strategy — per-assembly function read vs
   `ctx.fs.watch` + section re-registration; how mid-turn edits surface.
