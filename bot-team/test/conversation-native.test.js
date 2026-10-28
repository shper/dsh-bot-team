import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentPool } from '../host/agents.js';
import { BackgroundInteractions } from '../host/background-interactions.js';
import { BotSessionVisibility } from '../host/session-visibility.js';
import { collectNativeConversationBlockers, nativeConversationCapability } from '../host/native-activity.js';
import { nativeFixture, deferred } from './agent-native-fixture.js';

async function conversationFixture(t) {
  const f = await nativeFixture(t);
  f.group.activeConversationId = 'c1';
  f.member.sessionConversationId = 'c1';
  f.conversation = { conversationId: 'c1', afterSeq: 0 };
  f.repo.activeConversation = () => f.conversation;
  f.repo.sessionBindings = new Map([[f.member.sessionId, { ...f.member, conversationId: 'c1' }]]);
  f.repo.sessionBindingFor = id => f.repo.sessionBindings.get(id);
  f.repo.bindSession = async (member, value) => {
    const old = f.repo.sessionBindings.get(value.sessionId);
    assert.ok(!old || old.conversationId === value.conversationId);
    f.repo.sessionBindings.set(value.sessionId, { ...member, ...value });
  };
  f.repo.putMemberStrict = async (member, expected) => {
    f.lastExpected = expected;
    await f.beforeStrict?.(member);
    assert.equal(expected.expectedConversationId, f.conversation.conversationId);
    assert.equal(expected.expectedSessionId, f.repo.getMember(member.membershipId).sessionId);
    const copy = structuredClone(member);
    f.repo.members.set(member.membershipId, copy);
    f.durable.members.set(member.membershipId, copy);
    return copy;
  };
  f.next = (id, afterSeq = 70) => {
    f.group.activeConversationId = id;
    f.conversation = { conversationId: id, afterSeq };
  };
  return f;
}
const input = content => ({ id: 'conversation-input', role: 'user', source: { kind: 'user' }, content: content || [{ type: 'text', text: 'New work' }] });

test('multiple new conversations rotate lazily once and preserve old durable bindings', async t => {
  const f = await conversationFixture(t);
  const old = await f.pool.ensure('mem-1');
  f.next('c2', 70);
  f.next('c3', 85);
  assert.equal(f.calls.creates.length, 1);
  assert.equal(f.pool.current('mem-1'), undefined);
  assert.equal(f.pool.memberForSession(old.id), undefined);
  const fresh = await f.pool.ensure('mem-1');
  const member = f.repo.getMember('mem-1');
  assert.notEqual(fresh.id, old.id);
  assert.equal(member.sessionConversationId, 'c3');
  assert.equal(member.lastSeenSeq, 85);
  assert.deepEqual(member.previousSessionIds, [old.id]);
  assert.equal(f.repo.sessionBindingFor(old.id).conversationId, 'c1');
  assert.equal(f.repo.sessionBindingFor(fresh.id).conversationId, 'c3');
  assert.deepEqual(f.lastExpected, { expectedConversationId: 'c3', expectedSessionId: old.id });
  assert.equal(f.calls.resolves.length, 0);
  assert.equal(f.live.has(old.id), false);
  assert.equal(f.pool.overlays.has(old), false);
  assert.equal(await f.pool.ensure('mem-1'), fresh);
});

test('a disabled member with no old log still rotates past skipped conversations', async t => {
  const f = await conversationFixture(t);
  f.member.enabled = false;
  f.next('c3', 99);
  const fresh = await f.pool.ensure('mem-1');
  assert.notEqual(fresh.id, 'session-old');
  assert.deepEqual(f.calls.observes, []);
  assert.equal(f.repo.getMember('mem-1').lastSeenSeq, 99);
});

test('failed strict mapping persistence leaves old identity published and never creates an Agent', async t => {
  const f = await conversationFixture(t);
  f.next('c2');
  f.beforeStrict = () => { throw new Error('disk failure'); };
  await assert.rejects(f.pool.ensure('mem-1'), /disk failure/);
  assert.equal(f.repo.getMember('mem-1').sessionId, 'session-old');
  assert.equal(f.repo.getMember('mem-1').sessionConversationId, 'c1');
  assert.equal(f.calls.creates.length, 0);
  f.beforeStrict = undefined;
  assert.notEqual((await f.pool.ensure('mem-1')).id, 'session-old');
});

test('startup restoration and agent-created never overlay a stale native session', async t => {
  const f = await conversationFixture(t);
  const old = await f.pool.ensure('mem-1');
  f.next('c2');
  const replacement = new AgentPool({ ctx: f.ctx, repo: f.repo, personas: {}, config: { dataDir: f.cwd }, logger: null });
  t.after(() => replacement.disposeAll());
  await replacement.ready;
  await f.emit('agent/created', { agent: old });
  assert.equal(replacement.overlays.has(old), false);
  assert.equal(replacement.current('mem-1'), undefined);
  assert.equal(replacement.memberForSession(old.id), undefined);
  assert.equal(f.calls.creates.length, 1);
});

test('admission closes synchronously and preparation rechecks after each host await', async t => {
  const f = await conversationFixture(t);
  f.pool.assertAdmission = () => { throw new Error('switching'); };
  await assert.rejects(f.pool.ensure('mem-1'), /switching/);
  assert.equal(f.pool.preparing.size, 0);
  f.pool.assertAdmission = undefined;
  const entered = deferred(), release = deferred();
  f.beforePreset = async () => { entered.resolve(); await release.promise; };
  const pending = f.pool.ensure('mem-1');
  await entered.promise;
  f.next('c2');
  release.resolve();
  await assert.rejects(pending, /stale conversation/);
  assert.equal(f.calls.creates.length, 0);
});

test('native attachment awaits cannot deliver a stale conversation input', async t => {
  const f = await conversationFixture(t);
  const agent = await f.pool.ensure('mem-1');
  const entered = deferred(), release = deferred();
  f.services.get('attachments').admitPromptContent = async content => { entered.resolve(); await release.promise; return content; };
  const pending = f.pool.submit(agent, input([{ type: 'image', attachment: { attachmentId: 'image-ref', mediaType: 'image/png' } }]));
  await entered.promise;
  assert.equal(f.pool.isPreparingGroup('grp-1'), true);
  f.next('c2');
  release.resolve();
  await assert.rejects(pending, /stale conversation/);
  assert.equal(f.calls.submissions.length, 0);
  assert.equal(f.pool.isPreparingGroup('grp-1'), false);
});

test('model assembly rechecks generation after routing resolution and old selection is ignored', async t => {
  const f = await conversationFixture(t);
  const agent = await f.pool.ensure('mem-1');
  const entered = deferred(), release = deferred();
  f.services.get('llm').resolveCallConfig = async value => { entered.resolve(); await release.promise; return value; };
  f.bot.model = 'new-model-to-resolve';
  const pending = agent.assemble();
  await entered.promise;
  f.next('c2');
  release.resolve();
  await assert.rejects(pending, /stale conversation/);
  await f.selectModel(agent, { provider: 'old-provider', model: 'old-model' });
  assert.equal(f.calls.botWrites.length, 0);
});

test('old interaction responses reject even when membership still points to the old session', async t => {
  const f = await conversationFixture(t);
  const agent = await f.pool.ensure('mem-1');
  const bridge = new BackgroundInteractions({ ctx: f.ctx, repo: f.repo, bus: { emit() {} } });
  t.after(() => bridge.dispose());
  const request = bridge.receive('question', { agent, questions: [{ id: 'q', question: 'Continue?' }] }, () => 'ordinary');
  const aborted = assert.rejects(request, error => error.code === 'ASK_ABORTED');
  const view = bridge.snapshot('grp-1').interactions[0];
  assert.equal(view.conversationId, 'c1');
  f.next('c2');
  await assert.rejects(bridge.respond({ groupId: 'grp-1', sessionId: agent.id, interactionId: view.interactionId, operation: 'answer', answer: { answers: [{ id: 'q', custom: 'yes' }] } }), /失效|不存在/);
  await aborted;
});

function activityFixture() {
  const root = { id: 'root', status: 'idle', whenIdle: async () => {}, inbox: { nextTurn: [], nextStep: [] } };
  const child = { id: 'child', status: 'idle', whenIdle: async () => {}, inbox: { nextTurn: [], nextStep: [] } };
  const live = new Map([[root.id, root]]), goals = new Map(), jobs = new Map(), logs = new Map();
  const member = { membershipId: 'm', groupId: 'g', sessionId: root.id };
  let descendants = [], disposed = 0, borrowed = false;
  const services = {
    agents: { get: id => live.get(id), list: () => [...live.values()], roots: () => [root], isOwnedBy: (id, owner) => id === child.id && owner === root },
    goals: { get: agent => goals.get(agent.id) },
    jobs: { list: id => jobs.get(id) || [] },
    subagents: { listDescendants: async () => descendants, drainDescendants: async () => {} },
    sessionQuery: { observeSession: async id => ({ header: { id }, events: logs.get(id) || [], [Symbol.dispose]() { disposed++; } }) },
  };
  const ctx = { get: name => services[name] };
  const repo = { members: new Map([['m', member]]), getMember: () => member };
  const pool = { owns: agent => !borrowed && agent === root, drainedSessions: new Set(), isPreparingGroup: () => false };
  const collect = () => collectNativeConversationBlockers({ ctx, repo, pool, groupId: 'g' });
  return { ctx, services, repo, pool, root, child, live, goals, jobs, logs, collect,
    descendants: value => { descendants = value; }, borrowed: () => { borrowed = true; }, disposals: () => disposed };
}

test('native activity reads scoped optional services only through ctx.get', async () => {
  const f = activityFixture();
  for (const name of ['botTeamNativeActivity', ...Object.keys(f.services)]) {
    Object.defineProperty(f.ctx, name, { get() {
      assert.fail('cannot get property "' + name + '" without inject');
    } });
  }
  f.ctx.get = function (name) { assert.equal(this, f.ctx); return f.services[name]; };
  assert.deepEqual(nativeConversationCapability(f), { supported: true, missing: [] });
  assert.deepEqual(await f.collect(), []);

  delete f.services.jobs;
  assert.deepEqual(nativeConversationCapability(f).missing, ['jobs.list']);
  assert.equal((await f.collect())[0].kind, 'native-unsupported');

  const blocked = { kind: 'native-job', message: 'Adapter job is still running' };
  f.services.botTeamNativeActivity = { capability: { supported: true }, collect: () => [blocked] };
  assert.equal(nativeConversationCapability(f).supported, true);
  assert.deepEqual(await f.collect(), [blocked]);
  // Plain embedders without Cordis still supply services as ordinary properties.
  assert.equal(nativeConversationCapability({ ctx: f.services }).supported, true);
});

test('native blockers inspect inbox, descendant jobs, armed goals and real root ownership', async () => {
  const f = activityFixture();
  assert.equal(nativeConversationCapability(f).supported, true);
  assert.deepEqual(await f.collect(), []);
  f.root.inbox.nextTurn.push({ id: 'queued' });
  assert.ok((await f.collect()).some(value => value.kind === 'native-inbox'));
  f.root.inbox.nextTurn.length = 0;
  f.live.set(f.child.id, f.child);
  f.descendants([{ kind: 'child', id: 'child', parentId: 'root', mode: 'continuable', activity: 'running' }]);
  assert.deepEqual(await f.collect(), [], 'resident child list.running is not itself busy when its actual loop and inbox are idle');
  f.jobs.set('child', [{ id: 'shell-child', owner: 'child', status: 'stopping' }]);
  assert.ok((await f.collect()).some(value => value.jobId === 'shell-child'));
  f.jobs.clear();
  f.goals.set('child', { id: 'goal', phase: 'active', activation: 'armed' });
  assert.ok((await f.collect()).some(value => value.kind === 'native-goal'));
  f.goals.get('child').activation = 'disarmed';
  assert.deepEqual(await f.collect(), []);
  f.borrowed();
  assert.ok((await f.collect()).some(value => value.kind === 'native-borrowed'));
});

test('unknown external descendants remain busy despite a misleading inactive listing', async () => {
  const f = activityFixture();
  f.descendants([{ kind: 'child', id: 'external', mode: 'external', activity: 'inactive' }]);
  assert.ok((await f.collect()).some(value => value.kind === 'native-descendant-unknown'));
  f.live.clear();
  f.pool.drainedSessions.add('root');
  assert.deepEqual(await f.collect(), []);
});

test('cold root and child inboxes are observed without activation and leases are released', async () => {
  const f = activityFixture();
  f.live.clear();
  f.descendants([{ kind: 'child', id: 'child', mode: 'continuable', activity: 'inactive' }]);
  f.logs.set('child', [{ type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [{ id: 'parked' }] } }]);
  assert.ok((await f.collect()).some(value => value.sessionId === 'child' && value.kind === 'native-inbox'));
  assert.equal(f.disposals(), 2);
});

test('missing native services fail closed unless a verified embedder adapter is explicit', async () => {
  const ctx = { get: () => undefined };
  assert.equal(nativeConversationCapability({ ctx }).supported, false);
  assert.equal((await collectNativeConversationBlockers({ ctx, groupId: 'g' }))[0].kind, 'native-unsupported');
  const adapted = { get: name => name === 'botTeamNativeActivity' ? { capability: () => ({ supported: true }), collect: () => [] } : undefined };
  assert.equal(nativeConversationCapability({ ctx: adapted }).supported, true);
  assert.deepEqual(await collectNativeConversationBlockers({ ctx: adapted, groupId: 'g' }), []);
});

test('visibility retains binding ownership when a member and its messages are gone', async t => {
  const calls = [];
  const ctx = { agents: { get() {} }, on: () => () => {}, get: name => name === 'workspaceController'
    ? { archiveSession: async ({ sessionId }) => { calls.push(sessionId); return { archivedSessionIds: [sessionId] }; } }
    : name === 'sessionQuery' ? { observeSession: async id => ({ header: { id, cwd: '/tmp/bot-history' }, events: [], [Symbol.dispose]() {} }) } : undefined };
  const repo = { members: new Map(), messages: new Map(), sessionBindings: new Map([['binding', { sessionId: 'old-ordinary-history' }]]) };
  const visibility = new BotSessionVisibility({ ctx, repo, logger: null });
  t.after(() => visibility.dispose());
  await visibility.ready;
  assert.deepEqual(calls, ['old-ordinary-history']);
});

test('only exact non-waking approval policy annotations are ignored, without changing the inbox', async () => {
  const f = activityFixture();
  const note = { role: 'user', source: { kind: 'user-approval' }, content: [{ type: 'text', text: 'The approval policy changed from "ask" to "never" (changed by the user).' }] };
  f.root.inbox.nextStep.push(note);
  assert.deepEqual(await f.collect(), []);
  assert.deepEqual(f.root.inbox.nextStep, [note]);
  f.root.inbox.nextTurn.push(note);
  assert.ok((await f.collect()).some(value => value.kind === 'native-inbox'));
  f.root.inbox.nextTurn.length = 0;
  f.root.inbox.nextStep.push({ ...note, source: { kind: 'subagent-settled' } });
  assert.ok((await f.collect()).some(value => value.kind === 'native-inbox'));
  f.root.inbox.nextStep.pop();
  f.root.inbox.nextStep.push({ ...note, content: [{ type: 'text', text: 'Please run something' }] });
  assert.ok((await f.collect()).some(value => value.kind === 'native-inbox'));
});

test('idle status with a pending public whenIdle stays busy during native maintenance', async () => {
  const f = activityFixture();
  const pending = deferred();
  f.root.whenIdle = () => pending.promise;
  assert.ok((await f.collect()).some(value => value.kind === 'native-agent'));
  pending.resolve();
  assert.deepEqual(await f.collect(), []);
});

test('a missing root catalog still queries descendants and detects an orphan live child', async () => {
  const f = activityFixture();
  f.live.delete('root');
  f.child.session = { header: { parentSession: 'root' } };
  f.child.status = 'running';
  f.live.set(f.child.id, f.child);
  const missing = () => { throw Object.assign(new Error('missing'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' }); };
  f.services.sessionQuery.observeSession = async () => missing();
  let queries = 0;
  f.services.subagents.listDescendants = async () => { queries++; return missing(); };
  assert.ok((await f.collect()).some(value => value.sessionId === f.child.id && value.kind === 'native-agent'));
  assert.equal(queries, 1);
});
