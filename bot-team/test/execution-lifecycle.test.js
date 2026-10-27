import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../host/engine.js';
import { AgentPool } from '../host/agents.js';
import { openRepository } from '../host/domain.js';
import { BotTeamService } from '../host/service.js';
import { resolveConfig } from '../host/util.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

// The storage backend clones at submission and serializes writes, just like the
// host domain. Reopening it exercises persisted records rather than live objects.
function storageFixture() {
  const tables = new Map();
  const writes = [];
  let tail = Promise.resolve();
  const storage = {
    writes,
    beforePut: null,
    failPut: null,
    records(name) {
      if (!tables.has(name)) tables.set(name, new Map());
      return tables.get(name);
    },
    flush: () => tail,
  };
  storage.domain = {
    table(name) {
      const records = storage.records(name);
      return {
        entries: () => [...records].map(([key, value]) => [key, structuredClone(value)]),
        put(key, value) {
          const snapshot = structuredClone(value);
          writes.push({ table: name, key, value: snapshot });
          const saved = tail.then(async () => {
            await storage.beforePut?.(name, snapshot);
            if (storage.failPut?.(name, snapshot)) throw new Error('disk write failed');
            records.set(key, snapshot);
          });
          tail = saved.catch(() => {});
          return saved;
        },
        async delete(key) { records.delete(key); },
      };
    },
    async close() {},
  };
  return storage;
}

async function fixture(t, options = {}) {
  const storage = storageFixture();
  const frames = [];
  const warnings = [];
  const sessions = new Map();
  const callbacks = new Map();
  const submissions = [];
  const sessionHandlers = new Set();
  const logger = { warn: (text) => warnings.push(text) };
  const ctx = {
    logger,
    storageDomain: { open: async () => storage.domain },
    agents: { get: (id) => sessions.get(id) },
    get: () => undefined,
    on(type, handler) {
      assert.equal(type, 'session/event');
      sessionHandlers.add(handler);
      return () => sessionHandlers.delete(handler);
    },
  };
  const repo = await openRepository(ctx, logger);
  await repo.putGroup({ groupId: 'group', title: 'Group', nextSeq: 0 });
  const personas = { refresh: options.refresh || (async () => {}) };
  const config = { maxParallelTurns: 3, turnTimeoutMs: 300000, botApprovalPolicy: 'ask', ...options.config };
  const pool = new AgentPool({ ctx, repo, personas, config, logger });
  for (const suffix of ['a', 'b']) {
    await repo.putBot({ botId: suffix, name: suffix, provider: 'mock', model: 'mock', capability: 'work' });
    await repo.putMember({ membershipId: suffix, groupId: 'group', botId: suffix, sessionId: `member-session-${suffix}`, lastSeenSeq: 0 });
    const handlers = new Map();
    callbacks.set(suffix, handlers);
    const agent = {
      id: `actual-session-${suffix}`,
      session: { id: `actual-session-${suffix}`, seq: 20 },
      cancelled: 0,
      followup(input) {
        // This assertion runs at the model-submission boundary, before any event.
        const persisted = [...storage.records('messages').values()].find((message) => message.meta?.execution?.inputMessageId === input.id);
        assert.ok(persisted, 'input identity must be durable before followup');
        assert.equal(persisted.meta.execution.sessionId, agent.id);
        assert.equal(input.role, 'user');
        submissions.push({ agent, input: structuredClone(input), persisted: structuredClone(persisted) });
        options.onFollowup?.(agent, input);
      },
      cancel() { agent.cancelled += 1; },
    };
    sessions.set(agent.id, agent);
    await pool.makeSetup(suffix)({
      on: (type, handler) => { handlers.set(type, handler); },
      systemPrompt: { section() {}, context() {} },
    }, agent);
  }
  pool.ensure = options.ensure || (async (id) => sessions.get(`actual-session-${id}`));
  const engine = new Engine({
    ctx, repo, pool, personas, config, logger,
    bus: { emit: (groupId, frame) => frames.push({ groupId, ...structuredClone(frame) }) },
  });
  pool.attachStreamHandler((payload) => engine.onAssistantStream(payload));
  engine.buildPrompt = () => 'test prompt';
  const f = {
    engine, repo, pool, storage, frames, warnings, sessions, submissions, ctx, callbacks,
    agent: (suffix = 'a') => sessions.get(`actual-session-${suffix}`),
    start: (spec = {}) => engine.enqueueJob({ groupId: 'group', membershipId: 'a', triggerSeq: 0, triggerMessageId: null, kind: 'chat', ...spec }),
    message: (job) => repo.getMessage(job.placeholderId),
    durable: (job) => structuredClone(storage.records('messages').get(job.placeholderId)),
    input: (job) => submissions.find((submission) => submission.input.id === job.execution.inputMessageId)?.input,
    event(suffix, type, data, seq) {
      const agent = f.agent(suffix);
      const event = { type, seq: seq ?? agent.session.seq, time: 0, data };
      agent.session.seq = Math.max(agent.session.seq, event.seq + 1);
      for (const handler of sessionHandlers) handler(agent.session, event);
      return event;
    },
    claim(suffix, input, turn) { callbacks.get(suffix).get('agent/inbox/claimed')({ message: input, turn }); },
    stream(suffix, frame) { callbacks.get(suffix).get('agent/assistant-stream')({ frame }); },
    bind(job, turn, { claim = true } = {}) {
      const suffix = job.membershipId;
      const start = f.event(suffix, 'turn/start', { turn });
      if (claim) f.claim(suffix, f.input(job), turn);
      f.event(suffix, 'step/start', { turn, step: 1 });
      f.event(suffix, 'user/message', f.input(job));
      return start;
    },
    answer(job, text = 'reply') {
      return f.event(job.membershipId, 'assistant/message', {
        turn: job.turn, step: 1, usage: { inputTokens: 5, outputTokens: 10 },
        message: { role: 'assistant', id: `answer-${job.jobId}`, content: [{ type: 'text', text }] },
      });
    },
    async finish(job, reason = { kind: 'completed' }) {
      f.event(job.membershipId, 'step/end', { turn: job.turn, step: 1 });
      const end = f.event(job.membershipId, 'turn/end', { turn: job.turn, reason });
      await job.done;
      await storage.flush();
      return end;
    },
  };
  t.after(async () => { await engine.dispose(); await storage.flush(); });
  return f;
}

async function quotaFixture(t, rawConfig = {}) {
  const f = await fixture(t, { config: resolveConfig(rawConfig) });
  const service = Object.assign(Object.create(BotTeamService.prototype), {
    repo: f.repo,
    config: f.engine.config,
    engine: f.engine,
  });
  f.engine.quotaGuard = (groupId) => service.checkQuota(groupId);
  return { ...f, service };
}

for (const scenario of [
  { name: 'default configuration', config: {} },
  { name: 'legacy maxTurnsPerHour: 120', config: { maxTurnsPerHour: 120 } },
]) {
  test('125 replies in one hour complete under ' + scenario.name, async (t) => {
    const at = new Date(2026, 9, 27, 12).getTime();
    t.mock.method(Date, 'now', () => at);
    const f = await quotaFixture(t, scenario.config);
    assert.equal(Object.hasOwn(f.service.config, 'maxTurnsPerHour'), false);
    for (let turn = 1; turn <= 125; turn += 1) {
      const sent = f.engine.postHumanMessage({ groupId: 'group', text: 'reply ' + turn, mentions: ['a'] });
      assert.deepEqual(sent.accepted, ['a']);
      const job = f.engine.running.get('a');
      await tick();
      f.bind(job, turn);
      f.answer(job);
      await f.finish(job);
      assert.equal(f.durable(job).status, 'done');
    }
    const replies = f.repo.messagesOf('group').filter((message) => message.author.type === 'bot');
    assert.equal(replies.length, 125);
    assert.ok(replies.every((message) => message.createdAt === at && message.status === 'done'));
    assert.equal(f.submissions.length, 125);
    assert.deepEqual(f.service.checkQuota('group'), { ok: true, tokensToday: 1875, tokenLimit: 5000000 });
    assert.equal(f.engine.isRunning('group'), false);
  });
}

test('daily token budget still stops new replies at the boundary and resets at local midnight', async (t) => {
  let at = new Date(2026, 9, 27, 12).getTime();
  t.mock.method(Date, 'now', () => at);
  const f = await quotaFixture(t, { dailyTokenBudget: 1000, maxTurnsPerHour: 120 });
  const previousDay = f.engine.createMessage({ groupId: 'group', author: { type: 'bot' }, text: 'yesterday' });
  previousDay.createdAt = new Date(2026, 9, 26, 23, 59, 59).getTime();
  previousDay.usage = { totalTokens: 5000 };
  await f.repo.putMessage(previousDay);
  await f.repo.putGroup({ groupId: 'other', title: 'Other group', nextSeq: 0 });
  const otherGroup = f.engine.createMessage({ groupId: 'other', author: { type: 'bot' }, text: 'other group' });
  otherGroup.usage = { totalTokens: 5000 };
  await f.repo.putMessage(otherGroup);
  const today = f.engine.createMessage({ groupId: 'group', author: { type: 'bot' }, text: 'earlier today' });
  today.createdAt = new Date(2026, 9, 27, 0).getTime();
  today.usage = { totalTokens: 985 };
  await f.repo.putMessage(today);
  assert.deepEqual(f.service.checkQuota('group'), { ok: true, tokensToday: 985, tokenLimit: 1000 });
  assert.equal(f.service.checkQuota('other').ok, false, 'each group has an independent budget');

  f.engine.postHumanMessage({ groupId: 'group', text: 'last allowed reply', mentions: ['a'] });
  const job = f.engine.running.get('a');
  await tick();
  f.bind(job, 1);
  f.answer(job); // Usage without totalTokens falls back to input + output (5 + 10).
  await f.finish(job);
  assert.equal(f.message(job).status, 'done');
  assert.deepEqual(f.service.checkQuota('group'), {
    ok: false,
    reason: '本群今日 token 用量已达上限（1000 / 1000），请明天再试或调整配额',
    tokensToday: 1000,
    limit: 1000,
  });
  const denied = (error) => error.code === 'quota' && /今日 token/.test(error.message);
  assert.throws(() => f.engine.postHumanMessage({ groupId: 'group', text: 'over budget', mentions: ['a'] }), denied);
  assert.throws(() => f.engine.retryMessage(job.placeholderId), denied);
  assert.throws(() => f.engine.requestReview({ groupId: 'group', targetMessageId: job.placeholderId, reviewerMembershipId: 'b' }), denied);
  assert.throws(() => f.service.requireTaskQuota('group'), denied);
  await assert.rejects(() => f.engine.startDiscussion({ groupId: 'group', topic: 'over budget', membershipIds: ['a'], rounds: 2 }), denied);
  assert.equal(f.submissions.length, 1, 'denied operations never submit another model request');
  assert.equal(f.engine.isRunning('group'), false);
  assert.doesNotThrow(() => f.engine.postHumanMessage({ groupId: 'group', text: 'human only', mentions: [] }));

  at = new Date(2026, 9, 28, 0).getTime();
  assert.deepEqual(f.service.checkQuota('group'), { ok: true, tokensToday: 0, tokenLimit: 1000 });
  f.engine.postHumanMessage({ groupId: 'group', text: 'new day', mentions: ['a'] });
  const next = f.engine.running.get('a');
  await tick();
  f.bind(next, 2);
  f.answer(next);
  await f.finish(next);
  assert.equal(f.message(next).status, 'done');
  assert.deepEqual(f.service.checkQuota('group'), { ok: true, tokensToday: 15, tokenLimit: 1000 });
});

test('every reply starts with a fresh reference and records the ensured agent before submission', async (t) => {
  const ready = deferred();
  const f = await fixture(t, { ensure: () => ready.promise });
  const stale = { version: 1, jobId: 'old', sessionId: 'old-session', inputMessageId: 'old-input', turn: 99, startSeq: 100, endSeq: 200, submittedSeq: 90 };
  const job = f.start({ meta: { taskId: 'task', execution: stale } });
  await f.storage.flush();
  assert.deepEqual(f.durable(job).meta, { taskId: 'task', execution: {
    version: 1, jobId: job.jobId, sessionId: null, inputMessageId: null, turn: null, startSeq: null, endSeq: null,
  } });
  ready.resolve(f.agent());
  await tick();
  assert.equal(f.submissions.length, 1);
  assert.equal(job.execution.sessionId, f.agent().id);
  assert.equal(job.execution.submittedSeq, 20);
  assert.notEqual(job.execution.inputMessageId, stale.inputMessageId);
  assert.equal(f.submissions[0].persisted.meta.execution.inputMessageId, job.execution.inputMessageId);
  f.repo.getMember('a').sessionId = 'rotated-again';
  const start = f.bind(job, 1);
  f.answer(job);
  const end = await f.finish(job);
  assert.deepEqual(f.durable(job).meta.execution, {
    version: 1, jobId: job.jobId, sessionId: 'actual-session-a', inputMessageId: f.input(job).id,
    turn: 1, startSeq: start.seq, endSeq: end.seq, submittedSeq: 20,
  });
  assert.equal(f.durable(job).meta.taskId, 'task');
});

test('exact claims isolate concurrent sessions, unrelated inputs and successive turns', async (t) => {
  const f = await fixture(t);
  const a = f.start();
  const b = f.start({ membershipId: 'b' });
  await tick();
  f.event('a', 'turn/start', { turn: 2 });
  f.claim('a', { id: 'unrelated' }, 2);
  f.claim('b', f.input(a), 2);
  f.event('a', 'user/message', { id: 'unrelated', content: [] });
  f.event('a', 'assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'wrong' }] } });
  f.event('a', 'turn/end', { turn: 2, reason: { kind: 'completed' } });
  f.event('a', 'turn/start', { turn: 88 }, 19);
  assert.equal(a.turn, null);
  assert.equal(b.turn, null);
  assert.equal(a.finished, false);
  assert.equal(f.message(a).text, '');
  const startA = f.bind(a, 3);
  const startB = f.bind(b, 1);
  f.claim('a', f.input(a), 88);
  assert.equal(a.turn, 3);
  f.answer(a, 'answer a');
  f.answer(b, 'answer b');
  await f.finish(a);
  await f.finish(b);
  assert.equal(f.durable(a).meta.execution.startSeq, startA.seq);
  assert.equal(f.durable(b).meta.execution.startSeq, startB.seq);
  const old = f.durable(a);
  const next = f.start();
  await tick();
  const startNext = f.event('a', 'turn/start', { turn: 4 });
  f.claim('a', f.input(a), 3);
  f.event('a', 'user/message', f.input(a));
  f.stream('a', { type: 'start', turn: 3, step: 1, attemptId: 'old', revision: 1 });
  f.stream('a', { type: 'chunk', attemptId: 'old', chunk: { type: 'text-delta', text: 'old text' } });
  assert.equal(next.turn, null);
  f.claim('a', f.input(next), 4);
  f.event('a', 'step/start', { turn: 4, step: 1 });
  f.event('a', 'user/message', f.input(next));
  f.answer(next, 'new answer');
  await f.finish(next);
  assert.equal(f.durable(next).meta.execution.startSeq, startNext.seq);
  assert.equal(f.durable(next).text, 'new answer');
  assert.deepEqual(f.durable(a), old);
  assert.notEqual(next.execution.inputMessageId, a.execution.inputMessageId);
});

test('user/message fallback matches direct data.id and recovers the enclosing turn start', async (t) => {
  const f = await fixture(t);
  const job = f.start();
  await tick();
  f.event('a', 'turn/start', { turn: 1 });
  f.event('a', 'user/message', { id: 'some-other-input', content: [] });
  f.event('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  assert.equal(job.turn, null);
  const start = f.bind(job, 2, { claim: false });
  await f.storage.flush();
  assert.equal(f.durable(job).meta.execution.turn, 2);
  assert.equal(f.durable(job).meta.execution.startSeq, start.seq);
  f.answer(job);
  await f.finish(job);
  assert.equal(f.durable(job).status, 'done');
});

for (const kind of ['review', 'revision', 'chat']) {
  test(`${kind} retry preserves business metadata without reusing the prior execution`, async (t) => {
    const f = await fixture(t);
    const original = f.start({ kind, messageKind: kind, meta: { reviewOf: 'target', taskId: 'task', instructions: 'please review' } });
    await tick();
    f.bind(original, 1);
    f.answer(original, '结论：通过');
    await f.finish(original);
    const previous = f.durable(original);
    const retried = f.engine.retryMessage(original.placeholderId);
    assert.equal(f.message(retried).meta.execution.sessionId, null);
    assert.equal(f.message(retried).meta.execution.endSeq, null);
    assert.notEqual(f.message(retried).meta.execution.jobId, previous.meta.execution.jobId);
    await tick();
    f.bind(retried, 2);
    f.answer(retried, '结论：通过');
    await f.finish(retried);
    const stored = f.durable(retried);
    assert.equal(stored.meta.retryOf, original.placeholderId);
    assert.equal(stored.meta.taskId, 'task');
    assert.equal(stored.meta.instructions, 'please review');
    assert.equal(stored.meta.reviewOf, 'target');
    assert.equal(stored.meta.execution.jobId, retried.jobId);
    assert.equal(stored.meta.execution.turn, 2);
    assert.notEqual(stored.meta.execution.inputMessageId, previous.meta.execution.inputMessageId);
    assert.deepEqual(f.durable(original), previous);
  });
}

for (const phase of ['session', 'input']) {
  test(`failed ${phase} reference persistence never calls followup`, async (t) => {
    const f = await fixture(t);
    let failed = false;
    f.storage.failPut = (table, message) => {
      const execution = message.meta?.execution;
      if (table !== 'messages' || failed || !execution?.sessionId) return false;
      if (phase === 'input' && !execution.inputMessageId) return false;
      failed = true;
      return true;
    };
    const job = f.start();
    await job.done;
    await f.storage.flush();
    assert.equal(failed, true);
    assert.equal(f.submissions.length, 0);
    assert.equal(f.durable(job).status, 'error');
    assert.match(f.durable(job).error, /disk write failed/);
  });
}

test('submission awaits durable input identity and a stop during that write prevents followup', async (t) => {
  const f = await fixture(t);
  const entered = deferred();
  const release = deferred();
  f.storage.beforePut = async (table, message) => {
    if (table === 'messages' && message.meta?.execution?.inputMessageId) {
      entered.resolve();
      await release.promise;
    }
  };
  const job = f.start();
  await entered.promise;
  assert.equal(f.submissions.length, 0);
  assert.equal(f.durable(job).meta.execution.inputMessageId, null);
  f.engine.abortJob(job, 'stop');
  release.resolve();
  await tick();
  await f.storage.flush();
  assert.equal(f.submissions.length, 0);
  assert.equal(f.durable(job).status, 'stopped');
  assert.ok(f.durable(job).meta.execution.inputMessageId);
  assert.equal(f.durable(job).meta.execution.turn, null);
});

test('live metadata and tool/PTC/approval/retry invalidations preserve streamed reply text', async (t) => {
  const f = await fixture(t);
  const job = f.start();
  await tick();
  assert.ok(f.frames.some((frame) => frame.type === 'execution.updated' && frame.execution?.inputMessageId));
  const start = f.bind(job, 1);
  await f.storage.flush();
  assert.ok(f.frames.some((frame) => frame.type === 'execution.updated' && frame.execution?.startSeq === start.seq));
  f.stream('a', { type: 'start', turn: 1, step: 1, attemptId: 'request-1', revision: 1 });
  f.stream('a', { type: 'chunk', attemptId: 'request-1', revision: 2, chunk: { type: 'text-delta', text: 'streamed text' } });
  const messageWrites = () => f.storage.writes.filter((entry) => entry.table === 'messages' && entry.key === job.placeholderId).length;
  const before = messageWrites();
  const dataByType = [
    ['tool/call', { turn: 1, step: 1, callId: 'root', name: 'run_code', arguments: '{}' }],
    ['tool/ptc-dispatch-start', { rootCallId: 'root', parentCallId: 'root', subCallId: 'child', name: 'read', arguments: { file_path: 'a' } }],
    ['tool/ptc-dispatch', { rootCallId: 'root', parentCallId: 'root', subCallId: 'child', name: 'read', arguments: { file_path: 'a' }, result: 'x'.repeat(100000) }],
    ['tool/result', { turn: 1, step: 1, message: { toolCallId: 'root', content: [{ type: 'text', text: 'x'.repeat(100000) }] } }],
    ['approval/asked', { id: 'approval', toolName: 'bash', reason: 'needed' }],
    ['approval/decided', { id: 'approval', outcome: 'allowed' }],
    ['llm/retry', { turn: 1, step: 1, retryId: 'retry', retry: 1 }],
    ['llm/retry-started', { turn: 1, step: 1, retryId: 'retry', retry: 1 }],
  ];
  for (const [type, data] of dataByType) {
    const event = f.event('a', type, data);
    const update = f.frames.findLast((frame) => frame.type === 'execution.updated');
    assert.deepEqual(update, { groupId: 'group', type: 'execution.updated', messageId: job.placeholderId, sessionId: job.execution.sessionId, seq: event.seq });
  }
  assert.equal(messageWrites(), before, 'ordinary events only invalidate; no repeated reply persistence');
  assert.equal(f.frames.filter((frame) => frame.type === 'message.updated' && frame.message.messageId === job.placeholderId).length, 0);
  assert.equal(f.frames.findLast((frame) => frame.type === 'message.delta').chunk, 'streamed text');
  const approval = f.repo.messagesOf('group').find((message) => message.kind === 'approval');
  assert.equal(approval.meta.approvalState, 'allowed');
  const unrelatedCount = f.frames.length;
  f.event('a', 'tool/call', { turn: 9, step: 1, callId: 'unrelated' });
  f.event('a', 'user/message', { id: 'another-input' });
  assert.equal(f.frames.length, unrelatedCount);
  f.answer(job, 'final text');
  await f.finish(job);
  assert.equal(f.durable(job).text, 'final text');
  assert.equal(f.durable(job).usage.outputTokens, 10);
});

for (const cause of ['stop', 'timeout', 'dispose']) {
  test(`${cause} persists partial references and ignores a late end`, async (t) => {
    const f = await fixture(t);
    const job = f.start();
    await tick();
    const start = f.bind(job, 1);
    f.stream('a', { type: 'start', turn: 1, step: 1, attemptId: 'request', revision: 1 });
    f.stream('a', { type: 'chunk', attemptId: 'request', chunk: { type: 'text-delta', text: 'partial' } });
    f.engine.abortJob(job, cause);
    await f.storage.flush();
    const stored = f.durable(job);
    assert.equal(stored.status, 'stopped');
    assert.equal(stored.text, 'partial');
    assert.equal(stored.meta.execution.startSeq, start.seq);
    assert.equal(stored.meta.execution.endSeq, null);
    assert.equal(f.agent().cancelled, 1);
    f.event('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    await f.storage.flush();
    assert.deepEqual(f.durable(job), stored);
    const reopened = await openRepository(f.ctx);
    assert.deepEqual(reopened.getMessage(job.placeholderId).meta.execution, stored.meta.execution);
  });
}

test('restart preserves an interrupted reply identity and accepted start boundary', async (t) => {
  const f = await fixture(t);
  const job = f.start();
  await tick();
  const start = f.bind(job, 7);
  await f.storage.flush();
  const previous = f.durable(job).meta.execution;
  const reopened = await openRepository(f.ctx);
  await f.storage.flush();
  const recovered = reopened.getMessage(job.placeholderId);
  assert.equal(recovered.status, 'error');
  assert.match(recovered.error, /重启/);
  assert.deepEqual(recovered.meta.execution, previous);
  assert.equal(recovered.meta.execution.startSeq, start.seq);
  assert.equal(recovered.meta.execution.endSeq, null);
});

test('ensured session reference survives restart while persona refresh is still pending', async (t) => {
  const refresh = deferred();
  const f = await fixture(t, { refresh: () => refresh.promise });
  const job = f.start();
  await tick();
  const reopened = await openRepository(f.ctx);
  assert.deepEqual(reopened.getMessage(job.placeholderId).meta.execution, {
    version: 1, jobId: job.jobId, sessionId: f.agent().id, inputMessageId: null, turn: null, startSeq: null, endSeq: null,
  });
  f.engine.abortJob(job, 'stop');
  refresh.resolve();
  await tick();
  assert.equal(f.submissions.length, 0);
});

test('timeout while waiting for an inbox claim retains the submitted identity', { timeout: 2000 }, async (t) => {
  const f = await fixture(t, { config: { turnTimeoutMs: 30 } });
  const job = f.start();
  await job.done;
  await f.storage.flush();
  const stored = f.durable(job);
  assert.equal(f.submissions.length, 1);
  assert.equal(stored.status, 'stopped');
  assert.match(stored.error, /超时/);
  assert.equal(stored.meta.execution.sessionId, f.agent().id);
  assert.equal(stored.meta.execution.inputMessageId, f.input(job).id);
  assert.equal(stored.meta.execution.turn, null);
  assert.equal(stored.meta.execution.startSeq, null);
  assert.equal(stored.meta.execution.endSeq, null);
});

test('fallback adapters without seq bind only an exact user input and leave boundaries unknown', async (t) => {
  const f = await fixture(t);
  const job = f.start();
  await tick();
  const event = (type, data) => f.engine.onSessionEvent(f.agent().session, { type, data });
  event('turn/start', { turn: 1 });
  event('user/message', { id: 'unrelated' });
  assert.equal(job.turn, null);
  event('user/message', f.input(job));
  assert.equal(job.turn, 1);
  event('turn/end', { turn: 1, reason: { kind: 'completed' } });
  await f.storage.flush();
  assert.equal(f.durable(job).status, 'done');
  assert.equal(f.durable(job).meta.execution.startSeq, null);
  assert.equal(f.durable(job).meta.execution.endSeq, null);
});

test('an accepted aborted turn records its exact end sequence', async (t) => {
  const f = await fixture(t);
  const job = f.start();
  await tick();
  f.bind(job, 1);
  const end = await f.finish(job, { kind: 'aborted', reason: { kind: 'user' } });
  assert.equal(f.durable(job).status, 'stopped');
  assert.equal(f.durable(job).meta.execution.endSeq, end.seq);
});

for (const scenario of [
  { name: 'completed', status: 'done', error: null, reason: { kind: 'completed' } },
  { name: 'aborted', status: 'stopped', error: '已停止', reason: { kind: 'aborted', reason: { kind: 'user' } } },
  { name: 'failed', status: 'error', error: 'model failed', reason: { kind: 'error', error: { message: 'model failed' } } },
  { name: 'stopped before an end event', status: 'stopped', error: '已停止' },
]) {
  test(`terminal execution notification exposes ${scenario.name} repository state after message.updated`, async (t) => {
    const f = await fixture(t);
    const job = f.start();
    await tick();
    f.bind(job, 1);
    await f.storage.flush();
    const observed = [];
    const seenSeqs = new Set();
    const emit = f.engine.bus.emit;
    f.engine.bus.emit = (groupId, frame) => {
      emit(groupId, frame);
      if (frame.type !== 'execution.updated' || frame.messageId !== job.placeholderId) return;
      // An open execution panel ignores message.updated and deduplicates accepted
      // event sequences. Read the repository immediately on each invalidation.
      if (frame.seq !== null && seenSeqs.has(frame.seq)) return;
      if (frame.seq !== null) seenSeqs.add(frame.seq);
      const message = f.repo.getMessage(frame.messageId);
      observed.push({
        frame: structuredClone(frame),
        status: message.status,
        error: message.error,
        previousFrame: f.frames.at(-2),
      });
    };
    let endSeq = null;
    if (scenario.reason) {
      const end = await f.finish(job, scenario.reason);
      endSeq = end.seq;
      const early = observed.find((update) => update.frame.seq === end.seq);
      assert.equal(early.frame.execution.endSeq, end.seq);
      assert.equal(early.status, 'pending', 'the accepted end invalidation precedes finalization');
    } else {
      f.engine.abortJob(job, 'stop');
      await f.storage.flush();
    }
    const final = observed.at(-1);
    assert.ok(final, 'finalization must notify the open execution panel');
    assert.equal(final.frame.seq, null, 'final state must bypass accepted event sequence deduplication');
    assert.equal(final.frame.execution.endSeq, endSeq);
    assert.equal(final.status, scenario.status);
    assert.equal(final.error, scenario.error);
    assert.equal(final.previousFrame.type, 'message.updated');
    assert.equal(final.previousFrame.message.messageId, job.placeholderId);
    assert.deepEqual(final.frame.execution, f.durable(job).meta.execution);
  });
}

test('a failed boundary write errors the reply and cancels the active agent', async (t) => {
  const f = await fixture(t);
  const job = f.start();
  await tick();
  let failed = false;
  f.storage.failPut = (table, message) => {
    if (table !== 'messages' || !message.meta?.execution?.turn || failed) return false;
    failed = true;
    return true;
  };
  f.bind(job, 1);
  await job.done;
  await f.storage.flush();
  assert.equal(f.durable(job).status, 'error');
  assert.match(f.durable(job).error, /disk write failed/);
  assert.equal(f.agent().cancelled, 1);
});

test('a stopped job stays pending for workspace switching until asynchronous preparation settles', async (t) => {
  const preparing = deferred();
  const release = deferred();
  const f = await fixture(t);
  f.pool.ensure = async () => { preparing.resolve(); await release.promise; return f.agent(); };
  f.start();
  await preparing.promise;
  f.engine.stopGroup('group');
  assert.equal(f.engine.isRunning('group'), false);
  assert.equal(f.engine.hasPendingWork('group'), true);
  release.resolve();
  await tick();
  assert.equal(f.engine.hasPendingWork('group'), false);
  assert.equal(f.submissions.length, 0);
});

test('workspace session rotation seeds the new turn from earlier durable group messages', async (t) => {
  const f = await fixture(t);
  const old = f.engine.postHumanMessage({ groupId: 'group', text: 'Earlier project requirement', mentions: [] }).message;
  f.repo.getMember('a').lastSeenSeq = old.seq;
  f.pool.ensure = async () => {
    const member = f.repo.getMember('a');
    member.sessionId = f.agent().id;
    member.lastSeenSeq = 0;
    await f.repo.putMember(member);
    return f.agent();
  };
  const sent = f.engine.postHumanMessage({ groupId: 'group', text: 'Continue in the imported project', mentions: ['a'] });
  const job = f.engine.running.get('a');
  await tick();
  assert.ok(job.context.some((message) => message.messageId === old.messageId));
  assert.ok(job.context.some((message) => message.messageId === sent.message.messageId));
  assert.equal(f.repo.getMember('a').lastSeenSeq, sent.message.seq);
  f.engine.stopGroup('group');
});
