import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadClient, plain, walk, text } from './client-harness.js';

const client = loadClient();
const event = (seq, type, data = {}, time = 1000 + seq * 100) => ({ seq, time, type, data });
const message = (messageId = 'm1') => ({ messageId, seq: 7, status: 'streaming', author: { type: 'bot', botId: 'b1', name: 'Timi' } });
const target = (id = 'm1') => ({ groupId: 'g1', message: message(id) });
const page = overrides => ({ ok: true, groupId: 'g1', messageId: 'm1', availability: 'available', execution: { jobId: 'j1', sessionId: 'fixed-session' }, status: 'streaming', error: null, events: [], nextSeq: -1, hasMore: false, ...overrides });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const buttons = tree => walk(tree).filter(node => node.type === 'button');

function loader(local = client) {
  const requests = [];
  const snapshots = [];
  const controller = local.createExecutionController({ groupId: 'g1', messageId: 'm1', onChange: state => snapshots.push(state), fetchPage: (groupId, messageId, afterSeq, signal) => {
    const request = { groupId, messageId, afterSeq, signal, ...deferred() };
    requests.push(request);
    return request.promise;
  } });
  return { controller, requests, snapshots };
}

for (const [locale, expected] of [
  ['zh', '执行过程接口尚未加载。请完全退出并重新启动 DSH'],
  ['en', 'The execution details endpoint is not loaded. Fully quit and restart DSH'],
]) {
  test(`missing Host route explains recovery in ${locale} and retry succeeds after backend reload`, async () => {
    let ready = false;
    let calls = 0;
    const local = loadClient({ fetch: async (url, options) => {
      calls++;
      assert.equal(url, '/api/bot-team.message-execution?groupId=g1&messageId=m1&afterSeq=-1&limit=100');
      assert.equal(options.method, 'GET');
      assert.equal(options.signal.aborted, false);
      return ready ? Response.json(page({ status: 'done', events: [event(0, 'turn/start')] })) : new Response('not found', { status: 404 });
    } });
    local.setTestLocale(locale);
    const controller = local.createExecutionController({ groupId: 'g1', messageId: 'm1', onChange() {} });
    try {
      await controller.refresh();
      assert.ok(controller.getState().loadError.startsWith(expected));
      assert.equal(controller.getState().loading, false);
      assert.equal(controller.getState().availability, null);
      assert.equal(calls, 1);
      ready = true;
      await controller.refresh();
      assert.equal(controller.getState().loadError, '');
      assert.equal(controller.getState().availability, 'available');
      assert.equal(controller.getState().events.length, 1);
    } finally { controller.dispose(); }
  });
}

test('execution preserves application not-found messages instead of misdiagnosing an unloaded endpoint', async () => {
  const local = loadClient({ fetch: async () => Response.json({ ok: false, error: { code: 'not-found', message: 'Message not found' } }, { status: 404 }) });
  const controller = local.createExecutionController({ groupId: 'g1', messageId: 'm1', onChange() {} });
  try {
    await controller.refresh();
    assert.equal(controller.getState().loadError, 'Message not found');
  } finally { controller.dispose(); }
});

test('execution authentication failures remain distinct from an unloaded endpoint', async () => {
  const local = loadClient({ fetch: async () => new Response('unauthorized', { status: 401 }) });
  const controller = local.createExecutionController({ groupId: 'g1', messageId: 'm1', onChange() {} });
  try {
    await controller.refresh();
    assert.equal(controller.getState().loadError, '请求失败 (HTTP 401)');
  } finally { controller.dispose(); }
});

test('merging pages is ordered, immutable and deduplicated while the cursor follows filtered raw records', () => {
  const original = [event(4, 'step/start'), event(2, 'turn/start')];
  const incoming = [event(4, 'step/start'), event(8, 'step/end')];
  const merged = client.mergeExecutionEvents(original, incoming);
  assert.deepEqual(plain(merged.map(row => row.seq)), [2, 4, 8]);
  assert.deepEqual(original.map(row => row.seq), [4, 2]);
  const state = client.mergeExecutionPage({ ...client.emptyExecutionState('g1', 'm1'), events: merged, nextSeq: 8 }, page({ nextSeq: 90, hasMore: true }));
  assert.equal(state.nextSeq, 90);
  assert.equal(state.events.length, 3);
  assert.equal(client.mergeExecutionPage(state, page({ nextSeq: 10 })).nextSeq, 90);
});

test('projection pairs real SDK tool and nested PTC IDs, exact arguments, failures and attachments', () => {
  const args = '  {"command":"pwd"}\n';
  const records = [
    event(1, 'user/message', { id: 'input1', content: [{ type: 'text', text: 'Please inspect' }] }),
    event(2, 'turn/start', { turn: 3 }),
    event(3, 'tool/call', { turn: 3, step: 1, callId: 'root', name: 'run_code', arguments: '{"code":"..."}' }),
    event(4, 'tool/ptc-dispatch-start', { rootCallId: 'root', parentCallId: 'root', subCallId: 'inner', name: 'bash', arguments: args }),
    event(5, 'tool/ptc-dispatch-start', { rootCallId: 'root', parentCallId: 'inner', subCallId: 'leaf', name: 'read', arguments: { path: '/a' } }),
    event(6, 'tool/ptc-dispatch', { rootCallId: 'root', parentCallId: 'inner', subCallId: 'leaf', name: 'read', arguments: { path: '/a' }, isError: false, content: [{ type: 'text', text: 'leaf result' }] }),
    event(7, 'tool/ptc-dispatch', { rootCallId: 'root', parentCallId: 'root', subCallId: 'inner', name: 'bash', arguments: args, isError: true, content: 'permission denied', elapsedMs: 17 }),
    event(8, 'tool/result', { turn: 3, step: 1, message: { source: { type: 'tool', callId: 'root' }, content: 'outer result', isError: false }, attachments: [{ name: 'image.png' }] }),
    event(9, 'turn/end', { turn: 3, durationMs: 123 }),
  ];
  const projected = client.projectExecutionEvents(records);
  assert.deepEqual(plain(projected.map(node => node.seq)), [1, 2, 3, 9]);
  assert.equal(projected[0].payloads[0].value, 'Please inspect');
  const root = projected[2];
  assert.equal(root.tool, 'run_code');
  assert.equal(root.result, 'outer result');
  assert.equal(root.status, 'done');
  assert.equal(root.children[0].status, 'error');
  assert.equal(root.children[0].arguments, args);
  assert.equal(root.children[0].result, 'permission denied');
  assert.equal(root.children[0].durationMs, 17);
  assert.equal(root.children[0].children[0].tool, 'read');
  assert.equal(root.children[0].children[0].status, 'done');
  assert.equal(root.attachments[0].name, 'image.png');
  assert.equal(root.durationMs, undefined, 'timestamps do not invent a total');
  assert.equal(projected[3].durationMs, 123);
  assert.equal(records[2].data.children, undefined, 'projection does not mutate source records');
});

test('projection handles compatibility PTC endings, sparse results and reused call IDs in different steps', () => {
  const nodes = client.projectExecutionEvents([
    event(1, 'tool/call', { turn: 1, step: 1, callId: 'same', tool: 'first' }),
    event(2, 'tool/result', { turn: 1, step: 1, message: { toolCallId: 'same', isError: true, content: 'bad' }, error: { code: 'failed' } }),
    event(3, 'tool/call', { turn: 1, step: 2, callId: 'same', tool: 'second' }),
    event(4, 'tool/ptc-dispatch-start', { turn: 1, step: 2, parentCallId: 'same', callId: 'child', tool: 'read' }),
    event(5, 'tool/ptc-dispatch-end', { turn: 1, step: 2, parentCallId: 'same', callId: 'child', result: { ok: false, error: 'missing' } }),
    event(6, 'tool/result', { turn: 1, step: 3, message: { toolCallId: 'orphan', content: 'saved result' } }),
  ]);
  assert.equal(nodes.length, 3);
  assert.equal(nodes[0].status, 'error');
  assert.equal(nodes[0].error.code, 'failed');
  assert.equal(nodes[1].children[0].status, 'error');
  assert.equal(nodes[2].result, 'saved result');
});

test('projection preserves every event type including reasoning, attempts, compaction and unknown payloads', () => {
  const nodes = client.projectExecutionEvents([
    event(1, 'step/start', { step: 1 }),
    event(2, 'assistant/attempt', { model: 'model', status: 'retrying' }),
    event(3, 'assistant/message', { message: { content: [{ type: 'reasoning', text: 'private' }, { type: 'text', text: 'intermediate' }] } }),
    event(4, 'approval/asked', { id: 'a1', toolName: 'bash', reason: 'write' }),
    event(5, 'approval/decided', { id: 'a1', outcome: 'denied' }),
    event(6, 'llm/retry', { attempt: 2 }),
    event(7, 'llm/retry-started', { attempt: 3 }),
    event(8, 'context/compaction', { status: 'done' }),
    event(9, 'step/end', { step: 1 }),
    event(10, 'system/message', { text: 'system secret' }),
    event(11, 'assistant/stream', { text: 'hidden stream' }),
    event(12, 'future/safe-event', { text: 'unknown safe record', systemPrompt: 'never display unknown raw objects' }),
  ]);
  assert.deepEqual(plain(nodes.map(node => node.seq)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(nodes[1].label, '未完成的模型输出');
  assert.deepEqual(plain(nodes[1].payloads[0].value.data), { model: 'model', status: 'retrying' });
  assert.equal(nodes[2].blocks[0].text, 'private', 'recorded reasoning is preserved');
  assert.equal(nodes[2].payloads[0].value, 'intermediate');
  assert.equal(nodes[3].label, '等待审批');
  assert.equal(nodes[4].payloads[0].value.data.outcome, 'denied');
  assert.equal(nodes[5].label, '重试');
  assert.equal(nodes[7].label, '上下文整理');
  assert.match(nodes[9].label, /其他记录/);
  assert.equal(nodes[9].payloads[0].value.data.text, 'system secret');
  assert.equal(nodes[10].payloads[0].value.data.text, 'hidden stream');
  assert.equal(nodes[11].payloads[0].value.data.systemPrompt, 'never display unknown raw objects');
});

test('loader drains pages including filtered empty pages and queues updates received during fetch', async () => {
  const { controller, requests } = loader();
  const done = controller.refresh();
  await tick();
  assert.equal(requests[0].afterSeq, -1);
  controller.notify({ type: 'execution.updated', groupId: 'g1', messageId: 'm1', seq: 21 });
  requests[0].resolve(page({ nextSeq: 20, hasMore: true }));
  await tick();
  assert.equal(requests[1].afterSeq, 20, 'empty safe page still advances the raw cursor');
  controller.notify({ type: 'execution.updated', groupId: 'g1', messageId: 'm1', seq: 50 });
  requests[1].resolve(page({ events: [event(22, 'step/start')], nextSeq: 40 }));
  await tick();
  assert.equal(requests[2].afterSeq, 40);
  requests[2].resolve(page({ events: [event(22, 'step/start'), event(50, 'turn/end')], nextSeq: 50, status: 'done' }));
  await done;
  assert.deepEqual(plain(controller.getState().events.map(row => row.seq)), [22, 50]);
  assert.equal(controller.getState().loading, false);
  controller.notify({ type: 'execution.updated', groupId: 'g1', messageId: 'm1', seq: 50 });
  controller.notify({ type: 'execution.updated', groupId: 'other', messageId: 'm1', seq: 51 });
  controller.notify({ type: 'execution.updated', groupId: 'g1', messageId: 'other', seq: 51 });
  await tick();
  assert.equal(requests.length, 3, 'duplicate or unrelated invalidations do not fetch');
  controller.notify({ type: 'hello', groupId: 'g1' });
  await tick();
  assert.equal(requests[3].afterSeq, 50, 'reconnect catches up from the last raw sequence');
  requests[3].resolve(page({ nextSeq: 50 }));
  await tick();
  controller.dispose();
});

test('loader exposes failed pagination and retries without discarding earlier records', async () => {
  const { controller, requests } = loader();
  const first = controller.refresh();
  await tick();
  requests[0].resolve(page({ events: [event(1, 'turn/start')], nextSeq: 1, hasMore: true }));
  await tick();
  requests[1].reject(new Error('offline'));
  await first;
  assert.equal(controller.getState().loadError, 'offline');
  assert.equal(controller.getState().events.length, 1);
  const retry = controller.refresh();
  await tick();
  assert.equal(requests[2].afterSeq, 1);
  requests[2].resolve(page({ nextSeq: 1, hasMore: true }));
  await retry;
  assert.match(controller.getState().loadError, /分页未前进/);
  assert.equal(requests.length, 3, 'non-progressing pagination cannot spin');
  controller.dispose();
});

test('preparing transitions to available and disposal clears retry timers and aborts fetches', async () => {
  const timers = new Map();
  let timerId = 0;
  const local = loadClient({ setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id) });
  const { controller, requests, snapshots } = loader(local);
  const first = controller.refresh();
  await tick();
  requests[0].resolve(page({ availability: 'preparing', execution: null }));
  await first;
  assert.equal(timers.size, 1);
  controller.notify({ type: 'execution.updated', groupId: 'g1', messageId: 'm1', seq: 1, execution: { jobId: 'j1' } });
  await tick();
  assert.equal(timers.size, 0);
  requests[1].resolve(page({ events: [event(1, 'turn/start')], nextSeq: 1 }));
  await tick();
  assert.equal(controller.getState().availability, 'available');
  assert.equal(timers.size, 0);
  const running = controller.refresh();
  await tick();
  const count = snapshots.length;
  controller.dispose();
  assert.equal(requests[2].signal.aborted, true);
  requests[2].resolve(page({ nextSeq: 2 }));
  await running;
  assert.equal(snapshots.length, count, 'disposed requests cannot publish');
  controller.notify({ type: 'hello', groupId: 'g1' });
  await controller.refresh();
  assert.equal(requests.length, 3);
});

test('message hook rejects stale A results while B is open and aborts on close', async () => {
  const requests = [];
  const local = loadClient({ lifecycleEffects: true, fetch: (url, options) => {
    const request = { url, signal: options.signal, ...deferred() };
    requests.push(request);
    return request.promise;
  } });
  local.render(local.useMessageExecution, target('A'));
  local.flushEffects();
  await tick();
  const switching = local.render(local.useMessageExecution, target('B'));
  assert.equal(switching.state.messageId, 'B');
  assert.equal(switching.state.events.length, 0);
  local.flushEffects();
  await tick();
  assert.equal(requests[0].signal.aborted, true);
  assert.match(requests[0].url, /messageId=A&afterSeq=-1&limit=100/);
  requests[0].resolve({ json: async () => page({ messageId: 'A', events: [event(1, 'user/message', { content: 'wrong A' })] }) });
  requests[1].resolve({ json: async () => page({ messageId: 'B', events: [event(2, 'user/message', { content: 'right B' })], nextSeq: 2 }) });
  await tick();
  const current = local.render(local.useMessageExecution, target('B'));
  assert.equal(current.state.messageId, 'B');
  assert.deepEqual(plain(current.state.events.map(row => row.seq)), [2]);
  current.controller.current.refresh();
  await tick();
  local.render(local.useMessageExecution, null);
  local.flushEffects();
  assert.equal(requests[2].signal.aborted, true);
  requests[2].resolve({ json: async () => page({ messageId: 'B', nextSeq: 3 }) });
  await tick();
  assert.equal(local.render(local.useMessageExecution, null).state.events.length, 0);
  local.unmount();
});

test('loader rejects mismatched source responses instead of showing another message', async () => {
  const { controller, requests } = loader();
  const done = controller.refresh();
  await tick();
  requests[0].resolve(page({ messageId: 'wrong', events: [event(1, 'user/message', { content: 'wrong' })] }));
  await done;
  assert.equal(controller.getState().events.length, 0);
  assert.match(controller.getState().loadError, /不匹配/);
  controller.dispose();
});

test('SSE forwards execution invalidation and reconnects without replacing streamed bubbles', () => {
  let source;
  const frames = [];
  const actions = [];
  class Source {
    constructor() { source = this; this.listeners = new Map(); }
    addEventListener(type, fn) { this.listeners.set(type, fn); }
    removeEventListener(type, fn) { assert.equal(this.listeners.get(type), fn); this.listeners.delete(type); }
    close() { this.closed = true; }
  }
  const local = loadClient({ EventSource: Source, fetch: async () => ({ json: async () => ({ ok: true }) }) });
  local.render(() => local.useSse('g1', action => actions.push(action), frame => frames.push(frame)));
  const cleanup = local.effects[0]();
  source.listeners.get('execution.updated')({ data: JSON.stringify({ messageId: 'm1', seq: 9 }) });
  source.listeners.get('hello')({ data: '{}' });
  assert.deepEqual(frames.map(frame => frame.type), ['execution.updated', 'hello']);
  assert.equal(frames[0].groupId, 'g1');
  const streamed = { ...client.initialState, activeGroupId: 'g1', messagesByGroup: { g1: [{ ...message(), text: 'streamed current bubble' }] } };
  assert.equal(client.reducer(streamed, actions[0]), streamed);
  assert.equal(actions.filter(action => action.type === 'messagesTick').length, 1, 'only the existing reconnect path reloads messages');
  cleanup();
  assert.equal(source.listeners.size, 0);
  assert.equal(source.closed, true);
});

test('drawer renders accessible states and uses only the returned fixed session or explicitly labelled legacy fallback', () => {
  const opened = [];
  const local = loadClient();
  const props = { target: target(), onClose() {}, onRefresh() {}, onOpenSession: id => opened.push(id) };
  const render = state => local.render(local.ExecutionDrawer, { ...props, state: { ...client.emptyExecutionState('g1', 'm1'), loading: false, ...state } });
  const available = render(page({ fallbackSessionId: 'member-current' }));
  const dialog = walk(available).find(node => node.props?.role === 'dialog');
  assert.equal(dialog.props['aria-modal'], 'true');
  assert.match(text(available), /Timi · 消息 #7/);
  buttons(available).find(button => text(button) === '完整日志').props.onClick();
  assert.deepEqual(opened, ['fixed-session']);
  const legacy = render(page({ availability: 'legacy-unlinked', execution: null, fallbackSessionId: 'member-current' }));
  assert.doesNotMatch(text(legacy), /完整日志/);
  buttons(legacy).find(button => text(button) === '查看成员当前日志').props.onClick();
  assert.deepEqual(opened, ['fixed-session', 'member-current']);
  for (const [state, expected] of [
    [{ loading: true }, /正在加载执行过程/],
    [{ availability: 'preparing' }, /正在准备/],
    [{ availability: 'unavailable', reason: 'session-log-missing' }, /原始会话记录已不存在/],
    [{ availability: 'unavailable', reason: 'unrecognized-reason' }, /请稍后刷新记录重试/],
    [{ availability: 'available', reason: 'execution-log-incomplete' }, /执行记录不完整/],
    [{ loadError: 'offline' }, /加载失败/],
  ]) {
    const tree = render(state);
    assert.match(text(tree), expected);
    assert.ok(walk(tree).some(node => ['status', 'alert'].includes(node.props?.role)));
  }
  assert.match(client.GLOBAL_CSS, /.bt-execution-layer[^}]*position: absolute/);
  assert.match(client.GLOBAL_CSS, /max-width: 700px[^}]*.bt-execution-drawer[^}]*width: 100%/);
});

test('large payload details copy the complete exact recorded string after expansion', async () => {
  const copied = [];
  const local = loadClient({ navigator: { clipboard: { writeText: async value => copied.push(value) } } });
  const value = '  original\r\n' + 'x'.repeat(40000) + '\n  ';
  let tree = local.render(local.ExecutionPayload, { label: '调用参数', value });
  assert.equal(walk(tree).some(node => node.type === 'pre'), false, 'large content mounts only when expanded');
  tree.props.onToggle({ currentTarget: { open: true } });
  tree = local.render(local.ExecutionPayload, { label: '调用参数', value });
  assert.equal(text(walk(tree).find(node => node.type === 'pre')), value);
  await buttons(tree)[0].props.onClick();
  assert.deepEqual(copied, [value]);
  assert.match(text(local.render(local.ExecutionPayload, { label: '调用参数', value })), /已复制完整内容/);
});

test('drawer contains focus, closes on Escape and restores focus while removing listeners', () => {
  const listeners = new Map();
  const doc = { activeElement: null, addEventListener(type, fn) { const set = listeners.get(type) || new Set(); set.add(fn); listeners.set(type, set); }, removeEventListener(type, fn) { listeners.get(type).delete(fn); } };
  const makeFocusable = () => ({ isConnected: true, tabIndex: 0, getClientRects: () => [1], closest: () => null, focus() { doc.activeElement = this; } });
  const original = makeFocusable();
  const close = makeFocusable();
  const summary = makeFocusable();
  doc.activeElement = original;
  const dialog = { ownerDocument: doc, querySelectorAll: () => [close, summary], contains: node => node === close || node === summary, focus: () => close.focus() };
  let closed = 0;
  const local = loadClient();
  const tree = local.render(local.ExecutionDrawer, { target: { ...target(), returnFocus: original }, state: { ...client.emptyExecutionState('g1', 'm1'), loading: false }, onClose: () => closed++, onRefresh() {} });
  walk(tree).find(node => node.props?.role === 'dialog').props.ref.current = dialog;
  const cleanup = local.effects[0]();
  assert.equal(doc.activeElement, close);
  summary.focus();
  for (const fn of listeners.get('keydown')) fn({ key: 'Tab', preventDefault() {} });
  assert.equal(doc.activeElement, close, 'Tab loops from the last focusable control');
  for (const fn of listeners.get('keydown')) fn({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(closed, 1);
  cleanup();
  assert.equal(doc.activeElement, original);
  assert.equal([...listeners.values()].reduce((count, set) => count + set.size, 0), 0);
});

test('new response metadata clears an old partial-history reason and stale optional session links', () => {
  const partial = client.mergeExecutionPage(client.emptyExecutionState('g1', 'm1'), page({
    reason: 'execution-log-incomplete', sessionId: 'old-fixed', fallbackSessionId: 'old-member',
    events: [event(1, 'turn/start')], nextSeq: 1,
  }));
  const complete = client.mergeExecutionPage(partial, page({ events: [event(2, 'turn/end')], nextSeq: 2, status: 'done' }));
  assert.equal(complete.reason, undefined);
  assert.equal(complete.sessionId, undefined);
  assert.equal(complete.fallbackSessionId, undefined);
  assert.deepEqual(plain(complete.events.map(record => record.seq)), [1, 2]);
  const tree = client.render(client.ExecutionDrawer, { target: target(), state: complete, onClose() {}, onRefresh() {} });
  assert.match(text(tree), /已完成/);
  assert.doesNotMatch(text(tree), /执行记录不完整/);
});

test('execution focus returns to an existing control or the source message when no control had focus', () => {
  const row = { focus() {}, isConnected: true };
  const body = { focus() {}, isConnected: true };
  const composer = { focus() {}, isConnected: true };
  for (const focused of [body, composer]) {
    const source = message();
    const local = loadClient({ document: { body, activeElement: focused }, state: {
      ...client.initialState, loading: false, activeGroupId: 'g1', groups: [{ groupId: 'g1', title: 'Team', kind: 'group' }], messagesByGroup: { g1: [source] },
    } });
    const list = walk(local.render(local.BotTeamPage)).find(node => node.type === local.MessageList);
    list.props.onContextMenu({ preventDefault() {}, stopPropagation() {}, currentTarget: row, clientX: 1, clientY: 2 }, source);
    const menu = walk(local.render(local.BotTeamPage)).find(node => node.type === local.MessageContextMenu);
    menu.props.onClose();
    menu.props.onExecution(source);
    const drawer = walk(local.render(local.BotTeamPage)).find(node => node.type === local.ExecutionDrawer);
    assert.equal(drawer.props.target.returnFocus, focused === body ? row : composer);
  }
  const rendered = client.render(client.MessageRow, { message: message(), bots: [], allMessages: [], groupStart: true, groupEnd: true });
  assert.equal(rendered.props.tabIndex, -1, 'source row supports restoration without adding a Tab stop');
});

// Locale-only rendering needs the existing factory's private locale setter, so
// expose it here without expanding the shared lifecycle harness or production API.
function localizedExecution(locale) {
  let definition;
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}]; },
    useRef(value) { return { current: value }; },
    useEffect() {},
  };
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const marker = '    return {\n      inject:';
  const exposed = 'setTestLocale, uiT, UI_EN, UI_ZH, ExecutionDrawer, ExecutionEvent, MessageContextMenu, projectExecutionEvents, executionReasonText';
  assert.ok(source.includes(marker));
  vm.runInNewContext(source.replace(marker, '    return {\n      __test: { ' + exposed + ' },\n      inject:'), {
    window: { __ModuleLoader__: { load(value) { definition = value; } } }, console,
  });
  const api = definition.factory(name => name === 'react' ? React : pkg).__test;
  api.setTestLocale(locale);
  const expand = node => {
    if (Array.isArray(node)) return node.map(expand);
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') return expand(node.type(node.props));
    return { ...node, props: { ...node.props, children: expand(node.props?.children) } };
  };
  return { ...api, render: (component, props) => expand(component(props)) };
}

test('execution English copy translates labels and dynamic templates while preserving recorded content', () => {
  const en = localizedExecution('en');
  const source = { ...message(), author: { type: 'bot', name: '执行过程' } };
  const state = { ...page({ reason: 'execution-log-incomplete', events: [
    event(1, 'user/message', { content: '执行过程' }),
    event(2, 'assistant/attempt', { turn: 1, step: 1 }),
    event(3, 'tool/call', { turn: 1, step: 1, callId: 'outer', name: 'run_code', arguments: '执行过程' }),
    event(4, 'tool/ptc-dispatch-start', { rootCallId: 'outer', parentCallId: 'outer', subCallId: 'inner', name: '执行过程', arguments: '执行过程' }),
    event(5, 'tool/ptc-dispatch', { rootCallId: 'outer', parentCallId: 'outer', subCallId: 'inner', isError: true, content: '执行过程' }),
    event(6, 'future/safe-event'),
  ] }), loading: false };
  const tree = en.render(en.ExecutionDrawer, { target: { groupId: 'g1', message: source }, state, onClose() {}, onRefresh() {}, onOpenSession() {} });
  const visible = text(tree);
  for (const label of ['Execution details', '执行过程 · Message #7', 'Running', 'Trigger input', 'Full input', 'Unfinished model output', 'Tool · run_code', 'Nested tool · 执行过程', 'Call arguments', 'Tool result · ', 'Other record · future/safe-event', 'Failed', 'Awaiting result', 'Some execution records are missing.', 'Refresh records', 'Full logs']) assert.ok(visible.includes(label), label);
  const dialog = walk(tree).find(node => node.props?.role === 'dialog');
  assert.equal(buttons(dialog).find(button => text(button) === '×').props['aria-label'], 'Close execution details');
  assert.equal(walk(tree).find(node => node.type === 'ol').props['aria-label'], 'Execution records in chronological order');
  assert.equal(en.uiT('复制失败：{error}', { error: '执行过程' }), 'Copy failed: 执行过程');
  assert.equal(en.uiT('已复制完整内容'), 'Copied full contents');
  assert.equal(en.uiT('复制完整内容'), 'Copy full contents');
  const menu = en.render(en.MessageContextMenu, { menu: { message: source, x: 1, y: 1 }, bots: [], allMessages: [source], onClose() {}, onExecution() {} });
  const action = buttons(menu).find(button => text(button) === 'Execution details');
  assert.equal(action.props.title, "View this reply's execution details");
  for (const key of ['执行过程', '工具 · {tool}', '内部工具 · {tool}', '{bot} · 消息 #{message}', '刷新记录', '完整日志']) assert.equal(en.UI_ZH[key], key, 'Chinese registration includes added execution keys');
  const zh = localizedExecution('zh');
  assert.equal(zh.uiT('{bot} · 消息 #{message}', { bot: '执行过程', message: 7 }), '执行过程 · 消息 #7');
});

test('English execution states and reason messages contain readable fallback and retry instructions', () => {
  const en = localizedExecution('en');
  const props = { target: target(), onClose() {}, onRefresh() {}, onOpenSession() {} };
  for (const [state, expected] of [
    [{ loading: true }, 'Loading execution details…'],
    [{ loading: true, events: [event(1, 'turn/start')] }, 'Loading more records…'],
    [{ availability: 'preparing' }, 'Execution records are being prepared'],
    [{ availability: 'legacy-unlinked', fallbackSessionId: 'member-session' }, "View member's current logs"],
    [{ availability: 'unavailable', reason: 'session-log-missing' }, 'The original session records no longer exist.'],
    [{ availability: 'unavailable', reason: 'unknown-machine-code' }, 'Please refresh the records and try again later.'],
    [{ availability: 'available' }, 'There are no execution records to display yet.'],
    [{ loadError: 'original Host error' }, 'Loading failed: original Host errorRetry'],
  ]) {
    const tree = en.render(en.ExecutionDrawer, { ...props, state: { ...client.emptyExecutionState('g1', 'm1'), loading: false, ...state } });
    assert.ok(text(tree).includes(expected), expected);
  }
  assert.equal(en.uiT(en.executionReasonText('execution-boundary-mismatch')), 'The execution boundaries for this message could not be verified.');
});
