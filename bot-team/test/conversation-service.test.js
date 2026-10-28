import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotTeamService } from '../host/service.js';
import { openRepository } from '../host/domain.js';
import { isCurrentMemberSession } from '../host/conversations.js';
import { resolveConfig } from '../host/util.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const hasCode = (code) => (error) => error.code === code;
const busy = hasCode('conversation-busy');

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bot-team-conversation-')));
  const records = new Map();
  const storage = { beforePut: null, failPut: null };
  const storageRoot = path.join(root, 'storages');
  const domain = {
    unit: { constructor: { name: 'PerRecordJsonUnit' }, descriptor: { name: 'bot_team', layout: 'per-record' }, dir: path.join(storageRoot, 'bot_team') },
    table(name) {
      if (!records.has(name)) records.set(name, new Map());
      const table = records.get(name);
      return {
        entries: () => [...table].map(([key, value]) => [key, structuredClone(value)]),
        async put(key, value) {
          const snapshot = structuredClone(value);
          await storage.beforePut?.(name, snapshot);
          if (storage.failPut?.(name, snapshot)) throw new Error('disk write failed: ' + name);
          table.set(key, snapshot);
        },
        async delete(key) { table.delete(key); },
      };
    },
    async close() {},
  };
  const activity = { capability: () => ({ supported: true, missing: [] }), collect: () => [] };
  const calls = { creates: 0, native: [] };
  const adapter = { capability: (...args) => activity.capability(...args), collect: (args) => {
    calls.native.push(args);
    return activity.collect(args);
  } };
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    storageDomain: {
      config: { backend: 'json' },
      ctx: { storage: { backend: { get: () => ({ constructor: { name: 'JsonStorageBackend' }, root: storageRoot }) } } },
      open: async () => domain, get: () => undefined,
    },
    connection: { fetch: { register: () => () => {} } },
    tools: { register: () => () => {} }, on: () => () => {},
    get: (name) => name === 'botTeamNativeActivity' ? adapter : name === 'skills' ? { list: async () => [] } : undefined,
    agents: { get: () => undefined, create() { calls.creates += 1; assert.fail('New conversations must not create an Agent or call a model'); } },
  };
  const config = resolveConfig({ dataDir: path.join(root, 'data'), defaultCwd: root, migrateLegacyLayout: false, autoDispatchReady: true });
  const service = new BotTeamService(ctx, config);
  await service.ready;
  const bot = await service.createBot({ name: 'Alpha', provider: 'mock', model: 'mock' });
  const second = await service.createBot({ name: 'Beta', provider: 'mock', model: 'mock' });
  const group = await service.createGroup({ title: 'Conversation team', topic: 'Keep this topic' });
  await service.addMember({ groupId: group.groupId, botId: bot.botId });
  const disabled = await service.addMember({ groupId: group.groupId, botId: second.botId });
  await service.updateMember({ membershipId: disabled.membershipId, enabled: false });
  const direct = service.repo.getGroup(bot.directGroupId);
  const frames = [];
  for (const current of service.repo.allGroups()) service.bus.subscribe(current.groupId, (frame) => frames.push(structuredClone(frame)));
  const releases = [];
  t.after(async () => {
    for (const release of releases) release();
    storage.beforePut = null;
    storage.failPut = null;
    service.engine.running.clear();
    service.engine.queue = [];
    service.engine.pendingWork.clear();
    service.engine.activeBySession.clear();
    service.pool.preparing.clear();
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const hold = () => { const gate = deferred(); releases.push(gate.resolve); return gate; };
  const request = (target = group, requestId = 'new-request') => ({ groupId: target.groupId, expectedConversationId: service.repo.getGroup(target.groupId).activeConversationId, requestId });
  const message = async (target, text = 'Old conversation message') => {
    const value = service.engine.createMessage({ groupId: target.groupId, author: { type: 'human' }, text });
    await service.repo.flushGroupWrites(target.groupId);
    return value;
  };
  return { service, repo: service.repo, root, config, ctx, domain, records, storage, activity, calls, frames, bot, group, direct, request, message, hold };
}

for (const kind of ['direct', 'group']) test('conversation.new switches every ' + kind + ' member logically while physical sessions stay lazy', async (t) => {
  const f = await fixture(t);
  const target = f[kind];
  const oldMessage = await f.message(target);
  oldMessage.usage = { inputTokens: 12, outputTokens: 3 };
  await f.repo.putMessageStrict(oldMessage);
  const before = structuredClone(f.repo.getGroup(target.groupId));
  const members = structuredClone(f.repo.membersOf(target.groupId));
  const otherGroups = structuredClone(f.repo.allGroups().filter((group) => group.groupId !== target.groupId));
  const otherMembers = structuredClone([...f.repo.members.values()].filter((member) => member.groupId !== target.groupId));
  const bots = structuredClone(f.repo.allBots());
  const bindings = structuredClone(f.repo.sessionBindingsOf(target.groupId));
  assert.ok(members.every((member) => isCurrentMemberSession(f.repo, member)));
  const disposed = [];
  t.mock.method(f.service.pool, 'disposeMember', async (id, options) => { disposed.push({ id, options }); });
  const result = await f.service.dispatch('conversation.new', f.request(target));
  assert.equal(result.created, true);
  assert.notEqual(result.currentConversationId, before.activeConversationId);
  assert.equal(result.conversationVersion, before.conversationVersion + 1);
  assert.equal(result.conversation.previousConversationId, before.activeConversationId);
  assert.equal(result.conversation.afterSeq, oldMessage.seq);
  assert.equal(result.conversation.reason, 'user-new');
  assert.deepEqual(disposed.map((item) => item.id).sort(), members.map((member) => member.membershipId).sort());
  assert.ok(disposed.every((item) => item.options.strict === true));
  assert.deepEqual(f.repo.membersOf(target.groupId), members, 'No eager session replacement or cursor reset');
  assert.ok(f.repo.membersOf(target.groupId).every((member) => !isCurrentMemberSession(f.repo, member)));
  assert.deepEqual(f.repo.sessionBindingsOf(target.groupId), bindings);
  assert.deepEqual(f.repo.sessionBindingsOf(target.groupId, result.currentConversationId), []);
  assert.deepEqual(f.repo.allGroups().filter((group) => group.groupId !== target.groupId), otherGroups);
  assert.deepEqual([...f.repo.members.values()].filter((member) => member.groupId !== target.groupId), otherMembers);
  assert.deepEqual(f.repo.allBots(), bots);
  for (const key of ['title', 'topic', 'workspaceCwd', 'projectWorkspaceCwd', 'nextSeq', 'kind']) assert.equal(f.repo.getGroup(target.groupId)[key], before[key]);
  assert.deepEqual(f.repo.messagesOf(target.groupId), [oldMessage]);
  assert.equal(f.service.checkQuota(target.groupId).tokensToday, 15);
  assert.equal(f.calls.creates, 0);
  assert.equal(f.service.engine.queue.length, 0);
  assert.ok(f.calls.native.every((args) => args.groupId === target.groupId && args.repo === f.repo && args.pool === f.service.pool));
  const restarted = await openRepository({ storageDomain: { open: async () => f.domain } }, null);
  assert.equal(restarted.getGroup(target.groupId).activeConversationId, result.currentConversationId);
  assert.deepEqual(restarted.membersOf(target.groupId), members);
});

test('request replay is durable and returns the original result with the latest current conversation', async (t) => {
  const f = await fixture(t);
  const firstRequest = f.request();
  const first = await f.service.dispatch('conversation.new', firstRequest);
  const firstReplay = await f.service.dispatch('conversation.new', firstRequest);
  assert.equal(firstReplay.created, false);
  assert.deepEqual(firstReplay.conversation, first.conversation);
  const second = await f.service.dispatch('conversation.new', f.request(f.group, 'second-request'));
  const replay = await f.service.dispatch('conversation.new', firstRequest);
  assert.equal(replay.created, false);
  assert.deepEqual(replay.conversation, first.conversation);
  assert.equal(replay.currentConversationId, second.currentConversationId);
  assert.equal(replay.conversationVersion, second.conversationVersion);
  await assert.rejects(f.service.dispatch('conversation.new', { ...firstRequest, expectedConversationId: second.currentConversationId }), hasCode('conflict'));
  assert.equal(f.repo.conversationsOf(f.group.groupId).length, 3);
  assert.equal(f.frames.filter((frame) => frame.type === 'conversation.started').length, 2);
  const restoredRepo = await openRepository({ storageDomain: { open: async () => f.domain } }, null);
  const restored = Object.assign(Object.create(BotTeamService.prototype), { ready: Promise.resolve(), repo: restoredRepo });
  const retryAfterRestart = await restored.dispatch('conversation.new', firstRequest);
  assert.equal(retryAfterRestart.created, false);
  assert.deepEqual(retryAfterRestart.conversation, first.conversation);
  assert.equal(retryAfterRestart.currentConversationId, second.currentConversationId);
});

test('competing new requests are busy while switching and stale after commit', async (t) => {
  const f = await fixture(t);
  const entered = f.hold();
  const release = f.hold();
  f.activity.collect = async () => { entered.resolve(); await release.promise; return []; };
  const request = f.request();
  const changing = f.service.dispatch('conversation.new', request);
  await entered.promise;
  const duplicate = f.service.dispatch('conversation.new', request);
  try {
    await assert.rejects(f.service.dispatch('conversation.new', { ...request, requestId: 'competitor' }), busy);
    assert.equal(f.repo.getGroup(f.group.groupId).activeConversationId, request.expectedConversationId);
  } finally { release.resolve(); }
  const committed = await changing;
  const replay = await duplicate;
  assert.equal(replay.created, false);
  assert.deepEqual(replay.conversation, committed.conversation);
  assert.equal(f.frames.filter((frame) => frame.type === 'conversation.started').length, 1);
  await assert.rejects(f.service.dispatch('conversation.new', { ...request, requestId: 'competitor' }), (error) => error.code === 'stale-conversation' && error.details.currentConversationId === committed.currentConversationId);
  assert.equal(f.repo.conversationsOf(f.group.groupId).length, 2);
  assert.equal(f.calls.creates, 0);
});

test('a new conversation holds admission and publishes SSE only after durable pointer commit', async (t) => {
  const f = await fixture(t);
  const request = f.request();
  const beforeMembers = structuredClone(f.repo.membersOf(f.group.groupId));
  const entered = f.hold();
  const release = f.hold();
  f.storage.beforePut = async (name, value) => {
    if (name === 'groups' && value.groupId === f.group.groupId && value.activeConversationId !== request.expectedConversationId) { entered.resolve(); await release.promise; }
  };
  const observed = [];
  f.service.bus.subscribe(f.group.groupId, (frame) => {
    if (frame.type === 'conversation.started') observed.push({ frame, stored: structuredClone(f.records.get('groups').get(f.group.groupId)) });
  });
  const changing = f.service.dispatch('conversation.new', request);
  await entered.promise;
  try {
    assert.equal(f.repo.getGroup(f.group.groupId).activeConversationId, request.expectedConversationId);
    assert.equal(f.records.get('groups').get(f.group.groupId).activeConversationId, request.expectedConversationId);
    assert.equal(f.repo.conversationsOf(f.group.groupId).length, 1, 'Prepared orphan is invisible');
    assert.deepEqual(f.repo.membersOf(f.group.groupId), beforeMembers);
    assert.equal(observed.length, 0);
    const restarted = await openRepository({ storageDomain: { open: async () => f.domain } }, null);
    assert.equal(restarted.activeConversation(f.group.groupId).conversationId, request.expectedConversationId);
    await assert.rejects(f.service.dispatch('message.post', { groupId: f.group.groupId, text: 'Must remain a draft', expectedConversationId: request.expectedConversationId }), busy);
    await assert.rejects(f.service.dispatch('group.update', { groupId: f.group.groupId, title: 'Must not overwrite the head' }), busy);
    await assert.rejects(f.service.dispatch('member.update', { membershipId: beforeMembers[0].membershipId, enabled: false }), busy);
    await assert.rejects(f.service.dispatch('group.workspace.set', { groupId: f.group.groupId, workspaceCwd: '' }), busy);
    await assert.rejects(f.service.listSkills(f.group.groupId), busy);
    assert.equal(f.repo.messagesOf(f.group.groupId).length, 0);
    assert.equal(f.service.engine.queue.length, 0);
  } finally { release.resolve(); }
  const result = await changing;
  assert.equal(observed.length, 1);
  assert.equal(observed[0].stored.activeConversationId, result.currentConversationId);
  assert.equal(observed[0].frame.currentConversationId, result.currentConversationId);
  assert.doesNotThrow(() => f.service.assertWorkspaceStable(f.group.groupId));
});

for (const table of ['conversations', 'groups']) test('a failed ' + table + ' write keeps the old pointer and allows a clean retry', async (t) => {
  const f = await fixture(t);
  const request = f.request();
  const oldGroup = structuredClone(f.repo.getGroup(f.group.groupId));
  const oldMembers = structuredClone(f.repo.membersOf(f.group.groupId));
  f.storage.failPut = (name, value) => name === table && value.groupId === f.group.groupId && (name === 'conversations' ? value.requestId === request.requestId : value.activeConversationId !== request.expectedConversationId);
  await assert.rejects(f.service.dispatch('conversation.new', request), hasCode('storage-failed'));
  assert.deepEqual(f.repo.getGroup(f.group.groupId), oldGroup);
  assert.deepEqual(f.records.get('groups').get(f.group.groupId), oldGroup);
  assert.deepEqual(f.repo.membersOf(f.group.groupId), oldMembers);
  assert.equal(f.repo.conversationsOf(f.group.groupId).length, 1);
  assert.equal(f.frames.filter((frame) => frame.type === 'conversation.started').length, 0);
  assert.doesNotThrow(() => f.service.assertWorkspaceStable(f.group.groupId));
  const restarted = await openRepository({ storageDomain: { open: async () => f.domain } }, null);
  assert.equal(restarted.activeConversation(f.group.groupId).conversationId, request.expectedConversationId);
  assert.equal(restarted.conversationsOf(f.group.groupId).length, 1);
  f.storage.failPut = null;
  const retry = await f.service.dispatch('conversation.new', request);
  assert.equal(retry.created, true);
  assert.equal(f.repo.conversationsOf(f.group.groupId).length, 2);
});

test('partially failed handle disposal keeps every member mapping and the old pointer', async (t) => {
  const f = await fixture(t);
  const request = f.request();
  const members = structuredClone(f.repo.membersOf(f.group.groupId));
  const disposed = [];
  t.mock.method(f.service.pool, 'disposeMember', async (id) => {
    disposed.push(id);
    if (disposed.length === 2) throw new Error('native flush/dispose failed');
  });
  await assert.rejects(f.service.dispatch('conversation.new', request), hasCode('session-release-failed'));
  assert.equal(disposed.length, 2);
  assert.deepEqual(f.repo.membersOf(f.group.groupId), members);
  assert.equal(f.repo.getGroup(f.group.groupId).activeConversationId, request.expectedConversationId);
  assert.equal(f.records.get('groups').get(f.group.groupId).activeConversationId, request.expectedConversationId);
  assert.ok(f.repo.membersOf(f.group.groupId).every((member) => isCurrentMemberSession(f.repo, member)));
  assert.equal(f.repo.conversationsOf(f.group.groupId).length, 1);
  assert.equal(f.frames.filter((frame) => frame.type === 'conversation.started').length, 0);
  assert.doesNotThrow(() => f.service.assertWorkspaceStable(f.group.groupId));
});

test('a failed pending input write prevents conversation switch until that write is repaired', async (t) => {
  const f = await fixture(t);
  const request = f.request();
  f.storage.failPut = (name, value) => name === 'messages' && value.text === 'not yet durable';
  const input = f.service.engine.createMessage({ groupId: f.group.groupId, author: { type: 'human' }, text: 'not yet durable' });
  await assert.rejects(f.repo.flushGroupWrites(f.group.groupId), hasCode('persistence-failed'));
  let disposed = 0;
  t.mock.method(f.service.pool, 'disposeMember', async () => { disposed += 1; });
  await assert.rejects(f.service.dispatch('conversation.new', request), hasCode('storage-failed'));
  assert.equal(disposed, 0);
  assert.equal(f.repo.getGroup(f.group.groupId).activeConversationId, request.expectedConversationId);
  assert.equal(f.frames.filter((frame) => frame.type === 'conversation.started').length, 0);
  assert.doesNotThrow(() => f.service.assertWorkspaceStable(f.group.groupId));
  f.storage.failPut = null;
  await f.repo.putMessageStrict(input);
  await f.repo.flushGroupWrites(f.group.groupId);
  const result = await f.service.dispatch('conversation.new', request);
  assert.equal(result.conversation.afterSeq, input.seq);
});

test('new conversation rechecks native activity after old handles are released', async (t) => {
  const f = await fixture(t);
  const request = f.request();
  let released = false;
  t.mock.method(f.service.pool, 'disposeMember', async () => { released = true; });
  f.activity.collect = async () => released ? [{ kind: 'native-job', code: 'conversation-busy', groupId: f.group.groupId, message: 'Background work appeared' }] : [];
  await assert.rejects(f.service.dispatch('conversation.new', request), (error) => error.code === 'conversation-busy' && error.details.blockers.some((item) => item.kind === 'native-job'));
  assert.equal(f.repo.getGroup(f.group.groupId).activeConversationId, request.expectedConversationId);
  assert.equal(f.repo.conversationsOf(f.group.groupId).length, 1);
  assert.equal(f.frames.filter((frame) => frame.type === 'conversation.started').length, 0);
});

test('settings validation and skill preparation each reserve conversation admission', async (t) => {
  for (const kind of ['settings', 'skills']) await t.test(kind, async (t) => {
    const f = await fixture(t);
    const entered = f.hold();
    const release = f.hold();
    const request = f.request();
    let operation;
    if (kind === 'settings') {
      t.mock.method(f.service, 'requireFolder', async () => { entered.resolve(); await release.promise; return null; });
      operation = f.service.dispatch('group.update', { groupId: f.group.groupId, title: 'Renamed', folderId: null });
    } else {
      t.mock.method(f.service.pool, 'ensure', async () => { entered.resolve(); await release.promise; return { id: 'skill-only' }; });
      operation = f.service.listSkills(f.group.groupId);
    }
    await entered.promise;
    let observed;
    const attempt = f.service.dispatch('conversation.new', request).then((value) => ({ value }), (error) => ({ error }));
    void attempt.then((outcome) => { observed = outcome; });
    await new Promise((resolve) => setImmediate(resolve));
    const beforeRelease = observed;
    const pointerBeforeRelease = f.repo.getGroup(f.group.groupId).activeConversationId;
    release.resolve();
    await operation;
    await attempt;
    await f.repo.flushGroupWrites(f.group.groupId);
    assert.equal(pointerBeforeRelease, request.expectedConversationId);
    assert.equal(beforeRelease?.error?.code, 'conversation-busy', 'Pending ' + kind + ' must reject new conversation before its preparation/persistence finishes');
    const switched = await f.service.dispatch('conversation.new', request);
    assert.equal(switched.created, true);
  });
});

test('accepted input persistence drains before conversation commit and contributes to its boundary', async (t) => {
  const f = await fixture(t);
  const entered = f.hold();
  const release = f.hold();
  const request = f.request();
  f.storage.beforePut = async (name, value) => {
    if (name === 'messages' && value.groupId === f.group.groupId) { entered.resolve(); await release.promise; }
  };
  const sending = f.service.dispatch('message.post', { groupId: f.group.groupId, text: 'Persisting input', mentions: [], expectedConversationId: request.expectedConversationId });
  await entered.promise;
  await sending;
  let settled = false;
  const changing = f.service.dispatch('conversation.new', request);
  void changing.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(settled, false, 'A successful response must wait for the admitted input to become durable');
    assert.equal(f.repo.getGroup(f.group.groupId).activeConversationId, request.expectedConversationId);
    assert.equal(f.records.get('groups').get(f.group.groupId).activeConversationId, request.expectedConversationId);
    assert.equal(f.frames.filter((frame) => frame.type === 'conversation.started').length, 0);
    await assert.rejects(f.service.dispatch('message.post', { groupId: f.group.groupId, text: 'Late input', expectedConversationId: request.expectedConversationId }), busy);
  } finally { release.resolve(); }
  const result = await changing;
  const input = f.repo.messagesOf(f.group.groupId)[0];
  assert.equal(result.conversation.afterSeq, input.seq);
  assert.equal(input.conversationId, request.expectedConversationId);
  assert.equal(f.records.get('messages').get(input.messageId).text, 'Persisting input');
  assert.equal(f.frames.filter((frame) => frame.type === 'conversation.started').length, 1);
});

for (const source of ['interactions', 'SSE']) test('a postcommit ' + source + ' failure cannot roll back or misreport the durable conversation', async (t) => {
  const f = await fixture(t);
  const request = f.request();
  if (source === 'interactions') t.mock.method(f.service.interactions, 'reconcile', () => { throw new Error('Interaction refresh failed'); });
  else t.mock.method(f.service.bus, 'emit', () => { throw new Error('SSE disconnected'); });
  const result = await f.service.dispatch('conversation.new', request);
  assert.equal(result.created, true);
  assert.equal(f.repo.getGroup(f.group.groupId).activeConversationId, result.currentConversationId);
  assert.equal(f.records.get('groups').get(f.group.groupId).activeConversationId, result.currentConversationId);
  const replay = await f.service.dispatch('conversation.new', request);
  assert.equal(replay.created, false);
  assert.equal(replay.currentConversationId, result.currentConversationId);
  assert.equal(f.repo.conversationsOf(f.group.groupId).length, 2);
  assert.doesNotThrow(() => f.service.assertWorkspaceStable(f.group.groupId));
});

test('queued, running, settling and preparing work all block a conversation switch', async (t) => {
  const f = await fixture(t);
  const request = f.request();
  const membershipId = f.repo.membersOf(f.group.groupId)[0].membershipId;
  const job = { groupId: f.group.groupId, membershipId, finished: false };
  const cases = [
    [() => f.service.engine.queue.push(job), () => { f.service.engine.queue = []; }],
    [() => f.service.engine.running.set(membershipId, job), () => f.service.engine.running.clear()],
    [() => f.service.engine.pendingWork.add(job), () => f.service.engine.pendingWork.clear()],
    [() => f.service.pool.preparing.set(membershipId, Promise.resolve()), () => f.service.pool.preparing.clear()],
  ];
  for (const [enter, leave] of cases) {
    enter();
    try { await assert.rejects(f.service.dispatch('conversation.new', request), busy); }
    finally { leave(); }
    assert.equal(f.repo.getGroup(f.group.groupId).activeConversationId, request.expectedConversationId);
  }
  await f.repo.putDiscussion({ discussionId: 'active-discussion', groupId: f.group.groupId, topic: 'Still discussing', status: 'running' });
  await assert.rejects(f.service.dispatch('conversation.new', request), busy);
  await f.repo.deleteDiscussion('active-discussion');
  assert.equal((await f.service.dispatch('conversation.new', request)).created, true);
});

test('historical tasks remain readable but cannot dispatch, form new dependencies or auto unblock', async (t) => {
  const f = await fixture(t);
  const member = f.repo.membersOf(f.group.groupId)[0];
  const taskInput = { groupId: f.group.groupId, assigneeMembershipId: member.membershipId };
  const parent = await f.service.createTask({ ...taskInput, title: 'Old parent' });
  const dependent = await f.service.createTask({ ...taskInput, title: 'Old dependent', dependsOn: [parent.taskId] });
  const beforeParent = structuredClone(f.repo.getTask(parent.taskId));
  await f.service.dispatch('conversation.new', f.request());
  await assert.rejects(f.service.dispatch('task.dispatch', { taskId: parent.taskId }), hasCode('historical-target'));
  await assert.rejects(f.service.createTask({ ...taskInput, title: 'New task with old dependency', dependsOn: [parent.taskId] }), hasCode('historical-target'));
  assert.deepEqual(f.service.listTasks(f.group.groupId), []);
  assert.equal(f.service.listTasks(f.group.groupId, { includeHistorical: true }).length, 2);
  assert.deepEqual((await f.service.dispatchReadyTasks({ groupId: f.group.groupId })).dispatched, []);
  assert.deepEqual(await f.service.unblockDependents({ ...parent, status: 'accepted' }), []);
  await f.service.onTaskJobFinished({ kind: 'review', groupId: f.group.groupId, conversationId: parent.conversationId, meta: { taskId: parent.taskId } }, { messageId: 'late-review', meta: { verdict: 'pass' } }, 'done');
  assert.deepEqual(f.repo.getTask(parent.taskId), beforeParent);
  assert.equal(f.repo.getTask(dependent.taskId).status, 'pending');
  assert.equal(f.service.engine.queue.length, 0);
  const current = await f.service.createTask({ ...taskInput, title: 'Current parent' });
  const next = await f.service.createTask({ ...taskInput, title: 'Current dependent', dependsOn: [current.taskId] });
  await f.repo.putTask({ ...current, status: 'accepted' });
  t.mock.method(f.service.engine, 'pump', () => {});
  await f.service.unblockDependents(f.repo.getTask(current.taskId));
  assert.equal(f.repo.getTask(next.taskId).status, 'in_progress');
  assert.equal(f.repo.getTask(dependent.taskId).status, 'pending');
  assert.equal(f.service.engine.queue.length, 1);
  assert.equal(f.calls.creates, 0);
});
