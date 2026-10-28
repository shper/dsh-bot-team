/** Durable, serial step execution. Engine jobs may span several native turns. */
import { newId, now } from './util.js';
import { normalizeDiscussionInput, createDiscussionPlan, isDiscussionActive } from './discussion-flow.js';
import { buildDiscussionStepPrompt, parseDebateVerdict } from './prompt.js';
import { conversationIdOf } from './conversations.js';

const failure = (code, message) => Object.assign(new Error(message), { code });
const copy = value => structuredClone(value);
const finalPhases = new Set(['summary', 'closing', 'judgement']);
const terminal = record => record.status === 'done' || record.status === 'stopped';
const messageIds = job => [...new Set([...(job.previousReplies || []), job.placeholderId].filter(Boolean))];

export class DiscussionRunner {
  constructor(engine) {
    this.engine = engine;
    this.repo = engine.repo;
    this.chains = new Map();
    this.groupChains = new Map();
    this.closed = new Set();
  }

  serial(map, key, operation, groupId) {
    const pending = { groupId };
    this.engine.pendingWork.add(pending);
    const previous = map.get(key);
    let resolve, reject;
    const result = new Promise((done, fail) => { resolve = done; reject = fail; });
    const tail = result.catch(() => {});
    map.set(key, tail);
    if (previous) previous.then(operation).then(resolve, reject);
    else {
      try { Promise.resolve(operation()).then(resolve, reject); } catch (error) { reject(error); }
    }
    tail.then(() => {
      this.engine.pendingWork.delete(pending);
      if (map.get(key) === tail) map.delete(key);
      this.engine.checkIdle(groupId);
    });
    return result;
  }

  lock(id, operation) {
    return this.serial(this.chains, id, operation, this.repo.getDiscussion(id)?.groupId);
  }

  read(id) {
    const record = this.repo.getDiscussion(id);
    if (!record) throw failure('not-found', '讨论不存在');
    return copy(record);
  }

  async save(record) {
    record.revision = (record.revision || 0) + 1;
    record.updatedAt = now();
    await this.repo.putDiscussion(record);
    if (this.engine.isCurrentRecord(record)) this.engine.bus.emit(record.groupId, { type: 'discussion.updated', discussion: copy(record) });
    if (terminal(record) || record.status === 'paused') this.engine.settleDiscussionWaiters(record.discussionId);
    return record;
  }

  liveJobs(id) {
    return [...this.engine.running.values()].filter(job => job.discussionId === id && !job.finished);
  }

  queued(id) { return this.engine.queue.filter(job => job.discussionId === id); }

  snapshotContext(groupId, ids = []) {
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length || ids.length > 20) {
      throw failure('invalid-input', '引用消息列表无效（最多 20 条且不可重复）');
    }
    return ids.map(id => this.engine.captureQuote(groupId, id));
  }

  async ensureStartMessage(record) {
    const existing = this.repo.getMessage(record.startMessageId);
    if (existing && record.pauseReason !== 'start-error') return;
    const message = existing || this.engine.createMessage({
      groupId: record.groupId, conversationId: record.conversationId, author: { type: 'system', name: '系统' },
      text: (record.mode === 'debate' ? '开始辩论：' : '开始讨论：') + record.topic,
      kind: 'discussion', status: 'done', meta: { discussionId: record.discussionId, event: 'start', mode: record.mode },
    });
    await this.repo.putMessageStrict(message);
    this.engine.admitConversation(record.groupId, record.conversationId);
    record.startMessageId = message.messageId; record.startSeq = message.seq;
    if (!existing) this.engine.bus.emit(record.groupId, { type: 'message.added', message });
  }

  async start(input) {
    return this.serial(this.groupChains, input.groupId, async () => {
      const e = this.engine;
      const conversationId = e.admitConversation(input.groupId, input.expectedConversationId);
      const existing = this.repo.discussionsOf(input.groupId);
      if (input.requestId) {
        const previous = existing.find(record => record.startRequestId === input.requestId && e.isCurrentRecord(record));
        if (previous) return copy(previous);
      }
      if (existing.some(record => isDiscussionActive(record) && e.isCurrentRecord(record))) {
        throw failure('conflict', '该群已有进行中的讨论，请先停止或等待结束');
      }
      const config = normalizeDiscussionInput(this.repo, input);
      e.assertQuota(config.groupId);
      const contextSnapshots = this.snapshotContext(config.groupId, config.contextMessageIds);
      const steps = createDiscussionPlan(config);
      const record = {
        ...config, discussionId: newId('dsc'), conversationId, protocolVersion: 2,
        participants: config.participants.map(participant => ({ ...participant,
          sessionId: this.repo.getMember(participant.membershipId)?.sessionId || null })),
        status: 'running', steps, currentStepId: null, currentSpeaker: null,
        currentRound: 1, currentIndex: 0, phase: steps[0]?.phase || null, revision: 0,
        contextSnapshots, supplements: [], controlRequests: [], startRequestId: input.requestId || null,
        startSeq: 0, startMessageId: null, createdAt: now(), updatedAt: now(), partial: false,
      };
      const startMessage = e.createMessage({
        groupId: config.groupId, conversationId, author: { type: 'system', name: '系统' },
        text: (config.mode === 'debate' ? '开始辩论：' : '开始讨论：') + config.topic,
        kind: 'discussion', status: 'done', meta: { discussionId: record.discussionId, event: 'start', mode: config.mode },
      });
      record.startSeq = startMessage.seq;
      record.startMessageId = startMessage.messageId;
      try {
        await this.save(record);
        e.admitConversation(record.groupId, conversationId);
        await this.repo.putMessageStrict(startMessage);
        e.admitConversation(record.groupId, conversationId);
      } catch (error) {
        if (e.isCurrentRecord(record)) {
          record.status = 'paused'; record.pauseReason = 'start-error'; record.error = String(error?.message || error);
          try { await this.save(record); } catch (saveError) { e.logger?.warn?.('bot-team: failed to persist start recovery: ' + String(saveError)); }
        }
        throw error;
      }
      e.bus.emit(record.groupId, { type: 'message.added', message: startMessage });
      this.kick(record.discussionId);
      return copy(record);
    }, input.groupId);
  }

  kick(id) {
    void this.schedule(id).catch(error => this.failed(id, error));
  }

  async failed(id, error) {
    this.closed.add(id);
    this.engine.logger?.warn?.('bot-team: discussion persistence/scheduling failed: ' + String(error));
    try {
      await this.lock(id, async () => {
        const record = this.read(id);
        if (terminal(record)) return;
        record.status = 'paused';
        record.pauseReason = 'execution-error';
        record.error = String(error?.message || error);
        await this.save(record);
      });
    } catch (saveError) {
      this.engine.logger?.warn?.('bot-team: cannot persist paused discussion: ' + String(saveError));
      this.engine.settleDiscussionWaiters(id);
    }
  }

  pointer(record, step) {
    record.currentStepId = step?.stepId || null;
    record.currentSpeaker = step?.membershipId || null;
    if (step) {
      record.phase = step.phase;
      record.currentRound = step.round;
      record.currentIndex = record.steps.indexOf(step);
    }
  }

  validateMember(record, step) {
    const member = this.repo.getMember(step.membershipId);
    const participant = record.participants.find(item => item.membershipId === step.membershipId);
    if (!member || member.groupId !== record.groupId || member.enabled === false || !this.repo.getBot(member.botId) ||
        (participant && participant.botId !== member.botId)) throw failure('member-unavailable', '讨论成员已删除、停用或身份已改变');
    this.engine.assertQuota(record.groupId);
    return member;
  }

  async schedule(id) {
    return this.lock(id, async () => {
      const e = this.engine;
      const record = this.read(id);
      if (e.disposed || this.closed.has(id) || !['running', 'finalizing'].includes(record.status) || !e.isCurrentRecord(record)) return;
      if (this.liveJobs(id).length || this.queued(id).length) return;
      // A persisted running claim cannot be assumed abandoned by a second pump.
      if (record.steps.some(step => step.status === 'running')) return;
      const step = record.steps.find(step => step.status === 'pending');
      if (!step) {
        record.status = 'done';
        this.pointer(record, null);
        await this.save(record);
        return;
      }
      this.pointer(record, step);
      const attempt = { attemptId: newId('attempt'), jobId: newId('job'), sessionId: null,
        inputMessageId: null, messageIds: [], status: 'pending', createdAt: now() };
      step.attempts.push(attempt);
      step.status = 'running';
      try { this.validateMember(record, step); }
      catch (error) {
        step.status = attempt.status = 'error';
        step.error = attempt.error = String(error?.message || error);
        record.status = 'paused'; record.pauseReason = error.code || 'member-error';
        record.lastFailedStepId = step.stepId;
        await this.save(record);
        return;
      }
      await this.save(record); // durable claim precedes queue insertion, including the job ID
      if (this.closed.has(id) || e.disposed) return;
      const meta = { discussionId: id, stepId: step.stepId, attemptId: attempt.attemptId,
        phase: step.phase, side: step.side ?? null, round: step.round,
        summary: step.phase === 'summary' || step.phase === 'judgement', speaker: step.membershipId };
      try {
        e.enqueueJob({ jobId: attempt.jobId, groupId: record.groupId, conversationId: record.conversationId,
          membershipId: step.membershipId, kind: 'discussion_step', messageKind: 'discussion',
          discussionId: id, stepId: step.stepId, attemptId: attempt.attemptId, round: step.round,
          triggerSeq: this.repo.lastMessageOf(record.groupId)?.seq ?? record.startSeq,
          triggerMessageId: record.startMessageId, meta });
      } catch (error) {
        step.status = attempt.status = 'error'; step.error = attempt.error = String(error?.message || error);
        record.status = 'paused'; record.pauseReason = 'dispatch-error'; record.lastFailedStepId = step.stepId;
        await this.save(record);
      }
    });
  }

  match(record, job) {
    const step = record.steps.find(item => item.stepId === job.stepId);
    const attempt = step?.attempts.find(item => item.attemptId === job.attemptId && item.jobId === job.jobId);
    return { step, attempt };
  }

  assertDispatch(job) {
    const record = this.repo.getDiscussion(job.discussionId);
    if (!record || !this.engine.isCurrentRecord(record) || this.closed.has(job.discussionId) ||
        !['running', 'pausing', 'finalizing'].includes(record.status)) throw failure('discussion-paused', '讨论当前不能派发步骤');
    const { step, attempt } = this.match(record, job);
    if (!step || step.status !== 'running' || !attempt || step.attempts.at(-1) !== attempt) throw failure('stale-step', '讨论步骤已变化');
    this.validateMember(record, step);
    return { record, step, attempt };
  }

  prepare(job) {
    return this.lock(job.discussionId, async () => {
      this.assertDispatch(job);
      const record = this.read(job.discussionId);
      const { step, attempt } = this.match(record, job);
      const member = this.validateMember(record, step);
      const prompt = buildDiscussionStepPrompt({ repo: this.repo, botId: member.botId, groupId: record.groupId,
        discussion: copy(record), step: copy(step), transcript: copy(this.engine.discussionTranscript(record)) });
      attempt.prompt = prompt;
      attempt.dispatchedAt = now();
      attempt.status = 'running';
      attempt.messageIds = messageIds(job);
      step.messageIds = [...new Set([...step.messageIds, ...attempt.messageIds])];
      await this.save(record);
      job.promptText = prompt;
    });
  }

  execution(job) {
    return this.lock(job.discussionId, async () => {
      const record = this.read(job.discussionId);
      const { step, attempt } = this.match(record, job);
      if (!attempt) return;
      attempt.sessionId = job.execution.sessionId || attempt.sessionId;
      attempt.inputMessageId = attempt.inputMessageId || job.execution.inputMessageId;
      attempt.messageIds = [...new Set([...attempt.messageIds, ...messageIds(job)])];
      step.messageIds = [...new Set([...step.messageIds, ...attempt.messageIds])];
      await this.save(record);
    });
  }

  async finished(job) {
    await job.discussionMessageWrites;
    await this.lock(job.discussionId, async () => {
      const record = this.read(job.discussionId);
      const { step, attempt } = this.match(record, job);
      if (!attempt || step.attempts.at(-1) !== attempt || ['done', 'error', 'skipped'].includes(attempt.status)) return;
      const ids = messageIds(job);
      attempt.messageIds = [...new Set([...attempt.messageIds, ...ids])];
      step.messageIds = [...new Set([...step.messageIds, ...attempt.messageIds])];
      attempt.sessionId = job.sessionId || attempt.sessionId;
      attempt.inputMessageId = attempt.inputMessageId || job.execution?.inputMessageId;
      attempt.finishedAt = now();
      const stopping = ['stopping', 'stopped'].includes(record.status) || this.closed.has(record.discussionId);
      const ok = job.state === 'done' && !job.discussionPersistenceError;
      attempt.status = step.status = ok ? 'done' : stopping ? 'skipped' : 'error';
      if (!ok) {
        attempt.error = step.error = job.discussionPersistenceError || job.error || '成员执行失败或中断';
        if (!stopping) {
          record.status = 'paused'; record.pauseReason = 'member-error'; record.lastFailedStepId = step.stepId;
        }
      }
      if (ok && (step.phase === 'summary' || step.phase === 'judgement')) this.setSummary(record, step, attempt);
      if (record.status === 'pausing') { record.status = 'paused'; record.pauseReason = 'user'; }
      this.pointer(record, step);
      await this.save(record);
    });
    if (this.repo.getDiscussion(job.discussionId)?.status === 'stopping') this.checkStopping(job.discussionId);
    else this.kick(job.discussionId);
  }

  setSummary(record, step, attempt) {
    const messages = attempt.messageIds.map(id => this.repo.getMessage(id)).filter(message => message?.status === 'done');
    record.summary = messages.map(message => message.text || '').filter(Boolean).join('\n\n');
    if (step.phase === 'judgement') {
      const evidence = side => ['opening', 'closing'].every(phase => record.steps.some(item => item.side === side && item.phase === phase &&
        item.status === 'done' && (item.attempts.at(-1)?.messageIds || []).some(id => {
          const message = this.repo.getMessage(id);
          return message?.status === 'done' && String(message.text || '').trim();
        })));
      record.verdict = evidence('pro') && evidence('con') ? (parseDebateVerdict(record.summary) || 'insufficient') : 'insufficient';
    }
  }

  reconcile(record) {
    const messages = this.repo.messagesOf(record.groupId).filter(message =>
      conversationIdOf(this.repo, message) === conversationIdOf(this.repo, record) && message.meta?.discussionId === record.discussionId);
    for (const step of record.steps) {
      if (['done', 'skipped'].includes(step.status)) continue;
      const attempt = step.attempts.at(-1);
      if (!attempt) continue;
      const matches = messages.filter(message => message.meta?.stepId === step.stepId && message.meta?.attemptId === attempt.attemptId &&
        message.meta?.execution?.jobId === attempt.jobId);
      attempt.messageIds = [...new Set([...attempt.messageIds, ...matches.map(message => message.messageId)])];
      step.messageIds = [...new Set([...step.messageIds, ...attempt.messageIds])];
      const last = matches.at(-1);
      if (last?.status === 'done' && last.meta.logicalJobComplete === true) {
        step.status = attempt.status = 'done';
        attempt.sessionId = last.meta.execution.sessionId || attempt.sessionId;
        attempt.inputMessageId ||= matches.find(message => message.meta.execution.inputMessageId)?.meta.execution.inputMessageId || null;
        if (step.phase === 'summary' || step.phase === 'judgement') this.setSummary(record, step, attempt);
      } else if (step.status === 'running') {
        step.status = attempt.status = 'error';
        step.error = attempt.error = '执行中断；请重试此步骤，或提前结束以收束讨论';
        record.lastFailedStepId = step.stepId;
      }
    }
    record.needsRecovery = false;
  }

  removeQueued(record, reason) {
    const ids = new Set(this.queued(record.discussionId).map(job => job.jobId));
    this.engine.queue = this.engine.queue.filter(job => !ids.has(job.jobId));
    for (const step of record.steps) {
      const attempt = step.attempts.at(-1);
      if (attempt && ids.has(attempt.jobId)) {
        attempt.status = 'skipped'; attempt.error = reason; attempt.finishedAt = now();
        step.status = 'pending';
      }
    }
  }

  control(input) {
    return this.lock(input.discussionId, async () => {
      const e = this.engine;
      const record = this.read(input.discussionId);
      e.admitConversation(record.groupId, input.expectedConversationId);
      e.assertCurrentTarget(record.groupId, record);
      if (input.requestId && record.controlRequests?.some(request => request.requestId === input.requestId)) return copy(record);
      if (input.expectedRevision !== undefined && input.expectedRevision !== record.revision) {
        throw Object.assign(failure('stale-revision', '讨论状态已变化，请刷新后重试'), { details: { currentRevision: record.revision } });
      }
      const op = input.operation;
      if (!['pause', 'resume', 'retry', 'finish', 'stop', 'add_context'].includes(op)) throw failure('invalid-input', '无效的讨论控制操作');
      if (terminal(record)) {
        if (op === 'stop') return record;
        throw failure('conflict', '讨论已结束');
      }
      if (record.recoveryStatus === 'stopping' && op !== 'stop' && op !== 'add_context') {
        throw failure('conflict', '此讨论已请求停止，请先完成停止');
      }
      const live = this.liveJobs(record.discussionId);
      if ((record.needsRecovery || ['resume', 'retry'].includes(op) || (op === 'finish' && !live.length)) && !['add_context', 'stop'].includes(op)) {
        await e.discussionGuard(record);
        this.reconcile(record);
      }
      if (['resume', 'retry', 'finish'].includes(op)) await this.ensureStartMessage(record);
      if (op === 'add_context') {
        if (input.text !== undefined && (typeof input.text !== 'string' || input.text.length > 12000)) throw failure('invalid-input', '补充内容无效或超过 12000 字');
        const text = (input.text || '').trim();
        const contextSnapshots = this.snapshotContext(record.groupId, input.contextMessageIds || []);
        if (!text && !contextSnapshots.length) throw failure('invalid-input', '请输入补充内容或选择引用消息');
        record.supplements.push({ supplementId: newId('supplement'), text, contextMessageIds: input.contextMessageIds || [], contextSnapshots, createdAt: now() });
      } else if (op === 'pause') {
        this.removeQueued(record, '讨论已暂停');
        if (['running', 'pausing', 'finalizing'].includes(record.status)) {
          record.resumeStatus = record.status === 'finalizing' ? 'finalizing' : record.resumeStatus || 'running';
          record.status = live.length ? 'pausing' : 'paused'; record.pauseReason = 'user';
        }
      } else if (op === 'resume' || op === 'retry') {
        if (record.status !== 'paused') throw failure('conflict', '只有暂停的讨论可以继续或重试');
        if (live.length) throw failure('conflict', '当前步骤仍在结束，请稍后继续');
        this.reconcile(record);
        if (op === 'retry') {
          const step = record.steps.find(item => item.stepId === record.lastFailedStepId && item.status === 'error') || record.steps.find(item => item.status === 'error');
          if (!step) throw failure('conflict', '没有失败的步骤可重试');
          step.status = 'pending'; delete step.error;
        } else if (record.steps.some(step => step.status === 'error')) {
          await this.save(record);
          throw failure('retry-required', '讨论有失败的步骤，请使用重试；提前结束或停止可以跳过未完成步骤');
        }
        record.status = record.resumeStatus === 'finalizing' || record.finishRequested ? 'finalizing' : 'running';
        record.pauseReason = null; record.error = null;
        this.closed.delete(record.discussionId);
      } else if (op === 'finish') {
        this.removeQueued(record, '提前结束');
        record.partial = true; record.finishRequested = true; record.status = 'finalizing';
        for (const step of record.steps) {
          if (!['pending', 'error'].includes(step.status)) continue;
          if (!finalPhases.has(step.phase)) step.status = 'skipped';
          else if (step.status === 'error') { step.status = 'pending'; delete step.error; }
        }
        this.closed.delete(record.discussionId);
      } else if (op === 'stop') {
        this.closed.add(record.discussionId); // close dispatch before touching queue or cancelling an Agent
        record.status = 'stopping'; record.stopReason = 'user';
        this.removeQueued(record, '讨论已停止');
        await this.save(record);
        for (const job of live) e.abortJob(job, 'user');
        // Native cancellation is asynchronous. Keep the active slot until a
        // fresh guard confirms jobs, goals, inbox and descendants are quiescent.
        for (const step of record.steps) if (['pending', 'running', 'error'].includes(step.status)) step.status = 'skipped';
        await this.finishStop(record);
      }
      if (input.requestId) record.controlRequests = [...(record.controlRequests || []), { requestId: input.requestId, operation: op }];
      await this.save(record);
      if (['running', 'finalizing'].includes(record.status)) this.kick(record.discussionId);
      e.checkIdle(record.groupId);
      return copy(record);
    });
  }

  /** Synchronous scheduler barrier used by the legacy group/member stop APIs. */
  interrupt(id, { stop = false } = {}) {
    this.closed.add(id);
    return this.lock(id, async () => {
      const record = this.read(id);
      if (terminal(record)) return;
      this.removeQueued(record, stop ? '讨论已停止' : '成员已停止');
      for (const step of record.steps) if (step.status === 'running') {
        step.status = stop ? 'skipped' : 'error';
        const attempt = step.attempts.at(-1);
        if (attempt) { attempt.status = step.status; attempt.error = stop ? '讨论已停止' : '成员已停止'; }
        record.lastFailedStepId = step.stepId;
      }
      if (stop) for (const step of record.steps) if (step.status === 'pending') step.status = 'skipped';
      record.status = stop ? 'stopping' : 'paused';
      record.pauseReason = stop ? null : 'member-error';
      record.stopReason = stop ? 'user' : null;
      this.pointer(record, null);
      if (stop) await this.finishStop(record);
      await this.save(record);
    });
  }

  async finishStop(record) {
    try {
      for (const step of record.steps) for (const attempt of step.attempts) {
        this.engine.withdrawDiscussionInput({ groupId: record.groupId, conversationId: record.conversationId,
          stepId: step.stepId, jobId: attempt.jobId, sessionId: attempt.sessionId, execution: { inputMessageId: attempt.inputMessageId } });
      }
      await this.engine.discussionGuard(record);
      record.status = 'stopped'; record.needsRecovery = false; record.stopPendingReason = null;
      this.pointer(record, null);
    } catch (error) {
      record.status = 'stopping'; record.stopPendingReason = String(error?.message || error);
    }
  }

  checkStopping(id) {
    void this.lock(id, async () => {
      const record = this.read(id);
      if (record.status !== 'stopping') return;
      await this.finishStop(record);
      await this.save(record);
    }).catch(error => this.engine.logger?.warn?.('bot-team: stop completion check failed: ' + String(error)));
  }

  nativeSettled(sessionId) {
    const member = this.engine.pool.memberForSession?.(sessionId);
    if (!member) return;
    for (const record of this.repo.discussionsOf(member.groupId)) {
      if (record.protocolVersion === 2 && record.status === 'stopping' && this.engine.isCurrentRecord(record) &&
          (record.memberIds.includes(member.membershipId) || record.steps.some(step => step.attempts.some(attempt => attempt.sessionId === sessionId)))) {
        this.checkStopping(record.discussionId);
      }
    }
  }
}
