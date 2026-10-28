import test from 'node:test';
import assert from 'node:assert/strict';
import { loadClient, walk, text, plain } from './client-harness.js';

const noop = () => {};
const now = Date.now();

function state(overrides = {}) {
  return {
    statusByMember: {},
    bots: [],
    members: [],
    ...overrides,
  };
}

function composerProps(overrides = {}) {
  return {
    state: state(),
    dispatch: noop,
    group: { groupId: 'g1', kind: 'group', title: '群聊' },
    members: [],
    bots: [],
    replyTarget: null,
    userProfile: null,
    onClearReply: noop,
    onSent: noop,
    onResize: noop,
    onExportMarkdown: noop,
    onExportHtml: noop,
    onOpenSettings: noop,
    ...overrides,
  };
}

test('file and skill trigger helpers normalize names, queries and sizes', () => {
  const client = loadClient();
  assert.equal(client.formatFileSize(0), '0 B');
  assert.equal(client.formatFileSize(1536), '1.5 KB');
  assert.equal(client.formatFileSize(10 * 1024 * 1024), '10 MB');
  assert.equal(client.formatFileSize(-1), '');
  assert.equal(client.formatFileSize('nope'), '');

  assert.deepEqual(plain(client.findSkillTrigger('/', 1)), { start: 0, query: '' });
  assert.deepEqual(plain(client.findSkillTrigger('请 /off', 6)), { start: 2, query: 'off' });
  assert.deepEqual(plain(client.findSkillTrigger('hello /office-doc', 'hello /office-doc'.length)), { start: 6, query: 'office-doc' });
  assert.equal(client.findSkillTrigger('https://', 8), null);
  assert.equal(client.findSkillTrigger('a / b', 5), null);
  assert.equal(client.findSkillTrigger('/office ', 8), null);
  assert.equal(client.findSkillTrigger('x@y', 3), null);

  const skills = [
    { name: 'office' },
    { name: 'office-docx' },
    { name: 'pdf' },
    { name: 'data-analysis' },
  ];
  assert.deepEqual(plain(client.rankSkills(skills, '').map((skill) => skill.name)), ['office', 'office-docx', 'pdf', 'data-analysis']);
  assert.deepEqual(plain(client.rankSkills(skills, 'off').map((skill) => skill.name)), ['office', 'office-docx']);
  assert.deepEqual(plain(client.rankSkills(skills, 'odx').map((skill) => skill.name)), ['office-docx']);
  assert.deepEqual(plain(client.rankSkills(skills, 'zzz')), []);
});

test('the composer exposes a DSH-style grouped + command menu and keeps direct-chat @ behavior', () => {
  const client = loadClient({ localStorage: { getItem: () => null, setItem: () => {} } });
  const props = composerProps();
  let tree = client.render(client.Composer, props);
  const plus = walk(tree).find((node) => node.type === 'button' && node.props['aria-label'] === '添加文件或执行指令');
  assert.ok(plus, 'plus button exists');
  assert.equal(plus.props['aria-haspopup'], 'menu');
  const fileInput = walk(tree).find((node) => node.type === 'input' && node.props.type === 'file');
  assert.ok(fileInput, 'hidden file input exists');
  assert.equal(fileInput.props.multiple, true);
  assert.match(text(tree), /\/ 选择指令或 Skill/);
  assert.match(text(tree), /@ 提及/);

  plus.props.onClick();
  tree = client.render(client.Composer, props);
  const opened = text(tree);
  assert.match(opened, /添加/);
  assert.match(opened, /指令/);
  assert.match(opened, /文件/);
  assert.match(opened, /file/);
  assert.match(opened, /技能/);
  assert.match(opened, /skill/);
  assert.match(opened, /上传本地文件/);
  assert.match(opened, /插入 \/技能名/);
  assert.match(opened, /导出 Markdown/);
  assert.match(opened, /export/);
  assert.match(opened, /消息设置/);
  assert.match(opened, /settings/);
  assert.ok(walk(tree).find((node) => node.type === 'button' && node.props.role === 'menuitem' && text(node).includes('上传本地文件')));
  assert.ok(walk(tree).find((node) => node.type === 'button' && node.props.role === 'menuitem' && text(node).includes('插入 /技能名')));
  assert.ok(walk(tree).find((node) => node.type === 'button' && node.props.role === 'menuitem' && text(node).includes('导出 Markdown')));
  assert.ok(walk(tree).find((node) => node.type === 'button' && node.props.role === 'menuitem' && text(node).includes('消息设置')));

  const directClient = loadClient({ localStorage: { getItem: () => null, setItem: () => {} } });
  const direct = directClient.render(directClient.Composer, composerProps({
    group: { groupId: 'dm-1', kind: 'direct', title: 'Timi' },
    members: [{ membershipId: 'm1', botId: 'b1', groupId: 'dm-1' }],
    bots: [{ botId: 'b1', name: 'Timi', provider: 'deepseek', model: 'deepseek-chat' }],
    state: state({ statusByMember: {} }),
  }));
  assert.doesNotMatch(text(direct), /@ 提及/);
  const directInput = walk(direct).find((node) => node.type === 'textarea');
  assert.equal(directInput.props.placeholder, '给 Timi 发消息…');
  assert.ok(walk(direct).find((node) => node.type === 'button' && node.props['aria-label'] === '添加文件或执行指令'));
});

test('typing / fetches and opens the user-invocable skill picker', async () => {
  const calls = [];
  const client = loadClient({
    fetch: async (url) => {
      calls.push(String(url));
      return {
        status: 200,
        json: async () => ({
          ok: true,
          skills: [
            { name: 'office', description: 'Office documents', modelInvocable: true },
            { name: 'manual', description: 'Manual only', modelInvocable: false },
          ],
        }),
      };
    },
  });
  const props = composerProps();
  let tree = client.render(client.Composer, props);
  const input = walk(tree).find((node) => node.type === 'textarea');
  input.props.onChange({ target: { value: '/off', selectionStart: 4 } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  tree = client.render(client.Composer, props);
  const rendered = text(tree);
  assert.match(rendered, /选择指令或 Skill/);
  assert.match(rendered, /office/);
  assert.doesNotMatch(rendered, /Manual only/);
  assert.ok(calls.some((url) => url.includes('/api/bot-team.skills?groupId=g1')));
  assert.equal(walk(tree).filter((node) => node.props && node.props.role === 'option').length, 1);
});

test('message rows render durable attachment cards', () => {
  const client = loadClient();
  const message = {
    messageId: 'm1',
    groupId: 'g1',
    seq: 1,
    author: { type: 'human', name: '用户' },
    kind: 'chat',
    text: '',
    mentions: [],
    attachments: [
      { attachmentId: 'sha256:' + 'a'.repeat(64), name: 'brief.pdf', bytes: 1536, path: '/tmp/brief.pdf' },
    ],
    status: 'done',
    createdAt: now,
  };
  const row = client.MessageRow({
    message,
    bots: [],
    allMessages: [message],
    tasks: [],
    groupStart: true,
    groupEnd: true,
    chatDisplaySettings: client.DEFAULT_CHAT_DISPLAY_SETTINGS,
  });
  const rendered = text(row);
  assert.match(rendered, /brief\.pdf/);
  assert.match(rendered, /1\.5 KB/);
  assert.match(rendered, /只读附件/);
});
