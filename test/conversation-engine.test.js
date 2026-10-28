import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../host/engine.js';
import { buildTurnPrompt, buildReviewPrompt, buildTaskPrompt, buildSummaryPrompt } from '../host/prompt.js';
import { readBotSessionHistory, readMessageExecution } from '../host/execution.js';
import { resolveConfig } from '../host/util.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

function fixture(t, options = {}) {
  const groups = new Map([['group', { groupId: 'group', title: 'Group', nextSeq: 3, activeConversationId: 'conv-2', conversationVersion: 2 }]]);
  const conversations = new Map([
    ['conv-1', { conversationId: 'conv-1', groupId: 'group', ordinal: 1, afterSeq: 0, previousConversationId: null }],
    ['conv-2', { conversationId: 'conv-2', groupId: 'group', ordinal: 2, afterSeq: 3, previousConversationId: 'conv-1' }],
  ]);
  const members = new Map([['member', { membershipId: 'member', botId: 'bot', groupId: 'group', sessionId: 'old-session', sessionConversationId: 'conv-1', lastSeenSeq: 3 }]]);
  const bots = new Map([['bot', { botId: 'bot', name: 'Tester', provider: 'mock', model: 'mock' }]]);
  const bindings = new Map([['old-session', { sessionId: 'old-session', groupId: 'group', conversationId: 'conv-1', membershipId: 'member', botId: 'bot' }]]);
  const messages = new Map();
  for (const [seq, text] of ['OLD_SELECTED', 'OLD_NEIGHBOR', 'OLD_REPLY'].entries()) messages.set('old-' + (seq + 1), {
    messageId: 'old-' + (seq + 1), groupId: 'group', seq: seq + 1, text, status: 'done', kind: 'chat',
    author: seq === 2 ? { type: 'bot', membershipId: 'member', botId: 'bot', name: 'Tester' } : { type: 'human', name: '用户' },
  });
  const tasks = new Map(); const discussions = new Map(); const agents = new Map();
  const frames = []; const submissions = []; const memberWrites = []; const hooks = []; const ensures = [];
  const repo = {
    groups, conversations, members, messages, tasks, discussions,
    getGroup: id => groups.get(id), getMember: id => members.get(id), getBot: id => bots.get(id), getMessage: id => messages.get(id),
    getTask: id => tasks.get(id), getDiscussion: id => discussions.get(id),
    activeConversation: gid => conversations.get(groups.get(gid)?.activeConversationId),
    conversationsOf: gid => [...conversations.values()].filter(c => c.groupId === gid),
    conversationFor(record) {
      if (!record) return undefined;
      const found = record.conversationId ? conversations.get(record.conversationId) :
        Number.isInteger(record.seq) ? repo.conversationsOf(record.groupId).findLast(c => record.seq > c.afterSeq) : conversations.get('conv-1');
      return found?.groupId === record.groupId ? found : undefined;
    },
    sessionBindingsOf: (gid, cid) => [...bindings.values()].filter(b => b.groupId === gid && (!cid || b.conversationId === cid)),
    sessionBindingFor: sid => bindings.get(sid),
    membersOf: gid => [...members.values()].filter(m => m.groupId === gid),
    messagesOf: gid => [...messages.values()].filter(m => m.groupId === gid).sort((a, b) => a.seq - b.seq),
    messagesBetween: (gid, from, to) => repo.messagesOf(gid).filter(m => m.seq > from && m.seq <= to),
    lastMessageOf: gid => repo.messagesOf(gid).at(-1),
    allocateSeq: gid => ++groups.get(gid).nextSeq,
    appendMessage(message) { messages.set(message.messageId, message); },
    putMessage(message) { messages.set(message.messageId, message); return Promise.resolve(); },
    async putMessageStrict(message) { await repo.beforeMessageWrite?.(message); messages.set(message.messageId, message); },
    async putMemberStrict(member, expected) {
      await repo.beforeMemberWrite?.(member);
      assert.equal(expected.expectedConversationId, groups.get(member.groupId).activeConversationId);
      assert.equal(expected.expectedSessionId, members.get(member.membershipId).sessionId);
      memberWrites.push(structuredClone(member)); members.set(member.membershipId, structuredClone(member));
      return members.get(member.membershipId);
    },
    touchMember() { assert.fail('Engine must use strict writes on the latest member'); },
    putDiscussion(discussion) { discussions.set(discussion.discussionId, discussion); return repo.beforeDiscussionWrite?.(discussion) || Promise.resolve(); },
    discussionsOf: gid => [...discussions.values()].filter(d => d.groupId === gid),
    activeDiscussionOf: gid => repo.discussionsOf(gid).find(d => d.status === 'running'),
  };
  const ctx = {
    on: () => () => {}, agents: { get: id => agents.get(id) },
    get(name) {
      if (name === 'attachments') return { fileHostPath: ref => ref.attachmentId === 'good-file' ? '/attachments/example.txt' : null };
      if (name === 'goals') return { get: () => options.goal };
      if (name === 'sessionQuery') return options.query;
    },
  };
  function agent(sid) {
    if (!agents.has(sid)) agents.set(sid, {
      id: sid, session: { id: sid, seq: 0, events: [], snapshotEvents() { return this.events; } },
      cancel() {}, followup: async input => { submissions.push({ sessionId: sid, input: structuredClone(input) }); },
    });
    return agents.get(sid);
  }
  agent('old-session');
  const pool = {
    attachClaimHandler: () => () => {}, owns: () => true,
    memberForSession: sid => [...members.values()].find(m => m.sessionId === sid),
    async ensure(id) {
      ensures.push(id); await options.ensureGate?.promise;
      const member = members.get(id); const cid = groups.get(member.groupId).activeConversationId;
      if (options.forceRotation || member.sessionConversationId !== cid) {
        const sid = 'session-' + cid + '-' + ensures.length;
        members.set(id, { ...member, sessionId: sid, sessionConversationId: cid, lastSeenSeq: repo.activeConversation(member.groupId).afterSeq, preserved: 'ensure-result' });
        bindings.set(sid, { sessionId: sid, groupId: member.groupId, conversationId: cid, membershipId: id, botId: member.botId });
      }
      return agent(members.get(id).sessionId);
    },
    submit: (handle, input) => handle.followup(input),
  };
  const engine = new Engine({ ctx, repo, pool, config: resolveConfig(), personas: { refresh: options.refresh || (async () => {}) },
    logger: { warn() {} }, taskHook: (...args) => hooks.push(args), bus: { emit: (gid, frame) => frames.push({ groupId: gid, ...structuredClone(frame) }) },
  });
  const f = {
    repo, engine, ctx, pool, agents, bindings, frames, submissions, memberWrites, hooks, ensures, agent,
    post: (extra = {}) => engine.postHumanMessage({ groupId: 'group', text: 'CURRENT_REQUEST', mentions: ['member'], expectedConversationId: groups.get('group').activeConversationId, ...extra }),
    currentJob: () => engine.running.get('member'),
    async flush() { await tick(); await tick(); },
    switchConversation() {
      const group = groups.get('group'); const conversationId = 'conv-' + (group.conversationVersion + 1);
      conversations.set(conversationId, { groupId: 'group', conversationId, ordinal: ++group.conversationVersion, afterSeq: group.nextSeq, previousConversationId: group.activeConversationId });
      groups.set('group', { ...group, activeConversationId: conversationId });
    },
    event(job, type, data) {
      const session = agents.get(job.sessionId).session;
      const event = { seq: session.seq++, type, data }; session.events.push(event); engine.onSessionEvent(session, event); return event;
    },
    begin(job) {
      f.event(job, 'turn/start', { turn: 1 });
      engine.onInboxClaim({ agent: agents.get(job.sessionId), message: { id: job.execution.inputMessageId }, turn: 1 });
      f.event(job, 'user/message', { id: job.execution.inputMessageId });
    },
  };
  t.after(async () => { options.ensureGate?.resolve(); await engine.dispose(); await f.flush(); });
  return f;
}

test('new session uses the conversation floor and never writes the pre-ensure member back', async t => {
  const f = fixture(t); const old = f.repo.getMember('member'); old.lastSeenSeq = 100;
  const posted = f.post(); const job = f.currentJob(); await f.flush();
  assert.equal(posted.message.conversationId, 'conv-2'); assert.equal(job.conversationId, 'conv-2');
  assert.equal(f.submissions.length, 1);
  const prompt = f.submissions[0].input.content[0].text;
  assert.match(prompt, /CURRENT_REQUEST/); assert.doesNotMatch(prompt, /OLD_SELECTED|OLD_NEIGHBOR|OLD_REPLY/);
  assert.equal(old.sessionId, 'old-session'); assert.equal(old.lastSeenSeq, 100);
  assert.equal(f.repo.getMember('member').preserved, 'ensure-result');
  assert.equal(f.repo.getMember('member').sessionConversationId, 'conv-2');
  assert.equal(f.repo.getMember('member').lastSeenSeq, posted.message.seq);
  assert.ok(f.memberWrites.every(m => m.sessionId === f.submissions[0].sessionId));
});

test('workspace or preset rotation rebuilds only the current conversation and respects trigger upper bound', async t => {
  const gate = deferred(); const f = fixture(t, { forceRotation: true, ensureGate: gate });
  const member = f.repo.getMember('member'); member.sessionConversationId = 'conv-2';
  f.bindings.set(member.sessionId, { ...f.bindings.get(member.sessionId), conversationId: 'conv-2' });
  const prior = f.post({ mentions: [], text: 'CURRENT_EARLIER' }).message;
  member.lastSeenSeq = prior.seq;
  f.post(); f.post({ mentions: [], text: 'FUTURE_REQUEST' }); gate.resolve(); await f.flush();
  const prompt = f.submissions[0].input.content[0].text;
  assert.match(prompt, /CURRENT_EARLIER/); assert.match(prompt, /CURRENT_REQUEST/);
  assert.doesNotMatch(prompt, /OLD_|FUTURE_REQUEST/);
});

test('a generation switch while ensure waits cannot submit or update the newly mapped cursor', async t => {
  const gate = deferred(); const f = fixture(t, { ensureGate: gate });
  f.post(); const job = f.currentJob(); f.switchConversation(); gate.resolve(); await f.flush();
  assert.equal(f.submissions.length, 0); assert.equal(f.memberWrites.length, 0);
  assert.equal(job.state, 'error'); assert.equal(f.hooks.length, 0);
  assert.equal(f.repo.getMember('member').sessionConversationId, 'conv-3');
  assert.equal(f.repo.getMessage(job.placeholderId).conversationId, 'conv-2');
});

test('explicit old reply snapshots survive deletion without adding neighboring history', async t => {
  const gate = deferred(); const f = fixture(t, { ensureGate: gate });
  const target = f.repo.getMessage('old-1'); target.attachments = [{ attachmentId: 'good-file', name: 'example.txt', bytes: 8, path: '/forged-path' }];
  const result = f.post({ replyTo: 'old-1' }); f.repo.messages.delete('old-1'); gate.resolve(); await f.flush();
  assert.equal(result.message.quote.conversationId, 'conv-1');
  assert.equal(result.message.quote.attachments[0].path, '/attachments/example.txt');
  const prompt = f.submissions[0].input.content[0].text;
  assert.match(prompt, /OLD_SELECTED/); assert.match(prompt, /example.txt/);
  assert.doesNotMatch(prompt, /OLD_NEIGHBOR|OLD_REPLY|forged-path/);
  assert.throws(() => f.post({ replyTo: 'old-1' }), { code: 'invalid-input' });
});

test('explicit replies reject foreign targets, unavailable attachments and total input overflow atomically', async t => {
  const f = fixture(t); const target = f.repo.getMessage('old-1'); const before = f.repo.messages.size;
  target.groupId = 'foreign'; assert.throws(() => f.post({ replyTo: target.messageId }), { code: 'invalid-input' }); target.groupId = 'group';
  target.attachments = [{ attachmentId: 'missing', name: 'gone.txt', bytes: 1 }];
  assert.throws(() => f.post({ replyTo: target.messageId }), { code: 'invalid-input' });
  target.attachments = []; target.text = 'x'.repeat(40000);
  assert.throws(() => f.post({ replyTo: target.messageId }), { code: 'invalid-input' });
  assert.equal(f.repo.messages.size, before); assert.equal(f.ensures.length, 0);
});

test('retry, review, revision, tasks and automatic summaries reject historical targets before creating work', async t => {
  const f = fixture(t); const before = f.repo.messages.size;
  assert.throws(() => f.engine.retryMessage('old-3'), { code: 'historical-target' });
  assert.throws(() => f.engine.requestReview({ groupId: 'group', targetMessageId: 'old-3', reviewerMembershipId: 'member' }), { code: 'historical-target' });
  f.repo.messages.set('old-review', { ...f.repo.getMessage('old-3'), messageId: 'old-review', kind: 'review', meta: { reviewOf: 'old-3' } });
  assert.throws(() => f.engine.requestRevision({ groupId: 'group', reviewMessageId: 'old-review' }), { code: 'historical-target' });
  f.repo.tasks.set('old-task', { taskId: 'old-task', groupId: 'group', conversationId: 'conv-1', assigneeMembershipId: 'member' });
  assert.throws(() => f.engine.enqueueTaskTurn({ taskId: 'old-task' }), { code: 'historical-target' });
  f.repo.discussions.set('old-discussion', { discussionId: 'old-discussion', groupId: 'group', conversationId: 'conv-1', status: 'running', summarize: true, rounds: 1, currentRound: 2, memberIds: ['member'] });
  f.engine.scheduleDiscussion('old-discussion');
  assert.equal(f.repo.messages.size, before + 1); assert.equal(f.engine.queue.length, 0); assert.equal(f.ensures.length, 0);
});

test('admission guard applies before every execution entry including native adoption', async t => {
  const f = fixture(t); const error = Object.assign(new Error('switching'), { code: 'conversation-busy' });
  f.engine.assertAdmission = () => { throw error; };
  assert.throws(() => f.post(), error);
  assert.throws(() => f.engine.enqueueJob({ groupId: 'group', membershipId: 'member', kind: 'chat' }), error);
  assert.throws(() => f.engine.requestReview({ groupId: 'group', targetMessageId: 'old-3' }), error);
  assert.throws(() => f.engine.requestRevision({ groupId: 'group', reviewMessageId: 'old-3' }), error);
  assert.throws(() => f.engine.retryMessage('old-3'), error);
  await assert.rejects(f.engine.startDiscussion({ groupId: 'group', topic: 'topic', membershipIds: ['member'], rounds: 1 }), error);
  assert.equal(f.engine.adoptNativeTurn(f.agent('old-session').session, { type: 'turn/start', seq: 0, data: { turn: 1 } }), null);
  assert.equal(f.repo.messages.size, 3);
});

test('late native claim, stream, goal and durable end callbacks cannot advance the new conversation', async t => {
  const f = fixture(t, { goal: { phase: 'active', activation: 'armed' } });
  f.post(); const job = f.currentJob(); await f.flush(); f.begin(job);
  const endWrite = deferred(); let reached = false;
  f.repo.beforeMessageWrite = async message => { if (message.meta?.execution?.endSeq !== null) { reached = true; await endWrite.promise; } };
  f.event(job, 'turn/end', { turn: 1, reason: { kind: 'completed' } }); assert.equal(reached, true);
  f.switchConversation(); const count = f.repo.messages.size; const frameCount = f.frames.length;
  f.engine.onInboxClaim({ agent: f.agent(job.sessionId), message: { id: job.execution.inputMessageId }, turn: 2 });
  f.engine.onAssistantStream({ agent: f.agent(job.sessionId), frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'LATE_STREAM' } } });
  f.event(job, 'turn/start', { turn: 2 }); f.engine.checkNativeGoal(job.sessionId, job);
  assert.equal(f.frames.length, frameCount);
  endWrite.resolve(); await f.flush();
  assert.equal(f.repo.messages.size, count); assert.equal(f.hooks.length, 0);
  assert.ok(!f.frames.slice(frameCount).some(frame => frame.type === 'member.status'));
  assert.equal(job.state, 'stopped');
});

test('native recovery and direct turn adoption ignore stale member mappings', async t => {
  const f = fixture(t); const old = f.agent('old-session');
  old.session.events.push({ seq: 0, type: 'turn/start', data: { turn: 1 } });
  await f.engine.recoverNativeSessions();
  assert.equal(f.engine.adoptNativeTurn(old.session, old.session.events[0]), null);
  assert.equal(f.repo.messages.size, 3); assert.equal(f.ensures.length, 0);
});

test('all prompt builders exclude old automatic context and reject old execution targets', async t => {
  const f = fixture(t); const message = f.post({ mentions: [] }).message;
  const base = { repo: f.repo, groupId: 'group', botId: 'bot', contextMessages: f.repo.messagesOf('group') };
  assert.doesNotMatch(buildTurnPrompt(base), /OLD_/);
  assert.doesNotMatch(buildReviewPrompt({ ...base, targetMessage: message }), /OLD_/);
  assert.doesNotMatch(buildTaskPrompt({ ...base, task: { groupId: 'group', conversationId: 'conv-2', title: 'Current task' } }), /OLD_/);
  assert.throws(() => buildReviewPrompt({ ...base, targetMessage: f.repo.getMessage('old-3') }), { code: 'historical-target' });
  assert.throws(() => buildSummaryPrompt({ ...base, discussion: { groupId: 'group', conversationId: 'conv-1', topic: 'Old topic' }, transcript: [] }), { code: 'historical-target' });
});

test('persisted bindings keep removed members history readable and legacy fallback never follows a new session', async t => {
  const f = fixture(t); f.post(); await f.flush(); f.repo.members.clear();
  const events = [{ seq: 0, type: 'system/message', data: { text: 'old log' } }]; const observed = [];
  const ctx = { sessionQuery: { async observeSession(sid) { observed.push(sid); return { header: { id: sid }, cursor: 0, events, [Symbol.dispose]() {} }; } } };
  const legacy = await readMessageExecution({ ctx, repo: f.repo, groupId: 'group', messageId: 'old-3' });
  assert.equal(legacy.fallbackSessionId, 'old-session');
  f.repo.messages.clear();
  const history = await readBotSessionHistory({ ctx, repo: f.repo, groupId: 'group', sessionId: 'old-session' });
  assert.equal(history.availability, 'available'); assert.deepEqual(observed, ['old-session']);
  f.repo.groups.set('foreign', { groupId: 'foreign', activeConversationId: 'foreign-conv' });
  await assert.rejects(readBotSessionHistory({ ctx, repo: f.repo, groupId: 'foreign', sessionId: 'old-session' }), { code: 'invalid-input' });
});

test('a generation switch during persona refresh cannot submit an already prepared input', async t => {
  const refreshGate = deferred(); const entered = deferred();
  const f = fixture(t, { refresh: async () => { entered.resolve(); await refreshGate.promise; } });
  f.post(); const job = f.currentJob(); await entered.promise;
  f.switchConversation(); refreshGate.resolve(); await f.flush();
  assert.equal(f.submissions.length, 0); assert.equal(job.state, 'error'); assert.equal(f.hooks.length, 0);
});

test('native recovery rechecks the generation after an asynchronous history read', async t => {
  const readGate = deferred(); const entered = deferred();
  const f = fixture(t, { query: { readSession: async () => { entered.resolve(); return readGate.promise; } } });
  const member = f.repo.getMember('member'); member.sessionConversationId = 'conv-2';
  f.bindings.set(member.sessionId, { ...f.bindings.get(member.sessionId), conversationId: 'conv-2' });
  delete f.agent(member.sessionId).session.snapshotEvents;
  const recovering = f.engine.recoverNativeSessions(); await entered.promise;
  f.switchConversation(); readGate.resolve({ events: [{ type: 'turn/start', seq: 0, data: { turn: 1 } }] }); await recovering;
  assert.equal(f.repo.messages.size, 3); assert.equal(f.engine.running.size, 0);
});

test('discussion creation retains its generation across persistence and delayed summaries cannot restart it', async t => {
  const writeGate = deferred(); const f = fixture(t); f.repo.beforeDiscussionWrite = () => writeGate.promise;
  const started = f.engine.startDiscussion({ groupId: 'group', topic: 'Current topic', membershipIds: ['member'], rounds: 1, summarize: true });
  assert.equal(f.engine.pendingWork.size, 1);
  const discussion = [...f.repo.discussions.values()][0];
  assert.equal(discussion.conversationId, 'conv-2');
  f.switchConversation(); writeGate.resolve(); await assert.rejects(started, { code: 'stale-conversation' });
  f.engine.scheduleDiscussion(discussion.discussionId);
  assert.equal(f.engine.pendingWork.size, 0); assert.equal(f.submissions.length, 0);
  assert.equal(f.frames.length, 0);
});

test('direct Engine sends cannot turn /new into model input while quoted commands remain inert data', async t => {
  const f = fixture(t);
  assert.throws(() => f.post({ text: '/new' }), { code: 'command-required' });
  assert.throws(() => f.post({ text: ' /new extra ' }), { code: 'invalid-command' });
  assert.equal(f.repo.messages.size, 3); assert.equal(f.submissions.length, 0);
  f.repo.getMessage('old-1').text = '/new'; f.post({ replyTo: 'old-1' }); await f.flush();
  assert.equal(f.submissions.length, 1); assert.match(f.submissions[0].input.content[0].text, /\/new/);
  assert.equal(f.repo.getGroup('group').activeConversationId, 'conv-2');
});

test('task dispatch rejects a current task that depends on an old conversation', async t => {
  const f = fixture(t);
  f.repo.tasks.set('old-task', { taskId: 'old-task', groupId: 'group', conversationId: 'conv-1', status: 'accepted' });
  f.repo.tasks.set('new-task', { taskId: 'new-task', groupId: 'group', conversationId: 'conv-2', assigneeMembershipId: 'member', dependsOn: ['old-task'] });
  assert.throws(() => f.engine.enqueueTaskTurn({ taskId: 'new-task' }), { code: 'historical-target' });
  assert.equal(f.ensures.length, 0); assert.equal(f.repo.messages.size, 3);
});

test('strict repositories reject missing conversation metadata and stale expected generations', async t => {
  const f = fixture(t);
  assert.throws(() => f.post({ expectedConversationId: 'conv-1', mentions: [] }), { code: 'stale-conversation' });
  f.repo.activeConversation = undefined;
  assert.throws(() => f.post({ mentions: [] }), { code: 'conversation-corrupt' });
  assert.equal(f.repo.messages.size, 3);
});

test('an old execution cannot read a later conversation session even if its stored reference is changed', async t => {
  const f = fixture(t); f.post(); await f.flush();
  const latest = f.currentJob(); const old = f.repo.getMessage('old-3');
  old.meta = { execution: { ...latest.execution } };
  let observed = false;
  const ctx = { sessionQuery: { observeSession() { observed = true; } } };
  await assert.rejects(readMessageExecution({ ctx, repo: f.repo, groupId: 'group', messageId: old.messageId }), { code: 'invalid-input' });
  assert.equal(observed, false);
});

test('ambiguous or absent old bindings disable legacy fallback even when the member has a new session', async t => {
  const f = fixture(t); f.post(); await f.flush();
  f.bindings.set('second-old', { ...f.bindings.get('old-session'), sessionId: 'second-old' });
  const read = () => readMessageExecution({ repo: f.repo, groupId: 'group', messageId: 'old-3' });
  assert.equal((await read()).fallbackSessionId, undefined);
  f.bindings.delete('old-session'); f.bindings.delete('second-old');
  assert.equal((await read()).fallbackSessionId, undefined);
});
