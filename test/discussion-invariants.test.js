import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../host/engine.js';
import { DiscussionRunner } from '../host/discussion-runner.js';

function recoveryFixture() {
  const group = { groupId: 'group', activeConversationId: 'conversation', nextSeq: 0 };
  const member = { membershipId: 'member', botId: 'bot', groupId: group.groupId, enabled: true };
  const messages = new Map();
  const discussions = new Map();
  const enqueued = [];
  const repo = {
    messages, discussions,
    getGroup: id => id === group.groupId ? group : undefined,
    getBot: id => id === 'bot' ? { botId: id, name: 'Bot' } : undefined,
    getMember: id => id === member.membershipId ? member : undefined,
    membersOf: () => [member],
    getMessage: id => messages.get(id), getDiscussion: id => discussions.get(id),
    discussionsOf: () => [...discussions.values()], messagesOf: () => [...messages.values()],
    lastMessageOf: () => [...messages.values()].at(-1),
    activeConversation: () => ({ conversationId: 'conversation', afterSeq: 0 }),
    async putDiscussion(record) { discussions.set(record.discussionId, structuredClone(record)); },
    async putMessageStrict(message) {
      if (repo.failStartWrite && message.meta?.event === 'start') throw new Error('simulated start-message storage failure');
      messages.set(message.messageId, structuredClone(message));
    },
  };
  const engine = Object.create(Engine.prototype);
  Object.assign(engine, { repo, queue: [], running: new Map(), pendingWork: new Set(), disposed: false,
    bus: { emit() {} }, logger: { warn() {} }, settleDiscussionWaiters() {}, checkIdle() {}, assertQuota() {},
    admitConversation: () => 'conversation', isCurrentRecord: record => record.conversationId === 'conversation',
    discussionGuard: async () => {},
    createMessage(fields) { return { ...fields, messageId: 'message-' + ++group.nextSeq, seq: group.nextSeq }; },
    enqueueJob(job) { enqueued.push(job); },
  });
  engine.discussionRunner = new DiscussionRunner(engine);
  return { engine, repo, enqueued };
}

test('stopping an unclaimed discussion input withdraws only its own native inbox entry', () => {
  const ownInput = { id: 'discussion-input', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'discussion step' }] };
  const unrelatedInput = { id: 'unrelated-input', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'unrelated work' }] };
  const inbox = {
    nextTurn: [ownInput, unrelatedInput], nextStep: [],
    splice(lane, start, count, inserted = []) {
      const key = lane === 'next-turn' ? 'nextTurn' : 'nextStep';
      return this[key].splice(start, count, ...inserted);
    },
  };
  let cancellations = 0;
  const agent = { id: 'session', inbox, cancel() { cancellations++; } };
  const job = { jobId: 'job', discussionId: 'discussion', stepId: 'step-1', sessionId: agent.id,
    turn: null, submitted: true, finished: false, execution: { inputMessageId: ownInput.id } };
  const engine = Object.create(Engine.prototype);
  Object.assign(engine, {
    ctx: { agents: { get: () => agent } }, pool: { owns: () => true },
    activeBySession: new Map([[agent.id, job]]), logger: { warn() {} },
    finishJob(stopped, state) { stopped.finished = true; stopped.state = state; },
  });
  engine.abortJob(job, 'user');
  assert.equal(cancellations, 0, 'an unclaimed discussion must not cancel another native turn');
  assert.deepEqual(inbox.nextTurn.map(message => message.id), [unrelatedInput.id], 'the stopped discussion input must not execute later');
  assert.deepEqual(inbox.nextStep, []);
});

test('resume after a start-message write failure must not dispatch a missing trigger', async () => {
  const { engine, repo, enqueued } = recoveryFixture();
  repo.failStartWrite = true;
  await assert.rejects(engine.discussionRunner.start({ groupId: 'group', topic: 'recover', membershipIds: ['member'], rounds: 1 }), /storage failure/);
  const paused = [...repo.discussions.values()][0];
  assert.equal(paused.status, 'paused');
  assert.equal(repo.getMessage(paused.startMessageId), undefined);
  repo.failStartWrite = false;
  await engine.discussionRunner.control({ discussionId: paused.discussionId, operation: 'resume', expectedConversationId: 'conversation' });
  const pending = engine.discussionRunner.chains.get(paused.discussionId);
  if (pending) await pending;
  assert.equal(enqueued.length, 1);
  assert.doesNotThrow(() => engine.assertJobTargets(enqueued[0]), 'resumed execution must have a durable, valid trigger message');
});
