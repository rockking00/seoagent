/**
 * POST /api/lead —— Vercel Serverless Function
 *
 * 和 server/server.mjs 的区别：
 *   server.mjs 是跑在 VPS 上的常驻进程，线索落在本地 NDJSON 文件里；
 *   这里是 serverless，没有本地磁盘，线索靠 邮件 / 群机器人 / Upstash 三选一或多选。
 *
 * 环境变量（在 Vercel 项目 Settings → Environment Variables 里配）：
 *   RESEND_API_KEY / MAIL_TO / MAIL_FROM     邮件通知（必配一个，否则收不到线索）
 *   NOTIFY_WEBHOOK / NOTIFY_WEBHOOK_KIND     群机器人：wecom | feishu | telegram | generic
 *   TELEGRAM_CHAT_ID                         telegram 时才需要
 *   UPSTASH_REDIS_REST_URL / ..._TOKEN       可选，把线索额外存一份（推荐）
 *   RATE_LIMIT_PER_HOUR                      每实例每小时的提交上限，默认 6
 */

const MAX_BODY = 20 * 1024;
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_HOUR || 6);

// serverless 实例会被复用，这个 Map 只在同一个 warm 实例内有效，属于尽力而为
const buckets = new Map();

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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

async function readBody(req) {
  // 有的 Node runtime 会先把 body 解析好
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  const ct = String(req.headers['content-type'] || '');

  if (ct.includes('application/json')) {
    try {
      return JSON.parse(raw || '{}');
    } catch {
      return null;
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function isRateLimited(ip) {
  const now = Date.now();
  const bucket = buckets.get(ip);

  if (!bucket || now > bucket.reset) {
    buckets.set(ip, { count: 1, reset: now + 3_600_000 });
    if (buckets.size > 2000) {
      for (const [key, value] of buckets) if (now > value.reset) buckets.delete(key);
    }
    return false;
  }

  bucket.count += 1;
  return bucket.count > RATE_LIMIT;
}

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
  const key = process.env.RESEND_API_KEY;
  const to = process.env.MAIL_TO;
  const from = process.env.MAIL_FROM;
  if (!key || !to || !from) return;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from,
      to: to.split(',').map((s) => s.trim()).filter(Boolean),
      reply_to: rec.email,
      subject: `新询盘 · ${rec.name || rec.email}`,
      html: emailHtml(rec),
      text: plainText(rec),
    }),
  });

  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function sendWebhook(rec) {
  const url = process.env.NOTIFY_WEBHOOK;
  if (!url) return;

  const kind = (process.env.NOTIFY_WEBHOOK_KIND || 'generic').toLowerCase();
  const content = plainText(rec);
  let payload;

  switch (kind) {
    case 'wecom':
      payload = { msgtype: 'text', text: { content } };
      break;
    case 'feishu':
      payload = { msg_type: 'text', content: { text: content } };
      break;
    case 'telegram':
      payload = {
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: content,
        disable_web_page_preview: true,
      };
      break;
    default:
      payload = { text: content };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(`webhook ${res.status}`);
}

/** 可选：把线索额外存进 Upstash Redis（免费额度够用） */
async function saveToRedis(rec) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;

  const key = process.env.LEADS_KEY || 'seoagent:leads';
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(['LPUSH', key, JSON.stringify(rec)]),
  });

  if (!res.ok) throw new Error(`upstash ${res.status}`);
}

async function notify(rec) {
  const jobs = [sendEmail(rec), sendWebhook(rec), saveToRedis(rec)];
  const results = await Promise.allSettled(jobs);
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('[notify]', result.reason?.message || result.reason);
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    return res.end('method not allowed');
  }

  const wantsJson = String(req.headers.accept || '').includes('application/json');

  const ok = () => {
    if (wantsJson) {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ ok: true }));
    }
    res.statusCode = 303;
    res.setHeader('location', '/thanks');
    res.end();
  };

  const fail = (message, status = 400) => {
    res.statusCode = status;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end(message);
  };

  try {
    const body = await readBody(req);
    if (!body) return fail('请求格式不对');

    // 反垃圾：蜜罐 + 提交过快。命中就假装成功，不给机器人反馈。
    if (str(body._hp, 100)) return ok();
    const ts = Number(body._t);
    if (Number.isFinite(ts) && ts > 0 && Date.now() - ts < 2500) return ok();

    const ip =
      String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      String(req.headers['x-real-ip'] || '') ||
      '0.0.0.0';

    if (isRateLimited(ip)) {
      return fail('提交太频繁了，过一会儿再试，或者直接发邮件给我。', 429);
    }

    const email = str(body.email, 120).toLowerCase();
    const site = str(body.site, 200);
    if (!EMAIL_RE.test(email)) return fail('邮箱看起来不对，检查一下？');
    if (site.length < 4 || !site.includes('.') || /\s/.test(site)) {
      return fail('网站地址看起来不对，填域名就行（www.example.com）。');
    }

    const record = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      ip,
      name: str(body.name, 40),
      email,
      site,
      budget: str(body.budget, 40),
      message: str(body.message, 2000),
      ref: str(body._ref, 300),
      ua: str(req.headers['user-agent'], 300),
    };

    console.log(`[lead] ${record.email} · ${record.site}`);

    // 通知失败不阻塞跳转，但要留在日志里
    await notify(record);

    return ok();
  } catch (err) {
    console.error('[lead]', err);
    return fail('服务器出了点问题，请直接发邮件联系我。', 500);
  }
}
