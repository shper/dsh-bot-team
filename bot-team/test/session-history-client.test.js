import assert from 'node:assert/strict';
import test from 'node:test';
import { loadClient, plain, walk, text } from './client-harness.js';

const event = (seq, type, data = {}) => ({ seq, time: 1000 + seq, type, data });
const target = sessionId => ({ mode: 'session', groupId: 'g1', sessionId, botName: 'Timi' });
const page = (sessionId, overrides = {}) => ({ ok: true, groupId: 'g1', sessionId, availability: 'available', events: [], nextSeq: -1, hasMore: false, ...overrides });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

test('full history uses the authenticated Bot Team reader and loads every turn', async () => {
  const requests = [];
  const local = loadClient({ fetch: async (url, options) => {
    requests.push({ url, options });
    return Response.json(page('parentless-bot', requests.length === 1
      ? { events: [event(1, 'user/message', { id: 'first', content: [{ type: 'text', text: 'First turn' }] })], nextSeq: 3, hasMore: true }
      : { events: [event(5, 'user/message', { id: 'second', content: [{ type: 'text', text: 'Second turn' }] })], nextSeq: 8 }));
  } });
  const controller = local.createExecutionController({ groupId: 'g1', sessionId: 'parentless-bot', onChange() {} });
  try {
    await controller.refresh();
    assert.deepEqual(requests.map(r => r.url), [
      '/api/bot-team.session-history?groupId=g1&sessionId=parentless-bot&afterSeq=-1&limit=100',
      '/api/bot-team.session-history?groupId=g1&sessionId=parentless-bot&afterSeq=3&limit=100',
    ]);
    assert.ok(requests.every(r => r.options.method === 'GET' && !r.options.signal.aborted));
    assert.deepEqual(plain(controller.getState().events.map(e => e.seq)), [1, 5]);
    assert.equal(controller.getState().scope, 'session');
    assert.equal(controller.getState().loadError, '');
  } finally { controller.dispose(); }
});

test('history catches updates from other turns of the same session and ignores other sessions', async () => {
  const cursors = [];
  const local = loadClient();
  const controller = local.createExecutionController({ groupId: 'g1', sessionId: 'saved', onChange() {}, fetchPage: async (groupId, sessionId, afterSeq) => {
    cursors.push(afterSeq);
    return page(sessionId, { nextSeq: cursors.length * 5 });
  } });
  try {
    await controller.refresh();
    controller.notify({ type: 'execution.updated', groupId: 'g1', messageId: 'new-turn', sessionId: 'saved', seq: 8 });
    await tick();
    controller.notify({ type: 'execution.updated', groupId: 'g1', messageId: 'new-turn', sessionId: 'other', seq: 9 });
    controller.notify({ type: 'execution.updated', groupId: 'other', sessionId: 'saved', seq: 9 });
    controller.notify({ type: 'execution.updated', groupId: 'g1', sessionId: 'saved', seq: 8 });
    await tick();
    assert.deepEqual(cursors, [-1, 5]);
    controller.notify({ type: 'hello', groupId: 'g1' });
    await tick();
    assert.deepEqual(cursors, [-1, 5, 10]);
  } finally { controller.dispose(); }
});

test('history rejects a response for another session before exposing its events', async () => {
  const local = loadClient();
  const controller = local.createExecutionController({ groupId: 'g1', sessionId: 'requested', onChange() {}, fetchPage: async () => page('other', { events: [event(1, 'user/message')] }) });
  try {
    await controller.refresh();
    assert.equal(controller.getState().events.length, 0);
    assert.match(controller.getState().loadError, /会话历史与所选会话不匹配/);
  } finally { controller.dispose(); }
});

test('switching from a message to its full session starts at the beginning and aborts on close', async () => {
  const requests = [];
  const local = loadClient({ lifecycleEffects: true, fetch(url, options) {
    const request = { url, signal: options.signal, ...deferred() }; requests.push(request); return request.promise;
  } });
  local.render(local.useMessageExecution, { groupId: 'g1', message: { messageId: 'm2' } });
  local.flushEffects(); await tick();
  const history = local.render(local.useMessageExecution, target('saved'));
  assert.equal(history.state.scope, 'session');
  assert.equal(history.state.events.length, 0);
  local.flushEffects(); await tick();
  assert.equal(requests[0].signal.aborted, true);
  assert.match(requests[1].url, /session-history.*afterSeq=-1/);
  requests[0].resolve(Response.json({ groupId: 'g1', messageId: 'm2', events: [event(90, 'user/message')], nextSeq: 90 }));
  requests[1].resolve(Response.json(page('saved', { events: [event(1, 'user/message')], nextSeq: 1 })));
  await tick();
  const loaded = local.render(local.useMessageExecution, target('saved'));
  assert.deepEqual(plain(loaded.state.events.map(e => e.seq)), [1]);
  const refresh = loaded.controller.current.refresh(); await tick();
  local.render(local.useMessageExecution, null); local.flushEffects();
  assert.equal(requests[2].signal.aborted, true);
  requests[2].resolve(Response.json(page('saved', { events: [event(2, 'turn/end')], nextSeq: 2 })));
  await refresh;
  assert.equal(local.render(local.useMessageExecution, null).state.events.length, 0);
  local.unmount();
});

function chatFixture(extra = {}) {
  const message = { messageId: 'm2', groupId: 'g1', seq: 2, status: 'done', text: 'Saved reply', author: { type: 'bot', botId: 'b1', name: 'Timi' } };
  return { ...loadClient().initialState, loading: false, activeGroupId: 'g1',
    groups: [{ groupId: 'g1', title: 'Team', kind: 'group' }], bots: [{ botId: 'b1', name: 'Timi' }],
    members: [{ membershipId: 'mem1', groupId: 'g1', botId: 'b1', sessionId: 'current-session', enabled: true }],
    messagesByGroup: { g1: [message] }, ...extra,
  };
}
const component = (tree, type) => walk(tree).find(node => node.type === type);
const chatView = tree => walk(tree).find(node => node.props?.['data-view'] === 'chat');

test('member view opens a distinct full page and keeps the original chat mounted for return', () => {
  const local = loadClient({ state: chatFixture() });
  let tree = local.render(local.BotTeamPage);
  const member = component(tree, local.MembersPanel);
  member.props.onViewSession(member.props.members[0]);
  tree = local.render(local.BotTeamPage);
  const history = component(tree, local.SessionHistoryPage);
  assert.equal(history.props.target.sessionId, 'current-session');
  assert.equal(history.props.target.botName, 'Timi');
  assert.equal(history.props.target.groupTitle, 'Team');
  assert.equal(component(tree, local.ExecutionDrawer), undefined, 'full history is not an execution drawer mode');
  assert.equal(chatView(tree).props.hidden, true);
  assert.equal(component(tree, local.Composer).props.active, false);
  assert.equal(component(tree, local.GroupList).props.state.activeGroupId, 'g1');
  history.props.onBack();
  tree = local.render(local.BotTeamPage);
  assert.equal(component(tree, local.SessionHistoryPage), undefined);
  assert.equal(chatView(tree).props.hidden, false);
  assert.equal(component(tree, local.Composer).props.active, true);
});

test('returning from full history restores the same execution target and permits opening it again', () => {
  const fixture = chatFixture();
  const local = loadClient({ state: fixture });
  let tree = local.render(local.BotTeamPage);
  component(tree, local.MessageList).props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 10, clientY: 10 }, fixture.messagesByGroup.g1[0]);
  tree = local.render(local.BotTeamPage);
  const menu = component(tree, local.MessageContextMenu);
  menu.props.onExecution(fixture.messagesByGroup.g1[0]); menu.props.onClose();
  tree = local.render(local.BotTeamPage);
  const original = component(tree, local.ExecutionDrawer);
  assert.equal(original.props.target.message.messageId, 'm2');
  for (let attempt = 0; attempt < 2; attempt++) {
    component(tree, local.ExecutionDrawer).props.onOpenSession('historical-session');
    tree = local.render(local.BotTeamPage);
    const history = component(tree, local.SessionHistoryPage);
    assert.equal(history.props.target.sessionId, 'historical-session', 'the historical ID must not rotate to the member current session');
    assert.equal(history.props.returnToExecution, true);
    assert.equal(component(tree, local.ExecutionDrawer), undefined);
    history.props.onBack();
    tree = local.render(local.BotTeamPage);
    assert.equal(component(tree, local.ExecutionDrawer).props.target, original.props.target);
    assert.equal(component(tree, local.SessionHistoryPage), undefined);
  }
});

test('sidebar history uses the owning group without replacing the original chat selection', () => {
  const foreign = { membershipId: 'mem2', groupId: 'direct-2', botId: 'b2', sessionId: 'other-session', enabled: true };
  const fixture = chatFixture();
  fixture.groups.push({ groupId: 'direct-2', title: 'Helper', kind: 'direct', botId: 'b2' });
  fixture.bots.push({ botId: 'b2', name: 'Helper' }); fixture.members.push(foreign);
  const local = loadClient({ state: fixture });
  let tree = local.render(local.BotTeamPage);
  component(tree, local.GroupList).props.onViewSession(foreign);
  tree = local.render(local.BotTeamPage);
  const history = component(tree, local.SessionHistoryPage);
  assert.equal(component(tree, local.GroupList).props.state.activeGroupId, 'g1');
  assert.equal(history.props.target.groupId, 'direct-2');
  assert.equal(history.props.target.sessionId, 'other-session');
  assert.equal(history.props.target.botName, 'Helper');
  history.props.onBack();
  tree = local.render(local.BotTeamPage);
  assert.equal(component(tree, local.GroupList).props.state.activeGroupId, 'g1');
  assert.equal(chatView(tree).props.hidden, false);
});

for (const [locale, title, back, missing] of [
  ['zh', '完整会话', '返回聊天', '完整会话接口尚未加载'],
  ['en', 'Full session', 'Back to chat', 'The full session endpoint is not loaded'],
]) {
  test(`full history has a page heading and persistent return in ${locale}, including errors`, async () => {
    const local = loadClient({ fetch: async () => new Response('not found', { status: 404 }) });
    local.setTestLocale(locale);
    let returned = 0; let refreshed = 0;
    const props = { target: target('saved'), onBack() { returned++; }, onRefresh() { refreshed++; } };
    for (const status of [{ loading: true }, { loading: false, availability: 'available' }, { loading: false, availability: 'unavailable', reason: 'session-log-missing' }, { loading: false, loadError: 'failed request' }]) {
      const state = { ...local.emptyExecutionState('g1', undefined, 'saved'), ...status };
      const tree = local.render(local.SessionHistoryPage, { ...props, state });
      assert.equal(tree.props['data-view'], 'full-session');
      assert.equal(walk(tree).some(node => node.props?.role === 'dialog'), false);
      assert.ok(walk(tree).some(node => node.type === 'h1' && text(node) === title));
      assert.ok(text(tree).includes('Timi'));
      const returnButton = walk(tree).find(node => node.type === 'button' && text(node).endsWith(back));
      assert.ok(returnButton && !returnButton.props.disabled);
      returnButton.props.onClick();
      if (state.loadError) {
        const retry = walk(tree).find(node => node.type === 'button' && /^(重试|Retry)$/.test(text(node)));
        retry.props.onClick();
      }
    }
    assert.equal(returned, 4); assert.equal(refreshed, 1);
    const controller = local.createExecutionController({ groupId: 'g1', sessionId: 'saved', onChange() {} });
    try { await controller.refresh(); assert.ok(controller.getState().loadError.startsWith(missing)); }
    finally { controller.dispose(); }
  });
}
