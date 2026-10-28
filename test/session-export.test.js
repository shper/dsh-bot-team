import test from 'node:test';
import assert from 'node:assert/strict';
import { readBotSessionLog } from '../host/execution.js';
import { serializeBotSessionLog } from '../host/session-export.js';

const header = (extra = {}) => ({
  version: 4, id: 'saved-session', createdAt: 1700000000000, cwd: '/work/project',
  parentSession: 'parent-session', isSeeded: false, origin: 'subagent',
  delegationDepth: 1, agentPreset: 'bot-team-tools', ...extra,
});
const reference = (extra = {}) => ({ version: 1, jobId: 'job-1', sessionId: 'saved-session', inputMessageId: 'input-1', turn: 1, startSeq: 1, endSeq: null, ...extra });
function rawLog() {
  const rows = [
    ['system/message', { message: { role: 'system', content: [{ type: 'text', text: 'System prompt' }] } }],
    ['turn/start', { turn: 1 }],
    ['user/message', { id: 'input-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Request\n下一行 😀' }] }, { surfaceOp: 'append' }],
    ['assistant/attempt', { turn: 1, step: 1, stream: [{ type: 'chunk', chunk: { type: 'reasoning-delta', text: 'Thinking' } }], failure: { code: 'retry', detail: 'Full provider failure' } }],
    ['assistant/message', { turn: 1, step: 1, stream: [{ type: 'chunk', chunk: { type: 'text-delta', text: 'Answer' } }], message: { id: 'answer-1', role: 'assistant', source: { provider: 'deepseek', model: 'test', replayState: { signature: 'signed' } }, content: [
      { type: 'reasoning', text: 'Reasoning', metadata: { signature: 'signed' } },
      { type: 'encrypted-reasoning', data: 'opaque' },
      { type: 'text', text: 'Answer', hidden: true },
      { type: 'image', attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png', width: 1, height: 1 } },
      { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"file_path":"sample"}' },
    ] } }, { surfaceOp: 'append', sourceEventSeqs: [2, 3] }],
    ['tool/result', { turn: 1, step: 1, message: { id: 'tool-1', role: 'tool', source: { kind: 'tool', callId: 'call-1', rootCallId: 'root-1', parentCallId: 'parent-1' }, content: [{ type: 'text', text: 'Result' }] } }, { surfaceOp: 'append', sourceEventSeqs: [4] }],
    ['compaction/summary', { compactionId: 'compact-1', summary: [{ type: 'text', text: 'Summary' }], rawOutput: [{ type: 'reasoning', text: 'Summary reasoning' }], shadowedSeqs: [0, 2, 4] }],
    ['user/message', { id: 'replacement', role: 'user', content: [{ type: 'text', text: 'Replacement' }] }, { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 4 }, sourceEventSeqs: [6] }],
    ['extension/record', { nested: { any: ['opaque', null, true, 3] } }, { ignorable: true, extension: { sequence: 88 } }],
  ];
  return rows.map(([type, data, extra], seq) => ({ seq, time: 1700000000000 + seq, type, data, ...extra }));
}
function fixture(options = {}) {
  const state = {
    groups: [{ groupId: 'group-a' }, { groupId: 'group-b' }],
    members: [{ groupId: 'group-a', membershipId: 'member-a', botId: 'bot-a', sessionId: 'current-session' }],
    messages: [{ groupId: 'group-a', messageId: 'reply-a', author: { type: 'bot', botId: 'bot-a', membershipId: 'member-a' }, meta: { execution: reference() } }],
    header: header(options.header), events: options.events ?? rawLog(),
    gets: [], calls: [], closed: 0, live: options.live,
  };
  const repo = {
    getGroup: (id) => state.groups.find((group) => group.groupId === id),
    membersOf: (id) => state.members.filter((member) => member.groupId === id),
    messagesOf: (id) => state.messages.filter((message) => message.groupId === id),
  };
  const persistence = { async open(id, mode, settings) {
    state.calls.push({ op: 'open', id, mode, settings });
    await options.onOpen?.(state);
    if (state.openError) throw state.openError;
    return {
      get header() { return state.header; },
      async read(offset, limit, settings) {
        state.calls.push({ op: 'read', offset, limit, settings });
        await options.onRead?.(state);
        if (state.readError) throw state.readError;
        return { events: state.events };
      },
      async close() {
        state.closed += 1;
        await options.onClose?.(state);
        if (state.closeError) throw state.closeError;
      },
    };
  } };
  const sessions = {
    get(id) { state.calls.push({ op: 'get', id }); return state.live; },
    async flush(session) { assert.equal(session, state.live); state.calls.push({ op: 'flush' }); await options.onFlush?.(state); },
    create() { throw new Error('Do not create sessions'); },
    open() { throw new Error('Do not open sessions'); },
    prepare() { throw new Error('Do not prepare sessions'); },
  };
  const ctx = { get(name) {
    state.gets.push(name);
    if (name === 'sessionPersistence') return persistence;
    if (name === 'sessions') return sessions;
    throw new Error('No other service should be accessed: ' + name);
  }, get agents() { throw new Error('Must not restore an Agent'); }, get sessionQuery() { throw new Error('Prepared observations are not persistent logs'); } };
  return { state, repo, ctx, persistence, sessions, read: (params = {}) => readBotSessionLog({ ctx, repo, groupId: 'group-a', sessionId: 'saved-session', ...params }) };
}

test('reads a complete committed log with detached header/events and the native session descriptor', async () => {
  const f = fixture();
  const controller = new AbortController();
  const result = await f.read({ signal: controller.signal, path: '/outside', afterSeq: 5, limit: 1 });
  assert.equal(result.availability, 'available');
  assert.deepEqual(result.header, f.state.header);
  assert.deepEqual(result.events, f.state.events);
  assert.deepEqual(result.session, { id: 'saved-session', origin: 'subagent', native: false });
  assert.deepEqual(f.state.gets, ['sessionPersistence', 'sessions']);
  assert.deepEqual(f.state.calls, [
    { op: 'get', id: 'saved-session' },
    { op: 'open', id: 'saved-session', mode: 'read', settings: { signal: controller.signal } },
    { op: 'read', offset: 0, limit: undefined, settings: { signal: controller.signal } },
  ]);
  assert.equal(f.state.closed, 1);
  result.header.cwd = '/changed';
  result.events[4].data.message.content[0].text = 'changed';
  assert.equal(f.state.header.cwd, '/work/project');
  assert.equal(f.state.events[4].data.message.content[0].text, 'Reasoning');
});

test('serializes the canonical native header and every event verbatim as JSONL', () => {
  const meta = header({ projection: { renderer: 'not-a-log-field' }, native: false });
  const events = rawLog();
  const jsonl = serializeBotSessionLog(meta, events);
  const canonical = { type: 'session', version: 4, id: 'saved-session', createdAt: 1700000000000, cwd: '/work/project', parentSession: 'parent-session', isSeeded: false, origin: 'subagent', delegationDepth: 1, agentPreset: 'bot-team-tools' };
  assert.equal(jsonl, [canonical, ...events].map((row) => JSON.stringify(row)).join('\n') + '\n');
  assert.deepEqual(jsonl.trimEnd().split('\n').map((line) => JSON.parse(line)), [canonical, ...events]);
  assert.equal(jsonl.includes('projection'), false);
  assert.equal(jsonl.includes('native'), false);
});

test('canonical JSONL omits absent optional header fields and defaults delegation depth', () => {
  const meta = { version: 4, id: 'old-session', createdAt: 1, isSeeded: true };
  assert.equal(serializeBotSessionLog(meta, []), '{"type":"session","version":4,"id":"old-session","createdAt":1,"isSeeded":true,"delegationDepth":0}\n');
});

test('flushes only an existing live session before the persistent read and exports the entire committed prefix', async () => {
  const f = fixture({ live: { id: 'saved-session' }, onFlush(state) {
    const seq = state.events.length;
    state.events.push({ seq, time: 1700000000100, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  } });
  const result = await f.read();
  assert.deepEqual(f.state.calls.map((call) => call.op), ['get', 'flush', 'open', 'read']);
  assert.deepEqual(result.events, f.state.events);
  assert.equal(result.events.at(-1).type, 'turn/end');
});

test('never substitutes prepared repairs for persisted events, including real interrupted endings', async () => {
  const f = fixture();
  const persistent = await f.read();
  assert.deepEqual(persistent.events, f.state.events);
  assert.equal(persistent.events.at(-1).type, 'extension/record');
  const seq = f.state.events.length;
  const time = f.state.events.at(-1).time;
  f.state.events.push({ seq, time, type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } });
  const ended = await f.read();
  assert.deepEqual(ended.events, f.state.events, 'a committed interrupted event is retained even with the same timestamp');
});

test('export is unpaginated and remains available without a live session store or a query service', async () => {
  const events = Array.from({ length: 701 }, (_, seq) => ({ seq, time: seq, type: 'extension/record', data: { value: seq }, ignorable: true }));
  const f = fixture({ events, header: { origin: undefined } });
  const result = await f.read({ ctx: { sessionPersistence: f.persistence } });
  assert.equal(result.events.length, 701);
  assert.deepEqual(result.session, { id: 'saved-session', native: true });
  assert.equal(f.state.closed, 1);
});

test('authorizes immutable history after member rotation/removal and current membership for its exact session', async () => {
  const f = fixture();
  f.state.members = [];
  assert.equal((await f.read()).availability, 'available');
  f.state.messages = [];
  f.state.members = [{ groupId: 'group-a', membershipId: 'member-a', botId: 'bot-a', sessionId: 'current-session' }];
  f.state.header.id = 'current-session';
  assert.equal((await f.read({ sessionId: 'current-session' })).availability, 'available');
  await assert.rejects(f.read(), { code: 'invalid-input' });
});

test('rejects unrelated groups, arbitrary paths, and malformed/foreign references before service access', async () => {
  const f = fixture();
  for (const params of [{ groupId: 'group-b' }, { sessionId: 'unrelated' }, { sessionId: '../outside' }, { groupId: '../outside' }, { sessionId: '/private/log' }]) {
    await assert.rejects(f.read(params), { code: 'invalid-input' });
  }
  await assert.rejects(f.read({ groupId: 'absent' }), { code: 'not-found' });
  for (const change of [
    (message) => { message.author.type = 'human'; },
    (message) => { message.meta.execution.version = 2; },
    (message) => { message.groupId = 'group-b'; },
  ]) {
    const fresh = fixture(); change(fresh.state.messages[0]);
    await assert.rejects(fresh.read(), { code: 'invalid-input' });
    assert.deepEqual(fresh.state.gets, []);
  }
  assert.deepEqual(f.state.gets, []);
  assert.equal(f.state.closed, 0);
});

test('rechecks ownership after flush/open/read/close and closes every acquired handle', async () => {
  for (const stage of ['onFlush', 'onOpen', 'onRead', 'onClose']) {
    const f = fixture({ live: {}, [stage](state) { state.messages = []; } });
    await assert.rejects(f.read(), { code: 'invalid-input' });
    assert.equal(f.state.closed, stage === 'onFlush' ? 0 : 1, stage);
  }
  const removed = fixture({ onRead(state) { state.groups = []; } });
  await assert.rejects(removed.read(), { code: 'not-found' });
  assert.equal(removed.state.closed, 1);
});

test('propagates cancellation before lookup and at every asynchronous read boundary', async () => {
  const reason = new Error('Cancelled by caller');
  const before = new AbortController(); before.abort(reason);
  const f = fixture();
  await assert.rejects(f.read({ signal: before.signal }), (error) => error === reason);
  assert.deepEqual(f.state.gets, []);
  for (const stage of ['onFlush', 'onOpen', 'onRead', 'onClose']) {
    const controller = new AbortController();
    const active = fixture({ live: {}, [stage]() { controller.abort(reason); } });
    await assert.rejects(active.read({ signal: controller.signal }), (error) => error === reason);
    assert.equal(active.state.closed, stage === 'onFlush' ? 0 : 1, stage);
  }
  const sdk = fixture();
  sdk.state.readError = Object.assign(new Error('Cancelled by persistence'), { name: 'AbortError' });
  await assert.rejects(sdk.read(), { name: 'AbortError' });
  assert.equal(sdk.state.closed, 1);
});

test('unavailable persistence never falls back to prepared sessionQuery output', async () => {
  const f = fixture();
  const result = await f.read({ ctx: { get(name) { assert.equal(name, 'sessionPersistence'); return undefined; }, get sessionQuery() { assert.fail('Must not query prepared repairs'); } } });
  assert.equal(result.reason, 'session-persistence-unavailable');
  assert.equal(result.header, null);
  assert.deepEqual(result.events, []);
});

test('identity, read, close, corruption, and format errors return safe reasons and release handles', async () => {
  const names = [['SessionPersistenceNotFoundError', 'session-log-missing'], ['SessionPersistenceCorruptionError', 'session-log-corrupt'], ['SessionFormatUnsupportedError', 'session-log-format-unsupported'], ['Error', 'session-log-read-failed']];
  for (const [name, reason] of names) {
    for (const stage of ['openError', 'readError', 'closeError']) {
      const f = fixture(); f.state[stage] = Object.assign(new Error('PRIVATE_STORAGE_PATH'), { name });
      const result = await f.read();
      assert.equal(result.availability, 'unavailable');
      assert.equal(result.reason, reason);
      assert.equal(result.header, null);
      assert.deepEqual(result.events, []);
      assert.equal(JSON.stringify(result).includes('PRIVATE_STORAGE_PATH'), false);
      assert.equal(f.state.closed, stage === 'openError' ? 0 : 1);
    }
  }
  const wrong = fixture({ header: { id: 'another-session' } });
  assert.equal((await wrong.read()).reason, 'session-log-corrupt');
  assert.equal(wrong.state.calls.some((call) => call.op === 'read'), false);
  assert.equal(wrong.state.closed, 1);
  for (const events of [[{ seq: 4, type: 'turn/start', data: { turn: 1 } }], new Array(1)]) {
    const broken = fixture({ events });
    assert.equal((await broken.read()).reason, 'session-log-corrupt');
    assert.equal(broken.state.closed, 1);
  }
  const changed = fixture({ onRead(state) { state.header.id = 'another-session'; } });
  assert.equal((await changed.read()).reason, 'session-log-corrupt');
  assert.equal(changed.state.closed, 1);
});

test('ownership is rechecked even when a persistence operation fails', async () => {
  const f = fixture({ onRead(state) { state.messages = []; state.readError = new Error('storage failed'); } });
  await assert.rejects(f.read(), { code: 'invalid-input' });
  assert.equal(f.state.closed, 1);
});
