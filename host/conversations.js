/** Pure conversation checks shared by execution, history, and service code. */
const groupOf = (repo, groupId) => repo?.getGroup?.(groupId) ?? repo?.groups?.get?.(groupId);
const memberOf = (repo, memberId) => repo?.getMember?.(memberId) ?? repo?.members?.get?.(memberId);

export function currentConversationId(repo, groupId) {
  if (typeof repo?.activeConversation === 'function') return repo.activeConversation(groupId)?.conversationId ?? null;
  return groupOf(repo, groupId)?.activeConversationId ?? null;
}

export function conversationFloor(repo, groupId) {
  const group = groupOf(repo, groupId);
  if (typeof repo?.activeConversation === 'function') {
    const conversation = repo.activeConversation(groupId);
    if ((!conversation && group) || (conversation && (!Number.isSafeInteger(conversation.afterSeq) || conversation.afterSeq < 0 ||
        (group?.activeConversationId && group.activeConversationId !== conversation.conversationId)))) {
      throw Object.assign(new Error('聊天会话边界不可用'), { code: 'conversation-corrupt' });
    }
    return conversation?.afterSeq ?? 0;
  }
  // Only legacy doubles with no generation pointer can use the legacy floor.
  if (group?.activeConversationId) throw Object.assign(new Error('聊天会话边界不可用'), { code: 'conversation-corrupt' });
  return 0;
}

export function conversationIdOf(repo, record) {
  if (!record) return null;
  if (typeof repo?.conversationFor === 'function') return repo.conversationFor(record)?.conversationId ?? null;
  // An untagged record is legacy history, never implicitly the new current turn.
  return record.conversationId ?? null;
}

export function isCurrentMemberSession(repo, member, sessionId = member?.sessionId) {
  if (!member || !sessionId || member.sessionId !== sessionId) return false;
  const latest = memberOf(repo, member.membershipId);
  if ((typeof repo?.getMember === 'function' || typeof repo?.members?.get === 'function') &&
      (!latest || latest.groupId !== member.groupId || latest.botId !== member.botId || latest.sessionId !== sessionId)) return false;
  const conversationId = currentConversationId(repo, member.groupId);
  const strict = typeof repo?.activeConversation === 'function' || Boolean(groupOf(repo, member.groupId)?.activeConversationId);
  if (strict && (!conversationId || member.sessionConversationId !== conversationId || (latest && latest.sessionConversationId !== conversationId))) return false;
  if (typeof repo?.sessionBindingFor === 'function') {
    const binding = repo.sessionBindingFor(sessionId);
    if (!binding || binding.groupId !== member.groupId || binding.membershipId !== member.membershipId || binding.botId !== member.botId || binding.conversationId !== conversationId) return false;
  }
  return true;
}
