import test from 'node:test';
import assert from 'node:assert/strict';
import { openRepository } from '../host/domain.js';
import { BotTeamService } from '../host/service.js';
import { Engine } from '../host/engine.js';
import { GroupBus } from '../host/util.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

// Isolated records only: snapshots and the shared write chain model the Host
// domain's durability boundary. No real storage, Agent, or session is opened.
function memoryDomain() {
  const tables = new Map();
  let tail = Promise.resolve();
  const domain = {
    writes: [], beforePut: null, beforeDelete: null,
    records(name) {
      if (!tables.has(name)) tables.set(name, new Map());
      return tables.get(name);
    },
    enqueue(operation) {
      const saved = tail.then(operation);
      tail = saved.catch(() => {});
      return saved;
    },
    table(name) {
      const records = domain.records(name);
      return {
        entries: () => [...records].map(([key, value]) => [key, structuredClone(value)]),
        put(key, value) {
          const snapshot = structuredClone(value);
          domain.writes.push({ operation: 'put', table: name, key });
          return domain.enqueue(async () => {
            await domain.beforePut?.(name, key, snapshot);
            records.set(key, snapshot);
          });
        },
        delete(key) {
          domain.writes.push({ operation: 'delete', table: name, key });
          return domain.enqueue(async () => {
            await domain.beforeDelete?.(name, key);
            records.delete(key);
          });
        },
      };
    },
    async flush() {
      for (let count = 0; count < 30; count += 1) {
        const pending = tail;
        await pending;
        await tick();
        if (pending === tail) return;
      }
      assert.fail('Fixture writes did not settle');
    },
    async close() { await domain.flush(); },
  };
  return domain;
}

async function fixture(t) {
  const domain = memoryDomain();
  const warnings = [];
  const logger = { warn: text => warnings.push(text) };
  const agents = new Map();
  const goals = new Map();
  const ctx = {
    storageDomain: { open: async () => domain },
    agents: { get: id => agents.get(id) },
    get: name => name === 'goals' ? { get: agent => goals.get(agent.id) } : undefined,
    on: () => () => {},
  };
  const repo = await openRepository(ctx, logger);
  for (const groupId of ['group', 'direct']) {
    await repo.putGroup({ groupId, kind: groupId, title: groupId, nextSeq: 0, createdAt: 1 });
    await repo.putBot({ botId: 'bot-' + groupId, name: groupId, provider: 'mock', model: 'mock', capability: 'work' });
    await repo.putMember({ membershipId: 'member-' + groupId, groupId, botId: 'bot-' + groupId, sessionId: 'session-' + groupId, order: 0, lastSeenSeq: 0 });
    const session = { id: 'session-' + groupId, seq: 0, events: [] };
    agents.set(session.id, { id: session.id, session, cancelled: 0, cancel() { this.cancelled += 1; }, async followup() {} });
  }
  const pool = {
    memberForSession: id => [...repo.members.values()].find(member => member.sessionId === id),
    ensure: async id => agents.get(repo.getMember(id).sessionId),
    submit: async () => {},
    disposeMember() { assert.fail('Message deletion must not dispose the Bot Session'); },
  };
  const bus = new GroupBus();
  const config = { maxParallelTurns: 3, maxContextMessages: 40, maxMessageChars: 40000, turnTimeoutMs: 0 };
  const engine = new Engine({ ctx, repo, pool, bus, config, logger, personas: { refresh: async () => {} } });
  const frames = [];
  const foreignFrames = [];
  bus.subscribe('group', frame => frames.push(structuredClone(frame)));
  bus.subscribe('direct', frame => foreignFrames.push(structuredClone(frame)));
  const service = Object.assign(Object.create(BotTeamService.prototype), {
    ready: Promise.resolve(), ctx, repo, engine, pool, bus, config, logger, smokeState: null,
    healthPayload: () => ({}), getModelCatalog: async () => ({ groups: [] }),
  });
  const f = {
    domain, repo, service, ctx, engine, pool, agents, goals, frames, foreignFrames, warnings,
    async message(overrides = {}) {
      const message = engine.createMessage({ groupId: 'group', author: { type: 'human' }, text: 'Ordinary chat', ...overrides });
      await domain.flush();
      return message;
    },
    event(type, data, groupId = 'group') {
      const session = agents.get('session-' + groupId).session;
      const event = { seq: session.seq++, time: 1000 + session.seq, type, data };
      session.events.push(structuredClone(event));
      engine.onSessionEvent(session, event);
      return event;
    },
    async reopen() {
      await domain.flush();
      const reopened = await openRepository(ctx, logger);
      t.after(() => reopened.close());
      return reopened;
    },
  };
  t.after(async () => { await engine.dispose(); await repo.close(); });
  return f;
}

const author = (type, groupId = 'group') => type === 'human'
  ? { type, name: 'User' }
  : { type, botId: 'bot-' + groupId, membershipId: 'member-' + groupId, name: 'Bot' };
const deleteMessage = (f, message) => f.service.dispatch('message.delete', { groupId: message.groupId, messageId: message.messageId });
const deleteHttp = (f, payload) => f.service.handleActionHttp(new Request('http://localhost/api/bot-team.action', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'message.delete', payload }),
}));

for (const groupId of ['direct', 'group']) {
  for (const type of ['human', 'bot']) {
    for (const status of ['done', 'error', 'stopped']) {
      test(groupId + ' deletes one ' + type + ' ' + status + ' chat durably, emits updates and keeps sessions', async t => {
        const f = await fixture(t);
        const previous = await f.message({ groupId, text: 'Previous preview' });
        const other = await f.message({ groupId: groupId === 'group' ? 'direct' : 'group', text: 'Other chat' });
        const message = await f.message({ groupId, author: author(type, groupId), status, meta: { execution: { version: 1, sessionId: 'session-' + groupId } } });
        const before = structuredClone(f.repo.getGroup(groupId));
        const session = f.agents.get('session-' + groupId);
        session.session.events.push({ type: 'tool/result', data: { text: 'Keep original execution log' } });
        const originalLog = structuredClone(session.session.events);
        const member = structuredClone(f.repo.getMember('member-' + groupId));
        const writes = f.domain.writes.length;
        const frames = groupId === 'group' ? f.frames : f.foreignFrames;
        const unrelatedFrames = groupId === 'group' ? f.foreignFrames : f.frames;
        const response = await deleteHttp(f, { groupId, messageId: message.messageId });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { ok: true, result: { groupId, messageId: message.messageId, deleted: true } });
        assert.equal(f.repo.getMessage(message.messageId), undefined);
        assert.equal(f.domain.records('messages').has(message.messageId), false);
        assert.deepEqual(f.repo.messagesOf(groupId), [previous]);
        assert.deepEqual(f.repo.getMessage(other.messageId), other);
        assert.deepEqual(frames, [
          { type: 'message.deleted', groupId, messageId: message.messageId },
          { type: 'group.updated', group: before },
        ]);
        assert.deepEqual(unrelatedFrames, []);
        assert.deepEqual(f.domain.writes.slice(writes), [{ operation: 'delete', table: 'messages', key: message.messageId }]);
        assert.deepEqual(f.repo.getGroup(groupId), before, 'deletion does not allocate a seq or reorder the chat');
        assert.deepEqual(f.repo.getMember(member.membershipId), member);
        assert.equal(f.agents.get(session.id), session);
        assert.equal(session.cancelled, 0);
        assert.deepEqual(session.session.events, originalLog);
        const boot = await f.service.bootstrapPayload();
        assert.equal(boot.groups.find(group => group.groupId === groupId).lastMessage.text, 'Previous preview');
        const reopened = await f.reopen();
        assert.equal(reopened.getMessage(message.messageId), undefined);
        assert.deepEqual(reopened.messagesOf(groupId), [previous]);
        assert.ok(reopened.allocateSeq(groupId) > message.seq, 'removed sequence numbers are not reused');
      });
    }
  }
}

test('legacy chat defaults remain deletable and the final preview becomes empty', async t => {
  const f = await fixture(t);
  const message = await f.message();
  delete message.kind;
  delete message.status;
  await f.repo.putMessageStrict(message);
  await deleteMessage(f, message);
  assert.equal((await f.service.bootstrapPayload()).groups.find(group => group.groupId === 'group').lastMessage, null);
  const response = await f.service.handleMessages(new Request('http://localhost/api/bot-team.messages?groupId=group'));
  assert.deepEqual((await response.json()).messages, []);
});

test('missing and cross-chat ids fail closed without deleting any records or broadcasting', async t => {
  const f = await fixture(t);
  const message = await f.message();
  const writes = f.domain.writes.length;
  for (const payload of [
    { groupId: 'direct', messageId: message.messageId },
    { groupId: 'missing', messageId: message.messageId },
    { groupId: 'group', messageId: 'missing' },
    { groupId: 'group' },
    { messageId: message.messageId },
    null,
  ]) {
    const response = await deleteHttp(f, payload);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'not-found');
  }
  assert.equal(f.repo.getMessage(message.messageId), message);
  assert.deepEqual(f.domain.records('messages').get(message.messageId), message);
  assert.deepEqual(f.domain.writes.slice(writes), []);
  assert.deepEqual(f.frames, []);
  assert.deepEqual(f.foreignFrames, []);
});

test('system authors, special cards and unknown states cannot be deleted', async t => {
  const f = await fixture(t);
  for (const fields of [
    ...['system', 'approval'].map(kind => ({ kind, author: author('bot') })),
    { author: { type: 'system' } }, { author: undefined }, { status: 'unknown-state' },
  ]) {
    const message = await f.message(fields);
    await assert.rejects(deleteMessage(f, message), { code: 'invalid-input' });
    assert.equal(f.repo.getMessage(message.messageId), message);
  }
  assert.equal(f.domain.writes.some(write => write.operation === 'delete'), false);
  assert.deepEqual(f.frames, []);
});

test('completed and failed review, revision, discussion and task Bot bubbles remain ordinary deletable messages', async t => {
  const f = await fixture(t);
  for (const groupId of ['direct', 'group']) {
    for (const kind of ['review', 'revision', 'discussion', 'task']) {
      for (const status of ['done', 'error']) {
        const message = await f.message({ groupId, kind, status, author: author('bot', groupId) });
        await deleteMessage(f, message);
        assert.equal(f.repo.getMessage(message.messageId), undefined);
        assert.equal(f.domain.records('messages').has(message.messageId), false);
      }
    }
  }
});

test('pending and streaming messages are refused for both chat kinds and authors', async t => {
  const f = await fixture(t);
  for (const groupId of ['direct', 'group']) {
    for (const type of ['human', 'bot']) {
      for (const status of ['pending', 'streaming']) {
        for (const kind of ['chat', 'review', 'revision', 'discussion', 'task']) {
          const message = await f.message({ groupId, author: author(type, groupId), kind, status });
          await assert.rejects(deleteMessage(f, message), { code: 'busy' });
          assert.equal(f.repo.getMessage(message.messageId), message);
        }
      }
    }
  }
  assert.equal(f.domain.writes.some(write => write.operation === 'delete'), false);
  assert.deepEqual(f.frames, []);
  assert.deepEqual(f.foreignFrames, []);
});

test('a completed native goal reply stays protected until continuation releases it; unrelated history remains deletable', async t => {
  const f = await fixture(t);
  const older = await f.message({ author: author('bot') });
  f.goals.set('session-group', { phase: 'active', activation: 'armed' });
  f.event('turn/start', { turn: 1 });
  f.event('user/message', { id: 'native-input', role: 'user', content: [] });
  f.event('assistant/message', { turn: 1, step: 1, message: { id: 'native-reply', role: 'assistant', content: [{ type: 'text', text: 'Round finished' }] } });
  f.event('turn/end', { turn: 1, reason: { kind: 'completed' } });
  await f.domain.flush();
  const job = f.engine.activeBySession.get('session-group');
  const message = f.repo.getMessage(job.placeholderId);
  assert.equal(message.status, 'done');
  assert.equal(job.awaitingContinuation, true);
  await assert.rejects(deleteMessage(f, message), { code: 'busy' });
  await deleteMessage(f, older);
  assert.equal(f.engine.activeBySession.get('session-group'), job);
  assert.equal(f.repo.getMessage(message.messageId), message);
  f.goals.set('session-group', { phase: 'complete' });
  f.engine.checkNativeGoal('session-group');
  await f.domain.flush();
  await deleteMessage(f, message);
  const frames = f.frames.length;
  f.event('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'Late event' }] } });
  f.event('turn/end', { turn: 1, reason: { kind: 'completed' } });
  await f.domain.flush();
  assert.equal(f.repo.getMessage(message.messageId), undefined);
  assert.equal(f.frames.length, frames, 'late events cannot emit an update for the removed reply');
  assert.equal(f.agents.get('session-group').cancelled, 0);
});

test('stopped preparation remains protected while its asynchronous run is still settling', async t => {
  const f = await fixture(t);
  const ensure = deferred();
  t.after(() => ensure.resolve(f.agents.get('session-group')));
  f.pool.ensure = () => ensure.promise;
  const job = f.engine.enqueueJob({ groupId: 'group', membershipId: 'member-group', triggerSeq: 0, triggerMessageId: null, kind: 'chat' });
  const message = f.repo.getMessage(job.placeholderId);
  f.engine.stopMember('member-group');
  assert.equal(message.status, 'stopped');
  assert.equal(f.engine.running.size, 0);
  assert.equal(f.engine.pendingWork.has(job), true);
  await assert.rejects(deleteMessage(f, message), { code: 'busy' });
  ensure.resolve(f.agents.get('session-group'));
  await f.domain.flush();
  assert.equal(f.engine.pendingWork.has(job), false);
  await deleteMessage(f, message);
  assert.equal((await f.reopen()).getMessage(message.messageId), undefined);
});

for (const groupId of ['direct', 'group']) {
  test(groupId + ' keeps a queued human trigger until the Bot has finished using its input', async t => {
    const f = await fixture(t);
    f.engine.config.maxParallelTurns = 0;
    const posted = await f.service.dispatch('message.post', {
      groupId, text: 'Do not lose this queued instruction', mentions: ['member-' + groupId],
    });
    assert.equal(f.engine.queue[0].triggerMessageId, posted.message.messageId);
    await assert.rejects(deleteMessage(f, posted.message), { code: 'busy' });
    const submitted = [];
    f.pool.submit = async (_agent, input) => { submitted.push(input); };
    f.engine.config.maxParallelTurns = 3;
    f.engine.pump(groupId);
    await f.domain.flush();
    assert.equal(submitted.length, 1);
    assert.match(submitted[0].content[0].text, /Do not lose this queued instruction/);
    await assert.rejects(deleteMessage(f, posted.message), { code: 'busy' });
    f.engine.stopGroup(groupId);
    await f.domain.flush();
    await deleteMessage(f, posted.message);
    assert.equal((await f.reopen()).getMessage(posted.message.messageId), undefined);
  });
}

for (const kind of ['review', 'revision']) {
  test(kind + ' preparation protects its referenced source and review until prompt construction finishes', async t => {
    const f = await fixture(t);
    const unrelated = await f.message({ text: 'Unrelated history' });
    const target = await f.message({ author: author('bot'), text: 'Required original deliverable' });
    const review = await f.message({ kind: 'review', author: author('bot'), text: 'Required review feedback', meta: { reviewOf: target.messageId } });
    const ensure = deferred();
    t.after(() => ensure.resolve(f.agents.get('session-group')));
    f.pool.ensure = () => ensure.promise;
    const submitted = [];
    f.pool.submit = async (_agent, input) => { submitted.push(input); };
    f.engine.enqueueJob({ groupId: 'group', membershipId: 'member-group', kind,
      triggerSeq: review.seq, triggerMessageId: review.messageId,
      ...(kind === 'review' ? { reviewTargetId: target.messageId } : { reviewMessageId: review.messageId }),
    });
    await assert.rejects(deleteMessage(f, target), { code: 'busy' });
    await assert.rejects(deleteMessage(f, review), { code: 'busy' });
    await deleteMessage(f, unrelated);
    ensure.resolve(f.agents.get('session-group'));
    await f.domain.flush();
    assert.equal(submitted.length, 1);
    assert.match(submitted[0].content[0].text, /Required original deliverable/);
    if (kind === 'revision') assert.match(submitted[0].content[0].text, /Required review feedback/);
    f.engine.stopGroup('group');
    await f.domain.flush();
    await deleteMessage(f, target);
    await deleteMessage(f, review);
  });
}

test('deletion waits for storage, rejects duplicate operations and fences late writes', async t => {
  const f = await fixture(t);
  const message = await f.message();
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  f.domain.beforeDelete = async () => { entered.resolve(); await release.promise; };
  const pending = deleteMessage(f, message);
  await entered.promise;
  assert.equal(f.repo.getMessage(message.messageId), message);
  assert.equal(f.repo.lastMessageOf('group'), message);
  assert.deepEqual(f.domain.records('messages').get(message.messageId), message);
  assert.deepEqual(f.frames, []);
  await assert.rejects(deleteMessage(f, message), { code: 'busy' });
  await assert.rejects(f.repo.putMessageStrict({ ...message, text: 'Late strict update' }), { code: 'busy' });
  await f.repo.putMessage({ ...message, text: 'Late best-effort update' });
  await f.repo.appendMessage({ ...message, text: 'Late append' });
  assert.equal(f.repo.getMessage(message.messageId).text, message.text);
  release.resolve();
  await pending;
  await assert.rejects(f.repo.putMessageStrict(message), { code: 'not-found' });
  await f.repo.putMessage(message);
  await f.repo.appendMessage(message);
  await f.domain.flush();
  assert.equal(f.repo.getMessage(message.messageId), undefined);
  assert.deepEqual(f.repo.messagesOf('group'), []);
  assert.equal(f.domain.records('messages').has(message.messageId), false);
  assert.equal(f.domain.writes.filter(write => write.operation === 'delete').length, 1);
  assert.equal(f.frames.filter(frame => frame.type === 'message.deleted').length, 1);
  await assert.rejects(deleteMessage(f, message), { code: 'not-found' });
  assert.equal((await f.reopen()).getMessage(message.messageId), undefined);
});

for (const groupId of ['direct', 'group']) {
  test(groupId + ' persistence failure preserves the message, reaches the caller and allows retry', async t => {
    const f = await fixture(t);
    const message = await f.message({ groupId });
    const original = structuredClone(message);
    const failure = new Error('disk delete failed');
    f.domain.beforeDelete = async () => { throw failure; };
    await assert.rejects(deleteMessage(f, message), error => error === failure);
    const response = await deleteHttp(f, { groupId, messageId: message.messageId });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { ok: false, error: { code: 'internal', message: failure.message } });
    assert.deepEqual(f.repo.getMessage(message.messageId), original);
    assert.deepEqual(f.repo.messagesOf(groupId), [original]);
    assert.deepEqual(f.domain.records('messages').get(message.messageId), original);
    assert.deepEqual((await f.reopen()).getMessage(message.messageId), original);
    assert.deepEqual(f.frames, []);
    assert.deepEqual(f.foreignFrames, []);
    await f.repo.putMessageStrict({ ...message, text: 'Still writable after failed deletion' });
    f.domain.beforeDelete = null;
    await deleteMessage(f, message);
    assert.equal(f.repo.getMessage(message.messageId), undefined);
  });
}

test('a final write already submitted to storage settles before the durable deletion', async t => {
  const f = await fixture(t);
  const message = await f.message({ author: author('bot') });
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  f.domain.beforePut = async (table, key) => {
    if (table === 'messages' && key === message.messageId) { entered.resolve(); await release.promise; }
  };
  const saving = f.repo.putMessageStrict({ ...message, text: 'Final persisted answer' });
  await entered.promise;
  const deleting = deleteMessage(f, message);
  await tick();
  assert.ok(f.repo.getMessage(message.messageId));
  assert.deepEqual(f.frames, []);
  release.resolve();
  await saving;
  await deleting;
  assert.equal(f.domain.records('messages').has(message.messageId), false);
  assert.equal((await f.reopen()).getMessage(message.messageId), undefined);
});

test('reply, task and review references survive without cascades and missing targets fail safely', async t => {
  const f = await fixture(t);
  const target = await f.message({ author: author('bot'), text: 'Original deliverable' });
  const reply = await f.message({ replyTo: target.messageId, text: 'Keep reply' });
  const review = await f.message({ kind: 'review', author: author('bot'), replyTo: target.messageId, meta: { reviewOf: target.messageId, verdict: 'changes' }, text: 'Keep review' });
  const task = await f.repo.putTask({ taskId: 'task', groupId: 'group', title: 'Keep task', status: 'delivered', assigneeMembershipId: 'member-group', reviewerMembershipId: 'member-group', deliverableMessageId: target.messageId, reviewReplyMessageId: review.messageId, createdAt: 1 });
  const discussion = await f.repo.putDiscussion({ discussionId: 'discussion', groupId: 'group', topic: 'Keep discussion', status: 'done', startMessageId: target.messageId, createdAt: 1 });
  const saved = structuredClone({ reply, review, task, discussion });
  await deleteMessage(f, target);
  assert.deepEqual(f.repo.getMessage(reply.messageId), saved.reply);
  assert.deepEqual(f.repo.getMessage(review.messageId), saved.review);
  assert.deepEqual(f.repo.getTask(task.taskId), saved.task);
  assert.deepEqual(f.repo.getDiscussion(discussion.discussionId), saved.discussion);
  assert.equal((await f.service.bootstrapPayload()).groups.find(group => group.groupId === 'group').tasks[0].deliverableMessageId, target.messageId);
  await assert.rejects(f.service.dispatch('message.post', { groupId: 'group', text: 'Reply to deleted message', replyTo: target.messageId }), { code: 'invalid-input' });
  await assert.rejects(f.service.dispatch('message.retry', { messageId: target.messageId }), { code: 'not-found' });
  await assert.rejects(f.service.dispatch('review.request', { groupId: 'group', targetMessageId: target.messageId, reviewerMembershipId: 'member-group' }), { code: 'not-found' });
  await assert.rejects(f.service.dispatch('review.revise', { groupId: 'group', reviewMessageId: review.messageId }), { code: 'not-found' });
  await assert.rejects(f.service.dispatch('task.review', { taskId: task.taskId }), { code: 'not-found' });
  const bot = f.repo.getBot('bot-group');
  for (const job of [
    { kind: 'review', reviewTargetId: target.messageId },
    { kind: 'revision', reviewMessageId: review.messageId },
    { kind: 'task_revision', meta: { taskId: task.taskId } },
  ]) assert.throws(() => f.engine.buildPrompt({ groupId: 'group', membershipId: 'member-group', conversationId: f.repo.activeConversation('group').conversationId, ...job }, bot, f.repo.messagesOf('group')), { code: 'not-found' });
  assert.equal(f.domain.writes.filter(write => write.operation === 'delete').length, 1);
  await deleteMessage(f, review);
  assert.deepEqual(f.repo.getTask(task.taskId), saved.task, 'a deleted review reply does not cascade into its task');
  await assert.rejects(f.service.dispatch('review.revise', { groupId: 'group', reviewMessageId: review.messageId }), { code: 'not-found' });
  assert.throws(() => f.engine.buildPrompt({ groupId: 'group', membershipId: 'member-group', conversationId: f.repo.activeConversation('group').conversationId, kind: 'task_revision', meta: { taskId: task.taskId } }, bot, f.repo.messagesOf('group')), { code: 'not-found' });
});

test('message.deleted and group.updated travel through the existing SSE stream after HTTP success', async t => {
  const f = await fixture(t);
  const message = await f.message();
  const response = f.service.createEventStream(new Request('http://localhost/api/bot-team.events?groupId=group'), 'group');
  const reader = response.body.getReader();
  t.after(() => reader.cancel());
  const readFrame = async () => {
    const chunk = new TextDecoder().decode((await reader.read()).value);
    const data = chunk.split('\n').find(line => line.startsWith('data: '));
    return JSON.parse(data.slice(6));
  };
  assert.equal((await readFrame()).type, 'hello');
  assert.equal((await readFrame()).type, 'member.status');
  assert.equal((await deleteHttp(f, { groupId: 'group', messageId: message.messageId })).status, 200);
  assert.deepEqual(await readFrame(), { type: 'message.deleted', groupId: 'group', messageId: message.messageId });
  assert.equal((await readFrame()).type, 'group.updated');
  assert.equal(f.repo.getMessage(message.messageId), undefined);
});
