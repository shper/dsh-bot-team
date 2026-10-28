import test from 'node:test';
import assert from 'node:assert/strict';
import { loadClient, plain, walk, text } from './client-harness.js';

const noop = () => {};
const tick = () => new Promise(resolve => setImmediate(resolve));
const group = { groupId: 'g1', kind: 'group', title: 'Team', currentConversationId: 'c1' };
const bots = [1, 2].map(id => ({ botId: 'b' + id, name: 'Bot ' + id }));
const members = bots.map(bot => ({ membershipId: 'mem-' + bot.botId, botId: bot.botId, groupId: 'g1', enabled: true }));
const source = { messageId: 'source', groupId: 'g1', conversationId: 'c1', seq: 1, kind: 'chat', status: 'done',
  author: { type: 'bot', botId: 'b1' }, text: '  原文\n保留格式 **正文**  ', replyTo: 'parent-message' };
const button = (tree, label) => walk(tree).find(node => node.type === 'button' && text(node) === label);
const field = (tree, id) => walk(tree).find(node => node.props?.id === 'bt-discussion-' + id);
const menuEvent = () => ({ preventDefault: noop, stopPropagation: noop, clientX: 20, clientY: 30 });
const modes = [['discussion', '发起讨论', '开始讨论', 3], ['debate', '发起辩论', '开始辩论', 2]];

function openMenu({ message = source, groupPatch = {}, discussion = null, members: roster = members } = {}) {
  const page = loadClient();
  const client = loadClient({ state: { ...page.initialState, loading: false, activeGroupId: 'g1',
    groups: [{ ...group, ...groupPatch }], bots, members: roster, messagesByGroup: { g1: [message] }, discussions: { g1: discussion } } });
  const render = () => client.render(client.BotTeamPage);
  walk(render()).find(node => node.type === client.MessageList).props.onContextMenu(menuEvent(), message);
  const menu = walk(render()).find(node => node.type === client.MessageContextMenu);
  const menuClient = loadClient();
  const tree = menuClient.render(menuClient.MessageContextMenu, menu.props);
  return { client, render, menu, tree };
}

function renderDialog(props) {
  const requests = [];
  const client = loadClient({ fetch: async (_url, init) => {
    const request = JSON.parse(init.body);
    if (request.action !== 'ui.report') requests.push(request);
    return Response.json({ ok: true, result: { discussionId: 'new-discussion', groupId: 'g1', conversationId: 'c1', status: 'running' } });
  } });
  const render = () => client.render(client.DiscussionDialog, props);
  return { client, render, requests };
}

for (const [mode, menuLabel, startLabel, rounds] of modes) {
  test(menuLabel + ' opens the selected mode and submits the chosen message only after confirmation', async () => {
    for (const author of [{ type: 'human' }, { type: 'bot', botId: 'b1' }]) {
      const page = openMenu({ message: { ...source, author } });
      const action = button(page.tree, menuLabel);
      assert.ok(action);
      assert.equal(action.props.disabled, false);
      action.props.onClick({ stopPropagation: noop });
      const tree = page.render();
      assert.equal(walk(tree).some(node => node.type === page.client.MessageContextMenu), false);
      const dialog = walk(tree).find(node => node.type === page.client.DiscussionDialog);
      assert.ok(dialog);
      const setup = renderDialog(dialog.props);
      const config = setup.render();
      assert.equal(walk(config).find(node => node.props?.role === 'tab' && node.props['aria-selected']).props.id, 'bt-mode-' + mode);
      assert.equal(field(config, 'topic').props.value, source.text.trim());
      assert.equal(field(config, 'rounds').props.value, rounds);
      assert.equal(walk(config).find(node => node.type === setup.client.DiscussionReferences).props.value, source.messageId);
      assert.equal(setup.requests.length, 0);
      assert.equal(button(config, startLabel).props.disabled, false, 'two members suffice without a judge');
      button(config, startLabel).props.onClick();
      await tick();
      assert.equal(setup.requests.length, 1);
      const request = setup.requests[0];
      assert.equal(request.action, 'discussion.start');
      assert.equal(request.payload.mode, mode);
      assert.equal(request.payload.rounds, rounds);
      assert.equal(request.payload.topic, source.text.trim());
      assert.equal(request.payload.expectedConversationId, 'c1');
      assert.deepEqual(request.payload.contextMessageIds, [source.messageId]);
    }
  });
}

test('discussion actions are menu-only and never appear for single chats or system messages', () => {
  const client = loadClient();
  const actions = client.messageActionList({ message: source, meta: {}, onStartDiscussion: noop });
  const added = actions.filter(action => ['discussion', 'debate'].includes(action.key));
  assert.deepEqual(plain(added.map(action => action.label)), ['发起讨论', '发起辩论']);
  assert.ok(added.every(action => action.hover === false));
  for (const message of [{ ...source, kind: 'approval' }, { ...source, author: { type: 'system' } }, { ...source, kind: 'system' }]) {
    assert.equal(client.messageActionList({ message, onStartDiscussion: noop }).some(action => ['discussion', 'debate'].includes(action.key)), false);
  }
  const direct = openMenu({ groupPatch: { kind: 'direct', botId: 'b1' } });
  for (const [, label] of modes) assert.equal(button(direct.tree, label), undefined);
});

test('unsettled and empty messages cannot start a discussion or debate', () => {
  for (const message of [{ ...source, status: 'pending' }, { ...source, status: 'streaming' }, { ...source, text: ' \n ' }]) {
    const page = openMenu({ message });
    for (const [mode, label] of modes) {
      const action = button(page.tree, label);
      assert.equal(action.props.disabled, true);
      action.props.onClick({ stopPropagation: noop });
      page.menu.props.onStartDiscussion(message, mode);
      assert.equal(walk(page.render()).some(node => node.type === page.client.DiscussionDialog), false);
    }
  }
});

test('all active current discussion states disable new starts; completed and historical records allow them', () => {
  const record = { discussionId: 'd1', groupId: 'g1', conversationId: 'c1' };
  const cases = ['running', 'pausing', 'paused', 'finalizing', 'stopping'].map(status => [{ ...record, status }, true]);
  cases.push([{ ...record, status: 'done' }, false], [{ ...record, status: 'stopped' }, false], [{ ...record, status: 'running', conversationId: 'old' }, false]);
  for (const [discussion, disabled] of cases) {
    const page = openMenu({ discussion });
    for (const [mode, label] of modes) {
      assert.equal(button(page.tree, label).props.disabled, disabled, discussion.status);
      if (disabled) {
        button(page.tree, label).props.onClick({ stopPropagation: noop });
        page.menu.props.onStartDiscussion(source, mode);
        assert.equal(walk(page.render()).some(node => node.type === page.client.DiscussionDialog), false);
      }
    }
  }
});

test('menu resolves the live message and closes before passing the selected mode', () => {
  for (const [mode, label] of modes) {
    const client = loadClient(), calls = [];
    const snapshot = { ...source, status: 'streaming', text: 'partial' };
    const tree = client.render(client.MessageContextMenu, { menu: { message: snapshot, x: 0, y: 0 }, group, allMessages: [source],
      onClose: () => calls.push('close'), onStartDiscussion: (message, mode) => calls.push([message, mode]) });
    button(tree, label).props.onClick({ stopPropagation: noop });
    assert.deepEqual(calls, ['close', [source, mode]]);
  }
});

test('long historical messages seed a bounded topic and retain the full source in the current conversation', async () => {
  const message = { ...source, conversationId: 'old', text: '资料'.repeat(1500) };
  const page = openMenu({ message });
  button(page.tree, '发起辩论').props.onClick({ stopPropagation: noop });
  const dialog = walk(page.render()).find(node => node.type === page.client.DiscussionDialog);
  const setup = renderDialog(dialog.props);
  assert.equal(field(setup.render(), 'topic').props.value, message.text.slice(0, 2000));
  assert.equal(dialog.props.messages[0].text, message.text);
  field(setup.render(), 'topic').props.onChange({ target: { value: '编辑后的议题' } });
  button(setup.render(), '多成员讨论').props.onClick();
  assert.equal(field(setup.render(), 'rounds').props.value, 3);
  button(setup.render(), '1v1 辩论').props.onClick();
  assert.equal(field(setup.render(), 'rounds').props.value, 2);
  assert.equal(field(setup.render(), 'topic').props.value, '编辑后的议题');
  button(setup.render(), '开始辩论').props.onClick();
  await tick();
  assert.equal(setup.requests[0].payload.expectedConversationId, 'c1');
  assert.deepEqual(setup.requests[0].payload.contextMessageIds, [source.messageId]);
  assert.equal(setup.requests[0].payload.topic, '编辑后的议题');
});

test('header setup stays blank and insufficient members use the existing form validation', () => {
  const page = openMenu();
  walk(page.render()).find(node => node.props?.title === '发起讨论或辩论').props.onClick();
  const dialog = walk(page.render()).find(node => node.type === page.client.DiscussionDialog);
  const setup = renderDialog(dialog.props), config = setup.render();
  assert.equal(field(config, 'topic').props.value, '');
  assert.equal(field(config, 'rounds').props.value, 3);
  assert.equal(walk(config).find(node => node.type === setup.client.DiscussionReferences).props.value, '');
  for (const roster of [[members[0]], [members[0], { ...members[1], enabled: false }], [members[0], { ...members[1], botId: 'missing' }]]) {
    const page = openMenu({ members: roster });
    button(page.tree, '发起辩论').props.onClick({ stopPropagation: noop });
    const dialog = walk(page.render()).find(node => node.type === page.client.DiscussionDialog);
    const setup = renderDialog(dialog.props);
    assert.equal(button(setup.render(), '开始辩论').props.disabled, true);
  }
});

test('new menu labels and hints follow the English UI', () => {
  const client = loadClient();
  client.setTestLocale('en');
  const props = { menu: { message: source, x: 0, y: 0 }, group, allMessages: [source], onStartDiscussion: noop };
  const tree = client.render(client.MessageContextMenu, props);
  assert.ok(button(tree, 'New discussion'));
  assert.equal(button(tree, 'New debate').props.title, 'Start a debate with this message as a reference');
  const blocked = client.render(client.MessageContextMenu, { ...props, hasActiveDiscussion: true });
  assert.equal(button(blocked, 'New discussion').props.title, 'This group already has an active discussion or debate');
});
