import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentPool } from '../host/agents.js';
import { BOT_TEAM_TOOL_NAMES } from '../host/tools.js';

export const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const coded = (code, message = code) => Object.assign(new Error(message), { code });
const sameSelection = (a, b) => a?.provider === b?.provider && a?.model === b?.model && a?.reasoningEffort === b?.reasoningEffort;
function modelProjection(session) {
  let pending = null;
  let lastUsed = null;
  for (const event of session.snapshotEvents()) {
    if (event.type === 'model/selection') pending = event.data;
    if (event.type === 'request/header') {
      const { provider, model, reasoningEffort } = event.data.header.config;
      lastUsed = { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) };
      if (sameSelection(pending, lastUsed)) pending = null;
    }
  }
  return { pending, lastUsed };
}

class Scope {
  listeners = new Map();
  sections = new Map();
  contexts = new Map();
  restrictions = new Set();
  guards = new Set();
  systemPrompt = {
    section: value => this.register(this.sections, value),
    context: value => this.register(this.contexts, value),
  };
  tools = {
    restrict: value => { this.restrictions.add(value); return () => this.restrictions.delete(value); },
    guard: handler => { this.guards.add(handler); return () => this.guards.delete(handler); },
  };
  register(map, value) {
    assert.equal(map.has(value.name), false, 'duplicate prompt section');
    map.set(value.name, value);
    return () => map.delete(value.name);
  }
  on(type, handler, options = {}) {
    const listeners = this.listeners.get(type) || [];
    options.prepend ? listeners.unshift(handler) : listeners.push(handler);
    this.listeners.set(type, listeners);
    return () => { const index = listeners.indexOf(handler); if (index >= 0) listeners.splice(index, 1); };
  }
  async waterfall(type, args, leaf) {
    const chain = [...(this.listeners.get(type) || [])];
    const next = index => index === chain.length ? leaf() : chain[index](...args, () => next(index + 1));
    return next(0);
  }
  async emit(type, payload) { for (const handler of this.listeners.get(type) || []) await handler(payload); }
}

/** Direct Agent factory fixture: setup/mount precedes durable publication and serial hooks. */
export async function nativeFixture(t, options = {}) {
  const cwd = options.cwd || await realpath(await mkdtemp(path.join(os.tmpdir(), 'bot-native-')));
  if (!options.cwd) t.after(() => rm(cwd, { recursive: true, force: true }));
  const durable = options.durable || {
    members: new Map([['mem-1', { membershipId: 'mem-1', botId: 'bot-1', groupId: 'grp-1', sessionId: 'session-old', lastSeenSeq: 25 }]]),
    bots: new Map([['bot-1', { botId: 'bot-1', name: 'Bot One', provider: 'bot-provider', model: 'bot-model', reasoningEffort: 'high', maxTokens: 4096 }]]),
    groups: new Map([['grp-1', { groupId: 'grp-1', title: 'Group', workspaceCwd: cwd }]]),
    sessions: new Map(),
  };
  const repo = {
    members: new Map([...durable.members].map(([key, value]) => [key, structuredClone(value)])),
    bots: new Map([...durable.bots].map(([key, value]) => [key, structuredClone(value)])),
    groups: new Map([...durable.groups].map(([key, value]) => [key, structuredClone(value)])),
    getMember(id) { return this.members.get(id); },
    getBot(id) { return this.bots.get(id); },
    getGroup(id) { return this.groups.get(id); },
    async putBot(value) {
      await f.beforePutBot?.(value);
      this.bots.set(value.botId, value);
      durable.bots.set(value.botId, structuredClone(value));
      f.calls.botWrites.push(structuredClone(value));
    },
    async putMember(value) {
      await f.beforePut?.(value);
      this.members.set(value.membershipId, value);
      durable.members.set(value.membershipId, structuredClone(value));
      f.calls.writes.push(structuredClone(value));
    },
  };
  const globalListeners = new Map();
  const live = new Map();
  const defaults = Object.freeze({ provider: 'global-provider', model: 'global-model', reasoningEffort: 'low', maxTokens: 8192 });
  const calls = { controllerCreates: [], controllerResolves: [], presets: [], mounts: [], mountCommits: [], creates: [], resolves: [], observes: [], writes: [], directories: [], approvals: [], submissions: [], admissions: [], nativeDisposals: 0, leasesReleased: 0, botWrites: [], defaultsSaved: [], observerErrors: [] };
  const f = { cwd, durable, repo, live, defaults, calls };
  const emit = async (type, ...args) => { for (const handler of globalListeners.get(type) || []) await handler(...args); };
  const notify = (type, ...args) => {
    for (const handler of globalListeners.get(type) || []) {
      try { Promise.resolve(handler(...args)).catch(error => calls.observerErrors.push(error)); }
      catch (error) { calls.observerErrors.push(error); }
    }
  };
  const activate = async (id, { meta, agentOptions = {}, setup, ordinary = false, parentAgent, signal } = {}) => {
    signal?.throwIfAborted();
    if (live.has(id)) throw coded('session/writer-held');
    const stored = durable.sessions.get(id) || (meta ? { header: { id, ...meta }, events: [] } : undefined);
    if (!stored) throw coded('session/not-found');
    if (ordinary && stored.header.origin === 'subagent') throw coded('session/agent-busy');
    const scope = new Scope();
    let picked;
    const session = {
      id, header: Object.freeze({ ...stored.header }),
      get seq() { return stored.events.length; },
      snapshotEvents: () => [...stored.events],
      requestHeader: () => stored.events.findLast(event => event.type === 'request/header')?.data.header,
      append(type, data) {
        const event = { type, data: structuredClone(data), seq: stored.events.length };
        stored.events.push(event);
        if (type === 'request/header' && sameSelection(picked, data.header.config)) picked = undefined;
        if (live.get(id) === agent) notify('session/event', session, event);
        return event;
      },
    };
    picked = modelProjection(session).pending || undefined;
    const agent = {
      id, session, ctx: scope, options: agentOptions, parentAgent,
      selectForNextRequest(selected) { session.append('model/selection', selected); picked = selected; },
      async followup(input) { calls.submissions.push({ agent, input: structuredClone(input) }); await scope.emit('agent/inbox/claimed', { agent, message: input, turn: 1 }); },
      async assemble(subject = agent) {
        return scope.waterfall('system-prompt/assemble', [{}, { agent: subject, scope: subject }], async () => ({
          variables: { provider: 'seed', model: 'seed', native: true },
          sections: [...scope.sections.values()].map(section => ({ ...section, text: typeof section.text === 'function' ? section.text({ agent: subject }) : section.text })),
        }));
      },
      async request(subject = agent) {
        return scope.waterfall('agent/request', [{ agent: subject }], async () => ({ ...defaults, temperature: 0.4 }));
      },
    };
    if (ordinary) {
      // Only legacy ordinary controller Agents own the native model cache.
      let selection;
      scope.on('system-prompt/assemble', async (_assembly, _context, next) => {
        selection = picked || session.requestHeader()?.config || defaults;
        const result = await next();
        return { ...result, variables: { ...result.variables, provider: selection.provider, model: selection.model } };
      });
      scope.on('agent/request', async (_payload, next) => {
        const result = await next();
        return { ...result, provider: selection?.provider || defaults.provider, model: selection?.model || defaults.model, reasoningEffort: selection?.reasoningEffort || defaults.reasoningEffort };
      });
    }
    let disposed = false;
    const handle = { agent, async dispose() {
      if (disposed) return;
      disposed = true;
      calls.nativeDisposals += 1;
      if (live.get(id) === agent) { live.delete(id); await emit('agent/disposed', { agent }); }
      scope.listeners.clear();
      scope.sections.clear();
      scope.contexts.clear();
      scope.restrictions.clear();
      scope.guards.clear();
    } };
    try {
      if (setup) (await setup(scope, agent))?.commit();
      else await services.get('agentPresets').mount(scope, stored.header.agentPreset);
      durable.sessions.set(id, stored);
      live.set(id, agent);
      await emit('session/created', session);
      await emit('agent/created', { agent, source: meta ? 'startup' : 'resume' });
      await f.afterCreate?.(agent);
      return handle;
    } catch (error) { await handle.dispose(); throw error; }
  };
  const controller = {
    async create(request) { calls.controllerCreates.push(request); throw new Error('ordinary controller creation is forbidden for Bots'); },
    async resolveAgent(id) {
      calls.controllerResolves.push(id);
      try { return { agent: live.get(id) || (await activate(id, { ordinary: true })).agent }; }
      catch (error) { return { error }; }
    },
    async selectModel(request) {
      const { agent, error } = await controller.resolveAgent(request.sessionId);
      if (error) throw error;
      const resolved = await services.get('llm').resolveCallConfig(request);
      const selected = { provider: resolved.provider, model: resolved.model, ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }) };
      agent.selectForNextRequest(selected);
      calls.defaultsSaved.push(selected);
      return { selected };
    },
    async disposeAgent(id) {
      const agent = live.get(id);
      calls.nativeDisposals += 1;
      live.delete(id);
      if (agent) await emit('agent/disposed', { agent });
    },
  };
  const services = new Map([
    ['sessionController', controller],
    ['sessionQuery', {
      async observeSession(id, options) {
        assert.deepEqual(options, { projectionMode: 'none' });
        calls.observes.push(id);
        await f.beforeObserve?.(id);
        const stored = durable.sessions.get(id);
        if (!stored) throw coded('SESSION_QUERY_SESSION_NOT_FOUND');
        return { header: { ...stored.header }, events: structuredClone(stored.events), [Symbol.dispose]() { calls.leasesReleased += 1; } };
      },
    }],
    ['agentPresets', {
      async resolve(id) { calls.presets.push(id); await f.beforePreset?.(id); return { id: id || f.defaultPreset || 'native-default' }; },
      async mount(scope, id) {
        await f.beforeMount?.(scope, id);
        calls.mounts.push({ scope, id });
        assert.equal(scope.mounted, undefined, 'each Agent scope mounts the native preset once');
        scope.mounted = id;
        scope.systemPrompt.section({ name: 'deployment:persona-prefix', text: 'Native deployment persona' });
        scope.systemPrompt.section({ name: 'native:tools', text: 'Native preset instructions' });
        return { id };
      },
    }],
    ['tools', { get: (name, agent) => [...BOT_TEAM_TOOL_NAMES, 'subagent', 'subagent_fork', 'ask_user_question', 'workflow', 'send_message', 'create_goal', 'schedule_list', 'schedule_delete', ...(agent?.ctx.mounted ? ['schedule_create', 'schedule_update'] : [])].includes(name) ? {} : undefined }],
    ['workingDirectory', { async set(agent, cwd) { await f.beforeDirectory?.(agent, cwd); calls.directories.push({ id: agent.id, cwd }); } }],
    ['approval', { setPolicy(agent, policy) { calls.approvals.push({ id: agent.id, policy }); } }],
    ['sandboxPolicy', { overrideOf: session => session.snapshotEvents().findLast(event => event.type === 'sandbox/mode')?.data.mode }],
    ['sessionProjections', { stateOf: modelProjection }],
    ['llm', {
      resolveCallConfig: async request => ({ ...request, ...(request.reasoningEffort === undefined && f.defaultReasoning ? { reasoningEffort: f.defaultReasoning } : {}) }),
      resolveModelInfo: async () => ({ inputModalities: f.modalities || ['text', 'image'] }),
    }],
    ['attachments', {
      async readImage(ref) { return { ref, data: Buffer.from('verified-image') }; },
      async admitPromptContent(content) {
        calls.admissions.push(structuredClone(content));
        if (f.admissionError) throw f.admissionError;
        return content.map(part => part.type === 'image' ? { type: 'image', attachment: { attachmentId: 'sha256:admitted', mediaType: part.mediaType } } : structuredClone(part));
      },
    }],
  ]);
  const ctx = {
    get: name => services.get(name),
    agents: {
      get: id => live.get(id),
      roots: () => [...live.values()].filter(agent => !agent.parentAgent),
      async create(options) {
        assert.equal(options.parentAgent, undefined, 'Bot backgrounds are runtime roots without invented parents');
        assert.equal(options.meta.origin, 'subagent');
        calls.creates.push({ sessionId: options.sessionId, cwd: options.meta.cwd, origin: options.meta.origin, agentPreset: options.meta.agentPreset });
        assert.ok([...durable.members.values()].some(member => member.sessionId === options.sessionId), 'mapping must be durable before factory creation');
        await f.beforeCreate?.(options);
        return activate(options.sessionId, { ...options, meta: options.meta });
      },
      async resume(options) {
        assert.equal(options.parentAgent, undefined);
        calls.resolves.push(options.resumeSessionId);
        await f.beforeResolve?.(options.resumeSessionId);
        if (f.resolveError) throw f.resolveError;
        return activate(options.resumeSessionId, options);
      },
    },
    on(type, handler, options = {}) {
      // Native controller scopes are siblings of the plugin, not its children.
      // Cordis dispatch admits these lifecycle listeners only with global:true.
      assert.equal(options.global, true);
      const listeners = globalListeners.get(type) || new Set();
      listeners.add(handler);
      globalListeners.set(type, listeners);
      return () => listeners.delete(handler);
    },
  };
  Object.assign(f, { ctx, services, controller, emit, globalListeners, activateStored: (id, options) => activate(id, options), selectModel: async (agent, selected) => { agent.session.append('model/selection', selected); } });
  const pool = new AgentPool({ ctx, repo, personas: {}, config: { dataDir: cwd, botSandbox: true, botApprovalPolicy: 'ask' }, logger: null });
  pool.attachPrompt({ renderPersona: id => 'Bot identity: ' + repo.getBot(id).name, renderGroupContext: id => 'Roster for ' + id });
  Object.assign(f, { pool, member: repo.getMember('mem-1'), bot: repo.getBot('bot-1'), group: repo.getGroup('grp-1') });
  t.after(() => pool.disposeAll());
  return f;
}
