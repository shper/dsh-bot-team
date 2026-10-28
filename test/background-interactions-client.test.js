import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadClient, walk, text, plain } from './client-harness.js';

function fixture(fetch) {
  let definition, cursor = 0;
  const hooks = [], effects = [];
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) { return { type, props: { ...props, children: children.flat(Infinity).filter(item => item !== false && item != null) } }; },
    useState(value) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof value === 'function' ? value() : value;
      return [hooks[index], next => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next; }];
    },
    useRef(value) { return React.useState(() => ({ current: value }))[0]; },
    useEffect(effect, deps) {
      const index = cursor++;
      if (!hooks[index] || deps.some((value, i) => value !== hooks[index].deps[i])) {
        hooks[index]?.cleanup?.();
        hooks[index] = { deps, effect };
        effects.push(() => { hooks[index].cleanup = effect(); });
      }
    },
  };
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const context = vm.createContext({ console, URL, Blob, AbortController, setTimeout, clearTimeout, fetch,
    window: { __ModuleLoader__: { load: value => { definition = value; } } } });
  // The client has one plugin return with this indentation.
  const anchor = ['    return {', '      inject:'].join('\n');
  const exposed = 'BackgroundInteractionCard, BackgroundInteractionPanel, backgroundAnswer, initialState, reducer, setTestLocale';
  assert.ok(source.includes(anchor));
  vm.runInContext(source.replace(anchor, '    return {\n      __test: { ' + exposed + ' },\n      inject:'), context);
  const client = definition.factory(name => { assert.equal(name, 'react'); return React; }).__test;
  return { ...client, render(Component, props) { cursor = 0; return Component(props); },
    effects() { for (const effect of effects.splice(0)) effect(); },
    unmount() { for (const hook of hooks) hook?.cleanup?.(); } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const questions = [{ id: 'choice', question: 'Raw question?', detail: 'Exact detail', options: [{ label: 'A', description: 'Alpha' }, { label: 'B' }], multiSelect: true }, { id: 'notes', question: 'Notes?' }];
const interaction = { interactionId: 'interaction', groupId: 'group', sessionId: 'session', botName: 'Bot', kind: 'question', state: 'pending', timed: true, questions };
const button = (tree, label) => walk(tree).find(node => node.type === 'button' && text(node) === label);
const response = data => ({ ok: true, status: 200, json: async () => ({ ok: true, ...data }) });

test('question form preserves native selections and text and sends exact ownership identifiers', async () => {
  const calls = [], snapshots = [];
  const client = fixture(async (url, init) => { calls.push(JSON.parse(init.body)); return response({ groupId: 'group', epoch: 'e', revision: 2, interactions: [] }); });
  const props = { interaction, onSnapshot: value => snapshots.push(value) };
  let tree = client.render(client.BackgroundInteractionCard, props);
  client.effects();
  assert.match(text(tree), /Raw question\?Exact detail/);
  let options = walk(tree).filter(node => node.type === 'input');
  options[0].props.onChange({ target: { checked: true } });
  tree = client.render(client.BackgroundInteractionCard, props);
  options = walk(tree).filter(node => node.type === 'input');
  options[1].props.onChange({ target: { checked: true } });
  tree = client.render(client.BackgroundInteractionCard, props);
  walk(tree).filter(node => node.type === 'textarea')[1].props.onChange({ target: { value: 'exact\ntext' } });
  tree = client.render(client.BackgroundInteractionCard, props);
  await button(tree, '提交答案').props.onClick();
  assert.deepEqual(calls, [{ action: 'interaction.respond', payload: {
    groupId: 'group', sessionId: 'session', interactionId: 'interaction', operation: 'answer',
    answer: { answers: [{ id: 'choice', selected: ['A', 'B'] }, { id: 'notes', selected: [], custom: 'exact\ntext' }] },
  } }]);
  assert.equal(snapshots.length, 1);
  client.unmount();
});

test('question submit errors remain visible and duplicate in-flight submissions are prevented', async () => {
  let reject, count = 0;
  const client = fixture(() => { count++; return new Promise((resolve, fail) => { reject = fail; }); });
  const props = { interaction, onSnapshot: () => assert.fail('must not publish an error') };
  let tree = client.render(client.BackgroundInteractionCard, props);
  const submit = button(tree, '提交答案').props.onClick;
  const first = submit();
  await submit();
  assert.equal(count, 1);
  reject(new Error('temporary network failure'));
  await first;
  tree = client.render(client.BackgroundInteractionCard, props);
  assert.match(text(walk(tree).find(node => node.props?.role === 'alert')), /temporary network failure/);
  assert.equal(button(tree, '提交答案').props.disabled, false);
});

test('approval decisions and question cancellation use scoped service actions', async () => {
  for (const [kind, label, fields] of [['approval', '允许一次', { operation: 'answer', outcome: 'allowed-once' }], ['approval', '拒绝', { operation: 'answer', outcome: 'rejected' }], ['question', '取消提问', { operation: 'cancel' }], ['question', '稍后回答，继续执行', { operation: 'continue' }]]) {
    let request;
    const client = fixture(async (url, init) => { request = JSON.parse(init.body); return response({ interactions: [] }); });
    const tree = client.render(client.BackgroundInteractionCard, { interaction: { ...interaction, kind, toolName: 'bash', reason: 'Native reason' }, onSnapshot() {} });
    await button(tree, label).props.onClick();
    assert.deepEqual(request.payload, { groupId: 'group', sessionId: 'session', interactionId: 'interaction', ...fields });
  }
});

test('continued questions accept late answers while queued ones have no action controls', () => {
  const client = fixture(() => assert.fail('no request during rendering'));
  const continued = client.render(client.BackgroundInteractionCard, { interaction: { ...interaction, state: 'continued' }, onSnapshot() {} });
  assert.ok(button(continued, '提交答案'));
  assert.equal(button(continued, '取消提问'), undefined);
  assert.equal(button(continued, '稍后回答，继续执行'), undefined);
  const queued = client.render(client.BackgroundInteractionCard, { interaction: { ...interaction, state: 'queued' }, onSnapshot() {} });
  assert.equal(button(queued, '提交答案'), undefined);
  assert.match(text(queued), /答案已提交/);
});

test('panel reloads on reconnect invalidation and ignores a prior group response', async () => {
  const loads = [], actions = [];
  const client = fixture((url, init) => new Promise(resolve => loads.push({ payload: JSON.parse(init.body).payload, resolve })));
  const dispatch = action => actions.push(action);
  client.render(client.BackgroundInteractionPanel, { groupId: 'old', refreshTick: 1, dispatch });
  client.effects();
  client.render(client.BackgroundInteractionPanel, { groupId: 'new', refreshTick: 1, dispatch });
  client.effects();
  loads[0].resolve(response({ groupId: 'old', interactions: [interaction] }));
  loads[1].resolve(response({ groupId: 'new', interactions: [] }));
  await tick();
  assert.equal(actions.length, 1);
  assert.equal(actions[0].data.groupId, 'new');
  client.render(client.BackgroundInteractionPanel, { groupId: 'new', refreshTick: 2, dispatch });
  client.effects();
  assert.equal(loads.length, 3);
  assert.deepEqual(loads[2].payload, { groupId: 'new' });
  loads[2].resolve(response({ groupId: 'new', interactions: [] }));
  await tick();
  client.unmount();
});

test('SSE forwards interaction snapshots and reconnect invalidates pending-card queries', () => {
  let source;
  const actions = [];
  class Events {
    constructor() { source = this; this.listeners = new Map(); }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    removeEventListener(type) { this.listeners.delete(type); }
    close() { this.closed = true; }
    emit(type, value) { this.listeners.get(type)({ data: JSON.stringify(value) }); }
  }
  const client = loadClient({ EventSource: Events, lifecycleEffects: true });
  client.render(() => client.useSse('group', action => actions.push(action)), {});
  client.flushEffects();
  source.emit('interaction.updated', { groupId: 'group', revision: 3, interactions: [interaction] });
  assert.equal(actions[0].frame.type, 'interaction.updated');
  source.emit('hello', { groupId: 'group' });
  assert.ok(actions.some(action => action.type === 'messagesTick'));
  client.unmount();
  assert.equal(source.closed, true);
  assert.equal(source.listeners.size, 0);
});

test('English controls preserve untranslated native questions, option descriptions, and bot names', () => {
  const client = fixture(() => assert.fail('rendering does not submit'));
  client.setTestLocale('en');
  const tree = client.render(client.BackgroundInteractionCard, { interaction: { ...interaction, botName: '取消',
    questions: [{ id: 'raw', question: '保存', detail: '取消', options: [{ label: '取消', description: '保存' }] }] }, onSnapshot() {} });
  assert.ok(button(tree, 'Submit answers'));
  assert.match(text(tree), /取消/);
  assert.match(text(tree), /保存/);
  assert.equal(walk(tree).find(node => node.type === 'small').props.children[0], '保存');
});

test('interaction reducer keeps latest revision and permits a new service epoch', () => {
  const { reducer, initialState } = loadClient();
  const newest = { groupId: 'group', epoch: 'first', revision: 4, interactions: [interaction] };
  let state = reducer(initialState, { type: 'sse', frame: { type: 'interaction.updated', ...newest } });
  state = reducer(state, { type: 'interactions', data: { ...newest, revision: 2, interactions: [] } });
  assert.equal(state.interactionsByGroup.group.interactions.length, 1);
  state = reducer(state, { type: 'interactions', data: { ...newest, epoch: 'reloaded', revision: 0, interactions: [] } });
  assert.deepEqual(plain(state.interactionsByGroup.group.interactions), []);
});

test('late HTTP snapshots cannot replace a new service epoch learned through SSE', () => {
  const { reducer, initialState } = loadClient();
  const old = { groupId: 'group', epoch: 'old', revision: 9, interactions: [] };
  const fresh = { ...old, epoch: 'new', revision: 1, interactions: [interaction] };
  let state = reducer(initialState, { type: 'interactions', data: old, startedEpoch: null });
  state = reducer(state, { type: 'sse', frame: { type: 'interaction.updated', ...fresh } });
  for (const startedEpoch of [null, 'old']) {
    const unchanged = reducer(state, { type: 'interactions', data: old, startedEpoch });
    assert.equal(unchanged, state, 'both initial fetches and old reply requests must be ignored');
  }
  state = reducer(state, { type: 'interactions', data: { ...fresh, revision: 2, interactions: [] }, startedEpoch: 'old' });
  assert.equal(state.interactionsByGroup.group.revision, 2, 'a response already carrying the current epoch is valid');
  state = reducer(state, { type: 'interactions', data: { ...old, epoch: 'next' }, startedEpoch: 'new' });
  assert.equal(state.interactionsByGroup.group.epoch, 'next', 'HTTP may discover the next epoch if its starting epoch is current');
});

test('old ordinary and hidden member log pages offer no native conversation entry', () => {
  const client = loadClient();
  for (const origin of [undefined, 'subagent']) {
    const tree = client.SessionHistoryPage({ target: { groupId: 'group', sessionId: 'session', botName: 'Bot' },
      state: { session: { id: 'session', native: !origin, origin }, events: [], loading: false, afterSeq: -1 },
      onBack() {}, onRefresh() {}, onOpenNativeSession() { assert.fail('native navigation must not be offered'); } });
    assert.equal(button(tree, '打开原生会话'), undefined);
    assert.match(text(tree), /返回 Bot Team/);
  }
});
