import test from 'node:test';
import assert from 'node:assert/strict';
import { loadClient, text, walk } from './client-harness.js';

const client = loadClient();
const UI_EN = client.UI_EN;
const placeholders = (value) => [...String(value).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

const sampleMessage = (overrides = {}) => ({
  messageId: 'msg-1',
  seq: 1,
  status: 'done',
  kind: 'chat',
  text: '取消',
  author: { type: 'bot', botId: 'bot-1', name: '取消' },
  model: 'example-model',
  meta: { round: 2, verdict: 'pass' },
  ...overrides,
});

const sampleState = () => ({
  ...client.initialState,
  loading: false,
  config: {},
  groups: [{
    groupId: 'grp-1',
    title: '设置',
    topic: '讨论',
    kind: 'group',
    memberIds: ['mem-1'],
    lastMessage: { text: '取消', authorName: '用户', createdAt: Date.now() },
    running: false,
  }],
  bots: [{ botId: 'bot-1', name: '取消', provider: 'deepseek', model: 'chat' }],
  members: [{ membershipId: 'mem-1', groupId: 'grp-1', botId: 'bot-1', sessionId: 'session-1' }],
  folders: [],
});

test('English dictionary covers every key with matching placeholders', () => {
  const keys = Object.keys(UI_EN);
  assert.ok(keys.length > 450, 'dictionary is populated');
  for (const [key, value] of Object.entries(UI_EN)) {
    assert.ok(key.length > 0, 'key is not empty');
    assert.equal(typeof value, 'string');
    assert.ok(value.length > 0, 'value is not empty: ' + key);
    assert.deepEqual(placeholders(value), placeholders(key), 'placeholders match: ' + key);
  }
  assert.equal(client.uiT('设置'), '设置', 'test builds default to Chinese');
});

test('English chrome translates while message, name and title content stays verbatim', () => {
  client.setTestLocale('en');
  try {
    assert.equal(client.uiT('设置'), 'Settings');
    assert.equal(client.uiT('{count} 个回复中', { count: 3 }), '3 replying');

    const row = client.MessageRow({
      message: sampleMessage({ status: 'stopped' }),
      bots: sampleState().bots,
      allMessages: [],
      tasks: [],
      groupStart: true,
      groupEnd: true,
      chatDisplaySettings: client.DEFAULT_CHAT_DISPLAY_SETTINGS,
    });
    const rowText = text(row);
    assert.match(rowText, /Stopped/);
    assert.match(rowText, /Review passed/);
    assert.doesNotMatch(rowText, /已停止/);
    assert.doesNotMatch(rowText, /评审通过/);
    assert.match(rowText, /取消/, 'message text stays source');
    assert.equal((rowText.match(/取消/g) || []).length >= 2, true, 'author and body stay source');
    const modelNode = walk(row).find((node) => node.props && node.props['data-meta'] === 'model');
    assert.equal(modelNode.props.title, 'Model: deepseek / example-model');

    const system = client.MessageRow({
      message: sampleMessage({
        kind: 'discussion',
        status: 'done',
        author: { type: 'system', name: '系统' },
        text: '讨论「方案」结束。',
      }),
      bots: [],
      allMessages: [],
      tasks: [],
      groupStart: true,
      groupEnd: true,
      chatDisplaySettings: client.DEFAULT_CHAT_DISPLAY_SETTINGS,
    });
    assert.match(text(system), /Discussion “方案” ended\./);

    const approval = client.ApprovalRow({
      message: sampleMessage({
        kind: 'approval',
        author: { type: 'system', name: '审批' },
        text: 'Timi 请求权限：工具 bash（需要写权限）。',
        meta: { approvalState: 'pending', sessionId: 'session-2', toolName: 'bash' },
      }),
      bots: [],
      onOpenSession: () => {},
    });
    const approvalText = text(approval);
    assert.match(approvalText, /requests permission: tool bash \(需要写权限\)\./);
    assert.match(approvalText, /Approval request/);
    assert.match(approvalText, /Go to approval/);

    const list = text(client.GroupList({
      state: sampleState(),
      dispatch: () => {},
      onCreate: () => {},
      onCreateBot: () => {},
      onCreateFolder: () => {},
      onOpenDirect: () => {},
      onEditGroup: () => {},
      onDeleteGroup: () => {},
      onEditBot: () => {},
      onViewSession: () => {},
      onCreateGroupInFolder: () => {},
      onRenameFolder: () => {},
      onDeleteFolder: () => {},
      onReorderGroups: () => {},
      onReorderFolders: () => {},
    }));
    assert.match(list, /Settings/, 'settings button is translated');
    assert.match(list, /设置/, 'group title stays source');
    assert.match(list, /取消/, 'bot name stays source');
    assert.ok(walk(client.GroupList({
      state: sampleState(),
      dispatch: () => {},
      onCreate: () => {},
      onCreateBot: () => {},
      onCreateFolder: () => {},
      onOpenDirect: () => {},
      onEditGroup: () => {},
      onDeleteGroup: () => {},
      onEditBot: () => {},
      onViewSession: () => {},
      onCreateGroupInFolder: () => {},
      onRenameFolder: () => {},
      onDeleteFolder: () => {},
      onReorderGroups: () => {},
      onReorderFolders: () => {},
    })).some((node) => node.props && node.props.title === 'New group / topic'), 'new group tooltip is translated');

    const group = { ...sampleState().groups[0], kind: 'direct', title: '取消群' };
    const composer = client.Composer({
      state: sampleState(),
      dispatch: () => {},
      group,
      members: sampleState().members,
      bots: sampleState().bots,
      replyTarget: null,
      userProfile: null,
    });
    const textarea = walk(composer).find((node) => node.type === 'textarea');
    assert.equal(textarea.props.placeholder, 'Send 取消群 a message…');
    assert.ok(walk(composer).some((node) => node.props && node.props.title === 'Add file or command'), 'add-file tooltip is translated');
  } finally {
    client.setTestLocale('zh');
  }
});

test('apply registers zh/en dictionaries with the DSH locale service', () => {
  const registered = {};
  let active = 'en';
  const bind = (namespace) => (key, params) => {
    const template = (registered[namespace] && registered[namespace][active] && registered[namespace][active][key]) ?? key;
    return params
      ? String(template).replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
      : template;
  };
  const ctx = {
    effect(fn) { fn(); },
    locale: {
      register(namespace, dictionaries) { registered[namespace] = dictionaries; },
      bind,
      getSnapshot() { return { active }; },
    },
    slots: { inject() {} },
  };
  client.apply(ctx);
  assert.equal(client.inject.includes('locale'), true);
  assert.equal(registered.botTeam.en['设置'], 'Settings');
  assert.equal(registered.botTeam.zh['设置'], '设置');
  assert.equal(client.uiT('设置'), 'Settings');
  assert.equal(client.uiT('{count} 个回复中', { count: 2 }), '2 replying');
  active = 'zh';
  assert.equal(client.uiT('设置'), '设置');
});
