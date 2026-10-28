/**
 * Persona files: <botsDir>/<botId>/BOT.md (canonical).
 *
 * BOT.md holds both the identity ("who you are") and the operating rules
 * ("how you work"), separated by ordinary Markdown headings. Older bots may
 * still have SOUL.md + AGENT.md; when BOT.md is absent we merge those two on
 * read (without writing) so existing setups keep working. The next save from
 * the UI writes BOT.md and that becomes the single source of truth.
 *
 * The Host keeps the last read in memory so the prompt text provider (which must
 * be synchronous) can serve immediately; `refresh()` runs before every bot turn
 * and after every UI save, so file edits apply to the next step without
 * restarting the agent (M0 evidence: the section text function re-evaluates on
 * every assembly).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const FILE_OF_KIND = { bot: 'BOT.md', soul: 'SOUL.md', agent: 'AGENT.md' };
const EMPTY = { bot: '', soul: '', agent: '', text: '', hasBot: false, loadedAt: 0 };

function mergeLegacy(soul, agent) {
  const parts = [];
  if (soul && soul.trim()) parts.push(`## 人格\n\n${soul.trim()}`);
  if (agent && agent.trim()) parts.push(`## 工作规范\n\n${agent.trim()}`);
  return parts.join('\n\n');
}

export class Personas {
  constructor(botsDir, logger) {
    this.botsDir = botsDir;
    this.logger = logger;
    this.cache = new Map();
  }

  dirOf(botId) {
    return path.join(this.botsDir, botId);
  }

  fileOf(botId, kind) {
    return path.join(this.dirOf(botId), FILE_OF_KIND[kind]);
  }

  get(botId) {
    return this.cache.get(botId) ?? { ...EMPTY };
  }

  async ensureDir(botId) {
    await mkdir(this.dirOf(botId), { recursive: true });
  }

  /** Raw file read (no legacy fallback); `null` means the file does not exist. */
  async readRaw(botId, kind) {
    if (!FILE_OF_KIND[kind]) throw new Error(`unknown persona kind: ${kind}`);
    try {
      return await readFile(this.fileOf(botId, kind), 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  /**
   * Public read used by the UI. `bot` falls back to a merged view of the two
   * legacy files only when BOT.md does not exist. An existing empty BOT.md is
   * authoritative (the user may have intentionally cleared the persona).
   */
  async read(botId, kind) {
    if (kind !== 'bot') return (await this.readRaw(botId, kind)) ?? '';
    const bot = await this.readRaw(botId, 'bot');
    if (bot !== null) return bot;
    const [soul, agent] = await Promise.all([this.readRaw(botId, 'soul'), this.readRaw(botId, 'agent')]);
    return mergeLegacy(soul ?? '', agent ?? '');
  }

  async refresh(botId) {
    const [bot, soul, agent] = await Promise.all([
      this.readRaw(botId, 'bot'),
      this.readRaw(botId, 'soul'),
      this.readRaw(botId, 'agent'),
    ]);
    const hasBot = bot !== null;
    const soulText = soul ?? '';
    const agentText = agent ?? '';
    const value = {
      bot: bot ?? '',
      soul: soulText,
      agent: agentText,
      hasBot,
      text: hasBot ? bot : mergeLegacy(soulText, agentText),
      loadedAt: Date.now(),
    };
    this.cache.set(botId, value);
    return value;
  }

  async write(botId, kind, text) {
    if (!FILE_OF_KIND[kind]) throw new Error(`unknown persona kind: ${kind}`);
    await this.ensureDir(botId);
    await writeFile(this.fileOf(botId, kind), String(text ?? ''), 'utf8');
    const current = this.get(botId);
    const next = { ...current, [kind]: String(text ?? '') };
    if (kind === 'bot') next.hasBot = true;
    next.text = next.hasBot ? next.bot : mergeLegacy(next.soul, next.agent);
    next.loadedAt = Date.now();
    this.cache.set(botId, next);
    return next;
  }

  /** One-time load of every bot's files; failures degrade to empty text. */
  async preload(botIds) {
    for (const botId of botIds) {
      try {
        await this.refresh(botId);
      } catch (error) {
        this.logger?.warn?.(`bot-team: preload persona ${botId} failed: ${String(error)}`);
      }
    }
  }
}
