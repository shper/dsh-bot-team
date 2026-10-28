import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { nativeFixture, deferred } from './agent-native-fixture.js';

function seed(f, cwd) {
  f.durable.sessions.set('session-old', { header: { id: 'session-old', cwd, origin: 'subagent', agentPreset: 'native-default' }, events: [] });
}

test('a native session created under another cwd rotates without resuming or destroying the old Agent', async t => {
  const f = await nativeFixture(t);
  seed(f, '/tmp/old-workspace');
  const original = structuredClone(f.durable.sessions.get('session-old'));
  const agent = await f.pool.ensure('mem-1');
  assert.equal(f.calls.creates.length, 1);
  assert.match(agent.id, /^session-botteam-/);
  assert.equal(agent.session.header.cwd, f.cwd);
  assert.equal(f.member.sessionId, agent.id);
  assert.deepEqual(f.member.previousSessionIds, ['session-old']);
  assert.equal(f.calls.resolves.includes('session-old'), false);
  assert.equal(f.calls.nativeDisposals, 0);
  assert.deepEqual(f.durable.sessions.get('session-old'), original);
});

test('a native session whose cwd matches the workspace keeps its history', async t => {
  const f = await nativeFixture(t);
  seed(f, f.cwd);
  const agent = await f.pool.ensure('mem-1');
  assert.equal(f.calls.creates.length, 0);
  assert.equal(agent.id, 'session-old');
  assert.equal(f.member.lastSeenSeq, 25);
});

test('cached native agents rotate session and sandbox root after a project switch', async t => {
  const f = await nativeFixture(t);
  const project = path.join(f.cwd, 'project');
  await mkdir(project);
  f.group.projectWorkspaceCwd = f.cwd;
  const first = await f.pool.ensure('mem-1');
  const originalHeader = structuredClone(first.session.header);
  f.group.workspaceCwd = project;
  f.group.projectWorkspaceCwd = project;
  const second = await f.pool.ensure('mem-1');
  assert.notEqual(second.id, first.id);
  assert.equal(f.live.has(first.id), false, 'the pool releases its owned background handle on rotation');
  assert.equal(first.ctx.sections.has('bot-team:persona'), false, 'retired session loses active Bot overlay');
  assert.equal(f.calls.creates.length, 2);
  assert.equal(f.calls.creates[1].cwd, project);
  assert.equal(second.session.header.cwd, project);
  assert.deepEqual(first.session.header, originalHeader);
  assert.equal(f.member.lastSeenSeq, 0);
  assert.deepEqual(f.calls.directories.at(-1), { id: second.id, cwd: project });
  assert.deepEqual(second.session.snapshotEvents().find(event => event.type === 'sandbox/mode').data, { mode: 'workspace-write' });
  assert.equal(f.pool.memberForSession(first.id), undefined);
  assert.equal(f.pool.memberForSession(second.id), f.member);
});

test('single-flight preparation tracks its group and never recreates a missing imported project', async t => {
  const f = await nativeFixture(t);
  f.group.projectWorkspaceCwd = f.cwd;
  const gate = deferred();
  const entered = deferred();
  f.beforeCreate = async () => { entered.resolve(); await gate.promise; };
  const first = f.pool.ensure('mem-1');
  const second = f.pool.ensure('mem-1');
  await entered.promise;
  assert.equal(f.pool.isPreparingGroup('grp-1'), true);
  gate.resolve();
  assert.equal(await first, await second);
  assert.equal(f.calls.creates.length, 1);
  assert.equal(f.pool.isPreparingGroup('grp-1'), false);
  f.group.workspaceCwd = path.join(f.cwd, 'missing-project');
  f.group.projectWorkspaceCwd = f.group.workspaceCwd;
  await assert.rejects(f.pool.ensure('mem-1'), /目录不存在/);
  await assert.rejects(stat(f.group.workspaceCwd), { code: 'ENOENT' });
  assert.equal(f.calls.creates.length, 1);
});

test('working directory failure releases the acquired background handle and permits a same-id retry', async t => {
  const f = await nativeFixture(t);
  seed(f, f.cwd);
  f.beforeDirectory = () => { throw new Error('directory unavailable'); };
  await assert.rejects(f.pool.ensure('mem-1'), /无法设置 Bot 工作目录/);
  assert.equal(f.pool.entries.size, 0);
  assert.equal(f.calls.nativeDisposals, 1);
  assert.equal(f.live.has('session-old'), false);
  f.beforeDirectory = undefined;
  assert.equal((await f.pool.ensure('mem-1')).id, 'session-old');
  assert.equal(f.calls.creates.length, 0);
});
