import test from 'node:test';
import assert from 'node:assert/strict';
import { BotSessionVisibility } from '../host/session-visibility.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const failure = (code, message = code) => Object.assign(new Error(message), { code });

function fixture(t, { members = [], messages = [], headers = [], archived = [], isBusy } = {}) {
  const logs = new Map(headers.map(header => [header.id, {
    header: { cwd: '/tmp/bot-visibility', ...header },
    events: [{ type: 'user/message', seq: 0, data: { id: 'input', content: [{ type: 'text', text: 'Keep this history' }] } }],
  }]));
  const repo = { members: new Map(members.map((member, index) => [String(index), member])), messages: new Map(messages.map((message, index) => [String(index), message])) };
  const active = new Set();
  const agents = new Map();
  const goals = new Map();
  const archivedIds = new Set(archived);
  const reads = [];
  const calls = [];
  const warnings = [];
  const hooks = new Map();
  let observationDisposals = 0;
  const controls = { observe: null, archive: null };
  const controller = {
    async archiveSession(request) {
      assert.deepEqual(Object.keys(request), ['sessionId'], 'must never pass stopActivity');
      calls.push(structuredClone(request));
      await controls.archive?.(request.sessionId);
      if (archivedIds.has(request.sessionId)) return { archivedSessionIds: [...archivedIds] };
      if (!logs.has(request.sessionId)) throw failure('session/not-found');
      if (active.has(request.sessionId)) throw failure('workspace/session-active');
      archivedIds.add(request.sessionId);
      return { archivedSessionIds: [...archivedIds] };
    },
    unarchiveSession() { assert.fail('Migration must never unarchive'); },
    follow() { assert.fail('Migration must never enumerate user Sessions'); },
  };
  const query = {
    async observeSession(sessionId, options) {
      reads.push(sessionId);
      assert.deepEqual(options, { projectionMode: 'none' });
      await controls.observe?.(sessionId);
      const log = logs.get(sessionId);
      if (!log) throw failure('SESSION_QUERY_SESSION_NOT_FOUND');
      return { header: log.header, [Symbol.dispose]() { observationDisposals++; } };
    },
  };
  const ctx = {
    get(name) {
      if (name === 'workspaceController') return controller;
      if (name === 'sessionQuery') return query;
      if (name === 'goals') return { get: agent => goals.get(agent.id) };
      assert.fail('Unexpected service access: ' + name);
    },
    agents: {
      get: id => agents.get(id),
      create() { assert.fail('Migration must never activate Agents'); },
      resume() { assert.fail('Migration must never resume Agents'); },
      dispose() { assert.fail('Migration must never dispose Agents'); },
      list() { assert.fail('Migration must never enumerate Agents'); },
    },
    on(name, callback, options) {
      assert.deepEqual(options, { global: true });
      if (!hooks.has(name)) hooks.set(name, new Set());
      hooks.get(name).add(callback);
      return () => hooks.get(name).delete(callback);
    },
  };
  let visibility;
  const f = {
    ctx, repo, logs, agents, goals, active, archivedIds, reads, calls, warnings, hooks, controls,
    start() { visibility = new BotSessionVisibility({ ctx, repo, logger: { warn: text => warnings.push(text) }, isBusy }); return visibility; },
    emit(name, ...args) { return Promise.all([...hooks.get(name) || []].map(callback => callback(...args))); },
    observationDisposals: () => observationDisposals,
  };
  t.after(async () => { await visibility?.dispose(); });
  return f;
}

const botMessage = sessionId => ({ author: { type: 'bot', botId: 'bot' }, meta: { execution: { sessionId } } });

test('only exact repository Bot ownership is migrated; unrelated and human references stay untouched', async t => {
  const f = fixture(t, {
    members: [{ sessionId: 'current', previousSessionIds: ['previous', 'current', null] }],
    messages: [botMessage('message-only'), botMessage('current'), { author: { type: 'human', botId: 'bot' }, meta: { execution: { sessionId: 'human-session' } } }],
    headers: ['current', 'previous', 'message-only', 'human-session', 'session-botteam-unmapped'].map(id => ({ id })),
    archived: ['other-user-already-archived'],
  });
  const before = structuredClone([...f.logs]);
  const visibility = f.start();
  const result = await visibility.ready;
  assert.deepEqual(result.map(item => item.status), ['archived', 'archived', 'archived']);
  assert.deepEqual(new Set(f.calls.map(call => call.sessionId)), new Set(['current', 'previous', 'message-only']));
  assert.deepEqual([...f.logs], before, 'all native header/event records must remain unchanged');
  assert.equal(f.observationDisposals(), 3);
  await visibility.reconcile();
  await f.emit('session/event', { id: 'session-botteam-unmapped' }, { type: 'turn/end' });
  assert.equal(f.calls.length, 3, 'completed or unmapped Sessions must not be retried');
  assert.equal(f.reads.includes('human-session'), false);
  assert.equal(f.reads.includes('session-botteam-unmapped'), false);
  assert.equal(visibility.owned.has('other-user-already-archived'), false, 'archive response never grants ownership');
});

test('busy archive responses defer silently until relevant completion, without stopping activity', async t => {
  const f = fixture(t, { members: [{ sessionId: 'ordinary' }], headers: [{ id: 'ordinary' }] });
  f.active.add('ordinary');
  const visibility = f.start();
  assert.equal((await visibility.ready)[0].status, 'busy');
  assert.equal(f.archivedIds.has('ordinary'), false);
  assert.equal(f.calls.length, 1);
  await f.emit('session/event', { id: 'ordinary' }, { type: 'assistant/message' });
  await f.emit('session/event', { id: 'outside' }, { type: 'turn/end' });
  await f.emit('agent/status', { agent: { id: 'ordinary' }, status: 'running' });
  assert.equal(f.calls.length, 1);
  f.active.delete('ordinary');
  await Promise.all([
    f.emit('session/event', { id: 'ordinary' }, { type: 'turn/end' }),
    f.emit('agent/status', { agent: { id: 'ordinary' }, status: 'idle' }),
  ]);
  assert.equal(f.calls.length, 2, 'coalesce completion signals for the same Session');
  assert.equal(f.archivedIds.has('ordinary'), true);
  assert.deepEqual(f.warnings, []);
});

test('running native Agent is not sent to archive; idle event resumes migration', async t => {
  const f = fixture(t, { members: [{ sessionId: 'ordinary' }], headers: [{ id: 'ordinary' }] });
  const agent = { id: 'ordinary', status: 'running', cancel() { assert.fail('must not cancel'); } };
  f.agents.set(agent.id, agent);
  const visibility = f.start();
  assert.equal((await visibility.ready)[0].status, 'busy');
  await f.emit('session/event', { id: agent.id }, { type: 'turn/end' });
  assert.equal(f.calls.length, 0, 'native turn/end precedes idle');
  agent.status = 'idle';
  await f.emit('agent/status', { agent, status: 'idle' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.archivedIds.has(agent.id), true);
});

test('armed goals between turns stay visible until the goal stops', async t => {
  const f = fixture(t, { members: [{ sessionId: 'ordinary' }], headers: [{ id: 'ordinary' }] });
  const agent = { id: 'ordinary', status: 'idle' };
  f.agents.set(agent.id, agent);
  f.goals.set(agent.id, { phase: 'active', activation: 'armed' });
  const visibility = f.start();
  assert.equal((await visibility.ready)[0].status, 'busy');
  await f.emit('goal/activation-changed', { sessionId: agent.id, goal: { id: 'goal', revision: 1, activation: 'armed' } });
  assert.equal(f.reads.length, 1, 'arming is not a completion signal');
  await f.emit('agent/status', { agent, status: 'idle' });
  await f.emit('session/event', { id: agent.id }, { type: 'turn/end' });
  assert.equal(f.calls.length, 0, 'waiting for children or continuation is active work');
  const stopped = { phase: 'paused', activation: 'disarmed' };
  f.goals.set(agent.id, stopped);
  await f.emit('goal/activation-changed', { sessionId: agent.id, goal: { id: 'goal', revision: 2, activation: 'disarmed' } });
  assert.equal(f.calls.length, 1);
  assert.equal(f.archivedIds.has(agent.id), true);
});

test('engine observation predicate defers archival until explicit reconciliation after persistence', async t => {
  let engineBusy = true;
  const f = fixture(t, { members: [{ sessionId: 'ordinary' }], headers: [{ id: 'ordinary' }], isBusy: () => engineBusy });
  const visibility = f.start();
  assert.equal((await visibility.ready)[0].status, 'busy');
  await f.emit('session/event', { id: 'ordinary' }, { type: 'turn/end' });
  assert.equal(f.calls.length, 0);
  engineBusy = false;
  assert.equal((await visibility.reconcile())[0].status, 'archived');
  assert.equal(f.calls.length, 1);
});

test('subagent background Sessions are always skipped, including running ones and their history', async t => {
  const f = fixture(t, { members: [{ sessionId: 'background', previousSessionIds: ['old-child'] }], headers: [{ id: 'background', origin: 'subagent' }, { id: 'old-child', origin: 'subagent' }] });
  f.active.add('background');
  const visibility = f.start();
  assert.deepEqual((await visibility.ready).map(item => item.status), ['subagent', 'subagent']);
  await f.emit('session/event', { id: 'background' }, { type: 'turn/end' });
  await f.emit('goal/activation-changed', { sessionId: 'background' });
  await visibility.reconcile();
  assert.deepEqual(f.calls, []);
  assert.equal(f.active.has('background'), true);
});

test('missing observation and a disappearance during archive both skip without creating anything', async t => {
  const f = fixture(t, { members: [{ sessionId: 'missing', previousSessionIds: ['disappeared'] }], headers: [{ id: 'disappeared' }] });
  f.controls.archive = id => { f.logs.delete(id); };
  const result = await f.start().ready;
  assert.deepEqual(result.map(item => item.status), ['missing', 'missing']);
  assert.deepEqual(f.calls, [{ sessionId: 'disappeared' }]);
  assert.equal(f.archivedIds.size, 0);
  assert.deepEqual(f.warnings, []);
});

test('unknown observation and archive errors are exposed and logged, never retried by lifecycle noise', async t => {
  const f = fixture(t, { members: [{ sessionId: 'corrupt', previousSessionIds: ['permission', 'healthy'] }], headers: ['corrupt', 'permission', 'healthy'].map(id => ({ id })) });
  f.controls.observe = id => { if (id === 'corrupt') throw failure('SESSION_QUERY_CORRUPT', 'bad record'); };
  f.controls.archive = id => { if (id === 'permission') throw failure('permission/denied', 'cannot archive'); };
  const visibility = f.start();
  const result = await visibility.ready;
  assert.deepEqual(result.map(item => item.status), ['error', 'error', 'archived']);
  assert.equal(result[0].error.code, 'SESSION_QUERY_CORRUPT');
  assert.equal(result[1].error.code, 'permission/denied');
  assert.equal(f.warnings.length, 2);
  await f.emit('session/event', { id: 'corrupt' }, { type: 'turn/end' });
  await f.emit('agent/status', { agent: { id: 'permission' }, status: 'idle' });
  assert.equal(f.reads.length, 3);
  assert.equal(f.calls.length, 2);
  await visibility.reconcile();
  assert.equal(f.warnings.length, 2, 'repeat manual reconciliation does not spam identical diagnostics');
});

test('mismatched observed header is rejected before any archive mutation', async t => {
  const f = fixture(t, { members: [{ sessionId: 'owned' }], headers: [{ id: 'owned' }] });
  f.logs.get('owned').header.id = 'unrelated-user';
  const result = await f.start().ready;
  assert.equal(result[0].status, 'error');
  assert.match(f.warnings[0], /Invalid stored Bot session header/);
  assert.deepEqual(f.calls, []);
  assert.equal(f.observationDisposals(), 1);
});

test('missing archive service is reported for owned ordinary history; empty repository is a no-op', async t => {
  const f = fixture(t, { members: [{ sessionId: 'ordinary' }], headers: [{ id: 'ordinary' }] });
  const original = f.ctx.get;
  f.ctx.get = name => name === 'workspaceController' ? undefined : original(name);
  assert.equal((await f.start().ready)[0].status, 'error');
  assert.match(f.warnings[0], /workspaceController.archiveSession/);
  const empty = fixture(t);
  empty.ctx.get = () => assert.fail('empty ownership must not access host services');
  assert.deepEqual(await empty.start().ready, []);
});

test('already archived history relies only on the public idempotent API and leaves logs untouched', async t => {
  const f = fixture(t, { members: [{ sessionId: 'ordinary' }], headers: [{ id: 'ordinary' }], archived: ['ordinary'] });
  const before = structuredClone([...f.logs]);
  const visibility = f.start();
  assert.equal((await visibility.ready)[0].status, 'archived');
  await visibility.reconcile();
  assert.equal(f.calls.length, 1);
  assert.deepEqual([...f.logs], before);
});

test('completion racing an in-flight busy response is retained and retried exactly once', async t => {
  const f = fixture(t, { members: [{ sessionId: 'ordinary' }], headers: [{ id: 'ordinary' }] });
  const entered = deferred();
  const release = deferred();
  let first = true;
  f.controls.archive = async () => {
    if (!first) return;
    first = false;
    entered.resolve();
    await release.promise;
    throw failure('workspace/session-active');
  };
  const visibility = f.start();
  await entered.promise;
  const completion = f.emit('agent/status', { agent: { id: 'ordinary' }, status: 'idle' });
  release.resolve();
  await Promise.all([visibility.ready, completion]);
  assert.equal(f.calls.length, 2);
  assert.equal(f.archivedIds.has('ordinary'), true);
});

test('trusted ownership survives group removal; newly seen repository IDs require explicit reconcile', async t => {
  const f = fixture(t, { members: [{ sessionId: 'removed-group' }], headers: [{ id: 'removed-group' }, { id: 'new-owned' }] });
  f.active.add('removed-group');
  const visibility = f.start();
  await visibility.ready;
  f.repo.members.clear();
  f.active.delete('removed-group');
  await f.emit('agent/status', { agent: { id: 'removed-group' }, status: 'idle' });
  assert.equal(f.archivedIds.has('removed-group'), true);
  f.repo.messages.set('new', botMessage('new-owned'));
  await f.emit('session/event', { id: 'new-owned' }, { type: 'turn/end' });
  assert.equal(f.archivedIds.has('new-owned'), false);
  await visibility.reconcile();
  assert.equal(f.archivedIds.has('new-owned'), true);
});

test('disposal removes global listeners and prevents mutation after pending header observation', async t => {
  const f = fixture(t, { members: [{ sessionId: 'ordinary' }], headers: [{ id: 'ordinary' }] });
  const entered = deferred();
  const release = deferred();
  f.controls.observe = async () => { entered.resolve(); await release.promise; };
  const visibility = f.start();
  await entered.promise;
  const disposed = visibility.dispose();
  assert.ok([...f.hooks.values()].every(hooks => hooks.size === 0));
  release.resolve();
  await Promise.all([disposed, visibility.ready]);
  await f.emit('session/event', { id: 'ordinary' }, { type: 'turn/end' });
  assert.deepEqual(await visibility.reconcile(), []);
  assert.deepEqual(f.calls, []);
  assert.equal(f.observationDisposals(), 1);
});
