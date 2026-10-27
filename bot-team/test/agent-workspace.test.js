import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentPool } from '../host/agents.js';

function handleFor(sessionId, cwd) {
  const state = { disposed: 0 };
  return {
    state,
    handle: {
      agent: { id: sessionId, session: { header: { cwd } } },
      async dispose() { state.disposed += 1; },
    },
  };
}

async function fixture({ sessionCwd, workspaceCwd }) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'bot-team-agent-'));
  const member = { membershipId: 'mem-1', groupId: 'grp-1', botId: 'bot-1', sessionId: 'session-old' };
  const bot = { botId: 'bot-1', name: 'Timi', provider: 'deepseek', model: 'deepseek-chat', capability: 'work' };
  const group = { groupId: 'grp-1', kind: 'group', workspaceCwd };
  const repo = {
    getMember: (id) => (id === member.membershipId ? member : undefined),
    getBot: (id) => (id === bot.botId ? bot : undefined),
    getGroup: (id) => (id === group.groupId ? group : undefined),
    putMember: async (value) => { Object.assign(member, value); },
  };
  const resumes = [];
  const creates = [];
  const resumed = handleFor('session-old', sessionCwd);
  const ctx = {
    agents: {
      async resume(options) { resumes.push(options); return resumed.handle; },
      async create(options) { creates.push(options); return handleFor(options.sessionId, options.meta.cwd).handle; },
      get() { return undefined; },
    },
    get() { return undefined; },
  };
  const pool = new AgentPool({
    ctx,
    repo,
    personas: { get: () => ({ text: '' }), refresh: async () => ({}) },
    config: { dataDir, defaultCwd: dataDir, botSandbox: false },
    logger: null,
  });
  return { pool, repo, member, group, ctx, resumes, creates, resumed, dataDir };
}

test('an agent whose session was created for another cwd is reset to a fresh session', async () => {
  const workspaceCwd = await mkdtemp(path.join(os.tmpdir(), 'bot-team-workspace-'));
  const { pool, member, resumes, creates, resumed, dataDir } = await fixture({
    sessionCwd: '/tmp/old-workspace',
    workspaceCwd,
  });
  try {
    const agent = await pool.ensure('mem-1');
    assert.equal(resumes.length, 1);
    assert.equal(resumed.state.disposed, 1);
    assert.equal(creates.length, 1);
    assert.match(creates[0].sessionId, /^session-botteam-/);
    assert.equal(creates[0].meta.cwd, workspaceCwd);
    assert.equal(member.sessionId, creates[0].sessionId);
    assert.equal(agent.id, creates[0].sessionId);
    assert.equal(pool.entries.get('mem-1').sessionId, creates[0].sessionId);
  } finally {
    await rm(workspaceCwd, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('an agent whose session already matches the workspace keeps its history', async () => {
  const workspaceCwd = await mkdtemp(path.join(os.tmpdir(), 'bot-team-workspace-'));
  const { pool, member, resumes, creates, resumed, dataDir } = await fixture({
    sessionCwd: workspaceCwd,
    workspaceCwd,
  });
  try {
    const agent = await pool.ensure('mem-1');
    assert.equal(resumes.length, 1);
    assert.equal(resumed.state.disposed, 0);
    assert.equal(creates.length, 0);
    assert.equal(member.sessionId, 'session-old');
    assert.equal(agent.id, 'session-old');
  } finally {
    await rm(workspaceCwd, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('cached agents rotate their session and sandbox creation root when the project changes', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bot-team-project-agent-')));
  const project = path.join(root, 'project');
  await mkdir(project);
  const f = await fixture({ sessionCwd: root, workspaceCwd: root });
  t.after(async () => {
    await f.pool.disposeAll();
    await rm(root, { recursive: true, force: true });
    await rm(f.dataDir, { recursive: true, force: true });
  });
  const durable = new Map([['session-old', { cwd: root }]]);
  const live = new Map();
  const created = [];
  const modes = [];
  const directories = [];
  let resumes = 0;
  const handle = (id, cwd) => {
    const agent = { id, session: { header: { cwd }, append(type, data) { modes.push({ id, type, ...data }); } } };
    live.set(id, agent);
    return { agent, async dispose() { if (live.get(id) === agent) live.delete(id); } };
  };
  f.ctx.agents = {
    get: (id) => live.get(id),
    async resume({ resumeSessionId }) {
      resumes += 1;
      return handle(resumeSessionId, durable.get(resumeSessionId).cwd);
    },
    async create(options) {
      created.push(options);
      durable.set(options.sessionId, options.meta);
      return handle(options.sessionId, options.meta.cwd);
    },
  };
  f.ctx.get = (name) => name === 'workingDirectory'
    ? { async set(agent, cwd) { directories.push({ id: agent.id, cwd }); } }
    : undefined;
  f.pool.config.botSandbox = true;
  f.group.projectWorkspaceCwd = root;
  f.member.lastSeenSeq = 25;
  const first = await f.pool.ensure(f.member.membershipId);
  assert.equal(await f.pool.ensure(f.member.membershipId), first);
  assert.equal(resumes, 1, 'cache reuses the existing session');
  assert.equal(created.length, 0);
  f.group.workspaceCwd = project;
  f.group.projectWorkspaceCwd = project;
  const second = await f.pool.ensure(f.member.membershipId);
  assert.notEqual(second.id, first.id);
  assert.equal(live.has(first.id), false);
  assert.equal(created.length, 1);
  assert.equal(created[0].meta.cwd, project);
  assert.equal(second.session.header.cwd, project, 'sandbox root derives from new session creation metadata');
  assert.equal(f.member.sessionId, second.id);
  assert.equal(f.member.lastSeenSeq, 0, 'new history replays durable group context');
  assert.deepEqual(directories.at(-1), { id: second.id, cwd: project });
  assert.deepEqual(modes.at(-1), { id: second.id, type: 'sandbox/mode', mode: 'workspace-write' });
});

test('concurrent preparation shares one session and a missing imported project is never recreated', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bot-team-concurrent-agent-')));
  const f = await fixture({ sessionCwd: root, workspaceCwd: root });
  t.after(async () => {
    await f.pool.disposeAll();
    await rm(root, { recursive: true, force: true });
    await rm(f.dataDir, { recursive: true, force: true });
  });
  f.group.projectWorkspaceCwd = root;
  let complete;
  let started;
  const gate = new Promise((resolve) => { complete = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  let calls = 0;
  f.ctx.agents.resume = async () => { calls += 1; started(); await gate; return f.resumed.handle; };
  const first = f.pool.ensure(f.member.membershipId);
  const second = f.pool.ensure(f.member.membershipId);
  await entered;
  assert.equal(f.pool.isPreparingGroup(f.group.groupId), true);
  complete();
  assert.equal(await first, await second);
  assert.equal(calls, 1);
  assert.equal(f.pool.isPreparingGroup(f.group.groupId), false);
  f.group.workspaceCwd = path.join(root, 'missing-project');
  f.group.projectWorkspaceCwd = f.group.workspaceCwd;
  await assert.rejects(f.pool.ensure(f.member.membershipId), /目录不存在/);
  await assert.rejects(stat(f.group.workspaceCwd), { code: 'ENOENT' });
});

test('working directory failures never return an agent with a stale effective cwd', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bot-team-cwd-failure-'));
  const f = await fixture({ sessionCwd: root, workspaceCwd: root });
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(f.dataDir, { recursive: true, force: true });
  });
  f.ctx.get = (name) => name === 'workingDirectory'
    ? { async set() { throw new Error('directory unavailable'); } } : undefined;
  await assert.rejects(f.pool.ensure(f.member.membershipId), /无法设置 Bot 工作目录/);
  assert.equal(f.resumed.state.disposed, 1);
  assert.equal(f.pool.entries.size, 0);
});
