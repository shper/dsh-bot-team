import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotTeamService } from '../host/service.js';
import { resolveConfig } from '../host/util.js';

const SAME_BYTES = new Uint8Array([104, 105]);
const ATTACHMENT_ID = 'sha256:' + 'a'.repeat(64);

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
  const attachmentStore = {
    async saveFile({ data, name }) {
      return { attachmentId: ATTACHMENT_ID, name, bytes: data.byteLength };
    },
    fileHostPath(ref) {
      if (ref.attachmentId !== ATTACHMENT_ID) throw new Error('bad ref');
      return '/tmp/attachments/' + ref.name;
    },
  };
  const skills = {
    calls: [],
    async list(options) {
      this.calls.push(options);
      return [
        { name: 'office', description: 'Office files', invocation: { modelInvocable: true, userInvocable: true }, source: 'fs', provider: 'filesystem' },
        { name: 'model-only', description: 'not for humans', invocation: { modelInvocable: true, userInvocable: false }, source: 'fs', provider: 'filesystem' },
        { name: 'manual', description: 'manual only', invocation: { modelInvocable: false, userInvocable: true }, source: 'fs', provider: 'filesystem', path: '/skills/manual/SKILL.md' },
      ];
    },
  };
  const workingDirectory = { ensured: [], async ensure(agent) { this.ensured.push(agent); return this.cwd; }, cwd: '' };
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
    get(name) {
      if (name === 'attachments') return attachmentStore;
      if (name === 'skills') return skills;
      if (name === 'workingDirectory') return workingDirectory;
      return undefined;
    },
    agents: {},
    agentPresets: {},
  };
  return { ctx, routes, tools, attachmentStore, skills, workingDirectory };
}

async function boot() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'bot-team-files-'));
  const fake = fakeCtx(path.join(home, 'storages'));
  const service = new BotTeamService(
    fake.ctx,
    resolveConfig({
      dataDir: path.join(home, 'data'),
      botsDir: path.join(home, 'data', 'bots'),
      defaultCwd: home,
      migrateLegacyLayout: false,
      smokeResultsDir: path.join(home, 'smoke'),
    }),
  );
  await service.ready;
  return { service, home, ...fake };
}

test('the bot preset mounts local skill discovery and the skill tool', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.match(patch, /id: skill-filesystem/);
  assert.match(patch, /name: '@deepseek-ai\/dsh-skill-filesystem'/);
  assert.match(patch, /id: tool-skill/);
  assert.match(patch, /name: '@deepseek-ai\/dsh-tool-skill'/);
});

test('uploads become durable attachment refs and message.post persists them', async () => {
  const { service, home, attachmentStore } = await boot();
  try {
    const request = new Request('http://localhost/api/bot-team.upload?name=brief.txt', {
      method: 'POST',
      body: SAME_BYTES,
    });
    const response = await service.handleUploadHttp(request);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.attachment.attachmentId, ATTACHMENT_ID);
    assert.equal(body.attachment.name, 'brief.txt');
    assert.equal(body.attachment.bytes, 2);
    assert.equal(body.attachment.path, undefined);

    const group = await service.dispatch('group.create', { title: '附件群' });
    const posted = await service.dispatch('message.post', {
      groupId: group.groupId,
      text: '   ',
      attachments: [
        { attachmentId: ATTACHMENT_ID, name: 'brief.txt', bytes: 2 },
        { attachmentId: 'not-a-ref', name: 'bad.txt', bytes: 1 },
        { attachmentId: ATTACHMENT_ID, name: 'brief.txt', bytes: 2 },
      ],
    });
    const stored = service.repo.getMessage(posted.message.messageId);
    assert.equal(stored.text, '');
    assert.equal(stored.attachments.length, 1);
    assert.equal(stored.attachments[0].name, 'brief.txt');
    assert.equal(stored.attachments[0].path, '/tmp/attachments/brief.txt');
    assert.equal(attachmentStore.fileHostPath({ attachmentId: ATTACHMENT_ID, name: 'brief.txt', bytes: 2 }), '/tmp/attachments/brief.txt');

    await assert.rejects(
      () => service.dispatch('message.post', { groupId: group.groupId, text: '', attachments: [] }),
      /消息不能为空/,
    );
  } finally {
    await service.dispose();
    await rm(home, { recursive: true, force: true });
  }
});

test('skills are listed through the bot agent scope and user-invocable policy', async () => {
  const { service, home, skills, workingDirectory } = await boot();
  try {
    const bot = await service.dispatch('bot.create', {
      name: 'Skill Bot',
      provider: 'deepseek',
      model: 'deepseek-chat',
    });
    const direct = service.repo.getGroup(bot.directGroupId);
    workingDirectory.cwd = direct.workspaceCwd;
    const fakeAgent = { id: 'agent-1' };
    service.pool.ensure = async () => fakeAgent;
    const result = await service.listSkills(direct.groupId);
    assert.equal(result.memberId, service.repo.membersOf(direct.groupId)[0].membershipId);
    assert.equal(result.cwd, direct.workspaceCwd);
    assert.deepEqual(result.skills.map((skill) => skill.name), ['office', 'manual']);
    assert.equal(result.skills[0].modelInvocable, true);
    assert.equal(result.skills[1].modelInvocable, false);
    assert.equal(result.skills[1].path, '/skills/manual/SKILL.md');
    assert.equal(skills.calls.length, 1);
    assert.equal(skills.calls[0].scope, fakeAgent);
    assert.equal(skills.calls[0].cwd, direct.workspaceCwd);

    const emptyGroup = await service.dispatch('group.create', { title: '空群' });
    const empty = await service.listSkills(emptyGroup.groupId);
    assert.deepEqual(empty.skills, []);
    assert.equal(empty.reason, 'no-member');
  } finally {
    await service.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
