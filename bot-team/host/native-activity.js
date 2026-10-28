/** Native activity is queried through public host services; no Agent is resumed. */
function service(ctx, name) {
  // Cordis guards property access with inject declarations, even for absent
  // optional services. get() safely reads the store and may return undefined.
  return typeof ctx?.get === 'function' ? ctx.get(name) : ctx?.[name];
}
function adapterOf(ctx) { return service(ctx, 'botTeamNativeActivity'); }

/** Explicit adapters support isolated embedders/fixtures without fake idle states. */
export function nativeConversationCapability({ ctx, pool } = {}) {
  const adapter = adapterOf(ctx);
  if (adapter) {
    try {
      const capability = typeof adapter.capability === 'function' ? adapter.capability({ ctx, pool }) : adapter.capability;
      if (capability?.supported === true && typeof adapter.collect === 'function') return { ...capability, missing: capability.missing || [] };
      return { supported: false, missing: capability?.missing || ['adapter'], reason: capability?.reason || '原生活动适配器不可用' };
    } catch (error) { return { supported: false, missing: ['adapter'], reason: String(error?.message || error) }; }
  }
  const requirements = { agents: ['get', 'list', 'roots', 'isOwnedBy'], jobs: ['list'], goals: ['get'],
    subagents: ['listDescendants', 'drainDescendants'], sessionQuery: ['observeSession'] };
  const missing = [];
  for (const [name, methods] of Object.entries(requirements)) {
    const host = service(ctx, name);
    for (const method of methods) if (typeof host?.[method] !== 'function') missing.push(name + '.' + method);
  }
  return { supported: missing.length === 0, missing,
    ...(missing.length ? { reason: '宿主缺少可验证的原生活动查询能力：' + missing.join(', ') } : {}) };
}

// Installed rc.3 ApprovalService.setPolicy emits exactly this annotation via
// agent.inject(...): next-step, wakeup=false. It carries no work to execute.
// Keep every next-turn entry and every unrecognized next-step source blocking.
function policyAnnotation(message) {
  return message?.role === 'user' && message.source?.kind === 'user-approval' &&
    Object.keys(message.source).length === 1 && message.content?.length === 1 &&
    message.content[0]?.type === 'text' &&
    /^The approval policy changed from "(ask|never)" to "(ask|never)" [(]changed by the user[)][.]$/.test(message.content[0].text);
}

function inboxSize(nextTurn, nextStep, annotations = false) {
  return nextTurn.length + nextStep.filter(message => !annotations || !policyAnnotation(message)).length;
}

function persistedInbox(events, annotations = false) {
  const lanes = { 'next-turn': [], 'next-step': [] };
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue;
    const data = event.data;
    const lane = lanes[data?.target];
    const removed = data?.removedCount ?? 0;
    if (!lane || !Number.isSafeInteger(data.start) || data.start < 0 || data.start > lane.length ||
      !Number.isSafeInteger(removed) || removed < 0 || data.start + removed > lane.length || !Array.isArray(data.inserted)) {
      throw new Error('原生 inbox 历史无效');
    }
    lane.splice(data.start, removed, ...data.inserted);
  }
  return inboxSize(lanes['next-turn'], lanes['next-step'], annotations);
}

const missingSession = error => ['SESSION_QUERY_SESSION_NOT_FOUND', 'SESSION_QUERY_NOT_FOUND'].includes(error?.code);
const terminalJob = status => ['completed', 'failed', 'killed'].includes(status);

/**
 * Async because the installed host's durable descendant catalog and cold
 * Session observations are async. List.activity is deliberately ignored:
 * external activations have no local Session and may misleadingly be inactive.
 * Returns only blockers. Unknown observations fail closed, with a concrete cause.
 */
export async function collectNativeConversationBlockers({ ctx, repo, pool, groupId, interactions } = {}) {
  const adapter = adapterOf(ctx);
  const capability = nativeConversationCapability({ ctx, pool });
  const blockers = [];
  const add = (kind, message, extra = {}) => blockers.push({ code: 'conversation-busy', kind, groupId, message, ...extra });
  if (!capability.supported) {
    add('native-unsupported', capability.reason, { missing: capability.missing });
    return blockers;
  }
  if (adapter) {
    try {
      const result = await adapter.collect({ ctx, repo, pool, groupId, interactions });
      if (!Array.isArray(result)) throw new Error('原生活动适配器未返回阻塞列表');
      return result;
    } catch (error) {
      add('native-unknown', '无法确认原生活动：' + String(error?.message || error));
      return blockers;
    }
  }
  const agents = service(ctx, 'agents');
  const jobs = service(ctx, 'jobs');
  const goals = service(ctx, 'goals');
  const subagents = service(ctx, 'subagents');
  const query = service(ctx, 'sessionQuery');
  const roots = new Map();
  const root = (sessionId, member) => { if (sessionId && !roots.has(sessionId)) roots.set(sessionId, member); };
  for (const member of repo.members?.values() || []) if (member.groupId === groupId) {
    root(member.sessionId, member);
    for (const id of member.previousSessionIds || []) root(id, member);
  }
  for (const binding of repo.sessionBindings?.values() || []) if (binding.groupId === groupId) root(binding.sessionId, binding);
  for (const [agent, owned] of pool?.owned || []) {
    const member = repo.getMember?.(owned.membershipId);
    if (member?.groupId === groupId) root(agent.id, member);
  }
  const ids = new Set(roots.keys());
  const observed = new Map();
  const checkLive = (agent, member, isRoot = false) => {
    const details = { sessionId: agent.id, membershipId: member?.membershipId };
    if (isRoot && (!agents.roots().includes(agent) || !pool?.owns?.(agent))) {
      add('native-borrowed', '原生会话由其他所有者持有，无法关闭独立输入', details);
    }
    if (agent.status !== 'idle') add('native-agent', agent.status === 'running' ? '原生 Agent 仍在运行' : '无法确认原生 Agent 已空闲', details);
    try {
      const inbox = agent.inbox;
      if (!Array.isArray(inbox?.nextTurn) || !Array.isArray(inbox?.nextStep)) throw new Error('缺少 inbox 查询');
      if (inboxSize(inbox.nextTurn, inbox.nextStep, isRoot && pool?.owns?.(agent))) add('native-inbox', '原生 inbox 仍有待执行输入', details);
    } catch (error) { add('native-unknown', '无法确认原生 inbox：' + String(error?.message || error), details); }
    try {
      const goal = goals.get(agent);
      if (goal?.phase === 'active' && goal.activation === 'armed') add('native-goal', '原生目标仍获授权自动续跑', { ...details, goalId: goal.id });
      else if (goal?.phase === 'active' && goal.activation !== 'disarmed') add('native-unknown', '无法确认原生目标的续跑授权', details);
    } catch (error) { add('native-unknown', '无法读取原生目标：' + String(error?.message || error), details); }
  };
  for (const [sessionId, member] of roots) {
    const live = agents.get(sessionId);
    let absent = false;
    observed.set(sessionId, live);
    if (live) checkLive(live, member, true);
    else {
      let observation;
      try {
        observation = await query.observeSession(sessionId, { projectionMode: 'none' });
        if (observation.header?.id !== sessionId || !Array.isArray(observation.events)) throw new Error('无效的原生 Session 观察');
        if (persistedInbox(observation.events, true)) add('native-inbox', '历史原生 inbox 仍有未执行输入', { sessionId, membershipId: member?.membershipId });
      } catch (error) {
        if (missingSession(error)) absent = true; // Allocated ids need not have a log yet.
        else {
          add('native-unknown', '无法读取原生会话活动：' + String(error?.message || error), { sessionId });
          continue;
        }
      } finally { observation?.[Symbol.dispose]?.(); }
    }
    try {
      const descendants = await subagents.listDescendants(sessionId);
      if (!Array.isArray(descendants)) throw new Error('无效的子代理列表');
      for (const child of descendants) {
        ids.add(child.id);
        const details = { sessionId: child.id, parentSessionId: child.parentId, rootSessionId: sessionId, membershipId: member?.membershipId };
        if (child.kind !== 'child' || child.mode === 'external' || child.mode === 'unknown') {
          // Exact owned teardown has awaited the manager's complete forest.
          if (!live && pool?.drainedSessions?.has(sessionId)) continue;
          add('native-descendant-unknown', '无法证明子代理已停止：' + (child.reason || child.mode || '未知类型'), details);
          continue;
        }
        const agent = agents.get(child.id);
        observed.set(child.id, agent);
        if (agent) checkLive(agent, member);
        else if (child.activity === 'running') add('native-descendant-unknown', '子代理 Session 仍驻留，但无法读取其 Agent 活动', details);
        else {
          let observation;
          try {
            observation = await query.observeSession(child.id, { projectionMode: 'none' });
            if (observation.header?.id !== child.id || !Array.isArray(observation.events)) throw new Error('无效的子代理 Session 观察');
            if (persistedInbox(observation.events)) add('native-inbox', '子代理 inbox 仍有未执行输入', details);
          } catch (error) {
            if (!missingSession(error)) add('native-descendant-unknown', '无法读取子代理 inbox：' + String(error?.message || error), details);
          } finally { observation?.[Symbol.dispose]?.(); }
        }
      }
    } catch (error) {
      if (!absent || !missingSession(error)) add('native-unknown', '无法读取原生子代理：' + String(error?.message || error), { sessionId });
    }
  }
  // Registry ownership also covers live children before their durable catalog
  // publication; iterate to include descendants of every exact observed owner.
  let grew;
  do {
    grew = false;
    for (const agent of agents.list()) {
      if (ids.has(agent.id)) continue;
      const parent = [...ids].map(id => agents.get(id)).find(owner => owner && agents.isOwnedBy(agent.id, owner));
      // A manager-owned child can survive a missing root writer/catalog. Its
      // immutable parentSession still ties that live activity to this group.
      const parentSession = agent.session?.header?.parentSession;
      const parentId = typeof parentSession === 'string' ? parentSession : parentSession?.id;
      if (!parent && !ids.has(parentId)) continue;
      ids.add(agent.id);
      observed.set(agent.id, agent);
      checkLive(agent);
      grew = true;
    }
  } while (grew);
  for (const sessionId of ids) {
    try {
      const listed = jobs.list(sessionId);
      if (!Array.isArray(listed)) throw new Error('无效的后台作业列表');
      for (const job of listed) if (job.owner === sessionId && !terminalJob(job.status)) add('native-job', '原生后台作业尚未结束', { sessionId, jobId: job.id, status: job.status });
    } catch (error) { add('native-unknown', '无法读取原生后台作业：' + String(error?.message || error), { sessionId }); }
  }
  // status intentionally reports idle during native maintenance. whenIdle is
  // public and includes its activityDone promise; a one-turn probe distinguishes
  // settled idle from ongoing maintenance without waiting for work to finish.
  for (const [sessionId, agent] of observed) if (agent?.status === 'idle') {
    try {
      if (typeof agent.whenIdle !== 'function') throw new Error('缺少 whenIdle 查询');
      let immediate;
      const idle = await Promise.race([
        Promise.resolve(agent.whenIdle()).then(() => true),
        new Promise(resolve => { immediate = setImmediate(() => resolve(false)); }),
      ]).finally(() => clearImmediate(immediate));
      if (!idle) add('native-agent', '原生 Agent 仍有维护或待收尾活动', { sessionId });
    } catch (error) { add('native-unknown', '无法确认原生 Agent 已完成活动：' + String(error?.message || error), { sessionId }); }
  }
  for (const [sessionId, initial] of observed) {
    const current = agents.get(sessionId);
    if (current !== initial) add('native-changed', '检查期间原生 Agent 已变更，请重试', { sessionId });
    else if (current) checkLive(current, roots.get(sessionId), roots.has(sessionId));
  }
  if (pool?.isPreparingGroup?.(groupId)) add('native-preparing', '原生 Agent 或输入正在准备');
  const pendingInteractions = new Set([...(interactions?.entries?.values() || []), ...(interactions?.responding || [])]);
  for (const entry of pendingInteractions) if (entry.view?.groupId === groupId && (entry.busy || !['done', 'settled'].includes(entry.view.state))) {
    add('native-interaction', entry.busy ? '原生交互回答正在提交' : '原生交互尚未完成', { sessionId: entry.view.sessionId, interactionId: entry.view.interactionId });
  }
  const unique = new Map(blockers.map(value => [[value.kind, value.sessionId, value.jobId, value.interactionId, value.goalId].join(':'), value]));
  return [...unique.values()];
}
