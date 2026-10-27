# Bot Team

> 把 DeepSeek Harness 变成一间「Bot 公司」：每个 Bot 都是真实的 Agent，有独立会话、模型、人格和全套工具。你可以像用 IM 一样单聊、拉群、`@` 派活、评审、讨论、建任务。

`版本 1.2.0` · `MIT` · `DSH 0.2.1-rc.x` · `npm dsh-bot-team`

![Bot Team 首次使用欢迎页：创建 Bot、创建群聊与快速上手（深色）](<docs/design/implemented-home-dark.png>)

*当前客户端的真实 React 浏览器截图，使用隔离的模拟 API 数据。*

## 这是什么

Bot Team 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的侧栏插件。常见的「多 Agent」是在一次对话里临时开几个子 Agent，聊完即散；Bot Team 把 Bot 做成长期存在的同事：

- 每个 Bot 有名字、头像、独立的 provider / model / reasoning effort / maxTokens，以及独立 Session 记忆；
- 人格与工作规范写在 `BOT.md`，改完下一轮生效；
- 单聊是它的工位，群聊是会议室，任务工具管理工单，评审和讨论组织协作流程；
- 所有 Bot 统一为全能力 Bot：读写文件、搜索、联网、执行命令、Skill；不提供只读版或按角色裁剪工具的版本（`workspace-write` 沙箱，范围受群/单聊工作目录限制）；
- Bot 本身就是普通的 DSH 会话，随时可以点「查看会话」跳进它的执行流。

## 功能

### 对话

| 能力 | 说明 |
|---|---|
| 单聊 | 每个 Bot 自动拥有一个单聊窗口，不需要 `@`，记忆与群聊相互独立 |
| 群聊 | 群 / 话题、成员管理、`@` 派活、多 `@` 并行回复 |
| 流式 | 实时流式输出、停止、失败重试、断线补齐 |
| 消息 | 引用回复（群聊回复 Bot 时自动 `@` 原作者）、右键菜单、同作者消息合并、时间分隔、新消息分隔线、回到底部 |
| 输入 | 左下角 **+** 打开 DSH 风格分组命令菜单（文件 / 技能 / 提及 / 停止 / 导出 / 设置）；键入 `/` 选择 Skill；文件存入 DSH 附件库，Bot 拿到只读路径 |
| 导出 | 群聊导出 Markdown / HTML / PDF（PDF 文本可选中、A4 分页、页脚页码） |

### 组织与界面

- **首次使用引导**：欢迎页以 **创建 Bot** 为主入口、**创建群聊** 为次入口；**快速上手** 提供三步引导，创建成功后直接进入新 Bot 单聊或新群；
- 欢迎页及侧栏 **开始使用** 仅在没有 Bot 且没有群聊时显示；存在任一即隐藏，已有数据时不能返回欢迎页；删除全部 Bot 和群聊后恢复；欢迎页不显示右侧 Bot 库；
- 单聊、群聊、未分组和自定义分组都能展开 / 收起，群与分组支持拖动排序；
- 左侧栏从 232px 收起成 68px 图标栏，底部 **Bot 管理 / 设置** 上下排列；欢迎页随可用宽度调整卡片布局，窄屏通过导航按钮展开侧栏；
- 深浅色跟随 DSH（light / dark / system），使用 `--bt-*` token，切换即时生效；
- 账号头像、群头像（随机配色 / 10 个 SVG 插画 / 上传）、Bot 头像（按名字生成机器人面具）；
- **中文 / English 界面**跟随 DSH 的 **设置 → General → Language** 即时切换；宿主生成的讨论/评审/审批事件消息也会随语言切换，Bot 消息、群名、Bot 名等用户内容保持不变。

### 协作

- **评审**：让另一个 Bot 评审一条消息，返回「通过 / 需修改」结论徽标，可一键「让作者修改」；
- **多轮讨论**：固定轮次，显示进度、轮次与「共识 / 分歧 / 待决」总结，可随时停止；
- **任务管理（模型工具/API）**：创建任务并设置描述、验收标准、指派与评审者；派发 → 交付 → 评审 → 验收；支持优先级、DAG 依赖、环检测、验收后自动解锁、批量派发、队列与中断。群聊右侧的任务面板和「新建任务」入口已移除，任务能力仍可通过模型工具与 HTTP action 使用；
- **审批**：Bot 需要越界或升权时，群时间线出现审批卡片，点「去审批」到该 Bot 的会话里允许一次 / 拒绝，结果同步回群。

### 模型工具

在任意普通会话里也能操作群聊（8 个工具，Bot 成员自身被 deny 以防递归）：

```
bot_team_list          bot_team_create_group   bot_team_send        bot_team_review
bot_team_discuss       bot_team_task_create    bot_team_task_list   bot_team_task_update
```

## 安装

前置：DeepSeek Harness `0.2.1-rc.x`（桌面版或 CLI profile 均可）。

### 桌面版

1. 左侧栏 **插件 / Plugins** → **添加插件**；
2. 填 `dsh-bot-team@1.2.0`（也可以填本地目录绝对路径或 Git 地址）；
3. 安装完成后启用；如果之前启用过，对该 bundle **disable → enable**（或完整重启 DSH）；
4. 刷新页面，左侧栏出现 **Bot Team** 图标。

### CLI

```sh
dsh plugin --profile <profile> add dsh-bot-team@1.2.0
```

安装后同样要重新加载 Host 模块（disable→enable 或重启）。

> `1.2.0` 是当前源码版本；npm 上的公开发行版需按 [发布指南](docs/发布指南.md) 执行 `npm publish`。在发布前安装本机源码，请用本地目录路径。

### 从源码

```sh
git clone https://github.com/shper/dsh-bot-team.git
```

在插件页把 `/path/to/dsh-bot-team/bot-team` 作为本地目录添加；或让 Agent 执行 `plugin_manager` 的 `install_bundle`，`target` 填这个绝对路径。改完代码需要 disable→enable 或重启，才会加载新的 Host 模块。

> v1.1 起新增 `fontkit` 运行时依赖（PDF 字体子集）；从源码 link 安装时先在 `bot-team/` 执行 `npm install`。

### 兼容性

`engines.dsh` 为 `^0.2.1-rc.3`，安装在运行中的 DSH 版本上校验（含预发布版本）。DSH 升级到 0.3 后需要先跑一遍回归、再放宽范围并发新版本；用户被拦时可用 exact-version exemption，但会有风险提示。

## 快速开始

打开 **Bot Team**，没有 Bot 且没有群聊时会看到「开始使用」欢迎页。主按钮 **创建 Bot** 是推荐的第一步，也可以从次入口 **创建群聊** 开始；欢迎页右上角 **快速上手** 可查看以下三步：

1. **先认识一位 Bot**：点 **创建 Bot**，起名、选模型、填写 `BOT.md` 人格（可插入 9 套现成人格模板）。创建成功后自动打开它的单聊，直接发消息即可，无需 `@`。
2. **为共同的目标，建一个群**：点侧栏「群聊」右侧 **+**，保存后进入新群，再用右侧「+ 添加」邀请 Bot；同一 Bot 可以参与多个群。
3. **用 @ 邀请它们参与**：在群输入框里用 `@Bot名` 派活，多个 `@` 会并行回复并实时流式显示；随后可以发起评审或多轮讨论。

创建 Bot 或群聊后进入相应会话，欢迎页与侧栏 **开始使用** 隐藏，已有数据时不能返回欢迎页；删除全部 Bot 和群聊后恢复。取消创建会留在欢迎页。首页不显示右侧 Bot 库，全局 Bot 管理可从侧栏底部打开。欢迎页与引导支持中文 / English、light / dark 主题，并随可用宽度调整布局，窄屏可通过导航按钮访问侧栏。

任务可通过 `bot_team_task_create` / `bot_team_task_list` / `bot_team_task_update` 或 HTTP action 管理；群聊侧栏已移除任务面板。

<details>
<summary>浅色欢迎页（当前实现）</summary>

![Bot Team 首次使用欢迎页（浅色）](<docs/design/implemented-home-light.png>)

同样来自当前客户端的真实 React 浏览器渲染，API 使用隔离的模拟数据。

</details>

## 它是怎么工作的

| 层 | 做法 |
|---|---|
| Bot | `ctx.agents.create/resume` 创建真实 Agent 与持久 Session；`meta.origin='subagent'` 让它不出现在侧栏 |
| 群消息 | 群消息转成 `UserMessage` 走 `agent.followup()`；`session/event` 与 `agent/assistant-stream` 驱动消息与流式 |
| 人格 | `ctx.systemPrompt.section/context`（agent 作用域）注入 `BOT.md` 与群上下文 |
| 工具 | `ctx.agentPresets.mount` 挂载「全能力」preset；`ctx.tools.restrict` 防止 Bot 递归调用 Team 工具 |
| 数据 | storage domain `bot_team`（群 / 单聊 / 分组 / Bot / 成员 / 消息 / 讨论 / 任务），不写会话日志 |
| 页面 | 单文件 `client.js` 通过 `window.__ModuleLoader__.load` 注册到 `main` 与 `sidebar.panellist` 槽位 |
| 通道 | `/api/bot-team.*`（bootstrap / messages / events(SSE) / action / file / health），全部在登录态栅栏内 |

> 升级 DSH 后按 [升级检查清单](docs/升级检查清单.md) 逐项验证。

## 配置

`cordis.patch.yml` 的 `config` 可在 profile 的 patch 层覆盖：

| 字段 | 默认 | 说明 |
|---|---|---|
| `dataDir` | `$DSH_HOME/dsh-bot-team` | 插件数据根目录（人格与工作目录） |
| `botsDir` | `<dataDir>/bots` | `BOT.md` 存放目录 |
| `maxParallelTurns` | 3 | 群级并行回复上限 |
| `maxContextMessages` | 40 | 单轮注入的历史消息上限 |
| `enableModelTools` | true | 是否向普通会话暴露 `bot_team_*` 工具 |
| `maxTurnsPerHour` | 120 | 每群每小时 Bot 回复轮数上限 |
| `dailyTokenBudget` | 5000000 | 每群每日 token 上限 |
| `botSandbox` | true | Bot session 是否显式设为 `workspace-write` |
| `botApprovalPolicy` | ask | `ask`：越界时在群里出现审批卡片；`never`：无头模式直接拒绝 |

完整字段、HTTP action 与工具参数见 [bot-team/README.md](bot-team/README.md)。

## 数据与隐私

| 路径 | 内容 |
|---|---|
| `$DSH_HOME/storages/bot_team/` | 群、单聊、分组、Bot、成员、消息、任务、讨论 |
| `$DSH_HOME/dsh-bot-team/bots/<botId>/BOT.md` | 人格与工作规范 |
| `$DSH_HOME/dsh-bot-team/groups/<groupId>/` | 群聊工作目录 |
| `$DSH_HOME/dsh-bot-team/direct/<botId>/` | 单聊工作目录 |

- 插件不向任何第三方服务上传数据；Bot 的模型请求走你在 DSH 里配置的 provider。
- Bot 默认拥有 `workspace-write` 的文件与命令能力，范围受工作目录限制。把它们指向敏感目录之前，请先确认这是你想要的。

## 仓库结构

```
bot-team/     npm 包 dsh-bot-team：Host 半 index.js + host/*.js，Client 半 client.js
docs/         使用指南、逐版本变更记录、验收报告、发布指南、截图
research/     DSH runtime / persistence / UI 的调研笔记
tools/        开发辅助（asar 读取）
```

> 仓库根目录不是 npm 包：这里没有根 `package.json`，插件清单位于 `bot-team/package.json`。`npm run check` / `npm test` / `npm pack` 请在 `bot-team/` 下执行。

## 开发

宿主侧是普通 ESM，不 import 任何 `@deepseek-ai/*` 包；客户端是单文件 `client.js`，React 来自平台模块表。PDF 导出用 `fontkit` 读取并子集化系统 CJK 字体（唯一运行时依赖）；其余测试不依赖第三方包、不调用真实模型、不访问个人数据。

```sh
cd bot-team
npm install          # 安装唯一运行时依赖 fontkit（PDF 字体子集）
npm run check        # node --check：index.js / client.js / host/*.js
npm test             # 隔离回归测试；部分 PDF 用例按系统字体条件运行或跳过
npm pack --dry-run   # 查看真正会被发布的文件
```

发布前自检，以及 npm / Git / 插件市场索引三条发布路线见 [docs/发布指南.md](docs/发布指南.md)。

## 已知限制

- 分组只有一层；展开 / 收起是浏览器本地偏好，不跨设备同步；
- 讨论为固定轮次，同一群同时只允许一个讨论；
- 任务队列是 Engine 内存态，重启后排队标记丢失（任务仍为进行中）；
- Markdown 渲染较轻量：无语法高亮，图片未支持；
- PDF 使用系统 CJK 字体（macOS 优先 Hiragino Sans GB / Arial Unicode（宋体等无嵌入许可的字体自动跳过）；Windows/Linux 用常见中文字体）；没有 CJK 字体时导出返回 501，可用 `pdfFontPath` 指定字体文件；PDF 为轻量排版（无图片/头像、链接不可点击、emoji 可能缺字），正文文本可选中与搜索；
- 语言只覆盖界面与宿主事件消息；Bot 的回复、群名/Bot 名、人格模板正文、部分宿主错误仍按原语言显示；
- Bot 的操作边界由群/单聊工作目录、`botSandbox` 与审批策略共同约束。

## 文档

- [完整功能、HTTP 通道与配置](bot-team/README.md)
- [使用指南](docs/使用指南.md)
- [发布指南](docs/发布指南.md)
- [升级检查清单](docs/升级检查清单.md)
- [最新变更记录：v1.2 首次使用引导](<docs/v1.2-首次使用引导-变更记录.md>)
- [v1.1 中英双语与导出 PDF](<docs/v1.1-i18n与PDF-变更记录.md>)
- 当前版本 `1.2.0`；`1.0.0` 是首个 npm 公开发行版，`docs/` 的 v0.5–v0.8.1 是发布前的 0.x 内部迭代记录。
- 历史验证报告中的 `.bot-team/`、`.bot-team-spike/`、`tmp/` 证据文件已在发布前清理，报告保留为历史记录。

## License

MIT © [shper](https://github.com/shper)

## English

**Bot Team** is a DeepSeek Harness plugin for long-lived agent colleagues. Every bot is a real DSH agent with its own persistent session, model, `BOT.md` persona and full toolset (files, search, web, commands inside a `workspace-write` sandbox). Each bot gets a direct chat; groups support `@mention` dispatch, parallel streaming replies, peer review and multi-round discussions. Task tools and HTTP APIs support priorities, dependencies, review/acceptance and a dispatch queue; the group sidebar task panel and its creation entry have been removed. Data lives in the `bot_team` storage domain and `$DSH_HOME/dsh-bot-team/`; group conversations never pollute session logs.

Version **1.2.0** adds a welcome page with **Create Bot** as the primary action, **Create group** as the secondary action, and a three-step **Quick start** guide: create a Bot, form a group, then use `@` to collaborate. Successful creation opens the new direct chat or group. The sidebar **Get started** entry returns to the welcome page and stays selected during background data refreshes. The home page has no right-hand Bot library; Bot management remains available from the sidebar. Onboarding supports zh/en, light/dark themes and an adaptive narrow layout.

```sh
# Desktop: Plugins → Add plugin → dsh-bot-team@1.2.0, then reload
dsh plugin --profile <profile> add dsh-bot-team@1.2.0
```

`1.2.0` is the current source version; these npm installation examples apply once that version is published. Use a local directory to install the source before publication.

Requires DSH `0.2.1-rc.x`. The UI follows DSH's zh/en language setting, and group timelines export to Markdown, HTML, or a paginated PDF with selectable text. MIT licensed.
