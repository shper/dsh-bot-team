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
import { LastRequestMetrics } from './message-metrics.js';

const executionSeq = (value) => Number.isSafeInteger(value) && value >= 0;
const executionTurn = (value) => Number.isSafeInteger(value) && value > 0;
const executionEvent = (type) => /^(?:turn|step|user|assistant|tool|tools|ptc|approval|llm|request|compaction)\//.test(type);

export class Engine {
  constructor({ ctx, repo, pool, personas, bus, config, logger, quotaGuard, taskHook }) {
    this.ctx = ctx;
    this.repo = repo;
    this.pool = pool;
    this.personas = personas;
    this.bus = bus;
    this.config = config;
    this.logger = logger;
    this.quotaGuard = quotaGuard || (() => ({ ok: true }));
    this.taskHook = taskHook || (() => {});

    this.queue = [];
    this.running = new Map(); // membershipId -> job
    this.activeBySession = new Map(); // sessionId -> job
    this.waiters = new Map(); // groupId -> [{ resolve }]
    this.discussionWaiters = new Map(); // discussionId -> [{ resolve }]
    this.disposed = false;

    this.offSession = ctx.on('session/event', (session, event) => this.onSessionEvent(session, event));
    this.offClaim = pool.attachClaimHandler?.((payload) => this.onInboxClaim(payload));
  }

  // ── message helpers ──────────────────────────────────────────────────────
  createMessage(fields) {
    const seq = this.repo.allocateSeq(fields.groupId);
    const message = {
      messageId: newId('msg'),
      groupId: fields.groupId,
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
    const member = this.repo.getMember(job.membershipId);
    const bot = member ? this.repo.getBot(member.botId) : undefined;
    const name = bot?.name || 'Bot';
    const reason = typeof data.reason === 'string' ? data.reason.trim() : '';
    const text = `${name} 请求权限：工具 ${data.toolName}${reason ? `（${reason}）` : ''}。`;
    const message = this.createMessage({
      groupId: job.groupId,
      author: { type: 'system', name: '审批' },
      text,
      status: 'done',
      kind: 'approval',
      meta: {
        approvalId: String(data.id || ''),
        membershipId: job.membershipId,
        botId: member?.botId ?? null,
        sessionId: job.sessionId,
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
  assertQuota(groupId, turns = 1) {
    const result = this.quotaGuard(groupId, turns);
    if (!result || result.ok) return;
    const error = new Error(result.reason || '本群额度已用完，请稍后再试');
    error.code = 'quota';
    throw error;
  }

  postHumanMessage({ groupId, text, mentions, author, replyTo, attachments }) {
    const group = this.repo.getGroup(groupId);
    if (!group) throw new Error(`group ${groupId} does not exist`);
    let replyToId = null;
    if (replyTo) {
      const target = this.repo.getMessage(replyTo);
      if (!target || target.groupId !== groupId) {
        throw Object.assign(new Error('回复的原消息不存在或不属于本群'), { code: 'invalid-input' });
      }
      replyToId = target.messageId;
    }
    const message = this.createMessage({
      groupId,
      author: author || { type: 'human', name: '用户' },
      text,
      mentions,
      attachments,
      replyTo: replyToId,
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
    if (targets.length > 0) this.assertQuota(groupId, targets.length);
    for (const member of targets) {
      this.queue.push({
        jobId: newId('job'),
        groupId,
        membershipId: member.membershipId,
        triggerSeq: message.seq,
        triggerMessageId: message.messageId,
        kind: 'chat',
        state: 'queued',
      });
    }
    for (const member of targets) this.pump(groupId);
    return { message, accepted: targets.map((member) => member.membershipId) };
  }

  pump(groupId) {
    if (this.disposed) return;
    const runnable = [];
    const busy = new Set(
      [...this.running.values()].filter((job) => job.groupId === groupId).map((job) => job.membershipId),
    );
    let running = this.runningCount(groupId);
    for (const job of this.queue) {
      if (job.groupId !== groupId) continue;
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

  startJob(job) {
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
    const placeholder = this.createMessage({
      groupId: job.groupId,
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
    this.bus.emit(job.groupId, { type: 'message.added', message: placeholder });
    this.bus.emit(job.groupId, {
      type: 'member.status',
      membershipId: member.membershipId,
      status: 'running',
    });

    const previousSeen = Number.isInteger(member.lastSeenSeq) ? member.lastSeenSeq : 0;
    const context = this.repo
      .messagesBetween(job.groupId, previousSeen, job.triggerSeq)
      .filter((message) => message.messageId !== placeholder.messageId);
    member.lastSeenSeq = job.triggerSeq;
    this.repo.touchMember(member);
    job.context = context;

    job.timer = setTimeout(() => this.abortJob(job, 'timeout'), this.config.turnTimeoutMs);
    void this.runJob(job, member, bot, context);
  }

  async runJob(job, member, bot, context) {
    try {
      const agent = await this.pool.ensure(member.membershipId);
      if (job.finished) return;
      if (this.disposed || job.state === 'stopped') {
        this.finishJob(job, 'stopped', '已停止');
        return;
      }
      job.sessionId = agent.id;
      this.activeBySession.set(agent.id, job);
      await this.persistExecution(job, { sessionId: agent.id });
      if (job.finished) return;

      try {
        await this.personas.refresh(bot.botId);
      } catch (error) {
        this.logger?.warn?.(`bot-team: refresh persona ${bot.botId} failed: ${String(error)}`);
      }

      if (job.finished) return;
      const prompt = this.buildPrompt(job, bot, context);
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

      // M0 P1: followup puts the EXACT value into the durable inbox — it must be
      // a complete UserMessage (role + id + content + source). Claims may fire
      // synchronously, so arm correlation only after the write has succeeded.
      job.submitted = true;
      await agent.followup({
        role: 'user',
        id: inputMessageId,
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      });
      await job.done;
    } catch (error) {
      this.finishJob(job, 'error', String(error && error.message ? error.message : error));
    } finally {
      if (job.timer) clearTimeout(job.timer);
    }
  }

  emitExecutionUpdated(job, seq, includeExecution = false) {
    this.bus.emit(job.groupId, {
      type: 'execution.updated',
      messageId: job.placeholderId,
      seq: executionSeq(seq) ? seq : null,
      ...(includeExecution ? { execution: { ...job.execution } } : {}),
    });
  }

  async persistExecution(job, patch, seq = null) {
    const message = this.repo.messages.get(job.placeholderId);
    if (!message) throw new Error('无法保存执行记录：回复消息不存在');
    job.execution = { ...job.execution, ...patch };
    message.meta = { ...(message.meta || {}), execution: job.execution };
    message.updatedAt = now();
    // Do not use putMessage here: it deliberately swallows storage failures.
    const saved = this.repo.putMessageStrict(message);
    this.emitExecutionUpdated(job, seq, true);
    await saved;
  }

  executionFailed(job, error) {
    if (job.finished) return;
    this.finishJob(job, 'error', `无法保存执行记录：${String(error?.message || error)}`);
    if (job.submitted && job.execution.endSeq === null) {
      try {
        this.ctx.agents.get(job.sessionId)?.cancel?.({ kind: 'user' }, { keepInbox: false });
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
    if (!job || job.finished || job.ending || !job.submitted) return;
    if (!job.execution.inputMessageId || payload.message?.id !== job.execution.inputMessageId) return;
    this.bindExecutionTurn(job, payload.turn);
  }

  onSessionEvent(session, event) {
    if (!session || !event) return;
    const job = this.activeBySession.get(session.id);
    if (!job || job.finished || job.ending) return;
    const data = event.data || {};
    const correlated = Boolean(job.execution.inputMessageId);
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
      if ((data.id ?? data.message?.id) !== job.execution.inputMessageId) return;
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
          messageId: job.placeholderId,
          text: combined,
        });
      }
      return;
    }
    if (event.type === 'turn/end' && data.turn === job.turn) this.finishTurn(job, data.reason);
  }

  finishTurn(job, reason = {}) {
    if (reason.kind === 'completed') {
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
    const job = this.activeBySession.get(payload.agent.id);
    if (!job || job.finished || job.ending || job.turn === null || job.observedTurn !== job.turn) return;
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
        messageId: job.placeholderId,
        chunk: frame.chunk.text,
      });
    }
  }

  abortJob(job, cause) {
    if (!job || job.finished) return;
    job.state = 'stopped';
    try {
      job.abortController?.abort();
    } catch {
      /* noop */
    }
    const agent = job.sessionId ? this.ctx.agents.get(job.sessionId) : undefined;
    if (agent && typeof agent.cancel === 'function') {
      try {
        agent.cancel({ kind: 'user' }, { keepInbox: false });
      } catch (error) {
        this.logger?.warn?.(`bot-team: cancel agent failed: ${String(error)}`);
      }
    }
    const reason = cause === 'timeout' ? '本轮超时，已停止' : cause === 'dispose' ? '插件已卸载' : '已停止';
    this.finishJob(job, 'stopped', reason);
  }

  finishJob(job, status, error) {
    if (!job || job.finished) return;
    job.finished = true;
    job.state = status;
    if (job.timer) clearTimeout(job.timer);
    if (job.sessionId) this.activeBySession.delete(job.sessionId);
    this.running.delete(job.membershipId);

    const text = (job.steps.filter(Boolean).join('\n\n') || job.streamText || '').trim();
    const message = job.placeholderId ? this.repo.messages.get(job.placeholderId) : undefined;
    if (message) {
      message.text = text;
      message.status = status;
      message.error = error ?? null;
      message.usage = job.usage ?? null;
      message.generationStats = job.requestMetrics?.finish(status) ?? null;
      message.kind = job.messageKind ?? message.kind ?? 'chat';
      const meta = { ...(message.meta || {}), ...(job.meta || {}), execution: job.execution };
      if (job.kind === 'review' && status === 'done') {
        const verdict = parseReviewVerdict(text);
        if (verdict) meta.verdict = verdict;
      }
      if (Object.keys(meta).length > 0) message.meta = meta;
      message.updatedAt = now();
      this.repo.putMessage(message);
      this.bus.emit(job.groupId, { type: 'message.updated', message });
      // The accepted end event may have invalidated before this final status.
      // A null seq also refreshes stopped jobs and bypasses event deduplication.
      this.emitExecutionUpdated(job, null, true);
    }
    if (job.approvalMessages && job.approvalMessages.size > 0) {
      for (const approvalId of [...job.approvalMessages.keys()]) {
        this.settleApproval(job, approvalId, 'cancelled');
      }
    }
    this.bus.emit(job.groupId, {
      type: 'member.status',
      membershipId: job.membershipId,
      status: status === 'done' ? 'idle' : status === 'stopped' ? 'idle' : 'error',
      ...(status === 'error' ? { error: error ?? '未知错误' } : {}),
    });
    try {
      const hookResult = this.taskHook(job, message, status);
      if (hookResult && typeof hookResult.then === 'function') {
        hookResult.catch((hookError) => {
          this.logger?.warn?.('bot-team: task hook failed: ' + String(hookError));
        });
      }
    } catch (hookError) {
      this.logger?.warn?.('bot-team: task hook failed: ' + String(hookError));
    }
    job.resolveDone?.();
    job.state = status;
    this.pump(job.groupId);
    this.afterJobFinished(job);
    this.checkIdle(job.groupId);
  }

  /** Discussion bookkeeping + review-side effects after one job settles. */
  afterJobFinished(job) {
    if (!job) return;
    if (job.kind === 'discussion' && job.discussionId) {
      this.advanceDiscussion(job.discussionId, job.state === 'done');
      return;
    }
    if (job.kind === 'summary' && job.discussionId) {
      const discussion = this.repo.getDiscussion(job.discussionId);
      if (discussion && discussion.status === 'running') {
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
    if (!discussion || discussion.status !== 'running') return;
    if (!ok) {
      discussion.status = 'stopped';
      discussion.stopReason = 'member-error';
      discussion.updatedAt = now();
      this.repo.putDiscussion(discussion);
      this.bus.emit(discussion.groupId, { type: 'discussion.updated', discussion });
      this.systemMessage(discussion.groupId, `讨论「${discussion.topic}」因成员执行失败而停止。`);
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
  enqueueTaskTurn({ taskId, phase }) {
    const task = this.repo.getTask(taskId);
    if (!task) throw Object.assign(new Error('任务不存在'), { code: 'not-found' });
    const group = this.repo.getGroup(task.groupId);
    if (!group) throw Object.assign(new Error('任务所在群不存在'), { code: 'not-found' });
    const triggerSeq = this.repo.lastMessageOf(task.groupId)?.seq ?? 0;
    this.enqueueJob({
      groupId: task.groupId,
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
    const job = {
      jobId: newId('job'),
      state: 'queued',
      ...spec,
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

  requestReview({ groupId, targetMessageId, reviewerMembershipId, instructions, taskId }) {
    const target = this.repo.messages.get(targetMessageId);
    if (!target || target.groupId !== groupId) throw Object.assign(new Error('待评审消息不存在'), { code: 'not-found' });
    const member = this.repo.getMember(reviewerMembershipId);
    if (!member || member.groupId !== groupId) throw Object.assign(new Error('评审者不在群里'), { code: 'invalid-input' });
    const reviewer = this.repo.getBot(member.botId);
    if (!reviewer) throw Object.assign(new Error('评审者 Bot 不存在'), { code: 'not-found' });
    this.assertQuota(groupId, 1);
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

  requestRevision({ groupId, reviewMessageId }) {
    const review = this.repo.messages.get(reviewMessageId);
    if (!review || review.groupId !== groupId) throw Object.assign(new Error('评审消息不存在'), { code: 'not-found' });
    const targetId = review.meta && review.meta.reviewOf;
    const target = targetId ? this.repo.messages.get(targetId) : undefined;
    if (!target) throw Object.assign(new Error('找不到被评审的原消息'), { code: 'not-found' });
    const membershipId = target.author && target.author.membershipId;
    if (!membershipId || target.author.type !== 'bot') {
      throw Object.assign(new Error('只有 Bot 的消息可以要求作者修改'), { code: 'invalid-input' });
    }
    const member = this.repo.getMember(membershipId);
    const bot = member ? this.repo.getBot(member.botId) : undefined;
    if (!member || !bot) throw Object.assign(new Error('原消息作者已不在群里'), { code: 'not-found' });
    this.assertQuota(groupId, 1);
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

  retryMessage(messageId) {
    const message = this.repo.messages.get(messageId);
    if (!message) throw Object.assign(new Error('消息不存在'), { code: 'not-found' });
    if (message.author?.type !== 'bot') throw Object.assign(new Error('只能重试 Bot 的回复'), { code: 'invalid-input' });
    const member = this.repo.getMember(message.author.membershipId);
    if (!member) throw Object.assign(new Error('该 Bot 已不在群里'), { code: 'not-found' });
    this.assertQuota(message.groupId, 1);
    const meta = message.meta || {};
    if (message.kind === 'discussion') {
      throw Object.assign(new Error('讨论消息不支持单条重试，请重新发起讨论'), { code: 'invalid-input' });
    }
    if (message.kind === 'review' && meta.reviewOf) {
      return this.enqueueJob({
        groupId: message.groupId,
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
      membershipId: member.membershipId,
      kind: 'chat',
      triggerSeq: message.seq,
      triggerMessageId: message.replyTo || message.messageId,
      messageKind: 'chat',
      meta: { ...meta, retryOf: message.messageId },
    });
  }

  // ── M2: multi-round discussion ──────────────────────────────────────────
  async startDiscussion({ groupId, topic, membershipIds, rounds, summarize }) {
    const group = this.repo.getGroup(groupId);
    if (!group) throw Object.assign(new Error('群不存在'), { code: 'not-found' });
    if (this.repo.activeDiscussionOf(groupId)) {
      throw Object.assign(new Error('该群已有进行中的讨论，请先停止或等待结束'), { code: 'conflict' });
    }
    const members = [];
    for (const membershipId of membershipIds) {
      const member = this.repo.getMember(membershipId);
      if (member && member.groupId === groupId && member.enabled !== false && this.repo.getBot(member.botId)) {
        members.push(member.membershipId);
      }
    }
    if (members.length === 0) throw Object.assign(new Error('请选择至少一个讨论成员'), { code: 'invalid-input' });
    this.assertQuota(groupId, members.length);
    const discussion = {
      discussionId: newId('dsc'),
      groupId,
      topic,
      memberIds: members,
      rounds,
      currentRound: 1,
      currentIndex: 0,
      currentSpeaker: members[0],
      summarize: summarize === true,
      summaryStarted: false,
      status: 'running',
      startSeq: 0,
      startMessageId: null,
      createdAt: now(),
      updatedAt: now(),
    };
    const startMessage = this.createMessage({
      groupId,
      author: { type: 'system', name: '系统' },
      text: `开始讨论：${topic}（${members.length} 位成员，共 ${rounds} 轮${summarize ? '，结束生成总结' : ''}）`,
      kind: 'discussion',
      status: 'done',
      meta: { discussionId: discussion.discussionId, event: 'start' },
    });
    discussion.startSeq = startMessage.seq;
    discussion.startMessageId = startMessage.messageId;
    await this.repo.putDiscussion(discussion);
    this.bus.emit(groupId, { type: 'message.added', message: startMessage });
    this.bus.emit(groupId, { type: 'discussion.updated', discussion });
    this.scheduleDiscussion(discussion.discussionId);
    return discussion;
  }

  scheduleDiscussion(discussionId) {
    if (this.disposed) return;
    const discussion = this.repo.getDiscussion(discussionId);
    if (!discussion || discussion.status !== 'running') return;
    try {
      this.assertQuota(discussion.groupId, 1);
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
    if (!discussion || discussion.status !== 'running') return;
    discussion.status = 'stopped';
    discussion.stopReason = reason;
    discussion.currentSpeaker = null;
    this.repo.putDiscussion(discussion);
    this.bus.emit(discussion.groupId, { type: 'discussion.updated', discussion });
    this.systemMessage(discussion.groupId, '讨论「' + discussion.topic + '」已停止：' + message);
    for (const job of [...this.running.values()]) {
      if (job.discussionId === discussion.discussionId && !job.finished) this.abortJob(job, 'user');
    }
    this.queue = this.queue.filter((queued) => queued.discussionId !== discussion.discussionId);
    this.settleDiscussionWaiters(discussion.discussionId);
  }

  stopDiscussion(discussionId) {
    const discussion = this.repo.getDiscussion(discussionId);
    if (!discussion) throw Object.assign(new Error('讨论不存在'), { code: 'not-found' });
    if (discussion.status !== 'running') return { stopped: false };
    discussion.status = 'stopped';
    discussion.stopReason = 'user';
    discussion.currentSpeaker = null;
    this.repo.putDiscussion(discussion);
    this.bus.emit(discussion.groupId, { type: 'discussion.updated', discussion });
    this.systemMessage(discussion.groupId, `讨论「${discussion.topic}」已停止。`);
    for (const job of [...this.running.values()]) {
      if (job.discussionId === discussionId && !job.finished) this.abortJob(job, 'user');
    }
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
    this.settleDiscussionWaiters(discussionId);
    return { stopped: true };
  }

  discussionTranscript(discussion) {
    return this.repo.messagesOf(discussion.groupId).filter(
      (message) =>
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
    if (!discussion || discussion.status !== 'running') return Promise.resolve(true);
    return new Promise((resolve) => {
      const entry = { resolve, timer: setTimeout(() => resolve(false), timeoutMs) };
      const list = this.discussionWaiters.get(discussionId) ?? [];
      list.push(entry);
      this.discussionWaiters.set(discussionId, list);
    });
  }

  buildPrompt(job, bot, context) {
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
    let stopped = 0;
    const job = this.running.get(membershipId);
    if (job && !job.finished) {
      this.abortJob(job, 'user');
      stopped += 1;
    }
    const keep = [];
    for (const queued of this.queue) {
      if (queued.membershipId === membershipId) {
        stopped += 1;
        this.bus.emit(queued.groupId, {
          type: 'member.status',
          membershipId: queued.membershipId,
          status: 'idle',
        });
      } else {
        keep.push(queued);
      }
    }
    this.queue = keep;
    return { stopped };
  }

  stopGroup(groupId) {
    let stopped = 0;
    // Stop running discussions first so their jobs do not advance afterwards.
    for (const discussion of this.repo.discussionsOf(groupId)) {
      if (discussion.status === 'running') {
        discussion.status = 'stopped';
        discussion.stopReason = 'user';
        discussion.currentSpeaker = null;
        this.repo.putDiscussion(discussion);
        this.bus.emit(groupId, { type: 'discussion.updated', discussion });
        this.settleDiscussionWaiters(discussion.discussionId);
        this.systemMessage(groupId, `讨论「${discussion.topic}」已停止。`);
      }
    }
    for (const job of [...this.running.values()]) {
      if (job.groupId !== groupId || job.finished) continue;
      this.abortJob(job, 'user');
      stopped += 1;
    }
    const keep = [];
    for (const job of this.queue) {
      if (job.groupId === groupId) {
        stopped += 1;
        this.bus.emit(groupId, {
          type: 'member.status',
          membershipId: job.membershipId,
          status: 'idle',
        });
      } else {
        keep.push(job);
      }
    }
    this.queue = keep;
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

  isRunning(groupId) {
    return this.runningCount(groupId) > 0 || this.queuedCount(groupId) > 0;
  }

  async dispose() {
    this.disposed = true;
    try {
      this.offSession?.();
      this.offClaim?.();
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
