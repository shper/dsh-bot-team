/**
 * Turn engine: routes group messages to bot agents, keeps the shared timeline,
 * and streams assistant output to the UI.
 *
 * Per group:
 *  - a human message is persisted and broadcast first;
 *  - every mentioned member gets a placeholder bot message (stable seq, so the
 *    timeline order is the mention order) and a parallel turn (bounded by
 *    `maxParallelTurns`; a member never runs two turns at once);
 *  - token deltas stream as `message.delta`, step completion corrects with
 *    `message.replace`, and `turn/end` finalizes the placeholder;
 *  - `stop` cancels running turns and clears the queue; review/discussion
 *    orchestration will layer on top of this in M2 (they are inherently serial).
 */
import {
  buildDiscussionPrompt,
  buildTaskPrompt,
  buildTaskRevisionPrompt,
  buildRevisionPrompt,
  buildReviewPrompt,
  buildSummaryPrompt,
  buildTurnPrompt,
  parseReviewVerdict,
} from './prompt.js';
import { newId, now, withTimeout } from './util.js';
import { DiscussionRunner } from './discussion-runner.js';
import { isDiscussionActive } from './discussion-flow.js';
import { LastRequestMetrics } from './message-metrics.js';
import { currentConversationId, conversationFloor, conversationIdOf, isCurrentMemberSession } from './conversations.js';

const executionSeq = (value) => Number.isSafeInteger(value) && value >= 0;
const executionTurn = (value) => Number.isSafeInteger(value) && value > 0;
const executionEvent = (type) => typeof type === 'string';

export class Engine {
  constructor({ ctx, repo, pool, personas, bus, config, logger, quotaGuard, taskHook, workspaceGuard, assertAdmission, discussionGuard }) {
    this.ctx = ctx;
    this.repo = repo;
    this.pool = pool;
    this.personas = personas;
    this.bus = bus;
    this.config = config;
    this.logger = logger;
    this.quotaGuard = quotaGuard || (() => ({ ok: true }));
    this.taskHook = taskHook || (() => {});
    this.workspaceGuard = workspaceGuard || (() => {});
    this.assertAdmission = assertAdmission || this.workspaceGuard;
    this.pendingWork = new Set();
    this.discussionGuard = discussionGuard || (async () => {});
    this.discussionRunner = new DiscussionRunner(this);
    this.pumpBlocks = new Set();

    this.queue = [];
    this.running = new Map(); // membershipId -> job
    this.activeBySession = new Map(); // sessionId -> job
    this.waiters = new Map(); // groupId -> [{ resolve }]
    this.discussionWaiters = new Map(); // discussionId -> [{ resolve }]
    this.disposed = false;

    this.offSession = ctx.on('session/event', (session, event) => this.onSessionEvent(session, event), { global: true });
    this.offClaim = pool.attachClaimHandler?.((payload) => this.onInboxClaim(payload));
    if (ctx.get?.('goals')) this.offGoal = ctx.on('goal/activation-changed', ({ sessionId }) => {
      const job = this.activeBySession.get(sessionId);
      queueMicrotask(() => { this.checkNativeGoal(sessionId, job); this.discussionRunner.nativeSettled(sessionId); });
    }, { global: true });
  }

  admitConversation(groupId, expectedConversationId) {
    this.assertAdmission(groupId);
    const conversationId = currentConversationId(this.repo, groupId);
    const group = this.repo.getGroup(groupId);
    if (group?.activeConversationId) {
      if (conversationId !== group.activeConversationId) throw Object.assign(new Error('聊天会话归属不可用'), { code: 'conversation-corrupt' });
      conversationFloor(this.repo, groupId);
    }
    if (expectedConversationId !== undefined && expectedConversationId !== conversationId) {
      throw Object.assign(new Error('聊天已开始新会话，请重新选择当前会话'), {
        code: 'stale-conversation', details: { currentConversationId: conversationId },
      });
    }
    return conversationId;
  }

  isCurrentRecord(record, groupId = record?.groupId) {
    if (!record || record.groupId !== groupId) return false;
    try {
      const current = currentConversationId(this.repo, groupId);
      if (this.repo.getGroup(groupId)?.activeConversationId && !current) return false;
      return !current || conversationIdOf(this.repo, record) === current;
    } catch { return false; }
  }

  assertCurrentTarget(groupId, record) {
    if (!record || record.groupId !== groupId) {
      throw Object.assign(new Error('目标不存在或不属于本群'), { code: 'not-found' });
    }
    if (!this.isCurrentRecord(record, groupId)) {
      throw Object.assign(new Error('历史会话不能继续执行，请选取内容后在当前会话重新发送'), { code: 'historical-target' });
    }
    return record;
  }

  isCurrentJob(job) {
    if (!job || !this.isCurrentRecord(job)) return false;
    const member = this.repo.getMember(job.membershipId);
    if (!member || member.groupId !== job.groupId) return false;
    // Legacy adapters without a conversation pointer may expose a different
    // actual Agent id. Once migrated, session ownership is mandatory.
    if (this.repo.getGroup(job.groupId)?.activeConversationId && job.sessionId) {
      return isCurrentMemberSession(this.repo, member, job.sessionId);
    }
    return true;
  }

  assertJobCurrent(job) {
    if (!this.isCurrentJob(job)) {
      throw Object.assign(new Error('本次执行所属会话已结束'), { code: 'stale-conversation' });
    }
  }

  assertJobTargets(job) {
    // The pre-migration test adapters have no task/conversation repositories.
    if (!this.repo.getGroup(job.groupId)?.activeConversationId) return;
    const messageIds = [job.triggerMessageId, job.reviewTargetId, job.reviewMessageId,
      job.meta?.retryOf, job.meta?.reviewOf, job.meta?.revisionOf];
    if (job.meta?.taskId) {
      const task = this.assertCurrentTarget(job.groupId, this.repo.getTask?.(job.meta.taskId));
      messageIds.push(task.deliverableMessageId, task.reviewReplyMessageId);
      for (const dependencyId of task.dependencies || task.dependsOn || []) {
        this.assertCurrentTarget(job.groupId, this.repo.getTask?.(dependencyId));
      }
    }
    if (job.discussionId) this.assertCurrentTarget(job.groupId, this.repo.getDiscussion?.(job.discussionId));
    for (const id of messageIds.filter(Boolean)) this.assertCurrentTarget(job.groupId, this.repo.getMessage(id));
    const review = job.reviewMessageId ? this.repo.getMessage(job.reviewMessageId) : null;
    if (review?.meta?.reviewOf) this.assertCurrentTarget(job.groupId, this.repo.getMessage(review.meta.reviewOf));
  }

  contextFor(job, member, rebuild = false) {
    this.assertJobCurrent(job);
    const floor = conversationFloor(this.repo, job.groupId);
    const from = rebuild ? floor : Math.max(floor, Number.isInteger(member.lastSeenSeq) ? member.lastSeenSeq : 0);
    const context = this.repo.messagesBetween(job.groupId, from, job.triggerSeq)
      .filter(message => message.messageId !== job.placeholderId && this.isCurrentRecord(message, job.groupId));
    const maximum = this.config.maxContextMessages;
    return Number.isInteger(maximum) && maximum > 0 ? context.slice(-maximum) : context;
  }

  async advanceMemberCursor(job) {
    // These prompts contain an explicit transcript, not the ordinary chat context.
    if (job.discussionId || ['discussion', 'summary', 'discussion_step'].includes(job.kind)) return;
    this.assertJobCurrent(job);
    const member = this.repo.getMember(job.membershipId);
    const lastSeenSeq = Math.max(member.lastSeenSeq || 0, conversationFloor(this.repo, job.groupId), job.triggerSeq || 0);
    const updated = { ...member, lastSeenSeq };
    if (this.repo.putMemberStrict) await this.repo.putMemberStrict(updated, {
      expectedConversationId: job.conversationId, expectedSessionId: member.sessionId, preserveSession: true,
    });
    else {
      // Compatibility with adapters predating strict, copy-on-write members.
      Object.assign(member, updated);
      this.repo.touchMember(member);
    }
    this.assertJobCurrent(job);
  }

  captureQuote(groupId, replyTo) {
    if (!replyTo) return null;
    const target = this.repo.getMessage(replyTo);
    if (!target || target.groupId !== groupId) {
      throw Object.assign(new Error('回复的原消息不存在或不属于本群'), { code: 'invalid-input' });
    }
    const attachments = (target.attachments || []).map(attachment => {
      const store = this.ctx.get?.('attachments');
      let path;
      try { path = store?.fileHostPath?.(attachment); } catch { /* rejected below */ }
      if (typeof path !== 'string' || !path) {
        throw Object.assign(new Error('引用消息的附件已不可用，请重新选择'), { code: 'invalid-input' });
      }
      return { attachmentId: attachment.attachmentId, name: attachment.name, bytes: attachment.bytes, path };
    });
    const conversationId = conversationIdOf(this.repo, target);
    if (this.repo.getGroup(groupId)?.activeConversationId && !conversationId) {
      throw Object.assign(new Error('引用消息的会话归属不可用'), { code: 'invalid-input' });
    }
    return {
      messageId: target.messageId, conversationId,
      author: { ...target.author }, text: String(target.text || ''), attachments, capturedAt: now(),
    };
  }

  // ── message helpers ──────────────────────────────────────────────────────
  createMessage(fields) {
    const conversationId = fields.conversationId ?? currentConversationId(this.repo, fields.groupId);
    if (conversationId !== currentConversationId(this.repo, fields.groupId)) {
      throw Object.assign(new Error('本次执行所属会话已结束'), { code: 'stale-conversation' });
    }
    const seq = this.repo.allocateSeq(fields.groupId);
    const message = {
      messageId: newId('msg'),
      groupId: fields.groupId,
      conversationId,
      ...(fields.quote ? { quote: structuredClone(fields.quote) } : {}),
      seq,
      author: fields.author,
      kind: fields.kind ?? 'chat',
      text: typeof fields.text === 'string' ? fields.text : '',
      mentions: Array.isArray(fields.mentions) ? [...fields.mentions] : [],
      attachments: Array.isArray(fields.attachments) ? fields.attachments.map((attachment) => ({ ...attachment })) : [],
      replyTo: fields.replyTo ?? null,
      status: fields.status ?? 'done',
      error: null,
      usage: null,
      generationStats: null,
      provider: fields.provider ?? null,
      model: fields.model ?? null,
      reasoningEffort: fields.reasoningEffort ?? null,
      meta: fields.meta ?? null,
      createdAt: now(),
      updatedAt: now(),
    };
    this.repo.appendMessage(message);
    return message;
  }

  systemMessage(groupId, text) {
    const message = this.createMessage({
      groupId,
      author: { type: 'system', name: '系统' },
      text,
      status: 'done',
      kind: 'system',
    });
    this.bus.emit(groupId, { type: 'message.added', message });
    return message;
  }

  /**
   * Timeline card for a bot approval request. The actual allow/reject decision
   * is answered by the DSH approval UI in the bot's own session; this card only
   * points the user there and tracks the outcome.
   */
  approvalMessage(job, data) {
    if (!this.isCurrentJob(job)) return;
    const member = this.repo.getMember(job.membershipId);
    const bot = member ? this.repo.getBot(member.botId) : undefined;
    const name = bot?.name || 'Bot';
    const reason = typeof data.reason === 'string' ? data.reason.trim() : '';
    const text = `${name} 请求权限：工具 ${data.toolName}${reason ? `（${reason}）` : ''}。`;
    const message = this.createMessage({
      groupId: job.groupId,
      conversationId: job.conversationId,
      author: { type: 'system', name: '审批' },
      text,
      status: 'done',
      kind: 'approval',
      meta: {
        approvalId: String(data.id || ''),
        membershipId: job.membershipId,
        botId: member?.botId ?? null,
        sessionId: job.sessionId,
        nativeSession: true,
        toolName: String(data.toolName || ''),
        reason,
        approvalState: 'pending',
      },
    });
    job.approvalMessages = job.approvalMessages || new Map();
    job.approvalMessages.set(message.meta.approvalId, message);
    this.bus.emit(job.groupId, { type: 'message.added', message });
    return message;
  }

  settleApproval(job, approvalId, outcome) {
    const key = String(approvalId || '');
    const message = job.approvalMessages?.get(key);
    if (!message) return;
    message.meta = { ...(message.meta || {}), approvalState: outcome || 'unavailable', decidedAt: now() };
    message.updatedAt = now();
    this.repo.putMessage(message);
    this.bus.emit(job.groupId, { type: 'message.updated', message });
    job.approvalMessages.delete(key);
  }

  // ── public dispatch ──────────────────────────────────────────────────────
  assertQuota(groupId) {
    this.assertAdmission(groupId);
    const result = this.quotaGuard(groupId);
    if (!result || result.ok) return;
    const error = new Error(result.reason || '本群额度已用完，请稍后再试');
    error.code = 'quota';
    throw error;
  }

  postHumanMessage({ groupId, text, mentions = [], author, replyTo, attachments, humanInput = true, expectedConversationId }) {
    const conversationId = this.admitConversation(groupId, expectedConversationId);
    const group = this.repo.getGroup(groupId);
    if (!group) throw new Error('group ' + groupId + ' does not exist');
    const command = String(text || '').trim();
    if (command === '/new') throw Object.assign(new Error('请使用新建会话管理操作'), { code: 'command-required' });
    if (/^\/new\s/.test(command)) throw Object.assign(new Error('/new 不接受参数'), { code: 'invalid-command' });
    const quote = this.captureQuote(groupId, replyTo);
    const quoteSize = quote ? quote.text.length + JSON.stringify(quote.author).length + JSON.stringify(quote.attachments).length : 0;
    const inputSize = String(text || '').length + quoteSize + (attachments?.length ? JSON.stringify(attachments).length : 0);
    if (inputSize > (this.config.maxMessageChars || 40000)) {
      throw Object.assign(new Error('消息与引用内容超过输入大小上限，请减少内容后重试'), { code: 'invalid-input' });
    }
    const replyToId = quote?.messageId || null;
    const message = this.createMessage({
      groupId,
      author: author || { type: 'human', name: '用户' },
      text,
      mentions,
      attachments,
      replyTo: replyToId,
      conversationId,
      quote,
      status: 'done',
    });
    this.bus.emit(groupId, { type: 'message.added', message });

    const targets = [];
    for (const membershipId of mentions) {
      const member = this.repo.getMember(membershipId);
      if (!member || member.groupId !== groupId || member.enabled === false) continue;
      if (!this.repo.getBot(member.botId)) continue;
      if (!targets.some((candidate) => candidate.membershipId === member.membershipId)) targets.push(member);
    }
    if (targets.length > 0) this.assertQuota(groupId);
    for (const member of targets) {
      this.queue.push({
        jobId: newId('job'),
        groupId,
        conversationId,
        membershipId: member.membershipId,
        triggerSeq: message.seq,
        triggerMessageId: message.messageId,
        kind: 'chat',
        humanInput,
        state: 'queued',
      });
    }
    for (const member of targets) this.pump(groupId);
    return { message, accepted: targets.map((member) => member.membershipId) };
  }

  pump(groupId) {
    if (this.disposed || this.pumpBlocks.has(groupId)) return;
    const runnable = [];
    const busy = new Set(
      [...this.running.values()].filter((job) => job.groupId === groupId).map((job) => job.membershipId),
    );
    let running = this.runningCount(groupId);
    for (const job of this.queue) {
      if (job.groupId !== groupId) continue;
      if (job.stepId) {
        const discussion = this.repo.getDiscussion(job.discussionId);
        if (!discussion || this.discussionRunner.closed.has(job.discussionId) || !['running', 'finalizing'].includes(discussion.status)) continue;
      }
      if (running >= this.config.maxParallelTurns) break;
      if (busy.has(job.membershipId)) continue;
      busy.add(job.membershipId);
      running += 1;
      runnable.push(job);
    }
    for (const job of runnable) {
      const index = this.queue.indexOf(job);
      if (index >= 0) this.queue.splice(index, 1);
      this.startJob(job);
    }
  }

  runningCount(groupId) {
    let count = 0;
    for (const job of this.running.values()) if (job.groupId === groupId) count += 1;
    return count;
  }

  queuedCount(groupId) {
    return this.queue.filter((job) => job.groupId === groupId).length;
  }

  startJob(job, observed = null) {
    try {
      job.conversationId = this.admitConversation(job.groupId, job.conversationId);
      this.assertJobCurrent(job);
      this.assertJobTargets(job);
      if (observed && !isCurrentMemberSession(this.repo, this.repo.getMember(job.membershipId), observed.session.id)) {
        throw Object.assign(new Error('原生会话已不是当前会话'), { code: 'stale-conversation' });
      }
    } catch (error) {
      job.finished = true;
      job.state = 'error';
      job.error = String(error?.message || error);
      job.done = job.stepId ? this.discussionRunner.finished(job).catch(failure => this.discussionRunner.failed(job.discussionId, failure)) : Promise.resolve();
      job.done.then(() => job.resolveDone?.());
      if (!job.stepId && job.discussionId) this.advanceDiscussion(job.discussionId, false);
      this.checkIdle(job.groupId);
      return;
    }
    job.state = 'running';
    job.turn = null;
    job.submitted = false;
    job.turnStarts = new Map();
    job.observedTurn = null;
    job.observedTurnSeq = -1;
    job.execution = {
      version: 1,
      jobId: job.jobId,
      sessionId: null,
      inputMessageId: null,
      turn: null,
      startSeq: null,
      endSeq: null,
    };
    job.steps = [];
    job.streamText = '';
    job.requestMetrics = new LastRequestMetrics();
    job.finished = false;
    job.following = [];
    job.awaitingContinuation = false;
    job.nativeObserved = observed !== null;
    job.done = new Promise((resolve) => {
      job.resolveDone = resolve;
    });
    this.running.set(job.membershipId, job);

    const member = this.repo.getMember(job.membershipId);
    const bot = member ? this.repo.getBot(member.botId) : undefined;
    if (!member || !bot) {
      this.finishJob(job, 'error', '成员或 Bot 已不存在');
      return;
    }
    const placeholder = observed?.message || this.createMessage({
      groupId: job.groupId,
      conversationId: job.conversationId,
      author: {
        type: 'bot',
        botId: member.botId,
        membershipId: member.membershipId,
        name: bot.name,
      },
      text: '',
      status: 'pending',
      replyTo: job.triggerMessageId,
      kind: job.messageKind ?? (job.kind === 'discussion' || job.kind === 'summary' ? 'discussion' : job.kind === 'review' ? 'review' : 'chat'),
      provider: bot.provider ?? null,
      model: bot.model ?? null,
      reasoningEffort: bot.reasoningEffort ?? null,
      meta: { ...(job.meta || {}), execution: job.execution },
    });
    job.placeholderId = placeholder.messageId;
    if (observed?.message) {
      placeholder.status = 'pending';
      placeholder.error = null;
      this.bus.emit(job.groupId, { type: 'message.updated', message: placeholder });
    } else this.bus.emit(job.groupId, { type: 'message.added', message: placeholder });
    this.bus.emit(job.groupId, {
      type: 'member.status',
      conversationId: job.conversationId,
      membershipId: member.membershipId,
      status: 'running',
    });

    const context = this.contextFor(job, member);
    job.context = context;

    if (observed) {
      job.sessionId = observed.session.id;
      job.submitted = true;
      job.nativeInput = true;
      this.activeBySession.set(job.sessionId, job);
      this.recordExecution(job, { sessionId: job.sessionId, submittedSeq: observed.event.seq }, observed.event.seq);
      return;
    }
    if (this.config.turnTimeoutMs > 0) job.timer = setTimeout(() => this.abortJob(job, 'timeout'), this.config.turnTimeoutMs);
    void this.runJob(job, member, bot, context);
  }

  async runJob(job, member, bot, context) {
    this.pendingWork.add(job);
    try {
      this.admitConversation(job.groupId, job.conversationId);
      this.assertJobTargets(job);
      if (job.stepId) await this.discussionRunner.prepare(job);
      if (job.finished) return;
      const previousSessionId = member.sessionId;
      const previousConversationId = member.sessionConversationId;
      const agent = await this.pool.ensure(member.membershipId);
      if (job.finished) return;
      if (this.disposed || job.state === 'stopped') {
        this.finishJob(job, 'stopped', '已停止');
        return;
      }
      // ensure persists a replacement member. Never write the pre-ensure object
      // back over the new session mapping or its conversation ownership.
      member = this.repo.getMember(job.membershipId);
      job.sessionId = agent.id;
      this.assertJobCurrent(job);
      this.assertJobTargets(job);
      const rebuild = member.sessionId !== previousSessionId || previousConversationId !== member.sessionConversationId;
      context = this.contextFor(job, member, rebuild);
      job.context = context;
      await this.advanceMemberCursor(job);
      if (job.finished) return;
      this.activeBySession.set(agent.id, job);
      await this.persistExecution(job, { sessionId: agent.id });
      if (job.finished) return;

      try {
        await this.personas.refresh(bot.botId);
      } catch (error) {
        this.logger?.warn?.(`bot-team: refresh persona ${bot.botId} failed: ${String(error)}`);
      }

      if (job.finished) return;
      this.admitConversation(job.groupId, job.conversationId);
      this.assertJobCurrent(job);
      this.assertJobTargets(job);
      if (job.stepId) this.discussionRunner.assertDispatch(job);
      const prompt = job.promptText ?? this.buildPrompt(job, bot, context);
      job.promptPreview = prompt.slice(0, 2000);
      const inputMessageId = newId('umsg');
      // Session.seq is the next accepted event index, an inclusive search floor.
      const submittedSeq = agent.session?.seq;
      await this.persistExecution(job, {
        inputMessageId,
        ...(executionSeq(submittedSeq) ? { submittedSeq } : {}),
      });
      // A stop/timeout may have occurred while the durable write was pending.
      if (job.finished) return;

      this.admitConversation(job.groupId, job.conversationId);
      this.assertJobCurrent(job);
      this.assertJobTargets(job);

      if (job.stepId) this.discussionRunner.assertDispatch(job);

      // M0 P1: followup puts the EXACT value into the durable inbox — it must be
      // a complete UserMessage (role + id + content + source). Claims may fire
      // synchronously, so arm correlation only after the write has succeeded.
      job.submitted = true;
      const input = {
        role: 'user',
        id: inputMessageId,
        content: [{ type: 'text', text: prompt }],
        source: job.humanInput === true
          ? { kind: 'user' }
          : { kind: 'bot-team', groupId: job.groupId, ...(job.conversationId ? { conversationId: job.conversationId } : {}), jobId: job.jobId },
      };
      const assertActive = () => {
        if (job.finished) throw Object.assign(new Error('本次执行已结束'), { code: 'stopped' });
        this.assertJobCurrent(job); this.assertJobTargets(job);
        if (job.stepId) this.discussionRunner.assertDispatch(job);
      };
      if (this.pool.submit) await this.pool.submit(agent, input, assertActive);
      else { assertActive(); await agent.followup(input); }
      if (job.finished && job.stepId) this.withdrawDiscussionInput(job);
      await job.done;
    } catch (error) {
      this.finishJob(job, 'error', String(error && error.message ? error.message : error));
    } finally {
      if (job.timer) clearTimeout(job.timer);
      this.pendingWork.delete(job);
      if (job.finished && job.stepId) {
        this.withdrawDiscussionInput(job);
        if (this.repo.getDiscussion(job.discussionId)?.status === 'stopping') this.discussionRunner.checkStopping(job.discussionId);
      }
    }
  }

  emitExecutionUpdated(job, seq, includeExecution = false) {
    this.bus.emit(job.groupId, {
      type: 'execution.updated',
      messageId: job.placeholderId,
      conversationId: job.conversationId,
      sessionId: job.execution.sessionId,
      seq: executionSeq(seq) ? seq : null,
      ...(includeExecution ? { execution: { ...job.execution } } : {}),
    });
  }

  async persistExecution(job, patch, seq = null) {
    this.assertJobCurrent(job);
    const message = this.repo.messages.get(job.placeholderId);
    if (!message) throw new Error('无法保存执行记录：回复消息不存在');
    job.execution = { ...job.execution, ...patch };
    message.meta = { ...(message.meta || {}), execution: job.execution };
    message.updatedAt = now();
    // Do not use putMessage here: it deliberately swallows storage failures.
    const saved = this.repo.putMessageStrict(message);
    await saved;
    if (job.stepId) await this.discussionRunner.execution(job);
    if (this.isCurrentJob(job)) this.emitExecutionUpdated(job, seq, true);
  }

  recordExecution(job, patch, seq) {
    void this.persistExecution(job, patch, seq).catch(error => this.executionFailed(job, error));
  }

  executionFailed(job, error) {
    if (job.finished) return;
    const scoped = this.activeBySession.get(job.sessionId) === job && (!job.stepId || job.turn !== null);
    this.finishJob(job, 'error', `无法保存执行记录：${String(error?.message || error)}`);
    if (scoped && !job.nativeObserved && job.submitted && job.execution.endSeq === null) {
      try {
        this.ctx.agents.get(job.sessionId)?.cancel?.({ kind: 'user' }, { keepInbox: Boolean(job.stepId) });
      } catch (cancelError) {
        this.logger?.warn?.(`bot-team: cancel agent failed: ${String(cancelError)}`);
      }
    }
  }

  bindExecutionTurn(job, turn) {
    if (!executionTurn(turn) || (job.turn !== null && job.turn !== turn)) return;
    if (job.turn === turn) return;
    job.turn = turn;
    job.observedTurn = turn;
    const startSeq = job.turnStarts.get(turn) ?? null;
    job.turnStarts.clear();
    void this.persistExecution(job, { turn, startSeq }, startSeq)
      .catch((error) => this.executionFailed(job, error));
  }

  onInboxClaim(payload) {
    const job = this.activeBySession.get(payload?.agent?.id);
    if (!job || job.finished || job.ending || !job.submitted || !this.isCurrentJob(job)) return;
    if (this.ctx.agents.get(payload.agent.id) !== payload.agent) return;
    if (!job.execution.inputMessageId || payload.message?.id !== job.execution.inputMessageId) return;
    this.bindExecutionTurn(job, payload.turn);
  }

  /** Reattach group observation to already-live native Agents after plugin reload. */
  async recoverNativeSessions() {
    const query = this.ctx.get?.('sessionQuery');
    for (const member of this.repo.members?.values() || []) {
      if (!isCurrentMemberSession(this.repo, member, member.sessionId)) continue;
      const conversationId = currentConversationId(this.repo, member.groupId);
      const agent = member.sessionId ? this.ctx.agents.get?.(member.sessionId) : null;
      if (!agent || this.activeBySession.has(agent.id)) continue;
      try {
        const snapshot = typeof agent.session?.snapshotEvents === 'function'
          ? { events: agent.session.snapshotEvents() }
          : await query?.readSession?.(agent.id);
        if (this.disposed) return;
        if (currentConversationId(this.repo, member.groupId) !== conversationId ||
            !isCurrentMemberSession(this.repo, this.repo.getMember(member.membershipId), agent.id)) continue;
        this.admitConversation(member.groupId, conversationId);
        if (this.ctx.agents.get(agent.id) !== agent || this.pool.memberForSession?.(agent.id)?.membershipId !== member.membershipId || this.running.has(member.membershipId)) continue;
        const events = snapshot?.events;
        if (!Array.isArray(events)) continue;
        const startIndex = events.findLastIndex(event => event.type === 'turn/start');
        if (startIndex < 0) continue;
        const turnEvents = events.slice(startIndex);
        const start = turnEvents[0];
        if (!executionTurn(start.data?.turn) || !executionSeq(start.seq)) continue;
        const ended = turnEvents.some(event => event.type === 'turn/end' && event.data?.turn === start.data.turn);
        if (ended && !this.nativeGoalPending(agent.id)) continue;
        const previous = this.repo.messagesOf(member.groupId).findLast(message =>
          this.isCurrentRecord(message, member.groupId) && message.author?.membershipId === member.membershipId &&
          message.meta?.execution?.sessionId === agent.id &&
          message.meta.execution.turn === start.data.turn && message.meta.execution.startSeq === start.seq);
        const discussion = previous?.meta?.discussionId ? this.repo.getDiscussion?.(previous.meta.discussionId) : null;
        const linked = discussion && isDiscussionActive(discussion) && this.isCurrentRecord(discussion);
        const kind = linked ? (previous.meta.stepId ? 'discussion_step' : previous.meta.summary ? 'summary' : 'discussion')
          : previous?.meta?.taskPhase === 'revision' ? 'task_revision' : previous?.kind || 'native';
        const job = {
          jobId: previous?.meta?.execution?.jobId || newId('job'),
          groupId: member.groupId, conversationId, membershipId: member.membershipId,
          triggerSeq: member.lastSeenSeq || 0, triggerMessageId: previous?.replyTo || null,
          kind, messageKind: previous?.kind, meta: { ...(previous?.meta || {}), nativeSession: true },
          ...(linked ? { discussionId: discussion.discussionId, stepId: previous.meta.stepId, attemptId: previous.meta.attemptId, round: previous.meta.round } : {}),
          previousReplies: linked ? this.repo.messagesOf(member.groupId).filter(message =>
            message.messageId !== previous?.messageId && message.meta?.execution?.jobId === previous?.meta?.execution?.jobId &&
            message.meta?.attemptId === previous?.meta?.attemptId).map(message => message.messageId) : [],
        };
        this.startJob(job, { session: agent.session, event: start, message: previous });
        for (const event of turnEvents) this.onSessionEvent(agent.session, event);
      } catch (error) {
        this.logger?.warn?.('bot-team: native observation recovery failed: ' + String(error));
      }
    }
  }

  /** Follow native goals without treating their first completed turn as the task end. */
  nativeGoalPending(sessionId) {
    const member = this.pool.memberForSession?.(sessionId);
    if (!member || !isCurrentMemberSession(this.repo, member, sessionId)) return false;
    const agent = this.ctx.agents.get(sessionId);
    const goals = this.ctx.get?.('goals');
    if (!agent || !goals?.get) return false;
    try {
      const goal = goals.get(agent);
      return goal?.phase === 'active' && goal.activation === 'armed';
    } catch { return false; }
  }

  checkNativeGoal(sessionId, expectedJob = this.activeBySession.get(sessionId)) {
    const job = this.activeBySession.get(sessionId);
    if (job !== expectedJob || this.disposed || !job?.awaitingContinuation || job.finished || !this.isCurrentJob(job)) return;
    if (this.nativeGoalPending(sessionId)) return;
    const agent = this.ctx.agents.get(sessionId);
    const goal = agent ? this.ctx.get?.('goals')?.get(agent) : null;
    if (goal?.phase === 'blocked') this.finishJob(job, 'error', goal.blockedReason?.message || '原生目标已阻塞');
    else if (goal?.phase === 'paused' || (goal?.phase === 'active' && goal.activation !== 'armed')) this.finishJob(job, 'stopped', '原生目标已暂停');
    else this.finishJob(job, 'done');
  }

  /** A turn started from the native window, scheduler, or a child reply still belongs in the group. */
  adoptNativeTurn(session, event) {
    if (event.type !== 'turn/start' || !executionTurn(event.data?.turn) || !executionSeq(event.seq)) return null;
    const member = this.pool.memberForSession?.(session.id);
    if (!member || !isCurrentMemberSession(this.repo, member, session.id) || this.running.has(member.membershipId)) return null;
    let conversationId;
    try { conversationId = this.admitConversation(member.groupId); } catch { return null; }
    const job = {
      jobId: newId('job'), groupId: member.groupId, conversationId, membershipId: member.membershipId,
      triggerSeq: member.lastSeenSeq || 0, triggerMessageId: null, kind: 'native',
      meta: { nativeSession: true },
    };
    this.startJob(job, { session, event });
    return job.finished ? null : job;
  }

  startNativeContinuation(job, session, event) {
    if (!this.isCurrentJob(job)) return false;
    try { this.admitConversation(job.groupId, job.conversationId); } catch { return false; }
    const previous = this.repo.getMessage(job.placeholderId);
    if (!previous) throw new Error('Native continuation lost its preceding reply');
    job.previousReplies = [...(job.previousReplies || []), job.placeholderId];
    job.turn = null;
    job.turnStarts = new Map();
    job.observedTurn = null;
    job.observedTurnSeq = -1;
    job.steps = [];
    job.streamText = '';
    job.streamAttemptId = null;
    job.usage = null;
    job.requestMetrics = new LastRequestMetrics();
    job.awaitingContinuation = false;
    job.nativeInput = true;
    job.execution = {
      version: 1, jobId: job.jobId, sessionId: session.id, inputMessageId: null,
      turn: null, startSeq: null, endSeq: null, submittedSeq: event.seq,
    };
    const message = this.createMessage({
      groupId: job.groupId, conversationId: job.conversationId, author: previous.author, status: 'pending',
      kind: previous.kind, provider: previous.provider, model: previous.model,
      reasoningEffort: previous.reasoningEffort, replyTo: previous.messageId,
      meta: { ...(job.meta || {}), nativeSession: true, execution: job.execution },
    });
    job.placeholderId = message.messageId;
    this.bus.emit(job.groupId, { type: 'message.added', message });
    return true;
  }

  replayFollowing(job) {
    const following = job.following?.splice(0) || [];
    for (const item of following) {
      if (item.stream) this.onAssistantStream(item.stream);
      else this.onSessionEvent(item.session, item.event);
    }
  }

  onSessionEvent(session, event) {
    if (!session || !event) return;
    if (this.disposed) return;
    const live = this.ctx.agents.get(session.id);
    if (live?.session && live.session !== session) return;
    if (event.type === 'turn/end') this.discussionRunner.nativeSettled(session.id);
    const job = this.activeBySession.get(session.id) || this.adoptNativeTurn(session, event);
    if (!job || job.finished || !this.isCurrentJob(job)) return;
    if (job.ending) { job.following.push({ session, event }); return; }
    const data = event.data || {};
    if (job.awaitingContinuation) {
      if (event.type === 'turn/start') {
        if (!this.startNativeContinuation(job, session, event)) return;
      }
      else {
        if (event.type.startsWith('goal/')) queueMicrotask(() => this.checkNativeGoal(session.id, job));
        if (executionSeq(event.seq)) this.emitExecutionUpdated(job, event.seq);
        return;
      }
    }
    const correlated = Boolean(job.execution.inputMessageId) || job.nativeInput;
    if (correlated && !job.submitted) return;
    if (executionSeq(event.seq) && executionSeq(job.execution.submittedSeq) && event.seq < job.execution.submittedSeq) return;

    if (event.type === 'turn/start') {
      if (!executionTurn(data.turn)) return;
      // Legacy test/adapter events may omit both inbox identity and accepted seq.
      // A real submitted job must always wait for an exact claim or input ID.
      if (!correlated) {
        if (!executionSeq(event.seq) && job.turn === null) job.turn = job.observedTurn = data.turn;
        return;
      }
      // Adapters without accepted sequence numbers can still correlate the exact
      // user input; leave their unknown boundary null instead of inventing a seq.
      if (!executionSeq(event.seq) && job.observedTurnSeq < 0) job.observedTurn = data.turn;
      if (executionSeq(event.seq)) {
        if (event.seq > job.observedTurnSeq) {
          job.observedTurn = data.turn;
          job.observedTurnSeq = event.seq;
        }
        if (job.turn === null && !job.turnStarts.has(data.turn)) job.turnStarts.set(data.turn, event.seq);
        if (job.turn === data.turn && job.execution.startSeq === null) {
          void this.persistExecution(job, { startSeq: event.seq }, event.seq)
            .catch((error) => this.executionFailed(job, error));
        }
      }
      return;
    }
    if (event.type === 'user/message' && correlated) {
      const inputId = data.id ?? data.message?.id;
      if (job.nativeInput && !job.execution.inputMessageId && typeof inputId === 'string') {
        this.recordExecution(job, { inputMessageId: inputId }, event.seq);
      }
      if (inputId !== job.execution.inputMessageId) return;
      // Accepted user/message contains the UserMessage itself, without a turn.
      // Its exact ID disambiguates the enclosing turn/start candidate.
      this.bindExecutionTurn(job, executionTurn(data.turn) ? data.turn : job.observedTurn);
    }
    if (job.turn === null) return;
    if (executionTurn(data.turn) ? data.turn !== job.turn : job.observedTurn !== job.turn) return;
    if (executionSeq(event.seq) && executionSeq(job.execution.startSeq) && event.seq < job.execution.startSeq) return;

    if (event.type === 'turn/end' && data.turn === job.turn && correlated && executionSeq(event.seq)) {
      job.ending = true;
      void this.persistExecution(job, { endSeq: event.seq }, event.seq)
        .then(() => this.finishTurn(job, data.reason))
        .catch((error) => this.executionFailed(job, error));
      return;
    }
    if (executionSeq(event.seq) && executionEvent(event.type)) this.emitExecutionUpdated(job, event.seq);
    if (event.type === 'approval/asked') {
      if (this.config.botApprovalPolicy !== 'never') this.approvalMessage(job, event.data || {});
      return;
    }
    if (event.type === 'approval/decided') {
      this.settleApproval(job, event.data && event.data.id, event.data && event.data.outcome);
      return;
    }
    if ((event.type === 'assistant/message' || event.type === 'assistant/attempt') && event.data.turn === job.turn) {
      job.requestMetrics?.settle(event, job.turn);
    }
    if (event.type === 'assistant/message' && event.data.turn === job.turn) {
      const messageText = (event.data.message.content || [])
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('');
      if (messageText) job.steps.push(messageText);
      if (event.data.usage) job.usage = event.data.usage;
      const combined = job.steps.filter(Boolean).join('\n\n');
      if (combined) {
        this.bus.emit(job.groupId, {
          type: 'message.replace',
          conversationId: job.conversationId,
          messageId: job.placeholderId,
          text: combined,
        });
      }
      return;
    }
    if (event.type === 'turn/end' && data.turn === job.turn) this.finishTurn(job, data.reason);
  }

  finishTurn(job, reason = {}) {
    if (job.finished) return;
    if (!this.isCurrentJob(job)) { this.finishJob(job, 'stopped', '本次执行所属会话已结束'); return; }
    job.ending = false;
    if (reason.kind === 'completed') {
      if (this.nativeGoalPending(job.sessionId) || job.following?.some(item => item.event?.type === 'turn/start')) {
        this.settleMessage(job, 'done');
        job.awaitingContinuation = true;
        this.replayFollowing(job);
        return;
      }
      this.finishJob(job, 'done');
    } else if (reason.kind === 'aborted') {
      this.finishJob(job, 'stopped', reason.reason && reason.reason.kind === 'user' ? '已停止' : '已中断');
    } else if (reason.kind === 'max-tokens') {
      this.finishJob(job, 'error', '达到输出上限');
    } else {
      const detail = reason.error && reason.error.message ? reason.error.message : `turn ended: ${reason.kind}`;
      this.finishJob(job, 'error', detail);
    }
  }

  onAssistantStream(payload) {
    if (!payload || !payload.agent || !payload.frame) return;
    if (this.ctx.agents.get(payload.agent.id) !== payload.agent) return;
    const job = this.activeBySession.get(payload.agent.id);
    if (!job || job.finished || !this.isCurrentJob(job)) return;
    if (job.ending) { job.following.push({ stream: payload }); return; }
    if (job.awaitingContinuation || job.turn === null || job.observedTurn !== job.turn) return;
    const frame = payload.frame;
    if (executionTurn(frame.turn) && frame.turn !== job.turn) return;
    if (frame.type === 'start') {
      job.requestMetrics?.start(frame, job.turn);
      job.streamAttemptId = frame.attemptId;
      job.streamText = '';
      return;
    }
    if (frame.attemptId && frame.attemptId !== job.streamAttemptId) return;
    if (frame.type === 'end') {
      job.requestMetrics?.end(frame);
      return;
    }
    if (
      frame.type === 'chunk' &&
      frame.chunk &&
      frame.chunk.type === 'text-delta' &&
      typeof frame.chunk.text === 'string' &&
      frame.chunk.text.length > 0
    ) {
      job.streamText += frame.chunk.text;
      this.bus.emit(job.groupId, {
        type: 'message.delta',
        conversationId: job.conversationId,
        messageId: job.placeholderId,
        chunk: frame.chunk.text,
      });
    }
  }

  withdrawDiscussionInput(job) {
    if (!job?.stepId || !job.sessionId || !job.execution?.inputMessageId) return 0;
    if (this.activeBySession.get(job.sessionId) !== job && (!this.repo || !this.isCurrentRecord(job))) return 0;
    const inbox = this.ctx.agents.get(job.sessionId)?.inbox;
    if (typeof inbox?.splice !== 'function') return 0;
    let removed = 0;
    try {
      for (const [lane, key] of [['next-turn', 'nextTurn'], ['next-step', 'nextStep']]) {
        if (!Array.isArray(inbox[key])) continue;
        for (let index = inbox[key].length - 1; index >= 0; index -= 1) {
          const input = inbox[key][index];
          if (input?.id !== job.execution.inputMessageId) continue;
          // Persisted input identity remains authoritative if native admission
          // normalizes the source. Preserve an explicitly different job source.
          if (input.source?.kind === 'bot-team' && input.source.jobId && input.source.jobId !== job.jobId) continue;
          inbox.splice(lane, index, 1, []); removed += 1;
        }
      }
    } catch (error) { this.logger?.warn?.('bot-team: exact discussion input withdrawal failed: ' + String(error)); }
    return removed;
  }

  abortJob(job, cause) {
    if (!job || job.finished) return;
    job.state = 'stopped';
    this.withdrawDiscussionInput(job);
    try {
      job.abortController?.abort();
    } catch {
      /* noop */
    }
    const agent = job.sessionId ? this.ctx.agents.get(job.sessionId) : undefined;
    const owned = agent && this.pool.owns?.(agent);
    const scoped = this.activeBySession.get(job.sessionId) === job && (!job.stepId || job.turn !== null);
    if (agent && scoped && (cause !== 'dispose' || owned) && typeof agent.cancel === 'function') {
      try {
        // A shared native session may contain unrelated queued inputs.
        agent.cancel({ kind: 'user' }, { keepInbox: Boolean(job.stepId) });
      } catch (error) {
        this.logger?.warn?.(`bot-team: cancel agent failed: ${String(error)}`);
      }
    }
    const reason = cause === 'timeout' ? '本轮超时，已停止' : cause === 'dispose' ? (owned ? 'Bot Team 已卸载，后台执行已停止' : 'Bot Team 已断开观察；原生会话仍由 DSH 管理') : '已停止';
    this.finishJob(job, 'stopped', reason);
  }

  settleMessage(job, status, error) {
    const text = ((job.steps || []).filter(Boolean).join('\n\n') || job.streamText || '').trim();
    const message = job.placeholderId ? this.repo.messages.get(job.placeholderId) : undefined;
    if (message) {
      message.text = text;
      message.status = status;
      message.error = error ?? null;
      message.usage = job.usage ?? null;
      message.generationStats = job.requestMetrics?.finish(status) ?? null;
      message.kind = job.messageKind ?? message.kind ?? 'chat';
      const meta = { ...(message.meta || {}), ...(job.meta || {}), execution: job.execution,
        ...(job.stepId ? { logicalJobComplete: job.finished === true } : {}) };
      if (job.kind === 'review' && status === 'done') {
        const verdict = parseReviewVerdict(text);
        if (verdict) meta.verdict = verdict;
      }
      if (Object.keys(meta).length > 0) message.meta = meta;
      message.updatedAt = now();
      if (job.stepId) {
        const saved = Promise.resolve(this.repo.putMessageStrict(message)).catch(saveError => {
          job.discussionPersistenceError = String(saveError?.message || saveError);
        });
        job.discussionMessageWrites = Promise.all([job.discussionMessageWrites, saved]);
      } else this.repo.putMessage(message);
      this.bus.emit(job.groupId, { type: 'message.updated', message });
      // The accepted end event may have invalidated before this final status.
      // A null seq also refreshes stopped jobs and bypasses event deduplication.
      this.emitExecutionUpdated(job, null, true);
    }
    return message;
  }

  finishJob(job, status, error) {
    if (!job || job.finished) return;
    job.finished = true;
    job.state = status;
    job.error = error || null;
    if (job.timer) clearTimeout(job.timer);
    const current = this.isCurrentJob(job);
    if (job.sessionId && this.activeBySession.get(job.sessionId) === job) this.activeBySession.delete(job.sessionId);
    if (this.running.get(job.membershipId) === job) this.running.delete(job.membershipId);

    const message = this.settleMessage(job, status, error);
    if (job.approvalMessages && job.approvalMessages.size > 0) {
      for (const approvalId of [...job.approvalMessages.keys()]) {
        this.settleApproval(job, approvalId, 'cancelled');
      }
    }
    if (current) this.bus.emit(job.groupId, {
      type: 'member.status',
      conversationId: job.conversationId,
      membershipId: job.membershipId,
      status: status === 'done' ? 'idle' : status === 'stopped' ? 'idle' : 'error',
      ...(status === 'error' ? { error: error ?? '未知错误' } : {}),
    });
    try {
      const hookResult = current ? this.taskHook(job, message, status) : undefined;
      if (hookResult && typeof hookResult.then === 'function') {
        const pendingHook = { groupId: job.groupId, conversationId: job.conversationId };
        this.pendingWork.add(pendingHook);
        hookResult.catch((hookError) => {
          this.logger?.warn?.('bot-team: task hook failed: ' + String(hookError));
        }).finally(() => this.pendingWork.delete(pendingHook));
      }
    } catch (hookError) {
      this.logger?.warn?.('bot-team: task hook failed: ' + String(hookError));
    }
    if (job.stepId) {
      const pending = { groupId: job.groupId, conversationId: job.conversationId };
      this.pendingWork.add(pending);
      void this.discussionRunner.finished(job).catch(failure => this.discussionRunner.failed(job.discussionId, failure))
        .finally(() => {
          this.pendingWork.delete(pending); job.resolveDone?.();
          this.pump(job.groupId); this.checkIdle(job.groupId);
        });
    } else {
      job.resolveDone?.();
      this.pump(job.groupId);
      if (current) this.afterJobFinished(job);
      this.checkIdle(job.groupId);
    }
  }

  /** Discussion bookkeeping + review-side effects after one job settles. */
  afterJobFinished(job) {
    if (!job || !this.isCurrentJob(job)) return;
    if (job.kind === 'discussion' && job.discussionId) {
      this.advanceDiscussion(job.discussionId, job.state === 'done');
      return;
    }
    if (job.kind === 'summary' && job.discussionId) {
      const discussion = this.repo.getDiscussion(job.discussionId);
      if (discussion && discussion.status === 'running' && this.isCurrentRecord(discussion)) {
        discussion.status = job.state === 'done' ? 'done' : 'stopped';
        discussion.updatedAt = now();
        this.repo.putDiscussion(discussion);
        this.bus.emit(discussion.groupId, { type: 'discussion.updated', discussion });
        this.systemMessage(
          discussion.groupId,
          job.state === 'done'
            ? `讨论「${discussion.topic}」结束。`
            : `讨论「${discussion.topic}」总结失败/中断，已结束。`,
        );
        this.settleDiscussionWaiters(job.discussionId);
      }
    }
  }

  advanceDiscussion(discussionId, ok) {
    const discussion = this.repo.getDiscussion(discussionId);
    if (!discussion || discussion.status !== 'running' || !this.isCurrentRecord(discussion)) return;
    if (!ok) {
      discussion.status = 'stopped';
      discussion.stopReason = 'member-error';
      discussion.updatedAt = now();
      this.repo.putDiscussion(discussion);
      this.bus.emit(discussion.groupId, { type: 'discussion.updated', discussion });
      this.systemMessage(discussion.groupId, `讨论「${discussion.topic}」因成员执行失败而停止。`);
      this.settleDiscussionWaiters(discussionId);
      return;
    }
    discussion.currentIndex = (discussion.currentIndex ?? 0) + 1;
    if (discussion.currentIndex >= (discussion.memberIds?.length ?? 0)) {
      discussion.currentRound = (discussion.currentRound ?? 1) + 1;
      discussion.currentIndex = 0;
    }
    discussion.updatedAt = now();
    this.repo.putDiscussion(discussion);
    this.bus.emit(discussion.groupId, { type: 'discussion.updated', discussion });
    // Serial scheduling: the next speaker starts only after this job settles.
    setTimeout(() => this.scheduleDiscussion(discussionId), 0);
  }

  /** Enqueue one task delivery turn for the task's assignee. */
  enqueueTaskTurn({ taskId, phase, expectedConversationId }) {
    const task = this.repo.getTask(taskId);
    if (!task) throw Object.assign(new Error('任务不存在'), { code: 'not-found' });
    const group = this.repo.getGroup(task.groupId);
    if (!group) throw Object.assign(new Error('任务所在群不存在'), { code: 'not-found' });
    const conversationId = this.admitConversation(task.groupId, expectedConversationId);
    this.assertCurrentTarget(task.groupId, task);
    const triggerSeq = this.repo.lastMessageOf(task.groupId)?.seq ?? 0;
    this.enqueueJob({
      groupId: task.groupId,
      conversationId,
      membershipId: task.assigneeMembershipId,
      kind: phase === 'revision' ? 'task_revision' : 'task',
      triggerSeq,
      triggerMessageId: null,
      messageKind: 'task',
      meta: { taskId: task.taskId, taskPhase: phase || 'dispatch' },
    });
  }

  /** Queue shape for one group: running turns, waiting turns and their task ids. */
  queueSnapshot(groupId) {
    const runningJobs = [...this.running.values()].filter((job) => job.groupId === groupId && !job.finished);
    const queuedJobs = this.queue.filter((job) => job.groupId === groupId);
    return {
      running: runningJobs.length,
      queued: queuedJobs.length,
      runningTaskIds: runningJobs.map((job) => job.meta && job.meta.taskId).filter(Boolean),
      queuedTaskIds: queuedJobs.map((job) => job.meta && job.meta.taskId).filter(Boolean),
      parallelLimit: this.config.maxParallelTurns,
    };
  }

  // ── M2: review / revision ───────────────────────────────────────────────
  enqueueJob(spec) {
    const conversationId = this.admitConversation(spec.groupId, spec.conversationId ?? spec.expectedConversationId);
    this.assertJobTargets(spec);
    const job = {
      jobId: newId('job'),
      state: 'queued',
      ...spec,
      conversationId,
    };
    this.queue.push(job);
    this.pump(job.groupId);
    return job;
  }

  authorNameOf(message) {
    if (!message) return '未知';
    if (message.author?.type === 'human') return '用户';
    if (message.author?.type === 'system') return '系统';
    const bot = message.author?.botId ? this.repo.getBot(message.author.botId) : undefined;
    return bot?.name ?? message.author?.name ?? 'Bot';
  }

  requestReview({ groupId, targetMessageId, reviewerMembershipId, instructions, taskId, expectedConversationId }) {
    const conversationId = this.admitConversation(groupId, expectedConversationId);
    const target = this.repo.messages.get(targetMessageId);
    if (!target || target.groupId !== groupId) throw Object.assign(new Error('待评审消息不存在'), { code: 'not-found' });
    this.assertCurrentTarget(groupId, target);
    if (taskId) this.assertCurrentTarget(groupId, this.repo.getTask?.(taskId));
    const member = this.repo.getMember(reviewerMembershipId);
    if (!member || member.groupId !== groupId) throw Object.assign(new Error('评审者不在群里'), { code: 'invalid-input' });
    const reviewer = this.repo.getBot(member.botId);
    if (!reviewer) throw Object.assign(new Error('评审者 Bot 不存在'), { code: 'not-found' });
    this.assertQuota(groupId);
    const requestMessage = this.createMessage({
      groupId,
      author: { type: 'system', name: '系统' },
      text: `请 @${reviewer.name} 评审 #${target.seq}（${this.authorNameOf(target)}）的消息`,
      kind: 'review',
      status: 'done',
      mentions: [reviewerMembershipId],
      replyTo: targetMessageId,
      meta: { reviewOf: targetMessageId, reviewerMembershipId, instructions: instructions || '', ...(taskId ? { taskId } : {}) },
    });
    this.bus.emit(groupId, { type: 'message.added', message: requestMessage });
    this.enqueueJob({
      groupId,
      conversationId,
      membershipId: reviewerMembershipId,
      kind: 'review',
      triggerSeq: requestMessage.seq,
      triggerMessageId: requestMessage.messageId,
      reviewTargetId: targetMessageId,
      instructions: instructions || '',
      messageKind: 'review',
      meta: { reviewOf: targetMessageId, reviewerMembershipId, instructions: instructions || '', ...(taskId ? { taskId } : {}) },
    });
    return { requestMessage, reviewer: reviewer.name };
  }

  requestRevision({ groupId, reviewMessageId, expectedConversationId }) {
    const conversationId = this.admitConversation(groupId, expectedConversationId);
    const review = this.repo.messages.get(reviewMessageId);
    if (!review || review.groupId !== groupId) throw Object.assign(new Error('评审消息不存在'), { code: 'not-found' });
    this.assertCurrentTarget(groupId, review);
    const targetId = review.meta && review.meta.reviewOf;
    const target = targetId ? this.repo.messages.get(targetId) : undefined;
    if (!target) throw Object.assign(new Error('找不到被评审的原消息'), { code: 'not-found' });
    this.assertCurrentTarget(groupId, target);
    const membershipId = target.author && target.author.membershipId;
    if (!membershipId || target.author.type !== 'bot') {
      throw Object.assign(new Error('只有 Bot 的消息可以要求作者修改'), { code: 'invalid-input' });
    }
    const member = this.repo.getMember(membershipId);
    const bot = member ? this.repo.getBot(member.botId) : undefined;
    if (!member || !bot) throw Object.assign(new Error('原消息作者已不在群里'), { code: 'not-found' });
    this.assertQuota(groupId);
    const reviewerName = this.authorNameOf(review);
    const requestMessage = this.createMessage({
      groupId,
      author: { type: 'system', name: '系统' },
      text: `请 @${bot.name} 根据 #${review.seq} 的评审意见修改 #${target.seq}`,
      kind: 'revision',
      status: 'done',
      mentions: [membershipId],
      replyTo: reviewMessageId,
      meta: { reviewOf: reviewMessageId, revisionOf: target.messageId, reviewerName },
    });
    this.bus.emit(groupId, { type: 'message.added', message: requestMessage });
    this.enqueueJob({
      groupId,
      conversationId,
      membershipId,
      kind: 'revision',
      triggerSeq: requestMessage.seq,
      triggerMessageId: requestMessage.messageId,
      reviewMessageId,
      messageKind: 'revision',
      meta: { reviewOf: reviewMessageId, revisionOf: target.messageId, reviewerName },
    });
    return { requestMessage, author: bot.name };
  }

  retryMessage(messageId, expectedConversationId) {
    const message = this.repo.messages.get(messageId);
    if (!message) throw Object.assign(new Error('消息不存在'), { code: 'not-found' });
    const conversationId = this.admitConversation(message.groupId, expectedConversationId);
    this.assertCurrentTarget(message.groupId, message);
    if (message.author?.type !== 'bot') throw Object.assign(new Error('只能重试 Bot 的回复'), { code: 'invalid-input' });
    const member = this.repo.getMember(message.author.membershipId);
    if (!member) throw Object.assign(new Error('该 Bot 已不在群里'), { code: 'not-found' });
    this.assertQuota(message.groupId);
    const meta = message.meta || {};
    if (message.kind === 'discussion') {
      throw Object.assign(new Error('讨论消息不支持单条重试，请重新发起讨论'), { code: 'invalid-input' });
    }
    if (message.kind === 'review' && meta.reviewOf) {
      return this.enqueueJob({
        groupId: message.groupId,
        conversationId,
        membershipId: member.membershipId,
        kind: 'review',
        triggerSeq: message.seq,
        triggerMessageId: message.replyTo || message.messageId,
        reviewTargetId: meta.reviewOf,
        instructions: meta.instructions || '',
        messageKind: 'review',
        meta: { ...meta, retryOf: message.messageId },
      });
    }
    if (message.kind === 'revision' && meta.reviewOf) {
      return this.enqueueJob({
        groupId: message.groupId,
        conversationId,
        membershipId: member.membershipId,
        kind: 'revision',
        triggerSeq: message.seq,
        triggerMessageId: message.replyTo || message.messageId,
        reviewMessageId: meta.reviewOf,
        messageKind: 'revision',
        meta: { ...meta, retryOf: message.messageId },
      });
    }
    return this.enqueueJob({
      groupId: message.groupId,
      conversationId,
      membershipId: member.membershipId,
      kind: 'chat',
      triggerSeq: message.seq,
      triggerMessageId: message.replyTo || message.messageId,
      messageKind: 'chat',
      meta: { ...meta, retryOf: message.messageId },
    });
  }

  // ── M2: multi-round discussion ──────────────────────────────────────────
  async startDiscussion(input) {
    return this.discussionRunner.start(input);
  }

  async controlDiscussion(input) {
    const discussion = this.repo.getDiscussion(input.discussionId);
    if (!discussion) throw Object.assign(new Error('讨论不存在'), { code: 'not-found' });
    if (discussion.protocolVersion === 2) return this.discussionRunner.control(input);
    this.admitConversation(discussion.groupId, input.expectedConversationId);
    this.assertCurrentTarget(discussion.groupId, discussion);
    if (input.operation !== 'stop') throw Object.assign(new Error('旧版讨论只支持停止，请新建讨论以使用步骤控制'), { code: 'invalid-input' });
    await this.stopDiscussion(input.discussionId);
    return this.repo.getDiscussion(input.discussionId);
  }

  scheduleDiscussion(discussionId) {
    if (this.disposed) return;
    const discussion = this.repo.getDiscussion(discussionId);
    if (discussion?.protocolVersion === 2) {
      if (!this.isCurrentRecord(discussion) || !['running', 'finalizing'].includes(discussion.status)) return;
      return this.discussionRunner.schedule(discussionId);
    }
    if (!discussion || discussion.status !== 'running' || !this.isCurrentRecord(discussion)) return;
    try {
      this.assertQuota(discussion.groupId);
    } catch (error) {
      this.stopDiscussionInternal(discussion, 'quota', String(error && error.message ? error.message : error));
      return;
    }
    if ((discussion.currentRound ?? 1) > discussion.rounds) {
      if (discussion.summarize && !discussion.summaryStarted) {
        discussion.summaryStarted = true;
        discussion.currentSpeaker = discussion.memberIds[0];
        this.repo.putDiscussion(discussion);
        this.bus.emit(discussion.groupId, { type: 'discussion.updated', discussion });
        this.enqueueJob({
          groupId: discussion.groupId,
          conversationId: conversationIdOf(this.repo, discussion),
          membershipId: discussion.memberIds[0],
          kind: 'summary',
          discussionId,
          round: discussion.rounds,
          triggerSeq: this.repo.lastMessageOf(discussion.groupId)?.seq ?? discussion.startSeq,
          triggerMessageId: discussion.startMessageId,
          messageKind: 'discussion',
          meta: { discussionId, summary: true },
        });
        return;
      }
      discussion.status = 'done';
      discussion.currentSpeaker = null;
      discussion.updatedAt = now();
      this.repo.putDiscussion(discussion);
      this.bus.emit(discussion.groupId, { type: 'discussion.updated', discussion });
      this.systemMessage(discussion.groupId, `讨论「${discussion.topic}」结束。`);
      this.settleDiscussionWaiters(discussionId);
      return;
    }
    const membershipId = discussion.memberIds[discussion.currentIndex];
    const member = membershipId ? this.repo.getMember(membershipId) : undefined;
    if (!member || member.enabled === false) {
      discussion.currentIndex = (discussion.currentIndex ?? 0) + 1;
      if (discussion.currentIndex >= discussion.memberIds.length) {
        discussion.currentRound = (discussion.currentRound ?? 1) + 1;
        discussion.currentIndex = 0;
      }
      this.repo.putDiscussion(discussion);
      this.bus.emit(discussion.groupId, { type: 'discussion.updated', discussion });
      setTimeout(() => this.scheduleDiscussion(discussionId), 0);
      return;
    }
    discussion.currentSpeaker = membershipId;
    this.repo.putDiscussion(discussion);
    this.bus.emit(discussion.groupId, { type: 'discussion.updated', discussion });
    this.enqueueJob({
      groupId: discussion.groupId,
      conversationId: conversationIdOf(this.repo, discussion),
      membershipId,
      kind: 'discussion',
      discussionId,
      round: discussion.currentRound,
      triggerSeq: this.repo.lastMessageOf(discussion.groupId)?.seq ?? discussion.startSeq,
      triggerMessageId: discussion.startMessageId,
      messageKind: 'discussion',
      meta: { discussionId, round: discussion.currentRound, speaker: membershipId },
    });
    this.checkIdle(discussion.groupId);
  }

  stopDiscussionInternal(discussion, reason, message) {
    if (!discussion || discussion.status !== 'running' || !this.isCurrentRecord(discussion)) return;
    discussion.status = 'stopped';
    discussion.stopReason = reason;
    discussion.currentSpeaker = null;
    this.repo.putDiscussion(discussion);
    this.bus.emit(discussion.groupId, { type: 'discussion.updated', discussion });
    this.systemMessage(discussion.groupId, '讨论「' + discussion.topic + '」已停止：' + message);
    this.queue = this.queue.filter((queued) => queued.discussionId !== discussion.discussionId);
    for (const job of [...this.running.values()]) {
      if (job.discussionId === discussion.discussionId && !job.finished) this.abortJob(job, 'user');
    }
    this.settleDiscussionWaiters(discussion.discussionId);
  }

  stopDiscussion(discussionId) {
    const discussion = this.repo.getDiscussion(discussionId);
    if (!discussion) throw Object.assign(new Error('讨论不存在'), { code: 'not-found' });
    this.admitConversation(discussion.groupId);
    this.assertCurrentTarget(discussion.groupId, discussion);
    if (discussion.protocolVersion === 2) {
      const stopped = isDiscussionActive(discussion);
      return this.controlDiscussion({ discussionId, operation: 'stop', expectedConversationId: discussion.conversationId })
        .then(() => ({ stopped }));
    }
    if (discussion.status !== 'running') return { stopped: false };
    discussion.status = 'stopped';
    discussion.stopReason = 'user';
    discussion.currentSpeaker = null;
    this.repo.putDiscussion(discussion);
    this.bus.emit(discussion.groupId, { type: 'discussion.updated', discussion });
    this.systemMessage(discussion.groupId, `讨论「${discussion.topic}」已停止。`);
    const keep = [];
    for (const queued of this.queue) {
      if (queued.discussionId === discussionId) {
        this.bus.emit(discussion.groupId, {
          type: 'member.status',
          membershipId: queued.membershipId,
          status: 'idle',
        });
      } else {
        keep.push(queued);
      }
    }
    this.queue = keep;
    for (const job of [...this.running.values()]) {
      if (job.discussionId === discussionId && !job.finished) this.abortJob(job, 'user');
    }
    this.settleDiscussionWaiters(discussionId);
    return { stopped: true };
  }

  discussionTranscript(discussion) {
    return this.repo.messagesOf(discussion.groupId).filter(
      (message) =>
        this.isCurrentRecord(message, discussion.groupId) &&
        conversationIdOf(this.repo, message) === conversationIdOf(this.repo, discussion) &&
        message.meta &&
        message.meta.discussionId === discussion.discussionId &&
        message.author &&
        message.author.type === 'bot' &&
        (message.status === 'done' || message.status === 'error') &&
        String(message.text || '').trim().length > 0,
    );
  }

  settleDiscussionWaiters(discussionId) {
    const waiters = this.discussionWaiters.get(discussionId);
    if (!waiters || waiters.length === 0) return;
    this.discussionWaiters.delete(discussionId);
    for (const entry of waiters) {
      clearTimeout(entry.timer);
      entry.resolve(true);
    }
  }

  whenDiscussionSettled(discussionId, timeoutMs = 600000) {
    const discussion = this.repo.getDiscussion(discussionId);
    if (!discussion || !isDiscussionActive(discussion) || discussion.status === 'paused') return Promise.resolve(true);
    return new Promise((resolve) => {
      const entry = { resolve, timer: setTimeout(() => resolve(false), timeoutMs) };
      const list = this.discussionWaiters.get(discussionId) ?? [];
      list.push(entry);
      this.discussionWaiters.set(discussionId, list);
    });
  }

  buildPrompt(job, bot, context) {
    this.assertJobCurrent(job);
    this.assertJobTargets(job);
    context = context.filter(message => this.isCurrentRecord(message, job.groupId) && message.seq > conversationFloor(this.repo, job.groupId));
    if (job.promptText) return job.promptText;
    if (job.kind === 'task') {
      const task = job.meta && job.meta.taskId ? this.repo.getTask(job.meta.taskId) : undefined;
      return buildTaskPrompt({
        repo: this.repo,
        botId: bot.botId,
        groupId: job.groupId,
        task: task || { title: '（任务已删除）', description: '', acceptance: '' },
        contextMessages: context,
      });
    }
    if (job.kind === 'task_revision') {
      const task = job.meta && job.meta.taskId ? this.repo.getTask(job.meta.taskId) : undefined;
      const review = task && task.reviewReplyMessageId ? this.repo.messages.get(task.reviewReplyMessageId) : undefined;
      return buildTaskRevisionPrompt({
        repo: this.repo,
        botId: bot.botId,
        groupId: job.groupId,
        task: task || { title: '（任务已删除）', deliverableMessageId: null, acceptance: '' },
        reviewMessage: review,
        contextMessages: context,
      });
    }
    if (job.kind === 'review') {
      const target = this.repo.messages.get(job.reviewTargetId);
      const requester = this.repo.messages.get(job.triggerMessageId);
      return buildReviewPrompt({
        repo: this.repo,
        botId: bot.botId,
        groupId: job.groupId,
        targetMessage: target,
        requesterName: requester ? this.authorNameOf(requester) : '用户',
        instructions: job.instructions || '',
        contextMessages: context,
      });
    }
    if (job.kind === 'revision') {
      const review = this.repo.messages.get(job.reviewMessageId);
      const target = review && review.meta && review.meta.reviewOf
        ? this.repo.messages.get(review.meta.reviewOf)
        : undefined;
      return buildRevisionPrompt({
        repo: this.repo,
        botId: bot.botId,
        groupId: job.groupId,
        targetMessage: target,
        reviewMessage: review,
        reviewerName: this.authorNameOf(review),
        contextMessages: context,
      });
    }
    if (job.kind === 'discussion') {
      const discussion = this.repo.getDiscussion(job.discussionId);
      return buildDiscussionPrompt({
        repo: this.repo,
        botId: bot.botId,
        groupId: job.groupId,
        discussion: discussion || { topic: '（已删除的讨论）', rounds: job.round ?? 1 },
        round: job.round ?? 1,
        transcript: discussion ? this.discussionTranscript(discussion) : [],
      });
    }
    if (job.kind === 'summary') {
      const discussion = this.repo.getDiscussion(job.discussionId);
      return buildSummaryPrompt({
        repo: this.repo,
        botId: bot.botId,
        groupId: job.groupId,
        discussion: discussion || { topic: '（已删除的讨论）', rounds: job.round ?? 1 },
        transcript: discussion ? this.discussionTranscript(discussion) : [],
      });
    }
    return buildTurnPrompt({
      repo: this.repo,
      botId: bot.botId,
      groupId: job.groupId,
      contextMessages: context,
      triggeredByMessageId: job.triggerMessageId,
      mention: true,
    });
  }

  /** Interrupt every running/queued turn that belongs to one task. */
  cancelTaskRun(taskId) {
    let aborted = 0;
    let dequeued = 0;
    const groups = new Set();
    for (const job of [...this.running.values()]) {
      if (!job.finished && job.meta && job.meta.taskId === taskId) {
        groups.add(job.groupId);
        this.abortJob(job, 'user');
        aborted += 1;
      }
    }
    const kept = [];
    for (const queued of this.queue) {
      if (queued.meta && queued.meta.taskId === taskId) {
        groups.add(queued.groupId);
        dequeued += 1;
      } else {
        kept.push(queued);
      }
    }
    this.queue = kept;
    for (const groupId of groups) this.pump(groupId);
    return { aborted, dequeued };
  }

  stopMember(membershipId) {
    const job = this.running.get(membershipId);
    const affected = new Set([job?.groupId, ...this.queue.filter(item => item.membershipId === membershipId).map(item => item.groupId)].filter(Boolean));
    for (const groupId of affected) this.pumpBlocks.add(groupId);
    let stopped = 0;
    const discussions = new Set([job?.discussionId, ...this.queue.filter(item => item.membershipId === membershipId).map(item => item.discussionId)].filter(Boolean));
    for (const id of discussions) {
      const discussion = this.repo.getDiscussion(id);
      if (discussion?.protocolVersion === 2) void this.discussionRunner.interrupt(id).catch(error => this.discussionRunner.failed(id, error));
    }
    // Drain first: abortJob -> finishJob may synchronously pump another job.
    this.queue = this.queue.filter(queued => {
      if (queued.membershipId !== membershipId) return true;
      stopped += 1;
      this.bus.emit(queued.groupId, { type: 'member.status', membershipId, status: 'idle' });
      return false;
    });
    if (job && !job.finished) { this.abortJob(job, 'user'); stopped += 1; }
    for (const groupId of affected) { this.pumpBlocks.delete(groupId); this.pump(groupId); this.checkIdle(groupId); }
    return { stopped };
  }

  stopGroup(groupId) {
    this.pumpBlocks.add(groupId);
    let stopped = 0;
    // Close all discussion schedulers before clearing queues or cancelling jobs.
    for (const discussion of this.repo.discussionsOf(groupId)) {
      if (!isDiscussionActive(discussion) || !this.isCurrentRecord(discussion, groupId)) continue;
      if (discussion.protocolVersion === 2) {
        void this.discussionRunner.interrupt(discussion.discussionId, { stop: true }).catch(error => this.discussionRunner.failed(discussion.discussionId, error));
      } else {
        discussion.status = 'stopped'; discussion.stopReason = 'user'; discussion.currentSpeaker = null;
        this.repo.putDiscussion(discussion);
        this.bus.emit(groupId, { type: 'discussion.updated', discussion });
        this.settleDiscussionWaiters(discussion.discussionId);
      }
    }
    this.queue = this.queue.filter(job => {
      if (job.groupId !== groupId) return true;
      stopped += 1;
      this.bus.emit(groupId, { type: 'member.status', membershipId: job.membershipId, status: 'idle' });
      return false;
    });
    for (const job of [...this.running.values()]) {
      if (job.groupId !== groupId || job.finished) continue;
      this.abortJob(job, 'user'); stopped += 1;
    }
    this.pumpBlocks.delete(groupId);
    this.checkIdle(groupId);
    return { stopped };
  }

  checkIdle(groupId) {
    if (this.runningCount(groupId) > 0 || this.queuedCount(groupId) > 0) return;
    const waiters = this.waiters.get(groupId);
    if (!waiters || waiters.length === 0) return;
    this.waiters.delete(groupId);
    for (const entry of waiters) {
      clearTimeout(entry.timer);
      entry.resolve(true);
    }
  }

  whenIdle(groupId, timeoutMs = 180000) {
    if (this.runningCount(groupId) === 0 && this.queuedCount(groupId) === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const entry = { resolve, timer: setTimeout(() => resolve(false), timeoutMs) };
      const list = this.waiters.get(groupId) ?? [];
      list.push(entry);
      this.waiters.set(groupId, list);
    });
  }

  hasPendingWork(groupId) {
    return [...this.pendingWork].some((operation) => operation.groupId === groupId);
  }

  isRunning(groupId) {
    return this.runningCount(groupId) > 0 || this.queuedCount(groupId) > 0;
  }

  async dispose() {
    this.disposed = true;
    try {
      this.offSession?.();
      this.offClaim?.();
      this.offGoal?.();
    } catch {
      /* noop */
    }
    this.queue = [];
    for (const job of [...this.running.values()]) {
      try {
        this.abortJob(job, 'dispose');
      } catch {
        /* noop */
      }
    }
    for (const [groupId, waiters] of this.waiters) {
      for (const entry of waiters) {
        clearTimeout(entry.timer);
        entry.resolve(false);
      }
      this.waiters.delete(groupId);
    }
    for (const [discussionId, waiters] of this.discussionWaiters) {
      for (const entry of waiters) {
        clearTimeout(entry.timer);
        entry.resolve(false);
      }
      this.discussionWaiters.delete(discussionId);
    }
    // Give aborted turns a short window to settle before agents are disposed.
    await withTimeout(Promise.resolve(), 500, true);
  }
}
