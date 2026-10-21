/**
 * 一条命令把全站的占位信息换成你自己的。
 *
 *   node tools/setup.mjs --domain seo.yourdomain.com --email you@yourdomain.com
 *   node tools/setup.mjs --domain ... --email ... --brand "品牌名" --icp "沪ICP备xxxx号"
 *
 * 会改：首页的 canonical / OG / JSON-LD / 邮箱、robots、sitemap、Caddyfile、OG 图脚本。
 * 改完记得跑一次 python tools/make-og.py 重新生成分享图。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(' ')
    .matchAll(/--([\w-]+)(?:\s+("([^"]*)"|'([^']*)'|(\S+)))?/g)
    .map((m) => [m[1], m[3] ?? m[4] ?? m[5] ?? true])
);

const domain = String(args.domain || '')
  .trim()
  .replace(/^https?:\/\//i, '')
  .replace(/\/+$/, '');
const email = String(args.email || '').trim();
const brand = args.brand ? String(args.brand).trim() : '';
const icp = args.icp ? String(args.icp).trim() : '';

if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
  console.error('用法: node tools/setup.mjs --domain 你的域名 --email 你的邮箱 [--brand 品牌] [--icp 备案号]');
  process.exit(1);
}
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error('邮箱格式不对');
  process.exit(1);
}

const files = [
  'site/index.html',
  'site/thanks.html',
  'site/articles/how-search-works.html',
  'site/robots.txt',
  'site/sitemap.xml',
  'deploy/Caddyfile',
  'tools/make-og.py',
  'server/.env.example',
];

// 顺序有讲究：先换带域名的完整邮箱，再换域名
const rules = [
  ['https://example.com', `https://${domain}`],
  ['hi@example.com', email],
  ['admin@example.com', email],
  ['you@example.com', email],
  ['lead@yourdomain.com', `lead@${domain}`],
  ['example.com', domain],
];

if (brand) rules.push(['SEO增长前线', brand]);
if (icp) rules.push(['沪ICP备XXXXXXXX号', icp]);

let total = 0;
for (const rel of files) {
  const path = join(root, rel);
  let text = readFileSync(path, 'utf8');
  let changed = 0;

  for (const [from, to] of rules) {
    if (from === to) continue;
    const parts = text.split(from);
    if (parts.length > 1) {
      changed += parts.length - 1;
      text = parts.join(to);
    }
  }

  if (changed) {
    writeFileSync(path, text);
    total += changed;
    console.log(`  ${rel}  ${changed} 处`);
  }
}

// 品牌首字会用在左上角的方块里，顺手改掉
if (brand) {
  const indexPath = join(root, 'site/index.html');
  let html = readFileSync(indexPath, 'utf8');
  html = html.replace(
    /(<span class="brand-mark" aria-hidden="true">)(.)(<\/span>)/,
    (_, a, _old, c) => `${a}${brand.slice(0, 1)}${c}`
  );
  writeFileSync(indexPath, html);
}

console.log(total ? `共替换 ${total} 处。` : '没有需要替换的内容（可能已经改过了）。');
console.log('下一步：');
console.log('  1. python tools/make-og.py   重新生成分享图');
console.log('  2. node tools/preview.mjs    本地看效果');
console.log('  3. 改首页里标了「示例」的案例和数字');
