import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotTeamService } from '../host/service.js';
import { offlineUpdateDependencies } from './update-check-fixture.js';
import { BOT_TEAM_TOOL_NAMES, registerBotTeamTools } from '../host/tools.js';
import { resolveConfig } from '../host/util.js';

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

// Exercise the actual registered tool functions, Service admission and durable
// repository. Only execution is disabled: no Agent or model can be created.
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bot-team-tools-conversation-')));
  const tables = new Map(); const definitions = new Map(); const calls = { creates: 0 };
  const storageRoot = path.join(root, 'storages');
  const domain = {
    unit: { constructor: { name: 'PerRecordJsonUnit' }, descriptor: { name: 'bot_team', layout: 'per-record' }, dir: path.join(storageRoot, 'bot_team') },
    table(name) {
      if (!tables.has(name)) tables.set(name, new Map());
      const records = tables.get(name);
      return {
        entries: () => [...records].map(([key, value]) => [key, structuredClone(value)]),
        async put(key, value) { records.set(key, structuredClone(value)); },
        async delete(key) { records.delete(key); },
      };
    },
    async close() {},
  };
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    storageDomain: {
      config: { backend: 'json' },
      ctx: { storage: { backend: { get: () => ({ constructor: { name: 'JsonStorageBackend' }, root: storageRoot }) } } },
      open: async () => domain, get: () => undefined,
    },
    connection: { fetch: { register: () => () => {} } }, on: () => () => {},
    tools: { register(definition) {
      assert.equal(definitions.has(definition.name), false);
      definitions.set(definition.name, definition);
      return () => definitions.delete(definition.name);
    } },
    get: name => name === 'botTeamNativeActivity' ? {
      capability: () => ({ supported: true, missing: [] }), collect: () => [],
    } : undefined,
    agents: { get: () => undefined, create() { calls.creates += 1; assert.fail('Tool tests must never create Agents or call a model'); } },
  };
  const config = resolveConfig({ dataDir: path.join(root, 'data'), defaultCwd: root, migrateLegacyLayout: false, enableModelTools: false });
  const service = new BotTeamService(ctx, config, offlineUpdateDependencies);
  await service.ready;
  const unregister = registerBotTeamTools({ ctx, service, config: { ...config, enableModelTools: true }, logger: ctx.logger });
  assert.deepEqual([...definitions.keys()].sort(), [...BOT_TEAM_TOOL_NAMES].sort());
  const alpha = await service.createBot({ name: 'Alpha', provider: 'mock', model: 'mock' });
  const beta = await service.createBot({ name: 'Beta', provider: 'mock', model: 'mock' });
  const group = await service.createGroup({ title: 'Tool conversation team', topic: 'Permanent team topic' });
  const member = await service.addMember({ groupId: group.groupId, botId: alpha.botId });
  await service.addMember({ groupId: group.groupId, botId: beta.botId });
  t.mock.method(service.engine, 'pump', () => {});
  const repo = service.repo; let request = 0;
  const f = {
    service, repo, group, member, definitions, calls,
    cid: () => repo.activeConversation(group.groupId).conversationId,
    invoke: (name, args = {}) => definitions.get(name).execute({ groupId: group.groupId, ...args }),
    async next() {
      await repo.flushGroupWrites(group.groupId);
      return service.dispatch('conversation.new', { groupId: group.groupId, expectedConversationId: f.cid(), requestId: 'tool-new-' + (++request) });
    },
    async message(text, fields = {}) {
      const message = service.engine.createMessage({ groupId: group.groupId, text,
        author: { type: 'bot', name: 'Alpha', botId: alpha.botId, membershipId: member.membershipId }, ...fields });
      await repo.flushGroupWrites(group.groupId);
      return message;
    },
    async task(title = 'Current task', fields = {}) {
      return service.dispatch('task.create', { groupId: group.groupId, title,
        assigneeMembershipId: member.membershipId, ...fields });
    },
  };
  t.after(async () => {
    service.conversationChanges.clear(); service.workspaceChanges.clear();
    service.engine.queue = []; service.engine.running.clear(); service.engine.pendingWork.clear();
    unregister(); await service.dispose();
    assert.equal(calls.creates, 0);
    await rm(root, { recursive: true, force: true });
  });
  return f;
}

test('registered list exposes only current conversation messages and active discussions, including an empty new segment', async t => {
  const f = await fixture(t); const oldConversationId = f.cid();
  await f.message('OLD_AUTOMATIC_CONTEXT');
  await f.next();
  await f.repo.putDiscussion({ discussionId: 'old-discussion', groupId: f.group.groupId, conversationId: oldConversationId,
    topic: 'OLD_DISCUSSION_TOPIC', status: 'running', currentRound: 1, rounds: 2 });
  const empty = await f.invoke('bot_team_list', { includeMessages: true });
  assert.equal(empty.groups.length, 1); assert.equal(empty.groups[0].currentConversationId, f.cid());
  assert.equal(empty.groups[0].lastMessage, null); assert.equal(empty.groups[0].activeDiscussion, null);
  assert.deepEqual(empty.groups[0].messages, []); assert.doesNotMatch(JSON.stringify(empty), /OLD_/);
  await f.message('CURRENT_AUTOMATIC_CONTEXT');
  await f.repo.putDiscussion({ discussionId: 'current-discussion', groupId: f.group.groupId, conversationId: f.cid(),
    topic: 'Current topic', status: 'running', currentRound: 1, rounds: 2 });
  const populated = await f.invoke('bot_team_list', { includeMessages: true });
  assert.deepEqual(populated.groups[0].messages.map(message => message.text), ['CURRENT_AUTOMATIC_CONTEXT']);
  assert.equal(populated.groups[0].lastMessage.text, 'CURRENT_AUTOMATIC_CONTEXT');
  assert.equal(populated.groups[0].activeDiscussion.discussionId, 'current-discussion');
  assert.doesNotMatch(JSON.stringify(populated), /OLD_/);
  const all = await f.invoke('bot_team_list', { groupId: undefined });
  assert.equal(all.groups.length, 1, 'Direct chats are not automatic group context');
  assert.equal(all.groups[0].lastMessage.text, 'CURRENT_AUTOMATIC_CONTEXT');
});

test('registered send holds Service admission and passes the captured conversation into Engine', async t => {
  const f = await fixture(t); const cid = f.cid(); const gate = deferred(); const entered = deferred();
  const post = f.service.engine.postHumanMessage.bind(f.service.engine); const captured = [];
  t.mock.method(f.service.engine, 'postHumanMessage', async input => {
    captured.push({ ...input, guarded: f.service.workspaceOperations.get(f.group.groupId) > 0 });
    entered.resolve(); await gate.promise; return post(input);
  });
  const sending = f.invoke('bot_team_send', { text: '@Alpha local request', wait: false });
  await entered.promise;
  try {
    await assert.rejects(f.next(), { code: 'conversation-busy' });
    assert.equal(captured[0].expectedConversationId, cid); assert.equal(captured[0].guarded, true);
    assert.equal(captured[0].humanInput, false); assert.deepEqual(captured[0].mentions, [f.member.membershipId]);
  } finally { gate.resolve(); }
  const result = await sending;
  assert.equal(result.acceptedMentions, 1); assert.equal(f.cid(), cid);
  assert.equal(f.service.engine.queue[0].conversationId, cid);
  const before = f.repo.messages.size;
  f.service.conversationChanges.add(f.group.groupId);
  await assert.rejects(f.invoke('bot_team_send', { text: 'Blocked input', mentions: ['Alpha'], wait: false }), { code: 'conversation-busy' });
  f.service.conversationChanges.delete(f.group.groupId);
  assert.equal(captured.length, 1); assert.equal(f.repo.messages.size, before);
});

test('registered send returns only its admitted segment when waiting overlaps a later new conversation', async t => {
  const f = await fixture(t); const cid = f.cid();
  await f.message('BEFORE_REQUEST');
  t.mock.method(f.service.engine, 'whenIdle', async () => {
    f.service.engine.queue = [];
    await f.message('REPLY_TO_ORIGINAL_SEND');
    await f.next();
    await f.message('FUTURE_SEGMENT_REPLY');
    return true;
  });
  const result = await f.invoke('bot_team_send', { text: 'Local request', mentions: ['Alpha'] });
  assert.notEqual(f.cid(), cid); assert.equal(result.completed, true);
  assert.deepEqual(result.replies.map(reply => reply.text), ['REPLY_TO_ORIGINAL_SEND']);
  assert.doesNotMatch(JSON.stringify(result), /FUTURE_SEGMENT|BEFORE_REQUEST/);
});

test('registered send preserves management command rejection without posting model text', async t => {
  const f = await fixture(t); const before = f.repo.messages.size;
  await assert.rejects(f.invoke('bot_team_send', { text: '/new', wait: false }), { code: 'command-required' });
  await assert.rejects(f.invoke('bot_team_send', { text: '/new extra', wait: false }), { code: 'invalid-command' });
  assert.equal(f.repo.messages.size, before); assert.equal(f.service.engine.queue.length, 0);
});

test('registered review defaults to this segment and rejects an explicitly selected old message', async t => {
  const f = await fixture(t); const old = await f.message('OLD_DELIVERABLE'); await f.next();
  await assert.rejects(f.invoke('bot_team_review', { reviewer: 'Beta', wait: false }), /找不到要评审/);
  const current = await f.message('CURRENT_DELIVERABLE'); const review = f.service.engine.requestReview.bind(f.service.engine);
  const captured = [];
  t.mock.method(f.service.engine, 'requestReview', input => { captured.push(input); return review(input); });
  const result = await f.invoke('bot_team_review', { reviewer: 'Beta', wait: false });
  assert.equal(result.targetSeq, current.seq); assert.equal(captured[0].targetMessageId, current.messageId);
  assert.equal(captured[0].expectedConversationId, f.cid());
  const before = f.repo.messages.size;
  await assert.rejects(f.invoke('bot_team_review', { reviewer: 'Beta', messageSeq: old.seq, wait: false }), { code: 'historical-target' });
  assert.equal(f.repo.messages.size, before);
  f.service.conversationChanges.add(f.group.groupId);
  await assert.rejects(f.invoke('bot_team_review', { reviewer: 'Beta', wait: false }), { code: 'conversation-busy' });
  f.service.conversationChanges.delete(f.group.groupId);
});

test('registered review does not replace its awaited verdict with a newer segment review', async t => {
  const f = await fixture(t); const target = await f.message('ORIGINAL_DELIVERABLE');
  t.mock.method(f.service.engine, 'whenIdle', async () => {
    f.service.engine.queue = [];
    await f.message('ORIGINAL_REVIEW_PASS', { kind: 'review', meta: { verdict: 'pass', reviewOf: target.messageId } });
    await f.next();
    await f.message('FUTURE_REVIEW_CHANGES', { kind: 'review', meta: { verdict: 'changes' } });
    return true;
  });
  const result = await f.invoke('bot_team_review', { reviewer: 'Beta' });
  assert.equal(result.review.text, 'ORIGINAL_REVIEW_PASS'); assert.equal(result.review.verdict, 'pass');
  assert.doesNotMatch(JSON.stringify(result), /FUTURE_REVIEW/);
});

test('registered discussion captures admission and an awaited old discussion never schedules in the next segment', async t => {
  const f = await fixture(t); const cid = f.cid(); const captured = [];
  const start = f.service.engine.startDiscussion.bind(f.service.engine);
  t.mock.method(f.service.engine, 'startDiscussion', input => { captured.push(input); return start(input); });
  f.service.conversationChanges.add(f.group.groupId);
  await assert.rejects(f.invoke('bot_team_discuss', { topic: 'Blocked topic', wait: false }), { code: 'conversation-busy' });
  f.service.conversationChanges.delete(f.group.groupId); assert.equal(captured.length, 0);
  t.mock.method(f.service.engine, 'whenDiscussionSettled', async discussionId => {
    const discussion = f.repo.getDiscussion(discussionId);
    assert.equal(discussion.conversationId, cid);
    f.service.engine.queue = [];
    await f.message('ORIGINAL_DISCUSSION_REPLY', { kind: 'discussion', meta: { discussionId, round: 1 } });
    await f.message('ORIGINAL_DISCUSSION_SUMMARY', { kind: 'discussion', meta: { discussionId, summary: true } });
    await f.repo.putDiscussion({ ...discussion, status: 'done' });
    await f.next();
    await f.message('FUTURE_DISCUSSION_REPLY', { kind: 'discussion', meta: { discussionId: 'future-discussion' } });
    // A stale running record can survive a restart; a late scheduler must still
    // reject it by generation even before its status is reconciled.
    await f.repo.putDiscussion({ ...discussion, status: 'running', currentRound: 2, currentIndex: 0 });
    const historical = structuredClone(f.repo.getDiscussion(discussionId));
    f.service.engine.advanceDiscussion(discussionId, true);
    f.service.engine.scheduleDiscussion(discussionId);
    assert.deepEqual(f.repo.getDiscussion(discussionId), historical);
    assert.equal(f.service.engine.queue.length, 0);
    // Restore the actual terminal state after probing rejection of stale work.
    // A waiter returning true alone must not turn a running v2 record into done.
    await f.repo.putDiscussion({ ...historical, status: 'done' });
    return true;
  });
  const result = await f.invoke('bot_team_discuss', { topic: 'Original topic', members: ['Alpha'], rounds: 1 });
  assert.equal(captured[0].expectedConversationId, cid); assert.equal(result.discussion.settled, true);
  assert.equal(result.summary, 'ORIGINAL_DISCUSSION_SUMMARY');
  assert.deepEqual(result.transcript.map(message => message.text), ['ORIGINAL_DISCUSSION_REPLY', 'ORIGINAL_DISCUSSION_SUMMARY']);
  assert.doesNotMatch(JSON.stringify(result), /FUTURE_DISCUSSION/);
});

test('registered task creation cannot dispatch its just-created task after the conversation changes between actions', async t => {
  const f = await fixture(t); const cid = f.cid(); const dispatch = f.service.dispatch.bind(f.service); const actions = [];
  t.mock.method(f.service, 'dispatch', async (action, input) => {
    actions.push(action);
    const result = await dispatch(action, input);
    if (action === 'task.create') await f.next();
    return result;
  });
  await assert.rejects(f.invoke('bot_team_task_create', { title: 'Old admitted draft', assignee: 'Alpha', dispatch: true, wait: false }), { code: 'historical-target' });
  const task = f.repo.tasksOf(f.group.groupId)[0];
  assert.equal(task.conversationId, cid); assert.equal(task.status, 'pending');
  assert.ok(actions.includes('task.create')); assert.ok(actions.includes('task.dispatch'));
  assert.equal(f.service.engine.queue.length, 0);
});

test('registered task actions, lists and dispatch_ready do not advance historical tasks', async t => {
  const f = await fixture(t); const old = await f.task('OLD_TASK'); await f.next();
  const before = structuredClone(f.repo.getTask(old.taskId)); const dispatch = f.service.dispatch.bind(f.service); const actions = [];
  t.mock.method(f.service, 'dispatch', (action, input) => { actions.push(action); return dispatch(action, input); });
  for (const action of ['dispatch', 'review', 'revise', 'accept', 'request_changes', 'cancel', 'update']) {
    await assert.rejects(f.invoke('bot_team_task_update', { taskId: old.taskId, action, title: 'MUST_NOT_CHANGE', wait: false, force: true }), { code: 'historical-target' });
    assert.deepEqual(f.repo.getTask(old.taskId), before);
    assert.ok(actions.includes('task.' + action));
  }
  const empty = await f.invoke('bot_team_task_list', { includeClosed: true }); assert.deepEqual(empty.tasks, []);
  const created = await f.invoke('bot_team_task_create', { title: 'CURRENT_TASK', assignee: 'Alpha', dispatch: false });
  const current = f.repo.getTask(created.task.taskId); assert.equal(current.conversationId, f.cid());
  const listing = await f.invoke('bot_team_task_list', { includeClosed: true });
  assert.deepEqual(listing.tasks.map(task => task.taskId), [current.taskId]); assert.doesNotMatch(JSON.stringify(listing), /OLD_TASK/);
  const dispatched = await f.invoke('bot_team_task_update', { action: 'dispatch_ready' });
  assert.deepEqual(dispatched.dispatched.map(task => task.taskId), [current.taskId]);
  assert.deepEqual(f.repo.getTask(old.taskId), before);
  assert.deepEqual(f.service.engine.queue.map(job => job.meta.taskId), [current.taskId]);
  assert.equal(f.service.engine.queue[0].conversationId, f.cid());
});

test('registered task create and update both obey Service admission while a new conversation is committing', async t => {
  const f = await fixture(t); const task = await f.task(); const before = structuredClone(f.repo.getTask(task.taskId));
  f.service.conversationChanges.add(f.group.groupId);
  await assert.rejects(f.invoke('bot_team_task_create', { title: 'Blocked', assignee: 'Alpha', dispatch: true }), { code: 'conversation-busy' });
  await assert.rejects(f.invoke('bot_team_task_update', { action: 'dispatch', taskId: task.taskId, wait: false }), { code: 'conversation-busy' });
  await assert.rejects(f.invoke('bot_team_task_update', { action: 'dispatch_ready' }), { code: 'conversation-busy' });
  f.service.conversationChanges.delete(f.group.groupId);
  assert.equal(f.repo.tasksOf(f.group.groupId).length, 1); assert.deepEqual(f.repo.getTask(task.taskId), before);
  assert.equal(f.service.engine.queue.length, 0);
});
