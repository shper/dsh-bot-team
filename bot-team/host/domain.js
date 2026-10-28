/**
 * Durable repository for Bot Team, backed by the Host storage-domain service.
 *
 * Layout: one domain `bot_team` (per-record), mapped by storage-layout.js to the
 * physical `dsh-bot-team` directory, with the tables bots / groups /
 * folders / members / messages / conversations / session_bindings / meta.
 * Records are plain JSON; the domain calls each
 * table's `parse` when loading stored records (see `recordSchema`). Memory is
 * authoritative for reads; every write awaits backend durability through the
 * domain's per-domain write chain.
 *
 * Keys are path-safe (`[a-zA-Z0-9_-]` only) because the JSON backend maps one
 * record key to one file (M0 finding P3).
 */
import { createHash, randomUUID } from 'node:crypto';
import { now, recordSchema } from './util.js';
import { directGroupIdFor, directMembershipIdFor, directSessionIdFor } from './layout.js';

export const DOMAIN_NAME = 'bot_team';
export const DOMAIN_VERSION = 1;
/** Record-shape schema version stored in the meta table (domain version stays 1 by design). */
export const SCHEMA_VERSION = 7;

const digest = value => createHash('sha256').update(value).digest('hex');
const baselineId = groupId => `conv_${digest(`baseline:${groupId}`)}`;
const bindingIdFor = sessionId => `binding_${digest(sessionId)}`;
const copy = value => structuredClone(value);
const failure = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

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
      conversations: { valueSchema: recordSchema('conversations', ['conversationId', 'groupId', 'ordinal', 'previousConversationId', 'afterSeq', 'createdAt', 'reason', 'requestId']) },
      session_bindings: { valueSchema: recordSchema('session_bindings', ['bindingId', 'sessionId', 'groupId', 'conversationId', 'membershipId', 'botId']) },
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
  const conversations = new Map();
  const sessionBindings = new Map();
  const bindingsBySession = new Map();
  const groupWrites = new Map();
  const requestWrites = new Map();
  const failedWrites = new Map();
  // Keep committed generation fields away from mutable objects held by callers.
  const groupHeads = new Map();
  const groupNextSeq = new Map();
  const memberMappings = new Map();
  let bindingWrites = Promise.resolve();
  const deletedGroupIds = new Set();
  const deletedMemberIds = new Set();

  function enqueue(groupId, operation, recoveryKey) {
    const pending = (groupWrites.get(groupId) ?? Promise.resolve()).then(operation);
    const settled = pending.then(() => {
      if (recoveryKey) failedWrites.get(groupId)?.delete(recoveryKey);
    }, error => {
      if (recoveryKey) {
        if (!failedWrites.has(groupId)) failedWrites.set(groupId, new Map());
        failedWrites.get(groupId).set(recoveryKey, error);
      }
    });
    groupWrites.set(groupId, settled);
    settled.then(() => { if (groupWrites.get(groupId) === settled) groupWrites.delete(groupId); });
    return pending;
  }

  function serializeRequest(requestId, operation) {
    const pending = (requestWrites.get(requestId) ?? Promise.resolve()).then(operation);
    const settled = pending.catch(() => {});
    requestWrites.set(requestId, settled);
    settled.then(() => { if (requestWrites.get(requestId) === settled) requestWrites.delete(requestId); });
    return pending;
  }

  function publishGroup(group) {
    group.nextSeq = Math.max(groupNextSeq.get(group.groupId) ?? 0, group.nextSeq ?? 0);
    groupNextSeq.set(group.groupId, group.nextSeq);
    const head = { activeConversationId: group.activeConversationId, conversationVersion: group.conversationVersion };
    groupHeads.set(group.groupId, head);
    groups.set(group.groupId, group);
    return group;
  }

  function publishMember(member) {
    memberMappings.set(member.membershipId, copy(member));
    members.set(member.membershipId, member);
    return member;
  }

  function committedChain(groupId) {
    const group = groups.get(groupId);
    if (!group) return [];
    const head = groupHeads.get(groupId) ?? group;
    if (!head.activeConversationId) {
      if (repo.schemaVersion() >= 7) throw failure('conversation-corrupt', '聊天缺少当前会话', { groupId });
      return [];
    }
    const chain = [];
    const visited = new Set();
    let id = head.activeConversationId;
    let ordinal = head.conversationVersion;
    let upper = Number.isSafeInteger(group.nextSeq) ? group.nextSeq : 0;
    while (id) {
      const conversation = conversations.get(id);
      if (visited.has(id) || !conversation || conversation.groupId !== groupId || conversation.conversationId !== id ||
          !Number.isSafeInteger(ordinal) || ordinal < 1 || conversation.ordinal !== ordinal ||
          !Number.isSafeInteger(conversation.afterSeq) || conversation.afterSeq < 0 || conversation.afterSeq > upper ||
          (ordinal === 1 ? conversation.previousConversationId !== null || conversation.afterSeq !== 0 : typeof conversation.previousConversationId !== 'string' || !conversation.previousConversationId)) {
        throw failure('conversation-corrupt', '聊天会话历史链损坏', { groupId, conversationId: id });
      }
      visited.add(id);
      chain.push(conversation);
      id = conversation.previousConversationId;
      ordinal--;
      upper = conversation.afterSeq;
    }
    if (ordinal !== 0) throw failure('conversation-corrupt', '聊天会话版本不一致', { groupId });
    return chain.reverse();
  }

  async function writeConversation(conversation) {
    const existing = conversations.get(conversation.conversationId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(conversation)) throw failure('conflict', '不可修改已存在的会话记录');
      return existing;
    }
    const stored = Object.freeze(copy(conversation));
    await domain.table('conversations').put(stored.conversationId, stored);
    conversations.set(stored.conversationId, stored);
    return stored;
  }

  function writeBinding(member, options) {
    const pending = bindingWrites.then(() => writeBindingRecord(member, options));
    bindingWrites = pending.catch(() => {});
    return pending;
  }

  async function writeBindingRecord(member, { sessionId, conversationId, reason = 'session-created' }) {
    if (typeof sessionId !== 'string' || !sessionId.trim() || typeof conversationId !== 'string') throw failure('invalid-input', 'Session 归属缺少标识');
    const conversation = conversations.get(conversationId);
    if (!conversation || conversation.groupId !== member.groupId) throw failure('conversation-corrupt', 'Session 归属引用了无效会话');
    const existing = bindingsBySession.get(sessionId);
    if (existing) {
      if (existing.groupId !== member.groupId || existing.conversationId !== conversationId || existing.membershipId !== member.membershipId || existing.botId !== member.botId) {
        throw failure('session-binding-conflict', '同一 Session 存在互相冲突的聊天或成员归属', { sessionId, groupId: member.groupId });
      }
      return existing;
    }
    const binding = Object.freeze({
      bindingId: bindingIdFor(sessionId), sessionId, groupId: member.groupId, conversationId,
      membershipId: member.membershipId, botId: member.botId,
      botNameSnapshot: member.botNameSnapshot ?? bots.get(member.botId)?.name ?? member.botId,
      createdAt: now(), reason,
    });
    await domain.table('session_bindings').put(binding.bindingId, binding);
    sessionBindings.set(binding.bindingId, binding);
    bindingsBySession.set(sessionId, binding);
    return binding;
  }

  async function initializeConversation(group) {
    const existing = groupHeads.get(group.groupId)?.activeConversationId;
    if (existing) return committedChain(group.groupId).at(-1);
    const conversationId = baselineId(group.groupId);
    const conversation = await writeConversation(conversations.get(conversationId) ?? {
      conversationId, groupId: group.groupId, ordinal: 1, previousConversationId: null,
      afterSeq: 0, createdAt: group.createdAt ?? now(), reason: 'legacy', requestId: null,
    });
    if (conversation.groupId !== group.groupId || conversation.ordinal !== 1 || conversation.afterSeq !== 0 || conversation.previousConversationId !== null) throw failure('conversation-corrupt', '聊天基线会话损坏');
    for (const current of [...members.values()].filter(member => member.groupId === group.groupId)) {
      const member = copy(current);
      if (member.sessionConversationId && member.sessionConversationId !== conversationId) throw failure('conversation-corrupt', '旧成员的 Session 会话不属于迁移基线');
      for (const sessionId of new Set([member.sessionId, ...(member.previousSessionIds ?? [])].filter(Boolean))) {
        await writeBinding(member, { sessionId, conversationId, reason: 'legacy-member' });
      }
      if (!member.sessionConversationId) {
        member.sessionConversationId = conversationId;
        await domain.table('members').put(member.membershipId, member);
        publishMember(member);
      }
    }
    // These references were recorded by the Host before handing input to an Agent.
    // Preserve ownership even when that member has since been removed.
    for (const message of messagesByGroup.get(group.groupId) ?? []) {
      const execution = message.meta?.execution;
      const author = message.author;
      if (!execution?.sessionId) continue;
      if (execution.version !== 1 || typeof execution.jobId !== 'string' || !execution.jobId ||
          typeof execution.sessionId !== 'string' || author?.type !== 'bot' || !author.membershipId || !author.botId) {
        warn('legacy session binding', new Error('无法可靠关联执行引用: ' + message.messageId));
        continue;
      }
      await writeBinding({ groupId: group.groupId, membershipId: author.membershipId, botId: author.botId, botNameSnapshot: author.name },
        { sessionId: execution.sessionId, conversationId, reason: 'legacy-execution' });
    }
    const stored = { ...copy(groups.get(group.groupId) ?? {}), ...copy(group), activeConversationId: conversationId, conversationVersion: 1 };
    await domain.table('groups').put(group.groupId, stored);
    publishGroup(stored);
    return conversation;
  }
  // Strict deletions reserve the id before awaiting storage. Keep successful ids
  // for this repository lifetime so a late callback cannot recreate a message.
  const deletingMessageIds = new Set();
  const deletedMessageIds = new Set();
  const messageWriteError = (messageId) => {
    if (deletingMessageIds.has(messageId)) return Object.assign(new Error('消息正在删除'), { code: 'busy' });
    if (deletedMessageIds.has(messageId)) return Object.assign(new Error('消息已删除'), { code: 'not-found' });
    return null;
  };

  for (const [key, value] of domain.table('bots').entries()) bots.set(key, value);
  for (const [key, value] of domain.table('groups').entries()) {
    const group = { nextSeq: 0, ...value };
    // Normalize fields added in schema v6 so every in-memory record is complete
    // even before (or without) the migration write.
    if (group.kind !== 'direct') group.kind = 'group';
    if (group.folderId === undefined) group.folderId = null;
    // `order` intentionally stays undefined when missing: the v6 migration uses
    // that to assign the pre-upgrade display order exactly once.
    publishGroup(group);
  }
  for (const [key, value] of domain.table('folders').entries()) {
    const folder = { ...value };
    if (!Number.isInteger(folder.order)) folder.order = 0;
    folders.set(key, folder);
  }
  for (const [key, value] of domain.table('members').entries()) publishMember(value);
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
  for (const [key, value] of domain.table('conversations').entries()) {
    if (key !== value.conversationId) throw failure('conversation-corrupt', '会话存储键不一致');
    conversations.set(key, Object.freeze(copy(value)));
  }
  for (const [key, value] of domain.table('session_bindings').entries()) {
    if (typeof value.sessionId !== 'string' || key !== value.bindingId || key !== bindingIdFor(value.sessionId) || bindingsBySession.has(value.sessionId)) {
      throw failure('conversation-corrupt', 'Session 归属存储键冲突');
    }
    const binding = Object.freeze(copy(value));
    sessionBindings.set(key, binding);
    bindingsBySession.set(binding.sessionId, binding);
  }

  // Crash recovery: a previous process may have died mid-turn / mid-discussion.
  for (const message of messages.values()) {
    if (message.status === 'pending' || message.status === 'streaming') {
      message.status = 'error';
      message.error = 'Host 重启，该回复被中断，可重试';
      message.updatedAt = now();
      enqueue(message.groupId, () => domain.table('messages').put(message.messageId, copy(message)), 'message:' + message.messageId).catch(() => {});
    }
    if (message.kind === 'approval' && message.meta && message.meta.approvalState === 'pending') {
      message.meta = { ...message.meta, approvalState: 'cancelled', decidedAt: now() };
      message.updatedAt = now();
      enqueue(message.groupId, () => domain.table('messages').put(message.messageId, copy(message)), 'message:' + message.messageId).catch(() => {});
    }
  }
  for (const discussion of discussions.values()) {
    if (discussion.status === 'running') {
      discussion.status = 'stopped';
      discussion.stopReason = 'host-restart';
      discussion.updatedAt = now();
      enqueue(discussion.groupId, () => domain.table('discussions').put(discussion.discussionId, copy(discussion)), 'discussion:' + discussion.discussionId).catch(() => {});
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
    if (!Number.isSafeInteger(group.nextSeq) || group.nextSeq < maxSeq) group.nextSeq = maxSeq;
    groupNextSeq.set(group.groupId, group.nextSeq);
  }

  function recordConversation(record, previous) {
    const previousId = previous && repo.conversationFor(previous)?.conversationId;
    if (previous && record.conversationId && previousId !== record.conversationId) throw failure('conflict', '不可更改历史记录的会话归属');
    record.conversationId ??= previousId ?? repo.activeConversation(record.groupId)?.conversationId;
    if (!repo.conversationFor(record)) throw failure('conversation-corrupt', '记录缺少已提交的会话归属');
    return record;
  }

  function validateConversations() {
    for (const group of groups.values()) committedChain(group.groupId);
    for (const member of members.values()) {
      if (!groups.has(member.groupId)) continue;
      const binding = bindingsBySession.get(member.sessionId);
      if (!member.sessionConversationId || !repo.conversationFor({ groupId: member.groupId, conversationId: member.sessionConversationId }) ||
          !binding || binding.groupId !== member.groupId || binding.conversationId !== member.sessionConversationId || binding.membershipId !== member.membershipId || binding.botId !== member.botId) {
        throw failure('conversation-corrupt', '成员 Session 归属不完整', { membershipId: member.membershipId });
      }
    }
    for (const binding of sessionBindings.values()) {
      if (groups.has(binding.groupId) && !repo.conversationFor(binding)) throw failure('conversation-corrupt', 'Session 归属引用了未提交会话');
    }
  }

  const repo = {
    domain,
    bots,
    groups,
    folders,
    members,
    messages,
    meta,
    conversations,
    sessionBindings,

    activeConversation(groupId) {
      return committedChain(groupId).at(-1);
    },
    conversationsOf(groupId) {
      return committedChain(groupId);
    },
    conversationFor(record) {
      if (!record?.groupId) return undefined;
      const chain = committedChain(record.groupId);
      return record.conversationId == null ? chain[0] : chain.find(item => item.conversationId === record.conversationId);
    },
    sessionBindingsOf(groupId, conversationId) {
      const committed = new Set(committedChain(groupId).map(item => item.conversationId));
      return [...sessionBindings.values()].filter(binding => binding.groupId === groupId && committed.has(binding.conversationId) &&
        (conversationId === undefined || binding.conversationId === conversationId))
        .sort((a, b) => a.createdAt - b.createdAt || a.bindingId.localeCompare(b.bindingId));
    },
    sessionBindingFor(sessionId) {
      const binding = bindingsBySession.get(sessionId);
      return binding && repo.conversationFor(binding) ? binding : undefined;
    },
    bindSession(member, options = {}) {
      const candidate = copy(member);
      const binding = copy(options);
      return enqueue(candidate.groupId, () => {
        const latest = memberMappings.get(candidate.membershipId);
        if (!latest || latest.groupId !== candidate.groupId || latest.botId !== candidate.botId || deletedMemberIds.has(candidate.membershipId)) throw failure('not-found', '成员不存在');
        if (!repo.conversationFor({ groupId: candidate.groupId, conversationId: binding.conversationId })) throw failure('conversation-corrupt', 'Session 必须属于已提交会话');
        return writeBinding(candidate, binding);
      });
    },
    ensureConversation(groupId) {
      return enqueue(groupId, () => {
        const group = groups.get(groupId);
        if (!group || deletedGroupIds.has(groupId)) throw failure('not-found', '聊天不存在');
        return initializeConversation(group);
      });
    },
    async flushGroupWrites(groupId) {
      while (groupWrites.has(groupId)) await groupWrites.get(groupId);
      const errors = [...(failedWrites.get(groupId)?.values() ?? [])];
      if (errors.length) throw failure('persistence-failed', '聊天仍有未成功持久化的更改', { cause: errors[0], groupId });
    },
    commitConversation(groupId, { expectedConversationId, requestId } = {}) {
      if (typeof expectedConversationId !== 'string' || !expectedConversationId || typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200) {
        return Promise.reject(failure('invalid-input', '新建会话需要预期会话与 requestId'));
      }
      return enqueue(groupId, () => serializeRequest(requestId, async () => {
        const group = groups.get(groupId);
        if (!group || deletedGroupIds.has(groupId)) throw failure('not-found', '聊天不存在');
        for (const otherGroupId of groups.keys()) {
          if (otherGroupId !== groupId && committedChain(otherGroupId).some(item => item.requestId === requestId)) throw failure('conflict', 'requestId 已用于其他聊天');
        }
        const chain = committedChain(groupId);
        const current = chain.at(-1);
        if (!current) throw failure('conversation-corrupt', '聊天会话尚未初始化');
        const replay = chain.find(item => item.requestId === requestId);
        if (replay) {
          if (replay.previousConversationId !== expectedConversationId) throw failure('conflict', 'requestId 已用于不同父会话');
          return { created: false, conversation: replay, currentConversationId: current.conversationId, conversationVersion: current.ordinal };
        }
        if (current.conversationId !== expectedConversationId) throw failure('stale-conversation', '聊天已开始新会话', { currentConversationId: current.conversationId, conversationVersion: current.ordinal });
        if (failedWrites.get(groupId)?.size) throw failure('persistence-failed', '聊天仍有未成功持久化的更改');
        const conversation = await writeConversation({
          conversationId: 'conv_' + randomUUID(), groupId, ordinal: current.ordinal + 1,
          previousConversationId: current.conversationId, afterSeq: group.nextSeq ?? 0,
          createdAt: now(), reason: 'user-new', requestId,
        });
        const stored = { ...copy(groups.get(groupId)), activeConversationId: conversation.conversationId, conversationVersion: conversation.ordinal, updatedAt: now() };
        await domain.table('groups').put(groupId, stored);
        publishGroup(stored);
        return { created: true, conversation, currentConversationId: conversation.conversationId, conversationVersion: conversation.ordinal };
      }));
    },

    getBot(botId) {
      return bots.get(botId);
    },
    getGroup(groupId) {
      return copy(groups.get(groupId));
    },
    getFolder(folderId) {
      return folders.get(folderId);
    },
    getMember(membershipId) {
      return copy(members.get(membershipId));
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
      return [...groups.values()].map(copy).sort((a, b) => b.updatedAt - a.updatedAt);
    },
    allFolders() {
      return [...folders.values()].sort((a, b) => a.order - b.order || (a.createdAt ?? 0) - (b.createdAt ?? 0));
    },
    membersOf(groupId) {
      return [...members.values()]
        .filter((member) => member.groupId === groupId)
        .map(copy)
        .sort((a, b) => a.order - b.order);
    },
    membersOfBot(botId) {
      return [...members.values()].filter((member) => member.botId === botId).map(copy);
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
    putTask(task) {
      const candidate = recordConversation(copy(task), tasks.get(task.taskId));
      candidate.updatedAt = now();
      return enqueue(candidate.groupId, async () => {
        await domain.table('tasks').put(candidate.taskId, candidate);
        tasks.set(candidate.taskId, candidate);
        return candidate;
      });
    },
    async deleteTask(taskId) {
      const task = tasks.get(taskId);
      if (!task) return;
      await enqueue(task.groupId, () => domain.table('tasks').delete(taskId));
      tasks.delete(taskId);
    },
    discussionsOf(groupId) {
      return [...discussions.values()]
        .filter((discussion) => discussion.groupId === groupId)
        .sort((a, b) => b.createdAt - a.createdAt);
    },
    activeDiscussionOf(groupId) {
      return repo.discussionsOf(groupId).find((discussion) => discussion.status === 'running');
    },
    putDiscussion(discussion) {
      const candidate = recordConversation(copy(discussion), discussions.get(discussion.discussionId));
      candidate.updatedAt = now();
      return enqueue(candidate.groupId, async () => {
        await domain.table('discussions').put(candidate.discussionId, candidate);
        discussions.set(candidate.discussionId, candidate);
        failedWrites.get(candidate.groupId)?.delete('discussion:' + candidate.discussionId);
        return candidate;
      });
    },
    async deleteDiscussion(discussionId) {
      const discussion = discussions.get(discussionId);
      if (!discussion) return;
      await enqueue(discussion.groupId, () => domain.table('discussions').delete(discussionId));
      discussions.delete(discussionId);
    },

    allocateSeq(groupId) {
      const group = groups.get(groupId);
      if (!group) throw new Error(`group ${groupId} does not exist`);
      group.nextSeq = Math.max(groupNextSeq.get(groupId) ?? 0, group.nextSeq ?? 0) + 1;
      if (!Number.isSafeInteger(group.nextSeq)) throw failure('conversation-corrupt', '聊天消息序号超出有效范围');
      groupNextSeq.set(groupId, group.nextSeq);
      group.updatedAt = now();
      enqueue(groupId, async () => {
        const latest = groups.get(groupId);
        if (!latest || deletedGroupIds.has(groupId)) throw failure('not-found', '聊天已删除');
        const stored = { ...copy(latest), ...groupHeads.get(groupId) };
        await domain.table('groups').put(groupId, stored);
      }, 'group').catch((error) => warn('persist group seq', error));
      return group.nextSeq;
    },

    appendMessage(message) {
      const error = messageWriteError(message.messageId);
      if (error) {
        warn('persist message', error);
        return Promise.resolve();
      }
      try { recordConversation(message, messages.get(message.messageId)); }
      catch (error) { return Promise.reject(error); }
      const candidate = copy(message);
      messages.set(message.messageId, message);
      const list = messagesByGroup.get(message.groupId) ?? [];
      const existing = list.findIndex(item => item.messageId === message.messageId);
      if (existing >= 0) list[existing] = message;
      else list.push(message);
      sortBySeq(list);
      messagesByGroup.set(message.groupId, list);
      return enqueue(message.groupId, () => domain.table('messages').put(candidate.messageId, candidate), 'message:' + message.messageId)
        .catch((error) => warn('persist message', error));
    },
    putMessage(message) {
      return repo.putMessageStrict(message, { trackFailure: true }).catch((error) => warn('persist message', error));
    },
    // Execution references must be durable before a prompt enters the agent inbox.
    // Unlike putMessage, this path lets the caller fail closed on storage errors.
    putMessageStrict(message, { trackFailure = false } = {}) {
      const error = messageWriteError(message.messageId);
      if (error) return Promise.reject(error);
      let candidate;
      try { candidate = recordConversation(copy(message), messages.get(message.messageId)); }
      catch (error) { return Promise.reject(error); }
      return enqueue(candidate.groupId, async () => {
        await domain.table('messages').put(candidate.messageId, candidate);
        messages.set(candidate.messageId, candidate);
        const list = messagesByGroup.get(candidate.groupId) ?? [];
        const index = list.findIndex(item => item.messageId === candidate.messageId);
        if (index >= 0) list[index] = candidate;
        else list.push(candidate);
        sortBySeq(list);
        messagesByGroup.set(candidate.groupId, list);
        failedWrites.get(candidate.groupId)?.delete('message:' + candidate.messageId);
        return candidate;
      }, trackFailure ? 'message:' + candidate.messageId : undefined);
    },
    // Preserve the legacy best-effort delete below for group/bot cleanup. An
    // explicit user deletion must succeed durably before readers or SSE see it.
    async deleteMessageStrict(messageId) {
      if (deletingMessageIds.has(messageId)) throw Object.assign(new Error('消息正在删除'), { code: 'busy' });
      const message = messages.get(messageId);
      if (!message) return false;
      deletingMessageIds.add(messageId);
      try {
        // The domain write chain orders this after any already-submitted puts.
        await enqueue(message.groupId, () => domain.table('messages').delete(messageId));
        failedWrites.get(message.groupId)?.delete('message:' + messageId);
        deletedMessageIds.add(messageId);
        messages.delete(messageId);
        const list = messagesByGroup.get(message.groupId) ?? [];
        const index = list.findIndex((candidate) => candidate.messageId === messageId);
        if (index >= 0) list.splice(index, 1);
        return true;
      } finally {
        deletingMessageIds.delete(messageId);
      }
    },
    async deleteMessage(messageId) {
      const message = messages.get(messageId);
      if (!message) return false;
      messages.delete(messageId);
      const list = messagesByGroup.get(message.groupId) ?? [];
      const index = list.findIndex((candidate) => candidate.messageId === messageId);
      if (index >= 0) list.splice(index, 1);
      await enqueue(message.groupId, () => domain.table('messages').delete(messageId), 'message:' + messageId).catch((error) => warn('delete message', error));
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
    putGroup(group) {
      const candidate = copy(group);
      return enqueue(candidate.groupId, async () => {
        if (deletedGroupIds.has(candidate.groupId)) throw failure('not-found', '聊天已删除');
        const latest = groups.get(candidate.groupId);
        const head = groupHeads.get(candidate.groupId);
        const stored = { ...copy(latest ?? {}), ...candidate, ...head, nextSeq: Math.max(latest?.nextSeq ?? 0, candidate.nextSeq ?? 0), updatedAt: now() };
        if (!head?.activeConversationId) {
          // Publish a new group only after its baseline and pointer are durable.
          delete stored.activeConversationId;
          delete stored.conversationVersion;
          await initializeConversation(stored);
          return copy(groups.get(candidate.groupId));
        }
        await domain.table('groups').put(stored.groupId, stored);
        publishGroup(stored);
        failedWrites.get(stored.groupId)?.delete('group');
        return copy(stored);
      });
    },
    deleteGroup(groupId) {
      return enqueue(groupId, async () => {
        await domain.table('groups').delete(groupId);
        deletedGroupIds.add(groupId);
        groups.delete(groupId);
        groupHeads.delete(groupId);
        groupNextSeq.delete(groupId);
        failedWrites.delete(groupId);
        // Delete the authority first. A crash during cleanup leaves only invisible
        // orphan metadata, never an existing group with a broken history chain.
        for (const binding of [...sessionBindings.values()].filter(item => item.groupId === groupId)) {
          await domain.table('session_bindings').delete(binding.bindingId);
          sessionBindings.delete(binding.bindingId);
          bindingsBySession.delete(binding.sessionId);
        }
        for (const conversation of [...conversations.values()].filter(item => item.groupId === groupId)) {
          await domain.table('conversations').delete(conversation.conversationId);
          conversations.delete(conversation.conversationId);
        }
      });
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
    putMember(member) {
      return repo.putMemberStrict(member, { preserveSession: true });
    },
    putMemberStrict(member, options = {}) {
      const candidate = copy(member);
      const expectedConversationId = options.expectedConversationId ?? repo.activeConversation(candidate.groupId)?.conversationId;
      const captured = memberMappings.get(candidate.membershipId);
      const expectedSessionId = options.expectedSessionId ?? captured?.sessionId;
      return enqueue(candidate.groupId, async () => {
        if (deletedGroupIds.has(candidate.groupId) || deletedMemberIds.has(candidate.membershipId)) throw failure('not-found', '聊天或成员已删除');
        const current = repo.activeConversation(candidate.groupId);
        if (!current) throw failure('conversation-corrupt', '聊天会话尚未初始化');
        if (current.conversationId !== expectedConversationId) throw failure('stale-conversation', '成员写入跨越了会话切换');
        const latest = memberMappings.get(candidate.membershipId);
        if (latest && (latest.groupId !== candidate.groupId || latest.botId !== candidate.botId)) throw failure('conflict', '不可改变成员归属');
        if (latest && latest.sessionId !== expectedSessionId) throw failure('stale-session', '成员 Session 已轮换');
        const stored = { ...copy(latest ?? {}), ...candidate, updatedAt: now() };
        if (latest && options.preserveSession) {
          // Settings and old cursor callbacks must never restore an older mapping.
          stored.sessionId = latest.sessionId;
          stored.sessionConversationId = latest.sessionConversationId;
          stored.previousSessionIds = latest.previousSessionIds;
          stored.lastSeenSeq = latest.sessionId === candidate.sessionId && latest.sessionConversationId === candidate.sessionConversationId
            ? Math.max(latest.lastSeenSeq ?? 0, candidate.lastSeenSeq ?? 0) : latest.lastSeenSeq;
        } else {
          stored.sessionConversationId ??= latest?.sessionId === stored.sessionId ? latest.sessionConversationId : current.conversationId;
          if (latest && (latest.sessionId !== stored.sessionId || latest.sessionConversationId !== stored.sessionConversationId)) {
            if (stored.sessionConversationId !== current.conversationId || latest.previousSessionIds?.includes(stored.sessionId)) throw failure('stale-session', '不能恢复历史 Session 为当前执行');
            stored.previousSessionIds = [...new Set([...(latest.previousSessionIds ?? []), ...(stored.previousSessionIds ?? []), latest.sessionId].filter(id => id && id !== stored.sessionId))];
            stored.lastSeenSeq = Math.max(current.afterSeq, stored.lastSeenSeq ?? current.afterSeq);
          } else if (latest) stored.lastSeenSeq = Math.max(latest.lastSeenSeq ?? 0, stored.lastSeenSeq ?? 0);
        }
        if (!latest) {
          if (stored.sessionConversationId !== current.conversationId) throw failure('stale-conversation', '新成员必须加入当前会话');
          stored.lastSeenSeq = Math.max(current.afterSeq, stored.lastSeenSeq ?? 0);
        }
        if (!repo.conversationFor({ groupId: stored.groupId, conversationId: stored.sessionConversationId })) throw failure('conversation-corrupt', '成员 Session 归属无效');
        // Do not mutate caller-owned objects before either durable write succeeds.
        await writeBinding(stored, { sessionId: stored.sessionId, conversationId: stored.sessionConversationId, reason: latest ? 'session-mapping' : 'member-created' });
        await domain.table('members').put(stored.membershipId, stored);
        publishMember(stored);
        return copy(stored);
      });
    },
    deleteMember(membershipId) {
      const member = memberMappings.get(membershipId) ?? members.get(membershipId);
      if (!member) return Promise.resolve();
      return enqueue(member.groupId, async () => {
        await domain.table('members').delete(membershipId);
        deletedMemberIds.add(membershipId);
        members.delete(membershipId);
        memberMappings.delete(membershipId);
        // Historical sessionBindings intentionally outlive the membership.
      });
    },
    touchMember(member) {
      return repo.putMember(member).catch((error) => warn('touch member', error));
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
      if (version < 7) {
        // Each group commits its baseline only after its members and ownership are
        // durable. A failed migration leaves schema=6 and can resume after restart.
        for (const group of [...groups.values()]) await repo.ensureConversation(group.groupId);
        validateConversations();
        await repo.putMeta('schema', { version: 7, migratedAt: now() });
        version = 7;
        applied.push(6);
      }
      validateConversations();
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
          conversations: [...groups.keys()].reduce((sum, groupId) => sum + repo.conversationsOf(groupId).length, 0),
          sessionBindings: sessionBindings.size,
        },
      };
    },
    async close() {
      while (groupWrites.size) await Promise.all([...groupWrites.values()]);
      await domain.close();
    },
  };

  try {
    if (repo.schemaVersion() >= 7) validateConversations();
  } catch (error) {
    await domain.close().catch(() => {});
    throw error;
  }
  return repo;
}
