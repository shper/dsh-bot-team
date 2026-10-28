import test from 'node:test';
import assert from 'node:assert/strict';
import { loadClient, plain, walk, text } from './client-harness.js';

const noop = () => {};
const tick = () => new Promise(resolve => setImmediate(resolve));
const messageOf = (patch = {}) => ({
  messageId: 'm1', groupId: 'g1', seq: 1, status: 'done', kind: 'chat', text: 'Saved message',
  author: { type: 'human', name: 'Me' }, ...patch,
});
const component = (tree, type) => walk(tree).find(node => node.type === type);
const ids = messages => plain(messages.map(message => message.messageId));
function chatState(kind = 'group', messages = [messageOf()]) {
  return { ...loadClient().initialState, loading: false, activeGroupId: 'g1',
    groups: [{ groupId: 'g1', title: 'Chat', kind, botId: 'b1' }],
    messagesByGroup: { g1: messages },
  };
}
function openMenu(client, message) {
  const list = component(client.render(client.BotTeamPage), client.MessageList);
  list.props.onContextMenu({ preventDefault: noop, stopPropagation: noop, clientX: 10, clientY: 20 }, message);
  return component(client.render(client.BotTeamPage), client.MessageContextMenu);
}
class Events {
  static sources = [];
  constructor() { this.listeners = new Map(); Events.sources.push(this); }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  removeEventListener(type) { this.listeners.delete(type); }
  emit(type, frame) { this.listeners.get(type)?.({ data: JSON.stringify(frame) }); }
  close() { this.closed = true; }
}

test('delete is the final dangerous menu-only action for human and bot messages', () => {
  const client = loadClient();
  for (const author of [{ type: 'human' }, { type: 'bot', botId: 'b1' }]) {
    for (const status of ['done', 'error', 'stopped', 'pending', 'streaming']) {
      const message = messageOf({ author, status, text: '' });
      const calls = [];
      const actions = client.messageActionList({ message, mine: author.type === 'human',
        streaming: ['pending', 'streaming'].includes(status), onDelete: target => calls.push(target) });
      const action = actions.at(-1);
      assert.equal(action.key, 'delete');
      assert.equal(action.label, '删除消息');
      assert.equal(action.hover, false);
      assert.equal(action.danger, true);
      assert.equal(action.disabled, ['pending', 'streaming'].includes(status));
      if (!action.disabled) { action.onSelect(); assert.deepEqual(calls, [message]); }
    }
  }
  for (const kind of ['review', 'revision', 'discussion', 'task']) {
    const message = messageOf({ kind, author: { type: 'bot', botId: 'b1' } });
    assert.equal(client.messageActionList({ message, onDelete: noop }).at(-1).key, 'delete');
  }
  for (const patch of [{ kind: 'approval' }, { kind: 'system' }, { author: { type: 'system' } }]) {
    assert.equal(client.messageActionList({ message: messageOf(patch), onDelete: noop }).some(action => action.key === 'delete'), false);
  }
});

test('delete menu item closes before acting on the latest snapshot and supports English', () => {
  const client = loadClient();
  client.setTestLocale('en');
  const live = messageOf({ text: 'Latest message' });
  const calls = [];
  const props = { menu: { message: messageOf({ status: 'streaming' }), x: 10, y: 10 }, allMessages: [live],
    onClose: () => calls.push('close'), onDelete: message => calls.push(message) };
  const tree = client.render(client.MessageContextMenu, props);
  const button = walk(tree).filter(node => node.props?.role === 'menuitem').at(-1);
  assert.equal(text(button), 'Delete message');
  assert.match(button.props.className, /bt-msg-menu-danger/);
  assert.equal(button.props.disabled, false);
  assert.ok(walk(tree).some(node => node.props?.role === 'separator'));
  button.props.onClick({ stopPropagation: noop });
  assert.deepEqual(calls, ['close', live]);
  const streaming = client.render(client.MessageContextMenu, { ...props, allMessages: [messageOf({ status: 'pending' })] });
  const disabled = walk(streaming).filter(node => node.props?.role === 'menuitem').at(-1);
  assert.equal(disabled.props.disabled, true);
  assert.match(disabled.props.title, /Stop the reply/);
  disabled.props.onClick({ stopPropagation: noop });
  assert.equal(calls.length, 2);
});

test('direct and group chats delete only the selected human or bot message after confirmation', async () => {
  for (const kind of ['direct', 'group']) {
    for (const author of [{ type: 'human' }, { type: 'bot', botId: 'b1' }]) {
      const message = messageOf({ author });
      const keep = messageOf({ messageId: 'm2', seq: 2 });
      const requests = [], confirmations = [];
      const client = loadClient({ state: chatState(kind, [message, keep]),
        window: { confirm: prompt => { confirmations.push(prompt); return true; } },
        fetch: async (url, options) => {
          requests.push({ url, body: JSON.parse(options.body) });
          return Response.json({ ok: true, groupId: 'g1', messageId: 'm1', deleted: true });
        },
      });
      const menu = openMenu(client, message);
      assert.equal(typeof menu.props.onDelete, 'function');
      await menu.props.onDelete(message);
      const page = client.render(client.BotTeamPage);
      assert.deepEqual(ids(component(page, client.MessageList).props.messages), ['m2']);
      assert.equal(component(page, client.MessageContextMenu), undefined);
      assert.match(text(page), /已删除消息/);
      assert.deepEqual(confirmations, ['删除这条消息？删除后无法恢复。']);
      assert.deepEqual(requests, [{ url: '/api/bot-team.action', body: { action: 'message.delete', payload: { groupId: 'g1', messageId: 'm1' } } }]);
      assert.equal(component(page, client.GroupList).props.state.refreshTick, 1, 'refresh the authoritative preview and totals');
    }
  }
});

test('cancelled confirmation and streaming replies do not send a delete request', async () => {
  const prompts = [];
  const client = loadClient({ state: chatState(), window: { confirm: prompt => { prompts.push(prompt); return false; } } });
  client.setTestLocale('en');
  const menu = openMenu(client, messageOf());
  await menu.props.onDelete(messageOf());
  await menu.props.onDelete(messageOf({ status: 'streaming' }));
  assert.deepEqual(prompts, ['Delete this message? This cannot be undone.']);
  assert.deepEqual(ids(component(client.render(client.BotTeamPage), client.MessageList).props.messages), ['m1']);
});

test('delete waits for persistence, prevents duplicate requests and retains messages on failure', async () => {
  let respond;
  let requests = 0;
  let confirmations = 0;
  const client = loadClient({ state: chatState(), window: { confirm: () => { confirmations++; return true; } },
    fetch: () => { requests++; return new Promise(resolve => { respond = resolve; }); },
  });
  const remove = openMenu(client, messageOf()).props.onDelete;
  const pending = remove(messageOf());
  await remove(messageOf());
  assert.equal(requests, 1);
  assert.equal(confirmations, 1);
  assert.deepEqual(ids(component(client.render(client.BotTeamPage), client.MessageList).props.messages), ['m1']);
  respond(Response.json({ ok: false, error: { message: 'Storage unavailable' } }, { status: 500 }));
  await pending;
  let page = client.render(client.BotTeamPage);
  assert.deepEqual(ids(component(page, client.MessageList).props.messages), ['m1']);
  assert.match(text(page), /Storage unavailable/);
  assert.doesNotMatch(text(page), /已删除消息/);
  const retry = openMenu(client, messageOf()).props.onDelete(messageOf());
  respond(Response.json({ ok: true, groupId: 'g1', messageId: 'm1', deleted: true }));
  await retry;
  page = client.render(client.BotTeamPage);
  assert.deepEqual(ids(component(page, client.GroupList).props.state.messagesByGroup.g1), []);
  assert.match(text(page), /还没有消息/);
  assert.equal(requests, 2);
});

test('SSE deletion updates the correct cached chat and stale GETs or updates cannot restore it', () => {
  const client = loadClient();
  const removed = messageOf();
  const keep = messageOf({ messageId: 'm2', seq: 2 });
  const other = messageOf({ groupId: 'g2', messageId: 'm3' });
  let state = { ...chatState('group', [removed, keep]), activeGroupId: 'g2',
    messagesByGroup: { g1: [removed, keep], g2: [other] }, dialog: { kind: 'review', target: removed } };
  const frame = { type: 'message.deleted', groupId: 'g1', messageId: 'm1' };
  state = client.reducer(state, { type: 'sse', frame });
  assert.deepEqual(ids(state.messagesByGroup.g1), ['m2']);
  assert.deepEqual(ids(state.messagesByGroup.g2), ['m3']);
  assert.equal(state.dialog, null);
  assert.equal(client.reducer(state, { type: 'sse', frame }), state, 'duplicate SSE and HTTP completion are idempotent');
  state = client.reducer(state, { type: 'selectGroup', groupId: 'g1' });
  state = client.reducer(state, { type: 'messages', groupId: 'g1', messages: [removed, keep], hasMore: true });
  state = client.reducer(state, { type: 'prependMessages', groupId: 'g1', messages: [removed] });
  state = client.reducer(state, { type: 'sse', frame: { type: 'message.added', message: removed } });
  state = client.reducer(state, { type: 'sse', frame: { type: 'message.updated', message: removed } });
  state = client.reducer(state, { type: 'sse', frame: { type: 'message.delta', messageId: 'm1', chunk: 'late' } });
  assert.deepEqual(ids(state.messagesByGroup.g1), ['m2']);
});

test('deleting the last loaded message reloads any older history without changing other chats', () => {
  const client = loadClient();
  const state = { ...chatState(), hasMoreByGroup: { g1: true } };
  const action = { type: 'messageDeleted', groupId: 'g1', messageId: 'm1' };
  const next = client.reducer(state, action);
  assert.deepEqual(ids(next.messagesByGroup.g1), []);
  assert.equal(next.messagesTick, 1);
  assert.equal(client.reducer({ ...state, activeGroupId: 'g2' }, action).messagesTick, 0);
  assert.equal(client.reducer({ ...state, hasMoreByGroup: { g1: false } }, action).messagesTick, 0);
});

test('SSE subscribes to deletion and disconnects cleanly', () => {
  const client = loadClient({ EventSource: Events, lifecycleEffects: true });
  let state = chatState();
  client.render(() => client.useSse('g1', action => { state = client.reducer(state, action); }));
  client.flushEffects();
  const source = Events.sources.at(-1);
  source.emit('message.deleted', { groupId: 'g1', messageId: 'm1' });
  assert.deepEqual(ids(state.messagesByGroup.g1), []);
  source.emit('hello', {});
  assert.equal(state.messagesTick, 1, 'reconnect reloads removals missed while disconnected');
  client.unmount();
  assert.equal(source.closed, true);
  assert.equal(source.listeners.size, 0);
});

for (const missedEvent of [false, true]) {
  test('remote deletion clears reply/menu/execution targets ' + (missedEvent ? 'after reconnecting with a missed event' : 'from a live event'), async () => {
    const message = messageOf({ author: { type: 'bot', botId: 'b1' } });
    const state = chatState('group', [message]);
    let serverMessages = [message];
    const client = loadClient({ state, EventSource: Events, lifecycleEffects: true,
      window: { addEventListener: noop, removeEventListener: noop },
      setTimeout: () => 1, clearTimeout: noop,
      fetch: async url => {
        if (url.includes('bootstrap')) return Response.json({ ok: true, groups: state.groups });
        if (url.includes('message-execution')) return Response.json({ ok: true, groupId: 'g1', messageId: 'm1', events: [], nextSeq: -1, hasMore: false });
        if (url.includes('messages?')) return Response.json({ ok: true, messages: serverMessages, hasMore: false });
        throw new Error('Unexpected URL: ' + url);
      },
    });
    try {
      client.render(client.BotTeamPage); client.flushEffects(); await tick();
      const menu = openMenu(client, message);
      menu.props.onReply(message);
      menu.props.onExecution(message);
      let page = client.render(client.BotTeamPage); client.flushEffects(); await tick();
      assert.equal(component(page, client.Composer).props.replyTarget.messageId, 'm1');
      assert.ok(component(page, client.ExecutionDrawer));
      serverMessages = [];
      Events.sources.at(-1).emit(missedEvent ? 'hello' : 'message.deleted', missedEvent ? {} : { groupId: 'g1', messageId: 'm1' });
      client.render(client.BotTeamPage); client.flushEffects(); await tick();
      client.render(client.BotTeamPage); client.flushEffects(); await tick();
      page = client.render(client.BotTeamPage);
      assert.equal(component(page, client.Composer).props.replyTarget, null);
      assert.equal(component(page, client.MessageContextMenu), undefined);
      assert.equal(component(page, client.ExecutionDrawer), undefined);
      assert.deepEqual(ids(component(page, client.GroupList).props.state.messagesByGroup.g1), []);
      assert.match(text(page), /还没有消息/);
    } finally { client.unmount(); }
  });
}

test('history reload distinguishes deletion from an older page and preserves messages arriving during the request', () => {
  const client = loadClient();
  const older = messageOf({ messageId: 'older', seq: 1 });
  const removed = messageOf({ messageId: 'removed', seq: 3 });
  const kept = messageOf({ messageId: 'kept', seq: 2 });
  const arrived = messageOf({ messageId: 'arrived', seq: 4 });
  const state = chatState('group', [older, kept, removed, arrived]);
  const next = client.reducer(state, { type: 'messages', groupId: 'g1', messages: [kept], hasMore: true, knownMessages: [older, kept, removed] });
  assert.deepEqual(ids(next.messagesByGroup.g1), ['kept', 'arrived']);
  assert.equal(next.deletedMessageIdsByGroup.g1.removed, true);
  assert.equal(next.deletedMessageIdsByGroup.g1.older, undefined);
  assert.equal(next.deletedMessageIdsByGroup.g1.arrived, undefined);
  const paged = client.reducer(next, { type: 'prependMessages', groupId: 'g1', messages: [older, removed] });
  assert.deepEqual(ids(paged.messagesByGroup.g1), ['older', 'kept', 'arrived']);
});
