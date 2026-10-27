import test from 'node:test';
import assert from 'node:assert/strict';
import { loadClient, walk, text, plain } from './client-harness.js';

const noop = () => {};
const settle = () => new Promise(resolve => setImmediate(resolve));
const group = { groupId: 'project-chat', kind: 'direct', title: 'Developer', workspaceCwd: '/default/chat', projectWorkspaceCwd: '' };
const props = (overrides = {}) => ({ group, locked: false, onClose: noop, onSaved: noop, ...overrides });
const button = (tree, label) => {
  const result = walk(tree).find(node => node.type === 'button' && text(node) === label);
  assert.ok(result, 'button: ' + label);
  return result;
};
const input = tree => walk(tree).find(node => node.type === 'input' && node.props.className === 'bt-project-path');
const composerProps = (overrides = {}) => ({ state: { statusByMember: {} }, dispatch: noop, group, members: [], bots: [], ...overrides });

function applyContext(client, uiWorkspace) {
  client.apply({
    uiWorkspace, remote: {}, effect() {},
    locale: { register() {}, bind: () => (key, params = {}) => Object.entries(params).reduce((value, [name, replacement]) => value.replaceAll('{' + name + '}', replacement), key), getSnapshot: () => ({ active: 'zh' }) },
    slots: { inject() {} },
  });
}

test('folder menu is available in both chat types and opens the project dialog', () => {
  for (const kind of ['direct', 'group']) {
    const client = loadClient();
    const options = composerProps({ group: { ...group, kind } });
    let tree = client.render(client.Composer, options);
    walk(tree).find(node => node.props?.className === 'bt-add-btn').props.onClick();
    tree = client.render(client.Composer, options);
    const folder = walk(tree).find(node => node.props?.role === 'menuitem' && text(node).includes('引入项目'));
    assert.ok(folder);
    assert.equal(folder.props.disabled, false);
    folder.props.onClick();
    tree = client.render(client.Composer, options);
    const dialog = walk(tree).find(node => node.type === client.ProjectWorkspaceDialog);
    assert.equal(dialog.props.group.groupId, group.groupId);
  }
});

test('native cancellation and errors retain the draft without invoking a second picker', async () => {
  let hostCalls = 0;
  let rejectPicker = false;
  const client = loadClient({ window: { __DSH_DIRECTORY_PICKER__: { pick: async () => {
    if (rejectPicker) throw new Error('native picker unavailable');
    return null;
  } } } });
  applyContext(client, { pickDirectory: async () => { hostCalls += 1; return '/wrong'; } });
  const options = props({ group: { ...group, projectWorkspaceCwd: '/Users/example/项目 with spaces' } });
  let tree = client.render(client.ProjectWorkspaceDialog, options);
  button(tree, '选择文件夹…').props.onClick();
  await settle();
  tree = client.render(client.ProjectWorkspaceDialog, options);
  assert.equal(input(tree).props.value, options.group.projectWorkspaceCwd);
  assert.equal(hostCalls, 0);
  rejectPicker = true;
  button(tree, '选择文件夹…').props.onClick();
  await settle();
  tree = client.render(client.ProjectWorkspaceDialog, options);
  assert.match(text(tree), /native picker unavailable/);
  assert.equal(input(tree).props.value, options.group.projectWorkspaceCwd);
  assert.equal(hostCalls, 0);
});

test('the ordinary Web client uses DSH host directory picker and saves only on submit', async () => {
  const requests = [], saved = [];
  const chosen = '/Users/example/项目 with spaces';
  const client = loadClient({ fetch: async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { json: async () => ({ ok: true, result: { ...group, workspaceCwd: chosen, projectWorkspaceCwd: chosen } }) };
  } });
  applyContext(client, { pickDirectory: async () => chosen });
  const options = props({ onSaved: value => saved.push(plain(value)) });
  let tree = client.render(client.ProjectWorkspaceDialog, options);
  assert.equal(button(tree, '引入项目').props.disabled, true);
  button(tree, '选择文件夹…').props.onClick();
  await settle();
  tree = client.render(client.ProjectWorkspaceDialog, options);
  assert.equal(input(tree).props.value, chosen);
  assert.equal(requests.length, 0);
  button(tree, '引入项目').props.onClick();
  button(tree, '引入项目').props.onClick();
  await settle();
  assert.equal(requests.length, 1, 'double clicks cannot dispatch duplicate changes');
  assert.equal(requests[0].url, '/api/bot-team.action');
  assert.deepEqual(requests[0].body, { action: 'group.workspace.set', payload: { groupId: group.groupId, workspaceCwd: chosen } });
  assert.equal(saved[0].projectWorkspaceCwd, chosen);
});

test('missing picker supports manual paths and server errors preserve the editable draft', async () => {
  const client = loadClient({ fetch: async () => ({ json: async () => ({ ok: false, error: { code: 'invalid-input', message: 'Directory does not exist' } }) }) });
  const options = props();
  let tree = client.render(client.ProjectWorkspaceDialog, options);
  button(tree, '选择文件夹…').props.onClick();
  await settle();
  tree = client.render(client.ProjectWorkspaceDialog, options);
  assert.match(text(tree), /绝对路径/);
  input(tree).props.onChange({ target: { value: '/missing/project' } });
  tree = client.render(client.ProjectWorkspaceDialog, options);
  button(tree, '引入项目').props.onClick();
  await settle();
  tree = client.render(client.ProjectWorkspaceDialog, options);
  assert.match(text(tree), /Directory does not exist/);
  assert.equal(input(tree).props.value, '/missing/project');
  assert.equal(input(tree).props.disabled, false);
});

test('a late directory-picker result is discarded after closing the dialog', async () => {
  let resolvePicker;
  const client = loadClient({ lifecycleEffects: true, window: { __DSH_DIRECTORY_PICKER__: { pick: () => new Promise(resolve => { resolvePicker = resolve; }) } } });
  const options = props();
  const tree = client.render(client.ProjectWorkspaceDialog, options);
  client.flushEffects();
  button(tree, '选择文件夹…').props.onClick();
  client.unmount();
  resolvePicker('/late/project');
  await settle();
  const next = client.render(client.ProjectWorkspaceDialog, options);
  assert.equal(input(next).props.value, '');
});

test('project removal updates only its conversation and disables sending while pending', async () => {
  const frames = [], calls = [];
  let resolveRequest;
  const client = loadClient({ fetch: async (url, options) => {
    calls.push(JSON.parse(options.body));
    return new Promise(resolve => { resolveRequest = resolve; });
  } });
  const selected = { ...group, workspaceCwd: '/project', projectWorkspaceCwd: '/project' };
  let options = composerProps({ group: selected, dispatch: frame => frames.push(plain(frame)) });
  let tree = client.render(client.Composer, options);
  assert.match(text(tree), /当前项目/);
  assert.ok(text(tree).includes('/project'));
  walk(tree).find(node => node.type === 'textarea').props.onChange({ target: { value: 'search this project', selectionStart: 19 } });
  tree = client.render(client.Composer, options);
  walk(tree).find(node => node.props?.['aria-label'] === '移除项目，恢复默认工作目录').props.onClick();
  tree = client.render(client.Composer, options);
  assert.equal(button(tree, '发送').props.disabled, true);
  assert.deepEqual(calls, [{ action: 'group.workspace.set', payload: { groupId: group.groupId, workspaceCwd: '' } }]);
  options = { ...options, group: { ...group, groupId: 'another-chat', projectWorkspaceCwd: '/another' } };
  client.render(client.Composer, options);
  resolveRequest({ json: async () => ({ ok: true, result: group }) });
  await settle();
  assert.equal(frames[0].frame.group.groupId, group.groupId);
  assert.equal(frames[0].frame.group.projectWorkspaceCwd, '');
  const state = { groups: [selected, options.group] };
  const next = client.reducer(state, frames[0]);
  assert.equal(next.groups[0].projectWorkspaceCwd, '');
  assert.equal(next.groups[1].projectWorkspaceCwd, '/another');
});

test('running and queued work prevents project changes; an existing project remains visible', () => {
  for (const status of ['running', 'queued']) {
    const client = loadClient();
    const options = composerProps({
      group: { ...group, projectWorkspaceCwd: '/project' },
      members: [{ membershipId: 'm1', botId: 'b1' }],
      state: { statusByMember: { m1: status } },
    });
    let tree = client.render(client.Composer, options);
    assert.match(text(tree), /当前项目/);
    assert.equal(button(tree, '更换').props.disabled, true);
    assert.equal(walk(tree).find(node => node.props?.['aria-label'] === '移除项目，恢复默认工作目录').props.disabled, true);
    walk(tree).find(node => node.props?.className === 'bt-add-btn').props.onClick();
    tree = client.render(client.Composer, options);
    assert.equal(walk(tree).find(node => node.props?.role === 'menuitem' && text(node).includes('folder')).props.disabled, true);
  }
});

test('English project controls keep the selected path verbatim', () => {
  const client = loadClient();
  client.setTestLocale('en');
  const tree = client.render(client.ProjectWorkspaceDialog, props({ group: { ...group, projectWorkspaceCwd: '/项目/设置' } }));
  assert.equal(tree.props.title, 'Add folder / project');
  assert.equal(input(tree).props.value, '/项目/设置');
  assert.ok(button(tree, 'Choose folder…'));
  assert.ok(button(tree, 'Add project'));
});
