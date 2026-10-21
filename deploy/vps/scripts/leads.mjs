#!/usr/bin/env node
/**
 * 查看 / 导出线索。
 *
 *   node scripts/leads.mjs          按时间倒序列出
 *   node scripts/leads.mjs --csv    导出 CSV（可直接丢进 Excel）
 *   node scripts/leads.mjs --json   导出 NDJSON 原样
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const file = process.env.LEADS_FILE || join(__dirname, '..', 'data', 'leads.ndjson');

if (!existsSync(file)) {
  console.log(`还没有线索文件：${file}`);
  process.exit(0);
}

const lines = readFileSync(file, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean)
  .reverse();

const mode = process.argv[2] || '';

if (mode === '--json') {
  for (const r of lines) console.log(JSON.stringify(r));
  process.exit(0);
}

if (mode === '--csv') {
  const cols = ['at', 'name', 'email', 'site', 'budget', 'message', 'ref', 'ip'];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  console.log(cols.join(','));
  for (const r of lines) console.log(cols.map((c) => cell(r[c])).join(','));
  process.exit(0);
}

console.log(`共 ${lines.length} 条线索\n`);

for (const r of lines) {
  const when = new Date(r.at).toLocaleString('zh-CN', { hour12: false });
  console.log(`${when}  ${r.name || '—'}  <${r.email}>`);
  console.log(`  网站 ${r.site}${r.budget ? `   预算 ${r.budget}` : ''}${r.ref ? `   来源 ${r.ref}` : ''}`);
  if (r.message) console.log(`  ${r.message.replace(/\n/g, '\n  ')}`);
  console.log('');
}
