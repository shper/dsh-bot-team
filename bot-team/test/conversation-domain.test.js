import test from 'node:test';
import assert from 'node:assert/strict';
import { openRepository, SCHEMA_VERSION, DOMAIN_VERSION } from '../host/domain.js';
import { currentConversationId, conversationFloor, conversationIdOf, isCurrentMemberSession } from '../host/conversations.js';

const clone = value => structuredClone(value);
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Model the actual per-domain durable write chain, including a new repository
// reading only committed records after an injected crash or failed operation.
function memoryDomain(seed = {}) {
  const tables = new Map();
  let tail = Promise.resolve();
  const keys = { bots: 'botId', groups: 'groupId', members: 'membershipId', messages: 'messageId', tasks: 'taskId', discussions: 'discussionId', conversations: 'conversationId', session_bindings: 'bindingId', meta: 'key' };
  const records = name => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  };
  for (const [name, list] of Object.entries(seed)) for (const value of list) records(name).set(value[keys[name]], clone(value));
  const domain = {
    records, writes: [], beforePut: null,
    table(name) {
      return {
        entries: () => [...records(name)].map(([key, value]) => [key, clone(value)]),
        put(key, value) {
          assert.match(key, /^[a-zA-Z0-9_-]+$/);
          const snapshot = clone(value);
          const pending = tail.then(async () => {
            await domain.beforePut?.(name, key, snapshot);
            records(name).set(key, snapshot);
            domain.writes.push({ table: name, key, value: snapshot });
          });
          tail = pending.catch(() => {});
          return pending;
        },
        delete(key) {
          const pending = tail.then(() => records(name).delete(key));
          tail = pending.catch(() => {});
          return pending;
        },
      };
    },
    async close() { await tail; },
  };
  return domain;
}

const legacySeed = () => ({
  meta: [{ key: 'schema', version: 6 }],
  groups: [{ groupId: 'g', title: 'Chat', nextSeq: 12, createdAt: 10, updatedAt: 20 }],
  bots: [{ botId: 'b', name: 'Bot', provider: 'test', model: 'test', capability: 'work' }],
  members: [{ membershipId: 'm', groupId: 'g', botId: 'b', sessionId: 'native:旧/session', previousSessionIds: ['native:older/session'], lastSeenSeq: 7, enabled: false }],
  messages: [{ messageId: 'old', groupId: 'g', seq: 4, status: 'done', author: { type: 'bot', membershipId: 'removed-member', botId: 'removed-bot', name: 'Removed Bot' }, meta: { execution: { version: 1, jobId: 'job-old', sessionId: 'native:removed/session' } }, text: 'old-context' }],
  tasks: [{ taskId: 't', groupId: 'g', title: 'Historical draft', status: 'draft', createdAt: 4 }],
  discussions: [{ discussionId: 'd', groupId: 'g', topic: 'Historical discussion', status: 'stopped', createdAt: 4 }],
});
const open = domain => openRepository({ storageDomain: { open: async () => domain } }, { warn() {} });
async function fixture() {
  const domain = memoryDomain();
  const repo = await open(domain);
  await repo.runMigrations();
  await repo.putGroup({ groupId: 'g', title: 'Chat', nextSeq: 0, createdAt: 1 });
  await repo.putBot({ botId: 'b', name: 'Bot', provider: 'test', model: 'test', capability: 'work' });
  await repo.putMember({ membershipId: 'm', groupId: 'g', botId: 'b', sessionId: 's1', lastSeenSeq: 0, enabled: true });
  return { domain, repo, baseline: repo.activeConversation('g') };
}
const start = (repo, requestId = 'request-1', expectedConversationId = repo.activeConversation('g').conversationId) => repo.commitConversation('g', { requestId, expectedConversationId });

test('v7 migration preserves native sessions and cursors without rewriting history', async () => {
  const domain = memoryDomain(legacySeed());
  const repo = await open(domain);
  assert.equal(DOMAIN_VERSION, 1);
  assert.equal(SCHEMA_VERSION, 7);
  assert.deepEqual(await repo.runMigrations(), { version: 7, applied: [6] });
  const baseline = repo.activeConversation('g');
  assert.equal(baseline.ordinal, 1);
  assert.equal(baseline.afterSeq, 0);
  assert.equal(baseline.reason, 'legacy');
  assert.equal(baseline.previousConversationId, null);
  assert.equal(repo.getMember('m').sessionId, 'native:旧/session');
  assert.equal(repo.getMember('m').lastSeenSeq, 7);
  assert.equal(repo.getMember('m').enabled, false);
  assert.equal(repo.getMember('m').sessionConversationId, baseline.conversationId);
  assert.equal(repo.sessionBindingsOf('g').length, 3);
  assert.equal(repo.sessionBindingFor('native:removed/session').botNameSnapshot, 'Removed Bot');
  assert.equal(repo.conversationFor(repo.getMessage('old')), baseline);
  assert.equal(repo.conversationFor(repo.getTask('t')), baseline);
  assert.equal(repo.conversationFor(repo.getDiscussion('d')), baseline);
  assert.equal(domain.writes.some(write => ['messages', 'tasks', 'discussions'].includes(write.table)), false);
  assert.deepEqual(await repo.runMigrations(), { version: 7, applied: [] });
  const restarted = await open(domain);
  assert.equal(restarted.activeConversation('g').conversationId, baseline.conversationId);
  assert.equal(restarted.sessionBindingsOf('g').length, 3);
});

test('interrupted baseline migration is restartable and only marks schema after all writes', async () => {
  const domain = memoryDomain(legacySeed());
  let fail = true;
  domain.beforePut = name => { if (fail && name === 'groups') throw new Error('disk-full'); };
  const first = await open(domain);
  await assert.rejects(first.runMigrations(), /disk-full/);
  assert.equal(first.schemaVersion(), 6);
  assert.equal(first.activeConversation('g'), undefined);
  assert.equal(first.conversationsOf('g').length, 0);
  assert.equal(first.sessionBindingsOf('g').length, 0);
  const preparedId = [...domain.records('conversations').keys()][0];
  fail = false;
  const restarted = await open(domain);
  await restarted.runMigrations();
  assert.equal(restarted.activeConversation('g').conversationId, preparedId);
  assert.equal(domain.records('conversations').size, 1);
  assert.equal(restarted.getMember('m').sessionId, 'native:旧/session');
});

test('migration reports cross-group native-session ownership conflicts', async () => {
  const seed = legacySeed();
  seed.groups.push({ groupId: 'g2', title: 'Other', nextSeq: 0 });
  seed.members.push({ membershipId: 'm2', groupId: 'g2', botId: 'b', sessionId: 'native:旧/session', lastSeenSeq: 0 });
  const repo = await open(memoryDomain(seed));
  await assert.rejects(repo.runMigrations(), { code: 'session-binding-conflict' });
  assert.equal(repo.schemaVersion(), 6);
});

test('new group baseline publishes only after the pointer is durable', async () => {
  const domain = memoryDomain();
  const repo = await open(domain);
  await repo.runMigrations();
  domain.beforePut = name => { if (name === 'groups') throw new Error('pointer-write'); };
  await assert.rejects(repo.putGroup({ groupId: 'g', title: 'Chat' }), /pointer-write/);
  assert.equal(repo.getGroup('g'), undefined);
  assert.equal(repo.activeConversation('g'), undefined);
  domain.beforePut = null;
  const saved = await repo.putGroup({ groupId: 'g', title: 'Chat' });
  assert.equal(saved.activeConversationId, repo.activeConversation('g').conversationId);
  assert.equal((await repo.ensureConversation('g')).conversationId, saved.activeConversationId);
  assert.equal(domain.records('conversations').size, 1);
});

test('conversation prepare failure leaves the committed pointer unchanged', async () => {
  const { domain, repo, baseline } = await fixture();
  domain.beforePut = name => { if (name === 'conversations') throw new Error('prepare-failed'); };
  await assert.rejects(start(repo), /prepare-failed/);
  assert.equal(repo.activeConversation('g'), baseline);
  assert.equal(repo.conversationsOf('g').length, 1);
  assert.equal(domain.records('groups').get('g').activeConversationId, baseline.conversationId);
});

test('pointer failure leaves orphan preparation invisible on restart and retry', async () => {
  const { domain, repo, baseline } = await fixture();
  domain.beforePut = (name, key, value) => { if (name === 'groups' && value.conversationVersion > 1) throw new Error('pointer-failed'); };
  await assert.rejects(start(repo), /pointer-failed/);
  assert.equal(domain.records('conversations').size, 2);
  assert.equal(repo.activeConversation('g'), baseline);
  assert.deepEqual(repo.conversationsOf('g'), [baseline]);
  const orphan = [...repo.conversations.values()].find(c => c.ordinal === 2);
  assert.equal(repo.conversationFor({ groupId: 'g', conversationId: orphan.conversationId }), undefined);
  domain.beforePut = null;
  const restarted = await open(domain);
  assert.equal(restarted.activeConversation('g').conversationId, baseline.conversationId);
  assert.equal((await start(restarted)).created, true);
  assert.equal(restarted.conversationsOf('g').length, 2);
  assert.equal(domain.records('conversations').size, 3);
});

test('commit publishes once at the durable group write and replays after restart', async () => {
  const { domain, repo, baseline } = await fixture();
  const entered = deferred();
  const release = deferred();
  domain.beforePut = async (name, key, value) => {
    if (name === 'groups' && value.conversationVersion === 2) { entered.resolve(); await release.promise; }
  };
  const committed = start(repo);
  await entered.promise;
  assert.equal(repo.activeConversation('g'), baseline);
  assert.equal(repo.conversationsOf('g').length, 1);
  assert.equal(isCurrentMemberSession(repo, repo.getMember('m')), true);
  release.resolve();
  const result = await committed;
  assert.equal(result.created, true);
  assert.equal(isCurrentMemberSession(repo, repo.getMember('m')), false);
  const restarted = await open(domain);
  const replay = await start(restarted, 'request-1', baseline.conversationId);
  assert.equal(replay.created, false);
  assert.equal(replay.conversation.conversationId, result.conversation.conversationId);
  assert.equal(restarted.getMember('m').sessionId, 's1');
});

test('concurrent duplicate requests commit one record and stale requests cannot branch', async () => {
  const { repo, baseline } = await fixture();
  const results = await Promise.all([start(repo, 'same', baseline.conversationId), start(repo, 'same', baseline.conversationId)]);
  assert.deepEqual(results.map(result => result.created), [true, false]);
  assert.equal(repo.conversationsOf('g').length, 2);
  await assert.rejects(start(repo, 'other', baseline.conversationId), { code: 'stale-conversation' });
  await assert.rejects(start(repo, 'same', repo.activeConversation('g').conversationId), { code: 'conflict' });
});

test('replaying an earlier successful request reports the newer current head', async () => {
  const { repo, baseline } = await fixture();
  const second = await start(repo, 'two');
  const third = await start(repo, 'three');
  const replay = await start(repo, 'two', baseline.conversationId);
  assert.equal(replay.created, false);
  assert.equal(replay.conversation, second.conversation);
  assert.equal(replay.currentConversationId, third.conversation.conversationId);
  assert.equal(replay.conversationVersion, 3);
});

test('boundaries use monotonic nextSeq even after message deletion and consecutive empty conversations', async () => {
  const { repo } = await fixture();
  const seq = repo.allocateSeq('g');
  await repo.appendMessage({ messageId: 'one', groupId: 'g', seq, text: 'history', status: 'done' });
  await repo.deleteMessageStrict('one');
  const two = await start(repo, 'two');
  const three = await start(repo, 'three');
  assert.equal(two.conversation.afterSeq, 1);
  assert.equal(three.conversation.afterSeq, 1);
  assert.deepEqual(repo.conversationsOf('g').map(c => c.ordinal), [1, 2, 3]);
  assert.equal(repo.getGroup('g').nextSeq, 1);
  assert.equal(repo.getMember('m').sessionId, 's1');
  assert.equal(repo.sessionBindingsOf('g', three.conversation.conversationId).length, 0);
  assert.throws(() => { three.conversation.afterSeq = 0; }, TypeError);
});

test('strict member mapping failure preserves old mapping and successful rotation keeps historical bindings', async () => {
  const { domain, repo, baseline } = await fixture();
  const original = clone(repo.getMember('m'));
  const { conversation } = await start(repo);
  const candidate = { ...original, sessionId: 's2', sessionConversationId: conversation.conversationId, lastSeenSeq: conversation.afterSeq };
  domain.beforePut = name => { if (name === 'members') throw new Error('member-failed'); };
  await assert.rejects(repo.putMemberStrict(candidate, { expectedConversationId: conversation.conversationId, expectedSessionId: 's1' }), /member-failed/);
  assert.deepEqual(repo.getMember('m'), original);
  assert.equal(repo.sessionBindingFor('s2').conversationId, conversation.conversationId);
  assert.equal(isCurrentMemberSession(repo, repo.getMember('m')), false);
  domain.beforePut = null;
  const saved = await repo.putMemberStrict(candidate, { expectedConversationId: conversation.conversationId, expectedSessionId: 's1' });
  assert.equal(isCurrentMemberSession(repo, saved), true);
  assert.equal(repo.sessionBindingFor('s1').conversationId, baseline.conversationId);
  assert.equal(repo.sessionBindingsOf('g').length, 2);
  const writes = domain.writes.filter(write => ['session_bindings', 'members'].includes(write.table));
  assert.ok(writes.findIndex(write => write.table === 'session_bindings' && write.value.sessionId === 's2') < writes.findIndex(write => write.table === 'members' && write.value.sessionId === 's2'));
});

test('stale group and member writes cannot revert generations or the current cursor', async () => {
  const { domain, repo } = await fixture();
  const staleGroup = clone(repo.getGroup('g'));
  const staleMember = clone(repo.getMember('m'));
  const { conversation } = await start(repo);
  await repo.putMemberStrict({ ...staleMember, sessionId: 's2', sessionConversationId: conversation.conversationId, lastSeenSeq: 1 }, { expectedSessionId: 's1' });
  await repo.putGroup({ ...staleGroup, title: 'Renamed', nextSeq: 0 });
  await repo.putMember({ ...staleMember, enabled: false, lastSeenSeq: 500 });
  await repo.touchMember({ ...staleMember, lastSeenSeq: 999 });
  assert.equal(repo.getGroup('g').activeConversationId, conversation.conversationId);
  assert.equal(repo.getGroup('g').conversationVersion, 2);
  assert.equal(repo.getMember('m').sessionId, 's2');
  assert.equal(repo.getMember('m').sessionConversationId, conversation.conversationId);
  assert.equal(repo.getMember('m').lastSeenSeq, 1);
  await assert.rejects(repo.putMemberStrict(staleMember), { code: 'stale-session' });
  const restarted = await open(domain);
  assert.equal(restarted.getMember('m').sessionId, 's2');
  assert.equal(restarted.getGroup('g').conversationVersion, 2);
});

test('queued member writes check their captured conversation before publishing', async () => {
  const { domain, repo } = await fixture();
  const entered = deferred();
  const release = deferred();
  domain.beforePut = async (name, key, value) => {
    if (name === 'groups' && value.conversationVersion === 2) { entered.resolve(); await release.promise; }
  };
  const commit = start(repo);
  await entered.promise;
  const write = repo.putMemberStrict({ ...repo.getMember('m'), lastSeenSeq: 500 });
  const rejected = assert.rejects(write, { code: 'stale-conversation' });
  release.resolve();
  await commit;
  await rejected;
  assert.equal(repo.getMember('m').lastSeenSeq, 0);
});

test('new members start at the current floor and old logs survive removal and restart', async () => {
  const { domain, repo, baseline } = await fixture();
  repo.allocateSeq('g');
  await repo.flushGroupWrites('g');
  const { conversation } = await start(repo);
  const added = await repo.putMember({ membershipId: 'late', groupId: 'g', botId: 'b', sessionId: 'later', lastSeenSeq: 0 });
  assert.equal(added.lastSeenSeq, 1);
  assert.equal(added.sessionConversationId, conversation.conversationId);
  await repo.deleteMember('m');
  assert.equal(repo.sessionBindingFor('s1').conversationId, baseline.conversationId);
  const restarted = await open(domain);
  assert.equal(restarted.sessionBindingFor('s1').membershipId, 'm');
  assert.equal(restarted.sessionBindingsOf('g', baseline.conversationId).length, 1);
  await restarted.deleteGroup('g');
  assert.equal(restarted.sessionBindingFor('s1'), undefined);
  assert.equal(domain.records('session_bindings').size, 0);
  assert.equal(domain.records('conversations').size, 0);
});

test('native session ownership cannot race between different group write queues', async () => {
  const { repo } = await fixture();
  await repo.putGroup({ groupId: 'g2', title: 'Other' });
  await repo.putMember({ membershipId: 'm2', groupId: 'g2', botId: 'b', sessionId: 'other-initial' });
  const results = await Promise.allSettled([
    repo.bindSession(repo.getMember('m'), { sessionId: 'shared:unsafe/path', conversationId: currentConversationId(repo, 'g') }),
    repo.bindSession(repo.getMember('m2'), { sessionId: 'shared:unsafe/path', conversationId: currentConversationId(repo, 'g2') }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'session-binding-conflict');
});

test('flush waits for admitted writes and refuses a switch after unresolved best-effort failure', async () => {
  const { domain, repo } = await fixture();
  const entered = deferred();
  const release = deferred();
  domain.beforePut = async name => {
    if (name === 'messages') { entered.resolve(); await release.promise; throw new Error('message-failed'); }
  };
  const message = { messageId: 'pending-write', groupId: 'g', seq: repo.allocateSeq('g'), text: 'Hello', status: 'done' };
  const write = repo.appendMessage(message);
  await entered.promise;
  let flushed = false;
  const flush = repo.flushGroupWrites('g').then(() => { flushed = true; });
  const rejected = assert.rejects(flush, { code: 'persistence-failed' });
  await tick();
  assert.equal(flushed, false);
  release.resolve();
  await write;
  await rejected;
  await assert.rejects(start(repo), { code: 'persistence-failed' });
  domain.beforePut = null;
  await repo.putMessageStrict(message);
  await repo.flushGroupWrites('g');
  assert.equal((await start(repo)).created, true);
});

test('legacy records remain baseline while new messages tasks and discussions are tagged', async () => {
  const domain = memoryDomain(legacySeed());
  const repo = await open(domain);
  await repo.runMigrations();
  const baseline = currentConversationId(repo, 'g');
  const { conversation } = await start(repo);
  await repo.appendMessage({ messageId: 'new', groupId: 'g', seq: repo.allocateSeq('g'), status: 'done' });
  const task = await repo.putTask({ taskId: 'new-task', groupId: 'g', title: 'New task' });
  const discussion = await repo.putDiscussion({ discussionId: 'new-discussion', groupId: 'g', topic: 'New discussion' });
  assert.equal(conversationIdOf(repo, repo.getMessage('old')), baseline);
  assert.equal(conversationIdOf(repo, repo.getMessage('new')), conversation.conversationId);
  assert.equal(task.conversationId, conversation.conversationId);
  assert.equal(discussion.conversationId, conversation.conversationId);
  assert.equal(repo.conversationFor({ groupId: 'g', conversationId: 'uncommitted' }), undefined);
});

test('restart rejects corrupt current pointer, ordinal, parent chain and context floor', async () => {
  for (const corrupt of [
    (domain, head) => { domain.records('groups').get('g').activeConversationId = 'missing'; },
    (domain, head) => { domain.records('groups').get('g').conversationVersion += 1; },
    (domain, head) => { domain.records('conversations').get(head).previousConversationId = head; },
    (domain, head) => { domain.records('conversations').get(head).afterSeq = 999; },
    (domain, head) => { domain.records('conversations').get(head).groupId = 'foreign'; },
  ]) {
    const { domain, repo } = await fixture();
    await start(repo);
    corrupt(domain, currentConversationId(repo, 'g'));
    await assert.rejects(open(domain), { code: 'conversation-corrupt' });
  }
});

test('pure helper compatibility only permits legacy doubles without a conversation pointer', () => {
  const member = { membershipId: 'm', groupId: 'g', botId: 'b', sessionId: 's' };
  const legacy = { groups: new Map([['g', { groupId: 'g' }]]), members: new Map([['m', member]]) };
  assert.equal(conversationFloor(legacy, 'g'), 0);
  assert.equal(currentConversationId(legacy, 'g'), null);
  assert.equal(isCurrentMemberSession(legacy, member), true);
  legacy.groups.set('g', { groupId: 'g', activeConversationId: 'c2' });
  assert.equal(currentConversationId(legacy, 'g'), 'c2');
  assert.equal(isCurrentMemberSession(legacy, member), false);
  assert.equal(conversationIdOf(legacy, { groupId: 'g', seq: 1 }), null);
  assert.throws(() => conversationFloor(legacy, 'g'), { code: 'conversation-corrupt' });
  assert.equal(isCurrentMemberSession({ ...legacy, activeConversation: () => undefined }, member), false);
});

test('same requestId cannot be concurrently reused in another chat', async () => {
  const { repo, baseline } = await fixture();
  await repo.putGroup({ groupId: 'g2', title: 'Other' });
  const results = await Promise.allSettled([
    start(repo, 'shared-request', baseline.conversationId),
    repo.commitConversation('g2', { requestId: 'shared-request', expectedConversationId: currentConversationId(repo, 'g2') }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'conflict');
  assert.equal(repo.conversationsOf('g').length + repo.conversationsOf('g2').length, 3);
});

test('editing a member read snapshot cannot publish a failed session mapping', async () => {
  const { domain, repo } = await fixture();
  const member = repo.getMember('m');
  member.sessionId = 's2';
  domain.beforePut = name => { if (name === 'members') throw new Error('member-failed'); };
  await assert.rejects(repo.putMemberStrict(member, { expectedSessionId: 's1' }), /member-failed/);
  assert.equal(repo.getMember('m').sessionId, 's1');
  const group = repo.getGroup('g');
  group.activeConversationId = 'uncommitted';
  assert.notEqual(repo.getGroup('g').activeConversationId, 'uncommitted');
});

test('same-conversation session rotations cannot be reversed by old member objects', async () => {
  const { repo } = await fixture();
  const stale = repo.getMember('m');
  await repo.putMemberStrict({ ...stale, sessionId: 's2' }, { expectedSessionId: 's1' });
  await assert.rejects(repo.putMemberStrict(stale), { code: 'stale-session' });
  await repo.putMember(stale);
  assert.equal(repo.getMember('m').sessionId, 's2');
  assert.equal(repo.sessionBindingsOf('g').length, 2);
});

test('a pending group settings write cannot erase later reserved message sequences', async () => {
  const { domain, repo } = await fixture();
  const entered = deferred();
  const release = deferred();
  domain.beforePut = async (name, key, value) => {
    if (name === 'groups' && value.title === 'Held' && value.nextSeq === 0) { entered.resolve(); await release.promise; }
  };
  const write = repo.putGroup({ ...repo.getGroup('g'), title: 'Held' });
  await entered.promise;
  assert.equal(repo.allocateSeq('g'), 1);
  release.resolve();
  await write;
  await repo.flushGroupWrites('g');
  assert.equal(repo.getGroup('g').nextSeq, 1);
  assert.equal(domain.records('groups').get('g').nextSeq, 1);
  assert.equal((await start(repo)).conversation.afterSeq, 1);
});

test('failed best-effort message updates block switching until they are persisted', async () => {
  const { domain, repo } = await fixture();
  const message = { messageId: 'one', groupId: 'g', seq: repo.allocateSeq('g'), status: 'done', text: 'initial' };
  await repo.appendMessage(message);
  domain.beforePut = name => { if (name === 'messages') throw new Error('update-failed'); };
  await repo.putMessage({ ...message, text: 'updated' });
  await assert.rejects(repo.flushGroupWrites('g'), { code: 'persistence-failed' });
  domain.beforePut = null;
  await repo.putMessage({ ...message, text: 'updated' });
  await repo.flushGroupWrites('g');
  assert.equal((await start(repo)).created, true);
});
