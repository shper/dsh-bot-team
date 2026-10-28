/**
 * Host-observed average output rate for the latest model request, not pure
 * decoder throughput. Stream start precedes the first delivered chunk;
 * assistant/message commits before tool execution. The interval includes
 * request waiting, reasoning, network delivery and local stream settlement.
 */
import { performance } from 'node:perf_hooks';

const position = (value) => Number.isSafeInteger(value) && value > 0;
const sequence = (value) => Number.isSafeInteger(value) && value >= 0;

export class LastRequestMetrics {
  constructor(clock = () => performance.now()) {
    this.clock = clock;
    this.active = null;
    this.stats = null;
    this.lastRevision = -1;
    this.lastStep = 0;
    this.lastEventSeq = -1;
  }

  start(frame, turn) {
    // Other turns, duplicate starts and delayed older starts must not replace
    // the active attempt. Revisions are ordered within one Agent lifecycle.
    if (!position(turn) || (position(frame.turn) && frame.turn !== turn)) return;
    if (!position(frame.turn)) {
      this.active = null;
      this.stats = null;
      return;
    }
    if (sequence(frame.revision) && frame.revision <= this.lastRevision) return;
    if (position(frame.step) && frame.step < this.lastStep) return;
    this.active = null;
    this.stats = null;
    if (!position(frame.step) || !sequence(frame.revision) || typeof frame.attemptId !== 'string' || !frame.attemptId) return;
    this.lastRevision = frame.revision;
    this.lastStep = frame.step;
    const started = this.clock();
    if (!Number.isFinite(started)) return;
    this.active = {
      attemptId: frame.attemptId,
      turn,
      step: frame.step,
      started,
      messageSeq: null,
      candidate: null,
    };
  }

  settle(event, turn) {
    const data = event.data;
    if (!data || data.turn !== turn || !position(turn)) return;
    if (position(data.step) && data.step < this.lastStep) return;
    if (sequence(event.seq) && event.seq <= this.lastEventSeq) return;
    if (sequence(event.seq)) this.lastEventSeq = event.seq;
    // Never pair old usage with a later request's duration, including a later
    // response that reports no usage at all.
    this.stats = null;
    const active = this.active;
    if (!active || active.turn !== data.turn || active.step !== data.step || !sequence(event.seq)) {
      this.active = null;
      return;
    }
    if (event.type !== 'assistant/message' || data.interrupted === true) {
      this.active = null;
      return;
    }
    const durationMs = this.clock() - active.started;
    const outputTokens = data.usage?.outputTokens;
    active.messageSeq = event.seq;
    active.candidate = null;
    if (!Number.isFinite(durationMs) || durationMs <= 0 || !sequence(outputTokens)) return;
    const tokensPerSecond = outputTokens * 1000 / durationMs;
    if (!Number.isFinite(tokensPerSecond)) return;
    active.candidate = { scope: 'last-request', durationMs, outputTokens, tokensPerSecond };
  }

  end(frame) {
    const active = this.active;
    if (!active || frame.attemptId !== active.attemptId) return;
    if (sequence(frame.revision) && frame.revision <= this.lastRevision) return;
    if (sequence(frame.revision)) this.lastRevision = frame.revision;
    const outcome = frame.outcome;
    // assistant/message has turn/step but no attemptId. Its corresponding end
    // frame supplies the exact committed seq, disambiguating same-step retries.
    this.stats = outcome?.kind === 'committed' && outcome.eventType === 'assistant/message' &&
      outcome.seq === active.messageSeq ? active.candidate : null;
    this.active = null;
  }

  finish(status) {
    // Fail closed on cancellation, failure, missing end frames or a new request
    // still in flight; an earlier successful step is not the latest response.
    const stats = status === 'done' && !this.active ? this.stats : null;
    this.active = null;
    this.stats = null;
    return stats;
  }
}
