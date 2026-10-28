import test from 'node:test';
import assert from 'node:assert/strict';
import { BotTeamService } from '../host/service.js';

function fixture() {
  const group = { groupId: 'g', kind: 'group', activeConversationId: 'c2', conversationVersion: 2 };
  const runs = new Map();
  const messages = new Map();
  const members = new Map([
    ['m1', { membershipId: 'm1', botId: 'b1', groupId: 'g', sessionId: 's1' }],
    ['m2', { membershipId: 'm2', botId: 'b2', groupId: 'g', sessionId: 's2' }],
    ['other', { membershipId: 'other', botId: 'b3', groupId: 'g', sessionId: 's3' }],
  ]);
  const service = Object.create(BotTeamService.prototype);
  const calls = [];
  const activity = { capability: { supported: true }, collect: () => [] };
  service.ctx = { get: name => name === 'botTeamNativeActivity' ? activity : undefined };
  service.ready = Promise.resolve();
  service.pool = { owned: new Map(), preparing: new Map(), submitting: new Map(), overlayPreparing: new Map() };
  service.interactions = { entries: new Map(), responding: new Set() };
  service.repo = {
    members, messages, sessionBindings: new Map(),
    getGroup: id => id === 'g' ? group : undefined,
    getDiscussion: id => runs.get(id), getMember: id => members.get(id),
    activeConversation: id => id === 'g' ? { conversationId: group.activeConversationId, ordinal: 2 } : undefined,
    conversationFor: record => ({ conversationId: record.conversationId }),
    membersOf: id => [...members.values()].filter(member => member.groupId === id),
    messagesOf: id => [...messages.values()].filter(message => message.groupId === id),
  };
  service.engine = {
    startDiscussion: async input => { calls.push(['start', input]); return input; },
    controlDiscussion: async input => { calls.push(['control', input]); return runs.get(input.discussionId); },
    stopDiscussion: async id => { calls.push(['stop', id]); return { stopped: true }; },
  };
  const run = { discussionId: 'd', groupId: 'g', conversationId: 'c2', topic: 'Topic', protocolVersion: 2,
    revision: 4, mode: 'debate', status: 'paused', memberIds: ['m1', 'm2'], steps: [] };
  runs.set('d', run);
  return { service, group, runs, run, members, messages, calls, activity };
}

test('discussion start passes new configuration and preserves traditional defaults', async () => {
  const { service, calls } = fixture();
  await service.dispatch('discussion.start', { groupId: 'g', topic: 'Topic', format: 'structured', goal: 'Decision',
    membershipIds: ['m1', 'm2'], summaryMembershipId: 'm2', responseLength: 'detailed', language: 'en',
    perspectives: { m1: 'cost' }, background: 'Budget', contextMessageIds: ['source'], requestId: 'start', expectedConversationId: 'c2' }, { external: true });
  const input = calls[0][1];
  assert.equal(input.format, 'structured');
  assert.equal(input.rounds, undefined, 'flow selects the structured default');
  assert.equal(input.summarize, undefined);
  assert.equal(input.summaryMembershipId, 'm2');
  assert.deepEqual(input.contextMessageIds, ['source']);
  assert.deepEqual(input.perspectives, { m1: 'cost' });
  await service.startDiscussion({ groupId: 'g', topic: 'Classic' });
  assert.equal(calls[1][1].rounds, 2);
  assert.equal(calls[1][1].summarize, false);
  await assert.rejects(service.startDiscussion({ groupId: 'g', topic: 'x'.repeat(2001), format: 'structured' }), error => error.code === 'invalid-input');
  await assert.rejects(service.startDiscussion({ groupId: 'g', topic: 123, mode: 'debate' }), error => error.code === 'invalid-input');
  assert.equal(calls.length, 2, 'invalid modern topics are not silently truncated or dispatched');
});

test('historical details include only the exact group and conversation and report deleted sources', async () => {
  const { service, run, messages } = fixture();
  Object.assign(run, { conversationId: 'c1', status: 'done', verdict: 'tie', steps: [{ stepId: 's', status: 'done', messageIds: ['summary', 'deleted'] }] });
  for (const value of [
    { messageId: 'summary', groupId: 'g', conversationId: 'c1', status: 'done', text: 'Old verdict', meta: { discussionId: 'd', stepId: 's', summary: true } },
    { messageId: 'new', groupId: 'g', conversationId: 'c2', status: 'done', text: 'Must not leak', meta: { discussionId: 'd', summary: true } },
    { messageId: 'wrong-run', groupId: 'g', conversationId: 'c1', status: 'done', text: 'Other run', meta: { discussionId: 'other' } },
  ]) messages.set(value.messageId, value);
  const result = await service.dispatch('discussion.get', { groupId: 'g', discussionId: 'd' });
  assert.deepEqual(result.transcript.map(message => message.messageId), ['summary']);
  assert.equal(result.summary, 'Old verdict');
  assert.equal(result.verdict, 'tie');
  assert.deepEqual(result.missingMessageIds, ['deleted']);
  result.discussion.steps.length = 0;
  assert.equal(run.steps.length, 1, 'read result is a snapshot');
  await assert.rejects(service.dispatch('discussion.control', { discussionId: 'd', operation: 'resume', expectedConversationId: 'c2' }), error => error.code === 'historical-target');
  assert.throws(() => service.getDiscussion({ groupId: 'elsewhere', discussionId: 'd' }), error => error.code === 'not-found');
});

test('accepted multi-turn results survive source deletion without returning a failed draft', () => {
  const { service, run, messages } = fixture();
  Object.assign(run, { summary: 'Reasoning from turn one\n\nFinal assessment from turn two', verdict: 'insufficient',
    steps: [{ stepId: 'judge', phase: 'judgement', status: 'done', messageIds: ['old-draft', 'turn-1', 'turn-2'],
      attempts: [{ attemptId: 'failed', status: 'error', messageIds: ['old-draft'] }, { attemptId: 'accepted', status: 'done', messageIds: ['turn-1', 'turn-2'] }] }] });
  messages.set('old-draft', { messageId: 'old-draft', groupId: 'g', conversationId: 'c2', status: 'done', text: 'Verdict: pro',
    meta: { discussionId: 'd', stepId: 'judge', attemptId: 'failed', summary: true } });
  const result = service.getDiscussion({ discussionId: 'd' });
  assert.equal(result.summary, run.summary);
  assert.equal(result.verdict, 'insufficient');
  assert.deepEqual(result.missingMessageIds, ['turn-1', 'turn-2']);
});

test('controls reject stale pages and validate revision before forwarding exact request identity', async () => {
  const { service, calls } = fixture();
  await assert.rejects(service.dispatch('discussion.control', { discussionId: 'd', operation: 'resume', expectedConversationId: 'c1' }, { external: true }), error => error.code === 'stale-conversation');
  await assert.rejects(service.dispatch('discussion.control', { discussionId: 'd', operation: 'resume' }, { external: true }), error => error.code === 'reload-required');
  await assert.rejects(service.controlDiscussion({ discussionId: 'd', operation: 'resume', expectedRevision: -1 }), error => error.code === 'invalid-input');
  await assert.rejects(service.controlDiscussion({ discussionId: 'd', operation: 'unknown' }), error => error.code === 'invalid-input');
  await service.dispatch('discussion.control', { discussionId: 'd', operation: 'add_context', text: 'A new constraint',
    expectedConversationId: 'c2', expectedRevision: 4, requestId: 'request-1' }, { external: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].groupId, 'g');
  assert.equal(calls[0][1].expectedRevision, 4);
  assert.equal(calls[0][1].requestId, 'request-1');
  assert.equal(calls[0][1].text, 'A new constraint');
});

test('native recovery checks participating members without cancelling other sessions', async () => {
  const { service, run, activity } = fixture();
  let observed;
  activity.collect = args => { observed = args; return [{ membershipId: 'other', kind: 'native-agent', message: 'Other bot is working' }]; };
  await service.assertDiscussionNativeIdle(run);
  assert.deepEqual([...observed.repo.members.keys()], ['m1', 'm2']);
  assert.equal(service.repo.members.size, 3);
  activity.collect = () => [{ membershipId: 'm1', kind: 'native-goal', message: 'Participant goal is armed' }];
  await assert.rejects(service.assertDiscussionNativeIdle(run), error => error.code === 'native-busy' && error.details.blockers[0].kind === 'native-goal');
});

test('legacy stop remains supported while versioned stop uses the shared controller', async () => {
  const { service, run, calls } = fixture();
  run.status = 'stopped';
  assert.equal((await service.stopDiscussion({ discussionId: 'd' })).stopped, true);
  assert.equal(calls[0][0], 'control');
  run.protocolVersion = 1;
  assert.deepEqual(await service.stopDiscussion({ discussionId: 'd' }), { stopped: true });
  assert.equal(calls[1][0], 'stop');
});
