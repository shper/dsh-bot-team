/**
 * Plugin data layout and its one-time migration.
 *
 * The plugin owns one data root (config.dataDir, default
 * `$DSH_HOME/dsh-bot-team`):
 *
 *   <dataDir>/bots/<botId>/BOT.md        persona + working rules
 *   <dataDir>/direct/<botId>/            direct-chat workspace
 *   <dataDir>/groups/<groupId>/          group-chat workspace
 *
 * Older builds used `$DSH_HOME/bot-team/bots` for personas and let groups
 * default to the Host process cwd. The first `dsh-bot-team` build also kept
 * direct workspaces directly under `<dataDir>/<botId>`. `migrateLegacyLayout`
 * folds both layouts into the one above on startup: persona directories,
 * plugin-owned workspace directories, and the persisted `workspaceCwd` of the
 * groups that pointed there. It is idempotent and only runs for the default
 * layout (see `isStandardLayout`).
 */
import os from 'node:os';
import path from 'node:path';
import { constants } from 'node:fs';
import { access, mkdir, readdir, realpath, rename, rmdir, stat, unlink } from 'node:fs/promises';

export function dshHomeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** Root used by builds before the `dsh-bot-team` rename. */
export function legacyDataDir() {
  return path.join(dshHomeDir(), 'bot-team');
}

/** Direct chats live at <dataDir>/direct/<botId>; groups at <dataDir>/groups/<groupId>. */
export function defaultWorkspaceDir(config, group) {
  if (group && group.kind === 'direct' && group.botId) {
    return path.join(config.dataDir, 'direct', group.botId);
  }
  if (group && group.groupId) {
    return path.join(config.dataDir, 'groups', group.groupId);
  }
  return path.join(config.dataDir, 'groups');
}

/**
 * Migration only runs for the stock layout. A profile that overrides dataDir
 * or botsDir owns its paths and keeps whatever it configured.
 */
export function isStandardLayout(config) {
  const expectedRoot = path.join(dshHomeDir(), 'dsh-bot-team');
  return path.resolve(config.dataDir) === path.resolve(expectedRoot)
    && path.resolve(config.botsDir) === path.resolve(config.dataDir, 'bots');
}

/**
 * A session's sandbox root is fixed to its creation cwd, and DSH rejects
 * adopting a session under another cwd. A bot session can therefore only keep
 * its history while the workspace matches the cwd it was created with.
 */
export function sessionCwdMatches(headerCwd, workspaceCwd) {
  return typeof headerCwd === 'string'
    && path.resolve(headerCwd) === path.resolve(workspaceCwd);
}

/** Normalize a user-selected host path without creating any project directories. */
export function normalizeWorkspacePath(value) {
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) {
    throw Object.assign(new Error('workspaceCwd 必须是有效的目录路径'), { code: 'invalid-input' });
  }
  let target = value.trim();
  if (!target) return '';
  if (target === '~') target = os.homedir();
  else if (target.startsWith('~/')) target = path.join(os.homedir(), target.slice(2));
  if (!path.isAbsolute(target)) {
    throw Object.assign(new Error('workspaceCwd 必须是绝对路径（可使用 ~/）'), { code: 'invalid-input' });
  }
  return path.resolve(target);
}

/** Resolve symlinks and verify an existing, readable/searchable local directory. */
export async function validateProjectWorkspace(value) {
  const target = normalizeWorkspacePath(value);
  if (!target) throw Object.assign(new Error('项目目录不能为空'), { code: 'invalid-input' });
  try {
    const canonical = await realpath(target);
    if (!(await stat(canonical)).isDirectory()) {
      throw new Error('请选择文件夹，而不是文件');
    }
    await access(canonical, constants.R_OK | constants.X_OK);
    return canonical;
  } catch (error) {
    const reason = error?.code === 'ENOENT' ? '目录不存在' : error?.code === 'EACCES' || error?.code === 'EPERM'
      ? '目录不可访问' : String(error?.message || error);
    throw Object.assign(new Error('无法引入项目目录：' + reason), { code: 'invalid-input' });
  }
}

export async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function isDirectory(target) {
  try {
    return (await stat(target)).isDirectory();
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

/** The first dsh-bot-team build stored direct workspaces at <dataDir>/<botId>. */
function isPreviousDirectWorkspace(config, group, dir) {
  if (!group || group.kind !== 'direct' || !group.botId) return false;
  return path.resolve(dir) === path.resolve(path.join(config.dataDir, group.botId));
}

function isInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Agent cwd must exist before the session starts; failure is logged, never fatal. */
export async function ensureWorkspaceDir(dir, logger) {
  if (!dir) return false;
  try {
    await mkdir(dir, { recursive: true });
    return true;
  } catch (error) {
    logger?.warn?.(`bot-team: cannot create workspace ${dir}: ${String(error && error.message ? error.message : error)}`);
    return false;
  }
}

async function persistGroup(repo, group) {
  const table = repo.domain && typeof repo.domain.table === 'function' ? repo.domain.table('groups') : null;
  if (table) await table.put(group.groupId, group);
  else if (typeof repo.putGroup === 'function') await repo.putGroup(group);
}

async function movePersonaDirs(legacyBots, botsDir, logger, summary) {
  if (path.resolve(legacyBots) === path.resolve(botsDir)) return;
  if (!(await isDirectory(legacyBots))) return;
  if (!(await pathExists(botsDir))) {
    await mkdir(path.dirname(botsDir), { recursive: true });
    await rename(legacyBots, botsDir);
    summary.personas += 1;
    logger?.info?.(`bot-team: moved persona dir ${legacyBots} -> ${botsDir}`);
    return;
  }
  // Both sides exist (interrupted upgrade or manual setup): move only what is missing.
  for (const entry of await readdir(legacyBots, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const from = path.join(legacyBots, entry.name);
    const to = path.join(botsDir, entry.name);
    if (await pathExists(to)) continue;
    await rename(from, to);
    summary.personas += 1;
  }
  logger?.info?.(`bot-team: merged persona dirs from ${legacyBots} into ${botsDir}`);
  await rmdir(legacyBots).catch(() => {});
}

async function moveWorkspace(from, to, logger, summary) {
  if (path.resolve(from) === path.resolve(to)) return;
  if (!(await pathExists(from))) return;
  if (await pathExists(to)) {
    logger?.warn?.(`bot-team: workspace target already exists, left ${from} in place`);
    return;
  }
  await mkdir(path.dirname(to), { recursive: true });
  try {
    await rename(from, to);
    summary.workspaces += 1;
    logger?.info?.(`bot-team: moved workspace ${from} -> ${to}`);
  } catch (error) {
    logger?.warn?.(`bot-team: move workspace ${from} -> ${to} failed: ${String(error && error.message ? error.message : error)}`);
  }
}

/**
 * Move legacy personas and plugin-owned workspaces to the current layout and
 * rewrite group records that still point at an older plugin-owned path.
 * Explicit workspaces outside both layouts are never touched. Idempotent.
 */
export async function migrateLegacyLayout({ repo, config, logger }) {
  const legacyRoot = legacyDataDir();
  const summary = { personas: 0, workspaces: 0, groups: 0, legacyRootRemoved: false };
  if (path.resolve(legacyRoot) === path.resolve(config.dataDir)) return summary;

  await movePersonaDirs(path.join(legacyRoot, 'bots'), config.botsDir, logger, summary);

  for (const group of [...repo.groups.values()]) {
    const target = defaultWorkspaceDir(config, group);
    const current = typeof group.workspaceCwd === 'string' ? group.workspaceCwd.trim() : '';
    // Explicit workspaces outside both plugin-owned layouts are the user's choice.
    const legacyWorkspace = current ? isInside(current, legacyRoot) : false;
    const previousDirectWorkspace = current ? isPreviousDirectWorkspace(config, group, current) : false;
    if (current && !legacyWorkspace && !previousDirectWorkspace) {
      // A user-owned project may have moved or become unavailable. Never recreate it.
      continue;
    }
    if (current && current !== target) await moveWorkspace(current, target, logger, summary);
    if (group.workspaceCwd !== target) {
      group.workspaceCwd = target;
      await persistGroup(repo, group);
      summary.groups += 1;
    }
    await ensureWorkspaceDir(target, logger);
  }

  // Drop the old root when it is empty (Finder's .DS_Store is metadata, not data).
  await unlink(path.join(legacyRoot, '.DS_Store')).catch(() => {});
  await rmdir(legacyRoot)
    .then(() => { summary.legacyRootRemoved = true; })
    .catch(() => {});

  if (summary.personas || summary.workspaces || summary.groups) {
    logger?.info?.(
      `bot-team: layout migration done (personas=${summary.personas}, workspaces=${summary.workspaces}, groups=${summary.groups})`,
    );
  }
  return summary;
}
