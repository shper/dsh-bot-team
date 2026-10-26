# bot_team — durable state & orchestration research (design phase)

Build: DSH 0.2.1-rc.3, macOS Desktop, checkout `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/`.
Evidence from `node_modules/@deepseek-ai/*/README.md` + `lib/index.js` (JSDoc) read through the asar, plus live
`cordis_inspect_query` Service/Event/Config results. Nothing installed/configured. This profile already mounts
`storage`, `storage-json`, `storage-domain`, `session-projection-cache`, `session-persistence-jsonl`, `subagent`,
`subagent-spawn-in-process`, `agent-team`.

## 1. Storage decision: plugin-owned domain vs session log

### 1.1 Domain form (`@deepseek-ai/dsh-storage-domain`, `ctx.storageDomain`)
Exact live contract:
```ts
async open<S extends DomainSpec>(spec: S): Promise<Domain<S>>; get(name): DomainImpl|undefined; closeAll(): Promise<void>
interface Domain<S> { readonly name: string; readonly global: DomainGlobalHandleOf<S>
  table<N extends keyof S['tables'] & string>(name: N): KvTable<TableKeyOf<S,N>, TableValueOf<S,N>>; close(): Promise<void> }
interface KvTable<K,V> { get(key: K): V|undefined; entries(): IterableIterator<[K,V]>; keys(): IterableIterator<K>
  readonly size: number; put(key: K, value: V): Promise<void>; delete(key: K): Promise<boolean>
  update(key: K, fn: (current: V)=>V): Promise<V> }
interface DomainSpec { name: string; version: number; layout?: 'single'|'per-record'
  compatibleVersions?: readonly number[]; invalidRecords?: 'backup-and-skip'
  global?: { schema: ZodType<G>; initial: G }                 // global schema must reject null
  tables: Record<string, { valueSchema: ZodType<V> }> }       // built via domainTable(schema)
// defined with defineDomain(spec) — validates name/version/table names at module load; records are zod
```
Semantics: memory authoritative, medium durable; **one per-domain write chain** serializes `put/delete/update/global.set`;
each write awaits backend durability first, then mutates memory, then emits one `domain/changed` in write order (a rejected
backend write leaves memory untouched). `update()`'s transform runs at its chain slot, so read-modify-write is serialized,
**but there is no per-record expected-revision/CAS argument, no cross-table transaction, no secondary index, no
multi-segment key**; reads are synchronous immutable plain values. Event is in-process only:
`'domain/changed'(change: DomainChanged)`, after durability; a second host process sees nothing. Any package with
`storageDomain` injected may define/open its own domain name (one open per name, `already-open`); routing is the domain
plugin's config `{ backend, routes }`. On restart `open` re-validates every record (`invalid-record` names table+key); a
stored version ≠ `spec.version` rejects `version-mismatch` (no migration; `compatibleVersions` = read-compat only). Other
errors: `facet-unsupported`, `missing-key`, `closed`. The caller owns `Domain.close()`. Precedent:
`session-projection-cache` owns a `per-record` `session_projcache` domain. No model/token effect.

**Verdict:** groups, member definitions (name/model/persona) and transcript records belong in one plugin domain, e.g.
`defineDomain({ name: 'bot_team', version: 1, layout: 'per-record', tables: { groups, members, messages } })`. One record
per group (hot read + `nextMessageSeq`), one per member, one per message (`msg-<n>`/ULID). Board/task CAS must be
implemented as serialized `update()` on one record plus an explicit `expectedRevision` checked inside the transform
(single-process topology is the only supported one anyway).

### 1.2 Session-log alternative: what a plugin may append
`Session.append<T extends SessionEventType>(type, data, ...opts)` accepts **only** `SessionEventMap` types; for surface
types the only opts are `SurfaceIntent` (`surfaceOp`). There is **no `ignorable` option**, and an unknown stored event is
refused on reopen unless its envelope has `ignorable: true` (`@deepseek-ai/dsh-session-persistence`: fail-closed reads).
Custom event types are not an extension point.
`appendPluginRecord(session, type, data)` exists (`@deepseek-ai/dsh-session` §"Write experimental plugin records"), writes
`ignorable:true` records named `plugin:<owner>/<record>` declared in `PluginRecordMap` via `@deepseek-ai/dsh-session/types`,
but is **reserved for DSH's `packages/experimental/`** — "Plugins outside this repository must not call it either,
although no repository check can inspect them"; Session-format migration keeps those records only best-effort.
`cordis-plugin-development/references/practices.md` (L21) repeats: no new event types; derive from existing events or use
a storage service.
What agent-team actually does (`@deepseek-ai/dsh-experimental-agent-team/lib/index.js`): `TeamJournal.appendAndFlush`
does `root.session.append.bind(root.session)(type, data)` then `await ctx.sessions.flush(root.session)`
(L108–161). `team/member`/`team/task` are **DSH-internal experimental session vocabulary** (its projection decodes them,
L533–535, L727–737); the package may do this because it ships inside DSH's experimental subtree — not a mechanism a
profile-installed third-party plugin gets. `ctx.agentTeams` is the public façade (`spawnTeammate`, `sendMessage`, task CAS)
but is bound to "the exact live Lead Session", one implicit Team per root session.

### 1.3 Recommendation
- **Groups/members/personas/config → `bot_team` domain** (durable, validated, change events, no tokens, no log pollution).
- **Transcript**, two feasible designs:
  - **T1 (first version): domain `messages` table** — records `{id, groupId, seq, speaker, role, text, botSessionId?,
    time, replyTo?}`. Full control of speakers/mentions/threads; no model-visible pollution. Cost: the Web UI cannot read
    it through the built-in Session store, so bot_team must add its own host→client channel (§2.3).
  - **T2: write into a real "group host Session" log** using standard surface events — human/bot lines as
    `user/message` from `createUserMessage({content, source})` appended with `{ surfaceOp: 'append' }` (bot lines carry an
    `agent-message` source, agent-team's own peer-message convention). Free: renders in Conversation UI, persists in JSONL,
    forks/resumes. Cost: lines become the session's model-visible history (tokens/compaction), bot lines show as ordinary
    user bubbles (same documented limitation as agent-team), and we cannot safely fabricate `assistant/message` (needs
    provider `source` + exact compact stream).
- **Do not** use `appendPluginRecord` or invent `SessionEventMap` types.

## 2. Projection & client publication

### 2.1 `ctx.sessionProjections` (`@deepseek-ai/dsh-session-projection`)
```ts
register<K,S>(definition: ProjectionDefinition<K,S>): () => void
// { key, stateVersion, stateSchema: ZodType<S>,
//   init(header: SessionHeader, inheritedEventCount: SessionLogOffset): S,
//   apply(state: S, event: SessionEvent): S,          // synchronous; same reference = ignored event
//   wire?: { viewSchema: ZodType<View>; view(state: S): View } }  // present ⇒ client-visible
stateOf(session, key): S|undefined
snapshot(session, keys?): { asOfSeq: SessionSeqCursor; values: Partial<SessionProjectionMap> }
onChanged((session,key,value,seq)=>void): () => void
checkpoint(session): Record<key,{ver,seq,val}>; restoreFloor(cp); viewCheckpoint(cp,keys?); restore(cp,events,baseSeq,header,inherited); hydrate(...)
```
Drive: one `session/event` subscription; every committed event passes every registered unit's `apply` eagerly; `wire.view`
runs only when the state reference changed, and publication is suppressed when the raw view is `Object.is`-equal.
Registration is a fiber effect; same key+version share cells, incompatible version throws; no `wire` = host-only. Keys are
process-wide, not per-session capability signals. Checkpoints: every unit is checkpointed (host-only too);
`session-projection-cache` (mounted) persists `(sessionId,key,ver,seq,val)` rows in a domain at session creation, `turn/end`,
disposal, and throttled by `writeEveryEvents`/`writeIntervalMs`. Cold reads: `cachedSnapshot`/`viewCheckpoint` are zero-I/O
hints that may trail the log; `restoreFloor`+`restore` refold; `stateVersion` mismatch discards rows; log leads cache.

### 2.2 How `wire.view` reaches the Web client
Host-side values become projection frames in the client's shared Session store; the Web UI reads per session, e.g.
agent-team's panel: `projectionsBySession[lead].values.agentTeam`, model via
`projectionsBySession[member].values.modelSelection.next` (`@deepseek-ai/dsh-experimental-client-ui-agent-team/README.md`).
Agent-team registers `ctx.root.sessionProjections.register({ key:'agentTeam', stateVersion:4, stateSchema, apply,
wire:{viewSchema,view} })` inside `ctx.effect` (L1473–1482), and reuses the previous view object for mailbox-only changes so
no frame is published (L712–725). **A projection only sees session events — it cannot fold domain records.**

### 2.3 If the transcript lives in the domain
No built-in channel for plugin-owned non-session data. Options: (1) T2 projection — free wire view + client store;
(2) `ctx.webServer.register({kind:'exact'|'prefix', path, handler(req,res)}) => disposer` (duplicate path throws) plus a
client fetch/poll or `registerUpgrade` WebSocket for live update — plain-JS friendly; (3) generated Remote namespace
(`@Remote` methods + Typert wire) — what compiled host plugins use, needs a compiled package. MVP: T1 + host route.

## 3. Orchestration — creating and driving bot agents

### 3.1 Create/resume (`ctx.agents`, `@deepseek-ai/dsh-agent`)
```ts
async create(options: CreateAgentOptions): Promise<AgentHandle>
// { sessionId, parentAgent?                    // Omit ⇒ runtime root (matters for approvals/questions, §5)
//   meta?: { cwd?, parentSession?, isSeeded?, origin?:'subagent', delegationDepth?, agentPreset? },
//   inheritedEventCount?, seed?, agentOptions?: { provider?, model?, reasoningEffort?, maxTokens? },
//   signal?, setup?(agentCtx, agent): AgentSetupCommit|Promise<...>|void }
async resume(options: { resumeSessionId, parentAgent?, agentOptions?, signal?, setup? }): Promise<AgentHandle>
interface AgentHandle { agent: Agent; dispose(): Promise<void> }
```
`setup()` is the only per-bot persona/tool-composition hook: register `agentCtx.systemPrompt.section(...)`,
`agentCtx.tools.restrict(...)`, agent-scoped listeners inside one `agentCtx.effect()` and keep the disposer keyed by agent
(agent-loop README: config agents have no persona field; scoped persona is only available through programmatic
`create()`/`resume()`). `meta.agentPreset`/mounted preset is an alternative if personas ship as presets; a setup hook is
the direct route for AGENT.md/SOUL.md text. Durability: with `session-persistence-jsonl` mounted, agent-loop acquires the
session write handle before publication (`persistence.create(header)`; resume opens the log, appends synthetic
`interruptedTurnClosers` for a crashed mid-turn). `ctx.sessions.flush(session)` is the durability barrier.

### 3.2 Drive / observe / interrupt / cold-resume
From `@deepseek-ai/dsh-agent/README.md`: `agent.followup({content, source})` queues an ordinary next-turn prompt **and
wakes**; `agent.steer({content, source})` submits next-step input **and wakes**; `agent.inject({content, source})` adds
context **without waking**; `agent.cancel(cause, { keepInbox?: boolean })` aborts the active turn (default also clears the
inbox); `agent.whenIdle()` resolves at whole-agent quiescence; `agent.status`/`agent.inbox` (`{nextTurn,nextStep}`)
expose state.
Observe replies from the durable log on the bot session via `ctx.on('session/event', (session, event) => …)`: collect
`assistant/message` (text, usage) and treat `turn/end` (turn number, reason) as the final edge; `agent/status` and
`agent/assistant-stream` are process-local. Cold resume: `ctx.agents.resume({ resumeSessionId, agentOptions, setup })`
requires persistence mounted; re-run `setup` to restore persona/tools.

### 3.3 Own `SubagentProvider` vs reuse `ctx.agents.create`
`@deepseek-ai/dsh-subagent` (`ctx.subagents.registerProvider(p) => disposer`):
```ts
interface SubagentProvider { readonly name: string
  readonly capabilities: { agentOptions: boolean; agentPreset: boolean; outputSchema: boolean; depthLimit: boolean }
  readonly inheritsParentContext: boolean; readonly agentRouteDefaults?: {provider: string; model: string}
  start?(request: ResolvedSubagentStartRequest): Promise<SubagentRun>                  // external, one execution
  prepareContinuable?(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec> // local, fresh/fork seed
}
interface SubagentActivationSpec { provider; label; childId?; request: Omit<SubagentStartRequest,'label'|'signal'>;
  signal: AbortSignal; delivery: 'parent'|'caller' }
// startActivation(spec) ⇒ { childId, messageId?, result: Promise<SubagentResult>, dispose() }
// sendMessage(sender,targetId,content,{signal}) ⇒ MessageId  (steer; idle target starts turn; absent direct child cold-resumes)
// interrupt(targetSessionId, {kind:'ancestor',agent} | {kind:'user',parentSessionId}); waitForChildren(parent);
// listChildren(parentSessionId); drainChildren(parent, childIds); resolveMaxDepth(configured)
```
Provider prepares only; the manager owns creation, depth, capacity, structured output and disposal. This path makes bots
continuable subagent children (parentAgent set, `origin:'subagent'`, descriptor in log) with cold-resume via `sendMessage`,
`subagent/catalog` discovery and `drainDescendants`. Costs: `maxActiveSubagents` default 8 per top-level tree (cold resume
rejects `ACTIVATION_LIMIT_REACHED`), depth (setting `maxDepth` default 1, 0 disables), exact-adjacency messaging (siblings
cannot direct-message; child→parent needs a live parent), and the "you are a delegated subagent … approvals rejected
automatically" runtime-context statement in every child — wrong framing for a persona bot.
**Recommendation: bots as runtime roots via `ctx.agents.create/resume` + `setup`; route with followup/steer.** Write a
custom `SubagentProvider` only if bot_team must feed the subagent tool pipeline; the shipped `spawn` provider cannot set a
custom persona (only a registered agentPreset). Shortcut: `ctx.agentTeams.spawnTeammate` (group host as Lead) gives
roster+cold-resume, but one Team per root session, maxMembers 16, permanent names, no delete/rename, experimental
contracts, subagent semantics — not recommended as the core.

### 3.4 Lifecycle
Create/dispose handles inside one plugin `ctx.effect`. `AgentRegistry.create` uses the **registry's** context as owner
(lib L453–457), so unloading bot_team does **not** dispose bots — they leak as live (and persisted) agents. Per bot:
`await handle.dispose()` (stops/drains the loop, unregisters, removes the session, unwinds the scope); for
provider-managed children use `ctx.subagents.drainDescendants([...])`/`drainChildren`. Abort in-flight sends with a
plugin-owned AbortSignal; flush/`whenIdle` pending bots before unload (agent-loop limitation: a root shutdown with an
active agent can lose its final `turn/end` from the persisted log).

## 4. Concurrency & lifecycle semantics
- **Per-agent inbox ordering is durable** (`agent/inbox/spliced`; `nextTurn` + `nextStep`). At a turn boundary the loop
  atomically claims pending next-step input plus **one** queued prompt; between steps only next-step input. So N
  `followup()` calls ⇒ N sequential turns in order; N `steer()` calls may coalesce at one boundary but keep order.
  Replies map to steps, not inputs 1:1 (a turn has several steps): correlate by `turn` and wait for `turn/end`.
  **Yes — enqueue N messages to one agent and get N ordered turns**, but do not assume N assistant messages.
- `followup`/`steer` wake; `inject` does not (can sit until another input or queue mutation). Default `cancel()` clears
  queued input; agent-team's interrupt uses keep-inbox semantics so pending mail survives.
- Bots run truly in parallel (own loop+session). Serialize routing per group; the domain write chain serializes record
  writes but not multi-record group operations — keep one in-memory sequencer per group for transcript order/last-message
  bookkeeping. No cross-process coordination (domains in-process only; agent-team states one process/one checkout).
- Depth: root bots have no subagent-depth limit for their own tools; a bot that is a depth-1 subagent child cannot
  delegate further under `maxDepth: 1`. If bot tools must honor the user setting, read `ctx.subagents.resolveMaxDepth()`.
- Plugin unload/HMR: dispose projection, dispose bot handles, abort waits, `await domain.close()`. Unhandled cases leak
  live agents + durable sessions.
- Restart: domain rows are authoritative for groups/members; bot sessions are JSONL. Rebuild roster on load, resume bots
  lazily on first mention (or eagerly for the active group); interrupted turns are closed by resume's synthetic closers.

## 5. Approvals & user questions for bots
`ctx.approval` (`@deepseek-ai/dsh-user-approval`): `setPolicy(agent, 'ask'|'never')`, `overrideOf(session)`,
`request(req: ApprovalRequest): Promise<'allowed-once'|'rejected'|'cancelled'|'unavailable'>`. Policy is per-session,
durable (logged override), announced to the model; `request()` **requires an open turn** (idle asks throw before auditing),
runs the composed `approval/request` waterfall, fails closed (`unavailable`) without an answerer, and logs every
ask/outcome pair into the **requesting agent's** own session (`approval/asked`/`approval/decided`, log-only). A background
bot's prompt is **not guaranteed** to surface in the parent/group Web UI (the shipped Web answerer is agent-scoped/per
session). Options: (a) `ctx.approval.setPolicy(botAgent,'never')` for every bot at provisioning (this profile already
rejects approvals) and make bots self-contained inside their sandbox; (b) a bot_team `approval/request` listener that
recognizes our bots, auto-decides an allowlist, or relays the decision into the group UI. MVP: (a) + "blocked, needs
approval" text in the reply.
`ctx.userQuestions` (`@deepseek-ai/dsh-user-questions`): `ask()` authenticates the live agent and **admits only a runtime
root — "a live child cannot open a human interaction"**; child `ask_user_question` errors ("human interaction is
unavailable while the calling agent is owned by another live agent; include the unresolved question … in the final
result"). So question-asking bots must be runtime roots (`agents.create`, not subagent children), and the group UI must
surface the bot session's `userQuestions` projection; otherwise keep questions in reply text.

## 6. Risks / limits
- Domain: single-process only; no CAS/cross-record transactions/indexes/migration — a schema bump needs manual migration.
- No automatic client path for domain data: ship a host route/Remote + client surface, and budget that effort.
- T2 session-log route pollutes a real session's model history/compaction; bot lines can only be user-role events, and the
  stock Conversation UI does not render speakers.
- New session event types and `appendPluginRecord` are off-limits; agent-team's `team/*` events are DSH-internal
  experimental vocabulary, not an API.
- Bots are full agents (token/approval/tool fan-out): cap turns per mention, set `maxTokens`, restrict tools; agent-loop has
  no built-in turn budget (`agent/turn-stopping` is the hook).
- Subagent path (if chosen): capacity 8, depth, adjacency, delegation-scope statement; external backends are one-shot.
- Experimental packages (`agent-team`, client UI) may change contracts; HMR/unload leaks live+persisted bots if handles are
  not disposed; a root shutdown can lose a final `turn/end`.

## 7. Open questions
1. Is a group a **DSH session** (group-host session, T2, natural navigation) or a **pure plugin object** (T1, no session per
   group)? This decides transcript storage and UI strategy.
2. UI: reuse Conversation (T2) or a custom slot/page fed by a host route (T1)?
3. Persona delivery: `setup()` prompt section vs registered agentPreset; how are AGENT.md/SOUL.md materials loaded?
4. Restart UX: eager vs lazy bot resume; what if a group's host session/agent is gone?
5. Approval UX: silent `never` vs decision cards relayed into the group transcript.
6. Multi-bot discussion: deterministic host state machine vs a facilitator agent with model tools; group deletion/archival
   semantics and whether bot sessions should be hidden from the normal session list.

### Key source paths
- `@deepseek-ai/dsh-storage-domain/README.md`, `lib/index.js` (`defineDomain` L61–76, write chain L110–170); `@deepseek-ai/dsh-storage/README.md`
- `@deepseek-ai/dsh-session/README.md` (§append, §"Write experimental plugin records"); `@deepseek-ai/dsh-session-persistence/README.md`
- `@deepseek-ai/dsh-session-projection/README.md`; `@deepseek-ai/dsh-session-projection-cache/README.md`; `@deepseek-ai/dsh-agent/README.md`
- `@deepseek-ai/dsh-agent/lib/index.js` (create/resume L453–471); `@deepseek-ai/dsh-agent-loop/README.md`; `@deepseek-ai/dsh-subagent/README.md`
- `@deepseek-ai/dsh-experimental-agent-team/{README.md,lib/index.js}` (journal L108–161, projection L727–737, spawn L1003–1074, send L1586–1614)
- `@deepseek-ai/dsh-experimental-client-ui-agent-team/README.md`; `@deepseek-ai/dsh-user-approval/README.md`; `@deepseek-ai/dsh-user-questions/README.md`
- `@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md`
