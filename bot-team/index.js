/**
 * Bot Team Host entry.
 *
 * A plain-JS bundle plugin: it injects the Host services it composes over and
 * owns one BotTeamService for its lifetime. Every registration (routes, event
 * listeners, agents, domain) is released through the service disposer.
 */
import { BotTeamService } from './host/service.js';
import { resolveConfig } from './host/util.js';

// Package is published as dsh-bot-team; the Cordis plugin id stays bot-team,
// matching the built-in pattern (dsh-tool-bash → name "tool-bash").
export const name = 'bot-team';
export const inject = ['agents', 'storageDomain', 'connection', 'tools', 'agentPresets', 'sessionQuery', 'workspaceController'];

export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig && typeof rawConfig === 'object' ? rawConfig : {});
  const service = new BotTeamService(ctx, config);
  ctx.effect(() => () => service.dispose(), 'bot-team lifecycle');
}
