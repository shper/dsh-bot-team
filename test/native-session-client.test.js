import assert from 'node:assert/strict';
import test from 'node:test';
import { loadClient, plain, walk, text } from './client-harness.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const record = (seq, type, data = {}) => ({ seq, time: 1000 + seq, type, data });
const history = (sessionId, session = { id: sessionId, native: true }) => ({ ok: true, groupId: 'g1', sessionId, session, availability: 'available', events: [], nextSeq: -1, hasMore: false });
const component = (tree, type) => walk(tree).find(node => node.type === type);
const button = (tree, label) => walk(tree).find(node => node.type === 'button' && text(node) === label);

function connectWorkspace(local, openSession) {
  const slots = [];
  const ctx = {
    uiWorkspace: { openSession },
    effect: callback => callback(),
    locale: { register() {}, bind: () => (key, params) => key.replace(/[{]([a-z]+)[}]/g, (match, name) => params?.[name] ?? match), getSnapshot: () => ({ active: 'zh' }) },
    slots: { inject: (name, callback) => callback(), register: (slot, view) => { slots.push({ slot, view }); } },
  };
  local.apply(ctx);
  return slots;
}

function fixture(local) {
  return { ...local.initialState, loading: false, activeGroupId: 'g1',
    groups: [{ groupId: 'g1', title: 'Team', kind: 'group' }], bots: [{ botId: 'b1', name: 'Timi' }],
    members: [{ membershipId: 'mem1', groupId: 'g1', botId: 'b1', sessionId: 'saved', enabled: true }],
    messagesByGroup: { g1: [{ messageId: 'm1', groupId: 'g1', seq: 1, status: 'done', text: 'Saved reply', author: { type: 'bot', botId: 'b1', name: 'Timi' } }] },
  };
}

test('member logs stay inside Bot Team and never open the native workspace', () => {
  const opened = [];
  const local = loadClient({ state: fixture(loadClient()) });
  const slots = connectWorkspace(local, id => opened.push(id));
  assert.ok(slots.some(({ slot }) => slot.name === 'sidebar.panellist' && slot.id === 'bot-team'));
  let tree = local.render(local.BotTeamPage);
  const members = component(tree, local.MembersPanel);
  const memberView = local.remount(local.MembersPanel, members.props);
  assert.equal(button(memberView, '打开原生会话'), undefined);
  tree = local.remount(local.BotTeamPage);
  const currentMembers = component(tree, local.MembersPanel);
  currentMembers.props.onViewSession(currentMembers.props.members[0]);
  tree = local.render(local.BotTeamPage);
  assert.equal(component(tree, local.SessionHistoryPage).props.target.sessionId, 'saved');
  assert.deepEqual(opened, []);
});

test('legacy, absent, false and mismatched session metadata never invoke native navigation', async () => {
  for (const session of [undefined, { id: 'saved', origin: 'subagent', native: false }, { id: 'saved', origin: 'subagent', native: true }, { id: 'saved', native: false }, { id: 'other', native: true }, { id: 'saved' }]) {
    const errors = []; const opened = [];
    const local = loadClient();
    const navigation = local.createNativeSessionController({ workspace: () => ({ openSession: id => opened.push(id) }), fetchPage: async () => ({ ...history('saved'), session }) });
    assert.equal(await navigation.open({ groupId: 'g1', sessionId: 'saved', onError: error => errors.push(error) }), false);
    assert.equal(opened.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /旧版子会话|尚无法确认/);
  }
});

test('native lookup enforces group identity and reports unavailable navigation and rejected navigation', async () => {
  for (const [fetchPage, workspace, expected] of [
    [async () => ({ ...history('saved'), groupId: 'other' }), () => ({ openSession() { throw Error('must not navigate'); } }), /不匹配/],
    [async () => history('saved'), () => ({}), /导航暂不可用/],
    [async () => history('saved'), () => ({ openSession: async () => { throw Error('native failed'); } }), /native failed/],
  ]) {
    const errors = []; const local = loadClient();
    assert.equal(await local.createNativeSessionController({ fetchPage, workspace }).open({ groupId: 'g1', sessionId: 'saved', onError: error => errors.push(error) }), false);
    assert.match(errors[0], expected);
  }
});

test('a newer native lookup or cancel aborts pending metadata and ignores late responses', async () => {
  const local = loadClient(); const requests = []; const opened = []; const errors = [];
  const navigation = local.createNativeSessionController({ workspace: () => ({ openSession: id => opened.push(id) }), fetchPage: (groupId, sessionId, afterSeq, signal) => { const request = { sessionId, signal, ...deferred() }; requests.push(request); return request.promise; } });
  const first = navigation.open({ groupId: 'g1', sessionId: 'first', onError: error => errors.push(error) });
  const second = navigation.open({ groupId: 'g1', sessionId: 'second', onError: error => errors.push(error) });
  assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve(history('first')); requests[1].resolve(history('second'));
  assert.deepEqual(await Promise.all([first, second]), [false, true]);
  assert.deepEqual(opened, ['second']);
  const third = navigation.open({ groupId: 'g1', sessionId: 'third' });
  navigation.cancel();
  assert.equal(requests[2].signal.aborted, true);
  requests[2].resolve(history('third')); await third;
  assert.deepEqual(opened, ['second']); assert.deepEqual(errors, []);
});

test('approval audit cards direct both old and new sessions to Bot Team interactions', () => {
  const opened = []; const local = loadClient();
  for (const nativeSession of [true, false, undefined]) {
    const row = local.remount(local.ApprovalRow, {
      bots: [], onOpenSession: id => opened.push(id),
      message: { kind: 'approval', meta: { approvalState: 'pending', sessionId: 'saved', nativeSession } },
    });
    assert.equal(button(row, '去审批'), undefined);
    assert.match(text(row), /本聊天顶部的待处理交互/);
  }
  assert.deepEqual(opened, []);
});

test('execution and full history retain log routes without exposing native workspace navigation', () => {
  const local = loadClient(); const native = []; const logs = [];
  const source = { groupId: 'g1', message: { messageId: 'm1', seq: 1, author: { name: 'Timi' } } };
  for (const session of [{ id: 'saved', native: true }, { id: 'saved', origin: 'subagent', native: false }, undefined, { id: 'rotated', native: true }]) {
    const state = { ...local.emptyExecutionState('g1', 'm1'), ...history('saved', session), session, execution: { sessionId: 'saved' }, loading: false };
    const props = { state, onRefresh() {}, onOpenNativeSession: (...args) => native.push(args) };
    const drawer = local.remount(local.ExecutionDrawer, { ...props, target: source, onClose() {}, onOpenSession: id => logs.push(id) });
    button(drawer, '完整日志').props.onClick();
    const full = local.remount(local.SessionHistoryPage, { ...props, target: { groupId: 'g1', sessionId: 'saved' }, onBack() {} });
    for (const view of [drawer, full]) {
      const action = button(view, '打开原生会话');
      assert.equal(action, undefined);
    }
  }
  assert.deepEqual(logs, ['saved', 'saved', 'saved', 'saved']);
  assert.deepEqual(native, []);
});

test('full history rejects contradictory session metadata and clears a stale native flag on refresh', async () => {
  const local = loadClient();
  const controller = local.createExecutionController({ groupId: 'g1', sessionId: 'saved', onChange() {}, fetchPage: async () => ({ ...history('saved', { id: 'other', native: true }), events: [record(1, 'assistant/message')] }) });
  try { await controller.refresh(); assert.equal(controller.getState().events.length, 0); assert.match(controller.getState().loadError, /不匹配/); }
  finally { controller.dispose(); }
  const prior = local.mergeExecutionPage(local.emptyExecutionState('g1', undefined, 'saved'), history('saved'));
  const current = local.mergeExecutionPage(prior, { ...history('saved'), session: undefined });
  assert.equal(current.session, undefined);
});

test('native tools pair source.callId, preserve complete records, and keep failed nested PTC payloads', () => {
  const local = loadClient();
  const records = [
    record(1, 'tool/call', { turn: 2, step: 3, callId: 'root', name: 'run_code', arguments: '{"code":"..."}' }),
    record(2, 'tool/ptc-dispatch-start', { turn: 2, step: 3, rootCallId: 'root', parentCallId: 'root', subCallId: 'inner', name: 'read', arguments: { file_path: 'a.png' } }),
    record(3, 'tool/ptc-dispatch', { turn: 2, step: 3, rootCallId: 'root', parentCallId: 'root', subCallId: 'inner', content: [{ type: 'image', source: { type: 'base64', data: 'whole-image' } }], isError: true, providerMetadata: { raw: 'keep' } }),
    record(4, 'tool/result', { turn: 2, step: 3, callId: 'wrong-legacy-id', message: { id: 'result1', source: { type: 'tool', callId: 'root' }, content: [{ type: 'text', text: 'result' }, { type: 'audio', url: 'audio.mp3', mimeType: 'audio/mpeg' }], extension: { keep: true } } }),
  ];
  const nodes = local.projectExecutionEvents(records);
  assert.equal(nodes.length, 1); assert.equal(nodes[0].status, 'done');
  assert.equal(nodes[0].children[0].status, 'error');
  assert.deepEqual(plain(nodes[0].records), [records[0], records[3]]);
  assert.deepEqual(plain(nodes[0].children[0].records), [records[1], records[2]]);
  assert.deepEqual(plain(nodes[0].result), records[3].data.message.content);
});

test('structured reasoning and multimedia blocks expose bodies and retain full payloads', () => {
  const local = loadClient();
  const reasoning = { type: 'reasoning', text: '完整思考正文', signature: 'provider-signature', extra: { keep: true } };
  const media = { type: 'video', url: 'clip.mp4', mimeType: 'video/mp4', width: 640, height: 480, data: 'all-media-data' };
  const original = record(8, 'assistant/attempt', { turn: 4, step: 2, model: 'example', message: { content: [reasoning, media] }, diagnostics: { raw: [1, 2, 3] } });
  const node = local.projectExecutionEvents([original])[0];
  assert.deepEqual(plain(node.blocks), [reasoning, media]);
  assert.deepEqual(plain(node.payloads.at(-1).value), original);
  const thought = local.remount(local.ExecutionBlock, { block: reasoning });
  assert.equal(text(walk(thought).find(item => item.type === 'pre')), '完整思考正文');
  const multimedia = local.remount(local.ExecutionBlock, { block: media });
  for (const value of ['video', 'clip.mp4', 'video/mp4', '640', '480']) assert.ok(text(multimedia).includes(value), value);
  assert.deepEqual(plain(component(multimedia, local.ExecutionPayload).props.value), media);
  const nestedMedia = { type: 'image', source: { type: 'url', url: 'photo.png', mimeType: 'image/png' }, metadata: { whole: true } };
  const nested = local.remount(local.ExecutionBlock, { block: nestedMedia });
  assert.ok(text(nested).includes('photo.png')); assert.ok(text(nested).includes('image/png'));
  assert.deepEqual(plain(component(nested, local.ExecutionPayload).props.value), nestedMedia);
});

for (const [locale, title, count] of [['zh', '完整日志', '显示 1 / 5 条事件'], ['en', 'Full logs', 'Showing 1 of 5 events']]) {
  test('full logs default to structured and raw type/text filters inspect full JSON in ' + locale, () => {
    const local = loadClient(); local.setTestLocale(locale);
    const records = [record(1, 'assistant/reasoning', { text: 'thought' }), record(2, 'assistant/attempt', { nested: { value: 'needle' } }), record(3, 'context/compaction', { raw: 'kept' }), record(4, 'future/event', { payload: 'all' }), record(5, 'tool/result', { message: { source: { callId: 'x' }, content: 'result' } })];
    const props = { target: { groupId: 'g1', sessionId: 'saved' }, state: { ...history('saved'), events: records }, onBack() {}, onRefresh() {} };
    let full = local.render(local.SessionHistoryPage, props);
    assert.equal(text(walk(full).find(node => node.type === 'h1')), title);
    assert.equal(button(full, local.uiT('结构化执行')).props['aria-pressed'], true);
    button(full, local.uiT('原始事件')).props.onClick();
    full = local.render(local.SessionHistoryPage, props);
    assert.equal(button(full, local.uiT('原始事件')).props['aria-pressed'], true);
    assert.equal(component(full, local.RawExecutionEvents).props.events, records);
    let raw = local.remount(local.RawExecutionEvents, { events: records });
    assert.equal(walk(raw).filter(node => node.type === local.RawExecutionEvent).length, 5);
    walk(raw).find(node => node.type === 'input').props.onChange({ target: { value: 'NEEDLE' } });
    raw = local.render(local.RawExecutionEvents, { events: records });
    assert.ok(text(raw).includes(count));
    assert.equal(component(raw, local.RawExecutionEvent).props.event.seq, 2);
    walk(raw).find(node => node.type === 'select').props.onChange({ target: { value: 'future/event' } });
    raw = local.render(local.RawExecutionEvents, { events: records });
    assert.equal(component(raw, local.RawExecutionEvent), undefined);
    assert.ok(text(raw).includes(local.uiT('没有匹配的原始事件。')));
    walk(raw).find(node => node.type === 'input').props.onChange({ target: { value: '' } });
    raw = local.render(local.RawExecutionEvents, { events: records });
    assert.equal(component(raw, local.RawExecutionEvent).props.event.seq, 4);
  });
}

test('raw events display and copy the entire original object with sequence, turn, step and untranslated text', async () => {
  const copied = []; const local = loadClient({ navigator: { clipboard: { writeText: async value => copied.push(value) } } });
  local.setTestLocale('en');
  const event = { ...record(7, 'future/event', { turn: 3, step: 2, content: '执行过程' + 'x'.repeat(45000), extra: { nested: ['payload'] } }), nativeExtension: { id: 'original' } };
  const tree = local.render(local.RawExecutionEvent, { event });
  assert.match(text(tree), /Sequence 7 · Turn 3 · Step 2/);
  const pre = walk(tree).find(node => node.type === 'pre');
  assert.equal(pre.props.tabIndex, 0);
  assert.equal(text(pre), JSON.stringify(event, null, 2));
  await button(tree, 'Copy full contents').props.onClick();
  assert.deepEqual(copied, [JSON.stringify(event, null, 2)]);
  assert.match(local.GLOBAL_CSS, /bt-raw-json:focus-visible/);
  assert.match(local.GLOBAL_CSS, /bt-raw-filters label[^}]*flex: 1 1 240px/);
});

function downloadFixture(overrides = {}) {
  const downloads = []; const blobs = []; const requests = []; const revoked = [];
  const local = loadClient({
    URL: { createObjectURL(blob) { blobs.push(blob); return 'blob:export'; }, revokeObjectURL: url => revoked.push(url) },
    document: { createElement: () => ({ click() { downloads.push({ href: this.href, filename: this.download }); }, remove() {} }), body: { appendChild() {} } },
    setTimeout: fn => { fn(); return 1; },
    fetch: async (url, options) => { requests.push({ url, options }); return new Response('{"full":"jsonl"}\n', { headers: { 'content-type': 'application/x-ndjson' } }); },
    ...overrides,
  });
  return { local, downloads, blobs, requests, revoked };
}

test('raw export performs authenticated GET to Bot Team JSONL route and downloads unchanged bytes', async () => {
  const { local, downloads, blobs, requests, revoked } = downloadFixture();
  await local.exportRawSessionLog('g&1', 'session / saved', new AbortController().signal);
  assert.equal(requests[0].url, '/api/bot-team.session-export?groupId=g%261&sessionId=session%20%2F%20saved');
  assert.equal(requests[0].options.method, 'GET'); assert.equal(requests[0].options.credentials, 'same-origin');
  assert.equal(await blobs[0].text(), '{"full":"jsonl"}\n');
  assert.ok(downloads[0].filename.endsWith('.jsonl')); assert.equal(downloads[0].href, 'blob:export');
  assert.deepEqual(revoked, ['blob:export']);
});

test('export failures are visible and closing or switching cancels downloads without saving late responses', async () => {
  const failure = downloadFixture({ fetch: async () => Response.json({ ok: false, error: { message: 'log not found' } }, { status: 404 }) });
  let view = failure.local.render(failure.local.SessionExportButton, { groupId: 'g1', sessionId: 'saved' });
  await button(view, '导出原始日志').props.onClick();
  view = failure.local.render(failure.local.SessionExportButton, { groupId: 'g1', sessionId: 'saved' });
  assert.equal(text(walk(view).find(node => node.props.role === 'alert')), 'log not found');
  assert.equal(failure.downloads.length, 0);
  const requests = []; const active = downloadFixture({ lifecycleEffects: true, fetch: (url, options) => { const request = { signal: options.signal, ...deferred() }; requests.push(request); return request.promise; } });
  view = active.local.render(active.local.SessionExportButton, { groupId: 'g1', sessionId: 'first' }); active.local.flushEffects();
  const first = button(view, '导出原始日志').props.onClick();
  active.local.render(active.local.SessionExportButton, { groupId: 'g1', sessionId: 'second' }); active.local.flushEffects();
  assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve(new Response('old log')); await first;
  view = active.local.render(active.local.SessionExportButton, { groupId: 'g1', sessionId: 'second' });
  const second = button(view, '导出原始日志').props.onClick();
  active.local.unmount();
  assert.equal(requests[1].signal.aborted, true);
  requests[1].resolve(new Response('new log')); await second; await tick();
  assert.equal(active.downloads.length, 0);
});
