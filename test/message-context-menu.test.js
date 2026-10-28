import test from 'node:test';
import assert from 'node:assert/strict';
import { loadClient, plain, walk, text } from './client-harness.js';

const client = loadClient();

const botMessage = overrides => ({
  messageId: 'm1',
  seq: 3,
  status: 'done',
  kind: 'chat',
  text: 'Hello **world**',
  author: { type: 'bot', botId: 'b1', name: 'Timi' },
  meta: {},
  ...overrides,
});

const noop = () => {};

function actionsFor(message, extra = {}) {
  return client.messageActionList({
    message,
    mine: message.author?.type === 'human',
    streaming: message.status === 'pending' || message.status === 'streaming',
    meta: message.meta || {},
    hasQuoted: false,
    onReply: noop,
    onCopy: noop,
    onCopyQuote: noop,
    onJumpToMessage: noop,
    onReview: noop,
    onRevise: noop,
    onRetry: noop,
    onExecution: noop,
    ...extra,
  });
}

const menuButtons = tree => walk(tree).filter(node => node.props?.role === 'menuitem');

test('a finished bot message offers reply, copy and review in that order', () => {
  const actions = actionsFor(botMessage());
  assert.deepEqual(plain(actions.map(action => action.key)), ['reply', 'copy', 'quote', 'review', 'execution']);
  assert.deepEqual(plain(actions.map(action => action.label)), ['回复', '复制文本', '复制为引用', '评审', '执行过程']);
  assert.deepEqual(
    plain(actions.filter(action => action.hover !== false && !action.disabled).map(action => action.key)),
    ['reply', 'copy', 'review'],
    'hover toolbar shows the same three actions',
  );
});

test('streaming messages disable reply/copy, keep them inside the menu and keep the toolbar empty', () => {
  const empty = actionsFor(botMessage({ status: 'streaming', text: '' }));
  assert.deepEqual(plain(empty.map(action => action.key)), ['reply', 'copy', 'execution']);
  assert.equal(empty[0].disabled, true);
  assert.equal(empty[1].disabled, true);
  assert.deepEqual(plain(empty.filter(action => action.hover !== false && !action.disabled)), []);

  const partial = actionsFor(botMessage({ status: 'streaming', text: 'partial answer' }));
  assert.equal(partial.find(action => action.key === 'reply').disabled, true);
  assert.equal(partial.find(action => action.key === 'copy').disabled, false);
  assert.equal(partial.find(action => action.key === 'copy').hover, false, 'toolbar stays hidden while streaming');
  assert.equal(partial.some(action => action.key === 'review'), false);
});

test('own messages skip review; quoted human replies add copy-quote and jump-to-original', () => {
  const human = botMessage({ messageId: 'm2', author: { type: 'human' }, replyTo: 'm0' });
  const actions = actionsFor(human, { hasQuoted: true });
  assert.deepEqual(plain(actions.map(action => action.key)), ['reply', 'copy', 'quote', 'jump']);
  assert.equal(actions.find(action => action.key === 'quote').hover, false);
  assert.equal(actions.find(action => action.key === 'jump').hover, false);

  const jumped = [];
  const message = botMessage({ author: { type: 'human' }, replyTo: 'm0' });
  const jump = actionsFor(message, { hasQuoted: true, onJumpToMessage: id => jumped.push(id) }).find(action => action.key === 'jump');
  jump.onSelect();
  assert.deepEqual(plain(jumped), ['m0']);
});

test('review revisions and failed replies add their workflow actions', () => {
  const review = actionsFor(botMessage({ kind: 'review', meta: { reviewOf: 'm0' } }));
  assert.deepEqual(plain(review.map(action => action.key)), ['reply', 'copy', 'quote', 'review', 'revise', 'execution']);

  const failed = actionsFor(botMessage({ status: 'error', text: 'boom' }));
  assert.deepEqual(plain(failed.map(action => action.key)), ['reply', 'copy', 'quote', 'review', 'retry', 'execution']);
  assert.equal(failed.find(action => action.key === 'retry').danger, true);
});

test('quote markdown keeps the author on the first line and quotes every line', () => {
  assert.equal(client.buildQuoteMarkdown('Timi', 'line1\nline2'), '> **Timi**：line1\n> line2');
  assert.equal(client.buildQuoteMarkdown('我', 'single'), '> **我**：single');
  assert.equal(client.buildQuoteMarkdown('Timi', 'a\r\nb\n\nc'), '> **Timi**：a\n> b\n>\n> c');
  assert.equal(client.buildQuoteMarkdown('Timi', ''), '> **Timi**：');
});

test('menu placement follows the cursor and clamps to the viewport margins', () => {
  assert.deepEqual(plain(client.placeMessageMenu(100, 100, 1000, 800, 200, 100)), { left: 100, top: 100 });
  assert.deepEqual(plain(client.placeMessageMenu(950, 780, 1000, 800, 200, 100)), { left: 792, top: 692 });
  assert.deepEqual(plain(client.placeMessageMenu(-20, 2, 1000, 800, 200, 100)), { left: 8, top: 8 });
  assert.deepEqual(plain(client.placeMessageMenu(50, 50, 120, 90, 200, 100)), { left: 8, top: 8 });
  assert.equal(client.messageMenuHeight(3, 2), 3 * 32 + 2 * 9 + 12);
});

test('context menu renders labelled actions, closes first and skips disabled items', () => {
  const calls = [];
  const message = botMessage();
  const props = {
    menu: { message, x: 20, y: 20 },
    bots: [],
    allMessages: [],
    userProfile: null,
    onClose: () => calls.push('close'),
    onReply: () => calls.push('reply'),
    onCopy: () => calls.push('copy'),
    onReview: () => calls.push('review'),
  };
  const tree = client.render(client.MessageContextMenu, props);
  const buttons = menuButtons(tree);
  assert.deepEqual(buttons.map(button => text(button)), ['回复', '复制文本', '评审']);
  assert.equal(buttons.every(button => button.props.disabled === false), true);

  buttons.find(button => text(button) === '复制文本').props.onClick({ stopPropagation: noop });
  assert.deepEqual(calls, ['close', 'copy'], 'the menu unmounts before running the action');

  const disabledCalls = [];
  const streaming = botMessage({ status: 'streaming', text: '' });
  const disabledTree = client.render(client.MessageContextMenu, {
    ...props,
    menu: { message: streaming, x: 20, y: 20 },
    onReply: () => disabledCalls.push('reply'),
  });
  const disabledButtons = menuButtons(disabledTree);
  assert.equal(disabledButtons[0].props.disabled, true);
  assert.equal(disabledButtons[0].props['aria-disabled'], 'true');
  disabledButtons[0].props.onClick({ stopPropagation: noop });
  assert.deepEqual(disabledCalls, [], 'disabled action never fires');
});

test('message rows hook up the context menu and keep the hover toolbar icon-only', () => {
  const message = botMessage();
  let received = null;
  const tree = client.render(client.MessageRow, {
    message,
    groupStart: true,
    groupEnd: true,
    bots: [],
    tasks: [],
    allMessages: [],
    chatDisplaySettings: client.DEFAULT_CHAT_DISPLAY_SETTINGS,
    onReply: noop,
    onCopy: noop,
    onCopyQuote: noop,
    onReview: noop,
    onContextMenu: (event, target) => {
      received = { event, target };
    },
  });
  const row = walk(tree).find(node => node.props?.['data-message-id'] === 'm1');
  const event = { type: 'contextmenu' };
  row.props.onContextMenu(event);
  assert.equal(received.event, event);
  assert.equal(received.target, message);

  const toolbar = walk(tree).find(node => node.props?.role === 'toolbar');
  assert.deepEqual(
    toolbar.props.children.map(child => child.props.label),
    ['回复', '复制文本', '评审'],
    'hover toolbar stays icon-only and excludes menu-only actions',
  );
});

test('the page passes the context menu hooks to the message list and styles the menu', () => {
  const active = loadClient({
    state: {
      ...client.initialState,
      loading: false,
      activeGroupId: 'g1',
      groups: [{ groupId: 'g1', title: 'Group' }],
      messagesByGroup: { g1: [botMessage()] },
    },
  });
  const list = walk(active.render(active.BotTeamPage)).find(node => node.type === active.MessageList);
  assert.equal(typeof list.props.onContextMenu, 'function');
  assert.equal(typeof list.props.onCopyQuote, 'function');
  assert.match(client.GLOBAL_CSS, /\.bt-msg-menu-item:hover/);
  assert.match(client.GLOBAL_CSS, /\.bt-msg-menu-item:disabled/);
});

test('right-clicking a message row opens the menu via the page and suppresses the native menu', () => {
  const message = botMessage();
  const local = loadClient({
    state: {
      ...client.initialState,
      loading: false,
      activeGroupId: 'g1',
      groups: [{ groupId: 'g1', title: 'Group' }],
      messagesByGroup: { g1: [message] },
    },
  });
  const first = local.render(local.BotTeamPage);
  const list = walk(first).find(node => node.type === local.MessageList);
  const event = {
    clientX: 320,
    clientY: 240,
    defaultPrevented: false,
    target: null,
    currentTarget: { contains: () => false, getBoundingClientRect: () => ({ left: 100, top: 100 }) },
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {},
  };
  list.props.onContextMenu(event, message);
  assert.equal(event.defaultPrevented, true);

  const menu = walk(local.render(local.BotTeamPage)).find(node => node.type === local.MessageContextMenu);
  assert.ok(menu, 'menu is rendered after the state update');
  assert.equal(menu.props.menu.message.messageId, 'm1');
  assert.equal(menu.props.menu.x, 320);
  assert.equal(menu.props.menu.y, 240);
  assert.equal(menu.props.menu.groupId, 'g1');
  assert.deepEqual(plain(menu.props.allMessages.map(item => item.messageId)), ['m1']);
});

test('execution is a separate menu-only action for every ordinary bot state', () => {
  const calls = [];
  for (const status of ['pending', 'streaming', 'done', 'error', 'stopped']) {
    const message = botMessage({ messageId: status, status, text: '' });
    const action = actionsFor(message, { onExecution: target => calls.push(target) }).find(item => item.key === 'execution');
    assert.equal(action.label, '执行过程');
    assert.equal(action.disabled, false);
    assert.equal(action.hover, false);
    action.onSelect();
    assert.equal(calls.at(-1), message);
  }
  for (const patch of [{ author: { type: 'human' } }, { author: { type: 'system' } }, { kind: 'approval' }, { kind: 'system' }]) {
    assert.equal(actionsFor(botMessage(patch)).some(item => item.key === 'execution'), false);
  }
});

test('shared context menu invokes execution after closing, with the live source message', () => {
  const snapshot = botMessage({ status: 'pending', text: '' });
  const live = botMessage({ status: 'streaming', text: 'latest' });
  const calls = [];
  const tree = client.render(client.MessageContextMenu, {
    menu: { message: snapshot, x: 1, y: 1 }, bots: [], allMessages: [live],
    onClose: () => calls.push('close'), onExecution: message => calls.push(message),
  });
  menuButtons(tree).find(button => text(button) === '执行过程').props.onClick({ stopPropagation: noop });
  assert.deepEqual(calls, ['close', live]);
});

test('direct and group pages open execution for the selected message without replacing the chat', () => {
  for (const kind of ['direct', 'group']) {
    const message = botMessage({ groupId: 'g/' + kind });
    const local = loadClient({ state: {
      ...client.initialState, loading: false, activeGroupId: message.groupId,
      groups: [{ groupId: message.groupId, title: kind, kind, botId: 'b1' }],
      messagesByGroup: { [message.groupId]: [message] },
    } });
    const first = local.render(local.BotTeamPage);
    const list = walk(first).find(node => node.type === local.MessageList);
    list.props.onContextMenu({ preventDefault: noop, stopPropagation: noop, clientX: 1, clientY: 2 }, message);
    const menu = walk(local.render(local.BotTeamPage)).find(node => node.type === local.MessageContextMenu);
    assert.equal(typeof menu.props.onExecution, 'function');
    menu.props.onClose();
    menu.props.onExecution(message);
    const page = local.render(local.BotTeamPage);
    const drawer = walk(page).find(node => node.type === local.ExecutionDrawer);
    assert.equal(drawer.props.target.groupId, message.groupId);
    assert.equal(drawer.props.target.message, message);
    assert.equal(walk(page).find(node => node.type === local.MessageList).props.messages, list.props.messages);
    drawer.props.onClose();
    assert.equal(walk(local.render(local.BotTeamPage)).some(node => node.type === local.ExecutionDrawer), false);
  }
});
