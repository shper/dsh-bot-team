import test from 'node:test';
import assert from 'node:assert/strict';
import { loadClient, plain, walk, text } from './client-harness.js';

const ready = (overrides = {}) => ({
  instanceId: 'host-a', revision: 2, status: 'ready', currentVersion: '1.2.2',
  runtimeVersion: '0.2.1-rc.3', latestVersion: '1.3.0', availableVersion: '1.3.0',
  hasUpdate: true, compatibility: 'compatible', requiredDsh: '^0.2.1-rc.3',
  checkedAt: '2026-10-28T08:00:00Z', error: null,
  updateUrl: 'https://www.npmjs.com/package/dsh-bot-team/v/1.3.0', ...overrides,
});
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const action = (tree, name) => walk(tree).find(node => node.props?.['data-action'] === name);
const tick = () => new Promise(resolve => setImmediate(resolve));

// The page can be empty: startup update results must not depend on a chat's SSE.
test('startup status is read and polled only while the Host is checking', async () => {
  const client = loadClient();
  const changes = [];
  const timers = new Map();
  let reads = 0;
  const controller = client.createUpdateController({
    onChange: value => changes.push(plain(value)),
    fetchStatus: async () => ({ updateInfo: ++reads === 1 ? ready({ status: 'checking', revision: 1 }) : ready() }),
    check: () => { throw new Error('Reading cached status must not trigger an npm check'); },
    schedule: callback => { timers.set(1, callback); return 1; }, cancel: id => timers.delete(id),
  });
  await controller.refresh();
  assert.equal(changes[0].status, 'checking');
  assert.equal(timers.size, 1);
  const poll = timers.get(1); timers.clear(); poll();
  await tick();
  assert.equal(reads, 2);
  assert.equal(changes.at(-1).availableVersion, '1.3.0');
  assert.equal(timers.size, 0, 'completed checks do not keep polling');
  controller.dispose();
});

test('manual check publishes progress, merges double clicks, and ignores late status reads', async () => {
  const client = loadClient();
  const cached = deferred(); const manual = deferred();
  const changes = [];
  let checks = 0;
  const controller = client.createUpdateController({
    onChange: value => changes.push(plain(value)), fetchStatus: () => cached.promise,
    check: () => { checks++; return manual.promise; },
  });
  const oldRead = controller.refresh();
  const check = controller.check();
  assert.equal(changes.at(-1).status, 'checking');
  assert.equal(controller.check(), check);
  assert.equal(controller.refresh(), check, 'focus cannot interrupt a manual check');
  manual.resolve({ updateInfo: ready() });
  await check;
  cached.resolve({ updateInfo: ready({ revision: 0, latestVersion: '1.2.2', hasUpdate: false }) });
  await oldRead;
  assert.equal(checks, 1);
  assert.equal(changes.at(-1).latestVersion, '1.3.0');
  controller.dispose();
});

test('failed checks retain known version information and can be retried', async () => {
  const client = loadClient();
  const changes = []; let fail = true;
  const controller = client.createUpdateController({
    onChange: value => changes.push(plain(value)), fetchStatus: async () => ({ updateInfo: ready() }),
    check: async () => { if (fail) throw new Error('offline'); return { updateInfo: ready({ revision: 4 }) }; },
  });
  await controller.refresh(); await controller.check();
  assert.equal(changes.at(-1).status, 'error');
  assert.equal(changes.at(-1).error, 'offline');
  assert.equal(changes.at(-1).availableVersion, '1.3.0');
  fail = false; await controller.check();
  assert.equal(changes.at(-1).status, 'ready');
  controller.dispose();
});

test('a newer bootstrap cannot swallow a local transport failure or keep retry disabled', async () => {
  const client = loadClient();
  let state = client.initialState;
  const pending = deferred();
  const controller = client.createUpdateController({
    onChange: (updateInfo, local) => {
      state = client.reducer(state, local
        ? { type: 'updateRequestStatus', status: { status: updateInfo.status, error: updateInfo.error } }
        : { type: 'updateInfo', updateInfo });
    },
    fetchStatus: async () => ({ updateInfo: ready() }),
    check: () => pending.promise,
  });
  await controller.refresh();
  const request = controller.check();
  state = client.reducer(state, { type: 'bootstrap', data: { updateInfo: ready({ revision: 3, status: 'checking', latestVersion: '1.4.0' }) } });
  pending.reject(new Error('connection lost')); await request;
  // A subsequent chat refresh must not erase the browser's transport failure.
  state = client.reducer(state, { type: 'bootstrap', data: { updateInfo: ready({ revision: 3, status: 'checking', latestVersion: '1.4.0' }) } });
  const display = { ...state.updateInfo, ...state.updateRequestStatus };
  assert.equal(display.status, 'error');
  assert.equal(display.latestVersion, '1.4.0', 'the authoritative version fields are preserved');
  const panel = client.renderUpdatePanel({ updateInfo: display, onCheckUpdate() {} });
  assert.equal(action(panel, 'check-update').props.disabled, false);
  assert.match(text(panel), /connection lost/);
  state = client.reducer(state, { type: 'updateInfo', updateInfo: ready({ revision: 4 }) });
  assert.equal(state.updateRequestStatus, null, 'a successful response clears the local failure');
  assert.equal(state.updateInfo.status, 'ready');
  controller.dispose();
});

test('disposing aborts requests and discards late updates', async () => {
  const client = loadClient(); const pending = deferred(); const changes = []; let signal;
  const controller = client.createUpdateController({
    onChange: value => changes.push(value), fetchStatus: value => { signal = value; return pending.promise; },
  });
  const request = controller.refresh(); controller.dispose();
  assert.equal(signal.aborted, true);
  pending.resolve({ updateInfo: ready() }); await request;
  assert.equal(changes.length, 0);
});

test('older bootstrap snapshots do not erase a finished check; Host restarts reset the revision', () => {
  const client = loadClient();
  let state = client.reducer(client.initialState, { type: 'updateInfo', updateInfo: ready() });
  state = client.reducer(state, { type: 'bootstrap', data: { updateInfo: ready({ revision: 1, status: 'checking' }) } });
  assert.equal(state.updateInfo.status, 'ready');
  state = client.reducer(state, { type: 'updateInfo', updateInfo: ready({ instanceId: 'host-b', revision: 0, status: 'checking' }) });
  assert.equal(state.updateInfo.instanceId, 'host-b');
  assert.equal(state.updateInfo.status, 'checking');
});

test('about distinguishes latest incompatible release from the compatible update and provides working actions', async () => {
  const client = loadClient(); let checks = 0; let opens = 0;
  const props = { initialTab: 'about', pluginInfo: { version: '1.2.2' },
    updateInfo: ready({ latestVersion: '2.0.0', compatibility: 'incompatible', requiredDsh: '^0.3.0' }),
    onCheckUpdate: async () => { checks++; }, onOpenUpdate: () => { opens++; }, onClose() {}, onSaved() {},
  };
  const tree = client.render(client.ChatSettingsDialog, props);
  assert.match(text(tree), /2[.]0[.]0/); assert.match(text(tree), /1[.]3[.]0/);
  assert.match(text(tree), /不兼容/); assert.match(text(tree), /dsh-bot-team@1[.]3[.]0/);
  assert.ok(walk(tree).some(node => node.type === 'a' && node.props.href.endsWith('/blob/main/CHANGELOG.md')));
  await action(tree, 'check-update').props.onClick(); action(tree, 'open-update').props.onClick();
  assert.equal(checks, 1); assert.equal(opens, 1);
  props.updateInfo = ready({ status: 'checking' });
  assert.equal(action(client.render(client.ChatSettingsDialog, props), 'check-update').props.disabled, true);
  props.updateInfo = ready({ availableVersion: null, hasUpdate: false, compatibility: 'unknown', runtimeVersion: null });
  const unknown = client.render(client.ChatSettingsDialog, props);
  assert.equal(action(unknown, 'open-update').props.disabled, true);
  assert.match(text(unknown), /无法确认/);
});

test('settings has an update dot in expanded and collapsed sidebars and opens About', () => {
  for (const sidebarCollapsed of [false, true]) {
    const client = loadClient(); const actions = [];
    const tree = client.render(client.GroupList, { state: { ...client.initialState, sidebarCollapsed, updateInfo: ready() }, dispatch: value => actions.push(value) });
    const settings = walk(tree).find(node => node.props?.className?.includes('bt-settings-button'));
    assert.match(settings.props['aria-label'], /有可用更新/);
    assert.ok(walk(settings).some(node => node.props?.className?.includes('bt-update-dot')));
    settings.props.onClick();
    assert.deepEqual(plain(actions[0]), { type: 'dialog', dialog: { kind: 'settings', initialTab: 'about' } });
  }
});

test('the update entry navigates to DSH Plugins without requiring a group', () => {
  const client = loadClient({ state: { ...loadClient().initialState, loading: false, updateInfo: ready(), dialog: { kind: 'settings', initialTab: 'about' } } });
  const panels = [];
  client.apply({ effect: fn => fn(), locale: { register() {}, bind: () => key => key, getSnapshot: () => ({ active: 'zh' }) }, slots: { inject() {} }, layout: { selectPanel: id => panels.push(id) } });
  const dialog = walk(client.render(client.BotTeamPage)).find(node => node.type === client.ChatSettingsDialog);
  assert.equal(dialog.props.updateInfo.availableVersion, '1.3.0');
  assert.equal(dialog.props.initialTab, 'about');
  dialog.props.onOpenUpdate();
  assert.deepEqual(panels, ['plugins']);
});

test('English update and storage chrome is translated while diagnostics remain verbatim', () => {
  const client = loadClient(); client.setTestLocale('en');
  const tree = client.render(client.ChatSettingsDialog, { initialTab: 'about', updateInfo: ready({ status: 'error', error: 'npm 返回错误', releaseNotes: '- 修复会话问题\n- **Improve startup**', releaseNotesVersion: '1.3.0' }), onCheckUpdate() {}, onOpenUpdate() {} });
  assert.match(text(tree), /Check for updates/); assert.match(text(tree), /View release notes/);
  assert.match(text(tree), /npm 返回错误/);
  assert.match(text(tree), /Release notes · 1[.]3[.]0/);
  assert.match(text(tree), /修复会话问题/);
  assert.ok(walk(tree).some(node => node.type === 'strong' && text(node) === 'Improve startup'));
  const storageTab = walk(tree).find(node => node.props?.id === 'bt-settings-tab-storage');
  assert.equal(text(storageTab), 'Data storage');
});
