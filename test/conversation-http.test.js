import test from 'node:test';
import assert from 'node:assert/strict';
import { BotTeamService } from '../host/service.js';
import { openRepository } from '../host/domain.js';
import { registerRoutes, ROUTES } from '../host/routes.js';
import { GroupBus, resolveConfig } from '../host/util.js';

async function fixture() {
  const tables = new Map();
  const domain = {
    table(name) {
      if (!tables.has(name)) tables.set(name, new Map());
      const records = tables.get(name);
      return {
        entries: () => [...records].map(([key, value]) => [key, structuredClone(value)]),
        async put(key, value) { records.set(key, structuredClone(value)); },
        async delete(key) { records.delete(key); },
      };
    },
    async close() {},
  };
  const repo = await openRepository({ storageDomain: { open: async () => domain } }, null);
  await repo.runMigrations();
  for (const groupId of ['group-a', 'group-b']) await repo.putGroup({ groupId, kind: 'group', title: groupId, nextSeq: 0, createdAt: 1 });
  await repo.putBot({ botId: 'bot-a', name: 'Alpha', provider: 'mock', model: 'mock', capability: 'work' });
  await repo.putMember({ membershipId: 'member-a', groupId: 'group-a', botId: 'bot-a', sessionId: 'native-a', enabled: true, lastSeenSeq: 0, order: 0 });
  const activity = { capability: () => ({ supported: true, missing: [] }), collect: async () => [] };
  const calls = { sent: [], prepared: 0, disposed: [], routes: [] };
  const ctx = {
    get: (name) => name === 'botTeamNativeActivity' ? activity : undefined,
    connection: { fetch: { register: (route) => { calls.routes.push(route); return () => {}; } } },
    agents: { create() { assert.fail('HTTP queries and conversation.new must never create an Agent'); } },
  };
  const service = Object.assign(Object.create(BotTeamService.prototype), {
    ready: Promise.resolve(), repo, ctx, config: resolveConfig({ migrateLegacyLayout: false }), bus: new GroupBus(),
    pool: { isPreparingGroup: () => false, async disposeMember(id) { calls.disposed.push(id); }, async ensure() { calls.prepared += 1; assert.fail('Conversation queries must not prepare an Agent'); } },
    engine: {
      running: new Map(), isRunning: () => false, hasPendingWork: () => false,
      queueSnapshot: () => [],
      postHumanMessage(input) { calls.sent.push(input); return { message: input, accepted: [] }; },
    },
    interactions: { reconcile() {} },
  });
  const dispose = registerRoutes(ctx, service);
  const route = (name) => calls.routes.find((entry) => entry.path === ROUTES[name]);
  const action = (name, payload) => route('action').fetch(new Request('http://localhost' + ROUTES.action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: name, payload }) }));
  const query = (name, params = {}) => route(name).fetch(new Request('http://localhost' + ROUTES[name] + '?' + new URLSearchParams({ groupId: 'group-a', ...params })));
  const current = (groupId = 'group-a') => repo.activeConversation(groupId).conversationId;
  const start = async (requestId, groupId = 'group-a') => {
    const response = await action('conversation.new', { groupId, expectedConversationId: current(groupId), requestId });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };
  const message = async (text, groupId = 'group-a') => {
    const seq = repo.allocateSeq(groupId);
    const value = { messageId: groupId + '-message-' + seq, groupId, seq, conversationId: current(groupId), author: { type: 'human', name: 'User' }, text, status: 'done', createdAt: Date.now() };
    await repo.putMessageStrict(value);
    await repo.flushGroupWrites(groupId);
    return value;
  };
  return { service, repo, calls, activity, route, action, query, current, start, message, dispose };
}

test('conversation query route registers authenticated API GET and returns the baseline', async () => {
  const f = await fixture();
  assert.deepEqual(f.route('conversations').methods, ['GET']);
  assert.equal(f.route('conversations').path, '/api/bot-team.conversations');
  const response = await f.query('conversations');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.currentConversationId, f.current());
  assert.equal(body.conversationVersion, 1);
  assert.equal(body.conversations.length, 1);
  assert.equal(body.conversations[0].afterSeq, 0);
  assert.equal(f.calls.prepared, 0);
  await f.dispose();
});

test('external mutations without an expected conversation require reload; stale mutations never reach execution', async () => {
  const f = await fixture();
  const original = f.current();
  for (const [action, extra] of [
    ['message.post', { text: 'Draft', mentions: ['member-a'] }],
    ['task.create', { title: 'Draft task', assigneeMembershipId: 'member-a' }],
    ['conversation.new', { requestId: 'missing-expectation' }],
  ]) {
    const response = await f.action(action, { groupId: 'group-a', ...extra });
    assert.equal(response.status, 409, action);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'reload-required');
    assert.equal(body.details.currentConversationId, original);
    assert.equal(body.details.conversationVersion, 1);
  }
  const switched = await f.start('new-request');
  const stale = await f.action('message.post', { groupId: 'group-a', text: 'Old draft', mentions: ['member-a'], expectedConversationId: original });
  assert.equal(stale.status, 409);
  const body = await stale.json();
  assert.equal(body.error.code, 'stale-conversation');
  assert.equal(body.details.currentConversationId, switched.currentConversationId);
  assert.equal(body.details.conversationVersion, 2);
  assert.equal(f.calls.sent.length, 0);
  assert.equal(f.repo.messagesOf('group-a').length, 0);
  assert.equal(f.repo.tasksOf('group-a').length, 0);
  assert.equal(f.repo.getGroup('group-a').nextSeq, 0);
  assert.equal(f.calls.prepared, 0);
});

test('raw /new commands are rejected before messages can reach a model', async () => {
  const f = await fixture();
  for (const [text, code] of [['/new', 'command-required'], ['  /new  ', 'command-required'], ['/new argument', 'invalid-command'], ['/new\nmore', 'invalid-command']]) {
    const response = await f.action('message.post', { groupId: 'group-a', text, mentions: ['member-a'], expectedConversationId: f.current() });
    assert.equal(response.status, 400, text);
    assert.equal((await response.json()).error.code, code);
  }
  assert.equal(f.calls.sent.length, 0);
  assert.equal(f.calls.prepared, 0);
  assert.equal(f.repo.getGroup('group-a').nextSeq, 0);
  assert.equal(f.repo.conversationsOf('group-a').length, 1);
  const ordinary = await f.action('message.post', { groupId: 'group-a', text: 'Explain /new please', expectedConversationId: f.current() });
  assert.equal(ordinary.status, 200);
  assert.equal(f.calls.sent[0].text, 'Explain /new please');
});

test('conversation HTTP requests replay idempotently and report request parent conflicts', async () => {
  const f = await fixture();
  const payload = { groupId: 'group-a', expectedConversationId: f.current(), requestId: 'stable-request' };
  const first = await (await f.action('conversation.new', payload)).json();
  assert.equal(first.result.created, true);
  const later = await f.start('later-request');
  const replay = await (await f.action('conversation.new', payload)).json();
  assert.equal(replay.result.created, false);
  assert.deepEqual(replay.result.conversation, first.result.conversation);
  assert.equal(replay.result.currentConversationId, later.currentConversationId);
  const conflict = await f.action('conversation.new', { ...payload, expectedConversationId: later.currentConversationId });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'conflict');
  assert.equal(f.repo.conversationsOf('group-a').length, 3);
  assert.equal(f.repo.conversationsOf('group-b').length, 1);
  assert.equal(f.calls.sent.length, 0);
});

test('missing native capability and unknown native observations fail closed at HTTP', async () => {
  const f = await fixture();
  const payload = { groupId: 'group-a', expectedConversationId: f.current(), requestId: 'capability-request' };
  f.activity.capability = () => ({ supported: false, missing: ['jobs.list'], reason: 'Native job queries unavailable' });
  let response = await f.action('conversation.new', payload);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'conversation-capability-unavailable');
  f.activity.capability = () => ({ supported: true, missing: [] });
  f.activity.collect = async () => { throw new Error('Native observation failed'); };
  response = await f.action('conversation.new', payload);
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error.code, 'conversation-busy');
  assert.ok(body.details.blockers.some((item) => item.kind === 'native-unknown'));
  assert.equal(f.current(), payload.expectedConversationId);
  assert.equal(f.calls.disposed.length, 0);
  assert.equal(f.calls.prepared, 0);
});

test('conversation lists paginate empty segments and keep session bindings read-only and scoped', async () => {
  const f = await fixture();
  const baseline = f.current();
  await f.start('empty-one');
  const second = await f.start('empty-two');
  const third = await f.start('empty-three');
  const all = await (await f.query('conversations')).json();
  assert.deepEqual(all.conversations.map((entry) => entry.ordinal), [1, 2, 3, 4]);
  assert.deepEqual(all.conversations.map((entry) => entry.afterSeq), [0, 0, 0, 0]);
  const recent = await (await f.query('conversations', { limit: 2 })).json();
  assert.deepEqual(recent.conversations.map((entry) => entry.ordinal), [3, 4]);
  assert.equal(recent.hasMore, true);
  const earlier = await (await f.query('conversations', { limit: 2, beforeOrdinal: recent.nextBeforeOrdinal })).json();
  assert.deepEqual(earlier.conversations.map((entry) => entry.ordinal), [1, 2]);
  assert.equal(earlier.hasMore, false);
  const historical = await (await f.query('conversations', { conversationId: baseline, limit: 1 })).json();
  assert.equal(historical.sessionBindings[0].sessionId, 'native-a');
  assert.equal(historical.sessionBindings[0].conversationId, baseline);
  const empty = await (await f.query('conversations', { conversationId: second.currentConversationId })).json();
  assert.deepEqual(empty.sessionBindings, []);
  assert.equal(empty.currentConversationId, third.currentConversationId);
  assert.equal((await f.query('conversations', { groupId: 'group-b', conversationId: baseline })).status, 404);
  assert.equal((await f.query('conversations', { groupId: 'missing' })).status, 404);
  for (const cursor of ['-1', '1.5', 'bad']) assert.equal((await f.query('conversations', { conversationId: baseline, cursor })).status, 400);
  for (const beforeOrdinal of ['0', '-1', '1.5', 'bad']) assert.equal((await f.query('conversations', { beforeOrdinal })).status, 400);
  assert.equal(f.calls.prepared, 0);
  assert.equal(f.calls.sent.length, 0);
});

test('message boundaries include empty conversations and never consume or rewind message sequences', async () => {
  const f = await fixture();
  const firstMessage = await f.message('Original');
  const removed = await f.message('Deleted newest message');
  await f.repo.deleteMessageStrict(removed.messageId);
  const one = await f.start('empty-one');
  const two = await f.start('empty-two');
  assert.equal(one.conversation.afterSeq, removed.seq);
  assert.equal(two.conversation.afterSeq, removed.seq);
  const beforeNext = await (await f.query('messages')).json();
  assert.deepEqual(beforeNext.messages.map((message) => message.seq), [firstMessage.seq]);
  assert.deepEqual(beforeNext.conversationBoundaries.map((entry) => entry.ordinal), [1, 2, 3]);
  const emptyTail = await (await f.query('messages', { afterSeq: removed.seq })).json();
  assert.deepEqual(emptyTail.messages, []);
  assert.deepEqual(emptyTail.conversationBoundaries.map((entry) => entry.ordinal), [2, 3]);
  const next = await f.message('Current conversation');
  assert.equal(next.seq, removed.seq + 1);
  assert.equal(next.conversationId, two.currentConversationId);
  const currentPage = await (await f.query('messages', { limit: 1 })).json();
  assert.deepEqual(currentPage.messages.map((message) => message.messageId), [next.messageId]);
  assert.deepEqual(currentPage.conversationBoundaries.map((entry) => entry.ordinal), [2, 3], 'Empty segments sharing the leading boundary must not disappear');
  const oldPage = await (await f.query('messages', { beforeSeq: next.seq, limit: 1 })).json();
  assert.deepEqual(oldPage.messages.map((message) => message.messageId), [firstMessage.messageId]);
  assert.equal(oldPage.currentConversationId, two.currentConversationId);
  assert.equal(f.calls.prepared, 0);
});

test('an entirely empty timeline still returns every conversation separator', async () => {
  const f = await fixture();
  await f.start('empty-one');
  await f.start('empty-two');
  const body = await (await f.query('messages')).json();
  assert.deepEqual(body.messages, []);
  assert.deepEqual(body.conversationBoundaries.map((entry) => entry.ordinal), [1, 2, 3]);
  assert.equal(body.hasMore, false);
  assert.equal(f.repo.getGroup('group-a').nextSeq, 0);
});

test('SSE reconnect hello carries the authoritative current conversation', async () => {
  const f = await fixture();
  const current = await f.start('before-reconnect');
  const response = await f.query('events');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  try {
    const first = new TextDecoder().decode((await reader.read()).value);
    const data = JSON.parse(first.split('\n').find((line) => line.startsWith('data: ')).slice(6));
    assert.equal(data.type, 'hello');
    assert.equal(data.currentConversationId, current.currentConversationId);
    assert.equal(data.conversationVersion, current.conversationVersion);
  } finally { await reader.cancel(); }
});
