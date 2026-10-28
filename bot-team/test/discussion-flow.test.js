import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDiscussionInput,
  createDiscussionPlan,
  DISCUSSION_ACTIVE_STATUSES,
  isDiscussionActive,
} from '../host/discussion-flow.js';
import {
  buildDiscussionStepPrompt,
  parseDebateVerdict,
  buildDiscussionPrompt,
  buildSummaryPrompt,
} from '../host/prompt.js';

function fixture() {
  const groups = new Map([
    ['g1', { groupId: 'g1', title: '讨论群', kind: 'group', activeConversationId: 'c1' }],
    ['g2', { groupId: 'g2', title: '其他群', kind: 'group', activeConversationId: 'c2' }],
    ['direct', { groupId: 'direct', kind: 'direct' }],
  ]);
  const bots = new Map([1, 2, 3, 4].map(id => ['b' + id, { botId: 'b' + id, name: '成员' + id }]));
  const members = new Map([
    ...[1, 2, 3, 4].map(id => ['m' + id, { membershipId: 'm' + id, botId: 'b' + id, groupId: 'g1', enabled: id !== 4 }]),
    ['missing-bot', { membershipId: 'missing-bot', botId: 'gone', groupId: 'g1' }],
    ['foreign', { membershipId: 'foreign', botId: 'b3', groupId: 'g2' }],
  ]);
  const messages = new Map(Array.from({ length: 21 }, (_, index) => ['msg-' + index, {
    messageId: 'msg-' + index, groupId: 'g1', conversationId: 'c1', seq: index + 1,
    text: '材料 ' + index, status: 'done', author: { type: 'human' },
  }]));
  messages.set('other-group', { messageId: 'other-group', groupId: 'g2', conversationId: 'c2' });
  messages.set('historical', { messageId: 'historical', groupId: 'g1', conversationId: 'old', seq: 0, text: '历史材料' });
  return {
    groups, bots, members, messages,
    getGroup: id => groups.get(id), getBot: id => bots.get(id), getMember: id => members.get(id),
    getMessage: id => messages.get(id),
    membersOf: groupId => [...members.values()].filter(member => member.groupId === groupId),
    activeConversation: groupId => ({ conversationId: groups.get(groupId)?.activeConversationId, afterSeq: 0 }),
  };
}

const input = overrides => ({ groupId: 'g1', topic: '是否采用新的发布方案', membershipIds: ['m1', 'm2'], ...overrides });
const debateInput = overrides => input({ mode: 'debate', proMembershipId: 'm1', conMembershipId: 'm2', ...overrides });
function record(repo, overrides = {}) {
  const config = normalizeDiscussionInput(repo, input({ format: 'structured', ...overrides }));
  return { ...config, discussionId: 'd1', conversationId: 'c1', steps: createDiscussionPlan(config) };
}
function promptFor(repo, discussion, step, transcript = []) {
  return buildDiscussionStepPrompt({ repo, groupId: 'g1', botId: repo.getMember(step.membershipId).botId, discussion, step, transcript });
}
const invalidInput = { code: 'invalid-input' };

test('classic normalization preserves enabled roster order and version 2 defaults', () => {
  const repo = fixture();
  const config = normalizeDiscussionInput(repo, input({ membershipIds: undefined, topic: '  议题  ' }));
  assert.equal(config.protocolVersion, 2);
  assert.equal(config.topic, '议题');
  assert.equal(config.mode, 'discussion');
  assert.equal(config.format, 'classic');
  assert.equal(config.rounds, 2);
  assert.equal(config.summarize, false);
  assert.equal(config.responseLength, 'standard');
  assert.equal(config.language, 'auto');
  assert.equal(config.background, '');
  assert.equal(config.goal, '');
  assert.deepEqual(config.memberIds, ['m1', 'm2', 'm3']);
  assert.deepEqual(config.speakerIds, ['m1', 'm2', 'm3']);
  assert.equal(config.summaryMembershipId, 'm1');
  assert.deepEqual(config.contextMessageIds, []);
  assert.deepEqual(config.perspectives, {});
  assert.equal('contextSnapshots' in config, false, 'only the engine captures quotes');
});

test('independent summary membership is snapshotted without joining regular rounds', () => {
  const repo = fixture();
  const original = input({ membershipIds: ['m2', 'm1'], summaryMembershipId: 'm3', summarize: true,
    perspectives: { m2: ' 成本 ' }, expectedConversationId: 'c1' });
  const before = structuredClone(original);
  const config = normalizeDiscussionInput(repo, original);
  assert.deepEqual(original, before);
  assert.deepEqual(config.speakerIds, ['m2', 'm1']);
  assert.deepEqual(config.memberIds, ['m2', 'm1', 'm3']);
  assert.deepEqual(config.participants, [
    { membershipId: 'm2', botId: 'b2', name: '成员2' },
    { membershipId: 'm1', botId: 'b1', name: '成员1' },
    { membershipId: 'm3', botId: 'b3', name: '成员3' },
  ]);
  repo.bots.get('b3').name = '后来改名';
  assert.equal(config.participants[2].name, '成员3');
  assert.deepEqual(config.perspectives, { m2: '成本' });
  assert.equal(config.expectedConversationId, 'c1');
  const plan = createDiscussionPlan(config);
  assert.deepEqual(plan.map(step => step.membershipId), ['m2', 'm1', 'm2', 'm1', 'm3']);
  assert.deepEqual(plan.map(step => step.phase), ['discussion', 'discussion', 'discussion', 'discussion', 'summary']);
});

test('classic permits one speaker, structured requires at least two', () => {
  const repo = fixture();
  const classic = normalizeDiscussionInput(repo, input({ membershipIds: ['m1'], rounds: 1 }));
  assert.equal(createDiscussionPlan(classic).length, 1);
  assert.throws(() => normalizeDiscussionInput(repo, input({ membershipIds: ['m1'], format: 'structured' })), invalidInput);
  const structured = normalizeDiscussionInput(repo, input({ format: 'structured' }));
  assert.equal(structured.rounds, 3);
  assert.equal(structured.summarize, true);
  assert.equal(structured.summaryMembershipId, 'm1');
});

test('start validation rejects malformed values and invalid explicit members', () => {
  const repo = fixture();
  const cases = [
    null, [], 'topic', {}, input({ groupId: '' }), input({ groupId: 'direct' }),
    input({ topic: '  ' }), input({ topic: 5 }), input({ mode: 'other' }), input({ format: 'other' }),
    input({ responseLength: 'long' }), input({ language: 'fr' }), input({ summarize: 'true' }),
    input({ expectedConversationId: 4 }), input({ background: null }), input({ goal: [] }),
    input({ membershipIds: [] }), input({ membershipIds: 'm1' }), input({ membershipIds: [1] }),
    input({ membershipIds: ['m1', 'm1'] }), input({ membershipIds: ['m1', 'missing'] }),
    input({ membershipIds: ['m1', 'm4'] }), input({ membershipIds: ['m1', 'foreign'] }),
    input({ membershipIds: ['m1', 'missing-bot'] }), input({ summaryMembershipId: 'm4' }),
    input({ summaryMembershipId: 1 }), input({ proMembershipId: 'm1' }),
    input({ perspectives: [] }), input({ perspectives: { missing: '视角' } }),
    input({ perspectives: { m1: 1 } }),
  ];
  for (const value of cases) assert.throws(() => normalizeDiscussionInput(repo, value), invalidInput, JSON.stringify(value));
  assert.throws(() => normalizeDiscussionInput(repo, input({ groupId: 'unknown' })), { code: 'not-found' });
  repo.members.set('same-bot', { membershipId: 'same-bot', botId: 'b1', groupId: 'g1' });
  assert.throws(() => normalizeDiscussionInput(repo, input({ membershipIds: ['m1', 'same-bot'] })), invalidInput);
});

test('topic, goal and background enforce exact length limits', () => {
  const repo = fixture();
  for (const [key, limit] of [['topic', 2000], ['goal', 2000], ['background', 12000]]) {
    assert.equal(normalizeDiscussionInput(repo, input({ [key]: 'x'.repeat(limit) }))[key].length, limit);
    assert.throws(() => normalizeDiscussionInput(repo, input({ [key]: 'x'.repeat(limit + 1) })), invalidInput);
  }
});

test('debate positions allow 2000 characters and each perspective allows 500', () => {
  const repo = fixture();
  for (const key of ['proPosition', 'conPosition']) {
    assert.equal(normalizeDiscussionInput(repo, debateInput({ [key]: '立'.repeat(2000) }))[key].length, 2000);
    assert.throws(() => normalizeDiscussionInput(repo, debateInput({ [key]: '立'.repeat(2001) })), invalidInput);
  }
  const perspectives = { m1: '甲'.repeat(500), m2: '乙'.repeat(500) };
  assert.deepEqual(normalizeDiscussionInput(repo, input({ perspectives })).perspectives, perspectives);
  for (const membershipId of ['m1', 'm2']) {
    assert.throws(() => normalizeDiscussionInput(repo, input({
      perspectives: { ...perspectives, [membershipId]: '观'.repeat(501) },
    })), invalidInput);
  }
});

test('context IDs are unique, limited to twenty, and must exist in the same group', () => {
  const repo = fixture();
  const contextMessageIds = Array.from({ length: 20 }, (_, index) => 'msg-' + index);
  assert.deepEqual(normalizeDiscussionInput(repo, input({ contextMessageIds })).contextMessageIds, contextMessageIds);
  assert.deepEqual(normalizeDiscussionInput(repo, input({ contextMessageIds: ['historical'] })).contextMessageIds, ['historical']);
  for (const value of [null, 'msg-0', ['unknown'], ['other-group'], ['msg-0', 'msg-0'], [3], [...contextMessageIds, 'msg-20']]) {
    assert.throws(() => normalizeDiscussionInput(repo, input({ contextMessageIds: value })), invalidInput);
  }
});

test('round counts are strict integers with mode-specific bounds', () => {
  const repo = fixture();
  const variants = [
    { options: {}, min: 1, max: 5 },
    { options: { format: 'structured' }, min: 2, max: 5 },
    { options: { mode: 'debate', proMembershipId: 'm1', conMembershipId: 'm2' }, min: 1, max: 3 },
  ];
  for (const { options, min, max } of variants) {
    for (let rounds = min; rounds <= max; rounds += 1) assert.equal(normalizeDiscussionInput(repo, input({ ...options, rounds })).rounds, rounds);
    for (const rounds of [min - 1, max + 1, 2.5, '2', null, NaN, Infinity]) {
      assert.throws(() => normalizeDiscussionInput(repo, input({ ...options, rounds })), invalidInput);
    }
  }
});

test('classic rounds retain original per-member loop order and stable fresh steps', () => {
  const repo = fixture();
  for (let rounds = 1; rounds <= 5; rounds += 1) {
    const config = normalizeDiscussionInput(repo, input({ rounds, summaryMembershipId: 'm3', summarize: true }));
    const plan = createDiscussionPlan(config);
    assert.equal(plan.length, 2 * rounds + 1);
    for (let round = 1; round <= rounds; round += 1) {
      assert.deepEqual(plan.filter(step => step.phase === 'discussion' && step.round === round).map(step => step.membershipId), ['m1', 'm2']);
    }
    assert.deepEqual(plan.map(step => step.stepId), Array.from({ length: plan.length }, (_, index) => 'step-' + (index + 1)));
    assert.ok(plan.every(step => step.status === 'pending' && step.side === null && step.attempts.length === 0 && step.messageIds.length === 0));
    assert.equal(plan.at(-1).phase, 'summary');
    assert.equal(plan.at(-1).membershipId, 'm3');
    const fresh = createDiscussionPlan(config);
    assert.deepEqual(fresh, plan);
    plan[0].attempts.push({ status: 'error' });
    assert.deepEqual(fresh[0].attempts, []);
    assert.deepEqual(plan[1].attempts, []);
  }
});

test('structured rounds have exact viewpoint, challenge, converge and checkpoint counts', () => {
  const repo = fixture();
  for (let rounds = 2; rounds <= 5; rounds += 1) {
    for (const summarize of [true, false]) {
      const config = normalizeDiscussionInput(repo, input({ format: 'structured', rounds, summarize, summaryMembershipId: 'm3' }));
      const plan = createDiscussionPlan(config);
      const count = phase => plan.filter(step => step.phase === phase).length;
      assert.equal(plan.length, 2 * rounds + rounds - 1 + Number(summarize));
      assert.equal(count('viewpoint'), 2);
      assert.equal(count('challenge'), 2 * (rounds - 2));
      assert.equal(count('converge'), 2);
      assert.equal(count('checkpoint'), rounds - 1);
      assert.equal(count('summary'), Number(summarize));
      assert.equal(count('discussion'), 0);
      assert.ok(plan.filter(step => ['checkpoint', 'summary'].includes(step.phase)).every(step => step.membershipId === 'm3'));
      assert.ok(plan.filter(step => !['checkpoint', 'summary'].includes(step.phase)).every(step => step.membershipId !== 'm3'));
      for (let round = 1; round <= rounds; round += 1) {
        const phase = round === 1 ? 'viewpoint' : round === rounds ? 'converge' : 'challenge';
        const expected = [phase, phase, ...(round < rounds ? ['checkpoint'] : summarize ? ['summary'] : [])];
        assert.deepEqual(plan.filter(step => step.round === round).map(step => step.phase), expected);
      }
    }
  }
});

test('debate normalization requires distinct valid sides and an independent optional judge', () => {
  const repo = fixture();
  const config = normalizeDiscussionInput(repo, debateInput({ judgeMembershipId: 'm3' }));
  assert.equal(config.rounds, 2);
  assert.equal(config.summaryMembershipId, null);
  assert.deepEqual(config.speakerIds, ['m1', 'm2']);
  assert.deepEqual(config.memberIds, ['m1', 'm2', 'm3']);
  assert.deepEqual(normalizeDiscussionInput(repo, debateInput({ membershipIds: undefined })).speakerIds, ['m1', 'm2']);
  assert.deepEqual(normalizeDiscussionInput(repo, debateInput({ membershipIds: ['m1', 'm2', 'm3'], judgeMembershipId: 'm3' })).memberIds, ['m1', 'm2', 'm3']);
  for (const overrides of [
    { proMembershipId: undefined }, { conMembershipId: 'm1' }, { judgeMembershipId: 'm1' },
    { judgeMembershipId: 'm2' }, { judgeMembershipId: 'm4' }, { proMembershipId: 'missing' },
    { membershipIds: ['m1'] }, { membershipIds: ['m1', 'm2', 'm3'] }, { summaryMembershipId: 'm3' },
  ]) assert.throws(() => normalizeDiscussionInput(repo, debateInput(overrides)), invalidInput);
});

test('debate has two openings, four steps per round, two closings and judge independent of summarize', () => {
  const repo = fixture();
  for (let rounds = 1; rounds <= 3; rounds += 1) {
    for (const judgeMembershipId of [null, 'm3']) {
      for (const summarize of [true, false]) {
        const plan = createDiscussionPlan(normalizeDiscussionInput(repo, debateInput({ rounds, judgeMembershipId, summarize })));
        assert.equal(plan.length, 4 + 4 * rounds + Number(Boolean(judgeMembershipId)));
        assert.deepEqual(plan.slice(0, 2).map(step => [step.phase, step.side]), [['opening', 'pro'], ['opening', 'con']]);
        assert.equal(plan.filter(step => step.phase === 'summary').length, 0);
        for (let round = 1; round <= rounds; round += 1) {
          const exchange = plan.filter(step => step.round === round && ['question', 'answer'].includes(step.phase));
          assert.deepEqual(exchange.map(step => step.phase), ['question', 'answer', 'question', 'answer']);
          assert.deepEqual(exchange.filter(step => step.phase === 'question').map(step => step.side), round % 2 ? ['pro', 'con'] : ['con', 'pro']);
          assert.equal(exchange[1].targetStepId, exchange[0].stepId);
          assert.equal(exchange[3].targetStepId, exchange[2].stepId);
          assert.notEqual(exchange[1].membershipId, exchange[0].membershipId);
          assert.notEqual(exchange[3].membershipId, exchange[2].membershipId);
        }
        const closings = plan.filter(step => step.phase === 'closing');
        assert.deepEqual(closings.map(step => step.side), ['pro', 'con']);
        assert.ok(closings.every(step => step.round === rounds));
        assert.equal(plan.at(-1).phase, judgeMembershipId ? 'judgement' : 'closing');
        assert.ok(plan.filter(step => step.membershipId === 'm3').every(step => step.phase === 'judgement'));
      }
    }
  }
});

test('every debate question targets the latest substantive statement from its opponent', () => {
  const repo = fixture();
  const plan = createDiscussionPlan(normalizeDiscussionInput(repo, debateInput({ rounds: 3 })));
  const questions = plan.filter(step => step.phase === 'question');
  assert.deepEqual(questions.map(step => [step.stepId, step.targetStepId]), [
    ['step-3', 'step-2'], ['step-5', 'step-1'],
    ['step-7', 'step-6'], ['step-9', 'step-4'],
    ['step-11', 'step-10'], ['step-13', 'step-8'],
  ]);
  for (const question of questions) {
    const target = plan.find(step => step.stepId === question.targetStepId);
    assert.notEqual(target.membershipId, question.membershipId);
    assert.ok(['opening', 'answer'].includes(target.phase));
    assert.ok(plan.indexOf(target) < plan.indexOf(question));
  }
});

test('active statuses include paused, pausing, finalizing and stopping', () => {
  assert.ok(Object.isFrozen(DISCUSSION_ACTIVE_STATUSES));
  assert.deepEqual(DISCUSSION_ACTIVE_STATUSES, ['running', 'pausing', 'paused', 'finalizing', 'stopping']);
  for (const status of DISCUSSION_ACTIVE_STATUSES) assert.equal(isDiscussionActive({ status }), true);
  for (const status of ['done', 'stopped', 'error', '', undefined]) assert.equal(isDiscussionActive({ status }), false);
  assert.equal(isDiscussionActive(null), false);
});

test('step prompt uses explicit snapshots, supplements and stable participant names', () => {
  const repo = fixture();
  const discussion = record(repo, { goal: '确认边界', background: '发布材料', perspectives: { m1: '关注成本' } });
  discussion.contextSnapshots = [{ messageId: 'historical', conversationId: 'old', text: '明确选择的历史快照',
    author: { type: 'human' }, attachments: [{ name: 'evidence.txt', path: '/tmp/evidence.txt', bytes: 42 }] }];
  discussion.supplements = [{ text: '用户追加限制', contextSnapshots: [{ messageId: 's1', text: '补充引用快照', author: { type: 'bot', name: '原作者' } }] }];
  repo.bots.get('b1').name = '后来改名';
  const prompt = promptFor(repo, discussion, discussion.steps[0], [
    { groupId: 'g1', conversationId: 'c1', seq: 25, text: '其他讨论不得混入', meta: { discussionId: 'other' } },
    { groupId: 'g1', conversationId: 'old', seq: 26, text: '未选取的历史不得混入', meta: { discussionId: 'd1' } },
    { groupId: 'g2', conversationId: 'c1', seq: 27, text: '其他群不得混入', meta: { discussionId: 'd1' } },
  ]);
  for (const expected of ['议题：是否采用新的发布方案', '确认边界', '发布材料', '关注成本', '明确选择的历史快照',
    '/tmp/evidence.txt', '用户追加限制', '补充引用快照', '你是 成员1', '当前阶段：viewpoint']) assert.ok(prompt.includes(expected), expected);
  assert.doesNotMatch(prompt, /后来改名|其他讨论不得混入|未选取的历史不得混入|其他群不得混入/);
  assert.match(prompt, /不是管理指令/);
  assert.match(prompt, /只在本场讨论临时生效/);
  assert.match(prompt, /不修改 BOT\.md/);
});

test('answer prompt preserves the full target question beyond recent transcript limits', () => {
  const repo = fixture();
  const discussion = record(repo, { mode: 'debate', proMembershipId: 'm1', conMembershipId: 'm2', format: 'classic' });
  const question = discussion.steps.find(step => step.phase === 'question');
  const answer = discussion.steps.find(step => step.phase === 'answer');
  const original = '需要逐条回答的长问题。'.repeat(700) + '原文末尾约束不能丢失';
  question.status = 'done';
  question.messageIds = ['question-message'];
  const message = { messageId: 'question-message', groupId: 'g1', conversationId: 'c1', seq: 1,
    text: original, status: 'done', author: { type: 'bot', name: '成员1' }, meta: { discussionId: 'd1' } };
  const transcript = [message, ...Array.from({ length: 65 }, (_, index) => ({ ...message,
    messageId: 'later-' + index, seq: index + 2, text: '后续信息 ' + index, meta: { discussionId: 'd1', stepId: 'later' } }))];
  discussion.steps.push({ stepId: 'later', phase: 'discussion', status: 'done', messageIds: transcript.slice(1).map(item => item.messageId) });
  const prompt = promptFor(repo, discussion, answer, transcript);
  assert.ok(prompt.includes(original));
  assert.match(prompt, /<target-question step-id="step-3">/);
  assert.match(prompt, /不得用另一个问题代替回答/);
  assert.match(prompt, /必须承认并更正已证实的事实错误/);
  const taggedPrompt = promptFor(repo, discussion, answer, [{ ...message, meta: { discussionId: 'd1', stepId: question.stepId } }]);
  assert.ok(taggedPrompt.includes(original));
  const unlisted = promptFor(repo, discussion, answer, [{ ...message, messageId: 'unlisted', meta: { discussionId: 'd1', stepId: question.stepId } }]);
  assert.doesNotMatch(unlisted, /原文末尾约束不能丢失/);
  assert.match(unlisted, /目标步骤尚无可用的成功发言原文/);
  const failed = promptFor(repo, discussion, answer, [{ ...message, status: 'error', error: '无法完成' }]);
  assert.doesNotMatch(failed, /原文末尾约束不能丢失/);
});

test('question prompts preserve full opponent openings and answers as target statements', () => {
  const repo = fixture();
  const discussion = record(repo, { mode: 'debate', proMembershipId: 'm1', conMembershipId: 'm2', rounds: 2 });
  const questions = discussion.steps.filter(step => step.phase === 'question');
  for (const question of [questions[0], questions[3]]) {
    const target = discussion.steps.find(step => step.stepId === question.targetStepId);
    const original = ('对方的' + target.phase + '具体论证。').repeat(700) + '目标原文末尾限定';
    target.status = 'done';
    target.messageIds = ['target-' + target.stepId];
    const message = { messageId: target.messageIds[0], groupId: 'g1', conversationId: 'c1', seq: 1,
      text: original, status: 'done', author: { type: 'bot', name: '对方成员' }, meta: { discussionId: 'd1', stepId: target.stepId } };
    const transcript = [message, ...Array.from({ length: 65 }, (_, index) => ({ ...message,
      messageId: 'recent-' + index, seq: index + 2, text: '最近发言 ' + index, meta: { discussionId: 'd1', stepId: 'recent' } }))];
    discussion.steps.push({ stepId: 'recent-' + question.stepId, phase: 'discussion', status: 'done', messageIds: transcript.slice(1).map(item => item.messageId) });
    for (const message of transcript.slice(1)) message.meta.stepId = 'recent-' + question.stepId;
    const prompt = promptFor(repo, discussion, question, transcript);
    assert.ok(prompt.includes(original));
    assert.ok(prompt.includes('<target-statement step-id="' + target.stepId + '">'));
    assert.match(prompt, /必须质询的对方发言原文/);
    assert.match(prompt, /针对 target-statement 中对方的发言原文/);
    assert.doesNotMatch(prompt, /<target-question|必须直接回答的目标问题原文/);
  }
});

test('failed native multi-turn fragments are excluded after a successful retry of openings or questions', () => {
  const repo = fixture();
  for (const phase of ['opening', 'question']) {
    const discussion = record(repo, { mode: 'debate', proMembershipId: 'm1', conMembershipId: 'm2', judgeMembershipId: 'm3' });
    const consumer = discussion.steps.find(step => step.phase === (phase === 'opening' ? 'question' : 'answer'));
    const target = discussion.steps.find(step => step.stepId === consumer.targetStepId);
    const failedAttempt = { attemptId: 'failed-attempt', status: 'error', messageIds: ['failed-turn-1', 'failed-turn-2', 'failed-turn-3'] };
    const retry = { attemptId: 'successful-retry', status: 'running', messageIds: ['retry-turn-1', 'retry-turn-2', 'wrong-attempt', 'wrong-step', 'missing-attempt'] };
    target.status = 'running';
    target.attempts = [failedAttempt, retry];
    target.messageIds = [...failedAttempt.messageIds, ...retry.messageIds];
    const message = (id, text, attemptId, status = 'done') => ({ messageId: id, groupId: 'g1', conversationId: 'c1',
      seq: 1, status, text, meta: { discussionId: 'd1', stepId: target.stepId, attemptId } });
    const transcript = [
      message('failed-turn-1', '废弃执行第一段错误论据', failedAttempt.attemptId),
      message('failed-turn-2', '废弃执行第二段错误论据', failedAttempt.attemptId),
      message('failed-turn-3', '废弃执行最终失败', failedAttempt.attemptId, 'error'),
      message('retry-turn-1', '成功重试第一段有效论据', retry.attemptId),
      message('retry-turn-2', '成功重试第二段有效论据', retry.attemptId),
      message('wrong-attempt', '归属错误的执行片段', failedAttempt.attemptId),
      { ...message('wrong-step', '归属错误的步骤片段', retry.attemptId), meta: { discussionId: 'd1', stepId: 'different-step', attemptId: retry.attemptId } },
      message('missing-attempt', '缺少执行归属的片段', undefined),
      message('unlisted', '未列入成功消息名单的片段', retry.attemptId),
    ].map((item, index) => ({ ...item, seq: index + 1 }));
    const inflight = promptFor(repo, discussion, consumer, transcript);
    assert.doesNotMatch(inflight, /废弃执行|成功重试|归属错误|缺少执行归属|未列入成功消息名单/);
    assert.match(inflight, /目标步骤尚无可用的成功发言原文/);
    target.status = retry.status = 'done';
    const originalTranscript = structuredClone(transcript);
    for (const current of [consumer, discussion.steps.find(step => step.phase === 'closing'), discussion.steps.at(-1)]) {
      const prompt = promptFor(repo, discussion, current, transcript);
      assert.match(prompt, /成功重试第一段有效论据/);
      assert.match(prompt, /成功重试第二段有效论据/);
      assert.doesNotMatch(prompt, /废弃执行|归属错误|缺少执行归属|未列入成功消息名单/);
    }
    const targetPrompt = promptFor(repo, discussion, consumer, transcript);
    const targetBlock = targetPrompt.match(/<target-(?:statement|question)[^>]*>([\s\S]*?)<\/target-(?:statement|question)>/)[1];
    assert.match(targetBlock, /成功重试第一段有效论据/);
    assert.match(targetBlock, /成功重试第二段有效论据/);
    assert.deepEqual(transcript, originalTranscript, 'raw UI transcript remains unchanged');
  }
});

test('only the last successful attempt of a done step can supply target evidence', () => {
  const repo = fixture();
  const discussion = record(repo, { mode: 'debate', proMembershipId: 'm1', conMembershipId: 'm2' });
  const consumer = discussion.steps.find(step => step.phase === 'answer');
  const target = discussion.steps.find(step => step.stepId === consumer.targetStepId);
  target.status = 'done';
  target.attempts = [
    { attemptId: 'old', status: 'done', messageIds: ['old-message'] },
    { attemptId: 'new', status: 'done', messageIds: ['new-message'] },
  ];
  target.messageIds = ['old-message', 'new-message'];
  const transcript = target.attempts.map((attempt, index) => ({ messageId: attempt.messageIds[0], groupId: 'g1', conversationId: 'c1',
    seq: index + 1, status: 'done', text: index ? '最新成功问句' : '旧成功问句',
    meta: { discussionId: 'd1', stepId: target.stepId, attemptId: attempt.attemptId } }));
  const prompt = promptFor(repo, discussion, consumer, transcript);
  assert.match(prompt, /最新成功问句/);
  assert.doesNotMatch(prompt, /旧成功问句/);
  for (const status of ['pending', 'running', 'error', 'skipped']) {
    target.status = status;
    const excluded = promptFor(repo, discussion, consumer, transcript);
    assert.doesNotMatch(excluded, /最新成功问句|旧成功问句/);
    assert.match(excluded, /目标步骤尚无可用的成功发言原文/);
  }
});

test('failed attempt fragments cannot fill missing opening or closing judgement evidence', () => {
  const repo = fixture();
  const discussion = record(repo, { mode: 'debate', proMembershipId: 'm1', conMembershipId: 'm2', judgeMembershipId: 'm3' });
  const material = discussion.steps.filter(step => ['opening', 'closing'].includes(step.phase));
  const transcript = material.flatMap((step, index) => {
    step.status = 'done';
    const failed = { attemptId: 'failed-' + index, status: 'error', messageIds: ['failed-' + index] };
    const success = { attemptId: 'success-' + index, status: 'done', messageIds: ['success-' + index] };
    step.attempts = [failed, success];
    step.messageIds = [...failed.messageIds, ...success.messageIds];
    return [failed, success].map((attempt, nativeTurn) => ({ messageId: attempt.messageIds[0], groupId: 'g1', conversationId: 'c1',
      seq: index * 2 + nativeTurn + 1, status: 'done', text: (nativeTurn ? '成功有效论据' : '失败执行残留论据') + index,
      meta: { discussionId: 'd1', stepId: step.stepId, attemptId: attempt.attemptId } }));
  });
  const judgement = discussion.steps.at(-1);
  const complete = promptFor(repo, discussion, judgement, transcript);
  assert.doesNotMatch(complete, /材料检查：缺少|失败执行残留论据/);
  for (const target of material) {
    const success = target.attempts.at(-1);
    const withoutSuccess = transcript.filter(message => !success.messageIds.includes(message.messageId));
    const missing = promptFor(repo, discussion, judgement, withoutSuccess);
    assert.match(missing, /第一行必须严格输出 Verdict: insufficient/);
    assert.match(missing, /成功发言原文缺失，不得补写/);
    assert.doesNotMatch(missing, /失败执行残留论据/);
    const wrongAttempt = transcript.map(message => success.messageIds.includes(message.messageId)
      ? { ...message, meta: { ...message.meta, attemptId: target.attempts[0].attemptId } } : message);
    assert.match(promptFor(repo, discussion, judgement, wrongAttempt), /第一行必须严格输出 Verdict: insufficient/);
  }
});

test('phase prompts define consensus, closing and judgement templates', () => {
  const repo = fixture();
  const discussion = record(repo, { summaryMembershipId: 'm3' });
  for (const phase of ['checkpoint', 'summary']) {
    const prompt = promptFor(repo, discussion, discussion.steps.find(step => step.phase === phase));
    assert.match(prompt, /只有相关参与者明确认可的内容才能称为共识/);
    assert.match(prompt, /沉默、未反驳或总结者自己的判断不算认可/);
    assert.match(prompt, /待验证事实/);
  }
  const debate = record(repo, { mode: 'debate', proMembershipId: 'm1', conMembershipId: 'm2', judgeMembershipId: 'm3',
    proPosition: '按新方案发布', conPosition: '保留现有方案' });
  const closing = promptFor(repo, debate, debate.steps.find(step => step.phase === 'closing'));
  assert.match(closing, /## 最终立场/);
  assert.match(closing, /## 对方最强论点及回应/);
  assert.match(closing, /## 我方承认的事实错误与更正/);
  assert.match(closing, /按新方案发布/);
  assert.match(closing, /保留现有方案/);
  const judgement = promptFor(repo, debate, debate.steps.at(-1));
  assert.match(judgement, /本步骤身份：独立裁判/);
  assert.match(judgement, /Verdict: pro、Verdict: con、Verdict: tie 或 Verdict: insufficient/);
  assert.match(judgement, /证据或完成的问答不足以可靠裁决/);
  assert.match(judgement, /## 裁决理由/);
});

test('partial and finish-requested summaries disclose unfinished phases', () => {
  const repo = fixture();
  for (const flag of ['partial', 'finishRequested']) {
    const discussion = { ...record(repo), [flag]: true };
    const prompt = promptFor(repo, discussion, discussion.steps.find(step => step.phase === 'summary'));
    assert.match(prompt, /正在提前收束/);
    assert.match(prompt, /只能根据已完成的有效发言总结/);
    assert.match(prompt, /尚未完成阶段不得假称已完成/);
    assert.match(prompt, /不得补写未发生的回答、结辩或共识/);
  }
});

test('judgement requires completed valid openings and closings from both sides', () => {
  const repo = fixture();
  const discussion = record(repo, { mode: 'debate', proMembershipId: 'm1', conMembershipId: 'm2', judgeMembershipId: 'm3' });
  const judgement = discussion.steps.at(-1);
  const material = discussion.steps.filter(step => ['opening', 'closing'].includes(step.phase));
  const transcript = material.map((step, index) => {
    step.status = 'done';
    step.messageIds = ['material-' + index];
    return { messageId: 'material-' + index, groupId: 'g1', conversationId: 'c1', seq: index + 1,
      status: 'done', text: '已完成的有效论证', meta: { discussionId: 'd1', stepId: step.stepId } };
  });
  assert.doesNotMatch(promptFor(repo, discussion, judgement, transcript), /材料检查：缺少/);
  for (const missing of material) {
    const without = transcript.filter(message => message.meta.stepId !== missing.stepId);
    assert.match(promptFor(repo, discussion, judgement, without), /第一行必须严格输出 Verdict: insufficient/);
    missing.status = 'skipped';
    assert.match(promptFor(repo, discussion, judgement, transcript), /不得判定任何一方胜出或平局/);
    missing.status = 'done';
  }
  const invalid = [{ ...transcript[0], status: 'error' }, ...transcript.slice(1)];
  assert.match(promptFor(repo, discussion, judgement, invalid), /第一行必须严格输出 Verdict: insufficient/);
  const empty = [{ ...transcript[0], text: ' ' }, ...transcript.slice(1)];
  assert.match(promptFor(repo, discussion, judgement, empty), /第一行必须严格输出 Verdict: insufficient/);
});

test('prompt language and length hints follow the chosen configuration', () => {
  const repo = fixture();
  for (const language of ['auto', 'zh', 'en']) {
    for (const responseLength of ['short', 'standard', 'detailed']) {
      const discussion = record(repo, { language, responseLength });
      const prompt = promptFor(repo, discussion, discussion.steps[0]);
      assert.ok(prompt.includes('篇幅 ' + responseLength));
      assert.ok(prompt.includes(language === 'en' ? 'Output language: English' : language === 'zh' ? '输出语言：中文' : '跟随议题使用的主要语言'));
    }
  }
});

test('step prompts reject historical discussion targets and mismatched speakers', () => {
  const repo = fixture();
  const discussion = record(repo);
  assert.throws(() => promptFor(repo, { ...discussion, conversationId: 'old' }, discussion.steps[0]), { code: 'historical-target' });
  assert.throws(() => buildDiscussionStepPrompt({ repo, botId: 'b2', groupId: 'g1', discussion, step: discussion.steps[0], transcript: [] }), invalidInput);
  for (const phase of ['invalid', '__proto__', 'toString']) {
    assert.throws(() => promptFor(repo, discussion, { ...discussion.steps[0], phase }), invalidInput);
  }
});

test('debate verdict parser accepts only explicit unambiguous enum declarations', () => {
  for (const verdict of ['pro', 'con', 'tie', 'insufficient']) {
    assert.equal(parseDebateVerdict('Verdict: ' + verdict + '\n\n## Reasons\nEvidence.'), verdict);
    assert.equal(parseDebateVerdict('\n裁决：' + verdict + '\n理由'), verdict);
    assert.equal(parseDebateVerdict('**Verdict: ' + verdict + '**\n理由'), verdict);
  }
  for (const text of [undefined, null, '', '正方获胜', '我倾向 con', '结论：pro', '裁决：正方',
    'Verdict: pro or con', 'Verdict: probability', 'Verdict: pro!','理由：\nVerdict: pro',
    '> Verdict: con', '\x60\x60\x60\nVerdict: pro\n\x60\x60\x60', 'Verdict: pro\nVerdict: con']) {
    assert.equal(parseDebateVerdict(text), null, String(text));
  }
});

test('legacy discussion and summary prompt exports remain usable', () => {
  const repo = fixture();
  const discussion = record(repo, { format: 'classic' });
  assert.match(buildDiscussionPrompt({ repo, botId: 'b1', groupId: 'g1', discussion, round: 1, transcript: [] }), /本轮观点/);
  assert.match(buildSummaryPrompt({ repo, botId: 'b1', groupId: 'g1', discussion, transcript: [] }), /共识/);
});
