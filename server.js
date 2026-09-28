import express from 'express';
import { GoogleAuth } from 'google-auth-library';
import nodemailer from 'nodemailer';
import net from 'node:net';

// ---- 設定（環境変数で上書き可） ----
const cfg = {
  calendarId: process.env.CALENDAR_ID || '',
  ownerName: process.env.OWNER_NAME || 'Toshs',
  timeZone: process.env.TIME_ZONE || 'Asia/Tokyo',
  utcOffset: process.env.UTC_OFFSET || '+09:00', // Asia/Tokyo は夏時間なし
  workDays: (process.env.WORK_DAYS || '0,1,2,3,4,5,6').split(',').map(Number), // 0=日
  workStart: process.env.WORK_START || '10:00',
  workEnd: process.env.WORK_END || '23:00',
  durationStep: Number(process.env.DURATION_STEP || 30),
  maxDuration: Number(process.env.MAX_DURATION || 240),
  stepMinutes: Number(process.env.STEP_MINUTES || 30),
  daysAhead: Number(process.env.DAYS_AHEAD || 14),
  minNoticeHours: Number(process.env.MIN_NOTICE_HOURS || 0),
  mock: process.env.MOCK === '1' || !process.env.CALENDAR_ID,
  icsUrls: (process.env.ICS_URLS || '').split(',').map((s) => s.trim()).filter(Boolean),
  icsTtlMs: Number(process.env.ICS_TTL_MIN || 10) * 60000,
  icsIgnore: /^\s*\[休\]/, // 休講は空き扱い
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: Number(process.env.SMTP_PORT || 465),
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  mailFrom: process.env.MAIL_FROM || '',
  mailBcc: process.env.MAIL_BCC || '',
};
cfg.mailFrom ||= cfg.smtpUser ? `"${cfg.ownerName}" <${cfg.smtpUser}>` : '';

cfg.durations = Array.from({ length: Math.floor(cfg.maxDuration / cfg.durationStep) }, (_, i) => (i + 1) * cfg.durationStep);

const API = 'https://www.googleapis.com/calendar/v3';
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.readonly'] });

async function gcal(path, body) {
  const client = await auth.getClient();
  const res = await client.request({ url: API + path, method: 'POST', data: body });
  return res.data;
}

// ---- 日付ユーティリティ（ローカル日付 "YYYY-MM-DD" と固定オフセットで扱う） ----
const offsetMs = (() => {
  const m = cfg.utcOffset.match(/^([+-])(\d{2}):(\d{2})$/);
  const v = (Number(m[2]) * 60 + Number(m[3])) * 60000;
  return m[1] === '-' ? -v : v;
})();
const localDate = (d) => new Date(d.getTime() + offsetMs).toISOString().slice(0, 10);
const at = (date, hhmm) => new Date(`${date}T${hhmm}:00${cfg.utcOffset}`);
const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

// ---- ICS フィード（UTAS など Google に取り込まれない外部カレンダー） ----
function parseIcsDate(value) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00', z] = m;
  // Z は UTC、TZID 付き/フローティングはサイトのタイムゾーンとして扱う
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${z ? 'Z' : cfg.utcOffset}`);
}

function parseIcs(text) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const out = [];
  let ev = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') ev = {};
    else if (line === 'END:VEVENT') {
      if (ev?.start && ev.end && ev.status !== 'CANCELLED' && ev.transp !== 'TRANSPARENT' && !cfg.icsIgnore.test(ev.summary || '')) {
        out.push({ start: ev.start, end: ev.end });
      }
      ev = null;
    } else if (ev) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const [name] = line.slice(0, i).split(';');
      const value = line.slice(i + 1);
      if (name === 'DTSTART') ev.start = parseIcsDate(value);
      else if (name === 'DTEND') ev.end = parseIcsDate(value);
      else if (name === 'SUMMARY') ev.summary = value;
      else if (name === 'STATUS') ev.status = value.trim();
      else if (name === 'TRANSP') ev.transp = value.trim();
    }
  }
  return out;
}

const icsCache = new Map(); // url -> { at, events }
async function getIcsBusy(timeMin, timeMax) {
  const all = await Promise.all(cfg.icsUrls.map(async (url) => {
    const hit = icsCache.get(url);
    if (hit && Date.now() - hit.at < cfg.icsTtlMs) return hit.events;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const events = parseIcs(await res.text());
      icsCache.set(url, { at: Date.now(), events });
      return events;
    } catch (e) {
      // 取得失敗時は前回分を使う（一度も取れていなければダブルブッキング防止のためエラー）
      console.error('ICS fetch failed:', e.message);
      if (hit) return hit.events;
      throw e;
    }
  }));
  return all.flat().filter((b) => b.end > timeMin && b.start < timeMax);
}

async function getBusy(timeMin, timeMax) {
  const [google, ics] = await Promise.all([getGoogleBusy(timeMin, timeMax), getIcsBusy(timeMin, timeMax)]);
  return [...google, ...ics];
}

async function getGoogleBusy(timeMin, timeMax) {
  if (cfg.mock) return mockBusy.filter((b) => b.end > timeMin && b.start < timeMax);
  const data = await gcal('/freeBusy', {
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    timeZone: cfg.timeZone,
    items: [{ id: cfg.calendarId }],
  });
  const cal = data.calendars[cfg.calendarId];
  if (cal.errors?.length) throw new Error('freeBusy error: ' + JSON.stringify(cal.errors));
  return cal.busy.map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
}

function computeSlots(busy, duration, fromDate, toDate) {
  const earliest = new Date(Date.now() + cfg.minNoticeHours * 3600000);
  const days = [];
  for (let date = fromDate; date <= toDate; date = addDays(date, 1)) {
    const slots = [];
    if (cfg.workDays.includes(weekday(date))) {
      const dayEnd = at(date, cfg.workEnd);
      for (let s = at(date, cfg.workStart); ; s = new Date(s.getTime() + cfg.stepMinutes * 60000)) {
        const e = new Date(s.getTime() + duration * 60000);
        if (e > dayEnd) break;
        if (s < earliest) continue;
        if (busy.some((b) => b.start < e && b.end > s)) continue;
        slots.push(s.toISOString());
      }
    }
    days.push({ date, weekday: weekday(date), slots });
  }
  return days;
}

// ---- モック（CALENDAR_ID 未設定時のローカル確認用） ----
const mockBusy = (() => {
  const today = localDate(new Date());
  const out = [];
  for (let i = 0; i < cfg.daysAhead + 1; i++) {
    const d = addDays(today, i);
    out.push({ start: at(d, '12:00'), end: at(d, '13:00') });
    if (i % 2) out.push({ start: at(d, '15:00'), end: at(d, '16:30') });
  }
  return out;
})();

// ---- 予約確認メール（SMTP_HOST 未設定なら送らずログのみ） ----
let mailer = cfg.smtpHost
  ? nodemailer.createTransport({
      host: cfg.smtpHost,
      port: cfg.smtpPort,
      secure: cfg.smtpPort === 465,
      auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPass } : undefined,
      // 予約はすでに作成済みなので、SMTP が詰まってもレスポンスを長く待たせない
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    })
  : null;
if (mailer && !cfg.mailFrom) {
  console.warn('[mail] MAIL_FROM も SMTP_USER も未設定のため確認メールを無効化');
  mailer = null;
}

const fmtDate = new Intl.DateTimeFormat('ja-JP', { timeZone: cfg.timeZone, year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
const fmtTime = new Intl.DateTimeFormat('ja-JP', { timeZone: cfg.timeZone, hour: '2-digit', minute: '2-digit' });
const icsTime = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (t) => t.replace(/[\\,;]/g, (c) => '\\' + c).replace(/\r?\n/g, '\\n');
const mailAddress = (from) => from.match(/<([^>]+)>/)?.[1] || from;
// RFC 5545: 75 オクテットを超える行は CRLF + 空白で折り返す（UTF-8 の文字境界で切る）
function foldLine(line) {
  const out = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

function buildIcs({ uid, s, e, summary, organizer, attendee }) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//toshiie-booking//JA', 'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsTime(new Date())}`,
    `DTSTART:${icsTime(s)}`,
    `DTEND:${icsTime(e)}`,
    `SUMMARY:${icsText(summary)}`,
    `ORGANIZER;CN=${icsText(cfg.ownerName)}:mailto:${organizer}`,
    `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED:mailto:${attendee}`,
    'STATUS:CONFIRMED',
    'END:VEVENT', 'END:VCALENDAR',
  ].map(foldLine).join('\r\n');
}

// 宛先は未検証の入力なので、踏み台にされないよう予約者が自由に書けるメモは載せない
async function sendConfirmation({ name, email, s, e, dur }) {
  const when = `${fmtDate.format(s)} ${fmtTime.format(s)}〜${fmtTime.format(e)}`;
  const text = [
    `${name} 様`,
    '',
    `${cfg.ownerName} との予定の予約を承りました。`,
    '',
    `日時: ${when}（${dur}分）`,
    '',
    '※ このメールは送信専用です。',
  ].join('\n');
  const msg = {
    from: cfg.mailFrom,
    to: email,
    bcc: cfg.mailBcc || undefined,
    subject: `【予約確定】${when} ${cfg.ownerName}`,
    text,
    icalEvent: {
      filename: 'invite.ics',
      method: 'REQUEST',
      content: buildIcs({
        uid: `${s.getTime()}-${Math.random().toString(36).slice(2)}@toshiie-booking`,
        s, e,
        summary: `${cfg.ownerName}との予定`,
        organizer: mailAddress(cfg.mailFrom),
        attendee: email,
      }),
    },
  };
  if (!mailer || cfg.mock) {
    console.log('[mail] 送信をスキップ', { to: email, subject: msg.subject });
    return false;
  }
  await mailer.sendMail(msg);
  return true;
}

// ---- 簡易レート制限 ----
// X-Forwarded-For の末尾は Cloud Run が付けた直前の接続元。Firebase Hosting 経由だと
// それは Google のプロキシで、Firebase は利用者の送った XFF を捨てて「利用者,プロキシ」にするので、
// 末尾が Firebase のプロキシのときだけ 1 つ手前を利用者の IP とみなす
const firebaseProxies = new net.BlockList();
firebaseProxies.addSubnet('66.249.64.0', 19);
firebaseProxies.addSubnet('142.250.0.0', 15);
firebaseProxies.addSubnet('192.178.0.0', 15);
firebaseProxies.addSubnet('2001:4860::', 32, 'ipv6');
function clientIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const last = xff.at(-1);
  if (!last) return req.socket.remoteAddress;
  const viaFirebase = /Firebase Hosting/.test(req.headers.via || '') && xff.length >= 2 &&
    firebaseProxies.check(last, net.isIPv6(last) ? 'ipv6' : 'ipv4');
  return viaFirebase ? xff.at(-2) : last;
}

const hits = new Map();
function rateLimit(req, res, next) {
  const ip = clientIp(req);
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 3600000);
  if (list.length >= 5) return res.status(429).json({ error: '予約リクエストが多すぎます。しばらくしてからお試しください。' });
  list.push(now);
  hits.set(ip, list);
  next();
}

// ---- アプリ ----
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '10kb' }));
app.use(express.static('public'));

app.get('/api/config', (_req, res) => {
  res.json({ ownerName: cfg.ownerName, timeZone: cfg.timeZone, durations: cfg.durations, mock: cfg.mock });
});

app.get('/api/slots', async (req, res) => {
  const duration = Number(req.query.duration) || cfg.durations[0];
  if (!cfg.durations.includes(duration)) return res.status(400).json({ error: 'invalid duration' });
  const from = localDate(new Date());
  const to = addDays(from, cfg.daysAhead);
  try {
    const busy = await getBusy(at(from, '00:00'), at(addDays(to, 1), '00:00'));
    res.set('Cache-Control', 'no-store');
    res.json({ duration, days: computeSlots(busy, duration, from, to) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'カレンダーの取得に失敗しました' });
  }
});

app.post('/api/book', rateLimit, async (req, res) => {
  const { start, duration, name, email, note, website } = req.body || {};
  if (website) return res.json({ ok: true }); // honeypot
  const dur = Number(duration);
  const s = new Date(start);
  if (!cfg.durations.includes(dur) || isNaN(s)) return res.status(400).json({ error: '不正な枠です' });
  if (typeof name !== 'string' || !name.trim() || name.length > 100) return res.status(400).json({ error: 'お名前を入力してください' });
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return res.status(400).json({ error: 'メールアドレスが不正です' });
  const memo = typeof note === 'string' ? note.slice(0, 1000) : '';
  const who = name.replace(/[\r\n]+/g, ' ').trim();
  const e = new Date(s.getTime() + dur * 60000);

  try {
    // 枠が今もルール上有効かつ空いているか再確認
    const date = localDate(s);
    const busy = await getBusy(at(date, '00:00'), at(addDays(date, 1), '00:00'));
    const valid = computeSlots(busy, dur, date, date)[0].slots.includes(s.toISOString());
    if (!valid) return res.status(409).json({ error: 'この枠は埋まってしまいました。別の時間をお選びください。' });

    const event = {
      summary: `【予約】${who}`,
      description: `名前: ${who}\nメール: ${email}\n\n${memo}`,
      start: { dateTime: s.toISOString(), timeZone: cfg.timeZone },
      end: { dateTime: e.toISOString(), timeZone: cfg.timeZone },
    };
    if (cfg.mock) {
      mockBusy.push({ start: s, end: e });
      console.log('[mock] booked', event);
    } else {
      await gcal(`/calendars/${encodeURIComponent(cfg.calendarId)}/events`, event);
    }
    // メール送信の失敗で予約自体は失敗にしない
    const mailed = await sendConfirmation({ name: who, email, s, e, dur }).catch((err) => {
      console.error('confirmation mail failed:', err);
      return false;
    });
    res.json({ ok: true, start: s.toISOString(), end: e.toISOString(), mailed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '予約に失敗しました' });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`listening on :${port}${cfg.mock ? ' (MOCK mode)' : ''}`));
