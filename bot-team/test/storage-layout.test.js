import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openPluginStorageDomain, relocateStorageDirectory } from '../host/storage-layout.js';

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'bot-team-storage-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, 'custom storage root');
  await mkdir(root);
  return { root, legacy: path.join(root, 'bot_team'), target: path.join(root, 'dsh-bot-team') };
}

async function putFile(directory, relative, value) {
  const file = path.join(directory, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, value);
}

const link = (destination, alias) => symlink(destination, alias, process.platform === 'win32' ? 'junction' : 'dir');

async function assertAlias(legacy, target) {
  assert.equal((await lstat(legacy)).isSymbolicLink(), true);
  assert.equal((await lstat(target)).isDirectory(), true);
  assert.equal(await realpath(legacy), await realpath(target));
}

test('fresh installation writes through the legal unit name into the physical dsh-bot-team directory', async t => {
  const { legacy, target } = await fixture(t);
  assert.equal(await relocateStorageDirectory(legacy), target);
  await assertAlias(legacy, target);
  await putFile(legacy, 'groups/new.json', '{"groupId":"new"}');
  assert.equal(await readFile(path.join(target, 'groups/new.json'), 'utf8'), '{"groupId":"new"}');
  await relocateStorageDirectory(legacy);
  await assertAlias(legacy, target);
});

test('migration preserves every table, unknown files and record bytes, and repeat startup keeps new writes', async t => {
  const { legacy, target } = await fixture(t);
  const tables = ['bots', 'groups', 'folders', 'members', 'messages', 'discussions', 'tasks', 'meta'];
  const records = new Map(tables.map(table => [`${table}/record.json`, JSON.stringify({ version: 1, value: { table, text: '已有记录' } })]));
  records.set('unknown/backup.json', '{"preserve":true}');
  records.set('.metadata', 'unchanged metadata');
  for (const [file, value] of records) await putFile(legacy, file, value);
  const before = await lstat(legacy);
  await relocateStorageDirectory(legacy);
  assert.equal((await lstat(target)).ino, before.ino, 'moves the original directory instead of reserializing records');
  for (const [file, value] of records) assert.equal(await readFile(path.join(target, file), 'utf8'), value);
  await assertAlias(legacy, target);
  await putFile(legacy, 'messages/after-migration.json', 'new message');
  await relocateStorageDirectory(legacy);
  assert.equal(await readFile(path.join(target, 'messages/after-migration.json'), 'utf8'), 'new message');
});

test('restart after the directory move restores the compatibility link without losing data', async t => {
  const { legacy, target } = await fixture(t);
  await putFile(target, 'meta/settings.json', 'saved settings');
  await relocateStorageDirectory(legacy);
  await assertAlias(legacy, target);
  assert.equal(await readFile(path.join(legacy, 'meta/settings.json'), 'utf8'), 'saved settings');
});

test('two existing directories fail without merging or overwriting either store', async t => {
  const { legacy, target } = await fixture(t);
  await putFile(legacy, 'messages/same.json', 'old store');
  await putFile(target, 'messages/same.json', 'new store');
  await assert.rejects(relocateStorageDirectory(legacy), /both storage directories exist/);
  assert.equal(await readFile(path.join(legacy, 'messages/same.json'), 'utf8'), 'old store');
  assert.equal(await readFile(path.join(target, 'messages/same.json'), 'utf8'), 'new store');
  assert.equal((await lstat(legacy)).isDirectory(), true);
});

test('unexpected files and links are rejected without touching their destinations', async t => {
  for (const variant of ['source-file', 'target-file', 'target-link', 'wrong-link', 'dangling-link']) {
    await t.test(variant, async t => {
      const { root, legacy, target } = await fixture(t);
      const outside = path.join(root, 'outside');
      await putFile(outside, 'preserve.txt', 'keep');
      if (variant === 'source-file') await writeFile(legacy, 'source file');
      if (variant === 'target-file') await writeFile(target, 'target file');
      if (variant === 'target-link') await link(outside, target);
      if (variant === 'wrong-link') { await mkdir(target); await link(outside, legacy); }
      if (variant === 'dangling-link') await link(target, legacy);
      await assert.rejects(relocateStorageDirectory(legacy), /storage (source|destination)|storage link/);
      assert.equal(await readFile(path.join(outside, 'preserve.txt'), 'utf8'), 'keep');
      if (variant === 'source-file') assert.equal(await readFile(legacy, 'utf8'), 'source file');
      if (variant === 'target-file') assert.equal(await readFile(target, 'utf8'), 'target file');
    });
  }
});

class PerRecordJsonUnit {
  constructor(dir, descriptor) { this.dir = dir; this.descriptor = descriptor; }
}
class JsonStorageBackend {
  constructor(root) { this.root = root; }
}
const spec = { name: 'bot_team', layout: 'per-record', version: 1, tables: {} };

function facility(root, open) {
  return {
    config: { backend: 'json' },
    ctx: { storage: { backend: { get: () => new JsonStorageBackend(root) } } },
    get: () => undefined,
    open,
  };
}

test('the selected backend route is relocated before opening, including custom roots', async t => {
  const { root, legacy, target } = await fixture(t);
  await putFile(legacy, 'messages/persisted.json', 'existing');
  const active = { unit: new PerRecordJsonUnit(legacy, spec), async close() {} };
  let opens = 0;
  const storageDomain = facility(root, async received => {
    opens++;
    assert.equal(received, spec);
    await assertAlias(legacy, target);
    assert.equal(await readFile(path.join(legacy, 'messages/persisted.json'), 'utf8'), 'existing');
    await putFile(legacy, 'messages/after-open.json', 'new');
    return active;
  });
  storageDomain.config.routes = { bot_team: 'custom' };
  storageDomain.ctx.storage.backend.get = name => {
    assert.equal(name, 'custom');
    return new JsonStorageBackend(root);
  };
  assert.equal(await openPluginStorageDomain(storageDomain, spec), active);
  assert.equal(opens, 1);
  assert.equal(await readFile(path.join(target, 'messages/after-open.json'), 'utf8'), 'new');
});

test('an open domain is neither relocated nor closed by a new plugin instance', async t => {
  const { root, legacy, target } = await fixture(t);
  await putFile(legacy, 'messages/persisted.json', 'existing');
  let closes = 0;
  const storageDomain = facility(root, () => assert.fail('must not open another domain'));
  storageDomain.get = name => {
    assert.equal(name, 'bot_team');
    return { async close() { closes++; } };
  };
  await assert.rejects(openPluginStorageDomain(storageDomain, spec), /storage domain is still open/);
  assert.equal(closes, 0);
  assert.equal((await lstat(legacy)).isDirectory(), true);
  await assert.rejects(lstat(target), { code: 'ENOENT' });
});

test('unsupported adapters fail before filesystem changes and never guess a root', async t => {
  const { root, legacy, target } = await fixture(t);
  await putFile(legacy, 'messages/persisted.json', 'existing');
  const unsupported = [undefined, {}, { root }, new JsonStorageBackend('relative/root')];
  for (const backend of unsupported) {
    const storageDomain = facility(root, () => assert.fail('unsupported backend must not be opened'));
    storageDomain.ctx.storage.backend.get = () => backend;
    await assert.rejects(openPluginStorageDomain(storageDomain, spec), /cannot resolve the JSON storage directory/);
    assert.equal(await readFile(path.join(legacy, 'messages/persisted.json'), 'utf8'), 'existing');
    await assert.rejects(lstat(target), { code: 'ENOENT' });
  }
  await assert.rejects(openPluginStorageDomain({ open() { assert.fail('must not open'); } }, spec), /cannot resolve/);
});

test('wrong links are rejected before legacy bootstrap can write into another directory', async t => {
  const { root, legacy, target } = await fixture(t);
  const outside = path.join(root, 'outside');
  await putFile(outside, 'preserve.txt', 'keep');
  await mkdir(target);
  await link(outside, legacy);
  await writeFile(path.join(root, 'bot_team.json'), 'legacy backup');
  const storageDomain = facility(root, () => assert.fail('must not bootstrap an unchecked alias'));
  await assert.rejects(openPluginStorageDomain(storageDomain, spec), /unexpected or broken storage link/);
  assert.equal(await readFile(path.join(outside, 'preserve.txt'), 'utf8'), 'keep');
  assert.equal(await readFile(path.join(root, 'bot_team.json'), 'utf8'), 'legacy backup');
});

test('interrupted migration repairs the link before legacy bootstrap is allowed to run', async t => {
  const { root, legacy, target } = await fixture(t);
  await putFile(target, 'messages/persisted.json', 'latest record');
  await writeFile(path.join(root, 'bot_team.json'), 'older legacy backup');
  let opens = 0;
  const storageDomain = facility(root, async () => {
    opens++;
    await assertAlias(legacy, target);
    assert.equal(await readFile(path.join(legacy, 'messages/persisted.json'), 'utf8'), 'latest record');
    return { unit: new PerRecordJsonUnit(legacy, spec), async close() {} };
  });
  await openPluginStorageDomain(storageDomain, spec);
  assert.equal(opens, 1);
  assert.equal(await readFile(path.join(target, 'messages/persisted.json'), 'utf8'), 'latest record');
  assert.equal(await readFile(path.join(root, 'bot_team.json'), 'utf8'), 'older legacy backup');
});

test('the opened unit must agree with the selected backend directory', async t => {
  const { root, legacy, target } = await fixture(t);
  let closes = 0;
  const storageDomain = facility(root, async () => ({
    unit: new PerRecordJsonUnit(path.join(root, 'unexpected', 'bot_team'), spec),
    async close() { closes++; },
  }));
  await assert.rejects(openPluginStorageDomain(storageDomain, spec), /cannot resolve/);
  assert.equal(closes, 1);
  await assertAlias(legacy, target);
});
