/** Read Bot executions and group-owned Session history through session-query. */
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

function pick(value, keys) {
  const result = {};
  if (!record(value)) return result;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !own(descriptor, 'value')) continue;
    const copied = clone(descriptor.value);
    if (copied !== undefined) result[key] = copied;
  }
  return result;
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

function legacyResponse(repo, message, afterSeq) {
  const member = repo.getMember?.(message.author.membershipId);
  const fallback = typeof message.author.botId === 'string' && ID.test(message.author.botId) &&
    typeof message.author.membershipId === 'string' && ID.test(message.author.membershipId) &&
    member && member.groupId === message.groupId &&
    member.membershipId === message.author.membershipId && member.botId === message.author.botId &&
    typeof member.sessionId === 'string' && SESSION_ID.test(member.sessionId);
  return response(message, afterSeq, 'legacy-unlinked', null, {
    reason: 'legacy-message-has-no-execution-reference',
    ...(fallback ? { fallbackSessionId: member.sessionId } : {}),
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
  const events = observation.events;
  const cursor = observation.cursor;
  if (!Array.isArray(events) || !Number.isSafeInteger(cursor) || cursor < -1) fail('execution-log-corrupt', 'Invalid session snapshot');
  if (events.length !== cursor + 1 || events.some((event, index) => !record(event) || event.seq !== index || typeof event.type !== 'string')) {
    fail('execution-log-corrupt', 'Session log is not a contiguous snapshot');
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

function errorInfo(value) {
  return typeof value === 'string' ? value : pick(value, ['name', 'code', 'message', 'retryable', 'status', 'statusCode', 'providerRetryAfterMs']);
}

function userMessage(data) {
  const result = pick(data, ['id', 'role']);
  result.source = pick(data?.source, ['kind']);
  result.content = Array.isArray(data?.content) ? data.content.filter((block) =>
    block && ['text', 'image', 'image-url', 'file', 'audio'].includes(block.type) && block.hidden !== true && block.internal !== true,
  ).map((block) => block.type === 'text' ? pick(block, ['type', 'text']) : clone(block)) : [];
  return result;
}

/** Explicit observable vocabulary: no request envelopes, inbox copies or opaque streams. */
function project(event, inputMessageId) {
  const data = record(event.data) ? event.data : {};
  let projected;
  switch (event.type) {
    case 'user/message':
      if (event.surfaceOp && event.surfaceOp !== 'append') return null;
      if ((typeof inputMessageId !== 'string' || data.id !== inputMessageId) && data.source?.kind !== 'user') return null;
      projected = userMessage(data);
      break;
    case 'turn/start':
    case 'step/start':
    case 'step/end':
    case 'assistant/attempt':
      projected = pick(data, ['turn', 'step']);
      break;
    case 'turn/end':
      projected = pick(data, ['turn']);
      projected.reason = pick(data.reason, ['kind']);
      if (data.reason?.reason) projected.reason.reason = pick(data.reason.reason, ['kind']);
      if (data.reason?.error) projected.reason.error = errorInfo(data.reason.error);
      break;
    case 'assistant/message': {
      if (event.surfaceOp && event.surfaceOp !== 'append') return null;
      const content = Array.isArray(data.message?.content) ? data.message.content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string' && block.hidden !== true && block.internal !== true && block.visibility !== 'hidden')
        .map((block) => ({ type: 'text', text: block.text })) : [];
      if (content.length === 0) return null;
      projected = pick(data, ['turn', 'step', 'interrupted', 'usage']);
      projected.message = { ...pick(data.message, ['id', 'role']), content, source: pick(data.message?.source, ['provider', 'model']) };
      break;
    }
    case 'tool/call':
      projected = pick(data, ['turn', 'step', 'callId', 'name', 'arguments']);
      break;
    case 'tool/result':
      if (event.surfaceOp && event.surfaceOp !== 'append') return null;
      projected = pick(data, ['turn', 'step', 'meta']);
      projected.message = pick(data.message, ['id', 'role', 'toolCallId', 'isError', 'content']);
      projected.message.source = pick(data.message?.source, ['kind', 'callId']);
      if (data.error !== undefined) projected.error = errorInfo(data.error);
      break;
    case 'tool/ptc-dispatch-start':
    case 'tool/ptc-dispatch':
    case 'tool/ptc-dispatch-end':
      projected = pick(data, ['turn', 'step', 'rootCallId', 'parentCallId', 'subCallId', 'name', 'arguments', 'isError', 'content', 'meta']);
      if (data.error !== undefined) projected.error = errorInfo(data.error);
      break;
    case 'approval/asked':
      projected = pick(data, ['id', 'toolName', 'callId', 'reason']);
      break;
    case 'approval/decided':
      projected = pick(data, ['id', 'outcome']);
      break;
    case 'llm/retry':
    case 'llm/retry-started':
      projected = pick(data, ['turn', 'step', 'retryId', 'retry', 'provider', 'mode', 'maxRetries', 'delayMs']);
      if (data.failure !== undefined) projected.failure = errorInfo(data.failure);
      break;
    case 'compaction/start':
    case 'compaction/summary':
    case 'compaction/end':
    case 'compaction/prune':
      // The summary/rawOutput can repeat prompts, reasoning and adjacent turns.
      projected = pick(data, ['turn', 'compactionId', 'sourceCommandId', 'shadowedRange', 'shadowedSeqs', 'shadowedTokenCount', 'provider', 'model', 'maxTokens', 'usage', 'prunedSeqs']);
      if (data.error !== undefined) projected.error = errorInfo(data.error);
      break;
    default:
      return null;
  }
  return { seq: event.seq, time: clone(event.time) ?? null, type: event.type, data: projected };
}

function page(events, span, execution, afterSeq, limit) {
  const visible = [];
  let nextSeq = afterSeq;
  for (const event of events) {
    if (event.seq < span.startSeq || event.seq > span.lastSeq || event.seq <= afterSeq) continue;
    const item = project(event, execution.inputMessageId);
    if (item && visible.length === limit) return { events: visible, nextSeq, hasMore: true };
    nextSeq = event.seq;
    if (item) visible.push(item);
  }
  return { events: visible, nextSeq, hasMore: false };
}

function failureReason(error) {
  if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND' || error?.code === 'ENOENT') return 'session-log-missing';
  if (['SESSION_QUERY_CORRUPT_SESSION', 'SESSION_QUERY_INVALID_SURFACE', 'execution-log-corrupt'].includes(error?.code)) return 'session-log-corrupt';
  if (error?.code === 'SESSION_QUERY_SOURCE_CONFLICT') return 'session-reference-mismatch';
  return 'session-log-read-failed';
}

/** Resolve group-owned references before any Session lookup, including historical Bots. */
function sessionReferences(repo, groupId, sessionId) {
  const group = repo.getGroup(groupId);
  if (!group || group.groupId !== groupId) fail('not-found', 'Group not found');
  const validId = (value) => typeof value === 'string' && ID.test(value);
  const current = repo.membersOf(groupId).some((member) =>
    member?.groupId === groupId && validId(member.membershipId) && validId(member.botId) && member.sessionId === sessionId,
  );
  const references = [];
  for (const message of repo.messagesOf(groupId)) {
    if (message?.groupId !== groupId || !validId(message.messageId) || message.author?.type !== 'bot' ||
        !validId(message.author.membershipId) || !validId(message.author.botId)) continue;
    const parsed = reference(message);
    if (parsed.execution?.sessionId === sessionId) references.push(parsed.execution);
  }
  if (!current && references.length === 0) fail('invalid-input', 'Session does not belong to this group');
  return references;
}

/** Read every visible turn of a verified Bot Session without creating or resuming an Agent. */
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
    const response = result('available', page(events, span, { inputMessageId: null }, afterSeq, limit));
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
 * afterSeq is exclusive; nextSeq is the last examined raw seq (including hidden
 * records). Bounds in execution are inclusive. hasMore describes this captured
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
    const events = withoutColdRepairs(observationEvents(observation, execution.sessionId), observation, execution);
    const resolved = resolveSpan(events, execution);
    if (!resolved.span) return response(message, afterSeq, resolved.pending && ACTIVE.has(message.status) ? 'preparing' : 'unavailable', execution, { reason: resolved.reason });
    const { span } = resolved;
    execution = { ...execution, turn: span.turn, startSeq: span.startSeq };
    if (execution.endSeq === null && span.end && span.end.data?.reason?.kind !== 'interrupted') execution.endSeq = span.end.seq;
    const incomplete = !span.end || execution.endSeq === null;
    const result = response(message, afterSeq, 'available', execution, {
      ...page(events, span, execution, afterSeq, limit),
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
    // Do not return SDK exception text: storage errors can include private paths.
    return response(message, afterSeq, 'unavailable', execution, { reason: failureReason(error) });
  } finally {
    if (typeof observation?.[Symbol.dispose] === 'function') observation[Symbol.dispose]();
  }
}
