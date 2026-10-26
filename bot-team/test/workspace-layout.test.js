import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig } from '../host/util.js';
import {
  defaultWorkspaceDir,
  isStandardLayout,
  migrateLegacyLayout,
  sessionCwdMatches,
} from '../host/workspace.js';

const withDshHome = async (run) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'bot-team-home-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    await run(home);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
};

test('resolveConfig defaults to $DSH_HOME/dsh-bot-team and its bots subdirectory', async () => {
  await withDshHome(async (home) => {
    const config = resolveConfig({});
    assert.equal(config.dataDir, path.join(home, 'dsh-bot-team'));
    assert.equal(config.botsDir, path.join(home, 'dsh-bot-team', 'bots'));
    assert.equal(config.migrateLegacyLayout, true);
    assert.equal(isStandardLayout(config), true);

    const custom = resolveConfig({ dataDir: '/tmp/custom-bot-team' });
    assert.equal(custom.botsDir, path.join('/tmp/custom-bot-team', 'bots'));
    assert.equal(isStandardLayout(custom), false);
  });
});

test('sessionCwdMatches only accepts a session created for the same workspace', () => {
  assert.equal(sessionCwdMatches('/data/dsh-bot-team/direct/bot-a', '/data/dsh-bot-team/direct/bot-a'), true);
  assert.equal(sessionCwdMatches('/data/dsh-bot-team/direct/bot-a/', '/data/dsh-bot-team/direct/bot-a'), true);
  assert.equal(sessionCwdMatches('/data/old-workspace', '/data/dsh-bot-team/direct/bot-a'), false);
  assert.equal(sessionCwdMatches(undefined, '/data/dsh-bot-team/direct/bot-a'), false);
});

test('defaultWorkspaceDir gives each direct chat its bot id and each group its group id', () => {
  const config = { dataDir: '/data/dsh-bot-team' };
  assert.equal(
    defaultWorkspaceDir(config, { groupId: 'grp-dm-bot-a', kind: 'direct', botId: 'bot-a' }),
    '/data/dsh-bot-team/direct/bot-a',
  );
  assert.equal(
    defaultWorkspaceDir(config, { groupId: 'grp-1', kind: 'group' }),
    '/data/dsh-bot-team/groups/grp-1',
  );
});

function fakeRepo(groups) {
  const persisted = [];
  return {
    groups: new Map(groups.map((group) => [group.groupId, group])),
    persisted,
    domain: {
      table(name) {
        return {
          async put(key, value) {
            persisted.push([name, key, structuredClone(value)]);
          },
        };
      },
    },
  };
}

test('migrateLegacyLayout folds legacy, v1.8.0 direct, and current layouts, and is idempotent', async () => {
  await withDshHome(async (home) => {
    const legacy = path.join(home, 'bot-team');
    const dataDir = path.join(home, 'dsh-bot-team');
    await mkdir(path.join(legacy, 'bots', 'bot-a'), { recursive: true });
    await writeFile(path.join(legacy, 'bots', 'bot-a', 'BOT.md'), 'persona-a', 'utf8');
    await mkdir(path.join(legacy, 'group1', 'docs'), { recursive: true });
    await writeFile(path.join(legacy, 'group1', 'docs', 'note.md'), 'group-doc', 'utf8');
    // v1.8.0 kept direct workspaces directly under dataDir.
    await mkdir(path.join(dataDir, 'bot-old'), { recursive: true });
    await writeFile(path.join(dataDir, 'bot-old', 'note.txt'), 'old-direct', 'utf8');

    const config = resolveConfig({});
    const repo = fakeRepo([
      { groupId: 'grp-1', kind: 'group', workspaceCwd: path.join(legacy, 'group1') },
      { groupId: 'grp-dm-bot-b', kind: 'direct', botId: 'bot-b', workspaceCwd: '' },
      { groupId: 'grp-dm-bot-old', kind: 'direct', botId: 'bot-old', workspaceCwd: path.join(dataDir, 'bot-old') },
      { groupId: 'grp-external', kind: 'group', workspaceCwd: '/tmp/external-workspace' },
    ]);
    const summary = await migrateLegacyLayout({ repo, config, logger: null });

    assert.equal(
      await readFile(path.join(home, 'dsh-bot-team', 'bots', 'bot-a', 'BOT.md'), 'utf8'),
      'persona-a',
    );
    assert.equal(
      await readFile(path.join(home, 'dsh-bot-team', 'groups', 'grp-1', 'docs', 'note.md'), 'utf8'),
      'group-doc',
    );
    assert.equal(repo.groups.get('grp-1').workspaceCwd, path.join(home, 'dsh-bot-team', 'groups', 'grp-1'));
    assert.equal(repo.groups.get('grp-dm-bot-b').workspaceCwd, path.join(home, 'dsh-bot-team', 'direct', 'bot-b'));
    assert.equal((await stat(path.join(home, 'dsh-bot-team', 'direct', 'bot-b'))).isDirectory(), true);
    assert.equal(repo.groups.get('grp-dm-bot-old').workspaceCwd, path.join(home, 'dsh-bot-team', 'direct', 'bot-old'));
    assert.equal(
      await readFile(path.join(home, 'dsh-bot-team', 'direct', 'bot-old', 'note.txt'), 'utf8'),
      'old-direct',
    );
    await assert.rejects(stat(path.join(home, 'dsh-bot-team', 'bot-old')), { code: 'ENOENT' });
    assert.equal(repo.groups.get('grp-external').workspaceCwd, '/tmp/external-workspace');
    assert.equal(summary.personas, 1);
    assert.equal(summary.workspaces, 2);
    assert.equal(summary.groups, 3);
    assert.equal(summary.legacyRootRemoved, true);
    assert.equal(repo.persisted.filter(([, key]) => key === 'grp-external').length, 0);

    const again = await migrateLegacyLayout({ repo, config, logger: null });
    assert.deepEqual(
      { personas: again.personas, workspaces: again.workspaces, groups: again.groups },
      { personas: 0, workspaces: 0, groups: 0 },
    );
  });
});
