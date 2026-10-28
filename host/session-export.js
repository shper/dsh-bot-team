/**
 * Match @deepseek-ai/dsh-session-log-export's canonical JSONL format.
 * Call only with the committed header/events from readBotSessionLog, never a
 * prepared sessionQuery observation (which can append in-memory repair events).
 * The header schema belongs to the native log format; event payloads are opaque.
 */
export function serializeBotSessionLog(header, events) {
  const lines = [JSON.stringify({
    type: 'session',
    version: header.version,
    id: header.id,
    createdAt: header.createdAt,
    ...(header.cwd !== undefined ? { cwd: header.cwd } : {}),
    ...(header.parentSession !== undefined ? { parentSession: header.parentSession } : {}),
    isSeeded: header.isSeeded,
    ...(header.origin !== undefined ? { origin: header.origin } : {}),
    delegationDepth: header.delegationDepth ?? 0,
    ...(header.agentPreset !== undefined ? { agentPreset: header.agentPreset } : {}),
  })];
  for (const event of events) lines.push(JSON.stringify(event));
  return lines.join('\n') + '\n';
}
