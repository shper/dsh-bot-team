/**
 * PDF export for Bot Team group timelines.
 *
 * No PDF service is available in the DSH host, so this module writes a small
 * PDF 1.7 document itself and embeds a subset of a system CJK TrueType face.
 * The face is discovered at export time (platform font paths); fontkit handles
 * cmap lookup, shaping metrics and the subset. The PDF text is selectable and
 * searchable because the subset is a normal CIDFontType2 with ToUnicode.
 */
import { existsSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const A4 = Object.freeze({ width: 595.28, height: 841.89 });
const MARGIN = Object.freeze({ top: 54, bottom: 52, left: 48, right: 48 });
const CONTENT_WIDTH = A4.width - MARGIN.left - MARGIN.right;
const FOOTER_Y = 26;

export class PdfError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PdfError';
    this.code = code;
  }
}

const FONT_CANDIDATES = {
  darwin: [
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    '/System/Library/Fonts/Supplemental/Songti.ttc',
    '/System/Library/Fonts/STHeiti Light.ttc',
    '/Library/Fonts/Arial Unicode.ttf',
  ],
  win32: [
    'C:\\Windows\\Fonts\\msyh.ttc',
    'C:\\Windows\\Fonts\\msyh.ttf',
    'C:\\Windows\\Fonts\\simsun.ttc',
    'C:\\Windows\\Fonts\\simhei.ttf',
    'C:\\Windows\\Fonts\\arialuni.ttf',
  ],
  linux: [
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
    '/usr/share/fonts/truetype/arphic/uming.ttc',
    '/usr/share/fonts/truetype/arphic/ukai.ttc',
    '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf',
  ],
};

function faceScore(font) {
  const name = String(font.postscriptName || font.familyName || '').toLowerCase();
  let score = 0;
  if (/regular|w3|w4|medium|book/.test(name)) score += 8;
  if (/bold|black|heavy|semibold|w5|w6|w7|w8|w9/.test(name)) score -= 12;
  if (/light|thin|ultralight|extralight/.test(name)) score -= 8;
  if (/italic|oblique/.test(name)) score -= 8;
  if (/pingfang|yahei|hei|gothic|sans/.test(name)) score += 3;
  if (name.startsWith('.')) score -= 20;
  return score;
}

function pickFace(collection) {
  const faces = Array.isArray(collection && collection.fonts) ? collection.fonts : [collection];
  let best = null;
  for (const face of faces) {
    if (!face || typeof face.hasGlyphForCodePoint !== 'function') continue;
    // This writer embeds TrueType outlines (FontFile2); CFF/OpenType needs
    // FontFile3 and a CIDFontType0 writer, so skip those faces for now.
    if (face.type === 'OTF' || face['CFF ']) continue;
    const permissions = face['OS/2'] && face['OS/2'].fsType;
    if (permissions && (permissions.noEmbedding || permissions.noSubsetting)) continue;
    if (!face.hasGlyphForCodePoint(0x4f60) || !face.hasGlyphForCodePoint(0x597d)) continue;
    const score = faceScore(face);
    if (!best || score > best.score) best = { face, score };
  }
  return best ? best.face : null;
}

async function loadFontkit() {
  try {
    return await import('fontkit');
  } catch (error) {
    throw new PdfError('pdf-font-module-missing', 'PDF 导出需要 fontkit 依赖（请在插件目录执行 npm install）；PDF export needs the fontkit dependency.');
  }
}

/** Locate a system CJK TrueType face. Returns null when none is installed. */
export async function findPdfFont(explicitPath = '') {
  const fontkit = await loadFontkit();
  const candidates = explicitPath
    ? [explicitPath]
    : [...(FONT_CANDIDATES[process.platform] || []), ...FONT_CANDIDATES.linux];
  for (const file of candidates) {
    if (!file || !existsSync(file)) continue;
    try {
      const collection = fontkit.openSync(file);
      const face = pickFace(collection);
      if (!face) continue;
      return { font: face, path: file };
    } catch {
      /* unreadable font: try the next candidate */
    }
  }
  return null;
}

const LABELS = {
  zh: {
    members: '成员',
    exported: '导出时间',
    messages: '消息数',
    round: (n) => `第 ${n} 轮`,
    summary: '讨论总结',
    pass: '评审通过',
    changes: '需修改',
    attachment: '附件',
    page: (current, total) => `第 ${current} / ${total} 页`,
    system: '系统',
    user: '我',
    error: '错误',
    stopped: '已停止',
    noMessages: '还没有消息。',
  },
  en: {
    members: 'Members',
    exported: 'Exported',
    messages: 'Messages',
    round: (n) => `Round ${n}`,
    summary: 'Discussion summary',
    pass: 'Review passed',
    changes: 'Changes requested',
    attachment: 'Attachment',
    page: (current, total) => `Page ${current} of ${total}`,
    system: 'System',
    user: 'Me',
    error: 'Error',
    stopped: 'Stopped',
    noMessages: 'No messages yet.',
  },
};

function labelsFor(lang) {
  return /^en/i.test(String(lang || '')) ? LABELS.en : LABELS.zh;
}

function dateLabel(lang) {
  return new Date().toLocaleString(/^en/i.test(String(lang || '')) ? 'en-US' : 'zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1024) return Math.round(value) + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = value / 1024;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return (amount >= 10 ? Math.round(amount) : amount.toFixed(1)) + ' ' + units[index];
}

/* ── inline Markdown ─────────────────────────────────────────────────── */

const INLINE_RE = /(\*\*[^*]+\*\*|`[^`]+`|~~[^~]+~~|\[[^\]]+\]\((?:https?:\/\/)?[^\s)]+\)|\*[^*]+\*)/g;

function parseInline(text) {
  const runs = [];
  const source = String(text || '');
  let last = 0;
  let match;
  INLINE_RE.lastIndex = 0;
  while ((match = INLINE_RE.exec(source)) !== null) {
    if (match.index > last) runs.push({ text: source.slice(last, match.index) });
    const token = match[0];
    if (token.startsWith('**')) runs.push({ text: token.slice(2, -2), bold: true });
    else if (token.startsWith('`')) runs.push({ text: token.slice(1, -1), code: true });
    else if (token.startsWith('~~')) runs.push({ text: token.slice(2, -2), strike: true });
    else if (token.startsWith('*')) runs.push({ text: token.slice(1, -1), italic: true });
    else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      runs.push({ text: link ? link[1] : token, link: link ? link[2] : undefined });
    }
    last = INLINE_RE.lastIndex;
  }
  if (last < source.length) runs.push({ text: source.slice(last) });
  return runs.length > 0 ? runs : [{ text: '' }];
}

function parseBlocks(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let index = 0;
  const flushParagraph = (buffer) => {
    if (buffer.length === 0) return;
    blocks.push({ kind: 'paragraph', runs: parseInline(buffer.join(' ')) });
    buffer.length = 0;
  };
  const paragraph = [];
  while (index < lines.length) {
    const line = lines[index];
    if (/^```/.test(line)) {
      flushParagraph(paragraph);
      const code = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push({ kind: 'code', lines: code.length > 0 ? code : [''] });
      continue;
    }
    if (!line.trim()) {
      flushParagraph(paragraph);
      index += 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(paragraph);
      blocks.push({ kind: 'heading', level: Math.min(heading[1].length + 1, 5), runs: parseInline(heading[2]) });
      index += 1;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushParagraph(paragraph);
      blocks.push({ kind: 'hr' });
      index += 1;
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph(paragraph);
      const quoteLines = [quote[1]];
      index += 1;
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push({ kind: 'quote', runs: parseInline(quoteLines.join(' ')) });
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph(paragraph);
      blocks.push({ kind: 'bullet', runs: parseInline(bullet[1]) });
      index += 1;
      continue;
    }
    const ordered = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    if (ordered) {
      flushParagraph(paragraph);
      blocks.push({ kind: 'ordered', number: Number(ordered[1]), runs: parseInline(ordered[2]) });
      index += 1;
      continue;
    }
    if (line.trim().startsWith('|') && index + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[index + 1]) && lines[index + 1].includes('-')) {
      flushParagraph(paragraph);
      const splitRow = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
      const header = splitRow(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        rows.push(splitRow(lines[index]));
        index += 1;
      }
      blocks.push({ kind: 'table', header: header.map(parseInline), rows: rows.map((row) => row.map(parseInline)) });
      continue;
    }
    paragraph.push(line.trim());
    index += 1;
  }
  flushParagraph(paragraph);
  return blocks;
}

/* ── text measurement and wrapping ───────────────────────────────────── */

class TextEngine {
  constructor(font) {
    this.font = font;
    this.unitsPerEm = font.unitsPerEm || 1000;
    this.widthCache = new Map();
    this.subset = font.createSubset();
    this.widths = new Map();
    this.unicode = new Map();
    this.missing = 0;
  }

  measure(text, size) {
    const key = size + ':' + text;
    const cached = this.widthCache.get(key);
    if (cached !== undefined) return cached;
    let advance = 0;
    try {
      const run = this.font.layout(text);
      for (const position of run.positions) advance += position.xAdvance;
    } catch {
      advance = text.length * this.unitsPerEm * 0.6;
    }
    const width = (advance / this.unitsPerEm) * size;
    if (this.widthCache.size < 4000) this.widthCache.set(key, width);
    return width;
  }

  encode(text) {
    const run = this.font.layout(text);
    let hex = '';
    for (const glyph of run.glyphs) {
      const gid = this.subset.includeGlyph(glyph);
      if (!this.widths.has(gid)) this.widths.set(gid, glyph.advanceWidth || 0);
      if (!this.unicode.has(gid)) {
        const points = Array.isArray(glyph.codePoints) ? glyph.codePoints : [];
        if (points.length > 0) this.unicode.set(gid, points);
        else if (gid === 0) this.unicode.set(0, [0xfffd]);
      }
      if (gid === 0) this.missing += 1;
      hex += gid.toString(16).padStart(4, '0');
    }
    return hex;
  }

  finishFont() {
    const encoded = this.subset.encode();
    return Buffer.from(encoded);
  }
}

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;
const TOKEN_RE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]|[^\s\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]+|\s+/g;

function tokenize(runs) {
  const tokens = [];
  for (const run of runs) {
    const text = String(run.text || '');
    if (!text) continue;
    TOKEN_RE.lastIndex = 0;
    let match;
    while ((match = TOKEN_RE.exec(text)) !== null) {
      tokens.push({ ...run, text: match[0] });
    }
  }
  return tokens;
}

function trimTokens(tokens) {
  const result = tokens.slice();
  while (result.length > 0 && /^\s+$/.test(result[0].text)) result.shift();
  while (result.length > 0 && /^\s+$/.test(result[result.length - 1].text)) result.pop();
  return result;
}

function wrapRuns(runs, engine, size, maxWidth, indent = 0) {
  const tokens = tokenize(runs);
  const lines = [];
  let line = [];
  let width = 0;
  const limit = maxWidth - indent;
  const push = () => {
    lines.push(trimTokens(line));
    line = [];
    width = 0;
  };
  const add = (token) => {
    const measured = engine.measure(token.text, size);
    if (width + measured > limit && line.length > 0) {
      push();
      if (/^\s+$/.test(token.text)) return;
    }
    if (measured > limit && token.text.length > 1) {
      let buffer = '';
      for (const ch of token.text) {
        const charWidth = engine.measure(ch, size);
        if (width + charWidth > limit && line.length > 0) {
          push();
        }
        if (width + charWidth > limit && line.length === 0) {
          buffer += ch;
          line.push({ ...token, text: ch });
          width += charWidth;
          push();
        } else {
          buffer += ch;
          line.push({ ...token, text: ch });
          width += charWidth;
        }
      }
      return;
    }
    line.push(token);
    width += measured;
  };
  for (const token of tokens) {
    if (/^\s+$/.test(token.text) && line.length === 0) continue;
    add(token);
  }
  if (line.length > 0) push();
  return lines.length > 0 ? lines : [[]];
}

/* ── PDF writer ───────────────────────────────────────────────────────── */

function unicodeUtf16Hex(points) {
  const text = String.fromCodePoint(...points.filter((point) => point >= 0 && point <= 0x10ffff));
  const buffer = Buffer.from(text, 'utf16le');
  for (let index = 0; index < buffer.length; index += 2) {
    const swap = buffer[index];
    buffer[index] = buffer[index + 1];
    buffer[index + 1] = swap;
  }
  return buffer.toString('hex').toUpperCase();
}

function pdfNumber(value) {
  return Number(value).toFixed(2).replace(/\.00$/, '');
}

function utf16beHex(text) {
  const buffer = Buffer.from(String(text), 'utf16le');
  for (let index = 0; index < buffer.length; index += 2) {
    const swap = buffer[index];
    buffer[index] = buffer[index + 1];
    buffer[index + 1] = swap;
  }
  return '<FEFF' + buffer.toString('hex').toUpperCase() + '>';
}

function streamObject(dict, data, compress = true) {
  const payload = compress ? deflateSync(data) : data;
  const filter = compress ? ' /Filter /FlateDecode' : '';
  return Buffer.concat([
    Buffer.from('<< ' + dict + filter + ' /Length ' + payload.length + ' >>\nstream\n', 'latin1'),
    payload,
    Buffer.from('\nendstream', 'latin1'),
  ]);
}

class PdfBuilder {
  constructor() {
    this.objects = [];
  }

  add(body) {
    this.objects.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'latin1'));
    return this.objects.length;
  }

  stream(dict, data, compress = true) {
    return this.add(streamObject(dict, Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'latin1'), compress));
  }

  build(rootId, infoId) {
    const chunks = [Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
    let offset = chunks[0].length;
    const offsets = [0];
    for (let index = 0; index < this.objects.length; index += 1) {
      const body = this.objects[index];
      const head = Buffer.from(index + 1 + ' 0 obj\n', 'latin1');
      const tail = Buffer.from('\nendobj\n', 'latin1');
      offsets.push(offset);
      chunks.push(head, body, tail);
      offset += head.length + body.length + tail.length;
    }
    const xrefStart = offset;
    let xref = 'xref\n0 ' + (this.objects.length + 1) + '\n0000000000 65535 f \n';
    for (let index = 1; index <= this.objects.length; index += 1) {
      xref += String(offsets[index]).padStart(10, '0') + ' 00000 n \n';
    }
    const trailer = 'trailer\n<< /Size ' + (this.objects.length + 1) + ' /Root ' + rootId + ' 0 R /Info ' + infoId + ' 0 R >>\nstartxref\n' + xrefStart + '\n%%EOF\n';
    chunks.push(Buffer.from(xref, 'latin1'), Buffer.from(trailer, 'latin1'));
    return Buffer.concat(chunks);
  }
}

/* ── layout ─────────────────────────────────────────────────────────── */

class Layout {
  constructor(engine, labels, lang) {
    this.engine = engine;
    this.labels = labels;
    this.lang = lang;
    this.pages = [];
    this.page = null;
    this.y = 0;
    this.newPage();
  }

  newPage() {
    this.page = { ops: [] };
    this.pages.push(this.page);
    this.y = A4.height - MARGIN.top;
  }

  ensure(height) {
    if (this.y - height < MARGIN.bottom + 14) this.newPage();
  }

  space(height) {
    this.y -= height;
  }

  color(color) {
    const value = color || [0.1, 0.12, 0.15];
    return pdfNumber(value[0]) + ' ' + pdfNumber(value[1]) + ' ' + pdfNumber(value[2]) + ' rg';
  }

  drawSegment(text, size, x, baseline, style) {
    if (!text) return 0;
    const hex = this.engine.encode(text);
    const width = this.engine.measure(text, size);
    const color = style.color || [0.1, 0.12, 0.15];
    let op = 'BT /F1 ' + pdfNumber(size) + ' Tf ' + this.color(color) + ' 1 0 0 1 ' + pdfNumber(x) + ' ' + pdfNumber(baseline) + ' Tm <' + hex + '> Tj ET\n';
    if (style.bold) {
      op = 'BT /F1 ' + pdfNumber(size) + ' Tf ' + this.color(color) + ' 2 Tr ' + pdfNumber(0.36) + ' w ' + this.color(color) + ' RG 1 0 0 1 ' + pdfNumber(x) + ' ' + pdfNumber(baseline) + ' Tm <' + hex + '> Tj 0 Tr ET\n';
    }
    this.page.ops.push(op);
    return width;
  }

  drawLine(tokens, size, baseline, x, options = {}) {
    let cursor = x;
    for (const token of tokens) {
      const style = {
        bold: token.bold || options.bold,
        color: token.code ? [0.35, 0.37, 0.42] : token.link ? [0.12, 0.34, 0.72] : options.color,
      };
      cursor += this.drawSegment(token.text, size, cursor, baseline, style);
    }
    return cursor;
  }

  writeRuns(runs, options = {}) {
    const size = options.size || 10.5;
    const lineHeight = options.lineHeight || Math.round(size * 1.62);
    const indent = options.indent || 0;
    const lines = wrapRuns(runs, this.engine, size, CONTENT_WIDTH, indent);
    for (const line of lines) {
      this.ensure(lineHeight);
      const baseline = this.y - size;
      if (options.background) {
        this.page.ops.push(this.color(options.background) + ' ' + pdfNumber(MARGIN.left + indent - 4) + ' ' + pdfNumber(baseline - 3) + ' ' + pdfNumber(CONTENT_WIDTH - indent + 8) + ' ' + pdfNumber(lineHeight) + ' re f\n');
      }
      this.drawLine(line, size, baseline, MARGIN.left + indent, { bold: options.bold, color: options.color });
      this.y -= lineHeight;
    }
    return lines.length;
  }

  paragraph(runs, options = {}) {
    this.writeRuns(runs, options);
    this.space(options.after === undefined ? 4 : options.after);
  }

  heading(runs, level) {
    const size = level <= 2 ? 16 : level === 3 ? 13.5 : 12;
    this.writeRuns(runs, { size, bold: true, lineHeight: Math.round(size * 1.5), color: [0.08, 0.1, 0.13] });
    this.space(6);
  }

  bullet(runs, marker) {
    this.ensure(16);
    const size = 10.5;
    const baseline = this.y - size;
    this.drawSegment(marker, size, MARGIN.left + 4, baseline, { color: [0.4, 0.43, 0.48] });
    this.writeRuns(runs, { size, indent: 20, lineHeight: 17 });
    this.space(2);
  }

  quote(runs) {
    const size = 10.5;
    const lineHeight = 17;
    this.ensure(lineHeight + 4);
    const startY = this.y + 2;
    this.writeRuns(runs, { size, indent: 12, lineHeight, color: [0.35, 0.38, 0.44] });
    const endY = this.y + 4;
    this.page.ops.push(this.color([0.72, 0.75, 0.8]) + ' ' + pdfNumber(MARGIN.left + 2) + ' ' + pdfNumber(endY) + ' 2 ' + pdfNumber(startY - endY) + ' re f\n');
    this.space(4);
  }

  code(lines) {
    const size = 9;
    const lineHeight = 13.5;
    for (const line of lines.length > 0 ? lines : ['']) {
      const chunks = wrapRuns([{ text: line || ' ' }], this.engine, size, CONTENT_WIDTH, 10);
      for (const chunk of chunks) {
        this.ensure(lineHeight + 2);
        const baseline = this.y - size;
        this.page.ops.push(this.color([0.96, 0.965, 0.975]) + ' ' + pdfNumber(MARGIN.left) + ' ' + pdfNumber(baseline - 2) + ' ' + pdfNumber(CONTENT_WIDTH) + ' ' + pdfNumber(lineHeight) + ' re f\n');
        this.drawLine(chunk, size, baseline, MARGIN.left + 8, { color: [0.28, 0.31, 0.36] });
        this.y -= lineHeight;
      }
    }
    this.space(6);
  }

  table(block) {
    const size = 9.5;
    const lineHeight = 16;
    const columns = Math.max(block.header.length, ...block.rows.map((row) => row.length));
    const width = CONTENT_WIDTH / Math.max(columns, 1);
    const rowRuns = (cells, bold) => {
      const runs = [];
      for (let index = 0; index < columns; index += 1) {
        if (index > 0) runs.push({ text: '   ' });
        const cell = cells[index] || [{ text: '' }];
        runs.push(...cell.map((run) => ({ ...run, bold: bold || run.bold })));
      }
      return runs;
    };
    this.writeRuns(rowRuns(block.header, true), { size, lineHeight, bold: true });
    this.page.ops.push(this.color([0.82, 0.84, 0.87]) + ' ' + pdfNumber(MARGIN.left) + ' ' + pdfNumber(this.y + 2) + ' ' + pdfNumber(CONTENT_WIDTH) + ' 0.6 re f\n');
    this.space(5);
    for (const row of block.rows) this.writeRuns(rowRuns(row, false), { size, lineHeight });
    this.space(5);
  }

  rule() {
    this.ensure(10);
    this.page.ops.push(this.color([0.86, 0.88, 0.9]) + ' ' + pdfNumber(MARGIN.left) + ' ' + pdfNumber(this.y - 3) + ' ' + pdfNumber(CONTENT_WIDTH) + ' 0.8 re f\n');
    this.space(10);
  }

  finishFooters(title) {
    const total = this.pages.length;
    for (let index = 0; index < total; index += 1) {
      const page = this.pages[index];
      const label = this.labels.page(index + 1, total);
      const size = 8;
      const width = this.engine.measure(label, size);
      const hex = this.engine.encode(label);
      page.ops.push('BT /F1 ' + size + ' Tf 0.55 0.58 0.63 rg 1 0 0 1 ' + pdfNumber(A4.width - MARGIN.right - width) + ' ' + FOOTER_Y + ' Tm <' + hex + '> Tj ET\n');
      if (index > 0) {
        const header = String(title || '').slice(0, 80);
        const headerWidth = this.engine.measure(header, 8);
        const headerHex = this.engine.encode(header);
        page.ops.push('BT /F1 8 Tf 0.55 0.58 0.63 rg 1 0 0 1 ' + pdfNumber(MARGIN.left) + ' ' + pdfNumber(A4.height - 28) + ' Tm <' + headerHex + '> Tj ET\n');
        page.ops.push(this.color([0.9, 0.91, 0.93]) + ' ' + pdfNumber(MARGIN.left) + ' ' + pdfNumber(A4.height - 34) + ' ' + pdfNumber(Math.min(CONTENT_WIDTH, headerWidth + 2)) + ' 0.5 re f\n');
      }
    }
  }
}

/* ── message layout ─────────────────────────────────────────────────── */

/** English forms of the Host's generated system messages. */
function localizeSystemText(text, lang) {
  if (!/^en/i.test(String(lang || ''))) return String(text || '');
  const source = String(text || '');
  const patterns = [
    [/^讨论「(.+?)」总结失败\/中断，已结束。$/, (m) => 'Discussion “' + m[1] + '” summary failed/interrupted; ended.'],
    [/^讨论「(.+?)」因成员执行失败而停止。$/, (m) => 'Discussion “' + m[1] + '” stopped because a member failed.'],
    [/^讨论「(.+?)」已停止：(.+)$/, (m) => 'Discussion “' + m[1] + '” stopped: ' + m[2]],
    [/^讨论「(.+?)」已停止。$/, (m) => 'Discussion “' + m[1] + '” stopped.'],
    [/^讨论「(.+?)」结束。$/, (m) => 'Discussion “' + m[1] + '” ended.'],
    [/^开始讨论：(.+?)（(\d+) 位成员，共 (\d+) 轮(，结束生成总结)?）$/, (m) => 'Started discussion: ' + m[1] + ' (' + m[2] + ' members, ' + m[3] + ' rounds' + (m[4] ? ', summary at the end' : '') + ')'],
    [/^请 @(.+?) 评审 #(\d+)（(.+?)）的消息$/, (m) => 'Ask @' + m[1] + ' to review message #' + m[2] + ' (' + m[3] + ')'],
    [/^请 @(.+?) 根据 #(\d+) 的评审意见修改 #(\d+)$/, (m) => 'Ask @' + m[1] + ' to revise #' + m[3] + ' based on the review at #' + m[2]],
    [/^任务「(.+?)」已验收，前置依赖解除：(.+?) 可以派发了。$/, (m) => 'Task “' + m[1] + '” accepted; dependencies cleared: ' + m[2].split('、').join(', ') + ' can now be dispatched.'],
    [/^(.+?) 请求权限：工具 (.+?)(（(.+)）)?。$/, (m) => m[1] + ' requests permission: tool ' + m[2] + (m[4] ? ' (' + m[4] + ')' : '') + '.'],
  ];
  for (const [pattern, render] of patterns) {
    const match = pattern.exec(source);
    if (match) return render(match);
  }
  return source;
}

function authorLabel(message, labels) {
  const author = message && message.author;
  if (!author) return labels.system;
  if (author.type === 'system') return labels.system;
  if (author.type === 'human') return author.name || labels.user;
  return author.name || 'Bot';
}

function renderMessage(layout, message, labels, lang) {
  const badges = [];
  if (message.meta && message.meta.round) badges.push(labels.round(message.meta.round));
  if (message.meta && message.meta.summary) badges.push(labels.summary);
  if (message.meta && message.meta.verdict === 'pass') badges.push(labels.pass);
  if (message.meta && message.meta.verdict === 'changes') badges.push(labels.changes);
  if (message.status === 'stopped') badges.push(labels.stopped);
  if (message.status === 'error') badges.push(labels.error);
  const header = '#' + message.seq + '  ' + authorLabel(message, labels) + (badges.length ? '  ·  ' + badges.join('  ·  ') : '');
  layout.ensure(44);
  layout.space(6);
  layout.writeRuns([{ text: header }], { size: 8.8, lineHeight: 14, color: [0.45, 0.48, 0.54], bold: true });
  layout.space(3);
  const system = message.author && message.author.type === 'system';
  if (system) {
    layout.quote(parseInline(localizeSystemText(message.text, lang)));
  } else {
    const blocks = parseBlocks(message.text || '');
    if (blocks.length === 0) blocks.push({ kind: 'paragraph', runs: [{ text: '' }] });
    for (const block of blocks) {
      if (block.kind === 'paragraph') layout.paragraph(block.runs);
      else if (block.kind === 'heading') layout.heading(block.runs, block.level);
      else if (block.kind === 'bullet') layout.bullet(block.runs, '•');
      else if (block.kind === 'ordered') layout.bullet(block.runs, block.number + '.');
      else if (block.kind === 'quote') layout.quote(block.runs);
      else if (block.kind === 'code') layout.code(block.lines);
      else if (block.kind === 'hr') layout.rule();
      else if (block.kind === 'table') layout.table(block);
    }
  }
  if (Array.isArray(message.attachments) && message.attachments.length > 0) {
    for (const attachment of message.attachments) {
      const size = formatBytes(attachment.bytes);
      layout.writeRuns([{ text: labels.attachment + ': ' + attachment.name + (size ? ' (' + size + ')' : '') }], {
        size: 9,
        lineHeight: 14,
        color: [0.45, 0.48, 0.54],
      });
    }
  }
  if (message.status === 'error' && message.error) {
    layout.writeRuns([{ text: labels.error + ': ' + message.error }], { size: 9, lineHeight: 14, color: [0.72, 0.18, 0.18] });
  }
  layout.space(10);
}

/* ── document assembly ──────────────────────────────────────────────── */

function fontObjects(builder, engine, font, name) {
  const units = engine.unitsPerEm;
  const scale = (value) => Math.round((Number(value) || 0) * 1000 / units);
  const bbox = font.bbox || { minX: -200, minY: -300, maxX: 1000, maxY: 1000 };
  const fontBuffer = engine.finishFont();
  const fileRef = builder.stream(
    '/Length1 ' + fontBuffer.length,
    fontBuffer,
  );
  const descriptorRef = builder.add(
    '<< /Type /FontDescriptor /FontName /' + name +
      ' /Flags 4 /FontBBox [' + [scale(bbox.minX), scale(bbox.minY), scale(bbox.maxX), scale(bbox.maxY)].join(' ') + ']' +
      ' /ItalicAngle 0 /Ascent ' + scale(font.ascent || units * 0.8) +
      ' /Descent ' + scale(font.descent || -units * 0.2) +
      ' /CapHeight ' + scale(font.capHeight || (font.ascent || units * 0.8) * 0.7) +
      ' /StemV 80 /FontFile2 ' + fileRef + ' 0 R >>',
  );
  const widths = [];
  for (const [gid, advance] of [...engine.widths.entries()].sort((a, b) => a[0] - b[0])) {
    const width = scale(advance);
    if (width !== 1000) widths.push(gid + ' [' + width + ']');
  }
  const cidRef = builder.add(
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /' + name +
      ' /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>' +
      ' /FontDescriptor ' + descriptorRef + ' 0 R /CIDToGIDMap /Identity /DW 1000' +
      ' /W [' + widths.join(' ') + '] >>',
  );
  const toUnicode = [];
  const entries = [...engine.unicode.entries()].sort((a, b) => a[0] - b[0]).filter(([gid]) => gid !== 0);
  for (let index = 0; index < entries.length; index += 100) {
    const chunk = entries.slice(index, index + 100);
    toUnicode.push(chunk.length + ' beginbfchar');
    for (const [gid, points] of chunk) {
      toUnicode.push('<' + gid.toString(16).padStart(4, '0') + '> <' + unicodeUtf16Hex(points) + '>');
    }
    toUnicode.push('endbfchar');
  }
  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    ...toUnicode,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
    '',
  ].join('\n');
  const toUnicodeRef = builder.stream('', Buffer.from(cmap, 'latin1'), false);
  const type0Ref = builder.add(
    '<< /Type /Font /Subtype /Type0 /BaseFont /' + name + ' /Encoding /Identity-H /DescendantFonts [' + cidRef + ' 0 R] /ToUnicode ' + toUnicodeRef + ' 0 R >>',
  );
  return type0Ref;
}

/** Build a complete PDF for one group timeline. */
export async function buildGroupPdf({ group, members = [], bots = [], messages = [], conversations = [], conversationBoundaries = [], truncated = false, lang = 'zh', fontPath = '' }) {
  const labels = labelsFor(lang);
  const found = await findPdfFont(fontPath);
  if (!found) {
    throw new PdfError('pdf-font-unavailable', /^en/i.test(String(lang || ''))
      ? 'No CJK font is installed; PDF export needs a system CJK font or config.pdfFontPath.'
      : '未找到可用的中文字体；请安装系统 CJK 字体，或在 config.pdfFontPath 指定字体文件。');
  }
  const engine = new TextEngine(found.font);
  const layout = new Layout(engine, labels, lang);
  const title = String((group && group.title) || 'Bot Team');
  const topic = String((group && group.topic) || '');

  // Cover block
  layout.writeRuns([{ text: title }], { size: 20, bold: true, lineHeight: 30, color: [0.07, 0.09, 0.12] });
  if (topic) layout.writeRuns([{ text: topic }], { size: 10.5, lineHeight: 18, color: [0.38, 0.41, 0.47] });
  const roster = members
    .map((member) => {
      const bot = bots.find((candidate) => candidate.botId === member.botId);
      return bot ? bot.name : '';
    })
    .filter(Boolean)
    .join(labels === LABELS.en ? ', ' : '、');
  const meta = [
    labels.members + ': ' + (roster || '—'),
    labels.messages + ': ' + messages.length,
    labels.exported + ': ' + dateLabel(lang),
  ].join('    ·    ');
  layout.writeRuns([{ text: meta }], { size: 8.6, lineHeight: 16, color: [0.46, 0.49, 0.55] });
  layout.space(8);
  layout.rule();
  layout.space(4);

  const en = labels === LABELS.en;
  layout.writeRuns([{ text: en ? 'Export scope: entire chat, including all conversation segments.' : '导出范围：整个聊天，包含所有会话分段。' }], { size: 9, lineHeight: 16 });
  if (truncated) layout.writeRuns([{ text: en
    ? 'Incomplete export: the 50-page retrieval limit was reached or history pagination stopped. Earlier content may be missing.'
    : '导出不完整：已达到 50 页读取上限或历史分页中断，更早内容可能未包含。' }], { size: 10, lineHeight: 17, color: [0.7, 0.22, 0.1] });
  const boundaries = [...new Map([...conversationBoundaries, ...conversations].filter(item => item?.conversationId).map(item => [item.conversationId, item])).values()]
    .sort((a, b) => Number(a.afterSeq) - Number(b.afterSeq) || Number(a.ordinal) - Number(b.ordinal));
  const orderedMessages = [...messages].sort((a, b) => a.seq - b.seq);
  let cursor = 0;
  const renderBoundary = (conversation, empty) => {
    layout.space(10);
    layout.rule();
    layout.writeRuns([{ text: (en ? 'Conversation ' : '会话 ') + conversation.ordinal }], { size: 13, bold: true, lineHeight: 23 });
    if (conversation.createdAt) layout.writeRuns([{ text: new Date(conversation.createdAt).toLocaleString(en ? 'en-US' : 'zh-CN') }], { size: 9, lineHeight: 16 });
    if (empty) layout.writeRuns([{ text: en ? 'No messages in this conversation.' : '本会话没有消息。' }], { size: 10, lineHeight: 18, color: [0.5, 0.53, 0.58] });
  };
  for (const message of orderedMessages) {
    while (cursor < boundaries.length && Number(boundaries[cursor].afterSeq) < Number(message.seq)) {
      const conversation = boundaries[cursor++];
      renderBoundary(conversation, cursor < boundaries.length && Number(boundaries[cursor].afterSeq) < Number(message.seq));
    }
    renderMessage(layout, message, labels, lang);
  }
  while (cursor < boundaries.length) renderBoundary(boundaries[cursor++], true);
  if (!orderedMessages.length && !boundaries.length) layout.writeRuns([{ text: labels.noMessages }], { size: 10.5, lineHeight: 18, color: [0.5, 0.53, 0.58] });
  layout.finishFooters(title);

  const builder = new PdfBuilder();
  const pagesRef = builder.add(null);
  const fontName = 'BotTeamCJK';
  const fontRef = fontObjects(builder, engine, found.font, fontName);
  const pageRefs = [];
  for (const page of layout.pages) {
    const content = page.ops.join('');
    const contentRef = builder.stream('', Buffer.from(content, 'latin1'));
    const pageRef = builder.add(
      '<< /Type /Page /Parent ' + pagesRef + ' 0 R /MediaBox [0 0 ' + pdfNumber(A4.width) + ' ' + pdfNumber(A4.height) + ']' +
        ' /Resources << /Font << /F1 ' + fontRef + ' 0 R >> >> /Contents ' + contentRef + ' 0 R >>',
    );
    pageRefs.push(pageRef);
  }
  builder.objects[pagesRef - 1] = Buffer.from(
    '<< /Type /Pages /Kids [' + pageRefs.map((ref) => ref + ' 0 R').join(' ') + '] /Count ' + pageRefs.length + ' >>',
    'latin1',
  );
  const catalogRef = builder.add('<< /Type /Catalog /Pages ' + pagesRef + ' 0 R >>');
  const infoRef = builder.add(
    '<< /Title ' + utf16beHex(title) + ' /Producer ' + utf16beHex('Bot Team') + ' /CreationDate (D:' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + ') >>',
  );
  return builder.build(catalogRef, infoRef);
}
