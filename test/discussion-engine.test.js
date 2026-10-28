import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../host/engine.js';
import { resolveConfig } from '../host/util.js';
import { nativeFixture } from './agent-native-fixture.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(t, options = {}) {
  const groups = new Map([['group', { groupId: 'group', title: 'Test group', nextSeq: 0 }]]);
  const members = new Map(); const bots = new Map(); const messages = new Map(); const discussions = new Map();
  const committedMessages = new Map(); const committedDiscussions = new Map();
  const frames = []; const submissions = []; const agents = new Map(); const goals = new Map(); const ensures = [];
  const guards = []; const releases = [];
  const repo = {
    groups, members, bots, messages, discussions, committedMessages, committedDiscussions,
    getGroup: id => groups.get(id), getMember: id => members.get(id), getBot: id => bots.get(id),
    getMessage: id => messages.get(id), getDiscussion: id => discussions.get(id),
    membersOf: id => [...members.values()].filter(member => member.groupId === id),
    messagesOf: id => [...messages.values()].filter(message => message.groupId === id).sort((a, b) => a.seq - b.seq),
    discussionsOf: id => [...discussions.values()].filter(discussion => discussion.groupId === id),
    activeDiscussionOf: id => repo.discussionsOf(id).find(discussion => ['running', 'paused', 'pausing', 'finalizing', 'stopping'].includes(discussion.status)),
    messagesBetween: (id, from, to) => repo.messagesOf(id).filter(message => message.seq > from && message.seq <= to),
    lastMessageOf: id => repo.messagesOf(id).at(-1),
    allocateSeq: id => ++groups.get(id).nextSeq,
    appendMessage(message) { messages.set(message.messageId, message); committedMessages.set(message.messageId, structuredClone(message)); },
    putMessage(message) { return repo.putMessageStrict(message).catch(() => {}); },
    async putMessageStrict(message) {
      const snapshot = structuredClone(message);
      await repo.beforeMessage?.(snapshot);
      messages.set(message.messageId, message); committedMessages.set(message.messageId, snapshot);
    },
    async putDiscussion(discussion) {
      const snapshot = structuredClone(discussion);
      await repo.beforeDiscussion?.(snapshot);
      discussions.set(discussion.discussionId, snapshot); committedDiscussions.set(discussion.discussionId, structuredClone(snapshot));
    },
    touchMember(member) { members.set(member.membershipId, member); },
  };
  for (const id of ['a', 'b', 'judge']) {
    bots.set('bot-' + id, { botId: 'bot-' + id, name: 'Bot ' + id, provider: 'mock', model: 'mock' });
    members.set(id, { membershipId: id, botId: 'bot-' + id, groupId: 'group', sessionId: 'session-' + id, lastSeenSeq: 0, enabled: true });
    const session = { id: 'session-' + id, seq: 0, events: [], snapshotEvents() { return structuredClone(this.events); } };
    agents.set(session.id, { id: session.id, session, cancellations: [], cancel(reason, config) { this.cancellations.push({ reason, config }); } });
  }
  const ctx = {
    agents: { get: id => agents.get(id) }, on: () => () => {},
    get: name => name === 'goals' ? { get: agent => goals.get(agent.id) } : undefined,
  };
  const pool = {
    owns: () => true, attachClaimHandler: () => () => {},
    memberForSession: id => [...members.values()].find(member => member.sessionId === id),
    async ensure(id) { ensures.push(id); await options.ensure?.(id); return agents.get(members.get(id)?.sessionId); },
    async submit(agent, input, assertActive = () => {}) {
      await options.beforeSubmit?.(agent, input);
      assertActive();
      const message = [...committedMessages.values()].find(message => message.meta?.execution?.inputMessageId === input.id);
      assert.ok(message, 'input identity is durable before submission');
      if (message.meta.stepId) {
        const discussion = committedDiscussions.get(message.meta.discussionId);
        const step = discussion.steps.find(step => step.stepId === message.meta.stepId);
        const attempt = step.attempts.at(-1);
        assert.equal(attempt.inputMessageId, input.id);
        assert.equal(attempt.sessionId, agent.id);
        assert.equal(attempt.jobId, message.meta.execution.jobId);
        assert.ok(attempt.messageIds.includes(message.messageId));
        assert.equal(attempt.prompt, input.content[0].text);
      }
      submissions.push({ agentId: agent.id, input: structuredClone(input) });
    },
  };
  const engine = new Engine({ ctx, repo, pool, config: resolveConfig({ maxParallelTurns: 1 }),
    personas: { async refresh() {} }, logger: { warn() {} },
    bus: { emit: (groupId, frame) => frames.push({ groupId, ...structuredClone(frame) }) },
    quotaGuard: options.quota || (() => ({ ok: true })),
    discussionGuard: async record => { guards.push(record.discussionId); await options.guard?.(record); },
  });
  const f = {
    engine, repo, frames, submissions, agents, goals, ensures, guards, pool, ctx,
    async flush() { for (let i = 0; i < 8; i++) await tick(); },
    record: id => repo.getDiscussion(id),
    current: () => [...engine.running.values()].find(job => job.stepId),
    async start(extra = {}) {
      const record = await engine.startDiscussion({ groupId: 'group', topic: 'Should we proceed?', membershipIds: ['a', 'b'], rounds: 1, ...extra });
      await f.flush(); return f.record(record.discussionId);
    },
    async control(record, operation, extra = {}) {
      const result = await engine.controlDiscussion({ discussionId: record.discussionId, operation, ...extra });
      await f.flush(); return result;
    },
    async finish(text = 'Evidence and conclusion', status = 'done', job = f.current()) {
      assert.ok(job); job.steps = [text]; engine.finishJob(job, status, status === 'done' ? undefined : 'mock failure');
      await f.flush(); return job;
    },
    event(job, type, data) {
      const session = agents.get(job.sessionId).session;
      const event = { seq: session.seq++, type, data }; session.events.push(event); engine.onSessionEvent(session, event);
    },
    begin(job, turn = 1, inputId = job.execution.inputMessageId) {
      f.event(job, 'turn/start', { turn });
      f.event(job, 'user/message', { id: inputId });
    },
    end(job, turn = 1, text = 'Turn output', reason = { kind: 'completed' }) {
      f.event(job, 'assistant/message', { turn, message: { content: [{ type: 'text', text }] } });
      f.event(job, 'turn/end', { turn, reason });
    },
    gate() { const gate = deferred(); releases.push(gate.resolve); return gate; },
  };
  t.after(async () => { for (const release of releases) release(); await engine.dispose(); await f.flush(); });
  return f;
}

test('group start mutex includes persistence and request IDs are durable and idempotent', async t => {
  const f = fixture(t); const gate = f.gate(); let held = false;
  f.repo.beforeDiscussion = async record => { if (!held) { held = true; await gate.promise; } };
  const input = { groupId: 'group', topic: 'Topic', membershipIds: ['a', 'b'], rounds: 1, requestId: 'start-once' };
  const first = f.engine.startDiscussion(input); const duplicate = f.engine.startDiscussion(input);
  const conflict = f.engine.startDiscussion({ ...input, requestId: 'different' });
  const rejected = assert.rejects(conflict, { code: 'conflict' });
  await tick(); assert.equal(f.submissions.length, 0); gate.resolve();
  const [a, b] = await Promise.all([first, duplicate]); await rejected; await f.flush();
  assert.equal(a.discussionId, b.discussionId); assert.equal(f.repo.discussions.size, 1);
  assert.equal(f.submissions.length, 1); assert.equal(a.protocolVersion, 2);
  assert.deepEqual(a.steps.map(step => step.phase), ['discussion', 'discussion']);
});

test('repeated scheduling cannot dispatch before the durable claim or dispatch twice', async t => {
  const f = fixture(t); const gate = f.gate(); let held = false;
  f.repo.beforeDiscussion = async record => { if (!held && record.steps[0].status === 'running') { held = true; await gate.promise; } };
  const record = await f.engine.startDiscussion({ groupId: 'group', topic: 'Topic', membershipIds: ['a'], rounds: 1 });
  const calls = Array.from({ length: 4 }, () => f.engine.scheduleDiscussion(record.discussionId));
  await tick(); assert.equal(f.submissions.length, 0); assert.equal(f.ensures.length, 0);
  gate.resolve(); await Promise.all(calls); await f.flush();
  assert.equal(f.submissions.length, 1); assert.equal(f.record(record.discussionId).steps[0].attempts.length, 1);
});

test('pause waits for the logical job, wakes waiters, and deduplicates stale request revisions', async t => {
  const f = fixture(t); const record = await f.start();
  const wait = f.engine.whenDiscussionSettled(record.discussionId, 1000);
  const pauseInput = { expectedRevision: f.record(record.discussionId).revision, requestId: 'pause-1' };
  assert.equal((await f.control(record, 'pause', pauseInput)).status, 'pausing');
  await f.finish(); assert.equal(await wait, true);
  assert.equal(f.record(record.discussionId).status, 'paused'); assert.equal(f.submissions.length, 1);
  const replay = await f.control(record, 'pause', pauseInput);
  assert.equal(replay.status, 'paused');
  await assert.rejects(f.control(record, 'resume', { expectedRevision: pauseInput.expectedRevision, requestId: 'resume-1' }), { code: 'stale-revision' });
  await assert.rejects(f.start(), { code: 'conflict' });
  await f.control(record, 'resume'); assert.equal(f.submissions.length, 2); assert.equal(f.current().membershipId, 'b');
  await f.finish(); assert.equal(f.record(record.discussionId).status, 'done');
});

test('frozen prompts ignore later supplements; a retry gets the new supplement and a new attempt', async t => {
  const f = fixture(t); f.engine.postHumanMessage({ groupId: 'group', text: 'Unread ordinary context', mentions: [] });
  const record = await f.start(); const first = f.current(); const frozen = first.promptText;
  await f.control(record, 'add_context', { text: 'NEW_EVIDENCE' });
  assert.equal(first.promptText, frozen); assert.doesNotMatch(f.submissions[0].input.content[0].text, /NEW_EVIDENCE/);
  const wait = f.engine.whenDiscussionSettled(record.discussionId, 1000);
  await f.finish('Partial failed answer', 'error'); assert.equal(await wait, true);
  assert.equal(f.record(record.discussionId).steps[0].status, 'error');
  await f.control(record, 'retry'); const second = f.current();
  assert.equal(second.stepId, first.stepId); assert.notEqual(second.attemptId, first.attemptId);
  assert.match(second.promptText, /NEW_EVIDENCE/); assert.equal(f.record(record.discussionId).steps[0].attempts.length, 2);
  assert.equal(f.repo.getMember('a').lastSeenSeq, 0);
  await f.finish(); assert.match(f.current().promptText, /NEW_EVIDENCE/);
});

test('ordinary resume requires explicit retry for a failed step', async t => {
  const f = fixture(t); const record = await f.start(); await f.finish('failure', 'error');
  await assert.rejects(f.control(record, 'resume'), { code: 'retry-required' });
  assert.equal(f.current(), undefined); assert.equal(f.record(record.discussionId).steps[0].status, 'error');
  assert.equal(f.submissions.length, 1);
});

test('dispatch rechecks quota and membership and pauses with an error attempt', async t => {
  let budget = true; const f = fixture(t, { quota: () => ({ ok: budget, reason: 'Budget exhausted' }) });
  const record = await f.start(); budget = false; await f.finish();
  let current = f.record(record.discussionId);
  assert.equal(current.status, 'paused'); assert.equal(current.steps[1].status, 'error'); assert.equal(f.submissions.length, 1);
  budget = true; f.repo.members.delete('b'); await f.control(record, 'retry');
  current = f.record(record.discussionId);
  assert.equal(current.status, 'paused'); assert.equal(current.steps[1].attempts.length, 2);
  assert.equal(f.submissions.length, 1); assert.equal(await f.engine.whenDiscussionSettled(record.discussionId), true);
});

test('early startJob rejection marks the claimed step error and wakes discussion waiters', async t => {
  const f = fixture(t); const original = f.engine.startJob.bind(f.engine);
  f.engine.startJob = job => { f.repo.members.delete(job.membershipId); original(job); };
  const record = await f.start(); const saved = f.record(record.discussionId);
  assert.equal(saved.status, 'paused'); assert.equal(saved.steps[0].status, 'error');
  assert.equal(saved.steps[0].attempts[0].status, 'error'); assert.equal(f.submissions.length, 0);
  assert.equal(await f.engine.whenDiscussionSettled(record.discussionId), true);
});

test('final message durability gates advancement and write failure pauses the step', async t => {
  const f = fixture(t); const record = await f.start(); const gate = f.gate(); let held = false;
  f.repo.beforeMessage = async message => { if (!held && message.meta?.logicalJobComplete) { held = true; await gate.promise; } };
  const finished = f.finish(); await tick(); assert.equal(f.submissions.length, 1);
  gate.resolve(); await finished; assert.equal(f.submissions.length, 2);
  f.repo.beforeMessage = async message => { if (message.meta?.logicalJobComplete) throw new Error('storage offline'); };
  await f.finish();
  assert.equal(f.record(record.discussionId).status, 'paused'); assert.equal(f.record(record.discussionId).steps[1].status, 'error');
});

test('multi-turn native continuation retains one attempt and advances only once', async t => {
  const f = fixture(t); const record = await f.start(); const job = f.current(); const firstInput = job.execution.inputMessageId;
  f.begin(job); f.goals.set(job.sessionId, { phase: 'active', activation: 'armed' }); f.end(job, 1, 'First native turn'); await f.flush();
  assert.equal(f.submissions.length, 1); assert.equal(f.record(record.discussionId).steps[0].status, 'running');
  const firstMessage = job.placeholderId; assert.equal(f.repo.getMessage(firstMessage).meta.logicalJobComplete, false);
  f.begin(job, 2, 'native-second-input'); f.goals.set(job.sessionId, { phase: 'complete' }); f.end(job, 2, 'Second native turn'); await f.flush();
  const step = f.record(record.discussionId).steps[0];
  assert.equal(step.status, 'done'); assert.equal(step.attempts.length, 1); assert.equal(step.messageIds.length, 2);
  assert.equal(step.attempts[0].inputMessageId, firstInput); assert.ok(step.messageIds.includes(firstMessage));
  assert.equal(f.submissions.length, 2); f.engine.finishJob(job, 'done'); await f.flush(); assert.equal(f.submissions.length, 2);
});

test('finish keeps the current job then only closing and judgement; missing evidence cannot win', async t => {
  const f = fixture(t); const record = await f.start({ mode: 'debate', format: 'structured', proMembershipId: 'a', conMembershipId: 'b', judgeMembershipId: 'judge', summarize: true });
  await f.control(record, 'finish'); assert.equal(f.record(record.discussionId).status, 'finalizing');
  await f.finish('Only pro opening');
  assert.equal(f.current().meta.phase, 'closing'); await f.finish('Pro closing');
  assert.equal(f.current().meta.phase, 'closing'); await f.finish('Con closing');
  assert.equal(f.current().meta.phase, 'judgement'); assert.equal(f.current().meta.summary, true);
  await f.finish('Verdict: pro\nPro wins.');
  const saved = f.record(record.discussionId);
  assert.equal(saved.status, 'done'); assert.equal(saved.partial, true); assert.equal(saved.verdict, 'insufficient');
  assert.equal(saved.steps.find(step => step.phase === 'opening' && step.side === 'con').status, 'skipped');
});

test('cold recovery reconciles exact logical completion and never replays a completed step', async t => {
  const f = fixture(t); const record = await f.start(); await f.control(record, 'pause'); await f.finish();
  const interrupted = structuredClone(f.record(record.discussionId));
  interrupted.steps[0].status = 'running'; interrupted.steps[0].attempts[0].status = 'running'; interrupted.needsRecovery = true;
  await f.repo.putDiscussion(interrupted); await f.control(record, 'resume');
  assert.equal(f.current().membershipId, 'b'); assert.equal(f.record(record.discussionId).steps[0].status, 'done');
  assert.equal(f.record(record.discussionId).steps[0].attempts.length, 1); assert.equal(f.submissions.length, 2);
  assert.ok(f.guards.length);
});

test('recovery does not infer completion from unrelated messages or a completed native subturn', async t => {
  const f = fixture(t); const record = await f.start(); const job = f.current(); await f.control(record, 'pause'); await f.finish('unfinished', 'error');
  const interrupted = structuredClone(f.record(record.discussionId));
  interrupted.steps[0].status = 'running'; interrupted.steps[0].attempts[0].status = 'running'; interrupted.needsRecovery = true;
  const message = f.repo.getMessage(job.placeholderId); message.status = 'done'; message.meta.logicalJobComplete = false;
  await f.repo.putMessageStrict(message); await f.repo.putDiscussion(interrupted);
  await f.control(record, 'retry');
  assert.equal(f.current().membershipId, 'a'); assert.equal(f.record(record.discussionId).steps[0].attempts.length, 2);
});

test('native blockers prevent resume and stopping recovery cannot resurrect the run', async t => {
  let blocked = true;
  const f = fixture(t, { guard: () => { if (blocked) throw Object.assign(new Error('Native busy'), { code: 'native-busy' }); } });
  const record = await f.start(); await f.control(record, 'pause'); await f.finish();
  await assert.rejects(f.control(record, 'resume'), { code: 'native-busy' }); assert.equal(f.submissions.length, 1);
  blocked = false; const interrupted = structuredClone(f.record(record.discussionId)); interrupted.recoveryStatus = 'stopping'; interrupted.needsRecovery = true;
  await f.repo.putDiscussion(interrupted);
  await assert.rejects(f.control(record, 'retry'), { code: 'conflict' });
  await f.control(record, 'stop'); assert.equal(f.record(record.discussionId).status, 'stopped'); assert.equal(f.submissions.length, 1);
});

test('stop closes dispatch and preserves unrelated shared-session inbox inputs', async t => {
  const f = fixture(t); const record = await f.start(); const job = f.current(); f.begin(job); await f.flush();
  await f.control(record, 'stop'); await f.flush();
  assert.equal(f.record(record.discussionId).status, 'stopped'); assert.equal(f.submissions.length, 1);
  assert.equal(f.agents.get(job.sessionId).cancellations.length, 1);
  assert.equal(f.agents.get(job.sessionId).cancellations[0].config.keepInbox, true);
  f.end(job); await f.flush(); assert.equal(f.submissions.length, 1);
});

test('an unclaimed discussion input cannot cancel an unrelated native turn', async t => {
  const f = fixture(t); const record = await f.start(); const job = f.current();
  await f.control(record, 'stop'); assert.equal(f.agents.get(job.sessionId).cancellations.length, 0);
});

test('stopGroup drains queued work before finishJob can pump it', async t => {
  const f = fixture(t);
  f.engine.postHumanMessage({ groupId: 'group', text: 'Ordinary work', mentions: ['a', 'b'] }); await f.flush();
  assert.equal(f.submissions.length, 1); assert.equal(f.engine.queue.length, 1);
  f.engine.stopGroup('group'); await f.flush();
  assert.equal(f.submissions.length, 1); assert.equal(f.engine.queue.length, 0); assert.equal(f.engine.running.size, 0);
});

test('stopMember prevents queued re-dispatch and pauses its discussion', async t => {
  const f = fixture(t); const record = await f.start();
  f.engine.postHumanMessage({ groupId: 'group', text: 'Queued same member', mentions: ['a'] });
  f.engine.stopMember('a'); await f.flush();
  assert.equal(f.submissions.length, 1); assert.equal(f.record(record.discussionId).status, 'paused');
  assert.equal(f.record(record.discussionId).steps[0].status, 'error');
});

test('stop remains active until asynchronous native cancellation becomes idle', async t => {
  let busy = true;
  const f = fixture(t, { guard: () => { if (busy) throw Object.assign(new Error('Native descendants still running'), { code: 'native-busy' }); } });
  const record = await f.start(); const job = f.current(); f.begin(job); await f.flush();
  const stopped = await f.control(record, 'stop');
  assert.equal(stopped.status, 'stopping'); assert.match(stopped.stopPendingReason, /still running/);
  assert.equal(f.record(record.discussionId).status, 'stopping');
  await assert.rejects(f.start(), { code: 'conflict' });
  assert.equal(await f.engine.whenDiscussionSettled(record.discussionId, 5), false);
  busy = false;
  f.event(job, 'turn/end', { turn: 1, reason: { kind: 'aborted' } }); await f.flush();
  assert.equal(f.record(record.discussionId).status, 'stopped'); assert.equal(f.submissions.length, 1);
});

test('start message persistence failure leaves a paused recoverable run', async t => {
  const f = fixture(t);
  f.repo.beforeMessage = async message => { if (message.meta?.event === 'start') throw new Error('start message persistence failed'); };
  await assert.rejects(f.start(), /start message persistence failed/);
  const record = [...f.repo.discussions.values()][0];
  assert.equal(record.status, 'paused'); assert.equal(record.pauseReason, 'start-error'); assert.equal(f.submissions.length, 0);
  f.repo.beforeMessage = undefined; await f.control(record, 'resume'); assert.equal(f.submissions.length, 1);
});

test('stop withdraws only its own exact input from both native inbox lanes', async t => {
  const f = fixture(t); const record = await f.start(); const job = f.current();
  const own = structuredClone(f.submissions[0].input);
  const unrelated = { role: 'user', id: 'human-queued', source: { kind: 'user' }, content: [] };
  const inbox = { nextTurn: [unrelated, own], nextStep: [own, unrelated], splice(target, start, count, items) {
    this[target === 'next-turn' ? 'nextTurn' : 'nextStep'].splice(start, count, ...items);
  } };
  f.agents.get(job.sessionId).inbox = inbox;
  await f.control(record, 'stop');
  assert.deepEqual(inbox.nextTurn, [unrelated]); assert.deepEqual(inbox.nextStep, [unrelated]);
  assert.equal(f.agents.get(job.sessionId).cancellations.length, 0);
});

test('stopping during asynchronous submission admission prevents a late inbox input', async t => {
  const gate = deferred(); let pending = true;
  const f = fixture(t, { beforeSubmit: async () => { await gate.promise; pending = false; },
    guard: () => { if (pending) throw Object.assign(new Error('Submission in progress'), { code: 'native-busy' }); } });
  t.after(gate.resolve);
  const record = await f.start(); assert.equal(f.submissions.length, 0);
  await f.control(record, 'stop'); assert.equal(f.record(record.discussionId).status, 'stopping');
  gate.resolve(); await f.flush();
  assert.equal(f.submissions.length, 0); assert.equal(f.record(record.discussionId).status, 'stopped');
});

test('queued prompts freeze on dispatch and include supplements added before dispatch', async t => {
  const f = fixture(t);
  f.engine.postHumanMessage({ groupId: 'group', text: 'Occupy first member', mentions: ['a'] }); await f.flush();
  const ordinary = f.engine.running.get('a'); const record = await f.start();
  assert.equal(f.submissions.length, 1); assert.equal(f.engine.queue.length, 1);
  await f.control(record, 'add_context', { text: 'QUEUED_SUPPLEMENT' });
  await f.finish('Ordinary reply', 'done', ordinary);
  assert.match(f.current().promptText, /QUEUED_SUPPLEMENT/);
});

test('native recovery preserves discussion attempt identity without resubmitting its input', async t => {
  const f = fixture(t); const record = await f.start(); const job = f.current(); f.begin(job); await f.flush();
  const interrupted = structuredClone(f.record(record.discussionId)); interrupted.status = 'paused'; interrupted.needsRecovery = true;
  await f.repo.putDiscussion(interrupted);
  // Detach just the observer maps, as a process reload does, keeping the live native log.
  f.engine.running.clear(); f.engine.activeBySession.clear();
  await f.engine.recoverNativeSessions(); await f.flush();
  const recovered = f.current();
  assert.ok(recovered); assert.equal(recovered.jobId, job.jobId); assert.equal(recovered.stepId, job.stepId);
  assert.equal(recovered.attemptId, job.attemptId); assert.equal(recovered.placeholderId, job.placeholderId);
  assert.equal(f.submissions.length, 1);
  f.end(recovered, 1, 'Recovered completion'); await f.flush();
  assert.equal(f.record(record.discussionId).steps[0].status, 'done');
  assert.equal(f.record(record.discussionId).status, 'paused');
  job.resolveDone();
});

test('AgentPool rechecks a stopped logical job after its asynchronous model lookup', async t => {
  const f = await nativeFixture(t); const agent = await f.pool.ensure('mem-1');
  const gate = deferred(); const reached = deferred(); t.after(gate.resolve);
  const original = f.pool.modelFor.bind(f.pool); let stopped = false;
  f.pool.modelFor = async (...args) => { reached.resolve(); await gate.promise; return original(...args); };
  const submitted = f.pool.submit(agent, { id: 'step-input', role: 'user', source: { kind: 'bot-team', jobId: 'step-job' },
    content: [{ type: 'text', text: 'Should never be delivered' }] }, () => {
    if (stopped) throw Object.assign(new Error('Logical job stopped'), { code: 'stopped' });
  });
  const rejected = assert.rejects(submitted, { code: 'stopped' });
  await reached.promise; stopped = true; gate.resolve(); await rejected;
  assert.equal(f.calls.submissions.length, 0); assert.equal(f.pool.submitting.size, 0);
});

test('explicit finish retries failed final phases with a fresh attempt', async t => {
  const f = fixture(t); const record = await f.start({ membershipIds: ['a'], summarize: true });
  await f.finish('Initial argument'); assert.equal(f.current().meta.phase, 'summary');
  const failedAttempt = f.current().attemptId; await f.finish('Summary failed', 'error');
  await f.control(record, 'finish'); assert.equal(f.current().meta.phase, 'summary'); assert.notEqual(f.current().attemptId, failedAttempt);
  await f.finish('Recovered summary');
  const saved = f.record(record.discussionId);
  assert.equal(saved.status, 'done'); assert.equal(saved.partial, true); assert.equal(saved.summary, 'Recovered summary');
});

test('protocol 1 member failure still wakes existing discussion waiters', async t => {
  const f = fixture(t); const record = { protocolVersion: 1, discussionId: 'legacy', groupId: 'group', topic: 'Legacy', status: 'running', rounds: 1, memberIds: ['a'] };
  await f.repo.putDiscussion(record); const wait = f.engine.whenDiscussionSettled('legacy', 1000);
  f.engine.advanceDiscussion('legacy', false); await f.flush();
  assert.equal(await wait, true); assert.equal(f.record('legacy').status, 'stopped');
});
