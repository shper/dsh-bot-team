/**
 * One hidden background DSH Session per Bot membership. The plugin owns
 * factory-created/resumed handles and mounts the native default Agent preset.
 */
import { BOT_TEAM_TOOL_NAMES } from './tools.js';
import { newId } from './util.js';
import { currentConversationId, conversationFloor, isCurrentMemberSession } from './conversations.js';
import { defaultWorkspaceDir, ensureWorkspaceDir, sessionCwdMatches, validateProjectWorkspace } from './workspace.js';
import { botModel, inspectSessionHeader, installBotModel, submitNativeInput } from './native-session.js';

const RECURSIVE_TEAM_TOOLS = BOT_TEAM_TOOL_NAMES.filter(name => !['bot_team_list', 'bot_team_task_list'].includes(name));
// Native reminders deliver through SessionController, which rejects hidden
// origins. Leave list/delete available for old ordinary-session reminders.
const BACKGROUND_UNDELIVERABLE_TOOLS = ['schedule_create', 'schedule_update'];
const backgroundHeader = header => header?.origin === 'subagent'
  && header.parentSession === undefined && header.parentSessionId === undefined
  && header.parent === undefined && (header.delegationDepth === undefined || header.delegationDepth === 0);
const presetOf = (header, events) => {
  const selected = events.findLast(event => event.type === 'agent-preset/selected');
  if (!selected) return header.agentPreset;
  if (typeof selected.data?.agentPreset !== 'string' || !selected.data.agentPreset) throw new Error('Invalid stored Bot preset selection');
  return selected.data.agentPreset;
};

export class AgentPool {
  constructor({ ctx, repo, personas, config, logger }) {
    this.ctx = ctx;
    this.repo = repo;
    this.personas = personas;
    this.config = config;
    this.logger = logger;
    this.entries = new Map();
    this.owned = new Map();
    this.preparing = new Map();
    this.preparationAborts = new Map();
    this.overlays = new Map();
    this.overlayPreparing = new Map();
    this.versions = new Map();
    this.modelUpdates = new Map();
    this.recordingModel = new WeakSet();
    this.submitting = new Map();
    this.modelWrites = new Map();
    this.drainedSessions = new Set();
    this.disposed = false;
    // Observe factory publication and old ordinary-session activations. Owned
    // setup already installs its overlay; repeated hooks remain idempotent.
    this.offCreated = ctx.on('agent/created', async ({ agent }) => {
      if (this.disposed) return;
      const member = this.memberForSession(agent.id);
      if (member && this.canOverlay(agent)) {
        await this.makeSetup(member.membershipId)(agent.ctx, agent);
      }
    }, { global: true });
    this.offDisposed = ctx.on('agent/disposed', ({ agent }) => {
      this.detachOverlay(agent);
      this.owned.delete(agent);
      for (const [id, entry] of this.entries) if (entry.agent === agent) this.entries.delete(id);
    }, { global: true });
    this.offSelection = ctx.on('session/event', (session, event) => this.onModelSelection(session, event), { global: true });
    this.ready = Promise.all([...(this.repo.members?.values() || [])].map(member => {
      const agent = isCurrentMemberSession(this.repo, member) && this.ctx.agents.get(member.sessionId);
      return agent && this.canOverlay(agent) ? this.makeSetup(member.membershipId)(agent.ctx, agent) : undefined;
    })).then(() => undefined);
    // Keep the rejection observable to service.ready / ensure without an
    // unhandled rejection while the host is still constructing the service.
    this.ready.catch(error => this.logger?.warn?.('bot-team: restore live overlays failed: ' + String(error)));
  }

  sessionIdOf(member) { return member.sessionId; }

  memberForSession(sessionId) {
    // The durable repository is the single mapping authority, including after
    // restart and before create publishes agent/created. Never infer from IDs.
    for (const member of this.repo.members?.values() || []) {
      if (isCurrentMemberSession(this.repo, member, sessionId)) return member;
    }
    // Small embedders can expose only getMember; entries still stay verified.
    for (const memberId of new Set([...this.preparing.keys(), ...this.entries.keys()])) {
      const member = this.repo.getMember(memberId);
      if (isCurrentMemberSession(this.repo, member, sessionId)) return member;
    }
    return undefined;
  }

  requireMember(memberId) {
    const member = this.repo.getMember(memberId);
    if (!member) throw new Error('membership ' + memberId + ' does not exist');
    const bot = this.repo.getBot(member.botId);
    if (!bot) throw new Error('bot ' + member.botId + ' of membership ' + memberId + ' does not exist');
    const group = this.repo.getGroup(member.groupId);
    if (!group) throw new Error('group ' + member.groupId + ' does not exist');
    return { member, bot, group };
  }

  async ensure(memberId) {
    if (this.disposed) throw new Error('Bot AgentPool is disposed');
    const { member } = this.requireMember(memberId);
    this.assertAdmission?.(member.groupId);
    const expected = this.generation(member);
    if (this.preparing.has(memberId)) return this.preparing.get(memberId);
    // Defer prepare until this map is populated: synchronous lifecycle hooks
    // and callers joining in the same tick see the same in-flight operation.
    const abort = new AbortController();
    const version = this.versions.get(memberId);
    this.preparationAborts.set(memberId, abort);
    const pending = Promise.resolve().then(() => this.prepare(memberId, version, abort.signal, expected));
    this.preparing.set(memberId, pending);
    try { return await pending; }
    finally {
      if (this.preparing.get(memberId) === pending) this.preparing.delete(memberId);
      if (this.preparationAborts.get(memberId) === abort) this.preparationAborts.delete(memberId);
    }
  }

  isPreparingGroup(groupId) {
    return [...this.preparing.keys(), ...this.submitting.keys(), ...[...this.overlayPreparing.values()].map(value => value.membershipId)]
      .some(id => this.repo.getMember(id)?.groupId === groupId) || [...this.modelWrites.values()].includes(groupId);
  }

  generation(member) {
    return { membershipId: member.membershipId, groupId: member.groupId, botId: member.botId,
      conversationId: currentConversationId(this.repo, member.groupId), sessionId: member.sessionId };
  }

  assertGeneration(expected, { current = false, admission = true } = {}) {
    const member = this.repo.getMember(expected.membershipId);
    if (this.disposed || !member || member.groupId !== expected.groupId || member.botId !== expected.botId ||
        member.sessionId !== expected.sessionId || currentConversationId(this.repo, expected.groupId) !== expected.conversationId ||
        (current && !isCurrentMemberSession(this.repo, member, expected.sessionId))) {
      throw Object.assign(new Error('Bot session belongs to a stale conversation or was disposed'), { code: 'conversation-stale' });
    }
    if (admission) this.assertAdmission?.(expected.groupId);
    return member;
  }

  assertPreparing(memberId, version, expected) {
    if (this.disposed || this.versions.get(memberId) !== version) throw new Error('Bot session preparation was disposed');
    if (expected) this.assertGeneration(expected);
  }

  owns(agent) { return this.owned.has(agent); }

  canOverlay(agent) {
    const header = agent.session?.header;
    if (header?.origin !== undefined && header.origin !== 'subagent') return false;
    if (!header || agent.parentAgent || header.parentSession !== undefined || header.parentSessionId !== undefined || header.parent !== undefined || (header.delegationDepth !== undefined && header.delegationDepth !== 0)) return false;
    if (header.origin === 'subagent' && !backgroundHeader(header)) return false;
    // Durable origin does not define runtime parentage. A malformed real child
    // must not be borrowed just because it happens to match a membership id.
    if (this.ctx.agents.get(agent.id) === agent && typeof this.ctx.agents.roots === 'function' && !this.ctx.agents.roots().includes(agent)) return false;
    return true;
  }

  async storedPreset(sessionId, header) {
    const live = this.ctx.agents.get(sessionId);
    if (live) return presetOf(header, live.session.snapshotEvents());
    const observation = await this.ctx.get('sessionQuery').observeSession(sessionId, { projectionMode: 'none' });
    try {
      if (observation.header?.id !== sessionId || !Array.isArray(observation.events)) throw new Error('Invalid stored Bot preset history: ' + sessionId);
      return presetOf(observation.header, observation.events);
    } finally { observation[Symbol.dispose]?.(); }
  }

  async releaseOwned(agent) {
    const owned = this.owned.get(agent);
    if (!owned) return;
    owned.releasing ||= Promise.resolve().then(async () => {
      // The native factory owns the root only; the subagent manager owns its
      // descendants. Close that tree's admission and await its exact handles.
      if (this.ctx.agents.get(agent.id) === agent) await this.ctx.get('subagents')?.drainDescendants?.([agent]);
      await owned.handle.dispose();
      this.drainedSessions.add(agent.id);
    });
    try {
      await owned.releasing;
      if (this.owned.get(agent) === owned) this.owned.delete(agent);
      this.detachOverlay(agent);
    } catch (error) {
      owned.releasing = undefined;
      throw error;
    }
  }

  async prepare(memberId, version, signal, expected) {
    const check = () => { signal.throwIfAborted(); this.assertPreparing(memberId, version, expected); };
    check();
    await this.ready;
    check();
    const { member, group } = this.requireMember(memberId);
    const cwd = group.workspaceCwd || defaultWorkspaceDir(this.config, group);
    if (group.projectWorkspaceCwd) await validateProjectWorkspace(cwd);
    else if (!(await ensureWorkspaceDir(cwd, this.logger))) throw new Error('无法准备默认工作目录');
    check();
    const presets = this.ctx.agentPresets || this.ctx.get('agentPresets');
    if (typeof presets?.resolve !== 'function' || typeof presets?.mount !== 'function') throw new Error('Native default Agent preset registry is unavailable');
    const staleConversation = expected.conversationId !== null && member.sessionConversationId !== expected.conversationId;
    let sessionId = member.sessionId;
    // A stale mapping never causes native observation/resume or id reuse, even
    // when its old log was never written or several conversations were skipped.
    let header = !staleConversation && sessionId ? await inspectSessionHeader(this.ctx, sessionId) : undefined;
    check();
    const live = !staleConversation && sessionId && this.ctx.agents.get(sessionId);
    let compatible = false;
    let preset;
    let storedId;
    if (header && backgroundHeader(header) && sessionCwdMatches(header.cwd, cwd) && (!live || this.canOverlay(live))) {
      storedId = await this.storedPreset(sessionId, header);
      check();
      if (typeof storedId !== 'string' || !storedId) throw new Error('Invalid stored Bot preset identity');
      if (storedId !== 'bot-team-tools') {
        preset = await presets.resolve(storedId);
        check();
        if (preset?.id !== storedId || preset.broken) throw new Error('Invalid stored Bot preset: ' + storedId);
        compatible = true;
      }
    }
    if (!compatible) {
      preset = await presets.resolve(undefined);
      check();
      if (typeof preset?.id !== 'string' || !preset.id || preset.broken) throw new Error('Native default Agent preset is invalid');
      compatible = !staleConversation && storedId === preset.id;
    }
    const rotated = staleConversation || Boolean(header && !compatible);
    const next = { ...member };
    if (rotated) {
      if (sessionId) {
        if (typeof this.repo.bindSession === 'function') {
          await this.repo.bindSession(member, { sessionId, conversationId: member.sessionConversationId, reason: 'retained-history' });
          check();
        }
        next.previousSessionIds = [...new Set([...(member.previousSessionIds || []), sessionId])];
      }
      sessionId = newId('session-botteam');
      header = undefined;
      next.lastSeenSeq = conversationFloor(this.repo, group.groupId);
    }
    if (!sessionId) sessionId = newId('session-botteam');
    next.sessionId = sessionId;
    if (expected.conversationId !== null) next.sessionConversationId = expected.conversationId;
    if (rotated) {
      // Release all old handles owned by this membership, including detached
      // cache entries. Historical borrowed agents retain their original owner.
      this.entries.delete(memberId);
      for (const [agent, owned] of [...this.owned]) if (owned.membershipId === memberId) {
        await this.releaseOwned(agent);
        check();
      }
      for (const [agent, overlay] of [...this.overlays]) if (overlay.membershipId === memberId) this.detachOverlay(agent);
    }
    if (typeof this.repo.bindSession === 'function') {
      await this.repo.bindSession(next, { sessionId, conversationId: expected.conversationId, reason: rotated ? 'session-rotation' : 'session-activation' });
      check();
    }
    if (!header || next.sessionConversationId !== member.sessionConversationId) {
      // The new mapping is published only after strict persistence succeeds.
      if (typeof this.repo.putMemberStrict === 'function') {
        await this.repo.putMemberStrict(next, { expectedConversationId: expected.conversationId, expectedSessionId: expected.sessionId });
      } else {
        // Legacy repository doubles preserve object identity. Real repositories
        // use the strict copy/write/publish path above.
        const before = { ...member };
        Object.assign(member, next);
        try { await this.repo.putMember(member); }
        catch (error) { Object.assign(member, before); throw error; }
      }
      expected = { ...expected, sessionId };
      check();
    }

    let handle;
    let agent = compatible ? live : undefined;
    try {
      if (!agent) {
        const setup = async (scope, prepared) => {
          check();
          if (!backgroundHeader(prepared.session.header) || !sessionCwdMatches(prepared.session.header.cwd, cwd)) throw new Error('Background Bot session metadata changed during activation: ' + sessionId);
          await presets.mount(scope, preset.id);
          check();
          await this.makeSetup(memberId)(scope, prepared);
          check();
        };
        const options = { agentOptions: botModel(this.requireMember(memberId).bot), setup, signal };
        handle = header
          ? await this.ctx.agents.resume({ ...options, resumeSessionId: sessionId })
          : await this.ctx.agents.create({ ...options, sessionId, meta: { cwd, origin: 'subagent', agentPreset: preset.id } });
        agent = handle?.agent;
        if (agent) this.owned.set(agent, { membershipId: memberId, conversationId: expected.conversationId, handle });
        if (!agent || agent.id !== sessionId || typeof handle.dispose !== 'function') throw new Error('Background Agent factory returned an unexpected Bot session: ' + sessionId);
      }
      check();
      if (!backgroundHeader(agent.session.header) || !this.canOverlay(agent) || !sessionCwdMatches(agent.session.header.cwd, cwd)) throw new Error('Background Bot session metadata changed during activation: ' + sessionId);
      await this.makeSetup(memberId)(agent.ctx, agent);
      check();
      const workingDirectory = this.ctx.get('workingDirectory');
      if (typeof workingDirectory?.set === 'function') {
        try { await workingDirectory.set(agent, cwd); }
        catch (error) { throw new Error('无法设置 Bot 工作目录 ' + cwd + ': ' + String(error?.message || error), { cause: error }); }
      }
      check();
      if (this.ctx.agents.get(sessionId) !== agent) throw new Error('Bot session was disposed during activation');
      this.assertGeneration(expected, { current: true });
      this.entries.set(memberId, { membershipId: memberId, sessionId, conversationId: expected.conversationId, agent });
      return agent;
    } catch (error) {
      if (handle && agent) await this.releaseOwned(agent);
      throw error;
    }
  }

  async applySandboxMode(agent) {
    if (!this.config.botSandbox) return;
    const policy = this.ctx.get('sandboxPolicy');
    const current = policy?.overrideOf?.(agent.session)
      ?? agent.session.snapshotEvents?.().findLast(event => event.type === 'sandbox/mode')?.data.mode;
    if (current !== 'workspace-write') agent.session.append('sandbox/mode', { mode: 'workspace-write' });
  }

  current(memberId) {
    if (this.disposed) return undefined;
    const member = this.repo.getMember(memberId);
    const agent = isCurrentMemberSession(this.repo, member) && this.ctx.agents.get(member.sessionId);
    const entry = this.entries.get(memberId);
    if (entry && (entry.sessionId !== member?.sessionId || entry.agent !== agent)) this.entries.delete(memberId);
    // Borrowed background roots and legacy native activations may bypass ensure().
    const overlay = agent && this.overlays.get(agent);
    return overlay?.membershipId === memberId && overlay.conversationId === currentConversationId(this.repo, member.groupId) ? agent : undefined;
  }

  makeSetup(membershipId) {
    return async (agentCtx, agent) => {
      if (this.disposed || !this.canOverlay(agent) || !isCurrentMemberSession(this.repo, this.repo.getMember(membershipId), agent.id)) return;
      const pending = this.overlayPreparing.get(agent);
      if (pending) return pending.promise;
      const operation = {
        membershipId,
        promise: Promise.resolve().then(() => this.installOverlay(membershipId, agentCtx, agent)),
      };
      this.overlayPreparing.set(agent, operation);
      try { return await operation.promise; }
      finally { if (this.overlayPreparing.get(agent) === operation) this.overlayPreparing.delete(agent); }
    };
  }

  async installOverlay(membershipId, agentCtx, agent) {
    if (this.disposed) return;
    const { member } = this.requireMember(membershipId);
    if (!isCurrentMemberSession(this.repo, member, agent.id)) return;
    const expected = this.generation(member);
    this.assertGeneration(expected, { current: true });
    if (this.overlays.has(agent)) return;
    const overlay = { membershipId, conversationId: expected.conversationId, disposers: [] };
    const check = () => {
      this.assertGeneration(expected, { current: true });
      if (this.overlays.get(agent) !== overlay) throw new Error('Bot overlay was disposed');
    };
    const retain = disposer => { if (typeof disposer === 'function') overlay.disposers.push(disposer); };
    this.overlays.set(agent, overlay);
    try {
      // Independent section: keep the harness identity, deployment persona,
      // default preset, and the preset's entire native capability composition.
      retain(agentCtx.systemPrompt.section({
        name: 'bot-team:persona', order: 100,
        text: context => {
          if (context?.agent && context.agent !== agent) return '';
          const member = this.repo.getMember(membershipId);
          return isCurrentMemberSession(this.repo, member, agent.id) && expected.conversationId === currentConversationId(this.repo, member.groupId) ? this.personaText(member.botId, member.groupId) : '';
        },
      }));
      retain(agentCtx.systemPrompt.context({
        name: 'bot-team:group', order: 600,
        text: context => {
          if (context?.agent && context.agent !== agent) return '';
          const member = this.repo.getMember(membershipId);
          return isCurrentMemberSession(this.repo, member, agent.id) && expected.conversationId === currentConversationId(this.repo, member.groupId) ? this.groupContextText(member.botId, member.groupId) : '';
        },
      }));
      const tools = this.ctx.get('tools');
      const forbidden = [...RECURSIVE_TEAM_TOOLS, ...(backgroundHeader(agent.session.header) ? BACKGROUND_UNDELIVERABLE_TOOLS : [])];
      const deny = forbidden.filter(name => tools?.get?.(name, agent) !== undefined);
      if (deny.length) {
        if (typeof agentCtx.tools?.restrict !== 'function') throw new Error('Native scoped tool restrictions are unavailable');
        retain(agentCtx.tools.restrict({ deny }));
      }
      // A monotonic native guard also covers tools registered after this
      // overlay (for example while the plugin is hot-reloading).
      if (typeof agentCtx.tools?.guard === 'function') {
        retain(agentCtx.tools.guard(exec => RECURSIVE_TEAM_TOOLS.includes(exec.name)
          ? 'Bot Team members cannot recursively drive Bot Team write tools'
          : backgroundHeader(agent.session.header) && BACKGROUND_UNDELIVERABLE_TOOLS.includes(exec.name)
            ? 'Native reminders cannot deliver to hidden Bot Team sessions' : undefined));
      }
      await installBotModel(this.ctx, agentCtx, agent, () => this.modelFor(membershipId, expected), selected => this.publishModelSelection(agent, selected, expected), retain, check);
      check();
      retain(agentCtx.on('agent/assistant-stream', payload => {
        if (payload.agent && payload.agent !== agent) return;
        if (this.current(membershipId) !== agent || expected.conversationId !== currentConversationId(this.repo, expected.groupId)) return;
        this.streamHandler?.({ ...payload, agent });
      }));
      retain(agentCtx.on('agent/inbox/claimed', payload => {
        if (payload.agent && payload.agent !== agent) return;
        if (this.current(membershipId) !== agent || expected.conversationId !== currentConversationId(this.repo, expected.groupId)) return;
        this.claimHandler?.({ ...payload, agent });
      }));
      const approval = this.ctx.get('approval');
      approval?.setPolicy?.(agent, this.config.botApprovalPolicy === 'never' ? 'never' : 'ask');
      await this.applySandboxMode(agent);
      check();
    } catch (error) {
      this.detachOverlay(agent);
      throw error;
    }
  }

  detachOverlay(agent) {
    const overlay = this.overlays.get(agent);
    if (!overlay) return;
    this.overlays.delete(agent);
    for (const dispose of overlay.disposers.reverse()) {
      try { dispose(); }
      catch (error) { this.logger?.warn?.('bot-team: detach overlay failed: ' + String(error)); }
    }
  }

  onModelSelection(session, event) {
    if (this.disposed || event.type !== 'model/selection' || this.recordingModel.has(session)) return;
    const member = this.memberForSession(session.id);
    if (!member) return;
    const expected = this.generation(member);
    const selected = { ...event.data };
    const previous = this.modelUpdates.get(member.botId);
    // A new native selection can retry a failed profile write. Within one Bot
    // these writes stay ordered, including selections from different Sessions.
    const write = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(async () => {
      this.assertGeneration(expected, { current: true });
      const current = this.repo.getBot(member.botId);
      if (!current) throw new Error('Bot no longer exists for native model selection');
      const next = { ...current, provider: selected.provider, model: selected.model };
      if (selected.reasoningEffort === undefined) delete next.reasoningEffort;
      else next.reasoningEffort = selected.reasoningEffort;
      await this.repo.putBot(next);
      this.assertGeneration(expected, { current: true });
    });
    this.modelUpdates.set(member.botId, write);
    this.modelWrites.set(write, member.groupId);
    write.then(() => this.modelWrites.delete(write), () => this.modelWrites.delete(write));
    write.catch(error => this.logger?.warn?.('bot-team: persist native model selection failed: ' + String(error)));
    return write;
  }

  async modelFor(membershipId, expected) {
    const { member } = this.requireMember(membershipId);
    // New UI selections can arrive while a previous write is settling.
    for (;;) {
      const pending = this.modelUpdates.get(member.botId);
      if (pending) await pending;
      if (expected) this.assertGeneration(expected, { current: true });
      if (pending === this.modelUpdates.get(member.botId)) return this.requireMember(membershipId).bot;
    }
  }

  publishModelSelection(agent, selected, expected) {
    if (expected) this.assertGeneration(expected, { current: true });
    const projections = this.ctx.get('sessionProjections');
    if (typeof projections?.stateOf !== 'function') throw new Error('Native modelSelection projection is unavailable');
    const state = projections.stateOf(agent.session, 'modelSelection');
    if (!state) throw new Error('Native modelSelection projection is not registered');
    const next = state.pending ?? state.lastUsed;
    const { maxTokens, ...intent } = selected;
    if (next?.provider === intent.provider && next.model === intent.model && next.reasoningEffort === intent.reasoningEffort) return;
    // Session.append dispatches synchronously. Ignore only this plugin's own
    // publication; native UI selectModel events update the durable Bot profile.
    this.recordingModel.add(agent.session);
    try { agent.session.append('model/selection', intent); }
    finally { this.recordingModel.delete(agent.session); }
  }

  personaText(botId, groupId) { return this.prompt?.renderPersona(botId, groupId) || ''; }
  groupContextText(botId, groupId) { return this.prompt?.renderGroupContext(botId, groupId) || ''; }
  attachPrompt(promptApi) { this.prompt = promptApi; }
  attachStreamHandler(handler) { this.streamHandler = handler; }
  attachClaimHandler(handler) {
    this.claimHandler = handler;
    return () => { if (this.claimHandler === handler) this.claimHandler = undefined; };
  }

  async submit(agent, input) {
    if (this.disposed) throw new Error('Bot AgentPool is disposed');
    const member = this.memberForSession(agent.id);
    if (!member) throw new Error('Bot input targets an unmapped or stale conversation native session');
    const expected = this.generation(member);
    const version = this.versions.get(member.membershipId);
    const check = () => {
      this.assertPreparing(member.membershipId, version, expected);
      this.assertGeneration(expected, { current: true });
      if (this.ctx.agents.get(agent.id) !== agent) throw new Error('Bot session was disposed during input admission');
    };
    check();
    const pending = Promise.resolve().then(async () => {
      const model = botModel(await this.modelFor(member.membershipId, expected));
      check();
      await submitNativeInput(this.ctx, agent, input, model, check);
      check();
    });
    const operations = this.submitting.get(member.membershipId) || new Set();
    operations.add(pending);
    this.submitting.set(member.membershipId, operations);
    try { return await pending; }
    finally {
      operations.delete(pending);
      if (operations.size === 0) this.submitting.delete(member.membershipId);
    }
  }

  async disposeMember(membershipId) {
    this.versions.set(membershipId, (this.versions.get(membershipId) || 0) + 1);
    this.preparationAborts.get(membershipId)?.abort(new Error('Bot session preparation was disposed'));
    this.entries.delete(membershipId);
    const pending = this.preparing.get(membershipId);
    const overlays = [...this.overlayPreparing.values()].filter(operation => operation.membershipId === membershipId);
    await Promise.allSettled([pending, ...overlays.map(operation => operation.promise), ...(this.submitting.get(membershipId) || [])]);
    for (const [agent, owned] of [...this.owned]) if (owned.membershipId === membershipId) await this.releaseOwned(agent);
    for (const [agent, overlay] of this.overlays) if (overlay.membershipId === membershipId) this.detachOverlay(agent);
  }

  async disposeAll() {
    this.disposed = true;
    for (const abort of this.preparationAborts.values()) abort.abort(new Error('Bot AgentPool is disposed'));
    this.offCreated?.();
    this.offDisposed?.();
    this.offSelection?.();
    await Promise.allSettled([this.ready, ...this.modelUpdates.values(), ...this.preparing.values(), ...[...this.overlayPreparing.values()].map(operation => operation.promise), ...[...this.submitting.values()].flatMap(operations => [...operations])]);
    const releases = await Promise.allSettled([...this.owned.keys()].map(agent => this.releaseOwned(agent)));
    for (const result of releases) if (result.status === 'rejected') this.logger?.warn?.('bot-team: release background Agent failed: ' + String(result.reason));
    this.entries.clear();
    for (const agent of this.overlays.keys()) this.detachOverlay(agent);
    this.streamHandler = undefined;
    this.claimHandler = undefined;
  }

  list() { return [...new Set([...this.entries.keys(), ...[...this.overlays.values()].map(overlay => overlay.membershipId)])].filter(id => this.current(id)); }
}
