/**
 * Bot Team Client half (plain JS, loaded through window.__ModuleLoader__).
 *
 * Registers a sidebar entry and one full page in the keyed `main` slot
 * (the same mechanism the shipped Plugin Manager page uses). The page talks to
 * the Host through the authenticated exact Fetch routes under /api/bot-team.*:
 *   GET  bootstrap / messages / events(SSE) / file
 *   POST action
 *
 * M1 scope: group list + create/edit/delete, global bot library (create/edit,
 * persona file editors), add/remove group members, timeline with streaming bot
 * replies, @mention picker, stop, and live member status.
 */
window.__ModuleLoader__.load({
  id: 'dsh-bot-team',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PAGE_KEY = 'bot-team';
    const EMPTY_MESSAGES = [];
    const ROUTES = {
      bootstrap: '/api/bot-team.bootstrap',
      messages: '/api/bot-team.messages',
      events: '/api/bot-team.events',
      action: '/api/bot-team.action',
      file: '/api/bot-team.file',
    };
    const TASK_PRIORITY_LABEL = { urgent: '紧急', high: '高', normal: '普通', low: '低' };
    const ACCOUNT_CLIENT_VERSION = '0.2.1-rc.3';
    // The right-click menu's box is sized in JS so placement can clamp it to the viewport.
    const MESSAGE_MENU_WIDTH = 200;
    const TASK_PRIORITY_COLOR = {
      urgent: ['#fef2f2', '#b91c1c'],
      high: ['#fff7ed', '#c2410c'],
      normal: ['#f3f4f6', '#4b5563'],
      low: ['#f8fafc', '#64748b'],
    };
    const TASK_STATUS_LABEL = {
      pending: '待派发',
      in_progress: '进行中',
      delivered: '已交付',
      changes_requested: '需修改',
      accepted: '已验收',
      cancelled: '已取消',
    };
    const APPROVAL_STATE_LABEL = {
      pending: '等待审批',
      'allowed-once': '已允许一次',
      rejected: '已拒绝',
      cancelled: '已取消',
      unavailable: '审批不可用',
    };
    const APPROVAL_STATE_COLOR = {
      pending: ['#fffbeb', '#b45309'],
      'allowed-once': ['#ecfdf5', '#047857'],
      rejected: ['#fef2f2', '#b91c1c'],
      cancelled: ['#f3f4f6', '#64748b'],
      unavailable: ['#f8fafc', '#64748b'],
    };
    /**
     * 人格模板库：每项都是一份可直接写入 BOT.md 的完整 Markdown。
     * 「## 人格」回答“你是谁”，「## 工作规范」回答“你怎么做事”；
     * 新增模板只需往数组里加一项，选择菜单会自动出现。
     */
    const PERSONA_TEMPLATES = [
      {
        id: 'general',
        title: '通用助手',
        tag: '推荐',
        summary: '先结论后理由；信息不足先说明假设。',
        body: `## 人格
你是一位可靠的全能助手，说话直接、具体，重视事实与可执行性。

## 工作规范
- 先给结论，再给理由。
- 信息不足时先说明假设，必要时只问一个最关键的问题。
- 输出使用 Markdown，简洁、可执行。`,
      },
      {
        id: 'engineer',
        title: '代码实现工程师',
        summary: '小步改动、先读代码；给出完整代码与自测结果。',
        body: `## 人格
你是一位务实的软件工程师，说话简洁，重视正确性与可维护性，不炫技。

## 工作规范
- 先读懂现有代码与约定，再动手；改动尽量小、聚焦。
- 先说明要改哪些文件、为什么，再给出完整可运行的代码。
- 遵循项目既有风格，不引入不必要的新依赖。
- 完成后自测：边界、错误路径、类型/编译/测试是否通过。
- 汇报只写结论、改动点、验证结果与已知风险。`,
      },
      {
        id: 'reviewer',
        title: '代码评审员',
        summary: '按阻塞/风险/建议分级，每条给出最小修复方式。',
        body: `## 人格
你是一位严格但克制的评审员，说话就事论事，重视风险与可维护性。

## 工作规范
- 先给结论（通过 / 需修改 / 有阻塞），再按严重级别列问题：阻塞 > 风险 > 建议。
- 每条问题写清：位置、原因、影响、最小修复方式。
- 只评正确性、安全性、性能、可维护性，不纠结个人风格。
- 不确定的地方标注「待确认」，不臆测作者意图。
- 输出使用 Markdown，控制篇幅，先重后轻。`,
      },
      {
        id: 'pm',
        title: '需求分析师',
        summary: '目标、范围、验收标准；一次最多问 3 个关键问题。',
        body: `## 人格
你是一位严谨的需求分析师，说话清晰，重视边界与验收标准。

## 工作规范
- 先把目标、使用者、范围、明确不做什么写清楚。
- 用「用户故事 + 验收标准（Given/When/Then）」表达需求。
- 主动列出歧义与缺失信息，一次最多问 3 个关键问题。
- 区分「必须做」与「可以以后做」，给出最小可行范围。
- 输出使用 Markdown，避免空泛形容词。`,
      },
      {
        id: 'researcher',
        title: '技术调研员',
        summary: '结论先行；关键事实带来源，区分已验证与推测。',
        body: `## 人格
你是一位审慎的技术调研员，说话有依据，重视来源与可比性。

## 工作规范
- 先给结论与推荐选项，再给对比过程。
- 关键事实必须给出来源链接；找不到来源时明确标注为推测。
- 对比至少覆盖：能力、成熟度、成本、维护性、风险。
- 区分「已验证」与「未验证」，不把博客观点当事实。
- 信息可能过时时说明检索时间。`,
      },
      {
        id: 'qa',
        title: '测试工程师',
        summary: '覆盖正常/边界/异常；缺陷附最小复现步骤。',
        body: `## 人格
你是一位细致的测试工程师，说话精确，重视复现与边界。

## 工作规范
- 先列出测试范围与不测范围。
- 用例覆盖：正常路径、边界值、异常/失败路径、并发与权限。
- 每条用例写清：前置条件、步骤、期望结果。
- 发现缺陷时给出最小复现步骤、实际结果、期望结果、严重级别。
- 结论明确：可发布 / 带风险发布 / 不可发布。`,
      },
      {
        id: 'writer',
        title: '文档写作者',
        summary: '按读者组织结构；示例可直接运行。',
        body: `## 人格
你是一位技术写作者，说话准确克制，重视读者能否一次看懂。

## 工作规范
- 先确认读者与目标（上手 / 排错 / 决策），再组织结构。
- 结构：一句话结论 → 步骤或示例 → 注意事项。
- 示例必须可直接运行；命令与代码用代码块并标注语言。
- 术语首次出现给一句解释，避免内部黑话。
- 删掉重复与空话；宁可短，不要含糊。`,
      },
      {
        id: 'critic',
        title: '批判质疑者',
        summary: '先假设方案失败，逐条给出验证与补救。',
        body: `## 人格
你是一位不留情面的反方，说话直接，重视论证漏洞与隐藏成本。

## 工作规范
- 先假设方案会失败，列出最可能失败的方式与触发条件。
- 逐条质疑：前提是否成立、数据是否支持、成本是否被低估、最坏情况是什么。
- 每条质疑给出「若成立，如何验证 / 如何补救」。
- 明确指出哪些质疑是阻塞性的，哪些只是提醒。
- 最后给出一个仍然值得尝试的理由，避免为反对而反对。`,
      },
      {
        id: 'analyst',
        title: '数据分析师',
        summary: '先定口径；区分相关与因果，说明不确定性。',
        body: `## 人格
你是一位严谨的数据分析师，说话基于数据，重视口径与不确定性。

## 工作规范
- 先定义指标口径、时间范围与数据来源，再开始分析。
- 区分描述性结论与因果结论，不夸大相关性。
- 关键数字给出计算方式或查询语句，便于复核。
- 数据缺失、异常值、样本偏差要主动说明。
- 结论分「数据支持 / 数据不足 / 与直觉相反」三类表达。`,
      },
    ];
    const PERSONA_TEMPLATE = PERSONA_TEMPLATES[0].body;

    /** Plugin context captured in apply(), used by helpers outside the page component. */
    let appCtx = null;

    // ── API ───────────────────────────────────────────────────────────────
    async function request(url, options) {
      let response;
      try {
        response = await fetch(url, options);
      } catch (error) {
        throw new Error(`无法连接 Host：${String(error && error.message ? error.message : error)}`);
      }
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!body || body.ok === false) {
        const message = body && body.error && body.error.message ? body.error.message : `请求失败 (HTTP ${response.status})`;
        throw new Error(message);
      }
      return body;
    }

    const api = {
      bootstrap: () => request(ROUTES.bootstrap, { method: 'GET' }),
      messages: (groupId, beforeSeq) =>
        request(
          `${ROUTES.messages}?groupId=${encodeURIComponent(groupId)}&limit=120${
            Number.isFinite(beforeSeq) ? `&beforeSeq=${beforeSeq}` : ''
          }`,
          { method: 'GET' },
        ),
      action: (action, payload) =>
        request(ROUTES.action, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, payload }),
        }),
      fileGet: (botId, kind) =>
        request(`${ROUTES.file}?botId=${encodeURIComponent(botId)}&kind=${kind}`, { method: 'GET' }),
      filePut: (botId, kind, text) =>
        request(ROUTES.file, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ botId, kind, text }),
        }),
    };

    /** Fire-and-forget UI verification report (ends up in the Host smoke log). */
    function uiReport(payload) {
      try {
        void api.action('ui.report', payload).catch(() => {});
      } catch {
        /* best effort */
      }
    }

    /** Open a bot member's own DSH session in the main conversation view. */
    function openBotSession(sessionId, onError) {
      try {
        const workspace = appCtx && appCtx.uiWorkspace;
        if (!workspace || typeof workspace.openSession !== 'function') {
          throw new Error('会话视图服务不可用');
        }
        workspace.openSession(sessionId);
      } catch (error) {
        if (onError) onError(String(error && error.message ? error.message : error));
      }
    }

    /** Read the signed-in DSH account profile (name + avatar URL), if available. */
    async function fetchAccountProfile() {
      try {
        const remote = appCtx && appCtx.remote;
        const account = remote && remote.account;
        if (!account || typeof account.getProfile !== 'function') return null;
        const locale = typeof navigator !== 'undefined' && /^zh/i.test(String(navigator.language || '')) ? 'zh_CN' : 'en_US';
        const result = await account.getProfile({
          version: ACCOUNT_CLIENT_VERSION,
          locale,
          timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
        });
        if (result && result.ok && result.value && result.value.status === 'ready' && result.value.value) {
          return result.value.value;
        }
      } catch {
        /* account may be signed out or unavailable */
      }
      return null;
    }

    /** Decode, center-crop and compress a user-picked avatar into a 256px data URL. */
    async function createAvatarDataUrl(file) {
      if (!file) throw new Error('未选择图片');
      if (!String(file.type || '').startsWith('image/')) throw new Error('请选择图片文件');
      if (file.size > 8 * 1024 * 1024) throw new Error('头像图片不能超过 8MB');
      const source =
        typeof createImageBitmap === 'function'
          ? await createImageBitmap(file)
          : await new Promise((resolve, reject) => {
              const image = new Image();
              const url = URL.createObjectURL(file);
              image.onload = () => {
                URL.revokeObjectURL(url);
                resolve(image);
              };
              image.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('图片解码失败'));
              };
              image.src = url;
            });
      const size = 256;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('浏览器不支持图片处理');
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      const scale = Math.max(size / source.width, size / source.height);
      const width = source.width * scale;
      const height = source.height * scale;
      context.drawImage(source, (size - width) / 2, (size - height) / 2, width, height);
      if (typeof source.close === 'function') source.close();
      const dataUrl = canvas.toDataURL('image/webp', 0.86);
      if (!dataUrl.startsWith('data:image/')) throw new Error('图片编码失败');
      if (dataUrl.length > 700000) throw new Error('图片压缩后仍然过大，请换一张');
      return dataUrl;
    }

    /** Page through a group's full timeline (bounded), for Markdown export. */
    async function collectAllMessages(groupId) {
      let collected = [];
      let before;
      const seen = new Set();
      for (let page = 0; page < 50; page += 1) {
        const result = await api.messages(groupId, before);
        const messages = result.messages || [];
        for (const message of messages) {
          if (seen.has(message.messageId)) continue;
          seen.add(message.messageId);
          collected.push(message);
        }
        if (!result.hasMore || messages.length === 0) break;
        before = messages[0].seq;
      }
      collected.sort((a, b) => a.seq - b.seq);
      return collected;
    }

    function authorNameOf(message, bots) {
      if (!message || !message.author) return '未知';
      if (message.author.type === 'human') return message.author.name || '用户';
      if (message.author.type === 'system') return '系统';
      const bot = message.author.botId ? bots.find((candidate) => candidate.botId === message.author.botId) : null;
      return bot ? bot.name : message.author.name || 'Bot';
    }

    function buildGroupMarkdown({ group, members, bots, messages }) {
      const lines = [];
      lines.push(`# ${group.title}`);
      if (group.topic) lines.push(`> ${group.topic}`);
      lines.push('');
      lines.push(`- 成员：${members.map((member) => {
        const bot = bots.find((candidate) => candidate.botId === member.botId);
        return bot ? `${bot.name}（${bot.provider}/${bot.model}）` : '（已删除）';
      }).join('、')}`);
      lines.push(`- 导出时间：${new Date().toLocaleString()}`);
      lines.push(`- 消息数：${messages.length}`);
      lines.push('');
      lines.push('---');
      lines.push('');
      for (const message of messages) {
        const author = authorNameOf(message, bots);
        const badges = [];
        if (message.meta && message.meta.round) badges.push(`第 ${message.meta.round} 轮`);
        if (message.meta && message.meta.summary) badges.push('讨论总结');
        if (message.meta && message.meta.verdict === 'pass') badges.push('评审通过');
        if (message.meta && message.meta.verdict === 'changes') badges.push('需修改');
        if (message.status && message.status !== 'done') badges.push(message.status);
        lines.push(`## [#${message.seq}] ${author}${badges.length ? ` · ${badges.join(' · ')}` : ''}`);
        lines.push('');
        if (message.kind === 'system' || (message.author && message.author.type === 'system')) {
          lines.push(`> ${String(message.text || '').replace(/\n/g, '\n> ')}`);
        } else {
          lines.push(String(message.text || ''));
        }
        lines.push('');
      }
      return lines.join('\n');
    }

    function escapeHtml(text) {
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function inlineMarkdownToHtml(text) {
      let html = escapeHtml(text);
      html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
      html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>');
      html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
      return html;
    }

    function markdownToHtml(text) {
      const lines = String(text || '').split('\n');
      const out = [];
      let inCode = false;
      let codeLines = [];
      let list = null;
      const flushList = () => {
        if (list) {
          out.push('<ul>' + list.join('') + '</ul>');
          list = null;
        }
      };
      for (const line of lines) {
        if (/^```/.test(line)) {
          if (inCode) {
            out.push('<pre><code>' + escapeHtml(codeLines.join('\n')) + '</code></pre>');
            inCode = false;
            codeLines = [];
          } else {
            flushList();
            inCode = true;
          }
          continue;
        }
        if (inCode) {
          codeLines.push(line);
          continue;
        }
        if (!line.trim()) {
          flushList();
          continue;
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
          flushList();
          const level = Math.min(heading[1].length + 1, 6);
          out.push('<h' + level + '>' + inlineMarkdownToHtml(heading[2]) + '</h' + level + '>');
          continue;
        }
        const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
        if (bullet) {
          list = list || [];
          list.push('<li>' + inlineMarkdownToHtml(bullet[1]) + '</li>');
          continue;
        }
        const quote = /^>\s?(.*)$/.exec(line);
        if (quote) {
          flushList();
          out.push('<blockquote>' + inlineMarkdownToHtml(quote[1]) + '</blockquote>');
          continue;
        }
        if (/^\s*---\s*$/.test(line)) {
          flushList();
          out.push('<hr/>');
          continue;
        }
        flushList();
        out.push('<p>' + inlineMarkdownToHtml(line.trim()) + '</p>');
      }
      flushList();
      if (inCode) out.push('<pre><code>' + escapeHtml(codeLines.join('\n')) + '</code></pre>');
      return out.join('\n');
    }

    function buildGroupHtml({ group, members, bots, messages }) {
      const title = escapeHtml(group.title || 'Bot Team');
      const roster = members
        .map((member) => {
          const bot = bots.find((candidate) => candidate.botId === member.botId);
          return bot
            ? escapeHtml(
                bot.name +
                  '（' +
                  bot.provider +
                  '/' +
                  bot.model +
                  '）',
              )
            : '';
        })
        .filter(Boolean)
        .join('、');
      const rows = messages
        .map((message) => {
          const author = escapeHtml(authorNameOf(message, bots));
          const badges = [];
          if (message.meta && message.meta.round) badges.push('第 ' + message.meta.round + ' 轮');
          if (message.meta && message.meta.summary) badges.push('总结');
          if (message.meta && message.meta.verdict === 'pass') badges.push('评审通过');
          if (message.meta && message.meta.verdict === 'changes') badges.push('需修改');
          const body = markdownToHtml(message.text || '');
          const badgeHtml = badges.length ? ' · ' + badges.join(' · ') : '';
          return (
            '<article class="msg"><header>#' +
            message.seq +
            ' · ' +
            author +
            badgeHtml +
            '</header><div class="body">' +
            body +
            '</div></article>'
          );
        })
        .join('\n');
      return (
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>' +
        title +
        '</title><style>' +
        'body{font-family:-apple-system,system-ui,sans-serif;max-width:860px;margin:32px auto;padding:0 20px;color:#1f2329;line-height:1.6}' +
        'h1{font-size:22px}blockquote{border-left:3px solid #d1d5db;margin:0;padding-left:12px;color:#6b7280}' +
        'pre{background:#f6f8fa;border-radius:8px;padding:10px;overflow:auto}code{font-family:ui-monospace,monospace;font-size:12px}' +
        '.msg{border-bottom:1px solid #eee;padding:10px 0}.msg header{font-size:12px;color:#6b7280;font-weight:600;margin-bottom:4px}' +
        '</style></head><body><h1>' +
        title +
        '</h1>' +
        (group.topic ? '<blockquote>' + escapeHtml(group.topic) + '</blockquote>' : '') +
        '<p>成员：' +
        roster +
        '</p><p>导出时间：' +
        escapeHtml(new Date().toLocaleString()) +
        ' · 消息数：' +
        messages.length +
        '</p><hr/>' +
        rows +
        '</body></html>'
      );
    }

    function downloadText(filename, text, mime) {
      const blob = new Blob([text], { type: mime || 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    // Kept in sync with host/chat-settings.js; the Host persists these per profile.
    const CHAT_DISPLAY_MODES = [
      { value: 'hover', label: '悬停显示' },
      { value: 'always', label: '常驻显示' },
      { value: 'hidden', label: '隐藏' },
    ];
    const CHAT_DISPLAY_FIELDS = [
      { key: 'model', label: '模型名称', hint: '回复使用的模型' },
      { key: 'inputTokens', label: '输入 Token', hint: '最近一次上报的输入用量（非累计）' },
      { key: 'outputTokens', label: '输出 Token', hint: '最近一次上报的输出用量（非累计）' },
      { key: 'speed', label: '平均回复速度', hint: '最近一次模型请求的输出 Token / 秒' },
    ];
    const DEFAULT_CHAT_DISPLAY_SETTINGS = Object.freeze({
      model: 'hover', inputTokens: 'hover', outputTokens: 'hover', speed: 'hover',
    });

    function normalizeChatDisplaySettings(value) {
      const settings = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      return Object.fromEntries(CHAT_DISPLAY_FIELDS.map(({ key }) => [
        key,
        Object.prototype.hasOwnProperty.call(settings, key) && CHAT_DISPLAY_MODES.some(mode => mode.value === settings[key])
          ? settings[key] : DEFAULT_CHAT_DISPLAY_SETTINGS[key],
      ]));
    }

    // Sidebar collapse is a per-browser preference; the Host never needs it.
    const SIDEBAR_COLLAPSED_KEY = 'bot-team.sidebar.collapsed';

    function readSidebarCollapsed() {
      try {
        const storage = typeof window !== 'undefined' ? window.localStorage : null;
        return !!storage && storage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
      } catch {
        return false;
      }
    }

    function persistSidebarCollapsed(collapsed) {
      try {
        const storage = typeof window !== 'undefined' ? window.localStorage : null;
        if (storage) storage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
      } catch {
        /* storage can be unavailable (private mode / disabled); collapse still works this session */
      }
    }

    // The right-hand status panel (members / tasks / single-chat info) can be
    // collapsed too. Same per-browser rationale as the left rail.
    const RIGHT_PANEL_COLLAPSED_KEY = 'bot-team.right-panel.collapsed';

    function readRightPanelCollapsed() {
      try {
        const storage = typeof window !== 'undefined' ? window.localStorage : null;
        return !!storage && storage.getItem(RIGHT_PANEL_COLLAPSED_KEY) === '1';
      } catch {
        return false;
      }
    }

    function persistRightPanelCollapsed(collapsed) {
      try {
        const storage = typeof window !== 'undefined' ? window.localStorage : null;
        if (storage) storage.setItem(RIGHT_PANEL_COLLAPSED_KEY, collapsed ? '1' : '0');
      } catch {
        /* storage can be unavailable; collapse still works this session */
      }
    }

    // ── sidebar sections / folders / direct chats ─────────────────────────
    // Expanded/collapsed section state is also a per-browser preference (same
    // rationale as the rail): the Host stores conversations, not chrome.
    const SECTIONS_COLLAPSED_KEY = 'bot-team.sidebar.sections';
    const SECTION_DIRECT = 'direct';
    const SECTION_GROUPS = 'groups';
    const SECTION_UNGROUPED = 'ungrouped';
    const sectionFolderKey = (folderId) => `folder:${folderId}`;

    function readSectionsCollapsed() {
      try {
        const storage = typeof window !== 'undefined' ? window.localStorage : null;
        const raw = storage ? storage.getItem(SECTIONS_COLLAPSED_KEY) : null;
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        return Object.fromEntries(
          Object.entries(parsed).filter(([, value]) => typeof value === 'boolean' && value === true),
        );
      } catch {
        return {};
      }
    }

    function persistSectionsCollapsed(sections) {
      try {
        const storage = typeof window !== 'undefined' ? window.localStorage : null;
        if (storage) storage.setItem(SECTIONS_COLLAPSED_KEY, JSON.stringify(sections || {}));
      } catch {
        /* collapse still works for this session when storage is unavailable */
      }
    }

    const isDirectGroup = (group) => !!group && group.kind === 'direct';
    const groupKindOf = (group) => (isDirectGroup(group) ? 'direct' : 'group');
    const groupFolderIdOf = (group) => (isDirectGroup(group) ? null : group && group.folderId ? group.folderId : null);

    function orderOfGroup(group, fallback = Number.MAX_SAFE_INTEGER) {
      return group && Number.isFinite(group.order) ? group.order : fallback;
    }

    function compareByOrder(a, b) {
      return orderOfGroup(a, 0) - orderOfGroup(b, 0) || (a.createdAt || 0) - (b.createdAt || 0);
    }

    function sameIdOrder(a, b) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      return a.every((id, index) => id === b[index]);
    }

    /**
     * One source of truth for the sidebar: direct chats (one per bot, above
     * everything), custom folders with their group chats, then ungrouped groups.
     * Unknown/deleted folder ids fall back to 未分组 instead of hiding a group.
     */
    function buildSidebarModel(state) {
      const bots = Array.isArray(state.bots) ? state.bots : [];
      const groups = Array.isArray(state.groups) ? state.groups : [];
      const folders = Array.isArray(state.folders) ? state.folders : [];
      const directByBot = new Map();
      for (const group of groups) {
        if (isDirectGroup(group) && group.botId) directByBot.set(group.botId, group);
      }
      const direct = bots
        .map((bot) => ({ bot, group: directByBot.get(bot.botId) || null }))
        .sort((a, b) => {
          const orderA = a.group ? orderOfGroup(a.group, 1e9) : 1e9;
          const orderB = b.group ? orderOfGroup(b.group, 1e9) : 1e9;
          return orderA - orderB || (a.bot.createdAt || 0) - (b.bot.createdAt || 0);
        });
      const groupChats = groups.filter((group) => !isDirectGroup(group));
      const folderList = [...folders].sort(compareByOrder);
      const folderIds = new Set(folderList.map((folder) => folder.folderId));
      const grouped = new Map(folderList.map((folder) => [folder.folderId, []]));
      const ungrouped = [];
      for (const group of groupChats) {
        const folderId = groupFolderIdOf(group);
        if (folderId && folderIds.has(folderId)) grouped.get(folderId).push(group);
        else ungrouped.push(group);
      }
      for (const list of grouped.values()) list.sort(compareByOrder);
      ungrouped.sort(compareByOrder);
      return {
        direct,
        folders: folderList.map((folder) => ({ folder, groups: grouped.get(folder.folderId) })),
        ungrouped,
        groupCount: groupChats.length,
      };
    }

    /** Locate a sidebar group and the scope it belongs to. */
    function findSidebarGroup(model, groupId) {
      for (const entry of model.direct) {
        if (entry.group && entry.group.groupId === groupId) {
          return { kind: 'direct', folderId: null, group: entry.group };
        }
      }
      for (const folderEntry of model.folders) {
        const group = folderEntry.groups.find((candidate) => candidate.groupId === groupId);
        if (group) return { kind: 'group', folderId: folderEntry.folder.folderId, group };
      }
      const ungrouped = model.ungrouped.find((candidate) => candidate.groupId === groupId);
      if (ungrouped) return { kind: 'group', folderId: null, group: ungrouped };
      return null;
    }

    /** Ordered group ids of one scope (direct chat section, folder, or 未分组). */
    function scopeGroupIds(model, kind, folderId) {
      if (kind === 'direct') return model.direct.map((entry) => entry.group && entry.group.groupId).filter(Boolean);
      if (!folderId) return model.ungrouped.map((group) => group.groupId);
      const folderEntry = model.folders.find((entry) => entry.folder.folderId === folderId);
      return folderEntry ? folderEntry.groups.map((group) => group.groupId) : [];
    }

    /**
     * Compute the group.reorder payload for one drop. `target` is
     * `{ groupId }` (before/after a row), `{ folderId }` (append into a folder),
     * or `{ ungrouped: true }`. Returns null for a no-op or an illegal move
     * (single chat ↔ group chat).
     */
    function computeGroupDrop(model, dragGroupId, target, edge) {
      const dragged = findSidebarGroup(model, dragGroupId);
      if (!dragged) return null;
      let kind;
      let folderId;
      let orderedIds;
      if (target && target.groupId) {
        const destination = findSidebarGroup(model, target.groupId);
        if (!destination || destination.kind !== dragged.kind) return null;
        kind = destination.kind;
        folderId = destination.folderId;
        const list = scopeGroupIds(model, kind, folderId).filter((id) => id !== dragGroupId);
        const index = list.indexOf(target.groupId);
        if (index < 0) return null;
        list.splice(edge === 'after' ? index + 1 : index, 0, dragGroupId);
        orderedIds = list;
      } else {
        if (dragged.kind !== 'group') return null;
        kind = 'group';
        folderId = target && target.ungrouped ? null : target && target.folderId ? target.folderId : null;
        const list = scopeGroupIds(model, kind, folderId).filter((id) => id !== dragGroupId);
        list.push(dragGroupId);
        orderedIds = list;
      }
      const current = scopeGroupIds(model, kind, folderId);
      if (sameIdOrder(current, orderedIds)) {
        if (kind !== dragged.kind || folderId !== dragged.folderId) {
          return { kind, folderId, movedGroupId: dragGroupId, orderedIds };
        }
        return null;
      }
      return { kind, folderId, movedGroupId: dragGroupId, orderedIds };
    }

    /** Folder reorder drop payload (folders are a flat, ordered list). */
    function computeFolderDrop(model, dragFolderId, targetFolderId, edge) {
      const ids = model.folders.map((entry) => entry.folder.folderId);
      if (dragFolderId === targetFolderId) return null;
      const remaining = ids.filter((id) => id !== dragFolderId);
      const index = remaining.indexOf(targetFolderId);
      if (index < 0 || !ids.includes(dragFolderId)) return null;
      remaining.splice(edge === 'after' ? index + 1 : index, 0, dragFolderId);
      if (sameIdOrder(ids, remaining)) return null;
      return { orderedIds: remaining };
    }

    /** Keyboard/menu alternative to dragging: move one step inside its scope. */
    function stepGroupOrder(model, groupId, direction) {
      const scope = findSidebarGroup(model, groupId);
      if (!scope) return null;
      const ids = scopeGroupIds(model, scope.kind, scope.folderId);
      const index = ids.indexOf(groupId);
      const next = index + (direction === 'up' ? -1 : 1);
      if (index < 0 || next < 0 || next >= ids.length) return null;
      const orderedIds = ids.slice();
      orderedIds.splice(index, 1);
      orderedIds.splice(next, 0, groupId);
      return { kind: scope.kind, folderId: scope.folderId, movedGroupId: groupId, orderedIds };
    }

    function stepFolderOrder(model, folderId, direction) {
      const ids = model.folders.map((entry) => entry.folder.folderId);
      const index = ids.indexOf(folderId);
      const next = index + (direction === 'up' ? -1 : 1);
      if (index < 0 || next < 0 || next >= ids.length) return null;
      const orderedIds = ids.slice();
      orderedIds.splice(index, 1);
      orderedIds.splice(next, 0, folderId);
      return { orderedIds };
    }

    // ── state ─────────────────────────────────────────────────────────────
    const initialState = {
      loading: true,
      error: '',
      flash: '',
      bots: [],
      groups: [],
      folders: [],
      members: [],
      modelCatalog: { groups: [], default: null },
      pluginInfo: null,
      config: {},
      chatDisplaySettings: DEFAULT_CHAT_DISPLAY_SETTINGS,
      sidebarCollapsed: readSidebarCollapsed(),
      rightPanelCollapsed: readRightPanelCollapsed(),
      sectionsCollapsed: readSectionsCollapsed(),
      pendingDirectBotId: null,
      activeGroupId: null,
      messagesByGroup: {},
      statusByMember: {},
      dialog: null,
      smoke: null,
      refreshTick: 0,
      messagesTick: 0,
      discussions: {},
      hasMoreByGroup: {},
    };

    function upsertMessage(list, message) {
      const index = list.findIndex((candidate) => candidate.messageId === message.messageId);
      const next = index >= 0 ? list.slice() : list.concat([message]);
      if (index >= 0) next[index] = message;
      next.sort((a, b) => a.seq - b.seq);
      return next;
    }

    function patchMessage(list, messageId, patch) {
      const index = list.findIndex((candidate) => candidate.messageId === messageId);
      if (index < 0) return list;
      const next = list.slice();
      next[index] = { ...next[index], ...patch };
      return next;
    }

    function reducer(state, action) {
      switch (action.type) {
        case 'bootstrap': {
          const data = action.data;
          const groups = data.groups || [];
          const bots = data.bots || [];
          // Creating a bot should land directly in its single chat. The request
          // is kept in state until the refreshed bootstrap contains the direct
          // group (network ordering is not guaranteed).
          const pendingBotId = state.pendingDirectBotId;
          const pendingGroup = pendingBotId
            ? groups.find((group) => isDirectGroup(group) && group.botId === pendingBotId)
            : null;
          const activeGroupId = pendingGroup
            ? pendingGroup.groupId
            : groups.some((group) => group.groupId === state.activeGroupId)
              ? state.activeGroupId
              : groups[0]?.groupId ?? null;
          return {
            ...state,
            loading: false,
            error: '',
            bots,
            groups,
            folders: data.folders || [],
            members: data.members || [],
            modelCatalog: data.modelCatalog || { groups: [], default: null },
            pluginInfo: data.plugin || null,
            config: data.config || {},
            chatDisplaySettings: normalizeChatDisplaySettings(data.chatDisplaySettings),
            smoke: data.smoke || null,
            activeGroupId,
            pendingDirectBotId:
              pendingBotId && !pendingGroup && !bots.some((bot) => bot.botId === pendingBotId)
                ? pendingBotId
                : null,
            statusByMember: Object.fromEntries(
              (data.members || [])
                .filter((member) => member.running)
                .map((member) => [member.membershipId, 'running']),
            ),
            discussions: Object.fromEntries(
              groups
                .filter((group) => group.activeDiscussion || group.latestDiscussion)
                .map((group) => [group.groupId, group.activeDiscussion || group.latestDiscussion]),
            ),
          };
        }
        case 'selectGroup':
          // A manual choice wins over a pending "open the new bot's DM" request.
          return { ...state, activeGroupId: action.groupId, dialog: null, pendingDirectBotId: null };
        case 'pendingDirect':
          return { ...state, pendingDirectBotId: action.botId || null };
        case 'sectionCollapsed': {
          const sections = { ...state.sectionsCollapsed };
          if (action.collapsed === true) sections[action.key] = true;
          else delete sections[action.key];
          return { ...state, sectionsCollapsed: sections };
        }
        case 'applyGroupOrder': {
          const indexById = new Map((action.orderedIds || []).map((id, index) => [id, index]));
          const folderId = action.kind === 'direct' ? null : action.folderId || null;
          return {
            ...state,
            groups: state.groups.map((group) => {
              const index = indexById.get(group.groupId);
              const moved = action.movedGroupId === group.groupId;
              if (index === undefined && !moved) return group;
              const next = { ...group };
              if (moved) next.folderId = folderId;
              if (index !== undefined) next.order = index;
              return next;
            }),
          };
        }
        case 'applyFolderOrder': {
          const indexById = new Map((action.orderedIds || []).map((id, index) => [id, index]));
          return {
            ...state,
            folders: state.folders.map((folder) =>
              indexById.has(folder.folderId) ? { ...folder, order: indexById.get(folder.folderId) } : folder,
            ),
          };
        }
        case 'messages':
          return {
            ...state,
            messagesByGroup: { ...state.messagesByGroup, [action.groupId]: action.messages || [] },
            hasMoreByGroup: { ...state.hasMoreByGroup, [action.groupId]: action.hasMore === true },
          };
        case 'prependMessages': {
          const current = state.messagesByGroup[action.groupId] || [];
          const seen = new Set(current.map((message) => message.messageId));
          const merged = [...(action.messages || []).filter((message) => !seen.has(message.messageId)), ...current];
          return {
            ...state,
            messagesByGroup: { ...state.messagesByGroup, [action.groupId]: merged },
            hasMoreByGroup: { ...state.hasMoreByGroup, [action.groupId]: action.hasMore === true },
          };
        }
        case 'discussion': {
          const discussion = action.discussion;
          if (!discussion) return state;
          return {
            ...state,
            discussions: { ...state.discussions, [discussion.groupId]: discussion },
            groups: state.groups.map((group) =>
              group.groupId === discussion.groupId
                ? {
                    ...group,
                    activeDiscussion: discussion.status === 'running' ? discussion : null,
                    latestDiscussion: discussion,
                  }
                : group,
            ),
          };
        }
        case 'chatDisplaySettings':
          return { ...state, chatDisplaySettings: normalizeChatDisplaySettings(action.settings) };
        case 'sse': {
          const frame = action.frame;
          if ((frame.type === 'settings.updated' || frame.type === 'hello') && frame.chatDisplaySettings) {
            return reducer(state, { type: 'chatDisplaySettings', settings: frame.chatDisplaySettings });
          }
          const active = state.activeGroupId;
          if (frame.type === 'message.added' || frame.type === 'message.updated') {
            if (frame.message.groupId !== active) return state;
            return {
              ...state,
              messagesByGroup: {
                ...state.messagesByGroup,
                [active]: upsertMessage(state.messagesByGroup[active] || [], frame.message),
              },
            };
          }
          if (frame.type === 'message.delta' || frame.type === 'message.replace') {
            if (!active) return state;
            const list = state.messagesByGroup[active] || [];
            const target = list.find((message) => message.messageId === frame.messageId);
            if (!target) return state;
            const text = frame.type === 'message.delta' ? `${target.text || ''}${frame.chunk || ''}` : frame.text || '';
            return {
              ...state,
              messagesByGroup: {
                ...state.messagesByGroup,
                [active]: patchMessage(list, frame.messageId, {
                  text,
                  status: target.status === 'pending' ? 'streaming' : target.status,
                }),
              },
            };
          }
          if (frame.type === 'member.status') {
            return {
              ...state,
              statusByMember: {
                ...state.statusByMember,
                [frame.membershipId]: frame.status,
              },
            };
          }
          if (frame.type === 'member.added' || frame.type === 'member.removed' || frame.type === 'member.updated') {
            return { ...state, refreshTick: state.refreshTick + 1 };
          }
          if (frame.type === 'task.updated') {
            const task = frame.task;
            if (!task) return state;
            return {
              ...state,
              groups: state.groups.map((group) => {
                if (group.groupId !== task.groupId) return group;
                const current = Array.isArray(group.tasks) ? group.tasks : [];
                const exists = current.some((candidate) => candidate.taskId === task.taskId);
                const tasks = exists
                  ? current.map((candidate) => (candidate.taskId === task.taskId ? task : candidate))
                  : current.concat([task]);
                tasks.sort((a, b) => a.createdAt - b.createdAt);
                return { ...group, tasks };
              }),
            };
          }
          if (frame.type === 'discussion.updated') {
            return reducer(state, { type: 'discussion', discussion: frame.discussion });
          }
          if (frame.type === 'group.updated') {
            return {
              ...state,
              groups: state.groups.map((group) =>
                group.groupId === frame.group.groupId ? { ...group, ...frame.group } : group,
              ),
            };
          }
          return state;
        }
        case 'error':
          return { ...state, error: action.message };
        case 'flash':
          return { ...state, flash: action.message };
        case 'dialog':
          return { ...state, dialog: action.dialog };
        case 'toggleSidebar':
          return { ...state, sidebarCollapsed: state.sidebarCollapsed !== true };
        case 'toggleRightPanel':
          return { ...state, rightPanelCollapsed: state.rightPanelCollapsed !== true };
        case 'refreshTick':
          return { ...state, refreshTick: state.refreshTick + 1 };
        case 'messagesTick':
          return { ...state, messagesTick: state.messagesTick + 1 };
        default:
          return state;
      }
    }

    // ── styles ────────────────────────────────────────────────────────────
    const S = {
      root: {
        display: 'flex',
        height: '100%',
        minHeight: 0,
        fontFamily: 'var(--dsh-font-ui, system-ui, -apple-system, "Segoe UI", sans-serif)',
        color: 'var(--dsw-alias-label-primary, #1f2329)',
        background: 'var(--dsw-alias-bg-base, #ffffff)',
      },
      left: {
        width: 240,
        minWidth: 200,
        borderRight: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08))',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: 'var(--dsw-alias-bg-layer-1, #fafafa)',
      },
      leftHeader: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '14px 14px 8px',
        fontWeight: 600,
        fontSize: 14,
      },
      groupList: { overflow: 'auto', flex: 1, padding: '0 8px 12px' },
      groupItem: (active) => ({
        padding: active ? '9px 10px 9px 8px' : '9px 10px',
        borderRadius: 8,
        marginBottom: 4,
        cursor: 'pointer',
        background: active ? 'var(--dsw-alias-bg-layer-3, #e9edf5)' : 'transparent',
        border: '1px solid transparent',
        boxShadow: active ? 'inset 0 0 0 1px rgba(47,126,216,0.16)' : 'none',
        transition: 'background 120ms ease, border-color 120ms ease',
      }),
      groupTitleRow: { display: 'flex', alignItems: 'center', gap: 6 },
      groupTitle: { fontWeight: 600, fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      groupPreview: {
        fontSize: 11,
        color: 'var(--dsw-alias-label-tertiary, #8a8f98)',
        marginTop: 3,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      center: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 },
      chatHeader: {
        padding: '12px 18px',
        borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08))',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      },
      chatTitle: { fontWeight: 600, fontSize: 15 },
      chatTopic: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #8a8f98)', marginTop: 2 },
      timeline: { flex: 1, overflow: 'auto', padding: '16px 18px 8px', minHeight: 0 },
      right: {
        width: 260,
        minWidth: 220,
        borderLeft: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08))',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: 'var(--dsw-alias-bg-layer-1, #fafafa)',
      },
      rightHeader: {
        padding: '14px 14px 8px',
        fontWeight: 600,
        fontSize: 14,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      },
      memberList: { overflow: 'auto', flex: 1, padding: '0 10px 12px' },
      memberCard: {
        padding: '9px 10px',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-2, #ffffff)',
        border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08))',
        marginBottom: 8,
      },
      memberTop: { display: 'flex', alignItems: 'center', gap: 8 },
      dot: (color, status) => ({
        width: 9,
        height: 9,
        borderRadius: '50%',
        background: status === 'running' ? '#22c55e' : status === 'error' ? '#dc2626' : color || '#94a3b8',
        flex: '0 0 auto',
      }),
      memberName: { fontWeight: 600, fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      memberMeta: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #8a8f98)', marginTop: 4, lineHeight: 1.5 },
      memberActions: { display: 'flex', gap: 6, marginTop: 6 },
      smallBtn: {
        fontSize: 11,
        padding: '2px 8px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.14))',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      primaryBtn: {
        fontSize: 13,
        padding: '6px 14px',
        borderRadius: 8,
        border: '1px solid transparent',
        background: 'var(--dsw-alias-button-primary-bg, #2f6fed)',
        color: '#fff',
        cursor: 'pointer',
        fontWeight: 600,
      },
      ghostBtn: {
        fontSize: 13,
        padding: '6px 12px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.14))',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      dangerBtn: {
        fontSize: 13,
        padding: '6px 12px',
        borderRadius: 8,
        border: '1px solid rgba(220,38,38,0.35)',
        background: 'transparent',
        color: '#dc2626',
        cursor: 'pointer',
      },
      composerWrap: {
        borderTop: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08))',
        padding: '10px 18px 14px',
        position: 'relative',
      },
      composerRow: { display: 'flex', alignItems: 'flex-end', gap: 10 },
      textarea: {
        flex: 1,
        minHeight: 46,
        maxHeight: 180,
        resize: 'vertical',
        padding: '10px 12px',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.14))',
        background: 'var(--dsw-alias-bg-layer-2, #fff)',
        color: 'inherit',
        fontFamily: 'inherit',
        fontSize: 13,
        lineHeight: 1.6,
        outline: 'none',
        boxSizing: 'border-box',
        width: '100%',
      },
      hint: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #8a8f98)', marginTop: 6 },
      picker: {
        position: 'absolute',
        bottom: 76,
        left: 18,
        width: 260,
        maxHeight: 220,
        overflow: 'auto',
        background: 'var(--dsw-alias-bg-layer-2, #fff)',
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.14))',
        borderRadius: 10,
        boxShadow: 'var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,0.14))',
        zIndex: 30,
        padding: 6,
      },
      pickerItem: {
        padding: '7px 9px',
        borderRadius: 7,
        cursor: 'pointer',
        fontSize: 13,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      },
      msgRow: (mine) => ({
        display: 'flex',
        justifyContent: mine ? 'flex-end' : 'flex-start',
        marginBottom: 12,
      }),
      msgBody: (mine, color) => ({
        maxWidth: '78%',
        background: mine ? 'var(--dsw-alias-bg-accent, #e8f0ff)' : 'var(--dsw-alias-bg-layer-2, #fff)',
        border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08))',
        borderLeft: mine ? undefined : `3px solid ${color || '#94a3b8'}`,
        borderRadius: 10,
        padding: '8px 12px',
      }),
      msgMeta: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #8a8f98)' },
      msgAuthor: { fontWeight: 600, color: 'var(--dsw-alias-label-secondary, #4b5563)' },
      msgText: { fontSize: 13, lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      systemRow: {
        display: 'flex',
        justifyContent: 'center',
        margin: '6px 0 12px',
        fontSize: 11,
        color: 'var(--dsw-alias-label-tertiary, #8a8f98)',
      },
      overlay: {
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.28)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      },
      modal: {
        width: 560,
        maxWidth: '92vw',
        maxHeight: '86vh',
        overflow: 'auto',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        borderRadius: 14,
        boxShadow: 'var(--dsw-elevation-prominent, 0 20px 60px rgba(0,0,0,0.25))',
        padding: 20,
        color: 'inherit',
      },
      modalTitle: { fontSize: 16, fontWeight: 600, marginBottom: 14 },
      field: { marginBottom: 12 },
      label: { fontSize: 12, fontWeight: 600, marginBottom: 5, display: 'block', color: 'var(--dsw-alias-label-secondary, #4b5563)' },
      input: {
        width: '100%',
        padding: '8px 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.14))',
        background: 'var(--dsw-alias-bg-layer-2, #fff)',
        color: 'inherit',
        fontSize: 13,
        fontFamily: 'inherit',
        boxSizing: 'border-box',
      },
      row: { display: 'flex', gap: 10 },
      modalActions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 },
      flash: {
        position: 'absolute',
        top: 8,
        right: 18,
        background: 'var(--dsw-alias-bg-layer-3, #1f2329)',
        color: 'var(--dsw-alias-label-primary-inverse, #fff)',
        padding: '6px 12px',
        borderRadius: 8,
        fontSize: 12,
        zIndex: 40,
      },
      errorBanner: {
        background: 'rgba(220,38,38,0.08)',
        color: 'var(--bt-danger-text)',
        padding: '8px 12px',
        fontSize: 12,
        borderBottom: '1px solid rgba(220,38,38,0.2)',
      },
      centerEmpty: {
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        color: 'var(--dsw-alias-label-tertiary, #8a8f98)',
        fontSize: 13,
      },
    };

    // ── visual refresh: cohesive tokens (v1.5.5) ──────────────────────────
    Object.assign(S, {
      root: {
        ...S.root,
        background: 'var(--bt-bg)',
        color: 'var(--bt-text)',
        fontSize: 13,
        WebkitFontSmoothing: 'antialiased',
      },
      left: {
        ...S.left,
        width: 252,
        background: 'var(--bt-bg-soft)',
        borderRight: '1px solid var(--bt-border)',
      },
      leftHeader: {
        ...S.leftHeader,
        padding: '16px 14px 8px',
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: '0.04em',
        color: 'var(--bt-text-3)',
      },
      groupList: { overflow: 'auto', flex: 1, padding: '0 10px 10px' },
      sidebarActions: {
        marginTop: 'auto',
        flex: '0 0 auto',
        display: 'grid',
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        gap: 6,
        padding: '10px 12px',
        borderTop: '1px solid var(--bt-border)',
      },
      sidebarAction: {
        appearance: 'none',
        boxSizing: 'border-box',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 7,
        width: '100%',
        minWidth: 0,
        height: 36,
        padding: '0 10px',
        border: 0,
        borderRadius: 8,
        background: 'transparent',
        color: 'var(--bt-text-2)',
        fontFamily: 'inherit',
        fontSize: 12,
        fontWeight: 500,
        lineHeight: '20px',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
      },
      sidebarActionIcon: { display: 'block', flex: '0 0 16px', width: 16, height: 16 },
      groupItem: (active) => ({
        padding: '10px 12px',
        borderRadius: 10,
        marginBottom: 6,
        cursor: 'pointer',
        background: active ? 'var(--bt-accent-soft)' : 'transparent',
        border: active ? '1px solid var(--bt-accent-border)' : '1px solid transparent',
        boxShadow: 'none',
        transition: 'background 120ms ease, border-color 120ms ease',
      }),
      groupTitle: { fontWeight: 500, fontSize: 13.5, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      groupPreview: {
        fontSize: 11.5,
        color: 'var(--bt-text-3)',
        marginTop: 4,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      chatHeader: {
        ...S.chatHeader,
        padding: '14px 20px',
        background: 'var(--bt-surface)',
        borderBottom: '1px solid var(--bt-border)',
        boxShadow: '0 1px 2px rgba(16,24,40,0.03)',
        zIndex: 5,
      },
      chatTitle: { fontWeight: 600, fontSize: 15.5, letterSpacing: '-0.01em', color: 'var(--bt-text-strong)' },
      chatTopic: { fontSize: 12, color: 'var(--bt-text-3)', marginTop: 3 },
      timeline: { flex: 1, overflow: 'auto', padding: '20px 22px 12px', minHeight: 0 },
      right: { ...S.right, width: 280, background: 'var(--bt-bg-soft)', borderLeft: '1px solid var(--bt-border)' },
      rightHeader: {
        ...S.rightHeader,
        padding: '16px 14px 8px',
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: '0.04em',
        color: 'var(--bt-text-3)',
      },
      memberList: { overflow: 'auto', flex: 1, padding: '0 10px 12px' },
      memberCard: {
        padding: '10px 12px',
        borderRadius: 12,
        background: 'var(--bt-surface)',
        border: '1px solid var(--bt-border)',
        marginBottom: 10,
        boxShadow: '0 1px 2px rgba(16,24,40,0.04)',
      },
      avatarRow: { display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 14 },
      avatarPreview: {
        width: 60,
        height: 60,
        borderRadius: '50%',
        overflow: 'hidden',
        flex: '0 0 auto',
        border: '1px solid var(--bt-border-strong)',
        background: 'var(--bt-surface)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      },
      avatarPicker: { flex: 1, minWidth: 0 },
      avatarActions: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 },
      artGrid: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 },
      artOption: (selected) => ({
        width: 42,
        height: 42,
        borderRadius: '50%',
        padding: 0,
        border: selected ? '2px solid #2563eb' : '1px solid var(--bt-border-strong)',
        background: 'var(--bt-surface)',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: selected ? '0 0 0 3px rgba(37,99,235,0.12)' : 'none',
      }),
      avatarImage: (size) => ({
        width: size,
        height: size,
        borderRadius: '50%',
        objectFit: 'cover',
        display: 'block',
        flex: '0 0 auto',
        border: '1px solid rgba(16,24,40,0.06)',
        background: 'var(--bt-surface)',
      }),
      memberName: { ...S.memberName, fontSize: 13, color: 'var(--bt-text-strong)' },
      memberMeta: { ...S.memberMeta, fontSize: 11.5, color: 'var(--bt-text-3)', marginTop: 4 },
      smallBtn: {
        fontSize: 11.5,
        padding: '4px 9px',
        borderRadius: 7,
        border: '1px solid var(--bt-border-strong)',
        background: 'var(--bt-surface)',
        color: 'var(--bt-text-2)',
        cursor: 'pointer',
        lineHeight: 1.4,
        fontWeight: 500,
      },
      primaryBtn: {
        fontSize: 13,
        padding: '7px 16px',
        borderRadius: 8,
        border: '1px solid #2563eb',
        background: '#2563eb',
        color: '#ffffff',
        cursor: 'pointer',
        fontWeight: 600,
        boxShadow: '0 1px 2px rgba(37,99,235,0.25)',
      },
      ghostBtn: {
        fontSize: 13,
        padding: '7px 14px',
        borderRadius: 8,
        border: '1px solid var(--bt-border-strong)',
        background: 'var(--bt-surface)',
        color: 'var(--bt-text-2)',
        cursor: 'pointer',
      },
      dangerBtn: {
        fontSize: 13,
        padding: '7px 14px',
        borderRadius: 8,
        border: '1px solid rgba(217,45,32,0.28)',
        background: 'var(--bt-surface)',
        color: 'var(--bt-danger-text)',
        cursor: 'pointer',
      },
      composerWrap: { ...S.composerWrap, borderTop: '1px solid var(--bt-border)', padding: '12px 20px 16px', background: 'var(--bt-surface)' },
      composerRow: { display: 'flex', alignItems: 'flex-end', gap: 10 },
      textarea: {
        ...S.textarea,
        minHeight: 48,
        padding: '11px 14px',
        borderRadius: 12,
        border: '1px solid var(--bt-border-strong)',
        background: 'var(--bt-surface)',
        fontSize: 13,
        lineHeight: 1.65,
        boxShadow: 'inset 0 1px 2px rgba(16,24,40,0.03)',
      },
      hint: { ...S.hint, color: 'var(--bt-text-3)', marginTop: 7 },
      picker: {
        ...S.picker,
        width: 270,
        borderRadius: 12,
        border: '1px solid var(--bt-border)',
        boxShadow: '0 12px 32px rgba(16,24,40,0.16)',
        padding: 6,
      },
      pickerItem: { ...S.pickerItem, padding: '8px 10px', borderRadius: 8, fontSize: 13 },
      msgRow: (mine) => ({ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start', marginBottom: 14 }),
      msgBody: (mine, color) => ({
        maxWidth: '78%',
        background: mine ? 'var(--bt-user-bubble)' : 'var(--bt-bot-bubble)',
        border: mine ? '1px solid var(--bt-user-bubble-border)' : '1px solid var(--bt-border)',
        borderLeft: mine ? undefined : '3px solid ' + (color || '#94a3b8'),
        borderRadius: 12,
        padding: '9px 13px',
        boxShadow: '0 1px 2px rgba(16,24,40,0.04)',
      }),
      msgMeta: { display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5, fontSize: 11, color: 'var(--bt-text-3)' },
      msgAuthor: { fontWeight: 600, color: 'var(--bt-text-2)' },
      msgText: { fontSize: 13.5, lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--bt-text)' },
      systemRow: {
        display: 'flex',
        justifyContent: 'center',
        margin: '4px 0 14px',
        fontSize: 11,
        color: 'var(--bt-text-3)',
      },
      approvalCard: {
        border: '1px solid var(--bt-warn-border)',
        background: 'var(--bt-warn-bg)',
        borderRadius: 12,
        padding: '12px 14px',
        margin: '4px 0 14px',
      },
      approvalHead: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' },
      approvalTitle: { fontSize: 12.5, fontWeight: 600, color: 'var(--bt-warn-title)' },
      approvalText: { fontSize: 12.5, color: 'var(--bt-warn-text)', lineHeight: 1.65 },
      approvalActions: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 9, flexWrap: 'wrap' },
      approvalHint: { fontSize: 11, color: 'var(--bt-text-3)', lineHeight: 1.5 },
      overlay: {
        position: 'fixed',
        inset: 0,
        background: 'var(--bt-overlay)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        padding: 24,
        fontFamily: 'var(--dsh-font-ui, system-ui, -apple-system, "Segoe UI", sans-serif)',
        color: 'var(--bt-text)',
      },
      modal: {
        ...S.modal,
        width: 600,
        maxWidth: '94vw',
        maxHeight: '88vh',
        overflow: 'hidden',
        background: 'var(--bt-surface)',
        borderRadius: 18,
        padding: 0,
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 32px 80px rgba(16,24,40,0.28), 0 2px 8px rgba(16,24,40,0.08)',
        border: '1px solid var(--bt-border)',
      },
      modalHeader: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '20px 24px 14px',
        borderBottom: '1px solid var(--bt-border)',
        flex: '0 0 auto',
      },
      modalHeading: { flex: 1, minWidth: 0 },
      modalTitle: { fontSize: 17, fontWeight: 650, lineHeight: 1.35, letterSpacing: '-0.015em', color: 'var(--bt-text-strong)' },
      modalSubtitle: { fontSize: 12.5, color: 'var(--bt-text-3)', marginTop: 4, lineHeight: 1.55 },
      modalClose: {
        width: 30,
        height: 30,
        borderRadius: 9,
        border: '1px solid transparent',
        background: 'transparent',
        color: 'var(--bt-text-3)',
        fontSize: 20,
        lineHeight: 1,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: '0 0 auto',
        padding: 0,
      },
      modalBody: { padding: '18px 24px 20px', overflow: 'auto', minHeight: 0, flex: '1 1 auto', overscrollBehavior: 'contain' },
      modalFooter: {
        display: 'flex',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: 8,
        padding: '14px 24px',
        borderTop: '1px solid var(--bt-border)',
        background: 'var(--bt-bg-subtle)',
        flex: '0 0 auto',
      },
      settingsRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '14px 0', borderBottom: '1px solid var(--bt-border)' },
      settingsModes: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', flex: '0 0 auto', gap: 3, padding: 3, borderRadius: 9, background: 'var(--bt-bg-soft)', border: '1px solid var(--bt-border)' },
      settingsMode: { border: '1px solid transparent', borderRadius: 6, padding: '6px 9px', fontSize: 11.5, lineHeight: 1.5, cursor: 'pointer', whiteSpace: 'nowrap' },
      formGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'start' },
      sectionHeader: { display: 'flex', alignItems: 'center', gap: 8, margin: '2px 0 10px' },
      sectionTitle: { fontSize: 13, fontWeight: 600, color: 'var(--bt-text-strong)' },
      sectionMeta: { fontSize: 11.5, color: 'var(--bt-text-3)' },
      toolChips: { display: 'flex', flexWrap: 'wrap', gap: 6, paddingTop: 1 },
      toolChip: {
        fontSize: 11,
        padding: '4px 9px',
        borderRadius: 7,
        background: 'var(--bt-bg-subtle)',
        border: '1px solid var(--bt-border)',
        color: 'var(--bt-text-2)',
        lineHeight: 1.4,
      },
      sectionDivider: { height: 1, background: 'var(--bt-border)', margin: '16px 0 14px' },
      fieldHint: { fontSize: 11.5, color: 'var(--bt-text-3)', lineHeight: 1.55, marginTop: 5 },
      requiredMark: { color: '#d92d20', marginLeft: 2 },
      personaCard: {
        border: '1px solid var(--bt-border)',
        borderRadius: 14,
        padding: 14,
        background: 'var(--bt-bg-subtle)',
        marginTop: 2,
      },
      personaHead: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' },
      personaTitle: { fontSize: 13, fontWeight: 600, color: 'var(--bt-text-strong)' },
      fileChip: {
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 7px',
        borderRadius: 6,
        background: 'var(--bt-bg-subtle)',
        border: '1px solid var(--bt-border)',
        color: 'var(--bt-text-2)',
        fontSize: 10.5,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        letterSpacing: '0.02em',
      },
      metaBadge: {
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        borderRadius: 999,
        background: 'var(--bt-accent-soft)',
        border: '1px solid var(--bt-accent-border)',
        color: '#2563eb',
        fontSize: 10.5,
        fontWeight: 500,
      },
      personaIntro: { fontSize: 11.5, color: 'var(--bt-text-3)', lineHeight: 1.6, marginBottom: 10 },
      personaTextarea: {
        ...S.input,
        minHeight: 210,
        maxHeight: 360,
        resize: 'vertical',
        padding: '12px 14px',
        borderRadius: 10,
        border: '1px solid var(--bt-border-strong)',
        background: 'var(--bt-surface)',
        fontSize: 13,
        lineHeight: 1.75,
        boxShadow: 'inset 0 1px 2px rgba(16,24,40,0.03)',
      },
      personaFoot: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' },
      personaTip: { fontSize: 11.5, color: 'var(--bt-text-3)', lineHeight: 1.5, flex: 1, minWidth: 140 },
      charCount: { fontSize: 11.5, color: 'var(--bt-text-3)', fontVariantNumeric: 'tabular-nums' },
      templateWrap: { position: 'relative', flex: '0 0 auto' },
      templateBtn: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '5px 10px',
        borderRadius: 7,
        border: '1px solid var(--bt-border-strong)',
        background: 'var(--bt-surface)',
        color: 'var(--bt-text-2)',
        cursor: 'pointer',
        fontSize: 11.5,
        fontWeight: 500,
        lineHeight: 1.4,
      },
      templateCaret: { fontSize: 9, lineHeight: 1, color: 'var(--bt-text-3)' },
      templateMenu: {
        position: 'absolute',
        left: 0,
        bottom: 'calc(100% + 6px)',
        zIndex: 42,
        width: 336,
        maxWidth: '78vw',
        maxHeight: 332,
        overflowY: 'auto',
        padding: 6,
        borderRadius: 10,
        border: '1px solid var(--bt-border)',
        background: 'var(--bt-surface)',
        boxShadow: '0 12px 34px rgba(16,24,40,0.16)',
      },
      templateMenuHead: {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 8,
        padding: '4px 9px 6px',
      },
      templateMenuTitle: { fontSize: 11.5, fontWeight: 600, color: 'var(--bt-text-2)' },
      templateMenuHint: { fontSize: 10.5, color: 'var(--bt-text-3)', fontVariantNumeric: 'tabular-nums' },
      templateItem: {
        display: 'block',
        width: '100%',
        padding: '7px 9px',
        border: 0,
        borderRadius: 8,
        background: 'transparent',
        textAlign: 'left',
        cursor: 'pointer',
      },
      templateItemRow: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
      templateItemTitle: { fontSize: 12.5, fontWeight: 600, color: 'var(--bt-text)' },
      templateTag: {
        padding: '1px 6px',
        borderRadius: 999,
        background: 'var(--bt-accent-soft)',
        border: '1px solid var(--bt-accent-border)',
        color: '#2563eb',
        fontSize: 10,
        fontWeight: 500,
      },
      templateUsedTag: {
        padding: '1px 6px',
        borderRadius: 999,
        background: 'var(--bt-bg-subtle)',
        border: '1px solid var(--bt-border)',
        color: 'var(--bt-text-3)',
        fontSize: 10,
      },
      templateItemSummary: { marginTop: 2, fontSize: 11, lineHeight: 1.5, color: 'var(--bt-text-3)' },
      templateMenuFoot: {
        marginTop: 4,
        padding: '6px 9px 2px',
        borderTop: '1px solid var(--bt-border)',
        fontSize: 10.5,
        lineHeight: 1.5,
        color: 'var(--bt-text-3)',
      },
      field: { marginBottom: 14, minWidth: 0 },
      label: { fontSize: 12, fontWeight: 600, marginBottom: 6, display: 'block', color: 'var(--bt-text-2)' },
      input: {
        ...S.input,
        padding: '9px 11px',
        borderRadius: 9,
        border: '1px solid var(--bt-border-strong)',
        background: 'var(--bt-surface)',
        fontSize: 13,
        lineHeight: 1.5,
        outline: 'none',
      },
      flash: {
        ...S.flash,
        background: '#111827',
        color: '#ffffff',
        borderRadius: 10,
        padding: '7px 14px',
        fontSize: 12,
        boxShadow: '0 6px 20px rgba(17,24,39,0.25)',
      },
      errorBanner: {
        background: 'var(--bt-danger-bg)',
        color: 'var(--bt-danger-text)',
        padding: '9px 14px',
        fontSize: 12,
        borderBottom: '1px solid var(--bt-danger-border)',
      },
    });

    // ── v1.6 group-chat feed ──────────────────────────────────────────────
    Object.assign(S, {
      left: { ...S.left, width: 264 },
      leftHeader: { ...S.leftHeader, padding: '16px 14px 10px' },
      groupItem: (active) => ({
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '9px 10px',
        borderRadius: 11,
        marginBottom: 4,
        cursor: 'pointer',
        background: active ? 'var(--bt-accent-soft)' : 'transparent',
        border: active ? '1px solid var(--bt-accent-border)' : '1px solid transparent',
        transition: 'background 120ms ease, border-color 120ms ease',
      }),
      groupAvatar: (size) => ({
        width: size,
        height: size,
        borderRadius: size >= 36 ? 11 : 9,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: '0 0 auto',
        color: '#ffffff',
        fontWeight: 650,
        fontSize: Math.round(size * 0.4),
        lineHeight: 1,
        letterSpacing: '-0.02em',
        position: 'relative',
        textShadow: '0 1px 2px rgba(0,0,0,0.16)',
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.16)',
        userSelect: 'none',
      }),
      groupAvatarImage: (size) => ({
        width: size,
        height: size,
        borderRadius: size >= 36 ? 11 : 9,
        objectFit: 'cover',
        display: 'block',
        flex: '0 0 auto',
        border: '1px solid rgba(16,24,40,0.06)',
        background: 'var(--bt-surface)',
      }),
      groupAvatarDot: {
        position: 'absolute',
        right: -2,
        bottom: -2,
        width: 9,
        height: 9,
        borderRadius: '50%',
        background: '#22c55e',
        border: '2px solid var(--bt-bg-soft)',
        boxSizing: 'content-box',
      },
      groupItemBody: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 },
      groupItemTop: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
      groupItemTitle: {
        flex: 1,
        minWidth: 0,
        fontWeight: 600,
        fontSize: 13,
        color: 'var(--bt-text)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      groupItemTime: { flex: '0 0 auto', fontSize: 10.5, color: 'var(--bt-text-3)', fontVariantNumeric: 'tabular-nums' },
      groupItemPreview: {
        flex: 1,
        minWidth: 0,
        fontSize: 11.5,
        color: 'var(--bt-text-3)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        lineHeight: 1.45,
      },
      chatHeader: {
        ...S.chatHeader,
        padding: '11px 18px',
        minHeight: 64,
        background: 'var(--bt-surface)',
        borderBottom: '1px solid var(--bt-border)',
        boxShadow: '0 1px 2px rgba(16,24,40,0.03)',
        zIndex: 20,
        flex: '0 0 auto',
      },
      chatTitleRow: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
      chatTitle: { fontWeight: 650, fontSize: 15.5, letterSpacing: '-0.01em', color: 'var(--bt-text-strong)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      chatTopic: { fontSize: 11.5, color: 'var(--bt-text-3)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      headerLive: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        height: 20,
        padding: '0 8px',
        borderRadius: 999,
        background: '#ecfdf3',
        border: '1px solid #bbf7d0',
        color: '#15803d',
        fontSize: 10.5,
        fontWeight: 600,
        flex: '0 0 auto',
      },
      headerLiveDot: { width: 5, height: 5, borderRadius: '50%', background: '#22c55e' },
      headerActions: { display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' },
      headerBtn: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        height: 30,
        padding: '0 10px',
        borderRadius: 8,
        border: '1px solid var(--bt-border-strong)',
        background: 'var(--bt-surface)',
        color: 'var(--bt-text-2)',
        fontSize: 12,
        fontWeight: 500,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      headerIconBtn: {
        width: 30,
        height: 30,
        padding: 0,
        borderRadius: 8,
        border: '1px solid var(--bt-border-strong)',
        background: 'var(--bt-surface)',
        color: 'var(--bt-text-2)',
        fontSize: 16,
        lineHeight: 1,
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      },
      timelineWrap: {
        flex: 1,
        minHeight: 0,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bt-bg-subtle)',
      },
      timeline: {
        flex: 1,
        overflowY: 'auto',
        overflowX: 'hidden',
        padding: '18px 24px 20px',
        minHeight: 0,
        background: 'var(--bt-bg-subtle)',
        overscrollBehavior: 'contain',
      },
      messageColumn: { width: '100%', maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column' },
      timeDivider: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        margin: '4px 0 14px',
        fontSize: 10.5,
        color: 'var(--bt-text-3)',
        letterSpacing: '0.01em',
      },
      unreadDivider: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        margin: '2px 0 14px',
        color: '#3370ff',
        fontSize: 10.5,
        fontWeight: 600,
      },
      systemRow: {
        display: 'flex',
        justifyContent: 'center',
        margin: '2px 0 14px',
        fontSize: 10.5,
        color: 'var(--bt-text-3)',
        lineHeight: 1.55,
      },
      systemPill: {
        maxWidth: '82%',
        padding: '4px 11px',
        borderRadius: 999,
        background: 'var(--bt-border)',
        color: 'var(--bt-text-3)',
        textAlign: 'center',
      },
      msgRow: (mine, groupStart, groupEnd) => ({
        display: 'flex',
        flexDirection: mine ? 'row-reverse' : 'row',
        alignItems: 'flex-start',
        gap: 10,
        marginBottom: groupEnd ? 16 : 5,
        paddingTop: groupStart ? 5 : 0,
      }),
      msgAvatarCol: { width: 32, flex: '0 0 32px', display: 'flex', alignItems: 'flex-start' },
      msgMain: (mine) => ({
        display: 'flex',
        flexDirection: 'column',
        alignItems: mine ? 'flex-end' : 'flex-start',
        maxWidth: 'min(660px, 78%)',
        minWidth: 0,
      }),
      msgHead: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        margin: '0 2px 5px',
        maxWidth: '100%',
        minWidth: 0,
        fontSize: 11.5,
        color: 'var(--bt-text-3)',
      },
      msgAuthor: { fontWeight: 600, color: 'var(--bt-text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      msgBubbleLine: (mine) => ({
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: mine ? 'flex-end' : 'flex-start',
        maxWidth: '100%',
        minWidth: 0,
      }),
      msgBubble: (mine, groupStart) => ({
        maxWidth: '100%',
        minWidth: 0,
        boxSizing: 'border-box',
        padding: '9px 13px',
        background: mine ? 'var(--bt-user-bubble-strong)' : 'var(--bt-bot-bubble)',
        color: mine ? '#ffffff' : 'var(--bt-text)',
        border: mine ? '1px solid var(--bt-user-bubble-strong)' : '1px solid var(--bt-border)',
        borderTopLeftRadius: mine ? 14 : groupStart ? 5 : 14,
        borderTopRightRadius: mine ? (groupStart ? 5 : 14) : 14,
        borderBottomLeftRadius: 14,
        borderBottomRightRadius: 14,
        boxShadow: mine ? '0 1px 2px rgba(37,99,235,0.18)' : '0 1px 2px rgba(16,24,40,0.04)',
      }),
      msgText: { fontSize: 13.5, lineHeight: 1.72, whiteSpace: 'pre-wrap', wordBreak: 'break-word', minWidth: 0 },
      msgFooter: (mine) => ({
        display: 'flex',
        alignItems: 'center',
        justifyContent: mine ? 'flex-end' : 'flex-start',
        flexWrap: 'wrap',
        gap: 6,
        marginTop: 5,
        maxWidth: '100%',
      }),
      msgMetaText: { fontSize: 10, color: 'var(--bt-text-3)', fontVariantNumeric: 'tabular-nums' },
      replyQuote: (mine) => ({
        display: 'block',
        width: '100%',
        boxSizing: 'border-box',
        border: 0,
        borderLeft: `2px solid ${mine ? 'rgba(255,255,255,0.55)' : 'var(--bt-accent-border)'}`,
        borderRadius: 5,
        padding: '4px 8px',
        marginBottom: 7,
        background: mine ? 'rgba(255,255,255,0.12)' : 'var(--bt-accent-soft)',
        color: 'inherit',
        fontFamily: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
      }),
      replyQuoteName: { display: 'block', fontSize: 10.5, fontWeight: 600, opacity: 0.9, marginBottom: 1 },
      replyQuoteText: {
        display: 'block',
        fontSize: 11,
        lineHeight: 1.45,
        opacity: 0.78,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      typingBubble: { display: 'flex', alignItems: 'center', gap: 4, padding: '4px 1px' },
      typingLabel: { display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--bt-text-3)', fontSize: 10.5, whiteSpace: 'nowrap' },
      jumpButton: {
        position: 'absolute',
        right: 22,
        bottom: 14,
        zIndex: 8,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 32,
        padding: '0 12px',
        borderRadius: 999,
        border: '1px solid var(--bt-border)',
        background: 'var(--bt-surface)',
        color: 'var(--bt-text-2)',
        fontSize: 11.5,
        fontWeight: 500,
        cursor: 'pointer',
        boxShadow: '0 4px 14px rgba(16,24,40,0.14)',
      },
      composerWrap: { ...S.composerWrap, borderTop: '1px solid var(--bt-border)', padding: '10px 24px 14px', background: 'var(--bt-bg-subtle)' },
      composerShell: {
        position: 'relative',
        width: '100%',
        maxWidth: 900,
        margin: '0 auto',
        background: 'var(--bt-surface)',
        border: '1px solid var(--bt-border)',
        borderRadius: 14,
        boxShadow: '0 1px 2px rgba(16,24,40,0.04)',
        transition: 'border-color .14s ease, box-shadow .14s ease',
      },
      textarea: {
        ...S.textarea,
        display: 'block',
        width: '100%',
        minHeight: 44,
        maxHeight: 180,
        resize: 'none',
        padding: '12px 14px 4px',
        border: 0,
        borderRadius: 0,
        background: 'transparent',
        boxShadow: 'none',
        fontSize: 13.5,
        lineHeight: 1.68,
        boxSizing: 'border-box',
      },
      composerFoot: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '2px 8px 8px 10px',
        flexWrap: 'wrap',
      },
      composerHint: { flex: 1, minWidth: 160, fontSize: 10.5, color: 'var(--bt-text-3)', lineHeight: 1.5 },
      toolButton: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        height: 26,
        padding: '0 8px',
        borderRadius: 6,
        border: '1px solid transparent',
        background: 'transparent',
        color: 'var(--bt-text-3)',
        fontSize: 11,
        fontWeight: 500,
        cursor: 'pointer',
      },
      toolDanger: { color: 'var(--bt-danger-text)' },
      sendButton: {
        height: 30,
        padding: '0 16px',
        borderRadius: 8,
        border: '1px solid #2f63e8',
        background: '#3370ff',
        color: '#ffffff',
        fontSize: 12.5,
        fontWeight: 600,
        cursor: 'pointer',
        boxShadow: '0 1px 2px rgba(37,99,235,0.22)',
        flex: '0 0 auto',
      },
      replyBar: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 12px',
        borderBottom: '1px solid var(--bt-border)',
        background: 'var(--bt-bg-subtle)',
        borderRadius: '14px 14px 0 0',
      },
      replyBarBody: { flex: 1, minWidth: 0 },
      replyBarLabel: { fontSize: 10.5, fontWeight: 600, color: '#3370ff', marginBottom: 2 },
      replyBarText: { fontSize: 11.5, color: 'var(--bt-text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      replyBarClose: {
        width: 24,
        height: 24,
        padding: 0,
        border: 0,
        borderRadius: 6,
        background: 'transparent',
        color: 'var(--bt-text-3)',
        fontSize: 16,
        lineHeight: 1,
        cursor: 'pointer',
        flex: '0 0 auto',
      },
      picker: {
        position: 'absolute',
        bottom: 'calc(100% + 8px)',
        left: 0,
        width: 290,
        maxHeight: 286,
        overflow: 'auto',
        padding: 6,
        borderRadius: 12,
        border: '1px solid var(--bt-border)',
        background: 'var(--bt-surface)',
        boxShadow: '0 14px 38px rgba(16,24,40,0.18)',
        zIndex: 30,
      },
      pickerHeader: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '5px 9px 7px',
        fontSize: 10.5,
        fontWeight: 600,
        color: 'var(--bt-text-3)',
      },
      pickerItem: {
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '7px 9px',
        borderRadius: 8,
        cursor: 'pointer',
        fontSize: 12.5,
        color: 'var(--bt-text)',
      },
      pickerName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      pickerHint: { fontSize: 10, color: 'var(--bt-text-3)' },
      headerMenu: {
        position: 'absolute',
        top: 38,
        right: 0,
        zIndex: 42,
        minWidth: 178,
        padding: 5,
        borderRadius: 10,
        border: '1px solid var(--bt-border)',
        background: 'var(--bt-surface)',
        boxShadow: '0 12px 34px rgba(16,24,40,0.16)',
      },
      menuItem: {
        display: 'flex',
        alignItems: 'center',
        width: '100%',
        height: 32,
        padding: '0 10px',
        border: 0,
        borderRadius: 7,
        background: 'transparent',
        color: 'var(--bt-text-2)',
        fontSize: 12,
        textAlign: 'left',
        cursor: 'pointer',
      },
      menuDanger: { color: 'var(--bt-danger-text)' },
      menuDivider: { height: 1, background: 'var(--bt-border)', margin: '4px 6px' },
      messageMenu: {
        position: 'fixed',
        zIndex: 42,
        width: MESSAGE_MENU_WIDTH,
        boxSizing: 'border-box',
        padding: 5,
        borderRadius: 10,
        border: '1px solid var(--bt-border)',
        background: 'var(--bt-surface)',
        boxShadow: '0 12px 34px rgba(16,24,40,0.18)',
      },
      messageMenuItem: {
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        width: '100%',
        height: 32,
        padding: '0 10px',
        border: 0,
        borderRadius: 7,
        background: 'transparent',
        color: 'var(--bt-text-2)',
        fontSize: 12,
        textAlign: 'left',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
      },
      messageMenuIcon: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: '0 0 auto',
        width: 14,
        height: 14,
        color: 'var(--bt-text-3)',
      },
      messageMenuLabel: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
      messageMenuSeparator: { height: 1, background: 'var(--bt-border)', margin: '4px 6px' },
      emptyState: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        gap: 6,
        padding: '84px 20px 60px',
        color: 'var(--bt-text-3)',
      },
      emptyIcon: {
        width: 52,
        height: 52,
        borderRadius: 16,
        background: 'var(--bt-bg-subtle)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 6,
        color: 'var(--bt-text-3)',
        fontSize: 22,
        fontWeight: 600,
      },
      emptyTitle: { fontSize: 14, fontWeight: 600, color: 'var(--bt-text-2)' },
      emptyHint: { fontSize: 12, lineHeight: 1.7, maxWidth: 340 },
      loadEarlier: {
        alignSelf: 'center',
        margin: '0 0 14px',
        height: 28,
        padding: '0 12px',
        borderRadius: 999,
        border: '1px solid var(--bt-border)',
        background: 'rgba(255,255,255,0.9)',
        color: 'var(--bt-text-3)',
        fontSize: 11,
        cursor: 'pointer',
      },
      approvalWrap: { display: 'flex', justifyContent: 'center', margin: '2px 0 16px' },
      approvalCard: {
        width: '100%',
        maxWidth: 660,
        border: '1px solid var(--bt-warn-border)',
        background: 'var(--bt-warn-bg)',
        borderRadius: 12,
        padding: '12px 14px',
        boxSizing: 'border-box',
        boxShadow: '0 1px 2px rgba(16,24,40,0.04)',
      },
    });

    // ── v1.6.5 collapsible group sidebar ─────────────────────────────────
    Object.assign(S, {
      sidebar: (collapsed) => ({
        ...S.left,
        width: collapsed ? 68 : S.left.width,
        minWidth: collapsed ? 68 : S.left.minWidth,
        transition: 'width 180ms ease',
        overflowX: 'hidden',
      }),
      leftHeaderActions: { display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto' },
      sidebarToggle: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        padding: 0,
        border: 0,
        borderRadius: 8,
        background: 'transparent',
        color: 'var(--bt-text-3)',
        cursor: 'pointer',
        flex: '0 0 auto',
      },
      railHeader: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        padding: '12px 0 8px',
        flex: '0 0 auto',
      },
      railIconBtn: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 32,
        height: 32,
        padding: 0,
        border: 0,
        borderRadius: 9,
        background: 'transparent',
        color: 'var(--bt-text-3)',
        cursor: 'pointer',
        flex: '0 0 auto',
      },
      groupRail: {
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        overflowX: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        padding: '2px 10px 12px',
      },
      railItem: (active) => ({
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 46,
        height: 46,
        flex: '0 0 auto',
        padding: 0,
        boxSizing: 'border-box',
        borderRadius: 12,
        cursor: 'pointer',
        background: active ? 'var(--bt-accent-soft)' : 'transparent',
        border: active ? '1px solid var(--bt-accent-border)' : '1px solid transparent',
        transition: 'background 120ms ease, border-color 120ms ease',
      }),
      sidebarActionsCollapsed: {
        marginTop: 'auto',
        flex: '0 0 auto',
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr)',
        gap: 4,
        padding: '10px 0',
        borderTop: '1px solid var(--bt-border)',
        justifyItems: 'center',
      },
      railAction: {
        ...S.sidebarAction,
        width: 38,
        height: 38,
        minWidth: 38,
        padding: 0,
        margin: 0,
      },
      railActionIcon: { display: 'block', flex: '0 0 18px', width: 18, height: 18 },

      // v1.7 single chats + custom group sections.
      sidebarScroll: {
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        overflowX: 'hidden',
        padding: '0 8px 8px',
      },
      section: { marginTop: 4 },
      sectionHead: { display: 'flex', alignItems: 'center', gap: 2, padding: '4px 2px 2px', minHeight: 26 },
      sectionToggle: {
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        flex: 1,
        minWidth: 0,
        height: 24,
        padding: '0 4px',
        border: 0,
        borderRadius: 6,
        background: 'transparent',
        color: 'var(--bt-text-3)',
        cursor: 'pointer',
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.02em',
        textAlign: 'left',
      },
      sectionChevron: (collapsed) => ({
        display: 'inline-block',
        width: 8,
        height: 8,
        flex: '0 0 auto',
        color: 'inherit',
        transform: collapsed ? 'rotate(-90deg)' : 'none',
        transition: 'transform 120ms ease',
      }),
      sectionLabel: {
        flex: '0 0 auto',
        maxWidth: 78,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        color: 'var(--bt-text-2)',
      },
      sectionCount: {
        fontSize: 9.5,
        fontWeight: 500,
        color: 'var(--bt-text-3)',
        background: 'var(--bt-bg-subtle)',
        border: '1px solid var(--bt-border)',
        borderRadius: 999,
        padding: '0 5px',
        lineHeight: '15px',
        flex: '0 0 auto',
      },
      sectionActions: { display: 'flex', alignItems: 'center', gap: 1, flex: '0 0 auto' },
      sectionAction: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 22,
        height: 22,
        padding: 0,
        border: 0,
        borderRadius: 6,
        background: 'transparent',
        color: 'var(--bt-text-3)',
        cursor: 'pointer',
        flex: '0 0 auto',
      },
      sectionBody: { paddingTop: 2 },
      folder: { marginBottom: 2 },
      folderHead: { display: 'flex', alignItems: 'center', gap: 2, padding: '1px 2px', borderRadius: 6 },
      folderToggle: {
        flex: 1,
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        height: 26,
        padding: '0 4px',
        border: 0,
        borderRadius: 6,
        background: 'transparent',
        color: 'var(--bt-text-2)',
        cursor: 'pointer',
        fontSize: 11.5,
        fontWeight: 600,
        textAlign: 'left',
      },
      folderIcon: { display: 'inline-flex', flex: '0 0 auto', width: 12, height: 12, color: 'var(--bt-text-3)' },
      folderName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      folderCount: {
        fontSize: 9.5,
        fontWeight: 500,
        color: 'var(--bt-text-3)',
        background: 'var(--bt-bg-subtle)',
        border: '1px solid var(--bt-border)',
        borderRadius: 999,
        padding: '0 5px',
        lineHeight: '15px',
        flex: '0 0 auto',
      },
      folderMenu: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 20,
        height: 20,
        padding: 0,
        border: 0,
        borderRadius: 5,
        background: 'transparent',
        color: 'var(--bt-text-3)',
        cursor: 'pointer',
        flex: '0 0 auto',
        fontSize: 13,
        lineHeight: 1,
      },
      folderBody: { paddingLeft: 3 },
      folderEmpty: { fontSize: 10.5, color: 'var(--bt-text-3)', padding: '1px 10px 5px', lineHeight: 1.6 },
      ungroupedHead: { display: 'flex', alignItems: 'center', gap: 4, padding: '4px 6px 2px', color: 'var(--bt-text-3)' },
      ungroupedLabel: { fontSize: 10.5, fontWeight: 500, flex: 1, minWidth: 0 },
      rowMenu: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 20,
        height: 20,
        padding: 0,
        border: 0,
        borderRadius: 5,
        background: 'transparent',
        color: 'var(--bt-text-3)',
        cursor: 'pointer',
        flex: '0 0 auto',
        fontSize: 13,
        lineHeight: 1,
      },
      dropBefore: { boxShadow: 'inset 0 2px 0 var(--bt-accent)' },
      dropAfter: { boxShadow: 'inset 0 -2px 0 var(--bt-accent)' },
      dropFolder: { background: 'var(--bt-accent-soft)', boxShadow: 'inset 0 0 0 1px var(--bt-accent-border)' },
      dragSource: { opacity: 0.45 },
      railDivider: { width: 28, height: 2, flex: '0 0 auto', margin: '5px 0', borderRadius: 1, background: 'var(--bt-border-strong)' },
      railSectionMark: {
        flex: '0 0 auto',
        margin: '1px 0 -2px',
        fontSize: 9,
        lineHeight: 1,
        fontWeight: 600,
        letterSpacing: '0.06em',
        color: 'var(--bt-text-3)',
      },
      directPanel: { padding: '0 12px 12px', display: 'flex', flexDirection: 'column', gap: 10 },
      directCard: {
        padding: '14px 12px',
        borderRadius: 10,
        background: 'var(--bt-surface)',
        border: '1px solid var(--bt-border)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      },
      directIdentity: { display: 'flex', alignItems: 'center', gap: 10 },
      directName: { fontWeight: 600, fontSize: 14, color: 'var(--bt-text-strong)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      directModel: { fontSize: 11, color: 'var(--bt-text-3)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      directNote: { fontSize: 11, color: 'var(--bt-text-3)', lineHeight: 1.7 },
      directActions: { display: 'flex', flexWrap: 'wrap', gap: 6 },
      sidebarMenu: { ...S.messageMenu, width: 196, maxHeight: 'min(70vh, 420px)', overflowY: 'auto' },
      sidebarMenuItem: { ...S.messageMenuItem, height: 30 },
      sidebarMenuLabel: { ...S.messageMenuLabel, fontSize: 12 },
      sidebarMenuHint: {
        fontSize: 10,
        color: 'var(--bt-text-3)',
        padding: '4px 10px 2px',
        letterSpacing: '0.02em',
      },

      // v1.7 settings dialog: left module nav + message settings / about.
      settingsShell: { display: 'flex', gap: 22, minHeight: 430, alignItems: 'stretch' },
      settingsNav: {
        width: 190,
        flex: '0 0 190px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        paddingRight: 18,
        borderRight: '1px solid var(--bt-border)',
      },
      settingsNavItem: (active) => ({
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        width: '100%',
        padding: '8px 10px',
        border: 0,
        borderRadius: 8,
        background: active ? 'var(--bt-hover)' : 'transparent',
        color: active ? 'var(--bt-text-strong)' : 'var(--bt-text-2)',
        fontSize: 13,
        fontWeight: active ? 600 : 500,
        textAlign: 'left',
        cursor: 'pointer',
      }),
      settingsNavIcon: (active) => ({
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 16,
        height: 16,
        flex: '0 0 auto',
        color: active ? 'var(--bt-accent)' : 'var(--bt-text-3)',
      }),
      settingsContent: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 },
      settingsPanel: { display: 'flex', flexDirection: 'column', minWidth: 0 },
      settingsPanelHead: { marginBottom: 4 },
      settingsPanelTitle: { fontSize: 16, fontWeight: 600, color: 'var(--bt-text-strong)' },
      settingsPanelHint: { fontSize: 11.5, color: 'var(--bt-text-3)', lineHeight: 1.6, marginTop: 4 },
      aboutHero: { display: 'flex', alignItems: 'center', gap: 12, padding: '4px 0 10px' },
      aboutLogo: {
        width: 46,
        height: 46,
        borderRadius: 14,
        background: 'var(--bt-bg-subtle)',
        border: '1px solid var(--bt-border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: '0 0 auto',
      },
      aboutName: { fontSize: 16, fontWeight: 600, color: 'var(--bt-text-strong)' },
      aboutTagline: { fontSize: 11.5, color: 'var(--bt-text-3)', marginTop: 3 },
      aboutCard: {
        border: '1px solid var(--bt-border)',
        borderRadius: 12,
        background: 'var(--bt-bg-subtle)',
        padding: '12px 14px',
        marginBottom: 10,
      },
      aboutDescription: { fontSize: 12.5, lineHeight: 1.8, color: 'var(--bt-text-2)' },
      aboutFeatures: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 },
      aboutRow: { display: 'flex', alignItems: 'center', gap: 16, padding: '9px 0' },
      aboutLabel: { fontSize: 11.5, color: 'var(--bt-text-3)', flex: '0 0 64px' },
      aboutValue: {
        fontSize: 12.5,
        color: 'var(--bt-text-strong)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        wordBreak: 'break-all',
        minWidth: 0,
      },
      aboutNote: { fontSize: 11, color: 'var(--bt-text-3)', lineHeight: 1.7, marginTop: 2 },
    });

    const GLOBAL_CSS = `
.bt-root {
  --bt-surface: #ffffff;
  --bt-overlay: rgba(17,24,39,0.38);
  --bt-loading: rgba(255,255,255,0.5);
  --bt-bg: #ffffff;
  --bt-bg-soft: #f7f8fa;
  --bt-bg-subtle: #f8fafc;
  --bt-text: #1f2329;
  --bt-text-strong: #111827;
  --bt-text-2: #4b5563;
  --bt-text-3: #8a919c;
  --bt-border: #ebedf1;
  --bt-border-strong: #e1e5eb;
  --bt-accent: #3370ff;
  --bt-accent-soft: #e8f0fe;
  --bt-accent-border: #d5e3fb;
  --bt-hover: #f2f4f8;
  --bt-user-bubble: #eaf1ff;
  --bt-user-bubble-strong: #3370ff;
  --bt-user-bubble-border: #cfe0ff;
  --bt-bot-bubble: #ffffff;
  --bt-warn-bg: #fffdf5;
  --bt-warn-border: #fde68a;
  --bt-warn-title: #92400e;
  --bt-warn-text: #4b5563;
  --bt-danger-bg: #fef3f2;
  --bt-danger-border: #fecdca;
  --bt-danger-text: #b42318;
  color-scheme: light;
}
body[data-ds-dark-theme] .bt-root {
  --bt-surface: #181b22;
  --bt-overlay: rgba(0,0,0,0.58);
  --bt-loading: rgba(16,19,24,0.72);
  --bt-bg: #101318;
  --bt-bg-soft: #141820;
  --bt-bg-subtle: #1b2029;
  --bt-text: #e6e9ef;
  --bt-text-strong: #f4f6fa;
  --bt-text-2: #b6bdc9;
  --bt-text-3: #8b93a2;
  --bt-border: #262c36;
  --bt-border-strong: #343c49;
  --bt-accent: #7aa7ff;
  --bt-accent-soft: #1c2b46;
  --bt-accent-border: #2b4066;
  --bt-hover: #222833;
  --bt-user-bubble: #1d3154;
  --bt-user-bubble-strong: #2f5fa8;
  --bt-user-bubble-border: #2e4a78;
  --bt-bot-bubble: #191d26;
  --bt-warn-bg: #2a2214;
  --bt-warn-border: #5a4520;
  --bt-warn-title: #f2c97d;
  --bt-warn-text: #d7c19a;
  --bt-danger-bg: #2a1618;
  --bt-danger-border: #5a2a2f;
  --bt-danger-text: #f3a3a3;
  color-scheme: dark;
}
.bt-root { -webkit-font-smoothing: antialiased; }
.bt-root button { transition: background-color .14s ease, border-color .14s ease, color .14s ease, box-shadow .14s ease, filter .14s ease; }
.bt-root button:hover { filter: brightness(0.985); }
.bt-root button:active { filter: brightness(0.96); }
.bt-root button:disabled { opacity: .55; cursor: not-allowed; filter: none; }
.bt-root button:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(37,99,235,0.22) !important; }
.bt-root input:focus, .bt-root textarea:focus, .bt-root select:focus { border-color: var(--bt-accent) !important; box-shadow: 0 0 0 3px rgba(37,99,235,0.18) !important; outline: none; }
.bt-root input, .bt-root textarea, .bt-root select { transition: border-color .14s ease, box-shadow .14s ease; }
.bt-root ::-webkit-scrollbar { width: 10px; height: 10px; }
.bt-root ::-webkit-scrollbar-thumb { background: rgba(16,24,40,0.16); border-radius: 999px; border: 3px solid transparent; background-clip: content-box; }
.bt-root ::-webkit-scrollbar-thumb:hover { background: rgba(16,24,40,0.28); border: 3px solid transparent; background-clip: content-box; }
.bt-root ::-webkit-scrollbar-track { background: transparent; }
body[data-ds-dark-theme] .bt-root ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.18); border: 3px solid transparent; background-clip: content-box; }
body[data-ds-dark-theme] .bt-root ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.28); border: 3px solid transparent; background-clip: content-box; }
.bt-modal { animation: bt-modal-in .16s ease-out; }
@keyframes bt-modal-in { from { opacity: 0; transform: translateY(8px) scale(.985); } to { opacity: 1; transform: none; } }
.bt-modal-close:hover { background: var(--bt-hover) !important; color: var(--bt-text-2) !important; }
.bt-persona-textarea::placeholder { color: var(--bt-text-3); }

/* Quiet, evenly sized sidebar actions; SVGs never participate in text baselines. */
.bt-root .bt-sidebar-action:hover { background: var(--bt-hover) !important; color: var(--bt-text-strong) !important; filter: none; }
.bt-root .bt-sidebar-action:active { background: var(--bt-accent-soft) !important; color: var(--bt-accent) !important; filter: none; }
.bt-root .bt-sidebar-action svg { pointer-events: none; }

/* v1.6.5 collapsible group sidebar: icons-only rail, tooltips carry the labels. */
.bt-root .bt-sidebar { transition: width 180ms ease; }
.bt-root .bt-sidebar-toggle:hover { background: var(--bt-hover) !important; color: var(--bt-text-strong) !important; filter: none; }
.bt-root .bt-sidebar-toggle:active { background: var(--bt-accent-soft) !important; color: var(--bt-accent) !important; filter: none; }
.bt-root .bt-sidebar-toggle svg { pointer-events: none; }
.bt-root .bt-group-item:focus-visible { outline: 2px solid var(--bt-accent); outline-offset: 2px; }
.bt-root .bt-group-rail { scrollbar-width: none; -ms-overflow-style: none; }
.bt-root .bt-group-rail::-webkit-scrollbar { width: 0; height: 0; display: none; }

/* v1.7 direct chats + custom sections: quiet headers, hover affordances, drop targets. */
.bt-root .bt-section-toggle:hover, .bt-root .bt-folder-toggle:hover { background: var(--bt-hover) !important; filter: none; color: var(--bt-text-2) !important; }
.bt-root .bt-section-action:hover, .bt-root .bt-folder-menu:hover { background: var(--bt-hover) !important; color: var(--bt-text-2) !important; filter: none; }
.bt-root .bt-section-toggle:focus-visible, .bt-root .bt-folder-toggle:focus-visible,
.bt-root .bt-section-action:focus-visible, .bt-root .bt-folder-menu:focus-visible { outline: 2px solid var(--bt-accent); outline-offset: 1px; }
.bt-root .bt-row-menu, .bt-root .bt-folder-menu { opacity: 0; }
.bt-root .bt-folder-head:hover .bt-folder-menu,
.bt-root .bt-folder-head:focus-within .bt-folder-menu,
.bt-root .bt-group-item:hover .bt-row-menu,
.bt-root .bt-group-item:focus-within .bt-row-menu { opacity: 1; }
.bt-root .bt-row-menu:hover { background: var(--bt-hover) !important; color: var(--bt-text-2) !important; filter: none; }
.bt-root .bt-folder-head > .bt-folder-toggle { cursor: pointer; }
.bt-root .bt-folder-head[data-drop="true"] { background: var(--bt-accent-soft); box-shadow: inset 0 0 0 1px var(--bt-accent-border); }
.bt-root .bt-group-item { position: relative; }
.bt-root .bt-group-item[data-drop="before"] { box-shadow: inset 0 2px 0 var(--bt-accent) !important; }
.bt-root .bt-group-item[data-drop="after"] { box-shadow: inset 0 -2px 0 var(--bt-accent) !important; }
.bt-root .bt-group-item[data-dragging="true"] { opacity: .45; }
.bt-root .bt-rail-divider { opacity: .8; }
.bt-root .bt-direct-caption { white-space: nowrap; }
.bt-root .bt-sidebar-menu .bt-msg-menu-item { height: 30px; }

/* v1.7 settings dialog: quiet module nav, responsive one-column fallback. */
.bt-root .bt-settings-nav-item:hover { background: var(--bt-hover) !important; color: var(--bt-text-strong) !important; filter: none; }
.bt-root .bt-settings-nav-item:focus-visible { outline: 2px solid var(--bt-accent); outline-offset: 1px; }
@media (max-width: 700px) {
  .bt-root .bt-settings-shell { flex-direction: column; gap: 14px; min-height: 0; }
  .bt-root .bt-settings-nav {
    width: auto;
    flex: 0 0 auto;
    flex-direction: row;
    overflow-x: auto;
    padding: 0 0 10px;
    border-right: 0;
    border-bottom: 1px solid var(--bt-border);
  }
  .bt-root .bt-settings-nav-item { width: auto; flex: 0 0 auto; }
}

/* v1.6 group feed */
.bt-root .bt-group-item:hover { background: var(--bt-hover) !important; }
.bt-root .bt-group-item[data-active="true"]:hover { background: var(--bt-accent-soft) !important; }
.bt-root .bt-timeline { scrollbar-gutter: stable; }
.bt-root .bt-msg-actions {
  position: absolute;
  top: 2px;
  left: calc(100% + 8px);
  z-index: 5;
  display: inline-flex;
  align-items: center;
  gap: 1px;
  padding: 2px;
  border-radius: 8px;
  border: 1px solid var(--bt-border);
  background: var(--bt-surface);
  box-shadow: 0 3px 12px rgba(16,24,40,0.12);
  opacity: 0;
  pointer-events: none;
  transform: translateY(2px);
  transition: opacity .12s ease, transform .12s ease;
  white-space: nowrap;
}
.bt-root .bt-msg:hover .bt-msg-actions,
.bt-root .bt-msg:focus-within .bt-msg-actions,
.bt-root .bt-msg-actions:hover { opacity: 1; pointer-events: auto; transform: translateY(0); }
.bt-root .bt-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--bt-text-3);
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
}
.bt-root .bt-action-btn svg { display: block; pointer-events: none; }
.bt-root .bt-action-btn:hover { background: var(--bt-hover) !important; filter: none; color: var(--bt-text-2); }
.bt-root .bt-action-btn.bt-action-danger { color: var(--bt-danger-text); }
.bt-root .bt-action-btn.bt-action-danger:hover { background: var(--bt-danger-bg) !important; }
.bt-root .bt-msg:hover .bt-bubble { box-shadow: 0 2px 8px rgba(16,24,40,0.07); }
.bt-root .bt-msg-meta[data-display="hover"] { opacity: 0; transition: opacity .12s ease; }
.bt-root .bt-msg:hover .bt-msg-meta[data-display="hover"],
.bt-root .bt-msg:focus-within .bt-msg-meta[data-display="hover"] { opacity: 1; }
.bt-root .bt-settings-preview:focus-visible { outline: 2px solid var(--bt-accent); outline-offset: 3px; }
@media (hover: none) {
  .bt-root .bt-msg-meta[data-display="hover"] { opacity: 1; }
}
@media (max-width: 560px) {
  .bt-root .bt-settings-row { flex-direction: column; align-items: stretch !important; gap: 10px !important; }
}
.bt-root .bt-msg[data-own="true"]:hover .bt-bubble { box-shadow: 0 2px 8px rgba(37,99,235,0.22); }
.bt-root .bt-msg[data-own="true"] .bt-msg-actions { left: auto; right: calc(100% + 8px); }
.bt-root .bt-msg.bt-msg-flash .bt-bubble { animation: bt-msg-flash 1.35s ease; }
@keyframes bt-msg-flash {
  0%, 100% { box-shadow: 0 0 0 0 rgba(51,112,255,0); }
  15%, 60% { box-shadow: 0 0 0 3px rgba(51,112,255,0.32); }
}
.bt-root .bt-bubble .bt-rich > :last-child { margin-bottom: 0 !important; }
.bt-root .bt-bubble .bt-rich p:last-child { margin-bottom: 0 !important; }
.bt-root .bt-bubble .bt-rich pre { max-width: 100%; box-sizing: border-box; }
.bt-root .bt-bubble .bt-rich table { display: block; max-width: 100%; overflow-x: auto; }
.bt-root .bt-cursor {
  display: inline-block;
  width: 2px;
  height: 1.05em;
  margin-left: 2px;
  vertical-align: -2px;
  background: currentColor;
  animation: bt-blink 1s steps(2, start) infinite;
}
@keyframes bt-blink { 50% { opacity: 0; } }
.bt-root .bt-typing-dot {
  display: inline-block;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--bt-text-3);
  animation: bt-typing 1.15s ease-in-out infinite;
}
.bt-root .bt-typing-dot:nth-child(2) { animation-delay: .14s; }
.bt-root .bt-typing-dot:nth-child(3) { animation-delay: .28s; }
@keyframes bt-typing {
  0%, 60%, 100% { opacity: .35; transform: translateY(0); }
  30% { opacity: 1; transform: translateY(-2px); }
}
.bt-root .bt-time-divider span,
.bt-root .bt-unread-divider span { white-space: nowrap; }
.bt-root .bt-unread-divider::before,
.bt-root .bt-unread-divider::after {
  content: "";
  height: 1px;
  flex: 1;
  background: var(--bt-accent-border);
}
.bt-root .bt-composer:focus-within {
  border-color: var(--bt-accent-border) !important;
  box-shadow: 0 0 0 3px rgba(51,112,255,0.10), 0 1px 2px rgba(16,24,40,0.04) !important;
}
.bt-root .bt-composer textarea:focus {
  border-color: transparent !important;
  box-shadow: none !important;
}
.bt-root .bt-composer textarea::placeholder { color: var(--bt-text-3); }
.bt-root .bt-send-btn:disabled {
  background: var(--bt-bg-subtle) !important;
  border-color: var(--bt-border) !important;
  color: var(--bt-text-3) !important;
  box-shadow: none !important;
}
.bt-root .bt-tool-btn:hover { background: var(--bt-hover) !important; filter: none; }
.bt-root .bt-tool-btn.bt-tool-danger:hover { background: var(--bt-danger-bg) !important; }
.bt-root .bt-picker-item:hover { background: var(--bt-hover); }
.bt-root .bt-picker-item[data-active="true"] { background: var(--bt-accent-soft); }
.bt-root .bt-header-btn:hover { background: var(--bt-hover) !important; border-color: var(--bt-border-strong) !important; }
.bt-root .bt-icon-btn:hover { background: var(--bt-hover) !important; border-color: var(--bt-border-strong) !important; }
.bt-root .bt-menu-item:hover { background: var(--bt-hover) !important; filter: none; }
.bt-root .bt-menu-item.bt-menu-danger:hover { background: var(--bt-danger-bg) !important; }
.bt-root .bt-persona-tpl:hover { background: var(--bt-hover) !important; }
.bt-root .bt-persona-tpl-btn:hover { background: var(--bt-hover) !important; border-color: var(--bt-border-strong) !important; }
.bt-root .bt-persona-tpl-btn:disabled { opacity: .55; cursor: not-allowed; }
.bt-root .bt-menu-backdrop { position: fixed; inset: 0; z-index: 41; }
.bt-root .bt-menu { animation: bt-menu-in .12s ease-out; transform-origin: top right; }
.bt-root .bt-persona-menu { transform-origin: bottom left; }
/* v1.6.4 message context menu (fixed so the timeline never clips it) */
.bt-root .bt-msg-menu { transform-origin: top left; }
.bt-root .bt-msg-menu-item:hover { background: var(--bt-hover) !important; filter: none; }
.bt-root .bt-msg-menu-item:disabled { opacity: .42; cursor: default; background: transparent !important; filter: none !important; }
.bt-root .bt-msg-menu-item.bt-msg-menu-danger { color: var(--bt-danger-text); }
.bt-root .bt-msg-menu-item.bt-msg-menu-danger:hover { background: var(--bt-danger-bg) !important; }
.bt-root .bt-msg-menu-item.bt-msg-menu-danger .bt-msg-menu-icon { color: inherit; }
.bt-root .bt-msg-menu-sep { flex: 0 0 auto; }
@keyframes bt-menu-in { from { opacity: 0; transform: translateY(-3px) scale(.98); } to { opacity: 1; transform: none; } }
.bt-root .bt-jump-btn:hover { background: var(--bt-bg-subtle) !important; border-color: var(--bt-border-strong) !important; }
.bt-root .bt-load-earlier:hover { background: var(--bt-surface) !important; border-color: var(--bt-border-strong) !important; }
.bt-root .bt-chat-scroll-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 17px;
  height: 17px;
  padding: 0 5px;
  border-radius: 999px;
  background: #3370ff;
  color: #ffffff;
  font-size: 9.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
@media (max-width: 1100px) {
  .bt-root .bt-right-panel { display: none !important; }
  .bt-root .bt-right-toggle { display: none !important; }
  .bt-root .bt-timeline { padding-left: 18px; padding-right: 18px; }
  .bt-root .bt-composer-wrap { padding-left: 18px; padding-right: 18px; }
}
@media (max-width: 900px) {
  .bt-root .bt-msg-actions { top: -15px; left: 0; }
  .bt-root .bt-msg[data-own="true"] .bt-msg-actions { left: auto; right: 0; }
}
@media (hover: none) {
  .bt-root .bt-msg-actions { opacity: 1; pointer-events: auto; position: static; margin-bottom: 4px; border: 0; background: transparent; box-shadow: none; }
  .bt-root .bt-msg[data-own="true"] .bt-msg-actions { margin-left: auto; }
  .bt-root .bt-row-menu, .bt-root .bt-folder-menu { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .bt-root .bt-cursor, .bt-root .bt-typing-dot, .bt-root .bt-menu, .bt-root .bt-msg-menu, .bt-root .bt-msg-flash .bt-bubble { animation: none !important; }
  .bt-root .bt-sidebar { transition: none !important; }
}
`;

    // ── helpers ───────────────────────────────────────────────────────────
    function useBootstrap(dispatch) {
      const load = React.useCallback(async () => {
        try {
          const data = await api.bootstrap();
          dispatch({ type: 'bootstrap', data });
        } catch (error) {
          dispatch({ type: 'error', message: String(error && error.message ? error.message : error) });
        }
      }, [dispatch]);
      React.useEffect(() => {
        void load();
      }, [load]);
      return load;
    }

    function useSse(groupId, dispatch) {
      React.useEffect(() => {
        if (!groupId) return undefined;
        let closed = false;
        const source = new EventSource(`${ROUTES.events}?groupId=${encodeURIComponent(groupId)}`);
        const handler = (type) => (event) => {
          if (closed) return;
          try {
            const frame = { ...JSON.parse(event.data), type };
            if (type === 'hello') {
              uiReport({ kind: 'sse-hello', groupId, seq: frame.seq, running: frame.running });
              // Resync after a reconnect: SSE only guarantees frames after connect.
              dispatch({ type: 'messagesTick' });
            }
            dispatch({ type: 'sse', frame });
          } catch {
            /* ignore malformed frames */
          }
        };
        const types = [
          'hello',
          'message.added',
          'message.updated',
          'message.delta',
          'message.replace',
          'member.status',
          'member.added',
          'member.removed',
          'member.updated',
          'group.updated',
          'settings.updated',
        ];
        const listeners = types.map((type) => {
          const fn = handler(type);
          source.addEventListener(type, fn);
          return [type, fn];
        });
        source.onerror = () => {
          uiReport({ kind: 'sse-error', groupId, readyState: source.readyState });
        };
        return () => {
          closed = true;
          for (const [type, fn] of listeners) source.removeEventListener(type, fn);
          source.close();
        };
      }, [groupId, dispatch]);
    }

    function colorOfBot(bots, botId) {
      const bot = bots.find((candidate) => candidate.botId === botId);
      return bot ? bot.color : '#94a3b8';
    }

    function nameOfBot(bots, botId) {
      const bot = bots.find((candidate) => candidate.botId === botId);
      return bot ? bot.name : 'Bot';
    }

    function formatTime(value) {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    }

    function padClock(value) {
      return String(value).padStart(2, '0');
    }

    function sameDay(left, right) {
      const a = new Date(left);
      const b = new Date(right);
      if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return false;
      return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    }

    /** Centered timeline divider: 今天 / 昨天 / 具体日期 + 时间. */
    function formatTimeDivider(value) {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      const now = new Date();
      const clock = `${padClock(date.getHours())}:${padClock(date.getMinutes())}`;
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      const days = Math.round((today.getTime() - target.getTime()) / 86400000);
      if (days === 0) return `今天 ${clock}`;
      if (days === 1) return `昨天 ${clock}`;
      if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
      return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
    }

    /** Compact timestamp for the group list. */
    function formatListTime(value) {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      const days = Math.round((today.getTime() - target.getTime()) / 86400000);
      if (days === 0) return `${padClock(date.getHours())}:${padClock(date.getMinutes())}`;
      if (days === 1) return '昨天';
      if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}/${date.getDate()}`;
      return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
    }

    function formatFullTime(value) {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      return `${date.getFullYear()}-${padClock(date.getMonth() + 1)}-${padClock(date.getDate())} ${padClock(
        date.getHours(),
      )}:${padClock(date.getMinutes())}`;
    }

    function formatTokens(value) {
      const count = Number(value) || 0;
      if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
      if (count >= 1000) return `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}k`;
      return String(count);
    }

    function cleanPreview(text, limit = 100) {
      const source = String(text || '')
        .replace(/```[\s\S]*?```/g, ' [代码] ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' [图片] ')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/[`*_~>#|]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      return source.length > limit ? `${source.slice(0, limit)}…` : source;
    }

    function displayNameOf(message, bots, userProfile) {
      if (!message || !message.author) return '未知';
      if (message.author.type === 'human') return (userProfile && userProfile.name) || '我';
      if (message.author.type === 'system') return '系统';
      const bot = message.author.botId ? (bots || []).find((candidate) => candidate.botId === message.author.botId) : null;
      return bot ? bot.name : message.author.name || 'Bot';
    }

    function authorKeyOf(message) {
      if (!message || !message.author) return '';
      if (message.author.type === 'bot') return `bot:${message.author.botId || message.author.name || ''}`;
      return String(message.author.type || 'unknown');
    }

    function isPlainChatMessage(message) {
      if (!message || !message.author) return false;
      if (message.kind === 'approval' || message.kind === 'system') return false;
      if (message.author.type === 'system') return false;
      return true;
    }

    function canGroupMessages(previous, message) {
      if (!isPlainChatMessage(previous) || !isPlainChatMessage(message)) return false;
      if (authorKeyOf(previous) !== authorKeyOf(message)) return false;
      const gap = Number(message.createdAt || 0) - Number(previous.createdAt || 0);
      return gap >= 0 && gap < 5 * 60 * 1000;
    }

    function replyQuoteOf(message, allMessages) {
      if (!message || !message.replyTo || !message.author || message.author.type !== 'human') return null;
      return (allMessages || []).find((candidate) => candidate.messageId === message.replyTo) || null;
    }

    const MESSAGE_MENU_MARGIN = 8;
    const MESSAGE_MENU_ITEM_HEIGHT = 32;
    const MESSAGE_MENU_SEPARATOR_HEIGHT = 9;

    /** Keep the fixed-position menu fully inside the viewport (8px margin). */
    function placeMessageMenu(x, y, viewportWidth, viewportHeight, width, height) {
      const safeWidth = Number.isFinite(width) && width > 0 ? width : MESSAGE_MENU_WIDTH;
      const safeHeight = Number.isFinite(height) && height > 0 ? height : 0;
      const maxLeft = Math.max(MESSAGE_MENU_MARGIN, Number(viewportWidth || 0) - safeWidth - MESSAGE_MENU_MARGIN);
      const maxTop = Math.max(MESSAGE_MENU_MARGIN, Number(viewportHeight || 0) - safeHeight - MESSAGE_MENU_MARGIN);
      return {
        left: Math.min(Math.max(Number(x) || 0, MESSAGE_MENU_MARGIN), maxLeft),
        top: Math.min(Math.max(Number(y) || 0, MESSAGE_MENU_MARGIN), maxTop),
      };
    }

    function messageMenuHeight(itemCount, separatorCount) {
      return itemCount * MESSAGE_MENU_ITEM_HEIGHT + separatorCount * MESSAGE_MENU_SEPARATOR_HEIGHT + 10 + 2;
    }

    /** "> **Name**：first line" + quoted remaining lines, ready to paste in Markdown. */
    function buildQuoteMarkdown(name, text) {
      const body = String(text || '').replace(/\r\n?/g, '\n').trim();
      const lines = body ? body.split('\n') : [''];
      const head = `> **${String(name || '消息')}**：${lines[0]}`.trimEnd();
      const rest = lines.slice(1).map((line) => (line ? `> ${line}` : '>'));
      return rest.length ? [head, ...rest].join('\n') : head;
    }

    /**
     * One source of truth for a message's actions: the hover toolbar renders
     * the icon buttons, the right-click menu renders icon + label. Actions can
     * opt out of the toolbar (`hover: false`) or be shown disabled in the menu.
     */
    function messageActionList({
      message,
      mine,
      streaming,
      meta,
      hasQuoted,
      onReply,
      onCopy,
      onCopyQuote,
      onJumpToMessage,
      onReview,
      onRevise,
      onRetry,
    }) {
      const actions = [];
      const details = meta || {};
      const hasText = !!(message && String(message.text || '').trim());
      const select = (callback) => () => {
        if (typeof callback === 'function') callback(message);
      };
      actions.push({
        key: 'reply',
        icon: 'reply',
        label: '回复',
        title: streaming ? '回复生成中，暂不可回复' : '回复这条消息',
        section: 'primary',
        disabled: streaming,
        hover: !streaming,
        danger: false,
        onSelect: select(onReply),
      });
      actions.push({
        key: 'copy',
        icon: 'copy',
        label: '复制文本',
        title: hasText ? '复制消息原文（Markdown）' : '这条消息没有可复制的文本',
        section: 'primary',
        disabled: !hasText,
        hover: !streaming && hasText,
        danger: false,
        onSelect: select(onCopy),
      });
      if (!streaming && hasText && typeof onCopyQuote === 'function') {
        actions.push({
          key: 'quote',
          icon: 'quote',
          label: '复制为引用',
          title: '复制成带作者署名的 Markdown 引用',
          section: 'primary',
          disabled: false,
          hover: false,
          danger: false,
          onSelect: select(onCopyQuote),
        });
      }
      if (hasQuoted && typeof onJumpToMessage === 'function') {
        actions.push({
          key: 'jump',
          icon: 'jump',
          label: '定位原消息',
          title: '滚动到这条消息引用的原消息',
          section: 'navigate',
          disabled: false,
          hover: false,
          danger: false,
          onSelect: () => onJumpToMessage(message.replyTo),
        });
      }
      if (!mine && !streaming && typeof onReview === 'function') {
        actions.push({
          key: 'review',
          icon: 'review',
          label: '评审',
          title: '请另一位成员评审这条回复',
          section: 'workflow',
          disabled: false,
          hover: true,
          danger: false,
          onSelect: select(onReview),
        });
      }
      if (message && message.kind === 'review' && details.reviewOf && message.status === 'done' && typeof onRevise === 'function') {
        actions.push({
          key: 'revise',
          icon: 'edit',
          label: '让作者修改',
          title: '让作者按这条评审意见修改',
          section: 'workflow',
          disabled: false,
          hover: true,
          danger: false,
          onSelect: select(onRevise),
        });
      }
      if (message && message.status === 'error' && typeof onRetry === 'function') {
        actions.push({
          key: 'retry',
          icon: 'retry',
          label: '重试',
          title: '重试这条回复',
          section: 'danger',
          disabled: false,
          hover: true,
          danger: true,
          onSelect: select(onRetry),
        });
      }
      return actions;
    }

    function copyTextToClipboard(text) {
      const value = String(text || '');
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        return navigator.clipboard.writeText(value);
      }
      return new Promise((resolve, reject) => {
        try {
          const node = document.createElement('textarea');
          node.value = value;
          node.style.position = 'fixed';
          node.style.opacity = '0';
          document.body.appendChild(node);
          node.select();
          const copied = document.execCommand('copy');
          document.body.removeChild(node);
          copied ? resolve() : reject(new Error('浏览器不支持复制'));
        } catch (error) {
          reject(error);
        }
      });
    }

    // ── small components ──────────────────────────────────────────────────
    function containModalFocus(dialog) {
      if (!dialog) return undefined;
      const doc = dialog.ownerDocument;
      const previous = doc.activeElement;
      const focusable = () => Array.from(dialog.querySelectorAll('button, a[href], input, select, textarea, [tabindex], [contenteditable="true"]'))
        .filter(node => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length > 0 && !node.closest('[hidden], [inert]'));
      const focusFirst = () => (focusable()[0] || dialog).focus();
      if (!dialog.contains(doc.activeElement)) focusFirst();
      const onTab = event => {
        if (event.key !== 'Tab') return;
        const items = focusable();
        const active = doc.activeElement;
        if (!items.length) {
          event.preventDefault();
          dialog.focus();
        } else if (!items.includes(active) || (event.shiftKey && active === items[0])) {
          event.preventDefault();
          (event.shiftKey ? items[items.length - 1] : items[0]).focus();
        } else if (!event.shiftKey && active === items[items.length - 1]) {
          event.preventDefault();
          items[0].focus();
        }
      };
      const onFocus = event => { if (!dialog.contains(event.target)) focusFirst(); };
      doc.addEventListener('keydown', onTab, true);
      doc.addEventListener('focusin', onFocus);
      return () => {
        doc.removeEventListener('keydown', onTab, true);
        doc.removeEventListener('focusin', onFocus);
        if (previous?.isConnected) previous.focus();
      };
    }

    function Modal({ title, subtitle, width, onClose, children, footer }) {
      const dialogRef = React.useRef(null);
      React.useEffect(() => containModalFocus(dialogRef.current), []);
      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      }, [onClose]);
      return h(
        'div',
        { className: 'bt-root', style: S.overlay, onMouseDown: (event) => event.target === event.currentTarget && onClose() },
        h(
          'div',
          {
            className: 'bt-modal',
            ref: dialogRef,
            tabIndex: -1,
            style: width ? { ...S.modal, width } : S.modal,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': title,
          },
          h(
            'div',
            { style: S.modalHeader },
            h(
              'div',
              { style: S.modalHeading },
              h('div', { style: S.modalTitle }, title),
              subtitle ? h('div', { style: S.modalSubtitle }, subtitle) : null,
            ),
            h(
              'button',
              { className: 'bt-modal-close', style: S.modalClose, onClick: onClose, 'aria-label': '关闭' },
              '×',
            ),
          ),
          h('div', { style: S.modalBody }, children),
          footer ? h('div', { style: S.modalFooter }, footer) : null,
        ),
      );
    }

    function Field({ label, hint, required, style, children }) {
      return h(
        'div',
        { style: style ? { ...S.field, ...style } : S.field },
        h(
          'label',
          { style: S.label },
          label,
          required ? h('span', { style: S.requiredMark }, '*') : null,
        ),
        children,
        hint ? h('div', { style: S.fieldHint }, hint) : null,
      );
    }

    const SETTINGS_TABS = [
      { id: 'messages', label: '消息设置', icon: 'message' },
      { id: 'about', label: '关于', icon: 'info' },
    ];
    const ABOUT_DESCRIPTION = '在 DSH Web GUI 中运行单聊与多 Agent 群聊：每个 Bot 自动拥有独立的单聊窗口；群聊支持自定义分组、拖拽排序与展开/收起；Bot 可配置自己的模型、BOT.md 人格和完整工具能力。';
    const ABOUT_FEATURES = ['单聊自动创建', '群聊分组与拖拽排序', '展开 / 收起', 'BOT.md 人格', '任务与评审'];

    function SettingsNavIcon({ name }) {
      const common = {
        width: 16,
        height: 16,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
        style: { display: 'block' },
      };
      if (name === 'info') {
        return h(
          'svg',
          common,
          h('circle', { cx: 12, cy: 12, r: 9 }),
          h('path', { d: 'M12 11v5.5' }),
          h('path', { d: 'M12 7.5h.01' }),
        );
      }
      return h(
        'svg',
        common,
        h('path', { d: 'M4 5.5h16v10.5H9l-4.5 3.5v-3.5H4z' }),
        h('path', { d: 'M8 10h8M8 12.8h5' }),
      );
    }

    function ChatSettingsDialog({ settings, onClose, onSaved, pluginInfo, initialTab = 'messages' }) {
      // Keep only local edits: untouched fields follow settings saved in other tabs.
      const [edits, setEdits] = React.useState({});
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const [tab, setTab] = React.useState(
        SETTINGS_TABS.some((item) => item.id === initialTab) ? initialTab : 'messages',
      );
      const current = normalizeChatDisplaySettings(settings);
      const draft = { ...current, ...edits };
      const dirty = CHAT_DISPLAY_FIELDS.some(({ key }) => draft[key] !== current[key]);
      const activeTabIndex = SETTINGS_TABS.findIndex((item) => item.id === tab);

      const save = async () => {
        if (busy || !dirty) return;
        setBusy(true);
        setError('');
        try {
          const response = await api.action('settings.chatDisplay.update', { settings: draft });
          onSaved(normalizeChatDisplaySettings(response.result.chatDisplaySettings));
        } catch (failure) {
          setError(String(failure && failure.message ? failure.message : failure));
        } finally {
          setBusy(false);
        }
      };

      const selectTab = (next) => {
        if (next === tab) return;
        setTab(next);
      };
      const onTabKeyDown = (event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault();
        let nextIndex;
        if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = SETTINGS_TABS.length - 1;
        else {
          const offset = event.key === 'ArrowDown' ? 1 : -1;
          nextIndex = (activeTabIndex + offset + SETTINGS_TABS.length) % SETTINGS_TABS.length;
        }
        selectTab(SETTINGS_TABS[nextIndex].id);
        const parent = event.currentTarget && event.currentTarget.parentElement;
        if (parent && typeof parent.querySelectorAll === 'function') {
          const buttons = parent.querySelectorAll('[role="tab"]');
          const target = buttons[nextIndex];
          if (target && typeof target.focus === 'function') target.focus();
        }
      };

      const preview = messageMetadataItems({
        author: { type: 'bot' }, status: 'done', model: '示例模型',
        usage: { inputTokens: 250, outputTokens: 3600 },
        generationStats: { scope: 'last-request', durationMs: 60000, outputTokens: 3600 },
      }, draft);

      const messagesPanel = h(
        'div',
        {
          key: 'messages',
          role: 'tabpanel',
          id: 'bt-settings-panel-messages',
          'aria-labelledby': 'bt-settings-tab-messages',
          style: S.settingsPanel,
        },
        h(
          'div',
          { style: S.settingsPanelHead },
          h('div', { style: S.settingsPanelTitle }, '消息设置'),
          h('div', { style: S.settingsPanelHint }, '控制 Bot 回复下方的模型、Token 与速度信息；保存后应用于所有群聊与单聊。'),
        ),
        CHAT_DISPLAY_FIELDS.map(field => h('div', { key: field.key, className: 'bt-settings-row', style: S.settingsRow },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { id: 'bt-display-' + field.key, style: { fontSize: 12.5, fontWeight: 600 } }, field.label),
            h('div', { style: S.fieldHint }, field.hint),
          ),
          h('div', { role: 'group', 'aria-labelledby': 'bt-display-' + field.key, style: S.settingsModes },
            CHAT_DISPLAY_MODES.map(mode => h('button', {
              key: mode.value, type: 'button', 'aria-pressed': draft[field.key] === mode.value, disabled: busy,
              style: { ...S.settingsMode, background: draft[field.key] === mode.value ? 'var(--bt-accent-soft)' : 'transparent', color: draft[field.key] === mode.value ? 'var(--bt-accent)' : 'var(--bt-text-2)', borderColor: draft[field.key] === mode.value ? 'var(--bt-accent-border)' : 'transparent', fontWeight: draft[field.key] === mode.value ? 600 : 400 },
              onClick: () => setEdits(value => {
                const next = { ...value };
                if (mode.value === current[field.key]) delete next[field.key];
                else next[field.key] = mode.value;
                return next;
              }),
            }, mode.label)),
          ),
        )),
        h('div', { style: { ...S.fieldHint, marginTop: 12 } }, '速度包含本次模型请求的等待与思考，不含工具执行；并非纯解码速度。缺少计时或 Token 数据的历史消息不显示速度。'),
        h('div', { style: { ...S.sectionHeader, marginTop: 18 } },
          h('div', { style: S.sectionTitle }, '效果预览'),
          h('span', { style: S.sectionMeta }, '示例数据 · 移入下方区域查看'),
        ),
        h('div', { className: 'bt-msg bt-settings-preview', tabIndex: 0, 'aria-label': '消息信息显示预览', style: { padding: 14, border: '1px solid var(--bt-border)', borderRadius: 12, background: 'var(--bt-bg-subtle)' } },
          h('div', { style: { fontSize: 12.5, color: 'var(--bt-text-2)' } }, '这里是 Bot 的回复内容。'),
          preview.length ? h('div', { style: S.msgFooter(false) }, renderMessageMetadata(preview))
            : h('div', { style: S.fieldHint }, '已隐藏全部消息信息'),
        ),
        error ? h('div', { role: 'alert', style: { ...S.fieldHint, color: 'var(--bt-danger-text)', marginTop: 12 } }, `保存失败：${error}`) : null,
      );

      const info = pluginInfo && typeof pluginInfo === 'object' ? pluginInfo : {};
      const version = typeof info.version === 'string' && info.version ? info.version : '0.1.0';
      const packageName = typeof info.packageName === 'string' && info.packageName ? info.packageName : 'dsh-bot-team';
      const author = typeof info.author === 'string' && info.author ? info.author : 'shper';
      const metaRows = [
        { label: '版本', value: version },
        { label: '包名', value: packageName },
        { label: '开发者', value: author },
      ];
      const aboutPanel = h(
        'div',
        {
          key: 'about',
          role: 'tabpanel',
          id: 'bt-settings-panel-about',
          'aria-labelledby': 'bt-settings-tab-about',
          style: S.settingsPanel,
        },
        h(
          'div',
          { style: S.settingsPanelHead },
          h('div', { style: S.settingsPanelTitle }, '关于'),
          h('div', { style: S.settingsPanelHint }, '插件说明、版本号与开发者信息。'),
        ),
        h(
          'div',
          { style: S.aboutHero },
          h('div', { style: S.aboutLogo }, h(PanelIcon, { size: 30 })),
          h(
            'div',
            { style: { minWidth: 0 } },
            h('div', { style: S.aboutName }, 'Bot Team'),
            h('div', { style: S.aboutTagline }, '单聊 · 多 Agent 群聊 · 自定义分组'),
          ),
        ),
        h(
          'div',
          { style: S.aboutCard },
          h('div', { style: S.aboutDescription }, ABOUT_DESCRIPTION),
          h('div', { style: S.aboutFeatures }, ABOUT_FEATURES.map(label => h('span', { key: label, style: S.toolChip }, label))),
        ),
        h(
          'div',
          { style: S.aboutCard },
          metaRows.map((row, index) => h(
            'div',
            {
              key: row.label,
              style: {
                ...S.aboutRow,
                borderBottom: index < metaRows.length - 1 ? '1px solid var(--bt-border)' : 'none',
              },
            },
            h('span', { style: S.aboutLabel }, row.label),
            h('span', { style: S.aboutValue, title: row.value }, row.value),
          )),
        ),
        h(
          'div',
          { style: S.aboutNote },
          '数据保存在 $DSH_HOME/storages/bot_team；Bot 会话是真实 DSH session。人格文件在 $DSH_HOME/dsh-bot-team/bots/<botId>/BOT.md；单聊工作目录 $DSH_HOME/dsh-bot-team/direct/<botId>/，群聊工作目录 $DSH_HOME/dsh-bot-team/groups/<groupId>/。',
        ),
      );

      const footer = tab === 'messages'
        ? h(React.Fragment, null,
            h('button', { key: 'reset', type: 'button', style: { ...S.smallBtn, marginRight: 'auto' }, disabled: busy, onClick: () => { setEdits({ ...DEFAULT_CHAT_DISPLAY_SETTINGS }); setError(''); } }, '恢复默认'),
            h('button', { key: 'cancel', type: 'button', style: S.smallBtn, disabled: busy, onClick: onClose }, '取消'),
            h('button', { key: 'save', type: 'button', style: S.primaryBtn, disabled: busy || !dirty, onClick: save }, busy ? '保存中…' : '保存设置'),
          )
        : h('button', { key: 'close', type: 'button', style: S.primaryBtn, disabled: busy, onClick: onClose }, '关闭');

      return h(
        Modal,
        {
          title: '设置',
          width: 860,
          onClose: () => { if (!busy) onClose(); },
          footer,
        },
        h(
          'div',
          { className: 'bt-settings-shell', style: S.settingsShell },
          h(
            'nav',
            { className: 'bt-settings-nav', style: S.settingsNav, role: 'tablist', 'aria-label': '设置模块', 'aria-orientation': 'vertical' },
            SETTINGS_TABS.map(item => h(
              'button',
              {
                key: item.id,
                type: 'button',
                role: 'tab',
                id: `bt-settings-tab-${item.id}`,
                className: 'bt-settings-nav-item',
                'aria-selected': tab === item.id,
                'aria-controls': `bt-settings-panel-${item.id}`,
                tabIndex: tab === item.id ? 0 : -1,
                style: S.settingsNavItem(tab === item.id),
                onClick: () => selectTab(item.id),
                onKeyDown: onTabKeyDown,
              },
              h('span', { style: S.settingsNavIcon(tab === item.id) }, h(SettingsNavIcon, { name: item.icon })),
              h('span', null, item.label),
            )),
          ),
          h(
            'div',
            { style: S.settingsContent },
            tab === 'messages' ? messagesPanel : aboutPanel,
          ),
        ),
      );
    }

    // ── sidebar item menu ─────────────────────────────────────────────────
    /**
     * One fixed-position menu for sidebar rows/folders. It is rendered from
     * GroupList state (not inside the scrolled list) so it is never clipped.
     */
    function SidebarMenu({ menu, items, onClose }) {
      const height = 10
        + items.reduce((sum, item) => sum + (item.kind === 'separator' ? 9 : item.kind === 'hint' ? 20 : 30), 0);
      const viewportWidth = typeof window !== 'undefined' && Number.isFinite(window.innerWidth) ? window.innerWidth : 0;
      const viewportHeight = typeof window !== 'undefined' && Number.isFinite(window.innerHeight) ? window.innerHeight : 0;
      const placement = placeMessageMenu(menu.x, menu.y, viewportWidth, viewportHeight, 196, height);
      const menuRef = React.useRef(null);

      React.useEffect(() => {
        if (typeof window === 'undefined' || typeof document === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
        const node = menuRef.current;
        const previousFocus = document.activeElement;
        if (node && typeof node.querySelector === 'function') {
          const first = node.querySelector('[role="menuitem"]:not([disabled])');
          if (first && typeof first.focus === 'function') first.focus();
        }
        const close = () => {
          if (typeof onClose === 'function') onClose();
        };
        const inside = (target) => !!(node && target && typeof node.contains === 'function' && node.contains(target));
        const onPointerDown = (event) => {
          if (!inside(event.target)) close();
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            close();
          }
        };
        const onScrollOutside = (event) => {
          if (!inside(event.target)) close();
        };
        document.addEventListener('mousedown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('wheel', onScrollOutside, true);
        document.addEventListener('touchmove', onScrollOutside, true);
        window.addEventListener('resize', close);
        window.addEventListener('blur', close);
        return () => {
          document.removeEventListener('mousedown', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown);
          document.removeEventListener('wheel', onScrollOutside, true);
          document.removeEventListener('touchmove', onScrollOutside, true);
          window.removeEventListener('resize', close);
          window.removeEventListener('blur', close);
          if (previousFocus && previousFocus !== document.body && previousFocus.isConnected && typeof previousFocus.focus === 'function') {
            previousFocus.focus();
          }
        };
      }, []);

      const onMenuKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          if (typeof onClose === 'function') onClose();
          return;
        }
        if (event.key === 'Tab') {
          if (typeof onClose === 'function') onClose();
          return;
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        if (typeof document === 'undefined') return;
        const node = menuRef.current;
        if (!node || typeof node.querySelectorAll !== 'function') return;
        const buttons = Array.from(node.querySelectorAll('[role="menuitem"]:not([disabled])'));
        if (buttons.length === 0) return;
        event.preventDefault();
        const current = buttons.indexOf(document.activeElement);
        const next = event.key === 'ArrowDown'
          ? (current + 1) % buttons.length
          : (current - 1 + buttons.length) % buttons.length;
        if (buttons[next] && typeof buttons[next].focus === 'function') buttons[next].focus();
      };

      return h(
        React.Fragment,
        null,
        h('div', { className: 'bt-menu-backdrop', onClick: onClose }),
        h(
          'div',
          {
            ref: menuRef,
            className: 'bt-menu bt-sidebar-menu',
            role: 'menu',
            'aria-label': '会话操作',
            style: { ...S.sidebarMenu, left: placement.left, top: placement.top },
            onKeyDown: onMenuKeyDown,
            onContextMenu: (event) => event.preventDefault(),
          },
          items.map((item, index) => {
            if (item.kind === 'separator') {
              return h('div', {
                key: item.key || `sep-${index}`,
                className: 'bt-msg-menu-sep',
                role: 'separator',
                style: S.messageMenuSeparator,
              });
            }
            if (item.kind === 'hint') {
              return h('div', {
                key: item.key || `hint-${index}`,
                className: 'bt-sidebar-menu-hint',
                style: S.sidebarMenuHint,
              }, item.label);
            }
            return h(
              'button',
              {
                key: item.key,
                type: 'button',
                role: 'menuitem',
                className: `bt-msg-menu-item${item.danger ? ' bt-msg-menu-danger' : ''}`,
                style: S.sidebarMenuItem,
                disabled: item.disabled === true,
                'aria-disabled': item.disabled === true ? 'true' : undefined,
                title: item.title || item.label,
                onClick: () => {
                  if (typeof onClose === 'function') onClose();
                  if (typeof item.onSelect === 'function') item.onSelect();
                },
              },
              h('span', { style: S.sidebarMenuLabel }, item.label),
            );
          }),
        ),
      );
    }

    function SidebarChevron({ collapsed }) {
      return h(
        'svg',
        {
          width: 10,
          height: 10,
          viewBox: '0 0 12 12',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
          style: S.sectionChevron(collapsed),
        },
        h('path', { d: 'M3 4.5 6 7.5 9 4.5' }),
      );
    }

    function SidebarActionIcon({ name }) {
      const paths = name === 'folder-plus'
        ? [h('path', { key: 'folder', d: 'M2 4.5A1.5 1.5 0 0 1 3.5 3h1.9l1.2 1.4h3.9A1.5 1.5 0 0 1 12 5.9v4.6A1.5 1.5 0 0 1 10.5 12h-7A1.5 1.5 0 0 1 2 10.5z' }), h('path', { key: 'plus', d: 'M8 7.6v2.8M6.6 9h2.8' })]
        : [h('path', { key: 'plus', d: 'M8 3.5v9M3.5 8h9' })];
      return h(
        'svg',
        {
          width: 13,
          height: 13,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
          style: { display: 'block', pointerEvents: 'none' },
        },
        paths,
      );
    }

    function GroupList({
      state,
      dispatch,
      onCreate,
      onCreateBot,
      onCreateFolder,
      onOpenDirect,
      onEditGroup,
      onDeleteGroup,
      onEditBot,
      onViewSession,
      onCreateGroupInFolder,
      onRenameFolder,
      onDeleteFolder,
      onReorderGroups,
      onReorderFolders,
    }) {
      const collapsed = state.sidebarCollapsed === true;
      const sections = state.sectionsCollapsed || {};
      const model = buildSidebarModel(state);
      const schemaVersion = Number(state.config && state.config.schemaVersion);
      // The page can be refreshed before the Host half is re-enabled. Say so
      // instead of offering single chats that the old Host cannot create yet.
      const hostLayoutReady = !Number.isFinite(schemaVersion) || schemaVersion >= 6;
      const [drag, setDrag] = React.useState(null);
      const [drop, setDrop] = React.useState(null);
      const [menu, setMenu] = React.useState(null);

      const isCollapsed = (key) => sections[key] === true;
      const toggleSection = (key) => dispatch({ type: 'sectionCollapsed', key, collapsed: !isCollapsed(key) });
      const selectGroup = (group) => dispatch({ type: 'selectGroup', groupId: group.groupId });
      const onGroupKeyDown = (group) => (event) => {
        // Nested row-menu buttons own their own Enter/Space; do not also select
        // the conversation when the menu button has focus.
        if (event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        selectGroup(group);
      };
      const groupTooltip = (group) => {
        const last = group.lastMessage;
        if (!last) return group.topic ? `${group.title}\n${cleanPreview(group.topic, 80)}` : group.title;
        const author = String(last.authorName || '').trim();
        const prefix = author === '用户' ? '我：' : author && author !== '系统' ? `${author}：` : '';
        return `${group.title}\n${prefix}${cleanPreview(last.text, 80) || '[消息]'}`;
      };
      const directTooltip = (entry) => {
        const last = entry.group && entry.group.lastMessage;
        if (!last) return `${entry.bot.name}\n开始单聊`;
        const prefix = String(last.authorName || '').trim() === '用户' ? '我：' : '';
        return `${entry.bot.name}（单聊）\n${prefix}${cleanPreview(last.text, 80) || '[消息]'}`;
      };

      const openMenu = (event, type, id) => {
        if (!event) return;
        if (typeof event.preventDefault === 'function') event.preventDefault();
        if (typeof event.stopPropagation === 'function') event.stopPropagation();
        const rect = event.currentTarget && typeof event.currentTarget.getBoundingClientRect === 'function'
          ? event.currentTarget.getBoundingClientRect()
          : null;
        const x = Number.isFinite(event.clientX) && event.clientX > 0
          ? event.clientX
          : rect ? rect.left + Math.min(rect.width, 40) : 20;
        const y = Number.isFinite(event.clientY) && event.clientY > 0
          ? event.clientY
          : rect ? rect.bottom - 4 : 20;
        setMenu({ type, id, x, y });
      };
      const closeMenu = () => setMenu(null);

      const applyGroupReorder = (payload) => {
        if (payload && typeof onReorderGroups === 'function') onReorderGroups(payload);
      };
      const applyFolderReorder = (payload) => {
        if (payload && typeof onReorderFolders === 'function') onReorderFolders(payload);
      };
      const revealSection = (key) => {
        if (!isCollapsed(key)) return;
        dispatch({ type: 'sectionCollapsed', key, collapsed: false });
      };
      const revealFolder = (folderId) => {
        if (folderId) revealSection(sectionFolderKey(folderId));
        else revealSection(SECTION_UNGROUPED);
        revealSection(SECTION_GROUPS);
      };
      const moveGroupTo = (groupId, folderId) => {
        const payload = computeGroupDrop(model, groupId, folderId ? { folderId } : { ungrouped: true }, 'end');
        if (payload) revealFolder(folderId);
        applyGroupReorder(payload);
      };

      // ── drag & drop ────────────────────────────────────────────────────
      const startGroupDrag = (event, group) => {
        setDrag({ kind: 'group', id: group.groupId });
        setDrop(null);
        if (event.dataTransfer) {
          try {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', group.groupId);
          } catch {
            /* some webviews restrict dataTransfer during synthetic drags */
          }
        }
      };
      const startFolderDrag = (event, folderId) => {
        setDrag({ kind: 'folder', id: folderId });
        setDrop(null);
        if (event.dataTransfer) {
          try {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', folderId);
          } catch {
            /* ignore */
          }
        }
      };
      const endDrag = () => {
        setDrag(null);
        setDrop(null);
      };
      const dragOverGroupRow = (event, group) => {
        if (!drag || drag.kind !== 'group') return;
        const destination = findSidebarGroup(model, group.groupId);
        const source = findSidebarGroup(model, drag.id);
        if (!destination || !source || source.kind !== destination.kind) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        const rect = event.currentTarget && typeof event.currentTarget.getBoundingClientRect === 'function'
          ? event.currentTarget.getBoundingClientRect()
          : null;
        const edge = rect && event.clientY - rect.top > rect.height / 2 ? 'after' : 'before';
        if (!drop || drop.type !== 'group' || drop.groupId !== group.groupId || drop.edge !== edge) {
          setDrop({ type: 'group', groupId: group.groupId, edge });
        }
      };
      const dropOnGroupRow = (event, group) => {
        event.preventDefault();
        if (!drag || drag.kind !== 'group') return endDrag();
        const rect = event.currentTarget && typeof event.currentTarget.getBoundingClientRect === 'function'
          ? event.currentTarget.getBoundingClientRect()
          : null;
        const edge = rect && event.clientY - rect.top > rect.height / 2 ? 'after' : 'before';
        const payload = computeGroupDrop(model, drag.id, { groupId: group.groupId }, edge);
        endDrag();
        applyGroupReorder(payload);
      };
      const dragOverFolderHead = (event, folderId) => {
        if (!drag) return;
        if (drag.kind === 'group') {
          const source = findSidebarGroup(model, drag.id);
          if (!source || source.kind !== 'group') return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
          const next = folderId ? { type: 'folder-target', folderId } : { type: 'ungrouped-target' };
          if (!drop || drop.type !== next.type || drop.folderId !== folderId) setDrop(next);
          return;
        }
        if (drag.kind === 'folder' && folderId) {
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
          const rect = event.currentTarget && typeof event.currentTarget.getBoundingClientRect === 'function'
            ? event.currentTarget.getBoundingClientRect()
            : null;
          const edge = rect && event.clientY - rect.top > rect.height / 2 ? 'after' : 'before';
          if (!drop || drop.type !== 'folder' || drop.folderId !== folderId || drop.edge !== edge) {
            setDrop({ type: 'folder', folderId, edge });
          }
        }
      };
      const dropOnFolderHead = (event, folderId) => {
        event.preventDefault();
        if (!drag) return endDrag();
        if (drag.kind === 'group') {
          const payload = computeGroupDrop(model, drag.id, folderId ? { folderId } : { ungrouped: true }, 'end');
          if (payload) revealFolder(folderId);
          endDrag();
          applyGroupReorder(payload);
          return;
        }
        if (drag.kind === 'folder' && folderId) {
          const rect = event.currentTarget && typeof event.currentTarget.getBoundingClientRect === 'function'
            ? event.currentTarget.getBoundingClientRect()
            : null;
          const edge = rect && event.clientY - rect.top > rect.height / 2 ? 'after' : 'before';
          const payload = computeFolderDrop(model, drag.id, folderId, edge);
          endDrag();
          applyFolderReorder(payload);
        }
        endDrag();
      };

      // ── menus ──────────────────────────────────────────────────────────
      const groupMenuItems = (group) => {
        const scope = findSidebarGroup(model, group.groupId);
        const ids = scope ? scopeGroupIds(model, scope.kind, scope.folderId) : [];
        const index = ids.indexOf(group.groupId);
        const currentFolderId = scope ? scope.folderId : null;
        const items = [
          { key: 'edit', label: '编辑群信息', onSelect: () => onEditGroup && onEditGroup(group) },
          { kind: 'separator', key: 'sep-a' },
          { kind: 'hint', key: 'move-hint', label: '移动到分组' },
          {
            key: 'move-none',
            label: currentFolderId ? '未分组' : '未分组 ✓',
            disabled: !hostLayoutReady || !currentFolderId,
            onSelect: () => moveGroupTo(group.groupId, null),
          },
        ];
        for (const entry of model.folders) {
          const folder = entry.folder;
          const active = currentFolderId === folder.folderId;
          items.push({
            key: `move-${folder.folderId}`,
            label: `${active ? '✓ ' : ''}${folder.title}`,
            disabled: !hostLayoutReady || active,
            onSelect: () => moveGroupTo(group.groupId, folder.folderId),
          });
        }
        items.push(
          { key: 'new-folder', label: '＋ 新建分组…', disabled: !hostLayoutReady, onSelect: () => onCreateFolder && onCreateFolder() },
          { kind: 'separator', key: 'sep-b' },
          {
            key: 'up',
            label: '上移',
            disabled: !hostLayoutReady || index <= 0,
            onSelect: () => applyGroupReorder(stepGroupOrder(model, group.groupId, 'up')),
          },
          {
            key: 'down',
            label: '下移',
            disabled: !hostLayoutReady || index < 0 || index >= ids.length - 1,
            onSelect: () => applyGroupReorder(stepGroupOrder(model, group.groupId, 'down')),
          },
          { kind: 'separator', key: 'sep-c' },
          { key: 'delete', label: '删除群', danger: true, onSelect: () => onDeleteGroup && onDeleteGroup(group) },
        );
        return items;
      };
      const directMenuItems = (entry) => {
        const index = model.direct.findIndex((candidate) => candidate.bot.botId === entry.bot.botId);
        const membership = entry.group
          ? state.members.find((member) => member.groupId === entry.group.groupId) || null
          : null;
        return [
          {
            key: 'open',
            label: entry.group ? '打开单聊' : '创建单聊',
            onSelect: () => onOpenDirect && onOpenDirect(entry.bot.botId, entry.group),
          },
          { key: 'edit', label: '编辑 Bot', onSelect: () => onEditBot && onEditBot(entry.bot) },
          {
            key: 'session',
            label: '查看 Bot 会话',
            disabled: !membership,
            onSelect: () => membership && onViewSession && onViewSession(membership),
          },
          { kind: 'separator', key: 'sep-a' },
          {
            key: 'up',
            label: '上移',
            disabled: !hostLayoutReady || !entry.group || index <= 0,
            onSelect: () => entry.group && applyGroupReorder(stepGroupOrder(model, entry.group.groupId, 'up')),
          },
          {
            key: 'down',
            label: '下移',
            disabled: !hostLayoutReady || !entry.group || index < 0 || index >= model.direct.length - 1,
            onSelect: () => entry.group && applyGroupReorder(stepGroupOrder(model, entry.group.groupId, 'down')),
          },
        ];
      };
      const folderMenuItems = (folder) => {
        const index = model.folders.findIndex((entry) => entry.folder.folderId === folder.folderId);
        return [
          {
            key: 'new-group',
            label: '在此分组新建群',
            onSelect: () => onCreateGroupInFolder && onCreateGroupInFolder(folder.folderId),
          },
          { key: 'rename', label: '重命名分组', onSelect: () => onRenameFolder && onRenameFolder(folder) },
          { key: 'delete', label: '删除分组', danger: true, onSelect: () => onDeleteFolder && onDeleteFolder(folder) },
          { kind: 'separator', key: 'sep-a' },
          {
            key: 'up',
            label: '分组上移',
            disabled: index <= 0,
            onSelect: () => applyFolderReorder(stepFolderOrder(model, folder.folderId, 'up')),
          },
          {
            key: 'down',
            label: '分组下移',
            disabled: index < 0 || index >= model.folders.length - 1,
            onSelect: () => applyFolderReorder(stepFolderOrder(model, folder.folderId, 'down')),
          },
        ];
      };
      const menuItems = menu
        ? menu.type === 'group'
          ? (() => {
              const group = state.groups.find((candidate) => candidate.groupId === menu.id);
              return group ? groupMenuItems(group) : [];
            })()
          : menu.type === 'direct'
            ? directMenuItems(model.direct.find((entry) => entry.bot.botId === menu.id) || { bot: { name: '' }, group: null })
            : folderMenuItems(model.folders.find((entry) => entry.folder.folderId === menu.id)?.folder || { folderId: menu.id, title: '' })
        : [];

      // ── row renderers ──────────────────────────────────────────────────
      const rowMenuButton = (label, onClick, extraStyle) =>
        h(
          'button',
          {
            type: 'button',
            className: 'bt-row-menu',
            style: { ...S.rowMenu, ...(extraStyle || null) },
            title: label,
            'aria-label': label,
            onClick: (event) => {
              event.stopPropagation();
              onClick(event);
            },
            onMouseDown: (event) => event.stopPropagation(),
          },
          '···',
        );

      const renderGroupRow = (group) => {
        const active = group.groupId === state.activeGroupId;
        const last = group.lastMessage;
        const author = last ? String(last.authorName || '').trim() : '';
        const prefix = author === '用户' ? '我：' : author && author !== '系统' ? `${author}：` : '';
        const body = last ? cleanPreview(last.text, 70) : '';
        const preview = last ? `${prefix}${body || '[消息]'}` : group.topic ? cleanPreview(group.topic, 70) : '暂无消息';
        const memberCount = Array.isArray(group.memberIds) ? group.memberIds.length : 0;
        const isDragging = drag && drag.kind === 'group' && drag.id === group.groupId;
        const edge = drop && drop.type === 'group' && drop.groupId === group.groupId ? drop.edge : null;
        return h(
          'div',
          {
            key: group.groupId,
            className: 'bt-group-item',
            role: 'button',
            tabIndex: 0,
            draggable: hostLayoutReady,
            'data-active': active ? 'true' : 'false',
            'data-group-id': group.groupId,
            'data-drop': edge || undefined,
            'data-dragging': isDragging ? 'true' : undefined,
            'aria-current': active ? 'true' : undefined,
            style: {
              ...S.groupItem(active),
              ...(edge === 'before' ? S.dropBefore : edge === 'after' ? S.dropAfter : null),
              ...(isDragging ? S.dragSource : null),
            },
            onClick: () => selectGroup(group),
            onKeyDown: onGroupKeyDown(group),
            onContextMenu: (event) => openMenu(event, 'group', group.groupId),
            onDragStart: (event) => startGroupDrag(event, group),
            onDragOver: (event) => dragOverGroupRow(event, group),
            onDrop: (event) => dropOnGroupRow(event, group),
            onDragEnd: endDrag,
          },
          h(GroupAvatar, { group, size: 38 }),
          h(
            'div',
            { style: S.groupItemBody },
            h(
              'div',
              { style: S.groupItemTop },
              h('span', { style: S.groupItemTitle, title: group.title }, group.title),
              h('span', { style: S.groupItemTime }, formatListTime(last && last.createdAt)),
            ),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 } },
              group.running ? h('span', { style: { ...S.dot('#22c55e', 'running'), width: 6, height: 6 } }) : null,
              h('span', { style: S.groupItemPreview }, preview),
              !group.running && memberCount > 0
                ? h('span', { style: { fontSize: 10, color: 'var(--bt-text-3)', flex: '0 0 auto' } }, `${memberCount} 人`)
                : null,
            ),
          ),
          rowMenuButton(`${group.title} 操作`, (event) => openMenu(event, 'group', group.groupId)),
        );
      };

      const renderDirectRow = (entry) => {
        const active = entry.group && entry.group.groupId === state.activeGroupId;
        const last = entry.group && entry.group.lastMessage;
        const mine = last && String(last.authorName || '').trim() === '用户';
        const body = last ? cleanPreview(last.text, 70) : '';
        const preview = last ? `${mine ? '我：' : ''}${body || '[消息]'}` : '开始单聊';
        const isDragging = drag && drag.kind === 'group' && entry.group && drag.id === entry.group.groupId;
        const edge = drop && drop.type === 'group' && entry.group && drop.groupId === entry.group.groupId ? drop.edge : null;
        return h(
          'div',
          {
            key: entry.bot.botId,
            className: 'bt-group-item bt-direct-item',
            role: 'button',
            tabIndex: 0,
            draggable: !!entry.group,
            'data-active': active ? 'true' : 'false',
            'data-bot-id': entry.bot.botId,
            'data-drop': edge || undefined,
            'data-dragging': isDragging ? 'true' : undefined,
            'aria-label': `${entry.bot.name}（单聊）${entry.group && entry.group.running ? '（回复中）' : ''}`,
            'aria-current': active ? 'true' : undefined,
            title: directTooltip(entry),
            style: {
              ...S.groupItem(active),
              ...(edge === 'before' ? S.dropBefore : edge === 'after' ? S.dropAfter : null),
              ...(isDragging ? S.dragSource : null),
            },
            onClick: () => onOpenDirect && onOpenDirect(entry.bot.botId, entry.group),
            onKeyDown: (event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              if (onOpenDirect) onOpenDirect(entry.bot.botId, entry.group);
            },
            onContextMenu: (event) => openMenu(event, 'direct', entry.bot.botId),
            onDragStart: (event) => entry.group && startGroupDrag(event, entry.group),
            onDragOver: (event) => entry.group && dragOverGroupRow(event, entry.group),
            onDrop: (event) => entry.group && dropOnGroupRow(event, entry.group),
            onDragEnd: endDrag,
          },
          h(Avatar, { bot: entry.bot, size: 38 }),
          h(
            'div',
            { style: S.groupItemBody },
            h(
              'div',
              { style: S.groupItemTop },
              h('span', { style: S.groupItemTitle, title: entry.bot.name }, entry.bot.name),
              h('span', { style: S.groupItemTime }, formatListTime(last && last.createdAt)),
            ),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 } },
              entry.group && entry.group.running
                ? h('span', { style: { ...S.dot('#22c55e', 'running'), width: 6, height: 6 } })
                : null,
              h('span', { style: { ...S.groupItemPreview }, }, preview),
            ),
          ),
          rowMenuButton(`${entry.bot.name} 单聊操作`, (event) => openMenu(event, 'direct', entry.bot.botId)),
        );
      };

      const sectionHeader = (key, label, count, actions) =>
        h(
          'div',
          { className: 'bt-section-head', style: S.sectionHead, 'data-section-key': key },
          h(
            'button',
            {
              type: 'button',
              className: 'bt-section-toggle',
              style: S.sectionToggle,
              title: isCollapsed(key) ? `展开${label}` : `收起${label}`,
              'aria-label': isCollapsed(key) ? `展开${label}` : `收起${label}`,
              'aria-expanded': !isCollapsed(key),
              'aria-controls': `bt-section-body-${key}`,
              onClick: () => toggleSection(key),
            },
            h(SidebarChevron, { collapsed: isCollapsed(key) }),
            h('span', { style: S.sectionLabel }, label),
            count > 0 ? h('span', { style: S.sectionCount }, count) : null,
          ),
          h('div', { style: S.sectionActions }, actions),
        );

      const sectionAction = (label, icon, onClick) =>
        h(
          'button',
          {
            type: 'button',
            className: 'bt-section-action',
            style: S.sectionAction,
            title: label,
            'aria-label': label,
            onClick,
          },
          h(SidebarActionIcon, { name: icon }),
        );

      const renderFolder = (folderEntry) => {
        const folder = folderEntry.folder;
        const key = sectionFolderKey(folder.folderId);
        const folderCollapsed = isCollapsed(key);
        const isDragging = drag && drag.kind === 'folder' && drag.id === folder.folderId;
        const folderEdge = drop && drop.type === 'folder' && drop.folderId === folder.folderId ? drop.edge : null;
        const groupTarget = drop && drop.type === 'folder-target' && drop.folderId === folder.folderId;
        return h(
          'div',
          {
            key: folder.folderId,
            className: 'bt-folder',
            style: S.folder,
            'data-folder-id': folder.folderId,
            'data-dragging': isDragging ? 'true' : undefined,
          },
          h(
            'div',
            {
              className: 'bt-folder-head',
              style: { ...S.folderHead, ...(groupTarget ? S.dropFolder : null), ...(isDragging ? S.dragSource : null) },
              draggable: true,
              'data-drop': groupTarget || folderEdge ? 'true' : undefined,
              onDragStart: (event) => startFolderDrag(event, folder.folderId),
              onDragOver: (event) => dragOverFolderHead(event, folder.folderId),
              onDrop: (event) => dropOnFolderHead(event, folder.folderId),
              onDragEnd: endDrag,
            },
            h(
              'button',
              {
                type: 'button',
                className: 'bt-folder-toggle',
                style: S.folderToggle,
                title: folderCollapsed ? `展开分组 ${folder.title}` : `收起分组 ${folder.title}`,
                'aria-label': folderCollapsed ? `展开分组 ${folder.title}` : `收起分组 ${folder.title}`,
                'aria-expanded': !folderCollapsed,
                'aria-controls': `bt-folder-body-${folder.folderId}`,
                onClick: () => toggleSection(key),
              },
              h(SidebarChevron, { collapsed: folderCollapsed }),
              h(
                'svg',
                {
                  viewBox: '0 0 16 16',
                  width: 13,
                  height: 13,
                  fill: 'none',
                  stroke: 'currentColor',
                  strokeWidth: 1.4,
                  strokeLinecap: 'round',
                  strokeLinejoin: 'round',
                  'aria-hidden': true,
                  focusable: false,
                  style: S.folderIcon,
                },
                h('path', { d: 'M2 4.5A1.5 1.5 0 0 1 3.5 3h2l1.3 1.5h4.7A1.5 1.5 0 0 1 13 6v4.5A1.5 1.5 0 0 1 11.5 12h-8A1.5 1.5 0 0 1 2 10.5z' }),
              ),
              h('span', { style: S.folderName, title: folder.title }, folder.title),
              h('span', { style: S.folderCount }, folderEntry.groups.length),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'bt-folder-menu',
                style: S.folderMenu,
                title: `分组 ${folder.title} 操作`,
                'aria-label': `分组 ${folder.title} 操作`,
                onClick: (event) => openMenu(event, 'folder', folder.folderId),
              },
              '···',
            ),
          ),
          h(
            'div',
            {
              id: `bt-folder-body-${folder.folderId}`,
              className: 'bt-folder-body',
              style: { ...S.folderBody, display: folderCollapsed ? 'none' : undefined },
            },
            folderEntry.groups.length === 0
              ? h('div', { style: S.folderEmpty }, '分组内还没有群')
              : folderEntry.groups.map(renderGroupRow),
          ),
        );
      };

      const renderUngrouped = () => {
        const bodyCollapsed = isCollapsed(SECTION_UNGROUPED);
        const groupTarget = drop && drop.type === 'ungrouped-target';
        return h(
          'div',
          { key: '__ungrouped', className: 'bt-folder', style: S.folder },
          h(
            'div',
            {
              className: 'bt-folder-head',
              style: { ...S.folderHead, ...(groupTarget ? S.dropFolder : null) },
              'data-drop': groupTarget ? 'true' : undefined,
              onDragOver: (event) => dragOverFolderHead(event, null),
              onDrop: (event) => dropOnFolderHead(event, null),
            },
            h(
              'button',
              {
                type: 'button',
                className: 'bt-folder-toggle',
                style: { ...S.folderToggle, fontWeight: 500, color: 'var(--bt-text-3)' },
                title: bodyCollapsed ? '展开未分组' : '收起未分组',
                'aria-label': bodyCollapsed ? '展开未分组' : '收起未分组',
                'aria-expanded': !bodyCollapsed,
                'aria-controls': 'bt-section-body-ungrouped',
                onClick: () => toggleSection(SECTION_UNGROUPED),
              },
              h(SidebarChevron, { collapsed: bodyCollapsed }),
              h('span', { style: S.folderName }, '未分组'),
              h('span', { style: S.folderCount }, model.ungrouped.length),
            ),
          ),
          h(
            'div',
            {
              id: 'bt-section-body-ungrouped',
              className: 'bt-folder-body',
              style: { ...S.folderBody, display: bodyCollapsed ? 'none' : undefined },
            },
            model.ungrouped.length === 0
              ? h('div', { style: S.folderEmpty }, '拖动群到这里可移出分组')
              : model.ungrouped.map(renderGroupRow),
          ),
        );
      };

      const directSection = h(
        'div',
        { className: 'bt-sidebar-section', style: S.section, 'data-section': SECTION_DIRECT },
        sectionHeader(SECTION_DIRECT, '单聊', model.direct.length, [
          sectionAction('新建 Bot', 'plus', () => onCreateBot && onCreateBot()),
        ]),
        h(
          'div',
          {
            id: `bt-section-body-${SECTION_DIRECT}`,
            className: 'bt-section-body',
            style: { ...S.sectionBody, display: isCollapsed(SECTION_DIRECT) ? 'none' : undefined },
          },
          !hostLayoutReady
            ? h(
                'div',
                { className: 'bt-host-warning', style: { fontSize: 11, color: 'var(--bt-text-3)', padding: '4px 8px 8px', lineHeight: 1.7 } },
                'Host 仍是旧版本：重启 DSH（或重新启用 Bot Team）后，单聊与分组才会生效。',
              )
            : model.direct.length === 0
              ? h('div', { style: { fontSize: 11.5, color: 'var(--bt-text-3)', padding: '4px 8px 8px', lineHeight: 1.7 } }, '还没有 Bot。新建一个 Bot，就会自动拥有一个单聊窗口。')
              : model.direct.map(renderDirectRow),
        ),
      );

      const groupsSection = h(
        'div',
        { className: 'bt-sidebar-section', style: S.section, 'data-section': SECTION_GROUPS },
        sectionHeader(SECTION_GROUPS, '群聊', model.groupCount, [
          sectionAction('新建群 / 话题', 'plus', () => onCreate && onCreate()),
          hostLayoutReady ? sectionAction('新建分组', 'folder-plus', () => onCreateFolder && onCreateFolder()) : null,
        ].filter(Boolean)),
        h(
          'div',
          {
            id: `bt-section-body-${SECTION_GROUPS}`,
            className: 'bt-section-body',
            style: { ...S.sectionBody, display: isCollapsed(SECTION_GROUPS) ? 'none' : undefined },
          },
          model.folders.map(renderFolder),
          model.folders.length > 0 ? renderUngrouped() : model.ungrouped.map(renderGroupRow),
          model.groupCount === 0
            ? h(
                'div',
                { style: { fontSize: 11.5, color: 'var(--bt-text-3)', padding: '4px 8px 8px', lineHeight: 1.7 } },
                '还没有群。新建一个群/话题，然后把 Bot 拉进来。',
              )
            : null,
        ),
      );

      const list = collapsed
        ? h(
            'div',
            { style: S.groupRail, className: 'bt-group-rail' },
            model.direct.map((entry) =>
              h(
                'div',
                {
                  key: `direct-${entry.bot.botId}`,
                  className: 'bt-group-item bt-group-rail-item bt-direct-rail-item',
                  role: 'button',
                  tabIndex: 0,
                  'data-active': entry.group && entry.group.groupId === state.activeGroupId ? 'true' : 'false',
                  'aria-current': entry.group && entry.group.groupId === state.activeGroupId ? 'true' : undefined,
                  'aria-label': `${entry.bot.name}（单聊）${entry.group && entry.group.running ? '（回复中）' : ''}`,
                  title: directTooltip(entry),
                  style: S.railItem(!!(entry.group && entry.group.groupId === state.activeGroupId)),
                  onClick: () => onOpenDirect && onOpenDirect(entry.bot.botId, entry.group),
                  onKeyDown: (event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    if (onOpenDirect) onOpenDirect(entry.bot.botId, entry.group);
                  },
                },
                h(Avatar, { bot: entry.bot, size: 36 }),
              ),
            ),
            model.direct.length > 0 && (model.groupCount > 0)
              ? h('div', { key: 'rail-divider', className: 'bt-rail-divider', style: S.railDivider })
              : null,
            model.folders.flatMap((entry) => entry.groups).concat(model.ungrouped).map((group) => {
              const isActive = group.groupId === state.activeGroupId;
              return h(
                'div',
                {
                  key: group.groupId,
                  className: 'bt-group-item bt-group-rail-item',
                  role: 'button',
                  tabIndex: 0,
                  'data-active': isActive ? 'true' : 'false',
                  'aria-label': `${group.title}${group.running ? '（回复中）' : ''}`,
                  'aria-current': isActive ? 'true' : undefined,
                  title: groupTooltip(group),
                  style: S.railItem(isActive),
                  onClick: () => selectGroup(group),
                  onKeyDown: onGroupKeyDown(group),
                },
                h(GroupAvatar, { group, size: 36 }),
              );
            }),
          )
        : h(
            'div',
            { style: S.sidebarScroll, className: 'bt-sidebar-scroll' },
            directSection,
            groupsSection,
          );

      const toggleTitle = collapsed ? '展开侧栏' : '收起侧栏';
      const toggleButton = h(
        'button',
        {
          type: 'button',
          className: 'bt-sidebar-toggle',
          style: collapsed ? S.railIconBtn : S.sidebarToggle,
          title: toggleTitle,
          'aria-label': toggleTitle,
          'aria-expanded': !collapsed,
          'aria-controls': 'bt-group-sidebar',
          onClick: () => dispatch({ type: 'toggleSidebar' }),
        },
        h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false, style: S.sidebarActionIcon },
          h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 3 }),
          h('path', { d: 'M9 4v16' }),
          collapsed
            ? h('path', { d: 'M14 9.5l2.5 2.5-2.5 2.5' })
            : h('path', { d: 'M16 9.5L13.5 12l2.5 2.5' }),
        ),
      );
      const newGroupButton = h(
        'button',
        {
          type: 'button',
          className: 'bt-sidebar-toggle',
          style: S.railIconBtn,
          title: '新建群 / 话题',
          'aria-label': '新建群 / 话题',
          onClick: () => onCreate && onCreate(),
        },
        h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false, style: S.sidebarActionIcon },
          h('path', { d: 'M12 5v14M5 12h14' }),
        ),
      );
      const header = collapsed
        ? h('div', { style: S.railHeader }, toggleButton, newGroupButton)
        : h(
            'div',
            { style: S.leftHeader },
            h('span', null, '对话'),
            // Creation lives on the section headers now (单聊 + / 群聊 +); the
            // old duplicate "+ 新建" here made the two entry points ambiguous.
            h('div', { style: S.leftHeaderActions }, toggleButton),
          );

      const actionStyle = collapsed ? S.railAction : S.sidebarAction;
      const actionIconStyle = collapsed ? S.railActionIcon : S.sidebarActionIcon;
      return h(
        'div',
        {
          id: 'bt-group-sidebar',
          className: 'bt-sidebar',
          'data-collapsed': collapsed ? 'true' : 'false',
          style: S.sidebar(collapsed),
        },
        header,
        list,
        h(
          'div',
          {
            className: collapsed ? 'bt-sidebar-actions bt-sidebar-actions-rail' : 'bt-sidebar-actions',
            style: collapsed ? S.sidebarActionsCollapsed : S.sidebarActions,
          },
          h(
            'button',
            {
              type: 'button',
              className: 'bt-sidebar-action',
              style: actionStyle,
              title: 'Bot 管理（全局）',
              'aria-label': 'Bot 管理（全局）',
              onClick: () => dispatch({ type: 'dialog', dialog: { kind: 'bots' } }),
            },
            h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false, style: actionIconStyle },
              h('rect', { x: 4, y: 8, width: 16, height: 12, rx: 3 }),
              h('path', { d: 'M12 8V4H8M4 14H2M20 14h2M9 13h.01M15 13h.01M9 17h6' }),
            ),
            collapsed ? null : h('span', null, 'Bot 管理'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'bt-sidebar-action bt-settings-button',
              style: actionStyle,
              title: 'Bot Team 设置',
              'aria-label': 'Bot Team 设置',
              onClick: () => dispatch({ type: 'dialog', dialog: { kind: 'settings' } }),
            },
            h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false, style: actionIconStyle },
              h('path', { d: 'M4 7h6m4 0h6M4 17h2m4 0h10' }),
              h('circle', { cx: 12, cy: 7, r: 2 }),
              h('circle', { cx: 8, cy: 17, r: 2 }),
            ),
            collapsed ? null : h('span', null, '设置'),
          ),
        ),
        menu && menuItems.length > 0 ? h(SidebarMenu, { menu, items: menuItems, onClose: closeMenu }) : null,
      );
    }

    // ── lightweight Markdown rendering (no third-party deps) ─────────────
    function markdownTheme(options) {
      const own = !!(options && options.own);
      return {
        own,
        codeBg: own ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.06)',
        codeColor: own ? '#ffffff' : 'inherit',
        linkColor: own ? '#ffffff' : 'var(--dsw-alias-link, #2f6fed)',
        tableBorder: own ? '1px solid rgba(255,255,255,0.26)' : '1px solid rgba(0,0,0,0.12)',
        tableHeadBg: own ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.04)',
        quoteBorder: own ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.16)',
        quoteColor: own ? 'rgba(255,255,255,0.86)' : 'var(--dsw-alias-label-secondary, #4b5563)',
        hrColor: own ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.1)',
        preBg: own ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.05)',
      };
    }

    function renderInline(text, keyPrefix, theme) {
      const nodes = [];
      let key = 0;
      const segments = String(text || '').split(/(~~[^~]+~~)/);
      for (const segment of segments) {
        const strike = /^~~([^~]+)~~$/.exec(segment);
        if (strike) {
          nodes.push(h('del', { key: `${keyPrefix}-del${key++}` }, strike[1]));
          continue;
        }
        const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/;
        let rest = segment;
        while (rest.length > 0) {
          const match = pattern.exec(rest);
          if (!match) {
            nodes.push(rest);
            break;
          }
          if (match.index > 0) nodes.push(rest.slice(0, match.index));
          if (match[1] !== undefined) {
            nodes.push(h('code', {
              key: `${keyPrefix}-c${key++}`,
              style: { background: theme.codeBg, color: theme.codeColor, borderRadius: 4, padding: '0 4px', fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: 12 },
            }, match[1]));
          } else if (match[2] !== undefined) {
            nodes.push(h('strong', { key: `${keyPrefix}-b${key++}` }, match[2]));
          } else if (match[3] !== undefined) {
            nodes.push(h('em', { key: `${keyPrefix}-i${key++}` }, match[3]));
          } else if (match[4] !== undefined) {
            nodes.push(h('a', {
              key: `${keyPrefix}-a${key++}`,
              href: match[5],
              target: '_blank',
              rel: 'noreferrer',
              style: { color: theme.linkColor, textDecoration: theme.own ? 'underline' : 'none' },
            }, match[4]));
          }
          rest = rest.slice(match.index + match[0].length);
        }
      }
      return nodes;
    }

    function splitTableRow(line) {
      return String(line)
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim());
    }

    function renderPlainBlocks(text, keyPrefix, theme) {
      const blocks = [];
      const lines = String(text || '').split('\n');
      let list = null;
      let ordered = null;
      let paragraph = [];
      let counter = 0;
      const flushParagraph = () => {
        if (paragraph.length === 0) return;
        blocks.push(h('p', { key: `${keyPrefix}-p${counter++}`, style: { margin: '0 0 6px' } }, renderInline(paragraph.join(' '), `${keyPrefix}-p${counter}`, theme)));
        paragraph = [];
      };
      const flushList = () => {
        if (list) {
          blocks.push(h('ul', { key: `${keyPrefix}-ul${counter++}`, style: { margin: '0 0 6px', paddingLeft: 20 } }, list));
          list = null;
        }
        if (ordered) {
          blocks.push(h('ol', { key: `${keyPrefix}-ol${counter++}`, style: { margin: '0 0 6px', paddingLeft: 20 } }, ordered));
          ordered = null;
        }
      };
      const cellStyle = { border: theme.tableBorder, padding: '4px 8px', verticalAlign: 'top' };
      for (let index = 0; index < lines.length; index += 1) {
        const rawLine = lines[index];
        const line = rawLine.replace(/\s+$/, '');
        if (!line.trim()) {
          flushParagraph();
          flushList();
          continue;
        }
        // Pipe table: header row followed by a |---| separator row.
        const next = lines[index + 1] || '';
        if (line.trim().startsWith('|') && /^\s*\|?[\s:|-]+\|?\s*$/.test(next) && next.includes('-')) {
          flushParagraph();
          flushList();
          const header = splitTableRow(line);
          const align = splitTableRow(next).map((cell) => {
            if (/^:.*:$/.test(cell)) return 'center';
            if (/^:/.test(cell)) return 'left';
            if (/:$/.test(cell)) return 'right';
            return 'left';
          });
          const rows = [];
          index += 2;
          while (index < lines.length && lines[index].trim().startsWith('|')) {
            rows.push(splitTableRow(lines[index]));
            index += 1;
          }
          index -= 1;
          const tableKey = `${keyPrefix}-table${counter++}`;
          blocks.push(
            h(
              'table',
              { key: tableKey, style: { borderCollapse: 'collapse', margin: '0 0 8px', fontSize: 12 } },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  header.map((cell, cellIndex) =>
                    h('th', { key: `${tableKey}-h${cellIndex}`, style: { ...cellStyle, background: theme.tableHeadBg, textAlign: align[cellIndex] || 'left', fontWeight: 600 } }, renderInline(cell, `${tableKey}-h${cellIndex}`, theme)),
                  ),
                ),
              ),
              h(
                'tbody',
                null,
                rows.map((row, rowIndex) =>
                  h(
                    'tr',
                    { key: `${tableKey}-r${rowIndex}` },
                    row.map((cell, cellIndex) =>
                      h('td', { key: `${tableKey}-r${rowIndex}c${cellIndex}`, style: { ...cellStyle, textAlign: align[cellIndex] || 'left' } }, renderInline(cell, `${tableKey}-r${rowIndex}c${cellIndex}`, theme)),
                    ),
                  ),
                ),
              ),
            ),
          );
          continue;
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
          flushParagraph();
          flushList();
          const level = Math.min(heading[1].length + 2, 6);
          blocks.push(h(`h${level}`, { key: `${keyPrefix}-h${counter++}`, style: { margin: '8px 0 4px', fontSize: level <= 4 ? 15 : 13 } }, renderInline(heading[2], `${keyPrefix}-h${counter}`, theme)));
          continue;
        }
        const quote = /^>\s?(.*)$/.exec(line);
        if (quote) {
          flushParagraph();
          flushList();
          blocks.push(h('blockquote', { key: `${keyPrefix}-q${counter++}`, style: { margin: '0 0 6px', paddingLeft: 10, borderLeft: `3px solid ${theme.quoteBorder}`, color: theme.quoteColor } }, renderInline(quote[1], `${keyPrefix}-q${counter}`, theme)));
          continue;
        }
        const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
        if (bullet) {
          flushParagraph();
          if (ordered) flushList();
          list = list || [];
          list.push(h('li', { key: `${keyPrefix}-li${counter++}` }, renderInline(bullet[1], `${keyPrefix}-li${counter}`, theme)));
          continue;
        }
        const numbered = /^\s*\d+\.\s+(.*)$/.exec(line);
        if (numbered) {
          flushParagraph();
          if (list) flushList();
          ordered = ordered || [];
          ordered.push(h('li', { key: `${keyPrefix}-oli${counter++}` }, renderInline(numbered[1], `${keyPrefix}-oli${counter}`, theme)));
          continue;
        }
        if (/^\s*---\s*$/.test(line)) {
          flushParagraph();
          flushList();
          blocks.push(h('hr', { key: `${keyPrefix}-hr${counter++}`, style: { border: 0, borderTop: `1px solid ${theme.hrColor}`, margin: '8px 0' } }));
          continue;
        }
        paragraph.push(line.trim());
      }
      flushParagraph();
      flushList();
      return blocks;
    }

    function renderMarkdown(text, options) {
      const source = String(text || '');
      const theme = markdownTheme(options);
      const blocks = [];
      const fence = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g;
      let last = 0;
      let match;
      let index = 0;
      while ((match = fence.exec(source)) !== null) {
        if (match.index > last) blocks.push(...renderPlainBlocks(source.slice(last, match.index), `md${index++}`, theme));
        blocks.push(h('pre', {
          key: `md-code-${index++}`,
          style: { background: theme.preBg, borderRadius: 8, padding: '8px 10px', overflow: 'auto', fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, monospace', margin: '0 0 6px' },
        }, h('code', null, match[2].replace(/\n$/, ''))));
        last = fence.lastIndex;
      }
      if (last < source.length) blocks.push(...renderPlainBlocks(source.slice(last), `md${index++}`, theme));
      return blocks;
    }

    function badgeStyle(background, color) {
      return { fontSize: 10, background, color, borderRadius: 999, padding: '1px 7px', fontWeight: 600 };
    }

    const AVATAR_GRADIENTS = [
      ['#2563eb', '#0ea5e9'],
      ['#7c3aed', '#db2777'],
      ['#0d9488', '#22c55e'],
      ['#d97706', '#ef4444'],
      ['#db2777', '#f97316'],
      ['#4f46e5', '#8b5cf6'],
      ['#0369a1', '#6366f1'],
      ['#15803d', '#0ea5e9'],
      ['#9f1239', '#fb7185'],
      ['#334155', '#64748b'],
      ['#0f766e', '#14b8a6'],
      ['#6d28d9', '#2563eb'],
    ];
    const AVATAR_OVERLAYS = [
      'radial-gradient(circle at 72% 24%, rgba(255,255,255,0.30), transparent 46%)',
      'radial-gradient(circle at 50% 50%, transparent 52%, rgba(255,255,255,0.20) 53%, transparent 63%)',
      'linear-gradient(115deg, transparent 40%, rgba(255,255,255,0.18) 41%, rgba(255,255,255,0.18) 56%, transparent 57%)',
      'radial-gradient(circle at 30% 82%, rgba(255,255,255,0.18), transparent 42%)',
    ];
    const ROBOT_PALETTES = [
      { bg: '#eef6ff', c1: '#38bdf8', c2: '#2563eb', accent: '#f59e0b' },
      { bg: '#f5f3ff', c1: '#a78bfa', c2: '#7c3aed', accent: '#22d3ee' },
      { bg: '#ecfdf5', c1: '#34d399', c2: '#0d9488', accent: '#f59e0b' },
      { bg: '#fff7ed', c1: '#fb923c', c2: '#ea580c', accent: '#2563eb' },
      { bg: '#fdf2f8', c1: '#f472b6', c2: '#db2777', accent: '#facc15' },
      { bg: '#eef2ff', c1: '#818cf8', c2: '#4f46e5', accent: '#34d399' },
      { bg: '#f0fdfa', c1: '#2dd4bf', c2: '#0f766e', accent: '#fb7185' },
      { bg: '#f8fafc', c1: '#94a3b8', c2: '#475569', accent: '#38bdf8' },
    ];
    const ART_AVATARS = [
      {
        id: 'planet',
        label: '星球',
        bg: '#e8f1ff',
        draw: () => [
          h('circle', { cx: 50, cy: 50, r: 26, fill: '#4f7cff' }),
          h('circle', { cx: 41, cy: 43, r: 4, fill: '#2f5fe0' }),
          h('circle', { cx: 58, cy: 58, r: 5, fill: '#2f5fe0' }),
          h('ellipse', { cx: 50, cy: 52, rx: 42, ry: 11, fill: 'none', stroke: '#f59e0b', strokeWidth: 5, transform: 'rotate(-18 50 52)' }),
          h('circle', { cx: 78, cy: 24, r: 5, fill: '#f59e0b' }),
        ],
      },
      {
        id: 'rocket',
        label: '火箭',
        bg: '#fff4e8',
        draw: () => [
          h('path', { d: 'M50 14 C64 28 68 48 62 66 H38 C32 48 36 28 50 14 Z', fill: '#ef4444' }),
          h('path', { d: 'M38 52 L22 74 L38 68 Z', fill: '#f59e0b' }),
          h('path', { d: 'M62 52 L78 74 L62 68 Z', fill: '#f59e0b' }),
          h('circle', { cx: 50, cy: 40, r: 9, fill: '#ffffff' }),
          h('path', { d: 'M42 68 Q50 86 58 68 Z', fill: '#fbbf24' }),
          h('path', { d: 'M46 70 Q50 80 54 70 Z', fill: '#fff7ed' }),
        ],
      },
      {
        id: 'cloud',
        label: '云朵',
        bg: '#dbeafe',
        draw: () => [
          h('circle', { cx: 70, cy: 30, r: 10, fill: '#fbbf24' }),
          h('circle', { cx: 36, cy: 58, r: 13, fill: '#ffffff' }),
          h('circle', { cx: 50, cy: 50, r: 18, fill: '#ffffff' }),
          h('circle', { cx: 64, cy: 57, r: 13, fill: '#ffffff' }),
          h('rect', { x: 32, y: 54, width: 40, height: 16, rx: 8, fill: '#ffffff' }),
          h('path', { d: 'M40 74 L36 84 M52 74 L48 86 M64 74 L60 84', stroke: '#60a5fa', strokeWidth: 4, strokeLinecap: 'round' }),
        ],
      },
      {
        id: 'bolt',
        label: '闪电',
        bg: '#eef2ff',
        draw: () => [
          h('path', { d: 'M56 12 L28 54 H46 L40 88 L72 42 H52 Z', fill: '#fbbf24', stroke: '#f59e0b', strokeWidth: 3, strokeLinejoin: 'round' }),
        ],
      },
      {
        id: 'leaf',
        label: '叶子',
        bg: '#ecfdf5',
        draw: () => [
          h('path', { d: 'M50 16 C74 28 78 58 50 84 C22 58 26 28 50 16 Z', fill: '#34d399' }),
          h('path', { d: 'M50 30 V72', stroke: '#047857', strokeWidth: 3, strokeLinecap: 'round' }),
          h('path', { d: 'M50 44 L38 36 M50 54 L62 45 M50 64 L40 58', stroke: '#047857', strokeWidth: 2.5, strokeLinecap: 'round' }),
        ],
      },
      {
        id: 'flame',
        label: '火焰',
        bg: '#fff1f2',
        draw: () => [
          h('path', { d: 'M50 12 C66 32 74 44 70 60 C66 76 54 86 50 86 C46 86 34 76 30 60 C26 44 34 32 50 12 Z', fill: '#f97316' }),
          h('path', { d: 'M50 36 C58 48 60 58 56 66 C54 72 50 76 50 76 C50 76 46 72 44 66 C40 58 42 48 50 36 Z', fill: '#fbbf24' }),
          h('path', { d: 'M50 52 C54 59 54 64 52 68 C51 71 50 72 50 72 C50 72 49 71 48 68 C46 64 46 59 50 52 Z', fill: '#fff7ed' }),
        ],
      },
      {
        id: 'star',
        label: '星星',
        bg: '#fffbeb',
        draw: () => [
          h('path', { d: 'M50 14 L59 38 L84 40 L64 56 L71 80 L50 66 L29 80 L36 56 L16 40 L41 38 Z', fill: '#fbbf24', stroke: '#f59e0b', strokeWidth: 2, strokeLinejoin: 'round' }),
          h('circle', { cx: 24, cy: 28, r: 3, fill: '#fcd34d' }),
          h('circle', { cx: 78, cy: 70, r: 3, fill: '#fcd34d' }),
        ],
      },
      {
        id: 'moon',
        label: '月亮',
        bg: '#eef2ff',
        draw: () => [
          h('circle', { cx: 48, cy: 50, r: 30, fill: '#fbbf24' }),
          h('circle', { cx: 63, cy: 42, r: 26, fill: '#eef2ff' }),
          h('circle', { cx: 74, cy: 68, r: 3, fill: '#c7d2fe' }),
          h('circle', { cx: 82, cy: 30, r: 2.5, fill: '#c7d2fe' }),
        ],
      },
      {
        id: 'wave',
        label: '海浪',
        bg: '#ecfeff',
        draw: () => [
          h('circle', { cx: 72, cy: 28, r: 9, fill: '#fbbf24' }),
          h('path', { d: 'M6 62 Q20 46 34 62 T62 62 T90 62 V94 H6 Z', fill: '#22d3ee' }),
          h('path', { d: 'M6 76 Q20 62 34 76 T62 76 T90 76 V94 H6 Z', fill: '#0ea5e9', opacity: 0.85 }),
        ],
      },
      {
        id: 'flower',
        label: '花朵',
        bg: '#fdf2f8',
        draw: () => [
          h('circle', { cx: 50, cy: 28, r: 13, fill: '#f9a8d4' }),
          h('circle', { cx: 68, cy: 40, r: 13, fill: '#f9a8d4' }),
          h('circle', { cx: 68, cy: 60, r: 13, fill: '#f9a8d4' }),
          h('circle', { cx: 50, cy: 72, r: 13, fill: '#f9a8d4' }),
          h('circle', { cx: 32, cy: 60, r: 13, fill: '#f9a8d4' }),
          h('circle', { cx: 32, cy: 40, r: 13, fill: '#f9a8d4' }),
          h('circle', { cx: 50, cy: 50, r: 12, fill: '#fbbf24' }),
        ],
      },
    ];
    const ART_MAP = Object.fromEntries(ART_AVATARS.map((art) => [art.id, art]));

    function hashSeed(text) {
      let hash = 2166136261;
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return hash >>> 0;
    }

    /** Deterministic gradient monogram: stable per seed, no image assets. */
    function avatarGradient(seed) {
      const hash = hashSeed(String(seed || 'bot'));
      const pair = AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length];
      return {
        from: pair[0],
        to: pair[1],
        overlay: AVATAR_OVERLAYS[hash % AVATAR_OVERLAYS.length],
      };
    }

    /** Deterministic robot mascot; variants differ by palette/eyes/mouth/antenna. */
    function RobotAvatar({ seed, size = 22 }) {
      const hash = hashSeed(String(seed || 'bot'));
      const palette = ROBOT_PALETTES[hash % ROBOT_PALETTES.length];
      const variant = hash % 4;
      const gradientId = `bt-robot-${hash.toString(36)}`;
      const antenna = variant !== 3;
      const visor = variant === 1 || variant === 3;
      const straightMouth = variant === 2;
      return h(
        'svg',
        {
          viewBox: '0 0 100 100',
          width: size,
          height: size,
          'aria-hidden': true,
          style: {
            display: 'block',
            borderRadius: '50%',
            overflow: 'hidden',
            flex: '0 0 auto',
            background: palette.bg,
            border: '1px solid rgba(16,24,40,0.06)',
          },
        },
        h(
          'defs',
          null,
          h(
            'linearGradient',
            { id: gradientId, x1: '0', y1: '0', x2: '1', y2: '1' },
            h('stop', { offset: '0', stopColor: palette.c1 }),
            h('stop', { offset: '1', stopColor: palette.c2 }),
          ),
        ),
        h('rect', { width: 100, height: 100, fill: palette.bg }),
        h('ellipse', { cx: 50, cy: 82, rx: 26, ry: 4, fill: 'rgba(15,23,42,0.10)' }),
        antenna
          ? h('line', { x1: 50, y1: 24, x2: 50, y2: 12, stroke: palette.c2, strokeWidth: 4, strokeLinecap: 'round' })
          : null,
        antenna ? h('circle', { cx: 50, cy: 9, r: 5, fill: palette.accent }) : null,
        h('rect', { x: 8, y: 42, width: 8, height: 18, rx: 4, fill: palette.c2 }),
        h('rect', { x: 84, y: 42, width: 8, height: 18, rx: 4, fill: palette.c2 }),
        h('rect', { x: 17, y: 22, width: 66, height: 56, rx: 19, fill: `url(#${gradientId})` }),
        visor ? h('rect', { x: 27, y: 38, width: 46, height: 18, rx: 9, fill: '#f8fafc' }) : null,
        visor
          ? [
              h('circle', { key: 'l', cx: 41, cy: 47, r: 4.5, fill: '#0f172a' }),
              h('circle', { key: 'r', cx: 59, cy: 47, r: 4.5, fill: '#0f172a' }),
            ]
          : [
              h('circle', { key: 'lw', cx: 37, cy: 46, r: 9, fill: '#f8fafc' }),
              h('circle', { key: 'rw', cx: 63, cy: 46, r: 9, fill: '#f8fafc' }),
              h('circle', { key: 'lp', cx: 37, cy: 46, r: 4.5, fill: '#0f172a' }),
              h('circle', { key: 'rp', cx: 63, cy: 46, r: 4.5, fill: '#0f172a' }),
            ],
        h('path', {
          d: straightMouth ? 'M40 63 H60' : 'M36 61 Q50 71 64 61',
          fill: 'none',
          stroke: '#f8fafc',
          strokeWidth: 4,
          strokeLinecap: 'round',
        }),
        variant === 3 ? h('circle', { cx: 29, cy: 57, r: 3, fill: 'rgba(255,255,255,0.55)' }) : null,
        variant === 3 ? h('circle', { cx: 71, cy: 57, r: 3, fill: 'rgba(255,255,255,0.55)' }) : null,
      );
    }

    /** One hand-drawn SVG illustration from the selectable art pack. */
    function ArtAvatar({ id, size = 22, radius = '50%' }) {
      const art = ART_MAP[id];
      if (!art) return null;
      return h(
        'svg',
        {
          viewBox: '0 0 100 100',
          width: size,
          height: size,
          'aria-hidden': true,
          style: {
            display: 'block',
            borderRadius: radius,
            overflow: 'hidden',
            flex: '0 0 auto',
            background: art.bg,
            border: '1px solid rgba(16,24,40,0.06)',
          },
        },
        h('rect', { width: 100, height: 100, fill: art.bg }),
        h('g', null, ...art.draw()),
      );
    }

    function GradientMonogram({ name, size = 22 }) {
      const label = String(name || '我');
      const gradient = avatarGradient(label);
      return h(
        'span',
        {
          'aria-hidden': true,
          style: {
            width: size,
            height: size,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: '0 0 auto',
            color: '#ffffff',
            fontWeight: 600,
            fontSize: Math.max(9, Math.round(size * 0.42)),
            lineHeight: 1,
            letterSpacing: '0.01em',
            backgroundImage: `${gradient.overlay}, linear-gradient(135deg, ${gradient.from}, ${gradient.to})`,
            boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.18)',
            textShadow: '0 1px 2px rgba(0,0,0,0.18)',
            userSelect: 'none',
          },
        },
        label.slice(0, 1).toUpperCase(),
      );
    }

    /** DSH account picture with a graceful monogram fallback. */
    function RemoteAvatar({ src, name, size = 22 }) {
      const [failed, setFailed] = React.useState(false);
      React.useEffect(() => {
        setFailed(false);
      }, [src]);
      if (failed) return h(GradientMonogram, { name, size });
      return h('img', {
        src,
        alt: name,
        style: S.avatarImage(size),
        onError: () => setFailed(true),
      });
    }

    /** One avatar renderer: custom image, art pack, bot mascot, account or human monogram. */
    function Avatar({ bot, name, avatarUrl, size = 22 }) {
      const label = String(name || (bot && bot.name) || '?');
      const avatar = bot && typeof bot.avatar === 'string' ? bot.avatar : '';
      if (avatarUrl) {
        return h(RemoteAvatar, { src: avatarUrl, name: label, size });
      }
      if (avatar.startsWith('data:image/')) {
        return h('img', { src: avatar, alt: label, style: S.avatarImage(size) });
      }
      if (avatar.startsWith('art:')) {
        const artId = avatar.slice('art:'.length);
        if (ART_MAP[artId]) return h(ArtAvatar, { id: artId, size });
      }
      if (bot) {
        const seed = avatar.startsWith('preset:') ? avatar : bot.name || bot.botId || 'bot';
        return h(RobotAvatar, { seed, size });
      }
      return h(GradientMonogram, { name: label, size });
    }

    function GroupAvatar({ group, size = 38 }) {
      const title = String((group && group.title) || '群');
      const avatar = group && typeof group.avatar === 'string' ? group.avatar : '';
      const radius = size >= 36 ? 11 : 9;
      let content = null;
      if (avatar.startsWith('data:image/')) {
        content = h('img', { src: avatar, alt: title, style: S.groupAvatarImage(size) });
      } else if (avatar.startsWith('art:')) {
        const artId = avatar.slice('art:'.length);
        if (ART_MAP[artId]) content = h(ArtAvatar, { id: artId, size, radius });
      }
      if (!content) {
        const gradient = avatarGradient(avatar.startsWith('preset:') ? avatar : title);
        content = h(
          'span',
          {
            style: {
              ...S.groupAvatar(size),
              backgroundImage: `${gradient.overlay}, linear-gradient(135deg, ${gradient.from}, ${gradient.to})`,
            },
          },
          title.slice(0, 1).toUpperCase(),
        );
      }
      return h(
        'span',
        { 'aria-hidden': true, title, style: { position: 'relative', display: 'inline-flex', flex: '0 0 auto' } },
        content,
        group && group.running ? h('span', { style: S.groupAvatarDot }) : null,
      );
    }

    function TypingDots() {
      return h(
        'span',
        { style: S.typingBubble, 'aria-label': '正在输入' },
        [0, 1, 2].map((index) => h('span', { key: index, className: 'bt-typing-dot' })),
      );
    }

    function TimeDivider({ value }) {
      const label = formatTimeDivider(value);
      return label ? h('div', { className: 'bt-time-divider', style: S.timeDivider }, h('span', null, label)) : null;
    }

    function UnreadDivider() {
      return h('div', { className: 'bt-unread-divider', style: S.unreadDivider }, h('span', null, '新消息'));
    }

    function MessageList({ messages, unreadFromSeq, ...rest }) {
      let unreadShown = false;
      const rows = [];
      (messages || []).forEach((message, index) => {
        const previous = messages[index - 1];
        const next = messages[index + 1];
        const currentAt = Number(message.createdAt || 0);
        const previousAt = previous ? Number(previous.createdAt || 0) : 0;
        const showTime =
          !previous || !sameDay(previous.createdAt, message.createdAt) || currentAt - previousAt >= 5 * 60 * 1000;
        if (showTime) rows.push(h(TimeDivider, { key: `time-${message.messageId}`, value: message.createdAt }));
        if (!unreadShown && unreadFromSeq && Number(message.seq) >= Number(unreadFromSeq)) {
          rows.push(h(UnreadDivider, { key: `unread-${unreadFromSeq}` }));
          unreadShown = true;
        }
        rows.push(
          h(MessageRow, {
            ...rest,
            key: message.messageId,
            message,
            groupStart: !canGroupMessages(previous, message),
            groupEnd: !canGroupMessages(message, next),
          }),
        );
      });
      return rows;
    }

    function ApprovalRow({ message, bots, onOpenSession }) {
      const meta = message.meta || {};
      const state = meta.approvalState || 'pending';
      const colors = APPROVAL_STATE_COLOR[state] || APPROVAL_STATE_COLOR.unavailable;
      const bot = meta.botId ? (bots || []).find((candidate) => candidate.botId === meta.botId) : null;
      return h(
        'div',
        { style: S.approvalWrap },
        h(
          'div',
          { style: S.approvalCard },
          h(
            'div',
            { style: S.approvalHead },
            bot ? h(Avatar, { bot, size: 22 }) : h('span', { style: { fontSize: 15 } }, '!'),
            h('span', { style: S.approvalTitle }, '审批请求'),
            h('span', { style: badgeStyle(colors[0], colors[1]) }, APPROVAL_STATE_LABEL[state] || state),
            meta.toolName ? h('span', { style: badgeStyle('#f3f4f6', '#4b5563') }, meta.toolName) : null,
            h('span', { style: { marginLeft: 'auto', fontSize: 10, color: 'var(--bt-text-3)' } }, formatTime(message.createdAt)),
          ),
          h('div', { style: S.approvalText }, message.text || ''),
          state === 'pending' && meta.sessionId
            ? h(
                'div',
                { style: S.approvalActions },
                h('button', { style: S.primaryBtn, onClick: () => onOpenSession && onOpenSession(meta.sessionId) }, '去审批'),
                h('span', { style: S.approvalHint }, '在 Bot 会话里选择「允许一次」或「拒绝」；未处理会等到本轮超时，结果会同步回群里。'),
              )
            : null,
        ),
      );
    }

    function MessageActionIcon({ name }) {
      const paths = {
        reply: [h('path', { key: 'p', d: 'M8.5 5 4 9l4.5 4v-2.6c3.2 0 5.3 1 6.9 3-.4-4.3-2.8-7-6.9-7V5Z' })],
        copy: [
          h('rect', { key: 'r1', x: 7, y: 7, width: 8, height: 8, rx: 1.5 }),
          h('path', { key: 'p1', d: 'M13 7V5.5A1.5 1.5 0 0 0 11.5 4h-6A1.5 1.5 0 0 0 4 5.5v6A1.5 1.5 0 0 0 5.5 13H7' }),
        ],
        quote: [
          h('path', { key: 'p1', d: 'M5 5.5v9' }),
          h('path', { key: 'p2', d: 'M9 6.5h7M9 10h7M9 13.5h4.5' }),
        ],
        jump: [
          h('path', { key: 'p1', d: 'M15.5 14.5v-4a3 3 0 0 0-3-3H5.5' }),
          h('path', { key: 'p2', d: 'm8.5 4.5-3 3 3 3' }),
        ],
        review: [
          h('circle', { key: 'c', cx: 10, cy: 10, r: 7 }),
          h('path', { key: 'p', d: 'm7 10 2 2 4-4' }),
        ],
        edit: [h('path', { key: 'p', d: 'M13.5 4.5 15.5 6.5 8 14H6v-2l7.5-7.5Z' })],
        retry: [
          h('path', { key: 'p1', d: 'M15.5 8.5A5.5 5.5 0 1 0 15 10.5' }),
          h('path', { key: 'p2', d: 'M15.5 4.5v4h-4' }),
        ],
      };
      return h(
        'svg',
        {
          viewBox: '0 0 20 20',
          width: 14,
          height: 14,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        paths[name] || null,
      );
    }

    function MessageActionButton({ icon, label, title, danger, onClick }) {
      return h(
        'button',
        {
          type: 'button',
          className: `bt-action-btn${danger ? ' bt-action-danger' : ''}`,
          title: title || label,
          'aria-label': label,
          onClick: (event) => {
            event.stopPropagation();
            onClick();
          },
        },
        h(MessageActionIcon, { name: icon }),
      );
    }

    function messageMetadataItems(message, settings, authorBot) {
      if (!message || message.author?.type !== 'bot' || ['pending', 'streaming'].includes(message.status)) return [];
      const modes = normalizeChatDisplaySettings(settings);
      const items = [];
      const add = (key, text, title) => {
        if (modes[key] !== 'hidden') items.push({ key, text, title, mode: modes[key] });
      };
      const model = message.model || authorBot?.model || '';
      const provider = message.provider || authorBot?.provider || '';
      const effort = message.reasoningEffort || authorBot?.reasoningEffort || '';
      if (model) add('model', model, `模型：${provider ? provider + ' / ' : ''}${model}${effort ? ' · reasoning ' + effort : ''}`);
      const usage = message.usage || {};
      const validTokens = value => Number.isSafeInteger(value) && value >= 0;
      if (validTokens(usage.inputTokens)) add('inputTokens', `↑ ${formatTokens(usage.inputTokens)}`, `最近一次上报的输入 Token（非本轮累计）：${usage.inputTokens}`);
      if (validTokens(usage.outputTokens)) add('outputTokens', `↓ ${formatTokens(usage.outputTokens)}`, `最近一次上报的输出 Token（非本轮累计）：${usage.outputTokens}`);
      const stats = message.generationStats;
      if (message.status === 'done' && stats?.scope === 'last-request' && Number.isFinite(stats.durationMs) && stats.durationMs > 0
          && validTokens(stats.outputTokens) && stats.outputTokens === usage.outputTokens) {
        const speed = stats.outputTokens * 1000 / stats.durationMs;
        if (Number.isFinite(speed) && speed >= 0) {
          add('speed', `${speed > 0 && speed < 0.1 ? '< 0.1' : speed.toFixed(1)} tok/s`,
            `最近一次模型请求平均速度：输出 ${stats.outputTokens} Token / ${(stats.durationMs / 1000).toFixed(2)} 秒。包含等待与思考，不含工具执行；非纯解码速度。`);
        }
      }
      // Always-visible fields lead, so hidden hover slots never leave a leading gap.
      return items.sort((left, right) => Number(left.mode === 'hover') - Number(right.mode === 'hover'));
    }

    function renderMessageMetadata(items) {
      return items.map(item => h('span', {
        key: item.key,
        className: 'bt-msg-meta',
        'data-meta': item.key,
        'data-display': item.mode,
        title: item.title,
        style: { ...S.msgMetaText, whiteSpace: 'nowrap', ...(item.key === 'model' ? { maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' } : {}) },
      }, item.text));
    }

    function MessageRow({
      message,
      groupStart,
      groupEnd,
      bots,
      tasks,
      allMessages,
      onReply,
      onCopy,
      onCopyQuote,
      onContextMenu,
      onReview,
      onRevise,
      onRetry,
      onJumpToMessage,
      onOpenSession,
      userProfile,
      chatDisplaySettings,
    }) {
      if (message.kind === 'approval') {
        return h(ApprovalRow, { message, bots, onOpenSession });
      }
      if (message.author && message.author.type === 'system') {
        const kindLabel = message.kind === 'review' ? '评审' : message.kind === 'revision' ? '修改' : message.kind === 'discussion' ? '讨论' : '';
        return h(
          'div',
          { className: 'bt-system-row', style: S.systemRow },
          h('span', { style: S.systemPill }, kindLabel ? `[${kindLabel}] ${message.text}` : message.text),
        );
      }
      const mine = !!(message.author && message.author.type === 'human');
      const profile = mine ? userProfile : null;
      const botId = message.author && message.author.botId;
      const color = mine ? '#3370ff' : colorOfBot(bots, botId);
      const authorBot = botId ? (bots || []).find((candidate) => candidate.botId === botId) : null;
      const name = mine ? (profile && profile.name) || '我' : (authorBot && authorBot.name) || (message.author && message.author.name) || nameOfBot(bots, botId);
      const userAvatarUrl = mine && profile && profile.avatarUrl ? profile.avatarUrl : '';
      const streaming = message.status === 'pending' || message.status === 'streaming';
      const meta = message.meta || {};
      const target = meta.reviewOf ? (allMessages || []).find((candidate) => candidate.messageId === meta.reviewOf) : null;
      const task = meta.taskId ? (tasks || []).find((candidate) => candidate.taskId === meta.taskId) : null;
      const quoted = replyQuoteOf(message, allMessages);
      const showTyping = streaming && !message.text;
      const actions = messageActionList({
        message,
        mine,
        streaming,
        meta,
        hasQuoted: !!quoted,
        onReply,
        onCopy,
        onCopyQuote,
        onJumpToMessage,
        onReview,
        onRevise,
        onRetry,
      }).filter((action) => action.hover !== false && !action.disabled);

      const footer = [];
      if (meta.round) footer.push(h('span', { key: 'round', style: badgeStyle('#eef2ff', '#4f46e5') }, `第 ${meta.round} 轮`));
      if (meta.summary) footer.push(h('span', { key: 'summary', style: badgeStyle('#ecfdf5', '#047857') }, '总结'));
      if (meta.verdict === 'pass') footer.push(h('span', { key: 'pass', style: badgeStyle('#ecfdf5', '#047857') }, '评审通过'));
      if (meta.verdict === 'changes') footer.push(h('span', { key: 'changes', style: badgeStyle('#fffbeb', '#b45309') }, '需修改'));
      if (target) footer.push(h('span', { key: 'target', style: badgeStyle('#f3f4f6', '#667085') }, `评审 #${target.seq}`));
      if (task) {
        footer.push(
          h(
            'span',
            { key: 'task', style: { ...badgeStyle('#eef2ff', '#4f46e5'), maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            `任务 · ${task.title} · ${TASK_STATUS_LABEL[task.status] || task.status}`,
          ),
        );
      }
      footer.push(...renderMessageMetadata(messageMetadataItems(message, chatDisplaySettings, authorBot)));
      if (message.status === 'stopped') footer.push(h('span', { key: 'stopped', style: S.msgMetaText }, '已停止'));
      if (message.status === 'error' && message.error) {
        footer.push(
          h(
            'div',
            { key: 'error', style: { flexBasis: '100%', fontSize: 10.5, color: 'var(--bt-danger-text)', lineHeight: 1.55, wordBreak: 'break-word' } },
            `错误：${message.error}`,
          ),
        );
      }

      return h(
        'div',
        {
          className: 'bt-msg',
          'data-message-id': message.messageId,
          'data-own': mine ? 'true' : 'false',
          style: S.msgRow(mine, groupStart, groupEnd),
          onContextMenu: typeof onContextMenu === 'function' ? (event) => onContextMenu(event, message) : undefined,
        },
        h('div', { className: 'bt-msg-avatar', style: S.msgAvatarCol }, groupStart ? h(Avatar, { bot: authorBot, name, avatarUrl: userAvatarUrl, size: 32 }) : null),
        h(
          'div',
          { style: S.msgMain(mine) },
          !mine && groupStart
            ? h(
                'div',
                { style: S.msgHead },
                h('span', { style: { width: 6, height: 6, borderRadius: '50%', background: color, flex: '0 0 auto' } }),
                h('span', { style: S.msgAuthor }, name),
                streaming ? h('span', { style: S.typingLabel }, '正在输入') : null,
              )
            : null,
          h(
            'div',
            { style: S.msgBubbleLine(mine) },
            actions.length > 0
              ? h(
                  'div',
                  { className: 'bt-msg-actions', role: 'toolbar', 'aria-label': '消息操作' },
                  actions.map((action) =>
                    h(MessageActionButton, {
                      key: action.key,
                      icon: action.icon,
                      label: action.label,
                      title: action.title,
                      danger: action.danger,
                      onClick: action.onSelect,
                    }),
                  ),
                )
              : null,
            h(
              'div',
              {
                className: 'bt-bubble',
                title: formatFullTime(message.createdAt) || undefined,
                style: {
                  ...S.msgBubble(mine, groupStart),
                  ...(message.status === 'error' ? { background: 'var(--bt-danger-bg)', borderColor: 'var(--bt-danger-border)' } : null),
                },
              },
              quoted
                ? h(
                    'button',
                    {
                      type: 'button',
                      style: S.replyQuote(mine),
                      title: '定位到原消息',
                      onClick: () => onJumpToMessage && onJumpToMessage(quoted.messageId),
                    },
                    h('span', { style: S.replyQuoteName }, displayNameOf(quoted, bots, userProfile)),
                    h('span', { style: S.replyQuoteText }, cleanPreview(quoted.text, 96) || '[消息]'),
                  )
                : null,
              showTyping
                ? h('div', { style: S.typingBubble }, h(TypingDots))
                : h(
                    'div',
                    { className: 'bt-rich', style: { ...S.msgText, color: message.status === 'error' ? '#b42318' : 'inherit' } },
                    renderMarkdown(message.text, { own: mine }),
                    streaming && message.text ? h('span', { className: 'bt-cursor' }) : null,
                  ),
            ),
          ),
          footer.length > 0 ? h('div', { className: 'bt-msg-footer', style: S.msgFooter(mine) }, footer) : null,
        ),
      );
    }

    function MessageContextMenu({
      menu,
      bots,
      allMessages,
      userProfile,
      onClose,
      onReply,
      onCopy,
      onCopyQuote,
      onJumpToMessage,
      onReview,
      onRevise,
      onRetry,
    }) {
      // Prefer the live message so a streaming reply enables/disables menu items
      // as it finishes; fall back to the snapshot taken when the menu opened.
      const message = (allMessages || []).find((candidate) => candidate.messageId === menu.message.messageId) || menu.message;
      const mine = !!(message.author && message.author.type === 'human');
      const streaming = message.status === 'pending' || message.status === 'streaming';
      const quoted = replyQuoteOf(message, allMessages);
      const actions = messageActionList({
        message,
        mine,
        streaming,
        meta: message.meta || {},
        hasQuoted: !!quoted,
        onReply,
        onCopy,
        onCopyQuote,
        onJumpToMessage,
        onReview,
        onRevise,
        onRetry,
      });
      let separatorCount = 0;
      actions.forEach((action, index) => {
        if (index > 0 && actions[index - 1].section !== action.section) separatorCount += 1;
      });
      const viewportWidth = typeof window !== 'undefined' && Number.isFinite(window.innerWidth) ? window.innerWidth : 0;
      const viewportHeight = typeof window !== 'undefined' && Number.isFinite(window.innerHeight) ? window.innerHeight : 0;
      const placement = placeMessageMenu(
        menu.x,
        menu.y,
        viewportWidth,
        viewportHeight,
        MESSAGE_MENU_WIDTH,
        messageMenuHeight(actions.length, separatorCount),
      );
      const menuRef = React.useRef(null);

      React.useEffect(() => {
        if (typeof window === 'undefined' || typeof document === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
        const previousFocus = document.activeElement;
        const node = menuRef.current;
        if (node && typeof node.querySelector === 'function') {
          const first = node.querySelector('[role="menuitem"]:not([disabled])');
          if (first && typeof first.focus === 'function') first.focus();
        }
        const close = () => {
          if (typeof onClose === 'function') onClose();
        };
        const inside = (target) => !!(node && target && typeof node.contains === 'function' && node.contains(target));
        const onPointerDown = (event) => {
          if (!inside(event.target)) close();
        };
        const onContextMenu = (event) => {
          if (!inside(event.target)) close();
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            close();
          }
        };
        document.addEventListener('mousedown', onPointerDown, true);
        document.addEventListener('contextmenu', onContextMenu, true);
        document.addEventListener('keydown', onKeyDown);
        // Close on user scrolling (wheel/touchmove), not on the timeline's own
        // auto-scroll while a bot streams — otherwise the menu would vanish a
        // frame after opening at the bottom of an active chat.
        document.addEventListener('wheel', close, true);
        document.addEventListener('touchmove', close, true);
        window.addEventListener('resize', close);
        window.addEventListener('blur', close);
        return () => {
          document.removeEventListener('mousedown', onPointerDown, true);
          document.removeEventListener('contextmenu', onContextMenu, true);
          document.removeEventListener('keydown', onKeyDown);
          document.removeEventListener('wheel', close, true);
          document.removeEventListener('touchmove', close, true);
          window.removeEventListener('resize', close);
          window.removeEventListener('blur', close);
          // Give the caret back to wherever it was (often the composer) after
          // a copy/jump, unless that element has already left the document.
          if (previousFocus && previousFocus !== document.body && previousFocus.isConnected && typeof previousFocus.focus === 'function') {
            previousFocus.focus();
          }
        };
      }, []);

      const choose = (action) => {
        if (!action || action.disabled) return;
        if (typeof onClose === 'function') onClose();
        if (typeof action.onSelect === 'function') action.onSelect();
      };

      const onMenuKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          if (typeof onClose === 'function') onClose();
          return;
        }
        if (event.key === 'Tab') {
          if (typeof onClose === 'function') onClose();
          return;
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        if (typeof document === 'undefined') return;
        const node = menuRef.current;
        if (!node || typeof node.querySelectorAll !== 'function') return;
        const items = Array.from(node.querySelectorAll('[role="menuitem"]:not([disabled])'));
        if (!items.length) return;
        event.preventDefault();
        const current = items.indexOf(document.activeElement);
        const next = event.key === 'ArrowDown' ? (current + 1) % items.length : (current - 1 + items.length) % items.length;
        if (items[next] && typeof items[next].focus === 'function') items[next].focus();
      };

      return h(
        'div',
        {
          ref: menuRef,
          className: 'bt-menu bt-msg-menu',
          role: 'menu',
          'aria-label': '消息操作',
          style: { ...S.messageMenu, left: placement.left, top: placement.top },
          onKeyDown: onMenuKeyDown,
          onContextMenu: (event) => event.preventDefault(),
        },
        actions.map((action, index) => {
          const previous = actions[index - 1];
          const divider = previous && previous.section !== action.section
            ? h('div', { key: `separator-${action.key}`, className: 'bt-msg-menu-sep', role: 'separator', style: S.messageMenuSeparator })
            : null;
          return h(
            React.Fragment,
            { key: action.key },
            divider,
            h(
              'button',
              {
                type: 'button',
                role: 'menuitem',
                className: `bt-msg-menu-item${action.danger ? ' bt-msg-menu-danger' : ''}`,
                style: S.messageMenuItem,
                disabled: action.disabled === true,
                'aria-disabled': action.disabled === true ? 'true' : undefined,
                title: action.title || action.label,
                onClick: (event) => {
                  event.stopPropagation();
                  choose(action);
                },
              },
              h('span', { className: 'bt-msg-menu-icon', style: S.messageMenuIcon }, h(MessageActionIcon, { name: action.icon })),
              h('span', { style: S.messageMenuLabel }, action.label),
            ),
          );
        }),
      );
    }

    function Composer({ state, dispatch, group, members, bots, replyTarget, userProfile, onClearReply, onSent, onResize }) {
      const isDirect = !!(group && group.kind === 'direct');
      const textareaRef = React.useRef(null);
      const shellRef = React.useRef(null);
      const onResizeRef = React.useRef(onResize);
      onResizeRef.current = onResize;
      const [text, setText] = React.useState('');
      const [mentions, setMentions] = React.useState([]);
      const [picker, setPicker] = React.useState(null);
      const [pickerIndex, setPickerIndex] = React.useState(0);
      const [sending, setSending] = React.useState(false);

      const memberEntries = members
        .map((member) => ({ member, bot: bots.find((candidate) => candidate.botId === member.botId) }))
        .filter((entry) => entry.bot);

      React.useEffect(() => {
        const node = textareaRef.current;
        if (!node) return;
        node.style.height = 'auto';
        const next = Math.min(Math.max(node.scrollHeight, 44), 180);
        node.style.height = `${next}px`;
        node.style.overflowY = node.scrollHeight > 180 ? 'auto' : 'hidden';
      }, [text]);

      React.useEffect(() => {
        if (!replyTarget) return;
        const node = textareaRef.current;
        if (node) node.focus();
      }, [replyTarget && replyTarget.messageId]);

      React.useEffect(() => {
        const node = shellRef.current;
        if (!node || typeof ResizeObserver !== 'function') return undefined;
        let frame = 0;
        const observer = new ResizeObserver(() => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => {
            if (onResizeRef.current) onResizeRef.current();
          });
        });
        observer.observe(node);
        return () => {
          cancelAnimationFrame(frame);
          observer.disconnect();
        };
      }, []);

      const updatePicker = (value, caret) => {
        // A single chat has one bot and every message targets it; no @ picker.
        if (isDirect) {
          setPicker(null);
          return;
        }
        const before = value.slice(0, caret);
        const match = /@([^\s@]*)$/.exec(before);
        if (!match) {
          setPicker(null);
          return;
        }
        const query = match[1].toLowerCase();
        const options = memberEntries.filter((entry) => entry.bot.name.toLowerCase().includes(query));
        if (options.length === 0) {
          setPicker(null);
          return;
        }
        setPicker({ start: match.index, query, options });
        setPickerIndex(0);
      };

      const onChange = (event) => {
        const value = event.target.value;
        setText(value);
        updatePicker(value, event.target.selectionStart ?? value.length);
      };

      const insertMention = (entry) => {
        const caret = textareaRef.current ? textareaRef.current.selectionStart : text.length;
        const start = picker ? picker.start : caret;
        const before = text.slice(0, start);
        const after = text.slice(caret);
        const inserted = `@${entry.bot.name} `;
        const next = `${before}${inserted}${after}`;
        setText(next);
        setMentions((current) => (current.includes(entry.member.membershipId) ? current : current.concat([entry.member.membershipId])));
        setPicker(null);
        setPickerIndex(0);
        const position = before.length + inserted.length;
        requestAnimationFrame(() => {
          const node = textareaRef.current;
          if (!node) return;
          node.focus();
          node.setSelectionRange(position, position);
        });
      };

      const openMentionPicker = () => {
        if (isDirect) return;
        if (memberEntries.length === 0) {
          dispatch({ type: 'flash', message: '先在右侧成员面板添加 Bot，再 @ 它们' });
          return;
        }
        const node = textareaRef.current;
        const caret = node ? node.selectionStart : text.length;
        const before = text.slice(0, caret);
        const needsSpace = before.length > 0 && !/\s$/.test(before);
        const inserted = needsSpace ? ' @' : '@';
        const next = `${before}${inserted}${text.slice(caret)}`;
        const start = before.length + (needsSpace ? 1 : 0);
        setText(next);
        setPicker({ start, query: '', options: memberEntries });
        setPickerIndex(0);
        const position = start + 1;
        requestAnimationFrame(() => {
          const target = textareaRef.current;
          if (!target) return;
          target.focus();
          target.setSelectionRange(position, position);
        });
      };

      const send = async () => {
        const trimmedText = text.trim();
        if (!trimmedText || sending) return;
        const stillMentioned = mentions.filter((membershipId) => {
          const entry = memberEntries.find((candidate) => candidate.member.membershipId === membershipId);
          return entry && trimmedText.includes(`@${entry.bot.name}`);
        });
        setSending(true);
        try {
          await api.action('message.post', {
            groupId: group.groupId,
            text: trimmedText,
            mentions: stillMentioned,
            replyTo: replyTarget ? replyTarget.messageId : undefined,
          });
          setText('');
          setMentions([]);
          setPicker(null);
          setPickerIndex(0);
          onClearReply && onClearReply();
          onSent && onSent();
        } catch (error) {
          dispatch({ type: 'error', message: String(error && error.message ? error.message : error) });
        } finally {
          setSending(false);
        }
      };

      const onKeyDown = (event) => {
        if (picker && picker.options.length > 0) {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setPickerIndex((current) => (current + 1) % picker.options.length);
            return;
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setPickerIndex((current) => (current - 1 + picker.options.length) % picker.options.length);
            return;
          }
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            insertMention(picker.options[pickerIndex] || picker.options[0]);
            return;
          }
        }
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          void send();
        }
        if (event.key === 'Escape') {
          setPicker(null);
        }
      };

      const running = members.filter((member) => state.statusByMember[member.membershipId] === 'running');
      const replyName = replyTarget ? displayNameOf(replyTarget, bots, userProfile) : '';

      return h(
        'div',
        { className: 'bt-composer-wrap', style: S.composerWrap },
        h(
          'div',
          { ref: shellRef, className: 'bt-composer', style: S.composerShell },
          picker
            ? h(
                'div',
                { style: S.picker, role: 'listbox', 'aria-label': '选择要提及的成员' },
                h(
                  'div',
                  { style: S.pickerHeader },
                  h('span', null, '选择成员'),
                  h('span', { style: S.pickerHint }, '↑↓ 选择 · Enter 确认'),
                ),
                picker.options.map((entry, index) =>
                  h(
                    'div',
                    {
                      key: entry.member.membershipId,
                      className: 'bt-picker-item',
                      'data-active': index === pickerIndex ? 'true' : 'false',
                      style: S.pickerItem,
                      role: 'option',
                      'aria-selected': index === pickerIndex,
                      onMouseEnter: () => setPickerIndex(index),
                      onMouseDown: (event) => {
                        event.preventDefault();
                        insertMention(entry);
                      },
                    },
                    h(Avatar, { bot: entry.bot, size: 22 }),
                    h('span', { style: S.pickerName }, entry.bot.name),
                    entry.member.running ? h('span', { style: S.pickerHint }, '回复中') : null,
                  ),
                ),
              )
            : null,
          replyTarget
            ? h(
                'div',
                { className: 'bt-reply-bar', style: S.replyBar },
                h(
                  'div',
                  { style: S.replyBarBody },
                  h('div', { style: S.replyBarLabel }, `回复 ${replyName}`),
                  h('div', { style: S.replyBarText }, cleanPreview(replyTarget.text, 120) || '[消息]'),
                ),
                h(
                  'button',
                  { type: 'button', style: S.replyBarClose, title: '取消回复', onClick: () => onClearReply && onClearReply() },
                  '×',
                ),
              )
            : null,
          h('textarea', {
            ref: textareaRef,
            style: S.textarea,
            value: text,
            placeholder: isDirect ? `给 ${group.title} 发消息…` : '输入消息，@ 成员派活…',
            onChange,
            onKeyDown,
            'aria-label': isDirect ? '单聊消息输入框' : '群聊消息输入框',
          }),
          h(
            'div',
            { style: S.composerFoot },
            isDirect
              ? null
              : h(
                  'button',
                  { type: 'button', className: 'bt-tool-btn', style: S.toolButton, onClick: openMentionPicker, title: '插入 @ 提及' },
                  '@ 提及',
                ),
            running.length > 0
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'bt-tool-btn bt-tool-danger',
                    style: { ...S.toolButton, ...S.toolDanger },
                    onClick: () => void api.action('message.stop', { groupId: group.groupId }).then(() => onSent && onSent()),
                  },
                  h('span', { style: { width: 6, height: 6, borderRadius: '50%', background: '#22c55e' } }),
                  `${running.length} 个 Bot 正在回复 · 停止`,
                )
              : null,
            h(
              'span',
              { style: S.composerHint },
              isDirect
                ? 'Enter 发送 · Shift + Enter 换行'
                : running.length > 0
                  ? 'Enter 发送 · Shift + Enter 换行'
                  : 'Enter 发送 · Shift + Enter 换行 · @ 提及成员',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'bt-send-btn',
                style: S.sendButton,
                disabled: sending || !text.trim(),
                onClick: () => void send(),
              },
              sending ? '发送中…' : '发送',
            ),
          ),
        ),
      );
    }

    /** Right rail for a single chat: bot identity + session/persona entry points. */
    function DirectPanel({ bot, group, member, usage, onEdit, onCollapse, onViewSession }) {
      const name = (bot && bot.name) || (group && group.title) || 'Bot';
      return h(
        'div',
        { id: 'bt-right-panel', className: 'bt-right-panel', style: S.right },
        h(
          'div',
          { style: S.rightHeader },
          h('span', null, '单聊'),
          onCollapse
            ? h(
                'button',
                {
                  type: 'button',
                  style: S.smallBtn,
                  title: '收起右侧面板',
                  'aria-label': '收起右侧面板',
                  onClick: onCollapse,
                },
                '»',
              )
            : null,
        ),
        h(
          'div',
          { style: S.directPanel },
          h(
            'div',
            { style: S.directCard },
            h(
              'div',
              { style: S.directIdentity },
              h(Avatar, { bot, name, size: 44 }),
              h(
                'div',
                { style: { minWidth: 0, flex: 1 } },
                h('div', { style: S.directName, title: name }, name),
                h('div', { style: S.directModel, title: bot ? `${bot.provider}/${bot.model}` : '' },
                  bot ? `${bot.provider}/${bot.model}` : '（Bot 已删除）'),
              ),
            ),
            h(
              'div',
              { style: S.directNote },
              '这是你与 Bot 的一对一会话。每条消息都会直接发给它，不需要 @；它的记忆与群聊相互独立。',
            ),
            h(
              'div',
              { style: S.directActions },
              h('button', { type: 'button', style: S.ghostBtn, disabled: !bot, onClick: () => bot && onEdit && onEdit(bot) }, '编辑 Bot'),
              member
                ? h('button', { type: 'button', style: S.ghostBtn, onClick: () => onViewSession && onViewSession(member) }, '查看会话')
                : null,
            ),
          ),
          usage && (usage.inputTokens > 0 || usage.outputTokens > 0)
            ? h(
                'div',
                { style: S.directCard },
                h('div', { style: { ...S.label, marginBottom: 4 } }, 'Token 用量（本单聊累计）'),
                h('div', { style: S.directNote },
                  `输入 ${Number(usage.inputTokens || 0).toLocaleString()} · 输出 ${Number(usage.outputTokens || 0).toLocaleString()} · 合计 ${Number(usage.totalTokens || 0).toLocaleString()}`),
              )
            : null,
          h(
            'div',
            { style: S.directNote },
            '人格与工作规范在「编辑 Bot → BOT.md」中维护，下一轮回复生效。',
          ),
        ),
      );
    }

    function MembersPanel({ state, group, members, bots, dispatch, onAdd, onCollapse, onEdit, onViewSession, discussion, usage, tasks, onStopDiscussion, onTaskCreate, onTaskAction, onTaskEdit, onTaskStream }) {
      const runningMembers = members.filter((member) => state.statusByMember[member.membershipId] === 'running');
      return h(
        'div',
        { id: 'bt-right-panel', className: 'bt-right-panel', style: S.right },
        h(
          'div',
          { style: S.rightHeader },
          h('span', null, `成员 (${members.length})`),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h('button', { style: S.smallBtn, onClick: onAdd }, '+ 添加'),
            onCollapse
              ? h(
                  'button',
                  {
                    type: 'button',
                    style: S.smallBtn,
                    title: '收起右侧面板',
                    'aria-label': '收起右侧面板',
                    onClick: onCollapse,
                  },
                  '»',
                )
              : null,
          ),
        ),
        h(
          'div',
          { style: S.memberList },
          h(
            'div',
            { style: { ...S.memberCard, fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #8a8f98)' } },
            (usage
              ? `本群 tokens：${usage.totalTokens ?? 0}（in ${usage.inputTokens ?? 0} / out ${usage.outputTokens ?? 0}）`
              : '本群 tokens：0') +
              (state.config.schemaVersion ? ` · schema v${state.config.schemaVersion}` : '') +
              (state.config.maxTurnsPerHour ? ` · 限 ${state.config.maxTurnsPerHour} 轮/小时` : ''),
            runningMembers.length > 0 ? ` · ${runningMembers.length} 个运行中` : '',
          ),
          h(
            'div',
            { style: S.memberCard },
            h(
              'div',
              { style: S.memberTop },
              h('span', { style: { ...S.memberName, fontSize: 12 } }, '任务 (' + (tasks ? tasks.length : 0) + ')'),
              h('button', { style: S.smallBtn, onClick: onTaskCreate }, '+ 新建任务'),
            ),
            (tasks || []).length === 0
              ? h('div', { style: { fontSize: 11, color: 'var(--bt-text-3)', marginTop: 6 } }, '还没有任务。新建并派发后，可中断执行、查看执行详情。')
              : (tasks || []).map((task) => {
                  const assigneeMember = members.find((member) => member.membershipId === task.assigneeMembershipId);
                  const assigneeBot = assigneeMember ? bots.find((bot) => bot.botId === assigneeMember.botId) : null;
                  const queued = group.queue && (group.queue.queuedTaskIds || []).includes(task.taskId);
                  const canDispatch = task.status === 'pending' && task.ready !== false;
                  const canInterrupt = task.status === 'in_progress';
                  const stateHint =
                    task.status === 'in_progress'
                      ? (queued ? '排队中' : '执行中')
                      : task.status === 'delivered'
                        ? '已交付'
                        : task.status === 'cancelled'
                          ? '已中断'
                          : '';
                  return h(
                    'div',
                    { key: task.taskId, style: { borderTop: '1px solid var(--bt-border)', paddingTop: 6, marginTop: 6 } },
                    h(
                      'div',
                      { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                      h('span', { style: badgeStyle('#eef2ff', '#4f46e5') }, TASK_STATUS_LABEL[task.status] || task.status),
                      h(
                        'span',
                        { style: { fontSize: 12, fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                        task.title,
                      ),
                    ),
                    h(
                      'div',
                      { style: { fontSize: 11, color: 'var(--bt-text-3)', marginTop: 3 } },
                      (assigneeBot ? '指派：' + assigneeBot.name : '指派：未知') + (stateHint ? ' · ' + stateHint : ''),
                    ),
                    task.blockedBy && task.blockedBy.length > 0
                      ? h(
                          'div',
                          { style: { fontSize: 11, color: '#b45309', marginTop: 3 } },
                          '依赖未完成：' + task.blockedBy.map((blocker) => blocker.title).join('、'),
                        )
                      : null,
                    h(
                      'div',
                      { style: S.memberActions },
                      canDispatch
                        ? h('button', { style: S.smallBtn, onClick: () => onTaskAction && onTaskAction(task, 'dispatch') }, '派发')
                        : null,
                      canInterrupt
                        ? h('button', { style: { ...S.smallBtn, color: 'var(--bt-danger-text)' }, onClick: () => onTaskAction && onTaskAction(task, 'cancel') }, '中断')
                        : null,
                      h('button', { style: S.smallBtn, onClick: () => onTaskStream && onTaskStream(task) }, '执行流'),
                    ),
                  );
                }),
          ),
          discussion
            ? h(
                'div',
                { style: { ...S.memberCard, borderColor: discussion.status === 'running' ? 'rgba(79,70,229,0.4)' : undefined } },
                h(
                  'div',
                  { style: S.memberTop },
                  h('span', { style: badgeStyle(discussion.status === 'running' ? '#eef2ff' : '#f3f4f6', discussion.status === 'running' ? '#4f46e5' : '#6b7280') }, discussion.status === 'running' ? '讨论中' : discussion.status === 'done' ? '讨论结束' : '讨论停止'),
                  h('span', { style: { ...S.memberName, fontSize: 12 } }, discussion.topic),
                ),
                h(
                  'div',
                  { style: S.memberMeta },
                  `第 ${Math.min(discussion.currentRound || 1, discussion.rounds)}/${discussion.rounds} 轮`,
                  discussion.status === 'running' && discussion.currentSpeaker
                    ? ` · ${(() => {
                        const speaker = members.find((member) => member.membershipId === discussion.currentSpeaker);
                        const speakerBot = speaker ? bots.find((bot) => bot.botId === speaker.botId) : null;
                        return speakerBot ? `${speakerBot.name} 发言中` : '发言中';
                      })()}`
                    : '',
                ),
                discussion.status === 'running'
                  ? h(
                      'div',
                      { style: S.memberActions },
                      h('button', { style: S.smallBtn, onClick: onStopDiscussion }, '停止讨论'),
                    )
                  : null,
              )
            : null,
          members.length === 0
            ? h('div', { style: { fontSize: 12, color: 'var(--bt-text-3)', padding: '10px 6px', lineHeight: 1.7 } }, '还没有成员。添加一个 Bot，或用「新建 Bot」创建一个带人格设定的成员。')
            : members.map((member) => {
                const bot = bots.find((candidate) => candidate.botId === member.botId);
                if (!bot) return null;
                const status = state.statusByMember[member.membershipId] || 'idle';
                return h(
                  'div',
                  { key: member.membershipId, style: S.memberCard },
                  h(
                    'div',
                    { style: S.memberTop },
                    h(
                      'span',
                      { style: { position: 'relative', display: 'inline-flex', flex: '0 0 auto' } },
                      h(Avatar, { bot, size: 26 }),
                      h('span', {
                        style: {
                          ...S.dot(bot.color, status),
                          position: 'absolute',
                          right: -1,
                          bottom: -1,
                          width: 8,
                          height: 8,
                          border: '2px solid #ffffff',
                        },
                      }),
                    ),
                    h('span', { style: S.memberName }, bot.name),
                    h('span', { style: { fontSize: 10, color: 'var(--bt-text-3)' } }, status === 'running' ? '运行中' : status === 'error' ? '出错' : '空闲'),
                  ),
                  h(
                    'div',
                    { style: S.memberMeta },
                    `${bot.model}`,
                    bot.reasoningEffort ? ` · effort ${bot.reasoningEffort}` : '',
                  ),
                  h(
                    'div',
                    { style: S.memberActions },
                    h('button', { style: S.smallBtn, onClick: () => onViewSession && onViewSession(member) }, '查看会话'),
                    h('button', { style: S.smallBtn, onClick: () => onEdit(bot) }, '编辑'),
                    h(
                      'button',
                      {
                        style: S.smallBtn,
                        onClick: async () => {
                          try {
                            await api.action('member.remove', { membershipId: member.membershipId });
                            dispatch({ type: 'refreshTick' });
                          } catch (error) {
                            dispatch({ type: 'error', message: String(error && error.message ? error.message : error) });
                          }
                        },
                      },
                      '移出群',
                    ),
                  ),
                );
              }),
        ),
      );
    }

    // ── dialogs ───────────────────────────────────────────────────────────
    function GroupFormDialog({ group, folders, folderId, onClose, onSaved }) {
      const [title, setTitle] = React.useState(group ? group.title : '');
      const [topic, setTopic] = React.useState(group ? group.topic || '' : '');
      const [workspaceCwd, setWorkspaceCwd] = React.useState(group ? group.workspaceCwd || '' : '');
      const [avatar, setAvatar] = React.useState(group ? group.avatar || '' : '');
      const [folder, setFolder] = React.useState(group ? group.folderId || '' : folderId || '');
      const avatarFileRef = React.useRef(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');

      const randomizeAvatar = () => {
        const seed = `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        setAvatar(`preset:${seed}`);
      };

      const handleAvatarFile = async (file) => {
        if (!file) return;
        try {
          setAvatar(await createAvatarDataUrl(file));
          setError('');
        } catch (reason) {
          setError(`群头像读取失败：${String(reason && reason.message ? reason.message : reason)}`);
        } finally {
          if (avatarFileRef.current) avatarFileRef.current.value = '';
        }
      };

      const submit = async () => {
        setBusy(true);
        setError('');
        try {
          const payload = { title, topic, workspaceCwd, avatar, folderId: folder || null };
          const result = group
            ? await api.action('group.update', { groupId: group.groupId, ...payload })
            : await api.action('group.create', payload);
          onSaved({ group: result && result.result, created: !group });
        } catch (reason) {
          setError(String(reason && reason.message ? reason.message : reason));
        } finally {
          setBusy(false);
        }
      };
      return h(
        Modal,
        {
          title: group ? '编辑群信息' : '新建群 / 话题',
          subtitle: '群头像会显示在左侧群列表和聊天顶部。',
          width: 640,
          onClose,
          footer: [
            h('button', { key: 'cancel', style: S.ghostBtn, disabled: busy, onClick: onClose }, '取消'),
            h('button', { key: 'ok', style: S.primaryBtn, disabled: busy, onClick: () => void submit() }, group ? '保存' : '创建'),
          ],
        },
        error ? h('div', { style: { ...S.errorBanner, borderRadius: 8, marginBottom: 10 } }, error) : null,
        h(
          Field,
          { label: '群名称', required: true },
          h('input', { style: S.input, value: title, maxLength: 120, onChange: (event) => setTitle(event.target.value), placeholder: '例如：产品方案评审' }),
        ),
        h(
          Field,
          { label: '分组', hint: (folders || []).length ? '分组在左侧「群聊」中可展开/收起，也可以直接拖动群调整位置。' : '还没有分组。可在左侧「群聊」标题右侧点文件夹图标新建。' },
          h(
            'select',
            { style: S.input, value: folder, onChange: (event) => setFolder(event.target.value) },
            h('option', { value: '' }, '不分组'),
            (folders || []).map((entry) => h('option', { key: entry.folderId, value: entry.folderId }, entry.title)),
          ),
        ),
        h('input', {
          ref: avatarFileRef,
          type: 'file',
          accept: 'image/*',
          style: { display: 'none' },
          onChange: (event) => void handleAvatarFile(event.target.files && event.target.files[0]),
        }),
        h(
          'div',
          { style: S.avatarRow },
          h(
            'div',
            { style: { width: 60, height: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' } },
            h(GroupAvatar, { group: { title: title || '新群', avatar }, size: 60 }),
          ),
          h(
            'div',
            { style: S.avatarPicker },
            h('div', { style: S.label }, '群头像'),
            h(
              'div',
              { style: S.avatarActions },
              h('button', { style: { ...S.ghostBtn, padding: '6px 14px' }, onClick: randomizeAvatar }, '随机配色'),
              h(
                'button',
                { style: { ...S.ghostBtn, padding: '6px 14px' }, onClick: () => avatarFileRef.current && avatarFileRef.current.click() },
                '上传图片',
              ),
              avatar
                ? h('button', { style: { ...S.smallBtn, color: 'var(--bt-text-3)' }, onClick: () => setAvatar('') }, '重置')
                : null,
            ),
            h(
              'div',
              { style: S.fieldHint },
              avatar.startsWith('data:')
                ? '已上传自定义群头像（自动裁成 256×256 方形）。'
                : avatar.startsWith('art:')
                  ? '当前是插画群头像；可随机配色或重置为按名称生成。'
                  : avatar.startsWith('preset:')
                    ? '当前是随机配色群头像；可再次随机或重置为按名称生成。'
                    : '默认按群名称生成渐变底色；可随机配色、选插画或上传图片。',
            ),
            h('div', { style: { ...S.label, marginTop: 10 } }, '插画头像'),
            h(
              'div',
              { style: S.artGrid },
              ART_AVATARS.map((art) =>
                h(
                  'button',
                  {
                    key: art.id,
                    title: art.label,
                    style: S.artOption(avatar === `art:${art.id}`),
                    onClick: () => setAvatar(`art:${art.id}`),
                  },
                  h(ArtAvatar, { id: art.id, size: 34, radius: 9 }),
                ),
              ),
            ),
          ),
        ),
        h(Field, { label: '话题（可选）' }, h('textarea', { style: { ...S.input, minHeight: 70 }, value: topic, onChange: (event) => setTopic(event.target.value), placeholder: '这个群要讨论什么' })),
        h(
          Field,
          {
            label: '工作目录（可选，绝对路径）',
            hint: '留空使用默认：$DSH_HOME/dsh-bot-team/groups/<群 id>；单聊默认 $DSH_HOME/dsh-bot-team/direct/<botId>。修改后 Bot 下一轮会重建 DSH 会话（群消息保留）。',
          },
          h('input', { style: S.input, value: workspaceCwd, onChange: (event) => setWorkspaceCwd(event.target.value), placeholder: '留空使用插件默认目录，或填 /Users/you/project' }),
        ),
      );
    }

    function FolderFormDialog({ folder, onClose, onSaved }) {
      const [title, setTitle] = React.useState(folder ? folder.title : '');
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const submit = async () => {
        const name = title.trim();
        if (!name) {
          setError('请先填写分组名称。');
          return;
        }
        setBusy(true);
        setError('');
        try {
          const result = folder
            ? await api.action('folder.update', { folderId: folder.folderId, title: name })
            : await api.action('folder.create', { title: name });
          onSaved({ folder: result && result.result, created: !folder });
        } catch (reason) {
          setError(String(reason && reason.message ? reason.message : reason));
        } finally {
          setBusy(false);
        }
      };
      return h(
        Modal,
        {
          title: folder ? '重命名分组' : '新建分组',
          subtitle: '分组只影响左侧群聊列表的整理方式，不会移动或删除群内消息。',
          width: 420,
          onClose,
          footer: [
            h('button', { key: 'cancel', style: S.ghostBtn, disabled: busy, onClick: onClose }, '取消'),
            h('button', { key: 'ok', style: S.primaryBtn, disabled: busy, onClick: () => void submit() }, folder ? '保存' : '创建'),
          ],
        },
        error ? h('div', { style: { ...S.errorBanner, borderRadius: 8, marginBottom: 10 } }, error) : null,
        h(
          Field,
          { label: '分组名称', required: true, hint: '例如：工作、产品、个人。同名分组只能有一个。' },
          h('input', {
            style: S.input,
            value: title,
            maxLength: 40,
            autoFocus: true,
            onChange: (event) => setTitle(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void submit();
              }
            },
            placeholder: '例如：工作',
          }),
        ),
      );
    }

    function BotLibraryDialog({ bots, members, groups, onClose, onCreate, onEdit, onChanged }) {
      const [busyId, setBusyId] = React.useState('');
      const [error, setError] = React.useState('');
      const groupChatsOf = (botId) => members
        .filter((member) => member.botId === botId)
        .map((member) => groups.find((group) => group.groupId === member.groupId))
        .filter((group) => group && group.kind !== 'direct');
      const remove = async (bot) => {
        const inGroups = groupChatsOf(bot.botId);
        const hasDirect = members.some((member) => {
          const group = groups.find((candidate) => candidate.groupId === member.groupId);
          return member.botId === bot.botId && group && group.kind === 'direct';
        });
        const warning = [
          inGroups.length
            ? `它正在 ${inGroups.length} 个群中（${inGroups.map((group) => group.title).join('、')}），删除会同时把它移出这些群。`
            : '',
          hasDirect ? '它的单聊与全部单聊消息也会一并删除。' : '',
        ].filter(Boolean).join('\n');
        if (!window.confirm('从全局 Bot 库删除「' + bot.name + '」？' + (warning ? `\n\n${warning}` : ''))) return;
        setBusyId(bot.botId);
        setError('');
        try {
          await api.action('bot.delete', { botId: bot.botId });
          onChanged();
        } catch (reason) {
          setError(String(reason && reason.message ? reason.message : reason));
        } finally {
          setBusyId('');
        }
      };
      return h(
        Modal,
        {
          title: 'Bot 管理（全局）',
          onClose,
          footer: [
            h('button', { key: 'new', style: S.primaryBtn, onClick: onCreate }, '+ 新建 Bot'),
            h('button', { key: 'close', style: S.ghostBtn, onClick: onClose }, '关闭'),
          ],
        },
        error ? h('div', { style: { ...S.errorBanner, borderRadius: 8, marginBottom: 10 } }, error) : null,
        h(
          'div',
          { style: { fontSize: 11, color: 'var(--bt-text-3)', marginBottom: 8, lineHeight: 1.6 } },
          'Bot 是全局可复用的 Agent：每个 Bot 自动拥有一个单聊，也可以加入多个群，每个群内有独立会话与记忆。这里管理全局 Bot 库。',
        ),
        bots.length === 0
          ? h('div', { style: { fontSize: 12, color: 'var(--bt-text-3)' } }, '还没有 Bot，点「+ 新建 Bot」创建一个。')
          : bots.map((bot) => {
              const inGroups = groupChatsOf(bot.botId);
              return h(
                'div',
                { key: bot.botId, style: { borderTop: '1px solid var(--bt-border)', padding: '8px 0' } },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                  h(Avatar, { bot, size: 24 }),
                  h('span', { style: { fontSize: 13, fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, bot.name),
                ),
                h(
                  'div',
                  { style: { fontSize: 11, color: 'var(--bt-text-3)', marginTop: 2 } },
                  bot.provider + '/' + bot.model + (inGroups.length ? ' · 群：' + inGroups.map((group) => group.title).join('、') : ' · 未加入任何群聊'),
                ),
                h(
                  'div',
                  { style: S.memberActions },
                  h('button', { style: S.smallBtn, onClick: () => onEdit(bot) }, '编辑'),
                  h(
                    'button',
                    { style: { ...S.smallBtn, color: 'var(--bt-danger-text)' }, disabled: busyId === bot.botId, onClick: () => void remove(bot) },
                    busyId === bot.botId ? '删除中…' : '删除',
                  ),
                ),
              );
            }),
      );
    }

    function BotFormDialog({ bot, modelCatalog, onClose, onSaved }) {
      const editing = !!bot;
      const groups = modelCatalog.groups || [];
      const defaultProvider = bot ? bot.provider : groups[0] && groups[0].id;
      const defaultGroup = groups.find((group) => group.id === defaultProvider) || groups[0];
      const defaultModel = bot ? bot.model : defaultGroup && defaultGroup.models[0] && defaultGroup.models[0].id;
      const [name, setName] = React.useState(bot ? bot.name : '');
      const [avatar, setAvatar] = React.useState(bot ? bot.avatar || '' : '');
      const avatarFileRef = React.useRef(null);
      const [provider, setProvider] = React.useState(defaultProvider || '');
      const [model, setModel] = React.useState(defaultModel || '');
      const [reasoningEffort, setReasoningEffort] = React.useState(bot ? bot.reasoningEffort || '' : '');
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [botMd, setBotMd] = React.useState('');
      const [personaLoaded, setPersonaLoaded] = React.useState(!editing);
      const [personaStatus, setPersonaStatus] = React.useState('');
      const [templateMenuOpen, setTemplateMenuOpen] = React.useState(false);
      const [templateNote, setTemplateNote] = React.useState('');
      const personaRef = React.useRef(null);
      const personaDisabled = editing && !personaLoaded;

      const providerGroup = groups.find((group) => group.id === provider) || groups[0];
      const modelInfo = providerGroup ? providerGroup.models.find((candidate) => candidate.id === model) : undefined;
      const efforts = modelInfo && modelInfo.reasoning ? modelInfo.reasoning.efforts : [];
      const canSubmit = !busy && name.trim().length > 0 && (!editing || personaLoaded);

      React.useEffect(() => {
        if (!editing) return;
        let cancelled = false;
        api.fileGet(bot.botId, 'bot')
          .then((result) => {
            if (cancelled) return;
            setBotMd(result.text || '');
            setPersonaLoaded(true);
          })
          .catch((reason) => {
            if (!cancelled) {
              setPersonaStatus(`读取 BOT.md 失败：${String(reason && reason.message ? reason.message : reason)}`);
            }
          });
        return () => {
          cancelled = true;
        };
      }, [editing, bot && bot.botId]);

      const onProviderChange = (value) => {
        setProvider(value);
        const group = groups.find((candidate) => candidate.id === value);
        const firstModel = group && group.models[0] && group.models[0].id;
        setModel(firstModel || '');
        setReasoningEffort('');
      };

      React.useEffect(() => {
        if (!templateMenuOpen) return undefined;
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            setTemplateMenuOpen(false);
          }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
      }, [templateMenuOpen]);

      /** 内容里是否已包含某个模板（仅用于菜单里的「已包含」提示）。 */
      const templateApplied = (template) => botMd.includes(template.body.trim());

      /** 末尾正好是一份已知模板时，替换它而不是叠加第二份。 */
      const trailingTemplateBody = (text) =>
        PERSONA_TEMPLATES.map((template) => template.body.trim())
          .sort((a, b) => b.length - a.length)
          .find((body) => text === body || text.endsWith(`\n\n${body}`)) || '';

      const applyTemplate = (template) => {
        const body = template.body.trim();
        const alreadyApplied = templateApplied(template);
        setBotMd((current) => {
          const text = current.replace(/\s+$/, '');
          if (!text) return template.body;
          const trailing = trailingTemplateBody(text);
          if (trailing) {
            if (trailing === body) return current;
            const head = text.slice(0, text.length - trailing.length).replace(/\s+$/, '');
            return head ? `${head}\n\n${template.body}` : template.body;
          }
          if (text.includes(body)) return current;
          return `${text}\n\n${template.body}`;
        });
        setTemplateMenuOpen(false);
        setTemplateNote(
          alreadyApplied ? '当前内容已包含该模板，未重复插入。' : `已插入「${template.title}」模板，可按需修改。`,
        );
        requestAnimationFrame(() => {
          const node = personaRef.current;
          if (!node) return;
          node.focus();
          try {
            node.setSelectionRange(node.value.length, node.value.length);
          } catch {
            /* 忽略：某些浏览器在 disabled 时不允许设置选区 */
          }
        });
      };

      const randomizeAvatar = () => {
        const seed = `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        setAvatar(`preset:${seed}`);
      };

      const handleAvatarFile = async (file) => {
        if (!file) return;
        try {
          setAvatar(await createAvatarDataUrl(file));
          setError('');
        } catch (reason) {
          setError(`头像读取失败：${String(reason && reason.message ? reason.message : reason)}`);
        } finally {
          if (avatarFileRef.current) avatarFileRef.current.value = '';
        }
      };

      const submit = async () => {
        if (!name.trim()) {
          setError('请先填写显示名。');
          return;
        }
        setBusy(true);
        setError('');
        try {
          const payload = { name: name.trim(), avatar, provider, model, reasoningEffort };
          let botId = editing ? bot.botId : '';
          if (editing) {
            await api.action('bot.update', { botId: bot.botId, ...payload });
            if (personaLoaded) {
              await api.filePut(bot.botId, 'bot', botMd);
            }
          } else {
            const result = await api.action('bot.create', payload);
            botId = (result && result.result && result.result.botId) || '';
            if (botId) {
              await api.filePut(botId, 'bot', botMd);
            }
          }
          // The page opens the new bot's single chat after bootstrap reloads.
          onSaved({ botId, created: !editing });
        } catch (reason) {
          setError(String(reason && reason.message ? reason.message : reason));
        } finally {
          setBusy(false);
        }
      };

      const deleteBot = async () => {
        if (!editing) return;
        if (!window.confirm(`删除 Bot「${bot.name}」？它会从所有群移除，单聊与单聊消息也会一并删除。`)) return;
        setBusy(true);
        try {
          await api.action('bot.delete', { botId: bot.botId });
          onSaved();
        } catch (reason) {
          setError(String(reason && reason.message ? reason.message : reason));
        } finally {
          setBusy(false);
        }
      };

      return h(
        Modal,
        {
          title: editing ? `编辑 Bot：${bot.name}` : '新建 Bot',
          subtitle: editing
            ? '调整它的模型与人格设定；所有 Bot 默认具备完整工具权限。'
            : '创建一个可复用的 Agent：定好它是谁、用什么模型。',
          width: 720,
          onClose,
          footer: [
            editing
              ? h('button', { key: 'del', style: { ...S.dangerBtn, marginRight: 'auto' }, disabled: busy, onClick: () => void deleteBot() }, '删除 Bot')
              : null,
            h('button', { key: 'cancel', style: S.ghostBtn, disabled: busy, onClick: onClose }, '取消'),
            h('button', { key: 'ok', style: S.primaryBtn, disabled: !canSubmit, onClick: () => void submit() }, editing ? '保存' : '创建 Bot'),
          ],
        },
        error ? h('div', { style: { ...S.errorBanner, borderRadius: 8, marginBottom: 12 } }, error) : null,
        h(
          Field,
          {
            label: '显示名',
            required: true,
            hint: '群里 @ 时使用；Bot 之间也用它互相称呼。',
            style: { marginBottom: 16 },
          },
          h('input', {
            style: S.input,
            value: name,
            maxLength: 40,
            onChange: (event) => setName(event.target.value),
            placeholder: '例如：架构师 Alice',
            autoFocus: !editing,
          }),
        ),
        h('input', {
          ref: avatarFileRef,
          type: 'file',
          accept: 'image/*',
          style: { display: 'none' },
          onChange: (event) => void handleAvatarFile(event.target.files && event.target.files[0]),
        }),
        h(
          'div',
          { style: S.avatarRow },
          h(
            'div',
            { style: S.avatarPreview },
            h(Avatar, {
              bot: { avatar, name: name.trim() || 'A', color: (bot && bot.color) || '#2f7ed8' },
              name: name.trim() || 'A',
              color: (bot && bot.color) || '#2f7ed8',
              size: 60,
            }),
          ),
          h(
            'div',
            { style: S.avatarPicker },
            h('div', { style: S.label }, '头像'),
            h(
              'div',
              { style: S.avatarActions },
              h('button', { style: { ...S.ghostBtn, padding: '6px 14px' }, onClick: randomizeAvatar }, '随机生成'),
              h(
                'button',
                { style: { ...S.ghostBtn, padding: '6px 14px' }, onClick: () => avatarFileRef.current && avatarFileRef.current.click() },
                '上传图片',
              ),
              avatar
                ? h('button', { style: { ...S.smallBtn, color: 'var(--bt-text-3)' }, onClick: () => setAvatar('') }, '重置')
                : null,
            ),
            h(
              'div',
              { style: S.fieldHint },
              avatar.startsWith('data:')
                ? '已上传自定义图片（自动裁成 256×256 方形）。'
                : avatar.startsWith('art:')
                  ? '当前是插画头像；可随机换机器人或重置为按名称生成。'
                  : avatar.startsWith('preset:')
                    ? '当前是随机生成的机器人头像；可再次随机或重置为按名称生成。'
                    : '默认按名称生成机器人头像；点「随机生成」换一个配色/表情。',
            ),
            h('div', { style: { ...S.label, marginTop: 12 } }, '插画头像'),
            h(
              'div',
              { style: S.artGrid },
              ART_AVATARS.map((art) =>
                h(
                  'button',
                  {
                    key: art.id,
                    title: art.label,
                    style: S.artOption(avatar === `art:${art.id}`),
                    onClick: () => setAvatar(`art:${art.id}`),
                  },
                  h(ArtAvatar, { id: art.id, size: 34 }),
                ),
              ),
            ),
          ),
        ),
        h(
          'div',
          { style: S.sectionHeader },
          h('span', { style: S.sectionTitle }, '模型与工具'),
          h('span', { style: S.sectionMeta }, '所有 Bot 均具备完整工具权限'),
        ),
        h(
          'div',
          { style: S.formGrid },
          h(
            Field,
            { label: 'Provider', style: { marginBottom: 0 } },
            h(
              'select',
              { style: S.input, value: provider, onChange: (event) => onProviderChange(event.target.value) },
              groups.map((group) => h('option', { key: group.id, value: group.id }, group.name || group.id)),
            ),
          ),
          h(
            Field,
            { label: 'Model', style: { marginBottom: 0 } },
            h(
              'select',
              { style: S.input, value: model, onChange: (event) => setModel(event.target.value) },
              (providerGroup ? providerGroup.models : []).map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name || entry.id)),
            ),
          ),
        ),
        h(
          'div',
          { style: { ...S.formGrid, marginTop: 12 } },
          h(
            Field,
            { label: 'Reasoning effort', style: { marginBottom: 0 } },
            h(
              'select',
              { style: S.input, value: reasoningEffort, onChange: (event) => setReasoningEffort(event.target.value) },
              h('option', { value: '' }, '默认'),
              efforts.map((effort) => h('option', { key: effort.id, value: effort.id }, effort.name || effort.id)),
            ),
          ),
          h(
            'div',
            null,
            h('div', { style: S.label }, '可用工具'),
            h(
              'div',
              { style: S.toolChips },
              ['文件读写', '搜索', '联网', '命令'].map((label) =>
                h('span', { key: label, style: S.toolChip }, label),
              ),
            ),
          ),
        ),
        h('div', { style: S.sectionDivider }),
        h(
          'div',
          { style: S.personaCard },
          h(
            'div',
            { style: S.personaHead },
            h('span', { style: S.personaTitle }, '人格与工作规范'),
            h('span', { style: S.fileChip }, 'BOT.md'),
            h('span', { style: { flex: 1 } }),
            h('span', { style: S.metaBadge }, '下一轮回复生效'),
          ),
          h(
            'div',
            { style: S.personaIntro },
            '只维护一个文件：先写「你是谁」，再写「你怎么做事」。建议保留「人格」「工作规范」两个小节标题，模型更容易遵循；也可以从模板库选一个人设快速起步。',
          ),
          personaStatus
            ? h('div', { style: { ...S.errorBanner, borderRadius: 8, marginBottom: 8, border: '1px solid var(--bt-danger-border)' } }, personaStatus)
            : null,
          h('textarea', {
            ref: personaRef,
            className: 'bt-persona-textarea',
            style: S.personaTextarea,
            value: botMd,
            disabled: personaDisabled,
            spellCheck: false,
            onChange: (event) => {
              setBotMd(event.target.value);
              if (templateNote) setTemplateNote('');
            },
            placeholder: `例如（也可点「插入模板」选一套）：\n${PERSONA_TEMPLATE}`,
          }),
          h(
            'div',
            { style: S.personaFoot },
            h(
              'div',
              { style: S.templateWrap },
              h(
                'button',
                {
                  type: 'button',
                  className: 'bt-persona-tpl-btn',
                  style: S.templateBtn,
                  disabled: personaDisabled,
                  onClick: () => setTemplateMenuOpen((open) => !open),
                  'aria-haspopup': 'menu',
                  'aria-expanded': templateMenuOpen,
                },
                '插入模板',
                h('span', { style: S.templateCaret }, '▾'),
              ),
              templateMenuOpen
                ? h(
                    React.Fragment,
                    null,
                    h('div', { className: 'bt-menu-backdrop', onClick: () => setTemplateMenuOpen(false) }),
                    h(
                      'div',
                      { className: 'bt-menu bt-persona-menu', style: S.templateMenu, role: 'menu', 'aria-label': '人格模板库' },
                      h(
                        'div',
                        { style: S.templateMenuHead },
                        h('span', { style: S.templateMenuTitle }, '人格模板库'),
                        h('span', { style: S.templateMenuHint }, `${PERSONA_TEMPLATES.length} 个可选`),
                      ),
                      PERSONA_TEMPLATES.map((template) =>
                        h(
                          'button',
                          {
                            key: template.id,
                            type: 'button',
                            role: 'menuitem',
                            className: 'bt-persona-tpl',
                            style: S.templateItem,
                            onClick: () => applyTemplate(template),
                          },
                          h(
                            'div',
                            { style: S.templateItemRow },
                            h('span', { style: S.templateItemTitle }, template.title),
                            templateApplied(template)
                              ? h('span', { style: S.templateUsedTag }, '已包含')
                              : template.tag
                                ? h('span', { style: S.templateTag }, template.tag)
                                : null,
                          ),
                          h('div', { style: S.templateItemSummary }, template.summary),
                        ),
                      ),
                      h('div', { style: S.templateMenuFoot }, '空内容直接填入；已有内容追加到末尾，末尾是旧模板时自动替换。'),
                    ),
                  )
                : null,
            ),
            h('span', { style: S.personaTip }, templateNote || '支持 Markdown · 留空则只使用默认角色设定'),
            h('span', { style: S.charCount }, `${botMd.length} 字`),
          ),
        ),
      );
    }

    function AddMemberDialog({ group, bots, members, onClose, onSaved }) {
      const existing = new Set(members.map((member) => member.botId));
      const available = bots.filter((bot) => !existing.has(bot.botId));
      const [botId, setBotId] = React.useState(available[0] ? available[0].botId : '');
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const submit = async () => {
        if (!botId) return;
        setBusy(true);
        try {
          await api.action('member.add', { groupId: group.groupId, botId });
          onSaved();
        } catch (reason) {
          setError(String(reason && reason.message ? reason.message : reason));
        } finally {
          setBusy(false);
        }
      };
      return h(
        Modal,
        {
          title: `添加成员到「${group.title}」`,
          onClose,
          footer: [
            h('button', { key: 'cancel', style: S.ghostBtn, onClick: onClose }, '取消'),
            h('button', { key: 'ok', style: S.primaryBtn, disabled: busy || !botId, onClick: () => void submit() }, '添加'),
          ],
        },
        error ? h('div', { style: { ...S.errorBanner, borderRadius: 8, marginBottom: 10 } }, error) : null,
        available.length === 0
          ? h('div', { style: { fontSize: 13, color: 'var(--bt-text-3)' } }, 'Bot 库里的 Bot 都已在群里。先关闭此窗口，用「新建 Bot」创建一个。')
          : h(
              Field,
              { label: '选择 Bot' },
              h(
                'select',
                { style: S.input, value: botId, onChange: (event) => setBotId(event.target.value) },
                available.map((bot) => h('option', { key: bot.botId, value: bot.botId }, `${bot.name}（${bot.model}）`)),
              ),
            ),
      );
    }

    function TaskDialog({ group, members, bots, onClose, onSaved }) {
      const candidates = members
        .map((member) => ({ member, bot: bots.find((candidate) => candidate.botId === member.botId) }))
        .filter((entry) => entry.bot);
      const [title, setTitle] = React.useState('');
      const [description, setDescription] = React.useState('');
      const [acceptance, setAcceptance] = React.useState('');
      const [assigneeMembershipId, setAssigneeMembershipId] = React.useState(
        candidates[0] ? candidates[0].member.membershipId : '',
      );
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const submit = async () => {
        if (!assigneeMembershipId) return;
        setBusy(true);
        setError('');
        try {
          await api.action('task.create', {
            groupId: group.groupId,
            title,
            description,
            acceptance,
            assigneeMembershipId,
          });
          uiReport({ kind: 'action', action: 'task.create' });
          onSaved();
        } catch (reason) {
          setError(String(reason && reason.message ? reason.message : reason));
        } finally {
          setBusy(false);
        }
      };
      return h(
        Modal,
        {
          title: '新建任务',
          onClose,
          footer: [
            h('button', { key: 'cancel', style: S.ghostBtn, onClick: onClose }, '取消'),
            h('button', { key: 'ok', style: S.primaryBtn, disabled: busy || !assigneeMembershipId, onClick: () => void submit() }, '创建任务'),
          ],
        },
        error ? h('div', { style: { ...S.errorBanner, borderRadius: 8, marginBottom: 10 } }, error) : null,
        h(Field, { label: '任务标题' }, h('input', { style: S.input, value: title, onChange: (event) => setTitle(event.target.value), placeholder: '例如：实现登录页表单校验' })),
        h(Field, { label: '任务描述（可选）' }, h('textarea', { style: { ...S.input, minHeight: 80 }, value: description, onChange: (event) => setDescription(event.target.value), placeholder: '目标、范围、注意事项…' })),
        h(Field, { label: '验收标准（可选）' }, h('textarea', { style: { ...S.input, minHeight: 60 }, value: acceptance, onChange: (event) => setAcceptance(event.target.value), placeholder: '例如：单测通过、无 lint 错误' })),
        h(
          Field,
          { label: '指派给' },
          h(
            'select',
            { style: S.input, value: assigneeMembershipId, onChange: (event) => setAssigneeMembershipId(event.target.value) },
            candidates.map((entry) => h('option', { key: entry.member.membershipId, value: entry.member.membershipId }, entry.bot.name)),
          ),
        ),
        h('div', { style: { fontSize: 11, color: 'var(--bt-text-3)' } }, '创建后点任务卡片「派发」开始执行；执行中可「中断」；点「执行流」查看该 Bot 的完整执行过程。'),
      );
    }

    function ReviewDialog({ target, group, members, bots, onClose, onSaved }) {
      const candidates = members
        .map((member) => ({ member, bot: bots.find((candidate) => candidate.botId === member.botId) }))
        .filter((entry) => entry.bot);
      const [reviewerMembershipId, setReviewerMembershipId] = React.useState(
        candidates[0] ? candidates[0].member.membershipId : '',
      );
      const [instructions, setInstructions] = React.useState('');
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const submit = async () => {
        if (!reviewerMembershipId) return;
        setBusy(true);
        setError('');
        try {
          await api.action('review.request', {
            groupId: group.groupId,
            targetMessageId: target.messageId,
            reviewerMembershipId,
            instructions,
          });
          uiReport({ kind: 'action', action: 'review.request' });
          onSaved();
        } catch (reason) {
          setError(String(reason && reason.message ? reason.message : reason));
        } finally {
          setBusy(false);
        }
      };
      return h(
        Modal,
        {
          title: '请人评审',
          onClose,
          footer: [
            h('button', { key: 'cancel', style: S.ghostBtn, onClick: onClose }, '取消'),
            h('button', { key: 'ok', style: S.primaryBtn, disabled: busy || !reviewerMembershipId, onClick: () => void submit() }, '发起评审'),
          ],
        },
        error ? h('div', { style: { ...S.errorBanner, borderRadius: 8, marginBottom: 10 } }, error) : null,
        h(Field, { label: `被评审消息 #${target.seq}` }, h('div', { style: { ...S.input, maxHeight: 120, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 12, color: 'var(--bt-text-2)' } }, target.text || '（空）')),
        h(
          Field,
          { label: '评审者' },
          h(
            'select',
            { style: S.input, value: reviewerMembershipId, onChange: (event) => setReviewerMembershipId(event.target.value) },
            candidates.map((entry) => h('option', { key: entry.member.membershipId, value: entry.member.membershipId }, entry.bot.name)),
          ),
        ),
        h(Field, { label: '评审要求（可选）' }, h('textarea', {
          style: { ...S.input, minHeight: 70 },
          value: instructions,
          onChange: (event) => setInstructions(event.target.value),
          placeholder: '例如：重点检查方案风险与遗漏；输出 结论：通过/需修改，再给建议。',
        })),
      );
    }

    function DiscussionDialog({ group, members, bots, defaultTopic, onClose, onSaved }) {
      const candidates = members
        .map((member) => ({ member, bot: bots.find((candidate) => candidate.botId === member.botId) }))
        .filter((entry) => entry.bot);
      const [topic, setTopic] = React.useState(defaultTopic || '');
      const [selected, setSelected] = React.useState(candidates.map((entry) => entry.member.membershipId));
      const [rounds, setRounds] = React.useState(2);
      const [summarize, setSummarize] = React.useState(true);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const toggle = (membershipId) => {
        setSelected((current) => current.includes(membershipId)
          ? current.filter((value) => value !== membershipId)
          : current.concat([membershipId]));
      };
      const submit = async () => {
        setBusy(true);
        setError('');
        try {
          await api.action('discussion.start', {
            groupId: group.groupId,
            topic,
            membershipIds: selected,
            rounds,
            summarize,
          });
          uiReport({ kind: 'action', action: 'discussion.start' });
          onSaved();
        } catch (reason) {
          setError(String(reason && reason.message ? reason.message : reason));
        } finally {
          setBusy(false);
        }
      };
      return h(
        Modal,
        {
          title: '发起讨论',
          onClose,
          footer: [
            h('button', { key: 'cancel', style: S.ghostBtn, onClick: onClose }, '取消'),
            h('button', { key: 'ok', style: S.primaryBtn, disabled: busy || selected.length === 0, onClick: () => void submit() }, '开始讨论'),
          ],
        },
        error ? h('div', { style: { ...S.errorBanner, borderRadius: 8, marginBottom: 10 } }, error) : null,
        h(Field, { label: '讨论议题' }, h('textarea', {
          style: { ...S.input, minHeight: 70 },
          value: topic,
          onChange: (event) => setTopic(event.target.value),
          placeholder: '例如：如何看待把 Agent 群聊接入现有 IM？',
        })),
        h(
          Field,
          { label: '参与成员' },
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            candidates.map((entry) =>
              h(
                'label',
                { key: entry.member.membershipId, style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 } },
                h('input', {
                  type: 'checkbox',
                  checked: selected.includes(entry.member.membershipId),
                  onChange: () => toggle(entry.member.membershipId),
                }),
                h(Avatar, { bot: entry.bot, size: 22 }),
                entry.bot.name,
              ),
            ),
          ),
        ),
        h(
          'div',
          { style: S.row },
          h(
            Field,
            { label: '轮数' },
            h(
              'select',
              { style: S.input, value: rounds, onChange: (event) => setRounds(Number(event.target.value)) },
              [1, 2, 3, 4, 5].map((value) => h('option', { key: value, value }, `${value} 轮`)),
            ),
          ),
          h(
            Field,
            { label: '结束总结' },
            h(
              'label',
              { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, paddingTop: 6 } },
              h('input', { type: 'checkbox', checked: summarize, onChange: (event) => setSummarize(event.target.checked) }),
              '结束后由第一位成员输出共识/分歧/待决',
            ),
          ),
        ),
      );
    }

    // ── page ──────────────────────────────────────────────────────────────
    function BotTeamPage() {
      // Read the collapse preference per mount: initialState is module-level and
      // would otherwise restore the value from the first page load.
      const [state, dispatch] = React.useReducer(reducer, initialState, (initial) => ({
        ...initial,
        sidebarCollapsed: readSidebarCollapsed(),
        rightPanelCollapsed: readRightPanelCollapsed(),
        sectionsCollapsed: readSectionsCollapsed(),
      }));
      const refresh = useBootstrap(dispatch);
      const [userProfile, setUserProfile] = React.useState(null);

      React.useEffect(() => {
        let cancelled = false;
        const controller = new AbortController();
        const load = async () => {
          const profile = await fetchAccountProfile();
          if (!cancelled) setUserProfile(profile);
        };
        void load();
        const account = appCtx && appCtx.remote && appCtx.remote.account;
        if (account && typeof account.watch === 'function') {
          (async () => {
            try {
              for await (const frame of account.watch(controller.signal)) {
                if (cancelled) break;
                const status = frame && frame.value && frame.value.status;
                if (status === 'signed-out') setUserProfile(null);
                else if (status === 'credential-stored') void load();
              }
            } catch {
              /* account stream unavailable */
            }
          })();
        }
        return () => {
          cancelled = true;
          controller.abort();
        };
      }, []);

      React.useEffect(() => {
        if (state.refreshTick > 0) void refresh();
      }, [state.refreshTick, refresh]);

      React.useEffect(() => {
        if (state.flash) {
          const timer = setTimeout(() => dispatch({ type: 'flash', message: '' }), 2500);
          return () => clearTimeout(timer);
        }
        return undefined;
      }, [state.flash]);

      React.useEffect(() => {
        persistSidebarCollapsed(state.sidebarCollapsed === true);
      }, [state.sidebarCollapsed]);

      React.useEffect(() => {
        persistRightPanelCollapsed(state.rightPanelCollapsed === true);
      }, [state.rightPanelCollapsed]);

      React.useEffect(() => {
        persistSectionsCollapsed(state.sectionsCollapsed || {});
      }, [state.sectionsCollapsed]);

      useSse(state.activeGroupId, dispatch);

      const reportedRef = React.useRef(false);
      React.useEffect(() => {
        if (state.loading || reportedRef.current) return;
        reportedRef.current = true;
        uiReport({
          kind: 'bootstrap-loaded',
          bots: state.bots.length,
          groups: state.groups.length,
          members: state.members.length,
          activeGroupId: state.activeGroupId,
        });
      }, [state.loading, state.bots.length, state.groups.length, state.members.length, state.activeGroupId]);

      React.useEffect(() => {
        if (!state.activeGroupId) return;
        let cancelled = false;
        api.messages(state.activeGroupId)
          .then((result) => {
            if (cancelled) return;
            dispatch({ type: 'messages', groupId: state.activeGroupId, messages: result.messages || [], hasMore: result.hasMore === true });
            uiReport({
              kind: 'messages-loaded',
              groupId: state.activeGroupId,
              count: (result.messages || []).length,
            });
          })
          .catch((error) => dispatch({ type: 'error', message: String(error && error.message ? error.message : error) }));
        return () => {
          cancelled = true;
        };
      }, [state.activeGroupId, state.messagesTick]);

      const activeGroup = state.groups.find((group) => group.groupId === state.activeGroupId) || null;
      const members = state.members.filter((member) => member.groupId === state.activeGroupId);
      const activeIsDirect = isDirectGroup(activeGroup);
      const activeDirectMember = activeIsDirect ? members[0] || null : null;
      const activeDirectBot = activeIsDirect
        ? state.bots.find((bot) => bot.botId === activeGroup.botId) || null
        : null;
      const messages = state.messagesByGroup[state.activeGroupId] || EMPTY_MESSAGES;
      const timelineRef = React.useRef(null);
      const [replyTarget, setReplyTarget] = React.useState(null);
      const [messageMenu, setMessageMenu] = React.useState(null);
      const [headerMenuOpen, setHeaderMenuOpen] = React.useState(false);
      const [showJump, setShowJump] = React.useState(false);
      const [newCount, setNewCount] = React.useState(0);
      const [unreadFromSeq, setUnreadFromSeq] = React.useState(null);
      const scrollStateRef = React.useRef({ groupId: null, lastSeq: 0, stick: true });
      const pendingPrependRef = React.useRef(null);

      const scrollToLatest = (behavior) => {
        const node = timelineRef.current;
        if (!node) return;
        node.scrollTo({ top: node.scrollHeight, behavior: behavior || 'auto' });
        scrollStateRef.current.stick = true;
        setShowJump(false);
        setNewCount(0);
        setUnreadFromSeq(null);
      };

      const onTimelineScroll = () => {
        const node = timelineRef.current;
        if (!node) return;
        const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 72;
        scrollStateRef.current.stick = nearBottom;
        setShowJump(!nearBottom);
        if (nearBottom) {
          setNewCount(0);
          setUnreadFromSeq(null);
        }
      };

      React.useEffect(() => {
        setReplyTarget(null);
        setMessageMenu(null);
        setHeaderMenuOpen(false);
        setShowJump(false);
        setNewCount(0);
        setUnreadFromSeq(null);
        scrollStateRef.current.groupId = null;
      }, [state.activeGroupId]);

      React.useEffect(() => {
        if (!headerMenuOpen) return undefined;
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setHeaderMenuOpen(false);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      }, [headerMenuOpen]);

      React.useEffect(() => {
        if (!replyTarget || !scrollStateRef.current.stick) return undefined;
        const frame = requestAnimationFrame(() => {
          const node = timelineRef.current;
          if (node) node.scrollTop = node.scrollHeight;
        });
        return () => cancelAnimationFrame(frame);
      }, [replyTarget]);

      React.useEffect(() => {
        const node = timelineRef.current;
        if (!node) return;
        const scroll = scrollStateRef.current;
        const groupChanged = scroll.groupId !== state.activeGroupId;
        if (groupChanged) {
          scroll.groupId = state.activeGroupId;
          scroll.lastSeq = 0;
          scroll.stick = true;
          pendingPrependRef.current = null;
          setShowJump(false);
          setNewCount(0);
          setUnreadFromSeq(null);
        }
        if (pendingPrependRef.current) {
          const pending = pendingPrependRef.current;
          pendingPrependRef.current = null;
          node.scrollTop = pending.top + (node.scrollHeight - pending.height);
          scroll.stick = false;
          const tail = messages[messages.length - 1];
          scroll.lastSeq = tail ? Number(tail.seq) || 0 : 0;
          return;
        }
        const tail = messages[messages.length - 1];
        const lastSeq = tail ? Number(tail.seq) || 0 : 0;
        const previousSeq = Number(scroll.lastSeq) || 0;
        const added = messages.filter((message) => Number(message.seq) > previousSeq);
        if (groupChanged) {
          requestAnimationFrame(() => {
            const target = timelineRef.current;
            if (!target) return;
            target.scrollTop = target.scrollHeight;
            scroll.stick = true;
          });
        } else if (added.length > 0) {
          if (scroll.stick) {
            node.scrollTop = node.scrollHeight;
          } else {
            setNewCount((count) => count + added.length);
            setShowJump(true);
            setUnreadFromSeq((current) => (current == null ? Number(added[0].seq) : current));
          }
        } else if (scroll.stick) {
          node.scrollTop = node.scrollHeight;
        }
        scroll.lastSeq = lastSeq;
      }, [messages, state.activeGroupId]);

      const jumpToMessage = (messageId) => {
        const node = timelineRef.current;
        if (!node) return;
        const target = node.querySelector(`[data-message-id="${messageId}"]`);
        if (!target) {
          dispatch({ type: 'flash', message: '这条原消息在更早的历史里，请先加载更早的消息' });
          return;
        }
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.remove('bt-msg-flash');
        void target.offsetWidth;
        target.classList.add('bt-msg-flash');
        window.setTimeout(() => target.classList.remove('bt-msg-flash'), 1400);
      };

      const copyMessage = (message) => {
        copyTextToClipboard(message.text || '')
          .then(() => dispatch({ type: 'flash', message: '已复制消息' }))
          .catch((error) => dispatch({ type: 'error', message: String(error && error.message ? error.message : error) }));
      };

      const copyMessageQuote = (message) => {
        copyTextToClipboard(buildQuoteMarkdown(displayNameOf(message, state.bots, userProfile), message.text))
          .then(() => dispatch({ type: 'flash', message: '已复制引用' }))
          .catch((error) => dispatch({ type: 'error', message: String(error && error.message ? error.message : error) }));
      };

      /**
       * Right-click opens the same actions as the hover toolbar (plus quote and
       * jump-to-original). Keep the native menu when the user right-clicks a
       * link or a text selection inside this message, so "copy selection" and
       * "open link" still work.
       */
      const openMessageMenu = (event, message) => {
        if (!event || typeof event.preventDefault !== 'function') return;
        const target = event.target;
        if (target && typeof target.closest === 'function' && target.closest('a')) return;
        if (typeof window !== 'undefined' && typeof window.getSelection === 'function') {
          const selection = window.getSelection();
          if (selection && !selection.isCollapsed && String(selection).trim()) {
            const anchor = selection.anchorNode;
            if (anchor && event.currentTarget && typeof event.currentTarget.contains === 'function' && event.currentTarget.contains(anchor)) return;
          }
        }
        event.preventDefault();
        event.stopPropagation();
        setHeaderMenuOpen(false);
        const rect = event.currentTarget && typeof event.currentTarget.getBoundingClientRect === 'function'
          ? event.currentTarget.getBoundingClientRect()
          : null;
        const x = Number.isFinite(event.clientX) && event.clientX > 0 ? event.clientX : rect ? rect.left + 36 : 16;
        const y = Number.isFinite(event.clientY) && event.clientY > 0 ? event.clientY : rect ? rect.top + 22 : 16;
        setMessageMenu({ message, x, y, groupId: activeGroup ? activeGroup.groupId : null });
      };

      const openGroupCreate = (folderId) =>
        dispatch({ type: 'dialog', dialog: { kind: 'group', folderId: folderId || null } });
      const openGroupEdit = (group) =>
        dispatch({ type: 'dialog', dialog: { kind: 'group', group: group || activeGroup } });
      const openBotCreate = () => dispatch({ type: 'dialog', dialog: { kind: 'bot' } });
      const openBotEdit = (bot) => dispatch({ type: 'dialog', dialog: { kind: 'bot', bot } });
      const openMemberAdd = () => dispatch({ type: 'dialog', dialog: { kind: 'member' } });
      const openFolderCreate = () => dispatch({ type: 'dialog', dialog: { kind: 'folder' } });
      const openFolderEdit = (folder) => dispatch({ type: 'dialog', dialog: { kind: 'folder', folder } });
      const openReview = (message) => dispatch({ type: 'dialog', dialog: { kind: 'review', target: message } });
      const openTaskStream = (task) => {
        const member = members.find((candidate) => candidate.membershipId === task.assigneeMembershipId);
        if (!member) {
          dispatch({ type: 'error', message: '指派成员已不存在' });
          return;
        }
        openBotSession(member.sessionId, (message) => dispatch({ type: 'error', message }));
      };
      const openTaskCreate = () => dispatch({ type: 'dialog', dialog: { kind: 'task' } });
      const openTaskEdit = (task) => dispatch({ type: 'dialog', dialog: { kind: 'task', task } });
      const taskAction = async (task, action) => {
        try {
          if (action === 'dispatch') await api.action('task.dispatch', { taskId: task.taskId });
          else if (action === 'review') await api.action('task.review', { taskId: task.taskId });
          else if (action === 'accept') await api.action('task.accept', { taskId: task.taskId });
          else if (action === 'request_changes') await api.action('task.request_changes', { taskId: task.taskId });
          else if (action === 'revise') await api.action('task.revise', { taskId: task.taskId });
          else if (action === 'cancel') await api.action('task.cancel', { taskId: task.taskId });
          uiReport({ kind: 'action', action: 'task.' + action });
          if (action === 'cancel') dispatch({ type: 'flash', message: '已中断任务' });
          dispatch({ type: 'refreshTick' });
          dispatch({ type: 'messagesTick' });
        } catch (error) {
          dispatch({ type: 'error', message: String(error && error.message ? error.message : error) });
        }
      };

      const openDiscussion = () =>
        dispatch({ type: 'dialog', dialog: { kind: 'discussion', defaultTopic: '' } });

      const doRevise = async (reviewMessage) => {
        try {
          await api.action('review.revise', { groupId: activeGroup.groupId, reviewMessageId: reviewMessage.messageId });
          uiReport({ kind: 'action', action: 'review.revise' });
          dispatch({ type: 'messagesTick' });
        } catch (error) {
          dispatch({ type: 'error', message: String(error && error.message ? error.message : error) });
        }
      };
      const doRetry = async (message) => {
        try {
          await api.action('message.retry', { messageId: message.messageId });
          uiReport({ kind: 'action', action: 'message.retry' });
          dispatch({ type: 'messagesTick' });
        } catch (error) {
          dispatch({ type: 'error', message: String(error && error.message ? error.message : error) });
        }
      };
      const stopDiscussion = async () => {
        const discussion = state.discussions[activeGroup.groupId];
        if (!discussion) return;
        try {
          await api.action('discussion.stop', { discussionId: discussion.discussionId });
          dispatch({ type: 'messagesTick' });
          dispatch({ type: 'refreshTick' });
        } catch (error) {
          dispatch({ type: 'error', message: String(error && error.message ? error.message : error) });
        }
      };
      const loadEarlier = async () => {
        if (!activeGroup) return;
        const first = messages[0];
        if (!first) return;
        const node = timelineRef.current;
        try {
          const result = await api.messages(activeGroup.groupId, first.seq);
          if (scrollStateRef.current.groupId !== activeGroup.groupId) return;
          if (node) pendingPrependRef.current = { height: node.scrollHeight, top: node.scrollTop };
          dispatch({
            type: 'prependMessages',
            groupId: activeGroup.groupId,
            messages: result.messages || [],
            hasMore: result.hasMore === true,
          });
        } catch (error) {
          pendingPrependRef.current = null;
          dispatch({ type: 'error', message: String(error && error.message ? error.message : error) });
        }
      };

      const closeDialog = () => dispatch({ type: 'dialog', dialog: null });
      const afterChange = () => {
        closeDialog();
        dispatch({ type: 'refreshTick' });
      };
      const afterGroupSaved = (result) => {
        closeDialog();
        const group = result && result.group;
        if (group && group.groupId) dispatch({ type: 'selectGroup', groupId: group.groupId });
        // A new/moved group may live in a collapsed section; reveal its scope.
        dispatch({ type: 'sectionCollapsed', key: 'groups', collapsed: false });
        if (group && group.folderId) {
          dispatch({ type: 'sectionCollapsed', key: sectionFolderKey(group.folderId), collapsed: false });
        } else if (state.folders.length > 0) {
          dispatch({ type: 'sectionCollapsed', key: 'ungrouped', collapsed: false });
        }
        dispatch({ type: 'refreshTick' });
      };
      const afterBotSaved = (result) => {
        closeDialog();
        if (result && result.created && result.botId) {
          // Land directly in the new bot's single chat once bootstrap reloads.
          dispatch({ type: 'pendingDirect', botId: result.botId });
          dispatch({ type: 'sectionCollapsed', key: 'direct', collapsed: false });
        }
        dispatch({ type: 'refreshTick' });
      };
      const afterFolderSaved = () => {
        closeDialog();
        dispatch({ type: 'sectionCollapsed', key: 'groups', collapsed: false });
        dispatch({ type: 'refreshTick' });
      };

      const startReply = (message) => setReplyTarget(message);

      /** Select an existing single chat, or ask the Host to create it first. */
      const openDirect = async (botId, group) => {
        if (group && group.groupId) {
          dispatch({ type: 'selectGroup', groupId: group.groupId });
          return;
        }
        dispatch({ type: 'pendingDirect', botId });
        try {
          await api.action('direct.open', { botId });
          dispatch({ type: 'refreshTick' });
        } catch (error) {
          dispatch({ type: 'pendingDirect', botId: null });
          dispatch({ type: 'error', message: String(error && error.message ? error.message : error) });
        }
      };

      const reorderGroups = async (payload) => {
        if (!payload) return;
        dispatch({ type: 'applyGroupOrder', ...payload });
        try {
          await api.action('group.reorder', payload);
          uiReport({ kind: 'action', action: 'group.reorder' });
        } catch (error) {
          dispatch({ type: 'error', message: String(error && error.message ? error.message : error) });
        }
        dispatch({ type: 'refreshTick' });
      };

      const reorderFolders = async (payload) => {
        if (!payload) return;
        dispatch({ type: 'applyFolderOrder', ...payload });
        try {
          await api.action('folder.reorder', payload);
          uiReport({ kind: 'action', action: 'folder.reorder' });
        } catch (error) {
          dispatch({ type: 'error', message: String(error && error.message ? error.message : error) });
        }
        dispatch({ type: 'refreshTick' });
      };

      const deleteGroup = async (group) => {
        if (!group || isDirectGroup(group)) return;
        if (!window.confirm(`删除群「${group.title}」及其全部消息？`)) return;
        try {
          await api.action('group.delete', { groupId: group.groupId });
          dispatch({ type: 'refreshTick' });
        } catch (error) {
          dispatch({ type: 'error', message: String(error && error.message ? error.message : error) });
        }
      };
      const deleteActiveGroup = () => deleteGroup(activeGroup);

      const deleteFolder = async (folder) => {
        if (!folder) return;
        const count = state.groups.filter((group) => !isDirectGroup(group) && group.folderId === folder.folderId).length;
        const warning = count > 0
          ? `删除分组「${folder.title}」？其中 ${count} 个群会移到「未分组」，不会被删除。`
          : `删除分组「${folder.title}」？`;
        if (!window.confirm(warning)) return;
        try {
          await api.action('folder.delete', { folderId: folder.folderId });
          dispatch({ type: 'sectionCollapsed', key: 'groups', collapsed: false });
          dispatch({ type: 'sectionCollapsed', key: 'ungrouped', collapsed: false });
          dispatch({ type: 'refreshTick' });
        } catch (error) {
          dispatch({ type: 'error', message: String(error && error.message ? error.message : error) });
        }
      };

      const runningMembers = members.filter((member) => state.statusByMember[member.membershipId] === 'running');
      const botMembers = members.filter((member) => state.bots.some((bot) => bot.botId === member.botId));
      const headerSubtitle = activeIsDirect
        ? [
            '单聊',
            activeDirectBot ? `${activeDirectBot.provider}/${activeDirectBot.model}` : '',
            activeGroup && activeGroup.topic ? activeGroup.topic : '',
          ].filter(Boolean).join(' · ')
        : [
            `${members.length} 位成员${botMembers.length ? ` · ${botMembers.length} 个 Bot` : ''}`,
            activeGroup && activeGroup.topic ? activeGroup.topic : '',
          ]
            .filter(Boolean)
            .join(' · ');
      const menuItem = (label, onClick, danger) =>
        h(
          'button',
          {
            type: 'button',
            role: 'menuitem',
            className: `bt-menu-item${danger ? ' bt-menu-danger' : ''}`,
            style: { ...S.menuItem, ...(danger ? S.menuDanger : null) },
            onClick,
          },
          label,
        );

      const exportMarkdown = async () => {
        if (!activeGroup) return;
        try {
          const allMessages = await collectAllMessages(activeGroup.groupId);
          const markdown = buildGroupMarkdown({ group: activeGroup, members, bots: state.bots, messages: allMessages });
          const date = new Date().toISOString().slice(0, 10);
          downloadText(String(activeGroup.title || 'bot-team').replace(/[\\/:*?"<>|]/g, '_') + '-' + date + '.md', markdown);
          uiReport({ kind: 'action', action: 'group.export' });
        } catch (error) {
          dispatch({ type: 'error', message: String(error && error.message ? error.message : error) });
        }
      };

      const exportHtml = async () => {
        if (!activeGroup) return;
        try {
          const allMessages = await collectAllMessages(activeGroup.groupId);
          const html = buildGroupHtml({ group: activeGroup, members, bots: state.bots, messages: allMessages });
          const date = new Date().toISOString().slice(0, 10);
          downloadText(
            String(activeGroup.title || 'bot-team').replace(/[\\/:*?"<>|]/g, '_') + '-' + date + '.html',
            html,
            'text/html;charset=utf-8',
          );
          uiReport({ kind: 'action', action: 'group.export-html' });
        } catch (error) {
          dispatch({ type: 'error', message: String(error && error.message ? error.message : error) });
        }
      };

      const dialog = state.dialog;

      return h(
        'div',
        { style: { position: 'relative', height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' } },
        state.flash ? h('div', { style: S.flash }, state.flash) : null,
        state.error
          ? h(
              'div',
              { className: 'bt-root', style: S.errorBanner, onClick: () => dispatch({ type: 'error', message: '' }) },
              `${state.error}（点击关闭）`,
            )
          : null,
        h('style', { key: 'bt-global-css' }, GLOBAL_CSS),
        h(
          'div',
          { className: 'bt-root', style: { ...S.root, flex: 1, minHeight: 0 } },
          h(GroupList, {
            state,
            dispatch,
            onCreate: openGroupCreate,
            onCreateBot: openBotCreate,
            onCreateFolder: openFolderCreate,
            onOpenDirect: openDirect,
            onEditGroup: openGroupEdit,
            onDeleteGroup: deleteGroup,
            onEditBot: openBotEdit,
            onViewSession: (member) => openBotSession(member.sessionId, (message) => dispatch({ type: 'error', message })),
            onCreateGroupInFolder: openGroupCreate,
            onRenameFolder: openFolderEdit,
            onDeleteFolder: deleteFolder,
            onReorderGroups: reorderGroups,
            onReorderFolders: reorderFolders,
          }),
          h(
            'div',
            { style: S.center },
            activeGroup
              ? h(
                  React.Fragment,
                  null,
                  h(
                    'div',
                    { className: 'bt-chat-header', style: S.chatHeader },
                    activeIsDirect
                      ? h(Avatar, { bot: activeDirectBot, name: activeDirectBot ? activeDirectBot.name : activeGroup.title, size: 42 })
                      : h(GroupAvatar, { group: activeGroup, size: 42 }),
                    h(
                      'div',
                      { style: { flex: 1, minWidth: 0 } },
                      h(
                        'div',
                        { style: S.chatTitleRow },
                        h('div', { style: S.chatTitle, title: activeGroup.title }, activeGroup.title),
                        runningMembers.length > 0
                          ? h(
                              'span',
                              { style: S.headerLive },
                              h('span', { style: S.headerLiveDot }),
                              `${runningMembers.length} 个回复中`,
                            )
                          : null,
                      ),
                      h('div', { style: S.chatTopic, title: headerSubtitle }, headerSubtitle),
                    ),
                    h(
                      'div',
                      { style: S.headerActions },
                      activeIsDirect
                        ? h(
                            'button',
                            {
                              type: 'button',
                              className: 'bt-header-btn',
                              style: S.headerBtn,
                              onClick: () => activeDirectBot && openBotEdit(activeDirectBot),
                              title: '编辑这个 Bot',
                            },
                            '编辑 Bot',
                          )
                        : h(
                            'button',
                            { type: 'button', className: 'bt-header-btn', style: S.headerBtn, onClick: openDiscussion, title: '发起多轮讨论' },
                            '讨论',
                          ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'bt-icon-btn bt-right-toggle',
                          style: S.headerIconBtn,
                          onClick: () => dispatch({ type: 'toggleRightPanel' }),
                          title: state.rightPanelCollapsed === true ? '展开右侧面板' : '收起右侧面板',
                          'aria-label': state.rightPanelCollapsed === true ? '展开右侧面板' : '收起右侧面板',
                          'aria-expanded': state.rightPanelCollapsed !== true,
                          'aria-controls': 'bt-right-panel',
                        },
                        h(
                          'svg',
                          {
                            width: 16,
                            height: 16,
                            viewBox: '0 0 24 24',
                            fill: 'none',
                            stroke: 'currentColor',
                            strokeWidth: 1.7,
                            strokeLinecap: 'round',
                            strokeLinejoin: 'round',
                            'aria-hidden': true,
                            focusable: false,
                            style: S.sidebarActionIcon,
                          },
                          h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 3 }),
                          h('path', { d: 'M15 4v16' }),
                          state.rightPanelCollapsed === true
                            ? h('path', { d: 'M13.5 9.5 11 12l2.5 2.5' })
                            : h('path', { d: 'M12.5 9.5 15 12l-2.5 2.5' }),
                        ),
                      ),
                      h(
                        'div',
                        { style: { position: 'relative' } },
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'bt-icon-btn',
                            style: S.headerIconBtn,
                            onClick: () => setHeaderMenuOpen((open) => !open),
                            title: activeIsDirect ? '更多单聊操作' : '更多群操作',
                            'aria-label': activeIsDirect ? '更多单聊操作' : '更多群操作',
                            'aria-expanded': headerMenuOpen,
                          },
                          '···',
                        ),
                        headerMenuOpen
                          ? h(
                              React.Fragment,
                              null,
                              h('div', { className: 'bt-menu-backdrop', onClick: () => setHeaderMenuOpen(false) }),
                              h(
                                'div',
                                { className: 'bt-menu', style: S.headerMenu, role: 'menu' },
                                activeIsDirect
                                  ? menuItem('编辑 Bot', () => {
                                      setHeaderMenuOpen(false);
                                      if (activeDirectBot) openBotEdit(activeDirectBot);
                                    })
                                  : menuItem('添加成员', () => {
                                      setHeaderMenuOpen(false);
                                      openMemberAdd();
                                    }),
                                activeIsDirect
                                  ? menuItem('查看 Bot 会话', () => {
                                      setHeaderMenuOpen(false);
                                      if (activeDirectMember) {
                                        openBotSession(activeDirectMember.sessionId, (message) => dispatch({ type: 'error', message }));
                                      } else {
                                        dispatch({ type: 'error', message: '这个单聊的成员已不存在' });
                                      }
                                    })
                                  : menuItem('编辑群信息', () => {
                                      setHeaderMenuOpen(false);
                                      openGroupEdit(activeGroup);
                                    }),
                                h('div', { style: S.menuDivider }),
                                menuItem('导出 Markdown', () => {
                                  setHeaderMenuOpen(false);
                                  void exportMarkdown();
                                }),
                                activeIsDirect
                                  ? null
                                  : menuItem('导出 HTML', () => {
                                      setHeaderMenuOpen(false);
                                      void exportHtml();
                                    }),
                                activeIsDirect
                                  ? null
                                  : h(React.Fragment, null,
                                      h('div', { style: S.menuDivider }),
                                      menuItem(
                                        '删除群',
                                        () => {
                                          setHeaderMenuOpen(false);
                                          void deleteActiveGroup();
                                        },
                                        true,
                                      ),
                                    ),
                              ),
                            )
                          : null,
                      ),
                    ),
                  ),
                  h(
                    'div',
                    { style: S.timelineWrap },
                    h(
                      'div',
                      {
                        ref: timelineRef,
                        className: 'bt-timeline',
                        style: S.timeline,
                        onScroll: onTimelineScroll,
                      },
                      h(
                        'div',
                        { style: S.messageColumn },
                        state.hasMoreByGroup[activeGroup.groupId]
                          ? h(
                              'button',
                              { type: 'button', className: 'bt-load-earlier', style: S.loadEarlier, onClick: () => void loadEarlier() },
                              '加载更早的消息',
                            )
                          : null,
                        messages.length === 0
                          ? activeIsDirect
                            ? h(
                                'div',
                                { style: S.emptyState },
                                h('div', { style: S.emptyIcon }, '1:1'),
                                h('div', { style: S.emptyTitle }, `和 ${activeGroup.title} 打个招呼吧`),
                                h(
                                  'div',
                                  { style: S.emptyHint },
                                  '单聊消息会直接发给这个 Bot，不需要 @；它的回复会实时出现在这里。',
                                ),
                              )
                            : h(
                                'div',
                                { style: S.emptyState },
                                h('div', { style: S.emptyIcon }, '#'),
                                h('div', { style: S.emptyTitle }, '还没有消息'),
                                h(
                                  'div',
                                  { style: S.emptyHint },
                                  members.length === 0
                                    ? '先在右侧成员面板添加一个 Bot，再用 @ 提及它开始对话。'
                                    : '在下方输入消息，用 @ 提及成员；被 @ 的 Bot 会并行回复。',
                                ),
                                members.length === 0
                                  ? h('button', { style: S.primaryBtn, onClick: openMemberAdd }, '添加成员')
                                  : null,
                              )
                          : h(MessageList, {
                              messages,
                              unreadFromSeq,
                              bots: state.bots,
                              userProfile,
                              chatDisplaySettings: state.chatDisplaySettings,
                              allMessages: messages,
                              tasks: activeGroup.tasks || [],
                              onReply: startReply,
                              onCopy: copyMessage,
                              onCopyQuote: copyMessageQuote,
                              onContextMenu: openMessageMenu,
                              onReview: activeIsDirect ? undefined : openReview,
                              onRevise: activeIsDirect ? undefined : doRevise,
                              onRetry: doRetry,
                              onJumpToMessage: jumpToMessage,
                              onOpenSession: (sessionId) =>
                                openBotSession(sessionId, (message) => dispatch({ type: 'error', message })),
                            }),
                        h('div', { style: { height: 4, flex: '0 0 auto' } }),
                      ),
                    ),
                    showJump
                      ? h(
                          'button',
                          { type: 'button', className: 'bt-jump-btn', style: S.jumpButton, onClick: () => scrollToLatest('auto') },
                          newCount > 0 ? h('span', { className: 'bt-chat-scroll-badge' }, newCount > 99 ? '99+' : String(newCount)) : null,
                          newCount > 0 ? '条新消息' : '回到底部',
                          h('span', { style: { fontSize: 10, color: 'var(--bt-text-3)' } }, '↓'),
                        )
                      : null,
                  ),
                  h(Composer, {
                    state,
                    dispatch,
                    group: activeGroup,
                    members,
                    bots: state.bots,
                    replyTarget,
                    userProfile,
                    onClearReply: () => setReplyTarget(null),
                    onResize: () => {
                      if (!scrollStateRef.current.stick) return;
                      const node = timelineRef.current;
                      if (node) node.scrollTop = node.scrollHeight;
                    },
                    onSent: () => {
                      dispatch({ type: 'refreshTick' });
                      dispatch({ type: 'messagesTick' });
                      scrollStateRef.current.stick = true;
                      setShowJump(false);
                      setNewCount(0);
                      setUnreadFromSeq(null);
                      requestAnimationFrame(() => scrollToLatest('auto'));
                    },
                  }),
                )
              : h(
                  'div',
                  { style: S.centerEmpty },
                  h('div', { style: { fontSize: 15, fontWeight: 600 } }, 'Bot Team'),
                  h('div', null, '从左侧「单聊」新建一个 Bot（自动获得一对一会话），或创建一个群/话题把多个 Bot 拉进来；每个 Bot 可以有自己的模型、BOT.md 人格与能力。'),
                  h('button', { style: S.primaryBtn, onClick: () => openGroupCreate() }, '新建群 / 话题'),
                ),
          ),
          activeGroup
            ? state.rightPanelCollapsed === true
              ? null
              : activeIsDirect
              ? h(DirectPanel, {
                  bot: activeDirectBot,
                  group: activeGroup,
                  member: activeDirectMember,
                  usage: activeGroup.usage || null,
                  onEdit: openBotEdit,
                  onCollapse: () => dispatch({ type: 'toggleRightPanel' }),
                  onViewSession: (member) => openBotSession(member.sessionId, (message) => dispatch({ type: 'error', message })),
                })
              : h(MembersPanel, {
                  state,
                  dispatch,
                  group: activeGroup,
                  members,
                  bots: state.bots,
                  discussion: state.discussions[activeGroup.groupId] || null,
                  usage: activeGroup.usage || null,
                  onAdd: openMemberAdd,
                  onCollapse: () => dispatch({ type: 'toggleRightPanel' }),
                  onEdit: openBotEdit,
                  onViewSession: (member) => openBotSession(member.sessionId, (message) => dispatch({ type: 'error', message })),
                  tasks: activeGroup.tasks || [],
                  onTaskCreate: openTaskCreate,
                  onTaskAction: (task, action) => void taskAction(task, action),
                  onTaskEdit: openTaskEdit,
                  onTaskStream: openTaskStream,
                  onStopDiscussion: stopDiscussion,
                })
            : h('div', { id: 'bt-right-panel', style: S.right }, h('div', { style: S.rightHeader }, 'Bot 库'), h('div', { style: { padding: '0 12px 12px', display: 'flex', flexDirection: 'column', gap: 8 } },
                h('button', { style: S.ghostBtn, onClick: openBotCreate }, '+ 新建 Bot'),
                h('div', { style: { fontSize: 12, color: 'var(--bt-text-3)', lineHeight: 1.7 } }, `已有 ${state.bots.length} 个 Bot。每个 Bot 都有自己的单聊；也可以在群里加入它们。`),
                state.bots.map((bot) => h('div', { key: bot.botId, style: { ...S.memberCard, cursor: 'pointer' }, onClick: () => openBotEdit(bot) },
                  h('div', { style: S.memberTop }, h(Avatar, { bot, size: 24 }), h('span', { style: S.memberName }, bot.name)),
                  h('div', { style: S.memberMeta }, `${bot.model}`),
                )),
              )),
          messageMenu && messageMenu.groupId === state.activeGroupId
            ? h(MessageContextMenu, {
                menu: messageMenu,
                bots: state.bots,
                allMessages: messages,
                userProfile,
                onClose: () => setMessageMenu(null),
                onReply: startReply,
                onCopy: copyMessage,
                onCopyQuote: copyMessageQuote,
                onJumpToMessage: jumpToMessage,
                onReview: activeIsDirect ? undefined : openReview,
                onRevise: activeIsDirect ? undefined : doRevise,
                onRetry: doRetry,
              })
            : null,
        ),
        dialog && dialog.kind === 'settings'
          ? h(ChatSettingsDialog, {
              settings: state.chatDisplaySettings,
              pluginInfo: state.pluginInfo,
              onClose: closeDialog,
              onSaved: (settings) => {
                dispatch({ type: 'chatDisplaySettings', settings });
                dispatch({ type: 'flash', message: '群聊设置已保存，已应用于所有群聊' });
                closeDialog();
              },
            })
          : null,
        dialog && dialog.kind === 'group'
          ? h(GroupFormDialog, {
              group: dialog.group || null,
              folders: state.folders,
              folderId: dialog.folderId || null,
              onClose: closeDialog,
              onSaved: afterGroupSaved,
            })
          : null,
        dialog && dialog.kind === 'folder'
          ? h(FolderFormDialog, { folder: dialog.folder || null, onClose: closeDialog, onSaved: afterFolderSaved })
          : null,
        dialog && dialog.kind === 'bots'
          ? h(BotLibraryDialog, {
              bots: state.bots,
              members: state.members,
              groups: state.groups,
              onClose: closeDialog,
              onCreate: () => dispatch({ type: 'dialog', dialog: { kind: 'bot' } }),
              onEdit: (bot) => dispatch({ type: 'dialog', dialog: { kind: 'bot', bot } }),
              onChanged: () => dispatch({ type: 'refreshTick' }),
            })
          : null,
        dialog && dialog.kind === 'bot'
          ? h(BotFormDialog, {
              bot: dialog.bot || null,
              modelCatalog: state.modelCatalog,
              onClose: closeDialog,
              onSaved: afterBotSaved,
            })
          : null,
        dialog && dialog.kind === 'member' && activeGroup
          ? h(AddMemberDialog, { group: activeGroup, bots: state.bots, members, onClose: closeDialog, onSaved: afterChange })
          : null,
        dialog && dialog.kind === 'task' && activeGroup
          ? h(TaskDialog, {
              group: activeGroup,
              members,
              bots: state.bots,
              task: dialog.task || null,
              onClose: closeDialog,
              onSaved: afterChange,
            })
          : null,
        dialog && dialog.kind === 'review' && activeGroup
          ? h(ReviewDialog, { target: dialog.target, group: activeGroup, members, bots: state.bots, onClose: closeDialog, onSaved: afterChange })
          : null,
        dialog && dialog.kind === 'discussion' && activeGroup
          ? h(DiscussionDialog, {
              group: activeGroup,
              members,
              bots: state.bots,
              defaultTopic: dialog.defaultTopic || '',
              onClose: closeDialog,
              onSaved: afterChange,
            })
          : null,
        state.loading ? h('div', { className: 'bt-root', style: { ...S.overlay, background: 'var(--bt-loading)' } }, h('div', { style: { fontSize: 13, color: 'var(--bt-text-2)' } }, '加载 Bot Team…')) : null,
      );
    }

    // ── sidebar icon ──────────────────────────────────────────────────────
    function PanelIcon(props) {
      const size = (props && props.size) || 18;
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, style: { display: 'block' } },
        h('circle', { cx: 8, cy: 9, r: 3, fill: '#2f7ed8' }),
        h('circle', { cx: 16, cy: 9, r: 3, fill: '#8b5cf6' }),
        h('path', { d: 'M3 19c0-2.8 2.2-5 5-5s5 2.2 5 5', stroke: '#2f7ed8', strokeWidth: 1.6, fill: 'none', strokeLinecap: 'round' }),
        h('path', { d: 'M13 19c0-2.8 2.2-5 5-5s5 2.2 5 5', stroke: '#8b5cf6', strokeWidth: 1.6, fill: 'none', strokeLinecap: 'round' }),
      );
    }

    return {
      inject: ['slots', 'uiWorkspace', 'remote', 'remote.account'],
      apply(ctx) {
        appCtx = ctx;
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PAGE_KEY }, BotTeamPage));
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: PAGE_KEY, order: 40, label: 'Bot Team' }, PanelIcon),
        );
      },
    };
  },
});
