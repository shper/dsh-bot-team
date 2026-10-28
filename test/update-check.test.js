import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { UpdateChecker, resolveDshRuntimeVersion, UPDATE_REGISTRY_URL, RELEASE_NOTES_URL, RELEASE_NOTES_SOURCE_URL } from '../host/update-check.js';
import { BotTeamService, PLUGIN_INFO } from '../host/service.js';
import { resolveConfig } from '../host/util.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function packument(latest = '1.2.3', releases = {}) {
  const versions = Object.fromEntries(Object.entries(releases).map(([version, fields]) => [version, {
    name: 'dsh-bot-team', version, ...fields,
  }]));
  versions[latest] ??= { name: 'dsh-bot-team', version: latest, engines: { dsh: '^0.2.1-rc.3' } };
  return { 'dist-tags': { latest }, versions };
}

function checker(t, metadata = packument(), options = {}) {
  const calls = [];
  const { registry, notes, ...dependencies } = options;
  const updates = new UpdateChecker({
    currentVersion: '1.2.2',
    getRuntimeVersion: async () => '0.2.1-rc.3',
    fetch: async (url, init) => {
      assert.ok([UPDATE_REGISTRY_URL, RELEASE_NOTES_SOURCE_URL].includes(url), 'only the two fixed read-only sources are allowed');
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'error');
      assert.equal(init.cache, 'no-store');
      assert.ok(init.signal instanceof AbortSignal);
      calls.push({ url, ...init });
      if (url === UPDATE_REGISTRY_URL) return registry ? registry(init) : Response.json(metadata);
      return notes ? notes(init) : new Response('', { status: 404 });
    },
    ...dependencies,
  });
  t.after(() => updates.dispose());
  return { updates, calls, registryCalls: () => calls.filter(call => call.url === UPDATE_REGISTRY_URL) };
}

test('runtime detection uses the host getter and never treats a requirement as a runtime version', async () => {
  assert.equal(await resolveDshRuntimeVersion(async () => ({ getDshRuntimeVersion: () => '0.2.1-rc.3' })), '0.2.1-rc.3');
  for (const value of [null, undefined, '^0.2.1-rc.3', 'latest', 2]) {
    assert.equal(await resolveDshRuntimeVersion(async () => ({ getDshRuntimeVersion: () => value })), null);
  }
  assert.equal(await resolveDshRuntimeVersion(async () => { throw new Error('host absent'); }), null);
  assert.equal(await resolveDshRuntimeVersion(async () => ({})), null);
});

test('idle snapshots are isolated and service generations have distinct identities', t => {
  const first = checker(t).updates;
  const second = checker(t).updates;
  const idle = first.snapshot();
  assert.equal(idle.status, 'idle');
  assert.equal(idle.revision, 0);
  assert.equal(idle.currentVersion, '1.2.2');
  assert.equal(idle.checkedAt, null);
  assert.equal(idle.compatibility, null);
  assert.equal(idle.releaseNotes, null);
  assert.notEqual(idle.instanceId, second.snapshot().instanceId);
  idle.hasUpdate = true;
  assert.equal(first.snapshot().hasUpdate, false);
});

test('SemVer numeric ordering and latest ceiling exclude prereleases and next-only versions', async t => {
  const metadata = packument('1.10.0', {
    '1.9.1': {}, '1.10.0': {}, '1.11.0': {}, '2.0.0-beta.1': {}, broken: {},
  });
  metadata['dist-tags'].next = '1.11.0';
  metadata['dist-tags'].beta = '2.0.0-beta.1';
  const { updates } = checker(t, metadata, { currentVersion: '1.9.0' });
  const result = await updates.check();
  assert.equal(result.status, 'ready');
  assert.equal(result.latestVersion, '1.10.0');
  assert.equal(result.availableVersion, '1.10.0');
  assert.equal(result.hasUpdate, true);
  assert.equal(result.compatibility, 'compatible');
});

test('a lower compatible update remains available while latest exposes its incompatible requirement', async t => {
  const metadata = packument('2.0.0', {
    '1.3.0': { engines: { dsh: '>=0.2.0 <0.3.0' } },
    '1.9.0': { engines: { dsh: '^0.2.1-rc.3' } },
    '1.10.0': { engines: { dsh: '>=0.3.0' } },
    '2.0.0': { engines: { dsh: '^1.0.0' } },
  });
  const { updates } = checker(t, metadata, {
    notes: async () => new Response('## 未发布\nDo not use\n## [1.9.0](https://example.com/commit) — date\n- Safe version notes\n## 1.3.0\nOld notes'),
  });
  const result = await updates.check();
  assert.equal(result.latestVersion, '2.0.0');
  assert.equal(result.availableVersion, '1.9.0');
  assert.equal(result.compatibility, 'incompatible');
  assert.equal(result.requiredDsh, '^1.0.0');
  assert.equal(result.hasUpdate, true);
  assert.equal(result.updateUrl, 'https://www.npmjs.com/package/dsh-bot-team/v/1.9.0');
  assert.equal(result.releaseNotes, '- Safe version notes');
  assert.equal(result.releaseNotesVersion, '1.9.0');
});

test('latest remains visible when every update is incompatible', async t => {
  const { updates } = checker(t, packument('2.0.0', { '2.0.0': { engines: { dsh: '^1.0.0' } } }), {
    notes: async () => new Response('## [2.0.0]\n- Requires a newer DSH'),
  });
  const result = await updates.check();
  assert.equal(result.compatibility, 'incompatible');
  assert.equal(result.availableVersion, null);
  assert.equal(result.hasUpdate, false);
  assert.equal(result.latestVersion, '2.0.0');
  assert.equal(result.releaseNotesVersion, '2.0.0');
});

test('unknown runtime versions explicitly prevent compatibility claims even without engines', async t => {
  for (const getRuntimeVersion of [async () => null, async () => '^0.2.1', async () => { throw new Error('missing host'); }]) {
    const { updates } = checker(t, packument('1.2.3', { '1.2.3': {} }), { getRuntimeVersion });
    const result = await updates.check();
    assert.equal(result.status, 'ready');
    assert.equal(result.runtimeVersion, null);
    assert.equal(result.compatibility, 'unknown');
    assert.equal(result.availableVersion, null);
    assert.equal(result.hasUpdate, false);
  }
});

test('engine range matching follows DSH prerelease, malformed manifest, and peer precedence semantics', async t => {
  const cases = [
    [{ engines: { dsh: '>=0.2.0 <0.3.0 || ^1.0.0' } }, 'compatible'],
    [{ engines: { dsh: '0.2.0 - 0.2.5' } }, 'compatible'],
    [{ engines: { dsh: '0.2.x' } }, 'compatible'],
    [{ engines: { dsh: '*' } }, 'compatible'],
    [{}, 'compatible'],
    [{ engines: { dsh: '' } }, 'incompatible'],
    [{ engines: { dsh: 'not a range' } }, 'incompatible'],
    [{ engines: { dsh: 'workspace:*' } }, 'incompatible'],
    [{ engines: { dsh: null } }, 'incompatible'],
    [{ engines: [] }, 'incompatible'],
    [{ engines: { dsh: '^0.2.1-rc.3' }, peerDependencies: { '@deepseek-ai/dsh': '^9.0.0' } }, 'compatible'],
    [{ peerDependencies: { '@deepseek-ai/dsh': '^9.0.0' } }, 'incompatible'],
    [{ peerDependencies: { '@deepseek-ai/dsh-agents': 'workspace:*', other: '^9.0.0' } }, 'compatible'],
  ];
  for (const [fields, expected] of cases) {
    const { updates } = checker(t, packument('1.2.3', { '1.2.3': fields }));
    const result = await updates.check();
    assert.equal(result.compatibility, expected, JSON.stringify(fields));
    assert.equal(result.hasUpdate, expected === 'compatible');
  }
});

test('no downgrade or build-only update is offered, while an installed prerelease can update to stable', async t => {
  for (const [currentVersion, hasUpdate] of [['1.2.3', false], ['1.2.3+local', false], ['2.0.0', false], ['1.2.3-rc.1', true]]) {
    const { updates, calls } = checker(t, packument(), { currentVersion });
    const result = await updates.check();
    assert.equal(result.hasUpdate, hasUpdate, currentVersion);
    assert.equal(calls.length, hasUpdate ? 2 : 1, 'release notes are requested only for an update');
  }
});

test('malformed npm data and a prerelease latest fail without inventing stable releases', async t => {
  for (const metadata of [null, {}, { 'dist-tags': { latest: '1.2.3' }, versions: {} },
    packument('1.3.0-beta.1'), packument('not-semver'),
    { 'dist-tags': { latest: '1.2.3' }, versions: { '1.2.3': { version: '9.0.0' } } }]) {
    const { updates } = checker(t, metadata);
    const result = await updates.check();
    assert.equal(result.status, 'error', JSON.stringify(metadata));
    assert.equal(result.checkedAt, null);
    assert.equal(result.latestVersion, null);
    assert.equal(result.hasUpdate, false);
    assert.ok(result.error);
  }
});

test('concurrent forced checks join one request; only explicit checks can bypass or expire cache', async t => {
  const gate = deferred(); const started = deferred(); const transitions = [];
  let clock = Date.parse('2026-10-28T00:00:00Z'); let request = 0;
  const { updates, registryCalls } = checker(t, packument('1.2.2'), {
    now: () => clock, cacheTtlMs: 50, onChange: value => transitions.push(value),
    registry: async () => { request += 1; started.resolve(); if (request === 1) await gate.promise; return Response.json(packument('1.2.2')); },
  });
  const first = updates.check();
  assert.equal(updates.snapshot().status, 'checking');
  assert.equal(updates.check({ force: true }), first);
  await started.promise;
  assert.equal(registryCalls().length, 1);
  gate.resolve();
  const success = await first;
  assert.equal(success.revision, 2);
  assert.deepEqual(await updates.check(), success);
  assert.equal(registryCalls().length, 1);
  clock += 1;
  await updates.check({ force: true });
  assert.equal(registryCalls().length, 2);
  clock += 100;
  assert.equal(registryCalls().length, 2, 'cache expiry alone never starts a periodic task');
  await updates.check();
  assert.equal(registryCalls().length, 3);
  assert.deepEqual(transitions.map(value => value.revision), [1, 2, 3, 4, 5, 6]);
  assert.equal(new Set(transitions.map(value => value.instanceId)).size, 1);
});

test('failed checks preserve successful data and notes; a later successful check clears stale error and notes', async t => {
  let mode = 'first';
  const { updates } = checker(t, packument(), {
    registry: async () => {
      if (mode === 'error') throw new Error('offline');
      return Response.json(packument(mode === 'new' ? '1.2.4' : '1.2.3'));
    },
    notes: async () => new Response('## 1.2.3\n- Recorded change'),
  });
  const success = await updates.check();
  mode = 'error';
  const pending = updates.check({ force: true });
  assert.equal(updates.snapshot().releaseNotes, success.releaseNotes);
  const failure = await pending;
  for (const key of Object.keys(success).filter(key => !['status', 'revision', 'error'].includes(key))) {
    assert.deepEqual(failure[key], success[key], key);
  }
  assert.equal(failure.status, 'error');
  assert.ok(failure.error);
  mode = 'new';
  const recovered = await updates.check({ force: true });
  assert.equal(recovered.status, 'ready');
  assert.equal(recovered.error, null);
  assert.equal(recovered.availableVersion, '1.2.4');
  assert.equal(recovered.releaseNotes, null);
  assert.equal(recovered.releaseNotesVersion, null);
});

test('timeout aborts fetch even when the implementation ignores its signal and ignores late completions', async t => {
  const gate = deferred();
  const { updates, calls } = checker(t, packument(), { timeoutMs: 15, registry: () => gate.promise });
  const result = await updates.check();
  assert.equal(result.status, 'error');
  assert.match(result.error, /timed out/);
  assert.equal(calls[0].signal.aborted, true);
  gate.resolve(Response.json(packument()));
  await tick();
  assert.deepEqual(updates.snapshot(), result);
});

test('timeout includes streamed response bodies and cancels their reader', async t => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
    cancel() { cancelled = true; },
  });
  const { updates } = checker(t, {}, { timeoutMs: 15, registry: async () => new Response(body) });
  const result = await updates.check();
  assert.equal(result.status, 'error');
  assert.match(result.error, /timed out/);
  assert.equal(cancelled, true);
});

test('registry HTTP, JSON and byte limits are bounded failures', async t => {
  for (const [registry, expected] of [
    [async () => new Response('denied', { status: 503 }), /HTTP 503/],
    [async () => new Response('not JSON'), /invalid JSON/],
    [async () => new Response('{}', { headers: { 'content-length': '9999' } }), /size limit/],
    [async () => new Response('😀'.repeat(10), { headers: { 'content-length': '1' } }), /size limit/],
  ]) {
    const { updates, calls } = checker(t, {}, { maxBytes: 16, registry });
    const result = await updates.check();
    assert.equal(result.status, 'error');
    assert.match(result.error, expected);
    assert.equal(calls[0].signal.aborted, true);
  }
});

test('dispose cancels pending work and prevents future requests or stale publication', async t => {
  const gate = deferred(); const started = deferred(); const observed = [];
  const { updates, calls } = checker(t, {}, {
    registry: () => { started.resolve(); return gate.promise; },
    onChange: snapshot => observed.push(snapshot),
  });
  const promise = updates.check();
  await started.promise;
  updates.dispose();
  assert.equal(calls[0].signal.aborted, true);
  const stopped = await promise;
  assert.equal(stopped.status, 'idle');
  assert.equal(stopped.latestVersion, null);
  gate.resolve(Response.json(packument()));
  await tick();
  assert.deepEqual(updates.snapshot(), stopped);
  assert.deepEqual(await updates.check({ force: true }), stopped);
  assert.equal(calls.length, 1);
  assert.deepEqual(observed.map(value => value.status), ['checking']);
});

test('an immediate unload never starts a deferred network request', async t => {
  const { updates, calls } = checker(t);
  const pending = updates.check();
  updates.dispose();
  await pending;
  assert.equal(calls.length, 0);
});

test('release notes match only the selected version section and retain markdown as inert text', async t => {
  const content = '# Changelog\r\n## Unreleased\r\nDo not publish\r\n## [1.2.3](https://example.com/commit) — date\r\n### Added\r\n- Real note\r\n~~~text\r\n## Fake heading in code\r\n~~~\r\n<script>inert</script>\r\n## [1.2.2]\r\nOld note';
  const metadata = packument();
  metadata.repository = { url: 'https://untrusted.example.com' };
  metadata.versions['1.2.3'].readme = 'not release notes';
  const { updates, calls } = checker(t, metadata, { notes: async () => new Response(content) });
  const result = await updates.check();
  assert.equal(result.releaseNotes, '### Added\n- Real note\n~~~text\n## Fake heading in code\n~~~\n<script>inert</script>');
  assert.equal(result.releaseNotesVersion, '1.2.3');
  assert.equal(result.releaseNotesUrl, RELEASE_NOTES_URL);
  assert.equal(result.updateUrl, 'https://www.npmjs.com/package/dsh-bot-team/v/1.2.3');
  assert.deepEqual(calls.map(call => call.url), [UPDATE_REGISTRY_URL, RELEASE_NOTES_SOURCE_URL]);
});

test('missing, wrong-version, empty, oversized and failed release notes never fail npm detection', async t => {
  for (const notes of [
    async () => new Response('', { status: 404 }),
    async () => new Response('## Unreleased\nPending only\n## 1.2.30\nWrong version'),
    async () => new Response('## 1.2.3\n\n## 1.2.2\nPrevious'),
    async () => new Response('## [1.2.3X\nMalformed heading'),
    async () => new Response('x'.repeat(200)),
    async () => { throw new Error('GitHub unavailable'); },
  ]) {
    const { updates } = checker(t, packument(), { notes, notesMaxBytes: 128 });
    const result = await updates.check();
    assert.equal(result.status, 'ready');
    assert.equal(result.error, null);
    assert.equal(result.availableVersion, '1.2.3');
    assert.equal(result.releaseNotes, null);
    assert.equal(result.releaseNotesVersion, null);
  }
});

test('both notes-specific and whole-check deadlines preserve successful npm results', async t => {
  for (const limits of [{ timeoutMs: 500, notesTimeoutMs: 15 }, { timeoutMs: 15, notesTimeoutMs: 500 }]) {
    const { updates, calls } = checker(t, packument(), { ...limits, notes: () => new Promise(() => {}) });
    const result = await updates.check();
    assert.equal(result.status, 'ready');
    assert.equal(result.hasUpdate, true);
    assert.equal(result.releaseNotes, null);
    assert.equal(calls.find(call => call.url === RELEASE_NOTES_SOURCE_URL).signal.aborted, true);
  }
});

async function serviceFixture(t, updateCheck) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'bot-team-update-'));
  const tables = new Map(); const routes = [];
  const storageRoot = path.join(home, 'storages');
  const domain = {
    unit: { constructor: { name: 'PerRecordJsonUnit' }, descriptor: { name: 'bot_team', layout: 'per-record' }, dir: path.join(storageRoot, 'bot_team') },
    table(name) {
      if (!tables.has(name)) tables.set(name, new Map());
      const records = tables.get(name);
      return {
        entries: () => [...records].map(([key, value]) => [key, structuredClone(value)]),
        async put(key, value) { records.set(key, structuredClone(value)); },
        async delete(key) { records.delete(key); },
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
    connection: { fetch: { register: route => { routes.push(route); return () => {}; } } },
    tools: { register: () => () => {} }, on: () => () => {}, get: () => undefined,
    agents: {}, agentPresets: {},
  };
  const service = new BotTeamService(ctx, resolveConfig({ dataDir: path.join(home, 'data'), defaultCwd: home, migrateLegacyLayout: false }), {
    updateCheck: { getRuntimeVersion: async () => '0.2.1-rc.3', ...updateCheck },
  });
  t.after(async () => { await service.dispose(); await rm(home, { recursive: true, force: true }); });
  return { service, route: routes.find(route => route.path === '/api/bot-team.update') };
}

test('startup is asynchronous; bootstrap and GET are snapshots; POST waits, merges, and bypasses cache without a group', async t => {
  const gates = [deferred(), deferred()]; const starts = [deferred(), deferred()]; let requests = 0;
  const { service, route } = await serviceFixture(t, { fetch: async url => {
    assert.equal(url, UPDATE_REGISTRY_URL);
    const index = requests++;
    starts[index].resolve();
    return gates[index].promise;
  } });
  assert.deepEqual(route.methods, ['GET', 'POST']);
  await starts[0].promise;
  await service.ready;
  assert.equal(service.updateChecker.snapshot().status, 'checking', 'ready did not await npm');
  const bootstrap = await (await service.handleBootstrap()).json();
  assert.equal(bootstrap.updateInfo.status, 'checking');
  assert.deepEqual(bootstrap.groups, []);
  const get = () => route.fetch(new Request('http://localhost/api/bot-team.update'));
  const post = () => route.fetch(new Request('http://localhost/api/bot-team.update', { method: 'POST' }));
  const read = await (await get()).json();
  assert.equal(read.ok, true);
  assert.equal(read.updateInfo.instanceId, bootstrap.updateInfo.instanceId);
  assert.equal(requests, 1);
  let completed = false;
  const pending = post().then(response => { completed = true; return response; });
  await tick();
  assert.equal(completed, false);
  assert.equal(requests, 1);
  gates[0].resolve(Response.json(packument(PLUGIN_INFO.version)));
  const first = await (await pending).json();
  assert.equal(first.updateInfo.status, 'ready');
  assert.equal(first.updateInfo.currentVersion, PLUGIN_INFO.version);
  assert.deepEqual((await (await get()).json()).updateInfo, first.updateInfo);
  const manual = post();
  const simultaneous = post();
  await starts[1].promise;
  assert.equal(requests, 2);
  assert.equal((await (await get()).json()).updateInfo.status, 'checking');
  gates[1].resolve(Response.json(packument(PLUGIN_INFO.version)));
  const refreshed = await (await manual).json();
  assert.deepEqual((await (await simultaneous).json()).updateInfo, refreshed.updateInfo);
  assert.ok(refreshed.updateInfo.revision > first.updateInfo.revision);
  assert.equal(requests, 2);
});

test('network failure does not block chat startup or bootstrap; service disposal aborts a subsequent check', async t => {
  let fail = true; const started = deferred(); let signal;
  const { service, route } = await serviceFixture(t, { fetch: async (_url, init) => {
    if (fail) throw new Error('offline');
    signal = init.signal;
    started.resolve();
    return new Promise(() => {});
  } });
  await service.ready;
  await service.updateChecker.check();
  const bootstrap = await (await service.handleBootstrap()).json();
  assert.equal(bootstrap.ok, true);
  assert.equal(bootstrap.updateInfo.status, 'error');
  assert.equal((await service.createGroup({ title: 'Chat remains available' })).title, 'Chat remains available');
  fail = false;
  const pending = route.fetch(new Request('http://localhost/api/bot-team.update', { method: 'POST' }));
  await started.promise;
  await service.dispose();
  assert.equal(signal.aborted, true);
  assert.equal((await (await pending).json()).updateInfo.status, 'error');
});
