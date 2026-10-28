/**
 * Model-facing tools: let any ordinary DSH agent drive Bot Team without the UI.
 *
 *   bot_team_list          — discover groups / members / recent messages
 *   bot_team_create_group  — create a group and add (or create) bot members
 *   bot_team_send          — post a message, @ bots by name, wait for replies
 *   bot_team_review        — ask one bot to review a message, return the verdict
 *   bot_team_discuss       — run a multi-round discussion, return transcript/summary
 *
 * Registered globally on the plugin context. Bot members deny these names in
 * their setup (see agents.js) so a bot cannot recursively drive the group.
 * Every tool returns concise results with identifiers for follow-up calls.
 */
import { parseMentionsFromText } from './prompt.js';
import { currentConversationId, conversationIdOf } from './conversations.js';

export const BOT_TEAM_TOOL_NAMES = [
  'bot_team_list',
  'bot_team_create_group',
  'bot_team_send',
  'bot_team_review',
  'bot_team_discuss',
  'bot_team_task_create',
  'bot_team_task_list',
  'bot_team_task_update',
];

const MAX_TEXT_RETURN = 4000;

function clip(text, max = MAX_TEXT_RETURN) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max)}…（已截断，共 ${value.length} 字）` : value;
}

function textRender(value, title) {
  return [{ type: 'text', text: `${title}\n${JSON.stringify(value, null, 2)}` }];
}

export function registerBotTeamTools({ ctx, service, config, logger }) {
  if (!config.enableModelTools) return () => {};
  const disposers = [];

  const define = (definition) => {
    try {
      disposers.push(ctx.tools.register(definition));
    } catch (error) {
      logger?.warn?.(`bot-team: register tool ${definition.name} failed: ${String(error)}`);
    }
  };

  const ready = () => service.ready;
  const guarded = (groupId, operation) => typeof service.withWorkspaceOperation === 'function'
    ? service.withWorkspaceOperation(groupId, () => operation(currentConversationId(service.repo, groupId)))
    : operation(currentConversationId(service.repo, groupId));
  const currentMessage = (message) => conversationIdOf(service.repo, message) === currentConversationId(service.repo, message.groupId);

  const findMemberByName = (groupId, name) => {
    const target = String(name || '').trim().replace(/^@/, '').toLowerCase();
    if (!target) return undefined;
    for (const member of service.repo.membersOf(groupId)) {
      const bot = service.repo.getBot(member.botId);
      if (bot && bot.name.toLowerCase() === target) return { member, bot };
    }
    return undefined;
  };

  const botMessageAfter = (groupId, seq, conversationId = currentConversationId(service.repo, groupId)) =>
    service.repo
      .messagesOf(groupId)
      .filter((message) => message.seq > seq && message.author?.type === 'bot' && conversationIdOf(service.repo, message) === conversationId)
      .map((message) => ({
        seq: message.seq,
        kind: message.kind || 'chat',
        name: message.author?.name || '',
        status: message.status,
        ...(message.meta && message.meta.verdict ? { verdict: message.meta.verdict } : {}),
        text: clip(message.text, 2000),
      }));

  const waitIdle = async (groupId, timeoutMs) => {
    const completed = await service.engine.whenIdle(groupId, timeoutMs);
    return { completed, running: service.engine.isRunning(groupId) };
  };

  // ── bot_team_list ────────────────────────────────────────────────────────
  define({
    name: 'bot_team_list',
    description:
      'List Bot Team groups and their bot members. Returns group ids, titles, topics, member bot names/models, any running discussion, and the latest message. Use it first to find the groupId and bot names that the other bot_team tools need; pass groupId with includeMessages to read that group\'s recent timeline.',
    parameters: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: 'Optional group id: restrict the result to one group.' },
        includeMessages: {
          type: 'boolean',
          description: 'With groupId: include the latest 10 messages of that group.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { groups: { type: 'array' }, bots: { type: 'array' } } },
      render: (_args, value) => textRender(value, 'Bot Team groups'),
    },
    execute: async (args) => {
      await ready();
      const repo = service.repo;
      const groups = repo
        .allGroups()
        // Single chats are UI channels between one human and one bot, not
        // multi-agent groups; keep the model-facing group list focused.
        .filter((group) => group.kind !== 'direct')
        .filter((group) => !args.groupId || group.groupId === args.groupId)
        .map((group) => {
          const discussions = repo.discussionsOf(group.groupId).filter(currentMessage);
          const active = discussions.find((discussion) => discussion.status === 'running');
          const last = repo.messagesOf(group.groupId).filter(currentMessage).at(-1);
          return {
            groupId: group.groupId,
            currentConversationId: currentConversationId(repo, group.groupId),
            kind: group.kind || 'group',
            title: group.title,
            topic: group.topic || '',
            ...(group.folderId ? { folderId: group.folderId } : {}),
            ...(group.workspaceCwd ? { workspaceCwd: group.workspaceCwd } : {}),
            members: repo
              .membersOf(group.groupId)
              .map((member) => {
                const bot = repo.getBot(member.botId);
                return bot ? { name: bot.name, model: `${bot.provider}/${bot.model}` } : null;
              })
              .filter(Boolean),
            activeDiscussion: active
              ? { discussionId: active.discussionId, topic: active.topic, round: active.currentRound, rounds: active.rounds }
              : null,
            lastMessage: last
              ? { seq: last.seq, author: service.authorName(last), status: last.status, text: clip(last.text, 300) }
              : null,
            ...(args.includeMessages && !args.groupId
              ? {}
              : args.includeMessages && args.groupId
                ? {
                    messages: repo
                      .messagesOf(group.groupId)
                      .filter(currentMessage)
                      .slice(-10)
                      .map((message) => ({
                        seq: message.seq,
                        author: service.authorName(message),
                        kind: message.kind || 'chat',
                        status: message.status,
                        text: clip(message.text, 300),
                      })),
                  }
                : {}),
          };
        });
      return { groups, bots: repo.allBots().map((bot) => ({ botId: bot.botId, name: bot.name })) };
    },
  });

  // ── bot_team_create_group ────────────────────────────────────────────────
  define({
    name: 'bot_team_create_group',
    description:
      'Create a Bot Team group and add bot members. Bots are looked up by name in the global Bot library; for a missing name, provider+model create it. Every bot is full-capability (file read/write, search, web, workspace-write sandbox, command execution). Returns the new groupId and member ids; then use bot_team_send to talk to them.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Group title, for example "方案评审".' },
        topic: { type: 'string', description: 'Optional topic line shown in the group header.' },
        workspaceCwd: { type: 'string', description: 'Optional absolute working directory for the bots\' tools.' },
        bots: {
          type: 'array',
          description: 'Bots to add, by library name. provider+model create a missing bot.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Bot display name; also the @ mention token.' },
              provider: { type: 'string', description: 'Required only when creating a new bot.' },
              model: { type: 'string', description: 'Required only when creating a new bot.' },
            },
            required: ['name'],
            additionalProperties: false,
          },
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { groupId: { type: 'string' }, members: { type: 'array' } } },
      render: (_args, value) => textRender(value, 'Created Bot Team group'),
    },
    execute: async (args) => {
      await ready();
      const bots = Array.isArray(args.bots) ? args.bots : [];
      const group = await service.dispatch('group.create', {
        title: args.title,
        topic: args.topic || '',
        workspaceCwd: args.workspaceCwd || '',
      });
      const members = [];
      for (const spec of bots) {
        const name = String(spec && spec.name ? spec.name : '').trim();
        if (!name) continue;
        let bot = service.repo.allBots().find((candidate) => candidate.name === name);
        if (!bot && spec.provider && spec.model) {
          bot = await service.dispatch('bot.create', {
            name,
            provider: spec.provider,
            model: spec.model,
          });
        }
        if (!bot) {
          members.push({ name, error: 'Bot 不存在，且未提供 provider/model 以创建' });
          continue;
        }
        try {
          const member = await service.dispatch('member.add', { groupId: group.groupId, botId: bot.botId });
          members.push({ name: bot.name, membershipId: member.membershipId });
        } catch (error) {
          members.push({ name: bot.name, error: String(error && error.message ? error.message : error) });
        }
      }
      return { groupId: group.groupId, title: group.title, members };
    },
  });

  // ── bot_team_send ────────────────────────────────────────────────────────
  define({
    name: 'bot_team_send',
    description:
      'Post one message into a Bot Team group and return the bot replies. Mention bots by name to make them respond; with no mentions nothing replies. With wait:false the message is posted and the tool returns immediately (replies arrive later).',
    parameters: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: 'Target group id from bot_team_list.' },
        text: { type: 'string', description: 'Message text; include @BotName tokens for the bots that should respond.' },
        mentions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Bot names to mention explicitly. Omit to let @Name tokens in text decide.',
        },
        wait: { type: 'boolean', description: 'Wait for replies before returning. Defaults to true.' },
        timeoutMs: { type: 'integer', minimum: 10000, maximum: 600000, description: 'Reply wait budget. Defaults to 180000.' },
      },
      required: ['groupId', 'text'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { posted: { type: 'object' }, replies: { type: 'array' } } },
      render: (_args, value) => textRender(value, 'Bot Team replies'),
    },
    execute: async (args) => {
      await ready();
      const group = service.repo.getGroup(args.groupId);
      if (!group) throw new Error(`群 ${args.groupId} 不存在`);
      let mentions = Array.isArray(args.mentions)
        ? args.mentions
            .map((name) => findMemberByName(group.groupId, name))
            .filter(Boolean)
            .map((entry) => entry.member.membershipId)
        : [];
      if (mentions.length === 0) mentions = parseMentionsFromText(service.repo, group.groupId, String(args.text || ''));
      const { message } = await guarded(group.groupId, (expectedConversationId) => service.engine.postHumanMessage({
        groupId: group.groupId,
        text: String(args.text || ''),
        mentions,
        author: { type: 'human', name: '助手' },
        humanInput: false,
        expectedConversationId,
      }));
      const shouldWait = args.wait !== false;
      let wait = { completed: true, running: false };
      if (shouldWait) {
        wait = await waitIdle(group.groupId, Number(args.timeoutMs) || config.toolWaitTimeoutMs);
      }
      return {
        posted: { seq: message.seq, text: clip(message.text, 500) },
        acceptedMentions: mentions.length,
        ...wait,
        replies: botMessageAfter(group.groupId, message.seq, conversationIdOf(service.repo, message)),
      };
    },
  });

  // ── bot_team_review ──────────────────────────────────────────────────────
  define({
    name: 'bot_team_review',
    description:
      'Ask one bot member to review a message in a Bot Team group and return its verdict. Defaults to the latest bot message in the group. The review reply starts with 结论：通过/需修改, returned as verdict "pass" or "changes".',
    parameters: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: 'Group id from bot_team_list.' },
        reviewer: { type: 'string', description: 'Reviewer bot name (must be a member of the group).' },
        messageSeq: { type: 'integer', description: 'Seq of the message to review. Defaults to the latest bot message.' },
        instructions: { type: 'string', description: 'Optional review focus, e.g. risks, correctness, missing requirements.' },
        wait: { type: 'boolean', description: 'Wait for the review before returning. Defaults to true.' },
        timeoutMs: { type: 'integer', minimum: 10000, maximum: 600000, description: 'Wait budget. Defaults to 180000.' },
      },
      required: ['groupId', 'reviewer'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { review: { type: 'object' } } },
      render: (_args, value) => textRender(value, 'Bot Team review'),
    },
    execute: async (args) => {
      await ready();
      const group = service.repo.getGroup(args.groupId);
      if (!group) throw new Error(`群 ${args.groupId} 不存在`);
      const reviewer = findMemberByName(group.groupId, args.reviewer);
      if (!reviewer) throw new Error(`评审者 ${args.reviewer} 不在群里`);
      let target;
      if (Number.isInteger(args.messageSeq)) {
        target = service.repo.messagesOf(group.groupId).find((message) => message.seq === args.messageSeq);
      } else {
        target = [...service.repo.messagesOf(group.groupId)].reverse().find((message) => message.author?.type === 'bot' && currentMessage(message));
      }
      if (!target) throw new Error('找不到要评审的消息');
      const result = await guarded(group.groupId, (expectedConversationId) => service.engine.requestReview({
        groupId: group.groupId,
        targetMessageId: target.messageId,
        reviewerMembershipId: reviewer.member.membershipId,
        instructions: args.instructions || '',
        expectedConversationId,
      }));
      const shouldWait = args.wait !== false;
      let wait = { completed: true, running: false };
      if (shouldWait) {
        wait = await waitIdle(group.groupId, Number(args.timeoutMs) || config.toolWaitTimeoutMs);
      }
      const replies = botMessageAfter(group.groupId, result.requestMessage.seq, conversationIdOf(service.repo, result.requestMessage)).filter(
        (message) => message.kind === 'review',
      );
      const reply = replies[replies.length - 1] || null;
      return {
        requestSeq: result.requestMessage.seq,
        targetSeq: target.seq,
        reviewer: reviewer.bot.name,
        ...wait,
        review: reply,
      };
    },
  });

  // ── bot_team_discuss ─────────────────────────────────────────────────────
  define({
    name: 'bot_team_discuss',
    description:
      'Run a multi-round discussion among Bot Team group members and return the transcript plus an optional summary (共识/分歧/待决). Blocks until the discussion settles unless wait:false. Only one discussion may run per group.',
    parameters: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: 'Group id from bot_team_list.' },
        topic: { type: 'string', description: 'Discussion topic.' },
        members: {
          type: 'array',
          items: { type: 'string' },
          description: 'Bot names to include; defaults to every member.',
        },
        rounds: { type: 'integer', minimum: 1, maximum: 5, description: 'Rounds. Defaults to 2.' },
        summarize: { type: 'boolean', description: 'End with a 共识/分歧/待决 summary. Defaults to true.' },
        wait: { type: 'boolean', description: 'Wait until the discussion ends. Defaults to true.' },
        timeoutMs: { type: 'integer', minimum: 10000, maximum: 900000, description: 'Wait budget. Defaults to 300000.' },
      },
      required: ['groupId', 'topic'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { discussion: { type: 'object' }, transcript: { type: 'array' } } },
      render: (_args, value) => textRender(value, 'Bot Team discussion'),
    },
    execute: async (args) => {
      await ready();
      const group = service.repo.getGroup(args.groupId);
      if (!group) throw new Error(`群 ${args.groupId} 不存在`);
      let membershipIds;
      if (Array.isArray(args.members) && args.members.length > 0) {
        membershipIds = args.members
          .map((name) => findMemberByName(group.groupId, name))
          .filter(Boolean)
          .map((entry) => entry.member.membershipId);
      } else {
        membershipIds = service.repo.membersOf(group.groupId).map((member) => member.membershipId);
      }
      if (membershipIds.length === 0) throw new Error('群里没有可用成员');
      const roundsRaw = Number(args.rounds);
      const rounds = Number.isInteger(roundsRaw) ? Math.min(Math.max(roundsRaw, 1), 5) : 2;
      const discussion = await guarded(group.groupId, (expectedConversationId) => service.engine.startDiscussion({
        groupId: group.groupId,
        topic: String(args.topic || ''),
        membershipIds,
        rounds,
        summarize: args.summarize !== false,
        expectedConversationId,
      }));
      const shouldWait = args.wait !== false;
      let settled = true;
      if (shouldWait) {
        settled = await service.engine.whenDiscussionSettled(
          discussion.discussionId,
          Number(args.timeoutMs) || config.toolWaitTimeoutMs,
        );
      }
      const latest = service.repo.getDiscussion(discussion.discussionId) || discussion;
      const messages = service.repo
        .messagesOf(group.groupId)
        .filter((message) => message.meta && message.meta.discussionId === discussion.discussionId && message.author?.type === 'bot');
      const summary = messages.find((message) => message.meta && message.meta.summary);
      return {
        discussion: {
          discussionId: discussion.discussionId,
          topic: discussion.topic,
          rounds: discussion.rounds,
          status: latest.status,
          settled,
        },
        ...(summary ? { summary: clip(summary.text, 3000) } : {}),
        transcript: messages.map((message) => ({
          seq: message.seq,
          name: service.authorName(message),
          ...(message.meta && message.meta.round ? { round: message.meta.round } : {}),
          summary: message.meta?.summary === true,
          status: message.status,
          text: clip(message.text, 1500),
        })),
      };
    },
  });

  const compactObject = (value) =>
    Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));

  const taskBrief = (task) => {
    if (!task) return null;
    const view = service.taskView(task);
    const deliverable = view.deliverableMessageId ? service.repo.messages.get(view.deliverableMessageId) : undefined;
    const reviewReply = view.reviewReplyMessageId ? service.repo.messages.get(view.reviewReplyMessageId) : undefined;
    const assigneeMember = service.repo.getMember(view.assigneeMembershipId);
    const assigneeBot = assigneeMember ? service.repo.getBot(assigneeMember.botId) : undefined;
    const reviewerMember = view.reviewerMembershipId ? service.repo.getMember(view.reviewerMembershipId) : undefined;
    const reviewerBot = reviewerMember ? service.repo.getBot(reviewerMember.botId) : undefined;
    return compactObject({
      taskId: view.taskId,
      title: view.title,
      status: view.status,
      priority: view.priority,
      revision: view.revision,
      ready: view.ready,
      blockedBy: view.blockedBy.map((blocker) => compactObject({ title: blocker.title, status: blocker.status })),
      assignee: assigneeBot ? assigneeBot.name : undefined,
      reviewer: reviewerBot ? reviewerBot.name : undefined,
      deliverable: deliverable
        ? compactObject({ seq: deliverable.seq, status: deliverable.status, text: clip(deliverable.text, 1200) })
        : undefined,
      review: reviewReply
        ? compactObject({
            seq: reviewReply.seq,
            ...(reviewReply.meta && reviewReply.meta.verdict ? { verdict: reviewReply.meta.verdict } : {}),
            text: clip(reviewReply.text, 800),
          })
        : undefined,
      lastError: view.lastError,
    });
  };

  const waitTaskIdle = async (groupId, timeoutMs, shouldWait) => {
    if (!shouldWait) return { completed: false, running: service.engine.isRunning(groupId) };
    return waitIdle(groupId, timeoutMs);
  };

  // ── bot_team_task_create ─────────────────────────────────────────────────
  define({
    name: 'bot_team_task_create',
    description:
      'Create a Bot Team task and optionally dispatch it to its assignee bot. Tasks carry a description, acceptance criteria, priority, and dependencies on other accepted tasks. Returns the task snapshot; with dispatch+wait it also returns the delivery. Use bot_team_task_list/update for the rest of the lifecycle.',
    parameters: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: 'Target group id from bot_team_list.' },
        title: { type: 'string', description: 'Task title.' },
        description: { type: 'string', description: 'What the assignee should do.' },
        acceptance: { type: 'string', description: 'Acceptance criteria used by the reviewer prompt.' },
        assignee: { type: 'string', description: 'Assignee bot name (must be a group member).' },
        reviewer: { type: 'string', description: 'Optional reviewer bot name.' },
        priority: { type: 'string', enum: ['urgent', 'high', 'normal', 'low'], description: 'Defaults to normal; affects list sorting.' },
        dependsOn: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task ids that must be accepted before this task can be dispatched (max 10, no cycles).',
        },
        dispatch: { type: 'boolean', description: 'Dispatch immediately after creation. Defaults to false.' },
        wait: { type: 'boolean', description: 'With dispatch: wait for the delivery. Defaults to true.' },
        timeoutMs: { type: 'integer', minimum: 10000, maximum: 600000, description: 'Wait budget. Defaults to 180000.' },
      },
      required: ['groupId', 'title', 'assignee'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { task: { type: 'object' } } },
      render: (_args, value) => textRender(value, 'Bot Team task'),
    },
    execute: async (args) => {
      await ready();
      const group = service.repo.getGroup(args.groupId);
      if (!group) throw new Error('群 ' + args.groupId + ' 不存在');
      const assignee = findMemberByName(group.groupId, args.assignee);
      if (!assignee) throw new Error('指派对象 ' + args.assignee + ' 不在群里');
      const reviewer = args.reviewer ? findMemberByName(group.groupId, args.reviewer) : undefined;
      if (args.reviewer && !reviewer) throw new Error('评审者 ' + args.reviewer + ' 不在群里');
      const task = await service.dispatch('task.create', {
        groupId: group.groupId,
        title: args.title,
        description: args.description || '',
        acceptance: args.acceptance || '',
        assigneeMembershipId: assignee.member.membershipId,
        ...(reviewer ? { reviewerMembershipId: reviewer.member.membershipId } : {}),
        priority: args.priority || 'normal',
        dependsOn: Array.isArray(args.dependsOn) ? args.dependsOn : [],
      });
      let delivered = false;
      if (args.dispatch === true) {
        await service.dispatch('task.dispatch', { taskId: task.taskId });
        const wait = await waitTaskIdle(group.groupId, Number(args.timeoutMs) || config.toolWaitTimeoutMs, args.wait !== false);
        delivered = wait.completed === true;
      }
      return { task: taskBrief(service.repo.getTask(task.taskId)), delivered };
    },
  });

  // ── bot_team_task_list ───────────────────────────────────────────────────
  define({
    name: 'bot_team_task_list',
    description:
      'List Bot Team tasks of one group, sorted by priority then creation time. Each row reports status, priority, assignee/reviewer, revision, dependencies that still block dispatch, readiness, and the latest deliverable/review excerpt.',
    parameters: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: 'Target group id.' },
        taskId: { type: 'string', description: 'Return only this task id.' },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'delivered', 'changes_requested', 'accepted', 'cancelled'],
          description: 'Filter by one status.',
        },
        includeClosed: { type: 'boolean', description: 'Include accepted/cancelled tasks. Defaults to false.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max rows. Defaults to 20.' },
      },
      required: ['groupId'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { tasks: { type: 'array' } } },
      render: (_args, value) => textRender(value, 'Bot Team tasks'),
    },
    execute: async (args) => {
      await ready();
      const group = service.repo.getGroup(args.groupId);
      if (!group) throw new Error('群 ' + args.groupId + ' 不存在');
      const tasks = service.listTasks(group.groupId, {
        taskId: args.taskId,
        status: args.status,
        includeClosed: args.includeClosed === true,
        limit: Number.isInteger(args.limit) ? args.limit : 20,
      });
      return { tasks: tasks.map((task) => taskBrief(service.repo.getTask(task.taskId))) };
    },
  });

  // ── bot_team_task_update ─────────────────────────────────────────────────
  define({
    name: 'bot_team_task_update',
    description:
      'Advance one Bot Team task or edit its fields. Dispatch/review/revise may wait for the resulting bot turn and return the delivery or verdict. Dispatch and revise fail while dependencies are not accepted; cancel refuses unless force, which also cancels dependent tasks.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task id from bot_team_task_list; required unless action is dispatch_ready.' },
        groupId: { type: 'string', description: 'With dispatch_ready: group id whose ready tasks are dispatched.' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'With dispatch_ready: max tasks to dispatch. Defaults to 10.' },
        action: {
          type: 'string',
          enum: ['dispatch', 'dispatch_ready', 'review', 'accept', 'request_changes', 'revise', 'cancel', 'update'],
          description: 'Lifecycle step or field edit. dispatch_ready dispatches every ready pending task in the group (needs groupId, ignores taskId).',
        },
        instructions: { type: 'string', description: 'With review: extra review focus.' },
        wait: { type: 'boolean', description: 'For dispatch/review/revise: wait for the bot turn. Defaults to true.' },
        timeoutMs: { type: 'integer', minimum: 10000, maximum: 600000, description: 'Wait budget. Defaults to 180000.' },
        force: { type: 'boolean', description: 'With cancel: also cancel dependent tasks.' },
        title: { type: 'string', description: 'With update: new title.' },
        description: { type: 'string', description: 'With update: new description.' },
        acceptance: { type: 'string', description: 'With update: new acceptance criteria.' },
        priority: { type: 'string', enum: ['urgent', 'high', 'normal', 'low'], description: 'With update: new priority.' },
        dependsOn: { type: 'array', items: { type: 'string' }, description: 'With update: replacement dependency task ids.' },
        assignee: { type: 'string', description: 'With update: new assignee bot name.' },
        reviewer: { type: 'string', description: 'With update: new reviewer bot name; empty string removes it.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { task: { type: 'object' } } },
      render: (_args, value) => textRender(value, 'Bot Team task update'),
    },
    execute: async (args) => {
      await ready();
      if (args.action === 'dispatch_ready') {
        const groupId = String(args.groupId || '');
        if (!groupId) throw new Error('dispatch_ready 需要 groupId');
        return service.dispatch('task.dispatch_ready', {
          groupId,
          limit: Number.isInteger(args.limit) ? args.limit : 10,
        });
      }
      const task = service.repo.getTask(String(args.taskId || ''));
      if (!task) throw new Error('任务不存在');
      const groupId = task.groupId;
      let wait = { completed: false, running: service.engine.isRunning(groupId) };
      let actionResult = null;
      switch (args.action) {
        case 'dispatch':
        case 'revise':
        case 'review':
        case 'accept':
        case 'request_changes':
        case 'cancel': {
          const payload = { taskId: task.taskId };
          if (args.action === 'review') payload.instructions = args.instructions || '';
          if (args.action === 'cancel' && args.force) payload.force = true;
          actionResult = await service.dispatch('task.' + args.action, payload);
          if (args.action === 'dispatch' || args.action === 'revise' || args.action === 'review') {
            wait = await waitTaskIdle(groupId, Number(args.timeoutMs) || config.toolWaitTimeoutMs, args.wait !== false);
          }
          break;
        }
        case 'update': {
          const payload = { taskId: task.taskId };
          if (args.title !== undefined) payload.title = args.title;
          if (args.description !== undefined) payload.description = args.description;
          if (args.acceptance !== undefined) payload.acceptance = args.acceptance;
          if (args.priority !== undefined) payload.priority = args.priority;
          if (args.dependsOn !== undefined) payload.dependsOn = args.dependsOn;
          if (args.assignee !== undefined) {
            const member = findMemberByName(groupId, args.assignee);
            if (!member) throw new Error('指派对象 ' + args.assignee + ' 不在群里');
            payload.assigneeMembershipId = member.member.membershipId;
          }
          if (args.reviewer !== undefined) {
            if (args.reviewer === '') payload.reviewerMembershipId = '';
            else {
              const member = findMemberByName(groupId, args.reviewer);
              if (!member) throw new Error('评审者 ' + args.reviewer + ' 不在群里');
              payload.reviewerMembershipId = member.member.membershipId;
            }
          }
          await service.dispatch('task.update', payload);
          break;
        }
        default:
          throw new Error('未知 action: ' + String(args.action));
      }
      return {
        task: taskBrief(service.repo.getTask(task.taskId)),
        ...(actionResult && actionResult.interruption ? { interruption: actionResult.interruption } : {}),
        ...wait,
      };
    },
  });

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        /* noop */
      }
    }
  };
}
