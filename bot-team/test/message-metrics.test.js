import test from 'node:test';
import assert from 'node:assert/strict';
import { LastRequestMetrics } from '../host/message-metrics.js';
import { Engine } from '../host/engine.js';

const start = (overrides = {}) => ({ type: 'start', attemptId: 'session:1', revision: 1, turn: 1, step: 1, ...overrides });
const message = (overrides = {}) => ({
  type: 'assistant/message', seq: 10, time: 0,
  data: { turn: 1, step: 1, usage: { inputTokens: 25, outputTokens: 100 }, message: { content: [{ type: 'text', text: 'reply' }] } },
  ...overrides,
});
const end = (overrides = {}) => ({
  type: 'end', attemptId: 'session:1', revision: 3, index: 1,
  outcome: { kind: 'committed', eventType: 'assistant/message', seq: 10 },
  ...overrides,
});

function metricsFixture() {
  let now = 100;
  const metrics = new LastRequestMetrics(() => now);
  return { metrics, at: (value) => { now = value; } };
}

function complete(metrics, at, { began = 100, completed = 1100, outputTokens = 100 } = {}) {
  at(began);
  metrics.start(start(), 1);
  at(completed);
  const event = message();
  event.data.usage.outputTokens = outputTokens;
  metrics.settle(event, 1);
  metrics.end(end());
}

test('measures stream start to assistant/message, not end-frame or wall-clock time', () => {
  const { metrics, at } = metricsFixture();
  metrics.start(start(), 1);
  at(1100);
  metrics.settle(message({ time: -900000 }), 1);
  assert.equal(metrics.stats, null, 'unconfirmed settlement must not be published');
  at(9100);
  metrics.end(end());
  assert.deepEqual(metrics.finish('done'), { scope: 'last-request', durationMs: 1000, outputTokens: 100, tokensPerSecond: 100 });
});

test('a new request clears the previous successful sample immediately', () => {
  const { metrics, at } = metricsFixture();
  complete(metrics, at);
  assert.equal(metrics.stats.tokensPerSecond, 100);
  at(60100);
  metrics.start(start({ attemptId: 'session:2', revision: 4, step: 2 }), 1);
  assert.equal(metrics.stats, null);
  assert.equal(metrics.finish('done'), null);
});

for (const field of ['turn', 'step', 'revision', 'attemptId']) {
  test(`a malformed new start with missing ${field} invalidates old stats`, () => {
    const { metrics, at } = metricsFixture();
    complete(metrics, at);
    const frame = start({ attemptId: 'session:2', revision: 4, step: 2 });
    delete frame[field];
    metrics.start(frame, 1);
    assert.equal(metrics.finish('done'), null);
  });
}

test('same-step retries only use the successful attempt, excluding retry backoff', () => {
  const { metrics, at } = metricsFixture();
  metrics.start(start(), 1);
  at(1100);
  metrics.settle({ type: 'assistant/attempt', seq: 10, data: { turn: 1, step: 1 } }, 1);
  metrics.end(end({ outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 10 } }));
  assert.equal(metrics.stats, null);
  at(10100);
  metrics.start(start({ attemptId: 'session:2', revision: 4 }), 1);
  at(12100);
  metrics.settle(message({ seq: 11 }), 1);
  metrics.end(end({ attemptId: 'session:2', revision: 6, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 11 } }));
  assert.deepEqual(metrics.finish('done'), { scope: 'last-request', durationMs: 2000, outputTokens: 100, tokensPerSecond: 50 });
});

test('late old turns, starts, settlements and terminal frames cannot overwrite a newer attempt', () => {
  const { metrics, at } = metricsFixture();
  complete(metrics, at);
  at(2100);
  const latest = start({ attemptId: 'session:2', revision: 4, step: 2 });
  metrics.start(latest, 1);
  at(2300);
  metrics.start(start(), 1);
  metrics.start(start({ attemptId: 'other-turn', turn: 2, revision: 99 }), 1);
  metrics.settle(message(), 1);
  metrics.end(end());
  metrics.start(latest, 1);
  at(3100);
  const event = message({ seq: 11 });
  event.data.step = 2;
  metrics.settle(event, 1);
  metrics.end(end({ attemptId: latest.attemptId, revision: 6, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 11 } }));
  metrics.settle(event, 1);
  assert.deepEqual(metrics.finish('done'), { scope: 'last-request', durationMs: 1000, outputTokens: 100, tokensPerSecond: 100 });
});

for (const outputTokens of [undefined, null, -1, 1.5, '100', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test(`rejects invalid provider usage: ${String(outputTokens)}`, () => {
    const { metrics, at } = metricsFixture();
    metrics.start(start(), 1);
    at(1100);
    const event = message();
    event.data.usage.outputTokens = outputTokens;
    metrics.settle(event, 1);
    metrics.end(end());
    assert.equal(metrics.finish('done'), null);
  });
}

test('zero reported output tokens are a valid zero rate', () => {
  const { metrics, at } = metricsFixture();
  complete(metrics, at, { outputTokens: 0 });
  assert.deepEqual(metrics.finish('done'), { scope: 'last-request', durationMs: 1000, outputTokens: 0, tokensPerSecond: 0 });
});

for (const completed of [100, 99, NaN, Infinity]) {
  test(`rejects invalid elapsed time: ${String(completed)}`, () => {
    const { metrics, at } = metricsFixture();
    complete(metrics, at, { completed });
    assert.equal(metrics.finish('done'), null);
  });
}

test('rejects invalid start time and overflowing output rate', () => {
  const invalid = metricsFixture();
  complete(invalid.metrics, invalid.at, { began: NaN });
  assert.equal(invalid.metrics.finish('done'), null);
  const overflow = metricsFixture();
  complete(overflow.metrics, overflow.at, { began: 0, completed: Number.MIN_VALUE });
  assert.equal(overflow.metrics.finish('done'), null);
});

for (const scenario of ['missing start', 'missing end', 'wrong attempt', 'wrong seq', 'abandoned', 'interrupted', 'wrong step']) {
  test(`does not estimate speed with ${scenario}`, () => {
    const { metrics, at } = metricsFixture();
    if (scenario !== 'missing start') metrics.start(start(), 1);
    at(1100);
    const event = message();
    if (scenario === 'interrupted') event.data.interrupted = true;
    if (scenario === 'wrong step') event.data.step = 2;
    metrics.settle(event, 1);
    const frame = end();
    if (scenario === 'wrong attempt') frame.attemptId = 'another-attempt';
    if (scenario === 'wrong seq') frame.outcome.seq = 999;
    if (scenario === 'abandoned') frame.outcome = { kind: 'abandoned' };
    if (scenario !== 'missing end') metrics.end(frame);
    assert.equal(metrics.finish('done'), null);
  });
}

for (const status of ['stopped', 'error']) {
  test(`does not retain a previous successful sample when the job is ${status}`, () => {
    const { metrics, at } = metricsFixture();
    complete(metrics, at);
    assert.equal(metrics.finish(status), null);
  });
}

// No real sessions, storage, providers, APIs, or user histories are used.
// Engine job timers are cleared immediately; the metrics clock is deterministic.
function engineFixture() {
  let now = 0;
  let nextSeq = 0;
  const persisted = [];
  const frames = [];
  const members = new Map();
  const agents = new Map();
  const bots = new Map();
  const messages = new Map();
  const repo = {
    messages,
    allocateSeq: () => ++nextSeq,
    getGroup: (id) => id === 'group' ? { groupId: id } : undefined,
    getMember: (id) => members.get(id),
    getBot: (id) => bots.get(id),
    appendMessage: (value) => { messages.set(value.messageId, value); },
    putMessage: (value) => { persisted.push(structuredClone(value)); },
    messagesBetween: () => [],
    touchMember: () => {},
  };
  const engine = new Engine({
    ctx: { on: () => () => {}, agents: { get: (id) => agents.get(id) } },
    repo, pool: {}, personas: {},
    bus: { emit: (groupId, frame) => { frames.push({ groupId, ...structuredClone(frame) }); } },
    config: { maxParallelTurns: 3, turnTimeoutMs: 300000 },
  });
  engine.runJob = () => Promise.resolve();
  const addJob = (id = 'session', turn = 1) => {
    const memberId = `member-${id}`;
    if (!agents.has(id)) agents.set(id, { id, session: { id } });
    members.set(memberId, { membershipId: memberId, groupId: 'group', botId: id, sessionId: id });
    bots.set(id, { botId: id, name: id, provider: 'mock', model: 'mock-model' });
    const job = { jobId: `job-${id}-${turn}`, groupId: 'group', membershipId: memberId, triggerSeq: 0, kind: 'chat' };
    engine.startJob(job);
    clearTimeout(job.timer);
    job.timer = null;
    job.requestMetrics.clock = () => now;
    job.sessionId = id;
    engine.activeBySession.set(id, job);
    engine.onSessionEvent(agents.get(id).session, { type: 'turn/start', data: { turn } });
    return job;
  };
  return {
    engine, persisted, frames, messages, addJob,
    at: (value) => { now = value; },
    stream: (job, frame) => engine.onAssistantStream({ agent: agents.get(job.sessionId), frame }),
    event: (job, event) => engine.onSessionEvent(agents.get(job.sessionId).session, event),
    finish: (job, kind = 'completed') => engine.onSessionEvent(agents.get(job.sessionId).session, { type: 'turn/end', data: { turn: job.turn, reason: { kind } } }),
  };
}

test('Engine persists and emits last-request stats, keeps existing usage, excludes tool/approval time', () => {
  const f = engineFixture();
  const job = f.addJob();
  const stored = f.messages.get(job.placeholderId);
  assert.equal(stored.generationStats, null);
  stored.createdAt = -999999;
  stored.updatedAt = 999999999;
  f.at(100);
  f.stream(job, start());
  f.at(1100);
  f.event(job, message());
  f.stream(job, end());
  // A long tool/approval interval falls between requests, not in either sample.
  f.at(120100);
  f.stream(job, start({ attemptId: 'session:2', revision: 4, step: 2 }));
  f.at(121100);
  f.stream(job, { type: 'chunk', attemptId: 'session:2', revision: 5, chunk: { type: 'reasoning-delta', text: 'thinking' } });
  f.at(122100);
  const latest = message({ seq: 11 });
  latest.data.step = 2;
  latest.data.usage = { inputTokens: 90, outputTokens: 60, totalTokens: 150 };
  latest.data.message.content[0].text = 'final';
  f.event(job, latest);
  f.at(123100);
  f.stream(job, end({ attemptId: 'session:2', revision: 6, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 11 } }));
  f.finish(job);
  const expected = { scope: 'last-request', durationMs: 2000, outputTokens: 60, tokensPerSecond: 30 };
  assert.deepEqual(stored.generationStats, expected);
  assert.equal(stored.text, 'reply\n\nfinal');
  assert.deepEqual(stored.usage, latest.data.usage);
  assert.deepEqual(f.persisted.at(-1).generationStats, expected);
  const updated = f.frames.findLast((frame) => frame.type === 'message.updated');
  assert.deepEqual(updated.message.generationStats, expected);
  assert.deepEqual(JSON.parse(JSON.stringify(stored)).generationStats, expected);
});

test('Engine preserves legacy last-known usage but never reuses it for a response without usage', () => {
  const f = engineFixture();
  const job = f.addJob();
  f.at(100);
  f.stream(job, start());
  f.at(1100);
  const first = message();
  f.event(job, first);
  f.stream(job, end());
  f.at(2100);
  f.stream(job, start({ attemptId: 'session:2', revision: 4, step: 2 }));
  f.at(3100);
  const latest = message({ seq: 11 });
  latest.data.step = 2;
  delete latest.data.usage;
  f.event(job, latest);
  f.stream(job, end({ attemptId: 'session:2', revision: 6, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 11 } }));
  f.finish(job);
  assert.deepEqual(f.persisted.at(-1).usage, first.data.usage);
  assert.equal(f.persisted.at(-1).generationStats, null);
});

test('Engine cancellation/timeout ignores late frames and does not leak samples to the next turn', () => {
  const f = engineFixture();
  const old = f.addJob();
  f.at(100);
  f.stream(old, start());
  f.at(1100);
  f.event(old, message());
  f.stream(old, end());
  f.engine.abortJob(old, 'timeout');
  const snapshot = structuredClone(f.messages.get(old.placeholderId));
  assert.equal(snapshot.generationStats, null);
  f.stream(old, end());
  f.event(old, message());
  f.finish(old);
  assert.deepEqual(f.messages.get(old.placeholderId), snapshot);
  assert.equal(f.persisted.length, 1);
  const next = f.addJob('session', 2);
  f.stream(old, start());
  f.event(old, message());
  f.stream(old, end());
  f.finish(next);
  assert.equal(f.persisted.at(-1).generationStats, null);
});

test('Engine keeps concurrent bot requests isolated by session', () => {
  const f = engineFixture();
  const a = f.addJob('a');
  const b = f.addJob('b');
  f.at(100);
  f.stream(a, start({ attemptId: 'a:1' }));
  f.at(200);
  f.stream(b, start({ attemptId: 'b:1' }));
  f.at(1100);
  f.event(a, message());
  f.stream(a, end({ attemptId: 'a:1' }));
  f.finish(a);
  f.at(2200);
  f.event(b, message());
  f.stream(b, end({ attemptId: 'b:1' }));
  f.finish(b);
  assert.equal(f.messages.get(a.placeholderId).generationStats.tokensPerSecond, 100);
  assert.equal(f.messages.get(b.placeholderId).generationStats.tokensPerSecond, 50);
});

test('Engine degrades to null when an older runtime emits no request framing', () => {
  const f = engineFixture();
  const job = f.addJob();
  f.event(job, message());
  f.finish(job);
  assert.equal(f.persisted.at(-1).generationStats, null);
  assert.equal(f.persisted.at(-1).usage.outputTokens, 100);
});
