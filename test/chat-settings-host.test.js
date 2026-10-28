import test from 'node:test';
import assert from 'node:assert/strict';
import { openRepository } from '../host/domain.js';
import { BotTeamService } from '../host/service.js';
import { GroupBus } from '../host/util.js';
import { CHAT_DISPLAY_SETTINGS_KEY, DEFAULT_CHAT_DISPLAY_SETTINGS, isChatDisplaySettings, normalizeChatDisplaySettings } from '../host/chat-settings.js';

const settings = { model: 'always', inputTokens: 'hidden', outputTokens: 'hover', speed: 'always' };
function memoryDomain() {
  const tables = new Map();
  const domain = {
    beforePut: null,
    table(name) {
      if (!tables.has(name)) tables.set(name, new Map());
      const records = tables.get(name);
      return {
        entries: () => [...records.entries()].map(([key, value]) => [key, structuredClone(value)]),
        async put(key, value) {
          if (domain.beforePut) await domain.beforePut(name, key, value);
          records.set(key, structuredClone(value));
        },
        async delete(key) { records.delete(key); },
      };
    },
    async close() {},
  };
  return domain;
}
async function fixture(domain = memoryDomain()) {
  const ctx = { storageDomain: { open: async () => domain } };
  const repo = await openRepository(ctx);
  const service = Object.assign(Object.create(BotTeamService.prototype), {
    ready: Promise.resolve(), repo, bus: new GroupBus(), config: {}, smokeState: null,
    engine: { isRunning: () => false, running: new Map(), queueSnapshot: () => [] },
    healthPayload: () => ({}), getModelCatalog: async () => ({ groups: [] }),
  });
  return { domain, ctx, repo, service };
}

test('Host strictly validates writes while tolerating old/corrupt reads', () => {
  assert.equal(isChatDisplaySettings(settings), true);
  assert.equal(isChatDisplaySettings(DEFAULT_CHAT_DISPLAY_SETTINGS), true);
  for (const invalid of [null, [], 'hidden', {}, { model: 'always' }, { ...settings, model: 'sometimes' }, { ...settings, extra: 'hover' }, Object.create(settings)]) assert.equal(isChatDisplaySettings(invalid), false);
  assert.deepEqual(normalizeChatDisplaySettings({ model: 'always', speed: 'bad' }), { ...DEFAULT_CHAT_DISPLAY_SETTINGS, model: 'always' });
  assert.deepEqual(normalizeChatDisplaySettings(null), DEFAULT_CHAT_DISPLAY_SETTINGS);
});

test('writes global preferences once, broadcasts to every group, and reloads after repository restart', async () => {
  const { domain, service, repo } = await fixture();
  await repo.putGroup({ groupId: 'g1', title: 'First' });
  await repo.putGroup({ groupId: 'g2', title: 'Second' });
  const frames = [];
  service.bus.subscribe('g1', frame => frames.push(['g1', frame]));
  service.bus.subscribe('g2', frame => frames.push(['g2', frame]));
  const result = await service.dispatch('settings.chatDisplay.update', { settings });
  assert.deepEqual(result, { chatDisplaySettings: settings });
  assert.deepEqual(service.getChatDisplaySettings(), settings);
  assert.deepEqual(frames.map(([id]) => id).sort(), ['g1', 'g2']);
  assert.ok(frames.every(([, frame]) => frame.type === 'settings.updated'));
  assert.deepEqual(frames[0][1].chatDisplaySettings, settings);
  assert.equal(repo.getGroup('g1').chatDisplaySettings, undefined, 'not stored on one group');
  await repo.close();
  const reopened = await fixture(domain);
  assert.deepEqual(reopened.service.getChatDisplaySettings(), settings);
  assert.deepEqual((await reopened.service.bootstrapPayload()).chatDisplaySettings, settings);
  await reopened.repo.close();
});

test('bootstrap reads latest settings after slow model catalog discovery', async () => {
  const { service } = await fixture();
  let finishCatalog;
  service.getModelCatalog = () => new Promise(resolve => { finishCatalog = resolve; });
  const pending = service.bootstrapPayload();
  await service.updateChatDisplaySettings({ settings });
  finishCatalog({ groups: [] });
  assert.deepEqual((await pending).chatDisplaySettings, settings);
});

test('settings can be saved before any groups exist and defaults remain backwards compatible', async () => {
  const { service, repo } = await fixture();
  assert.deepEqual(service.getChatDisplaySettings(), DEFAULT_CHAT_DISPLAY_SETTINGS);
  assert.deepEqual((await service.bootstrapPayload()).chatDisplaySettings, DEFAULT_CHAT_DISPLAY_SETTINGS);
  await service.dispatch('settings.chatDisplay.update', { settings });
  assert.deepEqual(service.getChatDisplaySettings(), settings);
  await repo.putMeta(CHAT_DISPLAY_SETTINGS_KEY, { model: 'hidden', speed: 'corrupted' });
  assert.deepEqual(service.getChatDisplaySettings(), { ...DEFAULT_CHAT_DISPLAY_SETTINGS, model: 'hidden' });
});

test('waits for durable write before changing in-memory settings or broadcasting success', async () => {
  const { domain, service, repo } = await fixture();
  await repo.putGroup({ groupId: 'g1', title: 'First' });
  let finishWrite;
  const gate = new Promise(resolve => { finishWrite = resolve; });
  const frames = [];
  service.bus.subscribe('g1', frame => frames.push(frame));
  domain.beforePut = () => gate;
  const pending = service.updateChatDisplaySettings({ settings });
  assert.deepEqual(service.getChatDisplaySettings(), DEFAULT_CHAT_DISPLAY_SETTINGS);
  assert.equal(frames.length, 0);
  finishWrite();
  await pending;
  assert.deepEqual(service.getChatDisplaySettings(), settings);
  assert.equal(frames.length, 1);
});

test('a failed durable save leaves old settings intact and sends no success frame', async () => {
  const { domain, service, repo } = await fixture();
  await repo.putGroup({ groupId: 'g1', title: 'First' });
  await service.updateChatDisplaySettings({ settings });
  const frames = [];
  service.bus.subscribe('g1', frame => frames.push(frame));
  domain.beforePut = async () => { throw new Error('disk full'); };
  await assert.rejects(service.updateChatDisplaySettings({ settings: DEFAULT_CHAT_DISPLAY_SETTINGS }), /disk full/);
  assert.deepEqual(service.getChatDisplaySettings(), settings);
  assert.equal(frames.length, 0);
});

test('HTTP settings action rejects malformed/incomplete values and returns canonical settings on success', async () => {
  const { service } = await fixture();
  const request = payload => new Request('http://test/api/bot-team.action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'settings.chatDisplay.update', payload }) });
  const invalid = await service.handleActionHttp(request({ settings: { ...settings, speed: 'never' } }));
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'invalid-input');
  const missing = await service.handleActionHttp(request({}));
  assert.equal(missing.status, 400);
  const valid = await service.handleActionHttp(request({ settings }));
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), { ok: true, result: { chatDisplaySettings: settings } });
});

test('SSE hello includes current settings after a reconnect, and open streams receive live updates', async () => {
  const { service, repo } = await fixture();
  await repo.putGroup({ groupId: 'g1', title: 'First' });
  await service.updateChatDisplaySettings({ settings });
  const response = service.createEventStream(new Request('http://test/api/bot-team.events?groupId=g1'), 'g1');
  const reader = response.body.getReader();
  try {
    const decoder = new TextDecoder();
    const hello = decoder.decode((await reader.read()).value);
    assert.match(hello, /^event: hello/);
    const frame = JSON.parse(hello.split('\ndata: ')[1]);
    assert.deepEqual(frame.chatDisplaySettings, settings);
    await service.updateChatDisplaySettings({ settings: DEFAULT_CHAT_DISPLAY_SETTINGS });
    const event = decoder.decode((await reader.read()).value);
    assert.match(event, /^event: settings.updated/);
    assert.deepEqual(JSON.parse(event.split('\ndata: ')[1]).chatDisplaySettings, DEFAULT_CHAT_DISPLAY_SETTINGS);
  } finally {
    await reader.cancel();
  }
});
