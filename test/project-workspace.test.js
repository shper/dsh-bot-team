import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotTeamService } from '../host/service.js';
import { offlineUpdateDependencies } from './update-check-fixture.js';
import { openRepository } from '../host/domain.js';
import { renderGroupContext } from '../host/prompt.js';
import { resolveConfig } from '../host/util.js';
import { defaultWorkspaceDir, normalizeWorkspacePath, validateProjectWorkspace } from '../host/workspace.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const busy = (error) => error.code === 'busy';

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bot-team-project-')));
  const records = new Map();
  const storage = { beforePut: null, failPut: null };
  const storageRoot = path.join(root, 'storages');
  const domain = {
    unit: { constructor: { name: 'PerRecordJsonUnit' }, descriptor: { name: 'bot_team', layout: 'per-record' }, dir: path.join(storageRoot, 'bot_team') },
    table(name) {
      if (!records.has(name)) records.set(name, new Map());
      const table = records.get(name);
      return {
        entries: () => [...table].map(([key, value]) => [key, structuredClone(value)]),
        async put(key, value) {
          const snapshot = structuredClone(value);
          await storage.beforePut?.(name, snapshot);
          if (storage.failPut?.(name, snapshot)) throw new Error('disk write failed');
          table.set(key, snapshot);
        },
        async delete(key) { table.delete(key); },
      };
    },
    async close() {},
  };
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    storageDomain: {
      config: { backend: 'json' },
      ctx: { storage: { backend: { get: () => ({ constructor: { name: 'JsonStorageBackend' }, root: storageRoot }) } } },
      open: async () => domain, get: () => undefined,
    },
    connection: { fetch: { register: () => () => {} } },
    tools: { register: () => () => {} },
    on: () => () => {},
    get: () => undefined,
    agents: { get: () => undefined },
  };
  const config = resolveConfig({ dataDir: path.join(root, 'data'), migrateLegacyLayout: false });
  const service = new BotTeamService(ctx, config, offlineUpdateDependencies);
  await service.ready;
  const project = path.join(root, 'My Project');
  await mkdir(project);
  const frames = [];
  const bot = await service.createBot({ name: 'Project Bot', provider: 'mock', model: 'mock' });
  const group = service.repo.getGroup(bot.directGroupId);
  service.bus.subscribe(group.groupId, (frame) => frames.push(structuredClone(frame)));
  t.after(async () => {
    storage.beforePut = null;
    storage.failPut = null;
    service.engine.running.clear();
    service.engine.queue = [];
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return { service, root, project, group, bot, ctx, config, domain, storage, records, frames };
}

test('project selection persists for direct and group chats, broadcasts, and resets without deleting files', async (t) => {
  const f = await fixture(t);
  const { service, group, project, frames, domain, config, ctx, bot } = f;
  await writeFile(path.join(project, 'keep.txt'), 'keep');
  const selected = await service.dispatch('group.workspace.set', { groupId: group.groupId, workspaceCwd: project });
  assert.equal(selected.workspaceCwd, project);
  assert.equal(selected.projectWorkspaceCwd, project);
  assert.equal(frames.at(-1).type, 'group.updated');
  assert.equal(frames.at(-1).group.projectWorkspaceCwd, project);
  const boot = await service.bootstrapPayload();
  assert.equal(boot.groups.find((entry) => entry.groupId === group.groupId).projectWorkspaceCwd, project);
  const reopened = await openRepository({ storageDomain: { open: async () => domain } }, null);
  assert.equal(reopened.getGroup(group.groupId).projectWorkspaceCwd, project);
  assert.equal((await service.openDirect({ botId: bot.botId })).group.workspaceCwd, project);
  assert.match(renderGroupContext(service.repo, bot.botId, group.groupId), /用户已引入本地项目/);
  assert.match(renderGroupContext(service.repo, bot.botId, group.groupId), /项目任务请先读取/);

  const normal = await service.createGroup({ title: 'Project group' });
  await service.updateGroup({ groupId: normal.groupId, workspaceCwd: project });
  assert.equal(service.repo.getGroup(normal.groupId).projectWorkspaceCwd, project);
  const reset = await service.dispatch('group.workspace.set', { groupId: group.groupId, workspaceCwd: '' });
  assert.equal(reset.workspaceCwd, defaultWorkspaceDir(config, group));
  assert.equal(reset.projectWorkspaceCwd, '');
  assert.equal(frames.at(-1).group.projectWorkspaceCwd, '');
  assert.equal((await stat(path.join(project, 'keep.txt'))).isFile(), true);
  assert.doesNotMatch(renderGroupContext(service.repo, bot.botId, group.groupId), /用户已引入本地项目/);

  // Startup recognizes older custom workspace records without a schema bump.
  const legacy = { ...service.repo.getGroup(normal.groupId) };
  delete legacy.projectWorkspaceCwd;
  await service.repo.putGroup(legacy);
  const restored = new BotTeamService(ctx, config, offlineUpdateDependencies);
  await restored.ready;
  assert.equal(restored.repo.getGroup(normal.groupId).projectWorkspaceCwd, project);
  await restored.dispose();
});

test('invalid and missing project paths never change the group or create directories', async (t) => {
  const { service, group, root, project, frames } = await fixture(t);
  const file = path.join(root, 'file.txt');
  await writeFile(file, 'file');
  for (const workspaceCwd of [undefined, null, 1, '.', 'relative/project', path.join(root, 'missing'), file, 'bad\0path']) {
    await assert.rejects(service.dispatch('group.workspace.set', { groupId: group.groupId, workspaceCwd }),
      (error) => error.code === 'invalid-input');
    assert.equal(service.repo.getGroup(group.groupId).workspaceCwd, group.workspaceCwd);
    assert.equal(service.repo.getGroup(group.groupId).projectWorkspaceCwd, '');
  }
  await assert.rejects(stat(path.join(root, 'missing')), { code: 'ENOENT' });
  assert.equal(frames.length, 0);
  const link = path.join(root, 'project-link');
  await symlink(project, link);
  assert.equal(await validateProjectWorkspace(link), project);
  assert.equal(normalizeWorkspacePath('~/test-project'), path.join(os.homedir(), 'test-project'));
  assert.equal(await validateProjectWorkspace('~'), await realpath(os.homedir()));
  await service.dispatch('group.workspace.set', { groupId: group.groupId, workspaceCwd: link });
  assert.equal(service.repo.getGroup(group.groupId).workspaceCwd, project);
});

test('running, queued, discussion and pending operations reject switching; exact selections are no-ops', async (t) => {
  const { service, group, project, frames } = await fixture(t);
  let disposals = 0;
  service.pool.disposeMember = async () => { disposals += 1; };
  const set = () => service.setGroupWorkspace({ groupId: group.groupId, workspaceCwd: project });
  const running = { groupId: group.groupId, membershipId: 'busy', finished: false };
  service.engine.running.set('busy', running);
  await assert.rejects(set(), busy);
  // The old settings form submits the default directory even for a title edit.
  const normal = await service.createGroup({ title: 'Default' });
  service.engine.running.set('other', { groupId: normal.groupId, finished: false });
  const renamed = await service.updateGroup({ groupId: normal.groupId, title: 'Renamed', workspaceCwd: normal.workspaceCwd });
  assert.equal(renamed.projectWorkspaceCwd, '');
  service.engine.running.clear();
  service.engine.queue.push(running);
  await assert.rejects(set(), busy);
  service.engine.queue = [];
  await service.repo.putDiscussion({ discussionId: 'd', groupId: group.groupId, topic: 'Topic', status: 'running' });
  await assert.rejects(set(), busy);
  await service.repo.deleteDiscussion('d');
  service.engine.pendingWork.add(running);
  await assert.rejects(set(), busy);
  service.engine.pendingWork.clear();
  await set();
  assert.equal(disposals, 1);
  const frameCount = frames.length;
  const updatedAt = service.repo.getGroup(group.groupId).updatedAt;
  service.engine.running.set('busy', running);
  await set();
  assert.equal(disposals, 1);
  assert.equal(frames.length, frameCount);
  assert.equal(service.repo.getGroup(group.groupId).updatedAt, updatedAt);
});

test('switch closes admission before validation and throughout durable persistence', async (t) => {
  const { service, group, project, storage } = await fixture(t);
  const writing = deferred();
  const release = deferred();
  storage.beforePut = async (name, value) => {
    if (name === 'groups' && value.projectWorkspaceCwd === project) {
      writing.resolve();
      await release.promise;
    }
  };
  const switching = service.setGroupWorkspace({ groupId: group.groupId, workspaceCwd: project });
  // This check runs while realpath/stat/access have not completed yet.
  assert.throws(() => service.engine.postHumanMessage({ groupId: group.groupId, text: 'hello', mentions: [] }), busy);
  await assert.rejects(service.listSkills(group.groupId), busy);
  await assert.rejects(service.setGroupWorkspace({ groupId: group.groupId, workspaceCwd: '' }), busy);
  await writing.promise;
  assert.throws(() => service.engine.enqueueJob({ groupId: group.groupId, membershipId: 'unused' }), busy);
  release.resolve();
  await switching;
  assert.equal(service.engine.postHumanMessage({ groupId: group.groupId, text: 'ready', mentions: [] }).message.text, 'ready');
});

test('a failed group write rolls back the visible workspace and releases admission', async (t) => {
  const { service, group, project, storage, frames } = await fixture(t);
  storage.failPut = (name, value) => name === 'groups' && value.projectWorkspaceCwd === project;
  await assert.rejects(service.setGroupWorkspace({ groupId: group.groupId, workspaceCwd: project }), /disk write failed/);
  assert.equal(service.repo.getGroup(group.groupId).workspaceCwd, group.workspaceCwd);
  assert.equal(service.repo.getGroup(group.groupId).projectWorkspaceCwd, '');
  assert.equal(frames.length, 0);
  assert.doesNotThrow(() => service.assertWorkspaceStable(group.groupId));
  storage.failPut = null;
  await service.setGroupWorkspace({ groupId: group.groupId, workspaceCwd: project });
});

test('task persistence before enqueue and skill preparation reserve the original workspace', async (t) => {
  const { service, project, storage, bot } = await fixture(t);
  const group = await service.createGroup({ title: 'Tasks' });
  const member = await service.addMember({ groupId: group.groupId, botId: bot.botId });
  const task = await service.createTask({ groupId: group.groupId, title: 'Task', assigneeMembershipId: member.membershipId });
  const entered = deferred();
  const release = deferred();
  storage.beforePut = async (name, value) => {
    if (name === 'tasks' && value.status === 'in_progress') { entered.resolve(); await release.promise; }
  };
  service.engine.pump = () => {};
  const dispatching = service.dispatchTask({ taskId: task.taskId });
  await entered.promise;
  assert.equal(service.engine.isRunning(group.groupId), false);
  await assert.rejects(service.setGroupWorkspace({ groupId: group.groupId, workspaceCwd: project }), busy);
  release.resolve();
  await dispatching;
  assert.equal(service.engine.queuedCount(group.groupId), 1);
  await assert.rejects(service.setGroupWorkspace({ groupId: group.groupId, workspaceCwd: project }), busy);
  service.engine.queue = [];

  const skillsReady = deferred();
  const releaseSkills = deferred();
  service.ctx.get = (name) => name === 'skills' ? { list: async () => [] } : undefined;
  service.pool.ensure = async () => { skillsReady.resolve(); await releaseSkills.promise; return { id: 'skill-agent' }; };
  const skills = service.listSkills(group.groupId);
  await skillsReady.promise;
  await assert.rejects(service.setGroupWorkspace({ groupId: group.groupId, workspaceCwd: project }), busy);
  releaseSkills.resolve();
  await skills;
  await service.setGroupWorkspace({ groupId: group.groupId, workspaceCwd: project });
});

test('settings validation does not roll back message sequences allocated while awaiting a folder', async (t) => {
  const { service } = await fixture(t);
  const group = await service.createGroup({ title: 'Sequences' });
  const entered = deferred();
  const release = deferred();
  service.requireFolder = async () => { entered.resolve(); await release.promise; return null; };
  const editing = service.updateGroup({ groupId: group.groupId, title: 'Renamed', folderId: null });
  await entered.promise;
  const message = service.engine.postHumanMessage({ groupId: group.groupId, text: 'new message', mentions: [] }).message;
  release.resolve();
  await editing;
  assert.equal(service.repo.getGroup(group.groupId).nextSeq, message.seq);
  assert.equal(service.engine.postHumanMessage({ groupId: group.groupId, text: 'next message', mentions: [] }).message.seq, message.seq + 1);
});
