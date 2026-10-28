import test from 'node:test';
import assert from 'node:assert/strict';
import { BotTeamService } from '../host/service.js';
import { registerRoutes, ROUTES } from '../host/routes.js';

function fixture(options = {}) {
  const state = {
    groups: [{ groupId: 'group-a' }, { groupId: 'group-b' }],
    members: [],
    messages: [{
      messageId: 'reply-a', groupId: 'group-a', author: { type: 'bot', membershipId: 'member-a', botId: 'bot-a' },
      meta: { execution: { version: 1, jobId: 'job-a', sessionId: 'saved-session', inputMessageId: 'input-1', turn: 1, startSeq: 1, endSeq: 5 } },
    }],
    header: { version: 4, id: 'saved-session', createdAt: 1700000000000, cwd: '/work/project', isSeeded: false, origin: 'user', delegationDepth: 0, agentPreset: 'default' },
    events: [
      { type: 'system/message', data: { content: [{ type: 'text', text: 'System instructions' }] } },
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { id: 'input-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Original request' }] }, surfaceOp: 'append' },
      { type: 'assistant/attempt', data: { turn: 1, step: 1, stream: [{ type: 'chunk', chunk: { type: 'reasoning-delta', text: 'Thinking' } }] } },
      { type: 'assistant/message', data: { turn: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'Thinking' }, { type: 'image', attachment: { attachmentId: 'image-1', mediaType: 'image/png' } }, { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' }] } }, surfaceOp: 'append', sourceEventSeqs: [2, 3] },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ].map((event, seq) => ({ seq, time: 1700000000000 + seq, ...event })),
    opens: 0, reads: 0, closed: 0, flushes: 0, gets: [], ...options,
  };
  const persistence = { async open(id, mode, settings) {
    state.opens += 1;
    state.openArgs = { id, mode, settings };
    await state.onOpen?.();
    if (state.failure) throw state.failure;
    return {
      header: state.header,
      async read(offset, limit, settings) {
        state.reads += 1;
        state.readArgs = { offset, limit, settings };
        await state.onRead?.();
        if (state.readFailure) throw state.readFailure;
        return { events: state.events };
      },
      async close() { state.closed += 1; await state.onClose?.(); },
    };
  } };
  const sessions = {
    get(id) { assert.equal(id, state.header.id); return state.live; },
    async flush(session) { assert.equal(session, state.live); state.flushes += 1; await state.onFlush?.(); },
    create() { assert.fail('Export must not create a Session'); },
    open() { assert.fail('Export must not activate a Session'); },
    prepare() { assert.fail('Export must not prepare a Session'); },
  };
  const service = Object.create(BotTeamService.prototype);
  service.ready = Promise.resolve();
  service.repo = {
    getGroup: (id) => state.groups.find((group) => group.groupId === id),
    membersOf: (id) => state.members.filter((member) => member.groupId === id),
    messagesOf: (id) => state.messages.filter((message) => message.groupId === id),
  };
  service.ctx = { get(name) {
    state.gets.push(name);
    if (name === 'sessionPersistence') return state.noPersistence ? undefined : persistence;
    if (name === 'sessions') return sessions;
    assert.fail('Export must not restore agents or query prepared repairs: ' + name);
  }, get agents() { assert.fail('Export must not restore an Agent'); }, get sessionQuery() { assert.fail('Export must not query prepared repairs'); } };
  return { service, state };
}
const request = (params = {}, init) => new Request('http://localhost/api/bot-team.session-export?' + new URLSearchParams({ groupId: 'group-a', sessionId: 'saved-session', ...params }), init);

test('export HTTP downloads the complete native JSONL header and raw event envelopes', async () => {
  const f = fixture();
  const req = request({ limit: 1, afterSeq: 4, path: '/outside' });
  const response = await f.service.handleSessionExport(req);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="session-saved-session.jsonl"');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const body = await response.text();
  const expected = [{ type: 'session', ...f.state.header }, ...f.state.events];
  assert.equal(body, expected.map((row) => JSON.stringify(row)).join('\n') + '\n');
  assert.deepEqual(body.trimEnd().split('\n').map((line) => JSON.parse(line)), expected);
  assert.equal(f.state.openArgs.id, 'saved-session');
  assert.equal(f.state.openArgs.mode, 'read');
  assert.equal(f.state.openArgs.settings.signal, req.signal);
  assert.deepEqual(f.state.readArgs, { offset: 0, limit: undefined, settings: { signal: req.signal } });
  assert.equal(f.state.closed, 1);
});

test('export HTTP retains legacy subagent header fields and exports history after member removal', async () => {
  const f = fixture();
  Object.assign(f.state.header, { origin: 'subagent', parentSession: 'parent-session', delegationDepth: 1 });
  const response = await f.service.handleSessionExport(request());
  assert.equal(response.status, 200);
  const [header, ...events] = (await response.text()).trimEnd().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(header, { type: 'session', ...f.state.header });
  assert.deepEqual(events, f.state.events);
  assert.equal(f.state.closed, 1);
});

test('export HTTP rejects foreign or invalid group/session references before persistence access', async () => {
  const f = fixture();
  for (const [params, status, code] of [
    [{ groupId: 'group-b' }, 400, 'invalid-input'],
    [{ groupId: 'missing' }, 404, 'not-found'],
    [{ sessionId: 'unrelated-session' }, 400, 'invalid-input'],
    [{ groupId: '' }, 400, 'invalid-input'],
    [{ sessionId: '' }, 400, 'invalid-input'],
    [{ sessionId: '../outside' }, 400, 'invalid-input'],
    [{ sessionId: 'bad"\r\ncontent-type:text/html' }, 400, 'invalid-input'],
  ]) {
    const response = await f.service.handleSessionExport(request(params));
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).error.code, code);
  }
  assert.deepEqual(f.state.gets, []);
  assert.equal(f.state.opens, 0);
});

test('export HTTP sanitizes compatible session IDs in filenames while retaining the native header ID', async () => {
  const f = fixture();
  const sessionId = 'saved:session.v4';
  f.state.header.id = sessionId;
  f.state.messages[0].meta.execution.sessionId = sessionId;
  const response = await f.service.handleSessionExport(request({ sessionId }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="session-saved_session.v4.jsonl"');
  assert.equal(JSON.parse((await response.text()).split('\n')[0]).id, sessionId);
});

test('export HTTP returns a safe unavailable JSON response for persistence failures', async () => {
  for (const [options, reason] of [
    [{ noPersistence: true }, 'session-persistence-unavailable'],
    [{ failure: Object.assign(new Error('PRIVATE_STORAGE_PATH'), { name: 'SessionPersistenceNotFoundError' }) }, 'session-log-missing'],
    [{ readFailure: Object.assign(new Error('PRIVATE_STORAGE_PATH'), { name: 'SessionPersistenceCorruptionError' }) }, 'session-log-corrupt'],
    [{ readFailure: new Error('PRIVATE_STORAGE_PATH') }, 'session-log-read-failed'],
  ]) {
    const f = fixture(options);
    const response = await f.service.handleSessionExport(request());
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('content-disposition'), null);
    const body = await response.json();
    assert.equal(body.availability, 'unavailable');
    assert.equal(body.reason, reason);
    assert.equal(body.header, null);
    assert.deepEqual(body.events, []);
    assert.equal(JSON.stringify(body).includes('PRIVATE_'), false);
    assert.equal(f.state.closed, options.readFailure ? 1 : 0);
  }
});

test('export HTTP flushes only an existing session and never restores an Agent', async () => {
  const f = fixture({ live: { id: 'saved-session' } });
  f.state.onFlush = () => f.state.events.push({ seq: f.state.events.length, time: 1700000000006, type: 'extension/log', data: { persisted: true }, ignorable: true });
  const response = await f.service.handleSessionExport(request());
  assert.equal(response.status, 200);
  assert.equal(f.state.flushes, 1);
  assert.deepEqual(f.state.gets, ['sessionPersistence', 'sessions']);
  assert.deepEqual(JSON.parse((await response.text()).trimEnd().split('\n').at(-1)), f.state.events.at(-1));
});

test('export HTTP propagates request abort before and after persistence acquisition', async () => {
  const stopped = new Error('Request cancelled');
  const before = new AbortController(); before.abort(stopped);
  const cold = fixture();
  await assert.rejects(cold.service.handleSessionExport(request({}, { signal: before.signal })), (error) => error === stopped);
  assert.deepEqual(cold.state.gets, []);
  for (const stage of ['onFlush', 'onOpen', 'onRead', 'onClose']) {
    const controller = new AbortController();
    const f = fixture({ live: {}, [stage]() { controller.abort(stopped); } });
    const req = request({}, { signal: controller.signal });
    await assert.rejects(f.service.handleSessionExport(req), (error) => error === stopped);
    assert.equal(f.state.closed, stage === 'onFlush' ? 0 : 1);
  }
});

test('export HTTP rechecks group ownership after an asynchronous read before sending any log bytes', async () => {
  for (const groupDeleted of [false, true]) {
    const f = fixture();
    f.state.onRead = () => { if (groupDeleted) f.state.groups = []; else f.state.messages = []; };
    const response = await f.service.handleSessionExport(request());
    assert.equal(response.status, groupDeleted ? 404 : 400);
    assert.equal(response.headers.get('content-disposition'), null);
    const body = await response.json();
    assert.equal(body.error.code, groupDeleted ? 'not-found' : 'invalid-input');
    assert.equal(body.events, undefined);
    assert.equal(f.state.closed, 1);
  }
});

test('export route registers only authenticated API GET and unregisters cleanly', async () => {
  const routes = [];
  const disposed = [];
  const service = { handleSessionExport: async (value) => new Response(value.url) };
  const release = registerRoutes({ connection: { fetch: { register(route) { routes.push(route); return () => disposed.push(route.path); } } } }, service);
  const route = routes.find((entry) => entry.path === ROUTES.sessionExport);
  assert.equal(route.path, '/api/bot-team.session-export');
  assert.deepEqual(route.methods, ['GET']);
  const req = request();
  assert.equal(await (await route.fetch(req)).text(), req.url);
  await release();
  assert.ok(disposed.includes(ROUTES.sessionExport));
});
