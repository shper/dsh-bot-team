import test from 'node:test';
import assert from 'node:assert/strict';
import { openRepository } from '../host/domain.js';

function storage() {
  const records = new Map();
  const table = name => {
    if (!records.has(name)) records.set(name, new Map());
    return records.get(name);
  };
  return {
    records, beforePut: null,
    table(name) { return {
      entries: () => [...table(name)].map(([key, value]) => [key, structuredClone(value)]),
      put: async (key, value) => { await this.beforePut?.(name, key, value); table(name).set(key, structuredClone(value)); },
      delete: async key => { table(name).delete(key); },
    }; },
    async close() {},
  };
}
const open = domain => openRepository({ storageDomain: { open: async () => domain } }, { warn() {} });
async function fixture() {
  const domain = storage();
  const repo = await open(domain);
  await repo.runMigrations();
  await repo.putGroup({ groupId: 'g', title: 'Team', nextSeq: 0, createdAt: 1 });
  const conversationId = repo.activeConversation('g').conversationId;
  return { domain, repo, conversationId };
}
const run = (conversationId, status = 'running') => ({
  discussionId: 'd', groupId: 'g', conversationId, topic: 'Question', protocolVersion: 2,
  mode: 'debate', format: 'structured', status, revision: 6,
  steps: [{ stepId: 'step-1', membershipId: 'm', phase: 'opening', status: 'done', messageIds: ['answer'],
    attempts: [{ attemptId: 'attempt-1', jobId: 'job-1', sessionId: 'native-1', inputMessageId: 'input-1', status: 'done' }] },
    { stepId: 'step-2', membershipId: 'n', phase: 'opening', status: 'running', attempts: [{ attemptId: 'attempt-2', jobId: 'job-2' }], messageIds: [] }],
});

test('restart pauses versioned runs without replaying or inventing step completion', async () => {
  const { repo, domain, conversationId } = await fixture();
  const original = run(conversationId);
  await repo.putDiscussion(original);
  const restarted = await open(domain);
  await restarted.flushGroupWrites('g');
  const current = restarted.getDiscussion('d');
  assert.equal(current.status, 'paused');
  assert.equal(current.pauseReason, 'host-restart');
  assert.equal(current.recoveryStatus, 'running');
  assert.equal(current.needsRecovery, true);
  assert.equal(current.revision, 7);
  assert.deepEqual(current.steps, original.steps);
  assert.equal(restarted.activeDiscussionOf('g').discussionId, 'd');
  assert.equal(domain.records.get('discussions').get('d').status, 'paused');
});

test('restart retains a pending stop intention and an existing pause reason', async () => {
  const { repo, domain, conversationId } = await fixture();
  await repo.putDiscussion(run(conversationId, 'stopping'));
  let restarted = await open(domain);
  await restarted.flushGroupWrites('g');
  assert.equal(restarted.getDiscussion('d').recoveryStatus, 'stopping');
  await restarted.putDiscussion({ ...restarted.getDiscussion('d'), pauseReason: 'quota' });
  restarted = await open(domain);
  await restarted.flushGroupWrites('g');
  assert.equal(restarted.getDiscussion('d').pauseReason, 'quota');
  assert.equal(restarted.getDiscussion('d').needsRecovery, true);
});

test('v8 migration preserves legacy content and does not fabricate a step journal', async () => {
  const { repo, domain, conversationId } = await fixture();
  await repo.putDiscussion({ discussionId: 'old', groupId: 'g', conversationId, topic: 'Old topic', status: 'done', rounds: 2, memberIds: ['m'] });
  await repo.putMeta('schema', { version: 7 });
  const restarted = await open(domain);
  assert.deepEqual(await restarted.runMigrations(), { version: 8, applied: [7] });
  const legacy = restarted.getDiscussion('old');
  assert.equal(legacy.protocolVersion, 1);
  assert.equal(legacy.mode, 'discussion');
  assert.equal(legacy.format, 'classic');
  assert.equal(legacy.topic, 'Old topic');
  assert.equal(legacy.rounds, 2);
  assert.equal(legacy.steps, undefined);
  assert.deepEqual(await restarted.runMigrations(), { version: 8, applied: [] });
});

test('v8 migration marks the schema only after all run metadata is durable', async () => {
  const { repo, domain, conversationId } = await fixture();
  await repo.putDiscussion({ discussionId: 'old', groupId: 'g', conversationId, topic: 'Old', status: 'done' });
  await repo.putMeta('schema', { version: 7 });
  const restarted = await open(domain);
  domain.beforePut = name => { if (name === 'discussions') throw new Error('disk full'); };
  await assert.rejects(restarted.runMigrations(), /disk full/);
  assert.equal(restarted.schemaVersion(), 7);
  domain.beforePut = null;
  assert.equal((await restarted.runMigrations()).version, 8);
});

test('only unfinished runs in the current conversation occupy the active slot', async () => {
  const { repo, conversationId } = await fixture();
  await repo.putDiscussion({ ...run(conversationId, 'done'), steps: [] });
  assert.equal(repo.activeDiscussionOf('g'), undefined);
  const next = await repo.commitConversation('g', { expectedConversationId: conversationId, requestId: 'next' });
  assert.ok(next);
  await repo.putDiscussion({ ...run(conversationId, 'paused'), steps: [] });
  assert.equal(repo.activeDiscussionOf('g'), undefined, 'historical paused data cannot block the new conversation');
  await repo.putDiscussion({ ...run(repo.activeConversation('g').conversationId, 'paused'), discussionId: 'current', steps: [] });
  assert.equal(repo.activeDiscussionOf('g').discussionId, 'current');
});
