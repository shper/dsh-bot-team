import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { buildGroupPdf, findPdfFont, PdfError } from '../host/pdf.js';

const font = await findPdfFont().catch(() => null);

const members = [
  { membershipId: 'm1', groupId: 'g1', botId: 'b1' },
  { membershipId: 'm2', groupId: 'g1', botId: 'b2' },
];
const bots = [
  { botId: 'b1', name: 'Timi', provider: 'deepseek', model: 'deepseek-chat' },
  { botId: 'b2', name: 'Mochi', provider: 'deepseek', model: 'deepseek-reasoner' },
];
const group = { groupId: 'g1', title: 'Bot 测试群 · PDF', topic: '验证中文嵌入与分页' };

function message(seq, overrides = {}) {
  return {
    messageId: 'm' + seq,
    seq,
    status: 'done',
    kind: 'chat',
    author: { type: 'bot', botId: 'b1', name: 'Timi' },
    text: '',
    createdAt: Date.now(),
    ...overrides,
  };
}

const sample = [
  message(1, { text: '# 你好，世界\n\n中文 **粗体** 与 \`code\` 混排。\n\n- 第一项\n- second item\n\n> 引用\n\n| 名称 | 数量 |\n|---|---|\n| 苹果 | 3 |\n\n\`\`\`js\nconsole.log("你好")\n\`\`\`' }),
  message(2, { author: { type: 'human', name: '我' }, text: '请评审这个方案。' }),
  message(3, { author: { type: 'bot', botId: 'b2', name: 'Mochi' }, meta: { verdict: 'pass', round: 2 }, text: '结论：通过。\n\n建议补充边界条件。' }),
  message(4, { author: { type: 'system', name: '系统' }, kind: 'system', text: '讨论「方案」结束。' }),
  message(5, { attachments: [{ name: 'report.pdf', bytes: 123456 }], text: '附件在这里。' }),
];

test('PDF export is skipped when no CJK font is installed', { skip: font !== null }, () => {
  assert.equal(font, null);
});

test('builds a selectable-text PDF with an embedded CJK subset', { skip: font === null }, async () => {
  const pdf = await buildGroupPdf({ group, members, bots, messages: sample, lang: 'zh' });
  assert.equal(pdf.subarray(0, 8).toString(), '%PDF-1.7');
  const text = pdf.toString('latin1');
  assert.match(text, /\/Type \/Font \/Subtype \/Type0/);
  assert.match(text, /\/FontFile2/);
  assert.match(text, /\/ToUnicode/);
  assert.match(text, /beginbfchar/);
  assert.match(text, /4F60/, '你 is in the ToUnicode map');
  assert.match(text, /\/MediaBox \[0 0 595.28 841.89\]/);
  assert.ok(pdf.length > 20000, 'embedded font makes a real document');
  assert.ok(pdf.length < 2_000_000, 'subset keeps the file small');
});

test('English labels and round/verdict badges are localized in the PDF', { skip: font === null }, async () => {
  const pdf = await buildGroupPdf({ group, members, bots, messages: sample, lang: 'en' });
  const text = pdf.toString('latin1');
  assert.match(text, /beginbfchar/);
  assert.match(text, /004D/);
  assert.ok(pdf.length > 20000);
});

function selectableText(pdf) {
  const source = pdf.toString('latin1');
  const unicode = new Map([...source.matchAll(/<([0-9a-f]{4})> <([0-9a-f]{4,})>/gi)].map(([, glyph, codes]) =>
    [glyph.toUpperCase(), String.fromCharCode(...codes.match(/.{4}/g).map(code => Number.parseInt(code, 16)))]));
  const streams = [...source.matchAll(/Length ([0-9]+) >>\nstream\n/g)].map(match => {
    const start = match.index + match[0].length;
    const bytes = pdf.subarray(start, start + Number(match[1]));
    return (source.slice(Math.max(0, match.index - 30), match.index).includes('/FlateDecode') ? inflateSync(bytes) : bytes).toString('latin1');
  }).join('\n');
  return [...streams.matchAll(/<([0-9a-f]+)> Tj/gi)].map(([, codes]) =>
    codes.match(/.{4}/g).map(code => unicode.get(code.toUpperCase()) || '').join('')).join('');
}

test('discussion exports preserve phase and side labels and localize start events', { skip: font === null }, async () => {
  const messages = [
    message(1, { author: { type: 'system' }, kind: 'system', text: '开始辩论：CUSTOM_TOPIC' }),
    message(2, { meta: { phase: 'question', side: 'pro', round: 1 }, text: 'USER_ARGUMENT' }),
    message(3, { meta: { phase: 'judgement', summary: true, round: 1 }, text: 'Verdict: insufficient' }),
  ];
  const english = selectableText(await buildGroupPdf({ group, members, bots, messages, lang: 'en' }));
  assert.match(english, /Started debate: CUSTOM_TOPIC/);
  assert.match(english, /Pro/);
  assert.match(english, /Question/);
  assert.match(english, /Judgement/);
  assert.match(english, /USER_ARGUMENT/);
  assert.doesNotMatch(english, /Discussion summary/);
  const chinese = selectableText(await buildGroupPdf({ group, members, bots, messages, lang: 'zh' }));
  for (const label of ['开始辩论：CUSTOM_TOPIC', '正方', '质询', '裁决']) assert.ok(chinese.includes(label), label);
});

test('long timelines paginate and keep page footers', { skip: font === null }, async () => {
  const messages = Array.from({ length: 80 }, (_, index) =>
    message(index + 1, {
      text: '第 ' + (index + 1) + ' 条消息：' + '这是一段用于验证分页的中文内容。'.repeat(6),
    }),
  );
  const pdf = await buildGroupPdf({ group, members, bots, messages, lang: 'zh' });
  const text = pdf.toString('latin1');
  const count = Number((text.match(/\/Count (\d+)/) || [])[1]);
  const pages = (text.match(/\/Type \/Page /g) || []).length;
  assert.ok(count > 1, 'multiple pages');
  assert.equal(pages, count, 'page objects and page count agree');
});

test('a missing font path produces a readable PdfError', { skip: font === null }, async () => {
  await assert.rejects(
    () => buildGroupPdf({ group, members, bots, messages: sample, fontPath: '/definitely/not/a/font.ttf' }),
    (error) => error instanceof PdfError && error.code === 'pdf-font-unavailable',
  );
});

function pdfFakeCtx(storageDirectory) {
  const tables = new Map();
  const domain = {
    unit: { constructor: { name: 'PerRecordJsonUnit' }, descriptor: { name: 'bot_team', layout: 'per-record' }, dir: storageDirectory },
    table(name) {
      if (!tables.has(name)) tables.set(name, new Map());
      const records = tables.get(name);
      return {
        entries: () => [...records.entries()].map(([key, value]) => [key, structuredClone(value)]),
        async put(key, value) { records.set(key, structuredClone(value)); },
        async delete(key) { records.delete(key); },
      };
    },
    async close() {},
  };
  return {
    logger: { info() {}, warn() {}, error() {} },
    storageDomain: {
      config: { backend: 'json' },
      ctx: { storage: { backend: { get: () => ({ constructor: { name: 'JsonStorageBackend' }, root: path.dirname(storageDirectory) }) } } },
      get: () => undefined,
      open: async () => domain,
    },
    connection: { fetch: { register: () => () => {} } },
    tools: { register: () => () => {} },
    on: () => () => {},
    get: () => undefined,
    agents: {},
    agentPresets: {},
  };
}

test('the Host PDF route returns a downloadable PDF and a readable 404', { skip: font === null }, async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const { BotTeamService } = await import('../host/service.js');
  const { resolveConfig } = await import('../host/util.js');
  const home = await mkdtemp(path.join(os.tmpdir(), 'bot-team-pdf-service-'));
  const service = new BotTeamService(
    pdfFakeCtx(path.join(home, 'storages', 'bot_team')),
    resolveConfig({
      dataDir: path.join(home, 'data'),
      botsDir: path.join(home, 'data', 'bots'),
      defaultCwd: home,
      migrateLegacyLayout: false,
      smokeResultsDir: path.join(home, 'smoke'),
    }),
  );
  try {
    await service.ready;
    const group = await service.dispatch('group.create', { title: 'PDF 群', topic: '导出测试' });
    const response = await service.handleExportPdf(
      new Request('http://localhost/api/bot-team.export.pdf?groupId=' + encodeURIComponent(group.groupId) + '&lang=en'),
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/pdf/);
    assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''/);
    const buffer = Buffer.from(await response.arrayBuffer());
    assert.equal(buffer.subarray(0, 8).toString(), '%PDF-1.7');
    assert.ok(buffer.length > 5000);

    const missing = await service.handleExportPdf(
      new Request('http://localhost/api/bot-team.export.pdf?groupId=missing'),
    );
    assert.equal(missing.status, 404);
    const body = await missing.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'not-found');
  } finally {
    await service.dispose().catch(() => {});
    await rm(home, { recursive: true, force: true });
  }
});
