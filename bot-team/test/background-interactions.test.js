import test from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundInteractions, validateBackgroundAnswer } from '../host/background-interactions.js';

const questions = [
  { id: 'choice', header: 'Choose', question: 'Which?', detail: 'Full native detail', options: [{ label: 'A', description: 'First' }, { label: 'B' }], multiSelect: false },
  { id: 'notes', question: 'Details?' },
];
const answer = { answers: [{ id: 'choice', selected: ['B'] }, { id: 'notes', selected: [], custom: 'unchanged\nanswer' }] };
const nativeError = code => Object.assign(new Error(code), { name: 'UserQuestionError', code });

function fixture(t) {
  const agent = { id: 'session-one', session: { id: 'session-one', header: { origin: 'subagent' } } };
  const other = { id: 'session-two', session: { id: 'session-two' } };
  const child = { id: 'child', session: { id: 'child' } };
  const live = new Map([agent, other, child].map(value => [value.id, value]));
  const roots = [agent, other];
  const repo = {
    groups: new Map([['one', {}], ['two', {}]]), bots: new Map([['bot', { name: 'Bot' }]]),
    members: new Map([['member', { membershipId: 'member', groupId: 'one', botId: 'bot', sessionId: agent.id }],
      ['other', { membershipId: 'other', groupId: 'two', botId: 'bot', sessionId: other.id }]]),
  };
  const handlers = new Map();
  const frames = [], replies = [], active = [];
  let answerImplementation = async (...args) => { replies.push(args); return true; };
  const ctx = {
    get(name) { return this[name]; },
    agents: { get: id => live.get(id), roots: () => roots },
    sessionProjections: { stateOf: session => ({ questions: { active: session === agent.session ? active : [], settled: [] } }) },
    userQuestions: { answer: (...args) => answerImplementation(...args) },
    on(name, callback, options) {
      handlers.set(name, { callback, options });
      return () => handlers.delete(name);
    },
  };
  const adapter = new BackgroundInteractions({ ctx, repo, bus: { emit: (groupId, frame) => frames.push({ groupId, frame }) } });
  t.after(() => adapter.dispose());
  const request = (kind, data = {}) => handlers.get(kind === 'approval' ? 'approval/request' : 'user-questions/request').callback({ agent, questions, ...data }, () => 'next-provider');
  const item = () => adapter.snapshot('one').interactions[0];
  const respond = (extra, entry = item()) => adapter.respond({ groupId: entry.groupId, sessionId: entry.sessionId, interactionId: entry.interactionId, operation: 'answer', ...extra });
  return { adapter, request, item, respond, ctx, repo, agent, other, child, live, roots, handlers, frames, active, replies,
    answerWith: implementation => { answerImplementation = implementation; } };
}

test('global providers only claim exact repository members that are live runtime roots', async t => {
  const f = fixture(t);
  for (const name of ['approval/request', 'user-questions/request']) assert.deepEqual(f.handlers.get(name).options, { global: true, prepend: true });
  assert.equal(f.request('question', { agent: f.child }), 'next-provider');
  assert.equal(f.request('question', { agent: { ...f.agent } }), 'next-provider');
  f.repo.members.set('child-member', { membershipId: 'child-member', groupId: 'one', botId: 'bot', sessionId: f.child.id });
  assert.equal(f.request('approval', { agent: f.child }), 'next-provider', 'a real delegated child is never intercepted');
  const pending = f.request('question');
  assert.deepEqual(f.item().questions, questions);
  assert.equal(f.item().sessionId, f.agent.id, 'durable subagent lineage does not exclude a runtime root');
  assert.equal(f.adapter.snapshot('two').interactions.length, 0);
  await f.respond({ answer });
  assert.deepEqual(await pending, answer);
});

test('responses require exact interaction, group, session and current membership', async t => {
  const f = fixture(t);
  const pending = f.request('question');
  const failure = assert.rejects(pending, { code: 'ASK_ABORTED' });
  const item = f.item();
  for (const change of [{ groupId: 'two' }, { sessionId: f.other.id }, { interactionId: 'unknown' }]) {
    await assert.rejects(f.respond({ answer, ...change }), { code: 'invalid-interaction' });
  }
  assert.equal(f.item().state, 'pending');
  f.repo.members.delete('member');
  await assert.rejects(f.respond({ answer }, item), { code: 'invalid-interaction' });
  await failure;
  assert.equal(f.adapter.snapshot('one').interactions.length, 0);
});

test('native single choice, multiple choice, custom answers and explicit skip are validated', () => {
  assert.deepEqual(validateBackgroundAnswer(questions, answer), answer);
  const invalid = [
    { answers: [] }, { answers: [answer.answers[0], answer.answers[0]] },
    { answers: [{ id: 'choice', selected: ['missing'] }, answer.answers[1]] },
    { answers: [{ id: 'choice', selected: ['A', 'B'] }, answer.answers[1]] },
    { answers: [{ id: 'choice', selected: ['A', 'A'] }, answer.answers[1]] },
    { answers: [answer.answers[0], { id: 'notes', selected: [], custom: {} }] },
  ];
  for (const value of invalid) assert.throws(() => validateBackgroundAnswer(questions, value), { code: 'invalid-interaction' });
  const multi = [{ ...questions[0], multiSelect: true }];
  const selected = { answers: [{ id: 'choice', selected: ['A', 'B'] }] };
  assert.deepEqual(validateBackgroundAnswer(multi, selected), selected);
  const skipped = { answers: questions.map(question => ({ id: question.id, selected: [] })) };
  assert.deepEqual(validateBackgroundAnswer(questions, skipped), skipped);
});

test('approval decisions settle the original waterfall once and never use Agent RPC', async t => {
  const f = fixture(t);
  const pending = f.request('approval', { toolName: 'bash', reason: 'Need access' });
  const item = f.item();
  await assert.rejects(f.respond({ outcome: 'always' }), { code: 'invalid-interaction' });
  await f.respond({ outcome: 'allowed-once' });
  assert.equal(await pending, 'allowed-once');
  await assert.rejects(f.respond({ outcome: 'rejected' }, item), { code: 'invalid-interaction' });
  assert.equal(f.replies.length, 0);
  assert.ok(f.frames.every(({ groupId, frame }) => groupId === 'one' && frame.type === 'interaction.updated'));
  assert.equal(f.frames.at(-1).frame.interactions.length, 0);
});

test('abort, native cancellation, member removal and dispose settle pending requests', async t => {
  const f = fixture(t);
  const abort = new AbortController();
  const approval = f.request('approval', { signal: abort.signal });
  abort.abort();
  assert.equal(await approval, 'cancelled');
  const question = f.request('question');
  const rejected = assert.rejects(question, { name: 'UserQuestionError', code: 'ASK_CANCELLED' });
  await f.respond({ operation: 'cancel' });
  await rejected;
  const disposed = f.request('question');
  const disposedRejection = assert.rejects(disposed, { code: 'ASK_ABORTED' });
  f.adapter.dispose();
  await disposedRejection;
  assert.equal(f.handlers.size, 0);
  assert.equal(f.adapter.snapshot('one').interactions.length, 0);
});

test('timed expiry transitions to recoverable continued questions and accepts late Host answers', async t => {
  const f = fixture(t);
  const signal = new AbortController();
  const pending = f.request('question', { wait: { timed: true, callId: 'call-one' }, signal: signal.signal });
  const ended = assert.rejects(pending, { code: 'ASK_TIMED_OUT' });
  const interactionId = f.item().interactionId;
  signal.abort(nativeError('ASK_TIMED_OUT'));
  await ended;
  assert.equal(f.item().state, 'continuing');
  f.active.push({ callId: 'call-one', questions, state: 'continued' });
  f.handlers.get('session/event').callback(f.agent.session, { type: 'tool/result' });
  assert.equal(f.item().state, 'continued');
  assert.equal(f.item().interactionId, interactionId);
  await f.respond({ answer });
  assert.deepEqual(f.replies[0], [f.agent, 'call-one', answer]);
  assert.equal(f.item().state, 'queued');
  await assert.rejects(f.respond({ answer }), { code: 'invalid-interaction' });
  f.active.length = 0;
  assert.equal(f.adapter.snapshot('one').interactions.length, 0);
});

test('continue uses native timeout semantics while untimed questions cannot be continued', async t => {
  const f = fixture(t);
  const untimed = f.request('question');
  await assert.rejects(f.respond({ operation: 'continue' }), { code: 'invalid-interaction' });
  await f.respond({ answer });
  await untimed;
  const timed = f.request('question', { wait: { timed: true, callId: 'timed' } });
  const ended = assert.rejects(timed, { code: 'ASK_TIMED_OUT' });
  await f.respond({ operation: 'continue' });
  await ended;
});

test('reconnect recovers only continued native projections, and clears them after an actor is replaced', async t => {
  const f = fixture(t);
  f.active.push({ callId: 'restored', questions, state: 'continued' });
  f.active.push({ callId: 'not-continued', questions, state: 'open' });
  const entries = f.adapter.snapshot('one').interactions;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].callId, 'restored');
  assert.equal(f.adapter.snapshot('two').interactions.length, 0, 'recovery reads the exact member Session projection');
  f.live.delete(f.agent.id);
  assert.equal(f.adapter.snapshot('one').interactions.length, 0);
  await assert.rejects(f.respond({ answer }, entries[0]), { code: 'invalid-interaction' });
});

test('late-answer errors preserve retryability, queued duplicate replies become read-only', async t => {
  const f = fixture(t);
  f.active.push({ callId: 'late', questions, state: 'continued' });
  f.answerWith(async () => { throw new Error('temporary failure'); });
  await assert.rejects(f.respond({ answer }), /temporary failure/);
  assert.equal(f.item().state, 'continued');
  f.answerWith(async () => { throw nativeError('REPLY_QUEUED'); });
  await f.respond({ answer });
  assert.equal(f.item().state, 'queued');
});
