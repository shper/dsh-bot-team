# 输入框 + / 文件 / Skill 变更记录

> 状态：代码与测试完成；本次改了 Host 路由与 Bot 预设（bundle patch），建议**完整重启 DSH**（让 Host 模块和 `bot-team-tools` 预设一起重新加载），再刷新页面。只 disable → enable 插件不保证重新应用 bundle patch。

## 背景

Bot Team 的输入框只有 `@` 提及与发送/停止，不能带文件，也不能选 Skill。本次把 DSH 主输入框的两类常用能力补到群聊/单聊输入框：

- 左下角新增与 DSH 一致的 **+** 分组命令菜单（添加 / 指令）；
- 在输入框键入 `/` 直接打开 Skill 选择器；
- 附件随消息持久化，Bot 拿到只读路径，消息气泡显示附件卡。

## 变更

### 1. 输入框 +

- 位置：输入框底部左侧，发送按钮之前。
- **对齐 DSH 的 + 命令菜单**：弹层铺满输入框宽度，分「添加」「指令」两组；每行是 14px 图标 + 中文名 + 英文别名 + 右侧说明，支持 ↑/↓、Tab、Enter、Esc 与悬停/焦点高亮。
- 「添加」组：
  - **文件 file**：打开浏览器文件选择（多选），单个文件上限 32 MB，每条消息最多 10 个；上传中/失败会显示在输入框上方的草稿附件条。
  - **技能 skill**：在光标处插入 `/` 并打开 Skill 选择器。
  - **提及成员 mention**：群聊有成员时出现，插入 `@` 并打开成员选择器。
- 「指令」组：
  - **停止回复 stop**：有 Bot 正在回复时出现，中断当前会话进行中的回复。
  - **导出 Markdown export**、**导出 HTML export-html**（群聊）和 **消息设置 settings**。
- 直接键入 `/`（行首或空白后）也会打开 Skill 选择器；按 ↑/↓、Tab 或 Enter 选中，Esc 关闭。
- Skill 列表来自 Bot 的工作区（`group.workspaceCwd` / 单聊目录），只列出 `userInvocable` 的 Skill；`modelInvocable: false` 的条目显示「仅手动」。

### 2. 文件上传与持久化

- 新路由：`POST /api/bot-team.upload?name=<文件名>&groupId=<群 ID>`，请求体为原始字节。
- Host 通过 `ctx.attachments.saveFile({ data, name })` 把文件存入 DSH 附件库（`$DSH_HOME/attachments/v1`），返回 `{ attachmentId, name, bytes }`。
- `message.post` 新增 `attachments` 字段；Host 重新校验 `sha256:<hex>` 引用，派生只读路径并随消息持久化。
- Bot prompt 的 `<new-messages>` 中追加：
  ```text
  附件（已保存为只读文件，可用文件工具按路径读取）：
  - brief.pdf（1.5 KB）：/Users/…/attachments/v1/files/…/brief.pdf
  ```
- 消息气泡显示文件名、大小与「只读附件」；Markdown/HTML 导出也包含附件名。

### 3. Skill 注入

- Bot 预设 `bot-team-tools` 新增：
  - `@deepseek-ai/dsh-skill-filesystem`（发现工作区中的 `SKILL.md`）
  - `@deepseek-ai/dsh-tool-skill`（模型 catalog、`skill` 工具与 `/name` 用户 gesture）
- `dsh-skill` 注册表本身仍由 base 宿主挂载；预设层负责本地发现与模型侧加载。
- Bot prompt 把用户消息渲染为 `[#seq] 用户： /skill-name …`（冒号后保留空格），满足 `dsh-tool-skill` 的 `(^|\s)/name` 空白边界；发送时保留字面 `/skill-name`，由 Host 在 pre-step 注入完整 `<skill_content>`。
- 新路由：`GET /api/bot-team.skills?groupId=…&memberId=…`。Host 选择一个成员，`pool.ensure` 准备其 Agent，然后以该 Agent 为 scope 调用 `ctx.skills.list({ cwd, scope: agent })`；无成员时返回 `{ skills: [], reason: "no-member" }`。

## 限制

- 附件是**通用文件**，不是图片输入：图片/二进制会按文件保存并给出路径，Bot 用文件工具读取，不会作为视觉内容直接送给模型。
- 附件不会随消息删除；DSH 附件库本身也不自动回收。
- 单文件上限 32 MB、每条消息最多 10 个，均由客户端与服务端双重约束。
- `GET /api/bot-team.skills` 首次调用会为该群准备一个 Bot 会话（可能创建/恢复 DSH session），因此第一次打开选择器可能稍慢。
- Skill 列表缓存于当前会话：切换群、修改群工作目录或成员数量变化时会自动失效并重新读取。

## 验证

```sh
cd bot-team
npm run check
npm test
```

新增测试：

- `test/composer-file-skill.test.js`：`/` 触发串、模糊排序、大小格式化、+ 菜单与附件卡片。
- `test/file-skill-host.test.js`：Bot 预设包含 `skill-filesystem` / `tool-skill`、上传 → 附件库引用、`message.post` 持久化/去重/非法引用过滤、Skill agent scope 与 `userInvocable` 过滤。
- `test/attachment-prompt.test.js`：prompt 只读路径、附件-only 消息、`/skill` 空白边界。

本次新增 9 条测试；全套 125 条测试通过。**未做真实浏览器手测**：需要重新加载 Host 后，在 GUI 中点 + 选文件/ Skill，并发送一条带 `/office` 的消息确认 Bot 收到 Skill 指令。
