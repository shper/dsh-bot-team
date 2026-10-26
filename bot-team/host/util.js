/**
 * Shared helpers for the Bot Team Host half: config normalization, ids, small
 * validators, SSE bus and tiny HTTP helpers. No DSH package imports so a
 * profile-installed plain-JS bundle stays resolvable.
 */
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export function resolveConfig(raw = {}) {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const dataDir = typeof raw.dataDir === 'string' && raw.dataDir.trim().length > 0
    ? raw.dataDir.trim()
    : path.join(dshHome, 'dsh-bot-team');
  const botsDir = typeof raw.botsDir === 'string' && raw.botsDir.trim().length > 0
    ? raw.botsDir.trim()
    : path.join(dataDir, 'bots');
  const defaultCwd = typeof raw.defaultCwd === 'string' && raw.defaultCwd.trim().length > 0
    ? raw.defaultCwd.trim()
    : process.cwd();
  const positiveInt = (value, fallback, min, max) =>
    Number.isInteger(value) && value >= min && value <= max ? value : fallback;
  return {
    dataDir: path.resolve(dataDir),
    botsDir: path.resolve(botsDir),
    defaultCwd: path.resolve(defaultCwd),
    migrateLegacyLayout: raw.migrateLegacyLayout !== false,
    maxParallelTurns: positiveInt(raw.maxParallelTurns, 3, 1, 8),
    maxContextMessages: positiveInt(raw.maxContextMessages, 40, 5, 200),
    turnTimeoutMs: positiveInt(raw.turnTimeoutMs, 300000, 5000, 3600000),
    maxMessageChars: positiveInt(raw.maxMessageChars, 40000, 1000, 200000),
    maxGroups: positiveInt(raw.maxGroups, 50, 1, 500),
    enableModelTools: raw.enableModelTools !== false,
    botSandbox: raw.botSandbox !== false,
    botApprovalPolicy: raw.botApprovalPolicy === 'never' ? 'never' : 'ask',
    autoDispatchReady: raw.autoDispatchReady === true,
    maxTurnsPerHour: positiveInt(raw.maxTurnsPerHour, 120, 1, 10000),
    dailyTokenBudget: positiveInt(raw.dailyTokenBudget, 5000000, 1000, 100000000),
    toolWaitTimeoutMs: positiveInt(raw.toolWaitTimeoutMs, 180000, 10000, 900000),
    maxMembersPerGroup: positiveInt(raw.maxMembersPerGroup, 12, 1, 50),
    pdfFontPath: typeof raw.pdfFontPath === 'string' ? raw.pdfFontPath.trim() : '',
    smokeTest: raw.smokeTest === true,
    smokeResultsDir: typeof raw.smokeResultsDir === 'string' && raw.smokeResultsDir.trim().length > 0
      ? path.resolve(raw.smokeResultsDir)
      : path.resolve(process.cwd(), '.bot-team'),
  };
}

export const newId = (prefix) => `${prefix}-${randomUUID()}`;

export const now = () => Date.now();

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export function fail(code, message) {
  return { ok: false, error: { code, message } };
}

export function sseFrame(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function asString(value, max = 100000) {
  if (typeof value !== 'string') return '';
  return value.length > max ? value.slice(0, max) : value;
}

export function trimmed(value, max = 500) {
  return asString(value, max).trim();
}

/** Minimal record validator used by the domain tables (domain calls parse on load). */
export function recordSchema(label, requiredFields) {
  return {
    parse(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label}: record must be an object`);
      }
      for (const field of requiredFields) {
        if (value[field] === undefined) throw new Error(`${label}: record is missing '${field}'`);
      }
      return value;
    },
  };
}

/** In-process SSE fan-out plus last-sequence bookkeeping, one topic per group. */
export class GroupBus {
  constructor() {
    this.subscribers = new Map();
    this.lastSeq = new Map();
  }

  subscribe(groupId, write) {
    const set = this.subscribers.get(groupId) ?? new Set();
    set.add(write);
    this.subscribers.set(groupId, set);
    return () => {
      set.delete(write);
      if (set.size === 0) this.subscribers.delete(groupId);
    };
  }

  emit(groupId, frame) {
    // Execution seq belongs to a member's session log, not the group timeline.
    if (frame && frame.type !== 'execution.updated' && typeof frame.seq === 'number') this.lastSeq.set(groupId, frame.seq);
    const set = this.subscribers.get(groupId);
    if (!set) return;
    for (const write of [...set]) {
      try {
        write(frame);
      } catch {
        set.delete(write);
      }
    }
  }

  seqOf(groupId) {
    return this.lastSeq.get(groupId) ?? 0;
  }

  closeGroup(groupId) {
    this.subscribers.delete(groupId);
    this.lastSeq.delete(groupId);
  }
}

/** Run one async function with an upper bound, resolving a value on timeout. */
export function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        resolve({ ok: false, error: String(error && error.message ? error.message : error) });
      },
    );
  });
}
