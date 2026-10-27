import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openRepository } from '../host/domain.js';
import { BotTeamService } from '../host/service.js';
import { GroupBus } from '../host/util.js';
import { directGroupIdFor, directMembershipIdFor, sortByOrder } from '../host/layout.js';

/** In-memory storage-domain double (same shape the Host storage service exposes). */
function memoryDomain(seed = {}) {
  const tables = new Map();
  for (const [name, records] of Object.entries(seed)) {
    const map = new Map();
    for (const record of records) map.set(recordKey(name, record), structuredClone(record));
    tables.set(name, map);
  }
  const domain = {
    table(name) {
      if (!tables.has(name)) tables.set(name, new Map());
      const records = tables.get(name);
      return {
        entries: () => [...records.entries()].map(([key, value]) => [key, structuredClone(value)]),
        async put(key, value) { records.set(key, structuredClone(value)); },
        async delete(key) { records.delete(key); },
      };
    },
    async close() {},
  };
  return domain;
}

function recordKey(table, record) {
  if (table === 'bots') return record.botId;
  if (table === 'groups') return record.groupId;
  if (table === 'folders') return record.folderId;
  if (table === 'members') return record.membershipId;
  if (table === 'messages') return record.messageId;
  if (table === 'discussions') return record.discussionId;
  if (table === 'tasks') return record.taskId;
  if (table === 'meta') return record.key;
  return record.id;
}

async function fixture(options = {}) {
  const domain = options.domain || memoryDomain(options.seed);
  const repo = await openRepository({ storageDomain: { open: async () => domain } }, null);
  if (options.schema !== undefined) await repo.putMeta('schema', { version: options.schema });
  const dataDir = options.dataDir || await mkdtemp(path.join(os.tmpdir(), 'bot-team-data-'));
  const service = Object.assign(Object.create(BotTeamService.prototype), {
    ready: Promise.resolve(),
    repo,
    config: {
      dataDir,
      defaultCwd: dataDir,
      maxGroups: 50,
      maxMembersPerGroup: 12,
      maxMessageChars: 40000,
      maxTurnsPerHour: 120,
      dailyTokenBudget: 5000000,
      maxParallelTurns: 3,
      botsDir: path.join(dataDir, 'bots'),
      migrateLegacyLayout: false,
      botSandbox: true,
      botApprovalPolicy: 'ask',
    },
    logger: null,
    bus: new GroupBus(),
    personas: { preload: async () => {}, get: () => ({ text: '' }) },
    pool: { disposeMember: async () => {} },
    engine: {
      running: new Map(),
      isRunning: () => false,
      queueSnapshot: () => [],
      runningCount: () => 0,
      queuedCount: () => 0,
      stopMember() {},
      stopGroup() {},
      postHumanMessage() { throw new Error('engine stub: postHumanMessage not configured'); },
    },
    smokeState: null,
    getModelCatalog: async () => ({ default: null, groups: [], failures: [] }),
  });
  return { service, repo, domain };
}

const botInput = (name) => ({ name, provider: 'deepseek', model: 'deepseek-chat' });

test('creating a bot creates exactly one direct chat with one member and opens it', async () => {
  const { service, repo } = await fixture();
  const bot = await service.createBot(botInput('Timi'));
  assert.ok(bot.directGroupId);
  const direct = repo.getGroup(bot.directGroupId);
  assert.equal(direct.kind, 'direct');
  assert.equal(direct.botId, bot.botId);
  assert.equal(direct.title, 'Timi');
  assert.equal(direct.workspaceCwd, path.join(service.config.dataDir, 'direct', bot.botId));
  assert.equal((await stat(direct.workspaceCwd)).isDirectory(), true);
  assert.equal(direct.groupId, directGroupIdFor(bot.botId));
  const members = repo.membersOf(direct.groupId);
  assert.equal(members.length, 1);
  assert.equal(members[0].botId, bot.botId);
  assert.equal(members[0].membershipId, directMembershipIdFor(bot.botId));

  // Idempotent: opening the chat again never creates a second direct group.
  const opened = await service.openDirect({ botId: bot.botId });
  assert.equal(opened.groupId, direct.groupId);
  assert.equal(service.directGroups().length, 1);
  assert.equal(service.groupChats().length, 0);
  const bootstrap = await service.bootstrapPayload();
  assert.equal(bootstrap.groups.find((group) => group.groupId === direct.groupId).kind, 'direct');
  assert.deepEqual(bootstrap.folders, []);
});

test('renaming a bot renames its direct chat; deleting the bot removes the chat and its messages', async () => {
  const { service, repo } = await fixture();
  const bot = await service.createBot(botInput('Mochi'));
  const direct = repo.getGroup(bot.directGroupId);
  const posted = [];
  service.engine.postHumanMessage = (payload) => {
    posted.push(payload);
    return { message: { groupId: payload.groupId, seq: 1 }, accepted: payload.mentions };
  };
  await service.postMessage({ groupId: direct.groupId, text: '你好' });
  assert.deepEqual(posted[0].mentions, [directMembershipIdFor(bot.botId)]);

  await service.updateBot({ botId: bot.botId, name: 'Mochi 2' });
  assert.equal(repo.getGroup(bot.directGroupId).title, 'Mochi 2');

  const group = await service.createGroup({ title: '普通群' });
  await service.addMember({ groupId: group.groupId, botId: bot.botId });
  assert.equal(repo.membersOf(group.groupId).length, 1);

  const removed = await service.deleteBot({ botId: bot.botId });
  assert.equal(repo.getBot(bot.botId), undefined);
  assert.equal(repo.getGroup(direct.groupId), undefined);
  assert.deepEqual(removed.removedDirectGroupIds, [direct.groupId]);
  assert.equal(repo.membersOf(group.groupId).length, 0, 'membership in normal groups is removed too');
  assert.equal(repo.membersOf(direct.groupId).length, 0);
});

test('single chats auto-target the bot, while group chats still need an @ mention', async () => {
  const { service, repo } = await fixture();
  const botA = await service.createBot(botInput('Alpha'));
  const botB = await service.createBot(botInput('Beta'));
  const direct = repo.getGroup(botA.directGroupId);
  const group = await service.createGroup({ title: '评审群' });
  const memberA = await service.addMember({ groupId: group.groupId, botId: botA.botId });
  const memberB = await service.addMember({ groupId: group.groupId, botId: botB.botId });

  const posted = [];
  service.engine.postHumanMessage = (payload) => {
    posted.push(payload);
    return { message: { seq: 1 }, accepted: payload.mentions };
  };

  await service.postMessage({ groupId: direct.groupId, text: '在吗' });
  assert.deepEqual(posted.pop().mentions, [directMembershipIdFor(botA.botId)]);

  await service.postMessage({ groupId: direct.groupId, text: '再问一句', mentions: [] });
  assert.deepEqual(posted.pop().mentions, [directMembershipIdFor(botA.botId)], 'explicit empty mentions are ignored in DM');

  await service.postMessage({ groupId: group.groupId, text: '大家好' });
  assert.deepEqual(posted.pop().mentions, [], 'no @ means no bot reply in a group');

  await service.postMessage({ groupId: group.groupId, text: '@Beta 看一下' });
  assert.deepEqual(posted.pop().mentions, [memberB.membershipId]);

  await service.postMessage({ groupId: group.groupId, text: '都看一下', mentions: [memberA.membershipId] });
  assert.deepEqual(posted.pop().mentions, [memberA.membershipId]);
});

test('direct chats cannot be deleted, renamed or grow members', async () => {
  const { service } = await fixture();
  const bot = await service.createBot(botInput('Solo'));
  const direct = await service.openDirect({ botId: bot.botId });
  await assert.rejects(() => service.deleteGroup({ groupId: direct.groupId }), /单聊由 Bot 自动创建/);
  await assert.rejects(() => service.updateGroup({ groupId: direct.groupId, title: 'Other' }), /单聊名称/);
  await assert.rejects(() => service.addMember({ groupId: direct.groupId, botId: bot.botId }), /单聊只能有一个 Bot/);
  const member = service.repo.membersOf(direct.groupId)[0];
  await assert.rejects(() => service.removeMember({ membershipId: member.membershipId }), /单聊成员/);
  // Group-only workflows stay out of the one-to-one channel.
  await assert.rejects(
    () => service.createTask({ groupId: direct.groupId, title: '任务', assigneeMembershipId: member.membershipId }),
    /单聊不支持任务板/,
  );
  await assert.rejects(
    () => service.startDiscussion({ groupId: direct.groupId, topic: '讨论' }),
    /单聊不支持多轮讨论/,
  );
  await assert.rejects(
    () => service.requestReview({
      groupId: direct.groupId,
      targetMessageId: 'msg-x',
      reviewerMembershipId: member.membershipId,
    }),
    /单聊不支持评审/,
  );
});

test('folders group chats, move them with an explicit order, and deleting a folder keeps its groups', async () => {
  const { service, repo } = await fixture();
  const alpha = await service.createFolder({ title: '工作' });
  const beta = await service.createFolder({ title: '生活' });
  assert.deepEqual((await service.reorderFolders({ orderedIds: [beta.folderId, alpha.folderId] })).folders.map((f) => f.title), ['生活', '工作']);
  const bootstrap = await service.bootstrapPayload();
  assert.deepEqual(bootstrap.folders.map((folder) => folder.title), ['生活', '工作']);
  assert.equal(bootstrap.folders[0].folderId, beta.folderId);
  await assert.rejects(() => service.createFolder({ title: '工作' }), /已存在同名分组/);

  const g1 = await service.createGroup({ title: 'G1', folderId: alpha.folderId });
  const g2 = await service.createGroup({ title: 'G2', folderId: alpha.folderId });
  const g3 = await service.createGroup({ title: 'G3' });
  assert.equal(g1.order, 0);
  assert.equal(g2.order, 1);
  assert.equal(g3.order, 0);
  assert.equal(g3.folderId, null);

  // Reorder inside one folder.
  await service.reorderGroups({
    kind: 'group',
    folderId: alpha.folderId,
    orderedIds: [g2.groupId, g1.groupId],
  });
  assert.deepEqual(service.groupsInFolder(alpha.folderId).map((group) => group.groupId), [g2.groupId, g1.groupId]);
  assert.deepEqual(service.groupsInFolder(null).map((group) => group.groupId), [g3.groupId]);

  // Move G3 into the folder at the front, in one action.
  await service.reorderGroups({
    kind: 'group',
    folderId: alpha.folderId,
    movedGroupId: g3.groupId,
    orderedIds: [g3.groupId, g2.groupId, g1.groupId],
  });
  assert.equal(repo.getGroup(g3.groupId).folderId, alpha.folderId);
  assert.deepEqual(service.groupsInFolder(alpha.folderId).map((group) => group.groupId), [g3.groupId, g2.groupId, g1.groupId]);
  assert.deepEqual(service.groupsInFolder(null), []);

  // Explicit folder assignment through group.update appends at the end.
  const g4 = await service.createGroup({ title: 'G4' });
  await service.updateGroup({ groupId: g4.groupId, folderId: beta.folderId });
  assert.equal(repo.getGroup(g4.groupId).folderId, beta.folderId);
  assert.deepEqual(service.groupsInFolder(beta.folderId).map((group) => group.groupId), [g4.groupId]);

  // A short/stale order list never drops records: omitted ids are appended.
  await service.reorderGroups({ kind: 'group', folderId: alpha.folderId, orderedIds: [g1.groupId] });
  const all = sortByOrder(service.groupsInFolder(alpha.folderId)).map((group) => group.groupId);
  assert.equal(all[0], g1.groupId);
  assert.equal(all.length, 3);

  const deleted = await service.deleteFolder({ folderId: alpha.folderId });
  assert.equal(deleted.movedGroups.length, 3);
  assert.ok(repo.getGroup(g1.groupId));
  assert.equal(repo.getGroup(g1.groupId).folderId, null);
  const ungrouped = sortByOrder(service.groupsInFolder(null)).map((group) => group.groupId);
  assert.ok(ungrouped.includes(g3.groupId));
  assert.equal(repo.getFolder(alpha.folderId), undefined);
});

test('direct chats keep their own custom order, separate from group chats', async () => {
  const { service, repo } = await fixture();
  const first = await service.createBot(botInput('First'));
  const second = await service.createBot(botInput('Second'));
  assert.deepEqual(service.directGroups().map((group) => group.title), ['First', 'Second']);
  await service.reorderGroups({
    kind: 'direct',
    movedGroupId: repo.getGroup(second.directGroupId).groupId,
    orderedIds: [second.directGroupId, first.directGroupId],
  });
  assert.deepEqual(service.directGroups().map((group) => group.title), ['Second', 'First']);
  // Direct chats can never be put into a folder.
  await assert.rejects(
    () => service.updateGroup({ groupId: repo.getGroup(first.directGroupId).groupId, folderId: 'fld-x' }),
    /单聊不能放进分组/,
  );
  // Neither can a mixed direct/group reorder be smuggled through the API.
  const group = await service.createGroup({ title: '普通群' });
  await assert.rejects(
    () => service.reorderGroups({
      kind: 'direct',
      movedGroupId: group.groupId,
      orderedIds: [group.groupId, first.directGroupId],
    }),
    /不能在同一个列表里排序/,
  );
  await assert.rejects(
    () => service.reorderGroups({ kind: 'group', folderId: 'missing-folder', orderedIds: [group.groupId] }),
    /分组不存在/,
  );
});

test('group workspace defaults under dataDir/groups and an empty edit restores that default', async () => {
  const { service, repo } = await fixture();
  const group = await service.createGroup({ title: '工作目录群' });
  const fallback = path.join(service.config.dataDir, 'groups', group.groupId);
  assert.equal(group.workspaceCwd, fallback);
  assert.equal((await stat(fallback)).isDirectory(), true);

  await mkdir(path.join(service.config.dataDir, 'custom-workspace'));
  const custom = await realpath(path.join(service.config.dataDir, 'custom-workspace'));
  await service.updateGroup({ groupId: group.groupId, workspaceCwd: custom });
  assert.equal(repo.getGroup(group.groupId).workspaceCwd, custom);
  assert.equal((await stat(custom)).isDirectory(), true);

  await service.updateGroup({ groupId: group.groupId, workspaceCwd: '' });
  assert.equal(repo.getGroup(group.groupId).workspaceCwd, fallback);
});

test('schema v5 data migrates to v6: groups get ordering and every existing bot gets a direct chat', async () => {
  const at = 1761500000000;
  const seed = {
    bots: [
      { botId: 'bot-a', name: 'Alpha', provider: 'deepseek', model: 'x', capability: 'work', createdAt: at, updatedAt: at },
      { botId: 'bot-b', name: 'Beta', provider: 'deepseek', model: 'x', capability: 'work', createdAt: at + 1, updatedAt: at + 1 },
    ],
    groups: [
      { groupId: 'grp-old-1', title: '旧群一', nextSeq: 2, createdAt: at, updatedAt: at + 10 },
      { groupId: 'grp-old-2', title: '旧群二', nextSeq: 0, createdAt: at - 10, updatedAt: at - 5 },
    ],
    members: [
      { membershipId: 'mem-old', groupId: 'grp-old-1', botId: 'bot-a', order: 0, sessionId: 'session-old', enabled: true, lastSeenSeq: 0, createdAt: at, updatedAt: at },
    ],
    meta: [{ key: 'schema', version: 5 }],
  };
  const domain = memoryDomain(seed);
  const { service, repo } = await fixture({ domain, schema: 5 });
  const migration = await repo.runMigrations();
  assert.equal(migration.version, 6);
  assert.deepEqual(migration.applied, [5]);
  assert.equal(repo.schemaVersion(), 6);
  const old = repo.getGroup('grp-old-1');
  assert.equal(old.kind, 'group');
  assert.equal(old.folderId, null);
  assert.equal(Number.isInteger(old.order), true);
  assert.equal(repo.getGroup('grp-old-2').kind, 'group');

  assert.deepEqual(repo.allFolders(), []);
  const directs = service.directGroups().sort((a, b) => a.title.localeCompare(b.title));
  assert.equal(directs.length, 2);
  assert.deepEqual(directs.map((group) => group.botId), ['bot-a', 'bot-b']);
  for (const direct of directs) {
    assert.equal(direct.groupId, directGroupIdFor(direct.botId));
    assert.equal(repo.membersOf(direct.groupId).length, 1);
  }
  const bootstrap = await service.bootstrapPayload();
  assert.equal(bootstrap.directGroupCount, 2);
  assert.equal(bootstrap.groups.filter((group) => group.kind === 'group').length, 2);

  // Re-running is a no-op (idempotent direct chat creation).
  const again = await repo.runMigrations();
  assert.deepEqual(again.applied, []);
  assert.equal(service.directGroups().length, 2);
});
