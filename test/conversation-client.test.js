import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { loadClient, plain, walk, text } from './client-harness.js';
import { buildGroupPdf, findPdfFont } from '../host/pdf.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const noop = () => {};
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const conversation = (ordinal, afterSeq = 0, groupId = 'g1') => ({ conversationId: groupId + '-c' + ordinal, groupId, ordinal, afterSeq, createdAt: 1700000000000 + ordinal, previousConversationId: ordinal > 1 ? groupId + '-c' + (ordinal - 1) : null });
const group = (ordinal = 1, groupId = 'g1') => ({ groupId, title: 'Team', kind: 'group', currentConversationId: groupId + '-c' + ordinal, activeConversationId: groupId + '-c' + ordinal, conversationVersion: ordinal, currentConversation: conversation(ordinal, 0, groupId), canStartConversation: true });
const metadata = (ordinal, afterSeq = 0) => ({ currentConversationId: 'g1-c' + ordinal, conversationVersion: ordinal, currentConversation: conversation(ordinal, afterSeq) });
const message = (seq, ordinal = 1, patch = {}) => ({ messageId: 'm' + seq, groupId: 'g1', conversationId: 'g1-c' + ordinal, seq, createdAt: 1700000000000 + seq, text: 'message ' + seq, status: 'done', kind: 'chat', author: { type: 'bot', botId: 'b1', name: 'Old Bot' }, ...patch });
const component = (tree, type) => walk(tree).find(node => node.type === type);
const button = (tree, label) => walk(tree).find(node => node.type === 'button' && text(node) === label);
const fixture = client => ({ ...client.initialState, loading: false, activeGroupId: 'g1', groups: [group()], capabilities: { conversations: true, expectedConversationId: true } });

function composer({ fetchAction, fetchSkills, fetchUpload, props: overrides = {}, locale = 'zh' } = {}) {
  const requests = [], events = [], cleared = [];
  const local = loadClient({ lifecycleEffects: true,
    document: { addEventListener: noop, removeEventListener: noop },
    fetch: async (url, options) => {
      if (url.startsWith('/api/bot-team.skills')) return fetchSkills ? fetchSkills() : Response.json({ skills: [] });
      if (url.startsWith('/api/bot-team.upload')) return fetchUpload ? fetchUpload(url) : Response.json({ attachment: { attachmentId: 'a1', name: 'file.txt', bytes: 1 } });
      const body = JSON.parse(options.body); requests.push(body);
      return fetchAction ? fetchAction(body) : Response.json({ ok: true, result: body.action === 'conversation.new' ? { created: true, conversation: conversation(2), ...metadata(2) } : {} });
    },
  });
  local.setTestLocale(locale);
  const props = { state: fixture(local), group: group(), members: [], bots: [], dispatch: event => events.push(event),
    conversationControlRef: { current: null }, onClearReply: () => { cleared.push(true); props.replyTarget = null; }, ...overrides };
  const node = { style: {}, scrollHeight: 44, selectionStart: 0, focus: noop, setSelectionRange(start) { this.selectionStart = start; } };
  const render = () => { const tree = local.render(local.Composer, props); const input = walk(tree).find(item => item.type === 'textarea'); input.props.ref.current = node; node.selectionStart = input.props.value.length; return tree; };
  const settle = () => { render(); local.flushEffects(); return render(); };
  const input = () => walk(render()).find(item => item.type === 'textarea');
  const type = value => { node.selectionStart = value.length; input().props.onChange({ target: { value, selectionStart: value.length } }); return settle(); };
  const key = (key = 'Enter', extra = {}) => { let prevented = false; input().props.onKeyDown({ key, shiftKey: false, preventDefault: () => { prevented = true; }, ...extra }); return prevented; };
  settle();
  return { local, props, requests, events, cleared, render, settle, input, type, key };
}

test('standalone command parsing preserves ordinary text, case, code and URLs', () => {
  const local = loadClient();
  for (const value of ['/new', '  /new\n', '\n/new\t']) assert.deepEqual(plain(local.parseBuiltinCommand(value)), { command: 'new', valid: true });
  for (const value of ['/new hello', '/new\nmore', '/new --force']) assert.deepEqual(plain(local.parseBuiltinCommand(value)), { command: 'new', valid: false });
  for (const value of ['/NEW', '/newer', 'text /new', 'https://x/new', '`/new`', '~~~\n/new\n~~~']) assert.equal(local.parseBuiltinCommand(value), null);
  assert.equal(local.commandSkillOptions([], '', 0)[0].builtin, true);
  assert.equal(local.commandSkillOptions([], 'ne', 2).length, 0);
  const choices = local.commandSkillOptions([{ name: 'new', description: 'user skill' }], 'new', 0);
  assert.equal(choices[0].builtin, true); assert.equal(choices[1].conflict, true);
});

test('exact /new executes on first Enter despite empty or failed Skills, without a Bot', async () => {
  for (const fetchSkills of [undefined, () => Promise.reject(Error('offline'))]) {
    const c = composer({ fetchSkills }); c.type('/new');
    assert.equal(c.key(), true); await tick();
    assert.equal(c.requests.length, 1); assert.equal(c.requests[0].action, 'conversation.new');
    assert.equal(c.requests[0].payload.expectedConversationId, 'g1-c1'); assert.ok(c.requests[0].payload.requestId);
    assert.equal(c.input().props.value, '');
    assert.ok(c.events.some(event => event.type === 'conversationState' && event.data.conversationVersion === 2));
    c.local.unmount();
  }
});

test('prefix completion, Tab, Shift+Enter and IME never accidentally execute', async () => {
  for (const prefix of ['/', '/ne']) {
    const c = composer(); c.type(prefix); await tick(); c.settle();
    c.key(); assert.equal(c.input().props.value, '/new'); assert.equal(c.requests.length, 0);
    c.key(); await tick(); assert.equal(c.requests[0].action, 'conversation.new'); c.local.unmount();
  }
  const c = composer(); c.type('/new');
  c.key('Tab'); assert.equal(c.input().props.value, '/new'); assert.equal(c.requests.length, 0);
  assert.equal(c.key('Enter', { shiftKey: true }), false);
  assert.equal(c.key('Enter', { nativeEvent: { isComposing: true } }), false);
  assert.equal(c.key('Enter', { isComposing: true }), false);
  assert.equal(c.key('Enter', { keyCode: 229 }), false);
  assert.equal(c.requests.length, 0); c.local.unmount();
});

test('invalid command keeps draft; ordinary content sends with expected conversation', async () => {
  const c = composer(); c.type('/new\nkeep this'); c.key(); await tick();
  assert.equal(c.requests.length, 0); assert.equal(c.input().props.value, '/new\nkeep this');
  assert.ok(c.events.some(event => event.message === '请单独发送 /new'));
  c.type('/newer'); c.key(); await tick();
  assert.equal(c.requests[0].action, 'message.post'); assert.equal(c.requests[0].payload.text, '/newer');
  assert.equal(c.requests[0].payload.expectedConversationId, 'g1-c1'); c.local.unmount();
});

test('builtin completion survives a new Skill collision and conflicting Skill insertion is rejected', async () => {
  const c = composer({ fetchSkills: () => Response.json({ skills: [{ name: 'new', description: 'custom' }] }) });
  c.type('/ne'); await tick(); const tree = c.settle();
  const options = walk(tree).filter(node => node.props?.role === 'option');
  assert.equal(options.length, 2); assert.match(text(options[0]), /新建会话/);
  options[1].props.onMouseDown({ preventDefault: noop }); assert.equal(c.input().props.value, '/ne');
  assert.ok(c.events.some(event => /Skill new/.test(event.message || ''))); assert.equal(c.requests.length, 0); c.local.unmount();
});

test('capability gates never fall back to posting literal /new', async () => {
  for (const overrides of [
    { state: { ...loadClient().initialState, capabilities: {} } },
  ]) {
    const c = composer({ props: overrides }); c.type('/new'); c.key(); await tick();
    assert.equal(c.requests.length, 0); assert.equal(c.input().props.value, '/new');
    assert.ok(c.events.some(event => event.type === 'error'));
    walk(c.render()).find(node => node.props?.className === 'bt-add-btn').props.onClick();
    const entry = walk(c.render()).find(node => node.props?.role === 'menuitem' && text(node).includes('/new'));
    assert.equal(entry.props.disabled, true); c.local.unmount();
  }
});

test('busy bootstrap remains retryable after runtime work finishes without fresh canStart metadata', async () => {
  let running = true;
  const initial = { ...group(), canStartConversation: false, conversationBlockers: [{ message: '审批尚未结束' }] };
  const c = composer({ props: { group: initial }, fetchAction: () => running
    ? Response.json({ ok: false, error: { code: 'conversation-busy', message: '审批尚未结束' } }, { status: 409 })
    : Response.json({ ok: true, result: { ...metadata(2), conversation: conversation(2) } }) });
  c.type('/new'); c.key(); await tick(); assert.equal(c.requests.length, 1); assert.equal(c.input().props.value, '/new');
  let state = { ...fixture(c.local), groups: [initial], statusByMember: { mem1: 'running' } };
  state = c.local.reducer(state, { type: 'sse', frame: { type: 'member.status', groupId: 'g1', membershipId: 'mem1', status: 'idle', ...metadata(1) } });
  assert.equal(state.refreshTick, 1); assert.equal(state.groups[0].canStartConversation, false);
  running = false; c.props.state = state; c.props.group = state.groups[0]; c.settle(); c.key(); await tick();
  assert.equal(c.requests.length, 2); assert.equal(c.input().props.value, ''); c.local.unmount();
});

test('synchronous in-flight lock deduplicates Enter, send and menu requests', async () => {
  const wait = deferred(); const c = composer({ fetchAction: () => wait.promise });
  c.type('/new'); c.key(); c.key();
  c.props.conversationControlRef.current.startConversation();
  button(c.render(), '发送中…').props.onClick();
  assert.equal(c.requests.length, 1);
  wait.resolve(Response.json({ ok: true, result: { conversation: conversation(2), ...metadata(2), created: true } }));
  await tick(); assert.equal(c.input().props.value, ''); c.local.unmount();
});

test('late new response preserves text and uploaded attachments changed during the request', async () => {
  const wait = deferred(); const c = composer({ fetchAction: () => wait.promise });
  c.type('/new'); c.key(); c.type('new draft');
  const upload = walk(c.render()).find(node => node.type === 'input' && node.props.type === 'file');
  upload.props.onChange({ target: { files: [{ name: 'file.txt', size: 1, type: 'text/plain' }], value: 'file' } }); await tick();
  wait.resolve(Response.json({ ok: true, result: { conversation: conversation(2), ...metadata(2), created: true } })); await tick();
  assert.equal(c.input().props.value, 'new draft'); assert.match(text(c.render()), /file.txt/);
  c.props.group = group(2); c.settle(); assert.equal(button(c.render(), '将草稿用于当前会话'), undefined); c.local.unmount();
});

test('late send response does not clear edits, a newly selected reply or another chat draft', async () => {
  const wait = deferred(); const c = composer({ fetchAction: () => wait.promise });
  c.type('send snapshot'); c.key(); c.type('new content');
  c.props.replyTarget = message(4); c.settle();
  wait.resolve(Response.json({ ok: true, result: {} })); await tick();
  assert.equal(c.input().props.value, 'new content'); assert.equal(c.cleared.length, 0);
  c.props.group = group(1, 'g2'); c.settle(); c.type('other chat');
  c.props.group = group(); c.settle(); assert.equal(c.input().props.value, 'new content');
  c.props.group = group(1, 'g2'); c.settle(); assert.equal(c.input().props.value, 'other chat'); c.local.unmount();
});

test('remote segment changes preserve drafts until explicit adoption and clear only reply auto mentions', async () => {
  const members = [{ membershipId: 'mem1', groupId: 'g1', botId: 'b1', enabled: true }], bots = [{ botId: 'b1', name: 'Timi' }];
  const c = composer({ props: { members, bots } }); c.type('work @Manual');
  c.props.replyTarget = message(1); c.settle(); assert.equal(c.input().props.value, '@Timi work @Manual');
  c.props.group = group(2); const tree = c.settle();
  assert.match(text(tree), /草稿已保留/); assert.equal(button(tree, '发送').props.disabled, true);
  c.key(); assert.equal(c.requests.length, 0);
  button(tree, '将草稿用于当前会话').props.onClick(); c.settle();
  assert.equal(c.input().props.value, 'work @Manual'); assert.equal(c.props.replyTarget, null);
  c.key(); await tick(); assert.equal(c.requests[0].payload.expectedConversationId, 'g1-c2'); assert.equal(c.requests[0].payload.replyTo, undefined); c.local.unmount();
});

test('an empty remote draft binds automatically; manual mention edits survive adoption', () => {
  const c = composer(); c.props.group = group(2); c.settle();
  c.type('hello'); assert.equal(button(c.render(), '将草稿用于当前会话'), undefined); c.local.unmount();
  const d = composer({ props: { members: [{ membershipId: 'mem1', groupId: 'g1', botId: 'b1' }], bots: [{ botId: 'b1', name: 'Timi' }] } });
  d.type('body'); d.props.replyTarget = message(1); d.settle(); d.type('manual body'); d.type('@Timi manual body');
  d.props.group = group(2); d.settle(); button(d.render(), '将草稿用于当前会话').props.onClick(); d.settle();
  assert.equal(d.input().props.value, '@Timi manual body'); d.local.unmount();
});

test('stale API errors merge authoritative metadata, preserve the draft and never resend', async () => {
  const c = composer({ fetchAction: () => Response.json({ ok: false, error: { code: 'stale-conversation', message: 'Changed remotely', details: metadata(2) } }, { status: 409 }) });
  c.type('keep me'); c.key(); await tick();
  assert.equal(c.requests.length, 1); assert.equal(c.input().props.value, 'keep me');
  assert.ok(c.events.some(event => event.type === 'conversationState' && event.data.currentConversationId === 'g1-c2'));
  c.local.unmount();
});

test('all metadata transports reject version rollback and merge cached history', () => {
  const local = loadClient(); let state = fixture(local);
  state = local.reducer(state, { type: 'sse', frame: { type: 'conversation.started', groupId: 'g1', conversation: conversation(3, 5), ...metadata(3, 5) } });
  for (const action of [
    { type: 'bootstrap', data: { groups: [group(1)], capabilities: state.capabilities } },
    { type: 'messages', groupId: 'g1', messages: [message(1)], data: { ...metadata(1), conversationBoundaries: [conversation(1)] } },
    { type: 'conversationState', groupId: 'g1', data: { conversation: conversation(2, 5), ...metadata(2, 5) } },
    { type: 'sse', frame: { type: 'group.updated', group: group(1) } },
  ]) {
    state = local.reducer(state, action); assert.equal(state.groups[0].currentConversationId, 'g1-c3'); assert.equal(state.groups[0].conversationVersion, 3);
  }
  assert.deepEqual(plain(state.conversationsByGroup.g1.map(item => item.ordinal)), [1, 2, 3]);
  state = local.reducer(state, { type: 'sse', frame: { type: 'hello', groupId: 'g1', ...metadata(4, 5), chatDisplaySettings: { model: 'always' } } });
  assert.equal(state.groups[0].conversationVersion, 4); assert.equal(state.chatDisplaySettings.model, 'always');
});

test('same-version conflict refreshes without switching execution until authoritative bootstrap', () => {
  const local = loadClient(); let state = fixture(local);
  const conflict = { ...metadata(1), currentConversationId: 'other' };
  state = local.reducer(state, { type: 'conversationState', groupId: 'g1', data: conflict });
  assert.equal(state.groups[0].currentConversationId, 'g1-c1'); assert.equal(state.refreshTick, 1);
  state = local.reducer(state, { type: 'conversationState', groupId: 'g1', data: conflict }); assert.equal(state.refreshTick, 1);
  state = local.reducer(state, { type: 'conversationState', groupId: 'g1', data: metadata(1) });
  assert.equal(state.groups[0].conversationStateConflict, true, 'a repeated old frame cannot resolve conflicting authority');
  state = local.reducer(state, { type: 'bootstrap', data: { groups: [{ ...group(), ...conflict }], capabilities: state.capabilities } });
  assert.equal(state.groups[0].currentConversationId, 'other');
});

test('late local response cannot rebind a draft behind a newer SSE version', async () => {
  const wait = deferred(); const c = composer({ fetchAction: () => wait.promise }); c.type('/new'); c.key(); c.type('next');
  c.props.group = group(3); c.settle();
  wait.resolve(Response.json({ ok: true, result: { ...metadata(2), conversation: conversation(2) } })); await tick(); c.settle();
  assert.equal(c.input().props.value, 'next'); assert.equal(button(c.render(), '将草稿用于当前会话'), undefined);
  c.key(); assert.equal(c.requests[1].payload.expectedConversationId, 'g1-c3'); c.local.unmount();
});

test('virtual dividers deduplicate, retain empty segments, break grouping and never consume message slots', () => {
  const local = loadClient(); const records = [conversation(3, 1), conversation(1), conversation(2, 1), conversation(2, 1), conversation(4, 2)];
  const rows = local.conversationTimeline([message(1), message(2, 3)], records);
  assert.deepEqual(plain(rows.map(row => row.conversation ? 'c' + row.conversation.ordinal : row.message.messageId)), ['c1', 'm1', 'c2', 'c3', 'm2', 'c4']);
  const tree = local.MessageList({ messages: [message(1), message(2, 3)], conversations: records, group: group(4) });
  assert.equal(tree.filter(node => node.type === local.ConversationDivider).length, 4);
  const bubbles = tree.filter(node => node.type === local.MessageRow); assert.equal(bubbles.length, 2);
  assert.ok(bubbles.every(node => node.props.groupStart && node.props.groupEnd && node.props.historical));
});

test('history offers explicit quotes and log access while retry/review/revise are disabled', () => {
  const local = loadClient(); const invoked = [];
  for (const item of [message(1), message(2, 1, { status: 'error' }), message(3, 1, { kind: 'review', meta: { reviewOf: 'm1' } })]) {
    const actions = local.messageActionList({ message: item, historical: true, onReply: value => invoked.push(value), onReview: noop, onRetry: noop, onRevise: noop, onExecution: noop });
    const reply = actions.find(action => action.key === 'reply'); assert.equal(reply.label, '引用到当前会话'); reply.onSelect();
    assert.ok(actions.filter(action => ['review', 'retry', 'revise'].includes(action.key)).every(action => action.disabled));
    assert.equal(actions.find(action => action.key === 'execution').disabled, false);
  }
  assert.equal(invoked.length, 3);
  assert.equal(local.currentMemberSession({ sessionId: 'old', sessionConversationId: 'g1-c1', currentSessionId: null }, group(2)), null);
});

test('conversation log details page through fixed sessions and retain deleted Bot names', async () => {
  const urls = [], opened = []; const local = loadClient({ lifecycleEffects: true, fetch: async url => {
    urls.push(url); const page = urls.length;
    return Response.json({ ok: true, conversation: conversation(1), sessionBindings: [{ bindingId: 's' + page, sessionId: 'old-' + page, botNameSnapshot: page === 1 ? 'Deleted Bot' : 'Old Name' }], hasMore: page === 1, nextCursor: page === 1 ? 'cursor-1' : null });
  } });
  const props = { target: { groupId: 'g1', conversation: conversation(1) }, onClose: noop, onOpenSession: binding => opened.push(binding) };
  local.render(local.ConversationLogsDialog, props); local.flushEffects(); await tick();
  let tree = local.render(local.ConversationLogsDialog, props); assert.match(text(tree), /Deleted Bot/);
  button(tree, '加载更多日志').props.onClick(); await tick(); tree = local.render(local.ConversationLogsDialog, props);
  assert.match(urls[1], /cursor=cursor-1/); assert.match(urls[1], /conversationId=g1-c1/);
  button(tree, 'Deleted Bot · old-1').props.onClick(); assert.equal(opened[0].sessionId, 'old-1'); local.unmount();
});

test('Markdown and HTML exports order all segments, escape names and disclose empty segments', () => {
  const local = loadClient(); const conversations = [conversation(3, 1), conversation(1), conversation(2, 1)];
  const props = { group: { ...group(3), title: '<Team>' }, members: [], bots: [], messages: [message(1)], conversations, truncated: true };
  const markdown = local.buildGroupMarkdown(props), html = local.buildGroupHtml(props);
  for (const value of [markdown, html]) {
    assert.ok(value.indexOf('会话 1') < value.indexOf('message 1')); assert.ok(value.indexOf('message 1') < value.indexOf('会话 2'));
    assert.ok(value.indexOf('会话 2') < value.indexOf('会话 3')); assert.match(value, /本会话没有消息/); assert.match(value, /50 页/);
  }
  assert.match(html, /&lt;Team&gt;/);
  local.setTestLocale('en'); const english = local.buildGroupMarkdown(props); assert.match(english, /Conversation 1/); assert.match(english, /Incomplete export/); assert.match(english, /entire chat/);
});

test('bounded export pagination declares truncation and independently includes empty conversations', async () => {
  const local = loadClient(); const requests = [];
  const result = await local.collectAllMessages('g1', { includeConversations: true,
    fetchMessages: async (id, before) => { requests.push(before); const seq = before ? before - 1 : 100; return { messages: [message(seq)], hasMore: true }; },
    fetchConversations: async (id, options) => options.beforeOrdinal ? { conversations: [conversation(1)], hasMore: false } : { conversations: [conversation(2, 100), conversation(3, 100)], hasMore: true },
  });
  assert.equal(requests.length, 50); assert.equal(result.length, 50); assert.equal(result.truncated, true); assert.deepEqual(plain(result.conversations.map(item => item.ordinal)), [1, 2, 3]);
  const complete = await local.collectAllMessages('g1', { fetchMessages: async () => ({ messages: [], hasMore: false, conversationBoundaries: [conversation(1)] }) });
  assert.equal(complete.truncated, false); assert.equal(complete.conversations.length, 1);
});

test('menu new preserves ordinary draft and attachments and clears only the selected old reply', async () => {
  const c = composer({ props: { members: [{ membershipId: 'mem1', groupId: 'g1', botId: 'b1' }], bots: [{ botId: 'b1', name: 'Timi' }] } });
  c.type('keep @Manual'); c.props.replyTarget = message(1); c.settle();
  walk(c.render()).find(node => node.type === 'input' && node.props.type === 'file').props.onChange({ target: { files: [{ name: 'file.txt', size: 1 }], value: 'file' } }); await tick();
  await c.props.conversationControlRef.current.startConversation('menu'); c.props.group = group(2); c.settle();
  assert.equal(c.input().props.value, 'keep @Manual'); assert.match(text(c.render()), /file.txt/); assert.equal(c.props.replyTarget, null);
  c.local.unmount();
});

test('late response from another chat cannot consume its replacement draft', async () => {
  const wait = deferred(); const c = composer({ fetchAction: () => wait.promise }); c.type('/new'); c.key();
  c.props.group = group(1, 'g2'); c.settle(); c.type('other chat draft');
  wait.resolve(Response.json({ ok: true, result: { conversation: conversation(2), ...metadata(2) } })); await tick();
  assert.equal(c.input().props.value, 'other chat draft'); assert.equal(c.cleared.length, 0);
  assert.equal(c.events.find(event => event.type === 'conversationState').groupId, 'g1'); c.local.unmount();
});

test('deleted upload items stay removed when their response arrives after new conversation', async () => {
  const upload = deferred(); const c = composer({ fetchUpload: () => upload.promise });
  walk(c.render()).find(node => node.type === 'input' && node.props.type === 'file').props.onChange({ target: { files: [{ name: 'file.txt', size: 1 }], value: 'file' } });
  walk(c.render()).find(node => node.props?.className === 'bt-draft-file-remove').props.onClick();
  await c.props.conversationControlRef.current.startConversation('menu'); c.props.group = group(2); c.settle();
  upload.resolve(Response.json({ ok: true, attachment: { attachmentId: 'removed', name: 'file.txt', bytes: 1 } })); await tick();
  assert.doesNotMatch(text(c.render()), /file.txt/); c.local.unmount();
});

test('top-level stale details are merged and conflicting versions disable both send and new', async () => {
  const c = composer({ fetchAction: () => Response.json({ ok: false, error: { code: 'stale-conversation', message: 'Changed' }, details: metadata(2) }, { status: 409 }) });
  c.type('draft'); c.key(); await tick(); assert.ok(c.events.some(event => event.type === 'conversationState' && event.data.conversationVersion === 2)); c.local.unmount();
  const d = composer({ props: { group: { ...group(), conversationStateConflict: true } } }); d.type('safe'); d.key();
  assert.equal(button(d.render(), '发送').props.disabled, true); await d.props.conversationControlRef.current.startConversation(); assert.equal(d.requests.length, 0); d.local.unmount();
});

test('review and discussion forms opened before a remote new cannot start old work', () => {
  const requests = [], local = loadClient({ fetch: (url, options) => { requests.push(options); return Response.json({ ok: true }); } });
  const base = { group: group(), members: [{ membershipId: 'mem1', botId: 'b1' }], bots: [{ botId: 'b1', name: 'Timi' }], target: message(1), onClose: noop, onSaved: noop };
  for (const [view, label] of [[local.ReviewDialog, '发起评审'], [local.DiscussionDialog, '开始讨论']]) {
    local.remount(view, base); const changed = local.render(view, { ...base, group: group(2) });
    assert.equal(button(changed, label).props.disabled, true); button(changed, label).props.onClick();
  }
  assert.equal(requests.length, 0);
});

test('header new and plus new share the same controller in direct and group chats', () => {
  for (const kind of ['direct', 'group']) {
    const base = loadClient(), state = fixture(base); state.groups[0] = { ...group(2), kind, botId: 'b1' };
    const local = loadClient({ state }); let page = local.render(local.BotTeamPage); const control = component(page, local.Composer).props.conversationControlRef;
    const starts = []; control.current = { startConversation: source => starts.push(source) };
    walk(page).find(node => node.props?.title === (kind === 'direct' ? '更多单聊操作' : '更多群操作')).props.onClick();
    page = local.render(local.BotTeamPage); button(page, '新建会话').props.onClick(); assert.deepEqual(starts, ['menu']);
    assert.ok(button(page, '本会话尚无日志')); assert.ok(button(page, '上一会话日志'));
    assert.equal(component(page, local.Composer).props.key, undefined, 'segment changes must not remount the composer');
  }
});

test('log navigation uses currentSessionId and an opened old log stays fixed across newer metadata', () => {
  const base = loadClient(), state = fixture(base); state.groups = [group(2)];
  state.bots = [{ botId: 'b1', name: 'Timi' }]; state.members = [{ groupId: 'g1', membershipId: 'mem1', botId: 'b1', sessionId: 'old', sessionConversationId: 'g1-c2', currentSessionId: 'current' }];
  const local = loadClient({ state }); let page = local.render(local.BotTeamPage);
  component(page, local.MembersPanel).props.onViewSession(state.members[0]); page = local.render(local.BotTeamPage);
  assert.equal(component(page, local.SessionHistoryPage).props.target.sessionId, 'current');
  component(page, local.GroupList).props.dispatch({ type: 'sse', frame: { type: 'conversation.started', groupId: 'g1', ...metadata(3) } });
  page = local.render(local.BotTeamPage); assert.equal(component(page, local.SessionHistoryPage).props.target.sessionId, 'current');
});

test('new conversation first reply refreshes the member binding and current logs while an old window stays fixed', () => {
  const base = loadClient(), state = fixture(base);
  state.bots = [{ botId: 'b1', name: 'Timi' }]; state.members = [{ groupId: 'g1', membershipId: 'mem1', botId: 'b1', sessionId: 'old', sessionConversationId: 'g1-c1', currentSessionId: 'old' }];
  const local = loadClient({ state }); let page = local.render(local.BotTeamPage);
  component(page, local.MembersPanel).props.onViewSession(state.members[0]); page = local.render(local.BotTeamPage);
  const dispatch = component(page, local.GroupList).props.dispatch;
  dispatch({ type: 'sse', frame: { type: 'conversation.started', groupId: 'g1', ...metadata(2) } });
  const pendingMember = { ...state.members[0], currentSessionId: null };
  dispatch({ type: 'bootstrap', data: { groups: [group(2)], bots: state.bots, members: [pendingMember], capabilities: state.capabilities } });
  page = local.render(local.BotTeamPage);
  assert.equal(local.currentMemberSession(component(page, local.MembersPanel).props.members[0], group(2)), null);
  const firstReply = message(2, 2, { status: 'pending', author: { type: 'bot', botId: 'b1', membershipId: 'mem1', name: 'Timi' }, meta: { execution: { sessionId: 'new-physical-session' } } });
  dispatch({ type: 'sse', frame: { type: 'message.added', groupId: 'g1', conversationId: 'g1-c2', message: firstReply } });
  page = local.render(local.BotTeamPage); let snapshot = component(page, local.GroupList).props.state;
  assert.equal(snapshot.refreshTick, 1, 'the first current-generation execution requests bootstrap before completion');
  dispatch({ type: 'sse', frame: { type: 'execution.updated', groupId: 'g1', conversationId: 'g1-c2', messageId: 'm2', sessionId: 'new-physical-session' } });
  page = local.render(local.BotTeamPage); assert.equal(component(page, local.GroupList).props.state.refreshTick, 1, 'one refresh per generation and physical session');
  const currentMember = { ...pendingMember, sessionId: 'new-physical-session', sessionConversationId: 'g1-c2', currentSessionId: 'new-physical-session' };
  dispatch({ type: 'bootstrap', data: { groups: [group(2)], bots: state.bots, members: [currentMember], capabilities: state.capabilities } });
  page = local.render(local.BotTeamPage); assert.equal(component(page, local.SessionHistoryPage).props.target.sessionId, 'old');
  component(page, local.SessionHistoryPage).props.onBack(); page = local.render(local.BotTeamPage);
  component(page, local.MembersPanel).props.onViewSession(component(page, local.MembersPanel).props.members[0]); page = local.render(local.BotTeamPage);
  assert.equal(component(page, local.SessionHistoryPage).props.target.sessionId, 'new-physical-session');
  snapshot = component(page, local.GroupList).props.state;
  const historical = local.reducer(snapshot, { type: 'sse', frame: { type: 'execution.updated', groupId: 'g1', conversationId: 'g1-c1', sessionId: 'old' } });
  assert.equal(historical.refreshTick, snapshot.refreshTick, 'old execution cannot refresh or replace the current binding');
});

class ConversationEvents {
  static sources = [];
  constructor() { this.listeners = new Map(); ConversationEvents.sources.push(this); }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  removeEventListener(type) { this.listeners.delete(type); }
  emit(type, data) { this.listeners.get(type)?.({ data: JSON.stringify(data) }); }
  close() {}
}

test('remote new preserves history scroll; local success scrolls to its divider without unread messages', () => {
  const base = loadClient(), state = fixture(base); state.messagesByGroup.g1 = [message(1)]; state.conversationsByGroup.g1 = [conversation(1)];
  const local = loadClient({ state, lifecycleEffects: true, EventSource: ConversationEvents,
    window: { addEventListener: noop, removeEventListener: noop }, setTimeout: () => 1, clearTimeout: noop,
    fetch: () => new Promise(() => {}),
  });
  const navigated = [];
  const node = { scrollTop: 0, scrollHeight: 1000, clientHeight: 200, querySelectorAll: () => [{ getAttribute: () => 'g1-c3', scrollIntoView: options => navigated.push(options) }] };
  let page = local.render(local.BotTeamPage); let timeline = walk(page).find(item => item.props?.className === 'bt-timeline'); timeline.props.ref.current = node;
  local.flushEffects(); node.scrollTop = 123; timeline.props.onScroll();
  ConversationEvents.sources.at(-1).emit('conversation.started', { groupId: 'g1', conversation: conversation(2, 1), ...metadata(2, 1) });
  page = local.render(local.BotTeamPage); local.flushEffects(); assert.equal(node.scrollTop, 123); assert.equal(navigated.length, 0);
  component(page, local.Composer).props.onConversationStarted({ conversation: conversation(3, 1), ...metadata(3, 1) }, 'g1');
  page = local.render(local.BotTeamPage); local.flushEffects(); assert.equal(navigated.length, 1);
  const list = component(page, local.MessageList); assert.equal(list.props.messages.length, 1); assert.equal(list.props.conversations.length, 3); assert.equal(list.props.unreadFromSeq, null); local.unmount();
});

test('English command menu and remote-draft guidance are localized without changing draft text', () => {
  const c = composer({ locale: 'en' }); c.type('消息内容'); c.props.group = group(2); c.settle();
  assert.ok(button(c.render(), 'Use draft in current conversation')); assert.equal(c.input().props.value, '消息内容');
  walk(c.render()).find(node => node.props?.className === 'bt-add-btn').props.onClick();
  assert.match(text(c.render()), /New conversation/); assert.match(text(c.render()), /Start a new conversation for every group member/); c.local.unmount();
});

function pdfText(pdf) {
  const source = pdf.toString('latin1'), mappings = new Map();
  for (const block of source.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const match of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) mappings.set(match[1], String.fromCharCode(...match[2].match(/.{4}/g).map(code => parseInt(code, 16))));
  const result = [];
  for (const match of source.matchAll(/stream\n([\s\S]*?)\nendstream/g)) {
    let payload = Buffer.from(match[1], 'latin1'); try { payload = inflateSync(payload); } catch {}
    for (const text of payload.toString('latin1').matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) result.push(text[1].match(/.{4}/g).map(code => mappings.get(code) || '').join(''));
  }
  return result.join(' ').replace(/\s+/g, ' ');
}

test('PDF export renders ordered conversation headers, empty segments and truncation notice', async t => {
  if (!await findPdfFont().catch(() => null)) return t.skip('No CJK font installed');
  const buffer = await buildGroupPdf({ group: group(3), messages: [message(1)], conversations: [conversation(1), conversation(2, 1), conversation(3, 1)], lang: 'en', truncated: true });
  const content = pdfText(buffer);
  assert.match(content, /Conversation 1/); assert.match(content, /Conversation 2/); assert.match(content, /Conversation 3/);
  assert.ok(content.indexOf('Conversation 1') < content.indexOf('message 1')); assert.ok(content.indexOf('message 1') < content.indexOf('Conversation 2'));
  assert.match(content, /No messages in this conversation/); assert.match(content, /Incomplete export/);
});
