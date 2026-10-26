import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
  return { pool, repo, member, resumes, creates, resumed, dataDir };
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
