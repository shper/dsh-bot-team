import test from 'node:test';
import assert from 'node:assert/strict';
import { loadClient, plain, walk, text } from './client-harness.js';

const client = loadClient();
const noop = () => {};
const bot = { botId: 'bot-1', name: 'Researcher', provider: 'deepseek', model: 'deepseek-chat' };
const team = { groupId: 'team-1', kind: 'group', title: 'Research', memberIds: ['member-team'], folderId: 'folder-1', order: 0 };
const direct = { groupId: 'direct-1', kind: 'direct', botId: bot.botId, title: bot.name, memberIds: ['member-direct'], order: 0 };
const newBot = { ...bot, botId: 'bot-new', name: 'Writer' };
const newDirect = { ...direct, groupId: 'direct-new', botId: newBot.botId, title: newBot.name };
const message = { messageId: 'message-1', groupId: team.groupId, seq: 1, kind: 'chat', text: 'Keep this conversation', author: { type: 'human', name: 'User' }, status: 'done' };
const discussion = { discussionId: 'discussion-1', groupId: team.groupId, status: 'running' };

function stateWith(overrides = {}) {
  return {
    ...client.initialState,
    loading: false,
    bots: [bot],
    groups: [{ ...team, activeDiscussion: discussion }, direct],
    folders: [{ folderId: 'folder-1', title: 'Work', order: 0 }],
    members: [
      { membershipId: 'member-team', groupId: team.groupId, botId: bot.botId, running: true },
      { membershipId: 'member-direct', groupId: direct.groupId, botId: bot.botId },
    ],
    activeGroupId: team.groupId,
    messagesByGroup: { [team.groupId]: [message] },
    hasMoreByGroup: { [team.groupId]: true },
    statusByMember: { 'member-team': 'running' },
    discussions: { [team.groupId]: discussion },
    chatDisplaySettings: { ...client.DEFAULT_CHAT_DISPLAY_SETTINGS, model: 'hidden' },
    sectionsCollapsed: { direct: true, 'folder:folder-1': true },
    sidebarCollapsed: false,
    rightPanelCollapsed: false,
    config: { schemaVersion: 6 },
    ...overrides,
  };
}

function bootstrapData(state, overrides = {}) {
  return {
    bots: state.bots, groups: state.groups, folders: state.folders, members: state.members,
    config: state.config, chatDisplaySettings: state.chatDisplaySettings,
    ...overrides,
  };
}

function actionButton(tree, action) {
  const matches = walk(tree).filter(node => node.type === 'button' && node.props?.['data-action'] === action);
  assert.equal(matches.length, 1, `one real ${action} button`);
  assert.notEqual(matches[0].props.disabled, true, `${action} is available`);
  assert.equal(typeof matches[0].props.onClick, 'function', `${action} has a click handler`);
  return matches[0];
}

function component(tree, type) {
  const node = walk(tree).find(candidate => candidate.type === type);
  assert.ok(node, `${type.name} is rendered`);
  return node;
}

function pageFixture(overrides = {}) {
  const requests = [];
  const fetch = async (...args) => {
    requests.push(args);
    return { json: async () => ({ ok: true, result: {} }) };
  };
  const page = loadClient({ state: stateWith(overrides), fetch });
  // Child components get their own hook storage. Page mount effects are outside
  // these navigation tests; guide effects run separately below.
  const surface = loadClient({ fetch, lifecycleEffects: true });
  const render = () => page.render(page.BotTeamPage, {});
  const state = tree => component(tree, page.GroupList).props.state;
  const welcome = tree => surface.remount(surface.WelcomeScreen, component(tree, page.WelcomeScreen).props);
  const guide = tree => surface.remount(surface.GettingStartedDialog, component(tree, page.GettingStartedDialog).props);
  return { page, surface, requests, render, state, welcome, guide };
}

test('returning users still open the first conversation and retain an existing selection', () => {
  assert.equal(client.initialState.homeSelected, false);
  const data = bootstrapData(stateWith());
  const loaded = client.reducer(client.initialState, { type: 'bootstrap', data });
  assert.equal(loaded.activeGroupId, team.groupId);
  assert.equal(loaded.homeSelected, false);
  const selected = client.reducer(loaded, { type: 'selectGroup', groupId: direct.groupId });
  const refreshed = client.reducer(selected, { type: 'bootstrap', data });
  assert.equal(refreshed.activeGroupId, direct.groupId);
  assert.equal(refreshed.homeSelected, false);
  const removed = client.reducer(refreshed, { type: 'bootstrap', data: { ...data, groups: [team] } });
  assert.equal(removed.activeGroupId, team.groupId, 'a removed conversation retains the existing fallback');
});

test('home closes dialogs and pending navigation without losing cached conversations or preferences', () => {
  const before = stateWith({ dialog: { kind: 'settings' }, pendingDirectBotId: newBot.botId, sidebarCollapsed: true, rightPanelCollapsed: true });
  const snapshot = plain(before);
  const home = client.reducer(before, { type: 'showWelcome' });
  assert.equal(home.homeSelected, true);
  assert.equal(home.activeGroupId, null);
  assert.equal(home.dialog, null);
  assert.equal(home.pendingDirectBotId, null);
  for (const key of ['bots', 'groups', 'folders', 'members', 'messagesByGroup', 'hasMoreByGroup', 'statusByMember', 'discussions', 'chatDisplaySettings', 'sectionsCollapsed', 'sidebarCollapsed', 'rightPanelCollapsed']) {
    assert.deepEqual(plain(home[key]), snapshot[key], `${key} survives home navigation`);
  }
  assert.deepEqual(plain(before), snapshot, 'the previous state is untouched');
  const resumed = client.reducer(home, { type: 'selectGroup', groupId: team.groupId });
  assert.equal(resumed.homeSelected, false);
  assert.equal(resumed.activeGroupId, team.groupId);
  assert.deepEqual(plain(resumed.messagesByGroup[team.groupId]), [message]);
  assert.deepEqual(plain(resumed.discussions[team.groupId]), discussion);
  assert.equal(resumed.hasMoreByGroup[team.groupId], true);
});

test('explicit home selection survives bootstrap refreshes, reordered conversations, and an empty response', () => {
  const before = stateWith();
  let home = client.reducer(before, { type: 'showWelcome' });
  for (const groups of [before.groups, [direct, team], [], [newDirect, ...before.groups]]) {
    home = client.reducer(home, { type: 'bootstrap', data: bootstrapData(before, { groups }) });
    assert.equal(home.homeSelected, true);
    assert.equal(home.activeGroupId, null, 'background refresh must not reopen a conversation');
    assert.deepEqual(plain(home.messagesByGroup[team.groupId]), [message]);
  }
  const beforeInitialLoad = client.reducer(client.initialState, { type: 'showWelcome' });
  const loaded = client.reducer(beforeInitialLoad, { type: 'bootstrap', data: bootstrapData(before) });
  assert.equal(loaded.homeSelected, true, 'choosing home before the initial response also wins');
  assert.equal(loaded.activeGroupId, null);
});

test('creating a Bot leaves home and selects its direct chat after a delayed bootstrap response', () => {
  const before = stateWith();
  const home = client.reducer(before, { type: 'showWelcome' });
  const pending = client.reducer(home, { type: 'pendingDirect', botId: newBot.botId });
  assert.equal(pending.homeSelected, false);
  assert.equal(pending.pendingDirectBotId, newBot.botId);
  const stale = client.reducer(pending, { type: 'bootstrap', data: bootstrapData(before) });
  assert.equal(stale.pendingDirectBotId, newBot.botId, 'an older response cannot discard the pending Bot');
  const data = bootstrapData(before, { bots: [bot, newBot], groups: [...before.groups, newDirect] });
  const arrived = client.reducer(stale, { type: 'bootstrap', data });
  assert.equal(arrived.activeGroupId, newDirect.groupId);
  assert.equal(arrived.pendingDirectBotId, null);
  assert.equal(arrived.homeSelected, false);
  const precedence = client.reducer({ ...home, pendingDirectBotId: newBot.botId }, { type: 'bootstrap', data });
  assert.equal(precedence.activeGroupId, newDirect.groupId, 'a successfully resolved direct-chat request has precedence');
  assert.equal(precedence.homeSelected, false);
});

test('manual home or conversation selection wins over an in-flight direct-chat refresh', () => {
  const before = stateWith();
  const pending = client.reducer(before, { type: 'pendingDirect', botId: newBot.botId });
  const data = bootstrapData(before, { bots: [bot, newBot], groups: [newDirect, ...before.groups] });
  for (const action of [{ type: 'showWelcome' }, { type: 'selectGroup', groupId: direct.groupId }]) {
    const choice = client.reducer(pending, action);
    assert.equal(choice.pendingDirectBotId, null);
    const refreshed = client.reducer(choice, { type: 'bootstrap', data });
    assert.equal(refreshed.activeGroupId, action.type === 'showWelcome' ? null : direct.groupId);
    assert.equal(refreshed.homeSelected, action.type === 'showWelcome');
  }
  const home = client.reducer(pending, { type: 'showWelcome' });
  const cancelled = client.reducer(home, { type: 'pendingDirect', botId: null });
  assert.equal(cancelled.homeSelected, true, 'late request cleanup does not leave home');
});

test('messages fetched before going home remain available when the conversation is reopened', () => {
  const home = client.reducer(stateWith(), { type: 'showWelcome' });
  const latest = { ...message, messageId: 'message-2', seq: 2, text: 'A delayed response' };
  const delivered = client.reducer(home, { type: 'messages', groupId: team.groupId, messages: [message, latest], hasMore: true });
  assert.equal(delivered.activeGroupId, null);
  assert.equal(delivered.homeSelected, true);
  const resumed = client.reducer(delivered, { type: 'selectGroup', groupId: team.groupId });
  assert.deepEqual(plain(resumed.messagesByGroup[team.groupId]), [message, latest]);
  assert.equal(resumed.hasMoreByGroup[team.groupId], true);
});

test('the sidebar always offers an accessible home button, including the empty and collapsed states', () => {
  for (const locale of ['zh', 'en']) {
    for (const sidebarCollapsed of [false, true]) {
      for (const populated of [false, true]) {
        const local = loadClient();
        local.setTestLocale(locale);
        let state = stateWith({ sidebarCollapsed, ...(populated ? {} : { bots: [], groups: [], members: [], activeGroupId: null }) });
        const tree = local.render(local.GroupList, { state, dispatch: action => { state = local.reducer(state, action); } });
        const home = actionButton(tree, 'show-welcome');
        const label = local.uiT('开始使用');
        assert.equal(home.props['aria-label'] || text(home), label);
        if (sidebarCollapsed) assert.equal(text(home).includes(label), false, 'the collapsed control has an accessible name without visible label text');
        else assert.ok(text(home).includes(label));
        home.props.onClick();
        assert.equal(state.homeSelected, true);
        assert.equal(state.activeGroupId, null);
      }
    }
  }
});

test('welcome creation and quick-start buttons call only their assigned actions', () => {
  for (const hasBots of [false, true]) {
    const calls = [];
    const tree = client.remount(client.WelcomeScreen, {
      hasBots, onCreateBot: () => calls.push('bot'), onCreateGroup: () => calls.push('group'),
      onGuide: () => calls.push('guide'), onOpenSidebar: () => calls.push('sidebar'),
    });
    assert.deepEqual(calls, [], 'rendering the welcome screen does not create anything');
    const headings = walk(tree).filter(node => node.type === 'h2').map(text);
    assert.ok(headings.includes(hasBots ? '创建 Bot' : '创建第一个 Bot'));
    assert.equal(headings.includes(hasBots ? '创建第一个 Bot' : '创建 Bot'), false);
    assert.equal(text(actionButton(tree, 'create-bot')), '创建 Bot');
    for (const [action, expected] of [['create-bot', 'bot'], ['create-group', 'group'], ['quick-start', 'guide']]) {
      calls.length = 0;
      actionButton(tree, action).props.onClick();
      assert.deepEqual(calls, [expected]);
    }
    calls.length = 0;
    const navigation = walk(tree).find(node => node.type === 'button' && node.props['aria-label'] === '打开导航');
    assert.ok(navigation, 'mobile navigation is an accessible button');
    navigation.props.onClick();
    assert.deepEqual(calls, ['sidebar']);
  }
});

test('the guide uses the shared Modal and routes real creation buttons without making API requests', async () => {
  for (const hasBots of [false, true]) {
    const requests = [];
    const calls = [];
    const local = loadClient({ fetch: async (...args) => { requests.push(args); return { json: async () => ({ ok: true, result: {} }) }; }, lifecycleEffects: true });
    const guide = local.render(local.GettingStartedDialog, {
      hasBots, onClose: () => calls.push('close'), onCreateBot: () => calls.push('bot'), onCreateGroup: () => calls.push('group'),
    });
    local.flushEffects();
    await new Promise(resolve => setImmediate(resolve));
    const modal = component(guide, local.Modal);
    assert.ok(modal.props.title);
    assert.deepEqual(calls, [], 'viewing the guide does not invoke creation callbacks');
    assert.deepEqual(requests, [], 'mounting and reading the guide is local');
    for (const [action, expected] of [['create-bot', 'bot'], ['create-group', 'group']]) {
      calls.length = 0;
      actionButton(guide, action).props.onClick();
      assert.deepEqual(calls, [expected]);
    }
    calls.length = 0;
    modal.props.onClose();
    assert.deepEqual(calls, ['close']);
    assert.deepEqual(requests, [], 'guide navigation and closing do not call the API');
    local.unmount();
  }
});

test('welcome and the complete guide translate visible and accessible copy into English', () => {
  for (const hasBots of [false, true]) {
    const local = loadClient();
    const props = { hasBots, onClose: noop, onCreateBot: noop, onCreateGroup: noop, onGuide: noop, onOpenSidebar: noop };
    local.setTestLocale('zh');
    const zhGuide = local.render(local.GettingStartedDialog, props);
    assert.match(text(zhGuide), /[\p{Script=Han}]/u, 'the Chinese guide contains translated guidance');
    local.setTestLocale('en');
    const welcome = local.remount(local.WelcomeScreen, props);
    const guide = local.remount(local.GettingStartedDialog, props);
    const modal = component(guide, local.Modal);
    const expandedGuide = local.remount(local.Modal, modal.props);
    for (const tree of [welcome, expandedGuide]) {
      const copy = walk(tree).flatMap(node => [text(node), ...['title', 'subtitle', 'aria-label', 'aria-description', 'placeholder', 'alt'].map(key => node.props?.[key]).filter(value => typeof value === 'string')]).join('\n');
      assert.doesNotMatch(copy, /[\p{Script=Han}]/u, 'English UI must not leak untranslated Chinese copy');
    }
    assert.match(text(actionButton(welcome, 'create-bot')), /Bot/);
    assert.equal(walk(expandedGuide).find(node => node.props?.role === 'dialog').props['aria-modal'], 'true');
    assert.ok(walk(expandedGuide).some(node => node.type === 'button' && node.props['aria-label'] === 'Close'));
  }
});

test('pages without an active conversation render welcome with the right Bot library removed', () => {
  for (const overrides of [
    { bots: [], groups: [], members: [], activeGroupId: null },
    { groups: [], members: [], activeGroupId: null },
    { homeSelected: true, activeGroupId: null },
    { homeSelected: true, activeGroupId: null, rightPanelCollapsed: true },
    { activeGroupId: 'removed-group' },
  ]) {
    const fixture = pageFixture(overrides);
    const tree = fixture.render();
    const welcome = component(tree, fixture.page.WelcomeScreen);
    assert.equal(welcome.props.hasBots, fixture.state(tree).bots.length > 0);
    assert.equal(walk(tree).some(node => node.type === fixture.page.DirectPanel || node.type === fixture.page.MembersPanel || node.props?.id === 'bt-right-panel'), false);
    assert.equal(walk(tree).some(node => node.type === fixture.page.Composer), false);
  }
});

test('active conversations keep their existing direct or group right panel and collapse preference', () => {
  for (const activeGroup of [team, direct]) {
    for (const rightPanelCollapsed of [false, true]) {
      const fixture = pageFixture({ activeGroupId: activeGroup.groupId, rightPanelCollapsed });
      const tree = fixture.render();
      assert.equal(walk(tree).some(node => node.type === fixture.page.WelcomeScreen), false);
      assert.equal(component(tree, fixture.page.Composer).props.group.groupId, activeGroup.groupId);
      const expected = activeGroup.kind === 'direct' ? fixture.page.DirectPanel : fixture.page.MembersPanel;
      const other = activeGroup.kind === 'direct' ? fixture.page.MembersPanel : fixture.page.DirectPanel;
      assert.equal(walk(tree).some(node => node.type === expected), !rightPanelCollapsed);
      assert.equal(walk(tree).some(node => node.type === other), false);
    }
  }
});

test('home page buttons open the existing creation forms and close the guide using local navigation', () => {
  for (const source of ['welcome', 'guide']) {
    for (const action of ['create-bot', 'create-group']) {
      const fixture = pageFixture({ homeSelected: true, activeGroupId: null });
      let tree = fixture.render();
      let surface = fixture.welcome(tree);
      if (source === 'guide') {
        actionButton(surface, 'quick-start').props.onClick();
        tree = fixture.render();
        surface = fixture.guide(tree);
        fixture.surface.flushEffects();
        assert.deepEqual(fixture.requests, [], 'opening the guide never creates or fetches data');
      }
      actionButton(surface, action).props.onClick();
      tree = fixture.render();
      const formType = action === 'create-bot' ? fixture.page.BotFormDialog : fixture.page.GroupFormDialog;
      const form = component(tree, formType);
      assert.equal(form.props[action === 'create-bot' ? 'bot' : 'group'], null, 'the action opens a new-item form');
      assert.equal(walk(tree).some(node => node.type === fixture.page.GettingStartedDialog), false);
      form.props.onClose();
      tree = fixture.render();
      component(tree, fixture.page.WelcomeScreen);
      assert.equal(fixture.state(tree).dialog, null);
      assert.equal(fixture.state(tree).homeSelected, true);
      assert.deepEqual(fixture.requests, [], 'choosing or cancelling a form does not submit creation');
    }
  }
});

test('successful creation from onboarding leaves home and opens the new conversation after refresh', () => {
  const newGroup = { ...team, groupId: 'team-new', title: 'New project' };
  for (const kind of ['bot', 'group']) {
    const fixture = pageFixture({ homeSelected: true, activeGroupId: null });
    let tree = fixture.render();
    actionButton(fixture.welcome(tree), 'quick-start').props.onClick();
    tree = fixture.render();
    actionButton(fixture.guide(tree), `create-${kind}`).props.onClick();
    tree = fixture.render();
    const formType = kind === 'bot' ? fixture.page.BotFormDialog : fixture.page.GroupFormDialog;
    component(tree, formType).props.onSaved(kind === 'bot'
      ? { created: true, botId: newBot.botId }
      : { group: newGroup });
    tree = fixture.render();
    assert.equal(fixture.state(tree).homeSelected, false, 'successful creation exits explicit home selection');
    assert.equal(fixture.state(tree).dialog, null);
    const selectedGroup = kind === 'bot' ? newDirect : newGroup;
    component(tree, fixture.page.GroupList).props.dispatch({
      type: 'bootstrap',
      data: bootstrapData(fixture.state(tree), { bots: [bot, newBot], groups: [team, direct, selectedGroup] }),
    });
    tree = fixture.render();
    assert.equal(fixture.state(tree).activeGroupId, selectedGroup.groupId);
    assert.equal(fixture.state(tree).pendingDirectBotId, null);
    assert.equal(component(tree, fixture.page.Composer).props.group.groupId, selectedGroup.groupId);
    assert.deepEqual(plain(fixture.state(tree).messagesByGroup[team.groupId]), [message]);
  }
});

test('closing quick start returns to home and the welcome sidebar callback restores navigation', () => {
  const fixture = pageFixture({ homeSelected: true, activeGroupId: null, sidebarCollapsed: true });
  let tree = fixture.render();
  actionButton(fixture.welcome(tree), 'quick-start').props.onClick();
  tree = fixture.render();
  const guide = fixture.guide(tree);
  component(guide, fixture.surface.Modal).props.onClose();
  tree = fixture.render();
  assert.equal(fixture.state(tree).dialog, null);
  assert.equal(fixture.state(tree).homeSelected, true);
  const navigation = walk(fixture.welcome(tree)).find(node => node.type === 'button' && node.props['aria-label'] === '打开导航');
  assert.ok(navigation);
  navigation.props.onClick();
  tree = fixture.render();
  assert.equal(fixture.state(tree).sidebarCollapsed, false);
  assert.equal(fixture.state(tree).activeGroupId, null);
  assert.deepEqual(plain(fixture.state(tree).messagesByGroup[team.groupId]), [message]);
});
