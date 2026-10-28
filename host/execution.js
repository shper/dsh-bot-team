/** Read Bot executions and group-owned Session history through session-query. */
import { conversationIdOf } from './conversations.js';
const ID = /^[A-Za-z0-9_-]{1,256}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const ACTIVE = new Set(['pending', 'streaming', 'running', 'queued']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function integerParam(value, fallback, minimum, name) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]*|-1)$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum) {
    fail('invalid-input', name + ' must be an integer >= ' + minimum);
  }
  return value;
}

function target(repo, groupId, messageId) {
  const group = repo.getGroup(groupId);
  if (!group || group.groupId !== groupId) fail('not-found', 'Group not found');
  const message = repo.getMessage(messageId);
  if (!message) fail('not-found', 'Message not found');
  if (message.messageId !== messageId || message.groupId !== groupId) {
    fail('invalid-input', 'Message does not belong to this group');
  }
  if (message.author?.type !== 'bot') fail('invalid-input', 'Execution is only available for Bot messages');
  return message;
}

/** Clone JSON data without invoking toJSON/accessors or retaining mutable SDK objects. */
function clone(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return undefined;
  if (ancestors.has(value)) return '[Circular]';
  ancestors.add(value);
  try {
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
    const result = Array.isArray(value) ? [] : {};
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !own(descriptor, 'value')) continue;
      let copied;
      try { copied = clone(descriptor.value, ancestors); } catch { copied = null; }
      if (copied !== undefined || Array.isArray(result)) {
        Object.defineProperty(result, key, { value: copied ?? null, enumerable: true, configurable: true, writable: true });
      }
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function reference(message) {
  const raw = message.meta?.execution;
  if (raw === undefined || raw === null) return { legacy: true, execution: null };
  const invalid = () => ({ execution: null, reason: 'invalid-execution-reference' });
  if (!record(raw) || raw.version !== 1 || typeof raw.jobId !== 'string' || !ID.test(raw.jobId)) return invalid();
  const execution = { version: 1, jobId: raw.jobId };
  for (const key of ['sessionId', 'inputMessageId']) {
    const value = raw[key] ?? null;
    if (value !== null && (typeof value !== 'string' || !(key === 'sessionId' ? SESSION_ID : ID).test(value))) return invalid();
    execution[key] = value;
  }
  for (const key of ['turn', 'startSeq', 'endSeq']) {
    const value = raw[key] ?? null;
    if (value !== null && (!count(value) || (key === 'turn' && value < 1))) return invalid();
    execution[key] = value;
  }
  if (raw.submittedSeq !== undefined && raw.submittedSeq !== null) {
    if (!count(raw.submittedSeq)) return invalid();
    execution.submittedSeq = raw.submittedSeq;
  }
  if (execution.startSeq !== null && execution.endSeq !== null && execution.endSeq < execution.startSeq) return invalid();
  if (execution.startSeq !== null && execution.submittedSeq !== undefined && execution.startSeq < execution.submittedSeq) return invalid();
  if (!execution.sessionId && (execution.turn !== null || execution.startSeq !== null || execution.endSeq !== null)) return invalid();
  return { execution };
}

function response(message, afterSeq, availability, execution, extra = {}) {
  return {
    ok: true,
    groupId: message.groupId,
    messageId: message.messageId,
    availability,
    execution,
    status: typeof message.status === 'string' ? message.status : 'unknown',
    error: clone(message.error) ?? null,
    events: [],
    nextSeq: afterSeq,
    hasMore: false,
    ...(execution?.sessionId ? { sessionId: execution.sessionId } : {}),
    ...extra,
  };
}

function validateExecutionOwnership(repo, message, execution) {
  if (!repo.getGroup(message.groupId)?.activeConversationId || !execution?.sessionId) return;
  const conversationId = conversationIdOf(repo, message);
  const binding = repo.sessionBindingFor?.(execution.sessionId);
  if (!conversationId || (binding && (binding.groupId !== message.groupId ||
      binding.conversationId !== conversationId || binding.membershipId !== message.author.membershipId ||
      binding.botId !== message.author.botId))) fail('invalid-input', 'Execution Session does not belong to this message');
}

function legacyResponse(repo, message, afterSeq) {
  const member = repo.getMember?.(message.author.membershipId);
  const validAuthor = typeof message.author.botId === 'string' && ID.test(message.author.botId) &&
    typeof message.author.membershipId === 'string' && ID.test(message.author.membershipId);
  let fallbackSessionId;
  if (repo.getGroup(message.groupId)?.activeConversationId) {
    // A legacy message cannot borrow a newer member Session. Only a unique,
    // committed binding for this message's own conversation proves a fallback.
    const conversationId = conversationIdOf(repo, message);
    const bindings = conversationId && validAuthor ? (repo.sessionBindingsOf?.(message.groupId, conversationId) || []) : [];
    const candidates = new Set(bindings.filter(binding =>
      binding.groupId === message.groupId && binding.conversationId === conversationId &&
      binding.membershipId === message.author.membershipId && binding.botId === message.author.botId &&
      typeof binding.sessionId === 'string' && SESSION_ID.test(binding.sessionId)).map(binding => binding.sessionId));
    if (candidates.size === 1) fallbackSessionId = [...candidates][0];
  } else if (validAuthor && member && member.groupId === message.groupId &&
      member.membershipId === message.author.membershipId && member.botId === message.author.botId &&
      typeof member.sessionId === 'string' && SESSION_ID.test(member.sessionId)) fallbackSessionId = member.sessionId;
  return response(message, afterSeq, 'legacy-unlinked', null, {
    reason: 'legacy-message-has-no-execution-reference',
    ...(fallbackSessionId ? { fallbackSessionId } : {}),
  });
}

function abort(signal) {
  if (signal?.aborted) {
    if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
    throw signal.reason ?? Object.assign(new Error('Execution query aborted'), { name: 'AbortError' });
  }
}

function isAbort(error, signal) {
  return signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.code === 'SESSION_QUERY_ABORTED';
}

function observationEvents(observation, sessionId) {
  if (!observation || observation.header?.id !== sessionId || typeof observation[Symbol.dispose] !== 'function') {
    fail('execution-log-corrupt', 'Session observation identity or lease is invalid');
  }
  return validatedEvents(observation.events, observation.cursor);
}

function validatedEvents(events, cursor) {
  if (!Array.isArray(events) || !Number.isSafeInteger(cursor) || cursor < -1) fail('execution-log-corrupt', 'Invalid session snapshot');
  if (events.length !== cursor + 1) fail('execution-log-corrupt', 'Session log is not a contiguous snapshot');
  for (const [index, event] of events.entries()) {
    if (!record(event) || event.seq !== index || typeof event.type !== 'string') {
      fail('execution-log-corrupt', 'Session log is not a contiguous snapshot');
    }
  }
  return events;
}

/**
 * Cold SDK observations append unmarked interruption repairs to an open log.
 * With no durable end reference, avoid consuming their provisional seqs. The
 * suffix is the SDK's exact deterministic shape, not a timestamp search for a turn.
 */
function withoutColdRepairs(events, observation, execution) {
  if (observation.source !== 'prepared' || execution.endSeq !== null) return events;
  const last = events.at(-1);
  if (last?.type !== 'turn/end' || last.data?.reason?.kind !== 'interrupted') return events;
  let cut = events.length - 1;
  const step = events[cut - 1];
  if (step?.type === 'step/end' && step.data?.turn === last.data.turn && step.time === last.time) cut -= 1;
  while (cut > 0) {
    const event = events[cut - 1];
    const data = event.data;
    const id = data?.message?.id;
    const callId = data?.message?.source?.callId;
    if (event.type !== 'tool/result' || event.time !== last.time || data?.turn !== last.data.turn ||
      id !== 'interrupted-tool-result-' + callId + '-' + event.seq ||
      !['TOOL_OUTCOME_UNKNOWN', 'TOOL_NOT_STARTED'].includes(data?.error?.code)) break;
    cut -= 1;
  }
  return cut > 0 && events[cut - 1].time === last.time ? events.slice(0, cut) : events;
}

/** Find actual enclosing brackets; unrelated turn coordinates also fence broken tails. */
function turnSpans(events) {
  const spans = [];
  let open;
  for (const event of events) {
    const turn = event.data?.turn;
    if (event.type === 'turn/start') {
      if (open) open.lastSeq = event.seq - 1;
      open = count(turn) && turn > 0 ? { turn, startSeq: event.seq, lastSeq: event.seq, end: null, inputs: [] } : undefined;
      if (open) spans.push(open);
      continue;
    }
    if (!open) continue;
    if (turn !== undefined && turn !== null && turn !== open.turn) {
      open.lastSeq = event.seq - 1;
      open = undefined;
      continue;
    }
    open.lastSeq = event.seq;
    if (event.type === 'user/message' && (!event.surfaceOp || event.surfaceOp === 'append')) open.inputs.push(event);
    if (event.type === 'turn/end') {
      // An unreadable end is still a fence; it is never presented as completion.
      if (turn === open.turn) open.end = event;
      open = undefined;
    }
  }
  return spans;
}

function resolveSpan(events, execution) {
  const spans = turnSpans(events);
  const matches = execution.inputMessageId ? spans.flatMap((span) => span.inputs
    .filter((event) => event.data?.id === execution.inputMessageId)
    .map((input) => ({ span, input }))) : [];
  if (matches.length > 1) return { reason: 'ambiguous-input-message' };
  let span;
  if (matches.length === 1) {
    span = matches[0].span;
    if (execution.submittedSeq !== undefined && matches[0].input.seq < execution.submittedSeq) return { reason: 'execution-reference-mismatch' };
    if (execution.turn !== null && execution.turn !== span.turn) return { reason: 'execution-reference-mismatch' };
  } else if (execution.turn !== null) {
    const candidates = spans.filter((entry) => entry.turn === execution.turn);
    if (candidates.length > 1) return { reason: 'ambiguous-recorded-turn' };
    span = candidates[0];
    // A turn number alone, without its recorded boundary, cannot authorize a read.
    if (span && execution.startSeq === null) return { reason: 'execution-boundary-missing' };
    if (span && execution.inputMessageId && span.inputs.some((event) => event.data?.source?.kind === 'user')) {
      return { reason: 'input-message-mismatch' };
    }
  }
  if (!span) return { reason: 'execution-turn-not-recorded', pending: true };
  if (execution.startSeq !== null && execution.startSeq !== span.startSeq) return { reason: 'execution-boundary-mismatch' };
  if (execution.submittedSeq !== undefined && span.startSeq < execution.submittedSeq) return { reason: 'execution-boundary-mismatch' };
  if (execution.endSeq !== null && (span.end || execution.endSeq <= (events.at(-1)?.seq ?? -1)) &&
      span.end?.seq !== execution.endSeq) return { reason: 'execution-boundary-mismatch' };
  // A future end must not extend through a later turn already present in the snapshot.
  if (execution.endSeq !== null && execution.endSeq > span.lastSeq && span.lastSeq < (events.at(-1)?.seq ?? -1)) {
    return { reason: 'execution-boundary-mismatch' };
  }
  return { span };
}

/** Keep the SDK event envelope and payload intact, including future event types. */
function page(events, span, afterSeq, limit) {
  const selected = [];
  let nextSeq = afterSeq;
  for (const event of events) {
    if (event.seq < span.startSeq || event.seq > span.lastSeq || event.seq <= afterSeq) continue;
    if (selected.length === limit) return { events: selected, nextSeq, hasMore: true };
    selected.push(clone(event));
    nextSeq = event.seq;
  }
  return { events: selected, nextSeq, hasMore: false };
}

function sessionDescriptor(header) {
  return {
    id: header.id,
    ...(header.origin === undefined ? {} : { origin: clone(header.origin) }),
    native: header.origin !== 'subagent',
  };
}

function failureReason(error) {
  if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND' || error?.code === 'ENOENT' || error?.name === 'SessionPersistenceNotFoundError') return 'session-log-missing';
  if (error?.name === 'SessionPersistenceCorruptionError') return 'session-log-corrupt';
  if (error?.name === 'SessionFormatUnsupportedError') return 'session-log-format-unsupported';
  if (['SESSION_QUERY_CORRUPT_SESSION', 'SESSION_QUERY_INVALID_SURFACE', 'execution-log-corrupt'].includes(error?.code)) return 'session-log-corrupt';
  if (error?.code === 'SESSION_QUERY_SOURCE_CONFLICT') return 'session-reference-mismatch';
  return 'session-log-read-failed';
}

/** Resolve group-owned references before any Session lookup, including historical Bots. */
function sessionReferences(repo, groupId, sessionId) {
  const group = repo.getGroup(groupId);
  if (!group || group.groupId !== groupId) fail('not-found', 'Group not found');
  const validId = (value) => typeof value === 'string' && ID.test(value);
  const binding = repo.sessionBindingFor?.(sessionId) || repo.sessionBindingsOf?.(groupId).find(candidate => candidate.sessionId === sessionId);
  if (binding && binding.groupId !== groupId) fail('invalid-input', 'Session does not belong to this group');
  const bound = binding && validId(binding.membershipId) && validId(binding.botId) &&
    typeof binding.conversationId === 'string' && conversationIdOf(repo, binding) === binding.conversationId;
  const current = !group.activeConversationId && repo.membersOf(groupId).some((member) =>
    member?.groupId === groupId && validId(member.membershipId) && validId(member.botId) && member.sessionId === sessionId,
  );
  const references = [];
  for (const message of repo.messagesOf(groupId)) {
    if (message?.groupId !== groupId || !validId(message.messageId) || message.author?.type !== 'bot' ||
        !validId(message.author.membershipId) || !validId(message.author.botId)) continue;
    const parsed = reference(message);
    if (parsed.execution?.sessionId === sessionId && (!group.activeConversationId ||
        (conversationIdOf(repo, message) && (!binding || conversationIdOf(repo, message) === binding.conversationId)))) {
      references.push(parsed.execution);
    }
  }
  if (!bound && !current && references.length === 0) fail('invalid-input', 'Session does not belong to this group');
  return references;
}

/** Read all raw events of a verified Bot Session without creating or resuming an Agent. */
export async function readBotSessionHistory({ ctx, repo, groupId, sessionId, afterSeq, limit, signal } = {}) {
  if (typeof groupId !== 'string' || !ID.test(groupId) || typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
    fail('invalid-input', 'groupId and sessionId must be valid identifiers');
  }
  afterSeq = integerParam(afterSeq, -1, -1, 'afterSeq');
  limit = Math.min(integerParam(limit, 100, 1, 'limit'), 300);
  abort(signal);
  sessionReferences(repo, groupId, sessionId);
  const result = (availability, extra = {}) => ({
    ok: true, groupId, sessionId, availability, events: [], nextSeq: afterSeq, hasMore: false, ...extra,
  });
  let observation;
  try {
    const query = typeof ctx?.get === 'function' ? ctx.get('sessionQuery') : ctx?.sessionQuery;
    if (typeof query?.observeSession !== 'function') return result('unavailable', { reason: 'session-query-unavailable' });
    observation = await query.observeSession(sessionId, { signal, projectionMode: 'none' });
    abort(signal);
    // Group removal or membership rotation may have raced the asynchronous read.
    const references = sessionReferences(repo, groupId, sessionId);
    const raw = observationEvents(observation, sessionId);
    const last = raw.at(-1);
    // Only a recorded end for this exact tail protects it from cold-repair removal.
    // An earlier turn's durable end must not legitimize a later synthetic suffix.
    const end = references.find((ref) => ref.endSeq === last?.seq && (ref.turn === null || ref.turn === last.data?.turn));
    const events = withoutColdRepairs(raw, observation, { endSeq: end?.endSeq ?? null });
    const span = { startSeq: 0, lastSeq: events.at(-1)?.seq ?? -1 };
    const response = result('available', { session: sessionDescriptor(observation.header), ...page(events, span, afterSeq, limit) });
    abort(signal);
    return response;
  } catch (error) {
    if (isAbort(error, signal)) throw error;
    if (error?.code === 'invalid-input' || error?.code === 'not-found') throw error;
    sessionReferences(repo, groupId, sessionId);
    return result('unavailable', { reason: failureReason(error) });
  } finally {
    if (typeof observation?.[Symbol.dispose] === 'function') observation[Symbol.dispose]();
  }
}

/**
 * Read a group-owned committed log for native JSONL export. A prepared query
 * observation is never an export source: it can contain unpersisted repairs.
 * Flush only a Session already attached to the store; never open/resume an Agent.
 * Returns { ok, groupId, sessionId, availability, header, events, session?, reason? }.
 */
export async function readBotSessionLog({ ctx, repo, groupId, sessionId, signal } = {}) {
  if (typeof groupId !== 'string' || !ID.test(groupId) || typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
    fail('invalid-input', 'groupId and sessionId must be valid identifiers');
  }
  abort(signal);
  sessionReferences(repo, groupId, sessionId);
  const result = (availability, extra = {}) => ({
    ok: true, groupId, sessionId, availability, header: null, events: [], ...extra,
  });
  try {
    const service = (name) => typeof ctx?.get === 'function' ? ctx.get(name) : ctx?.[name];
    const persistence = service('sessionPersistence');
    if (typeof persistence?.open !== 'function') return result('unavailable', { reason: 'session-persistence-unavailable' });
    const sessions = service('sessions');
    const live = sessions?.get?.(sessionId);
    if (live !== undefined) {
      if (typeof sessions.flush !== 'function') return result('unavailable', { reason: 'session-flush-unavailable' });
      await sessions.flush(live);
      abort(signal);
      sessionReferences(repo, groupId, sessionId);
    }
    const options = signal === undefined ? {} : { signal };
    let handle;
    let header;
    let events;
    try {
      handle = await persistence.open(sessionId, 'read', options);
      abort(signal);
      sessionReferences(repo, groupId, sessionId);
      if (!handle || handle.header?.id !== sessionId || typeof handle.read !== 'function' || typeof handle.close !== 'function') {
        fail('execution-log-corrupt', 'Session persistence identity or read handle is invalid');
      }
      const snapshot = await handle.read(0, undefined, options);
      abort(signal);
      sessionReferences(repo, groupId, sessionId);
      header = clone(handle.header);
      if (header?.id !== sessionId) fail('execution-log-corrupt', 'Session persistence identity changed during read');
      events = validatedEvents(snapshot?.events, snapshot?.events?.length - 1).map((event) => clone(event));
    } finally {
      if (typeof handle?.close === 'function') await handle.close();
    }
    abort(signal);
    sessionReferences(repo, groupId, sessionId);
    return result('available', { header, events, session: sessionDescriptor(header) });
  } catch (error) {
    abort(signal);
    if (isAbort(error, signal)) throw error;
    if (error?.code === 'invalid-input' || error?.code === 'not-found') throw error;
    sessionReferences(repo, groupId, sessionId);
    return result('unavailable', { reason: failureReason(error) });
  }
}

/**
 * afterSeq is exclusive; nextSeq is the last returned raw seq.
 * Bounds in execution are inclusive. hasMore describes this captured
 * snapshot only; callers may poll again while status is pending/streaming.
 */
export async function readMessageExecution({ ctx, repo, groupId, messageId, afterSeq, limit, signal } = {}) {
  if (typeof groupId !== 'string' || !ID.test(groupId) || typeof messageId !== 'string' || !ID.test(messageId)) {
    fail('invalid-input', 'groupId and messageId must be valid identifiers');
  }
  afterSeq = integerParam(afterSeq, -1, -1, 'afterSeq');
  limit = Math.min(integerParam(limit, 100, 1, 'limit'), 300);
  abort(signal);
  let message = target(repo, groupId, messageId);
  let parsed = reference(message);
  if (parsed.legacy) return legacyResponse(repo, message, afterSeq);
  if (parsed.reason) return response(message, afterSeq, 'unavailable', null, { reason: parsed.reason });
  let execution = parsed.execution;
  validateExecutionOwnership(repo, message, execution);
  if (!execution.sessionId) return response(message, afterSeq, ACTIVE.has(message.status) ? 'preparing' : 'unavailable', execution, { reason: 'execution-session-not-recorded' });
  let observation;
  try {
    // Cordis rejects property reads for services outside the plugin's inject
    // list. sessionQuery is optional: resolve it through get before touching
    // the property used by plain-context adapters.
    const query = typeof ctx?.get === 'function' ? ctx.get('sessionQuery') : ctx?.sessionQuery;
    if (typeof query?.observeSession !== 'function') return response(message, afterSeq, 'unavailable', execution, { reason: 'session-query-unavailable' });
    observation = await query.observeSession(execution.sessionId, { signal, projectionMode: 'none' });
    abort(signal);
    // Reads can race lifecycle writes. Classify using the current durable message.
    message = target(repo, groupId, messageId);
    parsed = reference(message);
    if (!parsed.execution || parsed.execution.jobId !== execution.jobId || parsed.execution.sessionId !== execution.sessionId) {
      return response(message, afterSeq, 'unavailable', parsed.execution, { reason: 'execution-reference-changed' });
    }
    execution = parsed.execution;
    validateExecutionOwnership(repo, message, execution);
    const events = withoutColdRepairs(observationEvents(observation, execution.sessionId), observation, execution);
    const session = sessionDescriptor(observation.header);
    const resolved = resolveSpan(events, execution);
    if (!resolved.span) return response(message, afterSeq, resolved.pending && ACTIVE.has(message.status) ? 'preparing' : 'unavailable', execution, { session, reason: resolved.reason });
    const { span } = resolved;
    execution = { ...execution, turn: span.turn, startSeq: span.startSeq };
    if (execution.endSeq === null && span.end && span.end.data?.reason?.kind !== 'interrupted') execution.endSeq = span.end.seq;
    const incomplete = !span.end || execution.endSeq === null;
    const result = response(message, afterSeq, 'available', execution, {
      session,
      ...page(events, span, afterSeq, limit),
      ...(incomplete ? { reason: 'execution-log-incomplete' } : {}),
    });
    abort(signal);
    return result;
  } catch (error) {
    if (isAbort(error, signal)) throw error;
    if (error?.code === 'invalid-input' || error?.code === 'not-found') throw error;
    // A failed read can race terminal lifecycle updates too.
    message = target(repo, groupId, messageId);
    execution = reference(message).execution;
    validateExecutionOwnership(repo, message, execution);
    // Do not return SDK exception text: storage errors can include private paths.
    return response(message, afterSeq, 'unavailable', execution, { reason: failureReason(error) });
  } finally {
    if (typeof observation?.[Symbol.dispose] === 'function') observation[Symbol.dispose]();
  }
}
