import { inspectSessionHeader } from './native-session.js';

const isSessionId = value => typeof value === 'string' && value.length > 0;

/**
 * One-way migration of ordinary Sessions already owned by Bot Team.
 * New background/subagent Sessions are never archived. The workspace API owns
 * activity checks; omitting stopActivity is essential to preserve running work.
 */
export class BotSessionVisibility {
  constructor({ ctx, repo, logger, isBusy = () => false }) {
    this.ctx = ctx;
    this.repo = repo;
    this.logger = logger;
    this.isBusy = isBusy;
    this.disposed = false;
    // Ownership survives group/member removal once observed in the repository.
    // Never populate this cache from global Session lists or archive responses.
    this.owned = new Set();
    this.completed = new Map();
    this.busy = new Set();
    this.inFlight = new Map();
    this.activityRevision = new Map();
    this.reportedErrors = new Map();
    this.off = [
      ctx.on('session/event', (session, event) => {
        if (event?.type === 'turn/end' ||
            (event?.type === 'goal/change' && event.data?.goal?.phase && event.data.goal.phase !== 'active')) {
          return this.retryAfterActivity(session?.id);
        }
      }, { global: true }),
      // turn/end is appended while the native loop still reports running.
      ctx.on('agent/status', ({ agent, status }) => status === 'idle' ? this.retryAfterActivity(agent?.id) : undefined, { global: true }),
      ctx.on('agent/disposed', ({ agent }) => this.retryAfterActivity(agent?.id), { global: true }),
      ctx.on('goal/activation-changed', ({ sessionId, goal }) => {
        // rc.3 emits only id/revision/activation here, not the goal phase.
        if (!goal || goal.activation === 'disarmed') return this.retryAfterActivity(sessionId);
      }, { global: true }),
    ];
    this.ready = this.reconcile();
  }

  collectOwnership() {
    const add = id => { if (isSessionId(id)) this.owned.add(id); };
    for (const binding of this.repo.sessionBindings?.values() || []) add(binding.sessionId);
    for (const member of this.repo.members?.values() || []) {
      add(member.sessionId);
      if (Array.isArray(member.previousSessionIds)) for (const id of member.previousSessionIds) add(id);
    }
    for (const message of this.repo.messages?.values() || []) {
      if (message.author?.type === 'bot') add(message.meta?.execution?.sessionId);
    }
  }

  /** Refresh repository ownership; errors are returned and logged, never retried by timers. */
  async reconcile() {
    if (this.disposed) return [];
    this.collectOwnership();
    return Promise.all([...this.owned].map(sessionId => this.run(sessionId)));
  }

  retryAfterActivity(sessionId) {
    if (this.disposed || !this.owned.has(sessionId) || this.completed.has(sessionId)) return;
    // Remember a completion that races an in-flight busy response, but do not
    // start work for arbitrary tracked IDs that have never been known busy.
    if (this.inFlight.has(sessionId)) {
      this.activityRevision.set(sessionId, (this.activityRevision.get(sessionId) || 0) + 1);
      return this.inFlight.get(sessionId);
    }
    if (this.busy.has(sessionId)) return this.run(sessionId);
  }

  run(sessionId) {
    if (this.disposed || !this.owned.has(sessionId)) return Promise.resolve({ sessionId, status: 'disposed' });
    if (this.completed.has(sessionId)) return Promise.resolve({ sessionId, status: this.completed.get(sessionId) });
    const existing = this.inFlight.get(sessionId);
    if (existing) return existing;
    // Start on a microtask so synchronous lifecycle notifications and concurrent
    // reconcile calls share this entry before observation begins.
    const pending = Promise.resolve().then(async () => {
      let result;
      do {
        const revision = this.activityRevision.get(sessionId) || 0;
        this.busy.delete(sessionId);
        result = await this.archiveIdleOrdinary(sessionId);
        if (result.status !== 'busy' || this.disposed || revision === (this.activityRevision.get(sessionId) || 0)) break;
      } while (true);
      return result;
    }).finally(() => this.inFlight.delete(sessionId));
    this.inFlight.set(sessionId, pending);
    return pending;
  }

  async archiveIdleOrdinary(sessionId) {
    const result = status => ({ sessionId, status });
    if (this.disposed || !this.owned.has(sessionId)) return result('disposed');
    try {
      const header = await inspectSessionHeader(this.ctx, sessionId);
      if (this.disposed || !this.owned.has(sessionId)) return result('disposed');
      if (!header) return result('missing');
      if (header.origin === 'subagent') {
        this.completed.set(sessionId, 'subagent');
        return result('subagent');
      }
      const agent = this.ctx.agents?.get?.(sessionId);
      const goal = agent ? this.ctx.get?.('goals')?.get(agent) : undefined;
      if (this.isBusy(sessionId) || agent?.status === 'running' ||
          (goal?.phase === 'active' && goal.activation === 'armed')) {
        this.busy.add(sessionId);
        return result('busy');
      }
      const controller = this.ctx.get?.('workspaceController') || this.ctx.workspaceController;
      if (typeof controller?.archiveSession !== 'function') throw new Error('Bot Team requires workspaceController.archiveSession for ordinary Session migration');
      // Recheck after the asynchronous observation and immediately before the
      // mutation. A removed group is still covered by the trusted ownership cache.
      if (this.disposed || !this.owned.has(sessionId)) return result('disposed');
      const archived = await controller.archiveSession({ sessionId });
      if (!Array.isArray(archived?.archivedSessionIds) || !archived.archivedSessionIds.includes(sessionId)) {
        throw new Error('Workspace archive response did not include the owned Bot Session');
      }
      this.completed.set(sessionId, 'archived');
      this.reportedErrors.delete(sessionId);
      return result('archived');
    } catch (error) {
      if (error?.code === 'workspace/session-active') {
        if (!this.disposed) this.busy.add(sessionId);
        return result('busy');
      }
      if (error?.code === 'session/not-found' || error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return result('missing');
      const description = String(error?.message || error);
      const key = String(error?.code || '') + ':' + description;
      if (this.reportedErrors.get(sessionId) !== key) {
        this.reportedErrors.set(sessionId, key);
        this.logger?.warn?.('bot-team: ordinary Session archive failed for ' + sessionId + ': ' + description);
      }
      return { ...result('error'), error };
    }
  }

  /** Detach observation and await already-started calls; never stop native work. */
  async dispose() {
    this.disposed = true;
    for (const off of this.off.splice(0)) off();
    this.busy.clear();
    await Promise.allSettled([...this.inFlight.values()]);
  }
}
