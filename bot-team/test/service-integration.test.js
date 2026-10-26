import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotTeamService } from '../host/service.js';
import { resolveConfig } from '../host/util.js';

/** The DSH services the Host half touches during startup (no agents are run). */
function fakeCtx() {
  const tables = new Map();
  const domain = {
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
    storageDomain: { open: async () => domain },
    connection: { fetch: { register: (route) => { routes.push(route); return () => {}; } } },
    tools: { register: (definition) => { tools.push(definition); return () => {}; } },
    on: () => () => {},
    get: () => undefined,
    agents: {},
    agentPresets: {},
  };
  return { ctx, routes, tools };
}

test('the real service boots, registers its routes/tools, and drives direct chats + folders end to end', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'bot-team-service-'));
  const { ctx, routes, tools } = fakeCtx();
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
    assert.equal(routes.length, 9, 'bootstrap/messages/events/action/health/file/upload/skills/export-pdf routes');
    assert.deepEqual(
      routes.map((route) => route.path).sort(),
      [
        '/api/bot-team.action',
        '/api/bot-team.bootstrap',
        '/api/bot-team.events',
        '/api/bot-team.export.pdf',
        '/api/bot-team.file',
        '/api/bot-team.health',
        '/api/bot-team.messages',
        '/api/bot-team.skills',
        '/api/bot-team.upload',
      ],
    );
    assert.equal(tools.length, 8, 'all model tools registered');

    const health = service.healthPayload();
    assert.equal(health.domain.schemaVersion, 6);
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
    assert.equal(boot.plugin.version, '1.1.0');
    assert.equal(boot.plugin.author, 'shper');
    assert.equal(service.healthPayload().pluginVersion, '1.1.0');

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
