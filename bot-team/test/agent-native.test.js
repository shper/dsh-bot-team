import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentPool } from '../host/agents.js';
import { nativeFixture, deferred } from './agent-native-fixture.js';

test('a deployment still selecting the legacy preset does not rotate on every turn', async t => {
  const f = await nativeFixture(t);
  f.defaultPreset = 'bot-team-tools';
  const first = await f.pool.ensure('mem-1');
  const id = f.member.sessionId;
  assert.equal(await f.pool.ensure('mem-1'), first);
  await f.pool.disposeMember('mem-1');
  const restored = await f.pool.ensure('mem-1');
  assert.equal(restored.id, id);
  assert.equal(f.member.sessionId, id);
  assert.equal(f.calls.creates.length, 1);
  assert.deepEqual(f.calls.resolves, [id]);
  assert.equal(f.member.previousSessionIds, undefined);
});

const selection = bot => ({ provider: bot.provider, model: bot.model, reasoningEffort: bot.reasoningEffort, maxTokens: bot.maxTokens });
const input = (id = 'input-1') => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Do the work' }] });
function seed(f, header = {}, id = f.member.sessionId) {
  f.durable.sessions.set(id, { header: { id, cwd: f.cwd, origin: 'subagent', agentPreset: 'native-default', ...header }, events: [] });
}

test('owned create is hidden, durably mapped and mounts the current native default before publication', async t => {
  const f = await nativeFixture(t);
  f.afterCreate = agent => {
    assert.equal(f.pool.memberForSession(agent.id), f.member);
    assert.ok(agent.ctx.sections.has('bot-team:persona'));
    assert.equal(agent.ctx.mounted, 'native-default');
  };
  const agent = await f.pool.ensure('mem-1');
  assert.deepEqual(f.calls.creates, [{ sessionId: 'session-old', cwd: f.cwd, origin: 'subagent', agentPreset: 'native-default' }]);
  assert.equal(agent.session.header.parentSession, undefined);
  assert.equal(agent.parentAgent, undefined);
  assert.equal(f.pool.owns(agent), true);
  assert.deepEqual(f.calls.controllerCreates, []);
  assert.deepEqual(f.calls.controllerResolves, []);
  assert.deepEqual(f.calls.presets, [undefined]);
  const assembly = await agent.assemble();
  assert.equal(assembly.sections.find(section => section.name === 'deployment:persona-prefix').text, 'Native deployment persona');
  assert.match(assembly.sections.find(section => section.name === 'bot-team:persona').text, /Bot One/);
  const denied = [...agent.ctx.restrictions].flatMap(rule => rule.deny);
  assert.deepEqual(denied.sort(), ['bot_team_create_group', 'bot_team_debate', 'bot_team_discuss', 'bot_team_discussion_control', 'bot_team_review', 'bot_team_send', 'bot_team_task_create', 'bot_team_task_update', 'schedule_create', 'schedule_update'].sort());
  for (const allowed of ['subagent', 'subagent_fork', 'ask_user_question', 'workflow', 'send_message', 'create_goal', 'update_goal', 'schedule_list', 'schedule_delete', 'bot_team_list', 'bot_team_task_list']) assert.ok(!denied.includes(allowed));
  assert.deepEqual(f.calls.approvals, [{ id: agent.id, policy: 'ask' }]);
  assert.deepEqual(agent.session.snapshotEvents().filter(event => event.type === 'sandbox/mode').map(event => event.data), [{ mode: 'workspace-write' }]);
  assert.equal(await f.pool.ensure('mem-1'), agent);
  assert.equal(f.calls.mounts.length, 1);
  assert.equal(f.calls.creates.length, 1);
  assert.equal(f.calls.approvals.length, 1);
  assert.equal(f.pool.current('mem-1'), agent);
});

test('compatible hidden history resumes directly with the current native preset', async t => {
  const f = await nativeFixture(t);
  seed(f);
  f.durable.sessions.get('session-old').events.push({ type: 'turn/end', data: { turn: 2 }, seq: 0 });
  const agent = await f.pool.ensure('mem-1');
  assert.equal(agent.id, 'session-old');
  assert.equal(f.member.lastSeenSeq, 25);
  assert.equal(f.calls.creates.length, 0);
  assert.deepEqual(f.calls.resolves, ['session-old']);
  assert.equal(f.calls.leasesReleased, 2);
  assert.equal(agent.session.snapshotEvents()[0].type, 'turn/end');
  assert.equal(f.pool.owns(agent), true);
  assert.deepEqual(f.calls.controllerResolves, []);
});

test('owned cold recovery releases the old handle and restores the same hidden identity', async t => {
  const first = await nativeFixture(t);
  const original = await first.pool.ensure('mem-1');
  await original.assemble();
  original.session.append('request/header', { header: { config: await original.request() } });
  await first.pool.disposeAll();
  assert.equal(first.live.has(original.id), false);
  const second = await nativeFixture(t, { cwd: first.cwd, durable: first.durable });
  const agent = await second.pool.ensure('mem-1');
  assert.equal(second.calls.creates.length, 0);
  assert.equal(agent.id, original.id);
  assert.equal(second.pool.current('mem-1'), agent);
  assert.deepEqual(second.pool.list(), ['mem-1']);
  assert.equal((await agent.assemble()).variables.provider, second.bot.provider);
  assert.deepEqual(await agent.request(), { ...selection(second.bot), temperature: 0.4 });
  assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'sandbox/mode').length, 1);
});

test('ordinary sessions rotate only on next execution and their live controller Agents remain untouched', async t => {
  const f = await nativeFixture(t);
  seed(f, { origin: undefined });
  f.member.previousSessionIds = ['older-session'];
  const { agent: ordinary } = await f.controller.resolveAgent('session-old');
  const previous = structuredClone(f.durable.sessions.get('session-old'));
  assert.equal(f.member.sessionId, 'session-old');
  assert.equal(f.pool.owns(ordinary), false);
  const agent = await f.pool.ensure('mem-1');
  assert.notEqual(agent.id, ordinary.id);
  assert.equal(agent.session.header.origin, 'subagent');
  assert.deepEqual(f.durable.sessions.get(ordinary.id), previous);
  assert.equal(f.live.get(ordinary.id), ordinary);
  assert.deepEqual(f.member.previousSessionIds, ['older-session', 'session-old']);
  assert.equal(f.member.lastSeenSeq, 0);
  assert.equal(f.calls.controllerResolves.length, 1, 'only the explicit legacy activation called the controller');
  await f.pool.disposeAll();
  assert.equal(f.live.get(ordinary.id), ordinary);
  assert.equal(f.live.has(agent.id), false);
});

test('legacy limited preset rotates to a new hidden native-default session without changing old logs', async t => {
  const f = await nativeFixture(t);
  seed(f, { agentPreset: 'bot-team-tools' });
  const old = f.durable.sessions.get('session-old');
  old.events.push({ type: 'assistant/message', data: { text: 'old log' }, seq: 0 });
  const before = structuredClone(old);
  const agent = await f.pool.ensure('mem-1');
  assert.notEqual(agent.id, 'session-old');
  assert.equal(agent.session.header.origin, 'subagent');
  assert.equal(agent.session.header.agentPreset, 'native-default');
  assert.deepEqual(old, before);
  assert.deepEqual(f.calls.resolves, []);
  assert.deepEqual(f.member.previousSessionIds, ['session-old']);
});

test('stored preset selection is authoritative over a legacy immutable header', async t => {
  const f = await nativeFixture(t);
  seed(f, { agentPreset: 'bot-team-tools' });
  f.durable.sessions.get('session-old').events.push({ type: 'agent-preset/selected', data: { agentPreset: 'native-default' }, seq: 0 });
  const agent = await f.pool.ensure('mem-1');
  assert.equal(agent.id, 'session-old');
  assert.equal(agent.session.header.agentPreset, 'bot-team-tools');
  assert.equal(agent.ctx.mounted, 'native-default');
  assert.equal(f.calls.creates.length, 0);
});

test('a valid stored native preset restores the same hidden identity even when the current default changes or breaks', async t => {
  const f = await nativeFixture(t);
  const old = await f.pool.ensure('mem-1');
  old.session.append('assistant/message', { text: 'Keep the conversation context' });
  const previous = structuredClone(f.durable.sessions.get(old.id));
  await f.pool.disposeMember('mem-1');
  f.defaultPreset = 'new-native-default';
  f.beforePreset = id => { if (id === undefined) throw new Error('Current default is broken'); };
  const agent = await f.pool.ensure('mem-1');
  assert.equal(agent.id, old.id);
  assert.notEqual(agent, old);
  assert.equal(agent.ctx.mounted, 'native-default');
  assert.deepEqual(f.calls.presets, [undefined, 'native-default']);
  assert.deepEqual(f.durable.sessions.get(old.id), previous);
  assert.equal(f.calls.creates.length, 1);
  assert.equal(f.member.previousSessionIds, undefined);
});

for (const failure of ['missing-id', 'unavailable', 'broken', 'wrong-id']) {
  test('stored native preset ' + failure + ' fails closed without replacing the session', async t => {
    const f = await nativeFixture(t);
    seed(f, { agentPreset: failure === 'missing-id' ? undefined : 'saved-native' });
    const previousMember = structuredClone(f.member);
    const previousSession = structuredClone(f.durable.sessions.get('session-old'));
    f.services.get('agentPresets').resolve = async id => {
      assert.equal(id, 'saved-native', 'a broken saved preset never falls back to the current default');
      if (failure === 'unavailable') throw new Error('Saved native preset unavailable');
      return failure === 'broken' ? { id, broken: 'invalid native composition' } : { id: 'different-native' };
    };
    await assert.rejects(f.pool.ensure('mem-1'), /preset/i);
    assert.deepEqual(f.member, previousMember);
    assert.deepEqual(f.durable.sessions.get('session-old'), previousSession);
    assert.deepEqual(f.calls.creates, []);
    assert.deepEqual(f.calls.resolves, []);
    assert.deepEqual(f.calls.writes, []);
  });
}

for (const parent of [{ parentSession: { id: 'real-parent' } }, { parentSessionId: 'real-parent' }, { delegationDepth: 1 }, { parent: null }]) {
  test('parent-owned or malformed hidden lineage is never resumed: ' + JSON.stringify(parent), async t => {
    const f = await nativeFixture(t);
    seed(f, parent);
    const old = structuredClone(f.durable.sessions.get('session-old'));
    const agent = await f.pool.ensure('mem-1');
    assert.notEqual(agent.id, 'session-old');
    assert.deepEqual(f.calls.resolves, []);
    assert.deepEqual(f.durable.sessions.get('session-old'), old);
  });
}

test('a real runtime child without durable parent metadata is never borrowed', async t => {
  const f = await nativeFixture(t);
  seed(f);
  const foreign = await f.activateStored('session-old', { parentAgent: { id: 'real-parent' } });
  t.after(() => foreign.dispose());
  assert.equal(foreign.agent.ctx.sections.has('bot-team:persona'), false);
  const agent = await f.pool.ensure('mem-1');
  assert.notEqual(agent.id, foreign.agent.id);
  assert.equal(f.live.get(foreign.agent.id), foreign.agent);
  assert.equal(f.pool.owns(foreign.agent), false);
  await f.pool.disposeAll();
  assert.equal(f.live.get(foreign.agent.id), foreign.agent);
});

test('a compatible already-live background Agent reuses overlays without borrowing its ownership', async t => {
  const f = await nativeFixture(t);
  seed(f);
  const external = await f.activateStored('session-old');
  t.after(() => external.dispose());
  const agent = await f.pool.ensure('mem-1');
  assert.equal(agent, external.agent);
  assert.equal(f.pool.owns(agent), false);
  assert.deepEqual(f.calls.creates, []);
  assert.deepEqual(f.calls.resolves, []);
  await f.pool.disposeAll();
  assert.equal(f.live.get(agent.id), agent);
  assert.equal(agent.ctx.sections.has('bot-team:persona'), false);
  assert.equal(agent.ctx.sections.get('deployment:persona-prefix').text, 'Native deployment persona');
});

test('disposeMember releases only its owned handle and the next ensure resumes the durable session', async t => {
  const f = await nativeFixture(t);
  const first = await f.pool.ensure('mem-1');
  await f.pool.disposeMember('mem-1');
  assert.equal(f.live.has(first.id), false);
  assert.equal(f.pool.owns(first), false);
  const second = await f.pool.ensure('mem-1');
  assert.notEqual(first, second);
  assert.equal(second.id, first.id);
  await f.pool.disposeAll();
  assert.equal(f.calls.nativeDisposals, 2);
  assert.equal(f.live.size, 0);
  await assert.rejects(f.pool.ensure('mem-1'), /disposed/);
});

test('disposing during creation cannot leak an owned handle or repopulate the pool', async t => {
  const f = await nativeFixture(t);
  const gate = deferred();
  const entered = deferred();
  f.beforeCreate = async () => { entered.resolve(); await gate.promise; };
  const pending = f.pool.ensure('mem-1');
  const rejected = assert.rejects(pending, /disposed/);
  await entered.promise;
  const disposing = f.pool.disposeAll();
  gate.resolve();
  await Promise.all([disposing, rejected]);
  assert.equal(f.live.size, 0);
  assert.equal(f.pool.owned.size, 0);
  assert.equal(f.pool.entries.size, 0);
  assert.equal(f.pool.overlays.size, 0);
});

test('disposeMember before preparation starts aborts the factory admission and permits a later retry', async t => {
  const f = await nativeFixture(t);
  const pending = f.pool.ensure('mem-1');
  const rejected = assert.rejects(pending, /disposed/);
  await Promise.all([f.pool.disposeMember('mem-1'), rejected]);
  assert.equal(f.calls.creates.length, 0);
  assert.equal(f.pool.owned.size, 0);
  const retried = await f.pool.ensure('mem-1');
  assert.equal(f.pool.owns(retried), true);
});

test('disposeMember waits for an old ordinary UI overlay without disposing its controller Agent', async t => {
  const f = await nativeFixture(t);
  seed(f, { origin: undefined });
  const gate = deferred();
  const entered = deferred();
  const llm = f.services.get('llm');
  const resolve = llm.resolveCallConfig;
  llm.resolveCallConfig = async request => { entered.resolve(); await gate.promise; return resolve(request); };
  const resuming = f.controller.resolveAgent('session-old');
  await entered.promise;
  const disposing = f.pool.disposeMember('mem-1');
  gate.resolve();
  const [{ agent }] = await Promise.all([resuming, disposing]);
  assert.equal(f.live.get(agent.id), agent);
  assert.equal(f.pool.owns(agent), false);
  assert.equal(f.pool.overlays.size, 0);
  assert.equal(agent.ctx.listeners.get('agent/request').length, 1);
});

test('hot plugin reload reattaches to surviving borrowed background Agents without remounting presets', async t => {
  const f = await nativeFixture(t);
  seed(f);
  const external = await f.activateStored('session-old');
  t.after(() => external.dispose());
  await f.pool.disposeAll();
  const restored = new AgentPool({ ctx: f.ctx, repo: f.repo, personas: {}, config: f.pool.config, logger: null });
  t.after(() => restored.disposeAll());
  restored.attachPrompt({ renderPersona: () => 'Restored Bot', renderGroupContext: () => 'Restored group' });
  await restored.ready;
  assert.equal(restored.current('mem-1'), external.agent);
  assert.equal(restored.owns(external.agent), false);
  assert.equal(f.calls.mounts.length, 1);
  assert.equal((await external.agent.assemble()).sections.find(section => section.name === 'bot-team:persona').text, 'Restored Bot');
  assert.deepEqual(await external.agent.request(), { ...selection(f.bot), temperature: 0.4 });
});

for (const code of ['SESSION_QUERY_CORRUPT_SESSION', 'SESSION_QUERY_PERSISTENCE_FAILED', 'SESSION_QUERY_ABORTED', 'EACCES']) {
  test('inspection error ' + code + ' never silently recreates a session', async t => {
    const f = await nativeFixture(t);
    const error = Object.assign(new Error(code), { code });
    f.beforeObserve = () => { throw error; };
    await assert.rejects(f.pool.ensure('mem-1'), value => value === error);
    assert.equal(f.member.sessionId, 'session-old');
    assert.equal(f.calls.creates.length, 0);
    assert.equal(f.calls.writes.length, 0);
  });
}

for (const code of ['session/writer-held', 'gateway/internal', 'session/not-found', 'agent-preset/invalid']) {
  test('direct resume error ' + code + ' propagates without a create fallback', async t => {
    const f = await nativeFixture(t);
    seed(f);
    f.resolveError = Object.assign(new Error(code), { code });
    await assert.rejects(f.pool.ensure('mem-1'), value => value === f.resolveError);
    assert.equal(f.calls.creates.length, 0);
    assert.equal(f.member.sessionId, 'session-old');
  });
}

test('mapping persistence failure prevents factory creation', async t => {
  const f = await nativeFixture(t);
  f.beforePut = () => { throw new Error('storage unavailable'); };
  await assert.rejects(f.pool.ensure('mem-1'), /storage unavailable/);
  assert.equal(f.calls.creates.length, 0);
  assert.equal(f.pool.preparing.size, 0);
});

test('publication failure retains the durable identity and retries through direct resume', async t => {
  const f = await nativeFixture(t);
  f.afterCreate = () => { throw new Error('publication interrupted'); };
  await assert.rejects(f.pool.ensure('mem-1'), /publication interrupted/);
  assert.equal(f.live.size, 0);
  f.afterCreate = undefined;
  const agent = await f.pool.ensure('mem-1');
  assert.equal(agent.id, 'session-old');
  assert.equal(f.calls.creates.length, 1);
  assert.deepEqual(f.calls.resolves, ['session-old']);
});

for (const cold of [false, true]) {
  test('concurrent direct ' + (cold ? 'resume' : 'create') + ' is single-flight', async t => {
    const f = await nativeFixture(t);
    if (cold) seed(f);
    const entered = deferred();
    const gate = deferred();
    f[cold ? 'beforeResolve' : 'beforeCreate'] = async () => { entered.resolve(); await gate.promise; };
    const pending = Array.from({ length: 12 }, () => f.pool.ensure('mem-1'));
    await entered.promise;
    assert.equal(f.pool.isPreparingGroup('grp-1'), true);
    gate.resolve();
    const agents = await Promise.all(pending);
    assert.ok(agents.every(agent => agent === agents[0]));
    assert.equal(f.calls.creates.length, cold ? 0 : 1);
    assert.equal(f.calls.resolves.length, cold ? 1 : 0);
    assert.equal(f.pool.isPreparingGroup('grp-1'), false);
  });
}

test('missing controller is irrelevant while missing native presets fails without fallback', async t => {
  const f = await nativeFixture(t);
  f.services.delete('sessionController');
  const agent = await f.pool.ensure('mem-1');
  assert.equal(agent.session.header.origin, 'subagent');
  await f.pool.disposeMember('mem-1');
  f.services.delete('agentPresets');
  await assert.rejects(f.pool.ensure('mem-1'), /preset registry/);
  assert.equal(f.calls.creates.length, 1);
  assert.deepEqual(f.calls.controllerCreates, []);
});

test('unexpected factory identity is released and never installed as a member entry', async t => {
  const f = await nativeFixture(t);
  const create = f.ctx.agents.create;
  f.ctx.agents.create = async options => {
    const handle = await create(options);
    return { ...handle, agent: { ...handle.agent, id: 'unregistered-native-id' } };
  };
  await assert.rejects(f.pool.ensure('mem-1'), /unexpected Bot session/);
  assert.equal(f.pool.entries.size, 0);
  assert.equal(f.pool.owned.size, 0);
  assert.equal(f.live.size, 0);
});

test('overlay setup failure rolls back the unpublished Agent and retries the same identity', async t => {
  const f = await nativeFixture(t);
  f.services.set('approval', { setPolicy() { throw new Error('approval service failed'); } });
  await assert.rejects(f.pool.ensure('mem-1'), /approval service failed/);
  assert.equal(f.pool.overlays.size, 0);
  assert.equal(f.live.size, 0);
  assert.equal(f.member.sessionId, 'session-old');
  f.services.delete('approval');
  const agent = await f.pool.ensure('mem-1');
  assert.equal(agent.id, 'session-old');
  assert.equal(f.calls.creates.length, 2, 'unpublished failures leave no persisted header');
  assert.equal(agent.ctx.listeners.get('agent/request').length, 1);
});

test('late tool guards block undeliverable reminders but leave native delegation and questions available', async t => {
  const f = await nativeFixture(t);
  f.services.set('tools', { get: () => undefined });
  const agent = await f.pool.ensure('mem-1');
  assert.equal(agent.ctx.restrictions.size, 0);
  const [guard] = agent.ctx.guards;
  assert.match(guard({ agent, name: 'bot_team_send' }), /cannot recursively/);
  for (const name of ['schedule_create', 'schedule_update']) assert.match(guard({ agent, name }), /cannot deliver/);
  for (const name of ['subagent', 'subagent_fork', 'ask_user_question', 'workflow', 'create_goal', 'update_goal', 'schedule_list', 'schedule_delete', 'bot_team_list', 'bot_team_task_list']) assert.equal(guard({ agent, name }), undefined);
});

test('legacy ordinary overlays retain reminder tools for their supported controller delivery', async t => {
  const f = await nativeFixture(t);
  seed(f, { origin: undefined });
  const { agent } = await f.controller.resolveAgent('session-old');
  const denied = [...agent.ctx.restrictions].flatMap(rule => rule.deny);
  assert.ok(!denied.includes('schedule_create'));
  assert.equal([...agent.ctx.guards][0]({ agent, name: 'schedule_create' }), undefined);
});

test('background Bot model publishes normalized intent without any global model cache', async t => {
  const f = await nativeFixture(t);
  delete f.bot.reasoningEffort;
  f.defaultReasoning = 'medium';
  const agent = await f.pool.ensure('mem-1');
  const projection = () => f.services.get('sessionProjections').stateOf(agent.session, 'modelSelection');
  assert.deepEqual(projection().pending, { provider: f.bot.provider, model: f.bot.model, reasoningEffort: 'medium' });
  assert.equal(f.calls.defaultsSaved.length, 0);
  assert.equal(f.calls.botWrites.length, 0);
  await agent.assemble();
  const config = await agent.request();
  assert.equal(config.reasoningEffort, 'medium');
  assert.equal(config.maxTokens, 4096);
  agent.session.append('request/header', { header: { config } });
  assert.equal(projection().pending, null);
});

test('old ordinary native model selection persists the Bot route before the next hidden execution', async t => {
  const f = await nativeFixture(t);
  seed(f, { origin: undefined });
  const { agent: ordinary } = await f.controller.resolveAgent('session-old');
  await f.controller.selectModel({ sessionId: ordinary.id, provider: 'ui-provider', model: 'ui-model', reasoningEffort: 'low' });
  await ordinary.assemble();
  const expected = { provider: 'ui-provider', model: 'ui-model', reasoningEffort: 'low', maxTokens: 4096, temperature: 0.4 };
  assert.deepEqual(await ordinary.request(), expected);
  const hidden = await f.pool.ensure('mem-1');
  await hidden.assemble();
  assert.deepEqual(await hidden.request(), expected);
  assert.equal(f.calls.defaultsSaved.length, 1);
  assert.equal(f.durable.bots.get('bot-1').model, 'ui-model');
});

test('concurrent model selections remain durable in order and assembly waits for the latest', async t => {
  const f = await nativeFixture(t);
  const agent = await f.pool.ensure('mem-1');
  const gate = deferred();
  const entered = deferred();
  f.beforePutBot = async value => { if (value.model === 'first-choice') { entered.resolve(); await gate.promise; } };
  await f.selectModel(agent, { provider: 'ui', model: 'first-choice' });
  await entered.promise;
  await f.selectModel(agent, { provider: 'ui', model: 'last-choice' });
  const assembling = agent.assemble();
  gate.resolve();
  await assembling;
  assert.deepEqual(f.calls.botWrites.map(bot => bot.model), ['first-choice', 'last-choice']);
  assert.deepEqual(await agent.request(), { provider: 'ui', model: 'last-choice', maxTokens: 4096, temperature: 0.4 });
});

test('failed model persistence blocks execution until another selection successfully retries', async t => {
  const f = await nativeFixture(t);
  const agent = await f.pool.ensure('mem-1');
  f.beforePutBot = () => { throw new Error('model profile disk failure'); };
  await f.selectModel(agent, { provider: 'ui', model: 'failed-choice' });
  await assert.rejects(agent.assemble(), /model profile disk failure/);
  f.beforePutBot = undefined;
  await f.selectModel(agent, { provider: 'ui', model: 'retry-choice' });
  await agent.assemble();
  assert.equal((await agent.request()).model, 'retry-choice');
});

test('per-Bot routing overrides native selection in the correct waterfall order and never touches defaults', async t => {
  const f = await nativeFixture(t);
  const other = { membershipId: 'mem-2', botId: 'bot-2', groupId: 'grp-1', sessionId: 'session-two' };
  f.repo.members.set(other.membershipId, other);
  f.repo.bots.set('bot-2', { botId: 'bot-2', name: 'Bot Two', provider: 'other-provider', model: 'other-model' });
  const [a, b] = await Promise.all([f.pool.ensure('mem-1'), f.pool.ensure('mem-2')]);
  await Promise.all([a.assemble(), b.assemble()]);
  assert.deepEqual(await a.request(), { ...selection(f.bot), temperature: 0.4 });
  assert.deepEqual(await b.request(), { provider: 'other-provider', model: 'other-model', temperature: 0.4 });
  assert.deepEqual(f.defaults, { provider: 'global-provider', model: 'global-model', reasoningEffort: 'low', maxTokens: 8192 });
  f.bot.model = 'changed-between-assembly-and-request';
  assert.equal((await a.request()).model, 'bot-model', 'one assembly keeps a coherent request snapshot');
  delete f.bot.reasoningEffort;
  delete f.bot.maxTokens;
  await a.assemble();
  assert.deepEqual(await a.request(), { provider: f.bot.provider, model: f.bot.model, temperature: 0.4 });
  assert.equal(f.calls.creates.length, 2, 'model edits do not rotate or destroy native sessions');
});

test('native subagent routing and prompt identity are not overwritten by ancestor Bot overlay', async t => {
  const f = await nativeFixture(t);
  const agent = await f.pool.ensure('mem-1');
  const child = { id: 'native-subagent' };
  const assembly = await agent.assemble(child);
  assert.equal(assembly.variables.model, 'seed');
  assert.equal(assembly.sections.find(section => section.name === 'bot-team:persona').text, '');
  assert.equal((await agent.request(child)).model, 'global-model');
});

test('setup is idempotent under concurrent hook invocation and dynamic persona edits', async t => {
  const f = await nativeFixture(t);
  const agent = await f.pool.ensure('mem-1');
  await Promise.all(Array.from({ length: 10 }, () => f.emit('agent/created', { agent })));
  assert.equal(agent.ctx.listeners.get('agent/request').length, 1, 'background scope has exactly one Bot model listener and no controller cache');
  assert.equal(agent.ctx.listeners.get('agent/inbox/claimed').length, 1);
  f.bot.name = 'Edited identity';
  assert.match((await agent.assemble()).sections.find(section => section.name === 'bot-team:persona').text, /Edited identity/);
});

test('native model-change notice describes the Bot route instead of the global controller cache', async t => {
  const f = await nativeFixture(t);
  const agent = await f.pool.ensure('mem-1');
  agent.session.append('request/header', { header: { config: { provider: 'old-provider', model: 'old-model' } } });
  await agent.assemble();
  const result = await agent.ctx.waterfall('agent/pre-step', [{ agent, step: 1, messages: [input()], signal: new AbortController().signal }], async () => ({
    kind: 'continue', messages: [input(), { id: 'native-notice', role: 'user', source: { kind: 'model-selection', form: 'notice' }, content: [{ type: 'text', text: 'incorrect global route' }] }],
  }));
  const notices = result.messages.filter(message => message.source.kind === 'model-selection');
  assert.equal(notices.length, 1);
  assert.ok(notices[0].content[0].text.includes('old-provider/old-model'));
  assert.ok(notices[0].content[0].text.includes('bot-provider/bot-model'));
  assert.equal(result.messages[0].id, 'input-1');
});

test('submit retains caller identity and source through native attachment admission and scoped claims', async t => {
  const f = await nativeFixture(t);
  const agent = await f.pool.ensure('mem-1');
  const claims = [];
  f.pool.attachClaimHandler(payload => claims.push(payload));
  const message = input();
  message.source = { kind: 'user', clientTimeZone: 'Asia/Shanghai' };
  message.content.push({ type: 'file', attachment: { attachmentId: 'sha256:file', name: 'data.txt', bytes: 12 } });
  await f.pool.submit(agent, message);
  assert.equal(f.calls.admissions.length, 1);
  assert.deepEqual(f.calls.submissions[0].input, message);
  assert.equal(claims[0].agent, agent);
  assert.equal(claims[0].message.id, message.id);
});

test('image submit validates Bot model and durable images through native batch admission', async t => {
  const f = await nativeFixture(t);
  const agent = await f.pool.ensure('mem-1');
  const message = input();
  message.content.push({ type: 'image', attachment: { attachmentId: 'sha256:image', mediaType: 'image/png' } });
  f.modalities = ['text'];
  await assert.rejects(f.pool.submit(agent, message), /does not support image/);
  assert.equal(f.calls.submissions.length, 0);
  f.modalities = ['text', 'image'];
  await f.pool.submit(agent, message);
  assert.equal(f.calls.admissions[0][1].data, Buffer.from('verified-image').toString('base64'));
  assert.equal(f.calls.submissions[0].input.content[1].attachment.attachmentId, 'sha256:admitted');
});

test('attachment admission failure never delivers a partial native input', async t => {
  const f = await nativeFixture(t);
  const agent = await f.pool.ensure('mem-1');
  f.admissionError = new Error('attachment corrupt');
  const message = input();
  message.content.push({ type: 'file', attachment: { attachmentId: 'sha256:file' } });
  await assert.rejects(f.pool.submit(agent, message), /attachment corrupt/);
  assert.equal(f.calls.submissions.length, 0);
});