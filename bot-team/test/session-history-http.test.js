import test from 'node:test';
import assert from 'node:assert/strict';
import { BotTeamService } from '../host/service.js';
import { registerRoutes, ROUTES } from '../host/routes.js';

function fixture() {
  const state = {
    groups: [{ groupId: 'group-a' }, { groupId: 'group-b' }],
    members: [{ membershipId: 'member-a', groupId: 'group-a', botId: 'bot-a', sessionId: 'new-session' }],
    messages: [{
      messageId: 'reply-a', groupId: 'group-a', author: { type: 'bot', membershipId: 'member-a', botId: 'bot-a' },
      meta: { execution: { version: 1, jobId: 'job-a', sessionId: 'saved-session', inputMessageId: 'input-1', turn: 1, startSeq: 0, endSeq: 3 } },
    }],
    reads: 0, disposed: 0,
  };
  const events = [1, 2].flatMap((turn) => [
    { type: 'turn/start', data: { turn } },
    { type: 'user/message', data: { id: 'input-' + turn, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Question ' + turn }] } },
    { type: 'assistant/message', data: { turn, message: { role: 'assistant', content: [{ type: 'text', text: 'Answer ' + turn }] } } },
    { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
  ]).map((event, seq) => ({ ...event, seq, time: 1000 + seq }));
  const service = Object.create(BotTeamService.prototype);
  service.ready = Promise.resolve();
  service.repo = {
    getGroup: (id) => state.groups.find((group) => group.groupId === id),
    membersOf: (id) => state.members.filter((member) => member.groupId === id),
    messagesOf: (id) => state.messages.filter((message) => message.groupId === id),
  };
  service.ctx = { sessionQuery: { async observeSession(id, options) {
    state.reads += 1;
    state.signal = options.signal;
    if (state.onObserve) state.onObserve();
    if (state.failure) throw state.failure;
    return {
      header: { id, origin: 'subagent', delegationDepth: 0 }, source: 'prepared', cursor: events.length - 1, events,
      [Symbol.dispose]() { state.disposed += 1; },
    };
  } } };
  return { service, state };
}
const request = (params = {}, init) => new Request('http://localhost/api/bot-team.session-history?' + new URLSearchParams({ groupId: 'group-a', sessionId: 'saved-session', ...params }), init);

test('history HTTP pages the full parentless Session and returns no-store responses', async () => {
  const f = fixture();
  const first = await f.service.handleSessionHistory(request({ limit: 3 }));
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  const page = await first.json();
  assert.equal(page.ok, true);
  assert.equal(page.groupId, 'group-a');
  assert.equal(page.sessionId, 'saved-session');
  assert.equal(page.availability, 'available');
  assert.equal(page.events.length, 3);
  assert.equal(page.hasMore, true);
  const rest = await (await f.service.handleSessionHistory(request({ afterSeq: page.nextSeq }))).json();
  assert.equal(rest.hasMore, false);
  assert.deepEqual([...page.events, ...rest.events].filter((event) => event.type === 'turn/start').map((event) => event.data.turn), [1, 2]);
  assert.equal(f.state.reads, 2);
  assert.equal(f.state.disposed, 2);
});

test('history HTTP rejects arbitrary Session ids, cross-group requests, and invalid cursors before reads', async () => {
  const f = fixture();
  for (const [params, status, code] of [
    [{ groupId: 'group-b' }, 400, 'invalid-input'],
    [{ groupId: 'unknown' }, 404, 'not-found'],
    [{ sessionId: 'unrelated-session' }, 400, 'invalid-input'],
    [{ afterSeq: 'not-a-number' }, 400, 'invalid-input'],
    [{ limit: '0' }, 400, 'invalid-input'],
  ]) {
    const result = await f.service.handleSessionHistory(request(params));
    assert.equal(result.status, status);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal((await result.json()).error.code, code);
  }
  assert.equal(f.state.reads, 0);
});

test('history HTTP preserves historical Session access after member removal or rotation', async () => {
  const f = fixture();
  f.state.members[0].sessionId = 'rotated-session';
  assert.equal((await (await f.service.handleSessionHistory(request())).json()).availability, 'available');
  f.state.members = [];
  assert.equal((await (await f.service.handleSessionHistory(request())).json()).availability, 'available');
  assert.equal((await f.service.handleSessionHistory(request({ sessionId: 'rotated-session' }))).status, 400);
  assert.equal(f.state.disposed, 2);
});

test('history HTTP reports missing logs without leaking underlying failure details', async () => {
  const f = fixture();
  f.state.failure = Object.assign(new Error('PRIVATE_LOG_PATH'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' });
  const result = await f.service.handleSessionHistory(request());
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  const body = await result.json();
  assert.equal(body.availability, 'unavailable');
  assert.equal(body.reason, 'session-log-missing');
  assert.deepEqual(body.events, []);
  assert.equal(JSON.stringify(body).includes('PRIVATE_'), false);
});

test('history HTTP forwards cancellation and disposes a lease acquired during cancellation', async () => {
  const f = fixture();
  const controller = new AbortController();
  const stopped = new Error('Cancelled');
  f.state.onObserve = () => controller.abort(stopped);
  const req = request({}, { signal: controller.signal });
  await assert.rejects(f.service.handleSessionHistory(req), (error) => error === stopped);
  assert.equal(f.state.signal, req.signal);
  assert.equal(f.state.disposed, 1);
});

test('history route uses the authenticated API fence, supports only GET, and unregisters', async () => {
  const routes = [];
  const disposed = [];
  const service = { handleSessionHistory: async (value) => new Response(value.url) };
  const release = registerRoutes({ connection: { fetch: { register(route) { routes.push(route); return () => disposed.push(route.path); } } } }, service);
  const route = routes.find((entry) => entry.path === ROUTES.sessionHistory);
  assert.equal(route.path, '/api/bot-team.session-history');
  assert.deepEqual(route.methods, ['GET']);
  const req = request();
  assert.equal(await (await route.fetch(req)).text(), req.url);
  await release();
  assert.ok(disposed.includes(ROUTES.sessionHistory));
});
