/**
 * DSH 0.2 JSON storage accepts underscores in unit names, but not hyphens.
 * Keep the legal unit name and relocate its physical directory, leaving a
 * directory link for the backend (and older plugin versions) to follow.
 */
import path from 'node:path';
import { lstat, mkdir, readlink, rename, symlink } from 'node:fs/promises';

export const STORAGE_DIRECTORY_NAME = 'dsh-bot-team';

async function inspect(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Runs only while the storage domain is closed. Never merges two stores. */
export async function relocateStorageDirectory(legacyDirectory) {
  const legacy = path.resolve(legacyDirectory);
  if (path.basename(legacy) !== 'bot_team') {
    throw new Error(`bot-team: unexpected storage directory: ${legacy}`);
  }
  const root = path.dirname(legacy);
  const target = path.join(root, STORAGE_DIRECTORY_NAME);
  const [sourceInfo, targetInfo] = await Promise.all([inspect(legacy), inspect(target)]);
  if (targetInfo && !targetInfo.isDirectory()) {
    throw new Error(`bot-team: storage destination must be a real directory: ${target}`);
  }
  if (sourceInfo?.isSymbolicLink()) {
    const destination = path.resolve(root, await readlink(legacy));
    if (destination !== target || !targetInfo) {
      throw new Error(`bot-team: unexpected or broken storage link: ${legacy} -> ${destination}`);
    }
    return target;
  }
  if (sourceInfo && !sourceInfo.isDirectory()) {
    throw new Error(`bot-team: storage source is not a directory: ${legacy}`);
  }
  if (sourceInfo && targetInfo) {
    throw new Error(`bot-team: both storage directories exist; resolve the conflict before enabling the plugin: ${legacy}, ${target}`);
  }

  if (sourceInfo) {
    // Both paths are validated siblings; rename preserves all records and metadata.
    await rename(legacy, target);
  } else {
    // Also resumes an interrupted migration that moved the directory already.
    await mkdir(target, { recursive: true });
  }
  try {
    // Windows junctions need an absolute target; POSIX links stay relocatable.
    await symlink(process.platform === 'win32' ? target : STORAGE_DIRECTORY_NAME, legacy, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    // Restore the original location if creating the compatibility link failed.
    // Never overwrite a source directory recreated by another process.
    if (sourceInfo && !(await inspect(legacy))) {
      try {
        await rename(target, legacy);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `bot-team: storage link creation and rollback failed; data remains at ${target}`);
      }
    }
    throw error;
  }
  return target;
}

/**
 * Isolate the installed DSH 0.2 JSON adapter's implementation-specific fields.
 * The public domain API has no directory getter: resolve its configured route
 * and require a recognized JSON backend instead of guessing DSH_HOME. This must
 * precede open(), whose legacy single-file bootstrap can itself write records.
 */
export async function openPluginStorageDomain(storageDomain, spec, logger) {
  const unsupported = () => new Error('bot-team: cannot resolve the JSON storage directory; this layout requires the DSH 0.2 per-record JSON backend');
  const backendName = storageDomain.config?.routes?.[spec.name] ?? storageDomain.config?.backend;
  const registry = storageDomain.ctx?.storage?.backend;
  if (spec.name !== 'bot_team' || spec.layout !== 'per-record'
    || typeof backendName !== 'string' || !backendName
    || typeof registry?.get !== 'function' || typeof storageDomain.get !== 'function') {
    throw unsupported();
  }
  const backend = registry.get(backendName);
  if (backend?.constructor?.name !== 'JsonStorageBackend'
    || typeof backend.root !== 'string' || !path.isAbsolute(backend.root)) {
    throw unsupported();
  }
  // The previous plugin instance must finish close() and its write chain first.
  // Do not close a domain owned by another still-active instance.
  if (storageDomain.get(spec.name)) {
    throw new Error('bot-team: storage domain is still open; disable the previous plugin instance before relocating its data');
  }
  const legacyDirectory = path.join(backend.root, spec.name);
  const directory = await relocateStorageDirectory(legacyDirectory);
  const domain = await storageDomain.open(spec);
  const unit = domain.unit;
  if (unit?.constructor?.name !== 'PerRecordJsonUnit'
    || unit.descriptor?.name !== spec.name
    || unit.descriptor?.layout !== 'per-record'
    || unit.dir !== legacyDirectory) {
    await domain.close();
    throw unsupported();
  }
  logger?.info?.(`bot-team: storage directory ${directory}`);
  return domain;
}
