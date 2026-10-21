/**
 * 询盘接收端点 —— 整站唯一的后端，零依赖，只要 Node 18+。
 *
 *   POST /api/lead     表单提交（urlencoded 或 JSON）
 *   GET  /api/health   健康检查
 *
 * 三条原则：
 *   1. 先把线索落到本机磁盘（fsync），再发通知。通知挂了也不丢线索。
 *   2. 不依赖数据库和任何 npm 包，拷两个文件就能跑。
 *   3. 只监听 127.0.0.1，公网流量一律走 Caddy。
 */

import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 本机 .env（可选）。生产环境用 systemd 的 EnvironmentFile。
try {
  process.loadEnvFile(join(__dirname, '.env'));
} catch {
  /* 没有 .env 就用纯环境变量 */
}

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || join(__dirname, 'data');
const LEADS_FILE = join(DATA_DIR, 'leads.ndjson');
const THANKS_PATH = process.env.THANKS_PATH || '/thanks';
const MAX_BODY = 20 * 1024;
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_HOUR || 6);

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_TO = process.env.MAIL_TO || '';
const MAIL_FROM = process.env.MAIL_FROM || '';

const WEBHOOK_URL = process.env.NOTIFY_WEBHOOK || '';
const WEBHOOK_KIND = (process.env.NOTIFY_WEBHOOK_KIND || 'generic').toLowerCase();
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

mkdirSync(DATA_DIR, { recursive: true });

/* -------------------------------------------------------------------------- */
/* 小工具                                                                      */
/* -------------------------------------------------------------------------- */

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  return req.socket.remoteAddress || '0.0.0.0';
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
  );
}

function shanghaiTime(iso) {
  try {
    return new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  } catch {
    return iso;
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function text(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function redirect(res, location, status = 303) {
  res.writeHead(status, { location, 'cache-control': 'no-store', 'content-length': '0' });
  res.end();
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* -------------------------------------------------------------------------- */
/* 限流：内存计数，单进程足够                                                  */
/* -------------------------------------------------------------------------- */

const buckets = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const bucket = buckets.get(ip);

  if (!bucket || now > bucket.reset) {
    buckets.set(ip, { count: 1, reset: now + 3_600_000 });
    if (buckets.size > 5000) {
      for (const [key, value] of buckets) if (now > value.reset) buckets.delete(key);
    }
    return false;
  }

  bucket.count += 1;
  return bucket.count > RATE_LIMIT;
}

/* -------------------------------------------------------------------------- */
/* 存储：NDJSON 追加写 + fsync                                                  */
/* -------------------------------------------------------------------------- */

function appendLead(record) {
  const line = JSON.stringify(record) + '\n';
  const fd = openSync(LEADS_FILE, 'a', 0o600);
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/* -------------------------------------------------------------------------- */
/* 通知                                                                        */
/* -------------------------------------------------------------------------- */

function plainText(rec) {
  return [
    `新询盘${rec.name ? ` · ${rec.name}` : ''}`,
    `邮箱：${rec.email}`,
    `网站：${rec.site}`,
    rec.budget ? `预算：${rec.budget}` : '',
    rec.ref ? `来源：${rec.ref}` : '',
    '',
    rec.message || '（没有留言）',
    '',
    `时间：${shanghaiTime(rec.at)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function emailHtml(rec) {
  const rows = [
    ['邮箱', `<a href="mailto:${escapeHtml(rec.email)}">${escapeHtml(rec.email)}</a>`],
    ['网站', escapeHtml(rec.site)],
    ['称呼', escapeHtml(rec.name || '—')],
    ['预算', escapeHtml(rec.budget || '—')],
    ['来源', escapeHtml(rec.ref || '直访')],
    ['时间', escapeHtml(shanghaiTime(rec.at))],
  ];

  return `<div style="font:15px/1.65 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#12141a">
  <h2 style="margin:0 0 16px;font-size:18px">新询盘</h2>
  <table cellpadding="0" cellspacing="0" style="border-collapse:collapse">
    ${rows
      .map(
        ([k, v]) =>
          `<tr><td style="padding:4px 18px 4px 0;color:#6a7180;font-size:13px;white-space:nowrap">${k}</td><td style="padding:4px 0">${v}</td></tr>`
      )
      .join('')}
  </table>
  <div style="margin-top:18px;padding:16px;background:#f6f5f1;border-radius:10px;white-space:pre-wrap">${escapeHtml(
    rec.message || '（没有留言）'
  )}</div>
  <p style="margin-top:18px;color:#6a7180;font-size:12px">来自站点表单 · 直接回复本邮件即可回给客户</p>
</div>`;
}

async function sendEmail(rec) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: MAIL_TO.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      reply_to: rec.email,
      subject: `新询盘 · ${rec.name || rec.email}`,
      html: emailHtml(rec),
      text: plainText(rec),
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

async function sendWebhook(rec) {
  const content = plainText(rec);
  let payload;

  switch (WEBHOOK_KIND) {
    case 'wecom':
      payload = { msgtype: 'text', text: { content } };
      break;
    case 'feishu':
      payload = { msg_type: 'text', content: { text: content } };
      break;
    case 'telegram':
      payload = { chat_id: TELEGRAM_CHAT_ID, text: content, disable_web_page_preview: true };
      break;
    default:
      payload = { text: content };
  }

  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) throw new Error(`webhook ${res.status}`);
}

async function notify(rec) {
  const jobs = [];
  if (RESEND_API_KEY && MAIL_TO && MAIL_FROM) jobs.push(sendEmail(rec));
  if (WEBHOOK_URL) jobs.push(sendWebhook(rec));

  if (jobs.length === 0) {
    console.warn('[notify] 没有配置通知渠道，线索只写进了本地文件');
    return;
  }

  const results = await Promise.allSettled(jobs);
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('[notify] 通知失败：', result.reason?.message || result.reason);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 路由                                                                        */
/* -------------------------------------------------------------------------- */

async function handleLead(req, res) {
  const contentType = String(req.headers['content-type'] || '');
  const wantsJson =
    String(req.headers.accept || '').includes('application/json') ||
    contentType.includes('application/json');

  const ok = () => (wantsJson ? json(res, 200, { ok: true }) : redirect(res, THANKS_PATH));
  const fail = (message, status = 400) =>
    wantsJson ? json(res, status, { ok: false, error: message }) : text(res, status, message);

  let raw;
  try {
    raw = await readBody(req, MAX_BODY);
  } catch (err) {
    return fail(err?.status === 413 ? '内容太长' : '读取失败', err?.status || 400);
  }

  let body;
  try {
    body = contentType.includes('application/json')
      ? JSON.parse(raw || '{}')
      : Object.fromEntries(new URLSearchParams(raw));
  } catch {
    return fail('请求格式不对');
  }

  // 反垃圾：蜜罐 + 提交过快。命中就假装成功，不给机器人反馈。
  if (str(body._hp, 100)) return ok();
  const ts = Number(body._t);
  if (Number.isFinite(ts) && ts > 0 && Date.now() - ts < 2500) return ok();

  const ip = clientIp(req);
  if (isRateLimited(ip)) {
    return fail('提交太频繁了，过一会儿再试，或者直接发邮件给我。', 429);
  }

  const email = str(body.email, 120).toLowerCase();
  const site = str(body.site, 200);
  const name = str(body.name, 40);
  const budget = str(body.budget, 40);
  const message = str(body.message, 2000);
  const ref = str(body._ref, 300);

  if (!EMAIL_RE.test(email)) return fail('邮箱看起来不对，检查一下？');
  if (site.length < 4 || !site.includes('.') || /\s/.test(site)) {
    return fail('网站地址看起来不对，填域名就行（www.example.com）。');
  }

  const record = {
    id: randomUUID(),
    at: new Date().toISOString(),
    ip,
    name,
    email,
    site,
    budget,
    message,
    ref,
    ua: str(req.headers['user-agent'], 300),
  };

  try {
    appendLead(record);
  } catch (err) {
    console.error('[store] 写入失败：', err);
    return fail('服务器出了点问题，请直接发邮件联系我。', 500);
  }

  console.log(`[lead] ${record.email} · ${record.site}`);

  // 线索已落盘，通知异步发，不阻塞跳转
  notify(record).catch((err) => console.error('[notify]', err));

  return ok();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  try {
    if (path === '/api/health' && req.method === 'GET') {
      return json(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
    }

    if (path === '/api/lead') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
      return await handleLead(req, res);
    }

    if (path.startsWith('/api/')) {
      return json(res, 404, { ok: false, error: 'not found' });
    }

    text(res, 404, 'not found');
  } catch (err) {
    console.error('[server]', err);
    if (!res.headersSent) json(res, 500, { ok: false, error: 'internal error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`lead server listening on http://${HOST}:${PORT}`);
  console.log(`leads file: ${LEADS_FILE}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`${signal} received, closing`);
    server.close(() => process.exit(0));
  });
}
