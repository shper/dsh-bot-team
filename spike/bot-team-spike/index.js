/**
 * M0 spike — Host half.
 *
 * Throwaway verification plugin for the Bot Team design. On activation it:
 *   1. opens a plugin-owned storage domain (bot_team_spike) and checks put/get/update/delete,
 *   2. creates a real DSH agent for a "bot" with a custom model route, a custom
 *      persona system-prompt section and approval=never, drives one turn through
 *      agent.followup(), and captures the reply from session events,
 *   3. verifies the persona text reached the assembled system prompt,
 *   4. verifies the session header carries origin='subagent' and the request
 *      header carries the requested provider/model,
 *   5. disposes the agent and resumes the same session, driving one more turn,
 *   6. exposes three authenticated exact Fetch routes used by the client half:
 *        GET  /api/bot-team-spike.bootstrap
 *        POST /api/bot-team-spike.action
 *        GET  /api/bot-team-spike.events   (SSE)
 *   7. appends every check result to <resultsDir>/results.jsonl.
 *
 * No DSH package imports: only ctx services and Node builtins. This also tests
 * that a profile-installed plain-JS bundle can do everything the real plugin
 * needs without bundling @deepseek-ai packages.
 */
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const name = 'bot-team-spike';
export const inject = ['agents', 'storageDomain', 'connection', 'tools'];

const ROUTE_BOOTSTRAP = '/api/bot-team-spike.bootstrap';
const ROUTE_ACTION = '/api/bot-team-spike.action';
const ROUTE_EVENTS = '/api/bot-team-spike.events';
const DOMAIN_NAME = 'bot_team_spike';
const PERSONA_MARKER =
  'SPIKE_PERSONA_MARKER: 你的名字是 SpikeBot，代号 SPIKE-42。你只输出被要求的测试标记。';

function passThroughSchema(label) {
  return {
    parse(value) {
      if (value === null || typeof value !== 'object') {
        throw new Error(`${label}: record must be a plain object, got ${value === null ? 'null' : typeof value}`);
      }
      return value;
    },
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function sseFrame(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        resolve({ ok: false, error: String(error && error.message ? error.message : error) });
      },
    );
  });
}

export function apply(ctx, rawConfig = {}) {
  const config = {
    resultsDir: typeof rawConfig.resultsDir === 'string' && rawConfig.resultsDir.length > 0
      ? rawConfig.resultsDir
      : process.cwd(),
    autoSelfTest: rawConfig.autoSelfTest !== false,
    sseCloseAfterFrames: Number.isInteger(rawConfig.sseCloseAfterFrames) ? rawConfig.sseCloseAfterFrames : 3,
    turnTimeoutMs: Number.isInteger(rawConfig.turnTimeoutMs) ? rawConfig.turnTimeoutMs : 120000,
    personaMarker: typeof rawConfig.personaMarker === 'string' ? rawConfig.personaMarker : PERSONA_MARKER,
  };

  const state = {
    nonce: randomUUID(),
    domain: null,
    domainError: null,
    ready: false,
    disposed: false,
    sseSubscribers: new Set(),
    seq: 0,
    hostResults: [],
    clientReports: [],
    bot: null,            // { sessionId, handle, provider, model, modelSource, events }
    internalEvents: [],   // session events seen while a spike turn is awaited
    lastError: null,
  };

  // ── result reporting ──────────────────────────────────────────────────────
  async function appendResults(source, results) {
    const rows = results.map((result) => ({
      source,
      at: new Date().toISOString(),
      spikeNonce: state.nonce,
      ...result,
    }));
    try {
      await mkdir(config.resultsDir, { recursive: true });
      await appendFile(
        path.join(config.resultsDir, 'results.jsonl'),
        rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
        'utf8',
      );
    } catch (error) {
      // Never let reporting failure break a check.
      state.lastError = `results write failed: ${String(error)}`;
    }
    return rows;
  }

  async function reportHost(id, pass, detail) {
    const result = { id, pass: pass === true, detail: detail === undefined ? '' : detail };
    state.hostResults.push(result);
    await appendResults('host', [result]);
    return result;
  }

  // ── SSE bus ───────────────────────────────────────────────────────────────
  function publish(frame) {
    state.seq += 1;
    const payload = { ...frame, seq: state.seq, t: Date.now() };
    for (const write of [...state.sseSubscribers]) {
      try {
        write(payload);
      } catch {
        state.sseSubscribers.delete(write);
      }
    }
  }

  // ── model route discovery ────────────────────────────────────────────────
  async function pickModelRoute() {
    const attempted = [];
    let catalog = null;
    const controller = ctx.get('sessionController');
    if (controller && typeof controller.modelCatalog === 'function') {
      try {
        catalog = await controller.modelCatalog();
      } catch (error) {
        attempted.push(`modelCatalog failed: ${String(error)}`);
      }
    }
    let defaultSelection = catalog && catalog.default ? catalog.default : undefined;
    if (!defaultSelection) {
      const defaultModel = ctx.get('agentDefaultModel');
      if (defaultModel && typeof defaultModel.currentSelection === 'function') {
        defaultSelection = defaultModel.currentSelection();
      }
    }
    const candidates = [];
    for (const group of (catalog && catalog.groups) || []) {
      for (const model of group.models || []) {
        candidates.push({ provider: group.id, model: model.id });
      }
    }
    if (candidates.length === 0) {
      const llm = ctx.get('llm');
      if (llm && typeof llm.listProviders === 'function') {
        for (const provider of llm.listProviders()) {
          try {
            const models = await llm.listModels(provider.id);
            for (const model of models) candidates.push({ provider: provider.id, model: model.id });
          } catch (error) {
            attempted.push(`listModels(${provider.id}) failed: ${String(error)}`);
          }
        }
      }
    }
    if (!defaultSelection && candidates.length > 0) defaultSelection = candidates[0];
    const alternative = candidates.find(
      (candidate) =>
        !defaultSelection ||
        candidate.provider !== defaultSelection.provider ||
        candidate.model !== defaultSelection.model,
    );
    if (alternative) {
      return {
        provider: alternative.provider,
        model: alternative.model,
        modelSource: 'catalog-alternative',
        defaultSelection: defaultSelection || null,
        candidates,
        attempted,
      };
    }
    return {
      provider: defaultSelection ? defaultSelection.provider : 'deepseek-account',
      model: defaultSelection ? defaultSelection.model : 'deepseek-flash',
      modelSource: 'default-selection',
      defaultSelection: defaultSelection || null,
      candidates,
      attempted,
    };
  }

  // ── agent turn plumbing ──────────────────────────────────────────────────
  function waitForTurn(agent, prompt, label) {
    const sessionId = agent.id;
    return new Promise((resolve) => {
      let turn;
      const assistantTexts = [];
      let usage;
      let settled = false;
      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve({ label, turn, assistantTexts, usage, ...outcome });
      };
      const off = ctx.on('session/event', (session, event) => {
        if (!session || session.id !== sessionId) return;
        if (event.type === 'turn/start' && turn === undefined) {
          turn = event.data.turn;
        }
        if (event.type === 'assistant/message' && event.data.turn === turn) {
          const message = event.data.message;
          const text = (message.content || [])
            .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('');
          if (text) assistantTexts.push(text);
          if (event.data.usage) usage = event.data.usage;
        }
        if (event.type === 'turn/end' && event.data.turn === turn) {
          const reason = event.data.reason || {};
          finish({
            ok: reason.kind === 'completed',
            reasonKind: reason.kind || 'unknown',
            reason: JSON.stringify(reason).slice(0, 800),
          });
        }
      });
      const timer = setTimeout(
        () => finish({ ok: false, reasonKind: 'spike-timeout', reason: `no turn/end within ${config.turnTimeoutMs}ms` }),
        config.turnTimeoutMs,
      );
      try {
        // Agent.followup() puts the EXACT value into the durable inbox: it must be a
        // complete UserMessage (role + id + content + source), not a partial input.
        // A partial {content, source} is what the first spike run proved corrupts the
        // session log ("event lacks an identified message") and breaks the LLM body.
        const message = {
          role: 'user',
          id: randomUUID(),
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'user' },
        };
        const maybePromise = agent.followup(message);
        if (maybePromise && typeof maybePromise.catch === 'function') {
          maybePromise.catch((error) => finish({ ok: false, reasonKind: 'followup-rejected', reason: String(error) }));
        }
      } catch (error) {
        finish({ ok: false, reasonKind: 'followup-threw', reason: String(error) });
      }
    });
  }

  function makeSetup(agentCtx, agent) {
    // Persona replacement: same name as the deployment section → shadows it for this agent.
    const disposer = agentCtx.systemPrompt.section({
      name: 'deployment:persona-prefix',
      order: 0,
      text: () => config.personaMarker,
    });
    const approval = ctx.get('approval');
    let approvalApplied = false;
    if (approval && typeof approval.setPolicy === 'function') {
      try {
        approval.setPolicy(agent, 'never');
        approvalApplied = true;
      } catch (error) {
        state.lastError = `approval.setPolicy failed: ${String(error)}`;
      }
    }
    return {
      disposer,
      approvalApplied,
      assembled: null,
      assembleError: null,
    };
  }

  // ── host self test ───────────────────────────────────────────────────────
  async function runHostSelfTest() {
    await reportHost('host.selftest.started', true, `resultsDir=${config.resultsDir}`);

    // (A) domain open ------------------------------------------------------
    try {
      let lastError;
      for (let attempt = 0; attempt < 5 && !state.domain; attempt += 1) {
        try {
          state.domain = await ctx.storageDomain.open({
            name: DOMAIN_NAME,
            version: 1,
            layout: 'per-record',
            tables: {
              probes: { valueSchema: passThroughSchema('probes') },
              reports: { valueSchema: passThroughSchema('reports') },
            },
          });
        } catch (error) {
          lastError = error;
          const message = String(error && error.message ? error.message : error);
          if (!message.includes('already-open')) throw error;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      if (!state.domain) throw lastError || new Error('domain did not open');
      await reportHost('host.domain.open', true, `domain=${DOMAIN_NAME}`);
    } catch (error) {
      state.domainError = String(error && error.message ? error.message : error);
      await reportHost('host.domain.open', false, state.domainError);
      return; // everything else needs the domain
    }

    // (B) put/get/update/delete + domain/changed ---------------------------
    try {
      const domainEvents = [];
      const off = ctx.on('domain/changed', (change) => domainEvents.push(change));
      const probes = state.domain.table('probes');
      await probes.put('probe-host', { nonce: state.nonce, at: Date.now(), step: 1 });
      const readBack = probes.get('probe-host');
      await probes.update('probe-host', (current) => ({ ...current, step: 2 }));
      const updated = probes.get('probe-host');
      await probes.put('probe-deleted', { temporary: true });
      const deleted = await probes.delete('probe-deleted');
      off();
      const pass =
        !!readBack &&
        readBack.nonce === state.nonce &&
        updated &&
        updated.step === 2 &&
        deleted === true &&
        probes.get('probe-deleted') === undefined;
      await reportHost(
        'host.domain.crud',
        pass,
        `readNonce=${readBack && readBack.nonce} step=${updated && updated.step} deleted=${deleted} changeEvents=${domainEvents.length}`,
      );
      await reportHost(
        'host.domain.changeEvents',
        domainEvents.length >= 3,
        `events=${domainEvents.length} keys=${domainEvents.map((change) => `${change.table}/${change.key}/${change.operation}`).join(',')}`,
      );
    } catch (error) {
      await reportHost('host.domain.crud', false, String(error && error.stack ? error.stack : error));
    }

    // (C) bot agent: create + model + persona + one turn -------------------
    try {
      await waitForService('llm', 20000);

      // (C0) Cross-process recovery: resume the bot session recorded by a
      // previous activation (this is what a real DSH restart exercises).
      try {
        const previous = state.domain.table('probes').get('state-last-bot');
        if (previous && typeof previous.sessionId === 'string') {
          try {
            const previousHandle = await ctx.agents.resume({
              resumeSessionId: previous.sessionId,
              agentOptions: { provider: previous.provider, model: previous.model },
              setup: async (agentCtx, agent) => {
                makeSetup(agentCtx, agent);
              },
            });
            const previousTurn = await waitForTurn(
              previousHandle.agent,
              '重启恢复测试：请只回复一行 RESTART-OK。不要使用任何工具。',
              'restart',
            );
            const previousText = (previousTurn.assistantTexts || []).join('\n').trim();
            await reportHost(
              'host.bot.restartResume',
              previousTurn.ok === true && previousText.length > 0,
              `sessionId=${previous.sessionId} provider=${previous.provider} model=${previous.model} ok=${previousTurn.ok} reasonKind=${previousTurn.reasonKind || ''} reason=${(previousTurn.reason || '').slice(0, 400)} text=${JSON.stringify(previousText.slice(0, 200))}`,
            );
            await previousHandle.dispose();
          } catch (error) {
            await reportHost(
              'host.bot.restartResume',
              false,
              `resume of ${previous.sessionId} failed: ${String(error && error.stack ? error.stack : error).slice(0, 1200)}`,
            );
          }
        } else {
          await reportHost('host.bot.restartResume', true, 'no previous bot session recorded yet — skipped on first run');
        }
      } catch (error) {
        await reportHost('host.bot.restartResume', false, `pre-check failed: ${String(error)}`);
      }

      const route = await pickModelRoute();
      const sessionId = `session-spike-${randomUUID()}`;
      let setupInfo = null;
      const handle = await ctx.agents.create({
        sessionId,
        meta: { cwd: path.resolve(config.resultsDir), origin: 'subagent' },
        agentOptions: {
          provider: route.provider,
          model: route.model,
        },
        setup: async (agentCtx, agent) => {
          setupInfo = makeSetup(agentCtx, agent);
          // Prove the scoped persona section participates in the assembled prompt.
          try {
            setupInfo.assembled = await agentCtx.systemPrompt.assemble();
          } catch (error) {
            setupInfo.assembleError = String(error && error.message ? error.message : error);
          }
        },
      });
      state.bot = { sessionId, handle, route, setupInfo };
      await reportHost(
        'host.bot.created',
        true,
        `sessionId=${sessionId} origin=subagent model=${route.provider}/${route.model} modelSource=${route.modelSource} candidates=${route.candidates.length} approvalNever=${!!(setupInfo && setupInfo.approvalApplied)}`,
      );

      const assembledSections = setupInfo && setupInfo.assembled ? setupInfo.assembled.sections : [];
      const personaInAssembly = assembledSections.some(
        (section) => typeof section.text === 'string' && section.text.includes('SPIKE-42'),
      );

      const firstTurn = await waitForTurn(
        handle.agent,
        '请只回复一行：SPIKE-BOT-OK。不要使用任何工具，不要解释。',
        'first',
      );
      const replyText = (firstTurn.assistantTexts || []).join('\n').trim();
      await reportHost(
        'host.bot.firstTurn',
        firstTurn.ok === true && replyText.length > 0,
        `ok=${firstTurn.ok} reasonKind=${firstTurn.reasonKind || ''} reason=${(firstTurn.reason || '').slice(0, 600)} text=${JSON.stringify(replyText.slice(0, 300))} usage=${JSON.stringify(firstTurn.usage || null)}`,
      );
      // Remember the session so a later activation (or an app restart) can resume it.
      if (firstTurn.ok === true) {
        await state.domain.table('probes').put('state-last-bot', {
          sessionId,
          provider: route.provider,
          model: route.model,
          at: Date.now(),
        });
      }

      // (D) durable evidence: session header + request header + system message
      const events = handle.agent.session.snapshotEvents();
      const header = handle.agent.session.header || {};
      const requestHeaderEvent = [...events].reverse().find((event) => event.type === 'request/header');
      const requestHeader = requestHeaderEvent && requestHeaderEvent.data && requestHeaderEvent.data.header;
      const configuredRoute = requestHeader && requestHeader.config
        ? `${requestHeader.config.provider}/${requestHeader.config.model}`
        : 'missing';
      const userMessages = events.filter((event) => event.type === 'user/message').length;
      const assistantMessages = events.filter((event) => event.type === 'assistant/message').length;
      const systemTexts = events
        .filter((event) => event.type === 'system/message')
        .map((event) => JSON.stringify(event.data));
      const deploymentPersonaPresent = systemTexts.some((text) =>
        text.includes('You are a coding agent powered by'),
      );
      const spikeMarkerPresent = systemTexts.some((text) => text.includes('SPIKE-42'));

      await reportHost(
        'host.bot.sessionHeader',
        header.origin === 'subagent' && header.id === sessionId,
        `id=${header.id} origin=${header.origin} parentSession=${header.parentSession || 'none'} headerAgentPreset=${header.agentPreset || 'none'}`,
      );
      await reportHost(
        'host.bot.requestHeaderRoute',
        configuredRoute === `${route.provider}/${route.model}`,
        `requested=${route.provider}/${route.model} logged=${configuredRoute}`,
      );
      await reportHost(
        'host.bot.personaShadowedDeployment',
        spikeMarkerPresent && !deploymentPersonaPresent,
        `spikeMarkerPresent=${spikeMarkerPresent} deploymentPersonaPresent=${deploymentPersonaPresent} setupAssemblyMarker=${personaInAssembly} setupAssembleError=${(setupInfo && setupInfo.assembleError) || 'none'} userMessages=${userMessages} assistantMessages=${assistantMessages}`,
      );

      // (E) dispose + resume -------------------------------------------------
      await handle.dispose();
      const stillLive = ctx.agents.get(sessionId) !== undefined;
      await reportHost('host.bot.disposed', !stillLive, `liveAfterDispose=${stillLive}`);

      let resumedSetupInfo = null;
      const resumed = await ctx.agents.resume({
        resumeSessionId: sessionId,
        // Resume does NOT inherit the route from the stored session: the caller must
        // re-supply AgentOptions (or pin it from the agent/request waterfall).
        agentOptions: {
          provider: route.provider,
          model: route.model,
        },
        setup: async (agentCtx, agent) => {
          resumedSetupInfo = makeSetup(agentCtx, agent);
        },
      });
      state.bot.handle = resumed;
      await reportHost(
        'host.bot.resumed',
        resumed.agent.id === sessionId,
        `resumedId=${resumed.agent.id} approvalNever=${!!(resumedSetupInfo && resumedSetupInfo.approvalApplied)}`,
      );

      const resumedTurn = await waitForTurn(
        resumed.agent,
        '恢复测试：请只回复一行 RESUME-OK。不要使用任何工具。',
        'resume',
      );
      const resumedReply = (resumedTurn.assistantTexts || []).join('\n').trim();
      await reportHost(
        'host.bot.resumedTurn',
        resumedTurn.ok === true && resumedReply.length > 0,
        `ok=${resumedTurn.ok} reasonKind=${resumedTurn.reasonKind || ''} reason=${(resumedTurn.reason || '').slice(0, 600)} text=${JSON.stringify(resumedReply.slice(0, 300))} turn=${resumedTurn.turn}`,
      );

      // History continuity: the session should now contain both user prompts.
      const eventsAfterResume = resumed.agent.session.snapshotEvents();
      const promptsVisible = eventsAfterResume.filter((event) => event.type === 'user/message').length;
      await reportHost(
        'host.bot.historyContinuity',
        promptsVisible >= 2,
        `userMessages=${promptsVisible} totalEvents=${eventsAfterResume.length}`,
      );
    } catch (error) {
      await reportHost('host.bot.error', false, String(error && error.stack ? error.stack : error));
    }

    await reportHost('host.selftest.done', true, `hostResults=${state.hostResults.length} lastError=${state.lastError || 'none'}`);
  }

  async function waitForService(key, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const service = ctx.get(key);
      if (service) return service;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`service ${key} not available after ${timeoutMs}ms`);
  }

  // ── routes ───────────────────────────────────────────────────────────────
  function bootstrapBody() {
    let probeKeys = [];
    let reportKeys = [];
    try {
      if (state.domain) {
        probeKeys = [...state.domain.table('probes').keys()];
        reportKeys = [...state.domain.table('reports').keys()];
      }
    } catch {
      // domain not readable yet
    }
    return {
      ok: true,
      ready: state.ready,
      spikeNonce: state.nonce,
      domainOpen: !!state.domain,
      domainError: state.domainError,
      probeKeys,
      reportKeys,
      hostResults: state.hostResults,
      clientReports: state.clientReports,
      bot: state.bot
        ? {
            sessionId: state.bot.sessionId,
            provider: state.bot.route.provider,
            model: state.bot.route.model,
            modelSource: state.bot.route.modelSource,
            modelCandidates: state.bot.route.candidates.length,
          }
        : null,
      sseSubscribers: state.sseSubscribers.size,
      lastError: state.lastError,
    };
  }

  async function handleAction(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: 'bad-json' }, 400);
    }
    const action = body && body.action;
    if (action === 'probe') {
      if (!state.domain) return json({ ok: false, error: 'domain-not-ready' }, 503);
      const key = String(body.key || `probe-client-${Date.now()}`);
      await state.domain.table('probes').put(key, { from: 'client', at: Date.now(), nonce: body.nonce ?? null });
      publish({ type: 'probe', key, from: 'client' });
      return json({ ok: true, key });
    }
    if (action === 'report') {
      const source = typeof body.source === 'string' ? body.source : 'client';
      const results = Array.isArray(body.results) ? body.results : [];
      state.clientReports.push({ source, results, at: Date.now() });
      await appendResults(source, results);
      if (state.domain) {
        const key = `report-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await state.domain.table('reports').put(key, { source, results, at: Date.now() }).catch(() => {});
      }
      publish({ type: 'report', source, count: results.length });
      return json({ ok: true, count: results.length });
    }
    if (action === 'status') {
      return json({ ok: true, ...bootstrapBody() });
    }
    return json({ ok: false, error: `unknown-action:${String(action)}` }, 400);
  }

  function handleEvents(request) {
    const url = new URL(request.url);
    const selfClose = url.searchParams.get('selfClose') === '1';
    const framesRaw = url.searchParams.get('frames');
    const framesValue = framesRaw === null ? NaN : Number(framesRaw);
    const selfCloseAfter = Number.isInteger(framesValue) && framesValue > 0
      ? framesValue
      : config.sseCloseAfterFrames;
    const encoder = new TextEncoder();
    let write;
    let closed = false;
    let sent = 0;
    let off = () => {};
    let heartbeat;
    let closeTimer;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      try {
        off();
      } catch {}
      if (heartbeat) clearInterval(heartbeat);
      if (closeTimer) clearInterval(closeTimer);
      state.sseSubscribers.delete(write);
    };

    const stream = new ReadableStream({
      start(controller) {
        write = (frame) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(sseFrame(frame.type, frame)));
            sent += 1;
          } catch {
            cleanup();
          }
        };
        state.sseSubscribers.add(write);
        write({ type: 'hello', spikeNonce: state.nonce, mode: selfClose ? 'self-close' : 'persistent' });
        heartbeat = setInterval(() => write({ type: 'tick', t: Date.now() }), 2000);
        if (selfClose) {
          closeTimer = setInterval(() => {
            if (sent >= selfCloseAfter) {
              if (closeTimer) clearInterval(closeTimer);
              write({ type: 'bye', sent });
              cleanup();
              try {
                controller.close();
              } catch {}
            }
          }, 200);
        }
        request.signal.addEventListener('abort', () => {
          cleanup();
          try {
            controller.close();
          } catch {}
        });
      },
      cancel() {
        cleanup();
      },
    });

    return Promise.resolve(
      new Response(stream, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        },
      }),
    );
  }

  // ── lifecycle ────────────────────────────────────────────────────────────
  ctx.effect(() => {
    let disposed = false;

    // Register app routes (the real plugin's transport proof).
    const routeDisposers = [];
    const registerRoutes = () => {
      routeDisposers.push(
        ctx.connection.fetch.register({
          path: ROUTE_BOOTSTRAP,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: () => Promise.resolve(json(bootstrapBody())),
        }),
        ctx.connection.fetch.register({
          path: ROUTE_ACTION,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: (request) => handleAction(request),
        }),
        ctx.connection.fetch.register({
          path: ROUTE_EVENTS,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: (request) => handleEvents(request),
        }),
      );
    };

    try {
      registerRoutes();
      state.ready = true;
    } catch (error) {
      state.lastError = `route registration failed: ${String(error)}`;
    }

    // Also prove the tool registry surface the real plugin will use.
    const toolDisposer = [];
    try {
      if (ctx.tools && typeof ctx.tools.register === 'function') {
        toolDisposer.push(
          ctx.tools.register({
            name: 'bot_team_spike_ping',
            description: 'M0 scaffold check: returns pong. Remove with the spike bundle.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
            output: {
              schema: { type: 'object', properties: { pong: { type: 'boolean' } } },
              render: () => [{ type: 'text', text: 'pong' }],
            },
            execute: async () => ({ pong: true }),
          }),
        );
      }
    } catch (error) {
      state.lastError = `tool registration failed: ${String(error)}`;
    }

    if (config.autoSelfTest) {
      // Defer a tick so every dependent service is fully up.
      setTimeout(() => {
        if (disposed) return;
        void runHostSelfTest().catch(async (error) => {
          await reportHost('host.selftest.crashed', false, String(error && error.stack ? error.stack : error));
        });
      }, 1000);
    }

    return async () => {
      disposed = true;
      state.disposed = true;
      for (const write of [...state.sseSubscribers]) {
        try {
          state.sseSubscribers.delete(write);
        } catch {}
      }
      for (const dispose of [...routeDisposers].reverse()) {
        try {
          await dispose();
        } catch {}
      }
      for (const dispose of [...toolDisposer].reverse()) {
        try {
          await dispose();
        } catch {}
      }
      if (state.bot && state.bot.handle) {
        try {
          await state.bot.handle.dispose();
        } catch {}
        state.bot.handle = null;
      }
      if (state.domain) {
        try {
          await state.domain.close();
        } catch {}
        state.domain = null;
      }
    };
  }, 'bot-team-spike');
}
