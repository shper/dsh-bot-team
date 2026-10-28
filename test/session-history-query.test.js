import test from 'node:test';
import assert from 'node:assert/strict';
import { readBotSessionHistory, readMessageExecution } from '../host/execution.js';

function log() {
  const events = [];
  return { events, add(type, data, extra = {}) {
    const event = { seq: events.length, time: 1700000000000 + events.length, type, data, ...extra };
    events.push(event);
    return event;
  } };
}
const input = (id, text, kind = 'user') => ({ id, role: 'user', source: { kind }, content: [{ type: 'text', text }] });
const answer = (turn, text) => ({ turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }, { type: 'reasoning', text: 'PRIVATE_REASONING' }] } });
const reference = (extra = {}) => ({ version: 1, jobId: 'job-2', sessionId: 'saved-session', inputMessageId: 'input-2', turn: 2, startSeq: null, endSeq: null, ...extra });
const reply = (extra = {}) => ({ messageId: 'reply-2', groupId: 'group-a', author: { type: 'bot', botId: 'bot-a', membershipId: 'member-a' }, status: 'done', meta: { execution: reference() }, ...extra });

function history() {
  const run = log();
  run.add('system/message', { text: 'PRIVATE_SYSTEM' });
  for (let turn = 1; turn <= 3; turn += 1) {
    run.add('turn/start', { turn });
    run.add('step/start', { turn, step: 1 });
    run.add('user/message', input('input-' + turn, 'Request ' + turn));
    run.add('user/message', input('runtime-' + turn, 'PRIVATE_CONTEXT', 'runtime-context'));
    run.add('request/header', { authorization: 'PRIVATE_CREDENTIAL' });
    run.add('assistant/message', answer(turn, 'Answer ' + turn));
    if (turn === 2) {
      run.add('tool/call', { turn, step: 1, callId: 'call-2', name: 'read', arguments: { file_path: 'sample.txt' } });
      run.add('tool/result', { turn, step: 1, message: { role: 'tool', toolCallId: 'call-2', content: [{ type: 'text', text: 'Recorded result' }] } });
    }
    run.add('step/end', { turn, step: 1 });
    run.add('turn/end', { turn, reason: { kind: 'completed' } });
  }
  run.add('request/context', { text: 'PRIVATE_REQUEST_CONTEXT' });
  return run;
}

function fixture(options = {}) {
  const state = {
    groups: [{ groupId: 'group-a' }, { groupId: 'group-b' }],
    members: [{ membershipId: 'member-a', groupId: 'group-a', botId: 'bot-a', sessionId: 'current-session' }],
    messages: [reply()], events: options.events ?? history().events,
    source: options.source ?? 'live', calls: [], gets: [], disposed: 0,
  };
  const repo = {
    getGroup: (id) => state.groups.find((group) => group.groupId === id),
    membersOf: (id) => state.members.filter((member) => member.groupId === id),
    messagesOf: (id) => state.messages.filter((message) => message.groupId === id),
    getMessage: (id) => state.messages.find((message) => message.messageId === id),
    getMember: (id) => state.members.find((member) => member.membershipId === id),
  };
  const query = { async observeSession(id, settings) {
    state.calls.push({ id, settings });
    if (options.onObserve) await options.onObserve(state, settings);
    if (state.failure) throw state.failure;
    return {
      header: { id: state.headerId ?? id, origin: 'subagent', delegationDepth: 0, agentPreset: 'bot-team-tools', ...options.header },
      source: state.source, cursor: state.events.length - 1,
      get events() { if (state.eventsError) throw state.eventsError; return state.events.slice(); },
      [Symbol.dispose]() { state.disposed += 1; },
    };
  } };
  const ctx = {
    get(name) { state.gets.push(name); assert.equal(name, 'sessionQuery'); return query; },
    get sessionQuery() { throw new Error('Use optional-service lookup'); },
    get agents() { throw new Error('History must never activate an Agent'); },
    get sessions() { throw new Error('History must never open or resume a Session'); },
  };
  return { state, repo, ctx, query, read: (params = {}) => readBotSessionHistory({ ctx, repo, groupId: 'group-a', sessionId: 'saved-session', ...params }) };
}

test('reads parentless subagent history across every turn while preserving execution boundaries', async () => {
  const f = fixture();
  const controller = new AbortController();
  const result = await f.read({ signal: controller.signal });
  assert.equal(result.availability, 'available');
  assert.equal(result.groupId, 'group-a');
  assert.equal(result.sessionId, 'saved-session');
  assert.deepEqual(result.events.filter((event) => event.type === 'turn/start').map((event) => event.data.turn), [1, 2, 3]);
  assert.deepEqual(result.events, f.state.events);
  assert.deepEqual(result.session, { id: 'saved-session', origin: 'subagent', native: false });
  assert.deepEqual(result.events.filter((event) => event.type === 'user/message' && event.data.source.kind === 'user').map((event) => event.data.content[0].text), ['Request 1', 'Request 2', 'Request 3']);
  assert.equal(result.events.find((event) => event.type === 'tool/result').data.message.content[0].text, 'Recorded result');
  assert.equal(result.events.find((event) => event.type === 'assistant/message').data.message.content[1].text, 'PRIVATE_REASONING');
  assert.equal(result.nextSeq, f.state.events.at(-1).seq);
  assert.deepEqual(f.state.calls, [{ id: 'saved-session', settings: { signal: controller.signal, projectionMode: 'none' } }]);
  assert.deepEqual(f.state.gets, ['sessionQuery']);
  assert.equal(f.state.disposed, 1);
  const execution = await readMessageExecution({ ctx: f.ctx, repo: f.repo, groupId: 'group-a', messageId: 'reply-2' });
  assert.deepEqual(execution.events.filter((event) => event.type === 'turn/start').map((event) => event.data.turn), [2]);
  assert.deepEqual(execution.events, result.events.filter((event) => event.seq >= execution.execution.startSeq && event.seq <= execution.execution.endSeq));
  assert.deepEqual(execution.session, result.session);
  assert.equal(JSON.stringify(execution).includes('Answer 1'), false);
  assert.equal(JSON.stringify(execution).includes('Answer 3'), false);
});

test('authorizes current membership, immutable historical references, and removed members', async () => {
  const f = fixture();
  assert.equal((await f.read({ sessionId: 'current-session' })).availability, 'available');
  f.state.members[0].sessionId = 'rotated-session';
  assert.equal((await f.read()).availability, 'available');
  f.state.members = [];
  assert.equal((await f.read()).availability, 'available');
  await assert.rejects(f.read({ sessionId: 'current-session' }), { code: 'invalid-input' });
  assert.deepEqual(f.state.calls.map((entry) => entry.id), ['current-session', 'saved-session', 'saved-session']);
});

test('rejects cross-group, unrelated, non-Bot, and invalid references before querying', async () => {
  const f = fixture();
  for (const params of [{ groupId: 'group-b' }, { groupId: 'absent' }, { sessionId: 'arbitrary-session' }]) {
    await assert.rejects(f.read(params), { code: params.groupId === 'absent' ? 'not-found' : 'invalid-input' });
  }
  for (const message of [reply({ author: { type: 'human' } }), reply({ meta: { execution: { sessionId: 'saved-session' } } }), reply({ meta: {} })]) {
    f.state.messages = [message];
    await assert.rejects(f.read(), { code: 'invalid-input' });
  }
  assert.equal(f.state.calls.length, 0);
  assert.equal(f.state.gets.length, 0);
});

test('validates identifiers and pagination before any observation', async () => {
  const f = fixture();
  for (const params of [{ groupId: '' }, { sessionId: '../outside' }, { sessionId: 'x'.repeat(257) }, { afterSeq: '-2' }, { afterSeq: '-0' }, { afterSeq: '1.5' }, { limit: 0 }, { limit: 'invalid' }]) {
    await assert.rejects(f.read(params), { code: 'invalid-input' });
  }
  assert.equal(f.state.calls.length, 0);
});

test('paginates all raw events across turns without duplicates or dropped request tails', async () => {
  const f = fixture();
  const whole = await f.read();
  const collected = [];
  let afterSeq = -1;
  for (let pages = 0; pages < 50; pages += 1) {
    const next = await f.read({ afterSeq, limit: 3 });
    assert.ok(next.events.length <= 3);
    assert.ok(next.nextSeq >= afterSeq);
    collected.push(...next.events);
    afterSeq = next.nextSeq;
    if (!next.hasMore) break;
  }
  assert.deepEqual(collected, whole.events);
  assert.equal(new Set(collected.map((event) => event.seq)).size, collected.length);
  assert.equal(afterSeq, f.state.events.at(-1).seq);
  const empty = await f.read({ afterSeq });
  assert.deepEqual(empty.events, []);
  assert.equal(empty.nextSeq, afterSeq);
  assert.equal(empty.hasMore, false);
});

test('caps page size and retains a detached snapshot as live history grows', async () => {
  const run = log();
  for (let turn = 1; turn <= 302; turn += 1) run.add('turn/start', { turn });
  const f = fixture({ events: run.events });
  const page = await f.read({ limit: 999 });
  assert.equal(page.events.length, 300);
  assert.equal(page.hasMore, true);
  const snapshot = JSON.stringify(page);
  run.events[0].data.turn = 999;
  run.add('assistant/message', answer(302, 'Late answer'));
  const rest = await f.read({ afterSeq: page.nextSeq });
  assert.equal(rest.events.at(-1).data.message.content[0].text, 'Late answer');
  assert.equal(JSON.stringify(page), snapshot);
});

test('retains runtime inputs, missing ids, and raw surface replacements', async () => {
  const run = log();
  run.add('user/message', { ...input(null, 'PRIVATE_NULL_ID', 'runtime-context') });
  run.add('user/message', { content: [{ type: 'text', text: 'PRIVATE_MISSING_ID' }] });
  run.add('user/message', input('visible', 'Visible input'));
  run.add('user/message', input('replacement', 'PRIVATE_REPLACEMENT'), { surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 } });
  const result = await fixture({ events: run.events }).read();
  assert.deepEqual(result.events, run.events);
  assert.deepEqual(result.events.at(-1).surfaceOp, { op: 'replace', startSeq: 0, endSeq: 1 });
  assert.equal(result.nextSeq, 3);
});

test('rechecks ownership after reads and always disposes acquired leases', async () => {
  for (const change of [
    (state) => { state.groups = []; },
    (state) => { state.messages = []; },
  ]) {
    const f = fixture({ onObserve: change });
    await assert.rejects(f.read(), { code: f.state.groups.length ? 'invalid-input' : 'not-found' });
    assert.equal(f.state.disposed, 1);
  }
  const f = fixture({ onObserve(state) { state.members[0].sessionId = 'rotated'; } });
  await assert.rejects(f.read({ sessionId: 'current-session' }), { code: 'invalid-input' });
  assert.equal(f.state.disposed, 1);
});

test('retains historical authorization if a member rotates during observation', async () => {
  const f = fixture({ onObserve(state) { state.members = []; } });
  assert.equal((await f.read()).availability, 'available');
  assert.equal(f.state.disposed, 1);
});

test('propagates cancellation before acquisition, from SDK, and after acquisition', async () => {
  const stopped = new Error('Cancelled');
  const before = new AbortController();
  before.abort(stopped);
  const f = fixture();
  await assert.rejects(f.read({ signal: before.signal }), (error) => error === stopped);
  assert.equal(f.state.calls.length, 0);
  f.state.failure = Object.assign(new Error('SDK cancelled'), { code: 'SESSION_QUERY_ABORTED' });
  await assert.rejects(f.read(), { code: 'SESSION_QUERY_ABORTED' });
  const during = new AbortController();
  const acquired = fixture({ onObserve() { during.abort(stopped); } });
  await assert.rejects(acquired.read({ signal: during.signal }), (error) => error === stopped);
  assert.equal(acquired.state.disposed, 1);
});

test('returns safe unavailable reasons for absent services, missing logs, and corrupt observations', async () => {
  const f = fixture();
  assert.equal((await f.read({ ctx: { get: () => undefined } })).reason, 'session-query-unavailable');
  for (const [code, expected] of [['SESSION_QUERY_SESSION_NOT_FOUND', 'session-log-missing'], ['SESSION_QUERY_SOURCE_CONFLICT', 'session-reference-mismatch'], ['SESSION_QUERY_CORRUPT_SESSION', 'session-log-corrupt'], ['OTHER', 'session-log-read-failed']]) {
    f.state.failure = Object.assign(new Error('PRIVATE_STORAGE_PATH'), { code });
    const result = await f.read();
    assert.equal(result.availability, 'unavailable');
    assert.equal(result.reason, expected);
    assert.deepEqual(result.events, []);
    assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  }
  f.state.failure = undefined;
  f.state.headerId = 'wrong-id';
  assert.equal((await f.read()).availability, 'unavailable');
  f.state.headerId = undefined;
  f.state.eventsError = new Error('Broken getter');
  assert.equal((await f.read()).reason, 'session-log-read-failed');
  f.state.eventsError = undefined;
  f.state.events = [{ seq: 2, type: 'turn/start', data: { turn: 1 } }];
  assert.equal((await f.read()).reason, 'session-log-corrupt');
  assert.equal(f.state.disposed, 3);
});

test('rechecks authorization even when the Session read fails', async () => {
  const f = fixture({ onObserve(state) { state.groups = []; state.failure = new Error('PRIVATE_STORAGE_PATH'); } });
  await assert.rejects(f.read(), { code: 'not-found' });
});

test('cold interruption suffix never advances past durable events or an earlier recorded end', async () => {
  const run = log();
  run.add('turn/start', { turn: 1 });
  const earlierEnd = run.add('turn/end', { turn: 1, reason: { kind: 'completed' } });
  run.add('turn/start', { turn: 2 });
  run.add('step/start', { turn: 2, step: 1 });
  run.add('tool/call', { turn: 2, step: 1, callId: 'call', name: 'read', arguments: '{}' });
  const durable = run.events.slice();
  const time = durable.at(-1).time;
  const seq = run.events.length;
  run.add('tool/result', { turn: 2, step: 1, message: { id: 'interrupted-tool-result-call-' + seq, role: 'tool', toolCallId: 'call', isError: true, source: { kind: 'tool', callId: 'call' }, content: [{ type: 'text', text: 'Outcome unknown' }] }, error: { code: 'TOOL_OUTCOME_UNKNOWN' } }, { time, surfaceOp: 'append' });
  run.add('step/end', { turn: 2, step: 1 }, { time });
  const end = run.add('turn/end', { turn: 2, reason: { kind: 'interrupted' } }, { time });
  const cold = fixture({ events: run.events, source: 'prepared' });
  cold.state.messages[0].meta.execution = reference({ turn: 1, inputMessageId: 'input-1', startSeq: 0, endSeq: earlierEnd.seq });
  const first = await cold.read();
  const live = await fixture({ events: durable }).read();
  assert.deepEqual(first, live);
  assert.equal(first.nextSeq, durable.at(-1).seq);
  cold.state.messages.push(reply({ messageId: 'reply-final', meta: { execution: reference({ turn: 2, startSeq: 2, endSeq: end.seq }) } }));
  const recorded = await cold.read();
  assert.equal(recorded.events.at(-1).data.reason.kind, 'interrupted');
  assert.equal(recorded.nextSeq, end.seq);
  cold.state.source = 'live';
  cold.state.messages.pop();
  assert.equal((await cold.read()).nextSeq, end.seq, 'live actual endings remain visible');
});

test('an empty owned Session is readable with the plain-context query adapter', async () => {
  const f = fixture({ events: [] });
  const result = await f.read({ ctx: { sessionQuery: f.query } });
  assert.equal(result.availability, 'available');
  assert.deepEqual(result.events, []);
  assert.equal(result.nextSeq, -1);
  assert.equal(result.hasMore, false);
  assert.equal(f.state.disposed, 1);
});
