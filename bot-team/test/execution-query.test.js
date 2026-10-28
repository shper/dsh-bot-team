import test from 'node:test';
import assert from 'node:assert/strict';
import { readMessageExecution } from '../host/execution.js';

const input = (id, text = 'Run the task') => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
const assistant = (turn, text, extra = {}) => ({ turn, step: 1, message: { id: 'assistant-' + turn, role: 'assistant', content: [{ type: 'text', text }], source: { provider: 'deepseek', model: 'test' } }, ...extra });
const execution = (extra = {}) => ({ version: 1, jobId: 'job-1', sessionId: 'historical-session', inputMessageId: 'input-2', turn: null, startSeq: null, endSeq: null, ...extra });

function log() {
  const events = [];
  return { events, add(type, data, extra = {}) { const event = { seq: events.length, time: 1700000000000 + events.length, type, data, ...extra }; events.push(event); return event; } };
}

function simpleLog({ closed = true, turn = 2, id = 'input-2' } = {}) {
  const result = log();
  result.add('system/message', { message: { content: [{ type: 'text', text: 'PRIVATE_SYSTEM' }] } });
  result.start = result.add('turn/start', { turn });
  result.add('step/start', { turn, step: 1 });
  result.add('user/message', input(id), { surfaceOp: 'append' });
  result.add('assistant/message', assistant(turn, 'Visible answer'), { surfaceOp: 'append' });
  if (closed) {
    result.add('step/end', { turn, step: 1 });
    result.end = result.add('turn/end', { turn, reason: { kind: 'completed' } });
  }
  return result;
}

function fixture(options = {}) {
  const state = {
    group: { groupId: 'group-1' },
    message: { messageId: 'message-1', groupId: 'group-1', author: { type: 'bot', botId: 'bot-1', membershipId: 'member-1' }, status: 'done', error: null, meta: { execution: execution() }, ...options.message },
    member: { membershipId: 'member-1', groupId: 'group-1', botId: 'bot-1', sessionId: 'current-session' },
    events: options.events ?? simpleLog().events,
    source: options.source ?? 'live',
    calls: [], disposed: 0,
  };
  const repo = {
    getGroup: (id) => state.group?.groupId === id ? state.group : undefined,
    getMessage: (id) => state.message?.messageId === id ? state.message : undefined,
    getMember: (id) => state.member?.membershipId === id ? state.member : undefined,
  };
  const query = { async observeSession(id, settings) {
    state.calls.push({ id, settings });
    if (options.onObserve) await options.onObserve(state, settings);
    if (state.failure) throw state.failure;
    const events = state.events.slice();
    return {
      source: state.source, header: { id: state.headerId ?? id, ...options.header }, cursor: Object.hasOwn(state, 'cursor') ? state.cursor : events.length - 1,
      get events() { if (state.eventsError) throw state.eventsError; return events; },
      [Symbol.dispose]() { state.disposed += 1; },
    };
  } };
  const ctx = { sessionQuery: query,
    get agents() { throw new Error('Execution queries must not restore an Agent'); },
    get sessions() { throw new Error('Execution queries must not open a Session'); },
  };
  return { state, repo, ctx, query, read: (params = {}) => readMessageExecution({ ctx, repo, groupId: 'group-1', messageId: 'message-1', ...params }) };
}

function workflow() {
  const result = log();
  result.add('turn/start', { turn: 1 });
  result.add('user/message', input('old-input', 'SAME TASK'), { surfaceOp: 'append' });
  result.add('assistant/message', assistant(1, 'PRIVATE_PREVIOUS_TURN'));
  result.add('turn/end', { turn: 1, reason: { kind: 'completed' } });
  result.add('agent/inbox/spliced', { inserted: [input('input-2', 'PRIVATE_INBOX_COPY')] });
  result.start = result.add('turn/start', { turn: 2 });
  result.add('agent/inbox/spliced', { removedCount: 1, inserted: [] });
  result.add('step/start', { turn: 2, step: 1 });
  result.add('system/message', { turn: 2, message: { content: [{ type: 'text', text: 'PRIVATE_SYSTEM' }] } });
  result.add('developer/message', { message: { content: [{ type: 'text', text: 'PRIVATE_DEVELOPER' }] } });
  result.add('user/message', input('input-2', 'SAME TASK'), { surfaceOp: 'append' });
  result.add('user/message', { ...input('runtime-context', 'PRIVATE_CONTEXT'), source: { kind: 'runtime-context' } });
  result.add('request/header', { headers: { authorization: 'PRIVATE_TOKEN' }, config: { apiKey: 'PRIVATE_KEY' } });
  result.add('request/context', { context: 'PRIVATE_REQUEST' });
  result.add('assistant/attempt', { turn: 2, step: 1, stream: [{ text: 'PRIVATE_ATTEMPT' }] });
  result.add('llm/retry', { turn: 2, step: 1, retryId: 'retry-1', retry: 1, provider: 'deepseek', mode: 'normal', maxRetries: 3, delayMs: 1000, policyKey: 'PRIVATE_POLICY', failure: { code: 'RATE_LIMIT', message: 'Slow down', headers: 'PRIVATE_FAILURE_HEADERS' } });
  result.add('llm/retry-started', { turn: 2, step: 1, retryId: 'retry-1', retry: 1 });
  result.add('assistant/message', { turn: 2, step: 1, stream: [{ type: 'reasoning-delta', text: 'PRIVATE_STREAM' }], message: { id: 'assistant-2', role: 'assistant', source: { provider: 'deepseek', model: 'test', replayState: 'PRIVATE_REPLAY' }, content: [
    { type: 'reasoning', text: 'PRIVATE_REASONING' }, { type: 'encrypted-reasoning', data: 'PRIVATE_ENCRYPTED' },
    { type: 'text', text: 'PRIVATE_HIDDEN', hidden: true }, { type: 'text', text: 'PRIVATE_INTERNAL', internal: true },
    { type: 'text', text: 'Checking the files.', metadata: { secret: 'PRIVATE_TEXT_META' } },
    { type: 'image', attachment: { attachmentId: 'sha256:image', mediaType: 'image/png', width: 640, height: 480 } },
    { type: 'tool-call', id: 'root-1', name: 'functions.run_code', arguments: 'PRIVATE_DUPLICATED_CALL' },
  ] } }, { surfaceOp: 'append', sourceEventSeqs: [12, 13], providerMetadata: { requestId: 'request-2' } });
  result.arguments = JSON.stringify({ code: 'const value = await tools.read({file_path: "file.js"}); return value;', description: 'Read source', padding: 'x'.repeat(12000) });
  result.add('tool/call', { turn: 2, step: 1, callId: 'root-1', name: 'functions.run_code', arguments: result.arguments });
  result.add('tool/ptc-dispatch-start', { rootCallId: 'root-1', parentCallId: 'root-1', subCallId: 'sub-1', name: 'read', arguments: { file_path: 'file.js' } });
  result.add('tool/ptc-dispatch-start', { rootCallId: 'root-1', parentCallId: 'sub-1', subCallId: 'sub-2', name: 'bash', arguments: { command: 'node --test' } });
  result.add('approval/asked', { id: 'approval-1', toolName: 'bash', callId: 'sub-2', reason: 'Run tests' });
  result.add('approval/decided', { id: 'approval-1', outcome: 'allowed-once' });
  result.output = 'full output\n' + 'z'.repeat(18000);
  result.add('tool/ptc-dispatch', { rootCallId: 'root-1', parentCallId: 'sub-1', subCallId: 'sub-2', name: 'bash', arguments: { command: 'node --test' }, isError: true, content: [{ type: 'text', text: result.output }] });
  result.add('tool/ptc-dispatch', { rootCallId: 'root-1', parentCallId: 'root-1', subCallId: 'sub-1', name: 'read', arguments: { file_path: 'file.js' }, isError: false, content: [{ type: 'text', text: 'File contents' }] });
  result.add('tool/result', { turn: 2, step: 1, message: { id: 'result-1', role: 'tool', toolCallId: 'root-1', isError: true, source: { kind: 'tool', callId: 'root-1' }, content: [{ type: 'text', text: result.output }] }, error: { name: 'ToolCallError', code: 'TEST_FAILED' }, meta: { attachments: [{ id: 'attachment-1' }] } }, { surfaceOp: 'append' });
  result.add('compaction/start', { turn: 2, compactionId: 'compact-1' });
  result.add('compaction/summary', { compactionId: 'compact-1', summary: 'PRIVATE_SUMMARY', rawOutput: [{ type: 'reasoning', text: 'PRIVATE_COMPACT_RAW' }], shadowedRange: { start: 0, end: 25 }, shadowedSeqs: [1, 2], shadowedTokenCount: 500, provider: 'deepseek', model: 'test' });
  result.add('user/message', input('replacement', 'PRIVATE_REPLACEMENT'), { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 } });
  result.add('compaction/prune', { compactionId: 'compact-1', shadowedRange: { start: 1, end: 2 } });
  result.add('compaction/end', { turn: 2, compactionId: 'compact-1' });
  result.add('step/end', { turn: 2, step: 1 });
  result.end = result.add('turn/end', { turn: 2, reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'Tests failed', headers: 'PRIVATE_ERROR_HEADERS' } } });
  result.add('turn/start', { turn: 3 });
  result.add('user/message', input('next-input', 'PRIVATE_NEXT_TURN'));
  result.add('assistant/message', assistant(3, 'PRIVATE_NEXT_ANSWER'));
  result.add('turn/end', { turn: 3, reason: { kind: 'completed' } });
  return result;
}

test('preserves complete raw SDK envelopes, message blocks, attempts, and compaction within exact turn bounds', async () => {
  const run = workflow();
  const f = fixture({ events: run.events, message: { status: 'error', error: 'Tests failed' } });
  const controller = new AbortController();
  const result = await f.read({ signal: controller.signal });
  assert.equal(result.availability, 'available');
  assert.equal(result.status, 'error');
  assert.equal(result.error, 'Tests failed');
  assert.equal(result.execution.startSeq, run.start.seq);
  assert.equal(result.execution.endSeq, run.end.seq);
  assert.equal(result.execution.turn, 2);
  assert.equal(result.nextSeq, run.end.seq);
  assert.equal(result.hasMore, false);
  assert.equal(f.state.disposed, 1);
  assert.deepEqual(f.state.calls, [{ id: 'historical-session', settings: { signal: controller.signal, projectionMode: 'none' } }]);
  assert.deepEqual(result.events, run.events.slice(run.start.seq, run.end.seq + 1));
  assert.deepEqual(result.session, { id: 'historical-session', native: true });
  assert.equal(JSON.stringify(result).includes('PRIVATE_PREVIOUS_TURN'), false);
  assert.equal(JSON.stringify(result).includes('PRIVATE_NEXT_TURN'), false);
  assert.deepEqual(result.events.find((event) => event.type === 'assistant/attempt').data.stream, [{ text: 'PRIVATE_ATTEMPT' }]);
  assert.deepEqual(result.events.find((event) => event.type === 'assistant/message').data.message.content.map((block) => block.type), ['reasoning', 'encrypted-reasoning', 'text', 'text', 'text', 'image', 'tool-call']);
  assert.equal(result.events.find((event) => event.type === 'tool/call').data.arguments, run.arguments);
  const dispatch = result.events.find((event) => event.type === 'tool/ptc-dispatch' && event.data.subCallId === 'sub-2');
  assert.equal(dispatch.data.content[0].text, run.output);
  assert.equal(dispatch.data.isError, true);
  assert.equal(dispatch.data.parentCallId, 'sub-1');
  assert.equal(dispatch.data.rootCallId, 'root-1');
  const toolResult = result.events.find((event) => event.type === 'tool/result');
  assert.deepEqual(toolResult.data.error, { name: 'ToolCallError', code: 'TEST_FAILED' });
  assert.equal(toolResult.data.message.toolCallId, 'root-1');
  assert.equal(toolResult.data.message.content[0].text, run.output);
  assert.deepEqual(toolResult.data.meta.attachments, [{ id: 'attachment-1' }]);
  for (const type of ['approval/asked', 'approval/decided', 'llm/retry', 'llm/retry-started', 'compaction/start', 'compaction/summary', 'compaction/prune', 'compaction/end']) assert.ok(result.events.some((event) => event.type === type), type);
  assert.deepEqual(result.events.map((event) => event.seq), [...result.events.map((event) => event.seq)].sort((a, b) => a - b));
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('reports native and historical subagent origins without restoring agents', async () => {
  for (const origin of [undefined, 'user', 'subagent']) {
    const f = fixture({ header: origin === undefined ? {} : { origin } });
    const result = await f.read();
    assert.deepEqual(result.session, { id: 'historical-session', ...(origin === undefined ? {} : { origin }), native: origin !== 'subagent' });
    assert.equal(f.state.disposed, 1);
  }
  const legacy = await fixture({ message: { meta: null } }).read();
  assert.equal(legacy.session, undefined, 'an unobserved fallback is never claimed to be native');
});

test('preserves opaque future event envelopes and source relations as detached raw JSON', async () => {
  const run = simpleLog({ closed: false });
  const extra = run.add('extension/event', { nested: { value: ['raw'] } }, { ignorable: true, sourceEventSeqs: [1, 3], source: { rootCallId: 'root', parentCallId: 'parent' } });
  const result = await fixture({ events: run.events }).read();
  assert.deepEqual(result.events.at(-1), extra);
  result.events.at(-1).sourceEventSeqs.push(9);
  result.events.at(-1).data.nested.value.push('changed');
  assert.deepEqual(extra.sourceEventSeqs, [1, 3]);
  assert.deepEqual(extra.data.nested.value, ['raw']);
});

test('pagination returns every raw record and gives the same result live and cold', async () => {
  const run = workflow();
  const f = fixture({ events: run.events });
  const all = await f.read({ limit: 300 });
  for (const source of ['live', 'prepared']) {
    f.state.source = source;
    for (const limit of [1, 3, 7, 100]) {
      const events = [];
      let afterSeq = -1;
      for (let page = 0; page < 100; page += 1) {
        const result = await f.read({ afterSeq, limit });
        events.push(...result.events);
        assert.ok(result.nextSeq > afterSeq);
        if (!result.hasMore) { assert.equal(result.nextSeq, run.end.seq); break; }
        afterSeq = result.nextSeq;
      }
      assert.deepEqual(events, all.events);
    }
  }
  const first = await f.read({ limit: 1 });
  assert.equal(first.nextSeq, run.start.seq, 'the next raw event remains available on the next page');
  const empty = await f.read({ afterSeq: run.end.seq });
  assert.deepEqual(empty.events, []);
  assert.equal(empty.nextSeq, run.end.seq);
});

test('defaults accept null, integer query strings and cap a requested limit at 300', async () => {
  const run = simpleLog({ closed: false });
  for (let i = 0; i < 350; i += 1) run.add('tool/call', { turn: 2, step: 1, callId: 'call-' + i, name: 'read', arguments: '{}' });
  const f = fixture({ events: run.events });
  assert.equal((await f.read({ afterSeq: null, limit: null })).events.length, 100);
  assert.equal((await f.read({ afterSeq: '-1', limit: '999' })).events.length, 300);
  assert.equal((await f.read({ limit: 999 })).hasMore, true);
  assert.equal((await f.read({ afterSeq: String(run.events.length + 20) })).events.length, 0);
});

test('rejects malformed params, missing records, group mismatch and non-Bot targets with codes', async () => {
  const f = fixture();
  for (const afterSeq of ['', '1.0', '1e2', ' 1', true, [], {}, NaN, Infinity, -2, 1.1, -0, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(f.read({ afterSeq }), { code: 'invalid-input' });
  for (const limit of ['', '0', 0, -1, 1.5, false, [], {}, Infinity]) await assert.rejects(f.read({ limit }), { code: 'invalid-input' });
  for (const params of [{ groupId: '' }, { groupId: '../other' }, { messageId: null }, { messageId: [] }]) await assert.rejects(f.read(params), { code: 'invalid-input' });
  await assert.rejects(f.read({ groupId: 'missing' }), { code: 'not-found' });
  await assert.rejects(f.read({ messageId: 'missing' }), { code: 'not-found' });
  f.state.message.groupId = 'different-group';
  await assert.rejects(f.read(), { code: 'invalid-input' });
  f.state.message.groupId = 'group-1';
  for (const type of ['human', 'system', undefined]) { f.state.message.author.type = type; await assert.rejects(f.read(), { code: 'invalid-input' }); }
  assert.equal(f.state.calls.length, 0);
});

test('fixed historical sessions survive membership rotation and removal; browser session/path fields have no authority', async () => {
  const f = fixture();
  f.state.member.sessionId = 'rotated-session';
  let result = await f.read({ sessionId: '/private/arbitrary', path: '/tmp/log' });
  assert.equal(result.sessionId, 'historical-session');
  assert.equal(result.fallbackSessionId, undefined);
  f.state.member = undefined;
  result = await f.read();
  assert.equal(result.availability, 'available');
  assert.deepEqual(f.state.calls.map((call) => call.id), ['historical-session', 'historical-session']);
});

test('legacy messages expose only an explicitly named, ownership-checked fallback', async () => {
  const f = fixture({ message: { meta: null } });
  const result = await f.read();
  assert.equal(result.availability, 'legacy-unlinked');
  assert.equal(result.execution, null);
  assert.equal(result.sessionId, undefined);
  assert.equal(result.fallbackSessionId, 'current-session');
  assert.deepEqual(result.events, []);
  for (const change of [{ groupId: 'another' }, { botId: 'another' }, { sessionId: '../other' }]) {
    const before = { ...f.state.member };
    Object.assign(f.state.member, change);
    assert.equal((await f.read()).fallbackSessionId, undefined);
    f.state.member = before;
  }
  f.state.member = undefined;
  assert.equal((await f.read()).fallbackSessionId, undefined);
  assert.equal(f.state.calls.length, 0);
});

test('malformed stored references are unavailable and never trigger a session lookup', async () => {
  const f = fixture();
  for (const ref of [false, [], {}, execution({ version: 2 }), execution({ jobId: null }), execution({ sessionId: '../other' }), execution({ sessionId: '/absolute' }), execution({ inputMessageId: 'x/y' }), execution({ turn: '2' }), execution({ turn: 0 }), execution({ startSeq: -1 }), execution({ startSeq: 9, endSeq: 8 }), execution({ startSeq: 2, submittedSeq: 3 }), execution({ sessionId: null, turn: 2 }), execution({ submittedSeq: NaN })]) {
    f.state.message.meta.execution = ref;
    const result = await f.read();
    assert.equal(result.availability, 'unavailable');
    assert.equal(result.reason, 'invalid-execution-reference');
  }
  assert.equal(f.state.calls.length, 0);
});

test('recovers by exact input ID without text/time heuristics or inbox matches', async () => {
  const run = workflow();
  for (const event of run.events) event.time = 123;
  const f = fixture({ events: run.events });
  const result = await f.read();
  assert.equal(result.execution.turn, 2);
  assert.equal(result.execution.startSeq, run.start.seq);
  f.state.message.meta.execution.inputMessageId = 'nonexistent';
  assert.equal((await f.read()).availability, 'unavailable');
  f.state.message.status = 'pending';
  assert.equal((await f.read()).availability, 'preparing');
  assert.equal((await f.read()).events.length, 0);
});

test('recorded turn requires valid start/end bounds, including pre-input blocked executions', async () => {
  const run = log();
  run.add('turn/start', { turn: 2 });
  run.add('turn/end', { turn: 2, reason: { kind: 'blocked' } });
  const f = fixture({ events: run.events, message: { status: 'error', meta: { execution: execution({ turn: 2, startSeq: 0, endSeq: 1 }) } } });
  assert.equal((await f.read()).availability, 'available');
  f.state.message.meta.execution.startSeq = null;
  assert.equal((await f.read()).reason, 'execution-boundary-missing');
  f.state.message.meta.execution.startSeq = 1;
  assert.equal((await f.read()).reason, 'execution-boundary-mismatch');
  f.state.message.meta.execution = execution({ turn: 2, startSeq: 0, endSeq: 0 });
  assert.equal((await f.read()).reason, 'execution-boundary-mismatch');
});

test('rejects conflicting exact input IDs, turn references and adjacent-turn end bounds', async () => {
  const run = workflow();
  const f = fixture({ events: run.events });
  for (const ref of [execution({ turn: 1, startSeq: 0 }), execution({ startSeq: run.start.seq + 1 }), execution({ endSeq: run.events.length - 1 }), execution({ submittedSeq: run.start.seq + 1 })]) {
    f.state.message.meta.execution = ref;
    assert.equal((await f.read()).availability, 'unavailable');
  }
  f.state.message.meta.execution = execution({ turn: 1, startSeq: 0, inputMessageId: 'nonexistent' });
  assert.equal((await f.read()).reason, 'input-message-mismatch');
  f.state.message.meta.execution = execution();
  run.events.find((event) => event.type === 'user/message' && event.data.id === 'next-input').data.id = 'input-2';
  assert.equal((await f.read()).reason, 'ambiguous-input-message');
});

test('never includes a later turn when an earlier stopped/error log has no end', async () => {
  for (const status of ['stopped', 'error']) {
    const run = simpleLog({ closed: false });
    const last = run.events.at(-1).seq;
    run.add('turn/start', { turn: 3 });
    run.add('user/message', input('unrelated', 'PRIVATE_NEXT'));
    run.add('approval/asked', { id: 'unrelated', reason: 'PRIVATE_APPROVAL' });
    run.add('assistant/message', assistant(3, 'PRIVATE_ANSWER'));
    run.add('turn/end', { turn: 3, reason: { kind: 'completed' } });
    const f = fixture({ events: run.events, message: { status, error: 'Interrupted locally' } });
    const result = await f.read();
    assert.equal(result.status, status);
    assert.equal(result.error, 'Interrupted locally');
    assert.equal(result.availability, 'available');
    assert.equal(result.execution.endSeq, null);
    assert.equal(result.reason, 'execution-log-incomplete');
    assert.equal(result.nextSeq, last);
    assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  }
});

test('a foreign turn coordinate fences a broken log even without its next turn/start', async () => {
  const run = simpleLog({ closed: false });
  const last = run.events.at(-1).seq;
  run.add('assistant/message', assistant(3, 'PRIVATE_FOREIGN'));
  run.add('tool/ptc-dispatch', { rootCallId: 'foreign', content: [{ type: 'text', text: 'PRIVATE_FOREIGN_TOOL' }] });
  const result = await fixture({ events: run.events }).read();
  assert.equal(result.nextSeq, last);
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
});

test('preparing is only an active not-yet-recorded turn; completed absent logs are unavailable', async () => {
  const f = fixture({ events: [], message: { status: 'pending' } });
  const preparing = await f.read();
  assert.equal(preparing.availability, 'preparing');
  assert.deepEqual(preparing.session, { id: 'historical-session', native: true });
  f.state.message.status = 'error';
  assert.equal((await f.read()).availability, 'unavailable');
  f.state.message.status = 'streaming';
  f.state.message.meta.execution.sessionId = null;
  assert.equal((await f.read()).availability, 'preparing');
  f.state.message.status = 'stopped';
  assert.equal((await f.read()).availability, 'unavailable');
});

test('reads the current message status and metadata after observation settles', async () => {
  const run = simpleLog({ closed: false });
  const f = fixture({ events: run.events, message: { status: 'pending' }, onObserve(state) {
    state.message = { ...state.message, status: 'stopped', error: 'Stopped during observation', meta: { execution: execution({ turn: 2, startSeq: run.start.seq }) } };
  } });
  const result = await f.read();
  assert.equal(result.status, 'stopped');
  assert.equal(result.error, 'Stopped during observation');
  assert.equal(result.execution.endSeq, null);
  assert.equal(f.state.disposed, 1);
});

test('a replaced execution reference during observation is never mixed with the old session', async () => {
  const f = fixture({ onObserve(state) { state.message.meta.execution = execution({ sessionId: 'different-session' }); } });
  const result = await f.read();
  assert.equal(result.reason, 'execution-reference-changed');
  assert.deepEqual(result.events, []);
  assert.equal(f.state.disposed, 1);
});

test('reads optional services through Cordis ctx.get without touching an uninjected property', async () => {
  const f = fixture();
  let propertyReads = 0;
  Object.defineProperty(f.ctx, 'sessionQuery', { get() {
    propertyReads += 1;
    throw new Error('cannot get property "sessionQuery" without inject');
  } });
  f.ctx.get = function (name) { assert.equal(this, f.ctx); assert.equal(name, 'sessionQuery'); return f.query; };
  const result = await f.read();
  assert.equal(result.availability, 'available');
  assert.ok(result.events.some((event) => event.type === 'assistant/message'));
  assert.equal(f.state.disposed, 1);
  f.ctx.get = () => undefined;
  assert.equal((await f.read()).reason, 'session-query-unavailable');
  assert.equal(f.state.calls.length, 1);
  assert.equal(propertyReads, 0, 'a missing optional service must not fall back to the guarded property');
});

test('missing/corrupt/failed logs return useful reasons without private SDK exception text', async () => {
  const f = fixture();
  for (const [code, reason] of [['SESSION_QUERY_SESSION_NOT_FOUND', 'session-log-missing'], ['ENOENT', 'session-log-missing'], ['SESSION_QUERY_CORRUPT_SESSION', 'session-log-corrupt'], ['SESSION_QUERY_SOURCE_CONFLICT', 'session-reference-mismatch'], ['SESSION_QUERY_PERSISTENCE_FAILED', 'session-log-read-failed']]) {
    f.state.failure = Object.assign(new Error('PRIVATE_PATH /secret/header'), { code });
    const result = await f.read();
    assert.equal(result.availability, 'unavailable');
    assert.equal(result.reason, reason);
    assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  }
  assert.equal(f.state.disposed, 0, 'no lease was returned');
});

test('disposes a lease on corrupt observation, event getter failure and target validation failure', async () => {
  const f = fixture();
  f.state.headerId = 'wrong-session';
  assert.equal((await f.read()).availability, 'unavailable');
  f.state.headerId = undefined;
  f.state.eventsError = new Error('Broken getter');
  assert.equal((await f.read()).reason, 'session-log-read-failed');
  f.state.eventsError = undefined;
  f.state.events = [{ seq: 1, type: 'turn/start', data: { turn: 2 } }];
  assert.equal((await f.read()).reason, 'session-log-corrupt');
  assert.equal(f.state.disposed, 3);
  const removed = fixture({ onObserve(state) { state.message = undefined; } });
  await assert.rejects(removed.read(), { code: 'not-found' });
  assert.equal(removed.state.disposed, 1);
});

test('propagates cancellation before acquisition, from SDK, and after a lease is acquired', async () => {
  const controller = new AbortController();
  const stopped = new Error('Caller cancelled');
  controller.abort(stopped);
  const f = fixture();
  await assert.rejects(f.read({ signal: controller.signal }), (error) => error === stopped);
  assert.equal(f.state.calls.length, 0);
  f.state.failure = Object.assign(new Error('SDK cancelled'), { code: 'SESSION_QUERY_ABORTED' });
  await assert.rejects(f.read(), { code: 'SESSION_QUERY_ABORTED' });
  const during = new AbortController();
  const acquired = fixture({ onObserve() { during.abort(stopped); } });
  await assert.rejects(acquired.read({ signal: during.signal }), (error) => error === stopped);
  assert.equal(acquired.state.disposed, 1);
});

test('live growth resumes after raw request and attempt tails without mutating a captured page', async () => {
  const run = simpleLog({ closed: false });
  run.add('request/header', { authorization: 'PRIVATE_HEADER' });
  run.add('assistant/attempt', { turn: 2, step: 1, stream: ['PRIVATE_STREAM'] });
  const f = fixture({ events: run.events, message: { status: 'streaming' } });
  const first = await f.read();
  const snapshot = JSON.stringify(first);
  assert.equal(first.nextSeq, run.events.length - 1);
  assert.equal(first.hasMore, false);
  run.add('assistant/message', assistant(2, 'More visible text'));
  run.add('step/end', { turn: 2, step: 1 });
  const end = run.add('turn/end', { turn: 2, reason: { kind: 'completed' } });
  f.state.message.status = 'done';
  f.state.message.meta.execution = execution({ turn: 2, startSeq: run.start.seq, endSeq: end.seq });
  const second = await f.read({ afterSeq: first.nextSeq });
  assert.deepEqual(second.events.map((event) => event.type), ['assistant/message', 'step/end', 'turn/end']);
  assert.equal(second.nextSeq, end.seq);
  assert.equal(second.status, 'done');
  assert.equal(JSON.stringify(first), snapshot);
});

test('cold synthetic interruption repairs do not invent an end or consume future real seqs', async () => {
  const run = simpleLog({ closed: false });
  run.add('tool/call', { turn: 2, step: 1, callId: 'root', name: 'bash', arguments: '{}' });
  const real = run.events.slice();
  const time = real.at(-1).time;
  const seq = run.events.length;
  run.add('tool/result', { turn: 2, step: 1, message: { id: 'interrupted-tool-result-root-' + seq, role: 'tool', toolCallId: 'root', isError: true, source: { kind: 'tool', callId: 'root' }, content: [{ type: 'text', text: 'Outcome unknown' }] }, error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' } }, { time, surfaceOp: 'append' });
  run.add('step/end', { turn: 2, step: 1 }, { time });
  run.add('turn/end', { turn: 2, reason: { kind: 'interrupted' } }, { time });
  const live = await fixture({ events: real, message: { status: 'error' } }).read();
  const cold = await fixture({ events: run.events, source: 'prepared', message: { status: 'error' } }).read();
  assert.deepEqual(cold, live);
  assert.equal(cold.execution.endSeq, null);
  assert.equal(cold.nextSeq, real.at(-1).seq);
});

test('real interrupted endings with durable end refs or distinct timestamps remain visible', async () => {
  const run = simpleLog({ closed: false });
  run.add('step/end', { turn: 2, step: 1 });
  const end = run.add('turn/end', { turn: 2, reason: { kind: 'interrupted' } });
  const f = fixture({ events: run.events, source: 'prepared', message: { status: 'error' } });
  assert.equal((await f.read()).events.at(-1).type, 'turn/end');
  for (const event of run.events.slice(-3)) event.time = 100;
  f.state.message.meta.execution = execution({ turn: 2, startSeq: run.start.seq, endSeq: end.seq });
  const result = await f.read();
  assert.equal(result.execution.endSeq, end.seq);
  assert.equal(result.events.at(-1).data.reason.kind, 'interrupted');
});

test('keeps full tool values JSON-safe and detached with broken, cyclic or absent data', async () => {
  const run = simpleLog({ closed: false });
  const args = { amount: 1n, invalid: Infinity, text: 'keep all text', nested: { value: 2 } };
  args.self = args;
  Object.defineProperty(args, 'getter', { enumerable: true, get() { throw new Error('Must not run'); } });
  args.toJSON = () => { throw new Error('Must not run'); };
  run.add('tool/ptc-dispatch-start', { rootCallId: 'root', parentCallId: 'root', subCallId: 'sub', name: 'read', arguments: args });
  run.add('tool/result', null);
  run.add('assistant/message', { turn: 2, message: { content: [null, { type: 'reasoning', text: 'PRIVATE' }, { type: 'text' }] } });
  run.add('approval/asked', undefined);
  const result = await fixture({ events: run.events }).read();
  assert.equal(result.availability, 'available');
  const projected = result.events.find((event) => event.type === 'tool/ptc-dispatch-start').data.arguments;
  assert.equal(projected.amount, '1');
  assert.equal(projected.invalid, null);
  assert.equal(projected.self, '[Circular]');
  assert.equal(projected.getter, undefined);
  assert.equal(projected.toJSON, undefined);
  projected.nested.value = 99;
  assert.equal(args.nested.value, 2);
  assert.doesNotThrow(() => JSON.stringify(result));
});


test('returns an incomplete prefix when a recorded end is ahead of the captured snapshot', async () => {
  const run = simpleLog({ closed: false });
  const f = fixture({ events: run.events, message: { status: 'done', meta: { execution: execution({ turn: 2, startSeq: run.start.seq, endSeq: 20 }) } } });
  const result = await f.read();
  assert.equal(result.availability, 'available');
  assert.equal(result.reason, 'execution-log-incomplete');
  assert.equal(result.execution.endSeq, 20);
  assert.equal(result.nextSeq, run.events.at(-1).seq);
  run.add('turn/end', { turn: 2, reason: { kind: 'completed' } });
  assert.equal((await f.read()).reason, 'execution-boundary-mismatch', 'an observed actual end must match the reference');
});

test('an exact input without enclosing turn boundaries never authorizes a historical read', async () => {
  const run = log();
  run.add('user/message', input('input-2'));
  run.add('assistant/message', assistant(2, 'Unscoped answer'));
  const result = await fixture({ events: run.events }).read();
  assert.equal(result.availability, 'unavailable');
  assert.deepEqual(result.events, []);
});

test('failed observations also report current terminal message metadata', async () => {
  const f = fixture({ message: { status: 'pending' }, onObserve(state) {
    state.message = { ...state.message, status: 'error', error: 'Host restarted' };
    state.failure = Object.assign(new Error('Missing log'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' });
  } });
  const result = await f.read();
  assert.equal(result.status, 'error');
  assert.equal(result.error, 'Host restarted');
  assert.equal(result.reason, 'session-log-missing');
});

test('missing approval/tool payloads and raw system/request tails retain data and advance the cursor', async () => {
  const run = simpleLog({ closed: false });
  run.add('tool/result', {});
  run.add('approval/decided', null);
  const start = run.events.at(-1).seq;
  run.add('system/message', { content: 'PRIVATE_PROMPT' });
  run.add('request/header', { headers: 'PRIVATE_SECRET' });
  const f = fixture({ events: run.events });
  const result = await f.read({ afterSeq: start });
  assert.equal(result.availability, 'available');
  assert.deepEqual(result.events, run.events.slice(start + 1));
  assert.equal(result.nextSeq, run.events.at(-1).seq);
  assert.equal(result.hasMore, false);
});

test('missing observation cursors and sparse events fail closed', async () => {
  const missing = fixture();
  missing.state.cursor = undefined;
  assert.equal((await missing.read()).reason, 'session-log-corrupt');
  assert.equal(missing.state.disposed, 1);
  const sparse = fixture({ events: new Array(1) });
  assert.equal((await sparse.read()).reason, 'session-log-corrupt');
  assert.equal(sparse.state.disposed, 1);
});

test('out-of-order snapshots fail closed instead of silently reordering corrupted logs', async () => {
  const run = simpleLog();
  [run.events[2], run.events[3]] = [run.events[3], run.events[2]];
  const f = fixture({ events: run.events });
  const result = await f.read();
  assert.equal(result.reason, 'session-log-corrupt');
  assert.equal(f.state.disposed, 1);
});
