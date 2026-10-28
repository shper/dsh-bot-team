import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CHAT_DISPLAY_SETTINGS, normalizeChatDisplaySettings } from '../host/chat-settings.js';
import { loadClient, plain, walk, text } from './client-harness.js';

const client = loadClient();
const fields = Object.keys(DEFAULT_CHAT_DISPLAY_SETTINGS);
const modeSettings = mode => Object.fromEntries(fields.map(key => [key, mode]));
const message = overrides => ({
  messageId: 'msg-1', seq: 1, status: 'done', text: 'Hello', kind: 'chat',
  author: { type: 'bot', botId: 'bot-1', name: 'Bot' }, model: 'example-model', provider: 'example-provider',
  usage: { inputTokens: 250, outputTokens: 3600 },
  generationStats: { scope: 'last-request', durationMs: 60000, outputTokens: 3600, tokensPerSecond: 60 },
  ...overrides,
});
const row = (item, settings) => client.MessageRow({ message: item, bots: [], allMessages: [], tasks: [], groupStart: true, groupEnd: true, chatDisplaySettings: settings });
const metaNodes = tree => walk(tree).filter(node => node.props?.['data-meta']);
const button = (tree, label) => walk(tree).find(node => node.type === 'button' && text(node) === label);

test('client and Host normalize defaults, corrupt data and partial/legacy preferences identically', () => {
  for (const input of [undefined, null, '', [], { model: 'always' }, { model: 'bad', inputTokens: false, outputTokens: 'hidden', speed: 'hover', extra: 'always' }, Object.create({ model: 'hidden' })]) {
    assert.deepEqual(plain(client.normalizeChatDisplaySettings(input)), normalizeChatDisplaySettings(input));
  }
  assert.deepEqual(plain(client.DEFAULT_CHAT_DISPLAY_SETTINGS), DEFAULT_CHAT_DISPLAY_SETTINGS);
});

test('all 81 independent mode combinations render only chosen fields, with always-visible items first', () => {
  for (let index = 0; index < 81; index++) {
    const modes = ['hover', 'always', 'hidden'];
    const settings = Object.fromEntries(fields.map((field, offset) => [field, modes[Math.floor(index / 3 ** offset) % 3]]));
    const items = plain(client.messageMetadataItems(message(), settings));
    const expected = fields.filter(key => settings[key] !== 'hidden').sort((a, b) => Number(settings[a] === 'hover') - Number(settings[b] === 'hover'));
    assert.deepEqual(items.map(item => item.key), expected);
    assert.deepEqual(metaNodes(row(message(), settings)).map(node => node.props['data-meta']), expected);
    for (const item of items) {
      assert.equal(item.mode, settings[item.key]);
      assert.ok(!item.text.startsWith('·'), 'no dangling separators when other fields are hidden');
    }
  }
});

test('keeps real zero tokens and speed, omits missing or invalid values rather than manufacturing zeros', () => {
  const zeros = plain(client.messageMetadataItems(message({ usage: { inputTokens: 0, outputTokens: 0 }, generationStats: { scope: 'last-request', durationMs: 1000, outputTokens: 0 } })));
  assert.deepEqual(zeros.map(item => item.text), ['example-model', '↑ 0', '↓ 0', '0.0 tok/s']);
  for (const usage of [null, {}, { inputTokens: undefined, outputTokens: null }, { inputTokens: NaN, outputTokens: Infinity }, { inputTokens: -1, outputTokens: '2' }, { inputTokens: 1.5, outputTokens: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.deepEqual(plain(client.messageMetadataItems(message({ usage }))).map(item => item.key), ['model']);
  }
  assert.deepEqual(plain(client.messageMetadataItems(message({ usage: { outputTokens: 20 }, generationStats: null }))).map(item => item.key), ['model', 'outputTokens']);
});

test('does not estimate historical speed from message timestamps or mismatched statistics', () => {
  const invalid = [undefined, null, {}, { scope: 'turn', durationMs: 1000, outputTokens: 3600 }, { scope: 'last-request', durationMs: 1000, outputTokens: 42 }];
  for (const durationMs of [undefined, null, 0, -1, Infinity, NaN, '1000']) invalid.push({ scope: 'last-request', durationMs, outputTokens: 3600 });
  for (const generationStats of invalid) {
    assert.equal(client.messageMetadataItems(message({ generationStats, createdAt: 1000, updatedAt: 2000 })).some(item => item.key === 'speed'), false);
  }
  const tiny = client.messageMetadataItems(message({ usage: { outputTokens: 1 }, generationStats: { scope: 'last-request', durationMs: 100000, outputTokens: 1 } }));
  assert.equal(tiny.find(item => item.key === 'speed').text, '< 0.1 tok/s');
  const speed = client.messageMetadataItems(message()).find(item => item.key === 'speed');
  assert.equal(speed.text, '60.0 tok/s');
  assert.match(speed.title, /最近一次.*等待与思考.*不含工具执行/);
});

test('metadata stays out of streaming/human/system messages; failures never show stale speed', () => {
  for (const status of ['pending', 'streaming']) assert.deepEqual(plain(client.messageMetadataItems(message({ status }))), []);
  for (const type of ['human', 'system']) assert.deepEqual(plain(client.messageMetadataItems(message({ author: { type } }))), []);
  for (const status of ['error', 'stopped']) assert.equal(client.messageMetadataItems(message({ status })).some(item => item.key === 'speed'), false);
});

test('all-hidden removes the empty footer while preserving stopped, error and review status', () => {
  assert.equal(walk(row(message(), modeSettings('hidden'))).some(node => node.props?.className === 'bt-msg-footer'), false);
  const reviewed = row(message({ status: 'stopped', meta: { verdict: 'pass', round: 2 } }), modeSettings('hidden'));
  assert.match(text(reviewed), /第 2 轮.*评审通过.*已停止/);
  assert.equal(metaNodes(reviewed).length, 0);
  assert.match(text(row(message({ status: 'error', error: 'test failure' }), modeSettings('hidden'))), /错误：test failure/);
});

test('preserves header typing-label fix and three-dot bubble/loading cursor behavior', () => {
  for (const status of ['pending', 'streaming', 'done', 'stopped', 'error']) {
    for (const content of ['', 'Some text']) {
      const tree = row(message({ status, text: content }));
      const streaming = ['pending', 'streaming'].includes(status);
      assert.equal(walk(tree).filter(node => node.type === client.TypingDots).length, streaming && !content ? 1 : 0);
      assert.equal(walk(tree).filter(node => node.props?.className === 'bt-cursor').length, streaming && !!content ? 1 : 0);
      assert.equal((text(tree).match(/正在输入/g) || []).length, streaming ? 1 : 0);
    }
  }
  assert.equal(walk(client.TypingDots()).filter(node => node.props?.className === 'bt-typing-dot').length, 3);
});

test('settings button is available with no groups, alongside the existing Bot manager', () => {
  const actions = [];
  const tree = client.GroupList({ state: client.initialState, dispatch: action => actions.push(action) });
  const settingsButton = walk(tree).find(node => node.props?.['aria-label'] === 'Bot Team 设置');
  assert.ok(settingsButton);
  settingsButton.props.onClick();
  assert.deepEqual(plain(actions[0]), { type: 'dialog', dialog: { kind: 'settings', initialTab: 'messages' } });
  button(tree, 'Bot 管理').props.onClick();
  assert.equal(actions[1].dialog.kind, 'bots');
});

test('sidebar actions stack with shared heights and aligned icon/text layout', () => {
  const tree = client.GroupList({ state: client.initialState, dispatch() {} });
  const footer = walk(tree).find(node => node.props?.className === 'bt-sidebar-actions');
  assert.equal(footer.props.style.display, 'grid');
  assert.equal(footer.props.style.gridTemplateColumns, 'minmax(0, 1fr)');
  const actions = footer.props.children.filter(node => node.type === 'button');
  assert.equal(actions.length, 2);
  assert.equal(actions[0].props.style, actions[1].props.style, 'one shared style prevents height drift');
  for (const action of actions) {
    const style = action.props.style;
    assert.equal(style.height, 40);
    assert.equal(style.width, '100%');
    assert.equal(style.boxSizing, 'border-box');
    assert.equal(style.display, 'inline-flex');
    assert.equal(style.alignItems, 'center');
    assert.equal(style.justifyContent, 'flex-start');
    assert.equal(style.lineHeight, '20px');
    assert.equal(style.border, 0, 'quiet toolbar rather than two heavy outlined buttons');
    const icon = action.props.children.find(node => node.type === 'svg');
    assert.equal(icon.props.width, 16);
    assert.equal(icon.props.height, 16);
    assert.equal(icon.props.style.display, 'block', 'no inline-SVG baseline gap');
    assert.equal(icon.props.style.flex, '0 0 16px');
    assert.equal(icon.props['aria-hidden'], true);
    assert.equal(icon.props.focusable, false);
    assert.ok(action.props.children.some(node => node.type === 'span' && text(node)));
  }
  assert.match(client.GLOBAL_CSS, /\.bt-sidebar-action:hover \{ background: var\(--bt-hover\)/);
});

test('saved/bootstrap/SSE settings apply globally and survive group switches', () => {
  const settings = { ...modeSettings('always'), speed: 'hidden' };
  let state = client.reducer(client.initialState, { type: 'bootstrap', data: { groups: [{ groupId: 'g1' }, { groupId: 'g2' }], chatDisplaySettings: settings } });
  assert.deepEqual(plain(state.chatDisplaySettings), settings);
  state = client.reducer(state, { type: 'selectGroup', groupId: 'g2' });
  assert.deepEqual(plain(state.chatDisplaySettings), settings);
  state = client.reducer(state, { type: 'chatDisplaySettings', settings: modeSettings('hidden') });
  state = client.reducer(state, { type: 'sse', frame: { type: 'settings.updated', chatDisplaySettings: settings } });
  assert.deepEqual(plain(state.chatDisplaySettings), settings);
  state = client.reducer(state, { type: 'sse', frame: { type: 'hello', chatDisplaySettings: modeSettings('hover') } });
  assert.deepEqual(plain(state.chatDisplaySettings), modeSettings('hover'));
  const list = client.MessageList({ messages: [message()], chatDisplaySettings: settings });
  assert.equal(walk(list).find(node => node.type === client.MessageRow).props.chatDisplaySettings, settings);
});

test('page passes global settings to dialog without a selected group, and to the active message list', () => {
  const settings = modeSettings('always');
  const pluginInfo = { packageName: 'dsh-bot-team', version: '9.9.9', author: 'Tester' };
  const noGroup = loadClient({ state: { ...client.initialState, loading: false, plugins: null, pluginInfo, chatDisplaySettings: settings, dialog: { kind: 'settings' } } });
  const page = noGroup.render(noGroup.BotTeamPage);
  assert.deepEqual(walk(page).find(node => node.type === noGroup.ChatSettingsDialog).props.settings, settings);
  assert.deepEqual(walk(page).find(node => node.type === noGroup.ChatSettingsDialog).props.pluginInfo, pluginInfo);
  const active = loadClient({ state: { ...client.initialState, loading: false, activeGroupId: 'g1', groups: [{ groupId: 'g1', title: 'Group' }], messagesByGroup: { g1: [message()] }, chatDisplaySettings: settings } });
  assert.deepEqual(walk(active.render(active.BotTeamPage)).find(node => node.type === active.MessageList).props.chatDisplaySettings, settings);
});

test('SSE subscribes to settings updates and reconnect hello, and cleans up', () => {
  const listeners = new Map();
  let closed = false;
  const actions = [];
  const local = loadClient({ EventSource: class {
    addEventListener(type, handler) { listeners.set(type, handler); }
    removeEventListener(type) { listeners.delete(type); }
    close() { closed = true; }
  } });
  local.useSse('g1', action => actions.push(action));
  const cleanup = local.effects[0]();
  const settings = modeSettings('always');
  listeners.get('settings.updated')({ data: JSON.stringify({ chatDisplaySettings: settings }) });
  assert.deepEqual(plain(actions[0].frame.chatDisplaySettings), settings);
  assert.equal(actions[0].frame.type, 'settings.updated');
  cleanup();
  assert.equal(closed, true);
  assert.equal(listeners.size, 0);
});

function dialogFixture(options = {}) {
  const saved = [];
  const requests = [];
  let closed = 0;
  const local = loadClient({ fetch: async (url, init) => {
    requests.push({ url, ...init });
    if (options.fetch) return options.fetch(url, init);
    return { json: async () => ({ ok: true, result: { chatDisplaySettings: JSON.parse(init.body).payload.settings } }) };
  } });
  const props = { settings: options.settings || modeSettings('hover'), pluginInfo: options.pluginInfo || null, onClose: () => closed++, onSaved: settings => saved.push(settings) };
  const render = () => local.render(local.ChatSettingsDialog, props);
  const change = (key, mode) => {
    const group = walk(render()).find(node => node.props?.['aria-labelledby'] === 'bt-display-' + key);
    const label = local.CHAT_DISPLAY_MODES.find(item => item.value === mode).label;
    button(group, label).props.onClick();
  };
  return { local, props, saved, requests, render, change, closed: () => closed };
}

test('dialog has 4 accessible mode groups, previews edits, saves once and returns authoritative settings', async () => {
  const fixture = dialogFixture();
  assert.equal(walk(fixture.render()).filter(node => node.props?.role === 'group').length, 4);
  assert.equal(walk(fixture.render()).filter(node => node.props?.['aria-pressed'] === true).length, 4);
  assert.equal(button(fixture.render(), '保存设置').props.disabled, true);
  fixture.change('model', 'hidden');
  fixture.change('speed', 'always');
  assert.equal(metaNodes(fixture.render()).some(node => node.props['data-meta'] === 'model'), false);
  assert.equal(fixture.requests.length, 0, 'preview is not persisted before Save');
  await button(fixture.render(), '保存设置').props.onClick();
  assert.equal(fixture.requests.length, 1);
  const sent = JSON.parse(fixture.requests[0].body);
  assert.equal(sent.action, 'settings.chatDisplay.update');
  assert.deepEqual(sent.payload.settings, { ...modeSettings('hover'), model: 'hidden', speed: 'always' });
  assert.deepEqual(plain(fixture.saved[0]), sent.payload.settings);
});

test('settings dialog separates storage and about while preserving message controls', () => {
  const fixture = dialogFixture({
    pluginInfo: { packageName: '@local/bot-team-test', version: '9.9.9', author: '测试开发者' },
  });
  const initial = fixture.render();
  const tabs = walk(initial).filter(node => node.props?.role === 'tab');
  assert.deepEqual(plain(tabs.map(node => text(node))), ['消息设置', '侧边栏设置', '数据存储', '关于']);
  assert.equal(tabs[0].props['aria-selected'], true);
  assert.equal(tabs[1].props['aria-selected'], false);
  assert.equal(button(initial, '保存设置').props.disabled, true);

  button(initial, '关于').props.onClick();
  const about = fixture.render();
  const aboutTabs = walk(about).filter(node => node.props?.role === 'tab');
  assert.equal(aboutTabs[3].props['aria-selected'], true);
  assert.doesNotMatch(text(about), /\$DSH_HOME/);
  assert.ok(button(about, '版本检测'));
  button(about, '数据存储').props.onClick();
  const storage = fixture.render();
  assert.match(text(storage), /\$DSH_HOME\/storages\/dsh-bot-team/);
  assert.match(text(storage), /\$DSH_HOME\/dsh-bot-team\/bots\/<botId>\/BOT[.]md/);
  assert.equal(button(storage, '保存设置'), undefined);
  assert.equal(button(storage, '恢复默认'), undefined);
  assert.ok(button(storage, '关闭'));
  button(storage, '关于').props.onClick();
  assert.match(text(about), /插件说明、版本号与开发者信息/);
  assert.match(text(about), /单聊与多 Agent 群聊/);
  assert.match(text(about), /9\.9\.9/);
  assert.match(text(about), /测试开发者/);
  assert.match(text(about), /@local\/bot-team-test/);
  assert.equal(button(about, '保存设置'), undefined, 'about has no save action');
  assert.equal(button(about, '恢复默认'), undefined);
  assert.ok(button(about, '关闭'));
  button(about, '关闭').props.onClick();
  assert.equal(fixture.closed(), 1);

  // Switching back keeps the message controls (and local edits) available.
  const backFixture = dialogFixture();
  button(backFixture.render(), '关于').props.onClick();
  button(backFixture.render(), '消息设置').props.onClick();
  assert.equal(walk(backFixture.render()).filter(node => node.props?.['role'] === 'group').length, 4);
  assert.ok(button(backFixture.render(), '保存设置'));
});

test('open dialog follows remote saves on untouched fields without overwriting them on a local save', async () => {
  const fixture = dialogFixture();
  fixture.props.settings = { ...modeSettings('hover'), model: 'hidden' };
  assert.equal(button(fixture.render(), '保存设置').props.disabled, true, 'remote updates are not unsaved local edits');
  assert.equal(metaNodes(fixture.render()).some(node => node.props['data-meta'] === 'model'), false);
  fixture.change('speed', 'always');
  fixture.props.settings = { ...fixture.props.settings, inputTokens: 'hidden' };
  await button(fixture.render(), '保存设置').props.onClick();
  assert.deepEqual(plain(fixture.saved[0]), { model: 'hidden', inputTokens: 'hidden', outputTokens: 'hover', speed: 'always' });
});

test('cancel and restore-default preview do not write until Save', () => {
  const fixture = dialogFixture({ settings: modeSettings('always') });
  button(fixture.render(), '恢复默认').props.onClick();
  assert.equal(walk(fixture.render()).filter(node => node.props?.['aria-pressed'] === true && text(node) === '悬停显示').length, 4);
  button(fixture.render(), '取消').props.onClick();
  assert.equal(fixture.closed(), 1);
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.saved.length, 0);
});

test('failed persistence shows an error and retains the draft for retry; busy controls prevent closing', async () => {
  let resolveResponse;
  const fixture = dialogFixture({ fetch: () => new Promise(resolve => { resolveResponse = resolve; }) });
  fixture.change('model', 'always');
  const pending = button(fixture.render(), '保存设置').props.onClick();
  const busy = fixture.render();
  assert.equal(button(busy, '保存中…').props.disabled, true);
  assert.ok(walk(busy).filter(node => node.props?.['aria-pressed'] !== undefined).every(node => node.props.disabled));
  busy.props.onClose();
  assert.equal(fixture.closed(), 0);
  resolveResponse({ json: async () => ({ ok: false, error: { message: 'disk full' } }) });
  await pending;
  assert.match(text(walk(fixture.render()).find(node => node.props?.role === 'alert')), /disk full/);
  assert.equal(fixture.saved.length, 0);
  assert.equal(button(fixture.render(), '保存设置').props.disabled, false);
  const retry = button(fixture.render(), '保存设置').props.onClick();
  resolveResponse({ json: async () => ({ ok: true, result: { chatDisplaySettings: { ...modeSettings('hover'), model: 'always' } } }) });
  await retry;
  assert.equal(fixture.saved[0].model, 'always');
});

function focusFixture() {
  const listeners = new Map();
  const doc = {
    activeElement: null,
    addEventListener: (type, callback) => listeners.set(type, callback),
    removeEventListener: type => listeners.delete(type),
  };
  const element = name => ({
    name, isConnected: true, disabled: false, tabIndex: 0,
    getClientRects: () => [1], closest: () => null,
    focus() { doc.activeElement = this; },
  });
  const trigger = element('trigger');
  const first = element('first');
  const last = element('last');
  const disabled = { ...element('disabled'), disabled: true };
  const hidden = { ...element('hidden'), getClientRects: () => [] };
  const items = [first, last, disabled, hidden];
  const dialog = { ...element('dialog'), ownerDocument: doc, querySelectorAll: () => items, contains: target => target === dialog || items.includes(target) };
  trigger.focus();
  const key = (shiftKey = false) => {
    let prevented = false;
    listeners.get('keydown')({ key: 'Tab', shiftKey, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  return { doc, listeners, trigger, first, last, dialog, items, key };
}

test('modal focuses within, traps Tab/Shift+Tab, blocks background focus and restores trigger', () => {
  const fixture = focusFixture();
  const cleanup = client.containModalFocus(fixture.dialog);
  assert.equal(fixture.doc.activeElement, fixture.first);
  assert.equal(fixture.key(), false, 'middle navigation keeps native keyboard behavior');
  assert.equal(fixture.key(true), true);
  assert.equal(fixture.doc.activeElement, fixture.last, 'disabled/hidden controls skipped');
  assert.equal(fixture.key(), true);
  assert.equal(fixture.doc.activeElement, fixture.first);
  fixture.trigger.focus();
  fixture.listeners.get('focusin')({ target: fixture.trigger });
  assert.equal(fixture.doc.activeElement, fixture.first);
  cleanup();
  assert.equal(fixture.doc.activeElement, fixture.trigger);
  assert.equal(fixture.listeners.size, 0);
});

test('modal preserves existing autofocus and handles no enabled controls without trapping cleanup', () => {
  const fixture = focusFixture();
  fixture.last.focus();
  const cleanup = client.containModalFocus(fixture.dialog);
  assert.equal(fixture.doc.activeElement, fixture.last);
  fixture.items.length = 0;
  assert.equal(fixture.key(), true);
  assert.equal(fixture.doc.activeElement, fixture.dialog);
  fixture.last.isConnected = false;
  cleanup();
  assert.equal(fixture.listeners.size, 0);
  assert.equal(client.containModalFocus(null), undefined);
  const local = loadClient();
  const modal = local.render(local.Modal, { title: 'Test', onClose() {} });
  const panel = walk(modal).find(node => node.props?.role === 'dialog');
  assert.equal(panel.props.tabIndex, -1);
  panel.props.ref.current = fixture.dialog;
  const restore = local.effects[0]();
  assert.equal(fixture.listeners.size, 2, 'Modal actually installs the focus trap');
  restore();
});

test('CSS scopes hover rules to hover fields, with keyboard and touch access; uses theme colors', () => {
  assert.match(client.GLOBAL_CSS, /\.bt-msg-meta\[data-display="hover"\] \{ opacity: 0/);
  assert.match(client.GLOBAL_CSS, /\.bt-msg:focus-within \.bt-msg-meta\[data-display="hover"\]/);
  assert.match(client.GLOBAL_CSS, /@media \(hover: none\) \{\s*\.bt-root \.bt-msg-meta\[data-display="hover"\] \{ opacity: 1/);
  assert.doesNotMatch(client.GLOBAL_CSS, /\.bt-model \{ opacity: 0/);
  assert.match(client.GLOBAL_CSS, /@media \(max-width: 560px\)/);
  assert.match(client.GLOBAL_CSS, /body\[data-ds-dark-theme\] \.bt-root/);
});
