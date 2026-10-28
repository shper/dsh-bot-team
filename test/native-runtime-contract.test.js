import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { AgentPool } from '../host/agents.js';
import { BackgroundInteractions } from '../host/background-interactions.js';
import { inspectSessionHeader, submitNativeInput } from '../host/native-session.js';
import { collectNativeConversationBlockers, nativeConversationCapability } from '../host/native-activity.js';

// Opt in with the installed Electron runtime; ordinary node --test skips this
// integration suite. No GUI/server starts, and the LLM transport always throws.
// ELECTRON_RUN_AS_NODE=1 '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' --test test/native-runtime-contract.test.js
const nativeRoot = process.env.DSH_NATIVE_MODULE_ROOT || '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai';
const nativeTest = process.versions.electron ? test : test.skip;
const load = name => import(pathToFileURL(path.join(nativeRoot, name, 'lib/index.js')).href);

async function installedSidebarVisibility() {
  const source = await readFile(path.join(nativeRoot, 'dsh-client-ui-workspace/lib/client.js'), 'utf8');
  const predicate = source.match(/function sessionVisible\(session, current, archived, archivedFilter\) \{[\s\S]*?\n\t\t\}/)?.[0];
  assert.ok(predicate, 'the installed sidebar visibility predicate must be inspected when its contract changes');
  // Execute the installed pure predicate, rather than duplicating its current
  // origin/archive/blank rules in a test-owned approximation of the sidebar.
  return new Function('assertNever$1', 'return (' + predicate + ');')(
    value => { throw new Error('unexpected archive filter: ' + value); },
  );
}

async function fixture(t) {
  const [cordis, sessions, projections, agents, loop, tools, prompt, query, approval, sandbox, controller, presets, defaults, persistence, loader, goals, goalTools, scheduleTools, questions, jobs, subagents, spawn] = await Promise.all([
    'cordis', 'dsh-session', 'dsh-session-projection', 'dsh-agent',
    'dsh-agent-loop', 'dsh-tools', 'dsh-system-prompt', 'dsh-session-query',
    'dsh-user-approval', 'dsh-sandbox-policy', 'dsh-api-session-controller',
    'dsh-agent-preset-registry', 'dsh-agent-default-model', 'dsh-session-persistence-jsonl', 'cordis-plugin-loader',
    'dsh-goal', 'dsh-tool-goal', 'dsh-tool-schedule', 'dsh-user-questions',
    'dsh-jobs-local', 'dsh-subagent', 'dsh-subagent-spawn-in-process',
  ].map(load));
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bot-team-native-contract-')));
  const ctx = new cordis.Context();
  let llmCalls = 0;
  const forbidden = () => { llmCalls++; throw new Error('contract smoke must never call a model'); };
  ctx.provide('llm', {
    listProviders: () => [{ id: 'native' }, { id: 'bot' }],
    listModels: async () => [{ id: 'default' }, { id: 'configured' }, { id: 'other' }],
    resolveModelInfo: async (_provider, model) => ({ id: model }),
    resolveCallConfig: async config => config,
    prepareCall: forbidden, stream: forbidden, complete: forbidden, chat: forbidden,
  });
  ctx.provide('typert', { lookups: { configure() {}, register() {} }, contexts: { configureHost() {} }, resources: { register() {} } });
  ctx.provide('attachments', { imageLimits: { maxImageBytes: 1, maxImagesPerMessage: 1, maxMessageImageBytes: 1, maxImagePixels: 1, maxImageDimension: 1, mediaTypes: [] } });
  ctx.provide('fileUploads', { registerAgentResolver: () => () => {} });
  ctx.provide('fs', {});
  ctx.provide('workingDirectory', { ensure: async agent => agent.session.header.cwd, set: async () => {} });
  ctx.provide('remoteAccess', {});
  ctx.provide('modelCatalog', {});
  ctx.provide('workspaceRegistry', { archivedSessionIds: [] });
  const archived = [];
  ctx.provide('workspaceController', {
    async archiveSession(request) {
      assert.equal(typeof request.sessionId, 'string');
      assert.notEqual(request.stopActivity, true, 'migration must not silently cancel native activity');
      archived.push(request.sessionId);
      return { archivedSessionIds: [...archived] };
    },
  });
  ctx.provide('userMessage', { resolve: async ({ text }) => [{ type: 'text', text }] });
  // The installed schedule tool definitions participate in preset composition;
  // delivery is deliberately unavailable in a hidden, plugin-owned Session.
  const forbiddenSchedule = () => { throw new Error('contract smoke must not create or dispatch reminders'); };
  ctx.provide('schedule', { create: forbiddenSchedule, update: forbiddenSchedule, list: forbiddenSchedule, delete: forbiddenSchedule });
  const fibers = [];
  const pools = [];
  const interactionBridges = [];
  const controllerCalls = [];
  const mount = async (plugin, config) => {
    const fiber = ctx.plugin(plugin, config);
    fibers.push(fiber);
    await fiber;
    return fiber;
  };
  t.after(async () => {
    for (const bridge of interactionBridges) bridge.dispose();
    for (const pool of pools) await pool.disposeAll();
    for (const fiber of [...fibers].reverse()) await fiber.dispose();
    assert.equal(llmCalls, 0);
    assert.deepEqual(controllerCalls, [], 'plugin-owned Bots must not use ordinary SessionController routes');
    assert.ok(path.isAbsolute(cwd) && path.basename(cwd).startsWith('bot-team-native-contract-'));
    await rm(cwd, { recursive: true, force: true });
  });
  await mount(sessions.default);
  await mount(projections.default);
  await mount(agents.default);
  await mount(tools.default, {});
  await mount(prompt.default, { personaPrefix: 'Deployment persona' });
  await mount(query.default);
  await mount(approval.default, { policy: 'ask' });
  await mount(sandbox.default, { defaultMode: 'read-only' });
  await mount(defaults.default, { provider: 'native', model: 'default' });
  await mount(goals.default);
  await mount(questions.default);
  await mount(jobs.default);
  await mount(subagents.default);
  await mount(spawn);
  await mount(loader.default);
  ctx.loader.builtins['bot-team-contract-preset'] = {
    inject: ['systemPrompt'],
    apply(scope) {
      scope.systemPrompt.section({ name: 'native:contract-preset', order: 90, text: 'Native preset model {{provider}}/{{model}}' });
    },
  };
  ctx.loader.builtins['bot-team-contract-goals'] = goalTools;
  ctx.loader.builtins['bot-team-contract-schedule'] = scheduleTools;
  await mount(presets.default, { default: 'contract-default' });
  const unregisterPreset = await ctx.agentPresets.register({
    id: 'contract-default',
    plugins: [
      { name: 'cordis:bot-team-contract-preset' },
      { name: 'cordis:bot-team-contract-goals' },
      { name: 'cordis:bot-team-contract-schedule' },
    ],
  });
  t.after(unregisterPreset);
  await mount(persistence, { root: path.join(cwd, 'session-store') });
  let loopFiber = await mount(loop.default, { agents: [] });
  // Keep the actual controller's projections and native composition installed,
  // but any accidental ordinary-session activation must fail this fixture.
  await mount(controller.default, { defaultCwd: cwd });
  for (const name of ['create', 'resolveAgent', 'prompt', 'inspect', 'selectModel']) {
    ctx.sessionController[name] = () => {
      controllerCalls.push(name);
      throw new Error('hidden Bot must not call SessionController.' + name);
    };
  }
  const bot = { botId: 'contract-bot', name: 'Contract Bot', provider: 'bot', model: 'configured' };
  const member = { membershipId: 'contract-member', groupId: 'contract-group', botId: bot.botId, sessionId: 'session-botteam-contract' };
  const group = { groupId: member.groupId, workspaceCwd: cwd };
  const repo = {
    members: new Map([[member.membershipId, member]]),
    groups: new Map([[group.groupId, group]]),
    bots: new Map([[bot.botId, bot]]),
    getMember: id => id === member.membershipId ? member : undefined,
    listMembers: () => [member],
    getBot: id => id === bot.botId ? bot : undefined,
    getGroup: id => id === member.groupId ? group : undefined,
    putMember: async value => Object.assign(member, value),
    putBot: async value => Object.assign(bot, value),
  };
  const personas = {
    bot: () => ({ raw: 'Bot persona', name: bot.name }),
    soul: () => ({ raw: 'Bot soul' }), agent: () => ({ raw: 'Bot agent' }),
  };
  let pluginCtx;
  await mount({ name: 'bot-team-contract-scope', inject: ['agents', 'sessions', 'systemPrompt', 'tools', 'agentPresets', 'sessionQuery', 'approval', 'sandboxPolicy'], apply(scope) { pluginCtx = scope; } });
  const createPool = () => {
    const pool = new AgentPool({ ctx: pluginCtx, repo, personas, config: { dataDir: cwd, botSandbox: true, botApprovalPolicy: 'never' }, logger: console });
    pool.attachPrompt({ renderPersona: () => 'Contract Bot persona', renderGroupContext: () => 'Contract group context' });
    pools.push(pool);
    return pool;
  };
  const createInteractions = () => {
    const fallbackCalls = [];
    // Install ordinary host answerers first. The bridge must preempt these for
    // mapped roots, while unrelated native roots must still reach them.
    pluginCtx.on('approval/request', request => {
      fallbackCalls.push({ kind: 'approval', agentId: request.agent?.id });
      return Promise.resolve('rejected');
    }, { global: true });
    pluginCtx.on('user-questions/request', request => {
      fallbackCalls.push({ kind: 'question', agentId: request.agent?.id });
      return Promise.resolve({ answers: request.questions.map(question => ({ id: question.id, selected: [] })) });
    }, { global: true });
    const updates = new EventEmitter();
    const bridge = new BackgroundInteractions({ ctx: pluginCtx, repo, bus: { emit: (_groupId, snapshot) => updates.emit('update', snapshot) } });
    interactionBridges.push(bridge);
    const next = (predicate = () => true) => {
      const existing = bridge.snapshot(group.groupId).interactions.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); updates.off('update', observe); };
        const observe = snapshot => {
          const item = snapshot.interactions.find(predicate);
          if (item) { cleanup(); resolve(item); }
        };
        const timer = setTimeout(() => { cleanup(); reject(new Error('native interaction was not published')); }, 2000);
        updates.on('update', observe);
      });
    };
    const respond = (interaction, fields) => bridge.respond({ groupId: group.groupId, sessionId: interaction.sessionId, interactionId: interaction.interactionId, ...fields });
    return { bridge, next, respond, fallbackCalls };
  };
  const assemble = agent => ctx.systemPrompt.assemble({ agent, scope: agent, turn: 1, step: 1 });
  const request = async agent => {
    const assembled = await assemble(agent);
    const config = await agents.agentEvents(ctx, agent).waterfall('agent/request', { step: 1, signal: new AbortController().signal }, () => Promise.resolve({ provider: 'native', model: 'default' }));
    return { assembled, config, text: prompt.renderPrompt(assembled) };
  };
  return { ctx, pluginCtx, cwd, bot, member, repo, createPool, createInteractions, assemble, request, agents, archived, controllerCalls,
    UserQuestionError: questions.UserQuestionError, setApprovalPolicy: approval.setApprovalPolicy,
    coldDetach: async () => { await loopFiber.dispose(); loopFiber = await mount(loop.default, { agents: [] }); },
  };
}

function assertHiddenRoot(f, agent) {
  assert.equal(agent.session.header.id, f.member.sessionId);
  assert.equal(agent.session.header.origin, 'subagent');
  assert.equal(agent.session.header.cwd, f.cwd);
  assert.equal(agent.session.header.parentSession, undefined, 'a Bot must not invent a native parent Session');
  assert.equal(agent.session.header.delegationDepth ?? 0, 0);
  assert.ok(f.ctx.agents.roots().includes(agent), 'durable hidden origin must not imply delegated runtime ownership');
}

function assertNativeTools(f, agent) {
  const names = f.ctx.tools.schemas(agent).map(tool => tool.name);
  for (const name of ['get_goal', 'create_goal', 'update_goal', 'schedule_list', 'schedule_delete']) {
    assert.ok(names.includes(name), 'default native preset should retain ' + name);
  }
  for (const name of ['schedule_create', 'schedule_update']) {
    assert.ok(!names.includes(name), 'hidden sessions cannot promise reminder delivery: ' + name);
  }
}

async function submitWithoutModel(f, agent, id = 'umsg-contract') {
  const stop = agent.ctx.on('agent/pre-step', () => ({ kind: 'reject', reason: 'contract smoke: no model call' }), { prepend: true });
  const source = { kind: 'bot-team', groupId: f.member.groupId, jobId: 'contract-job' };
  const message = { role: 'user', id, content: [{ type: 'text', text: 'Contract input' }], source };
  try {
    await submitNativeInput(f.ctx, agent, message, f.bot);
    await agent.whenIdle();
  } finally {
    stop();
  }
  assert.equal(message.source.kind, 'bot-team');
  assert.ok(agent.session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced' && event.data.inserted?.some(item => item.id === message.id)));
  return message;
}

nativeTest('actual Agent factory creates a hidden root with default native preset, tools, and goal ownership', async t => {
  const f = await fixture(t);
  const pool = f.createPool();
  assert.equal(await inspectSessionHeader(f.ctx, 'session-botteam-does-not-exist'), undefined);
  const agent = await pool.ensure(f.member.membershipId);
  assertHiddenRoot(f, agent);
  assert.equal(pool.owns(agent), true);
  assert.equal(agent.session.header.agentPreset, 'contract-default');
  assert.equal(f.ctx.approval.effectivePolicy(agent.session), 'never');
  assert.equal(f.ctx.sandboxPolicy.overrideOf(agent.session), 'workspace-write');
  assertNativeTools(f, agent);
  const first = await f.request(agent);
  assert.equal(first.config.provider, 'bot');
  assert.equal(first.config.model, 'configured');
  for (const name of ['bot-team:persona', 'deployment:persona-prefix', 'harness:identity', 'native:contract-preset', 'tool:goal']) {
    assert.ok(first.assembled.sections.some(section => section.name === name), 'native assembly must retain ' + name);
  }
  assert.match(first.text, /Native preset model bot\/configured/);
  const goal = f.ctx.goals.create(agent, { objective: 'Verify an explicitly owned background goal', maxGoalRounds: 3 });
  assert.equal(goal.phase, 'active');
  assert.equal(goal.activation, 'armed');
  assert.equal(f.ctx.goals.get(agent).id, goal.id);
  await submitWithoutModel(f, agent);
  const raw = await f.ctx.sessionQuery.readSession(agent.id);
  assert.deepEqual(raw.session, agent.session.header);
  assert.deepEqual(raw.events, agent.session.snapshotEvents());
  assert.ok(raw.events.some(event => event.type === 'goal/change'));
  assert.deepEqual(f.controllerCalls, []);
});

nativeTest('the installed sidebar excludes hidden Bots even when current, nonblank, or showing archives', async t => {
  const f = await fixture(t);
  const agent = await f.createPool().ensure(f.member.membershipId);
  const visible = await installedSidebarVisibility();
  const summary = { id: agent.id, origin: agent.session.header.origin, blank: false };
  for (const current of [undefined, agent.id]) {
    for (const archived of [new Set(), new Set([agent.id])]) {
      for (const filter of ['default', 'show', 'only']) assert.equal(visible(summary, current, archived, filter), false);
    }
  }
  assert.equal(visible({ ...summary, origin: undefined }, undefined, new Set(), 'default'), true);
});

nativeTest('cold resume preserves the hidden identity, full log, native preset and disarmed goal without controller routes', async t => {
  const f = await fixture(t);
  const pool = f.createPool();
  const agent = await pool.ensure(f.member.membershipId);
  const goal = f.ctx.goals.create(agent, { objective: 'Persist through the Agent factory restart', maxGoalRounds: 3 });
  await submitWithoutModel(f, agent);
  const before = await f.ctx.sessionQuery.readSession(agent.id);
  await f.coldDetach();
  assert.equal(f.ctx.agents.get(agent.id), undefined);
  const resumed = await pool.ensure(f.member.membershipId);
  assert.notEqual(resumed, agent);
  assert.equal(resumed.id, agent.id);
  assertHiddenRoot(f, resumed);
  assert.equal(pool.owns(resumed), true);
  assertNativeTools(f, resumed);
  const restored = await f.request(resumed);
  assert.match(restored.text, /Native preset model bot\/configured/);
  assert.ok(restored.assembled.sections.some(section => section.name === 'bot-team:persona'));
  const savedGoal = f.ctx.goals.get(resumed);
  assert.equal(savedGoal.id, goal.id);
  assert.equal(savedGoal.phase, 'active');
  assert.equal(savedGoal.activation, 'disarmed', 'a cold restore must not fabricate renewed human goal authority');
  const after = await f.ctx.sessionQuery.readSession(resumed.id);
  // The installed JSONL codec persists an omitted root depth as zero.
  assert.deepEqual(after.session, { ...before.session, delegationDepth: before.session.delegationDepth ?? 0 });
  assert.deepEqual(after.events.slice(0, before.events.length), before.events);
  await submitWithoutModel(f, resumed, 'umsg-after-cold-resume');
  assert.deepEqual(f.controllerCalls, []);
  await pool.disposeAll();
  assert.equal(f.ctx.agents.get(resumed.id), undefined, 'the plugin must release its owned native Agent handle');
  const persisted = await f.ctx.sessionQuery.readSession(resumed.id);
  assert.ok(persisted.events.some(event => event.type === 'agent/inbox/spliced' && event.data.inserted?.some(message => message.id === 'umsg-after-cold-resume')));
});

nativeTest('Bot model edits keep request routing, model projection, and model text consistent without native UI selection', async t => {
  const f = await fixture(t);
  const agent = await f.createPool().ensure(f.member.membershipId);
  for (const selection of [{ provider: 'native', model: 'other' }, { provider: 'bot', model: 'configured' }]) {
    await f.repo.putBot({ ...f.bot, ...selection });
    const { config, text } = await f.request(agent);
    const state = f.ctx.sessionProjections.stateOf(agent.session, 'modelSelection');
    const shown = state.pending ?? state.lastUsed;
    assert.equal(config.provider, selection.provider);
    assert.equal(config.model, selection.model);
    assert.equal(shown.provider, config.provider);
    assert.equal(shown.model, config.model);
    assert.ok(text.includes('Native preset model ' + selection.provider + '/' + selection.model));
  }
  assert.deepEqual(f.controllerCalls, []);
});

nativeTest('plugin reload releases the old owned Agent and resumes the same persisted hidden Session', async t => {
  const f = await fixture(t);
  const before = f.createPool();
  const original = await before.ensure(f.member.membershipId);
  await submitWithoutModel(f, original);
  await before.disposeAll();
  assert.equal(f.ctx.agents.get(original.id), undefined);
  const saved = await f.ctx.sessionQuery.readSession(original.id);
  const after = f.createPool();
  const resumed = await after.ensure(f.member.membershipId);
  assert.notEqual(resumed, original);
  assert.equal(resumed.id, original.id);
  assertHiddenRoot(f, resumed);
  assertNativeTools(f, resumed);
  const restored = await f.ctx.sessionQuery.readSession(resumed.id);
  assert.deepEqual(restored.session, saved.session);
  assert.deepEqual(restored.events.slice(0, saved.events.length), saved.events);
});

for (const legacy of [
  { label: 'ordinary native', meta: { agentPreset: 'contract-default' } },
  { label: 'old hidden bot-team-tools', meta: { origin: 'subagent', agentPreset: 'bot-team-tools' } },
]) {
  nativeTest(legacy.label + ' history stays unchanged when migration allocates a new hidden default-preset Session', async t => {
    const f = await fixture(t);
    const oldId = f.member.sessionId;
    const old = await f.ctx.agents.create({
      sessionId: oldId, agentOptions: { provider: 'native', model: 'default' },
      meta: { cwd: f.cwd, ...legacy.meta },
    });
    old.agent.session.append('model/selection', { provider: 'native', model: 'default' });
    await old.dispose();
    const before = await f.ctx.sessionQuery.readSession(oldId);
    const agent = await f.createPool().ensure(f.member.membershipId);
    assert.notEqual(agent.id, oldId);
    assert.deepEqual(f.member.previousSessionIds, [oldId]);
    assertHiddenRoot(f, agent);
    assert.equal(agent.session.header.agentPreset, 'contract-default');
    assertNativeTools(f, agent);
    assert.equal(f.ctx.agents.get(oldId), undefined);
    assert.deepEqual(await f.ctx.sessionQuery.readSession(oldId), before);
    assert.deepEqual(f.controllerCalls, []);
  });
}

const contractQuestions = [{ id: 'choice', question: 'Choose a contract option', options: [{ label: 'Proceed' }, { label: 'Review' }], multiSelect: false }];
const contractAnswer = { answers: [{ id: 'choice', selected: ['Proceed'], custom: 'Native contract answer' }] };

function runServiceInNativeTurn(f, agent, action) {
  const result = Promise.withResolvers();
  const off = agent.ctx.on('agent/pre-step', async () => {
    try { result.resolve(await action()); } catch (error) { result.reject(error); }
    return { kind: 'reject', reason: 'native service contract: no model call' };
  }, { prepend: true });
  const completion = submitNativeInput(f.ctx, agent, {
    role: 'user', id: 'umsg-native-service-' + agent.id,
    content: [{ type: 'text', text: 'Native service contract turn' }],
    source: { kind: 'bot-team', groupId: f.member.groupId, jobId: 'native-service-contract' },
  }, f.bot).then(() => agent.whenIdle()).finally(off);
  return { result: result.promise, completion };
}

nativeTest('actual timed question answer uses the hidden bridge before existing native answerers and preserves unmapped fallback', async t => {
  const f = await fixture(t);
  const agent = await f.createPool().ensure(f.member.membershipId);
  const ui = f.createInteractions();
  const result = f.ctx.userQuestions.askTimed({ agent, questions: contractQuestions }, 'call-immediate', 10000);
  const interaction = await ui.next(item => item.callId === 'call-immediate');
  assert.equal(interaction.timed, true, 'the installed request.wait shape must reach the bridge');
  assert.equal(interaction.state, 'pending');
  assert.deepEqual(interaction.questions, contractQuestions);
  await ui.respond(interaction, { operation: 'answer', answer: contractAnswer });
  assert.deepEqual(await result, contractAnswer);
  assert.deepEqual(ui.fallbackCalls, [], 'Cordis prepend/global must keep Bot requests out of ordinary answerers');
  assert.deepEqual(ui.bridge.snapshot(f.member.groupId).interactions, []);
  const native = await f.ctx.agents.create({ sessionId: 'session-unmapped-question', meta: { cwd: f.cwd }, agentOptions: { provider: 'native', model: 'default' } });
  try {
    const fallback = await f.ctx.userQuestions.askTimed({ agent: native.agent, questions: contractQuestions }, 'call-unmapped', 10000);
    assert.deepEqual(fallback, { answers: [{ id: 'choice', selected: [] }] });
    assert.deepEqual(ui.fallbackCalls, [{ kind: 'question', agentId: native.agent.id }]);
  } finally { await native.dispose(); }
  assert.deepEqual(f.controllerCalls, []);
});

nativeTest('actual continued-question projection survives bridge reload and native answer admits the late reply', async t => {
  const f = await fixture(t);
  const pool = f.createPool();
  const agent = await pool.ensure(f.member.membershipId);
  const ui = f.createInteractions();
  const callId = 'call-late-answer';
  const pending = f.ctx.userQuestions.askTimed({ agent, questions: contractQuestions }, callId, 10000);
  const interaction = await ui.next(item => item.callId === callId);
  await ui.respond(interaction, { operation: 'continue' });
  assert.deepEqual(await pending, { pending: true, callId }, 'native askTimed must restore the bridge error to its typed timeout contract');
  // Seed the native PTC pending-result audit pair inside a real Agent turn;
  // the installed projection and persisted JSONL validator consume these rows.
  const seed = runServiceInNativeTurn(f, agent, () => {
    const dispatch = {
      rootCallId: 'call-contract-run-code', parentCallId: 'call-contract-run-code',
      subCallId: callId, name: 'ask_user_question',
      arguments: { questions: contractQuestions.map(({ multiSelect, ...question }) => ({ ...question, multi_select: multiSelect })) },
    };
    agent.session.append('tool/ptc-dispatch-start', dispatch);
    agent.session.append('tool/ptc-dispatch', {
      ...dispatch, content: [{ type: 'text', text: JSON.stringify({ pending: true, callId }) }], isError: false,
    });
  });
  await seed.result;
  await seed.completion;
  const projection = f.ctx.sessionProjections.stateOf(agent.session, 'userQuestions');
  assert.deepEqual(projection.questions.active, [{ callId, questions: contractQuestions, state: 'continued' }]);
  assert.deepEqual(projection.questions.settled, []);
  assert.equal(ui.bridge.snapshot(f.member.groupId).interactions[0].state, 'continued');
  ui.bridge.dispose();
  const restored = f.createInteractions();
  const late = await restored.next(item => item.callId === callId && item.state === 'continued');
  // Native admission happens after adapter metadata preparation. Supply only
  // that local metadata and cancel synchronously when the actual reply commits,
  // before any transport stream can run (the stream remains a tripwire).
  const prepareCall = f.ctx.llm.prepareCall;
  f.ctx.llm.prepareCall = async config => ({ config, stream: f.ctx.llm.stream });
  const stop = agent.ctx.on('session/event', (session, event) => {
    if (session === agent.session && event.type === 'user/message' && event.data.source.kind === 'user-question-reply') {
      agent.cancel({ kind: 'hook', reason: 'late answer contract: stop before model transport' });
    }
  });
  try {
    await restored.respond(late, { operation: 'answer', answer: contractAnswer });
    await agent.whenIdle();
  } finally { stop(); f.ctx.llm.prepareCall = prepareCall; }
  const settled = f.ctx.sessionProjections.stateOf(agent.session, 'userQuestions').questions;
  assert.deepEqual(settled.active, []);
  assert.deepEqual(settled.settled, [{ callId, answers: contractAnswer.answers }]);
  const reply = agent.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.source.kind === 'user-question-reply');
  assert.equal(reply?.data.source.callId, callId);
  assert.deepEqual(JSON.parse(reply.data.content[0].text), {
    kind: 'answer_to_pending_question', tool: 'ask_user_question', callId,
    questions: contractQuestions, answers: contractAnswer.answers,
  });
  assert.deepEqual(restored.bridge.snapshot(f.member.groupId).interactions, []);
  assert.deepEqual(ui.fallbackCalls, []);
  assert.deepEqual(restored.fallbackCalls, []);
  assert.deepEqual(f.controllerCalls, []);
  await pool.disposeAll();
  const persisted = await f.ctx.sessionQuery.readSession(agent.id);
  assert.ok(persisted.events.some(event => event.type === 'user/message' && event.data.source.kind === 'user-question-reply'));
});

nativeTest('actual question service restores bridge cancellation and abort errors and treats timeout as pending', async t => {
  const f = await fixture(t);
  const agent = await f.createPool().ensure(f.member.membershipId);
  const ui = f.createInteractions();
  const cancelled = f.ctx.userQuestions.askTimed({ agent, questions: contractQuestions }, 'call-cancel', 10000);
  const cancelledCheck = assert.rejects(cancelled, error => error instanceof f.UserQuestionError && error.code === 'ASK_CANCELLED');
  await ui.respond(await ui.next(item => item.callId === 'call-cancel'), { operation: 'cancel' });
  await cancelledCheck;
  const controller = new AbortController();
  const aborted = f.ctx.userQuestions.askTimed({ agent, questions: contractQuestions, signal: controller.signal }, 'call-abort', 10000);
  const abortedCheck = assert.rejects(aborted, error => error instanceof f.UserQuestionError && error.code === 'ASK_ABORTED');
  await ui.next(item => item.callId === 'call-abort');
  controller.abort();
  await abortedCheck;
  const expired = f.ctx.userQuestions.askTimed({ agent, questions: contractQuestions }, 'call-timeout', 15);
  await ui.next(item => item.callId === 'call-timeout');
  assert.deepEqual(await expired, { pending: true, callId: 'call-timeout' });
  const snapshot = ui.bridge.snapshot(f.member.groupId).interactions;
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].callId, 'call-timeout');
  assert.equal(snapshot[0].state, 'continuing');
  assert.deepEqual(ui.fallbackCalls, []);
  assert.deepEqual(f.controllerCalls, []);
});

nativeTest('actual approval service records allowed-once through the hidden bridge and preserves ordinary root fallback', async t => {
  const f = await fixture(t);
  const agent = await f.createPool().ensure(f.member.membershipId);
  const ui = f.createInteractions();
  f.setApprovalPolicy(agent.session, 'ask');
  const turn = runServiceInNativeTurn(f, agent, () => f.ctx.approval.request({ agent, toolName: 'contract-tool', reason: 'Approve the native contract operation' }));
  const interaction = await ui.next(item => item.kind === 'approval');
  assert.equal(interaction.toolName, 'contract-tool');
  await ui.respond(interaction, { operation: 'answer', outcome: 'allowed-once' });
  assert.equal(await turn.result, 'allowed-once');
  await turn.completion;
  const audit = agent.session.snapshotEvents().filter(event => ['approval/asked', 'approval/decided'].includes(event.type));
  assert.equal(audit.length, 2);
  assert.equal(audit[0].type, 'approval/asked');
  assert.equal(audit[1].type, 'approval/decided');
  assert.equal(audit[1].data.id, audit[0].data.id);
  assert.equal(audit[1].data.outcome, 'allowed-once');
  assert.deepEqual(ui.fallbackCalls, []);
  const native = await f.ctx.agents.create({ sessionId: 'session-unmapped-approval', meta: { cwd: f.cwd }, agentOptions: { provider: 'native', model: 'default' } });
  try {
    const fallback = runServiceInNativeTurn(f, native.agent, () => f.ctx.approval.request({ agent: native.agent, toolName: 'native-contract-tool' }));
    assert.equal(await fallback.result, 'rejected');
    await fallback.completion;
    assert.deepEqual(ui.fallbackCalls, [{ kind: 'approval', agentId: native.agent.id }]);
  } finally { await native.dispose(); }
  assert.deepEqual(f.controllerCalls, []);
});

nativeTest('bundled subagent routing inherits the effective request model over creation defaults', async () => {
  const { parentAgentOptionsForDelegation, resolveChildAgentOptions } = await load('dsh-subagent');
  const parent = {
    options: { provider: 'native', model: 'default', reasoningEffort: 'low' },
    session: { requestHeader: () => ({ config: { provider: 'bot', model: 'configured', reasoningEffort: 'high' } }) },
  };
  assert.deepEqual(parentAgentOptionsForDelegation(parent), { provider: 'bot', model: 'configured', reasoningEffort: 'high' });
  assert.deepEqual(resolveChildAgentOptions(parent, undefined, 1), { provider: 'bot', model: 'configured', reasoningEffort: 'high', subagentDepth: 1 });
  assert.deepEqual(resolveChildAgentOptions(parent, { provider: 'child', model: 'explicit' }, 1), { provider: 'child', model: 'explicit', subagentDepth: 1 });
});

nativeTest('actual conversation activity observes root inbox, armed goals and owned background jobs', async t => {
  const f = await fixture(t);
  const pool = f.createPool();
  const agent = await pool.ensure(f.member.membershipId);
  const collect = () => collectNativeConversationBlockers({ ctx: f.pluginCtx, repo: f.repo, pool, groupId: f.member.groupId });
  assert.deepEqual(nativeConversationCapability({ ctx: f.pluginCtx, pool }), { supported: true, missing: [] });
  assert.equal(agent.status, 'idle');
  // Native approval policy changes inject a next-step annotation without a
  // wakeup. Observe the exact producer payload, and keep it untouched.
  const queued = structuredClone(agent.inbox.nextStep);
  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0].source, { kind: 'user-approval' });
  assert.equal(queued[0].content[0].text, 'The approval policy changed from "ask" to "never" (changed by the user).');
  assert.deepEqual(await collect(), []);
  assert.deepEqual(agent.inbox.nextStep, queued);
  agent.inbox.splice('next-turn', Infinity, 0, [{ id: 'parked-contract', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Parked without waking the Agent' }] }]);
  assert.equal(agent.status, 'idle');
  assert.ok((await collect()).some(value => value.kind === 'native-inbox'));
  agent.inbox.splice('next-turn', 0, agent.inbox.nextTurn.length, []);
  f.ctx.goals.create(agent, { objective: 'Observe authorized continuation activity', maxGoalRounds: 2 });
  assert.ok((await collect()).some(value => value.kind === 'native-goal'));
  f.ctx.goals.disarm(agent);
  assert.deepEqual(await collect(), []);
  const controller = f.ctx.jobs.attachController('bot-team-conversation-contract');
  t.after(controller);
  const done = Promise.withResolvers();
  let canceled = 0;
  const jobId = f.ctx.jobs.start({ kind: 'contract-shell', label: 'Owned shell producer contract', owner: agent.id,
    run: () => ({ done: done.promise, cancel: () => { canceled++; done.resolve({ status: 'killed' }); } }) });
  assert.equal(f.ctx.jobs.list(agent.id).find(job => job.id === jobId).owner, agent.id);
  assert.ok((await collect()).some(value => value.jobId === jobId && value.kind === 'native-job'));
  assert.equal(canceled, 0, 'read-only activity observation must not stop producers');
  done.resolve({ status: 'completed' });
  await f.ctx.jobs.wait(jobId, 1000, agent.id);
  assert.deepEqual(await collect(), []);
  await pool.disposeMember(f.member.membershipId);
  assert.equal(f.ctx.agents.get(agent.id), undefined);
  assert.deepEqual(await collect(), [], 'post-release cold history is read without resuming the root');
});

nativeTest('actual managed descendants and their jobs remain blockers while the root is idle', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const pool = f.createPool();
  const root = await pool.ensure(f.member.membershipId);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const off = f.ctx.on('agent/created', ({ agent }) => {
    if (agent.id === root.id) return;
    agent.ctx.on('agent/pre-step', async () => {
      entered.resolve();
      await release.promise;
      return { kind: 'reject', reason: 'Native contract test never calls a model' };
    }, { prepend: true });
  }, { global: true, prepend: true });
  t.after(off);
  t.after(() => release.resolve());
  const receipt = await f.ctx.subagents.startActivation({ provider: 'spawn', label: 'Conversation child contract', delivery: 'caller',
    request: { parent: root, cwd: f.cwd, prompt: [{ type: 'text', text: 'Exercise real managed descendant activity' }], maxDepth: 2 }, signal: new AbortController().signal });
  await entered.promise;
  const child = f.ctx.agents.get(receipt.childId);
  assert.ok(child);
  assert.equal(root.status, 'idle');
  assert.equal(child.status, 'running');
  assert.ok(f.ctx.agents.isOwnedBy(child.id, root));
  assert.ok((await f.ctx.subagents.listDescendants(root.id)).some(value => value.kind === 'child' && value.id === child.id));
  const collect = () => collectNativeConversationBlockers({ ctx: f.pluginCtx, repo: f.repo, pool, groupId: f.member.groupId });
  assert.ok((await collect()).some(value => value.sessionId === child.id && value.kind === 'native-agent'));
  const controller = f.ctx.jobs.attachController('bot-team-descendant-contract');
  t.after(controller);
  const done = Promise.withResolvers();
  const jobId = f.ctx.jobs.start({ kind: 'contract-shell', label: 'Child shell producer contract', owner: child.id,
    run: () => ({ done: done.promise, cancel: () => done.resolve({ status: 'killed' }) }) });
  assert.ok((await collect()).some(value => value.sessionId === child.id && value.jobId === jobId));
  done.resolve({ status: 'completed' });
  await f.ctx.jobs.wait(jobId, 1000, child.id);
  release.resolve();
  await child.whenIdle();
  await pool.disposeMember(f.member.membershipId);
  await receipt.result;
  assert.equal(f.ctx.agents.get(child.id), undefined, 'owned root teardown must await the public descendant drain');
  assert.equal(f.ctx.agents.get(root.id), undefined);
  assert.deepEqual(await collect(), []);
});
