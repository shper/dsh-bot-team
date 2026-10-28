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
    // ── i18n ────────────────────────────────────────────────────────────
    // DSH owns the zh/en locale preference (Settings → General). The Host-side
    // locale service exposes ctx.locale; UI copy is translated at render time so
    // constants and menus follow a language switch without re-registration.
    const LOCALE_NS = 'botTeam';
    let localeRuntime = null;
    let testLocale = null;
    let rawDepth = 0;
    // Content values (names, titles, message bodies) are protected per subtree:
    // a string that is literally one of these values is never translated even
    // when it also happens to be a UI label ("取消" as a group name, etc.).
    const contentStack = [];
    const UI_TEXT_PROPS = ['title', 'placeholder', 'aria-label', 'aria-description', 'alt'];

    function interpolateUi(template, params) {
      if (!params) return template;
      return String(template).replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
    }

    /** Pick a singular dictionary key for count === 1, otherwise the plural template. */
    function pluralUi(oneKey, manyKey, count, params) {
      if (Number(count) === 1) return uiT(oneKey);
      return uiT(manyKey, { ...(params || {}), count });
    }

    /** Translate one UI string. Content keys fall through unchanged. */
    function uiT(key, params) {
      if (typeof key !== 'string' || key.length === 0) return key;
      if (localeRuntime && typeof localeRuntime.t === 'function') return localeRuntime.t(key, params);
      if (testLocale === 'en' && UI_EN[key] !== undefined) return interpolateUi(UI_EN[key], params);
      return params ? interpolateUi(key, params) : key;
    }

    /** Active DSH locale id ('zh', 'en', …); test builds default to Chinese. */
    function uiLocale() {
      if (localeRuntime && typeof localeRuntime.getLocale === 'function') return localeRuntime.getLocale();
      return testLocale || 'zh';
    }

    function isEnglishUi() {
      return /^en/i.test(String(uiLocale() || ''));
    }

    /** Test builds: force one of the built-in locales without a DSH context. */
    function setTestLocale(locale) {
      testLocale = locale === 'en' ? 'en' : locale === 'zh' ? 'zh' : null;
    }

    function inContent(text) {
      for (let index = contentStack.length - 1; index >= 0; index -= 1) {
        if (contentStack[index].has(text)) return true;
      }
      return false;
    }

    /** Protect exact content values while building one UI subtree. */
    function withContent(values, fn) {
      const set = new Set();
      for (const value of values || []) {
        if (typeof value === 'string' && value) set.add(value);
      }
      contentStack.push(set);
      try {
        return fn();
      } finally {
        contentStack.pop();
      }
    }

    /** Build content trees (Markdown, quoted text) without translating them. */
    function withRaw(fn) {
      rawDepth += 1;
      try {
        return fn();
      } finally {
        rawDepth -= 1;
      }
    }

    function translateChild(child) {
      if (typeof child === 'string') return rawDepth > 0 || inContent(child) ? child : uiT(child);
      if (Array.isArray(child)) return child.map(translateChild);
      return child;
    }

    /**
     * All UI text flows through this createElement wrapper. Static copy is
     * translated by exact dictionary lookup; elements marked `raw: true` render
     * user/bot content untouched (names, titles, messages, errors).
     */
    function h(type, props, ...children) {
      let nextProps = props;
      if (props) {
        const rawElement = props.raw === true;
        let cloned = false;
        const ensure = () => {
          if (!cloned) {
            nextProps = { ...props };
            cloned = true;
          }
        };
        const rawTitle = props.rawTitle === true;
        if ('raw' in props) {
          ensure();
          delete nextProps.raw;
        }
        if ('rawTitle' in props) {
          ensure();
          delete nextProps.rawTitle;
        }
        if (!rawElement && !rawTitle && rawDepth === 0) {
          for (const key of UI_TEXT_PROPS) {
            if (typeof props[key] === 'string' && props[key] && !inContent(props[key])) {
              ensure();
              nextProps[key] = uiT(props[key]);
            }
          }
        }
      }
      const nextChildren = rawDepth > 0 || (props && props.raw === true) ? children : children.map(translateChild);
      return React.createElement(type, nextProps, ...nextChildren);
    }

    const PAGE_KEY = 'bot-team';
    const EMPTY_MESSAGES = [];
    const ROUTES = {
      bootstrap: '/api/bot-team.bootstrap',
      messages: '/api/bot-team.messages',
      conversations: '/api/bot-team.conversations',
      execution: '/api/bot-team.message-execution',
      sessionHistory: '/api/bot-team.session-history',
      sessionExport: '/api/bot-team.session-export',
      events: '/api/bot-team.events',
      action: '/api/bot-team.action',
      file: '/api/bot-team.file',
      upload: '/api/bot-team.upload',
      skills: '/api/bot-team.skills',
      exportPdf: '/api/bot-team.export.pdf',
    };
    // Generic attachments are stored verbatim by the Host attachment service.
    // The browser cap keeps a single draft from blocking the page on huge files.
    const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
    const MAX_DRAFT_ATTACHMENTS = 10;
    const ACCOUNT_CLIENT_VERSION = '0.2.1-rc.3';
    // The right-click menu's box is sized in JS so placement can clamp it to the viewport.
    const MESSAGE_MENU_WIDTH = 200;
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
        throw new Error(uiT('无法连接 Host：{error}', { error: String(error && error.message ? error.message : error) }));
      }
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!body || body.ok === false) {
        const message = body && body.error && body.error.message ? body.error.message : uiT('请求失败 (HTTP {status})', { status: response.status });
        const error = new Error(message);
        error.status = response.status;
        error.details = body?.error?.details || body?.details;
        error.code = body?.error?.code || (response.status === 404 && body === null ? 'route-not-found' : null);
        throw error;
      }
      return body;
    }

    const api = {
      bootstrap: (signal) => request(ROUTES.bootstrap, { method: 'GET', signal }),
      messages: (groupId, beforeSeq) =>
        request(
          `${ROUTES.messages}?groupId=${encodeURIComponent(groupId)}&limit=120${
            Number.isFinite(beforeSeq) ? `&beforeSeq=${beforeSeq}` : ''
          }`,
          { method: 'GET' },
        ),
      conversations: (groupId, options = {}) => {
        const query = Object.entries({ groupId, limit: 100, ...options }).filter(([, value]) => value !== undefined && value !== null)
          .map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(value)).join('&');
        return request(ROUTES.conversations + '?' + query, { method: 'GET' });
      },
      execution: async (groupId, messageId, afterSeq, signal) => {
        try {
          return await request(`${ROUTES.execution}?groupId=${encodeURIComponent(groupId)}&messageId=${encodeURIComponent(messageId)}&afterSeq=${afterSeq}&limit=100`, { method: 'GET', signal });
        } catch (error) {
          // The Host dispatcher returns plain-text 404 when this route is absent.
          // A missing group/message has its own structured error and must stay distinct.
          if (error.code === 'route-not-found') {
            error.message = uiT('执行过程接口尚未加载。请完全退出并重新启动 DSH，再打开此面板；仅刷新页面无法加载后端更新。');
            error.code = 'execution-api-unavailable';
          }
          throw error;
        }
      },
      sessionHistory: async (groupId, sessionId, afterSeq, signal) => {
        try {
          return await request(`${ROUTES.sessionHistory}?groupId=${encodeURIComponent(groupId)}&sessionId=${encodeURIComponent(sessionId)}&afterSeq=${afterSeq}&limit=100`, { method: 'GET', signal });
        } catch (error) {
          if (error.code === 'route-not-found') {
            error.message = uiT('完整会话接口尚未加载。请完全退出并重新启动 DSH，再打开此面板。');
            error.code = 'session-history-api-unavailable';
          }
          throw error;
        }
      },
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
      upload: (groupId, file) =>
        request(
          `${ROUTES.upload}?groupId=${encodeURIComponent(groupId || '')}&name=${encodeURIComponent(file.name || 'file')}`,
          {
            method: 'POST',
            headers: { 'content-type': file.type || 'application/octet-stream' },
            body: file,
          },
        ),
      skills: (groupId, memberId) =>
        request(
          `${ROUTES.skills}?groupId=${encodeURIComponent(groupId)}&memberId=${encodeURIComponent(memberId || '')}`,
          { method: 'GET' },
        ),
      exportPdf: (groupId, lang) =>
        fetch(
          `${ROUTES.exportPdf}?groupId=${encodeURIComponent(groupId)}&lang=${encodeURIComponent(lang || 'zh')}`,
          { method: 'GET', credentials: 'same-origin' },
        ),
    };

    /** DSH's picker returns a host path; browser directory handles do not. */
    async function pickProjectDirectory() {
      const bridge = window.__DSH_DIRECTORY_PICKER__;
      if (bridge && typeof bridge.pick === 'function') return bridge.pick();
      const workspace = appCtx && appCtx.uiWorkspace;
      if (workspace && typeof workspace.pickDirectory === 'function') return workspace.pickDirectory();
      throw new Error(uiT('目录选择器不可用，请填写文件夹的绝对路径。'));
    }

    function formatFileSize(bytes) {
      const value = Number(bytes);
      if (!Number.isFinite(value) || value < 0) return '';
      if (value < 1024) return Math.round(value) + ' B';
      const units = ['KB', 'MB', 'GB', 'TB'];
      let amount = value / 1024;
      let unit = 0;
      while (amount >= 1024 && unit < units.length - 1) {
        amount /= 1024;
        unit += 1;
      }
      return (amount >= 10 ? Math.round(amount) : amount.toFixed(1)) + ' ' + units[unit];
    }

    /** The / menu only opens on a whitespace-bounded token under the caret. */
    function findSkillTrigger(value, caret) {
      const text = typeof value === 'string' ? value : '';
      const position = Number.isInteger(caret) ? Math.min(Math.max(caret, 0), text.length) : text.length;
      const before = text.slice(0, position);
      const match = /(^|\s)\/([a-zA-Z0-9-]*)$/.exec(before);
      if (!match) return null;
      return { start: match.index + match[1].length, query: match[2] };
    }

    function isOrderedSubsequence(haystack, needle) {
      let cursor = 0;
      for (const character of needle) {
        const found = haystack.indexOf(character, cursor);
        if (found < 0) return false;
        cursor = found + 1;
      }
      return true;
    }

    /** Fuzzy name filter: prefix matches first, then ordered subsequences, stable. */
    function rankSkills(skills, query) {
      const list = Array.isArray(skills)
        ? skills.filter((skill) => skill && typeof skill.name === 'string' && skill.name.length > 0)
        : [];
      const needle = String(query || '').trim().toLowerCase();
      if (!needle) return list.slice();
      const matches = [];
      list.forEach((skill, index) => {
        const name = skill.name.toLowerCase();
        if (!isOrderedSubsequence(name, needle)) return;
        matches.push({ skill, index, prefix: name.startsWith(needle) });
      });
      matches.sort((left, right) => Number(right.prefix) - Number(left.prefix) || left.index - right.index);
      return matches.map((entry) => entry.skill);
    }

    /** Commands are reserved only at the start of a complete, standalone draft. */
    function parseBuiltinCommand(value) {
      const text = String(value || '').trim();
      if (text === '/new') return { command: 'new', valid: true };
      if (/^\/new\s/.test(text)) return { command: 'new', valid: false };
      return null;
    }

    function commandSkillOptions(skills, query, start = 0) {
      const options = rankSkills(skills, query).map(skill => skill.name === 'new' ? { ...skill, conflict: true } : skill);
      if (start === 0 && 'new'.startsWith(String(query || ''))) options.unshift({ name: 'new', builtin: true, description: uiT('开始新的对话上下文，历史仍可查看') });
      return options;
    }

    function currentConversationId(group) {
      return group?.currentConversationId || group?.activeConversationId || null;
    }

    function currentMemberSession(member, group) {
      const id = currentConversationId(group);
      if (!id) return member?.sessionId || null;
      if (member?.sessionConversationId !== id) return null;
      return member?.currentSessionId === undefined ? member?.sessionId || null : member.currentSessionId;
    }

    function memberLogLabel(member, group) {
      if (!currentConversationId(group)) return '查看日志';
      return currentMemberSession(member, group) ? '本会话日志' : member?.sessionId ? '上一会话日志' : '本会话尚无日志';
    }

    function historicalMessage(message, group) {
      const id = currentConversationId(group);
      if (!id || !message) return false;
      if (message.conversationId) return message.conversationId !== id;
      return Number(message.seq) <= Number(group?.currentConversation?.afterSeq || 0);
    }

    function conversationBlockReason(group, capabilities) {
      if (group?.conversationStateConflict) return uiT('正在刷新会话状态，请稍后重试');
      if (!capabilities?.conversations || !capabilities?.expectedConversationId || !currentConversationId(group)) return uiT('Host 尚不支持新建会话，请更新并重新加载');
      return '';
    }

    // Native activity may end without a new bootstrap. Keep its explanation, but
    // let the atomic Host guard re-check it when the user explicitly retries.
    function conversationActivityHint(group) {
      if (group?.canStartConversation !== false) return '';
      const blockers = (group.conversationBlockers || []).map(item => typeof item === 'string' ? item : item.message || item.reason || item.kind || item.code).filter(Boolean);
      return (blockers.join(' · ') || uiT('当前工作尚未结束，请停止或等待后重试')) + ' · ' + uiT('点击重试检查当前状态');
    }

    function mergeConversationBoundaries(previous, incoming) {
      const records = new Map((previous || []).map(item => [item.conversationId, item]));
      for (const item of incoming || []) if (item?.conversationId) records.set(item.conversationId, { ...records.get(item.conversationId), ...item });
      return [...records.values()].sort((a, b) => Number(a.afterSeq) - Number(b.afterSeq) || Number(a.ordinal) - Number(b.ordinal));
    }

    /** Every transport uses this merge; old snapshots can add history, never rewind execution. */
    function mergeConversationState(state, groupId, incoming, authoritative = false) {
      if (!groupId || !incoming) return state;
      if (!currentConversationId(incoming) && !incoming.conversation && !incoming.currentConversation && !incoming.conversationBoundaries && !incoming.conversations) return state;
      const current = state.groups.find(group => group.groupId === groupId) || {};
      const records = mergeConversationBoundaries(state.conversationsByGroup?.[groupId], [
        ...(incoming.conversationBoundaries || incoming.conversations || []), incoming.conversation, incoming.currentConversation,
      ].filter(Boolean));
      const id = currentConversationId(incoming);
      const version = Number(incoming.conversationVersion);
      const knownVersion = Number(current.conversationVersion) || 0;
      const conflict = id && version === knownVersion && currentConversationId(current) && id !== currentConversationId(current);
      let next = { ...state, conversationsByGroup: { ...state.conversationsByGroup, [groupId]: records } };
      if (conflict && !authoritative) return { ...state, groups: state.groups.map(group => group.groupId === groupId ? { ...group, conversationStateConflict: true } : group), refreshTick: state.refreshTick + (state.conversationConflicts?.[groupId] ? 0 : 1), conversationConflicts: { ...state.conversationConflicts, [groupId]: true } };
      if (!id || !Number.isSafeInteger(version) || version < knownVersion) return next;
      if (state.conversationConflicts?.[groupId] && !authoritative && version === knownVersion) return next;
      const conversation = incoming.currentConversation?.conversationId === id ? incoming.currentConversation : records.find(item => item.conversationId === id);
      const changed = currentConversationId(current) !== id;
      next.groups = state.groups.map(group => group.groupId !== groupId ? group : {
        ...group, activeConversationId: id, currentConversationId: id, conversationVersion: version, conversationStateConflict: false,
        currentConversation: conversation || (changed ? null : group.currentConversation),
        ...(incoming.canStartConversation !== undefined ? { canStartConversation: incoming.canStartConversation, conversationBlockers: incoming.conversationBlockers || [] } : {}),
      });
      next.conversationConflicts = { ...state.conversationConflicts, [groupId]: false };
      return next;
    }

    function refreshConversationSessionBinding(state, frame) {
      if (!['message.added', 'message.updated', 'execution.updated'].includes(frame.type)) return state;
      const groupId = frame.message?.groupId || frame.groupId || state.activeGroupId;
      const group = state.groups.find(item => item.groupId === groupId);
      const conversationId = currentConversationId(group);
      const message = frame.message || (state.messagesByGroup[groupId] || []).find(item => item.messageId === frame.messageId);
      const sessionId = frame.execution?.sessionId || frame.sessionId || message?.meta?.execution?.sessionId;
      if (!conversationId || (frame.conversationId || message?.conversationId) !== conversationId || !sessionId) return state;
      if (state.members.some(member => member.groupId === groupId && currentMemberSession(member, group) === sessionId)) return state;
      const key = groupId + ':' + conversationId + ':' + sessionId;
      if (state.sessionBindingRefreshes?.[key]) return state;
      // The message identifies the generation, but bootstrap owns member bindings.
      // Never promote member.sessionId when currentSessionId is explicitly null.
      return { ...state, refreshTick: state.refreshTick + 1, sessionBindingRefreshes: { ...state.sessionBindingRefreshes, [key]: true } };
    }

    function conversationTimeline(messages, conversations) {
      const rows = [];
      const boundaries = mergeConversationBoundaries([], conversations);
      let cursor = 0;
      for (const message of [...(messages || [])].sort((a, b) => a.seq - b.seq)) {
        while (cursor < boundaries.length && Number(boundaries[cursor].afterSeq) < Number(message.seq)) rows.push({ conversation: boundaries[cursor++] });
        rows.push({ message });
      }
      while (cursor < boundaries.length) rows.push({ conversation: boundaries[cursor++] });
      return rows;
    }

    function conversationLabel(conversation) {
      return uiT('会话 {ordinal}', { ordinal: conversation.ordinal });
    }

    function conversationTime(conversation) {
      return conversation.createdAt ? new Date(conversation.createdAt).toLocaleString(isEnglishUi() ? 'en-US' : 'zh-CN') : '';
    }

    function conversationDate(value) {
      if (value === '' || (typeof value !== 'number' && typeof value !== 'string')) return null;
      const date = new Date(value);
      return Number.isFinite(date.getTime()) ? date : null;
    }

    /** Use only the direct successor: paginated history may have gaps. */
    function conversationRange(conversation, nextConversation, current) {
      const start = conversationDate(conversation.createdAt);
      const successor = !current && nextConversation?.previousConversationId === conversation.conversationId &&
        nextConversation.groupId === conversation.groupId && Number(nextConversation.ordinal) === Number(conversation.ordinal) + 1;
      const candidate = successor ? conversationDate(nextConversation.createdAt) : null;
      const end = start && candidate && candidate >= start ? candidate : null;
      const clock = date => padClock(date.getHours()) + ':' + padClock(date.getMinutes());
      const dated = (date, year) => (year ? date.getFullYear() + '/' : '') + padClock(date.getMonth() + 1) + '/' + padClock(date.getDate()) + ' ' + clock(date);
      const crossDay = start && end && !sameDay(start, end);
      const includeYear = crossDay && (start.getFullYear() !== end.getFullYear() || start.getFullYear() !== new Date().getFullYear());
      const full = date => date.toLocaleString(isEnglishUi() ? 'en-US' : 'zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
      });
      return {
        startLabel: start ? crossDay ? dated(start, includeYear) : formatTimeDivider(start.toISOString()) : uiT('时间未知'),
        endLabel: current ? uiT('至今') : end ? crossDay ? dated(end, includeYear) : clock(end) : uiT('结束时间未知'),
        startTime: start?.toISOString(), endTime: end?.toISOString(),
        detail: uiT('开始：{time}', { time: start ? full(start) : uiT('时间未知') }) + '\n' +
          uiT('结束：{time}', { time: current ? uiT('至今') : end ? full(end) : uiT('时间未知') }),
      };
    }

    /** Fire-and-forget UI verification report (ends up in the Host smoke log). */
    function uiReport(payload) {
      try {
        void api.action('ui.report', payload).catch(() => {});
      } catch {
        /* best effort */
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
    async function collectAllMessages(groupId, { includeConversations = false, fetchMessages = api.messages, fetchConversations = api.conversations } = {}) {
      const collected = [];
      let before;
      let conversations = [];
      let truncated = false;
      const seen = new Set();
      for (let page = 0; page < 50; page += 1) {
        const result = await fetchMessages(groupId, before);
        const messages = result.messages || [];
        conversations = mergeConversationBoundaries(conversations, result.conversationBoundaries);
        for (const message of messages) {
          if (seen.has(message.messageId)) continue;
          seen.add(message.messageId);
          collected.push(message);
        }
        truncated = result.hasMore === true;
        if (!result.hasMore || messages.length === 0) break;
        const next = Math.min(...messages.map(message => message.seq));
        if (before !== undefined && next >= before) break;
        before = next;
      }
      if (includeConversations) {
        let beforeOrdinal;
        for (let page = 0; page < 50; page += 1) {
          const result = await fetchConversations(groupId, { beforeOrdinal, limit: 100 });
          conversations = mergeConversationBoundaries(conversations, result.conversations);
          if (!result.hasMore) break;
          if (page === 49 || !result.conversations?.length) { truncated = true; break; }
          const next = Math.min(...result.conversations.map(item => item.ordinal));
          if (beforeOrdinal !== undefined && next >= beforeOrdinal) { truncated = true; break; }
          beforeOrdinal = next;
        }
      }
      collected.sort((a, b) => a.seq - b.seq);
      collected.conversations = conversations;
      collected.truncated = truncated;
      return collected;
    }

    function authorNameOf(message, bots) {
      if (!message || !message.author) return uiT('未知');
      if (message.author.type === 'human') return message.author.name || uiT('用户');
      if (message.author.type === 'system') return uiT('系统');
      const bot = message.author.botId ? bots.find((candidate) => candidate.botId === message.author.botId) : null;
      return bot ? bot.name : message.author.name || 'Bot';
    }

    // Host/system messages are stored as Chinese prose. Translate the known
    // event forms at render time (and in exports) so historic data follows a
    // language switch without rewriting persisted messages.
    const SYSTEM_MESSAGE_PATTERNS = [
      [/^讨论「(.+?)」总结失败\/中断，已结束。$/, (m) => uiT('讨论「{topic}」总结失败/中断，已结束。', { topic: m[1] })],
      [/^讨论「(.+?)」因成员执行失败而停止。$/, (m) => uiT('讨论「{topic}」因成员执行失败而停止。', { topic: m[1] })],
      [/^讨论「(.+?)」已停止：(.+)$/, (m) => uiT('讨论「{topic}」已停止：{message}', { topic: m[1], message: m[2] })],
      [/^讨论「(.+?)」已停止。$/, (m) => uiT('讨论「{topic}」已停止。', { topic: m[1] })],
      [/^讨论「(.+?)」结束。$/, (m) => uiT('讨论「{topic}」结束。', { topic: m[1] })],
      [/^开始讨论：(.+?)（(\d+) 位成员，共 (\d+) 轮(，结束生成总结)?）$/, (m) => uiT('开始讨论：{topic}（{count} 位成员，共 {rounds} 轮{suffix}）', {
        topic: m[1],
        count: m[2],
        rounds: m[3],
        suffix: m[4] ? uiT('，结束生成总结') : '',
      })],
      [/^请 @(.+?) 评审 #(\d+)（(.+?)）的消息$/, (m) => uiT('请 @{reviewer} 评审 #{seq}（{author}）的消息', { reviewer: m[1], seq: m[2], author: m[3] })],
      [/^请 @(.+?) 根据 #(\d+) 的评审意见修改 #(\d+)$/, (m) => uiT('请 @{bot} 根据 #{reviewSeq} 的评审意见修改 #{targetSeq}', { bot: m[1], reviewSeq: m[2], targetSeq: m[3] })],
      [/^任务「(.+?)」已验收，前置依赖解除：(.+?) 可以派发了。$/, (m) => uiT('任务「{title}」已验收，前置依赖解除：{names} 可以派发了。', { title: m[1], names: m[2].split('、').join(', ') })],
      [/^(.+?) 请求权限：工具 (.+?)(（(.+)）)?。$/, (m) => uiT('{name} 请求权限：工具 {tool}{reason}。', {
        name: m[1],
        tool: m[2],
        reason: m[4] ? uiT('（{reason}）', { reason: m[4] }) : '',
      })],
    ];

    function translateSystemText(text) {
      if (!isEnglishUi()) return String(text || '');
      const source = String(text || '');
      for (const [pattern, render] of SYSTEM_MESSAGE_PATTERNS) {
        const match = pattern.exec(source);
        if (match) return render(match);
      }
      return source;
    }

    function buildGroupMarkdown({ group, members, bots, messages, conversations = messages.conversations || [], truncated = messages.truncated === true }) {
      const lines = [];
      const sep = isEnglishUi() ? ', ' : '、';
      lines.push(`# ${group.title}`);
      if (group.topic) lines.push(`> ${group.topic}`);
      lines.push('');
      lines.push(`${uiT('- 成员：')}${members.map((member) => {
        const bot = bots.find((candidate) => candidate.botId === member.botId);
        return bot
          ? `${bot.name}${isEnglishUi() ? ' (' : '（'}${bot.provider}/${bot.model}${isEnglishUi() ? ')' : '）'}`
          : uiT('（已删除）');
      }).join(sep)}`);
      lines.push(`${uiT('- 导出时间：')}${new Date().toLocaleString(isEnglishUi() ? 'en-US' : 'zh-CN')}`);
      lines.push(`${uiT('- 消息数：')}${messages.length}`);
      lines.push(uiT('导出范围：整个聊天，包含所有会话分段'));
      if (truncated) lines.push('> ' + uiT('导出不完整：已达到 50 页读取上限或历史分页中断，更早内容可能未包含。'));
      lines.push('');
      lines.push('---');
      lines.push('');
      const entries = conversationTimeline(messages, conversations);
      for (const [index, entry] of entries.entries()) {
        if (entry.conversation) {
          lines.push('## ' + conversationLabel(entry.conversation) + ' · ' + conversationTime(entry.conversation), '');
          if (!entries[index + 1]?.message) lines.push(uiT('本会话没有消息'), '');
          continue;
        }
        const message = entry.message;
        const author = authorNameOf(message, bots);
        const badges = [];
        if (message.meta && message.meta.round) badges.push(uiT('第 {round} 轮', { round: message.meta.round }));
        if (message.meta && message.meta.summary) badges.push(uiT('讨论总结'));
        if (message.meta && message.meta.verdict === 'pass') badges.push(uiT('评审通过'));
        if (message.meta && message.meta.verdict === 'changes') badges.push(uiT('需修改'));
        if (message.status && message.status !== 'done') badges.push(message.status);
        lines.push(`## [#${message.seq}] ${author}${badges.length ? ` · ${badges.join(' · ')}` : ''}`);
        lines.push('');
        if (message.kind === 'system' || (message.author && message.author.type === 'system')) {
          lines.push(`> ${translateSystemText(message.text).replace(/\n/g, '\n> ')}`);
        } else {
          lines.push(String(message.text || ''));
        }
        if (Array.isArray(message.attachments) && message.attachments.length > 0) {
          for (const attachment of message.attachments) {
            const size = formatFileSize(attachment.bytes);
            lines.push(uiT('- 附件：') + attachment.name + (size ? (isEnglishUi() ? ' (' : '（') + size + (isEnglishUi() ? ')' : '）') : ''));
          }
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

    function buildGroupHtml({ group, members, bots, messages, conversations = messages.conversations || [], truncated = messages.truncated === true }) {
      const title = escapeHtml(group.title || 'Bot Team');
      const en = isEnglishUi();
      const sep = en ? ', ' : '、';
      const roster = members
        .map((member) => {
          const bot = bots.find((candidate) => candidate.botId === member.botId);
          return bot
            ? escapeHtml(
                  bot.name +
                  (en ? ' (' : '（') +
                  bot.provider +
                  '/' +
                  bot.model +
                  (en ? ')' : '）'),
              )
            : '';
        })
        .filter(Boolean)
        .join(sep);
      const entries = conversationTimeline(messages, conversations);
      const rows = entries
        .map((entry, index) => {
          if (entry.conversation) return '<section class="conversation"><h2>' + escapeHtml(conversationLabel(entry.conversation)) + '</h2><p>' + escapeHtml(conversationTime(entry.conversation)) + '</p>' + (!entries[index + 1]?.message ? '<p>' + escapeHtml(uiT('本会话没有消息')) + '</p>' : '') + '</section>';
          const message = entry.message;
          const author = escapeHtml(authorNameOf(message, bots));
          const badges = [];
          if (message.meta && message.meta.round) badges.push(uiT('第 {round} 轮', { round: message.meta.round }));
          if (message.meta && message.meta.summary) badges.push(uiT('总结'));
          if (message.meta && message.meta.verdict === 'pass') badges.push(uiT('评审通过'));
          if (message.meta && message.meta.verdict === 'changes') badges.push(uiT('需修改'));
          const body = markdownToHtml(message.author && message.author.type === 'system' ? translateSystemText(message.text) : message.text || '');
          const attachments = Array.isArray(message.attachments)
            ? message.attachments
                .map((attachment) => {
                  const size = formatFileSize(attachment.bytes);
                  return '<div class="attachment">' + escapeHtml(uiT('附件')) + ' · ' + escapeHtml(attachment.name) + (size ? ' · ' + size : '') + '</div>';
                })
                .join('')
            : '';
          const badgeHtml = badges.length ? ' · ' + badges.join(' · ') : '';
          return (
            '<article class="msg"><header>#' +
            message.seq +
            ' · ' +
            author +
            badgeHtml +
            '</header><div class="body">' +
            body +
            attachments +
            '</div></article>'
          );
        })
        .join('\n');
      return (
        '<!doctype html><html lang="' + (en ? 'en' : 'zh-CN') + '"><head><meta charset="utf-8"><title>' +
        title +
        '</title><style>' +
        'body{font-family:-apple-system,system-ui,sans-serif;max-width:860px;margin:32px auto;padding:0 20px;color:#1f2329;line-height:1.6}' +
        'h1{font-size:22px}blockquote{border-left:3px solid #d1d5db;margin:0;padding-left:12px;color:#6b7280}' +
        'pre{background:#f6f8fa;border-radius:8px;padding:10px;overflow:auto}code{font-family:ui-monospace,monospace;font-size:12px}' +
        '.msg{border-bottom:1px solid #eee;padding:10px 0}.msg header{font-size:12px;color:#6b7280;font-weight:600;margin-bottom:4px}' +
        '.attachment{display:inline-block;margin-top:6px;padding:4px 8px;border:1px solid #e5e7eb;border-radius:6px;background:#f9fafb;color:#4b5563;font-size:12px}' +
        '</style></head><body><h1>' +
        title +
        '</h1>' +
        (group.topic ? '<blockquote>' + escapeHtml(group.topic) + '</blockquote>' : '') +
        '<p>' + escapeHtml(uiT('成员：')) +
        roster +
        '</p><p>' + escapeHtml(uiT('导出时间：')) +
        escapeHtml(new Date().toLocaleString(en ? 'en-US' : 'zh-CN')) +
        ' · ' + escapeHtml(uiT('消息数：')) +
        messages.length +
        '</p><p>' + escapeHtml(uiT('导出范围：整个聊天，包含所有会话分段')) + '</p>' +
        (truncated ? '<p role="alert">' + escapeHtml(uiT('导出不完整：已达到 50 页读取上限或历史分页中断，更早内容可能未包含。')) + '</p>' : '') + '<hr/>' +
        rows +
        '</body></html>'
      );
    }

    function downloadBlob(filename, blob) {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    function downloadText(filename, text, mime) {
      downloadBlob(filename, new Blob([text], { type: mime || 'text/markdown;charset=utf-8' }));
    }

    function safeExportName(value, fallback) {
      return String(value || fallback || 'bot-team').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80) || fallback || 'bot-team';
    }

    // Kept in sync with host/chat-settings.js; the Host persists these per profile.
    // UI dictionaries are keyed by the Chinese source string. UI_ZH is generated
    // from the same keys at registration time; UI_EN lives beside it so a missing
    // entry falls back to Chinese instead of blank text.
    const UI_EN = {
      '点击重试检查当前状态': 'Click to check the current status again',
      '正在刷新会话状态，请稍后重试': 'Refreshing conversation state. Try again shortly.',
      '聊天已开始新会话，请关闭对话框后重试': 'A new conversation has started. Close this dialog and try again.',
      '会话历史与所选会话不匹配': 'Conversation history does not match the selected conversation.',
      "新建会话": "New conversation",
      "开始新的对话上下文，历史仍可查看": "Start fresh context; history stays available",
      "为本群全部成员开始新会话": "Start a new conversation for every group member",
      "已开始新会话": "New conversation started",
      "请单独发送 /new": "Send /new on its own",
      "Skill new 与内建指令冲突，请用自然语言明确要求加载该 Skill": "The Skill named new conflicts with the built-in command. Ask to load that Skill in natural language.",
      "Host 尚不支持新建会话，请更新并重新加载": "This Host does not support new conversations yet. Update and reload.",
      "当前工作尚未结束，请停止或等待后重试": "Work is still active. Stop it or wait, then try again.",
      "聊天已开始新会话，草稿已保留": "A new conversation has started. Your draft is preserved.",
      "将草稿用于当前会话": "Use draft in current conversation",
      "会话 {ordinal}": "Conversation {ordinal}",
      "当前会话": "Current conversation",
      "当前": "Current",
      "至今": "Present",
      "时间未知": "Time unknown",
      "结束时间未知": "End time unknown",
      "开始：{time}": "Started: {time}",
      "结束：{time}": "Ended: {time}",
      "查看{conversation}的日志": "View logs for {conversation}",
      "查看本会话日志": "View logs for this conversation",
      "本会话日志": "Current conversation logs",
      "本会话尚无日志": "No logs in this conversation yet",
      "上一会话日志": "Previous conversation logs",
      "加载更多日志": "Load more logs",
      "加载更早的会话分段": "Load earlier conversation segments",
      "本会话没有消息": "No messages in this conversation",
      "引用到当前会话": "Quote in current conversation",
      "明确引用这条历史消息到当前会话": "Explicitly quote this historical message in the current conversation",
      "历史会话只读，请明确引用到当前会话": "Historical conversations are read-only. Explicitly quote content in the current conversation.",
      "导出范围：整个聊天，包含所有会话分段": "Export scope: entire chat, including all conversation segments",
      "导出不完整：已达到 50 页读取上限或历史分页中断，更早内容可能未包含。": "Incomplete export: the 50-page retrieval limit was reached or history pagination stopped. Earlier content may be missing.",
      "选择指令或 Skill": "Choose a command or Skill",
      "↑↓ 选择 · Enter 补全 · Tab 补全 · /new 再次 Enter 执行": "↑↓ choose · Enter/Tab complete · Enter again to run /new",
      "Enter 发送 · Shift + Enter 换行 · / 选择指令或 Skill": "Enter send · Shift + Enter newline · / choose a command or Skill",
      "Enter 发送 · Shift + Enter 换行 · @ 提及成员 · / 选择指令或 Skill": "Enter send · Shift + Enter newline · @ mention · / choose a command or Skill",
      "将整个聊天导出为 Markdown（包含所有会话）": "Export the entire chat as Markdown (all conversations)",
      "将整个聊天导出为 HTML（包含所有会话）": "Export the entire chat as HTML (all conversations)",
      "将整个聊天导出为 PDF（包含所有会话）": "Export the entire chat as PDF (all conversations)",
      "历史引用只包含所选消息，不会带入其他历史内容": "This quote includes only the selected message, without surrounding history",
      "开始使用": "Get started",
      "选择一个单聊或群聊开始对话": "Select a direct or group chat to start a conversation",
      "Bot Team 导航": "Bot Team navigation",
      "欢迎来到 Bot Team": "Welcome to Bot Team",
      "好搭档，从这里开始。": "Great teammates start here.",
      "从一次对话，到一群 Bot 的默契协作。": "From one conversation to a team working together.",
      "为你的想法，找到一起把它实现的搭档。": "Find the teammates who help bring your ideas to life.",
      "你的第一位搭档，即将到来。": "Your first teammate starts here.",
      "为一个共同的目标，聚在一起。": "Bring a team together around a shared goal.",
      "快速上手": "Quick start",
      "工作空间": "Workspace",
      "打开导航": "Open navigation",
      "关闭导航": "Close navigation",
      "创建第一个 Bot": "Create your first Bot",
      "创建 Bot": "Create Bot",
      "推荐第一步": "Start here",
      "选一个模型，赋予它名字与专长。": "Choose a model, a name, and a specialty.",
      "写代码、找资料、聊想法，从一位搭档开始。": "Code, research, or explore an idea with your first teammate.",
      "自动开启一对一会话": "Includes a direct chat",
      "组建一个协作群": "Bring a team together",
      "让不同专长的 Bot 聚在一起。": "Bring Bots with different strengths into one group.",
      "讨论、分工、互相检查，一起把任务向前推进。": "Discuss, divide the work, and review it together.",
      "创建群聊": "Create group",
      "也可以稍后添加 Bot": "You can add Bots later",
      "一个想法，可以这样一起完成": "One idea, a few helpful teammates",
      "协作示例": "Example workflow",
      "@研究员 @工程师 @审阅者": "@Researcher @Engineer @Reviewer",
      "一起帮我做一个个人网站": "Help me build a personal website",
      "在群聊中": "In a group chat",
      "研究员": "Researcher",
      "工程师": "Engineer",
      "审阅者": "Reviewer",
      "梳理需求，找到合适的方向": "Explore the needs and find a direction",
      "编写代码，把想法做出来": "Write the code and bring it to life",
      "检查细节，让结果更可靠": "Review the details and improve the result",
      "每个 Bot 都可以有自己的模型与做事风格，你来决定如何搭配。": "Each Bot can have its own model and working style. You choose the mix.",
      "先从单聊开始也很好，随时都能组建你的团队。": "Start with a direct chat. You can build your team whenever you are ready.",
      "各有所长，一起完成。": "Different strengths. Better together.",
      "三小步，开启协作": "Three steps to working together",
      "先认识一位 Bot": "Meet your first Bot",
      "选择模型、名字与专长。创建后，它会自动拥有一个和你的单聊。": "Choose a model, name, and specialty. Your Bot gets a direct chat as soon as you create it.",
      "为共同的目标，建一个群": "Create a group around a goal",
      "邀请不同专长的 Bot 加入，同一个 Bot 也可以参与多个群。": "Invite Bots with different strengths. A Bot can participate in more than one group.",
      "用 @ 邀请它们参与": "Invite them with @mentions",
      "让 Bot 讨论问题、处理任务或检查彼此的工作。你来掌握方向。": "Ask Bots to discuss a problem, handle a task, or review each other's work. You set the direction.",
      " · 群：": " · Groups: ",
      " · 未加入任何群聊": " · No group chats",
      " · 消息数：": " · Messages: ",
      " [代码] ": " [code] ",
      " [图片] ": " [image] ",
      " 发消息…": " a message…",
      " 个 Bot 正在回复 · 停止": " bots replying · Stop",
      " 个文件": " files per message",
      " 轮": " ",
      "- 附件：": "- Attachment: ",
      "（回复中）": " (replying)",
      "（空）": "(empty)",
      "（已删除）": "(deleted)",
      "（Bot 已删除）": "(Bot deleted)",
      "[消息]": "[Message]",
      "」超过 32 MB，已跳过": "」 exceeds 32 MB and was skipped",
      "」上传失败：": "” upload failed: ",
      "@ 提及": "@ mention",
      "↑↓ 选择 · Enter 插入 · Esc 关闭": "↑↓ to select · Enter to insert · Esc to close",
      "↑↓ 选择 · Enter 确认": "↑↓ to select · Enter to confirm",
      "+ 添加": "+ Add",
      "+ 新建 Bot": "+ New Bot",
      "＋ 新建分组…": "+ New folder…",
      "</p><p>导出时间：": "</p><p>Exported at: ",
      "<div class=\"attachment\">附件 · ": "<div class=\"attachment\">Attachment · ",
      "<p>成员：": "<p>Members: ",
      "把 SKILL.md 放到 .dsh/skills 或 ~/.dsh/skills 后重试。": "Put SKILL.md in .dsh/skills or ~/.dsh/skills, then retry.",
      "版本": "Version",
      "包名": "Package",
      "保存": "Save",
      "保存设置": "Save settings",
      "保存中…": "Saving…",
      "本群累计 Token": "Group token usage",
      "输入": "Input",
      "输出": "Output",
      "累计 {count} Token": "{count} tokens in total",
      "编辑": "Edit",
      "编辑 Bot": "Edit Bot",
      "编辑群信息": "Edit group info",
      "编辑这个 Bot": "Edit this Bot",
      "不分组": "No folder",
      "参与成员": "Participants",
      "插画头像": "Illustrated avatars",
      "预置头像": "Preset avatars",
      "轨道": "Orbit",
      "灵光": "Spark",
      "电路": "Circuit",
      "像素": "Pixel",
      "侦察": "Scout",
      "助理": "Assistant",
      "智核": "AI core",
      "仿生": "Android",
      "团队": "Team",
      "机友": "Bot crew",
      "互联": "Connected",
      "智研": "Research team",
      "围坐": "Roundtable",
      "集群": "AI swarm",
      "社区": "Community",
      "插件说明、版本号与开发者信息。": "Plugin description, version, and developer information.",
      "插入 @ 提及": "Insert @ mention",
      "插入 @ 提及，选中群成员": "Insert an @ mention and pick a group member",
      "插入 /技能名，让 Bot 按 Skill 执行": "Insert /skill-name to have the Bot run a Skill",
      "插入模板": "Insert template",
      "查看 Bot 会话": "View Bot conversation",
      "查看会话": "View conversation",
      "常驻显示": "Always show",
      "出错": "Error",
      "创建": "Create",
      "创建 Bot": "Create Bot",
      "创建单聊": "Create direct chat",
      "创建一个可复用的 Agent：定好它是谁、用什么模型。": "Create a reusable agent: define who it is and which model it uses.",
      "从全局 Bot 库删除「": "Delete from the global Bot library: 「",
      "从左侧「单聊」新建一个 Bot（自动获得一对一会话），或创建一个群/话题把多个 Bot 拉进来；每个 Bot 可以有自己的模型、BOT.md 人格与能力。": "Create a Bot from “Direct chat” on the left (it gets a one-on-one conversation automatically), or create a group/topic and add several Bots. Each Bot can have its own model, BOT.md persona, and capabilities.",
      "打开 Bot Team 消息设置": "Open Bot Team message settings",
      "打开单聊": "Open direct chat",
      "待派发": "Pending dispatch",
      "单聊": "Direct chat",
      "单聊 · 多 Agent 群聊 · 自定义分组": "Direct chats · Multi-agent group chats · Custom folders",
      "单聊消息会直接发给这个 Bot，不需要 @；它的回复会实时出现在这里。": "Direct messages go straight to this Bot, no @ needed; its replies appear here in real time.",
      "单聊消息输入框": "Direct chat message input",
      "单聊自动创建": "Auto-created direct chats",
      "当前工作区没有可用的 Skill": "No Skills are available in the current workspace",
      "当前浏览器不支持文件选择": "File selection is not supported in this browser",
      "当前内容已包含该模板，未重复插入。": "This template is already included; it was not inserted again.",
      "当前是插画群头像；可随机配色或重置为按名称生成。": "Currently using an illustrated group avatar; you can randomize colors or reset to name-based generation.",
      "当前是插画头像；可随机换机器人或重置为按名称生成。": "Currently using an illustrated avatar; you can switch to another robot or reset to name-based generation.",
      "当前是随机配色群头像；可再次随机或重置为按名称生成。": "Currently using a randomly colored group avatar; you can randomize again or reset to name-based generation.",
      "当前是随机生成的机器人头像；可再次随机或重置为按名称生成。": "Currently using a randomly generated robot avatar; you can randomize again or reset to name-based generation.",
      "导出 HTML": "Export HTML",
      "导出 Markdown": "Export Markdown",
      "等待审批": "Awaiting approval",
      "低": "Low",
      "第 ": "Round ",
      "调整它的模型与人格设定；所有 Bot 默认具备完整工具权限。": "Adjust its model and persona; all Bots have full tool access by default.",
      "定位到原消息": "Jump to original message",
      "定位原消息": "Go to original message",
      "对话": "Chats",
      "发起多轮讨论": "Start multi-round discussion",
      "发起评审": "Start review",
      "发起讨论": "New discussion",
      "发送": "Send",
      "发送中…": "Sending…",
      "发言中": "Speaking",
      "分组": "Folder",
      "分组名称": "Folder name",
      "分组内还没有群": "No groups in this folder yet",
      "分组上移": "Move folder up",
      "分组下移": "Move folder down",
      "分组在左侧「群聊」中可展开/收起，也可以直接拖动群调整位置。": "Folders can be expanded or collapsed under “Group chats” on the left; you can also drag groups to reorder them.",
      "分组只影响左侧群聊列表的整理方式，不会移动或删除群内消息。": "Folders only change how the group chat list on the left is organized; they never move or delete messages in a group.",
      "复制成带作者署名的 Markdown 引用": "Copy as a Markdown quote with author attribution",
      "复制为引用": "Copy as quote",
      "复制文本": "Copy text",
      "复制消息原文（Markdown）": "Copy message source (Markdown)",
      "高": "High",
      "给 ": "Send ",
      "更多单聊操作": "More direct chat actions",
      "更多群操作": "More group actions",
      "工作目录（可选，绝对路径）": "Working directory (optional, absolute path)",
      "关闭": "Close",
      "关于": "About",
      "滚动到这条消息引用的原消息": "Scroll to the quoted original message",
      "还没有 Bot，点「+ 新建 Bot」创建一个。": "No bots yet. Click “+ New Bot” to create one.",
      "还没有 Bot。新建一个 Bot，就会自动拥有一个单聊窗口。": "No bots yet. Create a Bot and it automatically gets a direct chat.",
      "还没有成员。添加一个 Bot，或用「新建 Bot」创建一个带人格设定的成员。": "No members yet. Add a Bot, or use “New Bot” to create one with a persona.",
      "还没有分组。可在左侧「群聊」标题右侧点文件夹图标新建。": "No folders yet. Click the folder icon to the right of the “Group chats” heading on the left to create one.",
      "还没有群。新建一个群/话题，然后把 Bot 拉进来。": "No groups yet. Create a group/topic, then add Bots.",
      "还没有消息": "No messages yet",
      "海浪": "Waves",
      "花朵": "Flower",
      "话题（可选）": "Topic (optional)",
      "恢复默认": "Restore default",
      "回到底部": "Back to bottom",
      "回复": "Reply",
      "回复 ": "Reply to ",
      "回复生成中，暂不可回复": "A reply is being generated; you can't reply yet.",
      "删除消息": "Delete message",
      "删除这条消息": "Delete this message",
      "回复生成中，请先停止回复再删除": "Stop the reply before deleting this message",
      "删除这条消息？删除后无法恢复。": "Delete this message? This cannot be undone.",
      "已删除消息": "Message deleted",
      "消息不存在或不属于本聊天": "The message does not exist or belongs to another chat",
      "只能删除普通聊天消息": "Only regular chat messages can be deleted",
      "消息正在生成，请结束后再删除": "Wait for the reply to finish before deleting it",
      "消息状态不支持删除": "This message cannot be deleted in its current state",
      "消息仍被执行中的任务使用，请结束后再删除": "An active task is using this message. Wait for it to finish before deleting it.",
      "消息正在删除": "The message is being deleted",
      "消息已删除": "The message has been deleted",
      "回复使用的模型": "Model used for replies",
      "回复这条消息": "Reply to this message",
      "回复中": "Replying",
      "会话操作": "Conversation actions",
      "会话视图服务不可用": "Conversation view service unavailable",
      "火箭": "Rocket",
      "火焰": "Flame",
      "技能": "Skills",
      "加载 Bot Team…": "Loading Bot Team…",
      "加载更早的消息": "Load earlier messages",
      "将当前会话导出为 HTML": "Export the current conversation as HTML",
      "将当前会话导出为 Markdown": "Export the current conversation as Markdown",
      "结束后由第一位成员输出共识/分歧/待决": "The first member summarizes consensus / disagreements / open questions at the end.",
      "结束总结": "Summary at end",
      "仅手动": "Manual only",
      "紧急": "Urgent",
      "进行中": "In progress",
      "开发者": "Developer",
      "开始单聊": "Start direct chat",
      "开始讨论": "Start discussion",
      "可用工具": "Available tools",
      "空内容直接填入；已有内容追加到末尾，末尾是旧模板时自动替换。": "Empty content is inserted directly; existing content is appended, and an old template at the end is replaced automatically.",
      "空闲": "Idle",
      "控制 Bot 回复下方的模型、Token 与速度信息；保存后应用于所有群聊与单聊。": "Controls the model, token, and speed details below Bot replies; applies to all group and direct chats after saving.",
      "例如：产品方案评审": "e.g. Product proposal review",
      "例如：工作": "e.g. Work",
      "例如：工作、产品、个人。同名分组只能有一个。": "e.g. Work, Product, Personal. Folder names must be unique.",
      "例如：架构师 Alice": "e.g. Architect Alice",
      "例如：如何看待把 Agent 群聊接入现有 IM？": "e.g. How should we integrate agent group chat with our existing IM?",
      "例如：重点检查方案风险与遗漏；输出 结论：通过/需修改，再给建议。": "e.g. Focus on risks and gaps; output Conclusion: pass / needs changes, then suggestions.",
      "联网": "Web access",
      "浏览器不支持复制": "Copying is not supported in this browser",
      "浏览器不支持图片处理": "Image processing is not supported in this browser",
      "留空使用插件默认目录，或填 /Users/you/project": "Leave blank to use the plugin's default directory, or enter /Users/you/project",
      "留空使用默认：$DSH_HOME/dsh-bot-team/groups/<群 id>；单聊默认 $DSH_HOME/dsh-bot-team/direct/<botId>。修改后 Bot 下一轮会重建 DSH 会话（群消息保留）。": "Leave blank for the default: $DSH_HOME/dsh-bot-team/groups/<group id>; direct chats default to $DSH_HOME/dsh-bot-team/direct/<botId>. After a change, the Bot rebuilds its DSH session on the next turn (group messages are kept).",
      "轮数": "Rounds",
      "没有匹配的 Skill": "No matching Skills",
      "每条消息最多添加 ": "Up to ",
      "命令": "Commands",
      "模型名称": "Model name",
      "模型与工具": "Model & tools",
      "默认": "Default",
      "默认按名称生成机器人头像；点「随机生成」换一个配色/表情。": "By default, a robot avatar is generated from the name; click “Randomize” for a new color/mood.",
      "默认按群名称生成渐变底色；可随机配色、选插画或上传图片。": "By default, a gradient is generated from the group name; you can randomize colors, pick an illustration, or upload an image.",
      "排队中": "Queued",
      "派发": "Dispatch",
      "平均回复速度": "Average reply speed",
      "评审": "Review",
      "评审通过": "Review passed",
      "评审要求（可选）": "Review requirements (optional)",
      "评审者": "Reviewer",
      "普通": "Normal",
      "请另一位成员评审这条回复": "Ask another member to review this reply",
      "请人评审": "Request review",
      "请先填写分组名称。": "Enter a folder name first.",
      "请先填写显示名。": "Enter a display name first.",
      "请选择图片文件": "Choose an image file",
      "取消": "Cancel",
      "取消回复": "Cancel reply",
      "去审批": "Go to approval",
      "群": "Group",
      "群里 @ 时使用；Bot 之间也用它互相称呼。": "Used for @ mentions in groups; Bots also use it to address each other.",
      "群聊": "Group chats",
      "群聊分组与拖拽排序": "Group chat folders and drag-and-drop ordering",
      "群聊设置已保存，已应用于所有群聊": "Group chat settings saved and applied to all group chats",
      "群聊消息输入框": "Group chat message input",
      "群名称": "Group name",
      "群头像": "Group avatar",
      "群头像会显示在左侧群列表和聊天顶部。": "The group avatar appears in the group list on the left and at the top of the chat.",
      "让作者按这条评审意见修改": "Ask the author to revise based on this review",
      "让作者修改": "Ask the author to revise",
      "人格模板库": "Persona templates",
      "人格与工作规范": "Persona & working guidelines",
      "人格与工作规范在「编辑 Bot → BOT.md」中维护，下一轮回复生效。": "Persona and working guidelines are maintained in “Edit Bot → BOT.md” and take effect on the next reply.",
      "任务与评审": "Tasks & reviews",
      "删除": "Delete",
      "删除 Bot": "Delete Bot",
      "删除分组": "Delete folder",
      "删除群": "Delete group",
      "删除中…": "Deleting…",
      "闪电": "Lightning",
      "上传本地文件，Bot 可按路径读取": "Upload a local file; the Bot can read it by path",
      "上传失败 · 移除后重试": "Upload failed · remove and retry",
      "上传图片": "Upload image",
      "上传中…": "Uploading…",
      "上移": "Move up",
      "设置": "Settings",
      "设置模块": "Settings sections",
      "审批不可用": "Approvals unavailable",
      "审批请求": "Approval request",
      "示例模型": "Sample model",
      "示例数据 · 移入下方区域查看": "Sample data · hover the area below to view",
      "收起侧栏": "Collapse sidebar",
      "收起未分组": "Collapse Ungrouped",
      "收起右侧面板": "Collapse right panel",
      "输出 Token": "Output tokens",
      "输入 Token": "Input tokens",
      "输入消息，@ 成员派活…": "Type a message, @ a member to assign work…",
      "数据存储": "Data storage",
      "Bot 会话": "Bot sessions",
      "使用真实的 DSH session。": "Uses real DSH sessions.",
      "人格文件": "Persona file",
      "单聊工作目录": "Direct chat working directory",
      "群聊工作目录": "Group chat working directory",
      "在新标签页打开 GitHub 仓库": "Open the GitHub repository in a new tab",
      "刷新": "Refresh",
      "搜索": "Search",
      "速度包含本次模型请求的等待与思考，不含工具执行；并非纯解码速度。缺少计时或 Token 数据的历史消息不显示速度。": "Speed includes waiting and thinking for this model request, excludes tool execution, and is not pure decode speed. Messages missing timing or token data show no speed.",
      "随机配色": "Random colors",
      "随机生成": "Randomize",
      "所有 Bot 均具备完整工具权限": "All Bots have full tool access",
      "它的单聊与全部单聊消息也会一并删除。": "Its direct chat and all direct chat messages will be deleted too.",
      "讨论": "Discussion",
      "讨论结束": "Discussion ended",
      "讨论停止": "Discussion stopped",
      "讨论议题": "Discussion topic",
      "讨论中": "Discussing",
      "讨论总结": "Discussion summary",
      "提及成员": "Mention member",
      "添加": "Add",
      "添加成员": "Add members",
      "添加文件或 Skill": "Add file or Skill",
      "条新消息": " new messages",
      "停止回复": "Stop reply",
      "停止讨论": "Stop discussion",
      "头像": "Avatar",
      "头像图片不能超过 8MB": "Avatar image must be 8 MB or smaller",
      "图片编码失败": "Failed to encode image",
      "图片解码失败": "Failed to decode image",
      "图片压缩后仍然过大，请换一张": "Image is still too large after compression; choose another one",
      "拖动群到这里可移出分组": "Drag a group here to remove it from its folder",
      "未分组": "Ungrouped",
      "未分组 ✓": "Ungrouped ✓",
      "未命名": "Untitled",
      "未选择图片": "No image selected",
      "未知": "Unknown",
      "文件": "File",
      "文件「": "File “",
      "文件读写": "File access",
      "我": "Me",
      "我：": "Me: ",
      "系统": "System",
      "下一轮回复生效": "Takes effect on the next reply",
      "下移": "Move down",
      "先在右侧成员面板添加 Bot，再 @ 它们": "Add Bots in the members panel on the right, then @ mention them",
      "先在右侧成员面板添加一个 Bot，再用 @ 提及它开始对话。": "Add a Bot in the members panel on the right, then @ mention it to start a conversation.",
      "显示名": "Display name",
      "消息": "Message",
      "消息操作": "Message actions",
      "消息设置": "Message settings",
      "消息信息显示预览": "Message info display preview",
      "效果预览": "Preview",
      "新建 Bot": "New Bot",
      "新建分组": "New folder",
      "新建群 / 话题": "New group / topic",
      "新群": "New group",
      "新消息": "New messages",
      "星球": "Planet",
      "星星": "Star",
      "修改": "Revision",
      "需修改": "Needs changes",
      "悬停显示": "Show on hover",
      "选择 Bot": "Select Bot",
      "选择 Skill": "Select Skill",
      "选择成员": "Select member",
      "选择要提及的成员": "Select a member to mention",
      "叶子": "Leaf",
      "移出群": "Remove from group",
      "移除文件": "Remove file",
      "移除文件 ": "Remove file ",
      "移动到分组": "Move to folder",
      "已包含": "Included",
      "已复制消息": "Message copied",
      "已复制引用": "Quote copied",
      "已交付": "Delivered",
      "已拒绝": "Rejected",
      "已取消": "Canceled",
      "已上传自定义群头像（自动裁成 256×256 方形）。": "Custom group avatar uploaded (auto-cropped to a 256×256 square).",
      "已上传自定义图片（自动裁成 256×256 方形）。": "Custom image uploaded (auto-cropped to a 256×256 square).",
      "已跳过空文件「": "Skipped empty file 「",
      "已停止": "Stopped",
      "已验收": "Accepted",
      "已隐藏全部消息信息": "All message info hidden",
      "已允许一次": "Allowed once",
      "已中断": "Interrupted",
      "隐藏": "Hide",
      "用户": "User",
      "月亮": "Moon",
      "云朵": "Cloud",
      "运行中": "Running",
      "在 Bot 会话里选择「允许一次」或「拒绝」；未处理会等到本轮超时，结果会同步回群里。": "Choose “Allow once” or “Deny” in the Bot conversation; unresolved requests wait until the turn times out, and the result is synced back to the group.",
      "在 DSH Web GUI 中运行单聊与多 Agent 群聊：每个 Bot 自动拥有独立的单聊窗口；群聊支持自定义分组、拖拽排序与展开/收起；Bot 可配置自己的模型、BOT.md 人格和完整工具能力。": "Run direct chats and multi-agent group chats in the DSH Web GUI: every Bot automatically gets its own direct chat window; group chats support custom folders, drag-and-drop ordering, and expand/collapse; each Bot can configure its own model, BOT.md persona, and full tool capabilities.",
      "在此分组新建群": "New group in this folder",
      "在下方输入消息，用 @ 提及成员；被 @ 的 Bot 会并行回复。": "Type a message below and @ mention members; mentioned Bots reply in parallel.",
      "暂无消息": "No messages yet",
      "展开 / 收起": "Expand / collapse",
      "展开侧栏": "Expand sidebar",
      "展开未分组": "Expand Ungrouped",
      "展开右侧面板": "Expand right panel",
      "这个单聊的成员已不存在": "This direct chat's member no longer exists",
      "这个群还没有 Bot；添加 Bot 后即可读取它的工作区 Skill。": "This group has no Bots yet; add a Bot to read Skills from its workspace.",
      "这个群要讨论什么": "What should this group discuss?",
      "这里是 Bot 的回复内容。": "This is the Bot's reply.",
      "这是你与 Bot 的一对一会话。每条消息都会直接发给它，不需要 @；它的记忆与群聊相互独立。": "This is your one-on-one conversation with the Bot. Every message goes directly to it without @; its memory is separate from group chats.",
      "这条消息没有可复制的文本": "This message has no text to copy",
      "这条原消息在更早的历史里，请先加载更早的消息": "The original message is in earlier history; load earlier messages first.",
      "正在加载 Skill…": "Loading Skills…",
      "正在输入": "Typing",
      "支持 Markdown · 留空则只使用默认角色设定": "Markdown supported · leave blank to use only the default role prompt",
      "执行中": "Running",
      "只读附件": "Read-only attachment",
      "只维护一个文件：先写「你是谁」，再写「你怎么做事」。建议保留「人格」「工作规范」两个小节标题，模型更容易遵循；也可以从模板库选一个人设快速起步。": "Maintain a single file: first describe “who you are”, then “how you work”. Keep the “Persona” and “Working guidelines” headings so the model follows them more reliably; you can also start quickly with a template.",
      "指令": "Commands",
      "中断": "Interrupt",
      "中断当前会话进行中的回复": "Interrupt the in-progress reply in this conversation",
      "重命名分组": "Rename folder",
      "重试": "Retry",
      "重试这条回复": "Retry this reply",
      "重新读取 Skill 列表": "Reload Skill list",
      "重置": "Reset",
      "总结": "Summary",
      "最近一次模型请求的输出 Token / 秒": "Output tokens per second for the latest model request",
      "最近一次上报的输出用量（非累计）": "Last reported output usage (not cumulative)",
      "最近一次上报的输入用量（非累计）": "Last reported input usage (not cumulative)",
      "昨天": "Yesterday",
      "Bot 管理": "Bot management",
      "Bot 管理（全局）": "Bot management (global)",
      "Bot 库": "Bot library",
      "统一管理 Bot，在单聊与群聊中随时协作。": "Manage your Bots for direct chats and group collaboration.",
      "全部 Bot": "All Bots",
      "共 {count} 个 Bot": "{count} Bots in total",
      "所属群聊": "Groups",
      "未加入群聊": "No groups yet",
      "单聊与各群聊的会话和记忆相互独立。": "Each direct chat and group has its own conversation and memory.",
      "还没有 Bot": "No Bots yet",
      "创建你的第一个 Bot，开始单聊或邀请它加入群聊。": "Create your first Bot to start a direct chat or invite it to a group.",
      "创建第一个 Bot": "Create your first Bot",
      "删除 Bot：{name}": "Delete Bot: {name}",
      "Bot 库里的 Bot 都已在群里。先关闭此窗口，用「新建 Bot」创建一个。": "All Bots in the library are already in this group. Close this window and use “New Bot” to create one.",
      "Bot 是全局可复用的 Agent：每个 Bot 自动拥有一个单聊，也可以加入多个群，每个群内有独立会话与记忆。这里管理全局 Bot 库。": "Bots are globally reusable agents: each Bot automatically gets a direct chat and can join multiple groups, with an independent conversation and memory in each group. Manage the global Bot library here.",
      "Bot Team 设置": "Bot Team settings",
      "BOT.md 人格": "BOT.md persona",
      "Enter 发送 · Shift + Enter 换行 · @ 提及成员 · / 选择 Skill": "Enter to send · Shift + Enter for a new line · @ to mention members · / to select a Skill",
      "Enter 发送 · Shift + Enter 换行 · / 选择 Skill": "Enter to send · Shift + Enter for a new line · / to select a Skill",
      "Host 仍是旧版本：重启 DSH（或重新启用 Bot Team）后，单聊与分组才会生效。": "The Host is still on an old version: restart DSH (or re-enable Bot Team) for direct chats and folders to take effect.",
      "Host 未返回附件引用": "Host did not return an attachment reference",
      "文件夹": "Folder",
      "引入项目，Bot 可在目录中检索和处理任务": "Add a project so Bots can search and work in its folder",
      "任务结束后可切换项目文件夹": "Wait for active tasks to finish before switching projects",
      "当前项目": "Current project",
      "切换项目文件夹": "Switch project folder",
      "更换": "Change",
      "移除项目，恢复默认工作目录": "Remove project and restore the default working directory",
      "引入文件夹 / 项目": "Add folder / project",
      "Bot 将在这个文件夹中检索文件，并按你的任务读取、修改和运行项目。": "Bots will search this folder and read, edit, and run the project as your task requires.",
      "项目文件夹": "Project folder",
      "项目文件夹路径": "Project folder path",
      "选择或填写运行 DSH 的电脑上的文件夹绝对路径。": "Choose a folder or enter its absolute path on the computer running DSH.",
      "选择文件夹…": "Choose folder…",
      "正在选择…": "Choosing…",
      "引入项目": "Add project",
      "正在引入…": "Adding project…",
      "引入后对当前聊天持续生效。可在输入框更换或移除项目；移除会恢复默认工作目录，项目文件保留。": "This project stays active for this chat. Change or remove it in the composer; removing restores the default working directory and keeps your project files.",
      "目录选择器不可用，请填写文件夹的绝对路径。": "The folder picker is unavailable. Enter the absolute folder path.",
      "无法打开目录选择器，请填写路径：{error}": "Cannot open the folder picker. Enter a path: {error}",
      "Host 未返回项目工作目录": "The Host did not return the project working directory",
      "正在切换项目目录，请稍后重试": "The project folder is changing. Try again shortly.",
      "当前聊天有运行、排队或准备中的任务或讨论，请结束后再切换项目目录": "This chat has tasks or a discussion running, queued, or starting. Finish them before switching project folders.",
      "workspaceCwd 必须是有效的目录路径": "Enter a valid folder path.",
      "workspaceCwd 必须是绝对路径（可使用 ~/）": "Enter an absolute folder path (~/ is supported).",
      "项目目录不能为空": "The project folder cannot be empty.",
      "无法准备默认工作目录": "Cannot prepare the default working directory.",
      "无法引入项目目录：目录不存在": "Cannot add project: the folder does not exist.",
      "无法引入项目目录：目录不可访问": "Cannot add project: the folder is not accessible.",
      "无法引入项目目录：请选择文件夹，而不是文件": "Cannot add project: select a folder, not a file.",
      "Skill 加载失败：": "Failed to load Skills: ",
      "本单聊累计 Token": "Direct chat token usage",
      "通用助手": "General assistant",
      "推荐": "Recommended",
      "先结论后理由；信息不足先说明假设。": "Conclusion first, then reasoning; state assumptions when information is insufficient.",
      "代码实现工程师": "Software engineer",
      "小步改动、先读代码；给出完整代码与自测结果。": "Make small, focused changes; read the code first; provide complete code and self-test results.",
      "代码评审员": "Code reviewer",
      "按阻塞/风险/建议分级，每条给出最小修复方式。": "Grade issues as blocking / risk / suggestion, with the minimal fix for each.",
      "需求分析师": "Requirements analyst",
      "目标、范围、验收标准；一次最多问 3 个关键问题。": "Goals, scope, acceptance criteria; ask at most 3 key questions at a time.",
      "技术调研员": "Technical researcher",
      "结论先行；关键事实带来源，区分已验证与推测。": "Conclusion first; cite sources for key facts and separate verified from speculative.",
      "测试工程师": "Test engineer",
      "覆盖正常/边界/异常；缺陷附最小复现步骤。": "Cover normal, boundary, and error paths; include minimal reproduction steps for defects.",
      "文档写作者": "Documentation writer",
      "按读者组织结构；示例可直接运行。": "Structure for the reader; examples should run as-is.",
      "批判质疑者": "Devil's advocate",
      "先假设方案失败，逐条给出验证与补救。": "Assume the proposal will fail, then give validation and remediation for each risk.",
      "数据分析师": "Data analyst",
      "先定口径；区分相关与因果，说明不确定性。": "Define metrics first; separate correlation from causation and state uncertainty.",
      "第 {round} 轮": "Round {round}",
      "第 {current}/{total} 轮": "Round {current}/{total}",
      "{count} 个回复中": "{count} replying",
      "{count} 个 Bot 正在回复 · 停止": "{count} bots replying · Stop",
      "给 {title} 发消息…": "Send {title} a message…",
      "回复 {name}": "Reply to {name}",
      "{count} 个文件": "{count} files",
      "每条消息最多添加 {count} 个文件": "Up to {count} files per message",
      "「{name}」超过 32 MB，已跳过": "“{name}” exceeds 32 MB and was skipped",
      "文件「{name}」上传失败：{error}": "Failed to upload “{name}”: {error}",
      "已跳过空文件「{name}」": "Skipped empty file “{name}”",
      "{count} 条新消息": "{count} new messages",
      "成员 ({count})": "Members ({count})",
      "{count} 位成员 · {bots} 个 Bot": "{count} members · {bots} bots",
      "{count} 个运行中": "{count} running",
      "{count} 人": "{count} member(s)",
      "{count} 个可选": "{count} available",
      "{count} 字": "{count} chars",
      "{count} 轮": "{count} rounds",
      "{name} 操作": "{name} actions",
      "{name} 单聊操作": "{name} direct chat actions",
      "{name}（单聊）": "{name} (direct chat)",
      "{name} 发言中": "{name} speaking",
      "{title}（回复中）": "{title} (replying)",
      "和 {title} 打个招呼吧": "Say hello to {title}",
      "已有 {count} 个 Bot。每个 Bot 都有自己的单聊；也可以在群里加入它们。": "You already have {count} bots. Each Bot has its own direct chat; you can also add them to groups.",
      "删除 Bot「{name}」？它会从所有群移除，单聊与单聊消息也会一并删除。": "Delete Bot “{name}”? It will be removed from all groups, and its direct chat and messages will be deleted too.",
      "它正在 {count} 个群中（{groups}），删除会同时把它移出这些群。": "It is in {count} groups ({groups}); deleting it will also remove it from them.",
      "删除群「{title}」及其全部消息？": "Delete group “{title}” and all its messages?",
      "删除分组「{title}」？": "Delete folder “{title}”?",
      "删除分组「{title}」？其中 {count} 个群会移到「未分组」，不会被删除。": "Delete folder “{title}”? Its {count} groups will move to “Ungrouped”; they won't be deleted.",
      "从全局 Bot 库删除「{name}」？": "Delete “{name}” from the global Bot library?",
      "添加成员到「{title}」": "Add members to “{title}”",
      "编辑 Bot：{name}": "Edit Bot: {name}",
      "已插入「{title}」模板，可按需修改。": "Inserted the “{title}” template; edit it as needed.",
      "输入 {input} · 输出 {output} · 合计 {total}": "Input {input} · Output {output} · Total {total}",
      "最近一次模型请求平均速度：输出 {tokens} Token / {seconds} 秒。包含等待与思考，不含工具执行；非纯解码速度。": "Average speed of the latest model request: {tokens} output tokens / {seconds} s. Includes waiting and thinking, excludes tool execution; not pure decode speed.",
      "最近一次上报的输出 Token（非本轮累计）：{count}": "Last reported output tokens (not this turn's total): {count}",
      "最近一次上报的输入 Token（非本轮累计）：{count}": "Last reported input tokens (not this turn's total): {count}",
      "模型：{provider}{model}": "Model: {provider}{model}",
      "错误：{error}": "Error: {error}",
      "保存失败：{error}": "Save failed: {error}",
      "读取 BOT.md 失败：{error}": "Failed to read BOT.md: {error}",
      "群头像读取失败：{error}": "Failed to read group avatar: {error}",
      "头像读取失败：{error}": "Failed to read avatar: {error}",
      "Skill 加载失败：{error}": "Failed to load Skills: {error}",
      "请求失败 (HTTP {status})": "Request failed (HTTP {status})",
      "无法连接 Host：{error}": "Cannot connect to Host: {error}",
      "收起分组 {title}": "Collapse folder {title}",
      "展开分组 {title}": "Expand folder {title}",
      "收起{label}": "Collapse {label}",
      "展开{label}": "Expand {label}",
      "评审 #{seq}": "Review #{seq}",
      "被评审消息 #{seq}": "Reviewed message #{seq}",
      "任务 · {title} · {status}": "Task · {title} · {status}",
      "{count} 个群": "{count} groups",
      "{name}：": "{name}: ",
      "{count} 位成员": "{count} members",
      " · {count} 个 Bot": " · {count} bots",
      "{error}（点击关闭）": "{error} (click to close)",
      "附件": "Attachment",
      "成员：": "Members:",
      "导出时间：": "Exported:",
      "消息数：": "Messages:",
      "（单聊）": " (direct chat)",
      "导出 PDF": "Export PDF",
      "将当前会话导出为 PDF": "Export this conversation as PDF",
      "正在生成 PDF…": "Generating PDF…",
      "PDF 导出失败": "PDF export failed",
      "- 成员：": "- Members: ",
      "- 导出时间：": "- Exported: ",
      "- 消息数：": "- Messages: ",
      "添加文件或执行指令": "Add file or command",
      "移除文件 {name}": "Remove file {name}",
      "例如（也可点「插入模板」选一套）：": "e.g. (or click “Insert template” to pick one):",
      "分组 {title} 操作": "Folder {title} actions",
      "讨论「{topic}」总结失败/中断，已结束。": "Discussion “{topic}” summary failed/interrupted; ended.",
      "讨论「{topic}」因成员执行失败而停止。": "Discussion “{topic}” stopped because a member failed.",
      "讨论「{topic}」已停止：{message}": "Discussion “{topic}” stopped: {message}",
      "讨论「{topic}」已停止。": "Discussion “{topic}” stopped.",
      "讨论「{topic}」结束。": "Discussion “{topic}” ended.",
      "开始讨论：{topic}（{count} 位成员，共 {rounds} 轮{suffix}）": "Started discussion: {topic} ({count} members, {rounds} rounds{suffix})",
      "，结束生成总结": ", summary at the end",
      "请 @{reviewer} 评审 #{seq}（{author}）的消息": "Ask @{reviewer} to review message #{seq} ({author})",
      "请 @{bot} 根据 #{reviewSeq} 的评审意见修改 #{targetSeq}": "Ask @{bot} to revise #{targetSeq} based on the review at #{reviewSeq}",
      "任务「{title}」已验收，前置依赖解除：{names} 可以派发了。": "Task “{title}” accepted; dependencies cleared: {names} can now be dispatched.",
      "{name} 请求权限：工具 {tool}{reason}。": "{name} requests permission: tool {tool}{reason}.",
      "（{reason}）": " ({reason})",
      "1 轮": "1 round",
      "1 位成员": "1 member",
      "1 个 Bot": "1 bot",
      "1 人": "1 member",
      "1 个 Bot 正在回复 · 停止": "1 bot replying · Stop",
      "单条新消息": " new message",
      "{count} 个 Bot": "{count} bots"
    };
    // Execution copy stays additive so integrating the complete locale dictionary
    // preserves any existing translations for shared labels.
    for (const [key, value] of Object.entries({
      "执行过程": "Execution details",
      "查看这条回复的执行过程": "View this reply's execution details",
      "关闭执行过程": "Close execution details",
      "执行过程接口尚未加载。请完全退出并重新启动 DSH，再打开此面板；仅刷新页面无法加载后端更新。": "The execution details endpoint is not loaded. Fully quit and restart DSH, then reopen this panel. Refreshing the page alone cannot load backend updates.",
      "触发输入": "Trigger input",
      "执行开始": "Execution started",
      "执行结束": "Execution ended",
      "模型开始处理": "Model processing started",
      "模型处理结束": "Model processing ended",
      "中间文本": "Intermediate text",
      "未完成的模型输出": "Unfinished model output",
      "等待审批": "Awaiting approval",
      "审批决定": "Approval decision",
      "重试": "Retry",
      "上下文整理": "Context compaction",
      "其他记录 · {type}": "Other record · {type}",
      "输入原文": "Full input",
      "文本原文": "Full text",
      "附件记录": "Attachment records",
      "记录详情": "Record details",
      "执行记录与所选消息不匹配": "The execution records do not match the selected message",
      "执行记录分页未前进，请重试": "Execution pagination did not advance. Please retry.",
      "已复制完整内容": "Copied full contents",
      "复制失败：{error}": "Copy failed: {error}",
      "复制完整内容": "Copy full contents",
      "内部工具 · {tool}": "Nested tool · {tool}",
      "工具 · {tool}": "Tool · {tool}",
      "工具": "Tool",
      "失败": "Failed",
      "完成": "Completed",
      "等待结果": "Awaiting result",
      "调用参数": "Call arguments",
      "工具结果": "Tool result",
      "工具结果 · {time}": "Tool result · {time}",
      "错误详情": "Error details",
      "会话记录服务暂不可用，请稍后重试。": "The session records service is unavailable. Please retry later.",
      "原始会话记录已不存在。": "The original session records no longer exist.",
      "原始会话记录损坏，暂时无法读取。": "The original session records are damaged and cannot be read.",
      "暂时无法读取原始会话记录，请稍后重试。": "The original session records cannot be read right now. Please retry later.",
      "这条消息尚未记录对应会话。": "A session has not yet been recorded for this message.",
      "没有找到这条消息的执行轮次。": "The execution turn for this message was not found.",
      "执行记录不完整，以下仅显示仍可读取的部分。": "Some execution records are missing. Only the available records are shown below.",
      "这条历史消息没有关联执行记录。": "This older message has no linked execution records.",
      "无法确认这条消息对应的执行范围。": "The execution boundaries for this message could not be verified.",
      "请稍后刷新记录重试。": "Please refresh the records and try again later.",
      "等待执行": "Waiting to run",
      "执行中": "Running",
      "已完成": "Completed",
      "已停止": "Stopped",
      "状态未知": "Unknown status",
      "{bot} · 消息 #{message}": "{bot} · Message #{message}",
      "加载失败：": "Loading failed: ",
      "正在加载后续记录…": "Loading more records…",
      "正在加载执行过程…": "Loading execution details…",
      "执行记录正在准备，稍后会自动更新。": "Execution records are being prepared and will update automatically.",
      "这条历史消息没有关联执行记录，无法定位当时的执行过程。": "This older message has no linked execution records, so its original execution cannot be located.",
      "执行记录不可用。": "Execution records are unavailable. ",
      "尚无可显示的执行记录。": "There are no execution records to display yet.",
      "按时间排序的执行记录": "Execution records in chronological order",
      "刷新记录": "Refresh records",
      "打开完整会话": "Open full session",
      "完整会话": "Full session",
      "返回执行过程": "Back to execution details",
      "返回聊天": "Back to chat",
      "全部轮次 · 只读历史": "All turns · Read-only history",
      "关闭完整会话": "Close full session",
      "{bot} · 全部历史": "{bot} · Full history",
      "会话历史与所选会话不匹配": "The history does not match the selected session",
      "正在加载会话历史…": "Loading session history…",
      "会话历史不可用。": "Session history is unavailable. ",
      "尚无可显示的会话记录。": "There are no session records to display yet.",
      "按时间排序的会话记录": "Session records in chronological order",
      "完整会话接口尚未加载。请完全退出并重新启动 DSH，再打开此面板。": "The full session endpoint is not loaded. Fully quit and restart DSH, then reopen this panel.",
      "查看成员当前会话": "View member's current session",
      "打开原生会话": "Open native session",
      "打开后，可从侧栏的 Bot Team 返回。": "Return through Bot Team in the sidebar after opening.",
      "查看日志": "View logs",
      "完整日志": "Full logs",
      "查看成员当前日志": "View member's current logs",
      "结构化执行": "Structured execution",
      "原始事件": "Raw events",
      "日志视图": "Log view",
      "事件类型": "Event type",
      "全部类型": "All types",
      "筛选原始事件": "Filter raw events",
      "搜索完整 JSON": "Search full JSON",
      "显示 {count} / {total} 条事件": "Showing {count} of {total} events",
      "没有匹配的原始事件。": "No raw events match the filters.",
      "序号 {seq} · 轮次 {turn} · 步骤 {step}": "Sequence {seq} · Turn {turn} · Step {step}",
      "完整 JSON": "Full JSON",
      "思考正文": "Reasoning text",
      "内容块 · {type}": "Content block · {type}",
      "导出原始日志": "Export raw logs",
      "正在导出…": "Exporting…",
      "原始日志导出接口尚未加载，请完全退出并重新启动 DSH。": "The raw log export endpoint is not loaded. Fully quit and restart DSH.",
      "此旧版子会话无法在原生会话中打开，请查看只读日志。": "This legacy subagent session cannot open as a native session. View its read-only logs.",
      "尚无法确认此会话可在原生会话中打开，请刷新日志后重试。": "Native navigation is not yet available for this session. Refresh the logs and retry.",
      "原生会话导航暂不可用，请重新启动 DSH。": "Native session navigation is unavailable. Please restart DSH.",
      "原始事件记录": "Raw event records"
    })) {
      if (!(key in UI_EN)) UI_EN[key] = value;
    }
    Object.assign(UI_EN, {
      "Bot 提问": "Bot question",
      "待处理交互": "Pending interactions",
      "刷新交互": "Refresh interactions",
      "提交答案": "Submit answers",
      "允许一次": "Allow once",
      "填写答案或补充说明": "Enter an answer or additional details",
      "补充答案：{question}": "Additional answer: {question}",
      "跳过此问题": "Skip this question",
      "未选择或填写的问题会记为跳过。": "Questions with no selection or text will be recorded as skipped.",
      "稍后回答，继续执行": "Answer later and continue",
      "取消提问": "Cancel question",
      "Bot 已继续执行，你仍可提交答案。": "The bot has continued working. You can still submit an answer.",
      "答案已提交，等待 Bot 接收。": "Answer submitted; waiting for the bot to receive it.",
      "正在继续执行，请稍候。": "Continuing; please wait.",
      "请在本聊天顶部的待处理交互中回应；此卡片保留审批记录。": "Respond in the pending interactions at the top of this chat. This card keeps the approval record.",
      "这是后台 Bot 的只读日志。继续对话、回答问题和审批请返回 Bot Team。": "This is the background bot’s read-only log. Return to Bot Team to continue chatting, answer questions, or respond to approvals.",
      "请提交每个问题的答案。": "Submit an answer for every question.",
      "问题或答案格式不正确。": "Invalid question or answer format.",
      "答案包含无效或重复的选项。": "The answer contains invalid or duplicate options.",
      "此问题只能选择一个选项。": "Choose only one option for this question.",
      "补充答案格式不正确。": "Invalid additional answer format.",
      "此交互已失效或不属于当前会话。": "This interaction has expired or belongs to a different session.",
      "此答案正在处理，请稍后刷新。": "This answer is being processed. Please refresh shortly.",
      "此交互不能稍后回答。": "This interaction cannot be answered later.",
      "此问题已继续执行，请提交答案或跳过。": "The bot has continued. Submit an answer or skip the question.",
      "审批决定无效。": "Invalid approval decision.",
      "此问题已失效，请刷新。": "This question has expired. Please refresh.",
      "未知的交互操作。": "Unknown interaction action."
    });
    Object.assign(UI_EN, {
      "侧边栏设置": "Sidebar settings",
      "控制侧边栏的显示内容；保存后在当前浏览器生效。": "Choose what appears in the sidebar. Saved preferences apply in this browser.",
      "显示单聊": "Show direct chats",
      "默认开启，在侧边栏显示单聊列表与图标。": "Enabled by default. Show direct chat lists and icons in the sidebar.",
      "开启": "On",
      "设置已保存": "Settings saved"
    });

    const UI_ZH = { ...Object.fromEntries(Object.keys(UI_EN).map((key) => [key, key])), '单条新消息': '条新消息' };

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

    // Direct-chat visibility follows the same per-browser scope as sidebar collapse.
    const SIDEBAR_SHOW_DIRECT_KEY = 'bot-team.sidebar.showDirect';

    function readSidebarShowDirect() {
      try {
        const storage = typeof window !== 'undefined' ? window.localStorage : null;
        return !storage || storage.getItem(SIDEBAR_SHOW_DIRECT_KEY) !== '0';
      } catch {
        return true;
      }
    }

    function persistSidebarShowDirect(showDirect) {
      try {
        const storage = typeof window !== 'undefined' ? window.localStorage : null;
        if (storage) storage.setItem(SIDEBAR_SHOW_DIRECT_KEY, showDirect ? '1' : '0');
      } catch {
        /* storage can be unavailable; visibility still works this session */
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
      sidebarShowDirect: readSidebarShowDirect(),
      rightPanelCollapsed: readRightPanelCollapsed(),
      sectionsCollapsed: readSectionsCollapsed(),
      pendingDirectBotId: null,
      activeGroupId: null,
      messagesByGroup: {},
      deletedMessageIdsByGroup: {},
      interactionsByGroup: {},
      statusByMember: {},
      dialog: null,
      smoke: null,
      refreshTick: 0,
      messagesTick: 0,
      discussions: {},
      hasMoreByGroup: {},
      conversationsByGroup: {},
      conversationHasMoreByGroup: {},
      conversationConflicts: {},
      sessionBindingRefreshes: {},
      capabilities: {},
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

    function isDeletedMessage(state, groupId, messageId) {
      return state.deletedMessageIdsByGroup?.[groupId]?.[messageId] === true;
    }

    function shouldShowWelcome(state) {
      return !state.loading && state.bots.length === 0 && state.groups.length === 0;
    }

    function reducer(state, action) {
      if (action.type === 'bootstrap') {
        const previousGroups = state.groups;
        state = { ...state, groups: (action.data.groups || []).map(group => {
          const previous = previousGroups.find(item => item.groupId === group.groupId);
          if (!previous?.conversationVersion) return group;
          return { ...group, activeConversationId: previous.activeConversationId, currentConversationId: currentConversationId(previous), conversationVersion: previous.conversationVersion,
            currentConversation: previous.currentConversation, canStartConversation: previous.canStartConversation, conversationBlockers: previous.conversationBlockers, conversationStateConflict: previous.conversationStateConflict };
        }) };
        for (const group of action.data.groups || []) state = mergeConversationState(state, group.groupId, group, true);
        action = { ...action, data: { ...action.data, groups: state.groups } };
      } else if (action.type === 'messages' || action.type === 'prependMessages' || action.type === 'conversations') {
        state = mergeConversationState(state, action.groupId, action.data || action);
      } else if (action.type === 'sse') {
        const frame = action.frame;
        const data = frame.group || frame;
        state = mergeConversationState(state, data.groupId || state.activeGroupId, data);
        state = refreshConversationSessionBinding(state, frame);
      }
      switch (action.type) {
        case 'conversationState':
          return mergeConversationState(state, action.groupId, action.data);
        case 'conversations':
          return { ...state, conversationHasMoreByGroup: { ...state.conversationHasMoreByGroup, [action.groupId]: action.hasMore === true } };
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
            capabilities: data.capabilities || {},
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
        case 'showWelcome':
          if (!shouldShowWelcome(state)) return state;
          return { ...state, activeGroupId: null, dialog: null, pendingDirectBotId: null };
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
        case 'messageDeleted': {
          const { groupId, messageId } = action;
          if (!groupId || !messageId || isDeletedMessage(state, groupId, messageId)) return state;
          const remaining = (state.messagesByGroup[groupId] || []).filter(message => message.messageId !== messageId);
          return {
            ...state,
            // Remember removals for this page's lifetime: an older GET or SSE
            // snapshot must not put a deleted message back into the timeline.
            deletedMessageIdsByGroup: {
              ...state.deletedMessageIdsByGroup,
              [groupId]: { ...state.deletedMessageIdsByGroup?.[groupId], [messageId]: true },
            },
            messagesByGroup: {
              ...state.messagesByGroup,
              [groupId]: remaining,
            },
            // If this was the last loaded message, fetch the older history so
            // pagination still has a first message to use as its cursor.
            messagesTick: state.messagesTick + (groupId === state.activeGroupId && !remaining.length && state.hasMoreByGroup[groupId] ? 1 : 0),
            dialog: state.dialog?.target?.messageId === messageId ? null : state.dialog,
            refreshTick: state.refreshTick + 1,
          };
        }
        case 'messages': {
          const groupId = action.groupId;
          const fetched = action.messages || [];
          const fetchedIds = new Set(fetched.map(message => message.messageId));
          const firstSeq = fetched[0]?.seq ?? Infinity;
          // A reconnect can miss deletion events. Only infer removals for records
          // observed before this GET and inside its returned history window.
          const missing = (action.knownMessages || []).filter(message =>
            !fetchedIds.has(message.messageId) && !isDeletedMessage(state, groupId, message.messageId) &&
            (action.hasMore !== true || message.seq >= firstSeq));
          const deleted = { ...state.deletedMessageIdsByGroup?.[groupId] };
          for (const message of missing) deleted[message.messageId] = true;
          let messages = fetched.filter(message => !deleted[message.messageId]);
          if (action.knownMessages) {
            const knownIds = new Set(action.knownMessages.map(message => message.messageId));
            // Keep messages that arrived via SSE after the GET began.
            for (const message of state.messagesByGroup[groupId] || []) {
              if (!knownIds.has(message.messageId) && !fetchedIds.has(message.messageId) && !deleted[message.messageId]) {
                messages = upsertMessage(messages, message);
              }
            }
          }
          return {
            ...state,
            messagesByGroup: { ...state.messagesByGroup, [groupId]: messages },
            hasMoreByGroup: { ...state.hasMoreByGroup, [groupId]: action.hasMore === true },
            deletedMessageIdsByGroup: missing.length ? { ...state.deletedMessageIdsByGroup, [groupId]: deleted } : state.deletedMessageIdsByGroup,
            dialog: missing.some(message => message.messageId === state.dialog?.target?.messageId) ? null : state.dialog,
            refreshTick: state.refreshTick + (missing.length ? 1 : 0),
          };
        }
        case 'prependMessages': {
          const current = state.messagesByGroup[action.groupId] || [];
          const seen = new Set(current.map((message) => message.messageId));
          const merged = [...(action.messages || []).filter((message) => !seen.has(message.messageId) && !isDeletedMessage(state, action.groupId, message.messageId)), ...current];
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
        case 'sidebarShowDirect':
          return { ...state, sidebarShowDirect: action.showDirect !== false };
        case 'chatDisplaySettings':
          return { ...state, chatDisplaySettings: normalizeChatDisplaySettings(action.settings) };
        case 'interactions': {
          const data = action.data;
          if (!data?.groupId || !Array.isArray(data.interactions)) return state;
          const previous = state.interactionsByGroup?.[data.groupId];
          if (action.startedEpoch !== undefined && previous && previous.epoch !== action.startedEpoch && previous.epoch !== data.epoch) return state;
          if (previous?.epoch === data.epoch && previous.revision > data.revision) return state;
          return { ...state, interactionsByGroup: { ...state.interactionsByGroup, [data.groupId]: data } };
        }
        case 'sse': {
          const frame = action.frame;
          if (frame.type === 'message.deleted') return reducer(state, { type: 'messageDeleted', groupId: frame.groupId, messageId: frame.messageId });
          if (frame.type === 'interaction.updated') return reducer(state, { type: 'interactions', data: frame });
          if ((frame.type === 'settings.updated' || frame.type === 'hello') && frame.chatDisplaySettings) {
            state = reducer(state, { type: 'chatDisplaySettings', settings: frame.chatDisplaySettings });
          }
          const active = state.activeGroupId;
          if (frame.type === 'message.added' || frame.type === 'message.updated') {
            if (frame.message.groupId !== active || isDeletedMessage(state, active, frame.message.messageId)) return state;
            const settledBot = frame.message.author?.type === 'bot' && ['done', 'error', 'stopped'].includes(frame.message.status);
            return {
              ...state,
              // Group totals cover the entire history, including unloaded pages.
              // Reload the authoritative aggregate rather than adding SSE samples.
              refreshTick: state.refreshTick + (settledBot ? 1 : 0),
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
              refreshTick: state.refreshTick + (!['running', 'queued'].includes(frame.status) && ['running', 'queued'].includes(state.statusByMember[frame.membershipId]) ? 1 : 0),
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
                group.groupId === frame.group.groupId ? { ...group, ...frame.group,
                  activeConversationId: group.activeConversationId, currentConversationId: group.currentConversationId,
                  conversationVersion: group.conversationVersion, currentConversation: group.currentConversation,
                  canStartConversation: group.canStartConversation, conversationBlockers: group.conversationBlockers,
                } : group,
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

    // ── visual refresh: cohesive tokens (v0.5.5) ──────────────────────────
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
        width: 232,
        background: 'var(--bt-home-sidebar, var(--bt-bg-soft))',
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
        gridTemplateColumns: 'minmax(0, 1fr)',
        gap: 4,
        padding: '12px 16px 16px',
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
      usageHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 },
      usageLabel: { margin: 0, fontSize: 11.5, fontWeight: 500, color: 'var(--bt-text-3)' },
      usageRunning: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: 'var(--bt-text-2)', whiteSpace: 'nowrap' },
      usageTotal: { margin: '5px 0 9px', fontSize: 24, fontWeight: 600, lineHeight: 1.25, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums', color: 'var(--bt-text-strong)', overflowWrap: 'anywhere' },
      usageBreakdown: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 12, margin: 0, paddingTop: 9, borderTop: '1px solid var(--bt-border)' },
      usageMetric: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: '2px 6px', minWidth: 0 },
      usageValue: { margin: 0, fontSize: 12, fontWeight: 500, fontVariantNumeric: 'tabular-nums', color: 'var(--bt-text-2)', overflowWrap: 'anywhere' },
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
      botAvatarRow: { display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', alignItems: 'center', columnGap: 14, rowGap: 8, marginBottom: 12 },
      botAvatarControls: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
      botAvatarOptions: { display: 'flex', flexWrap: 'wrap', gap: 6, minWidth: 0 },
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
      formGrid: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12 },
      sectionHeader: { display: 'flex', alignItems: 'center', gap: 8, margin: '2px 0 10px' },
      sectionTitle: { fontSize: 13, fontWeight: 600, color: 'var(--bt-text-strong)' },
      sectionMeta: { fontSize: 11.5, color: 'var(--bt-text-3)' },
      toolChips: { display: 'flex', gap: 6, paddingTop: 1, whiteSpace: 'nowrap', overflowX: 'auto' },
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
      fieldRow: { display: 'grid', gridTemplateColumns: '112px minmax(0, 1fr)', columnGap: 12, rowGap: 5, alignItems: 'center' },
      fieldRowLabel: { marginBottom: 0, whiteSpace: 'nowrap' },
      fieldRowContent: { minWidth: 0 },
      fieldRowHint: { gridColumn: 2, marginTop: 0 },
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

    // Native selects keep keyboard/picker behavior, with consistent arrow spacing.
    S.select = {
      ...S.input,
      appearance: 'none',
      WebkitAppearance: 'none',
      minWidth: 0,
      paddingRight: 40,
      backgroundImage: 'var(--bt-select-arrow)',
      backgroundRepeat: 'no-repeat',
      backgroundPosition: 'right 12px center',
      backgroundSize: '16px 16px',
      textOverflow: 'ellipsis',
      cursor: 'pointer',
    };

    // ── v0.6 group-chat feed ──────────────────────────────────────────────
    Object.assign(S, {
      left: { ...S.left, width: 232 },
      leftHeader: { ...S.leftHeader, padding: '26px 24px 28px' },
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

    Object.assign(S, {
      addButton: {
        width: 30,
        height: 30,
        padding: 0,
        borderRadius: 999,
        border: '1px solid var(--bt-border)',
        background: 'var(--bt-surface)',
        color: 'var(--bt-text-2)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        flex: '0 0 auto',
      },
      addMenu: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 'calc(100% + 6px)',
        zIndex: 43,
        maxHeight: 400,
        overflowY: 'auto',
        padding: 4,
        borderRadius: 14,
        border: '1px solid var(--bt-border)',
        background: 'var(--bt-surface)',
        boxShadow: '0 18px 48px rgba(16,24,40,0.20)',
        boxSizing: 'border-box',
      },
      addMenuGroup: {
        padding: '5px 8px 2px',
        marginTop: 3,
        fontSize: 11,
        fontWeight: 500,
        lineHeight: '16px',
        color: 'var(--bt-text-3)',
      },
      addMenuItem: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: '100%',
        minHeight: 34,
        padding: '6px 8px',
        border: 0,
        borderRadius: 8,
        background: 'transparent',
        color: 'var(--bt-text)',
        fontSize: 13,
        lineHeight: '20px',
        textAlign: 'left',
        cursor: 'pointer',
        boxSizing: 'border-box',
      },
      addMenuIcon: {
        width: 14,
        height: 14,
        flex: '0 0 14px',
        color: 'var(--bt-text-3)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      },
      addMenuName: {
        flex: '0 1 auto',
        maxWidth: '40%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        color: 'var(--bt-text)',
      },
      addMenuAlias: {
        flex: '0 1 auto',
        maxWidth: '20%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        color: 'var(--bt-text-3)',
        fontSize: 12,
        lineHeight: '18px',
      },
      addMenuDesc: {
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        textAlign: 'right',
        color: 'var(--bt-text-3)',
        fontSize: 12,
        lineHeight: '18px',
      },
      skillPicker: { ...S.picker, width: 480, maxWidth: 'calc(100vw - 48px)', maxHeight: 320 },
      skillOptionBody: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
      skillOptionName: { fontSize: 12.5, color: 'var(--bt-text)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      skillOptionDesc: { fontSize: 10.5, color: 'var(--bt-text-3)', lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      skillIcon: { color: 'var(--bt-text-3)', flex: '0 0 auto' },
      skillEmpty: { padding: '16px 12px', fontSize: 11.5, color: 'var(--bt-text-3)', lineHeight: 1.6 },
      skillRefresh: {
        padding: 0,
        border: 0,
        background: 'transparent',
        color: 'var(--bt-accent)',
        fontSize: 10.5,
        cursor: 'pointer',
      },
      skillRetry: {
        marginTop: 8,
        height: 26,
        padding: '0 10px',
        borderRadius: 6,
        border: '1px solid var(--bt-border-strong)',
        background: 'var(--bt-surface)',
        color: 'var(--bt-text-2)',
        fontSize: 11,
        cursor: 'pointer',
      },
      draftAttachments: { display: 'flex', flexWrap: 'wrap', gap: 6, padding: '10px 12px 0' },
      draftAttachment: (status) => ({
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        maxWidth: 280,
        minWidth: 0,
        padding: '4px 5px 4px 7px',
        borderRadius: 8,
        border: '1px solid ' + (status === 'error' ? 'var(--bt-danger-border)' : 'var(--bt-border)'),
        background: status === 'error' ? 'var(--bt-danger-bg)' : 'var(--bt-bg-subtle)',
        opacity: status === 'uploading' ? 0.72 : 1,
      }),
      draftAttachmentBody: { flex: 1, minWidth: 0 },
      draftAttachmentName: { display: 'block', fontSize: 11, fontWeight: 500, color: 'var(--bt-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      draftAttachmentMeta: { display: 'block', fontSize: 9.5, color: 'var(--bt-text-3)', marginTop: 1 },
      draftAttachmentRemove: {
        width: 18,
        height: 18,
        padding: 0,
        border: 0,
        borderRadius: 5,
        background: 'transparent',
        color: 'var(--bt-text-3)',
        fontSize: 14,
        lineHeight: 1,
        cursor: 'pointer',
        flex: '0 0 auto',
      },
      messageAttachments: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 7 },
      messageAttachment: (mine) => ({
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        maxWidth: 340,
        minWidth: 0,
        padding: '6px 8px',
        borderRadius: 8,
        border: '1px solid ' + (mine ? 'rgba(255,255,255,0.26)' : 'var(--bt-border)'),
        background: mine ? 'rgba(255,255,255,0.14)' : 'var(--bt-bg-subtle)',
        boxSizing: 'border-box',
      }),
      messageAttachmentBody: { flex: 1, minWidth: 0 },
      messageAttachmentName: { display: 'block', fontSize: 11.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      messageAttachmentMeta: { display: 'block', fontSize: 10, opacity: 0.72, marginTop: 1 },
    });

    // ── v0.6.5 collapsible group sidebar ─────────────────────────────────
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
        width: 32,
        height: 32,
        padding: 0,
        border: 0,
        borderRadius: 8,
        background: 'transparent',
        color: 'var(--bt-text-3)',
        cursor: 'pointer',
        flex: '0 0 auto',
      },
      sidebarToggleIcon: { display: 'block', flex: '0 0 18px', width: 18, height: 18 },
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
        justifyItems: 'center',
      },
      railAction: {
        ...S.sidebarAction,
        justifyContent: 'center',
        width: 38,
        height: 38,
        minWidth: 38,
        padding: 0,
        margin: 0,
      },
      railActionIcon: { display: 'block', flex: '0 0 18px', width: 18, height: 18 },

      // v0.7 single chats + custom group sections.
      sidebarScroll: {
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        overflowX: 'hidden',
        padding: '0 16px 8px',
      },
      section: { marginTop: 12 },
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
      sectionActions: { display: 'flex', alignItems: 'center', gap: 4, flex: '0 0 auto' },
      sectionAction: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
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

      // v0.7 settings dialog: left module nav + message settings / about.
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
        border: '1px solid var(--bt-border-strong)',
        borderRadius: 14,
        background: 'var(--bt-bg-subtle)',
        padding: '14px 16px',
        marginBottom: 12,
      },
      aboutDescription: { fontSize: 12.5, lineHeight: 1.8, color: 'var(--bt-text-2)' },
      aboutFeatures: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 },
    });

    const WELCOME_CSS = `
/* First-use workspace, sized to the plugin pane rather than the browser. */
.bt-root { --bt-home-sidebar:#f7f8fa; --bt-home-bg:#fbfcff; --bt-home-card:#fff; --bt-home-primary:#eff4ff; --bt-home-border:#dce3ef; --bt-home-primary-border:#b8cbef; --bt-home-blue:#4168c4; --bt-home-button:#496fda; --bt-home-button-text:#fff; --bt-home-mint:#307d6a; --bt-home-sand:#906b38; }
body[data-ds-dark-theme] .bt-root { --bt-home-sidebar:#15171c; --bt-home-bg:#101216; --bt-home-card:#191c23; --bt-home-primary:#1d273a; --bt-home-border:#303541; --bt-home-primary-border:#506dac87; --bt-home-blue:#aac1ff; --bt-home-button:#7899fb; --bt-home-button-text:#111c37; --bt-home-mint:#90cbb8; --bt-home-sand:#cab28f; }
.bt-page { position:relative; min-width:0; container:bot-team / inline-size; }
.bt-main-panel { container:bot-main / inline-size; }
.bt-sidebar { flex-shrink:0; }
.bt-welcome-icon { display:block; flex-shrink:0; pointer-events:none; }
.bt-welcome-nav { display:flex; align-items:center; gap:11px; flex-shrink:0; margin:0 16px 8px; padding:12px 13px; border:1px solid transparent; border-radius:9px; background:transparent; color:var(--bt-text-2); font:inherit; font-size:13px; font-weight:550; text-align:left; cursor:pointer; }
.bt-welcome-nav[data-active=true] { color:var(--bt-home-blue); border-color:var(--bt-accent-border); background:var(--bt-accent-soft); }
.bt-welcome-nav:hover { background:var(--bt-hover); }
.bt-welcome-nav .bt-welcome-icon { width:18px; height:18px; }
.bt-welcome-nav .bt-welcome-nav-arrow { margin-left:auto; width:13px; height:13px; }
.bt-sidebar[data-collapsed=true] .bt-welcome-nav { justify-content:center; margin:0 auto 12px; width:46px; height:42px; padding:0; }
.bt-welcome-screen { flex:1; min-height:0; overflow:auto; background:radial-gradient(ellipse at 65% 0%,#7899fb06,transparent 53%),var(--bt-home-bg); }
.bt-welcome-screen *, .bt-welcome-nav { box-sizing:border-box; }
.bt-welcome-topbar { height:70px; display:flex; align-items:center; justify-content:space-between; gap:16px; padding:0 38px; border-bottom:1px solid var(--bt-border); }
.bt-welcome-breadcrumb { display:flex; align-items:center; gap:12px; color:var(--bt-text-2); font-size:12px; }
.bt-welcome-muted { color:var(--bt-text-3); }
.bt-welcome-guide { display:flex; align-items:center; gap:7px; color:var(--bt-text-3); padding:9px 0 9px 10px; border:0; background:none; font:inherit; font-size:12px; cursor:pointer; white-space:nowrap; }
.bt-welcome-guide:hover { color:var(--bt-text); }
.bt-welcome-guide .bt-welcome-icon { width:16px; height:16px; }
.bt-welcome-guide .bt-welcome-icon:last-child { width:12px; height:12px; }
.bt-welcome-mobile-menu, .bt-welcome-scrim { display:none; }
.bt-welcome-content { max-width:1080px; margin:0 auto; padding:62px 40px 34px; }
.bt-welcome-hero { display:flex; align-items:center; justify-content:space-between; gap:24px; min-height:176px; margin-bottom:37px; }
.bt-welcome-eyebrow { display:flex; align-items:center; gap:9px; color:var(--bt-text-2); font-size:12px; letter-spacing:.4px; margin:0 0 17px; }
.bt-welcome-eyebrow::before { content:''; width:6px; height:6px; flex-shrink:0; border-radius:50%; background:var(--bt-home-mint); box-shadow:0 0 0 4px #8bcbb60c; }
.bt-welcome-hero h1 { margin:0; color:var(--bt-text-strong); font-size:38px; letter-spacing:-1.4px; line-height:1.4; font-weight:620; }
.bt-welcome-description { font-size:14px; line-height:1.9; color:var(--bt-text-3); margin:14px 0 0; }
.bt-welcome-art { position:relative; width:270px; height:170px; flex-shrink:0; background-image:radial-gradient(#67728c25 1px,transparent 1px); background-size:17px 17px; mask-image:linear-gradient(90deg,transparent,black 14%,black 86%,transparent); }
.bt-welcome-connectors { position:absolute; inset:0; width:100%; height:100%; stroke:var(--bt-accent-border); stroke-width:1.1; }
.bt-welcome-tile { position:absolute; border-radius:13px; width:50px; height:50px; display:grid; place-items:center; border:1px solid var(--bt-home-border); box-shadow:0 10px 22px #0002; }
.bt-welcome-tile .bt-welcome-icon { width:25px; height:25px; }
.bt-welcome-tile.main-bot { left:104px; top:37px; width:69px; height:69px; background:linear-gradient(145deg,#779cff,#4768d6); border-color:#afc4ff77; color:#f5f8ff; border-radius:17px; transform:rotate(-7deg); }
.bt-welcome-tile.main-bot .bt-welcome-icon { width:37px; height:37px; }
.bt-welcome-tile.research { left:29px; top:91px; color:var(--bt-home-mint); background:color-mix(in srgb,var(--bt-home-mint) 15%,var(--bt-home-bg)); transform:rotate(-13deg); }
.bt-welcome-tile.review { left:208px; top:91px; color:var(--bt-home-sand); background:color-mix(in srgb,var(--bt-home-sand) 15%,var(--bt-home-bg)); transform:rotate(12deg); }
.bt-welcome-spark { position:absolute; left:55px; top:33px; color:var(--bt-text-3); font-size:16px; }
.bt-welcome-spark.second { left:221px; font-size:10px; }
.bt-welcome-art-caption { position:absolute; left:91px; bottom:8px; color:var(--bt-text-3); font-size:9px; letter-spacing:1.3px; }
.bt-welcome-actions { display:grid; grid-template-columns:1.08fr 1fr; gap:18px; }
.bt-welcome-card { display:flex; flex-direction:column; min-width:0; min-height:268px; padding:26px; border:1px solid var(--bt-home-border); border-radius:16px; background:var(--bt-home-card); }
.bt-welcome-card.primary { border-color:var(--bt-home-primary-border); background:radial-gradient(ellipse at 95% 5%,#4d70c510,transparent 60%),linear-gradient(120deg,var(--bt-home-primary),var(--bt-home-card)); }
.bt-welcome-card-top { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:19px; }
.bt-welcome-symbol { width:43px; height:43px; display:grid; place-items:center; border-radius:12px; background:var(--bt-accent-soft); color:var(--bt-home-blue); border:1px solid var(--bt-accent-border); }
.bt-welcome-symbol .bt-welcome-icon { width:24px; height:24px; }
.bt-welcome-symbol.group { background:var(--bt-hover); color:var(--bt-text-2); border-color:var(--bt-border); }
.bt-welcome-recommended { color:var(--bt-home-blue); font-size:10px; padding:5px 9px; border:1px solid var(--bt-accent-border); border-radius:5px; letter-spacing:.2px; }
.bt-welcome-card h2 { color:var(--bt-text-strong); font-size:20px; letter-spacing:-.5px; font-weight:600; margin:0 0 10px; line-height:1.5; }
.bt-welcome-card p { font-size:12px; line-height:1.95; margin:0 0 25px; color:var(--bt-text-3); }
.bt-welcome-card-bottom { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-top:auto; }
.bt-welcome-button { min-height:39px; padding:9px 15px; border-radius:7px; display:inline-flex; align-items:center; justify-content:center; gap:15px; font:inherit; font-size:12px; font-weight:550; cursor:pointer; }
.bt-welcome-button .bt-welcome-icon { width:16px; height:16px; }
.bt-welcome-primary { background:var(--bt-home-button); color:var(--bt-home-button-text); border:1px solid #adc2ff42; box-shadow:0 3px 12px #060e2914; }
.bt-welcome-secondary { background:var(--bt-hover); border:1px solid var(--bt-border-strong); color:var(--bt-text-2); }
.bt-welcome-card-caption { font-size:10px; color:var(--bt-text-3); display:flex; align-items:center; gap:5px; }
.bt-welcome-card-caption .bt-welcome-icon { width:12px; height:12px; }
.bt-welcome-example-section { margin-top:36px; }
.bt-welcome-section-heading { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:15px; }
.bt-welcome-section-heading h3 { font-size:13px; font-weight:500; color:var(--bt-text-2); margin:0; }
.bt-welcome-example-label { font-size:10px; color:var(--bt-text-3); display:flex; align-items:center; gap:5px; flex-shrink:0; }
.bt-welcome-example-label .bt-welcome-icon { width:13px; height:13px; }
.bt-welcome-example { border:1px solid var(--bt-border); border-radius:13px; overflow:hidden; background:var(--bt-home-card); }
.bt-welcome-prompt { display:flex; align-items:center; gap:12px; padding:18px 21px; border-bottom:1px solid var(--bt-border); }
.bt-welcome-prompt-icon { width:25px; height:25px; flex-shrink:0; display:grid; place-items:center; border-radius:7px; background:var(--bt-hover); color:var(--bt-text-2); }
.bt-welcome-prompt-icon .bt-welcome-icon { width:15px; height:15px; }
.bt-welcome-prompt-text { font-size:12px; color:var(--bt-text-2); line-height:1.8; }
.bt-welcome-prompt-text strong { font-weight:500; color:var(--bt-home-blue); margin-right:6px; }
.bt-welcome-prompt-context { margin-left:auto; color:var(--bt-text-3); display:flex; gap:5px; align-items:center; font-size:10px; white-space:nowrap; }
.bt-welcome-prompt-context .bt-welcome-icon { height:12px; width:12px; }
.bt-welcome-workflow { list-style:none; margin:0; display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:28px; padding:25px 24px; }
.bt-welcome-role { position:relative; display:flex; align-items:center; gap:11px; min-width:0; }
.bt-welcome-role:not(:last-child)::after { content:''; position:absolute; right:-13px; top:17px; width:5px; height:5px; border-top:1px solid var(--bt-text-3); border-right:1px solid var(--bt-text-3); transform:rotate(45deg); }
.bt-welcome-avatar { width:37px; height:37px; flex-shrink:0; display:grid; place-items:center; border:1px solid var(--bt-home-border); border-radius:10px; color:var(--bt-home-mint); background:color-mix(in srgb,var(--bt-home-mint) 10%,var(--bt-home-card)); }
.bt-welcome-avatar .bt-welcome-icon { width:19px; height:19px; }
.bt-welcome-avatar.blue { color:var(--bt-home-blue); background:var(--bt-accent-soft); }
.bt-welcome-avatar.sand { color:var(--bt-home-sand); background:color-mix(in srgb,var(--bt-home-sand) 10%,var(--bt-home-card)); }
.bt-welcome-role-name { font-size:12px; font-weight:550; margin-bottom:6px; color:var(--bt-text-2); }
.bt-welcome-role-copy { font-size:10px; color:var(--bt-text-3); line-height:1.7; }
.bt-welcome-example-bottom { display:flex; align-items:flex-start; gap:6px; padding:0 24px 19px; color:var(--bt-text-3); font-size:10px; line-height:1.8; }
.bt-welcome-example-bottom .bt-welcome-icon { height:12px; width:12px; margin-top:3px; }
.bt-welcome-note { display:flex; align-items:center; justify-content:center; gap:7px; color:var(--bt-text-3); font-size:11px; margin:29px 0 0; line-height:1.8; text-align:center; }
.bt-welcome-note .bt-welcome-icon { height:14px; width:14px; }
.bt-welcome-footer { display:flex; align-items:center; justify-content:center; gap:7px; margin-top:37px; font-size:9px; color:var(--bt-text-3); letter-spacing:.7px; }
.bt-welcome-steps { list-style:none; padding:0; margin:0; display:grid; gap:24px; }
.bt-welcome-steps li { display:flex; align-items:flex-start; gap:15px; }
.bt-welcome-step-number { display:grid; place-items:center; width:26px; height:26px; flex-shrink:0; border-radius:50%; background:var(--bt-accent-soft); color:var(--bt-accent); font-size:11px; }
.bt-welcome-steps h3 { font-size:13px; margin:2px 0 6px; font-weight:550; }
.bt-welcome-steps p { font-size:12px; line-height:1.8; color:var(--bt-text-2); margin:0; }
@container bot-main (max-width:1000px) {
  .bt-welcome-content { padding:48px 28px 32px; }
  .bt-welcome-hero h1 { font-size:32px; }
  .bt-welcome-description { font-size:12px; }
  .bt-welcome-art { transform:scale(.85); transform-origin:right center; margin-left:-35px; }
  .bt-welcome-card { padding:22px; }
}
@container bot-main (max-width:800px) {
  .bt-welcome-art { display:none; }
  .bt-welcome-content { padding-top:38px; }
  .bt-welcome-role { flex-direction:column; align-items:flex-start; gap:9px; }
  .bt-welcome-role:not(:last-child)::after { top:32px; }
  .bt-welcome-prompt-context { display:none; }
}
@container bot-main (max-width:600px) {
  .bt-welcome-topbar { height:61px; padding:0 20px; gap:10px; }
  .bt-welcome-breadcrumb { gap:9px; }
  .bt-welcome-content { padding:32px 20px; }
  .bt-welcome-hero { min-height:150px; margin-bottom:25px; }
  .bt-welcome-hero h1 { font-size:28px; letter-spacing:-.8px; }
  .bt-welcome-actions { grid-template-columns:minmax(0,1fr); gap:14px; }
  .bt-welcome-card { min-height:245px; }
  .bt-welcome-card-top { margin-bottom:16px; }
  .bt-welcome-example-section { margin-top:29px; }
  .bt-welcome-section-heading h3 { font-size:12px; }
  .bt-welcome-workflow { gap:17px; padding:23px 19px; }
  .bt-welcome-role:not(:last-child)::after { right:-8px; }
  .bt-welcome-avatar { width:32px; height:32px; }
  .bt-welcome-role-name { font-size:11px; }
  .bt-welcome-prompt { padding:16px; gap:9px; align-items:flex-start; }
  .bt-welcome-prompt-text { font-size:11px; }
  .bt-welcome-example-bottom { padding:0 19px 18px; }
  .bt-welcome-note { font-size:10px; margin-top:24px; }
}
@container bot-team (max-width:760px) {
  .bt-page[data-home=true] > .bt-sidebar { display:none !important; }
  .bt-page[data-home=true][data-mobile-sidebar=true] > .bt-sidebar { display:flex !important; position:absolute; z-index:21; inset:0 auto 0 0; max-width:calc(100% - 48px); box-shadow:12px 0 35px #0003; }
  .bt-page[data-home=true] .bt-welcome-mobile-menu { display:grid; place-items:center; padding:0; width:28px; height:32px; background:none; border:0; color:var(--bt-text-2); cursor:pointer; }
  .bt-page[data-home=true] > .bt-welcome-scrim { display:block; position:absolute; inset:0; z-index:20; border:0; background:#04070e99; backdrop-filter:blur(4px); }
}
@media (prefers-reduced-motion:reduce) { .bt-welcome-screen *, .bt-welcome-nav, .bt-sidebar { transition:none !important; } }
`;

    const GLOBAL_CSS = `
${WELCOME_CSS}
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
  --bt-select-arrow: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%220%200%2016%2016%22%3E%3Cpath%20d%3D%22m4%206%204%204%204-4%22%20fill%3D%22none%22%20stroke%3D%22%234b5563%22%20stroke-width%3D%221.5%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3C%2Fsvg%3E");
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
  --bt-select-arrow: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%220%200%2016%2016%22%3E%3Cpath%20d%3D%22m4%206%204%204%204-4%22%20fill%3D%22none%22%20stroke%3D%22%23b6bdc9%22%20stroke-width%3D%221.5%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3C%2Fsvg%3E");
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

/* Execution drawer overlays this page without unmounting its conversation. */
.bt-session-page { height: 100%; min-height: 0; min-width: 0; width: 100%; display: flex; flex-direction: column; color: var(--bt-text); background: var(--bt-surface); }
.bt-session-header { flex: none; display: flex; align-items: center; flex-wrap: wrap; gap: 14px; padding: 20px 28px; border-bottom: 1px solid var(--bt-border); }
.bt-session-heading { flex: 1; min-width: 160px; }
.bt-session-heading h1 { margin: 0 0 6px; font-size: 22px; color: var(--bt-text-strong); }
.bt-session-source { display: flex; flex-wrap: wrap; gap: 6px 12px; font-size: 12px; color: var(--bt-text-2); overflow-wrap: anywhere; }
.bt-session-body { flex: 1; min-height: 0; overflow: auto; padding: 28px; }
.bt-session-content { max-width: 1080px; margin: 0 auto; font-size: 13px; line-height: 1.7; }
.bt-log-modes, .bt-raw-filters { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 18px; }
.bt-log-modes button[aria-pressed="true"] { color: var(--bt-accent) !important; background: var(--bt-accent-soft) !important; }
.bt-raw-filters label { flex: 1 1 240px; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.bt-raw-filters input, .bt-raw-filters select { box-sizing: border-box; width: 100%; min-width: 0; }
.bt-raw-json, .bt-execution-text { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; max-height: 480px; overflow: auto; margin: 10px 0; }
.bt-raw-json { padding: 12px; border-radius: 6px; border: 1px solid var(--bt-border); background: var(--bt-hover); }
.bt-execution-block { margin-top: 10px; overflow-wrap: anywhere; }
.bt-execution-block p { color: var(--bt-text-2); }
.bt-session-export { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.bt-session-page button:focus-visible, .bt-execution-drawer button:focus-visible, .bt-raw-json:focus-visible, .bt-execution-text:focus-visible, .bt-raw-filters input:focus-visible, .bt-raw-filters select:focus-visible { outline: 2px solid var(--bt-accent); outline-offset: 2px; }
@media (max-width: 700px) { .bt-session-header, .bt-session-body { padding: 16px; } .bt-session-heading h1 { font-size: 19px; } }
.bt-execution-layer { position: absolute; inset: 0; z-index: 70; display: flex; justify-content: flex-end; background: rgba(16,24,40,.24); }
.bt-execution-drawer { width: min(580px, 100%); height: 100%; min-width: 0; display: flex; flex-direction: column; background: var(--bt-surface); color: var(--bt-text); border-left: 1px solid var(--bt-border); box-shadow: -8px 0 28px rgba(0,0,0,.16); }
.bt-execution-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding: 18px 20px; border-bottom: 1px solid var(--bt-border); font-size: 12px; line-height: 1.6; }
.bt-execution-header h2 { margin: 0 0 4px; font-size: 17px; color: var(--bt-text-strong); }
.bt-execution-source { color: var(--bt-text-2); overflow-wrap: anywhere; }
.bt-execution-body { flex: 1; min-height: 0; overflow: auto; padding: 16px 20px; font-size: 12px; line-height: 1.6; }
.bt-execution-footer { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--bt-border); }
.bt-execution-events, .bt-execution-children { list-style: none; padding: 0; margin: 0; }
.bt-execution-event { border-left: 2px solid var(--bt-border); margin: 0 0 16px 3px; padding-left: 12px; min-width: 0; }
.bt-execution-event-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px 10px; margin-bottom: 7px; color: var(--bt-text-2); }
.bt-execution-event-head strong { color: var(--bt-text-strong); overflow-wrap: anywhere; }
.bt-execution-event-head time { margin-left: auto; font-size: 11px; color: var(--bt-text-3); }
.bt-execution-children { margin-top: 12px; }
.bt-execution-payload { background: var(--bt-hover); border: 1px solid var(--bt-border); border-radius: 6px; margin-top: 6px; padding: 6px 8px; min-width: 0; }
.bt-execution-payload summary { cursor: pointer; overflow-wrap: anywhere; }
.bt-execution-payload summary:focus-visible { outline: 2px solid var(--bt-accent); outline-offset: 2px; }
.bt-execution-preview { display: block; color: var(--bt-text-3); white-space: pre-wrap; max-height: 3.2em; overflow: hidden; margin-top: 3px; }
.bt-execution-payload[open] .bt-execution-preview { display: none; }
.bt-execution-payload button { margin: 7px 6px 0 0; }
.bt-execution-payload pre { margin: 10px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 420px; overflow: auto; font-size: 11px; }
.bt-execution-failed { color: var(--bt-danger-text); overflow-wrap: anywhere; }
@media (max-width: 700px) { .bt-execution-drawer { width: 100%; border-left: 0; } .bt-execution-body, .bt-execution-header, .bt-execution-footer { padding: 12px; } }
.bt-modal { animation: bt-modal-in .16s ease-out; }
@keyframes bt-modal-in { from { opacity: 0; transform: translateY(8px) scale(.985); } to { opacity: 1; transform: none; } }
.bt-modal-close:hover { background: var(--bt-hover) !important; color: var(--bt-text-2) !important; }
.bt-persona-textarea::placeholder { color: var(--bt-text-3); }

/* The global Bot library keeps identity, model and memberships easy to scan. */
.bt-bot-library { box-sizing: border-box; }
.bt-bot-library .bt-modal-header { align-items: center !important; padding: 24px !important; gap: 14px !important; }
.bt-bot-library .bt-modal-icon { display: grid; place-items: center; flex: 0 0 46px; width: 46px; height: 46px; border: 1px solid var(--bt-accent-border); border-radius: 14px; color: var(--bt-accent); background: var(--bt-accent-soft); }
.bt-bot-library .bt-modal-icon svg { width: 25px; height: 25px; }
.bt-bot-library .bt-modal-title { font-size: 20px !important; letter-spacing: -.025em !important; }
.bt-bot-library .bt-modal-subtitle { color: var(--bt-text-2) !important; font-size: 12px !important; margin-top: 6px !important; }
.bt-bot-library .bt-modal-body { padding: 20px 24px 24px !important; background: var(--bt-bg-soft); }
.bt-bot-library .bt-modal-footer { padding: 16px 24px !important; background: var(--bt-surface) !important; gap: 18px !important; }
.bt-library-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 14px; }
.bt-library-count { display: flex; align-items: center; gap: 8px; margin: 0; color: var(--bt-text-2); font-size: 12px; font-weight: 600; }
.bt-library-count span { display: inline-grid; place-items: center; min-width: 22px; height: 22px; padding: 0 5px; box-sizing: border-box; border: 1px solid var(--bt-border-strong); border-radius: 7px; background: var(--bt-surface); color: var(--bt-text); font-size: 11px; font-variant-numeric: tabular-nums; }
.bt-library-create { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 36px; white-space: nowrap; }
.bt-library-create svg { width: 16px; height: 16px; }
.bt-library-list { display: grid; gap: 12px; margin: 0; padding: 0; list-style: none; }
.bt-library-card { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 14px; min-width: 0; padding: 14px 16px; border: 1px solid var(--bt-border-strong); border-radius: 14px; background: var(--bt-surface); box-shadow: 0 2px 4px rgba(0,0,0,.025); transition: border-color .16s ease, box-shadow .16s ease; }
.bt-library-card:hover, .bt-library-card:focus-within { border-color: var(--bt-accent-border); box-shadow: 0 3px 12px rgba(0,0,0,.05); }
.bt-library-card-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.bt-library-identity { flex: 1; min-width: 0; }
.bt-library-heading { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
.bt-library-name { flex: 0 1 auto; max-width: 40%; margin: 0; font-size: 14px; font-weight: 650; line-height: 1.4; color: var(--bt-text-strong); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bt-library-runtime { flex: 0 1 auto; min-width: 0; font-size: 11px; line-height: 1.5; color: var(--bt-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bt-library-actions { display: flex; align-items: center; flex: none; gap: 5px; }
.bt-library-action { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-width: 34px; height: 34px; padding: 0 10px; border: 1px solid var(--bt-border-strong); border-radius: 8px; background: var(--bt-surface); color: var(--bt-text-2); cursor: pointer; font: inherit; font-size: 12px; white-space: nowrap; }
.bt-library-action svg { width: 16px; height: 16px; flex: none; }
.bt-library-action:hover:not(:disabled) { background: var(--bt-hover); border-color: var(--bt-accent-border); color: var(--bt-text-strong); }
.bt-library-delete { padding: 0; border-color: transparent; background: transparent; color: var(--bt-text-3); }
.bt-library-delete:hover:not(:disabled), .bt-library-delete:focus-visible { color: var(--bt-danger-text); border-color: var(--bt-danger-border); background: var(--bt-danger-bg); }
.bt-library-details { min-width: 0; margin: 7px 0 0; }
.bt-library-detail { min-width: 0; }
.bt-library-detail dt { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.bt-library-detail dd { margin: 0; min-width: 0; min-height: 26px; display: flex; align-items: center; gap: 5px; }
.bt-library-groups { position: relative; }
.bt-library-group-measure { position: absolute; inset: 0; display: flex; align-items: center; gap: inherit; overflow: hidden; visibility: hidden; pointer-events: none; }
.bt-library-group { display: inline-flex; align-items: center; flex: none; gap: 5px; min-width: 0; max-width: 150px; box-sizing: border-box; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--bt-accent-border); background: var(--bt-accent-soft); color: var(--bt-accent); font-size: 11px; line-height: 1.5; }
.bt-library-group-more { flex: none; cursor: help; }
.bt-library-group-more:focus-visible { outline: 2px solid var(--bt-accent); outline-offset: 2px; }
.bt-library-group svg { width: 13px; height: 13px; flex: none; }
.bt-library-group span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bt-library-ungrouped { padding: 4px 0; color: var(--bt-text-3); font-size: 11px; line-height: 1.5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bt-library-note { display: flex; align-items: center; gap: 7px; flex: 1; color: var(--bt-text-3); font-size: 11px; line-height: 1.6; }
.bt-library-note svg { width: 15px; height: 15px; flex: none; }
.bt-library-close { flex: none; min-height: 34px; }
.bt-library-empty { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 36px 22px; border: 1px dashed var(--bt-border-strong); border-radius: 14px; background: var(--bt-surface); }
.bt-library-empty-icon { display: grid; place-items: center; width: 64px; height: 64px; margin-bottom: 18px; border-radius: 20px; background: var(--bt-accent-soft); color: var(--bt-accent); }
.bt-library-empty-icon svg { width: 32px; height: 32px; }
.bt-library-empty h3 { margin: 0; color: var(--bt-text-strong); font-size: 16px; font-weight: 600; }
.bt-library-empty p { max-width: 300px; margin: 8px 0 22px; color: var(--bt-text-2); font-size: 12px; line-height: 1.7; }
@media (max-width: 560px) {
  .bt-bot-library .bt-modal-header { padding: 18px 16px !important; gap: 10px !important; }
  .bt-bot-library .bt-modal-icon { flex-basis: 38px; width: 38px; height: 38px; border-radius: 11px; }
  .bt-bot-library .bt-modal-title { font-size: 17px !important; }
  .bt-bot-library .bt-modal-body { padding: 16px !important; }
  .bt-bot-library .bt-modal-footer { padding: 14px 16px !important; gap: 12px !important; }
  .bt-library-card { padding: 14px; gap: 10px; }
  .bt-library-card-head { grid-column: 1 / -1; gap: 9px; }
  .bt-library-heading { flex-direction: column; align-items: flex-start; gap: 2px; }
  .bt-library-name, .bt-library-runtime { max-width: 100%; }
  .bt-library-actions { grid-column: 2; gap: 2px; }
  .bt-library-action { padding: 0 7px; }
  .bt-library-delete { padding: 0; }
}
@media (max-width: 380px) {
  .bt-bot-library .bt-modal-icon { display: none; }
}
@media (prefers-reduced-motion: reduce) { .bt-bot-library { animation: none; } .bt-library-card { transition: none; } }


/* Quiet, evenly sized sidebar actions; SVGs never participate in text baselines. */
.bt-root .bt-sidebar-action:hover { background: var(--bt-hover) !important; color: var(--bt-text-strong) !important; filter: none; }
.bt-root .bt-sidebar-action:active { background: var(--bt-accent-soft) !important; color: var(--bt-accent) !important; filter: none; }
.bt-root .bt-sidebar-action svg { pointer-events: none; }

/* v0.6.5 collapsible group sidebar: icons-only rail, tooltips carry the labels. */
.bt-root .bt-sidebar { transition: width 180ms ease; }
.bt-root .bt-sidebar-toggle:hover { background: var(--bt-hover) !important; color: var(--bt-text-strong) !important; filter: none; }
.bt-root .bt-sidebar-toggle:active { background: var(--bt-accent-soft) !important; color: var(--bt-accent) !important; filter: none; }
.bt-root .bt-sidebar-toggle svg { pointer-events: none; }
.bt-root .bt-group-item:focus-visible { outline: 2px solid var(--bt-accent); outline-offset: 2px; }
.bt-root .bt-group-rail { scrollbar-width: none; -ms-overflow-style: none; }
.bt-root .bt-group-rail::-webkit-scrollbar { width: 0; height: 0; display: none; }

/* v0.7 direct chats + custom sections: quiet headers, hover affordances, drop targets. */
.bt-root .bt-section-toggle:hover, .bt-root .bt-folder-toggle:hover { background: var(--bt-hover) !important; filter: none; color: var(--bt-text-2) !important; }
.bt-root .bt-section-action:hover, .bt-root .bt-folder-menu:hover { background: var(--bt-hover) !important; color: var(--bt-text-2) !important; filter: none; }
.bt-root .bt-section-toggle:focus-visible, .bt-root .bt-folder-toggle:focus-visible,
.bt-root .bt-section-action:focus-visible, .bt-root .bt-folder-menu:focus-visible { outline: 2px solid var(--bt-accent); outline-offset: 1px; }
.bt-root .bt-folder-menu { opacity: 0; }
.bt-root .bt-folder-head:hover .bt-folder-menu,
.bt-root .bt-folder-head:focus-within .bt-folder-menu { opacity: 1; }
.bt-root .bt-folder-head > .bt-folder-toggle { cursor: pointer; }
.bt-root .bt-folder-head[data-drop="true"] { background: var(--bt-accent-soft); box-shadow: inset 0 0 0 1px var(--bt-accent-border); }
.bt-root .bt-group-item { position: relative; }
.bt-root .bt-group-item[data-drop="before"] { box-shadow: inset 0 2px 0 var(--bt-accent) !important; }
.bt-root .bt-group-item[data-drop="after"] { box-shadow: inset 0 -2px 0 var(--bt-accent) !important; }
.bt-root .bt-group-item[data-dragging="true"] { opacity: .45; }
.bt-root .bt-rail-divider { opacity: .8; }
.bt-root .bt-direct-caption { white-space: nowrap; }
.bt-root .bt-sidebar-menu .bt-msg-menu-item { height: 30px; }

/* About uses the same compact cards and value badges as the Bot library. */
.bt-about-information { display: grid; gap: 12px; }
.bt-about-info-card { min-width: 0; margin: 0; padding: 8px 16px; border: 1px solid var(--bt-border-strong); border-radius: 14px; background: var(--bt-surface); box-shadow: 0 2px 4px rgba(0,0,0,.025); }
.bt-about-info-row { display: grid; grid-template-columns: 96px minmax(0, 1fr); align-items: center; gap: 14px; min-width: 0; padding: 5px 0; }
.bt-about-info-label { margin: 0; color: var(--bt-text-3); font-size: 11.5px; line-height: 1.6; }
.bt-about-info-value { display: flex; align-items: center; min-width: 0; min-height: 24px; margin: 0; color: var(--bt-text-2); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.bt-about-value-chip { display: inline-block; max-width: 100%; box-sizing: border-box; padding: 3px 8px; border: 1px solid var(--bt-border); border-radius: 6px; background: var(--bt-bg-subtle); color: var(--bt-text-2); font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
.bt-about-version { background: var(--bt-accent-soft); border-color: var(--bt-accent-border); color: var(--bt-accent); font-weight: 600; }
.bt-about-link { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; color: var(--bt-accent); text-decoration: none; border-radius: 4px; }
.bt-about-link span { min-width: 0; overflow-wrap: anywhere; }
.bt-about-link svg { flex: none; width: 14px; height: 14px; margin: 3px; transform: rotate(-45deg); }
.bt-about-link:hover { text-decoration: underline; text-underline-offset: 3px; }
.bt-about-link:focus-visible { outline: 2px solid var(--bt-accent); outline-offset: 4px; }
@media (max-width: 560px) {
  .bt-about-info-card { padding: 8px 12px; }
  .bt-about-info-row { grid-template-columns: 80px minmax(0, 1fr); gap: 10px; }
}
@media (max-width: 380px) {
  .bt-about-info-row { grid-template-columns: minmax(0, 1fr); gap: 5px; padding: 8px 0; }
}

/* v0.7 settings dialog: quiet module nav, responsive one-column fallback. */
.bt-root .bt-settings-nav-item:hover { background: var(--bt-hover) !important; color: var(--bt-text-strong) !important; filter: none; }
.bt-root .bt-settings-nav-item:focus-visible { outline: 2px solid var(--bt-accent); outline-offset: 1px; }
@media (max-width: 700px) {
  .bt-root .bt-settings-shell { flex-direction: column; gap: 14px !important; min-height: 0 !important; }
  .bt-root .bt-settings-nav {
    width: auto !important;
    flex: 0 0 auto !important;
    flex-direction: row !important;
    overflow-x: auto;
    padding: 0 0 10px !important;
    border-right: 0 !important;
    border-bottom: 1px solid var(--bt-border);
  }
  .bt-root .bt-settings-nav-item { width: auto !important; flex: 0 0 auto; }
}

/* v0.6 group feed */
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
.bt-root .bt-message-column { container: bt-timeline / inline-size; }
.bt-root .bt-conversation-divider { display:flex; align-items:center; gap:16px; min-height:36px; margin:20px 0; }
.bt-root .bt-conversation-divider::before,
.bt-root .bt-conversation-divider::after { content:""; height:1px; background:var(--bt-border-strong); flex:1; min-width:12px; }
.bt-root .bt-conversation-meta { display:flex; flex:0 1 auto; flex-wrap:wrap; align-items:center; justify-content:center; gap:4px 10px; min-width:0; max-width:calc(100% - 56px); min-height:36px; }
.bt-root .bt-conversation-identity { display:flex; flex:none; align-items:center; gap:8px; white-space:nowrap; }
.bt-root .bt-conversation-identity strong { font-size:13px; font-weight:600; color:var(--bt-text-2); }
.bt-root .bt-conversation-divider[data-current=true] strong { color:var(--bt-text-strong); }
.bt-root .bt-conversation-current { padding:0 6px; border-radius:5px; background:var(--bt-accent-soft); color:var(--bt-accent); font-size:10px; line-height:19px; font-weight:500; }
.bt-root .bt-conversation-date { position:relative; display:flex; align-items:center; gap:10px; min-width:0; color:var(--bt-text-2); }
.bt-root .bt-conversation-dot { color:var(--bt-text-3); font-size:10px; }
.bt-root .bt-conversation-range { display:inline-flex; align-items:center; justify-content:center; flex-wrap:wrap; gap:4px; min-width:0; font-size:12px; line-height:20px; font-variant-numeric:tabular-nums; border-radius:3px; }
.bt-root .bt-conversation-range time { white-space:nowrap; }
.bt-root .bt-conversation-range:focus-visible { outline:2px solid var(--bt-accent); outline-offset:4px; }
.bt-root .bt-conversation-tooltip { position:absolute; top:calc(100% + 8px); left:50%; transform:translateX(-50%); z-index:12; width:max-content; max-width:min(340px, 80cqi); padding:7px 10px; border:1px solid var(--bt-border-strong); border-radius:6px; background:var(--bt-surface); color:var(--bt-text); box-shadow:0 4px 12px #0002; font-size:11px; line-height:1.8; white-space:pre-line; display:none; pointer-events:none; }
.bt-root .bt-conversation-date:not([data-dismissed=true]):hover .bt-conversation-tooltip,
.bt-root .bt-conversation-date:not([data-dismissed=true]):focus-within .bt-conversation-tooltip { display:block; }
.bt-root .bt-conversation-logs { position:relative; display:inline-flex; flex:none; align-items:center; justify-content:center; gap:5px; min-height:32px; margin-left:6px; padding:0 7px; border:0; border-radius:6px; background:transparent; color:var(--bt-text-2); font:inherit; font-size:12px; white-space:nowrap; cursor:pointer; }
.bt-root .bt-conversation-logs::before { content:""; position:absolute; left:-6px; width:1px; height:12px; background:var(--bt-border-strong); }
.bt-root .bt-conversation-logs:hover { background:var(--bt-hover); color:var(--bt-accent); }
.bt-root .bt-conversation-logs svg { flex:none; }
@container bt-timeline (max-width:560px) {
  .bt-root .bt-conversation-divider { gap:8px; margin:16px 0; }
  .bt-root .bt-conversation-meta { display:grid; grid-template-columns:auto auto; gap:0 10px; max-width:calc(100% - 40px); }
  .bt-root .bt-conversation-identity { justify-content:center; }
  .bt-root .bt-conversation-identity strong { font-size:12px; }
  .bt-root .bt-conversation-date { grid-row:2; grid-column:1 / -1; justify-content:center; padding:4px 0; }
  .bt-root .bt-conversation-dot { display:none; }
  .bt-root .bt-conversation-logs { grid-row:1; grid-column:2; min-height:36px; }
  .bt-root .bt-conversation-meta[data-logs=false] { grid-template-columns:1fr; }
}
@container bt-timeline (max-width:340px) {
  .bt-root .bt-conversation-divider { gap:4px; }
  .bt-root .bt-conversation-divider::before,
  .bt-root .bt-conversation-divider::after { min-width:6px; }
  .bt-root .bt-conversation-meta { max-width:calc(100% - 20px); column-gap:6px; }
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
.bt-root .bt-add-btn:hover, .bt-root .bt-add-btn[aria-expanded="true"] { background: var(--bt-hover) !important; color: var(--bt-text) !important; }
.bt-root .bt-add-menu { transform-origin: bottom center; }
.bt-root .bt-add-menu-item:hover,
.bt-root .bt-add-menu-item:focus { background: var(--bt-hover) !important; filter: none; outline: none; }
.bt-root .bt-add-menu-item:focus-visible { box-shadow: inset 0 0 0 1px var(--bt-border-strong); }
.bt-root .bt-draft-file-remove:hover { background: var(--bt-hover) !important; color: var(--bt-text-2) !important; }
.bt-root .bt-skill-picker .bt-picker-item { align-items: flex-start; }
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
/* v0.6.4 message context menu (fixed so the timeline never clips it) */
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
  .bt-root .bt-folder-menu { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .bt-root .bt-cursor, .bt-root .bt-typing-dot, .bt-root .bt-menu, .bt-root .bt-msg-menu, .bt-root .bt-msg-flash .bt-bubble { animation: none !important; }
  .bt-root .bt-sidebar { transition: none !important; }
}
`;

    // ── helpers ───────────────────────────────────────────────────────────
    function createBootstrapController({ load = api.bootstrap, onData, onError }) {
      let disposed = false;
      let revision = 0;
      let timer = null;
      let inFlight = null;
      const schedule = () => {
        if (disposed || inFlight || timer !== null) return;
        // Coalesce parallel bot completions and reconnect invalidations.
        timer = setTimeout(() => { timer = null; void run(); }, 100);
      };
      const run = async () => {
        const requestedRevision = revision;
        const request = new AbortController();
        inFlight = request;
        try {
          const data = await load(request.signal);
          if (!disposed && requestedRevision === revision) onData(data);
        } catch (error) {
          if (!disposed && requestedRevision === revision) onError(error);
        } finally {
          inFlight = null;
          // A completion during the GET invalidates its snapshot. Only the next
          // request may publish, so an older response cannot restore stale totals.
          if (!disposed && requestedRevision !== revision) schedule();
        }
      };
      return {
        refresh(immediate = false) {
          if (disposed) return;
          revision += 1;
          if (inFlight) return;
          if (immediate) {
            if (timer !== null) clearTimeout(timer);
            timer = null;
            void run();
          } else schedule();
        },
        dispose() {
          disposed = true;
          if (timer !== null) clearTimeout(timer);
          timer = null;
          inFlight?.abort();
        },
      };
    }

    function useBootstrap(dispatch) {
      const controller = React.useRef(null);
      const refresh = React.useCallback(() => controller.current?.refresh(), []);
      React.useEffect(() => {
        const current = createBootstrapController({
          onData: data => dispatch({ type: 'bootstrap', data }),
          onError: error => dispatch({ type: 'error', message: String(error && error.message ? error.message : error) }),
        });
        controller.current = current;
        current.refresh(true);
        return () => {
          current.dispose();
          if (controller.current === current) controller.current = null;
        };
      }, [dispatch]);
      return refresh;
    }

    function useSse(groupId, dispatch, onExecutionUpdate) {
      const executionListener = React.useRef(onExecutionUpdate);
      executionListener.current = onExecutionUpdate;
      React.useEffect(() => {
        if (!groupId) return undefined;
        let closed = false;
        const source = new EventSource(`${ROUTES.events}?groupId=${encodeURIComponent(groupId)}`);
        const handler = (type) => (event) => {
          if (closed) return;
          try {
            const frame = { groupId, ...JSON.parse(event.data), type };
            if (type === 'hello') {
              uiReport({ kind: 'sse-hello', groupId, seq: frame.seq, running: frame.running });
              // Resync after a reconnect: SSE only guarantees frames after connect.
              dispatch({ type: 'messagesTick' });
              dispatch({ type: 'refreshTick' });
            }
            if ((type === 'hello' || type === 'execution.updated') && executionListener.current) {
              executionListener.current({ ...frame, groupId });
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
          'message.deleted',
          'message.delta',
          'message.replace',
          'execution.updated',
          'interaction.updated',
          'member.status',
          'member.added',
          'member.removed',
          'member.updated',
          'group.updated',
          'conversation.started',
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
          source.onerror = null;
          source.close();
        };
      }, [groupId, dispatch]);
    }

    // Execution records stay separate from chat messages: metadata invalidation must
    // never replace a bubble that is receiving message.delta frames.
    function mergeExecutionEvents(current, incoming) {
      const bySeq = new Map();
      for (const event of [...(current || []), ...(incoming || [])]) {
        if (event && Number.isSafeInteger(event.seq) && event.seq >= 0 && !bySeq.has(event.seq)) bySeq.set(event.seq, event);
      }
      return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    }

    function emptyExecutionState(groupId, messageId, sessionId) {
      return { groupId, messageId, ...(sessionId ? { sessionId, scope: 'session' } : {}), events: [], nextSeq: -1, hasMore: false, availability: null, execution: null, status: null, error: null, loading: true, loadError: '' };
    }

    function mergeExecutionPage(current, page) {
      const events = mergeExecutionEvents(current.events, page.events);
      // nextSeq is the last raw record examined, even when that page is filtered empty.
      const nextSeq = Math.max(current.nextSeq, Number.isSafeInteger(page.nextSeq) ? page.nextSeq : -1, events.length ? events[events.length - 1].seq : -1);
      return { ...current, ...page, reason: page.reason, sessionId: page.sessionId, session: page.session, fallbackSessionId: page.fallbackSessionId, events, nextSeq, hasMore: page.hasMore === true, loadError: '' };
    }

    function canOpenNativeSession(session, sessionId) {
      return !!sessionId && session?.id === sessionId && session.native === true && session.origin !== 'subagent';
    }

    /** A click may require metadata I/O. A newer click, page switch or unmount
     * cancels that lookup before it can navigate the user's main panel. */
    function createNativeSessionController({ fetchPage = api.sessionHistory, workspace = () => appCtx?.uiWorkspace } = {}) {
      let pending = null;
      const cancel = () => { pending?.abort(); pending = null; };
      return {
        cancel,
        async open({ groupId, sessionId, session, onError }) {
          cancel();
          const controller = new AbortController();
          pending = controller;
          try {
            if (!groupId || !sessionId) throw new Error(uiT('这条消息尚未记录对应会话。'));
            let metadata = session;
            if (!metadata) {
              const page = await fetchPage(groupId, sessionId, -1, controller.signal);
              if (controller.signal.aborted) return false;
              if (page.groupId !== groupId || page.sessionId !== sessionId) throw new Error(uiT('会话历史与所选会话不匹配'));
              metadata = page.session;
            }
            if (metadata?.id !== sessionId) throw new Error(uiT('尚无法确认此会话可在原生会话中打开，请刷新日志后重试。'));
            if (metadata.origin === 'subagent' || metadata.native === false) throw new Error(uiT('此旧版子会话无法在原生会话中打开，请查看只读日志。'));
            if (!canOpenNativeSession(metadata, sessionId)) throw new Error(uiT('尚无法确认此会话可在原生会话中打开，请刷新日志后重试。'));
            const navigation = workspace();
            if (typeof navigation?.openSession !== 'function') throw new Error(uiT('原生会话导航暂不可用，请重新启动 DSH。'));
            if (controller.signal.aborted) return false;
            await navigation.openSession(sessionId);
            return true;
          } catch (error) {
            if (!controller.signal.aborted) onError?.(String(error?.message || error));
            return false;
          } finally {
            if (pending === controller) pending = null;
          }
        },
      };
    }

    async function exportRawSessionLog(groupId, sessionId, signal) {
      const response = await fetch(ROUTES.sessionExport + '?groupId=' + encodeURIComponent(groupId) + '&sessionId=' + encodeURIComponent(sessionId), { method: 'GET', credentials: 'same-origin', signal });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error?.message || uiT(response.status === 404 ? '原始日志导出接口尚未加载，请完全退出并重新启动 DSH。' : '请求失败 (HTTP {status})', { status: response.status }));
      }
      const blob = await response.blob();
      if (signal?.aborted) return;
      downloadBlob(safeExportName(sessionId, 'bot-session') + '.jsonl', blob);
    }

    function SessionExportButton({ groupId, sessionId }) {
      const [loading, setLoading] = React.useState(false);
      const [error, setError] = React.useState('');
      const request = React.useRef(null);
      React.useEffect(() => {
        setLoading(false); setError('');
        return () => { request.current?.abort(); request.current = null; };
      }, [groupId, sessionId]);
      const download = async () => {
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        setLoading(true); setError('');
        try { await exportRawSessionLog(groupId, sessionId, controller.signal); }
        catch (failure) { if (!controller.signal.aborted) setError(String(failure?.message || failure)); }
        finally { if (request.current === controller) { request.current = null; setLoading(false); } }
      };
      return h('div', { className: 'bt-session-export' },
        h('button', { type: 'button', style: S.ghostBtn, disabled: loading || !sessionId, onClick: download }, loading ? '正在导出…' : '导出原始日志'),
        error ? withRaw(() => h('span', { role: 'alert', className: 'bt-execution-failed' }, error)) : null,
      );
    }

    function executionPayload(value) {
      if (typeof value === 'string') return value;
      return value === undefined ? '' : JSON.stringify(value, null, 2);
    }

    function executionDuration(data) {
      const ms = data && (data.durationMs ?? data.elapsedMs);
      return Number.isFinite(ms) && ms >= 0 ? ms : null;
    }

    function executionFailed(value) {
      return !!(value && (value.isError === true || value.ok === false || value.error || ['error', 'failed', 'rejected'].includes(value.status)));
    }

    function executionText(data) {
      const message = data.message || data;
      const content = message.content ?? message.text;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) return content.filter(part => part && part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('');
      return '';
    }

    /** Pair native result.source.callId and every nested PTC dispatch without
     * discarding the original records that supplied the structured summary. */
    function projectExecutionEvents(events) {
      const ordered = mergeExecutionEvents([], events);
      const toolsByKey = new Map();
      const nodes = [];
      const scope = (data, id) => JSON.stringify([data.turn ?? null, data.step ?? null, id]);
      const compatible = (a, b) => (a.turn == null || b.turn == null || a.turn === b.turn) && (a.step == null || b.step == null || a.step === b.step);
      const labels = {
        'user/message': '触发输入', 'turn/start': '执行开始', 'turn/end': '执行结束',
        'step/start': '模型开始处理', 'step/end': '模型处理结束', 'assistant/message': '中间文本',
        'assistant/attempt': '未完成的模型输出', 'approval/asked': '等待审批', 'approval/decided': '审批决定',
      };
      for (const event of ordered) {
        const data = event.data || {};
        const type = String(event.type || 'unknown');
        const isPtc = ['tool/ptc-dispatch-start', 'tool/ptc-dispatch', 'tool/ptc-dispatch-end'].includes(type);
        const isTool = type === 'tool/call' || type === 'tool/result' || isPtc;
        if (isTool) {
          const callId = (type === 'tool/result' ? data.message?.source?.callId : null) || data.subCallId || data.callId || data.message?.toolCallId;
          const key = callId ? scope(data, callId) : 'tool:' + event.seq;
          let node = toolsByKey.get(key);
          if (!node && callId && type !== 'tool/call' && type !== 'tool/ptc-dispatch-start') {
            const candidates = [...toolsByKey.values()].filter(candidate => candidate.callId === callId && compatible(candidate, data));
            if (candidates.length === 1) node = candidates[0];
          }
          if (!node) {
            node = { key, kind: 'tool', seq: event.seq, time: event.time, callId, turn: data.turn, step: data.step, children: [], records: [], status: 'pending', tool: data.tool || data.name || null, ptc: isPtc };
            toolsByKey.set(key, node);
            nodes.push(node);
          }
          node.records.push(event);
          node.parentCallId = data.parentCallId || (isPtc ? data.rootCallId : null) || node.parentCallId;
          node.tool = data.tool || data.name || node.tool;
          node.durationMs = executionDuration(data) ?? node.durationMs;
          if (data.arguments !== undefined) node.arguments = data.arguments;
          if (type === 'tool/call' || type === 'tool/ptc-dispatch-start') {
            node.start = event;
          } else {
            node.end = event;
            node.result = data.message?.content ?? data.result ?? data.content ?? data.message ?? data;
            node.status = executionFailed(data.message) || executionFailed(data.result) || executionFailed(data) ? 'error' : 'done';
            if (data.error) node.error = data.error;
            if (data.attachments) node.attachments = data.attachments;
          }
          continue;
        }
        let label = labels[type];
        if (!label && /reasoning/.test(type)) label = '思考正文';
        if (!label && /retry/.test(type)) label = '重试';
        if (!label && /compact/.test(type)) label = '上下文整理';
        const node = { key: 'event:' + event.seq, kind: 'record', seq: event.seq, time: event.time, type, turn: data.turn, step: data.step, label: label || '其他记录 · ' + type, unknown: !label, durationMs: executionDuration(data), payloads: [], blocks: [] };
        const message = data.message || data;
        const content = message.content ?? message.text;
        if (type === 'user/message' || type === 'assistant/message' || type === 'assistant/attempt') {
          const text = executionText(data);
          if (text) node.payloads.push({ label: type === 'user/message' ? '输入原文' : '文本原文', value: text });
          if (Array.isArray(content)) node.blocks = content.filter(part => part && part.type !== 'text');
          if (typeof message.reasoning === 'string') node.blocks.push({ type: 'reasoning', text: message.reasoning });
          if (data.attachments) node.payloads.push({ label: '附件记录', value: data.attachments });
        } else if (/reasoning/.test(type) && typeof (message.text ?? message.content) === 'string') {
          node.blocks.push({ type: 'reasoning', text: message.text ?? message.content });
        }
        // Unknown variants, attempt diagnostics, compaction, metadata and complete
        // message blocks remain inspectable even when no summary renderer exists.
        node.payloads.push({ label: '记录详情', value: event });
        nodes.push(node);
      }
      const parentOf = new Map();
      for (const node of toolsByKey.values()) {
        if (!node.parentCallId) continue;
        const exact = toolsByKey.get(scope(node, node.parentCallId));
        const candidates = exact ? [exact] : [...toolsByKey.values()].filter(candidate => candidate.callId === node.parentCallId && compatible(candidate, node));
        if (candidates.length === 1 && candidates[0] !== node) parentOf.set(node, candidates[0]);
      }
      const roots = [];
      for (const node of nodes) {
        const parent = parentOf.get(node);
        const visited = new Set([node]);
        let ancestor = parent;
        while (ancestor && !visited.has(ancestor)) { visited.add(ancestor); ancestor = parentOf.get(ancestor); }
        if (parent && !ancestor) parent.children.push(node);
        else roots.push(node);
      }
      return roots.sort((a, b) => a.seq - b.seq);
    }

    /** One disposable loader per message or full session; invalidations during I/O
     * queue another pass, and all pages drain before waiting for the next SSE. */
    function createExecutionController({ groupId, messageId, sessionId, onChange, fetchPage = sessionId ? api.sessionHistory : api.execution }) {
      let state = emptyExecutionState(groupId, messageId, sessionId);
      let disposed = false;
      let dirty = false;
      let pending = null;
      let requestController = null;
      let preparingTimer = null;
      let lastNotice = -1;
      const publish = patch => { state = { ...state, ...patch }; if (!disposed) onChange(state); };
      const refresh = () => {
        if (disposed) return Promise.resolve();
        clearTimeout(preparingTimer);
        dirty = true;
        if (pending) return pending;
        pending = Promise.resolve().then(async () => {
          publish({ loading: true, loadError: '' });
          try {
            while (!disposed && (dirty || state.hasMore)) {
              dirty = false;
              const afterSeq = state.nextSeq;
              requestController = new AbortController();
              const page = await fetchPage(groupId, sessionId || messageId, afterSeq, requestController.signal);
              if (disposed) return;
              if (page.groupId !== groupId || (sessionId ? page.sessionId !== sessionId : page.messageId !== messageId)) {
                throw new Error(uiT(sessionId ? '会话历史与所选会话不匹配' : '执行记录与所选消息不匹配'));
              }
              const selectedSessionId = sessionId || page.execution?.sessionId || page.sessionId;
              if (page.session && page.session.id !== selectedSessionId) throw new Error(uiT('会话历史与所选会话不匹配'));
              const next = mergeExecutionPage(state, page);
              if (next.hasMore && next.nextSeq <= afterSeq) throw new Error(uiT('执行记录分页未前进，请重试'));
              publish(next);
            }
          } catch (error) {
            if (!disposed) publish({ loadError: String(error?.message || error) });
          } finally {
            pending = null;
            requestController = null;
            if (!disposed) {
              publish({ loading: false });
              if (state.availability === 'preparing' && !state.loadError) preparingTimer = setTimeout(refresh, 2000);
            }
          }
        });
        return pending;
      };
      return {
        refresh,
        getState: () => state,
        notify(frame) {
          if (disposed || frame.groupId !== groupId) return;
          if (frame.type !== 'hello' && (sessionId ? (frame.sessionId || frame.execution?.sessionId) !== sessionId : frame.messageId !== messageId)) return;
          if (frame.type !== 'hello' && Number.isSafeInteger(frame.seq)) {
            if (frame.seq <= lastNotice && !(!state.execution && frame.execution)) return;
            lastNotice = Math.max(lastNotice, frame.seq);
          }
          void refresh();
        },
        dispose() { disposed = true; dirty = false; clearTimeout(preparingTimer); requestController?.abort(); },
      };
    }

    function useMessageExecution(target) {
      const groupId = target?.groupId;
      const messageId = target?.message?.messageId;
      const sessionId = target?.mode === 'session' ? target.sessionId : undefined;
      const [state, setState] = React.useState(() => emptyExecutionState(groupId, messageId, sessionId));
      const controller = React.useRef(null);
      React.useEffect(() => {
        if (!groupId || !(messageId || sessionId)) return undefined;
        const current = createExecutionController({ groupId, messageId, sessionId, onChange: setState });
        controller.current = current;
        void current.refresh();
        return () => { current.dispose(); if (controller.current === current) controller.current = null; };
      }, [groupId, messageId, sessionId]);
      // A selection change renders before its effect runs. Never show A's records in B.
      const selected = state.groupId === groupId && (sessionId ? state.scope === 'session' && state.sessionId === sessionId : state.scope !== 'session' && state.messageId === messageId);
      return { state: selected ? state : emptyExecutionState(groupId, messageId, sessionId), controller };
    }

    function ExecutionPayload({ label, value }) {
      const [expanded, setExpanded] = React.useState(false);
      const [copyStatus, setCopyStatus] = React.useState('');
      const full = executionPayload(value);
      return h('details', { className: 'bt-execution-payload', onToggle: event => setExpanded(event.currentTarget.open) },
        h('summary', { tabIndex: 0 }, label, withRaw(() => h('span', { className: 'bt-execution-preview' }, full.slice(0, 120) + (full.length > 120 ? '…' : '')))),
        expanded ? h(React.Fragment, null,
          h('button', { type: 'button', style: S.smallBtn, onClick: () => copyTextToClipboard(full).then(() => setCopyStatus('已复制完整内容')).catch(error => setCopyStatus({ error: String(error?.message || error) })) }, '复制完整内容'),
          withRaw(() => h('span', { role: 'status', 'aria-live': 'polite' }, typeof copyStatus === 'string' ? uiT(copyStatus) : uiT('复制失败：{error}', copyStatus))),
          withRaw(() => h('pre', null, full)),
        ) : null,
      );
    }

    function ExecutionBlock({ block }) {
      const reasoning = block.type === 'reasoning';
      const body = block.text ?? block.reasoning ?? (typeof block.content === 'string' ? block.content : null);
      const metadata = block.source && typeof block.source === 'object' ? { ...block.source, ...block } : block;
      const info = ['name', 'filename', 'mimeType', 'mediaType', 'url', 'path', 'width', 'height', 'durationMs'].filter(key => metadata[key] != null).map(key => key + ': ' + executionPayload(metadata[key])).join(' · ');
      return h('div', { className: 'bt-execution-block' },
        h('strong', null, reasoning ? '思考正文' : uiT('内容块 · {type}', { type: block.type || 'unknown' })),
        reasoning && typeof body === 'string' ? withRaw(() => h('pre', { className: 'bt-execution-text', tabIndex: 0, 'aria-label': uiT('思考正文') }, body)) : null,
        info ? withRaw(() => h('p', null, info)) : null,
        h(ExecutionPayload, { label: '完整 JSON', value: block }),
      );
    }

    function ExecutionEvent({ node }) {
      const duration = Number.isFinite(node.durationMs) ? (node.durationMs < 1000 ? node.durationMs + ' ms' : (node.durationMs / 1000).toFixed(2) + ' s') : '';
      const tool = node.kind === 'tool';
      return h('li', { className: 'bt-execution-event', 'data-execution-seq': node.seq },
        h('div', { className: 'bt-execution-event-head' },
          withRaw(() => h('strong', null, tool ? uiT(node.ptc ? '内部工具 · {tool}' : '工具 · {tool}', { tool: node.tool || uiT('工具') }) : node.unknown ? uiT('其他记录 · {type}', { type: node.type }) : uiT(node.label))),
          tool ? h('span', { className: node.status === 'error' ? 'bt-execution-failed' : '' }, node.status === 'error' ? '失败' : node.status === 'done' ? '完成' : '等待结果') : null,
          h('time', { title: String(node.time ?? '') }, formatTime(node.time)),
          duration ? h('span', null, duration) : null,
        ),
        tool && node.arguments !== undefined ? h(ExecutionPayload, { label: '调用参数', value: node.arguments }) : null,
        node.children?.length ? h('ol', { className: 'bt-execution-children' }, node.children.map(child => h(ExecutionEvent, { key: child.key, node: child }))) : null,
        tool && node.result !== undefined ? h(ExecutionPayload, { label: node.end?.time ? uiT('工具结果 · {time}', { time: formatTime(node.end.time) }) : uiT('工具结果'), value: node.result }) : null,
        tool && node.error ? h(ExecutionPayload, { label: '错误详情', value: node.error }) : null,
        tool && node.attachments ? h(ExecutionPayload, { label: '附件记录', value: node.attachments }) : null,
        (node.blocks || []).map((block, index) => h(ExecutionBlock, { key: index, block })),
        (node.payloads || []).map((payload, index) => h(ExecutionPayload, { key: index, ...payload })),
        tool ? h(ExecutionPayload, { label: '原始事件记录', value: node.records }) : null,
      );
    }

    function executionReasonText(reason) {
      const messages = {
        'session-query-unavailable': '会话记录服务暂不可用，请稍后重试。',
        'session-log-missing': '原始会话记录已不存在。',
        'session-log-corrupt': '原始会话记录损坏，暂时无法读取。',
        'session-log-read-failed': '暂时无法读取原始会话记录，请稍后重试。',
        'execution-session-not-recorded': '这条消息尚未记录对应会话。',
        'execution-turn-not-recorded': '没有找到这条消息的执行轮次。',
        'execution-log-incomplete': '执行记录不完整，以下仅显示仍可读取的部分。',
        'legacy-message-has-no-execution-reference': '这条历史消息没有关联执行记录。',
      };
      if (messages[reason]) return messages[reason];
      if (['invalid-execution-reference', 'execution-reference-changed', 'session-reference-mismatch', 'ambiguous-input-message', 'execution-reference-mismatch', 'ambiguous-recorded-turn', 'execution-boundary-missing', 'input-message-mismatch', 'execution-boundary-mismatch'].includes(reason)) return '无法确认这条消息对应的执行范围。';
      return '请稍后刷新记录重试。';
    }

    function executionPosition(event) {
      return uiT('序号 {seq} · 轮次 {turn} · 步骤 {step}', { seq: event.seq, turn: event.data?.turn ?? event.turn ?? '—', step: event.data?.step ?? event.step ?? '—' });
    }

    function RawExecutionEvent({ event }) {
      const [copyStatus, setCopyStatus] = React.useState('');
      const full = JSON.stringify(event, null, 2);
      return h('li', { className: 'bt-execution-event bt-raw-event', 'data-execution-seq': event.seq },
        h('div', { className: 'bt-execution-event-head' },
          withRaw(() => h('strong', null, String(event.type || 'unknown'))),
          withRaw(() => h('span', null, executionPosition(event))),
          h('time', { title: String(event.time ?? '') }, formatTime(event.time)),
        ),
        h('button', { type: 'button', style: S.smallBtn, onClick: () => copyTextToClipboard(full).then(() => setCopyStatus('已复制完整内容')).catch(error => setCopyStatus({ error: String(error?.message || error) })) }, '复制完整内容'),
        withRaw(() => h('span', { role: 'status', 'aria-live': 'polite' }, typeof copyStatus === 'string' ? uiT(copyStatus) : uiT('复制失败：{error}', copyStatus))),
        withRaw(() => h('pre', { className: 'bt-raw-json', tabIndex: 0, 'aria-label': uiT('完整 JSON') }, full)),
      );
    }

    function RawExecutionEvents({ events }) {
      const [type, setType] = React.useState('');
      const [query, setQuery] = React.useState('');
      const ordered = mergeExecutionEvents([], events);
      const types = [...new Set(ordered.map(event => String(event.type || 'unknown')))];
      const needle = query.toLocaleLowerCase();
      const filtered = ordered.filter(event => (!type || String(event.type || 'unknown') === type) && (!needle || JSON.stringify(event).toLocaleLowerCase().includes(needle)));
      return h(React.Fragment, null,
        h('div', { className: 'bt-raw-filters', role: 'search', 'aria-label': '筛选原始事件' },
          h('label', null, '事件类型', h('select', { style: S.input, value: type, onChange: event => setType(event.target.value) },
            h('option', { value: '' }, '全部类型'),
            types.map(value => withRaw(() => h('option', { key: value, value }, value))),
          )),
          h('label', null, '筛选原始事件', h('input', { type: 'search', style: S.input, value: query, placeholder: '搜索完整 JSON', onChange: event => setQuery(event.target.value) })),
        ),
        h('p', { role: 'status', 'aria-live': 'polite' }, uiT('显示 {count} / {total} 条事件', { count: filtered.length, total: ordered.length })),
        filtered.length ? h('ol', { className: 'bt-execution-events', 'aria-label': '原始事件记录' }, filtered.map(event => h(RawExecutionEvent, { key: event.seq, event }))) : h('p', null, '没有匹配的原始事件。'),
      );
    }

    function renderExecutionRecords({ state, history = false, mode = 'structured', onRefresh }) {
      const records = mode === 'structured' ? projectExecutionEvents(state.events) : state.events;
      const available = state.availability === 'available';
      const reason = state.reason ? executionReasonText(state.reason) : '';
      return h(React.Fragment, null,
        state.loadError ? h('div', { role: 'alert', className: 'bt-execution-failed' }, '加载失败：', withRaw(() => h('span', null, state.loadError)), h('button', { type: 'button', style: S.ghostBtn, disabled: state.loading, onClick: onRefresh }, '重试')) : null,
        state.loading ? h('p', { role: 'status' }, state.events.length ? '正在加载后续记录…' : history ? '正在加载会话历史…' : '正在加载执行过程…') : null,
        state.availability === 'preparing' ? h('p', { role: 'status' }, '执行记录正在准备，稍后会自动更新。') : null,
        state.availability === 'legacy-unlinked' ? h('p', { role: 'status' }, '这条历史消息没有关联执行记录，无法定位当时的执行过程。') : null,
        state.availability === 'unavailable' ? h('p', { role: 'status' }, history ? '会话历史不可用。' : '执行记录不可用。', reason) : null,
        available && reason ? h('p', { role: 'status' }, reason) : null,
        state.error ? withRaw(() => h('div', { role: 'alert', className: 'bt-execution-failed' }, executionPayload(state.error))) : null,
        available && !records.length && !state.loading ? h('p', { role: 'status' }, history ? '尚无可显示的会话记录。' : '尚无可显示的执行记录。') : null,
        mode === 'raw' ? h(RawExecutionEvents, { events: state.events }) : records.length ? h('ol', { className: 'bt-execution-events', 'aria-label': history ? '按时间排序的会话记录' : '按时间排序的执行记录' }, records.map(node => h(ExecutionEvent, { key: node.key, node }))) : null,
      );
    }

    /** A separate page with an explicit return path, never a mode of the drawer. */
    function SessionHistoryPage({ target, state, onBack, onRefresh, onOpenNativeSession, returnToExecution = false }) {
      const backRef = React.useRef(null);
      const [mode, setMode] = React.useState('structured');
      const [sessionError, setSessionError] = React.useState('');
      React.useEffect(() => { backRef.current?.focus({ preventScroll: true }); }, [target.groupId, target.sessionId]);
      return h('section', { className: 'bt-root bt-session-page', role: 'region', 'aria-labelledby': 'bt-session-title', 'data-view': 'full-session' },
        h('header', { className: 'bt-session-header' },
          h('button', { ref: backRef, type: 'button', style: S.ghostBtn, onClick: onBack }, h('span', { 'aria-hidden': true }, '← '), returnToExecution ? '返回执行过程' : '返回聊天'),
          h('div', { className: 'bt-session-heading' },
            h('h1', { id: 'bt-session-title' }, '完整日志'),
            h('div', { className: 'bt-session-source' },
              withRaw(() => h('span', null, [target.groupTitle, target.botName || 'Bot'].filter(Boolean).join(' / '))),
              h('span', null, '全部轮次 · 只读历史'),
            ),
          ),
          h('button', { type: 'button', style: S.ghostBtn, disabled: state.loading, onClick: onRefresh }, '刷新记录'),
          h(SessionExportButton, { key: target.groupId + ':' + target.sessionId, groupId: target.groupId, sessionId: target.sessionId }),
        ),
        h('div', { className: 'bt-session-body', 'aria-busy': state.loading },
          h('div', { className: 'bt-session-content' },
            h('div', { className: 'bt-log-modes', role: 'group', 'aria-label': '日志视图' },
              h('button', { type: 'button', style: S.ghostBtn, 'aria-pressed': mode === 'structured', onClick: () => setMode('structured') }, '结构化执行'),
              h('button', { type: 'button', style: S.ghostBtn, 'aria-pressed': mode === 'raw', onClick: () => setMode('raw') }, '原始事件'),
            ),
            sessionError ? withRaw(() => h('p', { role: 'alert', className: 'bt-execution-failed' }, sessionError)) : null,
            h('p', { role: 'status' }, '这是后台 Bot 的只读日志。继续对话、回答问题和审批请返回 Bot Team。'),
            renderExecutionRecords({ state, history: true, mode, onRefresh }),
          ),
        ),
      );
    }

    function ExecutionDrawer({ target, state, onClose, onRefresh, onOpenSession, onOpenNativeSession }) {
      const dialogRef = React.useRef(null);
      const [sessionError, setSessionError] = React.useState('');
      React.useEffect(() => {
        const dialog = dialogRef.current;
        if (!dialog) return undefined;
        const release = containModalFocus(dialog);
        const doc = dialog.ownerDocument;
        const onKeyDown = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } };
        doc.addEventListener('keydown', onKeyDown);
        return () => {
          doc.removeEventListener('keydown', onKeyDown);
          if (release) release();
          if (target.returnFocus?.isConnected) target.returnFocus.focus({ preventScroll: true });
        };
      }, [target.groupId, target.message?.messageId, target.sessionId, onClose]);
      const status = state.status || target.message?.status;
      const statusLabel = { pending: '等待执行', streaming: '执行中', running: '执行中', done: '已完成', error: '失败', stopped: '已停止' }[status] || status || '状态未知';
      const sessionId = state.execution?.sessionId || state.sessionId;
      const legacy = state.availability === 'legacy-unlinked';
      return h('div', { className: 'bt-root bt-execution-layer', onMouseDown: event => { if (event.target === event.currentTarget) onClose(); } },
        h('aside', { ref: dialogRef, className: 'bt-execution-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'bt-execution-title', tabIndex: -1 },
          h('header', { className: 'bt-execution-header' },
            h('div', null,
              h('h2', { id: 'bt-execution-title' }, '执行过程'),
              withRaw(() => h('div', { className: 'bt-execution-source' }, uiT('{bot} · 消息 #{message}', { bot: target.message.author?.name || 'Bot', message: target.message.seq ?? target.message.messageId }))),
              h('div', { role: 'status', 'aria-live': 'polite', className: status === 'error' ? 'bt-execution-failed' : '' }, statusLabel),
            ),
            h('button', { type: 'button', style: S.ghostBtn, onClick: onClose, 'aria-label': '关闭执行过程' }, '×'),
          ),
          h('div', { className: 'bt-execution-body', 'aria-busy': state.loading },
            renderExecutionRecords({ state, onRefresh }),
          ),
          h('footer', { className: 'bt-execution-footer' },
            h('button', { type: 'button', style: S.ghostBtn, onClick: onRefresh, disabled: state.loading }, '刷新记录'),
            sessionId && !legacy && onOpenSession ? h('button', { type: 'button', style: S.ghostBtn, onClick: () => onOpenSession(sessionId, setSessionError) }, '完整日志') : null,
            sessionId ? h(SessionExportButton, { key: sessionId, groupId: target.groupId, sessionId }) : null,
            legacy && state.fallbackSessionId && onOpenSession ? h('button', { type: 'button', style: S.ghostBtn, onClick: () => onOpenSession(state.fallbackSessionId, setSessionError) }, '查看成员当前日志') : null,
            sessionError ? h('span', { role: 'alert', className: 'bt-execution-failed' }, sessionError) : null,
          ),
        ),
      );
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
      if (days === 0) return isEnglishUi() ? `Today ${clock}` : `今天 ${clock}`;
      if (days === 1) return isEnglishUi() ? `Yesterday ${clock}` : `昨天 ${clock}`;
      if (isEnglishUi()) {
        const monthDay = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        return date.getFullYear() === now.getFullYear()
          ? `${monthDay} ${clock}`
          : `${monthDay}, ${date.getFullYear()} ${clock}`;
      }
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
      if (days === 1) return isEnglishUi() ? 'Yesterday' : '昨天';
      if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}/${date.getDate()}`;
      return isEnglishUi()
        ? `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`
        : `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
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
        .replace(/```[\s\S]*?```/g, uiT(' [代码] '))
        .replace(/!\[[^\]]*\]\([^)]*\)/g, uiT(' [图片] '))
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/[`*_~>#|]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      return source.length > limit ? `${source.slice(0, limit)}…` : source;
    }

    function displayNameOf(message, bots, userProfile) {
      if (!message || !message.author) return uiT('未知');
      if (message.author.type === 'human') return (userProfile && userProfile.name) || uiT('我');
      if (message.author.type === 'system') return uiT('系统');
      const bot = message.author.botId ? (bots || []).find((candidate) => candidate.botId === message.author.botId) : null;
      return bot ? bot.name : message.author.name || 'Bot';
    }

    /**
     * The group member behind a bot-authored message. Replying in a group
     * defaults to @-mentioning this bot so the reply actually dispatches.
     */
    function replyMentionOf(message, members, bots) {
      if (!message || !message.author || message.author.type !== 'bot') return null;
      const botId = message.author.botId;
      if (!botId) return null;
      const member = (members || []).find(
        (candidate) => candidate && candidate.botId === botId && candidate.enabled !== false,
      );
      if (!member) return null;
      const bot = (bots || []).find((candidate) => candidate && candidate.botId === botId);
      return bot ? { member, bot } : null;
    }

    /**
     * Fold a reply target into the composer draft. Only the @ token inserted by
     * a previous reply (`auto`) is replaced or removed; text the user typed is
     * never touched. Returns the next text/mentions, the new auto marker, and
     * the caret position when the draft changed.
     */
    function applyReplyMention({ text, mentions, entry, auto }) {
      const currentText = String(text || '');
      const sourceMentions = Array.isArray(mentions) ? mentions : [];
      let nextText = currentText;
      let nextMentions = sourceMentions;
      let nextAuto = auto && auto.membershipId ? auto : null;
      let changed = false;

      const dropAuto = () => {
        if (!nextAuto) return;
        const token = '@' + nextAuto.name + ' ';
        if (nextText.startsWith(token)) {
          nextText = nextText.slice(token.length);
          changed = true;
        }
        // If the user moved the token, keep their edit (and the mention);
        // only forget it when it is no longer in the draft.
        if (!nextText.includes('@' + nextAuto.name) && nextMentions.includes(nextAuto.membershipId)) {
          nextMentions = nextMentions.filter((membershipId) => membershipId !== nextAuto.membershipId);
        }
        nextAuto = null;
      };

      if (!entry || !entry.bot || !entry.member) {
        dropAuto();
      } else if (nextAuto && nextAuto.membershipId !== entry.member.membershipId) {
        dropAuto();
      }

      if (entry && entry.bot && entry.member) {
        const token = '@' + entry.bot.name;
        if (!nextText.includes(token)) {
          nextText = token + ' ' + nextText;
          changed = true;
          nextAuto = { membershipId: entry.member.membershipId, name: entry.bot.name };
        }
        if (!nextMentions.includes(entry.member.membershipId)) {
          nextMentions = nextMentions.concat([entry.member.membershipId]);
        }
      }

      return {
        text: nextText,
        mentions: nextMentions,
        auto: nextAuto,
        caret: changed ? nextText.length : null,
      };
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
      if (previous.conversationId !== message.conversationId) return false;
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
      const head = `> **${String(name || uiT('消息'))}**${isEnglishUi() ? ': ' : '：'}${lines[0]}`.trimEnd();
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
      historical = false,
      onReply,
      onCopy,
      onCopyQuote,
      onJumpToMessage,
      onReview,
      onRevise,
      onRetry,
      onExecution,
      onDelete,
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
        label: historical ? '引用到当前会话' : '回复',
        title: streaming ? '回复生成中，暂不可回复' : historical ? '明确引用这条历史消息到当前会话' : '回复这条消息',
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
      if (isPlainChatMessage(message) && message.author.type === 'bot' && typeof onExecution === 'function') {
        actions.push({
          key: 'execution', icon: 'execution', label: '执行过程', title: '查看这条回复的执行过程',
          section: 'execution', disabled: false, hover: false, danger: false, onSelect: select(onExecution),
        });
      }
      if (isPlainChatMessage(message) && typeof onDelete === 'function') {
        actions.push({
          key: 'delete', icon: 'delete', label: '删除消息',
          title: streaming ? '回复生成中，请先停止回复再删除' : '删除这条消息',
          section: 'delete', disabled: streaming, hover: false, danger: true, onSelect: select(onDelete),
        });
      }
      return actions.map(action => historical && ['review', 'revise', 'retry'].includes(action.key)
        ? { ...action, disabled: true, hover: false, title: '历史会话只读，请明确引用到当前会话', onSelect: () => {} } : action);
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

    function Modal({ title, subtitle, width, className, icon, onClose, children, footer }) {
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
            className: 'bt-modal' + (className ? ' ' + className : ''),
            ref: dialogRef,
            tabIndex: -1,
            style: width ? { ...S.modal, width } : S.modal,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': title,
          },
          h(
            'div',
            { className: 'bt-modal-header', style: S.modalHeader },
            icon ? h('div', { className: 'bt-modal-icon', 'aria-hidden': true }, icon) : null,
            h(
              'div',
              { className: 'bt-modal-heading', style: S.modalHeading },
              h('div', { className: 'bt-modal-title', style: S.modalTitle }, title),
              subtitle ? h('div', { className: 'bt-modal-subtitle', style: S.modalSubtitle }, subtitle) : null,
            ),
            h(
              'button',
              { className: 'bt-modal-close', style: S.modalClose, onClick: onClose, 'aria-label': '关闭' },
              '×',
            ),
          ),
          h('div', { className: 'bt-modal-body', style: S.modalBody }, children),
          footer ? h('div', { className: 'bt-modal-footer', style: S.modalFooter }, footer) : null,
        ),
      );
    }

    // ── getting started: all actions use the existing Host-backed dialogs ──
    function WelcomeIcon({ name, className }) {
      const paths = {
        bot: ['M12 3v4M1.5 12v4m21-4v4M9 16h6', 'M8.5 11.5v1m7-1v1'],
        plus: ['M12 5v14M5 12h14'],
        arrow: ['M4 12h16m-6-6 6 6-6 6'],
        chevron: ['m9 5 7 7-7 7'],
        chat: ['M20 11.5a8.5 8.5 0 0 1-8.5 8.5H4l1-4A8.5 8.5 0 1 1 20 11.5Z', 'M8 10h7m-7 4h4'],
        group: ['M2.5 20v-2a5.5 5.5 0 0 1 5.5-5.5h2A5.5 5.5 0 0 1 15.5 18v2M16 4.8a3.2 3.2 0 0 1 0 6.4M18 14a5 5 0 0 1 3.5 4.7V20'],
        search: ['m16 16 4.5 4.5M8 10.5h5m-2.5-2.5v5'],
        code: ['m7 6-5 6 5 6m10-12 5 6-5 6M14 4l-4 16'],
        check: ['m5 12 4 4L19 6'],
        shield: ['m12 3 8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6zM8 11.5l2.5 2.5L16 9'],
        spark: ['m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6Z'],
        book: ['M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v15'],
        info: ['M12 11v5m0-9v.2'],
        menu: ['M4 6h16M4 12h16M4 18h16'],
      };
      return h('svg', {
        className: 'bt-welcome-icon' + (className ? ' ' + className : ''),
        width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.65, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false,
      },
        name === 'bot' ? h('rect', { x: 4, y: 7, width: 16, height: 13, rx: 4 }) : null,
        name === 'group' ? h('circle', { cx: 9, cy: 8, r: 3.2 }) : null,
        name === 'search' ? h('circle', { cx: 10.5, cy: 10.5, r: 6.5 }) : null,
        name === 'info' ? h('circle', { cx: 12, cy: 12, r: 9 }) : null,
        (paths[name] || paths.spark).map((d, key) => h('path', { key, d })),
      );
    }

    function WelcomeScreen({ hasBots, onCreateBot, onCreateGroup, onGuide, onOpenSidebar, sidebarOpen = false }) {
      const action = (label, name, callback, primary) => h('button', {
        type: 'button', className: 'bt-welcome-button ' + (primary ? 'bt-welcome-primary' : 'bt-welcome-secondary'),
        'data-action': name, onClick: callback,
      }, label, h(WelcomeIcon, { name: 'arrow' }));
      const role = (name, icon, copy, color) => h('li', { key: icon, className: 'bt-welcome-role' },
        h('span', { className: 'bt-welcome-avatar ' + color }, h(WelcomeIcon, { name: icon })),
        h('div', null, h('div', { className: 'bt-welcome-role-name' }, name), h('div', { className: 'bt-welcome-role-copy' }, copy)),
      );
      return h('div', { className: 'bt-welcome-screen', 'data-testid': 'welcome-screen' },
        h('header', { className: 'bt-welcome-topbar' },
          h('div', { className: 'bt-welcome-breadcrumb' },
            h('button', { type: 'button', className: 'bt-welcome-mobile-menu', onClick: onOpenSidebar, 'aria-label': '打开导航', 'aria-controls': 'bt-group-sidebar', 'aria-expanded': sidebarOpen }, h(WelcomeIcon, { name: 'menu' })),
            h('span', { className: 'bt-welcome-muted' }, '工作空间'), h('span', { 'aria-hidden': true }, '/'), h('span', null, '开始使用')),
          h('button', { type: 'button', className: 'bt-welcome-guide', 'data-action': 'quick-start', onClick: onGuide }, h(WelcomeIcon, { name: 'book' }), '快速上手', h(WelcomeIcon, { name: 'chevron' }))),
        h('div', { className: 'bt-welcome-content' },
          h('section', { className: 'bt-welcome-hero', 'aria-labelledby': 'bt-welcome-title' },
            h('div', null, h('p', { className: 'bt-welcome-eyebrow' }, '欢迎来到 Bot Team'),
              h('h1', { id: 'bt-welcome-title' }, '好搭档，从这里开始。'),
              h('p', { className: 'bt-welcome-description' }, '从一次对话，到一群 Bot 的默契协作。', h('br'), '为你的想法，找到一起把它实现的搭档。')),
            h('div', { className: 'bt-welcome-art', 'aria-hidden': true },
              h('svg', { className: 'bt-welcome-connectors', viewBox: '0 0 270 170', fill: 'none', focusable: false },
                h('path', { d: 'M133 90C132 126 90 108 57 118M142 88C156 121 197 100 231 118', strokeDasharray: '3 5' }),
                h('path', { d: 'M62 111C62 66 84 60 128 62M232 112C232 54 192 54 156 62', opacity: .5 })),
              h('span', { className: 'bt-welcome-spark' }, '✧'), h('span', { className: 'bt-welcome-spark second' }, '✦'),
              h('div', { className: 'bt-welcome-tile research' }, h(WelcomeIcon, { name: 'search' })),
              h('div', { className: 'bt-welcome-tile main-bot' }, h(WelcomeIcon, { name: 'bot' })),
              h('div', { className: 'bt-welcome-tile review' }, h(WelcomeIcon, { name: 'shield' })),
              h('div', { className: 'bt-welcome-art-caption' }, '• BETTER TOGETHER'))),
          h('section', { className: 'bt-welcome-actions', 'aria-label': '开始使用' },
            h('article', { className: 'bt-welcome-card primary' },
              h('div', { className: 'bt-welcome-card-top' }, h('div', { className: 'bt-welcome-symbol' }, h(WelcomeIcon, { name: 'bot' })), !hasBots ? h('span', { className: 'bt-welcome-recommended' }, '推荐第一步') : null),
              h('h2', null, hasBots ? '创建 Bot' : '创建第一个 Bot'),
              h('p', null, '选一个模型，赋予它名字与专长。', h('br'), '写代码、找资料、聊想法，从一位搭档开始。'),
              h('div', { className: 'bt-welcome-card-bottom' }, action('创建 Bot', 'create-bot', onCreateBot, true), h('span', { className: 'bt-welcome-card-caption' }, h(WelcomeIcon, { name: 'chat' }), '自动开启一对一会话'))),
            h('article', { className: 'bt-welcome-card' },
              h('div', { className: 'bt-welcome-card-top' }, h('div', { className: 'bt-welcome-symbol group' }, h(WelcomeIcon, { name: 'group' }))),
              h('h2', null, '组建一个协作群'), h('p', null, '让不同专长的 Bot 聚在一起。', h('br'), '讨论、分工、互相检查，一起把任务向前推进。'),
              h('div', { className: 'bt-welcome-card-bottom' }, action('创建群聊', 'create-group', onCreateGroup, false), h('span', { className: 'bt-welcome-card-caption' }, '也可以稍后添加 Bot')))),
          h('section', { className: 'bt-welcome-example-section', 'aria-labelledby': 'bt-welcome-example-title' },
            h('div', { className: 'bt-welcome-section-heading' }, h('h3', { id: 'bt-welcome-example-title' }, '一个想法，可以这样一起完成'), h('span', { className: 'bt-welcome-example-label' }, h(WelcomeIcon, { name: 'info' }), '协作示例')),
            h('div', { className: 'bt-welcome-example' },
              h('div', { className: 'bt-welcome-prompt' }, h('span', { className: 'bt-welcome-prompt-icon' }, h(WelcomeIcon, { name: 'chat' })), h('span', { className: 'bt-welcome-prompt-text' }, h('strong', null, '@研究员 @工程师 @审阅者'), ' ', '一起帮我做一个个人网站'), h('span', { className: 'bt-welcome-prompt-context' }, h(WelcomeIcon, { name: 'group' }), '在群聊中')),
              h('ol', { className: 'bt-welcome-workflow' }, role('研究员', 'search', '梳理需求，找到合适的方向', 'mint'), role('工程师', 'code', '编写代码，把想法做出来', 'blue'), role('审阅者', 'shield', '检查细节，让结果更可靠', 'sand')),
              h('div', { className: 'bt-welcome-example-bottom' }, h(WelcomeIcon, { name: 'spark' }), '每个 Bot 都可以有自己的模型与做事风格，你来决定如何搭配。'))),
          h('p', { className: 'bt-welcome-note' }, h(WelcomeIcon, { name: 'check' }), '先从单聊开始也很好，随时都能组建你的团队。'),
          h('footer', { className: 'bt-welcome-footer' }, h('span', null, 'BOT TEAM'), h('span', { 'aria-hidden': true }, '·'), h('span', null, '各有所长，一起完成。'))));
    }

    function GettingStartedDialog({ hasBots, onClose, onCreateBot, onCreateGroup }) {
      const steps = [
        ['先认识一位 Bot', '选择模型、名字与专长。创建后，它会自动拥有一个和你的单聊。'],
        ['为共同的目标，建一个群', '邀请不同专长的 Bot 加入，同一个 Bot 也可以参与多个群。'],
        ['用 @ 邀请它们参与', '让 Bot 讨论问题、处理任务或检查彼此的工作。你来掌握方向。'],
      ];
      return h(Modal, { title: '三小步，开启协作', onClose, width: 500,
        footer: [
          h('button', { key: 'group', type: 'button', style: S.ghostBtn, 'data-action': 'create-group', onClick: onCreateGroup }, '创建群聊'),
          h('button', { key: 'bot', type: 'button', style: S.primaryBtn, 'data-action': 'create-bot', onClick: onCreateBot }, hasBots ? '创建 Bot' : '创建第一个 Bot'),
        ],
      }, h('ol', { className: 'bt-welcome-steps' }, steps.map(([title, text], index) => h('li', { key: title },
        h('span', { className: 'bt-welcome-step-number', 'aria-hidden': true }, String(index + 1)),
        h('div', null, h('h3', null, title), h('p', null, text)),
      ))));
    }

    function Field({ label, hint, required, horizontal, style, children }) {
      return h(
        'div',
        { style: { ...S.field, ...(horizontal ? S.fieldRow : {}), ...style } },
        h(
          'label',
          { style: horizontal ? { ...S.label, ...S.fieldRowLabel } : S.label },
          label,
          required ? h('span', { style: S.requiredMark }, '*') : null,
        ),
        horizontal ? h('div', { style: S.fieldRowContent }, children) : children,
        hint ? h('div', { style: horizontal ? { ...S.fieldHint, ...S.fieldRowHint } : S.fieldHint }, hint) : null,
      );
    }

    const SETTINGS_TABS = [
      { id: 'messages', label: '消息设置', icon: 'message' },
      { id: 'sidebar', label: '侧边栏设置', icon: 'sidebar' },
      { id: 'about', label: '关于', icon: 'info' },
    ];
    const ABOUT_DESCRIPTION = '在 DSH Web GUI 中运行单聊与多 Agent 群聊：每个 Bot 自动拥有独立的单聊窗口；群聊支持自定义分组、拖拽排序与展开/收起；Bot 可配置自己的模型、BOT.md 人格和完整工具能力。';
    const ABOUT_FEATURES = ['单聊自动创建', '群聊分组与拖拽排序', '展开 / 收起', 'BOT.md 人格', '任务与评审'];
    const ABOUT_GITHUB_URL = 'https://github.com/shper/dsh-bot-team';
    const ABOUT_DATA_NOTES = [
      { label: '数据存储', path: '$DSH_HOME/storages/dsh-bot-team' },
      { label: 'Bot 会话', text: '使用真实的 DSH session。' },
      { label: '人格文件', path: '$DSH_HOME/dsh-bot-team/bots/<botId>/BOT.md' },
      { label: '单聊工作目录', path: '$DSH_HOME/dsh-bot-team/direct/<botId>/' },
      { label: '群聊工作目录', path: '$DSH_HOME/dsh-bot-team/groups/<groupId>/' },
    ];

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
      if (name === 'sidebar') {
        return h('svg', common,
          h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }),
          h('path', { d: 'M9 4v16' }),
        );
      }
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

    function ChatSettingsDialog({ settings, sidebarShowDirect = true, onClose, onSaved, pluginInfo, initialTab = 'messages' }) {
      // Keep only local edits: untouched fields follow settings saved in other tabs.
      const [edits, setEdits] = React.useState({});
      const [directEdit, setDirectEdit] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const [tab, setTab] = React.useState(
        SETTINGS_TABS.some((item) => item.id === initialTab) ? initialTab : 'messages',
      );
      const current = normalizeChatDisplaySettings(settings);
      const draft = { ...current, ...edits };
      const messagesDirty = CHAT_DISPLAY_FIELDS.some(({ key }) => draft[key] !== current[key]);
      const currentShowDirect = sidebarShowDirect !== false;
      const draftShowDirect = directEdit ?? currentShowDirect;
      const dirty = messagesDirty || draftShowDirect !== currentShowDirect;
      const activeTabIndex = SETTINGS_TABS.findIndex((item) => item.id === tab);

      const save = async () => {
        if (busy || !dirty) return;
        setBusy(true);
        setError('');
        try {
          let savedSettings = current;
          if (messagesDirty) {
            const response = await api.action('settings.chatDisplay.update', { settings: draft });
            savedSettings = normalizeChatDisplaySettings(response.result.chatDisplaySettings);
          }
          onSaved(savedSettings, draftShowDirect);
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
      );

      const sidebarPanel = h(
        'div',
        { key: 'sidebar', role: 'tabpanel', id: 'bt-settings-panel-sidebar', 'aria-labelledby': 'bt-settings-tab-sidebar', style: S.settingsPanel },
        h('div', { style: S.settingsPanelHead },
          h('div', { style: S.settingsPanelTitle }, '侧边栏设置'),
          h('div', { style: S.settingsPanelHint }, '控制侧边栏的显示内容；保存后在当前浏览器生效。'),
        ),
        h('div', { className: 'bt-settings-row', style: S.settingsRow },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { id: 'bt-sidebar-show-direct-label', style: { fontSize: 12.5, fontWeight: 600 } }, '显示单聊'),
            h('div', { id: 'bt-sidebar-show-direct-hint', style: S.fieldHint }, '默认开启，在侧边栏显示单聊列表与图标。'),
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h('span', { 'aria-hidden': true, style: S.fieldHint }, draftShowDirect ? '开启' : '隐藏'),
            h('button', {
              type: 'button', role: 'switch', 'aria-checked': draftShowDirect,
              'aria-labelledby': 'bt-sidebar-show-direct-label', 'aria-describedby': 'bt-sidebar-show-direct-hint', disabled: busy,
              style: { display: 'inline-flex', alignItems: 'center', width: 40, height: 24, padding: 3, flexShrink: 0, boxSizing: 'border-box', border: '1px solid var(--bt-border)', borderRadius: 12, background: draftShowDirect ? 'var(--bt-accent)' : 'var(--bt-bg-subtle)', cursor: busy ? 'wait' : 'pointer' },
              onClick: () => {
                const next = !draftShowDirect;
                setDirectEdit(next === currentShowDirect ? null : next);
              },
            }, h('span', { 'aria-hidden': true, style: { display: 'block', width: 16, height: 16, borderRadius: '50%', background: draftShowDirect ? '#fff' : 'var(--bt-text-3)', transform: draftShowDirect ? 'translateX(16px)' : 'translateX(0)', transition: 'transform 0.15s ease' } })),
          ),
        ),
      );

      const info = pluginInfo && typeof pluginInfo === 'object' ? pluginInfo : {};
      const version = typeof info.version === 'string' && info.version ? info.version : '1.2.2';
      const packageName = typeof info.packageName === 'string' && info.packageName ? info.packageName : 'dsh-bot-team';
      const author = typeof info.author === 'string' && info.author ? info.author : 'shper';
      const metaRows = [
        { label: '版本', value: version, kind: 'version' },
        { label: '包名', value: packageName, kind: 'code' },
        { label: '开发者', value: author },
        { label: 'GitHub', value: ABOUT_GITHUB_URL, href: ABOUT_GITHUB_URL },
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
        h('div', { className: 'bt-about-information' },
          h('dl', { className: 'bt-about-info-card' }, metaRows.map(row =>
            h('div', { key: row.label, className: 'bt-about-info-row' },
              h('dt', { className: 'bt-about-info-label' }, row.label),
              h('dd', { className: 'bt-about-info-value' }, row.href
                ? h('a', {
                    className: 'bt-about-link',
                    href: row.href,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    title: '在新标签页打开 GitHub 仓库',
                  }, h('span', { raw: true }, row.value), h(WelcomeIcon, { name: 'arrow' }))
                : h(row.kind ? 'code' : 'span', {
                    className: row.kind ? 'bt-about-value-chip' + (row.kind === 'version' ? ' bt-about-version' : '') : undefined,
                    title: row.value, rawTitle: true, raw: true,
                  }, row.value),
              ),
            ),
          )),
          h('dl', { className: 'bt-about-info-card' }, ABOUT_DATA_NOTES.map(note =>
            h('div', { key: note.label, className: 'bt-about-info-row' },
              h('dt', { className: 'bt-about-info-label' }, note.label),
              h('dd', { className: 'bt-about-info-value' }, note.path
                ? h('code', { className: 'bt-about-value-chip', title: note.path, rawTitle: true, raw: true }, note.path)
                : h('span', null, note.text),
              ),
            ),
          )),
        ),
      );

      const footer = tab !== 'about'
        ? h(React.Fragment, null,
            h('button', { key: 'reset', type: 'button', style: { ...S.smallBtn, marginRight: 'auto' }, disabled: busy, onClick: () => { if (tab === 'sidebar') setDirectEdit(true); else setEdits({ ...DEFAULT_CHAT_DISPLAY_SETTINGS }); setError(''); } }, '恢复默认'),
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
            tab === 'messages' ? messagesPanel : tab === 'sidebar' ? sidebarPanel : aboutPanel,
            error ? h('div', { role: 'alert', style: { ...S.fieldHint, color: 'var(--bt-danger-text)', marginTop: 12 } }, uiT('保存失败：{error}', { error })) : null,
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
              h('span', { style: S.sidebarMenuLabel, raw: item.raw === true }, item.label),
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
          width: 16,
          height: 16,
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

    function renderGroupList({
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
      onOpenNativeSession,
      onCreateGroupInFolder,
      onRenameFolder,
      onDeleteFolder,
      onReorderGroups,
      onReorderFolders,
      onShowWelcome,
      sidebarRef,
      mobileNavigation,
    }) {
      const collapsed = state.sidebarCollapsed === true;
      const showDirect = state.sidebarShowDirect !== false;
      const showWelcome = shouldShowWelcome(state);
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
        // Only select the conversation when the row itself has focus.
        if (event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        selectGroup(group);
      };
      const groupTooltip = (group) => {
        const last = group.lastMessage;
        if (!last) return group.topic ? `${group.title}\n${cleanPreview(group.topic, 80)}` : group.title;
        const author = String(last.authorName || '').trim();
        const prefix = author === '用户'
          ? uiT('我：')
          : author && author !== '系统'
            ? uiT('{name}：', { name: author })
            : '';
        return `${group.title}\n${prefix}${cleanPreview(last.text, 80) || uiT('[消息]')}`;
      };
      const directTooltip = (entry) => {
        const last = entry.group && entry.group.lastMessage;
        if (!last) return `${entry.bot.name}\n${uiT('开始单聊')}`;
        const prefix = String(last.authorName || '').trim() === '用户' ? uiT('我：') : '';
        return `${entry.bot.name}${uiT('（单聊）')}\n${prefix}${cleanPreview(last.text, 80) || uiT('[消息]')}`;
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
            raw: true,
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
            label: '查看日志',
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
      const renderGroupRow = (group) => {
        const active = group.groupId === state.activeGroupId;
        const last = group.lastMessage;
        const author = last ? String(last.authorName || '').trim() : '';
        const prefix = author === '用户'
          ? uiT('我：')
          : author && author !== '系统'
            ? uiT('{name}：', { name: author })
            : '';
        const body = last ? cleanPreview(last.text, 70) : '';
        const preview = last
          ? `${prefix}${body || uiT('[消息]')}`
          : group.topic
            ? cleanPreview(group.topic, 70)
            : uiT('暂无消息');
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
              h('span', { style: S.groupItemTitle, title: group.title, raw: true }, group.title),
              h('span', { style: S.groupItemTime }, formatListTime(last && last.createdAt)),
            ),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 } },
              group.running ? h('span', { style: { ...S.dot('#22c55e', 'running'), width: 6, height: 6 } }) : null,
              h('span', { style: S.groupItemPreview, raw: true }, preview),
              !group.running && memberCount > 0
                ? h('span', { style: { fontSize: 10, color: 'var(--bt-text-3)', flex: '0 0 auto' } }, pluralUi('1 人', '{count} 人', memberCount))
                : null,
            ),
          ),
        );
      };

      const renderDirectRow = (entry) => {
        const active = entry.group && entry.group.groupId === state.activeGroupId;
        const last = entry.group && entry.group.lastMessage;
        const mine = last && String(last.authorName || '').trim() === '用户';
        const body = last ? cleanPreview(last.text, 70) : '';
        const preview = last
          ? `${mine ? uiT('我：') : ''}${body || uiT('[消息]')}`
          : uiT('开始单聊');
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
            'aria-label': `${uiT('{name}（单聊）', { name: entry.bot.name })}${entry.group && entry.group.running ? uiT('（回复中）') : ''}`,
            'aria-current': active ? 'true' : undefined,
            title: directTooltip(entry),
            rawTitle: true,
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
              h('span', { style: S.groupItemTitle, title: entry.bot.name, raw: true }, entry.bot.name),
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
              title: isCollapsed(key) ? uiT('展开{label}', { label }) : uiT('收起{label}', { label }),
              'aria-label': isCollapsed(key) ? uiT('展开{label}', { label }) : uiT('收起{label}', { label }),
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
            key: label,
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
                title: folderCollapsed ? uiT('展开分组 {title}', { title: folder.title }) : uiT('收起分组 {title}', { title: folder.title }),
                'aria-label': folderCollapsed ? uiT('展开分组 {title}', { title: folder.title }) : uiT('收起分组 {title}', { title: folder.title }),
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
              h('span', { style: S.folderName, title: folder.title, raw: true }, folder.title),
              h('span', { style: S.folderCount }, folderEntry.groups.length),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'bt-folder-menu',
                style: S.folderMenu,
                title: uiT('分组 {title} 操作', { title: folder.title }),
                'aria-label': uiT('分组 {title} 操作', { title: folder.title }),
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
        { className: 'bt-sidebar-section', style: showWelcome ? S.section : { ...S.section, marginTop: 0 }, 'data-section': SECTION_DIRECT },
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
              ? h('div', { style: { fontSize: 11.5, color: 'var(--bt-text-3)', padding: '4px 8px 8px', lineHeight: 1.7 } }, '你的第一位搭档，即将到来。')
              : model.direct.map(renderDirectRow),
        ),
      );

      const groupsSection = h(
        'div',
        { className: 'bt-sidebar-section', style: showDirect || showWelcome ? S.section : { ...S.section, marginTop: 0 }, 'data-section': SECTION_GROUPS },
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
                '为一个共同的目标，聚在一起。',
              )
            : null,
        ),
      );

      const list = collapsed
        ? h(
            'div',
            { style: S.groupRail, className: 'bt-group-rail' },
            showDirect && model.direct.map((entry) =>
              h(
                'div',
                {
                  key: `direct-${entry.bot.botId}`,
                  className: 'bt-group-item bt-group-rail-item bt-direct-rail-item',
                  role: 'button',
                  tabIndex: 0,
                  'data-active': entry.group && entry.group.groupId === state.activeGroupId ? 'true' : 'false',
                  'aria-current': entry.group && entry.group.groupId === state.activeGroupId ? 'true' : undefined,
                  'aria-label': `${uiT('{name}（单聊）', { name: entry.bot.name })}${entry.group && entry.group.running ? uiT('（回复中）') : ''}`,
                  title: directTooltip(entry),
                  rawTitle: true,
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
            showDirect && model.direct.length > 0 && (model.groupCount > 0)
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
                  'aria-label': `${group.title}${group.running ? uiT('（回复中）') : ''}`,
                  'aria-current': isActive ? 'true' : undefined,
                  title: groupTooltip(group),
                  rawTitle: true,
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
            showDirect ? directSection : null,
            groupsSection,
          );

      const toggleTitle = mobileNavigation ? '关闭导航' : collapsed ? '展开侧栏' : '收起侧栏';
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
          onClick: () => mobileNavigation ? onShowWelcome?.() : dispatch({ type: 'toggleSidebar' }),
        },
        h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false, style: S.sidebarToggleIcon },
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
        ? h('div', { style: S.railHeader }, toggleButton, showWelcome ? null : newGroupButton)
        : h(
            'div',
            {
              style: { ...S.leftHeader, padding: '12px 24px 0', justifyContent: 'flex-end' },
              className: 'bt-sidebar-header',
            },
            // Creation lives on the section headers now (单聊 + / 群聊 +); the
            // old duplicate "+ 新建" here made the two entry points ambiguous.
            h('div', { style: S.leftHeaderActions }, toggleButton),
          );

      const actionStyle = collapsed ? S.railAction : { ...S.sidebarAction, justifyContent: 'flex-start', gap: 12, height: 40 };
      const actionIconStyle = collapsed ? S.railActionIcon : S.sidebarActionIcon;
      return h(
        'div',
        {
          id: 'bt-group-sidebar',
          className: 'bt-sidebar',
          ref: sidebarRef,
          role: mobileNavigation ? 'dialog' : 'navigation',
          'aria-label': 'Bot Team 导航',
          'aria-modal': mobileNavigation ? true : undefined,
          tabIndex: -1,
          'data-collapsed': collapsed ? 'true' : 'false',
          style: S.sidebar(collapsed),
        },
        header,
        showWelcome ? h('button', {
          type: 'button', className: 'bt-welcome-nav', 'data-action': 'show-welcome',
          'data-active': !state.activeGroupId ? 'true' : 'false',
          'aria-current': !state.activeGroupId ? 'page' : undefined,
          'aria-label': '开始使用', title: '开始使用',
          onClick: () => { dispatch({ type: 'showWelcome' }); onShowWelcome?.(); },
        }, h(WelcomeIcon, { name: 'spark' }), collapsed ? null : h('span', null, '开始使用'), collapsed ? null : h(WelcomeIcon, { name: 'chevron', className: 'bt-welcome-nav-arrow' })) : null,
        showWelcome ? null : list,
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
    function GroupList(props) {
      return renderGroupList(props);
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
      { id: 'sky', bg: '#eef6ff', c1: '#38bdf8', c2: '#2563eb', accent: '#f59e0b' },
      { id: 'violet', bg: '#f5f3ff', c1: '#a78bfa', c2: '#7c3aed', accent: '#22d3ee' },
      { id: 'mint', bg: '#ecfdf5', c1: '#34d399', c2: '#0d9488', accent: '#f59e0b' },
      { id: 'orange', bg: '#fff7ed', c1: '#fb923c', c2: '#ea580c', accent: '#2563eb' },
      { id: 'pink', bg: '#fdf2f8', c1: '#f472b6', c2: '#db2777', accent: '#facc15' },
      { id: 'indigo', bg: '#eef2ff', c1: '#818cf8', c2: '#4f46e5', accent: '#34d399' },
      { id: 'teal', bg: '#f0fdfa', c1: '#2dd4bf', c2: '#0f766e', accent: '#fb7185' },
      { id: 'slate', bg: '#f8fafc', c1: '#94a3b8', c2: '#475569', accent: '#38bdf8' },
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
    // Bold silhouettes and solid face panels stay legible at small avatar sizes.
    const BOT_ART_AVATARS = [
      {
        id: 'bot-orbit',
        label: '轨道',
        bg: '#f0edff',
        draw: (palette) => [
          h('ellipse', { cx: 50, cy: 51, rx: 39, ry: 24, fill: 'none', stroke: palette?.c2 || '#b5a5ea', strokeWidth: 5, transform: 'rotate(-28 50 51)' }),
          h('rect', { x: 23, y: 22, width: 54, height: 58, rx: 26, fill: palette?.c1 || '#8b76d5' }),
          h('rect', { x: 29, y: 37, width: 42, height: 29, rx: 14, fill: '#26354b' }),
          h('path', { d: 'M40 48 V54 M60 48 V54', stroke: palette?.bg || '#d3f7ee', strokeWidth: 5, strokeLinecap: 'round' }),
          h('circle', { cx: 80, cy: 30, r: 7, fill: palette?.accent || '#efb55d' }),
          h('rect', { x: 44, y: 72, width: 12, height: 4, rx: 2, fill: palette?.bg || '#e5ddff' }),
        ],
      },
      {
        id: 'bot-spark',
        label: '灵光',
        bg: '#fff3df',
        draw: (palette) => [
          h('path', { d: 'M51 8 L40 26 H50 L46 36 L62 18 H52 L57 8 Z', fill: palette?.accent || '#db8d35' }),
          h('rect', { x: 12, y: 47, width: 10, height: 18, rx: 5, fill: palette?.c2 || '#d99443' }),
          h('rect', { x: 78, y: 47, width: 10, height: 18, rx: 5, fill: palette?.c2 || '#d99443' }),
          h('rect', { x: 20, y: 30, width: 60, height: 51, rx: 19, fill: palette?.c1 || '#efb55d' }),
          h('rect', { x: 28, y: 41, width: 44, height: 29, rx: 11, fill: '#26354b' }),
          h('circle', { cx: 40, cy: 53, r: 4, fill: palette?.bg || '#fff0c7' }),
          h('path', { d: 'M56 54 L60 50 L64 54', fill: 'none', stroke: palette?.bg || '#fff0c7', strokeWidth: 4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
          h('path', { d: 'M45 62 Q50 66 55 62', fill: 'none', stroke: palette?.bg || '#fff0c7', strokeWidth: 3, strokeLinecap: 'round' }),
        ],
      },
      {
        id: 'bot-circuit',
        label: '电路',
        bg: '#e6f5ef',
        draw: (palette) => [
          h('path', { d: 'M36 17 V25 M64 17 V25 M17 39 H25 M17 61 H25 M75 39 H83 M75 61 H83 M36 75 V83 M64 75 V83', stroke: palette?.c2 || '#429d8d', strokeWidth: 6, strokeLinecap: 'round' }),
          h('rect', { x: 22, y: 22, width: 56, height: 56, rx: 13, fill: palette?.c1 || '#5bb5a1' }),
          h('rect', { x: 29, y: 30, width: 42, height: 40, rx: 9, fill: '#26354b' }),
          h('rect', { x: 36, y: 41, width: 8, height: 10, rx: 3, fill: palette?.bg || '#b8f1d7' }),
          h('rect', { x: 56, y: 41, width: 8, height: 10, rx: 3, fill: palette?.bg || '#b8f1d7' }),
          h('path', { d: 'M43 60 H57', stroke: palette?.bg || '#b8f1d7', strokeWidth: 4, strokeLinecap: 'round' }),
        ],
      },
      {
        id: 'bot-pixel',
        label: '像素',
        bg: '#fff0ec',
        draw: (palette) => [
          h('path', { d: 'M45 13 H55 V25 H70 V32 H80 V43 H87 V62 H80 V75 H69 V82 H31 V75 H20 V62 H13 V43 H20 V32 H30 V25 H45 Z', fill: palette?.c1 || '#dc877c' }),
          h('path', { d: 'M34 36 H66 V43 H73 V65 H66 V72 H34 V65 H27 V43 H34 Z', fill: '#26354b' }),
          h('rect', { x: 35, y: 46, width: 10, height: 10, fill: palette?.bg || '#ffe6cb' }),
          h('rect', { x: 55, y: 46, width: 10, height: 10, fill: palette?.bg || '#ffe6cb' }),
          h('rect', { x: 44, y: 62, width: 12, height: 4, fill: palette?.bg || '#ffe6cb' }),
        ],
      },
      {
        id: 'bot-scout',
        label: '侦察',
        bg: '#e9f3fd',
        draw: (palette) => [
          h('path', { d: 'M63 30 L72 17', stroke: palette?.c2 || '#4d88b8', strokeWidth: 5, strokeLinecap: 'round' }),
          h('circle', { cx: 74, cy: 14, r: 6, fill: palette?.accent || '#efb55d' }),
          h('rect', { x: 10, y: 44, width: 12, height: 20, rx: 6, fill: palette?.c2 || '#4d88b8' }),
          h('rect', { x: 78, y: 44, width: 12, height: 20, rx: 6, fill: palette?.c2 || '#4d88b8' }),
          h('rect', { x: 19, y: 29, width: 62, height: 49, rx: 23, fill: palette?.c1 || '#78add5' }),
          h('rect', { x: 26, y: 38, width: 48, height: 30, rx: 15, fill: '#26354b' }),
          h('circle', { cx: 41, cy: 53, r: 10, fill: palette?.bg || '#b9e8ef' }),
          h('circle', { cx: 41, cy: 53, r: 5, fill: '#26354b' }),
          h('path', { d: 'M59 52 H64', stroke: palette?.bg || '#b9e8ef', strokeWidth: 5, strokeLinecap: 'round' }),
        ],
      },
      {
        id: 'bot-assistant',
        label: '助理',
        bg: '#f9edf3',
        draw: (palette) => [
          h('path', { d: 'M19 52 V43 A31 31 0 0 1 81 43 V54', fill: 'none', stroke: palette?.c2 || '#7b668e', strokeWidth: 7, strokeLinecap: 'round' }),
          h('rect', { x: 24, y: 26, width: 52, height: 54, rx: 22, fill: palette?.c1 || '#cb98b4' }),
          h('rect', { x: 30, y: 38, width: 40, height: 28, rx: 12, fill: '#26354b' }),
          h('path', { d: 'M39 49 V53 M60 49 V53', stroke: palette?.bg || '#ffe7f2', strokeWidth: 5, strokeLinecap: 'round' }),
          h('rect', { x: 12, y: 44, width: 12, height: 22, rx: 6, fill: palette?.c2 || '#7b668e' }),
          h('rect', { x: 76, y: 44, width: 12, height: 22, rx: 6, fill: palette?.c2 || '#7b668e' }),
          h('path', { d: 'M82 61 V68 Q82 73 73 73 H57', fill: 'none', stroke: palette?.c2 || '#7b668e', strokeWidth: 5, strokeLinecap: 'round' }),
          h('rect', { x: 48, y: 69, width: 14, height: 8, rx: 4, fill: '#26354b' }),
        ],
      },
      {
        id: 'bot-core',
        label: '智核',
        bg: '#e7f4f3',
        draw: (palette) => [
          h('path', { d: 'M50 13 L80 30 V68 L50 86 L20 68 V30 Z', fill: palette?.c1 || '#509d9b' }),
          h('path', { d: 'M50 22 L72 35 V63 L50 76 L28 63 V35 Z', fill: '#26354b' }),
          h('path', { d: 'M38 43 V51 M62 43 V51', stroke: palette?.bg || '#a9eee0', strokeWidth: 6, strokeLinecap: 'round' }),
          h('path', { d: 'M43 61 H57', stroke: palette?.bg || '#a9eee0', strokeWidth: 4, strokeLinecap: 'round' }),
          h('circle', { cx: 50, cy: 21, r: 4, fill: palette?.accent || '#e7c47a' }),
          h('path', { d: 'M12 43 V57 M88 43 V57', stroke: palette?.c1 || '#509d9b', strokeWidth: 5, strokeLinecap: 'round' }),
        ],
      },
      {
        id: 'bot-android',
        label: '仿生',
        bg: '#eff0fb',
        draw: (palette) => [
          h('path', { d: 'M18 88 V81 Q18 65 38 65 H62 Q82 65 82 81 V88 Z', fill: palette?.c2 || '#7d8ac5' }),
          h('rect', { x: 43, y: 58, width: 14, height: 15, rx: 5, fill: palette?.c2 || '#536491' }),
          h('rect', { x: 27, y: 14, width: 46, height: 49, rx: 20, fill: palette?.c1 || '#a0addd' }),
          h('rect', { x: 34, y: 26, width: 32, height: 26, rx: 13, fill: '#26354b' }),
          h('path', { d: 'M42 36 V41 M58 36 V41', stroke: palette?.bg || '#e2e9ff', strokeWidth: 4, strokeLinecap: 'round' }),
          h('path', { d: 'M38 71 L50 81 L62 71', fill: 'none', stroke: palette?.bg || '#dce3fc', strokeWidth: 4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
          h('circle', { cx: 50, cy: 81, r: 4, fill: '#26354b' }),
        ],
      },
    ];

    // Small reusable members keep each group composition visually consistent.
    function artGroupRobot(x, y, size, color) {
      return h('g', { transform: 'translate(' + x + ' ' + y + ') scale(' + size / 40 + ')' },
        h('path', { d: 'M20 3 V10', stroke: color, strokeWidth: 4, strokeLinecap: 'round' }),
        h('circle', { cx: 20, cy: 3, r: 3, fill: color }),
        h('rect', { x: 0, y: 9, width: 40, height: 30, rx: 10, fill: color }),
        h('rect', { x: 6, y: 16, width: 28, height: 17, rx: 6, fill: '#26354b' }),
        h('circle', { cx: 13, cy: 24, r: 3, fill: '#eefaf6' }),
        h('circle', { cx: 27, cy: 24, r: 3, fill: '#eefaf6' }),
      );
    }

    function artGroupPerson(x, y, size, color) {
      return h('g', { transform: 'translate(' + x + ' ' + y + ') scale(' + size / 40 + ')' },
        h('circle', { cx: 20, cy: 11, r: 10, fill: color }),
        h('path', { d: 'M2 48 V42 C2 31 10 26 20 26 C30 26 38 31 38 42 V48 Z', fill: '#26354b' }),
        h('path', { d: 'M12 28 L20 37 L28 28', fill: color }),
      );
    }

    const GROUP_ART_AVATARS = [
      {
        id: 'group-team',
        label: '团队',
        bg: '#eeedfb',
        draw: () => [
          artGroupPerson(8, 24, 31, '#b2a0dc'),
          artGroupPerson(61, 24, 31, '#83b9b0'),
          h('path', { d: 'M28 84 V66 Q28 53 50 53 Q72 53 72 66 V84 Z', fill: '#eeedfb' }),
          artGroupPerson(30, 29, 40, '#8d7ac6'),
        ],
      },
      {
        id: 'group-bots',
        label: '机友',
        bg: '#eaf3fc',
        draw: () => [
          artGroupRobot(12, 20, 45, '#78add5'),
          h('rect', { x: 41, y: 42, width: 47, height: 38, rx: 13, fill: '#eaf3fc' }),
          artGroupRobot(44, 40, 44, '#8b83c8'),
        ],
      },
      {
        id: 'group-network',
        label: '互联',
        bg: '#e6f4ef',
        draw: () => [
          h('path', { d: 'M50 30 L25 69 H75 Z', fill: 'none', stroke: '#90bcae', strokeWidth: 5, strokeLinejoin: 'round' }),
          artGroupRobot(33, 10, 34, '#57aa95'),
          artGroupRobot(8, 53, 34, '#7f9ac5'),
          artGroupRobot(58, 53, 34, '#8d83c6'),
        ],
      },
      {
        id: 'group-dialogue',
        label: '对话',
        bg: '#fff1e8',
        draw: () => [
          h('path', { d: 'M17 18 H51 Q58 18 58 25 V47 Q58 54 51 54 H34 L23 64 V54 H17 Q10 54 10 47 V25 Q10 18 17 18 Z', fill: '#dba16d' }),
          h('rect', { x: 17, y: 27, width: 34, height: 19, rx: 7, fill: '#26354b' }),
          h('circle', { cx: 27, cy: 36, r: 3, fill: '#ffe9d0' }),
          h('circle', { cx: 41, cy: 36, r: 3, fill: '#ffe9d0' }),
          h('path', { d: 'M48 43 H83 Q90 43 90 50 V72 Q90 79 83 79 H78 V89 L65 79 H48 Q41 79 41 72 V50 Q41 43 48 43 Z', fill: '#679f98', stroke: '#fff1e8', strokeWidth: 3, strokeLinejoin: 'round' }),
          h('rect', { x: 48, y: 52, width: 34, height: 19, rx: 7, fill: '#26354b' }),
          h('circle', { cx: 58, cy: 61, r: 3, fill: '#d5f4e9' }),
          h('circle', { cx: 72, cy: 61, r: 3, fill: '#d5f4e9' }),
        ],
      },
      {
        id: 'group-lab',
        label: '智研',
        bg: '#edf3fa',
        draw: () => [
          artGroupRobot(10, 17, 36, '#7c9cc8'),
          artGroupRobot(54, 17, 36, '#8a81c3'),
          h('path', { d: 'M42 52 V63 L30 81 Q27 87 35 87 H65 Q73 87 70 81 L58 63 V52', fill: '#26354b', stroke: '#edf3fa', strokeWidth: 4, strokeLinejoin: 'round' }),
          h('path', { d: 'M40 73 H60 L66 83 H34 Z', fill: '#79c6b8' }),
          h('path', { d: 'M40 52 H60', stroke: '#26354b', strokeWidth: 5, strokeLinecap: 'round' }),
        ],
      },
      {
        id: 'group-huddle',
        label: '围坐',
        bg: '#faf0e6',
        draw: () => [
          artGroupPerson(35, 11, 30, '#cb9b6e'),
          artGroupPerson(8, 34, 30, '#8fa58b'),
          artGroupPerson(62, 34, 30, '#aa8fb2'),
          h('ellipse', { cx: 50, cy: 70, rx: 29, ry: 17, fill: '#faf0e6' }),
          h('ellipse', { cx: 50, cy: 70, rx: 25, ry: 13, fill: '#c29f7e' }),
          h('ellipse', { cx: 50, cy: 67, rx: 25, ry: 11, fill: '#e3c6a7' }),
        ],
      },
      {
        id: 'group-swarm',
        label: '集群',
        bg: '#eaf4f4',
        draw: () => [
          h('path', { d: 'M32 32 H68 V69 H32 Z', fill: 'none', stroke: '#9dc1bf', strokeWidth: 4, strokeLinejoin: 'round' }),
          artGroupRobot(13, 12, 34, '#6caaa6'),
          artGroupRobot(53, 12, 34, '#83a0c9'),
          artGroupRobot(13, 52, 34, '#8e87bd'),
          artGroupRobot(53, 52, 34, '#6caaa6'),
        ],
      },
      {
        id: 'group-community',
        label: '社区',
        bg: '#f7edf3',
        draw: () => [
          h('path', { d: 'M20 38 A32 32 0 0 1 80 38 M20 66 Q50 94 80 66', fill: 'none', stroke: '#d4bbd0', strokeWidth: 5, strokeLinecap: 'round' }),
          artGroupPerson(10, 33, 32, '#bf91ae'),
          artGroupPerson(58, 33, 32, '#91aaa5'),
          h('rect', { x: 29, y: 27, width: 42, height: 40, rx: 12, fill: '#f7edf3' }),
          artGroupRobot(32, 25, 36, '#9385bd'),
        ],
      },
    ];
    const ART_MAP = Object.fromEntries([...ART_AVATARS, ...BOT_ART_AVATARS, ...GROUP_ART_AVATARS].map((art) => [art.id, art]));

    function parseArtAvatar(value) {
      const match = /^art:([a-z0-9-]+)(?::([a-z0-9-]+))?$/.exec(value);
      if (!match || !Object.hasOwn(ART_MAP, match[1])) return null;
      const paletteId = match[2];
      if (paletteId && (!match[1].startsWith('bot-') || !ROBOT_PALETTES.some(palette => palette.id === paletteId))) return null;
      return { id: match[1], paletteId };
    }

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
    function ArtAvatar({ id, paletteId, size = 22, radius = '50%' }) {
      const art = ART_MAP[id];
      if (!art) return null;
      const palette = ROBOT_PALETTES.find(entry => entry.id === paletteId);
      const background = palette?.bg || art.bg;
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
            background,
            border: '1px solid rgba(16,24,40,0.06)',
          },
        },
        h('rect', { width: 100, height: 100, fill: background }),
        h('g', null, ...art.draw(palette)),
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
        rawTitle: true,
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
        return h('img', { src: avatar, alt: label, rawTitle: true, style: S.avatarImage(size) });
      }
      if (avatar.startsWith('art:')) {
        const art = parseArtAvatar(avatar);
        if (art) return h(ArtAvatar, { ...art, size });
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
        content = h('img', { src: avatar, alt: title, rawTitle: true, style: S.groupAvatarImage(size) });
      } else if (avatar.startsWith('art:')) {
        const art = parseArtAvatar(avatar);
        if (art) content = h(ArtAvatar, { ...art, size, radius });
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
        { 'aria-hidden': true, title, rawTitle: true, style: { position: 'relative', display: 'inline-flex', flex: '0 0 auto' } },
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

    function ConversationDivider({ conversation, nextConversation, current, onViewLogs }) {
      const range = conversationRange(conversation, nextConversation, current);
      const [dismissed, setDismissed] = React.useState(false);
      const label = conversationLabel(conversation);
      const tooltipId = 'bt-conversation-time-' + conversation.conversationId;
      return h('div', { className: 'bt-conversation-divider', 'data-conversation-id': conversation.conversationId, 'data-current': !!current,
        role: 'group', 'aria-label': label + (current ? ' · ' + uiT('当前会话') : '') },
        h('div', { className: 'bt-conversation-meta', 'data-logs': !!onViewLogs },
          h('span', { className: 'bt-conversation-identity' }, h('strong', null, label),
            current ? h('span', { className: 'bt-conversation-current' }, '当前') : null),
          h('span', { className: 'bt-conversation-date', 'data-dismissed': dismissed,
            onMouseEnter: () => setDismissed(false), onFocus: () => setDismissed(false),
            onKeyDown: event => { if (event.key === 'Escape') { setDismissed(true); event.stopPropagation(); } } },
            h('span', { className: 'bt-conversation-dot', 'aria-hidden': true }, '·'),
            h('span', { className: 'bt-conversation-range', tabIndex: 0, 'aria-describedby': tooltipId },
              h(range.startTime ? 'time' : 'span', { dateTime: range.startTime }, range.startLabel),
              h('span', null, '–'), h(range.endTime ? 'time' : 'span', { dateTime: range.endTime }, range.endLabel)),
            h('span', { className: 'bt-conversation-tooltip', role: 'tooltip', id: tooltipId }, range.detail)),
          onViewLogs ? h('button', { type: 'button', className: 'bt-conversation-logs',
            'aria-label': uiT('查看{conversation}的日志', { conversation: label }), onClick: () => onViewLogs(conversation) },
            h('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
              strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false },
              h('path', { d: 'M9 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6zM9 2v4h4M6 9h4M6 11.5h3' })),
            '查看日志') : null));
    }

    function MessageList({ messages, unreadFromSeq, conversations, group, onViewConversationLogs, ...rest }) {
      let unreadShown = false;
      const rows = [];
      const entries = conversationTimeline(messages, conversations);
      const successors = new Map(entries.filter(entry => entry.conversation?.previousConversationId).map(entry => [entry.conversation.previousConversationId, entry.conversation]));
      entries.forEach((entry, index) => {
        if (entry.conversation) {
          rows.push(h(ConversationDivider, { key: 'conversation-' + entry.conversation.conversationId, conversation: entry.conversation,
            nextConversation: successors.get(entry.conversation.conversationId),
            current: entry.conversation.conversationId === currentConversationId(group), onViewLogs: onViewConversationLogs }));
          return;
        }
        const message = entry.message;
        const previous = entries[index - 1]?.message;
        const next = entries[index + 1]?.message;
        const currentAt = Number(message.createdAt || 0);
        const previousAt = previous ? Number(previous.createdAt || 0) : 0;
        const boundary = entries[index - 1]?.conversation;
        const boundaryDate = boundary && conversationDate(boundary.createdAt);
        const repeatsBoundary = boundaryDate && currentAt >= boundaryDate.getTime() && message.conversationId === boundary.conversationId &&
          Math.floor(currentAt / 60000) === Math.floor(boundaryDate.getTime() / 60000);
        const showTime = !repeatsBoundary &&
          (!previous || !sameDay(previous.createdAt, message.createdAt) || currentAt - previousAt >= 5 * 60 * 1000);
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
            historical: historicalMessage(message, group),
            groupStart: !canGroupMessages(previous, message),
            groupEnd: !canGroupMessages(message, next),
          }),
        );
      });
      return rows;
    }

    function ConversationLogsDialog({ target, onClose, onOpenSession }) {
      const [bindings, setBindings] = React.useState([]);
      const [cursor, setCursor] = React.useState(null);
      const [hasMore, setHasMore] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const alive = React.useRef(true);
      const inFlight = React.useRef(false);
      const load = async nextCursor => {
        if (inFlight.current) return;
        inFlight.current = true; setBusy(true); setError('');
        try {
          const page = await api.conversations(target.groupId, { conversationId: target.conversation.conversationId, cursor: nextCursor, limit: 100 });
          if (!alive.current) return;
          if (page.conversation?.conversationId !== target.conversation.conversationId) throw new Error(uiT('会话历史与所选会话不匹配'));
          setBindings(current => [...new Map([...current, ...(page.sessionBindings || [])].map(binding => [binding.bindingId || binding.sessionId, binding])).values()]);
          setCursor(page.nextCursor); setHasMore(page.hasMore === true);
        } catch (reason) { if (alive.current) setError(String(reason?.message || reason)); }
        finally { inFlight.current = false; if (alive.current) setBusy(false); }
      };
      React.useEffect(() => { alive.current = true; void load(null); return () => { alive.current = false; }; }, [target.groupId, target.conversation.conversationId]);
      return h(Modal, { title: conversationLabel(target.conversation) + ' · ' + uiT('查看本会话日志'), onClose },
        error ? h('div', { role: 'alert', style: S.errorBanner }, error) : null,
        !bindings.length && !busy && !error ? h('p', null, '本会话尚无日志') : null,
        bindings.map(binding => h('button', { key: binding.bindingId || binding.sessionId, type: 'button', style: { ...S.ghostBtn, display: 'block', width: '100%', marginBottom: 8 },
          onClick: () => onOpenSession(binding) }, h('strong', { raw: true }, binding.botNameSnapshot || binding.botId || 'Bot'),
          h('span', { raw: true }, ' · ' + binding.sessionId))),
        busy ? h('p', { role: 'status' }, '加载中…') : null,
        hasMore || error ? h('button', { type: 'button', style: S.ghostBtn, disabled: busy, onClick: () => void load(cursor) }, error ? '重试' : '加载更多日志') : null);
    }

    function backgroundAnswer(questions, drafts) {
      return { answers: questions.map(question => ({ id: question.id, selected: drafts[question.id]?.selected || [],
        ...(drafts[question.id]?.custom ? { custom: drafts[question.id].custom } : {}) })) };
    }

    function BackgroundInteractionCard({ interaction, onSnapshot }) {
      const [drafts, setDrafts] = React.useState({});
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const submitting = React.useRef(false);
      const active = React.useRef(true);
      React.useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
      const waiting = interaction.state === 'continuing' || interaction.state === 'queued';
      const submit = async (operation, extra = {}) => {
        if (submitting.current || waiting) return;
        submitting.current = true;
        setBusy(true);
        setError('');
        try {
          const data = await api.action('interaction.respond', { groupId: interaction.groupId, expectedConversationId: interaction.conversationId, sessionId: interaction.sessionId,
            interactionId: interaction.interactionId, operation, ...extra });
          if (active.current) onSnapshot(data);
        } catch (reason) { if (active.current) setError(reason.message || String(reason)); }
        finally { submitting.current = false; if (active.current) setBusy(false); }
      };
      const patch = (id, value) => setDrafts(current => ({ ...current, [id]: { ...current[id], ...value } }));
      const question = interaction.kind === 'question';
      return h('section', { style: { ...S.approvalCard, maxWidth: 'none', margin: '8px 0' }, 'aria-label': question ? 'Bot 提问' : '审批请求' },
        h('div', { style: S.approvalHead }, h('strong', { raw: true }, interaction.botName), h('span', null, question ? 'Bot 提问' : '审批请求')),
        interaction.state === 'continued' ? h('p', { style: S.approvalHint }, 'Bot 已继续执行，你仍可提交答案。') : null,
        question ? (interaction.questions || []).map(item => h('fieldset', { key: item.id, disabled: busy || waiting, style: { border: 0, padding: '6px 0', margin: 0, minWidth: 0 } },
          h('legend', { raw: true, style: { fontWeight: 600 } }, item.header || item.question),
          item.header ? h('p', { raw: true, style: { margin: '4px 0' } }, item.question) : null,
          item.detail ? h('pre', { raw: true, style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 200, overflow: 'auto' } }, item.detail) : null,
          (item.options || []).map(option => h('label', { key: option.label, style: { display: 'flex', alignItems: 'baseline', gap: 8, margin: '6px 0' } },
            h('input', { type: item.multiSelect ? 'checkbox' : 'radio', name: interaction.interactionId + ':' + item.id,
              checked: (drafts[item.id]?.selected || []).includes(option.label), onChange: event => {
                const previous = drafts[item.id]?.selected || [];
                patch(item.id, { selected: item.multiSelect ? (event.target.checked ? [...previous, option.label] : previous.filter(label => label !== option.label)) : [option.label] });
              } }), h('span', { raw: true }, option.label, option.description ? h('small', { raw: true, style: { display: 'block', color: 'var(--bt-text-3)' } }, option.description) : null))),
          h('textarea', { 'aria-label': uiT('补充答案：{question}', { question: item.header || item.question }), placeholder: '填写答案或补充说明',
            style: { ...S.input, width: '100%', minHeight: 54, boxSizing: 'border-box' },
            value: drafts[item.id]?.custom || '', onChange: event => patch(item.id, { custom: event.target.value }) }),
          h('button', { type: 'button', style: S.ghostBtn, onClick: () => patch(item.id, { selected: [], custom: '' }) }, '跳过此问题')))
          : h(React.Fragment, null, h('p', { raw: true, style: S.approvalText }, interaction.toolName),
            h('pre', { raw: true, style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 } }, interaction.reason)),
        error ? h('p', { role: 'alert', style: { color: 'var(--bt-danger)' } }, error) : null,
        waiting ? h('p', { role: 'status' }, interaction.state === 'queued' ? '答案已提交，等待 Bot 接收。' : '正在继续执行，请稍候。') : h('div', { style: S.approvalActions },
          h('button', { type: 'button', style: S.primaryBtn, disabled: busy, onClick: () => submit('answer',
            question ? { answer: backgroundAnswer(interaction.questions, drafts) } : { outcome: 'allowed-once' }) }, question ? '提交答案' : '允许一次'),
          question && interaction.timed && interaction.state === 'pending' ? h('button', { type: 'button', style: S.ghostBtn, disabled: busy, onClick: () => submit('continue') }, '稍后回答，继续执行') : null,
          interaction.state === 'pending' ? h('button', { type: 'button', style: S.ghostBtn, disabled: busy,
            onClick: () => question ? submit('cancel') : submit('answer', { outcome: 'rejected' }) }, question ? '取消提问' : '拒绝') : null,
          question ? h('span', { style: S.approvalHint }, '未选择或填写的问题会记为跳过。') : null));
    }

    function BackgroundInteractionPanel({ groupId, currentConversationId: activeConversationId, snapshot, refreshTick, dispatch }) {
      const [error, setError] = React.useState('');
      const [reload, setReload] = React.useState(0);
      const latestSnapshot = React.useRef(snapshot);
      latestSnapshot.current = snapshot;
      React.useEffect(() => {
        let active = true;
        const startedEpoch = latestSnapshot.current?.groupId === groupId ? latestSnapshot.current.epoch : null;
        setError('');
        api.action('interaction.list', { groupId }).then(data => {
          if (active) dispatch({ type: 'interactions', data, startedEpoch });
        }).catch(reason => { if (active) setError(reason.message || String(reason)); });
        return () => { active = false; };
      }, [groupId, refreshTick, reload, dispatch]);
      const interactions = snapshot?.groupId === groupId ? (snapshot.interactions || []).filter(item => !activeConversationId || item.conversationId === activeConversationId) : [];
      if (!error && !interactions?.length) return null;
      return h('div', { style: { padding: '0 18px', flexShrink: 0, maxHeight: '42vh', overflowY: 'auto' }, 'aria-label': '待处理交互' },
        error ? h('div', { role: 'alert' }, error, h('button', { type: 'button', style: S.ghostBtn, onClick: () => setReload(value => value + 1) }, '刷新交互')) : null,
        (interactions || []).map(interaction => h(BackgroundInteractionCard, { key: interaction.interactionId, interaction,
          onSnapshot: data => dispatch({ type: 'interactions', data, startedEpoch: snapshot.epoch }) })));
    }

    function renderApprovalRow({ message, bots, onOpenSession }) {
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
          h('div', { style: S.approvalText, raw: true }, translateSystemText(message.text)),
          state === 'pending' && meta.sessionId
            ? h(
                'div',
                { style: S.approvalActions },
                h('span', { style: S.approvalHint }, '请在本聊天顶部的待处理交互中回应；此卡片保留审批记录。'),
              )
            : null,
        ),
      );
    }
    function ApprovalRow(props) {
      const message = (props && props.message) || {};
      return withContent([message.text], () => renderApprovalRow(props));
    }


    function FileGlyph({ size = 16, style }) {
      return h(
        'svg',
        {
          viewBox: '0 0 20 20',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style,
        },
        h('path', { d: 'M5 2.5h6l4 4v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2Z' }),
        h('path', { d: 'M11 2.5v4h4' }),
      );
    }

    function SkillGlyph({ size = 16, style }) {
      return h(
        'svg',
        {
          viewBox: '0 0 20 20',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style,
        },
        h('path', { d: 'M10 2.2 11.7 7l4.8 1.7-4.8 1.7L10 15.2 8.3 10.4 3.5 8.7l4.8-1.7L10 2.2Z' }),
        h('path', { d: 'M15.8 13.2l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7.7-1.9Z' }),
      );
    }

    /** Small monochrome glyphs for the DSH-style + command menu. */
    function AddMenuGlyph({ name, size = 14 }) {
      if (name === 'file') return h(FileGlyph, { size });
      if (name === 'skill') return h(SkillGlyph, { size });
      if (name === 'mention') {
        return h('span', { style: { fontSize: 13, fontWeight: 600, lineHeight: 1 } }, '@');
      }
      const paths = {
        folder: [h('path', { key: 'p', d: 'M2.5 5a1.5 1.5 0 0 1 1.5-1.5h4l2 2h6A1.5 1.5 0 0 1 17.5 7v8a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 15Z' })],
        stop: [h('rect', { key: 'r', x: 5, y: 5, width: 10, height: 10, rx: 2 })],
        download: [
          h('path', { key: 'p1', d: 'M10 3v9' }),
          h('path', { key: 'p2', d: 'm6.5 8.5 3.5 3.5 3.5-3.5' }),
          h('path', { key: 'p3', d: 'M4 15.5h12' }),
        ],
        code: [
          h('path', { key: 'p1', d: 'm7 6-4 4 4 4' }),
          h('path', { key: 'p2', d: 'm13 6 4 4-4 4' }),
        ],
        settings: [
          h('path', { key: 'p1', d: 'M4 6h12M4 10h12M4 14h12' }),
          h('circle', { key: 'c1', cx: 7, cy: 6, r: 1.6, fill: 'currentColor', stroke: 'none' }),
          h('circle', { key: 'c2', cx: 13, cy: 10, r: 1.6, fill: 'currentColor', stroke: 'none' }),
          h('circle', { key: 'c3', cx: 9, cy: 14, r: 1.6, fill: 'currentColor', stroke: 'none' }),
        ],
      };
      return h(
        'svg',
        {
          viewBox: '0 0 20 20',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        paths[name] || [],
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
        execution: [
          h('path', { key: 'p', d: 'M5 4v12M9 5h6M9 10h6M9 15h6' }),
          h('circle', { key: 'c', cx: 5, cy: 10, r: 2 }),
        ],
        delete: [
          h('path', { key: 'p1', d: 'M4 6h12M8 6V4h4v2M5.5 6l.8 10h7.4l.8-10' }),
          h('path', { key: 'p2', d: 'M8.5 9v4M11.5 9v4' }),
        ],
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
      if (model) {
        const modelTitle = uiT('模型：{provider}{model}', { provider: provider ? provider + ' / ' : '', model });
        add('model', model, modelTitle + (effort ? ' · reasoning ' + effort : ''));
      }
      const usage = message.usage || {};
      const validTokens = value => Number.isSafeInteger(value) && value >= 0;
      if (validTokens(usage.inputTokens)) add('inputTokens', `↑ ${formatTokens(usage.inputTokens)}`, uiT('最近一次上报的输入 Token（非本轮累计）：{count}', { count: usage.inputTokens }));
      if (validTokens(usage.outputTokens)) add('outputTokens', `↓ ${formatTokens(usage.outputTokens)}`, uiT('最近一次上报的输出 Token（非本轮累计）：{count}', { count: usage.outputTokens }));
      const stats = message.generationStats;
      if (message.status === 'done' && stats?.scope === 'last-request' && Number.isFinite(stats.durationMs) && stats.durationMs > 0
          && validTokens(stats.outputTokens) && stats.outputTokens === usage.outputTokens) {
        const speed = stats.outputTokens * 1000 / stats.durationMs;
        if (Number.isFinite(speed) && speed >= 0) {
          add('speed', `${speed > 0 && speed < 0.1 ? '< 0.1' : speed.toFixed(1)} tok/s`,
            uiT('最近一次模型请求平均速度：输出 {tokens} Token / {seconds} 秒。包含等待与思考，不含工具执行；非纯解码速度。', {
              tokens: stats.outputTokens,
              seconds: (stats.durationMs / 1000).toFixed(2),
            }));
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

    function renderMessageRow({
      message,
      groupStart,
      groupEnd,
      historical = false,
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
        const systemText = translateSystemText(message.text);
        return h(
          'div',
          { className: 'bt-system-row', style: S.systemRow },
          h('span', { style: S.systemPill, raw: true }, kindLabel ? `[${uiT(kindLabel)}] ${systemText}` : systemText),
        );
      }
      const mine = !!(message.author && message.author.type === 'human');
      const profile = mine ? userProfile : null;
      const botId = message.author && message.author.botId;
      const color = mine ? '#3370ff' : colorOfBot(bots, botId);
      const authorBot = botId ? (bots || []).find((candidate) => candidate.botId === botId) : null;
      const messageAuthorName = message.author && message.author.name;
      const name = mine
        ? (profile && profile.name) || uiT('我')
        : (authorBot && authorBot.name) || (messageAuthorName === '用户' ? uiT('用户') : messageAuthorName) || nameOfBot(bots, botId);
      const userAvatarUrl = mine && profile && profile.avatarUrl ? profile.avatarUrl : '';
      const streaming = message.status === 'pending' || message.status === 'streaming';
      const meta = message.meta || {};
      const target = meta.reviewOf ? (allMessages || []).find((candidate) => candidate.messageId === meta.reviewOf) : null;
      const task = meta.taskId ? (tasks || []).find((candidate) => candidate.taskId === meta.taskId) : null;
      const quoted = replyQuoteOf(message, allMessages);
      const showTyping = streaming && !message.text;
      const messageAttachments = Array.isArray(message.attachments)
        ? message.attachments.filter((attachment) => attachment && attachment.name)
        : [];
      const actions = messageActionList({
        message,
        mine,
        streaming,
        meta,
        hasQuoted: !!quoted,
        historical,
        onReply,
        onCopy,
        onCopyQuote,
        onJumpToMessage,
        onReview,
        onRevise,
        onRetry,
      }).filter((action) => action.hover !== false && !action.disabled);

      const footer = [];
      if (meta.round) footer.push(h('span', { key: 'round', style: badgeStyle('#eef2ff', '#4f46e5') }, uiT('第 {round} 轮', { round: meta.round })));
      if (meta.summary) footer.push(h('span', { key: 'summary', style: badgeStyle('#ecfdf5', '#047857') }, '总结'));
      if (meta.verdict === 'pass') footer.push(h('span', { key: 'pass', style: badgeStyle('#ecfdf5', '#047857') }, '评审通过'));
      if (meta.verdict === 'changes') footer.push(h('span', { key: 'changes', style: badgeStyle('#fffbeb', '#b45309') }, '需修改'));
      if (target) footer.push(h('span', { key: 'target', style: badgeStyle('#f3f4f6', '#667085') }, uiT('评审 #{seq}', { seq: target.seq })));
      if (task) {
        footer.push(
          h(
            'span',
            { key: 'task', style: { ...badgeStyle('#eef2ff', '#4f46e5'), maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            uiT('任务 · {title} · {status}', { title: task.title, status: uiT(TASK_STATUS_LABEL[task.status] || task.status) }),
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
            uiT('错误：{error}', { error: message.error }),
          ),
        );
      }

      return h(
        'div',
        {
          className: 'bt-msg',
          'data-message-id': message.messageId,
          tabIndex: -1,
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
                h('span', { style: S.msgAuthor, raw: true }, name),
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
                    h('span', { style: S.replyQuoteName, raw: true }, displayNameOf(quoted, bots, userProfile)),
                    h('span', { style: S.replyQuoteText, raw: true }, cleanPreview(quoted.text, 96) || uiT('[消息]')),
                  )
                : null,
              messageAttachments.length > 0
                ? h(
                    'div',
                    { style: S.messageAttachments },
                    messageAttachments.map((attachment, index) =>
                      h(
                        'div',
                        {
                          key: attachment.attachmentId + ':' + attachment.name + ':' + index,
                          style: S.messageAttachment(mine),
                          title: attachment.path || attachment.name,
                          rawTitle: true,
                        },
                        h(FileGlyph, { size: 15, style: { flex: '0 0 auto', opacity: 0.82 } }),
                        h(
                          'span',
                          { style: S.messageAttachmentBody },
                          h('span', { style: S.messageAttachmentName, raw: true }, attachment.name),
                          h(
                            'span',
                            { style: S.messageAttachmentMeta },
                            [formatFileSize(attachment.bytes), '只读附件'].filter(Boolean).join(' · '),
                          ),
                        ),
                      ),
                    ),
                  )
                : null,
              showTyping
                ? h('div', { style: S.typingBubble }, h(TypingDots))
                : message.text
                  ? h(
                      'div',
                      { className: 'bt-rich', style: { ...S.msgText, color: message.status === 'error' ? '#b42318' : 'inherit' } },
                      withRaw(() => renderMarkdown(message.text, { own: mine })),
                      streaming ? h('span', { className: 'bt-cursor' }) : null,
                    )
                  : null,
            ),
          ),
          footer.length > 0 ? h('div', { className: 'bt-msg-footer', style: S.msgFooter(mine) }, footer) : null,
        ),
      );
    }
    function MessageRow(props) {
      return renderMessageRow(props);
    }


    function MessageContextMenu({
      menu,
      group,
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
      onExecution,
      onDelete,
    }) {
      // Prefer the live message so a streaming reply enables/disables menu items
      // as it finishes; fall back to the snapshot taken when the menu opened.
      const message = (allMessages || []).find((candidate) => candidate.messageId === menu.message.messageId) || menu.message;
      const historical = historicalMessage(message, group);
      const mine = !!(message.author && message.author.type === 'human');
      const streaming = message.status === 'pending' || message.status === 'streaming';
      const quoted = replyQuoteOf(message, allMessages);
      const actions = messageActionList({
        message,
        mine,
        streaming,
        meta: message.meta || {},
        hasQuoted: !!quoted,
        historical,
        onReply,
        onCopy,
        onCopyQuote,
        onJumpToMessage,
        onReview,
        onRevise,
        onRetry,
        onExecution,
        onDelete,
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

    function ProjectWorkspaceDialog({ group, locked, onClose, onSaved }) {
      const [directory, setDirectory] = React.useState(group.projectWorkspaceCwd || '');
      const [busy, setBusy] = React.useState(false);
      const [picking, setPicking] = React.useState(false);
      const [error, setError] = React.useState('');
      const busyRef = React.useRef(false);
      const pickingRef = React.useRef(false);
      const aliveRef = React.useRef(true);
      React.useEffect(() => {
        aliveRef.current = true;
        return () => { aliveRef.current = false; };
      }, []);

      const choose = async () => {
        if (locked || busyRef.current || pickingRef.current) return;
        pickingRef.current = true;
        setPicking(true);
        setError('');
        try {
          const selected = await pickProjectDirectory();
          // null means cancel. Keep the draft and never open a second picker.
          if (aliveRef.current && typeof selected === 'string' && selected.trim()) setDirectory(selected);
        } catch (reason) {
          if (aliveRef.current) setError(uiT('无法打开目录选择器，请填写路径：{error}', { error: String(reason && reason.message ? reason.message : reason) }));
        } finally {
          pickingRef.current = false;
          if (aliveRef.current) setPicking(false);
        }
      };

      const submit = async () => {
        if (locked || busyRef.current || pickingRef.current || !directory.trim()) return;
        busyRef.current = true;
        setBusy(true);
        setError('');
        try {
          const result = await api.action('group.workspace.set', { groupId: group.groupId, expectedConversationId: currentConversationId(group), workspaceCwd: directory.trim() });
          if (!result.result || result.result.groupId !== group.groupId) throw new Error(uiT('Host 未返回项目工作目录'));
          if (aliveRef.current) onSaved(result.result);
        } catch (reason) {
          if (aliveRef.current) setError(uiT(String(reason && reason.message ? reason.message : reason)));
        } finally {
          busyRef.current = false;
          if (aliveRef.current) setBusy(false);
        }
      };
      const close = () => { if (!busyRef.current) onClose(); };
      return h(Modal, {
        title: '引入文件夹 / 项目',
        subtitle: 'Bot 将在这个文件夹中检索文件，并按你的任务读取、修改和运行项目。',
        width: 580,
        onClose: close,
        footer: [
          h('button', { key: 'cancel', type: 'button', style: S.ghostBtn, disabled: busy, onClick: close }, '取消'),
          h('button', { key: 'save', type: 'button', style: S.primaryBtn, disabled: busy || picking || locked || !directory.trim(), onClick: () => void submit() }, busy ? '正在引入…' : '引入项目'),
        ],
      },
        error ? h('div', { role: 'alert', style: { ...S.errorBanner, borderRadius: 8, marginBottom: 12 }, raw: true }, error) : null,
        locked ? h('div', { role: 'status', style: S.fieldHint }, '任务结束后可切换项目文件夹') : null,
        h(Field, { label: '项目文件夹', required: true, hint: '选择或填写运行 DSH 的电脑上的文件夹绝对路径。' },
          h('input', {
            className: 'bt-project-path', style: S.input, value: directory,
            placeholder: '/Users/you/project', 'aria-label': '项目文件夹路径', autoFocus: true,
            disabled: busy || picking || locked, autoComplete: 'off', spellCheck: false,
            onChange: (event) => { setDirectory(event.target.value); setError(''); },
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.nativeEvent?.isComposing) { event.preventDefault(); void submit(); }
            },
          }),
          h('button', { type: 'button', style: { ...S.ghostBtn, marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 6 }, disabled: busy || picking || locked, onClick: () => void choose() },
            h(AddMenuGlyph, { name: 'folder', size: 15 }), picking ? '正在选择…' : '选择文件夹…')),
        h('div', { style: S.fieldHint }, '引入后对当前聊天持续生效。可在输入框更换或移除项目；移除会恢复默认工作目录，项目文件保留。'),
      );
    }

    function renderComposer({
      state,
      dispatch,
      group,
      members,
      bots,
      replyTarget,
      userProfile,
      onClearReply,
      onSent,
      onResize,
      onExportMarkdown,
      onExportHtml,
      onExportPdf,
      onOpenSettings,
      conversationControlRef,
      onConversationStarted,
      active = true,
    }) {
      const isDirect = !!(group && group.kind === 'direct');
      const textareaRef = React.useRef(null);
      const shellRef = React.useRef(null);
      const fileInputRef = React.useRef(null);
      const addMenuRef = React.useRef(null);
      const onResizeRef = React.useRef(onResize);
      onResizeRef.current = onResize;
      const [text, setTextState] = React.useState('');
      const [mentions, setMentionsState] = React.useState([]);
      const [picker, setPicker] = React.useState(null);
      const [pickerIndex, setPickerIndex] = React.useState(0);
      const [sending, setSending] = React.useState(false);
      const [draftAttachments, setDraftAttachmentsState] = React.useState([]);
      const draftsRef = React.useRef(new Map());
      const draftRef = React.useRef({ groupId: group?.groupId, conversationId: currentConversationId(group), revision: 0, text: '', mentions: [], attachments: [] });
      const inFlightRef = React.useRef(null);
      const groupRef = React.useRef(group);
      groupRef.current = group;
      const replyTargetRef = React.useRef(replyTarget);
      replyTargetRef.current = replyTarget;
      const [draftConversationId, setDraftConversationId] = React.useState(currentConversationId(group));
      const updateDraft = (key, value, setter) => {
        const draft = draftRef.current;
        const next = typeof value === 'function' ? value(draft[key]) : value;
        if (next !== draft[key]) { draft[key] = next; draft.revision += 1; }
        setter(next);
      };
      const setText = value => updateDraft('text', value, setTextState);
      const setMentions = value => updateDraft('mentions', value, setMentionsState);
      const setDraftAttachments = value => updateDraft('attachments', value, setDraftAttachmentsState);
      const bindDraft = id => { draftRef.current.conversationId = id; setDraftConversationId(id); };
      const draftIsStale = !!(currentConversationId(group) && draftConversationId !== currentConversationId(group));
      const [addMenuOpen, setAddMenuOpen] = React.useState(false);
      React.useEffect(() => {
        if (!active) { setAddMenuOpen(false); setPicker(null); }
      }, [active]);
      const [skillCatalog, setSkillCatalog] = React.useState([]);
      const [skillLoading, setSkillLoading] = React.useState(false);
      const [skillError, setSkillError] = React.useState(null);
      const [skillReason, setSkillReason] = React.useState('');
      const [projectDialogOpen, setProjectDialogOpen] = React.useState(false);
      const [workspaceSaving, setWorkspaceSaving] = React.useState(false);
      const workspaceSavingRef = React.useRef(false);
      const projectCwd = (group && group.projectWorkspaceCwd) || '';
      const workspaceLocked = !!(group && (group.running || group.activeDiscussion?.status === 'running'))
        || members.some((member) => member.running || ['running', 'queued'].includes(state.statusByMember[member.membershipId]))
        || state.discussions?.[group && group.groupId]?.status === 'running';

      const groupIdRef = React.useRef(group && group.groupId);
      groupIdRef.current = group && group.groupId;
      const skillCatalogRef = React.useRef([]);
      skillCatalogRef.current = skillCatalog;
      const skillLoadedGroupRef = React.useRef(null);
      const skillLoadRef = React.useRef(null);
      const skillLoadIdRef = React.useRef(0);
      const skillLoadingRef = React.useRef(false);
      skillLoadingRef.current = skillLoading;
      const skillErrorRef = React.useRef(null);
      skillErrorRef.current = skillError;
      const skillReasonRef = React.useRef('');
      skillReasonRef.current = skillReason;
      const draftCountRef = React.useRef(0);
      draftCountRef.current = draftAttachments.length;
      const draftTextRef = React.useRef(text);
      draftTextRef.current = text;
      const draftMentionsRef = React.useRef(mentions);
      draftMentionsRef.current = mentions;
      // The @ token this composer inserted for the current reply target, so a
      // new target can replace it without touching anything the user typed.
      const autoReplyMentionRef = React.useRef(null);

      const memberEntries = members
        .map((member) => ({ member, bot: bots.find((candidate) => candidate.botId === member.botId) }))
        .filter((entry) => entry.bot);
      const readyAttachments = draftAttachments
        .filter((item) => item.status === 'ready' && item.attachment)
        .map((item) => item.attachment);
      const attachmentsPending = draftAttachments.some((item) => item.status !== 'ready');
      const command = parseBuiltinCommand(text);
      const canSend = !sending && !workspaceSaving && !draftIsStale && !group?.conversationStateConflict && (!attachmentsPending || !!command) && (text.trim() !== '' || readyAttachments.length > 0);

      React.useEffect(() => {
        const node = textareaRef.current;
        if (!node) return;
        node.style.height = 'auto';
        const next = Math.min(Math.max(node.scrollHeight, 44), 180);
        node.style.height = next + 'px';
        node.style.overflowY = node.scrollHeight > 180 ? 'auto' : 'hidden';
      }, [text]);

      // Replying in a group defaults to @-mentioning the bot that wrote the
      // quoted message. Group chats only dispatch mentioned bots, so without
      // this the reply would not reach the bot the user is answering.
      React.useEffect(() => {
        if (!replyTarget) return;
        if (replyTarget.groupId && group && replyTarget.groupId !== group.groupId) return;
        const node = textareaRef.current;
        if (node) node.focus();
        if (isDirect) return;
        const result = applyReplyMention({
          text: draftTextRef.current,
          mentions: draftMentionsRef.current,
          entry: replyMentionOf(replyTarget, members, bots),
          auto: autoReplyMentionRef.current,
        });
        autoReplyMentionRef.current = result.auto;
        if (result.text !== draftTextRef.current) {
          draftTextRef.current = result.text;
          setText(result.text);
          // The inserted prefix shifts any open @ / Skill trigger offsets.
          setPicker(null);
          setPickerIndex(0);
        }
        if (result.mentions !== draftMentionsRef.current) {
          draftMentionsRef.current = result.mentions;
          setMentions(result.mentions);
        }
        if (result.caret !== null) {
          const caret = result.caret;
          requestAnimationFrame(() => {
            const target = textareaRef.current;
            if (!target) return;
            target.focus();
            target.setSelectionRange(caret, caret);
          });
        }
      }, [replyTarget && replyTarget.messageId, group && group.groupId, isDirect]);

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

      // Cache each chat independently; a late request can only consume its own draft.
      React.useEffect(() => {
        if (draftRef.current.groupId !== group?.groupId) {
          draftsRef.current.set(draftRef.current.groupId, draftRef.current);
          const saved = draftsRef.current.get(group?.groupId) || { groupId: group?.groupId, conversationId: currentConversationId(group), revision: 0, text: '', mentions: [], attachments: [] };
          draftRef.current = saved;
          setTextState(saved.text);
          setMentionsState(saved.mentions);
          setDraftAttachmentsState(saved.attachments);
          setDraftConversationId(saved.conversationId);
          autoReplyMentionRef.current = null;
        }
        setAddMenuOpen(false);
        setProjectDialogOpen(false);
        setWorkspaceSaving(false);
        workspaceSavingRef.current = false;
        setPicker(null);
        setPickerIndex(0);
      }, [group && group.groupId]);

      React.useEffect(() => {
        const draft = draftRef.current;
        if (draft.groupId !== group?.groupId || draft.conversationId === currentConversationId(group)) return;
        if (!draft.text.trim() && !draft.attachments.length && !draft.mentions.length && !replyTargetRef.current) bindDraft(currentConversationId(group));
      }, [group?.groupId, currentConversationId(group), text, draftAttachments.length, mentions.length, replyTarget?.messageId]);

      // The skill catalog is workspace-scoped: switching chats, moving the
      // workspace, or changing the roster invalidates it.
      React.useEffect(() => {
        setSkillCatalog([]);
        setSkillLoading(false);
        setSkillError(null);
        setSkillReason('');
        skillCatalogRef.current = [];
        skillLoadedGroupRef.current = null;
        skillLoadRef.current = null;
        skillLoadIdRef.current += 1;
        setPicker((current) => (current && current.kind === 'skill' ? null : current));
      }, [group && group.groupId, group && group.workspaceCwd, members.length]);

      const closeAddMenu = () => {
        setAddMenuOpen(false);
        const node = textareaRef.current;
        if (node) node.focus();
      };

      const runAddMenuAction = (action) => {
        if (!action || action.disabled) return;
        closeAddMenu();
        action.run();
      };

      const onAddMenuKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeAddMenu();
          return;
        }
        if (event.key === 'Tab') {
          event.preventDefault();
          closeAddMenu();
          return;
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        if (typeof document === 'undefined') return;
        const node = addMenuRef.current;
        if (!node || typeof node.querySelectorAll !== 'function') return;
        const items = Array.from(node.querySelectorAll('[role="menuitem"]:not([disabled])'));
        if (!items.length) return;
        event.preventDefault();
        const current = items.indexOf(document.activeElement);
        const next = event.key === 'ArrowDown' ? (current + 1) % items.length : (current - 1 + items.length) % items.length;
        if (items[next] && typeof items[next].focus === 'function') items[next].focus();
      };

      React.useEffect(() => {
        if (!active || !addMenuOpen) return undefined;
        const node = addMenuRef.current;
        const first = node && typeof node.querySelector === 'function'
          ? node.querySelector('[role="menuitem"]:not([disabled])')
          : null;
        if (first && typeof first.focus === 'function') first.focus();
        const onEscape = (event) => {
          if (event.key !== 'Escape') return;
          closeAddMenu();
        };
        document.addEventListener('keydown', onEscape);
        return () => document.removeEventListener('keydown', onEscape);
      }, [addMenuOpen, active]);

      const ensureSkills = (force) => {
        const groupId = group && group.groupId;
        if (!groupId) return Promise.resolve([]);
        if (!force && skillLoadedGroupRef.current === groupId && !skillLoadRef.current) {
          return Promise.resolve(skillCatalogRef.current);
        }
        if (!force && skillLoadRef.current) return skillLoadRef.current;
        const loadId = skillLoadIdRef.current + 1;
        skillLoadIdRef.current = loadId;
        if (force) {
          skillLoadedGroupRef.current = null;
          skillLoadRef.current = null;
        }
        setSkillLoading(true);
        skillLoadingRef.current = true;
        setSkillError(null);
        skillErrorRef.current = null;
        setSkillReason('');
        skillReasonRef.current = '';
        setPicker((current) => (
          current && current.kind === 'skill'
            ? { ...current, loading: true, error: null, reason: '' }
            : current
        ));
        const promise = api.skills(groupId)
          .then((result) => {
            const list = result && Array.isArray(result.skills) ? result.skills : [];
            const reason = result && typeof result.reason === 'string' ? result.reason : '';
            if (groupIdRef.current !== groupId || skillLoadIdRef.current !== loadId) return null;
            skillCatalogRef.current = list;
            setSkillCatalog(list);
            setSkillReason(reason);
            skillReasonRef.current = reason;
            skillLoadedGroupRef.current = groupId;
            setPicker((current) => (
              current && current.kind === 'skill'
                ? { ...current, options: commandSkillOptions(list, current.query, current.start), loading: false, error: null, reason }
                : current
            ));
            return list;
          })
          .catch((error) => {
            const message = String(error && error.message ? error.message : error);
            if (groupIdRef.current === groupId && skillLoadIdRef.current === loadId) {
              setSkillError(message);
              skillErrorRef.current = message;
              setPicker((current) => (
                current && current.kind === 'skill'
                  ? { ...current, loading: false, error: message }
                  : current
              ));
            }
            return null;
          })
          .finally(() => {
            if (groupIdRef.current === groupId && skillLoadIdRef.current === loadId) {
              setSkillLoading(false);
              skillLoadingRef.current = false;
            }
            if (skillLoadRef.current === promise) skillLoadRef.current = null;
          });
        skillLoadRef.current = promise;
        return promise;
      };

      const refreshSkillPicker = (next) => {
        if (!next) return;
        setPicker((current) => (
          current && current.kind === 'skill'
            ? { ...current, options: commandSkillOptions(next, current.query, current.start), loading: false, error: null }
            : current
        ));
      };

      const updatePicker = (value, caret) => {
        if (!isDirect) {
          const before = value.slice(0, caret);
          const mentionMatch = /@([^\s@]*)$/.exec(before);
          if (mentionMatch) {
            const query = mentionMatch[1].toLowerCase();
            const options = memberEntries.filter((entry) => entry.bot.name.toLowerCase().includes(query));
            if (options.length > 0) {
              setPicker({ kind: 'mention', start: mentionMatch.index, query, options });
              setPickerIndex(0);
              return;
            }
          }
        }
        const skillMatch = findSkillTrigger(value, caret);
        if (!skillMatch) {
          setPicker(null);
          return;
        }
        const loaded = skillLoadedGroupRef.current === (group && group.groupId);
        const list = loaded ? skillCatalogRef.current : [];
        setPicker({
          kind: 'skill',
          start: skillMatch.start,
          query: skillMatch.query,
          options: commandSkillOptions(list, skillMatch.query, skillMatch.start),
          loading: skillLoadingRef.current || !loaded,
          error: skillErrorRef.current,
          reason: skillReasonRef.current,
        });
        setPickerIndex(0);
        if (!loaded && !skillLoadRef.current) {
          void ensureSkills(false).then(refreshSkillPicker);
        }
      };

      const onChange = (event) => {
        const value = event.target.value;
        if (autoReplyMentionRef.current && !value.startsWith('@' + autoReplyMentionRef.current.name + ' ')) autoReplyMentionRef.current = null;
        setText(value);
        updatePicker(value, event.target.selectionStart ?? value.length);
      };

      const insertMention = (entry) => {
        const caret = textareaRef.current ? textareaRef.current.selectionStart : text.length;
        const start = picker ? picker.start : caret;
        const before = text.slice(0, start);
        const after = text.slice(caret);
        const inserted = '@' + entry.bot.name + ' ';
        const next = before + inserted + after;
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

      const insertSkill = (skill) => {
        if (!skill || !skill.name) return;
        if (skill.conflict || (!skill.builtin && skill.name === 'new')) {
          dispatch({ type: 'error', message: 'Skill new 与内建指令冲突，请用自然语言明确要求加载该 Skill' });
          return;
        }
        const caret = textareaRef.current ? textareaRef.current.selectionStart : text.length;
        const start = picker && picker.kind === 'skill' ? picker.start : caret;
        const before = text.slice(0, start);
        const after = text.slice(caret);
        const inserted = '/' + skill.name + (skill.builtin ? '' : ' ');
        const next = before + inserted + after;
        setText(next);
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
        const next = before + inserted + text.slice(caret);
        const start = before.length + (needsSpace ? 1 : 0);
        setText(next);
        setAddMenuOpen(false);
        setPicker({ kind: 'mention', start, query: '', options: memberEntries });
        setPickerIndex(0);
        const position = start + 1;
        requestAnimationFrame(() => {
          const target = textareaRef.current;
          if (!target) return;
          target.focus();
          target.setSelectionRange(position, position);
        });
      };

      const openSkillPicker = () => {
        const node = textareaRef.current;
        const caret = node ? node.selectionStart : text.length;
        const before = text.slice(0, caret);
        const needsSpace = before.length > 0 && !/\s$/.test(before);
        const inserted = needsSpace ? ' /' : '/';
        const next = before + inserted + text.slice(caret);
        const start = before.length + (needsSpace ? 1 : 0);
        const loaded = skillLoadedGroupRef.current === (group && group.groupId);
        setText(next);
        setAddMenuOpen(false);
        setPicker({
          kind: 'skill',
          start,
          query: '',
          options: commandSkillOptions(loaded ? skillCatalogRef.current : [], '', start),
          loading: skillLoadingRef.current || !loaded,
          error: skillErrorRef.current,
          reason: skillReasonRef.current,
        });
        setPickerIndex(0);
        if (!loaded) void ensureSkills(false).then(refreshSkillPicker);
        const position = start + 1;
        requestAnimationFrame(() => {
          const target = textareaRef.current;
          if (!target) return;
          target.focus();
          target.setSelectionRange(position, position);
        });
      };

      const uploadFile = async (file) => {
        const groupId = group && group.groupId;
        const itemId = 'file-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        const uploadDraft = draftRef.current;
        setDraftAttachments((current) => current.concat([{
          id: itemId,
          name: file.name || 'file',
          size: file.size || 0,
          status: 'uploading',
          attachment: null,
          error: null,
        }]));
        try {
          const result = await api.upload(groupId, file);
          const attachment = result && result.attachment ? result.attachment : null;
          if (!attachment || !attachment.attachmentId) throw new Error('Host 未返回附件引用');
          if (!uploadDraft.attachments.some(item => item.id === itemId)) return;
          const finish = current => current.map(item => item.id === itemId ? { ...item, status: 'ready', attachment } : item);
          if (draftRef.current !== uploadDraft) { uploadDraft.attachments = finish(uploadDraft.attachments); uploadDraft.revision += 1; return; }
          setDraftAttachments(finish);
        } catch (error) {
          const message = String(error && error.message ? error.message : error);
          if (!uploadDraft.attachments.some(item => item.id === itemId)) return;
          const fail = current => current.map(item => item.id === itemId ? { ...item, status: 'error', error: message } : item);
          if (draftRef.current !== uploadDraft) { uploadDraft.attachments = fail(uploadDraft.attachments); uploadDraft.revision += 1; return; }
          setDraftAttachments(fail);
          dispatch({ type: 'error', message: uiT('文件「{name}」上传失败：{error}', { name: file.name || 'file', error: message }) });
        }
      };

      const onPickFiles = (event) => {
        const picked = event && event.target && event.target.files ? Array.from(event.target.files) : [];
        if (event && event.target) event.target.value = '';
        if (picked.length === 0) return;
        if (draftCountRef.current + picked.length > MAX_DRAFT_ATTACHMENTS) {
            dispatch({ type: 'flash', message: uiT('每条消息最多添加 {count} 个文件', { count: MAX_DRAFT_ATTACHMENTS }) });
          return;
        }
        for (const file of picked) {
          if (!file || !file.size) {
              dispatch({ type: 'flash', message: uiT('已跳过空文件「{name}」', { name: (file && file.name) || uiT('未命名') }) });
            continue;
          }
          if (file.size > MAX_ATTACHMENT_BYTES) {
              dispatch({ type: 'flash', message: uiT('「{name}」超过 32 MB，已跳过', { name: file.name }) });
            continue;
          }
          void uploadFile(file);
        }
        const node = textareaRef.current;
        if (node) node.focus();
      };

      const removeDraftAttachment = (itemId) => {
        setDraftAttachments((current) => current.filter((item) => item.id !== itemId));
      };

      const chooseFiles = () => {
        setAddMenuOpen(false);
        const node = fileInputRef.current;
        if (node && typeof node.click === 'function') node.click();
        else dispatch({ type: 'error', message: '当前浏览器不支持文件选择' });
      };

      const workspaceSaved = (updated) => {
        dispatch({ type: 'sse', frame: { type: 'group.updated', group: updated } });
        if (groupIdRef.current !== updated.groupId) return;
        setProjectDialogOpen(false);
        onSent && onSent();
      };

      const removeProject = async () => {
        if (workspaceLocked || sending || workspaceSavingRef.current) return;
        const groupId = group.groupId;
        workspaceSavingRef.current = true;
        setWorkspaceSaving(true);
        try {
          const result = await api.action('group.workspace.set', { groupId, expectedConversationId: currentConversationId(group), workspaceCwd: '' });
          workspaceSaved(result.result);
        } catch (error) {
          if (groupIdRef.current === groupId) dispatch({ type: 'error', message: uiT(String(error && error.message ? error.message : error)) });
        } finally {
          if (groupIdRef.current === groupId) {
            workspaceSavingRef.current = false;
            setWorkspaceSaving(false);
          }
        }
      };

      const reportRequestError = (error, groupId) => {
        if (error.details) dispatch({ type: 'conversationState', groupId, data: error.details });
        if (error.code === 'stale-conversation' || error.code === 'reload-required') dispatch({ type: 'refreshTick' });
        dispatch({ type: 'error', message: String(error?.message || error) });
      };
      const clearOldReply = () => {
        const draft = draftRef.current;
        const cleaned = applyReplyMention({ text: draft.text, mentions: draft.mentions, auto: autoReplyMentionRef.current, entry: null });
        autoReplyMentionRef.current = null;
        setText(cleaned.text);
        setMentions(cleaned.mentions);
        onClearReply?.();
      };
      const adoptDraft = () => {
        if (inFlightRef.current) return;
        bindDraft(currentConversationId(groupRef.current));
        clearOldReply();
      };
      const startConversation = async (source = 'menu') => {
        if (inFlightRef.current || workspaceSavingRef.current) return;
        const reason = conversationBlockReason(groupRef.current, state.capabilities);
        if (reason) { dispatch({ type: 'error', message: reason }); return; }
        const draft = draftRef.current;
        const expectedConversationId = source === 'command' ? draft.conversationId : currentConversationId(groupRef.current);
        if (expectedConversationId !== currentConversationId(groupRef.current)) { dispatch({ type: 'error', message: '聊天已开始新会话，草稿已保留' }); return; }
        const snapshot = { groupId: draft.groupId, expectedConversationId, revision: draft.revision,
          requestId: 'new-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2), replyId: replyTargetRef.current?.messageId };
        inFlightRef.current = snapshot;
        setSending(true);
        try {
          const response = await api.action('conversation.new', { groupId: snapshot.groupId, expectedConversationId, requestId: snapshot.requestId });
          const result = response.result;
          dispatch({ type: 'conversationState', groupId: snapshot.groupId, data: result });
          if (draftRef.current === draft && groupIdRef.current === snapshot.groupId) {
            // A later SSE may already know a newer segment than this response.
            const latest = groupRef.current;
            const id = Number(latest.conversationVersion) > Number(result.conversationVersion) ? currentConversationId(latest) : result.currentConversationId;
            if (source === 'command' && draft.revision === snapshot.revision && parseBuiltinCommand(draft.text)?.valid) setText('');
            bindDraft(id);
            if (replyTargetRef.current?.messageId === snapshot.replyId) clearOldReply();
            setPicker(null);
            setAddMenuOpen(false);
            onConversationStarted?.(result, snapshot.groupId);
          }
          dispatch({ type: 'flash', message: '已开始新会话' });
        } catch (error) {
          reportRequestError(error, snapshot.groupId);
        } finally {
          if (inFlightRef.current === snapshot) { inFlightRef.current = null; setSending(false); }
        }
      };
      if (conversationControlRef) conversationControlRef.current = { groupId: group?.groupId, startConversation };

      const send = async () => {
        if (inFlightRef.current || workspaceSavingRef.current) return;
        if (groupRef.current?.conversationStateConflict) { dispatch({ type: 'error', message: '正在刷新会话状态，请稍后重试' }); return; }
        const draft = draftRef.current;
        const command = parseBuiltinCommand(draft.text);
        if (command) {
          if (!command.valid) { dispatch({ type: 'error', message: '请单独发送 /new' }); return; }
          return startConversation('command');
        }
        if (draft.conversationId !== currentConversationId(groupRef.current)) { dispatch({ type: 'error', message: '聊天已开始新会话，草稿已保留' }); return; }
        const attachments = draft.attachments.filter(item => item.status === 'ready' && item.attachment).map(item => item.attachment);
        if (draft.attachments.some(item => item.status !== 'ready')) return;
        const trimmedText = draft.text.trim();
        if (!trimmedText && !attachments.length) return;
        const snapshot = { groupId: draft.groupId, expectedConversationId: draft.conversationId, revision: draft.revision,
          replyId: replyTargetRef.current?.messageId, requestId: 'send-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) };
        const stillMentioned = draft.mentions.filter(membershipId => {
          const entry = memberEntries.find(candidate => candidate.member.membershipId === membershipId);
          return entry && trimmedText.includes('@' + entry.bot.name);
        });
        inFlightRef.current = snapshot;
        setSending(true);
        try {
          await api.action('message.post', {
            groupId: snapshot.groupId, expectedConversationId: snapshot.expectedConversationId, requestId: snapshot.requestId,
            text: trimmedText, mentions: stillMentioned, replyTo: snapshot.replyId,
            attachments: attachments.map(attachment => ({ attachmentId: attachment.attachmentId, name: attachment.name, bytes: attachment.bytes })),
          });
          if (draftRef.current === draft && groupIdRef.current === snapshot.groupId) {
            if (draft.revision === snapshot.revision && replyTargetRef.current?.messageId === snapshot.replyId) {
              autoReplyMentionRef.current = null;
              setText(''); setMentions([]); setDraftAttachments([]);
              onClearReply?.();
            }
            setPicker(null); setPickerIndex(0); setAddMenuOpen(false);
            onSent?.();
          }
        } catch (error) { reportRequestError(error, snapshot.groupId); }
        finally { if (inFlightRef.current === snapshot) { inFlightRef.current = null; setSending(false); } }
      };

      const onKeyDown = (event) => {
        const composing = !!(event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229);
        if (composing) return;
        if (event.key === 'Enter' && !event.shiftKey && parseBuiltinCommand(draftRef.current.text)) {
          event.preventDefault();
          void send();
          return;
        }
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
          if ((event.key === 'Enter' && !event.shiftKey && !composing) || (event.key === 'Tab' && !event.shiftKey)) {
            event.preventDefault();
            const chosen = picker.options[pickerIndex] || picker.options[0];
            if (picker.kind === 'skill') insertSkill(chosen);
            else insertMention(chosen);
            return;
          }
        }
        if (picker && picker.kind === 'skill' && event.key === 'Escape') {
          event.preventDefault();
          setPicker(null);
          return;
        }
        if (event.key === 'Enter' && !event.shiftKey && !composing) {
          event.preventDefault();
          void send();
        }
        if (event.key === 'Escape') {
          setPicker(null);
          setAddMenuOpen(false);
        }
      };

      const running = members.filter((member) => state.statusByMember[member.membershipId] === 'running');
      const replyName = replyTarget ? displayNameOf(replyTarget, bots, userProfile) : '';
      const addMenuActions = [];
      const addMenuAction = (group, item) => addMenuActions.push({ group, ...item });
      addMenuAction('指令', { key: 'new', label: '新建会话', alias: '/new', icon: 'add',
        description: conversationBlockReason(group, state.capabilities) || conversationActivityHint(group) || (isDirect ? '开始新的对话上下文，历史仍可查看' : '为本群全部成员开始新会话'),
        disabled: sending || workspaceSaving || !!conversationBlockReason(group, state.capabilities), run: () => void startConversation('menu') });
      addMenuAction('添加', {
        key: 'file',
        label: '文件',
        alias: 'file',
        description: '上传本地文件，Bot 可按路径读取',
        icon: 'file',
        run: chooseFiles,
      });
      addMenuAction('添加', {
        key: 'folder',
        label: '文件夹',
        alias: 'folder',
        description: workspaceLocked ? '任务结束后可切换项目文件夹' : '引入项目，Bot 可在目录中检索和处理任务',
        icon: 'folder',
        disabled: workspaceLocked || sending || workspaceSaving,
        run: () => setProjectDialogOpen(true),
      });
      addMenuAction('添加', {
        key: 'skill',
        label: '技能',
        alias: 'skill',
        description: '插入 /技能名，让 Bot 按 Skill 执行',
        icon: 'skill',
        run: openSkillPicker,
      });
      if (!isDirect && memberEntries.length > 0) {
        addMenuAction('添加', {
          key: 'mention',
          label: '提及成员',
          alias: 'mention',
          description: '插入 @ 提及，选中群成员',
          icon: 'mention',
          run: openMentionPicker,
        });
      }
      if (running.length > 0) {
        addMenuAction('指令', {
          key: 'stop',
          label: '停止回复',
          alias: 'stop',
          description: '中断当前会话进行中的回复',
          icon: 'stop',
          run: () => {
            void api.action('message.stop', { groupId: group.groupId, expectedConversationId: currentConversationId(group) }).then(() => onSent && onSent());
          },
        });
      }
      if (typeof onExportMarkdown === 'function') {
        addMenuAction('指令', {
          key: 'export-markdown',
          label: '导出 Markdown',
          alias: 'export',
          description: '将整个聊天导出为 Markdown（包含所有会话）',
          icon: 'download',
          run: onExportMarkdown,
        });
      }
      if (!isDirect && typeof onExportHtml === 'function') {
        addMenuAction('指令', {
          key: 'export-html',
          label: '导出 HTML',
          alias: 'export-html',
          description: '将整个聊天导出为 HTML（包含所有会话）',
          icon: 'code',
          run: onExportHtml,
        });
      }
      if (!isDirect && typeof onExportPdf === 'function') {
        addMenuAction('指令', {
          key: 'export-pdf',
          label: '导出 PDF',
          alias: 'export-pdf',
          description: '将整个聊天导出为 PDF（包含所有会话）',
          icon: 'download',
          run: onExportPdf,
        });
      }
      if (typeof onOpenSettings === 'function') {
        addMenuAction('指令', {
          key: 'settings',
          label: '消息设置',
          alias: 'settings',
          description: '打开 Bot Team 消息设置',
          icon: 'settings',
          run: onOpenSettings,
        });
      }

      const hint = isDirect
        ? 'Enter 发送 · Shift + Enter 换行 · / 选择指令或 Skill'
        : running.length > 0
          ? 'Enter 发送 · Shift + Enter 换行 · / 选择指令或 Skill'
          : 'Enter 发送 · Shift + Enter 换行 · @ 提及成员 · / 选择指令或 Skill';

      const renderPicker = () => {
        if (!picker) return null;
        if (picker.kind === 'skill') {
          return h(
            'div',
            {
              className: 'bt-skill-picker',
              style: S.skillPicker,
              role: 'listbox',
              'aria-label': '选择指令或 Skill',
              onKeyDown: (event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                setPicker(null);
                const node = textareaRef.current;
                if (node) node.focus();
              },
            },
            h(
              'div',
              { style: S.pickerHeader },
              h('span', null, '选择指令或 Skill'),
              h(
                'span',
                { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
                h('span', { style: S.pickerHint }, '↑↓ 选择 · Enter 补全 · Tab 补全 · /new 再次 Enter 执行'),
                h(
                  'button',
                  {
                    type: 'button',
                    style: S.skillRefresh,
                    title: '重新读取 Skill 列表',
                    onMouseDown: (event) => event.preventDefault(),
                    onClick: () => {
                      void ensureSkills(true);
                      const node = textareaRef.current;
                      if (node) node.focus();
                    },
                  },
                  '刷新',
                ),
              ),
            ),
            picker.loading && picker.options.length === 0
              ? h('div', { style: S.skillEmpty }, '正在加载 Skill…')
              : picker.error && picker.options.length === 0
                ? h(
                    'div',
                    { style: S.skillEmpty },
                    uiT('Skill 加载失败：{error}', { error: picker.error }),
                    h(
                      'button',
                      {
                        type: 'button',
                        style: S.skillRetry,
                        onMouseDown: (event) => event.preventDefault(),
                        onClick: () => {
                          void ensureSkills(true).then(refreshSkillPicker);
                          const node = textareaRef.current;
                          if (node) node.focus();
                        },
                      },
                      '重试',
                    ),
                  )
                : picker.options.length === 0
                  ? h(
                      'div',
                      { style: S.skillEmpty },
                      picker.query
                        ? '没有匹配的 Skill'
                        : picker.reason === 'no-member'
                          ? '这个群还没有 Bot；添加 Bot 后即可读取它的工作区 Skill。'
                          : '当前工作区没有可用的 Skill',
                      picker.reason === 'no-member'
                        ? null
                        : h('div', { style: { marginTop: 4 } }, '把 SKILL.md 放到 .dsh/skills 或 ~/.dsh/skills 后重试。'),
                    )
                  : picker.options.map((skill, index) =>
                      h(
                        'div',
                        {
                          key: (skill.builtin ? 'command:' : 'skill:') + skill.name,
                          className: 'bt-picker-item',
                          'data-active': index === pickerIndex ? 'true' : 'false',
                          style: S.pickerItem,
                          role: 'option',
                          'aria-selected': index === pickerIndex,
                          onMouseEnter: () => setPickerIndex(index),
                          onMouseDown: (event) => {
                            event.preventDefault();
                            insertSkill(skill);
                          },
                        },
                        h(SkillGlyph, { size: 18, style: S.skillIcon }),
                        h(
                          'div',
                          { style: S.skillOptionBody },
                          h('span', { style: S.skillOptionName, raw: true }, skill.builtin ? uiT('新建会话') + ' /new' : skill.name),
                          skill.conflict
                            ? h('span', { style: S.skillOptionDesc }, 'Skill new 与内建指令冲突，请用自然语言明确要求加载该 Skill')
                            : skill.description
                            ? h('span', { style: S.skillOptionDesc, title: skill.description, raw: true }, cleanPreview(skill.description, 110))
                            : null,
                        ),
                        skill.modelInvocable === false ? h('span', { style: S.pickerHint }, '仅手动') : null,
                      ),
                    ),
          );
        }
        return h(
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
              h('span', { style: S.pickerName, raw: true }, entry.bot.name),
              entry.member.running ? h('span', { style: S.pickerHint }, '回复中') : null,
            ),
          ),
        );
      };

      return h(
        'div',
        { className: 'bt-composer-wrap', style: S.composerWrap },
        h(
          'div',
          { ref: shellRef, className: 'bt-composer', style: S.composerShell },
          addMenuOpen
            ? h(
                React.Fragment,
                null,
                h('div', { className: 'bt-menu-backdrop', onClick: closeAddMenu }),
                h(
                  'div',
                  {
                    ref: addMenuRef,
                    className: 'bt-menu bt-add-menu',
                    style: S.addMenu,
                    role: 'menu',
                    'aria-label': '添加文件或执行指令',
                    onKeyDown: onAddMenuKeyDown,
                  },
                  addMenuActions.map((item, index) => {
                    const previous = addMenuActions[index - 1];
                    return h(
                      React.Fragment,
                      { key: item.key },
                      !previous || previous.group !== item.group
                        ? h(
                            'div',
                            {
                              style: index === 0 ? { ...S.addMenuGroup, marginTop: 0 } : S.addMenuGroup,
                              role: 'presentation',
                            },
                            item.group,
                          )
                        : null,
                      h(
                        'button',
                        {
                          type: 'button',
                          role: 'menuitem',
                          className: 'bt-add-menu-item',
                          style: { ...S.addMenuItem, ...(item.disabled ? { opacity: 0.5, cursor: 'not-allowed' } : {}) },
                          disabled: !!item.disabled,
                          onClick: () => runAddMenuAction(item),
                        },
                        h('span', { style: S.addMenuIcon }, h(AddMenuGlyph, { name: item.icon, size: 14 })),
                        h('span', { style: S.addMenuName }, item.label),
                        h('span', { style: S.addMenuAlias }, item.alias),
                        h('span', { style: S.addMenuDesc }, item.description),
                      ),
                    );
                  }),
                ),
              )
            : null,
          renderPicker(),
          draftIsStale ? h('div', { role: 'status', className: 'bt-draft-conversation-warning', style: { ...S.replyBar, alignItems: 'center' } },
            h('span', null, '聊天已开始新会话，草稿已保留'),
            h('button', { type: 'button', style: S.smallBtn, disabled: sending, onClick: adoptDraft }, '将草稿用于当前会话')) : null,
          projectCwd
            ? h('div', { className: 'bt-project-workspace', style: { ...S.draftAttachments, flexWrap: 'nowrap', alignItems: 'center' } },
                h('div', { style: { ...S.draftAttachment('ready'), maxWidth: '100%', flex: 1, color: S.draftAttachmentMeta.color }, title: projectCwd, rawTitle: true },
                  h(AddMenuGlyph, { name: 'folder', size: 18 }),
                  h('div', { style: S.draftAttachmentBody },
                    h('span', { style: S.draftAttachmentMeta }, '当前项目'),
                    h('span', { style: S.draftAttachmentName, raw: true }, projectCwd)),
                  h('button', { type: 'button', style: S.toolButton, disabled: workspaceLocked || sending || workspaceSaving, onClick: () => setProjectDialogOpen(true), 'aria-label': '切换项目文件夹' }, '更换'),
                  h('button', { type: 'button', style: S.draftAttachmentRemove, disabled: workspaceLocked || sending || workspaceSaving, onClick: () => void removeProject(), title: '移除项目，恢复默认工作目录', 'aria-label': '移除项目，恢复默认工作目录' }, '×')))
            : null,
          replyTarget
            ? h(
                'div',
                { className: 'bt-reply-bar', style: S.replyBar },
                h(
                  'div',
                  { style: S.replyBarBody },
                  h('div', { style: S.replyBarLabel }, uiT('回复 {name}', { name: replyName })),
                  h('div', { style: S.replyBarText, raw: true }, cleanPreview(replyTarget.text, 120) || uiT('[消息]')),
                  historicalMessage(replyTarget, group) ? h('small', null, '历史引用只包含所选消息，不会带入其他历史内容') : null,
                ),
                h(
                  'button',
                  { type: 'button', style: S.replyBarClose, title: '取消回复', onClick: () => onClearReply && onClearReply() },
                  '×',
                ),
              )
            : null,
          draftAttachments.length > 0
            ? h(
                'div',
                { className: 'bt-draft-attachments', style: S.draftAttachments },
                draftAttachments.map((item) => {
                  const meta = item.status === 'uploading'
                    ? uiT('上传中…')
                    : item.status === 'error'
                      ? uiT('上传失败 · 移除后重试')
                      : formatFileSize(item.size);
                  return h(
                    'div',
                    {
                      key: item.id,
                      className: 'bt-draft-file',
                      style: S.draftAttachment(item.status),
                      title: item.error || item.name,
                      raw: true,
                    },
                    h(FileGlyph, { size: 14, style: { flex: '0 0 auto', color: 'var(--bt-text-3)' } }),
                    h(
                      'span',
                      { style: S.draftAttachmentBody },
                      h('span', { style: S.draftAttachmentName, raw: true }, item.name),
                      h('span', { style: S.draftAttachmentMeta }, meta),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'bt-draft-file-remove',
                        style: S.draftAttachmentRemove,
                        title: '移除文件',
                        'aria-label': uiT('移除文件 {name}', { name: item.name }),
                        onClick: () => removeDraftAttachment(item.id),
                      },
                      '×',
                    ),
                  );
                }),
              )
            : null,
          h('textarea', {
            ref: textareaRef,
            style: S.textarea,
            value: text,
            placeholder: isDirect ? uiT('给 {title} 发消息…', { title: group.title }) : uiT('输入消息，@ 成员派活…'),
            onChange,
            onKeyDown,
            'aria-label': isDirect ? '单聊消息输入框' : '群聊消息输入框',
          }),
          h(
            'div',
            { style: S.composerFoot },
            h(
              'button',
              {
                type: 'button',
                className: 'bt-add-btn',
                style: S.addButton,
                title: '添加文件或执行指令',
                'aria-label': '添加文件或执行指令',
                'aria-haspopup': 'menu',
                'aria-expanded': addMenuOpen,
                onClick: () => {
                  setPicker(null);
                  setAddMenuOpen((open) => !open);
                },
              },
              h(
                'svg',
                { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', 'aria-hidden': true },
                h('path', { d: 'M8 3v10M3 8h10' }),
              ),
            ),
            h('input', {
              ref: fileInputRef,
              type: 'file',
              multiple: true,
              style: { display: 'none' },
              onChange: onPickFiles,
              tabIndex: -1,
              'aria-hidden': true,
            }),
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
                    onClick: () => void api.action('message.stop', { groupId: group.groupId, expectedConversationId: currentConversationId(group) }).then(() => onSent && onSent()),
                  },
                  h('span', { style: { width: 6, height: 6, borderRadius: '50%', background: '#22c55e' } }),
                  pluralUi('1 个 Bot 正在回复 · 停止', '{count} 个 Bot 正在回复 · 停止', running.length),
                )
              : null,
            h('span', { style: S.composerHint }, hint),
            h(
              'button',
              {
                type: 'button',
                className: 'bt-send-btn',
                style: S.sendButton,
                disabled: !canSend,
                onClick: () => void send(),
              },
              sending ? '发送中…' : attachmentsPending ? '上传中…' : '发送',
            ),
          ),
        ),
        projectDialogOpen ? h(ProjectWorkspaceDialog, {
          key: group.groupId, group, locked: workspaceLocked || sending || workspaceSaving,
          onClose: () => setProjectDialogOpen(false), onSaved: workspaceSaved,
        }) : null,
      );
    }
    function Composer(props) {
      const values = [];
      const group = props && props.group;
      if (group) values.push(group.title, group.topic);
      for (const entry of (props && props.members) || []) {
        if (entry && entry.bot) values.push(entry.bot.name);
      }
      for (const bot of (props && props.bots) || []) values.push(bot.name);
      const reply = props && props.replyTarget;
      if (reply) values.push(reply.name, reply.text);
      return withContent(values, () => renderComposer(props));
    }


    function renderTokenUsageCard({ label, usage, runningCount = 0, className, style = S.memberCard }) {
      const inputTokens = usage?.inputTokens ?? 0;
      const outputTokens = usage?.outputTokens ?? 0;
      const totalTokens = usage?.totalTokens ?? (inputTokens + outputTokens);
      const exactTokens = (value) => Number(value).toLocaleString(isEnglishUi() ? 'en-US' : 'zh-CN');
      const displayTokens = (value) => value >= 1000000 ? formatTokens(value) : exactTokens(value);
      return h(
        'section',
        { className, style, 'aria-label': label },
        h(
          'div',
          { style: S.usageHeader },
          h('h3', { style: S.usageLabel }, label),
          runningCount > 0
            ? h('span', { style: S.usageRunning, role: 'status' },
                h('span', { 'aria-hidden': true, style: { width: 5, height: 5, borderRadius: '50%', background: '#22c55e' } }),
                uiT('{count} 个运行中', { count: runningCount }),
              )
            : null,
        ),
        h('div', { style: S.usageTotal, title: exactTokens(totalTokens), 'aria-label': uiT('累计 {count} Token', { count: exactTokens(totalTokens) }) }, displayTokens(totalTokens)),
        h(
          'dl',
          { style: S.usageBreakdown },
          ...[['输入', inputTokens], ['输出', outputTokens]].map(([label, value]) => h(
            'div',
            { key: label, style: S.usageMetric },
            h('dt', { style: S.usageLabel }, label),
            h('dd', { style: S.usageValue, title: exactTokens(value), 'aria-label': exactTokens(value) }, displayTokens(value)),
          )),
        ),
      );
    }

    /** Right rail for a single chat: bot identity + session/persona entry points. */
    function renderDirectPanel({ bot, group, member, usage, running = false, onEdit, onCollapse, onViewSession, onOpenNativeSession }) {
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
          renderTokenUsageCard({
            label: '本单聊累计 Token',
            usage,
            runningCount: running ? 1 : 0,
            className: 'bt-direct-usage',
            style: { ...S.memberCard, marginBottom: 0 },
          }),
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
                ? h('button', { type: 'button', style: S.ghostBtn, disabled: !(currentMemberSession(member, group) || member.sessionId), onClick: () => onViewSession && onViewSession(member) }, memberLogLabel(member, group))
                : null,
            ),
          ),
          h(
            'div',
            { style: S.directNote },
            '人格与工作规范在「编辑 Bot → BOT.md」中维护，下一轮回复生效。',
          ),
        ),
      );
    }
    function DirectPanel(props) {
      const bot = props && props.bot;
      const group = props && props.group;
      const values = [bot && bot.name, group && group.title, group && group.topic];
      return withContent(values, () => renderDirectPanel(props));
    }


    function renderMembersPanel({ state, members, bots, dispatch, onAdd, onCollapse, onEdit, onViewSession, onOpenNativeSession, discussion, usage, onStopDiscussion }) {
      const runningMembers = members.filter((member) => state.statusByMember[member.membershipId] === 'running');
      return h(
        'div',
        { id: 'bt-right-panel', className: 'bt-right-panel', style: S.right },
        h(
          'div',
          { style: S.rightHeader },
          h('span', null, uiT('成员 ({count})', { count: members.length })),
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
          renderTokenUsageCard({
            label: '本群累计 Token',
            usage,
            runningCount: runningMembers.length,
            className: 'bt-group-usage',
          }),
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
                  uiT('第 {current}/{total} 轮', {
                    current: Math.min(discussion.currentRound || 1, discussion.rounds),
                    total: discussion.rounds,
                  }),
                  discussion.status === 'running' && discussion.currentSpeaker
                    ? ` · ${(() => {
                        const speaker = members.find((member) => member.membershipId === discussion.currentSpeaker);
                        const speakerBot = speaker ? bots.find((bot) => bot.botId === speaker.botId) : null;
                        return speakerBot ? uiT('{name} 发言中', { name: speakerBot.name }) : uiT('发言中');
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
                    h('button', { type: 'button', style: S.smallBtn, disabled: !(currentMemberSession(member, state.groups.find(group => group.groupId === member.groupId)) || member.sessionId), onClick: () => onViewSession && onViewSession(member) }, memberLogLabel(member, state.groups.find(group => group.groupId === member.groupId))),
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
    function MembersPanel(props) {
      const values = [];
      const group = props && props.group;
      const discussion = props && props.discussion;
      if (group) values.push(group.title, group.topic);
      for (const bot of (props && props.bots) || []) values.push(bot.name, bot.provider, bot.model, bot.reasoningEffort);
      if (discussion) values.push(discussion.topic, discussion.summary);
      return withContent(values, () => renderMembersPanel(props));
    }


    // ── dialogs ───────────────────────────────────────────────────────────
    function renderGroupFormDialog({ group, folders, folderId, onClose, onSaved }) {
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
          setError(uiT('群头像读取失败：{error}', { error: String(reason && reason.message ? reason.message : reason) }));
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
            { style: S.select, value: folder, onChange: (event) => setFolder(event.target.value) },
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
            h('div', { style: { ...S.label, marginTop: 10 } }, '预置头像'),
            h(
              'div',
              { style: S.artGrid, role: 'group', 'aria-label': '预置头像' },
              GROUP_ART_AVATARS.map((art) =>
                h(
                  'button',
                  {
                    key: art.id,
                    title: art.label,
                    'aria-label': art.label,
                    'aria-pressed': avatar === `art:${art.id}`,
                    style: { ...S.artOption(avatar === `art:${art.id}`), borderRadius: 12 },
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
    function GroupFormDialog(props) {
      const group = props && props.group;
      const values = [group && group.title, group && group.topic];
      for (const folder of (props && props.folders) || []) values.push(folder.title);
      return withContent(values, () => renderGroupFormDialog(props));
    }


    function renderFolderFormDialog({ folder, onClose, onSaved }) {
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
    function FolderFormDialog(props) {
      const folder = props && props.folder;
      return withContent([folder && folder.title], () => renderFolderFormDialog(props));
    }


    function BotLibraryGroups({ groups }) {
      const rowRef = React.useRef(null);
      const measureRef = React.useRef(null);
      const [visibleCount, setVisibleCount] = React.useState(0);
      React.useEffect(() => {
        const row = rowRef.current;
        const measure = measureRef.current;
        if (!row || !measure) return undefined;
        const tags = Array.from(measure.children);
        const more = tags.pop();
        const update = () => {
          const available = row.getBoundingClientRect().width;
          const bounds = tags.map((tag) => tag.getBoundingClientRect());
          const start = bounds[0].left;
          const end = bounds[bounds.length - 1].right;
          let count = tags.length;
          if (end - start > available) {
            const moreBounds = more.getBoundingClientRect();
            const reserved = moreBounds.left - end + moreBounds.width;
            count = bounds.findIndex((bound) => bound.right - start + reserved > available);
          }
          setVisibleCount(count);
        };
        update();
        if (typeof ResizeObserver === 'function') {
          const observer = new ResizeObserver(update);
          observer.observe(row);
          for (const tag of measure.children) observer.observe(tag);
          return () => observer.disconnect();
        }
        window.addEventListener('resize', update);
        return () => window.removeEventListener('resize', update);
      }, [groups]);
      const groupTag = (group) => h('span', { key: group.groupId, className: 'bt-library-group', title: group.title, rawTitle: true },
        h(WelcomeIcon, { name: 'group' }),
        h('span', { raw: true }, group.title),
      );
      const groupTitles = groups.map((group) => group.title).join(isEnglishUi() ? ', ' : '、');
      return h('dd', { className: 'bt-library-groups', ref: rowRef },
        groups.length ? groups.slice(0, visibleCount).map(groupTag) : h('span', { className: 'bt-library-ungrouped' }, '未加入群聊'),
        groups.length > visibleCount ? h('span', {
          className: 'bt-library-group bt-library-group-more',
          title: groupTitles, raw: true, tabIndex: 0,
          'aria-label': `${uiT('所属群聊')}: ${groupTitles}`,
        }, '…') : null,
        groups.length ? h('span', { className: 'bt-library-group-measure', ref: measureRef, 'aria-hidden': true },
          groups.map(groupTag),
          h('span', { className: 'bt-library-group bt-library-group-more' }, '…'),
        ) : null,
      );
    }

    function renderBotLibraryDialog({ bots, members, groups, onClose, onCreate, onEdit, onChanged }) {
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
            ? uiT('它正在 {count} 个群中（{groups}），删除会同时把它移出这些群。', { count: inGroups.length, groups: inGroups.map((group) => group.title).join(isEnglishUi() ? ', ' : '、') })
            : '',
          hasDirect ? uiT('它的单聊与全部单聊消息也会一并删除。') : '',
        ].filter(Boolean).join('\n');
        if (!window.confirm(uiT('从全局 Bot 库删除「{name}」？', { name: bot.name }) + (warning ? `\n\n${warning}` : ''))) return;
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
      const createButton = h('button', {
        type: 'button', className: 'bt-library-create', style: S.primaryBtn, onClick: onCreate,
      }, h(WelcomeIcon, { name: 'plus' }), bots.length ? '新建 Bot' : '创建第一个 Bot');
      return h(
        Modal,
        {
          title: 'Bot 管理（全局）',
          subtitle: '统一管理 Bot，在单聊与群聊中随时协作。',
          className: 'bt-bot-library',
          icon: h(WelcomeIcon, { name: 'bot' }),
          width: 720,
          onClose,
          footer: [
            h('div', { key: 'note', className: 'bt-library-note' },
              h(WelcomeIcon, { name: 'info' }),
              h('span', null, '单聊与各群聊的会话和记忆相互独立。'),
            ),
            h('button', { key: 'close', className: 'bt-library-close', style: S.ghostBtn, onClick: onClose }, '关闭'),
          ],
        },
        error ? h('div', { role: 'alert', style: { ...S.errorBanner, borderRadius: 10, marginBottom: 14 } }, error) : null,
        bots.length === 0
          ? h('div', { className: 'bt-library-empty' },
              h('div', { className: 'bt-library-empty-icon' }, h(WelcomeIcon, { name: 'bot' })),
              h('h3', null, '还没有 Bot'),
              h('p', null, '创建你的第一个 Bot，开始单聊或邀请它加入群聊。'),
              createButton,
            )
          : h(React.Fragment, null,
              h('div', { className: 'bt-library-toolbar' },
                h('h3', { className: 'bt-library-count' },
                  '全部 Bot',
                  h('span', { 'aria-label': uiT('共 {count} 个 Bot', { count: bots.length }) }, bots.length),
                ),
                createButton,
              ),
              h('ul', { className: 'bt-library-list', 'aria-label': '全部 Bot' }, bots.map((bot) => {
                const inGroups = groupChatsOf(bot.botId);
                const runtimeLabel = `${bot.provider || '—'} / ${bot.model || '—'}`;
                const deleting = busyId === bot.botId;
                return h('li', { key: bot.botId, className: 'bt-library-card', 'aria-busy': deleting },
                  h('div', { className: 'bt-library-card-head' },
                    h(Avatar, { bot, size: 44 }),
                    h('div', { className: 'bt-library-identity' },
                      h('div', { className: 'bt-library-heading' },
                        h('h3', { className: 'bt-library-name', title: bot.name, raw: true }, bot.name),
                        h('span', { className: 'bt-library-runtime', title: runtimeLabel, raw: true }, runtimeLabel),
                      ),
                      h('dl', { className: 'bt-library-details' },
                        h('div', { className: 'bt-library-detail' },
                          h('dt', null, '所属群聊'),
                          h(BotLibraryGroups, { groups: inGroups }),
                        ),
                      ),
                    ),
                  ),
                  h('div', { className: 'bt-library-actions' },
                    h('button', {
                      type: 'button', className: 'bt-library-action',
                      'aria-label': uiT('编辑 Bot：{name}', { name: bot.name }),
                      onClick: () => onEdit(bot),
                    }, h(MessageActionIcon, { name: 'edit' }), '编辑'),
                    h('button', {
                      type: 'button', className: 'bt-library-action bt-library-delete',
                      title: deleting ? uiT('删除中…') : uiT('删除 Bot：{name}', { name: bot.name }),
                      'aria-label': deleting ? uiT('删除中…') : uiT('删除 Bot：{name}', { name: bot.name }),
                      disabled: deleting, onClick: () => void remove(bot),
                    }, deleting ? '…' : h(MessageActionIcon, { name: 'delete' })),
                  ),
                );
              })),
            ),
      );
    }
    function BotLibraryDialog(props) {
      const values = [];
      for (const bot of (props && props.bots) || []) values.push(bot.name, bot.provider, bot.model);
      for (const group of (props && props.groups) || []) values.push(group.title);
      return withContent(values, () => renderBotLibraryDialog(props));
    }


    function renderBotFormDialog({ bot, modelCatalog, onClose, onSaved }) {
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
              setPersonaStatus(uiT('读取 BOT.md 失败：{error}', { error: String(reason && reason.message ? reason.message : reason) }));
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
          alreadyApplied ? uiT('当前内容已包含该模板，未重复插入。') : uiT('已插入「{title}」模板，可按需修改。', { title: template.title }),
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
        const art = BOT_ART_AVATARS[Math.floor(Math.random() * (BOT_ART_AVATARS.length + 1))];
        if (art) {
          const palette = ROBOT_PALETTES[Math.floor(Math.random() * ROBOT_PALETTES.length)];
          setAvatar(`art:${art.id}:${palette.id}`);
          return;
        }
        const seed = `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        setAvatar(`preset:${seed}`);
      };

      const handleAvatarFile = async (file) => {
        if (!file) return;
        try {
          setAvatar(await createAvatarDataUrl(file));
          setError('');
        } catch (reason) {
          setError(uiT('头像读取失败：{error}', { error: String(reason && reason.message ? reason.message : reason) }));
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
        if (!window.confirm(uiT('删除 Bot「{name}」？它会从所有群移除，单聊与单聊消息也会一并删除。', { name: bot.name }))) return;
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
          title: editing ? uiT('编辑 Bot：{name}', { name: bot.name }) : uiT('新建 Bot'),
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
            horizontal: true,
            hint: '群里 @ 时使用；Bot 之间也用它互相称呼。',
            style: { marginBottom: 16, gridTemplateColumns: 'max-content minmax(0, 1fr)', columnGap: 8 },
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
          { style: S.botAvatarRow, role: 'group', 'aria-label': '头像' },
          h(
            'div',
            {
              style: { ...S.avatarPreview, width: 72, height: 72, gridRow: '1 / span 2' },
              title: avatar.startsWith('data:')
                ? '已上传自定义图片（自动裁成 256×256 方形）。'
                : avatar.startsWith('art:')
                  ? '当前是插画头像；可随机换机器人或重置为按名称生成。'
                  : avatar.startsWith('preset:')
                    ? '当前是随机生成的机器人头像；可再次随机或重置为按名称生成。'
                    : '默认按名称生成机器人头像；点「随机生成」换一个配色/表情。',
            },
            h(Avatar, {
              bot: { avatar, name: name.trim() || 'A', color: (bot && bot.color) || '#2f7ed8' },
              name: name.trim() || 'A',
              color: (bot && bot.color) || '#2f7ed8',
              size: 72,
            }),
          ),
          h(
            'div',
            { style: S.botAvatarControls },
            h('button', { type: 'button', style: S.smallBtn, onClick: randomizeAvatar }, '随机生成'),
            h(
              'button',
              { type: 'button', style: S.smallBtn, onClick: () => avatarFileRef.current && avatarFileRef.current.click() },
              '上传图片',
            ),
            avatar
              ? h('button', { type: 'button', style: S.smallBtn, onClick: () => setAvatar('') }, '重置')
              : null,
          ),
          h(
            'div',
            { style: S.botAvatarOptions, role: 'group', 'aria-label': '预置头像' },
            BOT_ART_AVATARS.map((art) =>
              h(
                'button',
                {
                  key: art.id,
                  type: 'button',
                  title: art.label,
                  'aria-label': art.label,
                  'aria-pressed': parseArtAvatar(avatar)?.id === art.id,
                  style: { ...S.artOption(parseArtAvatar(avatar)?.id === art.id), width: 36, height: 36, flex: '0 0 auto' },
                  onClick: () => setAvatar(`art:${art.id}`),
                },
                h(ArtAvatar, { id: art.id, size: 30 }),
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
            { label: 'Provider', horizontal: true, style: { marginBottom: 0 } },
            h(
              'select',
              { style: S.select, value: provider, onChange: (event) => onProviderChange(event.target.value) },
              groups.map((group) => h('option', { key: group.id, value: group.id }, group.name || group.id)),
            ),
          ),
          h(
            Field,
            { label: 'Model', horizontal: true, style: { marginBottom: 0 } },
            h(
              'select',
              { style: S.select, value: model, onChange: (event) => setModel(event.target.value) },
              (providerGroup ? providerGroup.models : []).map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name || entry.id)),
            ),
          ),
          h(
            Field,
            { label: 'Reasoning effort', horizontal: true, style: { marginBottom: 0 } },
            h(
              'select',
              { style: S.select, value: reasoningEffort, onChange: (event) => setReasoningEffort(event.target.value) },
              h('option', { value: '' }, '默认'),
              efforts.map((effort) => h('option', { key: effort.id, value: effort.id }, effort.name || effort.id)),
            ),
          ),
          h(
            Field,
            { label: '可用工具', horizontal: true, style: { marginBottom: 0 } },
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
            placeholder: `${uiT('例如（也可点「插入模板」选一套）：')}\n${PERSONA_TEMPLATE}`,
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
                        h('span', { style: S.templateMenuHint }, uiT('{count} 个可选', { count: PERSONA_TEMPLATES.length })),
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
            h('span', { style: S.charCount }, uiT('{count} 字', { count: botMd.length })),
          ),
        ),
      );
    }
    function BotFormDialog(props) {
      const bot = props && props.bot;
      return withContent([bot && bot.name, bot && bot.md], () => renderBotFormDialog(props));
    }


    function renderAddMemberDialog({ group, bots, members, onClose, onSaved }) {
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
          title: uiT('添加成员到「{title}」', { title: group.title }),
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
                { style: S.select, value: botId, onChange: (event) => setBotId(event.target.value) },
                available.map((bot) => h('option', { key: bot.botId, value: bot.botId }, `${bot.name}（${bot.model}）`)),
              ),
            ),
      );
    }
    function AddMemberDialog(props) {
      const values = [];
      const group = props && props.group;
      if (group) values.push(group.title);
      for (const bot of (props && props.bots) || []) values.push(bot.name, bot.provider, bot.model);
      return withContent(values, () => renderAddMemberDialog(props));
    }


    function renderReviewDialog({ target, group, members, bots, onClose, onSaved, onConversationError }) {
      const expectedConversationId = React.useRef(currentConversationId(group)).current;
      const stale = historicalMessage(target, group) || expectedConversationId !== currentConversationId(group);
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
        if (!reviewerMembershipId || stale || busy) return;
        setBusy(true);
        setError('');
        try {
          await api.action('review.request', {
            groupId: group.groupId,
            expectedConversationId,
            targetMessageId: target.messageId,
            reviewerMembershipId,
            instructions,
          });
          uiReport({ kind: 'action', action: 'review.request' });
          onSaved();
        } catch (reason) {
          onConversationError?.(reason, group.groupId);
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
            h('button', { key: 'ok', style: S.primaryBtn, disabled: busy || !reviewerMembershipId || stale, onClick: () => void submit() }, '发起评审'),
          ],
        },
        error ? h('div', { style: { ...S.errorBanner, borderRadius: 8, marginBottom: 10 } }, error) : null,
        stale ? h('p', { role: 'status' }, '历史会话只读，请明确引用到当前会话') : null,
        h(Field, { label: uiT('被评审消息 #{seq}', { seq: target.seq }) }, h('div', { style: { ...S.input, maxHeight: 120, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 12, color: 'var(--bt-text-2)' } }, translateSystemText(target.text) || '（空）')),
        h(
          Field,
          { label: '评审者' },
          h(
            'select',
            { style: S.select, value: reviewerMembershipId, onChange: (event) => setReviewerMembershipId(event.target.value) },
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
    function ReviewDialog(props) {
      const values = [];
      const target = props && props.target;
      const group = props && props.group;
      if (group) values.push(group.title, group.topic);
      if (target) values.push(target.text, target.authorName, target.error);
      for (const member of (props && props.members) || []) {
        const bot = member && member.bot;
        if (bot) values.push(bot.name);
      }
      return withContent(values, () => renderReviewDialog(props));
    }


    function renderDiscussionDialog({ group, members, bots, defaultTopic, onClose, onSaved, onConversationError }) {
      const expectedConversationId = React.useRef(currentConversationId(group)).current;
      const stale = expectedConversationId !== currentConversationId(group);
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
        if (busy || stale) return;
        setBusy(true);
        setError('');
        try {
          await api.action('discussion.start', {
            groupId: group.groupId,
            expectedConversationId,
            topic,
            membershipIds: selected,
            rounds,
            summarize,
          });
          uiReport({ kind: 'action', action: 'discussion.start' });
          onSaved();
        } catch (reason) {
          onConversationError?.(reason, group.groupId);
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
            h('button', { key: 'ok', style: S.primaryBtn, disabled: busy || selected.length === 0 || stale, onClick: () => void submit() }, '开始讨论'),
          ],
        },
        error ? h('div', { style: { ...S.errorBanner, borderRadius: 8, marginBottom: 10 } }, error) : null,
        stale ? h('p', { role: 'status' }, '聊天已开始新会话，请关闭对话框后重试') : null,
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
              { style: S.select, value: rounds, onChange: (event) => setRounds(Number(event.target.value)) },
              [1, 2, 3, 4, 5].map((value) => h('option', { key: value, value }, pluralUi('1 轮', '{count} 轮', value))),
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
    function DiscussionDialog(props) {
      const values = [];
      const group = props && props.group;
      if (group) values.push(group.title, group.topic);
      for (const member of (props && props.members) || []) {
        const bot = member && member.bot;
        if (bot) values.push(bot.name);
      }
      return withContent(values, () => renderDiscussionDialog(props));
    }


    /** Re-render the page when DSH switches the UI language. */
    function useLocaleRevision() {
      const [revision, setRevision] = React.useState(0);
      React.useEffect(() => {
        const locale = appCtx && appCtx.locale;
        if (!locale || typeof locale.subscribe !== 'function') return undefined;
        return locale.subscribe(() => setRevision((value) => value + 1));
      }, []);
      return revision;
    }

    // ── page ──────────────────────────────────────────────────────────────
    function BotTeamPage() {
      // Read browser preferences per mount: initialState is module-level and
      // would otherwise restore values from the first page load.
      const [state, dispatch] = React.useReducer(reducer, initialState, (initial) => ({
        ...initial,
        sidebarCollapsed: readSidebarCollapsed(),
        sidebarShowDirect: readSidebarShowDirect(),
        rightPanelCollapsed: readRightPanelCollapsed(),
        sectionsCollapsed: readSectionsCollapsed(),
      }));
      useLocaleRevision();
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
        persistSidebarShowDirect(state.sidebarShowDirect !== false);
      }, [state.sidebarShowDirect]);

      React.useEffect(() => {
        persistRightPanelCollapsed(state.rightPanelCollapsed === true);
      }, [state.rightPanelCollapsed]);

      React.useEffect(() => {
        persistSectionsCollapsed(state.sectionsCollapsed || {});
      }, [state.sectionsCollapsed]);

      const [executionTarget, setExecutionTarget] = React.useState(null);
      const [sessionTarget, setSessionTarget] = React.useState(null);
      const [conversationLogTarget, setConversationLogTarget] = React.useState(null);
      const conversationControlRef = React.useRef(null);
      const pendingConversationScrollRef = React.useRef(null);
      const activeExecutionTarget = executionTarget?.groupId === state.activeGroupId && !isDeletedMessage(state, executionTarget.groupId, executionTarget.message.messageId) ? executionTarget : null;
      const execution = useMessageExecution(sessionTarget ? null : activeExecutionTarget);
      const sessionHistory = useMessageExecution(sessionTarget);
      const historyReturnFocus = React.useRef(null);
      const returnFromSession = React.useCallback(() => setSessionTarget(null), []);
      React.useEffect(() => {
        if (sessionTarget || !historyReturnFocus.current) return;
        if (!activeExecutionTarget && historyReturnFocus.current.isConnected) historyReturnFocus.current.focus({ preventScroll: true });
        historyReturnFocus.current = null;
      }, [sessionTarget, activeExecutionTarget]);
      const closeExecution = React.useCallback(() => setExecutionTarget(null), []);
      // Log viewing stays read-only and independent of native main-panel navigation.
      const openBotHistory = (sessionId, onError, groupId = state.activeGroupId, botNameSnapshot) => {
        if (!sessionId || !groupId) {
          onError?.(uiT('这条消息尚未记录对应会话。'));
          return;
        }
        const member = state.members.find(item => item.groupId === groupId && item.sessionId === sessionId);
        historyReturnFocus.current = typeof document !== 'undefined' ? document.activeElement : null;
        setHeaderMenuOpen(false);
        setMessageMenu(null);
        setMobileSidebarOpen(false);
        setSessionTarget({
          mode: 'session', groupId, sessionId,
          groupTitle: state.groups.find(group => group.groupId === groupId)?.title || '',
          botName: (typeof botNameSnapshot === 'string' ? botNameSnapshot : null) || (activeExecutionTarget?.groupId === groupId ? activeExecutionTarget.message?.author?.name : null) || (member ? nameOfBot(state.bots, member.botId) : 'Bot'),
        });
      };
      const openMemberHistory = member => {
        const owner = state.groups.find(group => group.groupId === member.groupId);
        openBotHistory(currentMemberSession(member, owner) || member.sessionId,
          message => dispatch({ type: 'error', message }), member.groupId);
      };
      const mergeConversationError = (error, groupId = state.activeGroupId) => {
        if (error?.details) dispatch({ type: 'conversationState', groupId, data: error.details });
        if (error?.code === 'stale-conversation' || error?.code === 'reload-required') dispatch({ type: 'refreshTick' });
      };
      useSse(sessionTarget?.groupId || state.activeGroupId, dispatch, frame => {
        if (sessionTarget) sessionHistory.controller.current?.notify(frame);
        else if (activeExecutionTarget) execution.controller.current?.notify(frame);
      });

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
        const knownMessages = state.messagesByGroup[state.activeGroupId] || [];
        api.messages(state.activeGroupId)
          .then((result) => {
            if (cancelled) return;
            dispatch({ type: 'messages', groupId: state.activeGroupId, messages: result.messages || [], hasMore: result.hasMore === true, knownMessages, data: result });
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
      const conversations = state.conversationsByGroup?.[state.activeGroupId] || EMPTY_MESSAGES;
      const openConversationLogs = conversation => {
        if (!conversation || !activeGroup) return;
        setHeaderMenuOpen(false);
        setConversationLogTarget({ groupId: activeGroup.groupId, conversation });
      };
      React.useEffect(() => {
        if (!state.activeGroupId || !state.capabilities?.conversations) return;
        let cancelled = false;
        api.conversations(state.activeGroupId).then(data => {
          if (!cancelled) dispatch({ type: 'conversations', groupId: state.activeGroupId, data, hasMore: data.hasMore });
        }).catch(error => { if (!cancelled) dispatch({ type: 'error', message: String(error?.message || error) }); });
        return () => { cancelled = true; };
      }, [state.activeGroupId, activeGroup?.conversationVersion, state.capabilities?.conversations]);
      const showWelcome = shouldShowWelcome(state);
      const members = state.members.filter((member) => member.groupId === state.activeGroupId);
      const activeIsDirect = isDirectGroup(activeGroup);
      const activeDirectMember = activeIsDirect ? members[0] || null : null;
      const activeDirectBot = activeIsDirect
        ? state.bots.find((bot) => bot.botId === activeGroup.botId) || null
        : null;
      const messages = state.messagesByGroup[state.activeGroupId] || EMPTY_MESSAGES;
      const timelineRef = React.useRef(null);
      const mobileSidebarRef = React.useRef(null);
      const [mobileSidebarOpen, setMobileSidebarOpen] = React.useState(false);
      React.useEffect(() => { setMobileSidebarOpen(false); }, [state.activeGroupId, state.dialog]);
      React.useEffect(() => {
        if (!mobileSidebarOpen) return;
        const releaseFocus = containModalFocus(mobileSidebarRef.current);
        const closeOnEscape = (event) => { if (event.key === 'Escape') setMobileSidebarOpen(false); };
        const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(([entry]) => {
          if (entry.contentRect.width > 760) setMobileSidebarOpen(false);
        }) : null;
        if (mobileSidebarRef.current?.parentElement) resizeObserver?.observe(mobileSidebarRef.current.parentElement);
        window.addEventListener('keydown', closeOnEscape);
        return () => {
          window.removeEventListener('keydown', closeOnEscape);
          resizeObserver?.disconnect();
          releaseFocus?.();
        };
      }, [mobileSidebarOpen]);
      const [replyTarget, setReplyTarget] = React.useState(null);
      const [messageMenu, setMessageMenu] = React.useState(null);
      const deletingMessageIds = React.useRef(new Set());
      React.useEffect(() => {
        setReplyTarget(current => current && isDeletedMessage(state, current.groupId || state.activeGroupId, current.messageId) ? null : current);
        setMessageMenu(current => current && isDeletedMessage(state, current.groupId, current.message.messageId) ? null : current);
        setExecutionTarget(current => current && isDeletedMessage(state, current.groupId, current.message.messageId) ? null : current);
      }, [state.deletedMessageIdsByGroup, state.activeGroupId]);
      const [headerMenuOpen, setHeaderMenuOpen] = React.useState(false);
      const [showJump, setShowJump] = React.useState(false);
      const [newCount, setNewCount] = React.useState(0);
      const [unreadFromSeq, setUnreadFromSeq] = React.useState(null);
      const scrollStateRef = React.useRef({ groupId: null, lastSeq: 0, stick: true });
      const pendingPrependRef = React.useRef(null);
      React.useEffect(() => {
        const node = timelineRef.current;
        if (!node) return;
        const pending = pendingConversationScrollRef.current;
        if (pending?.groupId === state.activeGroupId) {
          const divider = Array.from(node.querySelectorAll('[data-conversation-id]')).find(item => item.getAttribute('data-conversation-id') === pending.conversationId);
          if (divider) { divider.scrollIntoView({ block: 'end' }); pendingConversationScrollRef.current = null; scrollStateRef.current.stick = true; }
        } else if (pendingPrependRef.current?.metadataOnly) {
          const anchor = pendingPrependRef.current;
          pendingPrependRef.current = null;
          node.scrollTop = anchor.top + node.scrollHeight - anchor.height;
        }
      }, [conversations, state.activeGroupId]);

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
        setExecutionTarget(current => current?.groupId === state.activeGroupId ? current : null);
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
        const focused = typeof document === 'undefined' ? null : document.activeElement;
        const returnFocus = focused && focused !== document.body && !focused.closest?.('.bt-msg-menu') ? focused : event.currentTarget;
        setMessageMenu({ message, x, y, groupId: activeGroup ? activeGroup.groupId : null, returnFocus });
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
      const openReview = (message) => { if (!historicalMessage(message, activeGroup)) dispatch({ type: 'dialog', dialog: { kind: 'review', target: message } }); };
      const openDiscussion = () =>
        dispatch({ type: 'dialog', dialog: { kind: 'discussion', defaultTopic: '' } });

      const doRevise = async (reviewMessage) => {
        if (historicalMessage(reviewMessage, activeGroup)) return;
        try {
          await api.action('review.revise', { groupId: activeGroup.groupId, expectedConversationId: currentConversationId(activeGroup), reviewMessageId: reviewMessage.messageId });
          uiReport({ kind: 'action', action: 'review.revise' });
          dispatch({ type: 'messagesTick' });
        } catch (error) {
          mergeConversationError(error, activeGroup.groupId);
          dispatch({ type: 'error', message: String(error && error.message ? error.message : error) });
        }
      };
      const doRetry = async (message) => {
        if (historicalMessage(message, activeGroup)) return;
        try {
          await api.action('message.retry', { groupId: activeGroup.groupId, expectedConversationId: currentConversationId(activeGroup), messageId: message.messageId });
          uiReport({ kind: 'action', action: 'message.retry' });
          dispatch({ type: 'messagesTick' });
        } catch (error) {
          mergeConversationError(error, activeGroup.groupId);
          dispatch({ type: 'error', message: String(error && error.message ? error.message : error) });
        }
      };
      const deleteMessage = async (message) => {
        if (!isPlainChatMessage(message) || ['pending', 'streaming'].includes(message.status)) return;
        const groupId = message.groupId || activeGroup?.groupId;
        const messageId = message.messageId;
        if (!groupId || deletingMessageIds.current.has(messageId) || isDeletedMessage(state, groupId, messageId)) return;
        if (!window.confirm(uiT('删除这条消息？删除后无法恢复。'))) return;
        deletingMessageIds.current.add(messageId);
        try {
          await api.action('message.delete', { groupId, messageId });
          dispatch({ type: 'messageDeleted', groupId, messageId });
          dispatch({ type: 'flash', message: '已删除消息' });
        } catch (error) {
          dispatch({ type: 'error', message: String(error && error.message ? error.message : error) });
        } finally {
          deletingMessageIds.current.delete(messageId);
        }
      };
      const stopDiscussion = async () => {
        const discussion = state.discussions[activeGroup.groupId];
        if (!discussion) return;
        try {
          await api.action('discussion.stop', { groupId: activeGroup.groupId, expectedConversationId: currentConversationId(activeGroup), discussionId: discussion.discussionId });
          dispatch({ type: 'messagesTick' });
          dispatch({ type: 'refreshTick' });
        } catch (error) {
          mergeConversationError(error, activeGroup.groupId);
          dispatch({ type: 'error', message: String(error && error.message ? error.message : error) });
        }
      };
      const loadEarlier = async () => {
        if (!activeGroup) return;
        const first = messages[0];
        if (!first) { await loadEarlierConversations(); return; }
        const node = timelineRef.current;
        try {
          const result = await api.messages(activeGroup.groupId, first.seq);
          if (scrollStateRef.current.groupId !== activeGroup.groupId) return;
          if (node) pendingPrependRef.current = { height: node.scrollHeight, top: node.scrollTop };
          dispatch({
            type: 'prependMessages',
            data: result,
            groupId: activeGroup.groupId,
            messages: result.messages || [],
            hasMore: result.hasMore === true,
          });
        } catch (error) {
          pendingPrependRef.current = null;
          dispatch({ type: 'error', message: String(error && error.message ? error.message : error) });
        }
      };

      const loadEarlierConversations = async () => {
        if (!activeGroup || !state.capabilities?.conversations) return;
        const first = conversations[0];
        try {
          const data = await api.conversations(activeGroup.groupId, { beforeOrdinal: first?.ordinal });
          if (scrollStateRef.current.groupId !== activeGroup.groupId) return;
          const node = timelineRef.current;
          if (node) pendingPrependRef.current = { height: node.scrollHeight, top: node.scrollTop, metadataOnly: true };
          dispatch({ type: 'conversations', groupId: activeGroup.groupId, data, hasMore: data.hasMore });
        } catch (error) { dispatch({ type: 'error', message: String(error?.message || error) }); }
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
        if (!window.confirm(uiT('删除群「{title}」及其全部消息？', { title: group.title }))) return;
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
          ? uiT('删除分组「{title}」？其中 {count} 个群会移到「未分组」，不会被删除。', { title: folder.title, count })
          : uiT('删除分组「{title}」？', { title: folder.title });
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
            `${pluralUi('1 位成员', '{count} 位成员', members.length)}${botMembers.length ? ' · ' + pluralUi('1 个 Bot', '{count} 个 Bot', botMembers.length) : ''}`,
            activeGroup && activeGroup.topic ? activeGroup.topic : '',
          ]
            .filter(Boolean)
            .join(' · ');
      const menuItem = (label, onClick, danger, disabled = false, title) =>
        h(
          'button',
          {
            type: 'button',
            role: 'menuitem',
            className: `bt-menu-item${danger ? ' bt-menu-danger' : ''}`,
            style: { ...S.menuItem, ...(danger ? S.menuDanger : null) },
            disabled, title,
            onClick,
          },
          label,
        );

      const exportMarkdown = async () => {
        if (!activeGroup) return;
        try {
          const allMessages = await collectAllMessages(activeGroup.groupId, { includeConversations: state.capabilities?.conversations === true });
          if (allMessages.truncated) dispatch({ type: 'flash', message: '导出不完整：已达到 50 页读取上限或历史分页中断，更早内容可能未包含。' });
          const markdown = buildGroupMarkdown({ group: activeGroup, members, bots: state.bots, messages: allMessages });
          const date = new Date().toISOString().slice(0, 10);
          downloadText(safeExportName(activeGroup.title, 'bot-team') + '-' + date + '.md', markdown);
          uiReport({ kind: 'action', action: 'group.export' });
        } catch (error) {
          dispatch({ type: 'error', message: String(error && error.message ? error.message : error) });
        }
      };

      const exportHtml = async () => {
        if (!activeGroup) return;
        try {
          const allMessages = await collectAllMessages(activeGroup.groupId, { includeConversations: state.capabilities?.conversations === true });
          if (allMessages.truncated) dispatch({ type: 'flash', message: '导出不完整：已达到 50 页读取上限或历史分页中断，更早内容可能未包含。' });
          const html = buildGroupHtml({ group: activeGroup, members, bots: state.bots, messages: allMessages });
          const date = new Date().toISOString().slice(0, 10);
          downloadText(safeExportName(activeGroup.title, 'bot-team') + '-' + date + '.html', html, 'text/html;charset=utf-8');
          uiReport({ kind: 'action', action: 'group.export-html' });
        } catch (error) {
          dispatch({ type: 'error', message: String(error && error.message ? error.message : error) });
        }
      };

      const exportPdf = async () => {
        if (!activeGroup) return;
        try {
          const response = await api.exportPdf(activeGroup.groupId, uiLocale());
          if (!response.ok) {
            const body = await response.json().catch(() => null);
            const message = body && body.error && body.error.message ? body.error.message : `HTTP ${response.status}`;
            throw new Error(message);
          }
          const blob = await response.blob();
          const date = new Date().toISOString().slice(0, 10);
          downloadBlob(safeExportName(activeGroup.title, 'bot-team') + '-' + date + '.pdf', blob);
          uiReport({ kind: 'action', action: 'group.export-pdf' });
        } catch (error) {
          dispatch({ type: 'error', message: String(error && error.message ? error.message : error) });
        }
      };

      const dialog = state.dialog;

      const chat = h(
        'div',
        { className: 'bt-chat-view', hidden: !!sessionTarget, 'data-view': 'chat', style: { position: 'relative', height: '100%', minHeight: 0, display: sessionTarget ? 'none' : 'flex', flexDirection: 'column' } },
        state.flash ? h('div', { style: S.flash }, state.flash) : null,
        state.error
          ? h(
              'div',
              { className: 'bt-root', style: S.errorBanner, onClick: () => dispatch({ type: 'error', message: '' }) },
              uiT('{error}（点击关闭）', { error: uiT(state.error) }),
            )
          : null,
        h('style', { key: 'bt-global-css' }, GLOBAL_CSS),
        h(
          'div',
          { className: 'bt-root bt-page', 'data-home': showWelcome ? 'true' : 'false', 'data-mobile-sidebar': mobileSidebarOpen ? 'true' : 'false', style: { ...S.root, flex: 1, minHeight: 0 } },
          mobileSidebarOpen && showWelcome ? h('button', { type: 'button', className: 'bt-welcome-scrim', 'aria-label': '关闭导航', onClick: () => setMobileSidebarOpen(false) }) : null,
          h(GroupList, {
            state,
            dispatch,
            sidebarRef: mobileSidebarRef,
            mobileNavigation: mobileSidebarOpen && showWelcome,
            onShowWelcome: () => setMobileSidebarOpen(false),
            onCreate: openGroupCreate,
            onCreateBot: openBotCreate,
            onCreateFolder: openFolderCreate,
            onOpenDirect: openDirect,
            onEditGroup: openGroupEdit,
            onDeleteGroup: deleteGroup,
            onEditBot: openBotEdit,
            onViewSession: openMemberHistory,
            onOpenNativeSession: openMemberHistory,
            onCreateGroupInFolder: openGroupCreate,
            onRenameFolder: openFolderEdit,
            onDeleteFolder: deleteFolder,
            onReorderGroups: reorderGroups,
            onReorderFolders: reorderFolders,
          }),
          h(
            'div',
            { className: 'bt-main-panel', style: S.center },
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
                        h('div', { style: S.chatTitle, title: activeGroup.title, raw: true }, activeGroup.title),
                        runningMembers.length > 0
                          ? h(
                              'span',
                              { style: S.headerLive },
                              h('span', { style: S.headerLiveDot }),
                              uiT('{count} 个回复中', { count: runningMembers.length }),
                            )
                          : null,
                      ),
                      h('div', { style: S.chatTopic, title: headerSubtitle, raw: true }, headerSubtitle),
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
                                 menuItem('新建会话', () => { setHeaderMenuOpen(false); void conversationControlRef.current?.startConversation('menu'); }, false,
                                   !!conversationBlockReason(activeGroup, state.capabilities), conversationBlockReason(activeGroup, state.capabilities) || conversationActivityHint(activeGroup) || uiT(activeIsDirect ? '开始新的对话上下文，历史仍可查看' : '为本群全部成员开始新会话')),
                                 currentConversationId(activeGroup) ? menuItem(members.some(member => currentMemberSession(member, activeGroup)) ? '本会话日志' : '本会话尚无日志', () => openConversationLogs(activeGroup.currentConversation)) : null,
                                 activeGroup.currentConversation?.previousConversationId ? menuItem('上一会话日志', () => {
                                   const previous = conversations.find(item => item.conversationId === activeGroup.currentConversation.previousConversationId);
                                   openConversationLogs(previous || { conversationId: activeGroup.currentConversation.previousConversationId, ordinal: activeGroup.currentConversation.ordinal - 1 });
                                 }) : null,
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
                                  ? currentConversationId(activeGroup) ? null : menuItem('查看日志', () => {
                                      setHeaderMenuOpen(false);
                                      if (activeDirectMember) {
                                        openBotHistory(activeDirectMember.sessionId, (message) => dispatch({ type: 'error', message }));
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
                                activeIsDirect ? null : menuItem('导出 PDF', () => {
                                  setHeaderMenuOpen(false);
                                  void exportPdf();
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
                  h(BackgroundInteractionPanel, {
                    groupId: activeGroup.groupId, currentConversationId: currentConversationId(activeGroup), snapshot: state.interactionsByGroup?.[activeGroup.groupId],
                    refreshTick: state.messagesTick, dispatch,
                  }),
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
                        { className: 'bt-message-column', style: S.messageColumn },
                        state.conversationHasMoreByGroup?.[activeGroup.groupId]
                          ? h('button', { type: 'button', className: 'bt-load-earlier', style: S.loadEarlier, onClick: () => void loadEarlierConversations() }, '加载更早的会话分段') : null,
                        state.hasMoreByGroup[activeGroup.groupId]
                          ? h(
                              'button',
                              { type: 'button', className: 'bt-load-earlier', style: S.loadEarlier, onClick: () => void loadEarlier() },
                              '加载更早的消息',
                            )
                          : null,
                        messages.length === 0 && conversations.length === 0
                          ? activeIsDirect
                            ? h(
                                'div',
                                { style: S.emptyState },
                                h('div', { style: S.emptyIcon }, '1:1'),
                                h('div', { style: S.emptyTitle }, uiT('和 {title} 打个招呼吧', { title: activeGroup.title })),
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
                              conversations, group: activeGroup, onViewConversationLogs: openConversationLogs,
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
                              onOpenSession: (sessionId, nativeSession) =>
                                openBotHistory(sessionId, (message) => dispatch({ type: 'error', message }), activeGroup.groupId, typeof nativeSession === 'boolean' ? { id: sessionId, native: nativeSession, ...(nativeSession ? {} : { origin: 'subagent' }) } : undefined),
                            }),
                        h('div', { style: { height: 4, flex: '0 0 auto' } }),
                      ),
                    ),
                    showJump
                      ? h(
                          'button',
                          { type: 'button', className: 'bt-jump-btn', style: S.jumpButton, onClick: () => scrollToLatest('auto') },
                          newCount > 0 ? h('span', { className: 'bt-chat-scroll-badge' }, newCount > 99 ? '99+' : String(newCount)) : null,
                          newCount > 0 ? (newCount === 1 ? uiT('单条新消息') : uiT('条新消息')) : uiT('回到底部'),
                          h('span', { style: { fontSize: 10, color: 'var(--bt-text-3)' } }, '↓'),
                        )
                      : null,
                  ),
                  h(Composer, {
                    active: !sessionTarget,
                    conversationControlRef,
                    onConversationStarted: (result, groupId) => {
                      pendingConversationScrollRef.current = { groupId, conversationId: result.currentConversationId };
                      dispatch({ type: 'conversationState', groupId, data: result });
                    },
                    state,
                    dispatch,
                    group: activeGroup,
                    members,
                    bots: state.bots,
                    replyTarget,
                    userProfile,
                    onClearReply: () => setReplyTarget(null),
                    onExportMarkdown: () => {
                      void exportMarkdown();
                    },
                    onExportHtml: activeIsDirect
                      ? null
                      : () => {
                          void exportHtml();
                        },
                    onExportPdf: activeIsDirect
                      ? null
                      : () => {
                          void exportPdf();
                        },
                    onOpenSettings: () => dispatch({ type: 'dialog', dialog: { kind: 'settings' } }),
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
              : showWelcome ? h(WelcomeScreen, {
                  hasBots: state.bots.length > 0,
                  onCreateBot: openBotCreate,
                  onCreateGroup: () => openGroupCreate(),
                  onGuide: () => dispatch({ type: 'dialog', dialog: { kind: 'getting-started' } }),
                  sidebarOpen: mobileSidebarOpen,
                  onOpenSidebar: () => {
                    if (state.sidebarCollapsed) dispatch({ type: 'toggleSidebar' });
                    setMobileSidebarOpen(true);
                  },
                })
              : state.loading ? null : h('div', { style: S.emptyState },
                  h('div', { style: S.emptyTitle }, '选择一个单聊或群聊开始对话'),
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
                  running: activeDirectMember && state.statusByMember[activeDirectMember.membershipId] === 'running',
                  onEdit: openBotEdit,
                  onCollapse: () => dispatch({ type: 'toggleRightPanel' }),
                  onViewSession: openMemberHistory,
                  onOpenNativeSession: openMemberHistory,
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
                  onViewSession: openMemberHistory,
                  onOpenNativeSession: openMemberHistory,
                  onStopDiscussion: stopDiscussion,
                })
            : null,
          messageMenu && messageMenu.groupId === state.activeGroupId && !isDeletedMessage(state, messageMenu.groupId, messageMenu.message.messageId)
            ? h(MessageContextMenu, {
                group: activeGroup,
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
                onExecution: message => setExecutionTarget({ groupId: messageMenu.groupId, message, returnFocus: messageMenu.returnFocus }),
                onDelete: deleteMessage,
              })
            : null,
        ),
        !sessionTarget && activeExecutionTarget
          ? h(ExecutionDrawer, {
              key: executionTarget.groupId + ':' + executionTarget.message.messageId,
              target: executionTarget,
              state: execution.state,
              onClose: closeExecution,
              onRefresh: () => execution.controller.current?.refresh(),
              onOpenSession: openBotHistory,
              onOpenNativeSession: openBotHistory,
            })
          : null,
        dialog && dialog.kind === 'getting-started'
          ? h(GettingStartedDialog, {
              hasBots: state.bots.length > 0, onClose: closeDialog,
              onCreateBot: openBotCreate, onCreateGroup: () => openGroupCreate(),
            })
          : null,
        dialog && dialog.kind === 'settings'
          ? h(ChatSettingsDialog, {
              settings: state.chatDisplaySettings,
              sidebarShowDirect: state.sidebarShowDirect,
              pluginInfo: state.pluginInfo,
              onClose: closeDialog,
              onSaved: (settings, showDirect) => {
                dispatch({ type: 'chatDisplaySettings', settings });
                dispatch({ type: 'sidebarShowDirect', showDirect });
                dispatch({ type: 'flash', message: '设置已保存' });
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
        dialog && dialog.kind === 'review' && activeGroup
          ? h(ReviewDialog, { onConversationError: mergeConversationError, target: dialog.target, group: activeGroup, members, bots: state.bots, onClose: closeDialog, onSaved: afterChange })
          : null,
        dialog && dialog.kind === 'discussion' && activeGroup
          ? h(DiscussionDialog, {
              onConversationError: mergeConversationError,
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
      // Keep the chat mounted so returning restores its draft, scroll and source
      // message. The execution drawer unmounts while this distinct page is open.
      return h('div', { className: 'bt-page-host', style: { height: '100%', minHeight: 0, minWidth: 0 } },
        chat,
        conversationLogTarget ? h(ConversationLogsDialog, {
          key: conversationLogTarget.groupId + ':' + conversationLogTarget.conversation.conversationId,
          target: conversationLogTarget, onClose: () => setConversationLogTarget(null),
          onOpenSession: binding => { setConversationLogTarget(null); openBotHistory(binding.sessionId, message => dispatch({ type: 'error', message }), conversationLogTarget.groupId, binding.botNameSnapshot); },
        }) : null,
        sessionTarget ? h(SessionHistoryPage, {
          key: sessionTarget.groupId + ':' + sessionTarget.sessionId,
          target: sessionTarget, state: sessionHistory.state, onBack: returnFromSession,
          onRefresh: () => sessionHistory.controller.current?.refresh(),
          returnToExecution: !!activeExecutionTarget,
          onOpenNativeSession: openBotHistory,
        }) : null,
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
      inject: ['slots', 'locale', 'uiWorkspace', 'remote', 'remote.account'],
      apply(ctx) {
        appCtx = ctx;
        ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh: UI_ZH, en: UI_EN }), 'bot-team: dictionaries');
        localeRuntime = {
          t: ctx.locale.bind(LOCALE_NS),
          getLocale: () => (ctx.locale.getSnapshot ? ctx.locale.getSnapshot().active : 'zh'),
        };
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PAGE_KEY, locale: LOCALE_NS }, BotTeamPage));
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: PAGE_KEY, order: 40, label: 'Bot Team' }, PanelIcon),
        );
      },
    };
  },
});
