# Bot Team（M1–M4 + v0.5–v0.8.1 内部迭代 + v1.1 i18n/PDF）

在 DSH Web GUI 里做多 Agent 群聊与单聊：每个 Bot 自动拥有一个单聊窗口；创建群/话题 → 从全局 Bot 库拉入多个 Bot → 在群里 @ 某个 Bot 派活、多 @ 并行回复、查看流式输出。群聊可以放进自定义分组、拖动排序，单聊 / 群聊 / 每个分组都能展开或收起。

每个 Bot 是**真实的 DSH Agent**（独立持久 Session），可以单独设置：

- **模型**：provider / model / reasoning effort / maxTokens（创建时 `agentOptions`，resume 时复传）；
- **头像**：按名称生成机器人面具、点「随机生成」换配色/表情、选 10 个 SVG 插画之一，或自定义上传（浏览器裁成 256×256，存为 data URL）；
- **人格与工作规范**：`<botsDir>/<botId>/BOT.md`（一个文件写「你是谁」+「你怎么做事」，在页面内编辑，下一轮生效；旧版 SOUL.md/AGENT.md 仍可读取）；
- **工具**：所有 Bot 统一为全能力 Bot——文件读写、搜索、联网、命令执行、Skill；不提供只读版或按角色裁剪工具的版本。session 沙箱为 `workspace-write`，范围受群/单聊工作目录限制。

群、分组、Bot、成员、消息都保存在插件自己的 storage domain `bot_team`（`$DSH_HOME/storages/bot_team/`），不污染会话日志。单聊也是 group 记录（`kind: "direct"`），由 Host 自动创建与清理。

插件文件数据默认在 `$DSH_HOME/dsh-bot-team/`：

| 路径 | 用途 |
|---|---|
| `bots/<botId>/BOT.md` | Bot 人格与工作规范（旧版 SOUL.md/AGENT.md 仍兼容读取） |
| `direct/<botId>/` | 该 Bot 单聊的工作目录 |
| `groups/<groupId>/` | 该群聊的工作目录 |

群/单聊记录里的 `workspaceCwd` 可以覆盖默认值；留空即使用上表目录。从旧版本升级时，Host 首次启动会把 `$DSH_HOME/bot-team/bots` 和仍指向 `$DSH_HOME/bot-team/` 的工作目录迁到新位置；v0.8.0 短暂使用的 `<dataDir>/<botId>` 单聊目录也会被折进 `direct/<botId>`。对应群记录会一并改写，用户自己指定的外部工作目录不动。迁移后 Bot 的旧 session cwd 与新工作目录不一致，首次回复时会为该成员新建 session（群消息历史保留，旧 session 文件不删除）。

## 使用

1. 左侧栏点击 **Bot Team** 图标，打开整页工作台；工作台左侧是「对话」栏：**单聊在上、群聊在下**，群聊可放进自定义分组。点头部按钮可把侧栏收起成图标栏（详情见第 25 条）。
2. 「群聊」右侧的 **+** 创建群/话题；「单聊」右侧的 **+** 创建 Bot。**新建 Bot 后会自动创建并打开它的单聊窗口**，不需要先建群。
3. 群聊里右侧「+ 添加」把 Bot 拉入；没有 Bot 时点「+ 新建 Bot」创建（可同时选头像/上传图片、写 BOT.md 人格与工作规范，`插入模板` 里有 9 套现成人格可选）。
4. 群聊输入框里用 `@` 选择成员后发送；被 @ 的 Bot 会并行开始回复，输出实时流式显示。单聊里**不需要 @**，每条消息都会直接发给该 Bot。输入框左下角 **+** 打开与 DSH 一致的分组命令菜单（文件 / 技能 / 提及 / 停止 / 导出 / 设置）；直接键入 `/` 也能选择 Skill（`/skill-name` 会在该轮加载对应 Skill 指令）。消息按作者分组，悬停或右键可回复/复制/评审，支持引用原消息与「回到底部 / N 条新消息」。
5. 输入框底部「停止」可中断当前群所有进行中的回复。
6. **模型工具**：在任意普通会话里也能用 `bot_team_list` / `bot_team_create_group` / `bot_team_send` / `bot_team_review` / `bot_team_discuss` 操作群聊（Bot 成员自身被 deny，防递归）。
7. **更多**：评审（结论徽标 + 让作者修改）、多轮讨论（进度/总结/停止）、Markdown（表格/删除线/代码块）、历史上翻、群导出 Markdown/HTML、成员「查看会话」、群 workspace 与 token 用量。
8. **硬化**：按群配额/限流（`maxTurnsPerHour`、`dailyTokenBudget`）、所有 Bot 统一 workspace-write 沙箱（受群工作目录限制）、domain schema 迁移（meta/schema）、`GET /api/bot-team.health`。
9. **任务板（v0.5）**：右栏「+ 新建任务」（标题/描述/验收标准/指派/评审者）→ 派发 → Bot 交付 → 请评审（verdict 自动流转）/验收通过/要求修改 →「让作者修改」再交付；消息上显示任务状态标记。
10. **任务模型工具 + 依赖/优先级（v0.5.1）**：`bot_team_task_create/list/update` 可在普通会话里建任务、派发、评审、验收；任务支持 `priority`（排序/展示）与 `dependsOn`（DAG 依赖、环检测、未验收阻塞派发、验收后自动解锁）；UI 支持优先级 chip、依赖多选、任务编辑。
11. **任务队列 + 一键派发（v0.5.2）**：任务面板显示「执行中 / 排队」并支持一键派发所有就绪任务（按优先级入队、受 `maxParallelTurns` 限制）；排队中的任务显示「排队中」；`autoDispatchReady`（默认关）可在依赖解锁后自动派发。
12. **全局 Bot 管理（v0.5.4）**：左侧栏底部「Bot 管理」按钮打开「Bot 管理（全局）」，查看全部 Bot 的名称/模型/所属群，支持新建、编辑、删除（删除前提示会从群中移出）。
13. **任务面板简化（v0.5.3）**：面板只保留「派发 / 中断 / 执行流」——进行中可**中断**（abort 当前 Bot turn）；点「执行流」直接打开该任务 Bot 的 DSH 会话查看完整执行过程。新建任务精简为标题/描述/验收标准/指派。评审/验收/编辑/一键派发等能力保留在模型工具与 HTTP action 中。
14. **UI 美化（v0.5.5）**：统一字体/间距/圆角与配色；侧栏与右栏浅灰分层、群选中态淡蓝高亮、按钮白底细边+悬浮反馈、消息气泡圆角卡片、输入框/弹窗/滚动条统一。
15. **Bot 弹窗重构 + 单文件人格（v0.5.6）**：新建/编辑 Bot 改为分组表单、等宽栅格、粘性头尾与单一 `BOT.md` 编辑器（插入模板 / 字数 / 下一轮生效提示）；旧 `SOUL.md`+`AGENT.md` 自动合并读取，保存时写为 `BOT.md`。
16. **全能力 Bot（v0.5.7）**：去掉「角色与权限」字段与执行型开关；所有 Bot 统一挂载 `bot-team-tools`、workspace-write，可直接读写文件、搜索、联网、执行命令。旧 talk/review Bot 通过 schema v5 自动升级为全能力。
17. **Bot 审批流（v0.5.8）**：默认审批策略 `ask`；Bot 需要越界/升权时，群时间线出现「审批请求」卡片，点「去审批」打开该 Bot 的 DSH 会话选择允许一次/拒绝，结果同步回群。`botApprovalPolicy: never` 可关闭。
18. **Bot 头像（v0.5.9）**：默认按名称生成机器人面具，可点「随机生成」换配色/表情，或从 10 个本地 SVG 插画（星球/火箭/云朵/闪电/叶子/火焰/星星/月亮/海浪/花朵）中选一个，或上传自定义图片。消息、成员卡、Bot 库、@ 选择器、审批卡片统一显示。
19. **群聊信息流（v0.6）**：微信/飞书式气泡与头像、同作者分组、今天/昨天时间分隔、悬停操作、引用回复与点击定位、复制、新消息分隔线与回到底部、加载历史保持滚动位置、群头部状态与「···」菜单、输入框 @ 选择器键盘操作；Bot 模型与 token 用量默认隐藏，悬停回复时显示。详见 `docs/v0.6-群聊信息流-变更记录.md`。
20. **账号头像（v0.6）**：自己的消息优先显示 DSH 登录账号的头像和昵称；未登录、无头像或图片加载失败时回退渐变字母。
21. **群头像（v0.6.1）**：新建/编辑群可随机配色、选 10 个 SVG 插画或上传自定义图片；群列表与聊天顶部同步显示。
22. **深浅色主题（v0.6.2）**：跟随 DSH 的 light / dark / system；页面、气泡、面板和弹窗使用 `--bt-*` token，切换时即时生效，无需刷新。
23. **人格模板库（v0.6.3）**：`插入模板` 改为模板菜单，内置 9 套人格（通用助手 / 代码实现 / 代码评审 / 需求分析 / 技术调研 / 测试 / 文档 / 批判质疑 / 数据分析），每套带一句话说明；空内容直接填入，已有内容追加，末尾是旧模板时自动替换；Esc 或点空白关闭。详见 `docs/v0.6.3-人格模板库-变更记录.md`。
24. **消息右键菜单（v0.6.4）**：在消息上点右键弹出操作菜单——回复 / 复制文本 / 复制为引用（Markdown 引用块）/ 定位原消息 / 评审 / 让作者修改 / 重试；位置跟随光标并自动避开视口边缘，方向键切换、Esc 或点空白关闭；选中文字或右键链接时保留浏览器原生菜单。详见 `docs/v0.6.4-消息右键菜单-变更记录.md`。
25. **左侧群栏收起（v0.6.5）**：左侧栏头部新增「收起侧栏」按钮，264px 收到 68px 后只显示群头像与图标按钮（群名/时间/预览隐藏，悬停显示群名与最后消息），消息区获得更多宽度；底部 Bot 管理/设置变为图标，键盘可达；偏好存浏览器 `localStorage`，刷新与切走再回来保持。详见 `docs/v0.6.5-侧栏收起-变更记录.md`。
26. **单聊 + 群聊分组 + 右侧面板收起（v0.7）**：每个 Bot 自动拥有一个单聊（创建 Bot 后直接打开，侧栏「单聊」区固定在群聊上方）；单聊无需 @，复用完整的时间线/流式/停止/导出与独立会话记忆。群聊可放进自定义分组、分组与群都支持拖动/菜单自定义排序；「单聊」「群聊」「未分组」和每个自定义分组都能展开/收起（状态存浏览器）。聊天右上角的右侧面板按钮和面板头的「»」都能收起/展开成员/任务/单聊信息面板，偏好同样存浏览器。详见 `docs/v0.7-单聊与分组-变更记录.md`。
27. **设置 / 关于（v0.7）**：左侧栏「设置」弹窗改为模块导航（消息设置 / 关于）；原有显示设置整体移入「消息设置」，「关于」显示插件说明、版本号、包名、开发者与数据位置；版本/包名/开发者由 Host 读取 `package.json` 下发。
28. **插件改名与数据目录（v0.8）**：包名与 Client 模块 id 统一为 `dsh-bot-team`，bundle 行仍为 `bot-team`；插件数据根目录迁到 `$DSH_HOME/dsh-bot-team/`，首次启动自动迁移旧 `$DSH_HOME/bot-team/`。
29. **单聊目录分层（v0.8.1）**：单聊工作目录改为 `<dataDir>/direct/<botId>/`，与群聊的 `groups/<groupId>/` 分层；启动迁移自动折叠 v0.8.0 的 `<dataDir>/<botId>/`。
30. **输入框 + 命令菜单与 Skill（v1.1）**：左下角 **+** 改为与 DSH 一致的全宽分组命令菜单（「添加」/「指令」，图标 + 中文名 + 英文别名 + 右侧说明，↑↓/Tab/Enter/Esc 操作）。**文件** 把本地文件存入 DSH 附件库（Bot 拿到只读路径，消息气泡显示附件卡）；**技能** 打开 Skill 选择器；群聊还可 **提及成员**；**指令** 组提供停止回复、导出 Markdown/HTML 与消息设置。输入框直接键入 `/` 也会打开 Skill 选择器。Bot 预设新增 `skill-filesystem` + `tool-skill`，选中的 `/skill-name` 由 DSH 原生 gesture 在当前轮注入完整 Skill 指令。详见 `../docs/输入框文件与Skill-变更记录.md`。
31. **回复自动 @（v1.1）**：群聊信息流里回复 Bot 消息时，输入框自动带上该 Bot 的 `@` 并加入显式 mention；切换回复对象会替换上一个自动 @（只动自动插入的前缀，不改用户正文），单聊和回复人类消息不插入。这样回复不会因为缺少 `@` 而没有 Bot 回应。
32. **中英双语（v1.1）**：界面跟随 DSH 的 **设置 → General → Language** 即时切换 zh/en；按钮、菜单、弹窗、空态、提示与宿主生成的讨论/评审/审批事件消息都会翻译，Bot 消息、群名、Bot 名、人格正文等用户内容保持原文。实现走 DSH 的 `ctx.locale` 服务（注册 `botTeam` 字典 + 渲染时查表），内容值按子树加保护，避免把名为「设置」的群错误翻译。
33. **导出 PDF（v1.1）**：群聊「···」菜单与输入框「指令」菜单新增「导出 PDF」；Host 用系统 CJK 字体 + `fontkit` 子集生成 PDF 1.7（文本可选中/搜索、A4 分页、页眉页脚页码），无需浏览器打印对话框。字体自动发现（macOS Hiragino Sans GB / Arial Unicode，Windows 微软雅黑/宋体，Linux 文泉驿等；无嵌入许可的字体自动跳过）；可用 `pdfFontPath` 指定。详见 `../docs/v1.1-i18n与PDF-变更记录.md`。


## 设置（消息设置 / 关于）

左侧栏底部 **Bot 管理** 旁的 **设置** 打开 Bot Team 设置，无需先选择群。弹窗改为左侧模块导航 + 右侧内容，模块为 **消息设置** 和 **关于**；导航支持 ↑/↓/Home/End 切换，选中项有高亮和焦点环。

**消息设置**（原有显示设置整体移入这里）：

- **模型名称 / 输入 Token / 输出 Token / 平均回复速度** 可各自选择 **悬停显示 / 常驻显示 / 隐藏**，默认全部悬停显示。
- 悬停模式也支持消息内部的键盘焦点；无悬停能力的触屏设备自动显示。隐藏模式完全移除对应字段，不影响正文、轮次、评审、停止/错误状态。
- 弹窗提供即时示例预览、恢复默认、取消和保存。只有 **保存设置** 会应用到所有群聊；保存失败时保留草稿并显示错误。
- 偏好存于当前 DSH 配置的 storage domain `bot_team` → `meta` → `chat-display-settings`，不依赖浏览器端口，刷新、切换群和重启后保留。有群 SSE 连接的其他页面也会同步设置；重连时通过 `hello` 获取最新值。
- Token 沿用最近一次模型上报的用量，**不是本轮多次模型调用的累计量**；缺失数据不伪装成 0。
- 速度为最近一次成功模型请求的输出 Token / 耗时，显示 `tok/s`。Host 用单调时钟测量请求流开始到响应提交，并验证同一 attempt 的结束帧；包含请求等待、思考、网络与本地提交开销，不包含排队、Agent 初始化、工具/审批等待或重试退避，**不是纯解码速度**。缺少计时/用量的历史消息、未完成/失败/停止的回复不显示速度，不按消息时间戳补算。

**关于**：

- 插件说明和功能特性（单聊自动创建、群聊分组与拖拽排序、展开/收起、BOT.md 人格、任务与评审）。
- **版本号 / 包名 / 开发者** 来自插件 `package.json`，由 Host bootstrap 的 `plugin` 字段下发；当前为 `1.1.0` / `dsh-bot-team` / `shper`。
- 数据与人格文件位置：`$DSH_HOME/storages/bot_team`、`$DSH_HOME/dsh-bot-team/bots/<botId>/BOT.md`；单聊 / 群聊工作目录在 `$DSH_HOME/dsh-bot-team/direct/<botId>/` 与 `$DSH_HOME/dsh-bot-team/groups/<groupId>/`。

![设置 · 消息设置](<../docs/assets/v0.7-settings-light.png>)

![设置 · 关于（深色）](<../docs/assets/v0.7-settings-about-dark.png>)

更新涉及 Host 和 Client：重新启用插件（或重启 DSH），然后刷新现有 GUI 页面。普通浏览器刷新不能单独加载新的 Host 模块。**v0.8 改名例外：profile 的 bundle 名已从 `@local/bot-team` 换成 `dsh-bot-team`，必须完整重启 DSH；只做 disable→enable 或刷新页面会找不到旧模块。**

## 数据与配置

`cordis.patch.yml` 的 `config`：

| 字段 | 默认 | 说明 |
|---|---|---|
| `dataDir` | `$DSH_HOME/dsh-bot-team` | 插件数据根目录（人格与工作目录） |
| `botsDir` | `<dataDir>/bots` | BOT.md（兼容旧 SOUL.md/AGENT.md）存放目录 |
| `defaultCwd` | Host 进程 cwd | 旧记录没有 `workspaceCwd` 时的兜底；新建群/单聊不再使用 |
| `migrateLegacyLayout` | true | 首次启动迁移 `$DSH_HOME/bot-team` 旧布局 |
| `maxParallelTurns` | 3 | 群级并行回复上限 |
| `maxContextMessages` | 40 | 单轮注入的历史消息上限 |
| `turnTimeoutMs` | 300000 | 单轮超时 |
| `smokeTest` | false | 激活时跑端到端冒烟/恢复检查（仅验证用；已关闭） |
| `enableModelTools` | true | 是否向普通会话暴露 `bot_team_*` 工具 |
| `toolWaitTimeoutMs` | 180000 | 模型工具等待 Bot 回复/讨论的默认超时 |
| `maxTurnsPerHour` | 120 | 每群每小时 Bot 回复轮数上限 |
| `dailyTokenBudget` | 5000000 | 每群每日 token 上限 |
| `botSandbox` | true | 是否把 Bot session 显式设为 `workspace-write` 沙箱 |
| `botApprovalPolicy` | ask | `ask`：越界/升权时在群时间线出现审批卡片，去 Bot 会话完成授权；`never`：无头模式，直接拒绝所有需审批操作 |
| `pdfFontPath` | 空 | 可选：指定 PDF 导出的 CJK TrueType/TTC 字体文件；空则按平台自动发现 |

HTTP 通道（全部在 `/api` 登录态栅栏内）：

- `GET /api/bot-team.bootstrap`
- `GET /api/bot-team.messages?groupId=…`
- `GET /api/bot-team.events?groupId=…`（SSE）
- `POST /api/bot-team.action`（`group.create` / `group.reorder` / `folder.create` / `folder.update` / `folder.delete` / `folder.reorder` / `direct.open` / `bot.create` / `member.add` / `message.post` / `message.stop` / `persona.write` / `settings.chatDisplay.update` …）
- `GET|PUT /api/bot-team.file`（`kind=bot`；兼容 `soul` / `agent`）
- `POST /api/bot-team.upload?name=…&groupId=…`（原始字节；返回 `attachmentId` / `name` / `bytes`）
- `GET /api/bot-team.skills?groupId=…&memberId=…`（当前工作区中 `userInvocable` 的 Skill；首次调用会准备一个 Bot 会话读取其工作区）
- `GET /api/bot-team.export.pdf?groupId=…&lang=zh|en`（返回 PDF，`Content-Disposition` 下载；无 CJK 字体时 501）

## 安装

这是一个标准 DSH bundle：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，`dsh.client` + `exports["./client"]` 提供 Web 端界面，`exports["./locale/*.json"]` / `exports["./icon"]` 提供插件管理页的标题、描述与图标。npm 包名：`dsh-bot-team`。

**桌面版（当前 GUI）**：左侧栏 **插件 / Plugins** 页 → 添加插件，填 `dsh-bot-team@<版本>`（或本地绝对路径、Git 地址）；装好后对 `bot-team` 行 disable → enable，或完整重启 DSH；浏览器刷新页面。

**CLI / 其他 profile**：

```sh
dsh plugin --profile <profile> add dsh-bot-team@1.1.0
```

> `1.1.0` 是当前源码版本；若 npm 上尚未发布，请用本地目录或 Git 地址安装（发布见 `../docs/发布指南.md`）。

该命令安装包，并把新 bundle 追加到 profile 的 `dsh.profile.bundles`。升级用 remove → add；桌面版插件页在提供 **Update** 时可直接更新，否则也是移除后重装。装完必须重新加载 Host 模块：只刷新页面不会加载新的 Host 代码。

**Git 直装**（不经过 npm）：

```sh
git+https://github.com/shper/dsh-bot-team.git#<40 位 commit>&path:/bot-team
```

**兼容性**：`engines.dsh` 为 `^0.2.1-rc.3`，安装前按运行中的 DSH 版本校验（含预发布版本）；DSH 升级到 0.3 后需先回归、再放宽 range 并发新版本。被拦时可用 exact-version exemption，但会提示风险。

发布流程（npm / Git / 插件市场索引、检查清单与已知风险）见 [docs/发布指南.md](https://github.com/shper/dsh-bot-team/blob/main/docs/%E5%8F%91%E5%B8%83%E6%8C%87%E5%8D%97.md)。

## 开发

宿主侧是普通 ESM（`index.js` + `host/*.js`，不 import 任何 `@deepseek-ai/*` 包）；客户端是单文件 `client.js`（`window.__ModuleLoader__.load` 工厂，React 来自平台模块表）。

安装/更新：`plugin_manager install_bundle` 之后，改代码需对 `bot-team` 行 `disable → enable`（或重启 DSH）才会加载新的 Host 模块；v0.8 改名后旧行名失效，必须完整重启 DSH。

发布前自检（在 `bot-team/` 目录）：

```sh
npm install            # 安装唯一运行时依赖 fontkit（PDF 字体子集）
npm run check          # node --check：index.js / client.js / host/*.js
npm test               # 134 条隔离回归测试（133 通过 + 1 条按字体条件跳过）
npm pack --dry-run     # 查看真正会被发布的文件
```

`npm publish` 会通过 `prepublishOnly` 自动跑 `check` + `test`。

### 隔离回归测试

在工作区根目录运行（无需第三方依赖，不调用真实模型、不访问个人历史/凭据）：

```sh
node --test bot-team/test/*.test.js
node --check bot-team/client.js
```

覆盖设置校验、持久化/失败处理、重启读取、HTTP/SSE 同步、设置弹窗模块（消息设置 / 关于）与插件元数据、全部 81 种字段模式组合、弹窗保存/取消/重试、流式气泡回归、消息右键菜单（动作生成/禁用态/引用复制/视口定位/菜单渲染/页面集成）、左侧群栏收起/展开（图标模式/键盘/localStorage 降级）、单聊与分组的侧栏模型/折叠/拖放计算/右侧面板折叠/旧 Host 降级、Host 侧单聊自动创建与 @ 语义/分组 CRUD/排序/schema v6 迁移、真实 Service 启动/路由/工具注册、DSH 风格 + 命令菜单与文件/Skill 选择器（分组结构、触发串、模糊排序、大小格式化、附件卡片渲染）、附件上传/引用归一化/消息持久化/Bot prompt 只读路径/Skill 按 agent scope 过滤、英文界面与内容保护（字典完整性/占位符/系统消息/语言切换）、PDF 字体子集/分页/ToUnicode/路由，以及最新请求速度的重试/工具/中断边界。Client 测试使用 VM 与轻量 React stub，验证组件结构与事件逻辑，不替代真实浏览器的布局、焦点和深浅色视觉验收。

## 已知限制

- Markdown 为轻量渲染（无语法高亮；已支持表格/删除线，图片未支持）。
- 讨论仅固定轮次（无 AI 主持人、同一群同时只允许一个讨论）。
- 讨论中的单条消息不支持重试（请重新发起讨论）。
- 审批默认 `ask`：Bot 越界/升权时会在群时间线出现「审批请求」卡片，点「去审批」打开该 Bot 的 DSH 会话选择「允许一次 / 拒绝」；无人处理时会等到本轮超时。`botApprovalPolicy: never` 可切回严格的自动拒绝模式。
- Bot 的操作边界由群/单聊工作目录、`botSandbox` 与审批策略共同约束。
- 语言只覆盖界面与宿主事件消息；Bot 回复、群名/Bot 名、人格模板正文与部分宿主错误保持原语言。
- PDF 依赖系统 CJK 字体；无字体时返回 501（可用 `pdfFontPath` 指定）。PDF 为轻量排版：无图片/头像、链接不可点击、emoji 可能缺字；正文可选中/搜索。

- 导出 HTML 为轻量 Markdown 转换（无表格/图片）。
- 任务板：优先级只影响排序/展示（不抢占调度）；依赖仅支持「全部 accepted」；无任务删除/排期/工时。
- 队列为 Engine 内存态（重启后排队标记丢失，任务仍 in_progress）；一键派发无独立持久队列。
- 任务面板 UI 只暴露「派发 / 中断 / 执行流」；评审/验收/编辑/一键派发需通过模型工具或 HTTP action。
- 单聊固定一对一（一个 Bot），不能加成员、不能删除；删除 Bot 时会连同单聊与单聊消息一起删除。单聊不参与模型工具 `bot_team_list`，也不会进入群聊分组；评审、讨论、任务板等群聊专属流程在单聊中禁用（Host 拒绝）。
- 分组只支持一层（不能嵌套）；分组删除后群会回到「未分组」，不会被删除。
- 分组/群的自定义排序保存在 Host；「展开/收起」是浏览器本地偏好，不跟随账号同步。
- 左侧栏收起为图标栏时不显示分组标题，只按单聊 → 群聊的顺序展示头像与分隔线。
- 右侧面板的展开/收起是浏览器本地偏好；`≤1100px` 时右侧面板本来就自动隐藏，右上角的切换按钮也一并隐藏。没有选中会话时（右侧显示 Bot 库）不提供收起。
- v0.7 同时改了 Host：升级后必须重新加载 Host 模块（disable→enable 或重启 DSH）再刷新页面；只刷新页面会看到「Host 仍是旧版本」提示。
- 输入框附件是**通用文件**：单文件 ≤32 MB、每条消息 ≤10 个；图片/二进制不会作为视觉输入送给模型，Bot 只能通过只读路径读取。附件存入 `$DSH_HOME/attachments/v1`，不随消息或群删除，也不会自动回收。
- Skill 选择器读取的是 Bot 工作区的 `userInvocable` Skill；首次打开会准备一个 Bot 会话，可能稍慢。Host 未重新加载时，Bot 预设还没有 `skill-filesystem` / `tool-skill`，`/skill-name` 不会加载对应指令。
- 本次同时改了 Host 路由（`upload` / `skills`）与 Bot 预设：建议**完整重启 DSH** 让 bundle patch 重新应用，再刷新页面；只 disable→enable 插件不保证刷新预设。
- **v1.1 升级提示**：新增 `/api/bot-team.export.pdf` 路由与 `fontkit` 依赖，必须重新加载 Host（disable→enable 或重启 DSH）再刷新页面；从源码 link 安装时先在 `bot-team/` 执行 `npm install`。

## 下一阶段

v1.1 已完成 M5 的「完整 i18n（zh/en）」与「导出 PDF」；剩余：可选的 per-Bot 权限分级（只读 / 全能力）、多进程配额账本、持久任务队列 / 优先级抢占、PDF 图片与可点击链接。
