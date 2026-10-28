import test from 'node:test';
import assert from 'node:assert/strict';
import { loadClient, plain, walk, text } from './client-harness.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const noop = () => {};
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const group = { groupId: 'g1', title: 'Team', currentConversationId: 'c1', activeConversationId: 'c1', conversationVersion: 1 };
const bots = [1, 2, 3, 4].map(id => ({ botId: 'b' + id, name: id === 1 ? '取消' : 'Bot ' + id }));
const members = bots.map((bot, index) => ({ membershipId: 'mem' + (index + 1), botId: bot.botId, groupId: 'g1', enabled: index !== 3 }));
const record = (patch = {}) => ({ discussionId: 'd1', groupId: 'g1', conversationId: 'c1', protocolVersion: 2, revision: 7, status: 'running', mode: 'discussion', format: 'structured', topic: 'Topic', rounds: 3, currentRound: 1, currentSpeaker: 'mem1', currentStepId: 's1', createdAt: 100,
  participants: [{ membershipId: 'mem1', name: 'Snapshot author' }], steps: [{ stepId: 's1', phase: 'viewpoint', membershipId: 'mem1', round: 1, status: 'running', messageIds: [] }, { stepId: 's2', phase: 'viewpoint', membershipId: 'mem2', round: 1, status: 'pending', messageIds: [] }], ...patch });
const message = (id, phase, extra = {}) => ({ messageId: id, groupId: 'g1', conversationId: 'c1', seq: Number(id.replace(/\D/g, '')) || 1, kind: 'discussion', author: { type: 'bot', botId: 'b1', name: 'Snapshot author' }, text: 'Original ' + id, status: 'done', meta: { discussionId: 'd1', phase }, ...extra });
const button = (tree, label) => walk(tree).find(node => node.type === 'button' && text(node) === label);
const field = (tree, id) => walk(tree).find(node => node.props?.id === id);
const actionRequests = requests => requests.filter(request => request.action !== 'ui.report');
function dialog(options = {}) {
  const requests = [], saved = [];
  const client = loadClient({ lifecycleEffects: true, fetch: async (url, init) => { const request = JSON.parse(init.body); requests.push(request); return options.fetch ? options.fetch(request) : Response.json({ ok: true, result: record() }); } });
  const props = { group, bots, members, defaultTopic: '', onClose: noop, onSaved: result => saved.push(result), ...options.props };
  const render = () => client.render(client.DiscussionDialog, props);
  const change = (id, value) => { field(render(), 'bt-discussion-' + id).props.onChange({ target: { value } }); return render(); };
  return { client, props, render, change, requests, saved };
}
function progress(options = {}) {
  const requests = [], updated = [];
  const client = loadClient({ lifecycleEffects: true, fetch: async (url, init) => { const request = JSON.parse(init.body); requests.push(request); return options.fetch ? options.fetch(request) : Response.json({ ok: true, result: record({ revision: 8, status: 'paused' }) }); } });
  const props = { discussion: record(), group, members, bots, onUpdated: value => updated.push(value), ...options.props };
  const render = () => client.render(client.DiscussionProgress, props);
  return { client, props, render, requests, updated };
}

test('new setup defaults to structured three rounds and enabled members only', () => {
  const c = dialog(); const tree = c.render();
  assert.equal(field(tree, 'bt-discussion-rounds').props.value, 3);
  assert.equal(field(tree, 'bt-discussion-format').props.value, 'structured');
  assert.equal(button(tree, '开始讨论').props.disabled, true);
  const enabled = walk(tree).filter(node => node.type === 'input' && node.props.type === 'checkbox' && node.props.checked);
  assert.equal(enabled.length, 4, 'three enabled members and final summary');
  assert.match(text(tree), /预计 12 次模型发言/);
  assert.deepEqual(plain(field(tree, 'bt-discussion-rounds').props.children.map(node => node.props.value)), [2, 3, 5, 'custom']);
  assert.ok(walk(tree).some(node => node.type === 'details' && node.props.className === 'bt-discussion-advanced'));
});

test('topic validation rejects whitespace and oversize input without dispatch', async () => {
  const c = dialog();
  for (const topic of ['  \n ', 'x'.repeat(2001)]) { c.change('topic', topic); const start = button(c.render(), '开始讨论'); assert.equal(start.props.disabled, true); start.props.onClick(); await tick(); }
  assert.equal(actionRequests(c.requests).length, 0);
  assert.equal(field(c.change('topic', 'x'.repeat(2000)), 'bt-discussion-topic').props.maxLength, 2000);
  assert.equal(button(c.render(), '开始讨论').props.disabled, false);
});

test('start payload preserves explicit order and independent summary author with advanced fields', async () => {
  const c = dialog(); c.change('topic', '  User topic  ');
  walk(c.render()).find(node => node.props?.['aria-label'] === '下移 取消').props.onClick();
  const row = walk(c.render()).find(node => node.props?.className === 'bt-discussion-member' && text(node).includes('Bot 3'));
  walk(row).find(node => node.type === 'input').props.onChange();
  c.change('summaryMembershipId', 'mem3'); c.change('goal', 'decision'); c.change('background', 'facts'); c.change('responseLength', 'short'); c.change('language', 'en');
  const refs = walk(c.render()).find(node => node.type === c.client.DiscussionReferences); refs.props.onChange('old-id, new-id\nold-id');
  field(c.render(), 'bt-perspective-mem2').props.onChange({ target: { value: 'Risk' } });
  button(c.render(), '开始讨论').props.onClick(); await tick();
  const request = actionRequests(c.requests)[0]; assert.equal(request.action, 'discussion.start');
  assert.deepEqual(plain(request.payload), { groupId: 'g1', expectedConversationId: 'c1', topic: 'User topic', mode: 'discussion', format: 'structured', membershipIds: ['mem2', 'mem1'], rounds: 3, summarize: true, summaryMembershipId: 'mem3', goal: 'decision', background: 'facts', responseLength: 'short', language: 'en', perspectives: { mem2: 'Risk' }, contextMessageIds: ['old-id', 'new-id'] });
  assert.equal(c.saved[0].discussionId, 'd1');
});

test('mode tabs preserve discussion order, both positions and advanced drafts', () => {
  const c = dialog(); c.change('topic', 'Keep topic'); c.change('goal', 'Keep goal'); c.change('format', 'classic');
  button(c.render(), '1v1 辩论').props.onClick(); c.change('proPosition', 'Support'); c.change('conPosition', 'Oppose'); c.change('judgeMembershipId', 'mem3');
  assert.match(text(c.render()), /预计 13 次模型发言/);
  button(c.render(), '多成员讨论').props.onClick(); assert.equal(field(c.render(), 'bt-discussion-format').props.value, 'classic');
  assert.equal(field(c.render(), 'bt-discussion-topic').props.value, 'Keep topic');
  assert.equal(field(c.render(), 'bt-discussion-goal').props.value, 'Keep goal');
  button(c.render(), '1v1 辩论').props.onClick(); assert.equal(field(c.render(), 'bt-discussion-proPosition').props.value, 'Support'); assert.equal(field(c.render(), 'bt-discussion-conPosition').props.value, 'Oppose');
});

test('debate excludes the opposite side and judge, and validates forged duplicate choices', async () => {
  const c = dialog(); c.change('topic', 'Debate'); button(c.render(), '1v1 辩论').props.onClick();
  const pro = field(c.render(), 'bt-discussion-proMembershipId'); assert.equal(pro.props.children.find(node => node.props.value === 'mem2').props.disabled, true);
  const judge = field(c.render(), 'bt-discussion-judgeMembershipId'); for (const id of ['mem1', 'mem2', 'mem4']) assert.equal(judge.props.children.find(node => node.props.value === id).props.disabled, true);
  c.change('conMembershipId', 'mem1'); assert.equal(button(c.render(), '开始辩论').props.disabled, true); button(c.render(), '开始辩论').props.onClick(); await tick(); assert.equal(actionRequests(c.requests).length, 0);
  c.change('conMembershipId', 'mem2'); c.change('judgeMembershipId', 'mem3'); c.change('proPosition', 'For'); c.change('conPosition', 'Against');
  button(c.render(), '开始辩论').props.onClick(); await tick();
  const payload = actionRequests(c.requests)[0].payload;
  assert.deepEqual(payload.membershipIds, ['mem1', 'mem2']); assert.equal(payload.judgeMembershipId, 'mem3'); assert.equal(payload.proPosition, 'For'); assert.equal(payload.conPosition, 'Against'); assert.equal(payload.mode, 'debate'); assert.equal(payload.summarize, false);
});

test('start uses a synchronous request lock and captured conversation', async () => {
  const wait = deferred(); const c = dialog({ fetch: request => request.action === 'ui.report' ? Response.json({ ok: true }) : wait.promise }); c.change('topic', 'Topic');
  const start = button(c.render(), '开始讨论'); start.props.onClick(); start.props.onClick(); assert.equal(actionRequests(c.requests).length, 1);
  wait.resolve(Response.json({ ok: true, result: record() })); await tick();
  const d = dialog(); d.change('topic', 'Topic'); d.props.group = { ...group, currentConversationId: 'c2' }; assert.equal(button(d.render(), '开始讨论').props.disabled, true); button(d.render(), '开始讨论').props.onClick(); await tick(); assert.equal(actionRequests(d.requests).length, 0);
});

test('round cost covers structured checkpoints, classic and optional judge', () => {
  const c = loadClient(); const draft = c.createDiscussionDraft(members, 'Topic');
  for (const rounds of [1, 2, 3]) {
    assert.equal(c.discussionEstimate({ ...draft, rounds, summarize: false }), 3 * rounds + rounds - 1);
    assert.equal(c.discussionEstimate({ ...draft, rounds, format: 'classic' }), 3 * rounds + 1);
    assert.equal(c.discussionEstimate({ ...draft, mode: 'debate', rounds }), 4 + 4 * rounds);
    assert.equal(c.discussionEstimate({ ...draft, mode: 'debate', rounds, judgeMembershipId: 'mem3' }), 5 + 4 * rounds);
  }
});

test('reference picker deduplicates typed IDs and preserves content in English', () => {
  const c = loadClient(); c.setTestLocale('en'); let value;
  const tree = c.render(c.DiscussionReferences, { id: 'refs', value: 'older,older', onChange: next => { value = next; }, messages: [message('m2', 'viewpoint', { text: '取消' })] });
  walk(tree).find(node => node.type === 'input').props.onChange(); assert.equal(value, 'older\nm2'); assert.match(text(tree), /取消/);
  assert.equal(walk(tree).find(node => node.type === 'label').props.htmlFor, 'refs');
});

test('tabs support arrow focus and fields have associated labels', () => {
  const c = dialog(); let focused = ''; const tab = button(c.render(), '多成员讨论');
  tab.props.onKeyDown({ key: 'ArrowRight', preventDefault: noop, currentTarget: { parentElement: { querySelector: id => ({ focus: () => { focused = id; } }) } } });
  assert.equal(focused, '#bt-mode-debate'); assert.equal(button(c.render(), '1v1 辩论').props['aria-selected'], true);
  for (const node of walk(c.render()).filter(node => ['input', 'select', 'textarea'].includes(node.type) && node.props.id)) assert.ok(walk(c.render()).some(label => label.type === 'label' && label.props.htmlFor === node.props.id), node.props.id);
});

test('pause and resume include request identity and revision and respect in-flight lock', async () => {
  const wait = deferred(); const c = progress({ fetch: () => wait.promise }); const pause = button(c.render(), '暂停'); pause.props.onClick(); pause.props.onClick();
  assert.equal(c.requests.length, 1); assert.equal(c.requests[0].action, 'discussion.control');
  const payload = c.requests[0].payload; assert.equal(payload.discussionId, 'd1'); assert.equal(payload.operation, 'pause'); assert.equal(payload.expectedRevision, 7); assert.equal(payload.expectedConversationId, 'c1'); assert.ok(payload.requestId);
  wait.resolve(Response.json({ ok: true, result: record({ revision: 8, status: 'paused' }) })); await tick(); assert.equal(c.updated[0].revision, 8);
  const resumed = progress({ props: { discussion: record({ status: 'paused', revision: 11 }) } }); button(resumed.render(), '继续').props.onClick(); await tick(); assert.equal(resumed.requests[0].payload.expectedRevision, 11); assert.equal(resumed.requests[0].payload.operation, 'resume');
});

test('paused errors offer retry, finish and stop; pending states remain active', async () => {
  for (const [label, operation] of [['重试当前步骤', 'retry'], ['提前收尾', 'finish'], ['停止讨论', 'stop']]) {
    const c = progress({ props: { discussion: record({ status: 'paused', steps: [{ stepId: 's1', phase: 'answer', side: 'con', membershipId: 'mem2', status: 'error', messageIds: [] }] }) } });
    assert.equal(button(c.render(), '继续').props.disabled, true); button(c.render(), label).props.onClick(); await tick(); assert.equal(c.requests[0].payload.operation, operation); assert.ok(c.requests[0].payload.requestId);
  }
  const c = loadClient(); for (const status of ['running', 'pausing', 'paused', 'finalizing', 'stopping']) assert.equal(c.isActiveDiscussion(record({ status })), true);
  for (const status of ['done', 'stopped']) assert.equal(c.isActiveDiscussion(record({ status })), false);
});

test('additional context sends text and selected IDs with concurrency guards', async () => {
  const c = progress(); button(c.render(), '补充上下文').props.onClick(); field(c.render(), 'bt-context-text-d1').props.onChange({ target: { value: 'New evidence' } });
  walk(c.render()).find(node => node.type === c.client.DiscussionReferences).props.onChange('m1 m2 m1'); button(c.render(), '添加上下文').props.onClick(); await tick();
  assert.deepEqual(c.requests[0].payload.contextMessageIds, ['m1', 'm2']); assert.equal(c.requests[0].payload.text, 'New evidence'); assert.equal(c.requests[0].payload.expectedRevision, 7); assert.equal(c.requests[0].payload.operation, 'add_context');
});

test('history cannot control and stale revision failures refresh without replaying the operation', async () => {
  const history = progress({ props: { group: { ...group, currentConversationId: 'c2' } } }); assert.equal(button(history.render(), '暂停'), undefined); assert.match(text(history.render()), /历史会话仅可查看/);
  const c = progress({ fetch: request => request.action === 'discussion.control' ? Response.json({ ok: false, error: { code: 'stale-revision', message: 'Changed' } }, { status: 409 }) : Response.json({ ok: true, result: { discussion: record({ revision: 12 }) } }) });
  button(c.render(), '暂停').props.onClick(); await tick(); await tick(); assert.deepEqual(c.requests.map(request => request.action), ['discussion.control', 'discussion.get']); assert.equal(c.updated[0].revision, 12); assert.match(text(c.render()), /Changed/);
});

test('progress uses steps and participant snapshots, with phase side and next speaker', () => {
  const c = progress({ props: { discussion: record({ phase: 'answer', currentStepId: 's2', steps: [{ stepId: 's1', phase: 'question', side: 'pro', membershipId: 'mem1', status: 'done', messageIds: ['m1', 'm2'] }, { stepId: 's2', phase: 'answer', side: 'con', membershipId: 'mem1', status: 'running' }, { stepId: 's3', phase: 'closing', side: 'pro', membershipId: 'mem2', status: 'pending' }] }) } });
  assert.match(text(c.render()), /回答 · 反方 · Snapshot author/); assert.match(text(c.render()), /已完成 1\/3 步/); assert.match(text(c.render()), /下一步：总结陈词 · 正方 · Bot 2/);
});

test('SSE, bootstrap and group snapshots cannot roll discussion revisions or conversations backward', () => {
  const c = loadClient(); const current = record({ revision: 10, status: 'paused' }); let state = { ...c.initialState, activeGroupId: 'g1', groups: [{ ...group, activeDiscussion: current }], discussions: { g1: current } };
  state = c.reducer(state, { type: 'sse', frame: { type: 'discussion.updated', discussion: record({ revision: 8 }) } }); assert.equal(state.discussions.g1.revision, 10);
  state = c.reducer(state, { type: 'bootstrap', data: { groups: [{ ...group, activeDiscussion: record({ revision: 9 }) }], bots, members } }); assert.equal(state.discussions.g1.revision, 10); assert.equal(state.groups[0].activeDiscussion.revision, 10);
  state = c.reducer(state, { type: 'sse', frame: { type: 'group.updated', group: { ...group, activeDiscussion: record({ revision: 6 }) } } }); assert.equal(state.groups[0].activeDiscussion.revision, 10);
  state = c.reducer(state, { type: 'discussion', discussion: record({ discussionId: 'older', conversationId: 'old', revision: 100, createdAt: 200 }) }); assert.equal(state.discussions.g1.discussionId, 'd1');
  state = c.reducer(state, { type: 'discussion', discussion: record({ status: 'done', revision: 11 }) }); assert.equal(state.groups[0].activeDiscussion, null);
  state = c.reducer(state, { type: 'discussion', discussion: record({ status: 'running', revision: 10 }) }); assert.equal(state.discussions.g1.status, 'done');
});

test('all active states survive bootstrap and terminal states release the active record', () => {
  const c = loadClient(); for (const status of ['running', 'pausing', 'paused', 'finalizing', 'stopping', 'done', 'stopped']) {
    const state = c.reducer({ ...c.initialState, groups: [group] }, { type: 'discussion', discussion: record({ status }) }); assert.equal(!!state.groups[0].activeDiscussion, !['done', 'stopped'].includes(status));
  }
});

test('result gets all history by discussion ID and groups results by step phase', async () => {
  const requests = [], jumps = []; const transcript = [message('m1', 'viewpoint'), message('m101', 'closing'), message('m102', 'closing', { text: 'Second turn' }), message('m103', 'judgement')];
  const completed = record({ status: 'done', mode: 'debate', judgeMembershipId: 'mem3', verdict: 'con', steps: [{ stepId: 'close', phase: 'closing', status: 'done', messageIds: ['m101', 'm102'] }, { stepId: 'judge', phase: 'judgement', status: 'done', messageIds: ['m103', 'deleted'] }] });
  const c = loadClient({ lifecycleEffects: true, fetch: async (url, init) => { requests.push(JSON.parse(init.body)); return Response.json({ ok: true, result: { discussion: completed, transcript, missingMessageIds: ['deleted'] } }); } });
  const props = { discussion: completed, group, bots, onJumpToMessage: (...args) => jumps.push(args) }; let tree = c.render(c.DiscussionResult, props); assert.equal(requests.length, 0);
  button(tree, '展开完整记录').props.onClick(); c.render(c.DiscussionResult, props); c.flushEffects(); await tick(); tree = c.render(c.DiscussionResult, props);
  assert.deepEqual(requests[0], { action: 'discussion.get', payload: { groupId: 'g1', discussionId: 'd1' } });
  assert.match(text(tree), /反方胜/); assert.match(text(tree), /1 条原文已删除或不可用/);
  const phases = walk(tree).filter(node => node.props?.['data-result-phase']); assert.deepEqual(phases.map(node => node.props['data-result-phase']), ['closing', 'judgement']);
  button(tree, '跳转原文 #101').props.onClick(); assert.equal(jumps[0][0], 'm101'); assert.equal(jumps[0][1].length, 4);
});

test('old Host details paginate saved messages without mixing groups, discussions or conversations', async () => {
  const calls = [], updated = [], jumps = [];
  const completed = record({ protocolVersion: 1, status: 'done', steps: [] });
  const summary = message('m120', undefined, { text: 'Saved final summary', meta: { discussionId: 'd1', summary: true } });
  const older = message('m1', undefined, { text: 'Earlier round' });
  const c = loadClient({ lifecycleEffects: true, fetch: async (url, init) => {
    calls.push({ url, init });
    if (init.method === 'POST') return Response.json({ ok: false, error: { code: 'unknown-action', message: '未知操作: discussion.get' } }, { status: 400 });
    const before = new URL(url, 'http://fixture').searchParams.get('beforeSeq');
    return Response.json({ ok: true, hasMore: !before, messages: before ? [older, summary,
      message('m2', 'summary', { text: 'Wrong group', groupId: 'g2' }),
      message('m3', 'summary', { text: 'Wrong conversation', conversationId: 'old' }),
      message('m4', 'summary', { text: 'Wrong discussion', meta: { discussionId: 'd2', summary: true } })] : [summary] });
  } });
  const props = { discussion: completed, group, bots, initiallyExpanded: true, onUpdated: value => updated.push(value), onJumpToMessage: (...args) => jumps.push(args) };
  c.render(c.DiscussionResult, props); c.flushEffects(); await tick();
  const tree = c.render(c.DiscussionResult, props);
  assert.deepEqual(calls.map(call => call.init.method), ['POST', 'GET', 'GET']);
  assert.match(calls[2].url, /beforeSeq=120/);
  assert.match(text(tree), /Saved final summary/); assert.match(text(tree), /Earlier round/);
  assert.doesNotMatch(text(tree), /未知操作|Wrong group|Wrong conversation|Wrong discussion/);
  assert.match(text(tree), /已从群消息中读取讨论记录/);
  const sections = walk(tree).filter(node => node.props?.['data-result-phase']);
  assert.deepEqual(sections.map(node => node.props['data-result-phase']), ['summary']);
  button(tree, '跳转原文 #1').props.onClick();
  assert.deepEqual(plain(jumps[0][1]).map(item => item.messageId), ['m1', 'm120']);
  assert.deepEqual(updated, [], 'a message-derived detail must not change active discussion state');
});

test('legacy historical details work without a run snapshot and respect local deletions', async () => {
  const c = loadClient({ lifecycleEffects: true, fetch: async (_url, init) => init.method === 'POST'
    ? Response.json({ ok: false, error: { code: 'unknown-action', message: 'unsupported' } }, { status: 400 })
    : Response.json({ ok: true, messages: [message('m1', 'viewpoint'),
        message('m2', 'summary', { text: 'Deleted summary' }),
        message('m3', 'summary', { status: 'error', text: 'Failed draft' })], hasMore: false }) });
  const props = { discussionId: 'd1', group: { ...group, latestDiscussion: record({ discussionId: 'new', topic: 'Unrelated topic' }) },
    bots, initiallyExpanded: true, deletedMessageIds: { m2: true }, onUpdated: () => assert.fail('historical transcript is read-only') };
  c.render(c.DiscussionResult, props); c.flushEffects(); await tick();
  const tree = c.render(c.DiscussionResult, props);
  assert.match(text(tree), /Original m1/); assert.doesNotMatch(text(tree), /Deleted summary|Unrelated topic/);
  assert.equal(walk(tree).some(node => node.props?.['data-result-phase'] === 'summary'), false, 'a failed draft is not a final summary');
  assert.match(text(tree), /Failed draft/); // still available in the original transcript
});

test('discussion details preserve real API failures instead of falling back to chat history', async () => {
  for (const [code, status] of [['not-found', 404], ['forbidden', 403], ['internal-error', 500]]) {
    let calls = 0;
    const c = loadClient({ lifecycleEffects: true, fetch: async () => { calls++; return Response.json({ ok: false, error: { code, message: 'Original failure ' + code } }, { status }); } });
    const props = { discussion: record(), group, initiallyExpanded: true };
    c.render(c.DiscussionResult, props); c.flushEffects(); await tick();
    assert.equal(calls, 1); assert.match(text(c.render(c.DiscussionResult, props)), new RegExp('Original failure ' + code));
  }
});

test('legacy detail reads discard late history and keep missing history actionable', async () => {
  const wait = deferred();
  const c = loadClient({ lifecycleEffects: true, fetch: async (_url, init) => {
    if (init.method === 'GET') return wait.promise;
    const id = JSON.parse(init.body).payload.discussionId;
    return id === 'd1' ? Response.json({ ok: false, error: { code: 'unknown-action', message: 'unsupported' } }, { status: 400 })
      : Response.json({ ok: true, result: { discussion: record({ discussionId: 'd2', steps: [] }), transcript: [message('m2', 'summary', { text: 'New selection' })] } });
  } });
  const props = { discussionId: 'd1', group, initiallyExpanded: true };
  c.render(c.DiscussionResult, props); c.flushEffects(); await tick();
  props.discussionId = 'd2'; c.render(c.DiscussionResult, props); c.flushEffects(); await tick();
  wait.resolve(Response.json({ ok: true, messages: [message('m1', 'summary', { text: 'Stale legacy reply' })], hasMore: false })); await tick();
  const output = text(c.render(c.DiscussionResult, props)); assert.match(output, /New selection/); assert.doesNotMatch(output, /Stale legacy reply/);
  const empty = loadClient({ lifecycleEffects: true, fetch: async (_url, init) => init.method === 'POST'
    ? Response.json({ ok: false, error: { code: 'unknown-action', message: 'unsupported' } }, { status: 400 })
    : Response.json({ ok: true, messages: [], hasMore: false }) });
  empty.render(empty.DiscussionResult, props); empty.flushEffects(); await tick();
  assert.match(text(empty.render(empty.DiscussionResult, props)), /未找到这条讨论的已保存消息/);
});

test('legacy detail marks incomplete pagination and rejects mixed conversation history', async () => {
  for (const mixed of [false, true]) {
    const c = loadClient({ lifecycleEffects: true, fetch: async (_url, init) => init.method === 'POST'
      ? Response.json({ ok: false, error: { code: 'unknown-action', message: 'unsupported' } }, { status: 400 })
      : Response.json({ ok: true, messages: mixed ? [message('m1', 'summary'), message('m2', 'summary', { conversationId: 'other' })] : [message('m1', 'summary')], hasMore: !mixed }) });
    const props = { discussionId: 'd1', group, initiallyExpanded: true };
    c.render(c.DiscussionResult, props); c.flushEffects(); await tick();
    const output = text(c.render(c.DiscussionResult, props));
    if (mixed) { assert.match(output, /讨论记录不匹配/); assert.doesNotMatch(output, /Original m1|Original m2/); }
    else { assert.match(output, /仅载入部分历史消息/); assert.match(output, /已载入的原始消息（1）/); assert.doesNotMatch(output, /全部原始消息/); }
  }
});

test('result verdict never guesses prose or top-level verdict; no judge stays undecided', async () => {
  const c = loadClient(); assert.equal(c.discussionVerdictLabel(record({ mode: 'debate', verdict: 'pro' })), '未设置裁判，不判定胜负');
  assert.equal(c.discussionVerdictLabel(record({ mode: 'discussion', verdict: 'pro' })), '');
  assert.equal(c.discussionVerdictLabel(record({ mode: 'debate', judgeMembershipId: 'mem3', summary: 'Pro wins', verdict: undefined })), '尚无裁决');
  for (const verdict of ['pro', 'con', 'tie', 'insufficient']) assert.notEqual(c.discussionVerdictLabel(record({ mode: 'debate', judgeMembershipId: 'mem3', verdict })), '尚无裁决');
});

test('result excludes locally deleted source content and rejects late detail responses', async () => {
  const waits = [deferred(), deferred()]; let index = 0; const c = loadClient({ lifecycleEffects: true, fetch: () => waits[index++].promise }); const props = { group, bots, discussion: record({ status: 'done', revision: 5 }), initiallyExpanded: true, deletedMessageIds: { m1: true } };
  c.render(c.DiscussionResult, props); c.flushEffects(); props.discussion = record({ status: 'done', revision: 8 }); c.render(c.DiscussionResult, props); c.flushEffects();
  waits[1].resolve(Response.json({ ok: true, result: { discussion: props.discussion, transcript: [message('m1', 'summary', { text: 'Deleted secret' }), message('m2', 'viewpoint', { text: 'Latest source' })] } })); await tick();
  waits[0].resolve(Response.json({ ok: true, result: { discussion: record({ status: 'done', revision: 5 }), transcript: [message('m3', 'summary', { text: 'Stale source' })] } })); await tick();
  const result = text(c.render(c.DiscussionResult, props)); assert.match(result, /Latest source/); assert.doesNotMatch(result, /Deleted secret|Stale source/);
});

test('Markdown and HTML preserve phases, sides and linked execution metadata with escaping', () => {
  const c = loadClient(); c.setTestLocale('en'); const messages = [message('m9', 'judgement', { text: '取消', meta: { discussionId: 'd<1>', stepId: 's1', attemptId: 'a1', phase: 'judgement', side: 'judge', round: 3, summary: true, speaker: '<Judge>' } }), message('m10', 'summary', { meta: { phase: 'summary', side: 'neutral', summary: true } })];
  const options = { group, members, bots, messages }; const md = c.buildGroupMarkdown(options), html = c.buildGroupHtml(options);
  assert.match(md, /Judgement · Judge · Round 3/); assert.match(md, /Final summary · Neutral/); assert.match(md, /discussionId: d<1> · stepId: s1 · attemptId: a1 · phase: judgement · side: judge · speaker: <Judge>/);
  assert.match(html, /discussionId: d&lt;1&gt;/); assert.doesNotMatch(html, /speaker: <Judge>/); assert.match(html, /取消/);
});

test('structured start system events translate chrome while keeping the topic verbatim', () => {
  const c = loadClient(); c.setTestLocale('en');
  for (const mode of ['discussion', 'debate']) { const message = { kind: 'discussion', author: { type: 'system' }, text: '开始' + (mode === 'debate' ? '辩论' : '讨论') + '：取消', meta: { event: 'start', mode, discussionId: 'd1' } };
    assert.equal(c.translateSystemText(message.text, message.meta), 'Started ' + mode + ': 取消');
    assert.match(text(c.render(c.MessageRow, { message, bots, allMessages: [], tasks: [] })), /取消/);
    assert.match(c.buildGroupMarkdown({ group, members, bots, messages: [message] }), new RegExp('Started ' + mode + ': 取消'));
  }
});

test('current discussion and debate controls appear below members and remain accessible when the rail is closed', () => {
  const initialState = loadClient().initialState;
  for (const mode of ['discussion', 'debate']) {
    const cases = ['running', 'pausing', 'paused', 'finalizing', 'stopping'].map(status => [record({ mode, status }), true]);
    cases.push([null, false], [record({ mode, status: 'done' }), false], [record({ mode, status: 'stopped' }), false], [record({ mode, conversationId: 'old' }), false]);
    for (const [discussion, visible] of cases) {
      const c = loadClient({ state: { ...initialState, loading: false, groups: [group], activeGroupId: 'g1', bots, members, rightPanelCollapsed: false, discussions: { g1: discussion } } });
      const tree = c.render(c.BotTeamPage);
      const panel = walk(tree).find(node => node.type === c.MembersPanel);
      const rail = c.render(c.MembersPanel, panel.props);
      const controls = walk(rail).filter(node => node.type === c.DiscussionProgress);
      assert.equal(controls.length, visible ? 1 : 0);
      assert.equal(walk(tree).filter(node => node.type === c.DiscussionProgress).length, controls.length, 'controls only live in the members rail');
      assert.equal(walk(tree).some(node => node.type === c.DiscussionResult), false, 'finished records do not linger in the chat');
      if (visible) {
        const list = rail.props.children.at(-1);
        assert.equal(list.props.children.at(-1).props.className, 'bt-discussion-dock');
        assert.match(text(list.props.children.at(-2)), /Bot 4/);
        assert.equal(controls[0].props.discussion.discussionId, discussion.discussionId);
      }
    }
    const c = loadClient({ state: { ...initialState, loading: false, groups: [group], activeGroupId: 'g1', bots, members, rightPanelCollapsed: true, discussions: { g1: record({ mode }) } } });
    let tree = c.render(c.BotTeamPage);
    assert.equal(walk(tree).some(node => node.type === c.DiscussionProgress || node.props?.className === 'bt-discussion-dock'), false);
    button(tree, mode === 'debate' ? '查看当前辩论' : '查看当前讨论').props.onClick(); tree = c.render(c.BotTeamPage);
    assert.ok(walk(tree).some(node => node.type === c.DiscussionProgress));
    assert.ok(walk(tree).some(node => node.type === c.DiscussionResult && node.props.initiallyExpanded));
    assert.equal(walk(tree).some(node => node.type === c.DiscussionDialog), false);
  }
});

test('discussion styles wrap fields and use both theme palettes', () => {
  const c = loadClient(); const css = c.GLOBAL_CSS;
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.bt-discussion-grid\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(css, /\.bt-discussion-heading, \.bt-discussion-status, \.bt-discussion-actions\s*\{[^}]*flex-wrap: wrap/);
  assert.match(css, /\.bt-discussion-badge\s*\{[^}]*var\(--bt-accent\)/);
  assert.match(css, /body\[data-ds-dark-theme\] \.bt-root/);
});

test('approved round presets adapt to format and preserve per-mode drafts', () => {
  const c = dialog(); c.change('topic', 'Topic'); c.change('rounds', 5); button(c.render(), '1v1 辩论').props.onClick();
  assert.equal(field(c.render(), 'bt-discussion-rounds').props.value, 2); assert.deepEqual(plain(field(c.render(), 'bt-discussion-rounds').props.children.map(node => node.props.value)), [1, 2, 3, 'custom']);
  c.change('rounds', 1); button(c.render(), '多成员讨论').props.onClick(); assert.equal(field(c.render(), 'bt-discussion-rounds').props.value, 5);
  c.change('format', 'classic'); assert.deepEqual(plain(field(c.render(), 'bt-discussion-rounds').props.children.map(node => node.props.value)), [1, 2, 3, 4, 5, 'custom']);
  c.change('rounds', 4); c.change('format', 'structured'); assert.equal(field(c.render(), 'bt-discussion-rounds').props.value, 'custom');
  assert.equal(field(c.render(), 'bt-discussion-customRounds').props.value, 4);
  button(c.render(), '1v1 辩论').props.onClick(); assert.equal(field(c.render(), 'bt-discussion-rounds').props.value, 1);
});

test('custom rounds submit the selected integer and update estimates in every mode', async () => {
  for (const [mode, format, estimate] of [['discussion', 'structured', 80], ['discussion', 'classic', 61], ['debate', 'structured', 84]]) {
    const c = dialog(); c.change('topic', 'Custom rounds');
    if (mode === 'debate') button(c.render(), '1v1 辩论').props.onClick();
    else c.change('format', format);
    c.change('rounds', 'custom');
    const input = field(c.render(), 'bt-discussion-customRounds');
    assert.equal(input.props.type, 'number'); assert.equal(input.props.max, 20); assert.equal(input.props.step, 1);
    assert.equal(input.props.min, mode === 'discussion' && format === 'structured' ? 2 : 1);
    c.change('customRounds', '20');
    assert.ok(text(c.render()).includes('预计 ' + estimate + ' 次模型发言'));
    const start = button(c.render(), mode === 'debate' ? '开始辩论' : '开始讨论');
    assert.equal(start.props.disabled, false); start.props.onClick(); await tick();
    const payload = actionRequests(c.requests)[0].payload;
    assert.equal(payload.rounds, 20); assert.equal(payload.mode, mode); assert.equal(payload.format, format);
  }
});

test('custom rounds reject empty, fractional and out-of-range values before dispatch', async () => {
  for (const mode of ['discussion', 'debate']) {
    const c = dialog(); c.change('topic', 'Bounds');
    if (mode === 'debate') button(c.render(), '1v1 辩论').props.onClick();
    c.change('rounds', 'custom');
    const invalid = ['', '0', '-1', '2.5', '21', 'Infinity', 'NaN', ...(mode === 'discussion' ? ['1'] : [])];
    for (const value of invalid) {
      c.change('customRounds', value);
      const tree = c.render(), start = button(tree, mode === 'debate' ? '开始辩论' : '开始讨论');
      assert.equal(start.props.disabled, true, value); assert.equal(field(tree, 'bt-discussion-customRounds').props['aria-invalid'], true);
      assert.doesNotMatch(text(tree), /预计 .* 次模型发言/); start.props.onClick(); await tick();
    }
    assert.equal(actionRequests(c.requests).length, 0);
    c.change('customRounds', mode === 'debate' ? '1' : '2');
    assert.equal(button(c.render(), mode === 'debate' ? '开始辩论' : '开始讨论').props.disabled, false);
  }
});

test('custom round values survive tabs and format changes without silently replacing empty drafts', () => {
  const c = dialog(); c.change('topic', 'Draft'); c.change('rounds', 'custom'); c.change('customRounds', '10');
  button(c.render(), '1v1 辩论').props.onClick();
  assert.equal(field(c.render(), 'bt-discussion-rounds').props.value, 2);
  c.change('rounds', 'custom'); c.change('customRounds', '6');
  button(c.render(), '多成员讨论').props.onClick();
  assert.equal(field(c.render(), 'bt-discussion-customRounds').props.value, '10');
  c.change('format', 'classic'); assert.equal(field(c.render(), 'bt-discussion-customRounds').props.value, '10');
  c.change('format', 'structured'); c.change('customRounds', '');
  button(c.render(), '1v1 辩论').props.onClick(); assert.equal(field(c.render(), 'bt-discussion-customRounds').props.value, '6');
  button(c.render(), '多成员讨论').props.onClick(); assert.equal(field(c.render(), 'bt-discussion-customRounds').props.value, '');
  assert.equal(button(c.render(), '开始讨论').props.disabled, true);
  c.change('rounds', 5); assert.equal(field(c.render(), 'bt-discussion-customRounds'), undefined);
  assert.equal(button(c.render(), '开始讨论').props.disabled, false);
  c.change('format', 'classic'); c.change('rounds', 1); c.change('format', 'structured');
  assert.equal(field(c.render(), 'bt-discussion-rounds').props.value, 3);
});

test('custom round fields expose localized limits and accessible validation', () => {
  const c = dialog(); c.client.setTestLocale('en'); c.change('topic', 'Custom'); c.change('rounds', 'custom'); c.change('customRounds', '21');
  const tree = c.render(), input = field(tree, 'bt-discussion-customRounds');
  assert.ok(walk(tree).some(node => node.type === 'label' && node.props.htmlFor === input.props.id && text(node) === 'Custom rounds'));
  assert.equal(input.props['aria-describedby'], 'bt-discussion-rounds-hint');
  assert.match(text(tree), /Supports 2–20 rounds/);
  assert.match(text(tree), /Rounds must be an integer from 2 to 20/);
});

test('structured requires two participants and excludes dormant perspectives from payload', async () => {
  const c = dialog(); c.change('topic', 'Topic'); field(c.render(), 'bt-perspective-mem3').props.onChange({ target: { value: 'Keep in draft' } });
  for (const name of ['Bot 2', 'Bot 3']) { const row = walk(c.render()).find(node => node.props?.className === 'bt-discussion-member' && text(node).includes(name)); walk(row).find(node => node.type === 'input').props.onChange(); }
  assert.equal(button(c.render(), '开始讨论').props.disabled, true); assert.match(text(c.render()), /结构化讨论至少需要两位成员/);
  c.change('format', 'classic'); button(c.render(), '开始讨论').props.onClick(); await tick(); assert.deepEqual(actionRequests(c.requests)[0].payload.perspectives, {});
});

test('stopping offers a fresh guarded stop check and preserves detailed failure text', async () => {
  const c = progress({ props: { discussion: record({ status: 'stopping', revision: 19, stopReason: 'user', stopPendingReason: 'Native work still busy' }) } });
  assert.match(text(c.render()), /Native work still busy/); assert.match(text(c.render()), /由用户请求/);
  button(c.render(), '检查停止状态').props.onClick(); await tick(); assert.equal(c.requests[0].payload.operation, 'stop'); assert.equal(c.requests[0].payload.expectedRevision, 19); assert.ok(c.requests[0].payload.requestId);
});

test('new conversation clears active ownership while keeping historical details available', () => {
  const c = loadClient(); const discussion = record(); const state = c.reducer({ ...c.initialState, loading: false, groups: [{ ...group, activeDiscussion: discussion }], activeGroupId: 'g1', discussions: { g1: discussion } }, { type: 'conversationState', groupId: 'g1', data: { currentConversationId: 'c2', conversationVersion: 2 } });
  assert.equal(state.groups[0].activeDiscussion, null);
  const page = loadClient({ state }); let tree = page.render(page.BotTeamPage); assert.equal(button(tree, '查看当前讨论'), undefined); button(tree, '讨论/辩论').props.onClick(); tree = page.render(page.BotTeamPage); assert.ok(walk(tree).some(node => node.type === page.DiscussionDialog));
});

test('newer group discussion snapshots advance revisions without waiting for another event', () => {
  const c = loadClient(); const previous = record({ revision: 5 }); const state = c.reducer({ ...c.initialState, groups: [group], discussions: { g1: previous } }, { type: 'sse', frame: { type: 'group.updated', group: { ...group, activeDiscussion: record({ revision: 9, status: 'pausing' }) } } });
  assert.equal(state.discussions.g1.revision, 9); assert.equal(state.groups[0].activeDiscussion.status, 'pausing');
});


test('system start events link to discussion history and provide original-message anchors', () => {
  const c = loadClient(); const opened = []; const source = { messageId: 'start-message', kind: 'discussion', author: { type: 'system' }, text: '开始讨论：History', meta: { discussionId: 'old-discussion', event: 'start', mode: 'discussion' } };
  const tree = c.render(c.MessageRow, { message: source, bots, allMessages: [], tasks: [], onOpenDiscussion: id => opened.push(id) });
  assert.equal(tree.props['data-message-id'], 'start-message'); walk(tree).find(node => node.type === 'button').props.onClick(); assert.deepEqual(opened, ['old-discussion']);
});
