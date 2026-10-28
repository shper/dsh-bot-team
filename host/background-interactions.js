/** Bot-specific answerers for the public Host human-interaction waterfalls. */
import { newId } from './util.js';
import { currentConversationId, isCurrentMemberSession } from './conversations.js';

const questionError = (code) => Object.assign(new Error(code), { name: 'UserQuestionError', code });
const invalid = (message) => Object.assign(new Error(message), { code: 'invalid-interaction' });
const clone = (value) => JSON.parse(JSON.stringify(value));

/** Validate complete native QuestionAnswer batches; empty selections explicitly skip a question. */
export function validateBackgroundAnswer(questions, answer) {
  if (!answer || !Array.isArray(answer.answers) || answer.answers.length !== questions.length) throw invalid('请提交每个问题的答案。');
  const remaining = new Map(questions.map(question => [question.id, question]));
  const answers = answer.answers.map(item => {
    const question = item && remaining.get(item.id);
    if (!question || !Array.isArray(item.selected) || item.selected.some(label => typeof label !== 'string')) throw invalid('问题或答案格式不正确。');
    remaining.delete(item.id);
    const labels = new Set((question.options || []).map(option => option.label));
    if (new Set(item.selected).size !== item.selected.length || item.selected.some(label => !labels.has(label))) throw invalid('答案包含无效或重复的选项。');
    if (question.multiSelect !== true && item.selected.length > 1) throw invalid('此问题只能选择一个选项。');
    if (item.custom !== undefined && typeof item.custom !== 'string') throw invalid('补充答案格式不正确。');
    return { id: item.id, selected: [...item.selected], ...(item.custom === undefined ? {} : { custom: item.custom }) };
  });
  if (remaining.size) throw invalid('请提交每个问题的答案。');
  return { answers };
}

export class BackgroundInteractions {
  constructor({ ctx, repo, bus }) {
    this.ctx = ctx;
    this.repo = repo;
    this.bus = bus;
    this.entries = new Map();
    this.revisions = new Map();
    this.epoch = newId('interactions');
    this.disposed = false;
    this.responding = new Set();
    const options = { global: true, prepend: true };
    this.off = [
      ctx.on('approval/request', (request, next) => this.receive('approval', request, next), options),
      ctx.on('user-questions/request', (request, next) => this.receive('question', request, next), options),
      ctx.on('session/event', session => {
        if ([...repo.members.values()].some(member => member.sessionId === session.id)) this.reconcile();
      }, { global: true }),
    ];
    // Membership removal and Agent disposal need not append a Session event.
    this.timer = setInterval(() => this.reconcile(), 1000);
    this.timer.unref?.();
  }

  memberFor(agent) {
    const agents = this.ctx.agents;
    if (!agent || !agents || agents.get(agent.id) !== agent || !agents.roots().includes(agent) || agent.session?.id !== agent.id) return;
    const members = [...this.repo.members.values()].filter(member => isCurrentMemberSession(this.repo, member, agent.id) && this.repo.groups.has(member.groupId));
    return members.length === 1 ? members[0] : undefined;
  }

  owns(entry) {
    const member = this.memberFor(entry.agent);
    return member?.membershipId === entry.view.membershipId && member.groupId === entry.view.groupId && member.botId === entry.view.botId && currentConversationId(this.repo, member.groupId) === entry.view.conversationId;
  }

  projection(agent) {
    return this.ctx.get('sessionProjections')?.stateOf(agent.session, 'userQuestions')?.questions;
  }

  make(kind, agent, member, fields) {
    const entry = { agent, view: {
      interactionId: newId('interaction'), groupId: member.groupId, sessionId: agent.id,
      membershipId: member.membershipId, botId: member.botId, conversationId: currentConversationId(this.repo, member.groupId),
      botName: this.repo.bots?.get(member.botId)?.name || 'Bot',
      kind, state: 'pending', createdAt: Date.now(), ...fields,
    } };
    this.entries.set(entry.view.interactionId, entry);
    return entry;
  }

  receive(kind, request, next) {
    const member = !this.disposed && this.memberFor(request.agent);
    if (!member) return next();
    const fields = kind === 'approval'
      ? { toolName: request.toolName, reason: request.reason || '', ...(request.callId ? { callId: request.callId } : {}) }
      : { questions: clone(request.questions), timed: request.wait?.timed === true, ...(request.wait?.callId ? { callId: request.wait.callId } : {}) };
    const entry = this.make(kind, request.agent, member, fields);
    return new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
      const abort = () => {
        if (kind === 'question' && entry.view.timed && request.signal?.reason?.code === 'ASK_TIMED_OUT') this.finish(entry, 'continue');
        else this.finish(entry, 'abort');
      };
      entry.cleanup = () => request.signal?.removeEventListener('abort', abort);
      request.signal?.addEventListener('abort', abort, { once: true });
      if (request.signal?.aborted) abort();
      else this.publish(member.groupId);
    });
  }

  finish(entry, operation, value) {
    if (!this.entries.has(entry.view.interactionId)) return;
    const { resolve, reject } = entry;
    entry.cleanup?.();
    entry.cleanup = entry.resolve = entry.reject = undefined;
    if (operation === 'continue') {
      entry.view.state = 'continuing';
      entry.transitionAt = Date.now();
      reject?.(questionError('ASK_TIMED_OUT'));
    } else {
      this.entries.delete(entry.view.interactionId);
      if (entry.view.kind === 'approval') resolve?.(operation === 'answer' ? value : 'cancelled');
      else if (operation === 'answer') resolve?.(value);
      else reject?.(questionError(operation === 'cancel' ? 'ASK_CANCELLED' : 'ASK_ABORTED'));
    }
    this.publish(entry.view.groupId);
  }

  /** Reconcile against public Session projections, including late questions after a reload. */
  reconcile() {
    if (this.disposed || this.reconciling) return;
    this.reconciling = true;
    const changed = new Set();
    try {
      for (const entry of [...this.entries.values()]) {
        if (!this.owns(entry)) { this.finish(entry, 'abort'); continue; }
        if (entry.view.kind !== 'question' || entry.view.state === 'pending') continue;
        const projection = this.projection(entry.agent);
        const active = projection?.active?.find(question => question.callId === entry.view.callId);
        if (active?.state === 'continued') {
          if (entry.view.state === 'continuing') { entry.view.state = 'continued'; changed.add(entry.view.groupId); }
        } else if (entry.view.state !== 'continuing' || projection?.settled?.some(question => question.callId === entry.view.callId) || Date.now() - entry.transitionAt > 30000) {
          this.entries.delete(entry.view.interactionId);
          changed.add(entry.view.groupId);
        }
      }
      for (const member of this.repo.members.values()) {
        const agent = this.ctx.agents?.get(member.sessionId);
        if (this.memberFor(agent)?.membershipId !== member.membershipId) continue;
        for (const question of this.projection(agent)?.active || []) {
          if (question.state !== 'continued' || [...this.entries.values()].some(entry => entry.agent === agent && entry.view.callId === question.callId)) continue;
          this.make('question', agent, member, { questions: clone(question.questions), callId: question.callId, timed: true, state: 'continued' });
          changed.add(member.groupId);
        }
      }
    } finally { this.reconciling = false; }
    for (const groupId of changed) this.publish(groupId);
  }

  view(groupId) {
    return { groupId, epoch: this.epoch, revision: this.revisions.get(groupId) || 0,
      interactions: [...this.entries.values()].filter(entry => entry.view.groupId === groupId && this.owns(entry)).map(entry => clone(entry.view)) };
  }

  publish(groupId) {
    this.revisions.set(groupId, (this.revisions.get(groupId) || 0) + 1);
    this.bus.emit(groupId, { type: 'interaction.updated', ...this.view(groupId) });
  }

  snapshot(groupId) {
    if (typeof groupId !== 'string' || !this.repo.groups.has(groupId)) throw invalid('群聊不存在。');
    this.reconcile();
    return this.view(groupId);
  }

  async respond(input = {}) {
    this.reconcile();
    const entry = this.entries.get(input.interactionId);
    if (this.disposed || !entry || !this.owns(entry) || entry.view.groupId !== input.groupId || entry.view.sessionId !== input.sessionId) throw invalid('此交互已失效或不属于当前会话。');
    const { view } = entry;
    if (input.expectedConversationId !== undefined && input.expectedConversationId !== view.conversationId) throw invalid('此交互已失效或不属于当前会话。');
    this.assertAdmission?.(view.groupId);
    if (entry.busy || view.state === 'continuing' || view.state === 'queued') throw invalid('此答案正在处理，请稍后刷新。');
    if (input.operation === 'continue') {
      if (view.kind !== 'question' || !view.timed || view.state !== 'pending') throw invalid('此交互不能稍后回答。');
      this.finish(entry, 'continue');
    } else if (input.operation === 'cancel') {
      if (view.state !== 'pending') throw invalid('此问题已继续执行，请提交答案或跳过。');
      this.finish(entry, 'cancel');
    } else if (input.operation === 'answer') {
      if (view.kind === 'approval') {
        if (!['allowed-once', 'rejected'].includes(input.outcome)) throw invalid('审批决定无效。');
        this.finish(entry, 'answer', input.outcome);
      } else {
        const answer = validateBackgroundAnswer(view.questions, input.answer);
        if (view.state === 'pending') this.finish(entry, 'answer', answer);
        else {
          entry.busy = true;
          this.responding.add(entry);
          try {
            const questions = this.ctx.get('userQuestions');
            if (typeof questions?.answer !== 'function') throw invalid('提问服务暂不可用，请稍后重试。');
            const accepted = await questions.answer(entry.agent, view.callId, answer);
            if (!this.owns(entry)) throw invalid('此交互已失效或不属于当前会话。');
            if (!accepted) { this.entries.delete(view.interactionId); throw invalid('此问题已失效，请刷新。'); }
            view.state = 'queued';
          } catch (error) {
            if (error?.code !== 'REPLY_QUEUED') throw error;
            if (!this.owns(entry)) throw invalid('此交互已失效或不属于当前会话。');
            view.state = 'queued';
          } finally { entry.busy = false; this.responding.delete(entry); this.publish(view.groupId); }
        }
      }
    } else throw invalid('未知的交互操作。');
    return { accepted: true, ...this.snapshot(view.groupId) };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    for (const off of this.off) off?.();
    for (const entry of [...this.entries.values()]) this.finish(entry, 'abort');
    this.entries.clear();
  }
}
