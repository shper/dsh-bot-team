#!/usr/bin/env node
/**
 * Read/search the packaged DSH install (app.asar) with Electron's asar-aware fs.
 *
 * Run with the Desktop app's own binary in Node mode:
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" tools/asar.mjs <cmd> ...
 *
 * Commands:
 *   list  <asarPath>                    list a directory inside the asar
 *   read  <asarPath> [start] [count]    print a text file (1-based lines)
 *   search <regex> <asarPath> [maxHits] grep files under a directory (text <= 3MB)
 *
 * <asarPath> is absolute inside the archive, e.g.
 *   /dsh/node_modules/@deepseek-ai/dsh-agent
 */
import fs from 'node:fs';
import path from 'node:path';

const ASAR_ROOT = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';
const abs = (p) => (p.startsWith('/') ? ASAR_ROOT + p : path.join(ASAR_ROOT, p));

const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'list') {
  const target = abs(args[0] ?? '/');
  for (const entry of fs.readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      console.log(`d  ${entry.name}/`);
    } else {
      const st = fs.statSync(path.join(target, entry.name));
      console.log(`f  ${st.size.toString().padStart(9)}  ${entry.name}`);
    }
  }
} else if (cmd === 'read') {
  const file = abs(args[0]);
  const text = fs.readFileSync(file, 'utf8');
  const start = Number(args[1] ?? 1);
  const count = Number(args[2] ?? 200);
  const lines = text.split('\n');
  for (let i = start - 1; i < Math.min(lines.length, start - 1 + count); i++) {
    console.log(String(i + 1).padStart(5) + '  ' + lines[i]);
  }
} else if (cmd === 'search') {
  const pattern = new RegExp(args[0], 'g');
  const root = abs(args[1] ?? '/');
  const maxHits = Number(args[2] ?? 120);
  let hits = 0;
  const skipExt = /\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|otf|map|wasm|pdf|zip|gz|mp4|mp3|node)$/i;
  const scanFile = (full) => {
    if (hits >= maxHits) return;
    if (skipExt.test(full)) return;
    let st;
    try { st = fs.statSync(full); } catch { return; }
    if (st.size > 3_000_000) return;
    let text;
    try { text = fs.readFileSync(full, 'utf8'); } catch { return; }
    if (text.includes('\u0000')) return;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && hits < maxHits; i++) {
      pattern.lastIndex = 0;
      if (pattern.test(lines[i])) {
        hits++;
        console.log(`${full.slice(ASAR_ROOT.length)}:${i + 1}: ${lines[i].trim().slice(0, 400)}`);
      }
    }
  };
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return scanFile(dir); }
    for (const entry of entries) {
      if (hits >= maxHits) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      scanFile(full);
    }
  };
  walk(root);
  if (hits >= maxHits) console.error(`(stopped at ${maxHits} hits)`);
} else {
  console.error('usage: asar.mjs list|read|search ...');
  process.exitCode = 2;
}
