import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotTeamService } from '../host/service.js';
import { resolveConfig } from '../host/util.js';
import { loadClient, walk } from './client-harness.js';

/** The DSH services the Host half touches during startup (no agents are run). */
function fakeCtx(storageRoot) {
  const tables = new Map();
  const domain = {
    unit: { constructor: { name: 'PerRecordJsonUnit' }, descriptor: { name: 'bot_team', layout: 'per-record' }, dir: path.join(storageRoot, 'bot_team') },
    table(name) {
      if (!tables.has(name)) tables.set(name, new Map());
      const records = tables.get(name);
      return {
        entries: () => [...records.entries()].map(([key, value]) => [key, structuredClone(value)]),
        async put(key, value) { records.set(key, structuredClone(value)); },
        async delete(key) { records.delete(key); },
      };
    },
    async close() {},
  };
  const routes = [];
  const tools = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    storageDomain: {
      config: { backend: 'json' },
      ctx: { storage: { backend: { get: () => ({ constructor: { name: 'JsonStorageBackend' }, root: storageRoot }) } } },
      get: () => undefined,
      open: async () => domain,
    },
    connection: { fetch: { register: (route) => { routes.push(route); return () => {}; } } },
    tools: { register: (definition) => { tools.push(definition); return () => {}; } },
    on: () => () => {},
    get: () => undefined,
    agents: {},
    agentPresets: {},
  };
  return { ctx, routes, tools };
}

test('bootstrap stays available when optional native services are absent from a guarded scope', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'bot-team-bootstrap-scope-'));
  const { ctx, routes } = fakeCtx(path.join(home, 'storages'));
  for (const name of ['botTeamNativeActivity', 'jobs', 'goals', 'subagents']) {
    Object.defineProperty(ctx, name, { get() {
      throw new Error('cannot get property "' + name + '" without inject');
    } });
  }
  const service = new BotTeamService(ctx, resolveConfig({
    dataDir: path.join(home, 'data'), defaultCwd: home, migrateLegacyLayout: false,
  }));
  t.after(async () => {
    await service.dispose();
    await rm(home, { recursive: true, force: true });
  });
  await service.ready;
  const route = routes.find(entry => entry.path === '/api/bot-team.bootstrap');
  const bootstrap = () => route.fetch(new Request('http://localhost/api/bot-team.bootstrap'));
  const empty = await bootstrap();
  const emptyBody = await empty.json();
  assert.equal(empty.status, 200, JSON.stringify(emptyBody));
  assert.equal(emptyBody.ok, true);
  assert.deepEqual(emptyBody.groups, []);
  assert.equal(emptyBody.capabilities.conversations, false);

  const group = await service.createGroup({ title: 'Existing chat' });
  const populated = await bootstrap();
  const body = await populated.json();
  assert.equal(populated.status, 200, JSON.stringify(body));
  assert.equal(body.groups[0].groupId, group.groupId);
  assert.equal(body.groups[0].canStartConversation, false);
  assert.ok(body.groups[0].conversationBlockers.some(item => item.code === 'native-capability-unavailable'));
});

test('random Bot illustration colors survive saving, reopening and renaming', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'bot-team-avatar-colors-'));
  const { ctx } = fakeCtx(path.join(home, 'storages'));
  const service = new BotTeamService(ctx, resolveConfig({
    dataDir: path.join(home, 'data'), defaultCwd: home, migrateLegacyLayout: false,
  }));
  t.after(async () => {
    await service.dispose();
    await rm(home, { recursive: true, force: true });
  });
  await service.ready;
  const client = loadClient();
  const reopenedClient = loadClient();
  const svg = (renderer, bot) => {
    const node = renderer.Avatar({ bot });
    return JSON.parse(JSON.stringify(node.type(node.props)));
  };
  const ids = ['bot-orbit', 'bot-spark', 'bot-circuit', 'bot-pixel', 'bot-scout', 'bot-assistant', 'bot-core', 'bot-android'];
  const palettes = ['sky', 'violet', 'mint', 'orange', 'pink', 'indigo', 'teal', 'slate'];
  let bot;
  for (const id of ids) {
    bot = await service.createBot({ name: id, provider: 'deepseek', model: 'deepseek-chat', avatar: 'art:' + id + ':sky' });
    assert.equal(bot.avatar, 'art:' + id + ':sky');
    for (const palette of palettes) {
      const avatar = 'art:' + id + ':' + palette;
      await service.updateBot({ botId: bot.botId, avatar });
      const boot = await service.bootstrapPayload();
      const saved = boot.bots.find(entry => entry.botId === bot.botId);
      assert.equal(saved.avatar, avatar);
      assert.deepEqual(svg(reopenedClient, { ...saved, name: 'Renamed Bot' }), svg(client, saved));
    }
  }
  const previous = service.repo.getBot(bot.botId).avatar;
  for (const avatar of [
    'art:bot-orbit:unknown', 'art:bot-orbit:', 'art:bot-orbit:sky:extra',
    'art:bot-unknown:sky', 'art:constructor:sky', 'art:bot-orbit:Sky',
    'art:group-team:sky', 'art:planet:sky',
  ]) {
    await assert.rejects(service.updateBot({ botId: bot.botId, avatar }), /未知的/);
    assert.equal(service.repo.getBot(bot.botId).avatar, previous, 'invalid colors cannot alter a saved avatar');
  }
  const trimmed = await service.updateBot({ botId: bot.botId, avatar: '  art:bot-orbit:mint  ' });
  assert.equal(trimmed.avatar, 'art:bot-orbit:mint');
  const legacy = await service.updateBot({ botId: bot.botId, avatar: 'preset:r-previous' });
  assert.equal(legacy.avatar, 'preset:r-previous');
});

test('Bot and group preset selections stay distinct and survive saving and reopening', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'bot-team-avatar-'));
  const { ctx } = fakeCtx(path.join(home, 'storages'));
  const service = new BotTeamService(ctx, resolveConfig({
    dataDir: path.join(home, 'data'), defaultCwd: home, migrateLegacyLayout: false,
  }));
  t.after(async () => {
    await service.dispose();
    await rm(home, { recursive: true, force: true });
  });
  await service.ready;
  const noop = () => {};
  const client = loadClient();
  const modelCatalog = { groups: [{ id: 'deepseek', models: [{ id: 'deepseek-chat' }] }] };
  const presetButtons = (tree) => {
    const picker = walk(tree).find(node => node.props?.role === 'group' && node.props['aria-label'] === '预置头像');
    assert.ok(picker, 'preset picker is named for assistive technology');
    return walk(picker).filter(node => node.type === 'button');
  };
  const assertArt = (kind, record, id) => {
    const node = kind === 'bot' ? client.Avatar({ bot: record }) : client.GroupAvatar({ group: record });
    const art = walk(node).find(child => typeof child.type === 'function' && child.props.id === id);
    assert.ok(art, 'saved preset resolves to its illustration');
    assert.equal(art.type(art.props).type, 'svg');
  };
  const selectedIds = [];
  const records = {};
  for (const kind of ['bot', 'group']) {
    const component = kind === 'bot' ? client.BotFormDialog : client.GroupFormDialog;
    const props = { onClose: noop, onSaved: noop, modelCatalog, folders: [] };
    const buttons = presetButtons(client.remount(component, props));
    assert.ok(buttons.length >= 6, 'each entity offers its own selection');
    const ids = buttons.map(button => button.props.key);
    assert.ok(ids.every(id => id.startsWith(kind + '-')), 'picker contains only its own category');
    selectedIds.push(ids);
    let record;
    for (const id of ids) {
      presetButtons(client.render(component, props)).find(button => button.props.key === id).props.onClick();
      const tree = client.render(component, props);
      const preview = walk(tree).find(node => node.type === (kind === 'bot' ? client.Avatar : client.GroupAvatar));
      const avatar = preview.props[kind].avatar;
      assert.equal(avatar, 'art:' + id);
      assert.deepEqual(presetButtons(tree).filter(button => button.props['aria-pressed']).map(button => button.props.key), [id]);
      record = record
        ? await service.dispatch(kind + '.update', { [kind + 'Id']: record[kind + 'Id'], avatar })
        : await service.dispatch(kind + '.create', { name: 'Avatar Bot', title: 'Avatar group', provider: 'deepseek', model: 'deepseek-chat', avatar });
      const boot = await service.bootstrapPayload();
      const saved = boot[kind === 'bot' ? 'bots' : 'groups'].find(entry => entry[kind + 'Id'] === record[kind + 'Id']);
      assert.equal(saved.avatar, avatar);
      const reopened = client.remount(component, { ...props, [kind]: saved });
      assert.equal(presetButtons(reopened).find(button => button.props['aria-pressed']).props.key, id);
      assertArt(kind, saved, id);
    }
    records[kind] = record;
  }
  assert.equal(selectedIds[0].some(id => selectedIds[1].includes(id)), false);
  for (const id of ['planet', 'rocket', 'cloud', 'bolt', 'leaf', 'flame', 'star', 'moon', 'wave', 'flower']) {
    for (const kind of ['bot', 'group']) {
      const saved = await service.dispatch(kind + '.update', { [kind + 'Id']: records[kind][kind + 'Id'], avatar: 'art:' + id });
      assert.equal(saved.avatar, 'art:' + id, 'legacy illustrations still save');
      assertArt(kind, saved, id);
    }
  }
  await assert.rejects(service.updateBot({ botId: records.bot.botId, avatar: 'art:bot-unknown' }), /未知的插画头像/);
  await assert.rejects(service.updateGroup({ groupId: records.group.groupId, avatar: 'art:group-unknown' }), /未知的插画头像/);
});

test('bootstrap and health omit hourly quotas while the real engine enforces the daily budget', async (t) => {
  t.mock.method(Date, 'now', () => new Date(2026, 9, 27, 12).getTime());
  const home = await mkdtemp(path.join(os.tmpdir(), 'bot-team-quota-'));
  const { ctx } = fakeCtx(path.join(home, 'storages'));
  const service = new BotTeamService(ctx, resolveConfig({
    dataDir: path.join(home, 'data'),
    defaultCwd: home,
    migrateLegacyLayout: false,
    maxTurnsPerHour: 120,
    dailyTokenBudget: 1000,
  }));
  t.after(async () => {
    await service.dispose();
    await rm(home, { recursive: true, force: true });
  });
  await service.ready;
  const group = await service.createGroup({ title: 'Quota test' });
  const boot = await service.bootstrapPayload();
  for (const config of [service.config, boot.config, boot.health.config, service.healthPayload().config]) {
    assert.equal(Object.hasOwn(config, 'maxTurnsPerHour'), false);
    assert.equal(config.dailyTokenBudget, 1000);
  }
  assert.deepEqual(boot.health.quotas[group.groupId], { ok: true, tokensToday: 0, tokenLimit: 1000 });
  assert.doesNotThrow(() => service.engine.assertQuota(group.groupId));

  const reply = service.engine.createMessage({ groupId: group.groupId, author: { type: 'bot' }, text: 'used budget' });
  reply.usage = { inputTokens: 600, outputTokens: 400 };
  await service.repo.putMessage(reply);
  assert.throws(() => service.engine.assertQuota(group.groupId), (error) => error.code === 'quota' && /今日 token/.test(error.message));
  const health = await (await service.handleHealth()).json();
  assert.deepEqual(health.quotas[group.groupId], {
    ok: false,
    reason: '本群今日 token 用量已达上限（1000 / 1000），请明天再试或调整配额',
    tokensToday: 1000,
    limit: 1000,
  });
  assert.equal(Object.hasOwn(health.config, 'maxTurnsPerHour'), false);
});

test('the real service boots, registers its routes/tools, and drives direct chats + folders end to end', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'bot-team-service-'));
  const { ctx, routes, tools } = fakeCtx(path.join(home, 'storages'));
  const service = new BotTeamService(
    ctx,
    resolveConfig({
      dataDir: path.join(home, 'data'),
      botsDir: path.join(home, 'data', 'bots'),
      defaultCwd: home,
      migrateLegacyLayout: false,
      smokeResultsDir: path.join(home, 'smoke'),
    }),
  );
  try {
    await service.ready;
    assert.equal(routes.length, 13, 'bootstrap/messages/conversations/execution/session-history/session-export/events/action/health/file/upload/skills/export-pdf routes');
    assert.deepEqual(
      routes.map((route) => route.path).sort(),
      [
        '/api/bot-team.action',
        '/api/bot-team.bootstrap',
        '/api/bot-team.conversations',
        '/api/bot-team.events',
        '/api/bot-team.export.pdf',
        '/api/bot-team.file',
        '/api/bot-team.health',
        '/api/bot-team.message-execution',
        '/api/bot-team.messages',
        '/api/bot-team.session-export',
        '/api/bot-team.session-history',
        '/api/bot-team.skills',
        '/api/bot-team.upload',
      ],
    );
    assert.equal(tools.length, 10, 'all model tools registered');

    const health = service.healthPayload();
    assert.equal(health.domain.schemaVersion, 8);
    assert.equal(health.domain.counts.folders, 0);

    const bot = await service.dispatch('bot.create', {
      name: '集成测试 Bot',
      provider: 'deepseek',
      model: 'deepseek-chat',
    });
    assert.ok(bot.directGroupId);
    const direct = service.repo.getGroup(bot.directGroupId);
    assert.equal(direct.workspaceCwd, path.join(home, 'data', 'direct', bot.botId));
    assert.equal((await stat(direct.workspaceCwd)).isDirectory(), true);
    const boot = await service.bootstrapPayload();
    assert.equal(boot.folders.length, 0);
    assert.equal(boot.groups.filter((group) => group.kind === 'direct').length, 1);
    assert.equal(boot.plugin.packageName, 'dsh-bot-team');
    assert.equal(boot.plugin.version, '1.2.2');
    assert.equal(boot.plugin.author, 'shper');
    assert.equal(service.healthPayload().pluginVersion, '1.2.2');

    const folder = await service.dispatch('folder.create', { title: '工作' });
    const group = await service.dispatch('group.create', { title: '集成群', folderId: folder.folderId });
    assert.equal(group.folderId, folder.folderId);
    assert.equal(group.workspaceCwd, path.join(home, 'data', 'groups', group.groupId));
    assert.equal((await stat(group.workspaceCwd)).isDirectory(), true);
    await service.dispatch('group.reorder', {
      kind: 'group',
      folderId: folder.folderId,
      movedGroupId: group.groupId,
      orderedIds: [group.groupId],
    });
    const after = await service.bootstrapPayload();
    assert.equal(after.folders[0].folderId, folder.folderId);
    assert.equal(after.groups.find((entry) => entry.groupId === group.groupId).folderId, folder.folderId);
    assert.equal(service.healthPayload().domain.counts.folders, 1);
  } finally {
    await service.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
