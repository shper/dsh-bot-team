/**
 * Durable repository for Bot Team, backed by the Host storage-domain service.
 *
 * Layout: one domain `bot_team` (per-record), mapped by storage-layout.js to the
 * physical `dsh-bot-team` directory, with the tables bots / groups /
 * folders / members / messages / meta. Records are plain JSON; the domain calls each
 * table's `parse` when loading stored records (see `recordSchema`). Memory is
 * authoritative for reads; every write awaits backend durability through the
 * domain's per-domain write chain.
 *
 * Keys are path-safe (`[a-zA-Z0-9_-]` only) because the JSON backend maps one
 * record key to one file (M0 finding P3).
 */
import { now, recordSchema } from './util.js';
import { directGroupIdFor, directMembershipIdFor, directSessionIdFor } from './layout.js';

export const DOMAIN_NAME = 'bot_team';
export const DOMAIN_VERSION = 1;
/** Record-shape schema version stored in the meta table (domain version stays 1 by design). */
export const SCHEMA_VERSION = 6;

function sortBySeq(list) {
  list.sort((a, b) => a.seq - b.seq);
  return list;
}

export async function openRepository(ctx, logger, openDomain = spec => ctx.storageDomain.open(spec)) {
  const domain = await openDomain({
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    layout: 'per-record',
    tables: {
      bots: { valueSchema: recordSchema('bots', ['botId', 'name', 'provider', 'model', 'capability']) },
      groups: { valueSchema: recordSchema('groups', ['groupId', 'title']) },
      folders: { valueSchema: recordSchema('folders', ['folderId', 'title']) },
      members: { valueSchema: recordSchema('members', ['membershipId', 'groupId', 'botId', 'sessionId']) },
      messages: { valueSchema: recordSchema('messages', ['messageId', 'groupId', 'seq']) },
      discussions: { valueSchema: recordSchema('discussions', ['discussionId', 'groupId', 'topic']) },
      tasks: { valueSchema: recordSchema('tasks', ['taskId', 'groupId', 'title']) },
      meta: { valueSchema: recordSchema('meta', []) },
    },
  });

  const bots = new Map();
  const groups = new Map();
  const folders = new Map();
  const members = new Map();
  const messages = new Map();
  const discussions = new Map();
  const tasks = new Map();
  const meta = new Map();
  const messagesByGroup = new Map();

  for (const [key, value] of domain.table('bots').entries()) bots.set(key, value);
  for (const [key, value] of domain.table('groups').entries()) {
    const group = { nextSeq: 0, ...value };
    // Normalize fields added in schema v6 so every in-memory record is complete
    // even before (or without) the migration write.
    if (group.kind !== 'direct') group.kind = 'group';
    if (group.folderId === undefined) group.folderId = null;
    // `order` intentionally stays undefined when missing: the v6 migration uses
    // that to assign the pre-upgrade display order exactly once.
    groups.set(key, group);
  }
  for (const [key, value] of domain.table('folders').entries()) {
    const folder = { ...value };
    if (!Number.isInteger(folder.order)) folder.order = 0;
    folders.set(key, folder);
  }
  for (const [key, value] of domain.table('members').entries()) members.set(key, value);
  for (const [key, value] of domain.table('messages').entries()) {
    messages.set(key, value);
    const list = messagesByGroup.get(value.groupId) ?? [];
    list.push(value);
    messagesByGroup.set(value.groupId, list);
  }
  for (const list of messagesByGroup.values()) sortBySeq(list);
  for (const [key, value] of domain.table('discussions').entries()) discussions.set(key, value);
  for (const [key, value] of domain.table('tasks').entries()) tasks.set(key, value);
  for (const [key, value] of domain.table('meta').entries()) meta.set(key, value);

  // Crash recovery: a previous process may have died mid-turn / mid-discussion.
  for (const message of messages.values()) {
    if (message.status === 'pending' || message.status === 'streaming') {
      message.status = 'error';
      message.error = 'Host 重启，该回复被中断，可重试';
      message.updatedAt = now();
      domain.table('messages').put(message.messageId, message).catch(() => {});
    }
    if (message.kind === 'approval' && message.meta && message.meta.approvalState === 'pending') {
      message.meta = { ...message.meta, approvalState: 'cancelled', decidedAt: now() };
      message.updatedAt = now();
      domain.table('messages').put(message.messageId, message).catch(() => {});
    }
  }
  for (const discussion of discussions.values()) {
    if (discussion.status === 'running') {
      discussion.status = 'stopped';
      discussion.stopReason = 'host-restart';
      discussion.updatedAt = now();
      domain.table('discussions').put(discussion.discussionId, discussion).catch(() => {});
    }
  }

  const warn = (label, error) => {
    try {
      logger?.warn?.(`bot-team: ${label}: ${String(error && error.message ? error.message : error)}`);
    } catch {
      /* logging must never break a write */
    }
  };

  // Make group sequence allocation consistent with stored messages after a restart.
  for (const group of groups.values()) {
    const list = messagesByGroup.get(group.groupId);
    const maxSeq = list && list.length > 0 ? list[list.length - 1].seq : 0;
    if (!Number.isInteger(group.nextSeq) || group.nextSeq < maxSeq) group.nextSeq = maxSeq;
  }

  const repo = {
    domain,
    bots,
    groups,
    folders,
    members,
    messages,
    meta,

    getBot(botId) {
      return bots.get(botId);
    },
    getGroup(groupId) {
      return groups.get(groupId);
    },
    getFolder(folderId) {
      return folders.get(folderId);
    },
    getMember(membershipId) {
      return members.get(membershipId);
    },
    getMeta(key) {
      return meta.get(key);
    },
    getMessage(messageId) {
      return messages.get(messageId);
    },
    allBots() {
      return [...bots.values()].sort((a, b) => a.createdAt - b.createdAt);
    },
    allGroups() {
      return [...groups.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    },
    allFolders() {
      return [...folders.values()].sort((a, b) => a.order - b.order || (a.createdAt ?? 0) - (b.createdAt ?? 0));
    },
    membersOf(groupId) {
      return [...members.values()]
        .filter((member) => member.groupId === groupId)
        .sort((a, b) => a.order - b.order);
    },
    membersOfBot(botId) {
      return [...members.values()].filter((member) => member.botId === botId);
    },
    messagesOf(groupId) {
      return [...(messagesByGroup.get(groupId) ?? [])];
    },
    messagesBetween(groupId, fromSeqExclusive, toSeqInclusive) {
      return (messagesByGroup.get(groupId) ?? []).filter(
        (message) => message.seq > fromSeqExclusive && message.seq <= toSeqInclusive,
      );
    },
    lastMessageOf(groupId) {
      const list = messagesByGroup.get(groupId);
      return list && list.length > 0 ? list[list.length - 1] : undefined;
    },
    getDiscussion(discussionId) {
      return discussions.get(discussionId);
    },
    getTask(taskId) {
      return tasks.get(taskId);
    },
    tasksOf(groupId) {
      return [...tasks.values()]
        .filter((task) => task.groupId === groupId)
        .sort((a, b) => a.createdAt - b.createdAt);
    },
    async putTask(task) {
      task.updatedAt = now();
      tasks.set(task.taskId, task);
      await domain.table('tasks').put(task.taskId, task);
      return task;
    },
    async deleteTask(taskId) {
      tasks.delete(taskId);
      await domain.table('tasks').delete(taskId).catch((error) => warn('delete task', error));
    },
    discussionsOf(groupId) {
      return [...discussions.values()]
        .filter((discussion) => discussion.groupId === groupId)
        .sort((a, b) => b.createdAt - a.createdAt);
    },
    activeDiscussionOf(groupId) {
      return repo.discussionsOf(groupId).find((discussion) => discussion.status === 'running');
    },
    async putDiscussion(discussion) {
      discussion.updatedAt = now();
      discussions.set(discussion.discussionId, discussion);
      await domain.table('discussions').put(discussion.discussionId, discussion);
      return discussion;
    },
    async deleteDiscussion(discussionId) {
      discussions.delete(discussionId);
      await domain.table('discussions').delete(discussionId).catch((error) => warn('delete discussion', error));
    },

    allocateSeq(groupId) {
      const group = groups.get(groupId);
      if (!group) throw new Error(`group ${groupId} does not exist`);
      group.nextSeq = (group.nextSeq ?? 0) + 1;
      group.updatedAt = now();
      domain.table('groups').put(groupId, group).catch((error) => warn('persist group seq', error));
      return group.nextSeq;
    },

    appendMessage(message) {
      messages.set(message.messageId, message);
      const list = messagesByGroup.get(message.groupId) ?? [];
      list.push(message);
      sortBySeq(list);
      messagesByGroup.set(message.groupId, list);
      return domain.table('messages').put(message.messageId, message).catch((error) => warn('persist message', error));
    },
    putMessage(message) {
      return repo.putMessageStrict(message).catch((error) => warn('persist message', error));
    },
    // Execution references must be durable before a prompt enters the agent inbox.
    // Unlike putMessage, this path lets the caller fail closed on storage errors.
    putMessageStrict(message) {
      messages.set(message.messageId, message);
      const list = messagesByGroup.get(message.groupId) ?? [];
      const index = list.findIndex((candidate) => candidate.messageId === message.messageId);
      if (index >= 0) list[index] = message;
      else list.push(message);
      sortBySeq(list);
      messagesByGroup.set(message.groupId, list);
      return domain.table('messages').put(message.messageId, message);
    },
    async deleteMessage(messageId) {
      const message = messages.get(messageId);
      if (!message) return false;
      messages.delete(messageId);
      const list = messagesByGroup.get(message.groupId) ?? [];
      const index = list.findIndex((candidate) => candidate.messageId === messageId);
      if (index >= 0) list.splice(index, 1);
      await domain.table('messages').delete(messageId).catch((error) => warn('delete message', error));
      return true;
    },

    async putBot(bot) {
      bot.updatedAt = now();
      bots.set(bot.botId, bot);
      await domain.table('bots').put(bot.botId, bot);
      return bot;
    },
    async deleteBot(botId) {
      bots.delete(botId);
      await domain.table('bots').delete(botId).catch((error) => warn('delete bot', error));
    },
    async putGroup(group) {
      group.updatedAt = now();
      groups.set(group.groupId, group);
      await domain.table('groups').put(group.groupId, group);
      return group;
    },
    async deleteGroup(groupId) {
      groups.delete(groupId);
      await domain.table('groups').delete(groupId).catch((error) => warn('delete group', error));
    },
    async putFolder(folder) {
      folder.updatedAt = now();
      folders.set(folder.folderId, folder);
      await domain.table('folders').put(folder.folderId, folder);
      return folder;
    },
    async deleteFolder(folderId) {
      folders.delete(folderId);
      await domain.table('folders').delete(folderId).catch((error) => warn('delete folder', error));
    },
    async putMember(member) {
      member.updatedAt = now();
      members.set(member.membershipId, member);
      await domain.table('members').put(member.membershipId, member);
      return member;
    },
    async deleteMember(membershipId) {
      members.delete(membershipId);
      await domain.table('members').delete(membershipId).catch((error) => warn('delete member', error));
    },
    touchMember(member) {
      member.updatedAt = now();
      members.set(member.membershipId, member);
      domain.table('members').put(member.membershipId, member).catch((error) => warn('touch member', error));
    },
    async putMeta(key, value) {
      await domain.table('meta').put(key, value);
      meta.set(key, value);
    },
    async clearGroupContent(groupId) {
      const memberList = repo.membersOf(groupId);
      for (const member of memberList) await repo.deleteMember(member.membershipId);
      for (const message of repo.messagesOf(groupId)) await repo.deleteMessage(message.messageId);
      for (const discussion of repo.discussionsOf(groupId)) await repo.deleteDiscussion(discussion.discussionId);
      for (const task of repo.tasksOf(groupId)) await repo.deleteTask(task.taskId);
    },
    schemaVersion() {
      const record = meta.get('schema');
      return record && Number.isInteger(record.version) ? record.version : 1;
    },
    /** Sequential in-place record migrations; each step persists before the next. */
    async runMigrations() {
      let version = repo.schemaVersion();
      const applied = [];
      if (version < 2) {
        for (const message of messages.values()) {
          let changed = false;
          if (message.kind === undefined) { message.kind = 'chat'; changed = true; }
          if (message.meta === undefined) { message.meta = null; changed = true; }
          if (message.status === undefined) { message.status = 'done'; changed = true; }
          if (message.usage === undefined) { message.usage = null; changed = true; }
          if (changed) {
            message.updatedAt = message.updatedAt || now();
            await domain.table('messages').put(message.messageId, message);
          }
        }
        for (const discussion of discussions.values()) {
          let changed = false;
          if (discussion.currentRound === undefined) { discussion.currentRound = 1; changed = true; }
          if (discussion.currentIndex === undefined) { discussion.currentIndex = 0; changed = true; }
          if (discussion.summarize === undefined) { discussion.summarize = false; changed = true; }
          if (changed) {
            discussion.updatedAt = now();
            await domain.table('discussions').put(discussion.discussionId, discussion);
          }
        }
        await repo.putMeta('schema', { version: 2, migratedAt: now() });
        version = 2;
        applied.push(1);
      }
      if (version < 3) {
        // v3 adds the tasks table; an additive table needs no record rewrite.
        await repo.putMeta('schema', { version: 3, migratedAt: now() });
        version = 3;
        applied.push(2);
      }
      if (version < 4) {
        // v4 adds task priority + dependency edges (defaults for existing tasks).
        for (const task of tasks.values()) {
          let changed = false;
          if (task.priority === undefined) { task.priority = 'normal'; changed = true; }
          if (task.dependsOn === undefined) { task.dependsOn = []; changed = true; }
          if (changed) {
            task.updatedAt = now();
            await domain.table('tasks').put(task.taskId, task);
          }
        }
        await repo.putMeta('schema', { version: 4, migratedAt: now() });
        version = 4;
        applied.push(3);
      }
      if (version < 5) {
        // v5: every bot is full-capability. Normalize the legacy tier field so
        // old talk/review bots are no longer restricted by the agent pool.
        for (const bot of bots.values()) {
          if (bot.capability !== 'work') {
            bot.capability = 'work';
            bot.updatedAt = now();
            await domain.table('bots').put(bot.botId, bot);
          }
        }
        await repo.putMeta('schema', { version: 5, migratedAt: now() });
        version = 5;
        applied.push(4);
      }
      if (version < 6) {
        // v6: direct chats + sidebar folders.
        // 1) Every existing group becomes a group chat with a dense `order`
        //    matching the list the user saw before (newest activity first).
        // 2) Every bot gets exactly one direct chat with a deterministic group
        //    and membership id, so the upgrade is idempotent and no bot loses
        //    the "single chat window" the new UI expects.
        const existing = [...groups.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
        let order = 0;
        for (const group of existing) {
          let changed = false;
          if (group.kind !== 'direct') {
            if (group.kind !== 'group') { group.kind = 'group'; changed = true; }
            if (group.folderId === undefined) { group.folderId = null; changed = true; }
            if (!Number.isInteger(group.order)) { group.order = order; changed = true; }
            order = Math.max(order, (Number.isInteger(group.order) ? group.order : -1) + 1);
          }
          if (changed) {
            group.updatedAt = group.updatedAt || now();
            await domain.table('groups').put(group.groupId, group);
          }
        }
        const sortedBots = [...bots.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
        let directOrder = 0;
        for (const group of groups.values()) {
          if (group.kind === 'direct' && Number.isInteger(group.order)) {
            directOrder = Math.max(directOrder, group.order + 1);
          }
        }
        for (const bot of sortedBots) {
          const at = now();
          let direct = [...groups.values()].find(
            (candidate) => candidate.kind === 'direct' && candidate.botId === bot.botId,
          );
          if (!direct) {
            const groupId = directGroupIdFor(bot.botId);
            if (groups.has(groupId)) continue;
            direct = {
              groupId,
              kind: 'direct',
              botId: bot.botId,
              title: bot.name,
              topic: '',
              folderId: null,
              order: directOrder++,
              nextSeq: 0,
              createdAt: at,
              updatedAt: at,
            };
            groups.set(direct.groupId, direct);
            await domain.table('groups').put(direct.groupId, direct);
          } else {
            // Finish a partially applied upgrade and keep the title in sync.
            let changed = false;
            if (direct.title !== bot.name) { direct.title = bot.name; changed = true; }
            if (!Number.isInteger(direct.order)) { direct.order = directOrder++; changed = true; }
            if (direct.folderId === undefined) { direct.folderId = null; changed = true; }
            if (changed) {
              direct.updatedAt = direct.updatedAt || at;
              await domain.table('groups').put(direct.groupId, direct);
            }
          }
          const membershipId = directMembershipIdFor(bot.botId);
          const hasMember = [...members.values()].some(
            (member) => member.groupId === direct.groupId && member.botId === bot.botId,
          );
          if (!hasMember && !members.has(membershipId)) {
            const member = {
              membershipId,
              groupId: direct.groupId,
              botId: bot.botId,
              order: 0,
              sessionId: directSessionIdFor(bot.botId),
              enabled: true,
              lastSeenSeq: 0,
              createdAt: at,
              updatedAt: at,
            };
            members.set(membershipId, member);
            await domain.table('members').put(membershipId, member);
          }
        }
        await repo.putMeta('schema', { version: 6, migratedAt: now() });
        version = 6;
        applied.push(5);
      }
      return { version, applied };
    },
    health() {
      return {
        domain: DOMAIN_NAME,
        domainVersion: DOMAIN_VERSION,
        schemaVersion: repo.schemaVersion(),
        counts: {
          bots: bots.size,
          groups: groups.size,
          folders: folders.size,
          members: members.size,
          messages: messages.size,
          discussions: discussions.size,
          tasks: tasks.size,
        },
      };
    },
    async close() {
      await domain.close();
    },
  };

  return repo;
}
