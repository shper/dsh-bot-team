import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../host/engine.js';
import { resolveConfig } from '../host/util.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

// Model the repository's immediate in-memory update and serialized, detached
// writes independently, so tests can hold the real durability boundary open.
function memoryRepository() {
  const groups = new Map([['group', { groupId: 'group', title: 'Group', nextSeq: 0 }]]);
  const bots = new Map();
  const members = new Map();
  const messages = new Map();
  const committed = new Map();
  const writes = [];
  let tail = Promise.resolve();
  const storage = {
    committed, writes, beforePut: null,
    async flush() {
      for (let count = 0; count < 50; count += 1) {
        const pending = tail;
        await pending;
        await tick();
        if (pending === tail) return;
      }
      assert.fail('Repository writes did not settle');
    },
  };
  function save(message) {
    const snapshot = structuredClone(message);
    writes.push(snapshot);
    const operation = tail.then(async () => {
      await storage.beforePut?.(snapshot);
      committed.set(snapshot.messageId, snapshot);
    });
    tail = operation.catch(() => {});
    return operation;
  }
  const repo = {
    groups, bots, members, messages,
    getGroup: (id) => groups.get(id),
    getBot: (id) => bots.get(id),
    getMember: (id) => members.get(id),
    getMessage: (id) => messages.get(id),
    allGroups: () => [...groups.values()],
    allBots: () => [...bots.values()],
    membersOf: (id) => [...members.values()].filter((member) => member.groupId === id),
    messagesOf: (id) => [...messages.values()].filter((message) => message.groupId === id).sort((a, b) => a.seq - b.seq),
    messagesBetween(id, from, to) { return repo.messagesOf(id).filter((message) => message.seq > from && message.seq <= to); },
    lastMessageOf(id) { return repo.messagesOf(id).at(-1); },
    allocateSeq(id) { const group = groups.get(id); assert.ok(group); return ++group.nextSeq; },
    appendMessage(message) { messages.set(message.messageId, message); return save(message); },
    putMessage(message) { return repo.putMessageStrict(message).catch(() => {}); },
    putMessageStrict(message) { messages.set(message.messageId, message); return save(message); },
    touchMember(member) { members.set(member.membershipId, member); },
    discussionsOf: () => [],
    activeDiscussionOf: () => undefined,
  };
  return { repo, storage };
}

function fixture(t, options = {}) {
  const { repo, storage } = memoryRepository();
  const agents = new Map();
  const goals = new Map();
  const handlers = new Map();
  const frames = [];
  const submissions = [];
  const ensures = [];
  const accesses = [];
  const inspections = [];
  const completions = [];
  const gates = [];
  const ctx = {
    agents: {
      get(id) { accesses.push(id); return agents.get(id); },
      list() { return [...agents.values()]; },
      restore() { assert.fail('Native observation/recovery must not restore an Agent'); },
      create() { assert.fail('Native observation/recovery must not create an Agent'); },
    },
    sessionController: {
      async inspect(id) {
        inspections.push(id);
        const agent = agents.get(id);
        assert.ok(agent, 'Recovery must only inspect an already-live mapped Agent');
        return { meta: { header: agent.session.header }, events: agent.session.snapshotEvents() };
      },
      restore() { assert.fail('Recovery must not restore cold sessions'); },
    },
    get(name) {
      if (name === 'sessionController') return ctx.sessionController;
      if (name === 'goals') return { get: (agent) => goals.get(agent.id) };
      if (name === 'agents') return ctx.agents;
      return undefined;
    },
    on(type, handler) {
      const registered = handlers.get(type) ?? new Set();
      registered.add(handler); handlers.set(type, registered);
      return () => registered.delete(handler);
    },
  };
  for (const id of ['a', 'b', 'cold']) {
    repo.bots.set('bot-' + id, { botId: 'bot-' + id, name: 'Bot ' + id, provider: 'mock', model: 'mock' });
    repo.members.set(id, { membershipId: id, groupId: 'group', botId: 'bot-' + id, sessionId: 'session-' + id, lastSeenSeq: 0, enabled: true });
    if (id === 'cold') continue;
    const session = {
      id: 'session-' + id, header: { id: 'session-' + id, ...(options.background ? { origin: 'subagent' } : {}) }, seq: 0, events: [],
      snapshotEvents() { return structuredClone(this.events); },
    };
    const agent = {
      id: session.id, session, cancelled: 0,
      cancel() { this.cancelled += 1; },
      async followup(input) { submissions.push({ agentId: this.id, input: structuredClone(input) }); },
    };
    agents.set(agent.id, agent);
  }
  let claimHandler;
  const pool = {
    ready: Promise.resolve(),
    owns: agent => options.owned === true && agents.get(agent.id) === agent,
    entries: new Map([...agents].map(([id, agent]) => [id.slice('session-'.length), agent])),
    sessionIdOf: (member) => member.sessionId,
    memberForSession: (id) => [...repo.members.values()].find((member) => member.sessionId === id),
    async ensure(id) { ensures.push(id); const member = repo.getMember(id); assert.ok(member); const agent = agents.get(member.sessionId); assert.ok(agent, 'Fixture only submits already-live agents'); return agent; },
    async submit(agent, input) {
      const saved = [...storage.committed.values()].find((message) => message.meta?.execution?.inputMessageId === input.id);
      assert.ok(saved, 'The exact input identity must be committed before submission');
      assert.equal(saved.meta.execution.sessionId, agent.id);
      await agent.followup(input);
    },
    attachClaimHandler(handler) { claimHandler = handler; return () => { claimHandler = undefined; }; },
  };
  const engine = new Engine({
    ctx, repo, pool, config: resolveConfig(options.config ?? {}),
    personas: { async refresh() {} },
    logger: { warn() {} },
    bus: { emit(groupId, frame) { frames.push({ groupId, ...structuredClone(frame) }); } },
    taskHook(job, message, status) { completions.push({ jobId: job.jobId, messageId: message?.messageId, status }); },
  });
  engine.buildPrompt = () => 'Native test request';
  const f = {
    engine, repo, storage, agents, goals, handlers, ctx, pool, frames, submissions, ensures, accesses, inspections, completions,
    agent: (member = 'a') => agents.get('session-' + member),
    replies: () => repo.messagesOf('group').filter((message) => message.author.type === 'bot'),
    message: (job) => repo.getMessage(job.placeholderId),
    async flush() { await tick(); await storage.flush(); },
    post(params = {}) { return engine.postHumanMessage({ groupId: 'group', text: 'Human request', mentions: ['a'], ...params }); },
    enqueue(member = 'a') { return engine.enqueueJob({ groupId: 'group', membershipId: member, triggerSeq: repo.lastMessageOf('group')?.seq ?? 0, triggerMessageId: null, kind: 'chat' }); },
    event(member, type, data) {
      const session = f.agent(member).session;
      const event = { seq: session.seq++, time: 1700000000000 + session.seq, type, data };
      session.events.push(structuredClone(event));
      for (const handler of handlers.get('session/event') ?? []) handler(session, event);
      return event;
    },
    stream(member, frame) { engine.onAssistantStream({ agent: f.agent(member), frame }); },
    claim(member, input, turn) { claimHandler?.({ agent: f.agent(member), message: input, turn }); },
    setGoal(member, value) {
      goals.set(f.agent(member).id, value);
      for (const handler of handlers.get('goal/activation-changed') ?? []) handler({ sessionId: f.agent(member).id });
    },
    begin(member, turn, input = { role: 'user', id: 'native-input-' + turn, source: { kind: 'user' }, content: [{ type: 'text', text: 'Native request ' + turn }] }) {
      const start = f.event(member, 'turn/start', { turn });
      f.event(member, 'user/message', input);
      return { start, input, job: engine.activeBySession.get(f.agent(member).id) };
    },
    answer(member, turn, text) { return f.event(member, 'assistant/message', { turn, step: 1, message: { id: 'answer-' + turn, role: 'assistant', content: [{ type: 'text', text }] } }); },
    end(member, turn, reason = { kind: 'completed' }) { return f.event(member, 'turn/end', { turn, reason }); },
    seed(member, rows) {
      const session = f.agent(member).session;
      session.events = rows.map((event, seq) => ({ seq, time: 1700000000000 + seq, ...event }));
      session.seq = session.events.length;
      return session.events;
    },
    holdEndWrite(turn) {
      const reached = deferred(); const release = deferred(); let held = false;
      gates.push(release);
      storage.beforePut = async (message) => {
        if (!held && message.meta?.execution?.turn === turn && message.meta.execution.endSeq !== null) {
          held = true; reached.resolve(); await release.promise;
        }
      };
      return { reached: reached.promise, release: release.resolve };
    },
  };
  t.after(async () => {
    for (const gate of gates) gate.resolve();
    if (!engine.disposed) await engine.dispose();
    await storage.flush();
  });
  return f;
}

const replayRows = (turn = 1, text = 'Recovered answer', ended = false) => [
  { type: 'turn/start', data: { turn } },
  { type: 'user/message', data: { id: 'native-input-' + turn, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Native request' }] } },
  { type: 'assistant/message', data: { turn, step: 1, message: { id: 'answer-' + turn, role: 'assistant', content: [{ type: 'text', text }] } } },
  ...(ended ? [{ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }] : []),
];

function savedReply(f, id, execution, text = '') {
  const message = {
    messageId: id, groupId: 'group', seq: f.repo.allocateSeq('group'),
    author: { type: 'bot', membershipId: 'a', botId: 'bot-a', name: 'Bot a' },
    text, status: execution.endSeq === null ? 'pending' : 'done', kind: 'chat',
    meta: { nativeSession: true, execution: { version: 1, jobId: 'saved-job-' + id, sessionId: 'session-a', ...execution } },
    createdAt: 1, updatedAt: 1,
  };
  f.repo.appendMessage(message);
  return message;
}

test('default zero timeout keeps an active native-backed job running until its actual turn ends', async (t) => {
  const f = fixture(t);
  assert.equal(f.engine.config.turnTimeoutMs, 0);
  const job = f.enqueue();
  await f.flush();
  await new Promise((resolve) => setTimeout(resolve, 12));
  assert.equal(job.state, 'running');
  assert.equal(job.finished, false);
  assert.equal(job.timer, undefined);
  assert.equal(f.agent().cancelled, 0);
  const input = f.submissions[0].input;
  f.begin('a', 1, input);
  f.answer('a', 1, 'Completed normally');
  f.end('a', 1);
  await job.done;
  await f.flush();
  assert.equal(job.state, 'done');
  assert.equal(f.message(job).text, 'Completed normally');
});

test('UI posts carry a human source while relay posts retain bot-team job provenance', async (t) => {
  for (const humanInput of [undefined, false]) {
    const f = fixture(t);
    const posted = f.post(humanInput === undefined ? {} : { humanInput });
    await f.flush();
    const job = f.engine.running.get('a');
    const input = f.submissions[0].input;
    assert.deepEqual(posted.accepted, ['a']);
    assert.deepEqual(input.source, humanInput === false ? { kind: 'bot-team', groupId: 'group', jobId: job.jobId } : { kind: 'user' });
    assert.equal(f.message(job).replyTo, posted.message.messageId);
    assert.equal(f.message(job).meta.execution.inputMessageId, input.id);
    f.begin('a', 1, input); f.answer('a', 1, 'Reply'); f.end('a', 1);
    await job.done;
  }
});

test('a mapped external native turn creates one group reply with exact input and seq boundaries', async (t) => {
  const f = fixture(t);
  const { start, input, job } = f.begin('a', 7);
  assert.ok(job);
  f.answer('a', 7, 'Native window answer');
  const end = f.end('a', 7);
  await job.done;
  await f.flush();
  assert.equal(f.replies().length, 1);
  const message = f.replies()[0];
  assert.equal(message.author.membershipId, 'a');
  assert.equal(message.text, 'Native window answer');
  assert.equal(message.status, 'done');
  assert.equal(message.meta.nativeSession, true);
  assert.deepEqual({ sessionId: message.meta.execution.sessionId, inputMessageId: message.meta.execution.inputMessageId, turn: message.meta.execution.turn, startSeq: message.meta.execution.startSeq, endSeq: message.meta.execution.endSeq }, { sessionId: 'session-a', inputMessageId: input.id, turn: 7, startSeq: start.seq, endSeq: end.seq });
  assert.deepEqual(f.ensures, []);
  assert.deepEqual(f.submissions, []);
});

test('unmapped sessions and events without an owning native turn are never collected into a group', async (t) => {
  const f = fixture(t);
  const outsider = { id: 'outside-session', seq: 3 };
  for (const event of [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', data: { id: 'outside-input', source: { kind: 'user' } } },
    { seq: 2, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'Foreign output' }] } } },
  ]) f.engine.onSessionEvent(outsider, event);
  f.event('a', 'assistant/message', { turn: 3, message: { content: [{ type: 'text', text: 'No turn/start' }] } });
  await f.flush();
  assert.deepEqual(f.replies(), []);
  assert.equal(f.engine.runningCount('group'), 0);
  assert.deepEqual(f.frames, []);
  assert.deepEqual(f.ensures, []);
});

test('armed goals retain the running slot and create a separate reply and exact execution for each continuation', async (t) => {
  const f = fixture(t, { config: { maxParallelTurns: 1 } });
  f.setGoal('a', { phase: 'active', activation: 'armed' });
  const { start: firstStart, input: firstInput, job } = f.begin('a', 1);
  const firstId = job.placeholderId;
  f.answer('a', 1, 'First answer');
  const firstEnd = f.end('a', 1);
  const queued = f.enqueue('b');
  let resolved = false; job.done.then(() => { resolved = true; });
  await f.flush();
  assert.equal(job.state, 'running');
  assert.equal(job.awaitingContinuation, true);
  assert.equal(resolved, false);
  assert.equal(f.engine.running.get('a'), job);
  assert.equal(f.engine.queue.includes(queued), true);
  assert.deepEqual(f.submissions, []);
  const first = structuredClone(f.repo.getMessage(firstId));
  assert.equal(first.status, 'done');
  assert.equal(first.meta.execution.startSeq, firstStart.seq);
  assert.equal(first.meta.execution.endSeq, firstEnd.seq);
  assert.equal(first.meta.execution.inputMessageId, firstInput.id);
  const { start: secondStart, input: secondInput } = f.begin('a', 2);
  const secondId = job.placeholderId;
  f.answer('a', 2, 'Second answer');
  const secondEnd = f.end('a', 2);
  await f.flush();
  assert.notEqual(secondId, firstId);
  const second = f.repo.getMessage(secondId);
  assert.equal(second.replyTo, firstId);
  assert.equal(second.text, 'Second answer');
  assert.equal(second.meta.execution.startSeq, secondStart.seq);
  assert.equal(second.meta.execution.endSeq, secondEnd.seq);
  assert.equal(second.meta.execution.inputMessageId, secondInput.id);
  assert.notEqual(secondInput.id, firstInput.id);
  assert.deepEqual(f.repo.getMessage(firstId), first, 'later turns never expand or overwrite the first reply');
  assert.equal(f.engine.queue.includes(queued), true);
  assert.equal(f.completions.length, 0);
});

test('goal completion after a completed turn settles the logical job once and releases queued work', async (t) => {
  const f = fixture(t, { config: { maxParallelTurns: 1 } });
  f.setGoal('a', { phase: 'active', activation: 'armed' });
  const { job } = f.begin('a', 1);
  f.answer('a', 1, 'Goal delivery'); f.end('a', 1);
  const queued = f.enqueue('b');
  await f.flush();
  assert.equal(job.awaitingContinuation, true);
  f.setGoal('a', { phase: 'complete', activation: 'disarmed' });
  await job.done;
  await f.flush();
  assert.equal(job.state, 'done');
  assert.equal(f.message(job).text, 'Goal delivery');
  assert.equal(f.engine.activeBySession.has('session-a'), false);
  assert.equal(f.engine.running.get('b'), queued);
  assert.equal(f.submissions.length, 1);
  assert.equal(f.submissions[0].agentId, 'session-b');
  assert.deepEqual(f.completions, [{ jobId: job.jobId, messageId: job.placeholderId, status: 'done' }]);
  f.setGoal('a', { phase: 'complete', activation: 'disarmed' });
  await tick();
  assert.equal(f.completions.length, 1);
});

test('blocked, paused, and disarmed goals finish a waiting continuation with the appropriate state', async (t) => {
  for (const [goal, status, error] of [
    [{ phase: 'blocked', activation: 'disarmed', blockedReason: { message: 'Waiting for credentials' } }, 'error', 'Waiting for credentials'],
    [{ phase: 'paused', activation: 'disarmed' }, 'stopped', '原生目标已暂停'],
    [{ phase: 'active', activation: 'disarmed' }, 'stopped', '原生目标已暂停'],
  ]) {
    const f = fixture(t);
    f.setGoal('a', { phase: 'active', activation: 'armed' });
    const { job } = f.begin('a', 1);
    f.answer('a', 1, 'Progress'); f.end('a', 1);
    await f.flush();
    f.setGoal('a', goal);
    await job.done;
    await f.flush();
    assert.equal(job.state, status);
    assert.equal(f.message(job).status, status);
    assert.equal(f.message(job).error, error);
    assert.equal(f.engine.runningCount('group'), 0);
    assert.equal(f.agent().cancelled, 0, 'a completed native turn is not cancelled while classifying its goal');
  }
});

test('events and streaming deltas for a following turn survive blocked end persistence without crossing reply boundaries', async (t) => {
  const f = fixture(t);
  const { job, start: firstStart } = f.begin('a', 1);
  f.answer('a', 1, 'First answer');
  await f.flush();
  const firstId = job.placeholderId;
  const gate = f.holdEndWrite(1);
  const firstEnd = f.end('a', 1);
  await gate.reached;
  const { start: secondStart, input: secondInput } = f.begin('a', 2);
  f.stream('a', { type: 'start', turn: 2, step: 1, attemptId: 'attempt-two' });
  f.stream('a', { type: 'chunk', turn: 2, attemptId: 'attempt-two', chunk: { type: 'text-delta', text: 'Second streamed' } });
  f.answer('a', 2, 'Second final answer');
  const secondEnd = f.end('a', 2);
  assert.equal(job.placeholderId, firstId);
  assert.equal(job.ending, true);
  assert.equal(f.replies().length, 1);
  assert.equal(f.frames.some((frame) => frame.messageId === firstId && frame.chunk === 'Second streamed'), false);
  assert.equal(storageEnd(f, firstId), null, 'first turn end is not yet durable');
  gate.release();
  await job.done;
  await f.flush();
  const replies = f.replies();
  assert.equal(replies.length, 2);
  const [first, second] = replies;
  assert.equal(first.text, 'First answer');
  assert.equal(second.text, 'Second final answer');
  assert.deepEqual([first.meta.execution.startSeq, first.meta.execution.endSeq], [firstStart.seq, firstEnd.seq]);
  assert.deepEqual([second.meta.execution.startSeq, second.meta.execution.endSeq], [secondStart.seq, secondEnd.seq]);
  assert.equal(second.meta.execution.inputMessageId, secondInput.id);
  assert.ok(f.frames.some((frame) => frame.type === 'message.delta' && frame.messageId === second.messageId && frame.chunk === 'Second streamed'));
  assert.equal(f.frames.some((frame) => frame.messageId === first.messageId && String(frame.text ?? frame.chunk ?? '').includes('Second')), false);
  assert.equal(job.state, 'done');
});

function storageEnd(f, id) { return f.storage.committed.get(id)?.meta?.execution?.endSeq; }

test('disposing the plugin detaches native observation without cancelling the underlying Agent', async (t) => {
  const f = fixture(t);
  f.setGoal('a', { phase: 'active', activation: 'armed' });
  const { job } = f.begin('a', 1);
  f.answer('a', 1, 'Work in progress');
  await f.flush();
  await f.engine.dispose();
  assert.equal(f.agent().cancelled, 0);
  assert.equal(f.agents.get('session-a'), f.agent());
  assert.deepEqual(f.goals.get('session-a'), { phase: 'active', activation: 'armed' });
  assert.equal(f.handlers.get('session/event').size, 0);
  assert.equal(f.handlers.get('goal/activation-changed').size, 0);
  const count = f.frames.length;
  f.event('a', 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'Still running natively' }] } });
  assert.equal(f.frames.length, count);
  assert.equal(f.message(job).meta.execution.endSeq, null, 'unloading never fabricates a native end boundary');
});

test('recovery observes only live mapped sessions and replays unfinished native turns without cold Agent restoration', async (t) => {
  const f = fixture(t);
  const events = f.seed('a', replayRows(4, 'Recovered partial'));
  f.agents.set('outside-session', { id: 'outside-session', session: { id: 'outside-session', snapshotEvents() { assert.fail('Unmapped live sessions must not be inspected'); } } });
  assert.equal(typeof f.engine.recoverNativeSessions, 'function');
  await f.engine.recoverNativeSessions();
  await f.flush();
  const job = f.engine.running.get('a');
  assert.ok(job);
  assert.equal(f.engine.running.has('cold'), false);
  assert.equal(f.inspections.includes('session-cold'), false);
  assert.equal(f.inspections.includes('outside-session'), false);
  assert.equal(f.replies().length, 1);
  assert.equal(f.message(job).meta.execution.turn, 4);
  assert.equal(f.message(job).meta.execution.startSeq, events[0].seq);
  assert.equal(f.message(job).meta.execution.inputMessageId, 'native-input-4');
  assert.deepEqual(f.ensures, []);
  assert.deepEqual(f.submissions, []);
  f.end('a', 4);
  await job.done;
  await f.flush();
  assert.equal(f.message(job).text, 'Recovered partial');
  assert.equal(f.message(job).status, 'done');
});

test('recovery reuses the exact persisted reply and remains idempotent without overwriting another turn', async (t) => {
  const f = fixture(t);
  f.seed('a', replayRows(4, 'Recovered final text'));
  const other = savedReply(f, 'other-reply', { inputMessageId: 'different-input', turn: 3, startSeq: 20, endSeq: 25 }, 'Previous answer');
  const exact = savedReply(f, 'saved-reply', { inputMessageId: 'native-input-4', turn: 4, startSeq: 0, endSeq: null }, 'Old partial');
  await f.flush();
  const untouched = structuredClone(other);
  await f.engine.recoverNativeSessions();
  await f.engine.recoverNativeSessions();
  await f.flush();
  const job = f.engine.running.get('a');
  assert.ok(job);
  assert.equal(job.placeholderId, exact.messageId);
  assert.equal(f.replies().length, 2);
  assert.deepEqual(f.repo.getMessage(other.messageId), untouched);
  f.end('a', 4);
  await job.done;
  await f.flush();
  assert.equal(f.repo.getMessage(exact.messageId).text, 'Recovered final text');
  assert.equal(f.repo.getMessage(exact.messageId).meta.execution.inputMessageId, 'native-input-4');
  assert.deepEqual(f.ensures, []);
});

test('recovery resumes an armed goal after its last completed turn and ignores completed unarmed sessions', async (t) => {
  const f = fixture(t);
  const firstEvents = f.seed('a', replayRows(1, 'First goal answer', true));
  f.seed('b', replayRows(8, 'Completed unrelated answer', true));
  f.setGoal('a', { phase: 'active', activation: 'armed' });
  const first = savedReply(f, 'goal-reply', { inputMessageId: 'native-input-1', turn: 1, startSeq: 0, endSeq: firstEvents.at(-1).seq }, 'First goal answer');
  await f.flush();
  await f.engine.recoverNativeSessions();
  await f.flush();
  const job = f.engine.running.get('a');
  assert.ok(job);
  assert.equal(job.awaitingContinuation, true);
  assert.equal(job.placeholderId, first.messageId);
  assert.equal(f.engine.running.has('b'), false);
  assert.equal(f.replies().length, 1);
  const previous = structuredClone(f.repo.getMessage(first.messageId));
  f.begin('a', 2);
  f.answer('a', 2, 'Final goal delivery');
  f.setGoal('a', { phase: 'complete', activation: 'disarmed' });
  f.end('a', 2);
  await job.done;
  await f.flush();
  assert.equal(f.replies().length, 2);
  assert.notEqual(job.placeholderId, first.messageId);
  assert.equal(f.message(job).text, 'Final goal delivery');
  assert.equal(job.state, 'done');
  assert.deepEqual(f.repo.getMessage(first.messageId), previous);
  assert.deepEqual(f.ensures, []);
  assert.deepEqual(f.submissions, []);
});

test('hidden background roots keep goal continuations and child replies in Bot Team', async t => {
  const f = fixture(t, { background: true, owned: true });
  f.setGoal('a', { phase: 'active', activation: 'armed' });
  const { job } = f.begin('a', 1);
  assert.ok(job);
  f.answer('a', 1, 'First hidden answer');
  f.end('a', 1);
  await f.flush();
  assert.equal(job.awaitingContinuation, true);
  const first = structuredClone(f.message(job));
  f.begin('a', 2);
  f.answer('a', 2, 'Child result handled');
  f.setGoal('a', { phase: 'complete', activation: 'disarmed' });
  f.end('a', 2);
  await job.done;
  assert.equal(f.replies().length, 2);
  assert.equal(f.message(job).text, 'Child result handled');
  assert.deepEqual(f.repo.getMessage(first.messageId), first);
  assert.deepEqual(f.ensures, []);
});

test('hidden recovery reads the live log without an ordinary SessionController route', async t => {
  const f = fixture(t, { background: true });
  f.ctx.sessionController.inspect = () => assert.fail('Hidden roots cannot use ordinary Session routes');
  f.seed('a', replayRows(3, 'Preserved background output'));
  await f.engine.recoverNativeSessions();
  const job = f.engine.running.get('a');
  assert.ok(job);
  f.end('a', 3);
  await job.done;
  assert.equal(f.message(job).text, 'Preserved background output');
  assert.deepEqual(f.submissions, []);
});

test('plugin disposal cancels only a Bot root whose handle it owns', async t => {
  const f = fixture(t, { background: true, owned: true });
  const { job } = f.begin('a', 1);
  f.answer('a', 1, 'Partial background output');
  await f.engine.dispose();
  assert.equal(f.agent().cancelled, 1);
  assert.equal(f.message(job).status, 'stopped');
  assert.match(f.message(job).error, /后台执行已停止/);
});
