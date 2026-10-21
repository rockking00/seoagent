/**
 * 静态自检：不依赖任何包，跑 `node tools/check.mjs`。
 *
 * 检查：页面能否读到、锚点、样式类、JSON-LD、meta、站内链接、CSS 括号。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const siteDir = join(root, 'site');

const pages = [
  'index.html',
  'thanks.html',
  '404.html',
  'articles/how-search-works.html',
];

const css = readFileSync(join(siteDir, 'assets/styles.css'), 'utf8');
const problems = [];
const cssClasses = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
const usedClasses = new Set();
const allIds = new Map();
const html = new Map();

for (const page of pages) {
  const path = join(siteDir, page);
  if (!existsSync(path)) {
    problems.push(`缺少页面 ${page}`);
    continue;
  }
  html.set(page, readFileSync(path, 'utf8'));
}

for (const [page, text] of html) {
  const where = (msg) => `[${page}] ${msg}`;

  // 锚点只能在同一页内跳
  const ids = new Set([...text.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  allIds.set(page, ids);
  for (const [, anchor] of text.matchAll(/href="#([^"]+)"/g)) {
    if (!ids.has(anchor)) problems.push(where(`锚点 #${anchor} 没有对应的 id`));
  }

  // 样式类
  for (const [, value] of text.matchAll(/\sclass="([^"]*)"/g)) {
    for (const token of value.split(/\s+/).filter(Boolean)) usedClasses.add(token);
  }

  // JSON-LD
  const blocks = [...text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  blocks.forEach(([, body], i) => {
    try {
      const data = JSON.parse(body);
      if (!data['@type']) problems.push(where(`第 ${i + 1} 段 JSON-LD 缺 @type`));
    } catch (err) {
      problems.push(where(`第 ${i + 1} 段 JSON-LD 不是合法 JSON：${err.message}`));
    }
  });

  // 必备 meta
  const noindex = /name="robots"\s+content="[^"]*noindex/.test(text);
  if (!/<title>[^<]+<\/title>/.test(text)) problems.push(where('缺少 title'));
  if (!noindex) {
    if (!/name="description"\s+content="[^"]+"/.test(text)) problems.push(where('缺少 description'));
    if (!/rel="canonical"\s+href="https:\/\/[^"]+"/.test(text)) problems.push(where('可索引页面缺少 canonical'));
    if (!/property="og:image"\s+content="https:\/\/[^"]+"/.test(text)) problems.push(where('可索引页面缺少 og:image'));
    if (blocks.length === 0) problems.push(where('可索引页面没有 JSON-LD'));
  }

  // 站内链接
  for (const [, href] of text.matchAll(/href="(\/[^"#?]*)"/g)) {
    const clean = href.replace(/\/$/, '');
    if (!clean) continue; // 指向首页
    const candidates = [
      join(siteDir, clean),
      join(siteDir, `${clean}.html`),
      join(siteDir, clean, 'index.html'),
    ];
    if (!candidates.some((p) => existsSync(p))) {
      problems.push(where(`站内链接 ${href} 找不到对应文件`));
    }
  }
}

// 样式类是否都有定义
for (const cls of usedClasses) {
  if (!cssClasses.has(cls)) problems.push(`class "${cls}" 在 CSS 里没有定义`);
}

// CSS 花括号配平（错一个会让后面所有样式失效）
const openBraces = (css.match(/\{/g) || []).length;
const closeBraces = (css.match(/\}/g) || []).length;
if (openBraces !== closeBraces) {
  problems.push(`CSS 花括号不匹配：{ ${openBraces} 个，} ${closeBraces} 个`);
}

// 首页表单
const index = html.get('index.html') || '';
if (/<form/.test(index) && !/action="\/api\/lead"/.test(index)) problems.push('首页表单没有指向 /api/lead');

// 占位符残留
for (const [page, text] of html) {
  if (text.includes('{{')) problems.push(`[${page}] 还有 {{ }} 模板占位符`);
}

if (problems.length) {
  console.error(`发现 ${problems.length} 个问题：`);
  for (const p of problems) console.error(` - ${p}`);
  process.exit(1);
}

const totalIds = [...allIds.values()].reduce((n, set) => n + set.size, 0);
console.log(
  `OK：${html.size} 个页面、${usedClasses.size} 个样式类、${totalIds} 个锚点、站内链接全部可达`
);
