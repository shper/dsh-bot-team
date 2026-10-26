# Bot Team — M0 Spike Bundle（已完成，已卸载）

> **结果：M0 全绿 22/22**（含整机重启后 resume 上一次 bot 会话、页面真实渲染）。
> 报告见 [../../docs/M0-验证报告.md](../../docs/M0-验证报告.md)，原始证据见 `../../.bot-team-spike/results.jsonl`。
> 本目录保留作参考/复测用；插件本体已从 profile 卸载，spike 创建的 bot session 已清理。

一次性技术验证插件，**验证完立即卸载**。它验证正式方案 `bot_team` 依赖的 6 个技术假设，
把结果写到工作区 `.bot-team-spike/results.jsonl`。

## 验证内容

| # | 检查 | 结果 ID |
|---|---|---|
| 1 | 整页（`main` slot）+ 侧栏入口（`sidebar.panellist`）注册与渲染 | `client.page.mounted` + `Slots.listSubTree` 检查 |
| 2 | 页面内 Cookie 鉴权的 exact Fetch 路由（GET/POST） | `client.route.bootstrap` / `client.route.action` |
| 3 | 插件自有 storage domain 的写入/重读/变更事件 | `host.domain.open` / `host.domain.crud` / `client.route.persist` |
| 4 | SSE 实时推送 + 服务端主动断流后的自动重连 | `client.sse.hello` / `client.sse.reconnect` |
| 5 | 真实 bot agent：自定义模型 + 人格 section + 审批策略 + 回复捕获 | `host.bot.created` / `host.bot.firstTurn` / `host.bot.personaAssembled` / `host.bot.sessionHeader` / `host.bot.requestHeaderRoute` / `host.bot.personaInSessionLog` |
| 6 | dispose 后 resume 同一 session 并继续对话 | `host.bot.disposed` / `host.bot.resumed` / `host.bot.resumedTurn` / `host.bot.historyContinuity` |

Host 自测在插件激活后自动开始；Client 自测在页面加载后自动开始。
要拿到 `client.page.mounted`，需要在左侧栏点一次 "Bot Team Spike" 图标。

## 安装（需要审批）

```text
plugin_manager action=install_bundle target=/Users/shper/Documents/11_dsh_plugin/bot_team/spike/bot-team-spike
```

安装后刷新页面（或等待 Client HMR）：左侧栏出现 "Bot Team Spike"。

## 查看结果

```bash
cat /Users/shper/Documents/11_dsh_plugin/bot_team/.bot-team-spike/results.jsonl
```

## 卸载（验证完必须执行）

```text
plugin_manager action=remove_bundle target=@local/bot-team-spike
```

卸载后刷新页面，侧栏入口与页面消失；插件创建的 bot session 保留在 `~/.dsh/sessions`
（`origin: subagent`，不会出现在会话列表），可忽略或用会话导出工具清理。

## 已知的故意简化

- 没有 locale / icon 资源（一次性测试夹具，不进入正式插件清单）。
- 没有声明 `Config` schema（Host 手动解析 config）。
- domain 的 zod schema 用最小 `{ parse }` 替身（M0 只验证 domain 机制，正式插件会带 `zod` 依赖）。
- bot agent 不挂 preset（正式插件才需要工具集），M0 只验证模型/人格/生命周期。
