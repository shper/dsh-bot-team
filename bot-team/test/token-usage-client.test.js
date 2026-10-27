import assert from 'node:assert/strict';
import test from 'node:test';
import { loadClient, plain, text } from './client-harness.js';

const groupId = 'token-group';
const usage = { inputTokens: 4754, outputTokens: 5603, totalTokens: 10357 };
const zeroUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
const snapshot = (totals = zeroUsage) => ({ groups: [{ groupId, kind: 'group', usage: totals }], members: [], bots: [] });
const reply = (status = 'done') => ({ messageId: 'reply', groupId, seq: 2, author: { type: 'bot' }, status, usage });
const settle = () => new Promise(resolve => setImmediate(resolve));

function fakeTimers() {
  let nextId = 0;
  const pending = new Map();
  return {
    setTimeout(fn) { const id = ++nextId; pending.set(id, fn); return id; },
    clearTimeout(id) { pending.delete(id); },
    count() { return pending.size; },
    runNext() {
      const entry = pending.entries().next().value;
      assert.ok(entry, 'expected a scheduled refresh');
      pending.delete(entry[0]);
      entry[1]();
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('finished replies invalidate group totals and refresh the right panel from the full history', () => {
  const client = loadClient();
  let state = client.reducer(client.initialState, { type: 'bootstrap', data: snapshot() });
  state = client.reducer(state, { type: 'sse', frame: { type: 'message.updated', message: reply() } });
  assert.deepEqual(plain(state.messagesByGroup[groupId][0].usage), usage);
  assert.equal(state.refreshTick, 1);

  // The server aggregate includes history absent from the paginated client list.
  const totals = { inputTokens: 14754, outputTokens: 7603, totalTokens: 22357 };
  state = client.reducer(state, { type: 'bootstrap', data: snapshot(totals) });
  // Duplicate SSE delivery must never add the same sample to the aggregate twice.
  state = client.reducer(state, { type: 'sse', frame: { type: 'message.updated', message: reply() } });
  state = client.reducer(state, { type: 'bootstrap', data: snapshot(totals) });
  assert.deepEqual(plain(state.groups[0].usage), totals);
  assert.equal(state.messagesByGroup[groupId].length, 1);
  const panel = client.MembersPanel({ state, members: [], bots: [], dispatch() {}, usage: state.groups[0].usage });
  assert.match(text(panel), /本群累计 Token/);
  assert.match(text(panel), /14,754/);
  assert.match(text(panel), /7,603/);
  assert.match(text(panel), /22,357/);
});

test('only settled bot messages invalidate totals during SSE streaming', () => {
  const client = loadClient();
  const state = client.reducer(client.initialState, { type: 'bootstrap', data: snapshot() });
  for (const status of ['done', 'error', 'stopped']) {
    const next = client.reducer(state, { type: 'sse', frame: { type: 'message.updated', message: reply(status) } });
    assert.equal(next.refreshTick, 1, status);
  }
  for (const message of [reply('running'), reply('queued'), { ...reply(), author: { type: 'human' } }, { ...reply(), groupId: 'other' }]) {
    const next = client.reducer(state, { type: 'sse', frame: { type: 'message.updated', message } });
    assert.equal(next.refreshTick, 0);
  }
  const next = client.reducer(state, { type: 'sse', frame: { type: 'message.delta', messageId: 'reply', chunk: 'text' } });
  assert.equal(next.refreshTick, 0);
});

test('hello refreshes authoritative totals after missing a completion while disconnected', () => {
  const sources = [];
  class EventSource {
    constructor() { this.listeners = new Map(); sources.push(this); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    removeEventListener(type) { this.listeners.delete(type); }
    close() { this.closed = true; }
    emit(type, data) { this.listeners.get(type)?.({ data: JSON.stringify(data) }); }
  }
  const client = loadClient({ EventSource, lifecycleEffects: true });
  let state = client.reducer(client.initialState, { type: 'bootstrap', data: snapshot() });
  client.render(() => client.useSse(groupId, action => { state = client.reducer(state, action); }));
  client.flushEffects();
  sources[0].emit('hello', { seq: 20, running: [], chatDisplaySettings: {} });
  assert.equal(state.refreshTick, 1);
  assert.equal(state.messagesTick, 1);
  state = client.reducer(state, { type: 'bootstrap', data: snapshot(usage) });
  assert.deepEqual(plain(state.groups[0].usage), usage);
  client.unmount();
  assert.equal(sources[0].closed, true);
});

test('parallel completions coalesce and a stale response cannot replace the latest totals', async t => {
  const timers = fakeTimers();
  const client = loadClient(timers);
  const requests = [];
  const published = [];
  const errors = [];
  const controller = client.createBootstrapController({
    load(signal) { const request = { ...deferred(), signal }; requests.push(request); return request.promise; },
    onData(data) { published.push(data); },
    onError(error) { errors.push(error); },
  });
  t.after(() => controller.dispose());
  for (let i = 0; i < 20; i += 1) controller.refresh();
  assert.equal(timers.count(), 1);
  timers.runNext();
  assert.equal(requests.length, 1);
  for (let i = 0; i < 20; i += 1) controller.refresh();
  assert.equal(requests.length, 1, 'at most one GET in flight');
  requests[0].resolve(snapshot());
  await settle();
  assert.equal(published.length, 0, 'the snapshot predating the completion is discarded');
  assert.equal(timers.count(), 1);
  timers.runNext();
  requests[1].resolve(snapshot(usage));
  await settle();
  assert.deepEqual(published, [snapshot(usage)]);
  assert.deepEqual(errors, []);
  assert.equal(timers.count(), 0);
});

test('a superseded request error is ignored and a later refresh can recover', async t => {
  const timers = fakeTimers();
  const client = loadClient(timers);
  const requests = [];
  const published = [];
  const errors = [];
  const controller = client.createBootstrapController({
    load() { const request = deferred(); requests.push(request); return request.promise; },
    onData(data) { published.push(data); },
    onError(error) { errors.push(error); },
  });
  t.after(() => controller.dispose());
  controller.refresh(true);
  controller.refresh();
  requests[0].reject(new Error('old request'));
  await settle();
  assert.deepEqual(errors, []);
  timers.runNext();
  const currentError = new Error('current request');
  requests[1].reject(currentError);
  await settle();
  assert.deepEqual(errors, [currentError]);
  controller.refresh();
  timers.runNext();
  requests[2].resolve(snapshot(usage));
  await settle();
  assert.deepEqual(published, [snapshot(usage)]);
});

test('unmount cancels pending refreshes and aborts an active bootstrap without publishing', async () => {
  const timers = fakeTimers();
  const requests = [];
  const actions = [];
  const client = loadClient({
    ...timers,
    lifecycleEffects: true,
    fetch(url, options) {
      const request = { ...deferred(), url, signal: options.signal };
      requests.push(request);
      return request.promise;
    },
  });
  const dispatch = action => actions.push(action);
  const refresh = client.render(() => client.useBootstrap(dispatch));
  client.flushEffects();
  assert.equal(requests.length, 1, 'initial load is immediate');
  refresh();
  client.unmount();
  assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve({ json: async () => snapshot(usage) });
  await settle();
  assert.deepEqual(actions, []);
  assert.equal(timers.count(), 0);

  const controller = client.createBootstrapController({ load() { throw new Error('must not load'); }, onData() {}, onError() {} });
  controller.refresh();
  assert.equal(timers.count(), 1);
  controller.dispose();
  assert.equal(timers.count(), 0);
});
