# bot_team — Web UI rendering & Client↔Host research

Scope: how to render a multi-agent group chat in the DSH Web client (this profile, 0.2.1-rc.3,
GUI http://127.0.0.1:54169) and how the Client talks to the Host. Design phase only — nothing installed.

**Evidence caveat.** The live Client inspect channel was unreachable (`Slots.listSubTree` and
`Theme.listTokens` timed out: "Open or reconnect the Harness page"). The slot map below is
reconstructed from the *installed, shipping* client bundles (`lib/client.js`) and READMEs: every
key/option is verbatim from a shipped registration, props from the code that renders the slot.
Re-run those two inspect queries with the page open to confirm occupants/props and token names.

App root: `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/`.

## 1. Slot map

Shell slots are declared by `@deepseek-ai/dsh-client-ui-layout` (`lib/client.js:623-653`): `root`
(single) renders `AppFrame`; children `sidebar`(single), `main`(keyed), `rightbar`(single),
`shell.bottom`(single), `shell.overlay`(list), `shell.leading`(single). `main` renders as
`renderSlot("main", {}, { entryKey: usePanelInfo(s=>s.activePanelId) ?? "conversation" })`
(`:117-120`) — a **keyed global-panel slot**.

| Slot key | Kind/scope | Props (source) | Group-chat use |
|---|---|---|---|
| `root` / `shell.bottom` / `shell.leading` | single | shell tree; bottom row `{}`; leading mounted only when `darwin && sidebarCollapsed` (`ui-layout:315,354-358`) | N (root replacement / unreliable) |
| `sidebar` | single | `{collapsed, width}`; declared children `sidebar.panellist`(list), `sidebar.panellist.actions`(list), `sidebar.workspaces`(single), `sidebar.settings`(single), `sidebar.footer.action`(list), `sidebar.brand.*`, `sidebar.toggle.badge` (ui-sidebar `lib/client.js:611-649`) | N (occupied) |
| `sidebar.panellist` | list | entry opts `{name,id,order,label:(()=>string),locale}`; component gets `{size}` (icon). Every entry becomes a "Global panel" row; clicking calls `ctx.layout.selectPanel(id)` (ui-sidebar `lib/client.js:566-585`, `597-599`; Plugin Manager `lib/client.js:4484-4490`) | **Y — sidebar entry** |
| `sidebar.panellist.actions` | list | extra panel-list actions; presence observed by sidebar | Y (secondary) |
| `main` | **keyed** | registration opts `{name,key:<panelId>,locale,store?,inject?,children?}`; page receives framework props + injected face (`lib/client.js:4411-4461` in ui-plugin-manager). Panel identity = `entry.options.key`; switch with `ctx.layout.selectPanel(id)` (`ui-layout lib/client.js:452-472`) | **Y — whole page** |
| `rightbar` | single | `{width, viewportWidth, canShow}`; only one occupant; the right Sidebar occupies it (`ui-sidebar-right`) | N (single occupant) |
| `shell.overlay` | list | `{}`; rendered in an overlay layer div (ui-layout `:344-353`). Used for toasts (`dsh-client-ui-plugin-manager:4402-4410`) and global notices (`dsh-client-ui-chat`) | Y — modal/overlay |
| `conversation.session.header.actions` | list (session-scoped) | component gets `{sessionId,useSession,useSessions,useSessionStatus,openTeammate,t}` + `inject` face (agent-team `lib/client.js:491-497`) | Y — header button |
| `conversation.session.header.corner` | seat | right-sidebar expand button lives here (ui-sidebar-right README) | maybe |
| `conversation.session.header.views.actions` | list | `{entries, onOpen, onPinnedChange, onDismiss}` — "More conversation views" menu (ui-conversation README) | Y — view entry |
| `conversation.view` | per-session ring | renderers for the View tab ring (Chat, Trajectory). Registered via `ctx.uiConversation.views.register(...)` + slot key (ui-conversation/ui-trajectory READMEs; exact props not verified live) | Y — per-session tab |
| `conversation.chat.node` | keyed by `kind` | opts `{name, key:<kind>, locale}`; component gets `{node, t, renderFactorySlot}`; node = `{key,kind,id,target:"chat",anchorSeq,location,visibility,data}` (ui-goal `lib/client.js:398-432`, `582-586`) | Y — custom chat row |
| `conversation.input.dock` | list | opts `{name,id,order,locale,inject:(sessionId)=>face}`; rendered above composer (ui-goal `:604-651`) | Y — conversation-adjacent row |
| `conversation.composer.dock` | list | `{id,order,...}` statistics/controls row under composer (ui-chat README) | Y (secondary) |
| `conversation.composer` | chain | takeover by `select(owner)`; owner `{sessionId,session,pendingInteraction}` (ui-conversation README) | N |
| `sidebar.right.pane.tab` | keyed by tab type `id` | `{sidebar,panel,tab}` via `useTabInfo()`; tab types register through `ctx.sidebarRightTabs.register({id,kind,...})`; opened via `ctx.sidebarRight.openTab(kind)` / `openResource(address)` (ui-sidebar-right README §extension seats) | Y — right panel **if** `ui-sidebar-right` is mounted |

Whole-page answer: **yes, a plugin can allocate a whole page.** A keyed `main` registration plus
one `sidebar.panellist` entry is exactly how the shipped Plugin Manager page works (same
`PANEL_ID = "plugins"`, page opened by `ctx.layout.selectPanel(PANEL_ID)`;
`dsh-client-ui-plugin-manager/lib/client.js:4354-4355, 4411-4491`). `ui-layout` treats
`activePanelId === null` as the Conversation and only selects ids registered in `main`
(`selectPanel` throws otherwise, `:468-472`).

## 2. Recommended rendering architecture

Primary surface: **one full page in `main`** (`key: "bot-team"`) with a `sidebar.panellist`
entry (id `bot-team`, icon + labelled "Bot Team"), plus `shell.overlay` for modal dialogs and
toasts. Rationale:
- Verified pattern, no session required, inherits shell theme/locale, no iframe (iframes lose
  theme tokens and `ctx.locale` — practices.md:33).
- Page layout mirrors Plugin Manager: own in-page navigation store (`defineStore`), left group
  list, center message timeline, right roster/task rail, all inside one React component.
- Group detail can be embedded per group inside the page (Plugin Manager embeds package
  detail pages in-page) — no page-per-group routing needed.

Secondary/optional surfaces (phase 2, independent registrations): (1) **per-session tab**
(`conversation.view` via `ctx.uiConversation.views.register`) showing the group chat attached to
that session's agent/group; (2) **header action** (`conversation.session.header.actions`)
"Open group chat" like the Agent Team trigger, calling `ctx.layout.selectPanel("bot-team")`;
(3) **right docking panel** (`sidebar.right.pane.tab` tab type) for roster while chatting, only if
`@deepseek-ai/dsh-client-ui-sidebar-right` is enabled in the profile (currently `absent`);
(4) **chat rows** (`conversation.chat.node`) for events like "task assigned to @reviewer" if the
group timeline is ever rendered through the normal Chat surface.

Where group chat must live: **not inside a session view** — the global `main` page is session-less
and is the right home for the group list; per-bot conversations stay native sessions opened via
`ctx.uiWorkspace.openSession(...)` (`dsh-client-ui-agent-team/lib/client.js:478-490`).

## 3. Client↔Host: live read path (supported, build-free)

Host declares a **session projection** with a `wire` block; frames are pushed to the browser by
the existing Session Controller carrier — no custom RPC needed for reads
(`dsh-session-projection/README.md:34-58`). Closest shipped model:
`@deepseek-ai/dsh-experimental-agent-team/lib/types/projection.js:318-326`:

```js
export const teamProjectionDefinition = {
  key: 'agentTeam',
  stateVersion: 4,
  stateSchema: teamProjectionEntrySchema,
  init: header => emptyTeamState(header.id),
  apply: applyProjectionEvent,                    // pure, sync, returns same ref when ignored
  wire: { viewSchema: teamProjectionSchema, view: teamProjectionView }, // sync, reference-stable
}
// host: ctx.sessionProjections.register(definition)  (inside ctx.effect)
```

Client reads the same value three shipped ways:
```js
// a) slot props hooks (agent-team TeamAction)
const team = useSessions(s => s.projectionsBySession[leadSessionId]?.values.agentTeam);
// b) session binding projection face (ui-goal, lib/client.js:589-596)
const face = ctx.sessions.binding(sessionId)?.session.projections.faceOf("goal");
face.getSnapshot(); face.subscribe(listener);
// c) status/list stores: useSessionStatus, useSessions((s)=>s.byId[id]?.running)
```
Group-state recommendation: one projection key (`botTeam`) per group session holding
`{members, groups, messages-lite, tasks}` as one whole JSON view; keep `apply` pure and `view`
reference-stable (practices.md:24-28) — live updates then need no polling or custom RPC.

## 4. Client↔Host: write path (main risk — generator not shipped)

Shipped mechanism: Host service methods decorated `@Remote` (or `@Remote({mode:'stream'})` for
`RemoteStream`/`RemoteStreamHandle`), bound through `TypertRemoteService`/`bindTypertRemote()`,
generated into `TYPERT_REMOTE` artifacts mounted by the client (`dsh-typert-protocol/README.md:30-57`;
generated example `dsh-plugin-manager/lib/typert.remote-client.js:444+`). Client calls are typed
namespace methods after `inject: ['remote','remote.<namespace>']`:

```js
const r = await ctx.remote.goals.edit(sessionId, ref, { objective }); // {ok:true}|{ok:false,error}
ctx.remote.$on("goal/activation-changed", ev => ...);                 // forwarded events
```
(`dsh-client-ui-goal/lib/client.js:621-648`; Plugin Manager injects `remote`, `remote.pluginManager`,
`remote.pluginInventory`, … `:4357-4365`.)

**Blocking finding:** the generator package `@deepseek-ai/dsh-typert-generator` and all
`.d.ts`/typert artifacts of the installed packages are **not present** in the shipped asar
(`node_modules/@deepseek-ai/dsh-typert-generator` does not resolve; only built `lib/*.js` of
shipped packages ship). Also `@deepseek-ai/dsh-api-remotes/README.md:77` states the Client
assembly's Remote capability set is fixed by build-time value imports and the Client does not
discover Host Remotes at runtime. So a third-party plain-JS bundle cannot simply add a new
`ctx.remote.botTeam` namespace. Options, in order:
1. **Build inside a DSH source checkout** (canonical): author Host `./typert` + Client `./remote`
   artifacts with the repo's typert generator, auto-registered by `@deepseek-ai/dsh-typert-loader`
   (package exports `./typert`, cached per process — restart after adding it). Client plugin mounts
   its own contribution with `ctx.remote.$mount(TYPERT_REMOTE)` inside `ctx.effect` and receives
   the exact disposer. Spike this first: mounting a non-selected namespace from a plugin half is
   not demonstrated by a shipped package (all shipped namespaces are selected in `api-remotes`).
2. **Build-free fallback**: reads via session projection (above); writes as Host **commands**
   (`ctx.commands.register({name, description, input:{hint}, handler:({agent,rawInput})=>...})`,
   `dsh-commands/README.md:30-63`) executed from the page through the existing command RPC
   (`ui-commands` README: "the host `command.execute` RPC they trigger", `commands.list`
   directory). Verify `ctx.remote.commands.execute(...)` is callable from plugin UI and whether
   it needs a retained session; then model actions (create group, send @mention, ask review) as
   commands targeting the group's orchestrator session.
3. Last resort: drive existing Remotes only (submit an ordinary prompt to the orchestrator
   session via Session Controller) and let the Host agent route mentions through bot_team tools.
   No new transport; least precise UX.

Do **not** add host HTTP endpoints or poll `agent/status` for this.

## 5. Reference component/data-flow: Agent Team UI (closest analog)

`@deepseek-ai/dsh-experimental-client-ui-agent-team` — client half is one file,
`lib/client.js` (packageDir via `Config.listConfigs` entry `include:ui-agent-team`). Structure:
- `apply(ctx)` with `inject = ['sessions','uiWorkspace','slots','locale']` (`:456-462`),
  registers locale NS `agent-team`, then one slot registration:
  `ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({name, id:"agent-team", order:-20, locale:NS, inject:()=>actions}, TeamAction))` (`:469-497`).
- `TeamAction` (`:223-390`): trigger button, panel portaled with
  `react_dom.createPortal(..., document.body)`, `role="dialog"`, Escape/outside dismissal,
  `useAnchoredPosition`; sections: error banner, loading/unavailable notice, roster grid with
  per-row selector subscriptions (`useSessions(s=>s.projectionsBySession[member.id]?.values.modelSelection?.next?.model)`,
  `useSessionStatus`, `StateDot`), task cards (owner/blockedBy/writeScopes/warnings).
- Data: Lead identity `useSession(s=>s.subagent?.address.parentSessionId)`; team value
  `useSessions(s=>s.projectionsBySession[leadSessionId]?.values.agentTeam)`; navigation
  `ctx.uiWorkspace.openSession({parentSessionId, childSessionId, mode:"continuable"})`. Host side
  has no Remote namespace (`apply(){}` only in `lib/index.js`): live updates ride the projection stream.

Full-page reference to copy: `@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js:4351-4491`:
`inject=['slots','locale','remote','remote.pluginManager','configForms','layout']`; locale NS + `t`;
`ctx.remote.$on("plugin-manager/changed", refresh)`; a `shell.overlay` toast entry; then
`ctx.slots.inject("main", function*(){ yield register({name:"main",key:PANEL_ID,locale,store,inject,children:{...}}, Page); const disposeNav = ctx.reflect.provide("pluginNavigation",{openList:()=>ctx.layout.selectPanel(PANEL_ID)}); yield ()=>disposeNav(); })`
plus `ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({name:"sidebar.panellist",id:PANEL_ID,order:0,label:()=>t("panel"),locale:NS}, PluginsPanelIcon))`.
Client bundle format: `window.__ModuleLoader__.load({id:"<pkg>", factory:(require)=>{ return { inject:[...], apply(ctx){} } }})`
with `require('react')` / `require('react/jsx-runtime')` / `require('react-dom')` from the browser
module table; CSS via the `data-plugin-css` style-tag trick (agent-team `lib/client.js:11-20`;
template: skill `templates/decoration/client.js`).

## 6. Navigation & entry point

- Page: `ctx.layout.selectPanel("<id>")`; `null` returns to Conversation. Only ids registered in
  `main` are selectable; `retainMainPanels` collapses to Conversation when the id disappears.
- Sidebar row: registering `sidebar.panellist` is enough — the sidebar itself calls
  `ctx.layout.selectPanel(id)`.
- Sessions/bots: `ctx.uiWorkspace.openSession(sessionId)` or
  `openSession({parentSessionId, childSessionId, mode:"continuable"})` (agent-team).
- **No app router**: page state is the `main` keyed selection plus plugin-local stores; persist
  "last group" in a plugin-prefixed localStorage key (sidebar-right precedent:
  `dsh.sidebar-right.v1.<sessionId>`).
- `ctx.slots.inject(ownerKey, () => ctx.slots.register(...))` everywhere: registrations die with
  the owning declaration and reinstall when it returns (practices.md:36).

## 7. Locale / theme checklist

Locale:
- Bundle metadata for Plugin Manager/Settings inventory: exported `locale/en.json`, `locale/zh.json`
  with `{"meta":{"title":...,"description":...}}`, exported `./locale/*.json` and `./icon`, listed
  in `files` (skill `references/host-plugin.md:30-51`). These JSON files are inventory metadata,
  separate from runtime dictionaries.
- Runtime copy: `ctx.effect(() => ctx.locale.register("botTeam", {zh, en}), "...")` (typed object
  form requires complete zh+en); `const t = ctx.locale.bind(NS)`; pass `locale: NS` in every slot
  registration so the framework injects `t` and copy re-renders on language switch (locale README:38);
  `ctx.locale.resolveText` for packed `LocalizedText`. Page/entry titles use the same NS.

Theme:
- Use only `--dsw-alias-*` tokens in CSS (agent-team uses `--dsw-alias-label-tertiary`,
  `--dsw-alias-bg-layer-2`, `--dsw-elevation-stroke`, `--dsw-elevation-prominent`,
  `--dsw-radius-md`, `--dsh-content-font-size`, `--dsh-content-font-delta`); literal colors only
  for artwork. Tokens may be renamed by upgrades (degraded appearance only); never rely on host
  class names.
- Inject plugin CSS once as a `<style data-plugin data-plugin-css="<pkg>/<file>">` tag (with
  `document.querySelector` guard) and remove it on dispose, or render a component-local `<style>`
  so unmounting removes it (ui-plugin.md:13). Never replace/read host DOM; the page owns its own
  subtree, `shell.overlay` uses its own portal.
- If JS needs resolved theme: `ctx.theme.getTheme()` + `ctx.on("theme/change", ...)` (ui-layout
  `:700-710`); `Theme.listTokens` was unavailable here — re-query once the page is connected.

## 8. Open questions / spikes

1. **Remote namespace feasibility** (highest risk): can a workspace bundle ship a hand-built or
   generated `TYPERT_REMOTE` and mount it from its own client half (`ctx.remote.$mount`, declaring
   a non-baseline import in `dsh.client.external`)? Needs the typert generator (not in the shipped
   app) or a documented plain-JS descriptor route. Spike before committing to an action API;
   fallback = command RPC (§4 option 2).
2. **Live slot confirmation**: re-run `Slots.listSubTree`/`listTokens` with the GUI page open;
   confirm `conversation.view` props and that no other plugin occupies the `main`/`sidebar.panellist`
   ids we plan to use (ids are unique per slot).
3. **`ui-sidebar-right` availability**: profile shows `include:ui-sidebar-right` `absent`; the
   right-docked roster depends on enabling that bundle (see `ui-sidebar-documentpreview` for a tab type).
4. **Group/session model**: one orchestrator session per group (native queue/turns/roster) vs.
   session-less plugin storage. Projections are session-scoped, so a session per group is the
   natural read channel; confirm durable-session-storage expectations (as Agent Team requires).
5. **Streaming**: `@Remote({mode:'stream'})` yields `RemoteStreamHandle<Out,In>` (protocol README:49)
   but is generator-bound; if unavailable, drive live text from the projection / conversation rows.
6. **Late activation**: Agent Team documents "after enabling the plugin, reload the page to receive
   its Team projection" — expect the same reload requirement for a new projection key; state it in UX.
