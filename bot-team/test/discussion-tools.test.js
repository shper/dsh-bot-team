import test from 'node:test';
import assert from 'node:assert/strict';
import { BOT_TEAM_TOOL_NAMES, registerBotTeamTools } from '../host/tools.js';

// Only in-memory repository/service doubles: no Agent, provider or model exists.
function fixture(t, { legacy = false, protocolVersion = 2 } = {}) {
  const definitions = new Map();
  const groups = new Map([
    ['group', { groupId: 'group', title: 'Team', activeConversationId: 'conversation' }],
    ['other', { groupId: 'other', title: 'Other', activeConversationId: 'other-conversation' }],
  ]);
  const bots = new Map(); const members = new Map(); const discussions = new Map(); const messages = new Map();
  const calls = { dispatch: [], start: [], wait: [], guards: [] };
  const config = { enableModelTools: true, toolWaitTimeoutMs: 73000 };
  const repo = {
    groups, bots, members, discussions, messages,
    getGroup: id => groups.get(id), getBot: id => bots.get(id), getMember: id => members.get(id),
    getDiscussion: id => discussions.get(id), getMessage: id => messages.get(id),
    allGroups: () => [...groups.values()], allBots: () => [...bots.values()],
    membersOf: groupId => [...members.values()].filter(member => member.groupId === groupId),
    messagesOf: groupId => [...messages.values()].filter(message => message.groupId === groupId),
    discussionsOf: groupId => [...discussions.values()].filter(discussion => discussion.groupId === groupId),
  };
  let guarded = 0;
  const f = {
    definitions, config, calls, repo,
    addMember(name, id, fields = {}) {
      bots.set('bot-' + id, { botId: 'bot-' + id, name, provider: 'mock', model: 'mock' });
      members.set(id, { membershipId: id, botId: 'bot-' + id, groupId: 'group', ...fields });
    },
    message(fields = {}) {
      const messageId = 'message-' + (messages.size + 1);
      const message = { messageId, seq: messages.size + 1, groupId: 'group', conversationId: 'conversation',
        author: { type: 'bot', name: 'Alpha' }, status: 'done', text: 'reply', ...fields };
      messages.set(message.messageId, message); return message;
    },
    invoke: (name, args = {}) => definitions.get(name).execute(args),
    discuss: (args = {}) => f.invoke('bot_team_discuss', { groupId: 'group', topic: 'Choose a design', wait: false, ...args }),
    debate: (args = {}) => f.invoke('bot_team_debate', { groupId: 'group', topic: 'Choose a policy', pro: 'Alpha', con: 'Beta', wait: false, ...args }),
  };
  f.addMember('Alpha', 'alpha'); f.addMember('Beta', 'beta'); f.addMember('Judge', 'judge');
  const start = input => {
    assert.ok(guarded > 0, 'Starts must hold service admission');
    calls.start.push(structuredClone(input));
    const discussionId = 'discussion-' + (discussions.size + 1);
    const phase = input.mode === 'debate' ? 'opening' : input.format === 'structured' ? 'viewpoint' : 'discussion';
    const membershipId = input.proMembershipId || input.membershipIds[0];
    const step = { stepId: 'step-1', phase, membershipId, side: input.mode === 'debate' ? 'pro' : null,
      round: 1, status: 'running', attempts: [], messageIds: [] };
    const discussion = { ...input, discussionId, protocolVersion, conversationId: input.expectedConversationId,
      status: 'running', revision: 1, phase, steps: [step], currentStepId: step.stepId, currentSpeaker: membershipId };
    discussions.set(discussionId, discussion); return structuredClone(discussion);
  };
  const engine = {
    startDiscussion: legacy ? start : () => assert.fail('Modern tools must use service.dispatch'),
    async whenDiscussionSettled(discussionId, timeoutMs) {
      calls.wait.push({ discussionId, timeoutMs });
      return f.onWait ? f.onWait(discussions.get(discussionId)) : true;
    },
  };
  const service = {
    ready: Promise.resolve(), repo, engine,
    authorName: message => message.author?.name || '',
    async withWorkspaceOperation(groupId, operation) {
      calls.guards.push(groupId);
      if (f.busy) throw Object.assign(new Error('Conversation is changing'), { code: 'conversation-busy' });
      guarded += 1;
      try { return await operation(); } finally { guarded -= 1; }
    },
    async dispatch(action, input) {
      assert.equal(legacy, false, 'Legacy doubles must use guarded engine fallback');
      calls.dispatch.push({ action, input: structuredClone(input) });
      return service.withWorkspaceOperation(input.groupId, () => {
        assert.equal(input.expectedConversationId, groups.get(input.groupId).activeConversationId);
        if (action === 'discussion.start') return start(input);
        const discussion = discussions.get(input.discussionId);
        assert.equal(input.groupId, discussion.groupId);
        if (action === 'discussion.get') {
          if (f.onGet) return f.onGet(discussion);
          // Deliberately return unfiltered rows to exercise the tool's provenance checks.
          const transcript = [...messages.values()];
          const summaryMessage = transcript.filter(message => message.groupId === discussion.groupId
            && message.conversationId === discussion.conversationId && message.meta?.discussionId === discussion.discussionId
            && message.meta?.summary === true && message.status === 'done').at(-1);
          return { discussion: structuredClone(discussion), transcript,
            ...(summaryMessage ? { summary: summaryMessage.text } : {}),
            ...(discussion.verdict ? { verdict: discussion.verdict } : {}) };
        }
        assert.equal(action, 'discussion.control');
        if (discussion.conversationId !== input.expectedConversationId) {
          throw Object.assign(new Error('Historical discussion'), { code: 'historical-target' });
        }
        if (input.expectedRevision !== undefined && discussion.revision !== input.expectedRevision) {
          throw Object.assign(new Error('Revision changed'), { code: 'stale-revision' });
        }
        if (f.onControl) return f.onControl(discussion, input);
        discussion.revision += 1;
        discussion.status = { pause: 'paused', resume: 'running', retry: 'running', finish: 'finalizing', stop: 'stopped' }[input.operation] || discussion.status;
        return structuredClone(discussion);
      });
    },
  };
  if (!legacy) service.startDiscussion = start;
  f.service = service;
  const unregister = registerBotTeamTools({ ctx: {
    tools: { register(definition) {
      assert.equal(definitions.has(definition.name), false);
      definitions.set(definition.name, definition); return () => definitions.delete(definition.name);
    } },
    agents: { create: () => assert.fail('Discussion tool tests must never create an Agent') },
  }, service, config, logger: { warn: message => assert.fail(message) } });
  t.after(unregister);
  return f;
}

const startInput = f => f.calls.start.at(-1);

test('registers discussion, debate and control in the recursion denylist with configured wait budgets', t => {
  const f = fixture(t);
  assert.deepEqual([...f.definitions.keys()].sort(), [...BOT_TEAM_TOOL_NAMES].sort());
  for (const name of ['bot_team_discuss', 'bot_team_debate', 'bot_team_discussion_control']) {
    const tool = f.definitions.get(name);
    assert.ok(BOT_TEAM_TOOL_NAMES.includes(name));
    assert.equal(tool.parameters.additionalProperties, false);
    assert.match(tool.parameters.properties.timeoutMs.description, /73000/);
    assert.deepEqual(tool.output.schema.properties.verdict.enum, ['pro', 'con', 'tie', 'insufficient']);
    assert.equal(tool.output.render({}, { discussion: {} })[0].type, 'text');
  }
  for (const tool of f.definitions.values()) {
    if (tool.parameters.properties.timeoutMs) assert.match(tool.parameters.properties.timeoutMs.description, /73000/);
  }
});

test('classic defaults remain two rounds, all available members and a summary, through service admission', async t => {
  const f = fixture(t); f.addMember('Disabled', 'disabled', { enabled: false });
  const result = await f.discuss();
  assert.deepEqual(startInput(f), {
    groupId: 'group', topic: 'Choose a design', mode: 'discussion', format: 'classic', membershipIds: ['alpha', 'beta', 'judge'],
    rounds: 2, summarize: true, perspectives: {}, background: '', goal: '', responseLength: 'standard', language: 'auto',
    contextMessageIds: [], expectedConversationId: 'conversation',
  });
  assert.deepEqual(f.calls.dispatch.map(call => call.action), ['discussion.start', 'discussion.get']);
  assert.equal(result.discussion.settled, false); assert.equal(f.calls.wait.length, 0);
  await f.discuss({ rounds: 99, summarize: false, members: [' @ALPHA '] });
  assert.equal(startInput(f).rounds, 20); assert.equal(startInput(f).summarize, false);
  assert.deepEqual(startInput(f).membershipIds, ['alpha']);
});

test('discussion and debate schemas advertise the twenty-round ceiling', t => {
  const f = fixture(t);
  for (const name of ['bot_team_discuss', 'bot_team_debate']) {
    const rounds = f.definitions.get(name).parameters.properties.rounds;
    assert.equal(rounds.type, 'integer');
    assert.equal(rounds.minimum, 1);
    assert.equal(rounds.maximum, 20);
    assert.match(rounds.description, /1–20/);
  }
  assert.match(f.definitions.get('bot_team_discuss').parameters.properties.rounds.description, /Structured: 2–20 rounds, default 3/);
});

test('tools forward longer rounds through modern service and legacy engine admission', async t => {
  for (const legacy of [false, true]) {
    const f = fixture(t, { legacy });
    for (const rounds of [6, 10, 20]) {
      for (const format of ['classic', 'structured']) {
        const result = await f.discuss({ format, rounds });
        assert.equal(startInput(f).rounds, rounds);
        assert.equal(startInput(f).summarize, true);
        assert.equal(result.discussion.rounds, rounds);
      }
      const result = await f.debate({ rounds, judge: 'Judge' });
      assert.equal(startInput(f).rounds, rounds);
      assert.equal(startInput(f).summarize, true);
      assert.equal(startInput(f).judgeMembershipId, 'judge');
      assert.equal(result.discussion.rounds, rounds);
    }
  }
});

test('classic tools retain compatible coercion and defaulting', async t => {
  const f = fixture(t);
  for (const [rounds, expected] of [['10', 10], [0, 1], [2.5, 2]]) {
    await f.discuss({ rounds });
    assert.equal(startInput(f).rounds, expected);
  }
});

test('structured discussion maps names and perspectives to member IDs and accepts explicit same-group history', async t => {
  const f = fixture(t); const reference = f.message({ conversationId: 'historical', text: 'Past evidence' });
  const result = await f.discuss({ format: 'structured', members: ['Alpha', 'Beta'], summaryMember: 'Judge',
    perspectives: { '@Alpha': 'Cost', beta: 'Risk', Judge: 'Decision criteria' }, background: 'Capacity is limited', goal: 'Select a design',
    responseLength: 'detailed', language: 'zh', contextMessageIds: [reference.messageId] });
  assert.equal(startInput(f).rounds, 3); assert.equal(startInput(f).summaryMembershipId, 'judge');
  assert.deepEqual(startInput(f).perspectives, { alpha: 'Cost', beta: 'Risk', judge: 'Decision criteria' });
  assert.equal(startInput(f).background, 'Capacity is limited'); assert.equal(startInput(f).goal, 'Select a design');
  assert.equal(startInput(f).responseLength, 'detailed'); assert.equal(startInput(f).language, 'zh');
  assert.deepEqual(startInput(f).contextMessageIds, [reference.messageId]);
  assert.equal(result.discussion.stage, 'viewpoint'); assert.deepEqual(result.transcript, []);
});

test('unknown, ambiguous, duplicate and empty member choices fail before starting a discussion', async t => {
  const f = fixture(t);
  for (const args of [
    { members: [] }, { members: 'Alpha' }, { members: ['Alpha', 'Missing'] }, { members: ['Alpha', '@alpha'] },
    { summaryMember: 'Missing' }, { perspectives: { Missing: 'Cost' } },
    { members: ['Alpha'], perspectives: { Beta: 'Risk' } }, { perspectives: { Alpha: 7 } },
    { perspectives: { Alpha: 'Cost', '@alpha': 'Risk' } }, { perspectives: [] },
    { format: 'structured', members: ['Alpha'] }, { format: 'structured', rounds: 1 },
    { format: 'structured', rounds: 21 }, { format: 'structured', rounds: 2.5 }, { format: 'structured', rounds: '3' }, { format: 'unknown' },
  ]) await assert.rejects(f.discuss(args), { code: 'invalid-input' });
  f.addMember('ALPHA', 'duplicate');
  await assert.rejects(f.discuss({ members: ['Alpha'] }), /有歧义/);
  await assert.rejects(f.debate(), /有歧义/);
  assert.equal(f.calls.start.length, 0);
  await assert.rejects(f.invoke('bot_team_send', { groupId: 'group', text: 'hello', mentions: ['Missing'] }), /不在群里/);
});

test('debate maps independent sides and optional judge with a strict one-to-twenty round budget', async t => {
  const f = fixture(t); const result = await f.debate();
  assert.equal(startInput(f).mode, 'debate'); assert.equal(startInput(f).rounds, 2);
  assert.equal(startInput(f).proMembershipId, 'alpha'); assert.equal(startInput(f).conMembershipId, 'beta');
  assert.equal(startInput(f).summarize, false); assert.equal(startInput(f).judgeMembershipId, undefined);
  assert.equal(result.discussion.side, 'pro'); assert.equal(result.discussion.currentStep.stepId, 'step-1');
  await f.debate({ judge: 'Judge', proPosition: 'Adopt', conPosition: 'Defer', rounds: 3, responseLength: 'short', language: 'en' });
  assert.equal(startInput(f).judgeMembershipId, 'judge'); assert.equal(startInput(f).summarize, true);
  assert.equal(startInput(f).proPosition, 'Adopt'); assert.equal(startInput(f).conPosition, 'Defer');
  assert.equal(startInput(f).responseLength, 'short'); assert.equal(startInput(f).language, 'en');
  const count = f.calls.start.length;
  for (const args of [{ pro: 'Missing' }, { con: 'Missing' }, { judge: 'Missing' }, { con: '@alpha' }, { judge: 'Beta' },
    { rounds: 0 }, { rounds: 21 }, { rounds: 1.5 }, { rounds: '2' }]) {
    await assert.rejects(f.debate(args), { code: 'invalid-input' });
  }
  assert.equal(f.calls.start.length, count);
});

test('context references reject foreign or missing messages and invalid response options', async t => {
  const f = fixture(t); const foreign = f.message({ groupId: 'other' }); const own = f.message();
  for (const contextMessageIds of [[foreign.messageId], ['missing'], [own.messageId, own.messageId], 'not-an-array']) {
    await assert.rejects(f.discuss({ contextMessageIds }), { code: 'invalid-input' });
    await assert.rejects(f.debate({ contextMessageIds }), { code: 'invalid-input' });
  }
  for (const args of [{ responseLength: 'huge' }, { language: 'fr' }]) await assert.rejects(f.discuss(args), { code: 'invalid-input' });
  assert.equal(f.calls.start.length, 0);
});

test('controls derive group and current conversation from the record and forward revision, request and context', async t => {
  const f = fixture(t); const { discussion } = await f.discuss(); const reference = f.message({ conversationId: 'historical' });
  for (const operation of ['pause', 'resume', 'retry', 'finish', 'add_context', 'stop']) {
    const revision = f.repo.getDiscussion(discussion.discussionId).revision;
    const result = await f.invoke('bot_team_discussion_control', { discussionId: discussion.discussionId, operation,
      groupId: 'ignored-extra-argument', expectedRevision: revision, requestId: 'request-' + operation,
      text: 'Consider this evidence', contextMessageIds: [reference.messageId], wait: false });
    const call = f.calls.dispatch.filter(entry => entry.action === 'discussion.control').at(-1);
    assert.deepEqual(call.input, { groupId: 'group', discussionId: discussion.discussionId, operation,
      text: 'Consider this evidence', contextMessageIds: [reference.messageId], expectedRevision: revision,
      requestId: 'request-' + operation, expectedConversationId: 'conversation' });
    assert.equal(result.discussion.revision, revision + 1);
  }
  assert.equal(f.calls.wait.length, 0);
  const result = await f.invoke('bot_team_discussion_control', { discussionId: discussion.discussionId, operation: 'get' });
  assert.equal(result.discussion.status, 'stopped'); assert.equal(result.discussion.settled, true); assert.equal(f.calls.wait.length, 0);
  await assert.rejects(f.invoke('bot_team_discussion_control', { discussionId: discussion.discussionId, operation: 'unknown' }), { code: 'invalid-input' });
  await assert.rejects(f.invoke('bot_team_discussion_control', { discussionId: 'missing', operation: 'get' }), { code: 'not-found' });
});

test('historical reads stay readable while controls obey current conversation, revision and service guards', async t => {
  const f = fixture(t); const { discussion } = await f.discuss();
  await assert.rejects(f.invoke('bot_team_discussion_control', { discussionId: discussion.discussionId, operation: 'pause', expectedRevision: 99, wait: false }), { code: 'stale-revision' });
  f.repo.getGroup('group').activeConversationId = 'next';
  const old = await f.invoke('bot_team_discussion_control', { discussionId: discussion.discussionId, operation: 'get' });
  assert.equal(old.discussion.conversationId, 'conversation');
  await assert.rejects(f.invoke('bot_team_discussion_control', { discussionId: discussion.discussionId, operation: 'resume', wait: false }), { code: 'historical-target' });
  assert.equal(f.calls.dispatch.at(-1).input.expectedConversationId, 'next');
  f.busy = true;
  await assert.rejects(f.discuss(), { code: 'conversation-busy' });
  await assert.rejects(f.invoke('bot_team_discussion_control', { discussionId: discussion.discussionId, operation: 'get' }), { code: 'conversation-busy' });
});

test('v2 pause returns promptly with stage, side, revision and reason without claiming terminal completion', async t => {
  const f = fixture(t);
  f.onWait = discussion => {
    discussion.status = 'paused'; discussion.pauseReason = 'member-error'; discussion.revision = 9;
    discussion.steps[0].status = 'error'; return true;
  };
  const result = await f.debate({ wait: true });
  assert.equal(f.calls.wait.length, 1); assert.equal(f.calls.wait[0].timeoutMs, 73000);
  assert.equal(result.discussion.status, 'paused'); assert.equal(result.discussion.settled, false);
  assert.equal(result.discussion.awaitingUser, true); assert.equal(result.discussion.reason, 'member-error');
  assert.equal(result.discussion.stage, 'opening'); assert.equal(result.discussion.side, 'pro');
  assert.equal(result.discussion.currentStep.status, 'error'); assert.equal(result.discussion.revision, 9);
  const { discussionId } = result.discussion;
  await f.invoke('bot_team_discussion_control', { discussionId, operation: 'get', wait: true, timeoutMs: 19000 });
  assert.equal(f.calls.wait.at(-1).timeoutMs, 19000);
});

test('a pending native stop exposes the blocker instead of only the stop request reason', async t => {
  const f = fixture(t); const { discussion } = await f.discuss();
  Object.assign(f.repo.getDiscussion(discussion.discussionId), {
    status: 'stopping', stopReason: 'user', stopPendingReason: 'A participant native goal remains active',
  });
  const result = await f.invoke('bot_team_discussion_control', { discussionId: discussion.discussionId, operation: 'get' });
  assert.equal(result.discussion.reason, 'A participant native goal remains active');
  assert.equal(result.discussion.settled, false);
});

test('only done and stopped settle v2 even if the engine waiter reports success for another status', async t => {
  const f = fixture(t); const { discussion } = await f.discuss(); const record = f.repo.getDiscussion(discussion.discussionId);
  for (const status of ['running', 'pausing', 'paused', 'finalizing', 'stopping', 'done', 'stopped']) {
    record.status = status;
    for (const wait of [false, true]) {
      const result = await f.invoke('bot_team_discussion_control', { discussionId: record.discussionId, operation: 'get', wait });
      assert.equal(result.discussion.settled, ['done', 'stopped'].includes(status), status + ' wait=' + wait);
    }
    const listed = await f.invoke('bot_team_list', { groupId: 'group' });
    assert.equal(listed.groups[0].activeDiscussion?.status ?? null, ['done', 'stopped'].includes(status) ? null : status);
  }
});

test('transcript filters all three source IDs and retains message/step/phase/side metadata', async t => {
  const f = fixture(t); const { discussion } = await f.debate(); const id = discussion.discussionId;
  const accepted = f.message({ text: 'Accepted', meta: { discussionId: id, stepId: 'step-1', round: 1 } });
  f.message({ text: 'FOREIGN_GROUP', groupId: 'other', meta: { discussionId: id } });
  f.message({ text: 'FOREIGN_CONVERSATION', conversationId: 'old', meta: { discussionId: id } });
  f.message({ text: 'FOREIGN_DISCUSSION', meta: { discussionId: 'other' } });
  f.message({ text: 'UNRELATED', meta: {} });
  f.message({ text: 'SYSTEM_EVENT', author: { type: 'system' }, meta: { discussionId: id } });
  const result = await f.invoke('bot_team_discussion_control', { discussionId: id, operation: 'get' });
  assert.deepEqual(result.transcript, [{ messageId: accepted.messageId, groupId: 'group', conversationId: 'conversation', discussionId: id,
    seq: accepted.seq, name: 'Alpha', stepId: 'step-1', phase: 'opening', side: 'pro', round: 1, summary: false, status: 'done', text: 'Accepted' }]);
  assert.doesNotMatch(JSON.stringify(result), /FOREIGN_|UNRELATED|SYSTEM_EVENT/);
  const listed = await f.invoke('bot_team_list', { groupId: 'group', includeMessages: true });
  assert.ok(listed.groups[0].messages.every(message => message.messageId));
});

test('waiting across a new conversation returns the admitted discussion and its final summary/verdict', async t => {
  const f = fixture(t);
  f.onWait = discussion => {
    discussion.status = 'done'; discussion.verdict = 'tie';
    f.message({ text: 'Original conclusion', meta: { discussionId: discussion.discussionId, summary: true, phase: 'judgement', stepId: 'final' } });
    f.repo.getGroup('group').activeConversationId = 'next';
    f.message({ text: 'FUTURE_CONTENT', conversationId: 'next', meta: { discussionId: discussion.discussionId, summary: true } });
    return true;
  };
  const result = await f.debate({ judge: 'Judge', wait: true, timeoutMs: 22000 });
  assert.equal(result.discussion.status, 'done'); assert.equal(result.discussion.settled, true);
  assert.equal(result.summary, 'Original conclusion'); assert.equal(result.verdict, 'tie');
  assert.equal(result.discussion.conversationId, 'conversation');
  assert.equal(f.calls.dispatch.at(-1).input.expectedConversationId, 'next');
  assert.equal(f.calls.wait[0].timeoutMs, 22000); assert.doesNotMatch(JSON.stringify(result), /FUTURE_CONTENT/);
});

test('failed final drafts stay in the transcript without becoming a successful summary', async t => {
  const f = fixture(t); const { discussion } = await f.debate({ judge: 'Judge' });
  f.repo.getDiscussion(discussion.discussionId).status = 'paused';
  f.message({ text: 'Incomplete draft', status: 'error', meta: { discussionId: discussion.discussionId, summary: true, phase: 'judgement' } });
  const result = await f.invoke('bot_team_discussion_control', { discussionId: discussion.discussionId, operation: 'get' });
  assert.equal(result.summary, undefined); assert.equal(result.verdict, undefined);
  assert.equal(result.transcript[0].text, 'Incomplete draft');
});

test('get uses the authoritative service snapshot and does not resurrect an unaccepted final draft', async t => {
  const f = fixture(t); const { discussion } = await f.discuss();
  const draft = f.message({ text: 'Unaccepted draft', meta: { discussionId: discussion.discussionId, summary: true } });
  f.onGet = record => ({ discussion: { ...record, status: 'stopped', revision: 99, partial: true, stopReason: 'user', pauseReason: 'member-error' }, transcript: [draft] });
  const result = await f.invoke('bot_team_discussion_control', { discussionId: discussion.discussionId, operation: 'get' });
  assert.equal(f.repo.getDiscussion(discussion.discussionId).revision, 1);
  assert.equal(result.discussion.revision, 99); assert.equal(result.discussion.status, 'stopped');
  assert.equal(result.discussion.partial, true, 'the authoritative result preserves early-finish status');
  assert.equal(result.discussion.reason, 'user'); assert.equal(result.discussion.settled, true);
  assert.equal(result.summary, undefined); assert.equal(result.transcript[0].text, 'Unaccepted draft');
});

test('legacy doubles use guarded engine admission and preserve old waited completion but not wait:false', async t => {
  const f = fixture(t, { legacy: true, protocolVersion: 1 });
  const immediate = await f.discuss();
  assert.equal(immediate.discussion.settled, false); assert.equal(startInput(f).expectedConversationId, 'conversation');
  const waited = await f.discuss({ wait: true });
  assert.equal(waited.discussion.settled, true); assert.equal(f.calls.wait[0].timeoutMs, 73000);
  assert.equal(f.calls.dispatch.length, 0);
  f.busy = true; const before = f.calls.start.length;
  await assert.rejects(f.discuss(), { code: 'conversation-busy' }); assert.equal(f.calls.start.length, before);
});
