import assert from 'node:assert/strict';
import test from 'node:test';
import { BotTeamService } from '../host/service.js';
import { registerRoutes, ROUTES } from '../host/routes.js';
import { GroupBus } from '../host/util.js';

function fixture() {
  const group = { groupId: 'group-a' };
  const member = { membershipId: 'member-a', groupId: group.groupId, botId: 'bot-a', sessionId: 'new-session' };
  const message = {
    messageId: 'reply-a', groupId: group.groupId, status: 'done', text: 'Done',
    author: { type: 'bot', membershipId: member.membershipId, botId: member.botId },
    meta: { execution: { version: 1, jobId: 'job-a', sessionId: 'saved-session', inputMessageId: 'input-a', turn: 1, startSeq: 0, endSeq: 5, submittedSeq: 0 } },
  };
  const data = [
    ['turn/start', { turn: 1 }],
    ['step/start', { turn: 1, step: 1 }],
    ['user/message', { id: 'input-a', role: 'user', content: [{ type: 'text', text: 'Read the file' }] }],
    ['tool/call', { turn: 1, step: 1, callId: 'call-a', name: 'read', arguments: '{"file_path":"example.txt"}' }],
    ['tool/result', { turn: 1, step: 1, message: { id: 'result-a', role: 'tool', toolCallId: 'call-a', isError: false, content: [{ type: 'text', text: 'Recorded output' }] } }],
    ['turn/end', { turn: 1, reason: 'done' }],
  ];
  let reads = 0;
  let disposed = 0;
  const service = Object.create(BotTeamService.prototype);
  service.ready = Promise.resolve();
  service.repo = {
    getGroup: (id) => id === group.groupId ? group : undefined,
    getMessage: (id) => id === message.messageId ? message : undefined,
    getMember: (id) => id === member.membershipId ? member : undefined,
  };
  service.ctx = {
    sessionQuery: {
      async observeSession(id) {
        reads += 1;
        assert.equal(id, 'saved-session', 'use the reply reference after the member rotates its session');
        return {
          header: { id }, cursor: 5, revision: 6,
          events: data.map(([type, body], seq) => ({ seq, type, time: 1000 + seq, data: body })),
          [Symbol.dispose]() { disposed += 1; },
        };
      },
    },
  };
  return { service, message, get reads() { return reads; }, get disposed() { return disposed; } };
}

const request = (params = '') => new Request('http://localhost/api/bot-team.message-execution?groupId=group-a&messageId=reply-a' + params);

test('execution HTTP reads the saved session, paginates, and marks the response private to the request', async () => {
  const f = fixture();
  const first = await f.service.handleMessageExecution(request('&limit=3'));
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  const page = await first.json();
  assert.equal(page.ok, true);
  assert.equal(page.availability, 'available');
  assert.equal(page.execution.sessionId, 'saved-session');
  assert.equal(page.hasMore, true);
  const next = await f.service.handleMessageExecution(request('&afterSeq=' + page.nextSeq));
  const rest = await next.json();
  assert.equal(rest.hasMore, false);
  assert.ok(rest.events.some((event) => event.type === 'tool/result'));
  assert.equal(f.reads, 2);
  assert.equal(f.disposed, 2);
});

test('execution HTTP rejects wrong groups and malformed pagination before reading logs', async () => {
  const f = fixture();
  const wrong = await f.service.handleMessageExecution(new Request('http://localhost/api/bot-team.message-execution?groupId=group-b&messageId=reply-a'));
  assert.equal(wrong.status, 404);
  assert.equal((await wrong.json()).error.code, 'not-found');
  const invalid = await f.service.handleMessageExecution(request('&afterSeq=invalid'));
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'invalid-input');
  assert.equal(f.reads, 0);
});

test('execution HTTP distinguishes legacy messages and refuses human messages', async () => {
  const f = fixture();
  f.message.meta = {};
  const legacy = await (await f.service.handleMessageExecution(request())).json();
  assert.equal(legacy.availability, 'legacy-unlinked');
  assert.equal(legacy.fallbackSessionId, 'new-session');
  f.message.author.type = 'human';
  const human = await f.service.handleMessageExecution(request());
  assert.equal(human.status, 400);
  assert.equal(f.reads, 0);
});

test('execution route uses the existing authenticated API fence and supports only GET', async () => {
  const routes = [];
  const disposed = [];
  const service = { handleMessageExecution: async (value) => new Response(value.url) };
  const release = registerRoutes({ connection: { fetch: { register(route) { routes.push(route); return () => disposed.push(route.path); } } } }, service);
  const route = routes.find((item) => item.path === ROUTES.execution);
  assert.equal(route.path, '/api/bot-team.message-execution');
  assert.deepEqual(route.methods, ['GET']);
  const req = request();
  assert.equal(await (await route.fetch(req)).text(), req.url);
  await release();
  assert.equal(disposed.length, routes.length);
});

test('execution invalidations retain their session seq without changing the group reconnect cursor', () => {
  const bus = new GroupBus();
  const frames = [];
  bus.subscribe('group-a', (frame) => frames.push(frame));
  bus.emit('group-a', { type: 'message.added', seq: 7 });
  bus.emit('group-a', { type: 'execution.updated', messageId: 'reply-a', seq: 120 });
  assert.equal(bus.seqOf('group-a'), 7);
  assert.equal(frames.at(-1).seq, 120);
});
