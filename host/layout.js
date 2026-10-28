/**
 * Group kinds and sidebar ordering helpers shared by the Host modules.
 *
 * A direct chat ("单聊") is a normal group record with `kind: 'direct'`, one
 * member and a `botId`. It reuses the whole timeline/turn engine, but it is not
 * a group chat: it cannot be deleted on its own, cannot gain members, and it is
 * rendered in its own sidebar section above group chats.
 *
 * Group chats may live in one optional folder (a custom sidebar section).
 * `order` is a dense integer per scope (the direct section, one folder, or the
 * ungrouped tail), so drag/drop only needs to rewrite that one scope.
 */
import { trimmed } from './util.js';

export const GROUP_KIND_GROUP = 'group';
export const GROUP_KIND_DIRECT = 'direct';
export const MAX_FOLDER_TITLE = 40;
export const MAX_FOLDERS = 100;

export function isDirectGroup(group) {
  return !!group && group.kind === GROUP_KIND_DIRECT;
}

export function groupKindOf(group) {
  return isDirectGroup(group) ? GROUP_KIND_DIRECT : GROUP_KIND_GROUP;
}

/** Direct-chat ids are deterministic, so ensuring one is idempotent. */
export const directGroupIdFor = (botId) => `grp-dm-${botId}`;
export const directMembershipIdFor = (botId) => `mem-dm-${botId}`;
export const directSessionIdFor = (botId) => `session-botteam-dm-${botId}`;

/** Folder assignment; direct chats are never in a folder. */
export function groupFolderIdOf(group) {
  if (!group || isDirectGroup(group)) return null;
  return typeof group.folderId === 'string' && group.folderId ? group.folderId : null;
}

export function sortByOrder(list) {
  return [...list].sort(
    (a, b) => (Number.isFinite(a.order) ? a.order : 0) - (Number.isFinite(b.order) ? b.order : 0)
      || (a.createdAt ?? 0) - (b.createdAt ?? 0),
  );
}

export function nextOrder(items) {
  let max = -1;
  for (const item of items) {
    if (Number.isInteger(item.order) && item.order > max) max = item.order;
  }
  return max + 1;
}

/** Returns the trimmed title or '' (callers turn '' into a validation error). */
export function normalizeFolderTitle(value) {
  if (value === undefined || value === null) return '';
  return trimmed(value, MAX_FOLDER_TITLE);
}

/** Deduplicated list of non-empty string ids, preserving first-seen order. */
export function uniqueIdList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const list = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue;
    const id = candidate.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    list.push(id);
  }
  return list;
}

/**
 * Turn a client's requested order into dense positions for one scope.
 * Unknown ids are ignored and omitted scope ids are appended, so a stale client
 * can never delete or hide a record just by submitting a short list.
 */
export function resolveOrdering(scopeIds, requestedIds) {
  const allowed = new Set(scopeIds);
  const ordered = [];
  const seen = new Set();
  for (const id of uniqueIdList(requestedIds)) {
    if (!allowed.has(id) || seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  for (const id of scopeIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  return ordered.map((id, index) => ({ id, order: index }));
}
