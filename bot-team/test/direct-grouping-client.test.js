import test from 'node:test';
import assert from 'node:assert/strict';
import { loadClient, plain, walk, text } from './client-harness.js';

const client = loadClient();
const noop = () => {};

const now = 1761500000000;
const bot = (botId, name, extra = {}) => ({
  botId,
  name,
  provider: 'deepseek',
  model: 'deepseek-chat',
  createdAt: now,
  ...extra,
});
const group = (groupId, title, extra = {}) => ({
  groupId,
  kind: 'group',
  title,
  topic: '',
  memberIds: ['m-' + groupId],
  running: false,
  order: 0,
  folderId: null,
  lastMessage: {
    messageId: 'msg-' + groupId,
    seq: 1,
    text: `${title} 的消息`,
    authorName: '用户',
    createdAt: now,
  },
  ...extra,
});
const directGroup = (botId, title, extra = {}) => ({
  groupId: 'dm-' + botId,
  kind: 'direct',
  botId,
  title,
  topic: '',
  memberIds: ['m-dm-' + botId],
  running: false,
  order: 0,
  folderId: null,
  lastMessage: null,
  ...extra,
});

const bots = [bot('b1', 'Timi'), bot('b2', 'Mochi')];
const groups = [
  directGroup('b1', 'Timi', { lastMessage: { text: '你好', authorName: 'Timi', createdAt: now } }),
  directGroup('b2', 'Mochi'),
  group('g1', '产品群', { folderId: 'f1', order: 0 }),
  group('g2', '技术群', { folderId: 'f1', order: 1 }),
  group('g3', '杂项群', { order: 0 }),
];
const folders = [{ folderId: 'f1', title: '工作', order: 0 }];
const members = [
  { membershipId: 'm1', groupId: 'dm-b1', botId: 'b1' },
  { membershipId: 'm2', groupId: 'dm-b2', botId: 'b2' },
  { membershipId: 'm3', groupId: 'g1', botId: 'b1' },
  { membershipId: 'm4', groupId: 'g2', botId: 'b2' },
  { membershipId: 'm5', groupId: 'g3', botId: 'b1' },
];

const baseState = (overrides = {}) => ({
  ...client.initialState,
  loading: false,
  bots,
  groups,
  folders,
  members,
  activeGroupId: 'g1',
  sectionsCollapsed: {},
  ...overrides,
});

const groupListProps = (overrides = {}, hooks = {}) => ({
  state: baseState(overrides),
  dispatch: hooks.dispatch || noop,
  onCreate: hooks.onCreate || noop,
  onCreateBot: hooks.onCreateBot || noop,
  onCreateFolder: hooks.onCreateFolder || noop,
  onOpenDirect: hooks.onOpenDirect || noop,
  onEditGroup: hooks.onEditGroup || noop,
  onDeleteGroup: hooks.onDeleteGroup || noop,
  onEditBot: hooks.onEditBot || noop,
  onViewSession: hooks.onViewSession || noop,
  onCreateGroupInFolder: hooks.onCreateGroupInFolder || noop,
  onRenameFolder: hooks.onRenameFolder || noop,
  onDeleteFolder: hooks.onDeleteFolder || noop,
  onReorderGroups: hooks.onReorderGroups || noop,
  onReorderFolders: hooks.onReorderFolders || noop,
});

const render = (overrides = {}, hooks = {}) => client.GroupList(groupListProps(overrides, hooks));
const byClass = (tree, className) => walk(tree).find((node) => node.props?.className === className);
const allByClass = (tree, className) => walk(tree).filter((node) => node.props?.className === className);
const buttonByLabel = (tree, label) => walk(tree).find((node) => node.type === 'button' && node.props?.['aria-label'] === label);
const buttonByText = (tree, label) => walk(tree).find((node) => node.type === 'button' && text(node) === label);

test('sidebar model puts single chats above groups, keeps folder order and falls back to 未分组', () => {
  const model = client.buildSidebarModel(baseState({
    folders: [{ folderId: 'f2', title: '生活', order: 1 }, { folderId: 'f1', title: '工作', order: 0 }],
    groups: [
      ...groups,
      group('g4', '孤儿群', { folderId: 'missing-folder', order: 0 }),
    ],
  }));
  assert.deepEqual(plain(model.direct.map((entry) => entry.bot.name)), ['Timi', 'Mochi']);
  assert.deepEqual(plain(model.direct.map((entry) => entry.group?.groupId)), ['dm-b1', 'dm-b2']);
  assert.deepEqual(plain(model.folders.map((entry) => entry.folder.title)), ['工作', '生活']);
  assert.deepEqual(plain(model.folders[0].groups.map((entry) => entry.title)), ['产品群', '技术群']);
  assert.deepEqual(plain(model.folders[1].groups), []);
  assert.deepEqual(plain(model.ungrouped.map((entry) => entry.title)), ['杂项群', '孤儿群']);
  assert.equal(model.groupCount, 4);
});

test('expanded sidebar renders 单聊 then 群聊 with a folder and 未分组; folder creation stays in the header', () => {
  const tree = render();
  const sections = allByClass(tree, 'bt-sidebar-section');
  assert.deepEqual(sections.map((node) => node.props['data-section']), ['direct', 'groups']);
  assert.equal(text(tree).indexOf('单聊') < text(tree).indexOf('群聊'), true);

  const directRows = allByClass(tree, 'bt-group-item bt-direct-item');
  assert.equal(directRows.length, 2);
  assert.equal(directRows[0].props['data-bot-id'], 'b1');
  assert.match(directRows[0].props['aria-label'], /Timi（单聊）/);
  assert.match(directRows[0].props.title, /^Timi（单聊）\n你好$/);

  const folderHeads = allByClass(tree, 'bt-folder-toggle');
  assert.ok(folderHeads.some((node) => /分组 工作/.test(node.props['aria-label'])));
  assert.ok(folderHeads.some((node) => /未分组/.test(node.props['aria-label'])));
  assert.doesNotMatch(text(tree), /新建分组/, 'the bottom new-folder row is gone');
  assert.equal(walk(tree).some((node) => node.props?.className === 'bt-new-folder'), false);
  assert.match(text(tree), /产品群/);
  assert.match(text(tree), /杂项群/);
  const newFolder = buttonByLabel(tree, '新建分组');
  assert.ok(newFolder);
  assert.ok(buttonByLabel(tree, '新建 Bot'));
  assert.ok(buttonByLabel(tree, '新建群 / 话题'));

  // Row menus are real buttons with names, not unlabeled glyphs.
  assert.equal(allByClass(tree, 'bt-row-menu').length, 5);
  for (const button of allByClass(tree, 'bt-row-menu')) {
    assert.ok(button.props['aria-label'].length > 0);
  }
});

test('single-chat and group-chat sections and each folder collapse through the reducer', () => {
  const actions = [];
  const tree = render({}, { dispatch: (action) => actions.push(action) });
  buttonByLabel(tree, '收起单聊').props.onClick();
  buttonByLabel(tree, '收起群聊').props.onClick();
  buttonByLabel(tree, '收起分组 工作').props.onClick();
  assert.deepEqual(plain(actions), [
    { type: 'sectionCollapsed', key: 'direct', collapsed: true },
    { type: 'sectionCollapsed', key: 'groups', collapsed: true },
    { type: 'sectionCollapsed', key: 'folder:f1', collapsed: true },
  ]);

  const collapsed = render({ sectionsCollapsed: { direct: true, groups: true, 'folder:f1': true, ungrouped: true } });
  assert.equal(buttonByLabel(collapsed, '展开单聊').props['aria-expanded'], false);
  assert.equal(buttonByLabel(collapsed, '展开群聊').props['aria-expanded'], false);
  assert.equal(buttonByLabel(collapsed, '展开分组 工作').props['aria-expanded'], false);
  const directBody = walk(collapsed).find((node) => node.props?.id === 'bt-section-body-direct');
  assert.equal(directBody.props.style.display, 'none');
  const groupsBody = walk(collapsed).find((node) => node.props?.id === 'bt-section-body-groups');
  assert.equal(groupsBody.props.style.display, 'none');
  const folderBody = walk(collapsed).find((node) => node.props?.id === 'bt-folder-body-f1');
  assert.equal(folderBody.props.style.display, 'none');

  const state = baseState();
  const once = client.reducer(state, { type: 'sectionCollapsed', key: 'direct', collapsed: true });
  assert.deepEqual(plain(once.sectionsCollapsed), { direct: true });
  assert.equal(state.sectionsCollapsed.direct, undefined, 'original state is not mutated');
  const twice = client.reducer(once, { type: 'sectionCollapsed', key: 'direct', collapsed: false });
  assert.deepEqual(plain(twice.sectionsCollapsed), {});
});

test('section collapse preference is read/written through localStorage and survives bad JSON', () => {
  const store = new Map([[client.SECTIONS_COLLAPSED_KEY, JSON.stringify({ direct: true, 'folder:f1': true, junk: 'x' })]]);
  const local = loadClient({
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, value),
    },
  });
  assert.equal(local.SECTIONS_COLLAPSED_KEY, 'bot-team.sidebar.sections');
  assert.deepEqual({ ...local.initialState.sectionsCollapsed }, { direct: true, 'folder:f1': true });
  local.persistSectionsCollapsed({ groups: true });
  assert.deepEqual(JSON.parse(store.get(local.SECTIONS_COLLAPSED_KEY)), { groups: true });
  assert.equal(local.sectionFolderKey('f1'), 'folder:f1');

  const broken = loadClient({
    localStorage: {
      getItem: () => '{not json',
      setItem() { throw new Error('quota'); },
    },
  });
  assert.deepEqual({ ...broken.initialState.sectionsCollapsed }, {});
  assert.doesNotThrow(() => broken.persistSectionsCollapsed({ direct: true }));
  const unavailable = loadClient({
    localStorage: {
      getItem() { throw new Error('disabled'); },
      setItem() { throw new Error('disabled'); },
    },
  });
  assert.deepEqual({ ...unavailable.initialState.sectionsCollapsed }, {});
});

test('collapsed rail shows single chats first, separated from groups, without section labels', () => {
  const tree = render({ sidebarCollapsed: true });
  const rail = byClass(tree, 'bt-group-rail');
  assert.ok(rail);
  assert.doesNotMatch(text(tree), /单聊|群聊|工作|未分组|产品群|新建分组/, 'rail keeps icons only');
  const items = rail.props.children.filter((node) => node && node.props?.className && node.props.className.includes('bt-group-rail-item'));
  assert.equal(items.length, 5);
  assert.match(items[0].props['aria-label'], /Timi（单聊）/);
  assert.match(items[1].props['aria-label'], /Mochi（单聊）/);
  assert.match(items[0].props.title, /^Timi（单聊）/);
  assert.match(items[2].props['aria-label'], /产品群/);
  assert.ok(rail.props.children.some((node) => node && node.props?.className === 'bt-rail-divider'));
});

test('drop computation reorders, moves across folders, and refuses mixing single chats with groups', () => {
  const model = client.buildSidebarModel(baseState());
  assert.deepEqual(plain(client.computeGroupDrop(model, 'g3', { groupId: 'g1' }, 'before')), {
    kind: 'group',
    folderId: 'f1',
    movedGroupId: 'g3',
    orderedIds: ['g3', 'g1', 'g2'],
  });
  assert.deepEqual(plain(client.computeGroupDrop(model, 'g1', { groupId: 'g2' }, 'after')), {
    kind: 'group',
    folderId: 'f1',
    movedGroupId: 'g1',
    orderedIds: ['g2', 'g1'],
  });
  assert.deepEqual(plain(client.computeGroupDrop(model, 'g1', { ungrouped: true }, 'end')), {
    kind: 'group',
    folderId: null,
    movedGroupId: 'g1',
    orderedIds: ['g3', 'g1'],
  });
  assert.deepEqual(plain(client.computeGroupDrop(model, 'g2', { folderId: 'f1' }, 'end')), null, 'already at the end');
  assert.equal(client.computeGroupDrop(model, 'dm-b1', { groupId: 'g1' }, 'before'), null);
  assert.equal(client.computeGroupDrop(model, 'g1', { groupId: 'dm-b1' }, 'before'), null);
  assert.deepEqual(plain(client.computeGroupDrop(model, 'dm-b2', { groupId: 'dm-b1' }, 'before')), {
    kind: 'direct',
    folderId: null,
    movedGroupId: 'dm-b2',
    orderedIds: ['dm-b2', 'dm-b1'],
  });
  assert.deepEqual(plain(client.computeFolderDrop(model, 'f1', 'f1', 'before')), null);
  assert.deepEqual(plain(client.computeFolderDrop(model, 'f1', 'missing', 'before')), null);
  const twoFolders = client.buildSidebarModel(baseState({
    folders: [{ folderId: 'f1', title: '工作', order: 0 }, { folderId: 'f2', title: '生活', order: 1 }],
  }));
  assert.deepEqual(plain(client.computeFolderDrop(twoFolders, 'f2', 'f1', 'before')), { orderedIds: ['f2', 'f1'] });
  assert.deepEqual(plain(client.stepGroupOrder(model, 'g2', 'up')), {
    kind: 'group',
    folderId: 'f1',
    movedGroupId: 'g2',
    orderedIds: ['g2', 'g1'],
  });
  assert.equal(client.stepGroupOrder(model, 'g1', 'up'), null);
  assert.equal(client.stepFolderOrder(model, 'f1', 'up'), null);
});

test('reducer applies optimistic orders, folder moves and the pending single-chat selection', () => {
  const state = baseState({ activeGroupId: 'g1' });
  const applied = client.reducer(state, {
    type: 'applyGroupOrder',
    kind: 'group',
    folderId: 'f1',
    movedGroupId: 'g3',
    orderedIds: ['g3', 'g1', 'g2'],
  });
  assert.deepEqual(applied.groups.find((entry) => entry.groupId === 'g3').folderId, 'f1');
  assert.equal(applied.groups.find((entry) => entry.groupId === 'g3').order, 0);
  assert.equal(applied.groups.find((entry) => entry.groupId === 'g1').order, 1);
  assert.equal(applied.groups.find((entry) => entry.groupId === 'g2').order, 2);
  assert.equal(state.groups.find((entry) => entry.groupId === 'g3').folderId, null, 'source state untouched');

  const folderOrder = client.reducer(
    baseState({ folders: [{ folderId: 'f1', title: '工作', order: 0 }, { folderId: 'f2', title: '生活', order: 1 }] }),
    { type: 'applyFolderOrder', orderedIds: ['f2', 'f1'] },
  );
  assert.equal(folderOrder.folders.find((entry) => entry.folderId === 'f2').order, 0);

  const pending = client.reducer(baseState({ activeGroupId: 'g1' }), { type: 'pendingDirect', botId: 'b2' });
  assert.equal(pending.pendingDirectBotId, 'b2');
  const bootstrapped = client.reducer(pending, {
    type: 'bootstrap',
    data: {
      bots,
      groups,
      folders,
      members,
      config: {},
      chatDisplaySettings: client.DEFAULT_CHAT_DISPLAY_SETTINGS,
    },
  });
  assert.equal(bootstrapped.activeGroupId, 'dm-b2', 'new bot opens its single chat');
  assert.equal(bootstrapped.pendingDirectBotId, null);
  assert.deepEqual(bootstrapped.folders, folders);

  // If the bot exists but no direct group came back (older Host), do not stay pending.
  const stale = client.reducer(
    { ...baseState(), pendingDirectBotId: 'b1' },
    {
      type: 'bootstrap',
      data: { bots, groups: groups.filter((entry) => entry.kind !== 'direct'), folders, members, config: {}, chatDisplaySettings: client.DEFAULT_CHAT_DISPLAY_SETTINGS },
    },
  );
  assert.equal(stale.pendingDirectBotId, null);
});

test('the composer switches to direct-chat copy and drops the @ picker', () => {
  const state = baseState();
  const direct = client.Composer({
    state,
    dispatch: noop,
    group: groups[0],
    members: [members[0]],
    bots,
    replyTarget: null,
    userProfile: null,
    onClearReply: noop,
    onSent: noop,
    onResize: noop,
  });
  const directInput = walk(direct).find((node) => node.type === 'textarea');
  assert.equal(directInput.props['aria-label'], '单聊消息输入框');
  assert.equal(directInput.props.placeholder, '给 Timi 发消息…');
  assert.doesNotMatch(text(direct), /@ 提及/);
  assert.match(text(direct), /Enter 发送/);
  assert.doesNotMatch(text(direct), /@ 提及成员/);

  const groupComposer = client.Composer({
    state,
    dispatch: noop,
    group: groups[2],
    members: [members[2]],
    bots,
    replyTarget: null,
    userProfile: null,
    onClearReply: noop,
    onSent: noop,
    onResize: noop,
  });
  const groupInput = walk(groupComposer).find((node) => node.type === 'textarea');
  assert.equal(groupInput.props['aria-label'], '群聊消息输入框');
  assert.equal(groupInput.props.placeholder, '输入消息，@ 成员派活…');
  assert.match(text(groupComposer), /@ 提及/);
});

test('the direct-chat page header and right rail use bot identity, not member management', () => {
  const state = baseState({
    groups: [directGroup('b1', 'Timi', { usage: { inputTokens: 1200, outputTokens: 340, totalTokens: 1540 } })],
    members: [members[0]],
    activeGroupId: 'dm-b1',
    messagesByGroup: {
      'dm-b1': [{
        messageId: 'dm-msg-1',
        groupId: 'dm-b1',
        seq: 1,
        author: { type: 'bot', botId: 'b1', name: 'Timi' },
        kind: 'chat',
        text: '你好',
        mentions: [],
        status: 'done',
        createdAt: now,
      }],
    },
  });
  const local = loadClient({
    state,
    localStorage: { getItem: () => null, setItem: () => {} },
  });
  const tree = local.BotTeamPage({});
  const nodes = walk(tree);
  assert.ok(nodes.some((node) => node.type === local.DirectPanel));
  const composer = nodes.find((node) => node.type === local.Composer);
  assert.equal(composer.props.group.kind, 'direct');
  assert.ok(!nodes.some((node) => node.type === local.MembersPanel), 'no member panel in a single chat');
  assert.doesNotMatch(text(tree), /讨论/);
  assert.match(text(tree), /编辑 Bot/);
  assert.match(text(tree), /单聊/);
  assert.ok(buttonByLabel(tree, '更多单聊操作'));
  const messageList = nodes.find((node) => node.type === local.MessageList);
  assert.ok(messageList);
  assert.equal(messageList.props.onReview, undefined, 'single chats have no review workflow');
  assert.equal(typeof messageList.props.onRetry, 'function', 'retry stays available');

  const panel = local.DirectPanel({
    bot: bots[0],
    group: state.groups[0],
    member: members[0],
    usage: state.groups[0].usage,
    onEdit: noop,
    onViewSession: noop,
  });
  assert.match(text(panel), /deepseek\/deepseek-chat/);
  assert.match(text(panel), /1,200/);
  assert.ok(buttonByText(panel, '编辑 Bot'));
  assert.ok(buttonByText(panel, '查看会话'));
});

test('group and folder dialogs expose folder assignment and naming', () => {
  const groupDialog = client.GroupFormDialog({
    group: groups[2],
    folders,
    folderId: null,
    onClose: noop,
    onSaved: noop,
  });
  const select = walk(groupDialog).find((node) => node.type === 'select');
  assert.equal(select.props.value, 'f1');
  const options = select.props.children.filter(Boolean).map((node) => node.props.value);
  assert.deepEqual(options, ['', 'f1']);
  assert.match(text(groupDialog), /不分组/);

  const createDialog = client.GroupFormDialog({
    group: null,
    folders,
    folderId: 'f1',
    onClose: noop,
    onSaved: noop,
  });
  assert.equal(walk(createDialog).find((node) => node.type === 'select').props.value, 'f1');

  const folderDialog = client.FolderFormDialog({ folder: null, onClose: noop, onSaved: noop });
  assert.equal(folderDialog.props.title, '新建分组');
  assert.equal(walk(folderDialog).find((node) => node.type === 'input').props.maxLength, 40);
});

test('an old Host shows a restart hint instead of single chats it cannot create yet', () => {
  const tree = render({ config: { schemaVersion: 5 } });
  assert.match(text(tree), /Host 仍是旧版本/);
  assert.equal(allByClass(tree, 'bt-group-item bt-direct-item').length, 0);
  assert.equal(allByClass(tree, 'bt-row-menu').length, 3, 'only group rows keep a row menu');
  assert.equal(buttonByLabel(tree, '新建分组'), undefined, 'folder creation is hidden until the Host is upgraded');
});

test('the sidebar context menu renders items, hints, disabled entries and danger styling', () => {
  const tree = client.SidebarMenu({
    menu: { type: 'group', id: 'g1', x: 120, y: 160 },
    items: [
      { key: 'edit', label: '编辑群信息', onSelect: () => {} },
      { kind: 'separator', key: 'sep' },
      { kind: 'hint', key: 'hint', label: '移动到分组' },
      { key: 'move', label: '工作', onSelect: () => {} },
      { key: 'up', label: '上移', disabled: true, onSelect: () => {} },
      { key: 'delete', label: '删除群', danger: true, onSelect: () => {} },
    ],
    onClose: () => {},
  });
  const menu = walk(tree).find((node) => node.props?.className === 'bt-menu bt-sidebar-menu');
  assert.ok(menu);
  assert.equal(menu.props.role, 'menu');
  assert.equal(menu.props['aria-label'], '会话操作');
  assert.match(text(menu), /编辑群信息/);
  assert.match(text(menu), /移动到分组/);
  const buttons = walk(menu).filter((node) => node.type === 'button');
  assert.deepEqual(buttons.map((node) => node.props.disabled === true), [false, false, true, false]);
  assert.ok(buttons[3].props.className.includes('bt-msg-menu-danger'));
  assert.ok(walk(tree).some((node) => node.props?.className === 'bt-menu-backdrop'), 'a backdrop closes the menu');
  assert.ok(walk(tree).some((node) => node.props?.role === 'separator'));
});

test('a bot without a direct group still has a row that requests creation on click', () => {
  const calls = [];
  const tree = render(
    { groups: groups.filter((entry) => entry.groupId !== 'dm-b2') },
    { onOpenDirect: (botId, chat) => calls.push([botId, !!chat]) },
  );
  const row = walk(tree).find((node) => node.props?.['data-bot-id'] === 'b2');
  assert.ok(row);
  row.props.onClick();
  assert.deepEqual(plain(calls), [['b2', false]]);
});

test('the right status panel can be collapsed and expanded, and the preference persists', () => {
  const store = new Map([[client.RIGHT_PANEL_COLLAPSED_KEY, '1']]);
  const local = loadClient({
    state: gameStateForPanel({ rightPanelCollapsed: false }),
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, value),
    },
  });
  assert.equal(local.RIGHT_PANEL_COLLAPSED_KEY, 'bot-team.right-panel.collapsed');
  assert.equal(local.readRightPanelCollapsed(), true);
  assert.equal(local.initialState.rightPanelCollapsed, true, 'the module snapshot reads storage');

  const expanded = local.BotTeamPage({});
  const expandedNodes = walk(expanded);
  assert.ok(expandedNodes.some((node) => node.type === local.DirectPanel), 'panel is visible by default');
  assert.ok(buttonByLabel(expanded, '收起右侧面板'));
  assert.equal(buttonByLabel(expanded, '收起右侧面板').props['aria-expanded'], true);

  const collapsedClient = loadClient({
    state: gameStateForPanel({ rightPanelCollapsed: true }),
    localStorage: { getItem: () => null, setItem: () => {} },
  });
  const collapsed = collapsedClient.BotTeamPage({});
  const collapsedNodes = walk(collapsed);
  assert.ok(!collapsedNodes.some((node) => node.type === collapsedClient.DirectPanel), 'panel is unmounted when collapsed');
  assert.ok(!collapsedNodes.some((node) => node.type === collapsedClient.MembersPanel));
  assert.ok(buttonByLabel(collapsed, '展开右侧面板'));
  assert.equal(buttonByLabel(collapsed, '展开右侧面板').props['aria-expanded'], false);

  const toggled = collapsedClient.reducer(
    gameStateForPanel({ rightPanelCollapsed: true }),
    { type: 'toggleRightPanel' },
  );
  assert.equal(toggled.rightPanelCollapsed, false);
  assert.equal(collapsedClient.reducer(toggled, { type: 'toggleRightPanel' }).rightPanelCollapsed, true);

  local.persistRightPanelCollapsed(false);
  assert.equal(store.get(local.RIGHT_PANEL_COLLAPSED_KEY), '0');
  local.persistRightPanelCollapsed(true);
  assert.equal(store.get(local.RIGHT_PANEL_COLLAPSED_KEY), '1');

  const unavailable = loadClient({
    localStorage: {
      getItem() { throw new Error('disabled'); },
      setItem() { throw new Error('disabled'); },
    },
  });
  assert.equal(unavailable.readRightPanelCollapsed(), false);
  assert.doesNotThrow(() => unavailable.persistRightPanelCollapsed(true));
});

test('the panel header also offers a collapse control', () => {
  let collapses = 0;
  const panel = client.DirectPanel({
    bot: bots[0],
    group: directGroup('b1', 'Timi'),
    member: members[0],
    usage: null,
    onEdit: noop,
    onCollapse: () => { collapses += 1; },
    onViewSession: noop,
  });
  const collapse = buttonByLabel(panel, '收起右侧面板');
  assert.ok(collapse);
  collapse.props.onClick();
  assert.equal(collapses, 1);
  assert.equal(walk(client.DirectPanel({ bot: bots[0], group: directGroup('b1', 'Timi'), member: members[0], usage: null, onEdit: noop, onViewSession: noop })).some((node) => node.props?.['aria-label'] === '收起右侧面板'), false, 'no dead control without a handler');
});

function gameStateForPanel(overrides = {}) {
  return {
    ...baseState({
      groups: [directGroup('b1', 'Timi')],
      members: [members[0]],
      activeGroupId: 'dm-b1',
    }),
    ...overrides,
  };
}
