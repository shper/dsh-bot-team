/**
 * Bot agents: one live DSH Agent per group membership, created/resumed lazily.
 *
 * Creation contract (M0-verified):
 *   agents.create({ sessionId, meta:{ cwd, origin:'subagent', agentPreset },
 *                   agentOptions:{ provider, model, reasoningEffort?, maxTokens? },
 *                   setup(agentCtx, agent) })
 * Resume contract (M0 P2): `agents.resume` does NOT inherit the stored route, so
 * every resume re-supplies agentOptions.
 *
 * setup() installs, for that one agent scope:
 *   - the full tool preset (files, search, web, bash, todo),
 *   - a `deployment:persona-prefix` section that replaces the deployment persona,
 *   - a `bot-team:group` runtime context with the live roster,
 *   - tool restrictions that block recursive Team tools,
 *   - approval policy `never` (background bots cannot answer human approvals).
 */
import { BOT_TEAM_TOOL_NAMES } from './tools.js';
import { newId } from './util.js';
import { defaultWorkspaceDir, ensureWorkspaceDir, sessionCwdMatches, validateProjectWorkspace } from './workspace.js';

const BOT_PRESET_ID = 'bot-team-tools';

const TEAM_TOOL_CANDIDATES = [
  'spawn_teammate',
  'send_message',
  'interrupt_agent',
  'list_agents',
  'wait_agent',
  'team_task_create',
  'team_task_get',
  'team_task_list',
  'team_task_update',
  'subagent',
  'subagent_fork',
  'ask_user_question',
  'workflow',
];

export class AgentPool {
  constructor({ ctx, repo, personas, config, logger }) {
    this.ctx = ctx;
    this.repo = repo;
    this.personas = personas;
    this.config = config;
    this.logger = logger;
    this.entries = new Map();
    this.preparing = new Map();
  }

  sessionIdOf(member) {
    return member.sessionId;
  }

  async ensure(memberId) {
    if (this.preparing.has(memberId)) return this.preparing.get(memberId);
    const pending = this.prepare(memberId);
    this.preparing.set(memberId, pending);
    try {
      return await pending;
    } finally {
      if (this.preparing.get(memberId) === pending) this.preparing.delete(memberId);
    }
  }

  isPreparingGroup(groupId) {
    return [...this.preparing.keys()].some((memberId) => this.repo.getMember(memberId)?.groupId === groupId);
  }

  async prepare(memberId) {
    const member = this.repo.getMember(memberId);
    if (!member) throw new Error(`membership ${memberId} does not exist`);
    const bot = this.repo.getBot(member.botId);
    if (!bot) throw new Error(`bot ${member.botId} of membership ${memberId} does not exist`);
    const group = this.repo.getGroup(member.groupId);
    if (!group) throw new Error(`group ${member.groupId} does not exist`);

    const cwd = group.workspaceCwd || defaultWorkspaceDir(this.config, group);
    if (group.projectWorkspaceCwd) await validateProjectWorkspace(cwd);
    const fingerprint = JSON.stringify({
      provider: bot.provider,
      model: bot.model,
      reasoningEffort: bot.reasoningEffort ?? null,
      maxTokens: bot.maxTokens ?? null,
      cwd,
    });

    const existing = this.entries.get(memberId);
    if (existing && existing.fingerprint === fingerprint && this.ctx.agents.get(existing.sessionId)) {
      return existing.handle.agent;
    }
    if (existing) {
      try {
        await existing.handle.dispose();
      } catch (error) {
        this.logger?.warn?.(`bot-team: dispose stale agent ${memberId} failed: ${String(error)}`);
      }
      this.entries.delete(memberId);
    }

    const presetId = BOT_PRESET_ID;
    const agentOptions = {
      provider: bot.provider,
      model: bot.model,
      ...(typeof bot.reasoningEffort === 'string' && bot.reasoningEffort ? { reasoningEffort: bot.reasoningEffort } : {}),
      ...(Number.isInteger(bot.maxTokens) && bot.maxTokens > 0 ? { maxTokens: bot.maxTokens } : {}),
    };
    const setup = this.makeSetup(member.membershipId);
    if (!group.projectWorkspaceCwd && !(await ensureWorkspaceDir(cwd, this.logger))) {
      throw new Error('无法准备默认工作目录');
    }
    const meta = {
      cwd,
      origin: 'subagent',
      agentPreset: presetId,
    };

    let handle;
    try {
      handle = await this.ctx.agents.resume({
        resumeSessionId: member.sessionId,
        agentOptions,
        setup,
      });
    } catch (resumeError) {
      this.logger?.info?.(
        `bot-team: resume ${member.sessionId} failed, creating a fresh bot session: ${String(
          resumeError && resumeError.message ? resumeError.message : resumeError,
        )}`,
      );
      handle = await this.ctx.agents.create({
        sessionId: member.sessionId,
        meta,
        agentOptions,
        setup,
      });
    }

    // DSH fixes a session's sandbox root to its creation cwd and refuses to adopt
    // a session under another cwd, so a group whose workspace moved (v0.8 layout
    // migration, or a workspace edit) needs a fresh session. Group history lives
    // in the domain, so the bot keeps the conversation; only its DSH session log
    // restarts. The old session file is left on disk.
    const sessionCwd = handle.agent?.session?.header?.cwd;
    if (!sessionCwdMatches(sessionCwd, cwd)) {
      const previousSessionId = member.sessionId;
      try {
        await handle.dispose();
      } catch (error) {
        this.logger?.warn?.(`bot-team: dispose session ${previousSessionId} failed: ${String(
          error && error.message ? error.message : error,
        )}`);
      }
      const freshSessionId = newId('session-botteam');
      this.logger?.info?.(
        `bot-team: workspace ${cwd} does not match session ${previousSessionId} cwd ${String(
          sessionCwd,
        )}; starting fresh session ${freshSessionId}`,
      );
      handle = await this.ctx.agents.create({ sessionId: freshSessionId, meta, agentOptions, setup });
      member.sessionId = freshSessionId;
      member.lastSeenSeq = 0;
      await this.repo.putMember(member);
    }

    // Keep the effective working directory aligned even when the session's
    // sandbox root is already the workspace (no-op in the normal case).
    const workingDirectory = this.ctx.get('workingDirectory');
    if (workingDirectory && typeof workingDirectory.set === 'function') {
      try {
        await workingDirectory.set(handle.agent, cwd);
      } catch (error) {
        await handle.dispose();
        throw new Error(`无法设置 Bot 工作目录 ${cwd}: ${String(error?.message || error)}`);
      }
    }

    this.entries.set(memberId, {
      membershipId: memberId,
      sessionId: member.sessionId,
      handle,
      fingerprint,
      agent: handle.agent,
    });
    await this.applySandboxMode(handle.agent);
    return handle.agent;
  }

  /**
   * All bots are full-capability, so the session sandbox is workspace-write.
   * The mode is a normal session event (the canonical write path), appended
   * only when it differs. Group cwd still bounds the filesystem.
   */
  async applySandboxMode(agent) {
    if (!this.config.botSandbox) return;
    const desired = 'workspace-write';
    try {
      const policy = this.ctx.get('sandboxPolicy');
      const current = policy && typeof policy.overrideOf === 'function' ? policy.overrideOf(agent.session) : undefined;
      if (current === desired) return;
      if (agent.session && typeof agent.session.append === 'function') {
        agent.session.append('sandbox/mode', { mode: desired });
      }
    } catch (error) {
      this.logger?.warn?.('bot-team: apply sandbox mode ' + desired + ' failed: ' + String(error));
    }
  }

  current(memberId) {
    const entry = this.entries.get(memberId);
    if (!entry) return undefined;
    if (!this.ctx.agents.get(entry.sessionId)) {
      this.entries.delete(memberId);
      return undefined;
    }
    return entry.agent;
  }

  makeSetup(membershipId) {
    return async (agentCtx, agent) => {
      const member = this.repo.getMember(membershipId);
      const bot = member ? this.repo.getBot(member.botId) : undefined;
      const group = member ? this.repo.getGroup(member.groupId) : undefined;
      if (!member || !bot || !group) return;

      // 1) full tool preset (files, search, web, bash, todo)
      const presetId = BOT_PRESET_ID;
      const presets = this.ctx.get('agentPresets');
      if (presets && typeof presets.mount === 'function') {
        try {
          const preset = await presets.resolve(presetId);
          await presets.mount(agentCtx, preset.id);
        } catch (error) {
          this.logger?.warn?.(`bot-team: mount preset ${presetId} failed: ${String(error)}`);
        }
      }

      // 2) identity: shadow the deployment persona for this agent only
      try {
        agentCtx.systemPrompt.section({
          name: 'deployment:persona-prefix',
          order: 0,
          text: () => {
            // Lazy import-free rebuild each assembly from current repo state.
            const currentMember = this.repo.getMember(membershipId);
            if (!currentMember) return '';
            return this.personaText(currentMember.botId, currentMember.groupId);
          },
        });
      } catch (error) {
        this.logger?.warn?.(`bot-team: register persona section failed: ${String(error)}`);
      }

      // 3) live roster runtime context
      try {
        agentCtx.systemPrompt.context({
          name: 'bot-team:group',
          order: 600,
          text: () => {
            const currentMember = this.repo.getMember(membershipId);
            if (!currentMember) return '';
            return this.groupContextText(currentMember.botId, currentMember.groupId);
          },
        });
      } catch (error) {
        this.logger?.warn?.(`bot-team: register group context failed: ${String(error)}`);
      }

      // 4) tool restrictions: Team tools only (no recursive group driving)
      try {
        const tools = this.ctx.get('tools');
        const deny = [];
        for (const name of [...TEAM_TOOL_CANDIDATES, ...BOT_TEAM_TOOL_NAMES]) {
          if (tools && typeof tools.get === 'function' && tools.get(name) !== undefined && !deny.includes(name)) {
            deny.push(name);
          }
        }
        if (deny.length > 0 && agentCtx.tools && typeof agentCtx.tools.restrict === 'function') {
          agentCtx.tools.restrict({ deny });
        }
      } catch (error) {
        this.logger?.warn?.(`bot-team: restrict bot tools failed: ${String(error)}`);
      }

      // 5) forward live assistant stream frames (agent-scoped event) to the engine
      try {
        if (typeof agentCtx.on === 'function') {
          agentCtx.on('agent/assistant-stream', (payload) => {
            try {
              this.streamHandler?.({ ...payload, agent });
            } catch {
              /* noop */
            }
          });
        }
      } catch (error) {
        this.logger?.warn?.(`bot-team: subscribe assistant stream failed: ${String(error)}`);
      }

      // Inbox claims are agent-scoped and contain only { message, turn }.
      // Capture the actual agent, since a membership may later rotate sessions.
      try {
        agentCtx.on?.('agent/inbox/claimed', (payload) => {
          try {
            this.claimHandler?.({ ...payload, agent });
          } catch (error) {
            this.logger?.warn?.(`bot-team: handle inbox claim failed: ${String(error)}`);
          }
        });
      } catch (error) {
        this.logger?.warn?.(`bot-team: subscribe inbox claims failed: ${String(error)}`);
      }

      // 6) approval policy: `ask` lets a bot request one-time permission for a
      //    sandbox escalation; the approval is surfaced as a Bot Team timeline
      //    card and answered in the bot's own DSH session. `never` is the
      //    deterministic headless fallback (deny every approval request).
      try {
        const approval = this.ctx.get('approval');
        if (approval && typeof approval.setPolicy === 'function') {
          approval.setPolicy(agent, this.config.botApprovalPolicy === 'never' ? 'never' : 'ask');
        }
      } catch (error) {
        this.logger?.warn?.(`bot-team: set approval policy failed: ${String(error)}`);
      }
    };
  }

  // Persona/context builders are injected by the service after construction to
  // keep this module free of prompt-formatting dependencies.
  personaText(botId, groupId) {
    return this.prompt.renderPersona(botId, groupId);
  }

  groupContextText(botId, groupId) {
    return this.prompt.renderGroupContext(botId, groupId);
  }

  attachPrompt(promptApi) {
    this.prompt = promptApi;
  }

  /** Assistant stream frames are agent-scoped; the setup callback forwards them here. */
  attachStreamHandler(handler) {
    this.streamHandler = handler;
  }

  attachClaimHandler(handler) {
    this.claimHandler = handler;
    return () => {
      if (this.claimHandler === handler) this.claimHandler = undefined;
    };
  }

  async disposeMember(membershipId, { strict = false } = {}) {
    const entry = this.entries.get(membershipId);
    if (!entry) return;
    this.entries.delete(membershipId);
    try {
      await entry.handle.dispose();
    } catch (error) {
      this.logger?.warn?.(`bot-team: dispose agent ${membershipId} failed: ${String(error)}`);
      if (strict) {
        this.entries.set(membershipId, entry);
        throw error;
      }
    }
  }

  async disposeAll() {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) {
      try {
        await entry.handle.dispose();
      } catch (error) {
        this.logger?.warn?.(`bot-team: dispose agent ${entry.membershipId} failed: ${String(error)}`);
      }
    }
  }

  list() {
    return [...this.entries.keys()];
  }
}
