/** Pure validation and step planning for version 2 discussions. */
export const DISCUSSION_ACTIVE_STATUSES = Object.freeze([
  'running', 'pausing', 'paused', 'finalizing', 'stopping',
]);

export function isDiscussionActive(record) {
  return Boolean(record && DISCUSSION_ACTIVE_STATUSES.includes(record.status));
}

function invalid(message) {
  throw Object.assign(new Error(message), { code: 'invalid-input' });
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function text(value, name, { required = false, max = Infinity } = {}) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') invalid(name + ' 必须是字符串');
  const result = value.trim();
  if (required && !result) invalid(name + ' 不能为空');
  if (value.length > max) invalid(name + ' 不能超过 ' + max + ' 字');
  return result;
}

function choice(value, name, values, fallback) {
  if (value === undefined) return fallback;
  if (!values.includes(value)) invalid(name + ' 无效');
  return value;
}

function ids(value, name) {
  if (!Array.isArray(value)) invalid(name + ' 必须是数组');
  const result = value.map(item => text(item, name, { required: true }));
  if (new Set(result).size !== result.length) invalid(name + ' 不能重复');
  return result;
}

/**
 * Validate start input without mutating repository state or capturing attachments.
 * memberIds includes every assigned participant; speakerIds contains only speakers
 * in the regular rounds. The engine captures contextMessageIds via captureQuote.
 */
export function normalizeDiscussionInput(repo, input) {
  if (!plainObject(input)) invalid('讨论参数必须是对象');
  const groupId = text(input.groupId, 'groupId', { required: true });
  const group = repo.getGroup(groupId);
  if (!group) throw Object.assign(new Error('群不存在'), { code: 'not-found' });
  if (group.kind === 'direct') invalid('单聊不能开始多人讨论或辩论');

  const mode = choice(input.mode, 'mode', ['discussion', 'debate'], 'discussion');
  const format = choice(input.format, 'format', ['classic', 'structured'], 'classic');
  const topic = text(input.topic, '议题', { required: true, max: 2000 });
  const background = text(input.background, '背景', { max: 12000 });
  const goal = text(input.goal, '目标', { max: 2000 });
  const responseLength = choice(input.responseLength, 'responseLength', ['short', 'standard', 'detailed'], 'standard');
  const language = choice(input.language, 'language', ['auto', 'zh', 'en'], 'auto');
  if (input.summarize !== undefined && typeof input.summarize !== 'boolean') invalid('summarize 必须是布尔值');
  const summarize = input.summarize === undefined ? mode === 'discussion' && format === 'structured' : input.summarize;
  const minRounds = mode === 'discussion' && format === 'structured' ? 2 : 1;
  const maxRounds = mode === 'debate' ? 3 : 5;
  const rounds = input.rounds === undefined ? (minRounds === 2 ? 3 : 2) : input.rounds;
  if (!Number.isInteger(rounds) || rounds < minRounds || rounds > maxRounds) {
    invalid('rounds 必须是 ' + minRounds + ' 到 ' + maxRounds + ' 之间的整数');
  }
  const expectedConversationId = input.expectedConversationId === undefined ? undefined
    : text(input.expectedConversationId, 'expectedConversationId', { required: true });

  const eligible = member => member && member.groupId === groupId && member.enabled !== false && repo.getBot(member.botId);
  const requireMember = membershipId => {
    const member = repo.getMember(membershipId);
    if (!eligible(member)) invalid('成员不存在、不属于本群、已停用或其 Bot 已删除：' + membershipId);
    return member;
  };
  const role = name => input[name] === undefined || input[name] === null || input[name] === '' ? null
    : text(input[name], name, { required: true });
  let summaryMembershipId = role('summaryMembershipId');
  const proMembershipId = role('proMembershipId');
  const conMembershipId = role('conMembershipId');
  const judgeMembershipId = role('judgeMembershipId');
  const proPosition = text(input.proPosition, '正方立场', { max: 2000 });
  const conPosition = text(input.conPosition, '反方立场', { max: 2000 });
  let speakerIds;

  if (mode === 'debate') {
    if (!proMembershipId || !conMembershipId || proMembershipId === conMembershipId) invalid('辩论必须选择不同的正方和反方成员');
    if (judgeMembershipId === proMembershipId || judgeMembershipId === conMembershipId) invalid('裁判必须独立于正方和反方');
    if (summaryMembershipId) invalid('辩论请使用 judgeMembershipId 指定裁判');
    speakerIds = [proMembershipId, conMembershipId];
    if (input.membershipIds !== undefined) {
      const selected = ids(input.membershipIds, 'membershipIds');
      if (selected.some(id => !speakerIds.includes(id) && id !== judgeMembershipId) ||
          speakerIds.some(id => !selected.includes(id))) invalid('辩论成员必须包含正反双方，且只能额外包含指定裁判');
    }
  } else {
    if (proMembershipId || conMembershipId || judgeMembershipId || proPosition || conPosition) invalid('正反方和裁判配置仅适用于辩论');
    speakerIds = input.membershipIds === undefined
      ? repo.membersOf(groupId).filter(eligible).map(member => member.membershipId)
      : ids(input.membershipIds, 'membershipIds');
    if (speakerIds.length < (format === 'structured' ? 2 : 1)) invalid(format === 'structured' ? '结构化讨论至少需要两名成员' : '请选择至少一个讨论成员');
    summaryMembershipId ??= speakerIds[0];
  }
  if (new Set(speakerIds).size !== speakerIds.length) invalid('讨论成员不能重复');
  const memberIds = [...new Set([...speakerIds, summaryMembershipId, judgeMembershipId].filter(Boolean))];
  const participants = memberIds.map(membershipId => {
    const member = requireMember(membershipId);
    const bot = repo.getBot(member.botId);
    return { membershipId, botId: member.botId, name: bot.name };
  });
  if (new Set(participants.map(participant => participant.botId)).size !== participants.length) invalid('同一个 Bot 不能承担多个参与者身份');

  const contextMessageIds = input.contextMessageIds === undefined ? [] : ids(input.contextMessageIds, 'contextMessageIds');
  if (contextMessageIds.length > 20) invalid('引用消息最多 20 条');
  for (const messageId of contextMessageIds) {
    const message = repo.getMessage(messageId);
    if (!message || message.groupId !== groupId) invalid('引用消息不存在或不属于本群：' + messageId);
  }
  const perspectiveInput = input.perspectives === undefined ? {} : input.perspectives;
  if (!plainObject(perspectiveInput)) invalid('perspectives 必须是成员到视角文本的对象');
  const perspectives = Object.fromEntries(Object.entries(perspectiveInput).map(([membershipId, value]) => {
    if (!memberIds.includes(membershipId)) invalid('视角只能分配给本次参与者：' + membershipId);
    return [membershipId, text(value, '成员视角', { max: 500 })];
  }));

  return {
    protocolVersion: 2, groupId, topic, mode, format, goal, background, rounds, summarize,
    memberIds, speakerIds, participants, summaryMembershipId,
    proMembershipId, conMembershipId, judgeMembershipId, proPosition, conPosition,
    responseLength, language, perspectives, contextMessageIds, expectedConversationId,
  };
}

/** Build a deterministic plan; every call returns fresh mutable step state. */
export function createDiscussionPlan(config) {
  const steps = [];
  const add = (phase, membershipId, round, side = null, targetStepId) => {
    const step = {
      stepId: 'step-' + (steps.length + 1), phase, membershipId, side, round,
      ...(targetStepId ? { targetStepId } : {}),
      status: 'pending', attempts: [], messageIds: [],
    };
    steps.push(step);
    return step;
  };
  if (config.mode === 'debate') {
    const members = { pro: config.proMembershipId, con: config.conMembershipId };
    const latestStatement = {
      pro: add('opening', members.pro, 1, 'pro'),
      con: add('opening', members.con, 1, 'con'),
    };
    for (let round = 1; round <= config.rounds; round += 1) {
      const order = round % 2 === 1 ? ['pro', 'con'] : ['con', 'pro'];
      for (const side of order) {
        const other = side === 'pro' ? 'con' : 'pro';
        const question = add('question', members[side], round, side, latestStatement[other].stepId);
        latestStatement[other] = add('answer', members[other], round, other, question.stepId);
      }
    }
    add('closing', members.pro, config.rounds, 'pro');
    add('closing', members.con, config.rounds, 'con');
    if (config.judgeMembershipId) add('judgement', config.judgeMembershipId, config.rounds);
    return steps;
  }

  const speakerIds = config.speakerIds;
  for (let round = 1; round <= config.rounds; round += 1) {
    const phase = config.format !== 'structured' ? 'discussion'
      : round === 1 ? 'viewpoint' : round === config.rounds ? 'converge' : 'challenge';
    for (const membershipId of speakerIds) add(phase, membershipId, round);
    if (config.format === 'structured' && round < config.rounds) {
      add('checkpoint', config.summaryMembershipId, round);
    }
  }
  if (config.summarize) add('summary', config.summaryMembershipId, config.rounds);
  return steps;
}
