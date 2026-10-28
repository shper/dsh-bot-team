/** Read-only npm update detection. No install operations or recurring work. */
import { randomUUID } from 'node:crypto';
import semver from 'semver';

export const UPDATE_REGISTRY_URL = 'https://registry.npmjs.org/dsh-bot-team';
export const RELEASE_NOTES_URL = 'https://github.com/shper/dsh-bot-team/blob/main/CHANGELOG.md';
export const RELEASE_NOTES_SOURCE_URL = 'https://raw.githubusercontent.com/shper/dsh-bot-team/main/CHANGELOG.md';
const NPM_PACKAGE_URL = 'https://www.npmjs.com/package/dsh-bot-team';
const SEMVER_OPTIONS = { includePrerelease: true };

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const validVersion = value => typeof value === 'string' && semver.valid(value) ? value.trim() : null;
const versionUrl = version => version ? NPM_PACKAGE_URL + '/v/' + encodeURIComponent(version) : NPM_PACKAGE_URL;

/**
 * DSH app-boot documents this getter as the single version used for admission.
 * Its implementation reads the running app-boot package's own manifest. Do not
 * infer a runtime from this plugin's engines range or a workspace installation.
 * The runtime resolver supplies this host module; bare Node/embedders may not.
 */
export async function resolveDshRuntimeVersion(load = () => import('@deepseek-ai/dsh-app-boot')) {
  try {
    const host = await load();
    return validVersion(await host.getDshRuntimeVersion());
  } catch {
    return null;
  }
}

function acceptsRange(runtimeVersion, range) {
  return typeof range === 'string' && range.trim() !== '' &&
    semver.validRange(range, SEMVER_OPTIONS) !== null && semver.satisfies(runtimeVersion, range, SEMVER_OPTIONS);
}

/** Match DSH admission semantics, including prerelease runtimes and peer fallback. */
function compatibilityOf(manifest, runtimeVersion) {
  if (!runtimeVersion) return 'unknown';
  if (own(manifest, 'engines')) {
    if (!isRecord(manifest.engines)) return 'incompatible';
    if (own(manifest.engines, 'dsh')) {
      return acceptsRange(runtimeVersion, manifest.engines.dsh) ? 'compatible' : 'incompatible';
    }
  }
  if (own(manifest, 'peerDependencies')) {
    if (!isRecord(manifest.peerDependencies)) return 'incompatible';
    for (const [name, range] of Object.entries(manifest.peerDependencies)) {
      if (typeof range !== 'string') return 'incompatible';
      if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue;
      const effective = ['workspace:^', 'workspace:~', 'workspace:*'].includes(range) ? runtimeVersion : range;
      if (!acceptsRange(runtimeVersion, effective)) return 'incompatible';
    }
  }
  return 'compatible';
}

class UpdateCheckError extends Error {}

function manifestOf(versions, version) {
  const manifest = own(versions, version) ? versions[version] : null;
  if (!isRecord(manifest) || manifest.version !== version) return null;
  if (own(manifest, 'name') && manifest.name !== 'dsh-bot-team') return null;
  return manifest;
}

function selectVersions(metadata, currentVersion, runtimeVersion) {
  if (!validVersion(currentVersion)) throw new UpdateCheckError('Current plugin version is not valid SemVer.');
  if (!isRecord(metadata) || !isRecord(metadata['dist-tags']) || !isRecord(metadata.versions)) {
    throw new UpdateCheckError('npm returned invalid package metadata.');
  }
  const latestVersion = validVersion(metadata['dist-tags'].latest);
  if (!latestVersion || semver.prerelease(latestVersion) !== null) {
    throw new UpdateCheckError('npm latest does not identify a stable version.');
  }
  const latest = manifestOf(metadata.versions, latestVersion);
  if (!latest) throw new UpdateCheckError('npm latest version metadata is missing or invalid.');

  let availableVersion = null;
  // npm latest is the stable release ceiling: a newer next/beta tag, even if
  // its version string is stable, is never automatically recommended.
  for (const version of Object.keys(metadata.versions)) {
    if (!validVersion(version) || semver.prerelease(version) !== null ||
      !semver.gt(version, currentVersion) || semver.gt(version, latestVersion)) continue;
    const manifest = manifestOf(metadata.versions, version);
    if (!manifest || compatibilityOf(manifest, runtimeVersion) !== 'compatible') continue;
    if (!availableVersion || semver.gt(version, availableVersion)) availableVersion = version;
  }
  return {
    runtimeVersion,
    latestVersion,
    availableVersion,
    hasUpdate: availableVersion !== null,
    // These two fields describe latest, even when a lower version is safe.
    compatibility: compatibilityOf(latest, runtimeVersion),
    requiredDsh: typeof latest.engines?.dsh === 'string' ? latest.engines.dsh : null,
    releaseNotesUrl: RELEASE_NOTES_URL,
    updateUrl: versionUrl(availableVersion || latestVersion),
  };
}

function cancelBody(body, reason) {
  try { void body?.cancel(reason).catch(() => {}); } catch { /* already closed/locked */ }
}

async function readResponseText(response, signal, maxBytes) {
  if (signal.aborted) {
    cancelBody(response.body, signal.reason);
    throw signal.reason;
  }
  if (!response.ok) {
    cancelBody(response.body);
    throw new UpdateCheckError('npm registry returned HTTP ' + response.status + '.');
  }
  const contentLength = Number(response.headers?.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    cancelBody(response.body);
    throw new UpdateCheckError('npm package metadata exceeds the size limit.');
  }
  if (typeof response.body?.getReader !== 'function') {
    cancelBody(response.body);
    throw new UpdateCheckError('npm returned an unreadable response body.');
  }
  const reader = response.body.getReader();
  const cancel = () => cancelBody(reader, signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new UpdateCheckError('npm package metadata exceeds the size limit.');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  } catch (error) {
    cancelBody(reader, error);
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

/** Exact version headings only; Unreleased and headings inside code are ignored. */
function extractReleaseNotes(markdown, version) {
  const lines = markdown.split(/\r?\n/);
  let start = -1;
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = /^##[ \t]+(.+)$/.exec(line)?.[1];
    if (start !== -1 && /^#{1,2}[ \t]+/.test(line)) return lines.slice(start, index).join('\n').trim() || null;
    if (!heading) continue;
    const closingBracket = heading.indexOf(']');
    const token = heading.startsWith('[')
      ? (closingBracket > 1 ? heading.slice(1, closingBracket) : null)
      : heading.split(/[ \t]/)[0];
    if (token === version) start = index + 1;
  }
  return start === -1 ? null : lines.slice(start).join('\n').trim() || null;
}

/**
 * One checker per service. fetch/getRuntimeVersion/now are injectable so tests
 * exercise the real startup path without network requests or environment flags.
 * GET reads snapshot(); check({ force: true }) bypasses only the success cache,
 * always joining an existing request. Errors keep the last successful fields.
 */
export class UpdateChecker {
  constructor({ currentVersion, fetch: fetchImpl = globalThis.fetch,
    getRuntimeVersion = resolveDshRuntimeVersion, now = Date.now,
    timeoutMs = 10000, maxBytes = 2 * 1024 * 1024, cacheTtlMs = 5 * 60 * 1000,
    notesTimeoutMs = 2000, notesMaxBytes = 128 * 1024,
    onChange = () => {} } = {}) {
    this.fetch = fetchImpl;
    this.getRuntimeVersion = getRuntimeVersion;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
    this.cacheTtlMs = cacheTtlMs;
    this.notesTimeoutMs = notesTimeoutMs;
    this.notesMaxBytes = notesMaxBytes;
    this.onChange = onChange;
    this.inFlight = null;
    this.controller = null;
    this.disposed = false;
    this.lastSuccessAt = null;
    this.state = {
      instanceId: randomUUID(),
      revision: 0,
      status: 'idle',
      currentVersion,
      runtimeVersion: null,
      latestVersion: null,
      availableVersion: null,
      hasUpdate: false,
      compatibility: null,
      requiredDsh: null,
      checkedAt: null,
      error: null,
      releaseNotes: null,
      releaseNotesVersion: null,
      releaseNotesUrl: RELEASE_NOTES_URL,
      updateUrl: versionUrl(validVersion(currentVersion)),
    };
  }

  snapshot() { return { ...this.state }; }

  publish(fields) {
    this.state = { ...this.state, ...fields, revision: this.state.revision + 1 };
    try { this.onChange(this.snapshot()); } catch { /* observers cannot fail a check */ }
  }

  async request(signal, onMetadata) {
    signal.throwIfAborted();
    const [metadata, rawRuntimeVersion] = await Promise.all([
      Promise.resolve().then(async () => {
        const response = await this.fetch(UPDATE_REGISTRY_URL, {
          method: 'GET',
          headers: { accept: 'application/vnd.npm.install-v1+json' },
          redirect: 'error',
          cache: 'no-store',
          signal,
        });
        const text = await readResponseText(response, signal, this.maxBytes);
        try { return JSON.parse(text); }
        catch { throw new UpdateCheckError('npm returned invalid JSON.'); }
      }),
      Promise.resolve().then(() => this.getRuntimeVersion()).catch(() => null),
    ]);
    const result = {
      ...selectVersions(metadata, this.state.currentVersion, validVersion(rawRuntimeVersion)),
      releaseNotes: null, releaseNotesVersion: null,
    };
    onMetadata(result);
    const notesVersion = result.availableVersion ||
      (semver.gt(result.latestVersion, this.state.currentVersion) ? result.latestVersion : null);
    if (notesVersion) {
      const releaseNotes = await this.readReleaseNotes(notesVersion, signal);
      if (releaseNotes) return { ...result, releaseNotes, releaseNotesVersion: notesVersion };
    }
    return result;
  }

  async readReleaseNotes(version, signal) {
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason);
    if (signal.aborted) return null;
    signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(), this.notesTimeoutMs);
    let onAbort;
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const text = await Promise.race([
        Promise.resolve().then(async () => {
          controller.signal.throwIfAborted();
          const response = await this.fetch(RELEASE_NOTES_SOURCE_URL, {
            method: 'GET', headers: { accept: 'text/plain' }, redirect: 'error',
            cache: 'no-store', signal: controller.signal,
          });
          return readResponseText(response, controller.signal, this.notesMaxBytes);
        }),
        cancelled,
      ]);
      return extractReleaseNotes(text, version);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      controller.signal.removeEventListener('abort', onAbort);
      controller.abort();
    }
  }

  check({ force = false } = {}) {
    if (this.disposed) return Promise.resolve(this.snapshot());
    if (this.inFlight) return this.inFlight;
    const age = this.lastSuccessAt === null ? Infinity : this.now() - this.lastSuccessAt;
    if (!force && this.state.status === 'ready' && age >= 0 && age < this.cacheTtlMs) {
      return Promise.resolve(this.snapshot());
    }
    const previous = this.snapshot();
    const controller = new AbortController();
    this.controller = controller;
    let onAbort;
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const timer = setTimeout(() => controller.abort(new UpdateCheckError('Update check timed out.')), this.timeoutMs);
    // The race also bounds injected/custom fetch implementations which ignore
    // AbortSignal. Late completions never publish a stale result after dispose.
    let metadataResult = null;
    const ready = result => {
      this.lastSuccessAt = this.now();
      this.publish({ ...result, status: 'ready', checkedAt: new Date(this.lastSuccessAt).toISOString(), error: null });
    };
    this.inFlight = Promise.race([Promise.resolve().then(() => this.request(controller.signal, result => { metadataResult = result; })), cancelled])
      .then(result => {
        if (!this.disposed) ready(result);
      })
      .catch(error => {
        if (!this.disposed) {
          // A notes timeout must not discard a successful npm version lookup.
          if (metadataResult) ready(metadataResult);
          else this.publish({ status: 'error', error: error instanceof UpdateCheckError
            ? error.message : 'Unable to check the npm registry.' });
        }
      })
      .finally(() => {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', onAbort);
        controller.abort();
        this.controller = null;
        this.inFlight = null;
        if (this.disposed && this.state.status === 'checking') {
          this.state = { ...previous, revision: this.state.revision + 1 };
        }
      })
      .then(() => this.snapshot());
    this.publish({ status: 'checking', error: null });
    return this.inFlight;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.controller?.abort(new UpdateCheckError('Update check cancelled.'));
  }
}
