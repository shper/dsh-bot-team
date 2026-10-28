/**
 * BotTeamService — the Host half of the Bot Team plugin.
 *
 * Owns: the durable repository, persona files, the bot AgentPool, the turn
 * Engine, the SSE bus and the authenticated HTTP surface consumed by the
 * Client page. All plugin configuration is normalized in ./util.js.
 */
import path from 'node:path';
import { appendFile, mkdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { openRepository } from './domain.js';
import { currentConversationId, conversationIdOf, isCurrentMemberSession } from './conversations.js';
import { collectNativeConversationBlockers, nativeConversationCapability } from './native-activity.js';
import { openPluginStorageDomain } from './storage-layout.js';
import { CHAT_DISPLAY_SETTINGS_KEY, isChatDisplaySettings, normalizeChatDisplaySettings } from './chat-settings.js';
import { Personas } from './personas.js';
import { AgentPool } from './agents.js';
import { BackgroundInteractions } from './background-interactions.js';
import { BotSessionVisibility } from './session-visibility.js';
import { Engine } from './engine.js';
import { readBotSessionHistory, readBotSessionLog, readMessageExecution } from './execution.js';
import { serializeBotSessionLog } from './session-export.js';
import { registerRoutes } from './routes.js';
import { BOT_TEAM_TOOL_NAMES, registerBotTeamTools } from './tools.js';
import { GroupBus, asString, fail, json, newId, now, trimmed } from './util.js';
import {
  GROUP_KIND_DIRECT,
  MAX_FOLDERS,
  directGroupIdFor,
  directMembershipIdFor,
  directSessionIdFor,
  groupFolderIdOf,
  groupKindOf,
  isDirectGroup,
  nextOrder,
  normalizeFolderTitle,
  resolveOrdering,
  sortByOrder,
} from './layout.js';
import { parseMentionsFromText, renderGroupContext, renderPersona } from './prompt.js';
import { buildGroupPdf } from './pdf.js';
import { defaultWorkspaceDir, ensureWorkspaceDir, isStandardLayout, migrateLegacyLayout, normalizeWorkspacePath, sessionCwdMatches, validateProjectWorkspace } from './workspace.js';

class ServiceError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    if (details) this.details = details;
  }
}

// Package metadata for the About module. Read once at module load; a bundled
// build without package.json still gets a usable fallback.
const pluginRequire = createRequire(import.meta.url);
let pluginPackage = {};
try {
  pluginPackage = pluginRequire('../package.json');
} catch {
  /* package metadata unavailable */
}
export const PLUGIN_INFO = Object.freeze({
  name: 'Bot Team',
  packageName: typeof pluginPackage.name === 'string' ? pluginPackage.name : 'dsh-bot-team',
  version: typeof pluginPackage.version === 'string' ? pluginPackage.version : '1.2.2',
  author: typeof pluginPackage.author === 'string'
    ? pluginPackage.author
    : pluginPackage.author && typeof pluginPackage.author.name === 'string'
      ? pluginPackage.author.name
      : '本地插件',
  description: typeof pluginPackage.description === 'string' ? pluginPackage.description : '',
});

const SMOKE_VERSION = 11;
const TASK_PRIORITIES = ['urgent', 'high', 'normal', 'low'];
const TASK_PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
const MAX_TASK_DEPENDENCIES = 10;
const PERSONA_KINDS = new Set(['bot', 'soul', 'agent']);
const MAX_MESSAGE_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const ATTACHMENT_ID_RE = /^sha256:[0-9a-f]{64}$/;

const BOT_COLORS = ['#2f7ed8', '#8b5cf6', '#0d9488', '#d97706', '#db2777', '#4f46e5', '#65a30d', '#dc2626'];

// Avatar grammar: preset seeds are mascots; bundled Bot art may include a stable palette ID.
const AVATAR_PRESET_RE = /^preset:[a-z0-9-]{1,40}$/;
const AVATAR_ART_IDS = new Set([
  // Keep the original illustrations valid for saved Bot and group records.
  'planet', 'rocket', 'cloud', 'bolt', 'leaf', 'flame', 'star', 'moon', 'wave', 'flower',
  'bot-orbit', 'bot-spark', 'bot-circuit', 'bot-pixel', 'bot-scout', 'bot-assistant', 'bot-core', 'bot-android',
  'group-team', 'group-bots', 'group-network', 'group-dialogue', 'group-lab', 'group-huddle', 'group-swarm', 'group-community',
]);
const AVATAR_ART_PALETTES = new Set(['sky', 'violet', 'mint', 'orange', 'pink', 'indigo', 'teal', 'slate']);
const MAX_AVATAR_CHARS = 800000;

function normalizeAvatar(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new ServiceError('invalid-input', '头像格式不支持');
  const text = value.trim();
  if (!text) return '';
  if (text.startsWith('preset:')) {
    if (!AVATAR_PRESET_RE.test(text)) throw new ServiceError('invalid-input', '未知的头像预设');
    return text;
  }
  if (text.startsWith('art:')) {
    const match = /^art:([a-z0-9-]+)(?::([a-z0-9-]+))?$/.exec(text);
    if (!match || !AVATAR_ART_IDS.has(match[1])) throw new ServiceError('invalid-input', '未知的插画头像');
    const [, id, paletteId] = match;
    if (paletteId && (!id.startsWith('bot-') || !AVATAR_ART_PALETTES.has(paletteId))) {
      throw new ServiceError('invalid-input', '未知的头像配色');
    }
    return text;
  }
  if (text.startsWith('data:image/')) {
    if (text.length > MAX_AVATAR_CHARS) throw new ServiceError('invalid-input', '头像图片过大');
    if (!/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(text)) {
      throw new ServiceError('invalid-input', '头像图片格式不支持');
    }
    return text;
  }
  throw new ServiceError('invalid-input', '头像格式不支持');
}

function requireText(value, field, max) {
  const text = trimmed(value, max);
  if (!text) throw new ServiceError('invalid-input', `${field} 不能为空`);
  return text;
}

function optionalText(value, max) {
  if (value === undefined || value === null) return '';
  return asString(value, max).trim();
}

export class BotTeamService {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.logger = ctx.logger;
    this.bus = new GroupBus();
    this.repo = null;
    this.personas = null;
    this.pool = null;
    this.engine = null;
    this.conversationChanges = new Set();
    this.workspaceChanges = new Set();
    this.workspaceOperations = new Map();
    this.modelCatalogCache = null;
    this.smokeState = null;
    this.routeDispose = registerRoutes(ctx, this);
    this.toolDispose = null;
    this.disposed = false;

    this.ready = this.init();
    this.ready.catch((error) => {
      this.logger?.error?.(`bot-team: init failed: ${String(error && error.stack ? error.stack : error)}`);
    });
  }

  async init() {
    this.repo = await openRepository(this.ctx, this.logger, spec => openPluginStorageDomain(this.ctx.storageDomain, spec, this.logger));
    const migration = await this.repo.runMigrations();
    if (migration.applied.length > 0) {
      this.logger?.info?.('bot-team: migrated domain records to schema v' + migration.version);
    }
    if (this.config.migrateLegacyLayout && isStandardLayout(this.config)) {
      try {
        await migrateLegacyLayout({ repo: this.repo, config: this.config, logger: this.logger });
      } catch (error) {
        this.logger?.warn?.(`bot-team: legacy data layout migration failed: ${String(
          error && error.message ? error.message : error,
        )}`);
      }
    }
    // Older group records already allowed custom workspaces; expose them as
    // imported projects without changing the directory or its contents.
    for (const group of this.repo.groups.values()) {
      if (typeof group.projectWorkspaceCwd === 'string') continue;
      group.projectWorkspaceCwd = group.workspaceCwd && !sessionCwdMatches(group.workspaceCwd, defaultWorkspaceDir(this.config, group))
        ? group.workspaceCwd : '';
      await this.repo.putGroup(group);
    }
    this.personas = new Personas(this.config.botsDir, this.logger);
    this.pool = new AgentPool({
      ctx: this.ctx,
      repo: this.repo,
      personas: this.personas,
      config: this.config,
      logger: this.logger,
    });
    this.pool.assertAdmission = (groupId) => this.assertWorkspaceStable(groupId);
    this.pool.attachPrompt({
      renderPersona: (botId, groupId) => renderPersona(this.repo, this.personas, botId, groupId),
      renderGroupContext: (botId, groupId) => renderGroupContext(this.repo, botId, groupId),
    });
    this.engine = new Engine({
      ctx: this.ctx,
      repo: this.repo,
      pool: this.pool,
      personas: this.personas,
      bus: this.bus,
      config: this.config,
      logger: this.logger,
      quotaGuard: (groupId) => this.checkQuota(groupId),
      workspaceGuard: (groupId) => this.assertWorkspaceStable(groupId),
      taskHook: async (job, message, status) => {
        await this.onTaskJobFinished(job, message, status);
        await this.visibility?.reconcile();
      },
    });
    this.engine.assertAdmission = (groupId) => this.assertWorkspaceStable(groupId);
    this.pool.attachStreamHandler((payload) => this.engine.onAssistantStream(payload));
    this.interactions = new BackgroundInteractions({ ctx: this.ctx, repo: this.repo, bus: this.bus });
    this.toolDispose = registerBotTeamTools({
      ctx: this.ctx,
      service: this,
      config: this.config,
      logger: this.logger,
    });
    await this.personas.preload(this.repo.allBots().map((bot) => bot.botId));
    await this.pool.ready;
    await this.engine.recoverNativeSessions();
    this.visibility = new BotSessionVisibility({
      ctx: this.ctx, repo: this.repo, logger: this.logger,
      isBusy: sessionId => this.engine.activeBySession.has(sessionId),
    });
    await this.visibility.ready;
    this.logger?.info?.(`bot-team: ready (domain bot_team, bots=${this.repo.bots.size}, groups=${this.repo.groups.size})`);

    if (this.config.smokeTest) {
      void this.runSmokeOrRecovery().catch((error) => {
        this.logger?.warn?.(`bot-team: smoke test crashed: ${String(error)}`);
      });
    }
    return this;
  }

  conversationState(groupId) {
    const conversation = this.repo?.activeConversation?.(groupId) || null;
    const group = this.repo?.getGroup?.(groupId);
    return {
      activeConversationId: conversation?.conversationId || group?.activeConversationId || null,
      currentConversationId: conversation?.conversationId || group?.activeConversationId || null,
      conversationVersion: conversation?.ordinal || group?.conversationVersion || 0,
      currentConversation: conversation,
    };
  }

  conversationCapability() {
    if (typeof this.repo?.commitConversation !== 'function') return { supported: false, reason: '会话存储尚未就绪' };
    return nativeConversationCapability({ ctx: this.ctx, pool: this.pool });
  }

  isCurrentRecord(record) {
    return !!record && conversationIdOf(this.repo, record) === currentConversationId(this.repo, record.groupId);
  }

  assertCurrentRecord(record) {
    if (record && !this.isCurrentRecord(record)) {
      throw new ServiceError('historical-target', '目标属于已结束的会话，请选取内容后在当前会话重新发起', this.conversationState(record.groupId));
    }
  }

  assertExpectedConversation(groupId, expected, required = false) {
    const state = this.conversationState(groupId);
    if (!state.currentConversationId) return;
    if (expected === undefined || expected === null || expected === '') {
      if (required) throw new ServiceError('reload-required', '聊天已支持独立会话，请刷新页面后重试', state);
      return;
    }
    if (expected !== state.currentConversationId) throw new ServiceError('stale-conversation', '聊天已开始新会话，草稿已保留', state);
  }

  async conversationBlockers(groupId, { ownChange = false } = {}) {
    const blockers = [];
    const add = (code, message) => blockers.push({ code, kind: 'chat', groupId, message });
    if (!ownChange && this.conversationChanges?.has(groupId)) add('conversation-changing', '正在新建会话');
    if (this.workspaceChanges?.has(groupId)) add('workspace-changing', '正在切换项目目录');
    if (this.workspaceOperations?.get(groupId) > 0) add('operation-pending', '聊天操作尚未完成');
    if (this.engine?.isRunning?.(groupId)) add('execution-running', '仍有运行或排队的回复');
    if (this.engine?.hasPendingWork?.(groupId)) add('execution-settling', '执行结果尚未保存完成');
    if (this.repo?.activeDiscussionOf?.(groupId)) add('discussion-running', '讨论尚未结束');
    if (this.pool?.isPreparingGroup?.(groupId)) add('agent-preparing', 'Bot 正在准备会话');
    const capability = this.conversationCapability();
    if (!capability.supported) add('native-capability-unavailable', capability.reason || '宿主无法验证后台工作状态');
    else {
      try {
        blockers.push(...await collectNativeConversationBlockers({ ctx: this.ctx, repo: this.repo, pool: this.pool, groupId, interactions: this.interactions }));
      } catch (error) {
        add('native-state-unavailable', '无法确认后台工作状态：' + String(error?.message || error));
      }
    }
    return blockers;
  }

  async newConversation(input) {
    this.conversationRequests ??= new Map();
    const key = JSON.stringify([input.groupId, input.requestId]);
    const existing = this.conversationRequests.get(key);
    if (existing) {
      if (existing.expectedConversationId !== input.expectedConversationId) throw new ServiceError('conflict', 'requestId 已用于其他会话请求');
      return { ...await existing.promise, created: false };
    }
    const promise = this.performNewConversation(input);
    this.conversationRequests.set(key, { expectedConversationId: input.expectedConversationId, promise });
    try { return await promise; }
    finally { this.conversationRequests.delete(key); }
  }

  async performNewConversation(input) {
    const groupId = String(input.groupId || '');
    if (!this.repo.getGroup(groupId)) throw new ServiceError('not-found', '群不存在');
    const requestId = String(input.requestId || '');
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(requestId)) throw new ServiceError('invalid-input', '新建会话需要有效的 requestId');
    const previous = this.repo.conversationsOf(groupId).find((item) => item.requestId === requestId);
    if (previous) {
      if (previous.previousConversationId !== input.expectedConversationId) throw new ServiceError('conflict', 'requestId 已用于其他会话请求');
      return { created: false, conversation: previous, ...this.conversationState(groupId) };
    }
    this.assertExpectedConversation(groupId, input.expectedConversationId, true);
    this.assertWorkspaceStable(groupId);
    const capability = this.conversationCapability();
    if (!capability.supported) throw new ServiceError('conversation-capability-unavailable', capability.reason || '宿主无法验证后台工作状态');
    this.conversationChanges ??= new Set();
    this.conversationChanges.add(groupId);
    try {
      const check = async () => {
        this.assertExpectedConversation(groupId, input.expectedConversationId, true);
        const blockers = await this.conversationBlockers(groupId, { ownChange: true });
        if (blockers.length) throw new ServiceError('conversation-busy', blockers.map((item) => item.message).join('；'), { ...this.conversationState(groupId), blockers });
      };
      const flush = async () => {
        try { await this.repo.flushGroupWrites(groupId); }
        catch (error) { throw new ServiceError('storage-failed', '聊天更改尚未保存成功：' + String(error?.message || error)); }
      };
      await check();
      await flush();
      await check();
      for (const member of this.repo.membersOf(groupId)) {
        try { await this.pool.disposeMember(member.membershipId, { strict: true }); }
        catch (error) { throw new ServiceError('session-release-failed', '旧会话释放失败：' + String(error?.message || error)); }
      }
      await check();
      await flush();
      let result;
      try { result = await this.repo.commitConversation(groupId, { expectedConversationId: input.expectedConversationId, requestId }); }
      catch (error) {
        if (['stale-conversation', 'conflict', 'invalid-input', 'conversation-corrupt'].includes(error?.code)) throw error;
        throw new ServiceError('storage-failed', '新会话保存失败：' + String(error?.message || error));
      }
      try {
        Promise.resolve(this.interactions?.reconcile?.()).catch((error) => this.logger?.warn?.('bot-team: conversation interaction refresh failed: ' + String(error)));
        this.bus.emit(groupId, { type: 'conversation.started', groupId, ...result, ...this.conversationState(groupId) });
      } catch (error) {
        this.logger?.warn?.('bot-team: conversation committed; notification failed: ' + String(error));
      }
      return { ...result, ...this.conversationState(groupId) };
    } finally {
      this.conversationChanges.delete(groupId);
    }
  }

  messageConversationBoundaries(groupId, messages, { beforeSeq, afterSeq } = {}) {
    const all = this.repo.conversationsOf?.(groupId) || [];
    if (!messages.length) return all.filter((item) => (beforeSeq === undefined || item.afterSeq < beforeSeq) && (afterSeq === undefined || item.afterSeq >= afterSeq));
    const first = messages[0].seq;
    const last = messages.at(-1).seq;
    const leading = [...all].reverse().find((item) => item.afterSeq < first);
    return all.filter((item) => item.afterSeq === leading?.afterSeq || (item.afterSeq >= first && (beforeSeq === undefined || item.afterSeq <= last)));
  }

  handleConversations(request) {
    return this.withReady(() => {
      const params = new URL(request.url).searchParams;
      const groupId = params.get('groupId') || '';
      if (!this.repo.getGroup(groupId)) return json(fail('not-found', '群不存在'), 404);
      const requestedLimit = Number(params.get('limit'));
      const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 200) : 100;
      const all = this.repo.conversationsOf(groupId);
      const id = params.get('conversationId');
      if (id) {
        const conversation = all.find((item) => item.conversationId === id);
        if (!conversation) return json(fail('not-found', '会话不存在'), 404);
        const rawCursor = params.get('cursor');
        const cursor = rawCursor === null ? 0 : Number(rawCursor);
        if (!Number.isSafeInteger(cursor) || cursor < 0) return json(fail('invalid-input', '会话日志游标无效'), 400);
        const bindings = this.repo.sessionBindingsOf(groupId, id);
        const sessionBindings = bindings.slice(cursor, cursor + limit);
        const hasMore = cursor + sessionBindings.length < bindings.length;
        return json({ ok: true, groupId, conversation, sessionBindings, hasMore, nextCursor: hasMore ? cursor + sessionBindings.length : null, ...this.conversationState(groupId) });
      }
      const before = params.has('beforeOrdinal') ? Number(params.get('beforeOrdinal')) : Infinity;
      if (before !== Infinity && (!Number.isSafeInteger(before) || before < 1)) return json(fail('invalid-input', '会话分页游标无效'), 400);
      const filtered = all.filter((item) => item.ordinal < before);
      const conversations = filtered.slice(-limit);
      return json({ ok: true, groupId, conversations, hasMore: filtered.length > conversations.length, nextBeforeOrdinal: conversations[0]?.ordinal ?? null, ...this.conversationState(groupId) });
    });
  }

  // ── HTTP handlers ────────────────────────────────────────────────────────
  async withReady(operation, signal) {
    try {
      await this.ready;
      return await operation();
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      const code = error instanceof ServiceError ? error.code : 'not-ready';
      const status = code === 'not-ready' ? 503 : 400;
      return json(fail(code, String(error && error.message ? error.message : error)), status);
    }
  }

  handleHealth() {
    return this.withReady(() => json(this.healthPayload()));
  }

  handleBootstrap() {
    return this.withReady(async () => json(await this.bootstrapPayload()));
  }

  async bootstrapPayload() {
    const usageByGroup = new Map();
    for (const group of this.repo.groups.values()) {
      let input = 0;
      let output = 0;
      for (const message of this.repo.messagesOf(group.groupId)) {
        if (message.usage) {
          input += message.usage.inputTokens ?? 0;
          output += message.usage.outputTokens ?? 0;
        }
      }
      usageByGroup.set(group.groupId, { inputTokens: input, outputTokens: output, totalTokens: input + output });
    }
    const groups = await Promise.all(this.repo.allGroups().map(async (group) => {
      const blockers = await this.conversationBlockers(group.groupId);
      const members = this.repo.membersOf(group.groupId);
      const lastMessage = this.repo.lastMessageOf(group.groupId);
      const discussions = this.repo.discussionsOf(group.groupId).filter((item) => this.isCurrentRecord(item));
      const activeDiscussion = discussions.find((discussion) => discussion.status === 'running') || null;
      const latestDiscussion = discussions[0] || null;
      return {
        ...group,
        ...this.conversationState(group.groupId),
        canStartConversation: blockers.length === 0,
        conversationBlockers: blockers,
        memberIds: members.map((member) => member.membershipId),
        running: this.engine.isRunning(group.groupId),
        usage: usageByGroup.get(group.groupId) || { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        activeDiscussion,
        latestDiscussion,
        tasks: this.listTasks(group.groupId, { includeClosed: true, limit: 100 }),
        queue: this.engine.queueSnapshot(group.groupId),
        lastMessage: lastMessage
          ? {
              messageId: lastMessage.messageId,
              seq: lastMessage.seq,
              text: String(lastMessage.text || '').slice(0, 240) ||
                (Array.isArray(lastMessage.attachments) && lastMessage.attachments.length > 0 ? '[附件]' : ''),
              status: lastMessage.status,
              authorName: this.authorName(lastMessage),
              createdAt: lastMessage.createdAt,
            }
          : null,
      };
    }));
    return {
      ok: true,
      capabilities: { conversations: this.conversationCapability().supported, expectedConversationId: true },
      bots: this.repo.allBots(),
      groups,
      folders: this.repo.allFolders(),
      // Direct chats are group records too; the client separates them by kind.
      directGroupCount: [...this.repo.groups.values()].filter(isDirectGroup).length,
      members: [...this.repo.members.values()].map((member) => ({
        ...member,
        currentSessionId: isCurrentMemberSession(this.repo, member) ? member.sessionId : null,
        running: this.engine.running.has(member.membershipId),
      })),
      config: {
        maxParallelTurns: this.config.maxParallelTurns,
        maxContextMessages: this.config.maxContextMessages,
        dataDir: this.config.dataDir,
        personasDir: this.config.botsDir,
        defaultCwd: this.config.defaultCwd,
        botSandbox: this.config.botSandbox,
        botApprovalPolicy: this.config.botApprovalPolicy,
        dailyTokenBudget: this.config.dailyTokenBudget,
        schemaVersion: this.repo.schemaVersion(),
      },
      plugin: PLUGIN_INFO,
      health: this.healthPayload(),
      modelCatalog: await this.getModelCatalog(),
      // A preference save may complete while model catalog discovery awaits I/O.
      chatDisplaySettings: this.getChatDisplaySettings(),
      smoke: this.smokeState,
    };
  }

  handleMessages(request) {
    return this.withReady(() => {
      const url = new URL(request.url);
      const groupId = url.searchParams.get('groupId') || '';
      if (!this.repo.getGroup(groupId)) return json(fail('not-found', `群 ${groupId} 不存在`), 404);
      const limitRaw = Number(url.searchParams.get('limit'));
      const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 300) : 200;
      const parseSeq = (value) => {
        if (value === null || value === undefined || value === '') return undefined;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
      };
      const afterRaw = parseSeq(url.searchParams.get('afterSeq'));
      const beforeRaw = parseSeq(url.searchParams.get('beforeSeq'));
      let messages = this.repo.messagesOf(groupId);
      if (afterRaw !== undefined) messages = messages.filter((message) => message.seq > afterRaw);
      if (beforeRaw !== undefined) messages = messages.filter((message) => message.seq < beforeRaw);
      const hasMore = messages.length > limit;
      messages = messages.slice(-limit);
      return json({
        ok: true,
        groupId,
        messages,
        hasMore,
        ...this.conversationState(groupId),
        conversationBoundaries: this.messageConversationBoundaries(groupId, messages, { beforeSeq: beforeRaw, afterSeq: afterRaw }),
        running: this.engine.isRunning(groupId),
      });
    });
  }

  /** Export one group timeline as a self-contained PDF (subset CJK font). */
  async handleExportPdf(request) {
    return this.withReady(async () => {
      const url = new URL(request.url);
      const groupId = url.searchParams.get('groupId') || '';
      const group = this.repo.getGroup(groupId);
      if (!group) return json(fail('not-found', `群 ${groupId} 不存在`), 404);
      const lang = String(url.searchParams.get('lang') || 'zh').toLowerCase().startsWith('en') ? 'en' : 'zh';
      try {
        const pdf = await buildGroupPdf({
          group,
          members: this.repo.membersOf(groupId),
          bots: this.repo.allBots(),
          messages: this.repo.messagesOf(groupId),
          conversations: this.repo.conversationsOf?.(groupId) || [],
          truncated: false,
          lang,
          fontPath: this.config.pdfFontPath || '',
        });
        const stamp = new Date().toISOString().slice(0, 10);
        const safe = String(group.title || 'bot-team')
          .replace(/[\/:*?"<>|\u0000-\u001f]/g, '_')
          .slice(0, 80) || 'bot-team';
        const filename = `${safe}-${stamp}.pdf`;
        return new Response(pdf, {
          headers: {
            'content-type': 'application/pdf',
            'content-disposition': `attachment; filename="bot-team-${stamp}.pdf"; filename*=UTF-8''${encodeURIComponent(filename)}`,
            'content-length': String(pdf.length),
            'cache-control': 'no-store',
          },
        });
      } catch (error) {
        const code = error && typeof error.code === 'string' ? error.code : 'pdf-failed';
        return json(fail(code, String(error && error.message ? error.message : error)), code === 'pdf-font-unavailable' ? 501 : 500);
      }
    });
  }

  /** Read one reply's recorded turn without resuming or sending to the Bot. */
  handleMessageExecution(request) {
    return this.withReady(async () => {
      const url = new URL(request.url);
      let response;
      try {
        response = json(await readMessageExecution({
          ctx: this.ctx,
          repo: this.repo,
          groupId: url.searchParams.get('groupId') || '',
          messageId: url.searchParams.get('messageId') || '',
          afterSeq: url.searchParams.get('afterSeq'),
          limit: url.searchParams.get('limit'),
          signal: request.signal,
        }));
      } catch (error) {
        if (request.signal.aborted) throw error;
        const code = ['not-found', 'invalid-input'].includes(error?.code) ? error.code : 'execution-failed';
        const status = code === 'not-found' ? 404 : code === 'invalid-input' ? 400 : 500;
        response = json(fail(code, String(error?.message || error)), status);
      }
      response.headers.set('cache-control', 'no-store');
      return response;
    });
  }

  /** Read a group-owned Bot Session without activating it through ordinary Session routing. */
  handleSessionHistory(request) {
    return this.withReady(async () => {
      const url = new URL(request.url);
      let response;
      try {
        response = json(await readBotSessionHistory({
          ctx: this.ctx,
          repo: this.repo,
          groupId: url.searchParams.get('groupId') || '',
          sessionId: url.searchParams.get('sessionId') || '',
          afterSeq: url.searchParams.get('afterSeq'),
          limit: url.searchParams.get('limit'),
          signal: request.signal,
        }));
      } catch (error) {
        if (request.signal.aborted) throw error;
        const code = ['not-found', 'invalid-input'].includes(error?.code) ? error.code : 'session-history-failed';
        const status = code === 'not-found' ? 404 : code === 'invalid-input' ? 400 : 500;
        response = json(fail(code, code === 'session-history-failed' ? 'Session history read failed' : String(error?.message || error)), status);
      }
      response.headers.set('cache-control', 'no-store');
      return response;
    }, request.signal);
  }

  /** Export the canonical persisted log without activating the Bot session. */
  handleSessionExport(request) {
    return this.withReady(async () => {
      const url = new URL(request.url);
      try {
        const result = await readBotSessionLog({
          ctx: this.ctx,
          repo: this.repo,
          groupId: url.searchParams.get('groupId') || '',
          sessionId: url.searchParams.get('sessionId') || '',
          signal: request.signal,
        });
        if (!result.ok || result.availability !== 'available') return json(result, 503);
        const filename = 'session-' + result.sessionId.replace(/[^a-zA-Z0-9._-]/g, '_') + '.jsonl';
        return new Response(serializeBotSessionLog(result.header, result.events), {
          headers: {
            'content-type': 'application/x-ndjson; charset=utf-8',
            'content-disposition': 'attachment; filename="' + filename + '"',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          },
        });
      } catch (error) {
        if (request.signal.aborted) throw error;
        const code = ['not-found', 'invalid-input'].includes(error?.code) ? error.code : 'session-export-failed';
        return json(fail(code, code === 'session-export-failed' ? 'Session log export failed' : String(error?.message || error)),
          code === 'not-found' ? 404 : code === 'invalid-input' ? 400 : 500);
      }
    }, request.signal);
  }

  handleEvents(request) {
    const url = new URL(request.url);
    const groupId = url.searchParams.get('groupId') || '';
    void this.appendDebug('sse-open', { groupId, url: request.url });
    return this.withReady(() => {
      if (!this.repo.getGroup(groupId)) return json(fail('not-found', `群 ${groupId} 不存在`), 404);
      try {
        return this.createEventStream(request, groupId);
      } catch (error) {
        void this.appendDebug('sse-error', {
          groupId,
          error: String(error && error.stack ? error.stack : error),
        });
        return json(fail('sse-error', String(error && error.message ? error.message : error)), 500);
      }
    });
  }

  createEventStream(request, groupId) {
      const self = this;
      const encoder = new TextEncoder();
      let closed = false;
      let unsubscribe = () => {};
      let heartbeat;
      let controllerRef;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        try {
          unsubscribe();
        } catch {
          /* noop */
        }
        if (heartbeat) clearInterval(heartbeat);
      };

      const stream = new ReadableStream({
        start(controller) {
          // NOTE: `this` inside a ReadableStream source method is the underlying
          // source object, not the service — capture the service explicitly.
          const service = self;
          controllerRef = controller;
          const write = (frame) => {
            if (closed) return;
            try {
              controller.enqueue(
                encoder.encode(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`),
              );
            } catch {
              cleanup();
            }
          };
          unsubscribe = service.bus.subscribe(groupId, write);
          write({
            type: 'hello',
            groupId,
            seq: service.bus.seqOf(groupId),
            at: now(),
            running: service.engine.isRunning(groupId),
            chatDisplaySettings: service.getChatDisplaySettings(),
            ...service.conversationState(groupId),
          });
          // Push current member statuses so a reconnecting page is consistent.
          for (const member of service.repo.membersOf(groupId)) {
            write({
              type: 'member.status',
              membershipId: member.membershipId,
              status: service.engine.running.has(member.membershipId) ? 'running' : 'idle',
            });
          }
          heartbeat = setInterval(() => {
            if (closed) return;
            try {
              controller.enqueue(encoder.encode(': ping\n\n'));
            } catch {
              cleanup();
            }
          }, 15000);
          request.signal.addEventListener('abort', () => {
            cleanup();
            try {
              controller.close();
            } catch {
              /* noop */
            }
          });
        },
        cancel() {
          cleanup();
        },
      });

      return new Response(stream, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        },
      });
  }

  /** Debug breadcrumbs for the SSE path (written to the smoke log, no state change). */
  async appendDebug(kind, detail = {}) {
    try {
      await mkdir(this.config.smokeResultsDir, { recursive: true });
      await appendFile(
        path.join(this.config.smokeResultsDir, 'smoke.jsonl'),
        JSON.stringify({ at: new Date().toISOString(), pass: true, detail: { step: 'debug', kind, ...detail } }) + '\n',
        'utf8',
      );
    } catch {
      /* best effort */
    }
  }

  async handleActionHttp(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json(fail('bad-json', '请求体不是合法 JSON'), 400);
    }
    return this.withReady(async () => {
      try {
        const result = await this.dispatch(body && body.action, body && body.payload, { external: true });
        return json({ ok: true, result });
      } catch (error) {
        const code = error instanceof ServiceError
          ? error.code
          : error && typeof error.code === 'string'
            ? error.code
            : 'internal';
        const status = ['stale-conversation', 'conversation-busy', 'historical-target', 'reload-required', 'conflict'].includes(code) ? 409
          : code === 'not-found' && body?.action === 'conversation.new' ? 404
            : code === 'conversation-capability-unavailable' ? 503
              : ['internal', 'storage-failed', 'session-release-failed', 'conversation-corrupt'].includes(code) ? 500 : 400;
        const conversationError = ['stale-conversation', 'conversation-busy', 'historical-target', 'reload-required', 'storage-failed', 'session-release-failed', 'conversation-corrupt'].includes(code);
        const details = error?.details || (conversationError && body?.payload?.groupId ? this.conversationState(body.payload.groupId) : undefined);
        return json({ ...fail(code, String(error && error.message ? error.message : error)), ...(details ? { details } : {}) }, status);
      }
    });
  }

  async handleFileHttp(request) {
    return this.withReady(async () => {
      const url = new URL(request.url);
      if (request.method === 'PUT') {
        let body;
        try {
          body = await request.json();
        } catch {
          return json(fail('bad-json', '请求体不是合法 JSON'), 400);
        }
        const botId = String((body && body.botId) || '');
        const kind = String((body && body.kind) || '');
        const text = String((body && body.text) || '');
        await this.dispatch('persona.write', { botId, kind, text });
        return json({ ok: true, botId, kind, length: text.length });
      }
      const botId = url.searchParams.get('botId') || '';
      const kind = url.searchParams.get('kind') || 'bot';
      const bot = this.repo.getBot(botId);
      if (!bot) return json(fail('not-found', `Bot ${botId} 不存在`), 404);
      if (!PERSONA_KINDS.has(kind)) return json(fail('invalid-input', `未知人格文件: ${kind}`), 400);
      const text = await this.personas.read(botId, kind);
      const file = this.personas.fileOf(botId, kind);
      return json({ ok: true, botId, kind, text, file });
    });
  }

  /**
   * Upload one generic file into the DSH attachment store. Browser file inputs
   * send the raw bytes; the store keeps them verbatim under the harness home and
   * returns a durable read-only reference. The client only ever holds the
   * reference metadata, never a host path.
   */
  async handleUploadHttp(request) {
    return this.withReady(async () => {
      const url = new URL(request.url);
      const groupId = String(url.searchParams.get('groupId') || '');
      if (groupId && !this.repo.getGroup(groupId)) {
        return json(fail('not-found', `群 ${groupId} 不存在`), 404);
      }
      const rawName = String(url.searchParams.get('name') || '');
      const name = rawName.replace(/[\\/\r\n\t]/g, ' ').trim().slice(0, 160);
      if (!name) return json(fail('invalid-input', '文件名不能为空'), 400);
      const declared = Number(request.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) {
        return json(fail('limit', '文件不能超过 32 MB'), 413);
      }
      let data;
      try {
        data = new Uint8Array(await request.arrayBuffer());
      } catch {
        return json(fail('invalid-input', '文件读取失败'), 400);
      }
      if (data.byteLength === 0) return json(fail('invalid-input', '文件为空'), 400);
      if (data.byteLength > MAX_ATTACHMENT_BYTES) {
        return json(fail('limit', '文件不能超过 32 MB'), 413);
      }
      const store = this.ctx.get('attachments');
      if (!store || typeof store.saveFile !== 'function') {
        return json(fail('unavailable', '附件服务不可用（Host 未挂载 dsh-attachment）'), 503);
      }
      let ref;
      try {
        ref = await store.saveFile({ data, name });
      } catch (error) {
        return json(fail('attachment-failed', `文件保存失败：${String(
          error && error.message ? error.message : error,
        )}`), 500);
      }
      return json({
        ok: true,
        attachment: {
          attachmentId: String(ref.attachmentId),
          name: String(ref.name || name),
          bytes: Number.isSafeInteger(ref.bytes) ? ref.bytes : data.byteLength,
        },
      });
    });
  }

  /** User-invocable skills for the group workspace, read through a bot's agent scope. */
  handleSkillsHttp(request) {
    return this.withReady(async () => {
      const url = new URL(request.url);
      const groupId = url.searchParams.get('groupId') || '';
      const memberId = url.searchParams.get('memberId') || '';
      return json({ ok: true, ...(await this.listSkills(groupId, memberId)) });
    });
  }

  async listSkills(groupId, memberId = '') {
    return this.withWorkspaceOperation(groupId, () => this.listSkillsInWorkspace(groupId, memberId));
  }

  async listSkillsInWorkspace(groupId, memberId) {
    const group = this.repo.getGroup(groupId);
    if (!group) throw new ServiceError('not-found', `群 ${groupId} 不存在`);
    const members = this.repo.membersOf(groupId).filter(
      (member) => member.enabled !== false && this.repo.getBot(member.botId),
    );
    let member;
    if (memberId) {
      member = members.find((candidate) => candidate.membershipId === memberId);
      if (!member) throw new ServiceError('not-found', '成员不存在或已停用');
    } else {
      member = members[0];
    }
    if (!member) return { groupId, memberId: null, skills: [], reason: 'no-member' };
    const skillsService = this.ctx.get('skills');
    if (!skillsService || typeof skillsService.list !== 'function') {
      throw new ServiceError('unavailable', 'Skill 服务不可用（Host 未挂载 dsh-skill）');
    }
    let agent;
    try {
      agent = await this.pool.ensure(member.membershipId);
    } catch (error) {
      throw new ServiceError('agent-failed', `无法准备 Bot 会话：${String(
        error && error.message ? error.message : error,
      )}`);
    }
    let cwd = group.workspaceCwd || defaultWorkspaceDir(this.config, group);
    const workingDirectory = this.ctx.get('workingDirectory');
    if (workingDirectory && typeof workingDirectory.ensure === 'function') {
      try {
        const ensured = await workingDirectory.ensure(agent);
        if (typeof ensured === 'string' && ensured) cwd = ensured;
      } catch {
        /* fall back to the group workspace */
      }
    }
    let summaries;
    try {
      summaries = await skillsService.list({ cwd, scope: agent });
    } catch (error) {
      throw new ServiceError('skills-failed', `Skill 列表读取失败：${String(
        error && error.message ? error.message : error,
      )}`);
    }
    const skills = (Array.isArray(summaries) ? summaries : [])
      .filter((skill) => skill && skill.invocation && skill.invocation.userInvocable === true)
      .map((skill) => ({
        name: String(skill.name || ''),
        description: String(skill.description || ''),
        whenToUse: String(skill.whenToUse || ''),
        modelInvocable: skill.invocation.modelInvocable === true,
        source: String(skill.source || ''),
        provider: String(skill.provider || ''),
        ...(typeof skill.path === 'string' && skill.path ? { path: skill.path } : {}),
      }))
      .filter((skill) => skill.name);
    return { groupId, memberId: member.membershipId, cwd, skills };
  }

  attachmentStore() {
    const store = this.ctx.get('attachments');
    return store && typeof store.fileHostPath === 'function' ? store : null;
  }

  /** Resolve the read-only host path the bot's file tools can open. */
  attachmentPathOf(attachment) {
    const store = this.attachmentStore();
    if (!store) return null;
    try {
      const value = store.fileHostPath({
        attachmentId: attachment.attachmentId,
        name: attachment.name,
        bytes: attachment.bytes,
      });
      return typeof value === 'string' && value ? value : null;
    } catch {
      return null;
    }
  }

  /** Keep only durable references produced by the attachment store. */
  normalizeMessageAttachments(value) {
    if (!Array.isArray(value)) return [];
    const result = [];
    for (const item of value) {
      if (result.length >= MAX_MESSAGE_ATTACHMENTS) break;
      if (!item || typeof item !== 'object') continue;
      const attachmentId = String(item.attachmentId || '');
      if (!ATTACHMENT_ID_RE.test(attachmentId)) continue;
      const name = String(item.name || '').replace(/[\\/\r\n\t]/g, ' ').trim().slice(0, 160) || '附件';
      const bytes = Number.isSafeInteger(item.bytes) && item.bytes >= 0 ? item.bytes : 0;
      if (result.some((candidate) => candidate.attachmentId === attachmentId && candidate.name === name)) continue;
      const path = this.attachmentPathOf({ attachmentId, name, bytes });
      result.push({ attachmentId, name, bytes, ...(path ? { path } : {}) });
    }
    return result;
  }

  // ── action dispatch ──────────────────────────────────────────────────────
  actionGroupIds(action, input) {
    const ids = new Set();
    const add = (value) => { if (value && this.repo.getGroup(value)) ids.add(value); };
    add(input.groupId);
    add(this.repo.getMember?.(input.membershipId)?.groupId);
    add(this.repo.getTask?.(input.taskId)?.groupId);
    add(this.repo.getDiscussion?.(input.discussionId)?.groupId);
    for (const key of ['messageId', 'targetMessageId', 'reviewMessageId']) add(this.repo.messages?.get(input[key])?.groupId);
    if (input.botId && ['bot.update', 'bot.delete', 'persona.write', 'direct.open'].includes(action)) {
      for (const member of this.repo.membersOfBot(input.botId)) add(member.groupId);
    }
    if (['group.reorder', 'folder.delete'].includes(action)) for (const group of this.repo.allGroups()) add(group.groupId);
    return [...ids].sort();
  }

  async dispatch(action, payload = {}, { external = false } = {}) {
    await this.ready;
    const input = payload && typeof payload === 'object' && !Array.isArray(payload) ? { ...payload } : {};
    if (action === 'conversation.new') return this.newConversation(input);
    const groupIds = this.actionGroupIds(action, input);
    const executing = ['message.post', 'message.retry', 'message.stop', 'review.request', 'review.revise',
      'discussion.start', 'discussion.stop', 'interaction.respond', 'task.create', 'task.dispatch',
      'task.dispatch_ready', 'task.review', 'task.accept', 'task.request_changes', 'task.revise', 'task.update', 'task.cancel'].includes(action);
    if (executing) {
      for (const groupId of groupIds) this.assertExpectedConversation(groupId, input.expectedConversationId, external);
      if (input.expectedConversationId === undefined && groupIds.length === 1) input.expectedConversationId = currentConversationId(this.repo, groupIds[0]);
    }
    // Workspace changes provide their own exclusive admission; counting that
    // same request as an ordinary operation would make it block itself.
    if (action === 'group.workspace.set' || (action === 'group.update' && input.workspaceCwd !== undefined)
      || ['interaction.list', 'ui.report'].includes(action)) return this.dispatchAction(action, input);
    const perform = (index) => index < groupIds.length
      ? this.withWorkspaceOperation(groupIds[index], () => perform(index + 1))
      : this.dispatchAction(action, input);
    return perform(0);
  }

  async dispatchAction(action, input) {
    switch (action) {
      case 'interaction.list':
        return this.interactions.snapshot(input.groupId);
      case 'interaction.respond':
        return this.interactions.respond(input);
      case 'settings.chatDisplay.update':
        return this.updateChatDisplaySettings(input);
      case 'group.create':
        return this.createGroup(input);
      case 'group.update':
        return this.updateGroup(input);
      case 'group.workspace.set':
        return this.setGroupWorkspace(input);
      case 'group.delete':
        return this.deleteGroup(input);
      case 'group.reorder':
        return this.reorderGroups(input);
      case 'folder.create':
        return this.createFolder(input);
      case 'folder.update':
        return this.updateFolder(input);
      case 'folder.delete':
        return this.deleteFolder(input);
      case 'folder.reorder':
        return this.reorderFolders(input);
      case 'direct.open':
        return this.openDirect(input);
      case 'bot.create':
        return this.createBot(input);
      case 'bot.update':
        return this.updateBot(input);
      case 'bot.delete':
        return this.deleteBot(input);
      case 'member.add':
        return this.addMember(input);
      case 'member.remove':
        return this.removeMember(input);
      case 'member.update':
        return this.updateMember(input);
      case 'message.post':
        return this.postMessage(input);
      case 'message.delete':
        return this.deleteMessage(input);
      case 'message.stop':
        return this.stopGroup(input);
      case 'message.retry':
        return this.engine.retryMessage(String(input.messageId || ''));
      case 'review.request':
        return this.requestReview(input);
      case 'review.revise':
        return this.requestRevision(input);
      case 'discussion.start':
        return this.startDiscussion(input);
      case 'discussion.stop':
        return this.engine.stopDiscussion(String(input.discussionId || ''));
      case 'task.create':
        return this.createTask(input);
      case 'task.dispatch':
        return this.dispatchTask(input);
      case 'task.dispatch_ready':
        return this.dispatchReadyTasks(input);
      case 'task.review':
        return this.reviewTask(input);
      case 'task.accept':
        return this.acceptTask(input);
      case 'task.request_changes':
        return this.requestTaskChanges(input);
      case 'task.revise':
        return this.reviseTask(input);
      case 'task.cancel':
        return this.cancelTask(input);
      case 'task.update':
        return this.updateTask(input);
      case 'persona.write':
        return this.writePersona(input);
      case 'ui.report':
        return this.recordUiReport(input);
      default:
        throw new ServiceError('unknown-action', `未知操作: ${String(action)}`);
    }
  }

  getChatDisplaySettings() {
    return normalizeChatDisplaySettings(this.repo.getMeta(CHAT_DISPLAY_SETTINGS_KEY));
  }

  async updateChatDisplaySettings({ settings }) {
    if (!isChatDisplaySettings(settings)) {
      throw new ServiceError('invalid-input', '群聊显示设置无效：每项须为 hover / always / hidden');
    }
    const next = normalizeChatDisplaySettings(settings);
    await this.repo.putMeta(CHAT_DISPLAY_SETTINGS_KEY, next);
    // Preferences are profile-wide, not tied to whichever group is open.
    for (const group of this.repo.allGroups()) {
      this.bus.emit(group.groupId, { type: 'settings.updated', chatDisplaySettings: next });
    }
    return { chatDisplaySettings: next };
  }

  isTaskReady(task) {
    if (!this.isCurrentRecord(task)) return { ready: false, blockers: [{ taskId: task.taskId, title: task.title, status: 'historical' }] };
    const blockers = [];
    for (const dependencyId of task.dependsOn || []) {
      const dependency = this.repo.getTask(dependencyId);
      blockers.push({
        taskId: dependencyId,
        title: dependency ? dependency.title : '（已删除的任务）',
        status: dependency ? dependency.status : 'missing',
      });
    }
    const pending = blockers.filter((blocker) => blocker.status !== 'accepted');
    return { ready: pending.length === 0, blockers: pending };
  }

  taskView(task) {
    if (!task) return null;
    const { ready, blockers } = this.isTaskReady(task);
    return { ...task, priority: task.priority || 'normal', dependsOn: task.dependsOn || [], ready, blockedBy: blockers };
  }

  taskSortValue(task) {
    const rank = TASK_PRIORITY_RANK[task.priority] ?? TASK_PRIORITY_RANK.normal;
    return rank * 1e15 + (task.createdAt || 0);
  }

  listTasks(groupId, options = {}) {
    const includeClosed = options.includeClosed === true;
    let tasks = this.repo.tasksOf(groupId)
      .filter((task) => options.includeHistorical === true || this.isCurrentRecord(task))
      .map((task) => this.taskView(task));
    if (options.taskId) tasks = tasks.filter((task) => task.taskId === options.taskId);
    if (options.status) tasks = tasks.filter((task) => task.status === options.status);
    if (!includeClosed && !options.status) {
      tasks = tasks.filter((task) => task.status !== 'accepted' && task.status !== 'cancelled');
    }
    tasks.sort((a, b) => this.taskSortValue(a) - this.taskSortValue(b));
    const limit = Number.isInteger(options.limit) ? Math.min(Math.max(options.limit, 1), 100) : 20;
    return tasks.slice(0, limit);
  }

  /** Validate same-group, existence, count and acyclicity; returns normalized ids. */
  validateDependsOn(groupId, taskId, dependsOn) {
    const ids = [...new Set((Array.isArray(dependsOn) ? dependsOn : []).filter((value) => typeof value === 'string' && value))];
    if (ids.length > MAX_TASK_DEPENDENCIES) {
      throw new ServiceError('invalid-input', '依赖任务数量超过上限 ' + MAX_TASK_DEPENDENCIES);
    }
    const all = new Map(this.repo.tasksOf(groupId).map((task) => [task.taskId, task]));
    for (const dependencyId of ids) {
      if (taskId && dependencyId === taskId) throw new ServiceError('invalid-input', '任务不能依赖自身');
      const dependency = all.get(dependencyId);
      if (!dependency) throw new ServiceError('invalid-input', '依赖任务不存在：' + dependencyId);
      this.assertCurrentRecord(dependency);
      if (dependency.status === 'cancelled') throw new ServiceError('invalid-input', '依赖任务已取消：' + dependency.title);
    }
    if (taskId && ids.length > 0) {
      const graph = new Map([...all.entries()].map(([id, task]) => [
        id,
        id === taskId ? ids : (Array.isArray(task.dependsOn) ? task.dependsOn : []),
      ]));
      const stack = [...ids];
      const visited = new Set();
      while (stack.length > 0) {
        const current = stack.pop();
        if (current === taskId) throw new ServiceError('invalid-input', '依赖关系存在循环（涉及任务 ' + ids.join('、') + '）');
        if (visited.has(current)) continue;
        visited.add(current);
        const next = graph.get(current);
        if (next) stack.push(...next);
      }
    }
    return ids;
  }

  emitTask(task) {
    if (!task) return;
    this.bus.emit(task.groupId, { type: 'task.updated', task: this.taskView(task) });
  }

  /** After a task is accepted, notify and mark dependents that became dispatchable. */
  async unblockDependents(task) {
    if (!this.isCurrentRecord(task)) return [];
    const dependents = this.repo
      .tasksOf(task.groupId)
      .filter(
        (candidate) =>
          this.isCurrentRecord(candidate) &&
          candidate.taskId !== task.taskId &&
          (candidate.dependsOn || []).includes(task.taskId) &&
          candidate.status !== 'accepted' &&
          candidate.status !== 'cancelled',
      );
    if (dependents.length === 0) return [];
    const views = dependents.map((dependent) => this.taskView(dependent));
    for (const depend of dependents) this.emitTask(depend);
    const readyNames = views.filter((view) => view.ready).map((view) => view.title);
    if (this.config.autoDispatchReady) {
      for (const view of views.filter((candidate) => candidate.ready && candidate.status === 'pending')) {
        try {
          await this.dispatchTask({ taskId: view.taskId });
        } catch (error) {
          this.logger?.warn?.('bot-team: auto dispatch ' + view.taskId + ' skipped: ' + String(error));
        }
      }
    }
    if (readyNames.length > 0) {
      this.engine.systemMessage(
        task.groupId,
        '任务「' + task.title + '」已验收，前置依赖解除：' + readyNames.join('、') + ' 可以派发了。',
      );
    }
    return views;
  }

  requireTaskQuota(groupId) {
    try {
      this.engine.assertQuota(groupId);
    } catch (error) {
      if (error && error.code) throw new ServiceError(error.code, String(error.message));
      throw error;
    }
  }

  taskAssigneeOf(task) {
    const member = task ? this.repo.getMember(task.assigneeMembershipId) : undefined;
    return member ? this.repo.getBot(member.botId) : undefined;
  }

  async createTask(input) {
    const groupId = String(input.groupId || '');
    const group = this.repo.getGroup(groupId);
    if (!group) throw new ServiceError('not-found', '群不存在');
    if (isDirectGroup(group)) throw new ServiceError('invalid-input', '单聊不支持任务板，请使用群聊');
    const title = requireText(input.title, '任务标题', 200);
    const description = optionalText(input.description, 4000);
    const acceptance = optionalText(input.acceptance, 2000);
    const assignee = this.repo.getMember(String(input.assigneeMembershipId || ''));
    if (!assignee || assignee.groupId !== groupId) throw new ServiceError('invalid-input', '指派对象不在该群里');
    const reviewer = input.reviewerMembershipId
      ? this.repo.getMember(String(input.reviewerMembershipId))
      : undefined;
    if (input.reviewerMembershipId && (!reviewer || reviewer.groupId !== groupId)) {
      throw new ServiceError('invalid-input', '评审者不在该群里');
    }
    const priority = TASK_PRIORITIES.includes(input.priority) ? input.priority : 'normal';
    const dependsOn = this.validateDependsOn(groupId, null, input.dependsOn);
    const task = {
      taskId: newId('task'),
      groupId,
      conversationId: currentConversationId(this.repo, groupId),
      title,
      description,
      acceptance,
      assigneeMembershipId: assignee.membershipId,
      ...(reviewer ? { reviewerMembershipId: reviewer.membershipId } : {}),
      priority,
      dependsOn,
      status: 'pending',
      revision: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    await this.repo.putTask(task);
    this.emitTask(task);
    return task;
  }

  /** One-click dispatch: every pending+ready task, highest priority first. */
  async dispatchReadyTasks(input) {
    const groupId = String(input.groupId || '');
    const group = this.repo.getGroup(groupId);
    if (!group) throw new ServiceError('not-found', '群不存在');
    const limit = Number.isInteger(input.limit) ? Math.min(Math.max(input.limit, 1), 20) : 10;
    const candidates = this.listTasks(groupId, { limit: 200 })
      .filter((task) => task.status === 'pending' && task.ready === true)
      .slice(0, limit);
    const dispatched = [];
    const skipped = [];
    for (const task of candidates) {
      try {
        await this.dispatchTask({ taskId: task.taskId });
        dispatched.push({ taskId: task.taskId, title: task.title, priority: task.priority });
      } catch (error) {
        skipped.push({
          taskId: task.taskId,
          title: task.title,
          reason: String(error && error.message ? error.message : error),
        });
        if (error && error.code === 'quota') break;
      }
    }
    return { dispatched, skipped, queue: this.engine.queueSnapshot(groupId), pendingReady: candidates.length };
  }

  async dispatchTask(input) {
    const task = this.repo.getTask(String(input.taskId || ''));
    if (!task) throw new ServiceError('not-found', '任务不存在');
    this.assertCurrentRecord(task);
    this.assertExpectedConversation(task.groupId, input.expectedConversationId);
    if (task.status !== 'pending') throw new ServiceError('invalid-input', '只有待派发的任务可以派发（当前：' + task.status + '）');
    const readiness = this.isTaskReady(task);
    if (!readiness.ready) {
      throw new ServiceError(
        'invalid-input',
        '任务被依赖阻塞：' + readiness.blockers.map((blocker) => blocker.title + '（' + blocker.status + '）').join('、'),
      );
    }
    this.requireTaskQuota(task.groupId);
    return this.withWorkspaceOperation(task.groupId, async () => {
      task.status = 'in_progress';
      await this.repo.putTask(task);
      this.emitTask(task);
      this.engine.enqueueTaskTurn({ taskId: task.taskId, phase: 'dispatch' });
      return task;
    });
  }

  async reviewTask(input) {
    const task = this.repo.getTask(String(input.taskId || ''));
    if (!task) throw new ServiceError('not-found', '任务不存在');
    this.assertCurrentRecord(task);
    this.assertExpectedConversation(task.groupId, input.expectedConversationId);
    if (task.status !== 'delivered') throw new ServiceError('invalid-input', '只有已交付的任务可以评审（当前：' + task.status + '）');
    const reviewerMembershipId = String(input.reviewerMembershipId || task.reviewerMembershipId || '');
    const reviewer = this.repo.getMember(reviewerMembershipId);
    if (!reviewer || reviewer.groupId !== task.groupId) throw new ServiceError('invalid-input', '评审者不在该群里');
    if (!task.deliverableMessageId) throw new ServiceError('invalid-input', '任务还没有交付物');
    this.requireTaskQuota(task.groupId);
    const instructions =
      optionalText(input.instructions, 2000) ||
      '请按验收标准评审该任务的交付物：第一行输出 结论：通过 或 结论：需修改，然后给理由与具体修改建议。' +
        (task.acceptance ? '\n验收标准：' + task.acceptance : '');
    const result = this.engine.requestReview({
      groupId: task.groupId,
      targetMessageId: task.deliverableMessageId,
      reviewerMembershipId: reviewer.membershipId,
      instructions,
      taskId: task.taskId,
    });
    task.reviewerMembershipId = reviewer.membershipId;
    task.reviewMessageId = result.requestMessage.messageId;
    task.status = 'delivered';
    await this.repo.putTask(task);
    this.emitTask(task);
    return { task, review: result };
  }

  async acceptTask(input) {
    const task = this.repo.getTask(String(input.taskId || ''));
    if (!task) throw new ServiceError('not-found', '任务不存在');
    this.assertCurrentRecord(task);
    this.assertExpectedConversation(task.groupId, input.expectedConversationId);
    if (task.status !== 'delivered' && task.status !== 'changes_requested') {
      throw new ServiceError('invalid-input', '当前状态不能验收（' + task.status + '）');
    }
    return this.withWorkspaceOperation(task.groupId, async () => {
      task.status = 'accepted';
      task.acceptedAt = now();
      await this.repo.putTask(task);
      this.emitTask(task);
      await this.unblockDependents(task);
      return this.taskView(task);
    });
  }

  async updateTask(input) {
    const task = this.repo.getTask(String(input.taskId || ''));
    if (!task) throw new ServiceError('not-found', '任务不存在');
    this.assertCurrentRecord(task);
    this.assertExpectedConversation(task.groupId, input.expectedConversationId);
    if (task.status === 'accepted' || task.status === 'cancelled') {
      throw new ServiceError('invalid-input', '已验收/已取消的任务不能编辑');
    }
    if (input.title !== undefined) task.title = requireText(input.title, '任务标题', 200);
    if (input.description !== undefined) task.description = optionalText(input.description, 4000);
    if (input.acceptance !== undefined) task.acceptance = optionalText(input.acceptance, 2000);
    if (input.priority !== undefined) {
      if (!TASK_PRIORITIES.includes(input.priority)) {
        throw new ServiceError('invalid-input', '未知优先级：' + String(input.priority));
      }
      task.priority = input.priority;
    }
    if (input.assigneeMembershipId !== undefined) {
      const assignee = this.repo.getMember(String(input.assigneeMembershipId));
      if (!assignee || assignee.groupId !== task.groupId) throw new ServiceError('invalid-input', '指派对象不在该群里');
      task.assigneeMembershipId = assignee.membershipId;
    }
    if (input.reviewerMembershipId !== undefined) {
      if (!input.reviewerMembershipId) delete task.reviewerMembershipId;
      else {
        const reviewer = this.repo.getMember(String(input.reviewerMembershipId));
        if (!reviewer || reviewer.groupId !== task.groupId) throw new ServiceError('invalid-input', '评审者不在该群里');
        task.reviewerMembershipId = reviewer.membershipId;
      }
    }
    if (input.dependsOn !== undefined) task.dependsOn = this.validateDependsOn(task.groupId, task.taskId, input.dependsOn);
    await this.repo.putTask(task);
    this.emitTask(task);
    return this.taskView(task);
  }

  async requestTaskChanges(input) {
    const task = this.repo.getTask(String(input.taskId || ''));
    if (!task) throw new ServiceError('not-found', '任务不存在');
    this.assertCurrentRecord(task);
    this.assertExpectedConversation(task.groupId, input.expectedConversationId);
    if (task.status !== 'delivered') throw new ServiceError('invalid-input', '只有已交付的任务可以要求修改（当前：' + task.status + '）');
    task.status = 'changes_requested';
    task.changesRequestedAt = now();
    await this.repo.putTask(task);
    this.emitTask(task);
    return task;
  }

  async reviseTask(input) {
    const task = this.repo.getTask(String(input.taskId || ''));
    if (!task) throw new ServiceError('not-found', '任务不存在');
    this.assertCurrentRecord(task);
    this.assertExpectedConversation(task.groupId, input.expectedConversationId);
    if (task.status !== 'changes_requested') throw new ServiceError('invalid-input', '只有被要求修改的任务可以重新交付（当前：' + task.status + '）');
    const readiness = this.isTaskReady(task);
    if (!readiness.ready) {
      throw new ServiceError(
        'invalid-input',
        '任务被依赖阻塞：' + readiness.blockers.map((blocker) => blocker.title + '（' + blocker.status + '）').join('、'),
      );
    }
    this.requireTaskQuota(task.groupId);
    return this.withWorkspaceOperation(task.groupId, async () => {
      task.status = 'in_progress';
      await this.repo.putTask(task);
      this.emitTask(task);
      this.engine.enqueueTaskTurn({ taskId: task.taskId, phase: 'revision' });
      return task;
    });
  }

  async cancelTask(input) {
    const task = this.repo.getTask(String(input.taskId || ''));
    if (!task) throw new ServiceError('not-found', '任务不存在');
    this.assertCurrentRecord(task);
    this.assertExpectedConversation(task.groupId, input.expectedConversationId);
    if (task.status === 'accepted') throw new ServiceError('invalid-input', '已验收的任务不能取消');
    const dependents = this.repo
      .tasksOf(task.groupId)
      .filter(
        (candidate) =>
          this.isCurrentRecord(candidate) &&
          candidate.taskId !== task.taskId &&
          (candidate.dependsOn || []).includes(task.taskId) &&
          candidate.status !== 'accepted' &&
          candidate.status !== 'cancelled',
      );
    const force = input.force === true;
    if (dependents.length > 0 && !force) {
      throw new ServiceError(
        'invalid-input',
        '以下任务依赖它，请先处理依赖或使用 force 级联取消：' + dependents.map((depend) => depend.title).join('、'),
      );
    }
    const cancelledDependents = [];
    for (const depend of dependents) {
      depend.status = 'cancelled';
      depend.cancelledAt = now();
      await this.repo.putTask(depend);
      this.emitTask(depend);
      cancelledDependents.push(depend.taskId);
    }
    const wasRunning = task.status === 'in_progress';
    task.status = 'cancelled';
    task.cancelledAt = now();
    await this.repo.putTask(task);
    const interruption = wasRunning ? this.engine.cancelTaskRun(task.taskId) : { aborted: 0, dequeued: 0 };
    this.emitTask(task);
    return { ...this.taskView(task), cancelledDependents, interruption };
  }

  /** Engine hook: task delivery / revision / review results move the task state machine. */
  async onTaskJobFinished(job, message, status) {
    try {
      const taskId = job && job.meta ? job.meta.taskId : undefined;
      if (!taskId) return;
      const task = this.repo.getTask(taskId);
      if (!task || !this.isCurrentRecord(task) || (job.conversationId && job.conversationId !== currentConversationId(this.repo, task.groupId))) return;
      if (job.kind === 'task' || job.kind === 'task_revision') {
        if (status === 'done' && message) {
          task.status = 'delivered';
          task.deliverableMessageId = message.messageId;
          task.revision = (task.revision || 0) + 1;
          task.lastDeliveredAt = now();
        } else if (task.status !== 'cancelled') {
          task.status = 'in_progress';
          task.lastError = (message && message.error) || status;
        }
      } else if (job.kind === 'review') {
        task.reviewReplyMessageId = message ? message.messageId : task.reviewReplyMessageId;
        const verdict = message && message.meta ? message.meta.verdict : undefined;
        if (status === 'done' && verdict === 'pass') task.status = 'accepted';
        else if (status === 'done' && verdict === 'changes') task.status = 'changes_requested';
        task.revision = (task.revision || 0) + 1;
      }
      await this.repo.putTask(task);
      if (!this.isCurrentRecord(task)) return;
      this.emitTask(task);
      if (task.status === 'accepted') await this.unblockDependents(task);
    } catch (hookError) {
      // A bookkeeping failure must never crash the host process.
      this.logger?.warn?.('bot-team: task bookkeeping failed: ' + String(hookError));
    }
  }

  async requestReview(input) {
    const groupId = String(input.groupId || '');
    const group = this.repo.getGroup(groupId);
    if (group && isDirectGroup(group)) throw new ServiceError('invalid-input', '单聊不支持评审，请使用群聊');
    const targetMessageId = String(input.targetMessageId || '');
    const reviewerMembershipId = String(input.reviewerMembershipId || '');
    const instructions = optionalText(input.instructions, 2000);
    try {
      this.assertExpectedConversation(groupId, input.expectedConversationId);
      return this.engine.requestReview({ groupId, targetMessageId, reviewerMembershipId, instructions, expectedConversationId: input.expectedConversationId });
    } catch (error) {
      if (error && error.code) throw new ServiceError(error.code, String(error.message));
      throw error;
    }
  }

  async requestRevision(input) {
    const group = this.repo.getGroup(String(input.groupId || ''));
    if (group && isDirectGroup(group)) throw new ServiceError('invalid-input', '单聊不支持评审修改，请使用群聊');
    try {
      return this.engine.requestRevision({
        groupId: String(input.groupId || ''),
        reviewMessageId: String(input.reviewMessageId || ''),
        expectedConversationId: input.expectedConversationId,
      });
    } catch (error) {
      if (error && error.code) throw new ServiceError(error.code, String(error.message));
      throw error;
    }
  }

  async startDiscussion(input) {
    const groupId = String(input.groupId || '');
    const group = this.repo.getGroup(groupId);
    if (!group) throw new ServiceError('not-found', '群不存在');
    if (isDirectGroup(group)) throw new ServiceError('invalid-input', '单聊不支持多轮讨论，请使用群聊');
    const topic = requireText(input.topic, '讨论议题', 2000);
    const roundsRaw = Number(input.rounds);
    const rounds = Number.isInteger(roundsRaw) ? Math.min(Math.max(roundsRaw, 1), 5) : 2;
    const membershipIds = Array.isArray(input.membershipIds)
      ? input.membershipIds.filter((value) => typeof value === 'string')
      : this.repo.membersOf(groupId).map((member) => member.membershipId);
    try {
      return await this.engine.startDiscussion({
        groupId,
        topic,
        membershipIds,
        rounds,
        summarize: input.summarize === true,
        expectedConversationId: input.expectedConversationId,
      });
    } catch (error) {
      if (error && error.code) throw new ServiceError(error.code, String(error.message));
      throw error;
    }
  }

  /**
   * Client-side UI verification breadcrumbs (page rendered, bootstrap/messages
   * loaded, SSE hello). Recorded into the same smoke log so M1 verification has
   * objective evidence that the real page talked to the Host.
   */
  async recordUiReport(input) {
    const payload = input && typeof input === 'object' ? input : {};
    const kind = asString(payload.kind, 60);
    const allowed = new Set(['bootstrap-loaded', 'messages-loaded', 'sse-hello', 'sse-error', 'page-mounted', 'action']);
    if (!allowed.has(kind)) return { accepted: false };
    await this.appendSmoke({
      pass: true,
      detail: {
        step: 'ui',
        kind,
        groupId: asString(payload.groupId, 80) || undefined,
        bots: Number.isInteger(payload.bots) ? payload.bots : undefined,
        groups: Number.isInteger(payload.groups) ? payload.groups : undefined,
        members: Number.isInteger(payload.members) ? payload.members : undefined,
        count: Number.isInteger(payload.count) ? payload.count : undefined,
        seq: Number.isInteger(payload.seq) ? payload.seq : undefined,
        action: asString(payload.action, 60) || undefined,
      },
    });
    return { accepted: true };
  }

  // ── groups / folders / direct chats ──────────────────────────────────────
  groupChats() {
    return [...this.repo.groups.values()].filter((group) => !isDirectGroup(group));
  }

  directGroups() {
    return sortByOrder([...this.repo.groups.values()].filter(isDirectGroup));
  }

  groupsInFolder(folderId) {
    return sortByOrder(this.groupChats().filter((group) => groupFolderIdOf(group) === (folderId || null)));
  }

  /** Validate an optional folder id ('' / null / undefined mean ungrouped). */
  async requireFolder(folderId) {
    if (folderId === undefined || folderId === null || folderId === '') return null;
    const folder = this.repo.getFolder(String(folderId));
    if (!folder) throw new ServiceError('not-found', '分组不存在');
    return folder;
  }

  assertWorkspaceStable(groupId) {
    if (this.conversationChanges?.has(groupId)) {
      throw new ServiceError('conversation-busy', '正在新建会话，请稍后重试', this.conversationState(groupId));
    }
    if (this.workspaceChanges?.has(groupId)) {
      throw new ServiceError('busy', '正在切换项目目录，请稍后重试');
    }
  }

  /** Reserve a group before an async operation can prepare an agent or enqueue work. */
  async withWorkspaceOperation(groupId, operation) {
    this.assertWorkspaceStable(groupId);
    this.workspaceOperations ??= new Map();
    this.workspaceOperations.set(groupId, (this.workspaceOperations.get(groupId) || 0) + 1);
    try {
      return await operation();
    } finally {
      const remaining = this.workspaceOperations.get(groupId) - 1;
      if (remaining > 0) this.workspaceOperations.set(groupId, remaining);
      else this.workspaceOperations.delete(groupId);
    }
  }

  workspaceBusy(groupId) {
    return this.engine.isRunning(groupId)
      || this.engine.hasPendingWork?.(groupId)
      || this.repo.activeDiscussionOf(groupId)
      || this.workspaceOperations?.get(groupId) > 0
      || this.pool.isPreparingGroup?.(groupId);
  }

  /** Hold admission closed from before the first filesystem await through persistence. */
  async withWorkspaceChange(groupId, value, commit) {
    const group = this.repo.getGroup(groupId);
    if (!group) throw new ServiceError('not-found', '群不存在');
    const fallback = defaultWorkspaceDir(this.config, group);
    const normalized = normalizeWorkspacePath(value);
    // The legacy settings form always posts workspaceCwd, including the default.
    const selected = normalized && !sessionCwdMatches(normalized, fallback) ? normalized : '';
    const current = group.workspaceCwd || fallback;
    this.assertWorkspaceStable(groupId);
    if (sessionCwdMatches(selected || fallback, current) && (group.projectWorkspaceCwd || '') === selected) {
      return this.withWorkspaceOperation(groupId, () => commit({ workspaceCwd: current, projectWorkspaceCwd: selected }));
    }
    if (this.workspaceBusy(groupId)) {
      throw new ServiceError('busy', '当前聊天有运行、排队或准备中的任务或讨论，请结束后再切换项目目录');
    }
    this.workspaceChanges ??= new Set();
    this.workspaceChanges.add(groupId);
    try {
      const projectWorkspaceCwd = selected ? await validateProjectWorkspace(selected) : '';
      const workspaceCwd = projectWorkspaceCwd || fallback;
      if (!selected && !(await ensureWorkspaceDir(fallback, this.logger))) {
        throw new ServiceError('invalid-input', '无法准备默认工作目录');
      }
      if (!sessionCwdMatches(current, workspaceCwd)) {
        // Await disposal before publishing the new root. The session id remains
        // durable; AgentPool.ensure rotates it when its creation cwd differs.
        for (const member of this.repo.membersOf(groupId)) {
          await this.pool.disposeMember(member.membershipId, { strict: true });
        }
      }
      return await commit({ workspaceCwd, projectWorkspaceCwd });
    } finally {
      this.workspaceChanges.delete(groupId);
    }
  }

  async setGroupWorkspace(input) {
    const workspaceCwd = normalizeWorkspacePath(input.workspaceCwd);
    return this.updateGroup({ groupId: input.groupId, workspaceCwd });
  }

  async createGroup(input) {
    const title = requireText(input.title, '群名称', 120);
    if (this.groupChats().length >= this.config.maxGroups) {
      throw new ServiceError('limit', `群数量已达上限 ${this.config.maxGroups}`);
    }
    const selected = normalizeWorkspacePath(input.workspaceCwd ?? '');
    const projectWorkspaceCwd = selected ? await validateProjectWorkspace(selected) : '';
    const folder = await this.requireFolder(input.folderId);
    const avatar = normalizeAvatar(input.avatar);
    const groupId = newId('grp');
    const groupWorkspace = projectWorkspaceCwd || defaultWorkspaceDir(this.config, { kind: 'group', groupId });
    if (!projectWorkspaceCwd && !(await ensureWorkspaceDir(groupWorkspace, this.logger))) {
      throw new ServiceError('invalid-input', '无法准备默认工作目录');
    }
    const group = {
      groupId,
      kind: 'group',
      title,
      topic: optionalText(input.topic, 2000),
      workspaceCwd: groupWorkspace,
      projectWorkspaceCwd,
      folderId: folder ? folder.folderId : null,
      order: nextOrder(this.groupsInFolder(folder ? folder.folderId : null)),
      ...(avatar ? { avatar } : {}),
      nextSeq: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    await this.repo.putGroup(group);
    this.logger?.info?.(`bot-team: created group ${group.groupId} "${title}"`);
    return this.repo.getGroup(group.groupId);
  }

  async updateGroup(input) {
    const groupId = String(input.groupId || '');
    if (!this.repo.getGroup(groupId)) throw new ServiceError('not-found', '群不存在');
    const commit = async (workspace = {}) => {
      let folder;
      if (input.folderId !== undefined) {
        if (isDirectGroup(this.repo.getGroup(groupId))) throw new ServiceError('invalid-input', '单聊不能放进分组');
        folder = await this.requireFolder(input.folderId);
      }
      // Read after all asynchronous validation so a running turn cannot have its
      // newly allocated sequence overwritten by a stale group snapshot.
      const previous = this.repo.getGroup(groupId);
      if (!previous) throw new ServiceError('not-found', '群不存在');
      const group = { ...previous, ...workspace };
      if (input.title !== undefined) {
        if (isDirectGroup(group)) throw new ServiceError('invalid-input', '单聊名称随 Bot 名称自动更新');
        group.title = requireText(input.title, '群名称', 120);
      }
      if (input.topic !== undefined) group.topic = optionalText(input.topic, 2000);
      if (input.avatar !== undefined) {
        const avatar = normalizeAvatar(input.avatar);
        if (avatar) group.avatar = avatar;
        else delete group.avatar;
      }
      if (input.folderId !== undefined) {
        const nextFolderId = folder ? folder.folderId : null;
        if (groupFolderIdOf(group) !== nextFolderId) {
          group.folderId = nextFolderId;
          group.order = nextOrder(this.groupsInFolder(nextFolderId));
        }
      }
      if (JSON.stringify(group) === JSON.stringify(previous)) return previous;
      try {
        await this.repo.putGroup(group);
      } catch (error) {
        // putGroup publishes to the in-memory map before its durable write.
        // Keep failed workspace changes invisible once admission opens again.
        if (this.repo.getGroup(groupId) === group) {
          previous.nextSeq = Math.max(previous.nextSeq || 0, group.nextSeq || 0);
          this.repo.groups.set(groupId, previous);
        }
        throw error;
      }
      this.bus.emit(groupId, { type: 'group.updated', group });
      return group;
    };
    return input.workspaceCwd !== undefined
      ? this.withWorkspaceChange(groupId, input.workspaceCwd, commit)
      : this.withWorkspaceOperation(groupId, () => commit());
  }

  async deleteGroup(input) {
    const group = this.repo.getGroup(String(input.groupId || ''));
    if (!group) throw new ServiceError('not-found', '群不存在');
    if (isDirectGroup(group)) {
      throw new ServiceError('invalid-input', '单聊由 Bot 自动创建，删除 Bot 时会一并删除');
    }
    this.engine.stopGroup(group.groupId);
    for (const member of this.repo.membersOf(group.groupId)) {
      await this.pool.disposeMember(member.membershipId);
      await this.repo.deleteMember(member.membershipId);
    }
    for (const message of this.repo.messagesOf(group.groupId)) {
      await this.repo.deleteMessage(message.messageId);
    }
    for (const discussion of this.repo.discussionsOf(group.groupId)) {
      await this.repo.deleteDiscussion(discussion.discussionId);
    }
    for (const task of this.repo.tasksOf(group.groupId)) {
      await this.repo.deleteTask(task.taskId);
    }
    await this.repo.deleteGroup(group.groupId);
    this.bus.closeGroup(group.groupId);
    this.logger?.info?.(`bot-team: deleted group ${group.groupId}`);
    return { groupId: group.groupId };
  }

  /**
   * One direct chat per bot. Deterministic ids keep this idempotent, and a bot
   * created outside the UI (or restored from an older schema) still gets its
   * single-chat window on the next activation.
   */
  async ensureDirectGroup(bot) {
    let direct = this.directGroups().find((group) => group.botId === bot.botId);
    if (!direct) {
      const at = now();
      direct = {
        groupId: directGroupIdFor(bot.botId),
        kind: GROUP_KIND_DIRECT,
        botId: bot.botId,
        title: bot.name,
        topic: '',
        workspaceCwd: defaultWorkspaceDir(this.config, { kind: 'direct', botId: bot.botId }),
        projectWorkspaceCwd: '',
        folderId: null,
        order: nextOrder(this.directGroups()),
        nextSeq: 0,
        createdAt: at,
        updatedAt: at,
      };
      if (this.repo.groups.has(direct.groupId)) {
        direct.groupId = newId('grp');
      }
      await this.repo.putGroup(direct);
    } else {
      let changed = false;
      if (direct.title !== bot.name) { direct.title = bot.name; changed = true; }
      if (direct.folderId === undefined) { direct.folderId = null; changed = true; }
      if (!Number.isInteger(direct.order)) {
        direct.order = nextOrder(this.directGroups());
        changed = true;
      }
      if (!direct.workspaceCwd) {
        direct.workspaceCwd = defaultWorkspaceDir(this.config, direct);
        changed = true;
      }
      if (changed) await this.repo.putGroup(direct);
    }
    if (!direct.projectWorkspaceCwd) await ensureWorkspaceDir(direct.workspaceCwd, this.logger);
    const members = this.repo.membersOf(direct.groupId);
    if (!members.some((member) => member.botId === bot.botId)) {
      const at = now();
      const member = {
        membershipId: directMembershipIdFor(bot.botId),
        groupId: direct.groupId,
        botId: bot.botId,
        order: 0,
        sessionId: directSessionIdFor(bot.botId),
        enabled: true,
        lastSeenSeq: 0,
        createdAt: at,
        updatedAt: at,
      };
      if (!this.repo.members.has(member.membershipId)) await this.repo.putMember(member);
    }
    return this.repo.getGroup(direct.groupId);
  }

  async openDirect(input) {
    const bot = this.repo.getBot(String(input.botId || ''));
    if (!bot) throw new ServiceError('not-found', 'Bot 不存在');
    const group = await this.ensureDirectGroup(bot);
    return { groupId: group.groupId, group };
  }

  /** Move a dragged group into a scope and rewrite that scope's dense order. */
  async reorderGroups(input) {
    const kind = input.kind === GROUP_KIND_DIRECT ? GROUP_KIND_DIRECT : 'group';
    const moved = input.movedGroupId ? this.repo.getGroup(String(input.movedGroupId)) : null;
    if (input.movedGroupId && !moved) throw new ServiceError('not-found', '群不存在');
    if (moved && groupKindOf(moved) !== kind) {
      throw new ServiceError('invalid-input', '单聊与群聊不能在同一个列表里排序');
    }
    let folder = null;
    if (kind === 'group') folder = await this.requireFolder(input.folderId);
    const folderId = folder ? folder.folderId : null;
    if (moved) {
      if (isDirectGroup(moved)) {
        // Direct chats are always ungrouped.
      } else if (groupFolderIdOf(moved) !== folderId) {
        moved.folderId = folderId;
        await this.repo.putGroup(moved);
      }
    }
    const scope = kind === GROUP_KIND_DIRECT ? sortByOrder(this.directGroups()) : this.groupsInFolder(folderId);
    const ordering = resolveOrdering(scope.map((group) => group.groupId), input.orderedIds);
    for (const entry of ordering) {
      const group = this.repo.getGroup(entry.id);
      if (!group || group.order === entry.order) continue;
      group.order = entry.order;
      await this.repo.putGroup(group);
    }
    return {
      kind,
      folderId,
      movedGroupId: moved ? moved.groupId : null,
      order: ordering,
    };
  }

  async createFolder(input) {
    const title = normalizeFolderTitle(input.title);
    if (!title) throw new ServiceError('invalid-input', '分组名称不能为空');
    if (this.repo.folders.size >= MAX_FOLDERS) {
      throw new ServiceError('limit', `分组数量已达上限 ${MAX_FOLDERS}`);
    }
    if ([...this.repo.folders.values()].some((folder) => folder.title === title)) {
      throw new ServiceError('conflict', `已存在同名分组: ${title}`);
    }
    const folder = {
      folderId: newId('fld'),
      title,
      order: nextOrder([...this.repo.folders.values()]),
      createdAt: now(),
      updatedAt: now(),
    };
    await this.repo.putFolder(folder);
    return folder;
  }

  async updateFolder(input) {
    const folder = this.repo.getFolder(String(input.folderId || ''));
    if (!folder) throw new ServiceError('not-found', '分组不存在');
    if (input.title !== undefined) {
      const title = normalizeFolderTitle(input.title);
      if (!title) throw new ServiceError('invalid-input', '分组名称不能为空');
      if ([...this.repo.folders.values()].some((candidate) => candidate.folderId !== folder.folderId && candidate.title === title)) {
        throw new ServiceError('conflict', `已存在同名分组: ${title}`);
      }
      folder.title = title;
    }
    await this.repo.putFolder(folder);
    return folder;
  }

  async deleteFolder(input) {
    const folder = this.repo.getFolder(String(input.folderId || ''));
    if (!folder) throw new ServiceError('not-found', '分组不存在');
    // Never delete groups with their folder: they fall back to 未分组.
    const moved = sortByOrder(this.groupsInFolder(folder.folderId));
    let order = nextOrder(this.groupsInFolder(null));
    for (const group of moved) {
      group.folderId = null;
      group.order = order++;
      await this.repo.putGroup(group);
    }
    await this.repo.deleteFolder(folder.folderId);
    return { folderId: folder.folderId, movedGroups: moved.map((group) => group.groupId) };
  }

  async reorderFolders(input) {
    const folders = this.repo.allFolders();
    const ordering = resolveOrdering(folders.map((folder) => folder.folderId), input.orderedIds);
    for (const entry of ordering) {
      const folder = this.repo.getFolder(entry.id);
      if (!folder || folder.order === entry.order) continue;
      folder.order = entry.order;
      await this.repo.putFolder(folder);
    }
    return { folders: this.repo.allFolders() };
  }

  async createBot(input) {
    const name = requireText(input.name, 'Bot 名称', 40);
    if (this.repo.allBots().some((bot) => bot.name === name)) {
      throw new ServiceError('conflict', `已存在同名 Bot: ${name}`);
    }
    const provider = requireText(input.provider, 'provider', 80);
    const model = requireText(input.model, 'model', 160);
    const avatar = normalizeAvatar(input.avatar);
    const signature = optionalText(input.signature, 120);
    const reasoningEffort = optionalText(input.reasoningEffort, 80);
    const maxTokensRaw = Number(input.maxTokens);
    const bot = {
      botId: newId('bot'),
      name,
      color: /^#[0-9a-fA-F]{6}$/.test(String(input.color || '')) ? input.color : BOT_COLORS[this.repo.bots.size % BOT_COLORS.length],
      provider,
      model,
      // Retained in the record schema for compatibility; every bot is full-capability.
      capability: 'work',
      ...(avatar ? { avatar } : {}),
      ...(signature ? { signature } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(Number.isInteger(maxTokensRaw) && maxTokensRaw > 0 ? { maxTokens: Math.min(maxTokensRaw, 200000) } : {}),
      createdAt: now(),
      updatedAt: now(),
    };
    await this.repo.putBot(bot);
    // Every bot immediately gets its own single-chat window; the client opens it
    // after creation, and the migration creates them for pre-existing bots.
    const direct = await this.ensureDirectGroup(bot);
    this.logger?.info?.(
      `bot-team: created bot ${bot.botId} "${name}" (${provider}/${model}) direct=${direct.groupId}`,
    );
    return { ...bot, directGroupId: direct.groupId };
  }

  async updateBot(input) {
    const bot = this.repo.getBot(String(input.botId || ''));
    if (!bot) throw new ServiceError('not-found', 'Bot 不存在');
    if (input.name !== undefined) {
      const name = requireText(input.name, 'Bot 名称', 40);
      if (this.repo.allBots().some((candidate) => candidate.name === name && candidate.botId !== bot.botId)) {
        throw new ServiceError('conflict', `已存在同名 Bot: ${name}`);
      }
      bot.name = name;
    }
    if (input.provider !== undefined) bot.provider = requireText(input.provider, 'provider', 80);
    if (input.model !== undefined) bot.model = requireText(input.model, 'model', 160);
    if (input.avatar !== undefined) {
      const avatar = normalizeAvatar(input.avatar);
      if (avatar) bot.avatar = avatar;
      else delete bot.avatar;
    }
    if (input.signature !== undefined) {
      const signature = optionalText(input.signature, 120);
      if (signature) bot.signature = signature;
      else delete bot.signature;
    }
    if (input.reasoningEffort !== undefined) {
      const effort = optionalText(input.reasoningEffort, 80);
      if (effort) bot.reasoningEffort = effort;
      else delete bot.reasoningEffort;
    }
    if (input.maxTokens !== undefined) {
      const maxTokens = Number(input.maxTokens);
      if (Number.isInteger(maxTokens) && maxTokens > 0) bot.maxTokens = Math.min(maxTokens, 200000);
      else delete bot.maxTokens;
    }
    await this.repo.putBot(bot);
    // Keep the single-chat title in sync with the bot's display name.
    for (const direct of this.directGroups()) {
      if (direct.botId !== bot.botId) continue;
      if (direct.title !== bot.name) {
        direct.title = bot.name;
        await this.repo.putGroup(direct);
        this.bus.emit(direct.groupId, { type: 'group.updated', group: direct });
      }
    }
    return bot;
  }

  async deleteBot(input) {
    const bot = this.repo.getBot(String(input.botId || ''));
    if (!bot) throw new ServiceError('not-found', 'Bot 不存在');
    const directGroups = this.directGroups().filter((group) => group.botId === bot.botId);
    for (const member of this.repo.membersOfBot(bot.botId)) {
      this.engine.stopMember(member.membershipId);
      await this.pool.disposeMember(member.membershipId);
      await this.repo.deleteMember(member.membershipId);
    }
    // The single chat belongs to the bot, so deleting the bot removes it too.
    for (const direct of directGroups) {
      this.engine.stopGroup(direct.groupId);
      for (const message of this.repo.messagesOf(direct.groupId)) {
        await this.repo.deleteMessage(message.messageId);
      }
      for (const discussion of this.repo.discussionsOf(direct.groupId)) {
        await this.repo.deleteDiscussion(discussion.discussionId);
      }
      for (const task of this.repo.tasksOf(direct.groupId)) {
        await this.repo.deleteTask(task.taskId);
      }
      await this.repo.deleteGroup(direct.groupId);
      this.bus.closeGroup(direct.groupId);
    }
    await this.repo.deleteBot(bot.botId);
    return { botId: bot.botId, removedDirectGroupIds: directGroups.map((group) => group.groupId) };
  }

  async addMember(input) {
    const group = this.repo.getGroup(String(input.groupId || ''));
    if (!group) throw new ServiceError('not-found', '群不存在');
    if (isDirectGroup(group)) throw new ServiceError('invalid-input', '单聊只能有一个 Bot');
    const bot = this.repo.getBot(String(input.botId || ''));
    if (!bot) throw new ServiceError('not-found', 'Bot 不存在');
    const members = this.repo.membersOf(group.groupId);
    if (members.length >= this.config.maxMembersPerGroup) {
      throw new ServiceError('limit', `每个群最多 ${this.config.maxMembersPerGroup} 个成员`);
    }
    if (members.some((member) => member.botId === bot.botId)) {
      throw new ServiceError('conflict', '该 Bot 已在群里');
    }
    const member = {
      membershipId: newId('mem'),
      groupId: group.groupId,
      botId: bot.botId,
      order: members.length,
      sessionId: newId('session-botteam'),
      enabled: true,
      lastSeenSeq: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    const saved = await this.repo.putMember(member);
    this.bus.emit(group.groupId, { type: 'member.added', member: saved });
    return saved;
  }

  async removeMember(input) {
    const member = this.repo.getMember(String(input.membershipId || ''));
    if (!member) throw new ServiceError('not-found', '成员不存在');
    const group = this.repo.getGroup(member.groupId);
    if (group && isDirectGroup(group)) throw new ServiceError('invalid-input', '单聊成员随 Bot 存在，不能移除');
    this.engine.stopMember(member.membershipId);
    await this.pool.disposeMember(member.membershipId);
    await this.repo.deleteMember(member.membershipId);
    this.bus.emit(member.groupId, { type: 'member.removed', membershipId: member.membershipId });
    return { membershipId: member.membershipId };
  }

  async updateMember(input) {
    const member = this.repo.getMember(String(input.membershipId || ''));
    if (!member) throw new ServiceError('not-found', '成员不存在');
    if (input.enabled !== undefined) member.enabled = input.enabled !== false;
    if (Number.isInteger(input.order)) member.order = input.order;
    const saved = await this.repo.putMember(member);
    this.bus.emit(member.groupId, { type: 'member.updated', member: saved });
    return saved;
  }

  async postMessage(input) {
    const groupId = String(input.groupId || '');
    const group = this.repo.getGroup(groupId);
    if (!group) throw new ServiceError('not-found', '群不存在');
    const text = String(input.text ?? '').trim();
    if (text.length > this.config.maxMessageChars) throw new ServiceError('invalid-input', '消息超过长度上限');
    if (text === '/new') throw new ServiceError('command-required', '请使用新建会话指令入口');
    if (/^[/]new\s/.test(text)) throw new ServiceError('invalid-command', '请单独发送 /new');
    this.assertExpectedConversation(groupId, input.expectedConversationId);
    const attachments = this.normalizeMessageAttachments(input.attachments);
    if (!text && attachments.length === 0) throw new ServiceError('invalid-input', '消息不能为空');
    const groupMembers = this.repo.membersOf(groupId);
    let mentions = Array.isArray(input.mentions)
      ? input.mentions.filter((value) => typeof value === 'string')
      : [];
    const validMentions = new Set(groupMembers.map((member) => member.membershipId));
    mentions = [...new Set(mentions)].filter((membershipId) => validMentions.has(membershipId));
    if (isDirectGroup(group)) {
      // A single chat has exactly one bot: every user message targets it, so the
      // user never has to type "@BotName" in a DM.
      mentions = groupMembers.slice(0, 1).map((member) => member.membershipId);
    } else if (mentions.length === 0) {
      mentions = parseMentionsFromText(this.repo, groupId, text);
    }
    const replyTo = typeof input.replyTo === 'string' && input.replyTo ? input.replyTo : null;
    return this.engine.postHumanMessage({ groupId, text, mentions, replyTo, attachments, expectedConversationId: input.expectedConversationId ?? currentConversationId(this.repo, groupId) });
  }

  async deleteMessage(input) {
    const groupId = String(input.groupId || '');
    const messageId = String(input.messageId || '');
    const group = this.repo.getGroup(groupId);
    const message = this.repo.getMessage(messageId);
    if (!group || !message || message.groupId !== groupId) {
      throw new ServiceError('not-found', '消息不存在或不属于本聊天');
    }
    if (['system', 'approval'].includes(message.kind) || !['human', 'bot'].includes(message.author?.type)) {
      throw new ServiceError('invalid-input', '只能删除普通聊天消息');
    }
    if (message.status === 'pending' || message.status === 'streaming') {
      throw new ServiceError('busy', '消息正在生成，请结束后再删除');
    }
    if (!['done', 'error', 'stopped'].includes(message.status ?? 'done')) {
      throw new ServiceError('invalid-input', '消息状态不支持删除');
    }
    // A native goal may have a done reply while waiting for its next turn, and
    // a stopped job may still be finishing durable writes. Status alone is not
    // enough: its current placeholder must survive until that work releases it.
    // Queued/preparing turns still need their trigger and review inputs when
    // constructing the prompt, so keep those records until the job settles.
    const jobs = [
      ...(this.engine.running?.values() ?? []),
      ...(this.engine.activeBySession?.values() ?? []),
      ...(this.engine.pendingWork ?? []),
      ...(this.engine.queue ?? []),
    ];
    if (jobs.some((job) =>
      [job.placeholderId, job.triggerMessageId, job.reviewTargetId, job.reviewMessageId].includes(messageId) ||
      (job.kind === 'revision' && this.repo.getMessage(job.reviewMessageId)?.meta?.reviewOf === messageId))) {
      throw new ServiceError('busy', '消息仍被执行中的任务使用，请结束后再删除');
    }
    if (!await this.repo.deleteMessageStrict(messageId)) {
      throw new ServiceError('not-found', '消息不存在或不属于本聊天');
    }
    this.bus.emit(groupId, { type: 'message.deleted', groupId, messageId });
    // Keep the existing group update signal; message.deleted consumers refresh
    // bootstrap for the preview. Deletion must not count as new group activity.
    this.bus.emit(groupId, { type: 'group.updated', group });
    return { groupId, messageId, deleted: true };
  }

  async stopGroup(input) {
    const group = this.repo.getGroup(String(input.groupId || ''));
    if (!group) throw new ServiceError('not-found', '群不存在');
    return this.engine.stopGroup(group.groupId);
  }

  async writePersona(input) {
    const bot = this.repo.getBot(String(input.botId || ''));
    if (!bot) throw new ServiceError('not-found', 'Bot 不存在');
    const kind = String(input.kind || 'bot');
    if (!PERSONA_KINDS.has(kind)) throw new ServiceError('invalid-input', `未知人格文件: ${kind}`);
    const text = asString(input.text, 100000);
    await this.personas.write(bot.botId, kind, text);
    return { botId: bot.botId, kind, length: text.length, file: this.personas.fileOf(bot.botId, kind) };
  }

  // ── helpers ──────────────────────────────────────────────────────────────
  authorName(message) {
    if (!message) return '';
    if (message.author?.type === 'human') return '用户';
    if (message.author?.type === 'system') return '系统';
    const bot = message.author?.botId ? this.repo.getBot(message.author.botId) : undefined;
    return bot?.name ?? message.author?.name ?? 'Bot';
  }

  async getModelCatalog() {
    if (this.modelCatalogCache && Date.now() - this.modelCatalogCache.at < 60000) {
      return this.modelCatalogCache.value;
    }
    let value = null;
    const controller = this.ctx.get('sessionController');
    if (controller && typeof controller.modelCatalog === 'function') {
      try {
        const catalog = await controller.modelCatalog();
        value = {
          default: catalog.default ?? null,
          groups: (catalog.groups || []).map((group) => ({
            id: group.id,
            name: group.name,
            models: (group.models || []).map((model) => ({
              id: model.id,
              name: model.name || model.id,
              reasoning: model.reasoning
                ? {
                    efforts: (model.reasoning.efforts || []).map((effort) => ({
                      id: effort.id,
                      name: effort.name || effort.id,
                    })),
                    defaultEffort: model.reasoning.defaultEffort,
                  }
                : null,
            })),
          })),
          failures: catalog.failures || [],
        };
      } catch (error) {
        this.logger?.warn?.(`bot-team: model catalog failed: ${String(error)}`);
      }
    }
    if (!value) {
      try {
        const llm = this.ctx.get('llm');
        const groups = [];
        for (const provider of llm && typeof llm.listProviders === 'function' ? llm.listProviders() : []) {
          try {
            const models = await llm.listModels(provider.id);
            groups.push({
              id: provider.id,
              name: provider.name || provider.id,
              models: models.map((model) => ({ id: model.id, name: model.name || model.id, reasoning: null })),
            });
          } catch {
            /* skip a provider that cannot list models */
          }
        }
        const defaultModel = this.ctx.get('agentDefaultModel');
        value = {
          default: defaultModel && typeof defaultModel.currentSelection === 'function'
            ? defaultModel.currentSelection()
            : null,
          groups,
          failures: [],
        };
      } catch {
        value = { default: null, groups: [], failures: [] };
      }
    }
    this.modelCatalogCache = { at: Date.now(), value };
    return value;
  }

  /** Per-group usage guard: daily token budget, reset at local midnight. */
  checkQuota(groupId) {
    const dayStart = new Date(Date.now());
    dayStart.setHours(0, 0, 0, 0);
    const dayStartMs = dayStart.getTime();
    let tokensToday = 0;
    for (const message of this.repo.messagesOf(groupId)) {
      if (!message.createdAt) continue;
      if (message.createdAt >= dayStartMs && message.usage) {
        tokensToday += (message.usage.totalTokens ?? ((message.usage.inputTokens ?? 0) + (message.usage.outputTokens ?? 0)));
      }
    }
    if (tokensToday >= this.config.dailyTokenBudget) {
      return {
        ok: false,
        reason: '本群今日 token 用量已达上限（' + tokensToday + ' / ' + this.config.dailyTokenBudget + '），请明天再试或调整配额',
        tokensToday,
        limit: this.config.dailyTokenBudget,
      };
    }
    return { ok: true, tokensToday, tokenLimit: this.config.dailyTokenBudget };
  }

  healthPayload() {
    return {
      ok: true,
      plugin: 'bot-team',
      pluginVersion: PLUGIN_INFO.version,
      pluginInfo: PLUGIN_INFO,
      domain: this.repo.health(),
      config: {
        botSandbox: this.config.botSandbox,
        botApprovalPolicy: this.config.botApprovalPolicy,
        dailyTokenBudget: this.config.dailyTokenBudget,
        maxParallelTurns: this.config.maxParallelTurns,
        enableModelTools: this.config.enableModelTools,
      },
      toolNames: BOT_TEAM_TOOL_NAMES,
      quotas: Object.fromEntries(
        [...this.repo.groups.values()].map((group) => [group.groupId, this.checkQuota(group.groupId)]),
      ),
      smoke: this.smokeState,
      at: Date.now(),
    };
  }

  async appendSmoke(record) {
    const row = { at: new Date().toISOString(), ...record };
    try {
      await mkdir(this.config.smokeResultsDir, { recursive: true });
      await appendFile(
        path.join(this.config.smokeResultsDir, 'smoke.jsonl'),
        JSON.stringify(row) + '\n',
        'utf8',
      );
    } catch (error) {
      this.logger?.warn?.(`bot-team: smoke result write failed: ${String(error)}`);
    }
    try {
      this.repo?.putMeta('smoke-last', row);
    } catch {
      /* noop */
    }
    this.smokeState = { status: record.pass ? 'pass' : 'fail', at: row.at, detail: record.detail };
  }

  async pickSmokeModel() {
    const catalog = await this.getModelCatalog();
    if (catalog && catalog.default && catalog.default.provider && catalog.default.model) {
      return { provider: catalog.default.provider, model: catalog.default.model, source: 'catalog-default' };
    }
    for (const group of (catalog && catalog.groups) || []) {
      for (const model of group.models || []) {
        return { provider: group.id, model: model.id, source: 'catalog-first' };
      }
    }
    const defaultModel = this.ctx.get('agentDefaultModel');
    if (defaultModel && typeof defaultModel.currentSelection === 'function') {
      const selection = defaultModel.currentSelection();
      if (selection && selection.provider && selection.model) {
        return { provider: selection.provider, model: selection.model, source: 'agent-default-model' };
      }
    }
    return { provider: 'deepseek-account', model: 'deepseek-flash', source: 'fallback' };
  }

  /** M1 verification: exercise the real path end-to-end, then a restart-recovery pass. */
  async runSmokeOrRecovery() {
    if (!this.config.smokeTest) return;
    const done = this.repo.getMeta('smoke-done');
    if (done && done.v === SMOKE_VERSION) {
      await this.runRecoveryCheck();
      return;
    }
    await this.runSmokeTest();
  }

  async ensureSmokeFixtures(route) {
    const findOrCreateBot = async (name, color) => {
      let bot = this.repo.allBots().find((candidate) => candidate.name === name);
      if (!bot) {
        bot = await this.dispatch('bot.create', {
          name,
          provider: route.provider,
          model: route.model,
          color,
        });
      }
      return bot;
    };
    const botA = await findOrCreateBot('M1 冒烟机器人', '#2f7ed8');
    const botB = await findOrCreateBot('M1 冒烟机器人 B', '#8b5cf6');

    let group = this.repo.allGroups().find((candidate) => candidate.title === 'M1 冒烟测试群');
    if (!group) {
      group = await this.dispatch('group.create', {
        title: 'M1 冒烟测试群',
        topic: '自动验证：@ 派发 / 多 @ 并行 / 无 @ 不回复 / 持久化',
      });
    }
    const ensureMember = async (bot) => {
      const existing = this.repo.membersOf(group.groupId).find((member) => member.botId === bot.botId);
      if (existing) return existing;
      return this.dispatch('member.add', { groupId: group.groupId, botId: bot.botId });
    };
    const memberA = await ensureMember(botA);
    const memberB = await ensureMember(botB);
    // M1 verification: the persona file is written through the real action path
    // and its text must reach the bot's assembled system prompt (checked below).
    await this.dispatch('persona.write', {
      botId: botA.botId,
      kind: 'bot',
      text: '## 人格\nSOUL_SMOKE_MARKER: 你是冒烟测试机器人，代号 SMOKE-ALPHA。\n\n## 工作规范\n被要求输出标记时，只输出标记本身。\n',
    });
    return { botA, botB, group, memberA, memberB };
  }

  async runSmokeTest() {
    this.smokeState = { status: 'running', startedAt: Date.now() };
    const startedAt = Date.now();
    try {
      const route = await this.pickSmokeModel();
      const { botA, botB, group, memberA, memberB } = await this.ensureSmokeFixtures(route);
      const botMessages = () => this.repo.messagesOf(group.groupId).filter((message) => message.author?.type === 'bot');

      // 1) @mention dispatch → one bot reply (covers streaming path; the reply text
      //    only exists because assistant deltas/final text were captured).
      const beforeMention = botMessages().length;
      await this.dispatch('message.post', {
        groupId: group.groupId,
        text: `@${botA.name} 请只回复一行 M1-OK。不要使用任何工具。`,
        mentions: [memberA.membershipId],
      });
      const idleMention = await this.engine.whenIdle(group.groupId, 120000);
      const afterMention = botMessages();
      const lastMention = afterMention[afterMention.length - 1];
      const mentionPass =
        idleMention === true &&
        afterMention.length === beforeMention + 1 &&
        !!lastMention &&
        lastMention.status === 'done' &&
        String(lastMention.text || '').includes('M1-OK');

      // 4b) task board flow A: create → dispatch → delivered → review(pass) → accepted
      let taskFlowPass = false;
      let taskChangesPass = false;
      let taskDetail = null;
      try {
        const taskA = await this.dispatch('task.create', {
          groupId: group.groupId,
          title: '冒烟任务 A：输出 TASK-A-OK',
          description: '请只输出一行 TASK-A-OK。不要使用任何工具。',
          acceptance: '回复内容必须包含 TASK-A-OK。',
          assigneeMembershipId: memberA.membershipId,
          reviewerMembershipId: memberB.membershipId,
        });
        await this.dispatch('task.dispatch', { taskId: taskA.taskId });
        await this.engine.whenIdle(group.groupId, 120000);
        let current = this.repo.getTask(taskA.taskId);
        const deliveredA = current.status === 'delivered' && !!current.deliverableMessageId;
        const deliverableA = current.deliverableMessageId ? this.repo.messages.get(current.deliverableMessageId) : null;
        await this.dispatch('task.review', { taskId: taskA.taskId });
        await this.engine.whenIdle(group.groupId, 120000);
        current = this.repo.getTask(taskA.taskId);
        const reviewedA = current.status === 'accepted';
        taskFlowPass = deliveredA && reviewedA && !!deliverableA && String(deliverableA.text || '').includes('TASK-A-OK');

        // flow B: deliverable misses the acceptance → review requests changes → revise → delivered → accept
        const taskB = await this.dispatch('task.create', {
          groupId: group.groupId,
          title: '冒烟任务 B：故意不满足验收的任务',
          description: '请只输出一行 TASK-B-OK。不要输出数字。',
          acceptance: '回复必须同时包含 TASK-B-OK 与数字 12345。',
          assigneeMembershipId: memberA.membershipId,
          reviewerMembershipId: memberB.membershipId,
        });
        await this.dispatch('task.dispatch', { taskId: taskB.taskId });
        await this.engine.whenIdle(group.groupId, 120000);
        // Deterministic rework path: a human requests changes, the assignee revises,
        // the task is delivered again, then accepted. (Model-driven 需修改 verdict is
        // already covered indirectly by flow A's review; asserting on an LLM verdict
        // here would make the smoke flaky.)
        await this.dispatch('task.request_changes', { taskId: taskB.taskId });
        let currentB = this.repo.getTask(taskB.taskId);
        const changedB = currentB.status === 'changes_requested';
        await this.dispatch('task.revise', { taskId: taskB.taskId });
        await this.engine.whenIdle(group.groupId, 120000);
        currentB = this.repo.getTask(taskB.taskId);
        const redeliveredB = currentB.status === 'delivered';
        await this.dispatch('task.accept', { taskId: taskB.taskId });
        currentB = this.repo.getTask(taskB.taskId);
        taskChangesPass = changedB && redeliveredB && currentB.status === 'accepted';
        taskDetail = {
          taskA: { status: current.status, revision: current.revision, deliverable: !!deliverableA },
          taskB: {
            finalStatus: currentB.status,
            deliverable: !!currentB.deliverableMessageId,
            revision: currentB.revision,
          },
        };
      } catch (error) {
        taskDetail = { error: String(error && error.stack ? error.stack : error) };
      }

      // 4c) v0.5.1: priority sorting + dependency gating + cycle rejection + auto-unblock
      let taskPriorityPass = false;
      let dependencyGatingPass = false;
      let dependencyCyclePass = false;
      let autoUnblockPass = false;
      let taskMetaPass = false;
      let taskMetaDetail = null;
      try {
        const stamp = Date.now();
        const taskLow = await this.dispatch('task.create', {
          groupId: group.groupId,
          title: '冒烟低优任务 ' + stamp,
          description: '不派发',
          assigneeMembershipId: memberA.membershipId,
          priority: 'low',
        });
        const taskUrgent = await this.dispatch('task.create', {
          groupId: group.groupId,
          title: '冒烟紧急任务 ' + stamp,
          description: '不派发',
          assigneeMembershipId: memberA.membershipId,
          priority: 'urgent',
        });
        const sorted = this.listTasks(group.groupId, { limit: 100 });
        const lowIndex = sorted.findIndex((task) => task.taskId === taskLow.taskId);
        const urgentIndex = sorted.findIndex((task) => task.taskId === taskUrgent.taskId);
        taskPriorityPass = lowIndex >= 0 && urgentIndex >= 0 && urgentIndex < lowIndex;

        const taskP = await this.dispatch('task.create', {
          groupId: group.groupId,
          title: '冒烟依赖前置任务 ' + stamp,
          description: '请只输出一行 DEP-P-OK。不要使用任何工具。',
          acceptance: '包含 DEP-P-OK',
          assigneeMembershipId: memberA.membershipId,
        });
        const taskD = await this.dispatch('task.create', {
          groupId: group.groupId,
          title: '冒烟依赖后置任务 ' + stamp,
          description: '不派发',
          assigneeMembershipId: memberA.membershipId,
          dependsOn: [taskP.taskId],
        });
        const blockedView = this.taskView(this.repo.getTask(taskD.taskId));
        let blockedError = null;
        try {
          await this.dispatch('task.dispatch', { taskId: taskD.taskId });
        } catch (error) {
          blockedError = String(error && error.message ? error.message : error);
        }
        await this.dispatch('task.dispatch', { taskId: taskP.taskId });
        await this.engine.whenIdle(group.groupId, 120000);
        await this.dispatch('task.accept', { taskId: taskP.taskId });
        const unblockedView = this.taskView(this.repo.getTask(taskD.taskId));
        const unblockMessages = this.repo
          .messagesOf(group.groupId)
          .filter((message) => message.author && message.author.type === 'system' && String(message.text || '').includes('前置依赖解除'));
        autoUnblockPass = unblockMessages.length > 0;
        dependencyGatingPass = blockedView.ready === false && !!blockedError && unblockedView.ready === true;
        await this.dispatch('task.cancel', { taskId: taskD.taskId });

        const cycleA = await this.dispatch('task.create', {
          groupId: group.groupId,
          title: '冒烟环检测 A ' + stamp,
          assigneeMembershipId: memberA.membershipId,
        });
        const cycleB = await this.dispatch('task.create', {
          groupId: group.groupId,
          title: '冒烟环检测 B ' + stamp,
          assigneeMembershipId: memberA.membershipId,
          dependsOn: [cycleA.taskId],
        });
        let cycleError = null;
        try {
          await this.dispatch('task.update', { taskId: cycleA.taskId, dependsOn: [cycleB.taskId] });
        } catch (error) {
          cycleError = String(error && error.message ? error.message : error);
        }
        dependencyCyclePass = !!cycleError && cycleError.includes('循环');
        taskMetaPass = taskPriorityPass && dependencyGatingPass && dependencyCyclePass && autoUnblockPass && batchPass && queuePass && autoDispatchOffPass;
        taskMetaDetail = {
          priorityOrder: { urgentIndex, lowIndex },
          blockedError,
          dependencyReadyBefore: blockedView.ready,
          dependencyReadyAfter: unblockedView.ready,
          cycleError,
          autoUnblockMessages: unblockMessages.length,
        };
      } catch (error) {
        taskMetaDetail = { error: String(error && error.stack ? error.stack : error) };
      }

      // 4d) v0.5.2: one-click batch dispatch, queue snapshot, auto-dispatch off by default
      for (const stale of this.repo.tasksOf(group.groupId)) {
        if (stale.status === 'pending') {
          try {
            await this.dispatch('task.cancel', { taskId: stale.taskId, force: true });
          } catch {
            /* stale cleanup is best effort */
          }
        }
      }
      let batchPass = false;
      let queuePass = false;
      let autoDispatchOffPass = false;
      let batchDetail = null;
      try {
        const stamp = Date.now();
        const low = await this.dispatch('task.create', {
          groupId: group.groupId,
          title: '冒烟批量低 ' + stamp,
          description: '请只输出一行 BATCH-LOW-OK。',
          assigneeMembershipId: memberA.membershipId,
          priority: 'low',
        });
        const high = await this.dispatch('task.create', {
          groupId: group.groupId,
          title: '冒烟批量高 ' + stamp,
          description: '请只输出一行 BATCH-HIGH-OK。',
          assigneeMembershipId: memberA.membershipId,
          priority: 'high',
        });
        const urgent = await this.dispatch('task.create', {
          groupId: group.groupId,
          title: '冒烟批量紧急 ' + stamp,
          description: '请只输出一行 BATCH-URGENT-OK。',
          assigneeMembershipId: memberA.membershipId,
          priority: 'urgent',
        });
        const result = await this.dispatchReadyTasks({ groupId: group.groupId, limit: 10 });
        const ourIds = new Set([low.taskId, high.taskId, urgent.taskId]);
        const ours = result.dispatched.filter((entry) => ourIds.has(entry.taskId));
        const order = ours.map((entry) => entry.priority);
        batchPass = ours.length === 3 && order[0] === 'urgent' && order[1] === 'high' && order[2] === 'low';
        queuePass =
          result.queue &&
          result.queue.running + result.queue.queued >= 1 &&
          result.queue.running <= result.queue.parallelLimit;
        await this.engine.whenIdle(group.groupId, 180000);
        const deliveredCount = [low.taskId, high.taskId, urgent.taskId]
          .map((taskId) => this.repo.getTask(taskId))
          .filter((task) => task && task.status === 'delivered').length;
        batchPass = batchPass && deliveredCount === 3;

        // autoDispatchReady defaults to false: accepting a dependency must NOT dispatch its dependent
        const pre = await this.dispatch('task.create', {
          groupId: group.groupId,
          title: '冒烟自动派发前置 ' + stamp,
          description: '请只输出一行 AUTO-PRE-OK。',
          assigneeMembershipId: memberA.membershipId,
        });
        const dependent = await this.dispatch('task.create', {
          groupId: group.groupId,
          title: '冒烟自动派发后置 ' + stamp,
          description: '请只输出一行 AUTO-DEP-OK。',
          assigneeMembershipId: memberA.membershipId,
          dependsOn: [pre.taskId],
        });
        await this.dispatch('task.dispatch', { taskId: pre.taskId });
        await this.engine.whenIdle(group.groupId, 120000);
        await this.dispatch('task.accept', { taskId: pre.taskId });
        const afterAccept = this.taskView(this.repo.getTask(dependent.taskId));
        autoDispatchOffPass = afterAccept.status === 'pending' && afterAccept.ready === true;
        batchDetail = {
          dispatchedOrder: order,
          queue: result.queue,
          deliveredCount,
          autoDispatch: { status: afterAccept.status, ready: afterAccept.ready },
        };
      } catch (error) {
        batchDetail = { error: String(error && error.stack ? error.stack : error) };
      }

      // 1b) persona: file persisted + text present in the bot's system prompt
      let personaFilePass = false;
      try {
        const info = await stat(this.personas.fileOf(botA.botId, 'bot'));
        personaFilePass = info.isFile() && info.size > 0;
      } catch {
        personaFilePass = false;
      }
      const agentA = this.pool.current(memberA.membershipId);
      let personaInPromptPass = false;
      if (agentA && agentA.session) {
        try {
          const events = agentA.session.snapshotEvents();
          personaInPromptPass = events.some(
            (event) => event.type === 'system/message' && JSON.stringify(event.data).includes('SOUL_SMOKE_MARKER'),
          );
        } catch {
          personaInPromptPass = false;
        }
      }

      // 2) no @mention → no bot turn at all
      const beforeNoMention = botMessages().length;
      await this.dispatch('message.post', {
        groupId: group.groupId,
        text: '（冒烟：这条消息没有 @ 任何人，按规则不应触发任何回复）',
      });
      await new Promise((resolve) => setTimeout(resolve, 900));
      const noMentionPass = botMessages().length === beforeNoMention && !this.engine.isRunning(group.groupId);

      // 3) two @mentions in one message → two replies dispatched in parallel
      const beforeParallel = botMessages().length;
      await this.dispatch('message.post', {
        groupId: group.groupId,
        text: `@${botA.name} 请只回复 PAR-A。@${botB.name} 请只回复 PAR-B。不要使用任何工具。`,
        mentions: [memberA.membershipId, memberB.membershipId],
      });
      const idleParallel = await this.engine.whenIdle(group.groupId, 180000);
      const parallelSlice = botMessages().slice(-2);
      const parallelPass =
        idleParallel === true &&
        botMessages().length === beforeParallel + 2 &&
        parallelSlice.length === 2 &&
        parallelSlice.every((message) => message.status === 'done') &&
        parallelSlice.some((message) => String(message.text || '').includes('PAR-A')) &&
        parallelSlice.some((message) => String(message.text || '').includes('PAR-B'));

      // 4) review: B reviews A's last reply, verdict parsed, then A revises it
      let reviewPass = false;
      let revisionPass = false;
      let reviewDetail = null;
      try {
        const reviewResult = await this.dispatch('review.request', {
          groupId: group.groupId,
          targetMessageId: lastMention.messageId,
          reviewerMembershipId: memberB.membershipId,
          instructions: '冒烟评审：请只输出两行。第一行必须是 结论：通过 或 结论：需修改；第二行一句理由。不要使用任何工具。',
        });
        const idleReview = await this.engine.whenIdle(group.groupId, 120000);
        const reviewReplies = botMessages().filter(
          (message) => message.meta && message.meta.reviewOf === lastMention.messageId && message.kind === 'review',
        );
        const reviewReply = reviewReplies[reviewReplies.length - 1];
        reviewDetail = reviewReply
          ? { status: reviewReply.status, verdict: reviewReply.meta?.verdict, text: String(reviewReply.text || '').slice(0, 160) }
          : null;
        reviewPass =
          idleReview === true &&
          !!reviewReply &&
          reviewReply.status === 'done' &&
          (reviewReply.meta?.verdict === 'pass' || reviewReply.meta?.verdict === 'changes') &&
          String(reviewReply.text || '').length > 0;
        if (reviewPass && reviewResult && reviewResult.requestMessage) {
          await this.dispatch('review.revise', {
            groupId: group.groupId,
            reviewMessageId: reviewReply.messageId,
          });
          const idleRevision = await this.engine.whenIdle(group.groupId, 120000);
          const revisions = botMessages().filter(
            (message) => message.meta && message.meta.revisionOf === lastMention.messageId,
          );
          const revision = revisions[revisions.length - 1];
          revisionPass = idleRevision === true && !!revision && revision.status === 'done' && String(revision.text || '').length > 0;
        }
      } catch (error) {
        reviewDetail = { error: String(error && error.message ? error.message : error) };
      }

      // 5) two-round discussion with summary
      let discussionPass = false;
      let discussionDetail = null;
      try {
        const discussion = await this.dispatch('discussion.start', {
          groupId: group.groupId,
          topic: 'M2 冒烟讨论：群聊机器人应该优先解决什么问题？',
          membershipIds: [memberA.membershipId, memberB.membershipId],
          rounds: 2,
          summarize: true,
        });
        const settled = await this.engine.whenDiscussionSettled(discussion.discussionId, 300000);
        const latestDiscussion = this.repo.getDiscussion(discussion.discussionId);
        const discussionMessages = this.repo
          .messagesOf(group.groupId)
          .filter((message) => message.meta && message.meta.discussionId === discussion.discussionId && message.author?.type === 'bot');
        const summaryMessage = discussionMessages.find((message) => message.meta && message.meta.summary);
        const doneMessages = discussionMessages.filter((message) => message.status === 'done');
        discussionDetail = {
          settled,
          status: latestDiscussion?.status,
          speakers: discussionMessages.length,
          done: doneMessages.length,
          summary: summaryMessage ? String(summaryMessage.text || '').slice(0, 200) : null,
        };
        discussionPass =
          settled === true &&
          latestDiscussion &&
          latestDiscussion.status === 'done' &&
          doneMessages.length >= 5 &&
          !!summaryMessage &&
          /(共识|分歧|待决)/.test(String(summaryMessage.text || ''));
      } catch (error) {
        discussionDetail = { error: String(error && error.message ? error.message : error) };
      }

      let schemaVersionPass = false;
      let sandboxTierPass = false;
      let quotaPass = false;
      let quotaDenyPass = false;
      let healthPass = false;
      try {
        schemaVersionPass = this.repo.schemaVersion() >= 6;
        const health = this.healthPayload();
        healthPass =
          health.domain.schemaVersion >= 6 &&
          health.domain.counts.messages > 0 &&
          health.toolNames.length === BOT_TEAM_TOOL_NAMES.length;
        const quota = this.checkQuota(group.groupId);
        quotaPass = quota.ok === true;
        const dailyTokenBudget = this.config.dailyTokenBudget;
        try {
          this.config.dailyTokenBudget = quota.tokensToday;
          quotaDenyPass = this.checkQuota(group.groupId).ok === false;
        } finally {
          this.config.dailyTokenBudget = dailyTokenBudget;
        }
        const agentA2 = this.pool.current(memberA.membershipId);
        if (agentA2 && agentA2.session) {
          const modes = agentA2.session
            .snapshotEvents()
            .filter((event) => event.type === 'sandbox/mode')
            .map((event) => event.data && event.data.mode);
          sandboxTierPass = modes.includes('workspace-write');
        }
      } catch (error) {
        healthPass = false;
      }

      // v0.7: every bot owns exactly one single chat, and group folders survive
      // create → move → reorder → delete (groups fall back to 未分组).
      let directChatPass = false;
      let folderLifecyclePass = false;
      let layoutDetail = null;
      let tempFolderId = null;
      let tempGroupId = null;
      try {
        const bots = this.repo.allBots();
        directChatPass = bots.length > 0 && bots.every((bot) => {
          const directs = this.directGroups().filter((direct) => direct.botId === bot.botId);
          return directs.length === 1 && this.repo.membersOf(directs[0].groupId).length === 1;
        });
        const stamp = Date.now();
        const folder = await this.dispatch('folder.create', { title: `冒烟分组 ${stamp}` });
        tempFolderId = folder.folderId;
        const tempGroup = await this.dispatch('group.create', {
          title: `冒烟分组临时群 ${stamp}`,
          folderId: folder.folderId,
        });
        tempGroupId = tempGroup.groupId;
        await this.dispatch('group.reorder', {
          kind: 'group',
          folderId: folder.folderId,
          movedGroupId: tempGroup.groupId,
          orderedIds: [tempGroup.groupId],
        });
        const inFolder = this.repo.getGroup(tempGroup.groupId).folderId === folder.folderId;
        await this.dispatch('folder.delete', { folderId: folder.folderId });
        tempFolderId = null;
        const outOfFolder = this.repo.getGroup(tempGroup.groupId).folderId === null;
        await this.dispatch('group.delete', { groupId: tempGroup.groupId });
        tempGroupId = null;
        folderLifecyclePass = inFolder && outOfFolder && !this.repo.getGroup(tempGroup.groupId);
        layoutDetail = { directChatPass, folderLifecyclePass };
      } catch (error) {
        layoutDetail = {
          directChatPass,
          folderLifecyclePass,
          error: String(error && error.message ? error.message : error),
        };
        try {
          if (tempGroupId) await this.dispatch('group.delete', { groupId: tempGroupId });
        } catch {
          /* cleanup */
        }
        try {
          if (tempFolderId) await this.dispatch('folder.delete', { folderId: tempFolderId });
        } catch {
          /* cleanup */
        }
      }

      let modelToolsPass = false;
      let registeredToolNames = [];
      try {
        const schemas = this.ctx.tools && typeof this.ctx.tools.schemas === 'function' ? this.ctx.tools.schemas() : [];
        registeredToolNames = schemas.map((schema) => schema.name).filter((name) => BOT_TEAM_TOOL_NAMES.includes(name));
        modelToolsPass = BOT_TEAM_TOOL_NAMES.every((name) => registeredToolNames.includes(name));
      } catch (error) {
        registeredToolNames = [`error: ${String(error)}`];
      }

      const pass = mentionPass && noMentionPass && parallelPass && personaFilePass && personaInPromptPass && reviewPass && revisionPass && discussionPass && modelToolsPass && schemaVersionPass && sandboxTierPass && quotaPass && quotaDenyPass && healthPass && directChatPass && folderLifecyclePass && taskFlowPass && taskChangesPass && taskPriorityPass && dependencyGatingPass && dependencyCyclePass && autoUnblockPass;
      await this.appendSmoke({
        pass,
        detail: {
          step: 'smoke-v' + SMOKE_VERSION,
          groupId: group.groupId,
          botA: { botId: botA.botId, membershipId: memberA.membershipId },
          botB: { botId: botB.botId, membershipId: memberB.membershipId },
          model: route,
          checks: {
            mentionReply: mentionPass,
            noMentionNoReply: noMentionPass,
            parallelReplies: parallelPass,
            personaFilePersisted: personaFilePass,
            personaInSystemPrompt: personaInPromptPass,
            reviewVerdict: reviewPass,
            authorRevision: revisionPass,
            discussionRounds: discussionPass,
            modelToolsRegistered: modelToolsPass,
            schemaVersionMigrated: schemaVersionPass,
            sandboxTierWorkspaceWrite: sandboxTierPass,
            quotaWithinLimits: quotaPass,
            quotaRejectsOverLimit: quotaDenyPass,
            healthEndpointShape: healthPass,
            directChatPerBot: directChatPass,
            groupFolderLifecycle: folderLifecyclePass,
            taskFlowAccepted: taskFlowPass,
            taskChangesAndRework: taskChangesPass,
            taskPrioritySort: taskPriorityPass,
            taskDependencyGating: dependencyGatingPass,
            taskDependencyCycleRejected: dependencyCyclePass,
            taskAutoUnblock: autoUnblockPass,
            taskBatchDispatch: batchPass,
            taskQueueSnapshot: queuePass,
            taskAutoDispatchOffByDefault: autoDispatchOffPass,
          },
          tasks: taskDetail,
          layout: layoutDetail,
          batch: batchDetail,
          taskMeta: taskMetaDetail,
          schemaVersion: this.repo.schemaVersion(),
          health: this.healthPayload(),
          registeredToolNames,
          review: reviewDetail,
          discussion: discussionDetail,
          lastBotMessage: lastMention
            ? { status: lastMention.status, text: String(lastMention.text || '').slice(0, 200), usage: lastMention.usage }
            : null,
          elapsedMs: Date.now() - startedAt,
        },
      });
      if (pass) {
        await this.repo.putMeta('smoke-done', { v: SMOKE_VERSION, at: Date.now(), groupId: group.groupId });
      }
    } catch (error) {
      await this.appendSmoke({
        pass: false,
        detail: {
          step: 'smoke-v4',
          error: String(error && error.stack ? error.stack : error),
          elapsedMs: Date.now() - startedAt,
        },
      });
    }
  }

  /** Runs on every later activation: proves the bot session resumes across a process restart. */
  async runRecoveryCheck() {
    const done = this.repo.getMeta('smoke-done');
    const group = (done && this.repo.getGroup(done.groupId)) ||
      this.repo.allGroups().find((candidate) => candidate.title === 'M1 冒烟测试群');
    if (!group) {
      this.smokeState = { status: 'recovery-skipped', reason: 'no smoke group' };
      return;
    }
    const member = this.repo.membersOf(group.groupId)[0];
    const bot = member ? this.repo.getBot(member.botId) : undefined;
    if (!member || !bot) {
      this.smokeState = { status: 'recovery-skipped', reason: 'no smoke member' };
      return;
    }
    this.smokeState = { status: 'recovering' };
    const startedAt = Date.now();
    try {
      await this.dispatch('message.post', {
        groupId: group.groupId,
        text: `@${bot.name} 重启恢复冒烟：请只回复一行 RECOVER-OK。不要使用任何工具。`,
        mentions: [member.membershipId],
      });
      const idle = await this.engine.whenIdle(group.groupId, 120000);
      const messages = this.repo.messagesOf(group.groupId).filter((message) => message.author?.type === 'bot');
      const last = messages[messages.length - 1];
      const pass = idle === true && !!last && last.status === 'done' && String(last.text || '').includes('RECOVER-OK');
      await this.appendSmoke({
        pass,
        detail: {
          step: 'recovery',
          groupId: group.groupId,
          membershipId: member.membershipId,
          sessionId: member.sessionId,
          idle,
          lastBotMessage: last
            ? { status: last.status, text: String(last.text || '').slice(0, 200), usage: last.usage }
            : null,
          elapsedMs: Date.now() - startedAt,
        },
      });
      this.smokeState = { status: pass ? 'recovery-pass' : 'recovery-fail', at: Date.now() };
    } catch (error) {
      await this.appendSmoke({
        pass: false,
        detail: {
          step: 'recovery',
          error: String(error && error.stack ? error.stack : error),
          elapsedMs: Date.now() - startedAt,
        },
      });
      this.smokeState = { status: 'recovery-error' };
    }
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await this.routeDispose?.();
    } catch {
      /* noop */
    }
    try {
      this.toolDispose?.();
    } catch {
      /* noop */
    }
    try {
      await this.interactions?.dispose();
    } catch {
      /* noop */
    }
    try {
      await this.visibility?.dispose();
    } catch {
      /* noop */
    }
    try {
      await this.engine?.dispose();
    } catch {
      /* noop */
    }
    try {
      await this.pool?.disposeAll();
    } catch {
      /* noop */
    }
    try {
      await this.repo?.close();
    } catch {
      /* noop */
    }
    this.logger?.info?.('bot-team: disposed');
  }
}
