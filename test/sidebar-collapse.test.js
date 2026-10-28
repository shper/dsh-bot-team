import test from 'node:test';
import assert from 'node:assert/strict';
import { loadClient, plain, walk, text } from './client-harness.js';

const client = loadClient();
const noop = () => {};

const group = overrides => ({
  groupId: 'g1',
  title: 'Bot 测试群',
  topic: '验证侧栏收起',
  memberIds: ['m1', 'm2'],
  running: false,
  lastMessage: {
    messageId: 'm1',
    seq: 3,
    text: '修好了',
    authorName: 'Timi',
    createdAt: 1761470000000,
  },
  ...overrides,
});

const state = overrides => ({
  ...client.initialState,
  loading: false,
  groups: [group()],
  activeGroupId: 'g1',
  ...overrides,
});

const render = (overrides, hooks = {}) => client.GroupList({
  state: state(overrides),
  dispatch: hooks.dispatch || noop,
  onCreate: hooks.onCreate || noop,
});
const sidebar = tree => walk(tree).find(node => node.props?.className === 'bt-sidebar');
const buttons = tree => walk(tree).filter(node => node.type === 'button');
const toggle = tree => buttons(tree).find(node => /侧栏/.test(node.props?.['aria-label'] || ''));

test('expanded sidebar keeps the group feed, labels and a collapse affordance', () => {
  const tree = render();
  const rail = sidebar(tree);
  assert.equal(rail.props['data-collapsed'], 'false');
  assert.equal(rail.props.id, 'bt-group-sidebar');
  assert.equal(rail.props.style.width, 232);
  assert.equal(rail.props.style.transition, 'width 180ms ease');
  assert.match(client.GLOBAL_CSS, /\.bt-sidebar \{ transition: width 180ms ease; \}/);
  assert.match(client.GLOBAL_CSS, /\.bt-sidebar-toggle:hover/);
  assert.match(client.GLOBAL_CSS, /\.bt-group-rail::-webkit-scrollbar/);
  assert.match(client.GLOBAL_CSS, /\.bt-sidebar \{ transition: none !important; \}/, 'reduced motion disables the width animation');
  assert.match(text(tree), /群聊/);
  assert.match(text(tree), /Bot 测试群/);
  assert.match(text(tree), /Bot 管理/);
  assert.match(text(tree), /设置/);

  const button = toggle(tree);
  assert.ok(button, 'a collapse toggle is rendered');
  assert.equal(button.props['aria-label'], '收起侧栏');
  assert.equal(button.props.title, '收起侧栏');
  assert.equal(button.props['aria-expanded'], true);
  assert.equal(button.props['aria-controls'], 'bt-group-sidebar');
  assert.equal(text(button), '', 'the toggle itself is icon-only');
});

test('collapsing keeps only icons: avatars, icon buttons and tooltips', () => {
  const tree = render({ sidebarCollapsed: true });
  const rail = sidebar(tree);
  assert.equal(rail.props['data-collapsed'], 'true');
  assert.equal(rail.props.style.width, 68);
  assert.equal(rail.props.style.minWidth, 68);

  assert.doesNotMatch(text(tree), /群聊|Bot 测试群|Bot 管理|设置|暂无消息|Timi/, 'no labels or previews survive in the rail');
  assert.ok(walk(tree).some(node => typeof node.type === 'function' && node.props?.size === 36 && node.props?.group), 'group avatar component still renders');
  for (const button of buttons(tree)) {
    assert.ok((button.props['aria-label'] || button.props.title || '').length > 0, 'every icon button carries an accessible name');
    assert.equal(text(button), '', 'icon buttons drop their text labels');
  }

  const item = walk(tree).find(node => node.props?.className === 'bt-group-item bt-group-rail-item');
  assert.ok(item);
  assert.equal(item.props.role, 'button');
  assert.equal(item.props.tabIndex, 0);
  assert.equal(item.props['data-active'], 'true');
  assert.equal(item.props['aria-current'], 'true');
  assert.equal(item.props['aria-label'], 'Bot 测试群');
  assert.match(item.props.title, /^Bot 测试群\nTimi：修好了$/);
  assert.equal(item.props.style.width, 46);
  assert.equal(item.props.style.display, 'flex');
  assert.ok(walk(item).some(node => typeof node.type === 'function' && node.props?.size === 36), 'avatar is the group icon');

  const footer = walk(tree).find(node => node.props?.className === 'bt-sidebar-actions bt-sidebar-actions-rail');
  assert.ok(footer);
  assert.equal(footer.props.style.gridTemplateColumns, 'minmax(0, 1fr)');
  const actions = footer.props.children.filter(node => node.type === 'button');
  assert.equal(actions.length, 2);
  assert.equal(actions[0].props.style, actions[1].props.style, 'both rail actions share one style');
  for (const action of actions) {
    assert.equal(action.props.style.width, 38);
    assert.equal(action.props.style.height, 38);
    const icon = action.props.children.find(node => node.type === 'svg');
    assert.equal(icon.props.style.width, 18);
  }

  const button = toggle(tree);
  assert.equal(button.props['aria-label'], '展开侧栏');
  assert.equal(button.props['aria-expanded'], false);
});

test('toggle and group selection dispatch the expected actions from both layouts', () => {
  const actions = [];
  const expanded = render({}, { dispatch: action => actions.push(action) });
  toggle(expanded).props.onClick();
  assert.deepEqual(plain(actions), [{ type: 'toggleSidebar' }]);

  const clicked = [];
  const collapsed = render({ sidebarCollapsed: true }, { dispatch: action => clicked.push(action) });
  const item = walk(collapsed).find(node => node.props?.className === 'bt-group-item bt-group-rail-item');
  item.props.onClick();
  assert.deepEqual(plain(clicked), [{ type: 'selectGroup', groupId: 'g1' }]);

  const keyed = [];
  const keyboard = render({ sidebarCollapsed: true }, { dispatch: action => keyed.push(action) });
  const keyedItem = walk(keyboard).find(node => node.props?.className === 'bt-group-item bt-group-rail-item');
  const press = key => keyedItem.props.onKeyDown({ key, preventDefault: noop });
  press('Enter');
  press(' ');
  press('a');
  assert.deepEqual(plain(keyed), [
    { type: 'selectGroup', groupId: 'g1' },
    { type: 'selectGroup', groupId: 'g1' },
  ]);
});

test('group creation is offered from the section header in both layouts and keeps the callback', () => {
  const calls = [];
  const expanded = render({}, { onCreate: () => calls.push('expanded') });
  assert.equal(
    walk(expanded).some(node => node.type === 'button' && text(node) === '+ 新建'),
    false,
    'the expanded header no longer has a redundant + 新建 button',
  );
  const sectionPlus = buttons(expanded).find(node => node.props['aria-label'] === '新建群 / 话题');
  assert.ok(sectionPlus);
  sectionPlus.props.onClick();

  const collapsed = render({ sidebarCollapsed: true }, { onCreate: () => calls.push('collapsed') });
  const plus = buttons(collapsed).find(node => node.props['aria-label'] === '新建群 / 话题');
  assert.ok(plus);
  plus.props.onClick();
  assert.deepEqual(calls, ['expanded', 'collapsed']);
});

test('the reducer toggles collapse without mutating state or touching other fields', () => {
  const before = state();
  const collapsed = client.reducer(before, { type: 'toggleSidebar' });
  assert.equal(collapsed.sidebarCollapsed, true);
  assert.equal(collapsed.groups, before.groups);
  assert.equal(before.sidebarCollapsed, false, 'original state stays untouched');
  const expanded = client.reducer(collapsed, { type: 'toggleSidebar' });
  assert.equal(expanded.sidebarCollapsed, false);
  assert.equal(expanded.activeGroupId, 'g1');
});

test('collapse preference is read and written through localStorage, and storage failures are ignored', () => {
  const store = new Map([[client.SIDEBAR_COLLAPSED_KEY, '1']]);
  const local = loadClient({
    localStorage: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, value),
    },
  });
  assert.equal(local.SIDEBAR_COLLAPSED_KEY, 'bot-team.sidebar.collapsed');
  assert.equal(local.initialState.sidebarCollapsed, true, 'a stored preference restores the rail');
  local.persistSidebarCollapsed(false);
  assert.equal(store.get(local.SIDEBAR_COLLAPSED_KEY), '0');
  local.persistSidebarCollapsed(true);
  assert.equal(store.get(local.SIDEBAR_COLLAPSED_KEY), '1');
  assert.equal(local.readSidebarCollapsed(), true);

  const unavailable = loadClient({
    localStorage: {
      getItem() { throw new Error('storage disabled'); },
      setItem() { throw new Error('quota exceeded'); },
    },
  });
  assert.equal(unavailable.initialState.sidebarCollapsed, false, 'unreadable storage falls back to expanded');
  assert.doesNotThrow(() => unavailable.persistSidebarCollapsed(true), 'a failed write never breaks the toggle');
  assert.equal(unavailable.readSidebarCollapsed(), false);
});

test('the page reads the stored preference on each mount instead of the module-level snapshot', () => {
  const store = new Map([[client.SIDEBAR_COLLAPSED_KEY, '1']]);
  const local = loadClient({
    localStorage: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, value),
    },
  });
  const groupList = tree => walk(tree).find(node => node.type === local.GroupList);
  assert.equal(groupList(local.render(local.BotTeamPage)).props.state.sidebarCollapsed, true);

  store.set(client.SIDEBAR_COLLAPSED_KEY, '0');
  assert.equal(groupList(local.remount(local.BotTeamPage)).props.state.sidebarCollapsed, false, 'a remount re-reads storage');
});
