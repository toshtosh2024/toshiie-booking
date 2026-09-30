const $ = (id) => document.getElementById(id);
const I18N = {
  ja: {
    locale: 'ja-JP', dow: ['日', '月', '火', '水', '木', '金', '土'],
    title: 'Toshiieとの日程調整', heading: '日程調整',
    sub: 'ご都合のよい日時をお選びください。塩見に連絡が行きます',
    duration: '所要時間', date: '日付', time: '時間',
    footer: 'カレンダーの空き状況はリアルタイムで反映されます。',
    cancel: 'キャンセル', confirm: '予約の確認',
    name: 'お名前', namePh: '山田 太郎', email: 'メール', note: 'メモ（任意）', notePh: 'ご用件など',
    book: '予約する', doneTitle: '予約が完了しました', doneNote: 'この画面のスクリーンショットを保存しておくと安心です。',
    sep: '', close: '閉じる', tzJst: '日本時間 (JST)',
    durMinus: '30分短くする', durPlus: '30分長くする',
    loadFail: '読み込みに失敗しました', noSlots: '現在予約できる枠がありません',
    nameReq: 'お名前を入力してください', emailBad: 'メールアドレスを正しく入力してください',
    bookFail: '予約に失敗しました', netFail: '通信に失敗しました。もう一度お試しください。',
    mailed: (a) => `確認メールを ${a} に送信しました。`,
    hour: (h) => `${h}時間`, min: (m) => `${m}分`, unit: (d) => `${d}単位`, range: (a, b, u) => `${a}〜${b}・${u}`,
    period: ['午前', '午後', '夜'],
    dayAria: (m, d, dow, n) => `${m}月${d}日 ${dow}曜日 ${n ? `${n}枠` : '空きなし'}`,
    monthLabel: (y, m1, m2) => m1 === m2 ? `${y}年${m1}月` : `${y}年${m1}月 – ${m2}月`,
    dayLabel: (m, d, dow, n) => `${m}月${d}日（${dow}）· ${n}枠`,
    slotAria: (t, dur) => `${t}から${dur}`,
  },
  en: {
    locale: 'en-US', dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    title: 'Schedule a time with Toshiie', heading: 'Book a time',
    sub: 'Pick a time that works for you. Toshiie will be notified.',
    duration: 'Duration', date: 'Date', time: 'Time',
    footer: 'Calendar availability is updated in real time.',
    cancel: 'Cancel', confirm: 'Confirm booking',
    name: 'Name', namePh: 'Jane Smith', email: 'Email', note: 'Note (optional)', notePh: 'Purpose of the meeting, etc.',
    book: 'Book', doneTitle: 'Booking confirmed', doneNote: 'You may want to save a screenshot of this screen.',
    sep: ' ', close: 'Close', tzJst: 'Japan Time (JST)',
    durMinus: 'Shorten by 30 minutes', durPlus: 'Extend by 30 minutes',
    loadFail: 'Failed to load', noSlots: 'No time slots are currently available',
    nameReq: 'Please enter your name', emailBad: 'Please enter a valid email address',
    bookFail: 'Booking failed', netFail: 'Network error. Please try again.',
    mailed: (a) => `A confirmation email was sent to ${a}.`,
    hour: (h) => `${h} hr`, min: (m) => `${m} min`, unit: (d) => `${d} steps`, range: (a, b, u) => `${a} – ${b} · ${u}`,
    period: ['Morning', 'Afternoon', 'Evening'],
    dayAria: (m, d, dow, n) => `${dow}, ${m}/${d}, ${n ? `${n} slots` : 'unavailable'}`,
    monthLabel: (y, m1, m2) => m1 === m2 ? `${MONTHS_EN[m1 - 1]} ${y}` : `${MONTHS_EN[m1 - 1]} – ${MONTHS_EN[m2 - 1]} ${y}`,
    dayLabel: (m, d, dow, n) => `${dow}, ${MONTHS_EN[m - 1]} ${d} · ${n} slots`,
    slotAria: (t, dur) => `${t}, ${dur}`,
  },
};
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const store = { get: () => { try { return localStorage.getItem('lang'); } catch { return null; } }, set: (v) => { try { localStorage.setItem('lang', v); } catch {} } };
let lang = store.get() || (navigator.language?.startsWith('ja') ? 'ja' : 'en');
if (!I18N[lang]) lang = 'ja';
const t = () => I18N[lang];
let config, days = [], selectedDate = null, duration, pickedStart = null, lastFocus = null, loadSeq = 0, mailedTo = '';

const dtf = (opts) => new Intl.DateTimeFormat(t().locale, { timeZone: config.timeZone, ...opts });
const fmtTime = (iso) => dtf({ hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const localHour = (iso) => Number(dtf({ hour: 'numeric', hourCycle: 'h23' }).format(new Date(iso)).replace(/\D/g, ''));
const endOf = (iso) => new Date(new Date(iso).getTime() + duration * 60000).toISOString();
const parts = (date) => date.split('-').map(Number);
const todayLocal = () => dtf({ year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replaceAll('/', '-');

async function init() {
  config = await fetch('/api/config').then((r) => r.json());
  duration = config.durations[0];

  if (config.durations.length < 2) $('durLabel').closest('.section').hidden = true;
  const ds = config.durations;
  const step = (dir) => {
    const next = ds[ds.indexOf(duration) + dir];
    if (next === undefined) return;
    duration = next;
    renderDuration(true);
    clearTimeout(stepTimer);
    stepTimer = setTimeout(load, 250); // 連打中はまとめて1回だけ取得
  };
  $('durMinus').onclick = () => step(-1);
  $('durPlus').onclick = () => step(1);
  applyLang();
  load();
}

function applyLang() {
  const L = t();
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = L[el.dataset.i18n];
  for (const el of document.querySelectorAll('[data-i18n-ph]')) el.placeholder = L[el.dataset.i18nPh];
  document.title = L.title;
  for (const b of document.querySelectorAll('#lang button')) b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
  if (!config) return;
  const ds = config.durations;
  $('owner').textContent = config.ownerName;
  $('tz').textContent = config.timeZone === 'Asia/Tokyo' ? L.tzJst : config.timeZone;
  $('durMinus').setAttribute('aria-label', L.durMinus);
  $('durPlus').setAttribute('aria-label', L.durPlus);
  if (ds.length > 1) $('durRange').textContent = L.range(fmtDur(ds[0]), fmtDur(ds.at(-1)), L.unit(fmtDur(ds[1] - ds[0])));
  renderDuration();
  if (days.length) { renderDays(); renderSlots(); }
  if (!$('sheet').hidden && pickedStart) fillSummary(pickedStart);
  if (!$('sheetDone').hidden) fillDone();
}

for (const b of document.querySelectorAll('#lang button')) {
  b.onclick = () => { lang = b.dataset.lang; store.set(lang); applyLang(); };
}

const fmtDur = (min) => {
  const h = Math.floor(min / 60), m = min % 60;
  return h ? [t().hour(h), m && t().min(m)].filter(Boolean).join(t().sep) : t().min(m);
};
let stepTimer;

function renderDuration(bump) {
  const ds = config.durations;
  $('durValue').textContent = fmtDur(duration);
  $('metaDuration').textContent = fmtDur(duration);
  $('durMinus').disabled = duration === ds[0];
  $('durPlus').disabled = duration === ds.at(-1);
  if (bump) {
    const el = $('durValue');
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }
}

async function load() {
  const seq = ++loadSeq;
  $('status').hidden = true;
  $('slots').innerHTML = `<div class="slot-grid">${'<div class="skeleton"></div>'.repeat(8)}</div>`;
  try {
    const r = await fetch(`/api/slots?duration=${duration}&lang=${lang}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    if (seq !== loadSeq) return;
    days = data.days;
  } catch (e) {
    if (seq !== loadSeq) return;
    $('slots').innerHTML = '';
    showStatus(e.message || t().loadFail);
    return;
  }
  if (!days.some((d) => d.date === selectedDate && d.slots.length)) {
    selectedDate = days.find((d) => d.slots.length)?.date ?? null;
  }
  renderDays();
  renderSlots();
}

function showStatus(text) {
  $('status').textContent = text;
  $('status').hidden = false;
}

function renderDays() {
  const wrap = $('days');
  const today = todayLocal();
  wrap.innerHTML = '';
  for (const d of days) {
    const [, m, day] = parts(d.date);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'date' + (d.weekday === 0 ? ' sun' : d.weekday === 6 ? ' sat' : '') + (d.date === today ? ' today' : '');
    b.disabled = !d.slots.length;
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(d.date === selectedDate));
    b.setAttribute('aria-label', t().dayAria(m, day, t().dow[d.weekday], d.slots.length));
    b.innerHTML = `<span class="date-dow">${t().dow[d.weekday]}</span><span class="date-num">${day}</span><span class="date-dot"></span>`;
    b.onclick = () => { selectedDate = d.date; renderDays(); renderSlots(); };
    wrap.append(b);
  }
  const sel = wrap.querySelector('[aria-selected="true"]');
  if (sel) wrap.scrollTo({ left: Math.max(0, sel.offsetLeft - wrap.clientWidth / 2 + sel.clientWidth / 2), behavior: 'smooth' });

  const first = parts(days[0].date), last = parts(days.at(-1).date);
  $('monthLabel').textContent = t().monthLabel(first[0], first[1], last[1]);
}

function renderSlots() {
  const wrap = $('slots');
  wrap.innerHTML = '';
  const day = days.find((d) => d.date === selectedDate);
  if (!day) {
    $('dayLabel').textContent = '';
    showStatus(t().noSlots);
    return;
  }
  $('status').hidden = true;
  const [, m, d] = parts(day.date);
  $('dayLabel').textContent = t().dayLabel(m, d, t().dow[day.weekday], day.slots.length);

  const groups = [
    [t().period[0], day.slots.filter((s) => localHour(s) < 12)],
    [t().period[1], day.slots.filter((s) => localHour(s) >= 12 && localHour(s) < 18)],
    [t().period[2], day.slots.filter((s) => localHour(s) >= 18)],
  ];
  let i = 0;
  for (const [title, slots] of groups) {
    if (!slots.length) continue;
    const g = document.createElement('div');
    g.className = 'slot-group';
    g.innerHTML = `<h3 class="slot-group-title">${title}</h3><div class="slot-grid"></div>`;
    const grid = g.lastElementChild;
    for (const s of slots) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'slot';
      b.style.animationDelay = `${Math.min(i++, 12) * 18}ms`;
      b.textContent = fmtTime(s);
      b.setAttribute('aria-label', t().slotAria(fmtTime(s), fmtDur(duration)));
      b.onclick = () => openSheet(s);
      grid.append(b);
    }
    wrap.append(g);
  }
}

// ---------- シート ----------
function openSheet(start) {
  pickedStart = start;
  lastFocus = document.activeElement;
  fillSummary(start);
  $('formError').textContent = '';
  document.querySelectorAll('.list-row.invalid').forEach((r) => r.classList.remove('invalid'));
  $('sheetForm').hidden = false;
  $('sheetDone').hidden = true;

  $('backdrop').hidden = false;
  $('sheet').hidden = false;
  document.body.style.overflow = 'hidden';
  void $('sheet').offsetHeight; // reflow してからクラスを付けて遷移を発火
  $('backdrop').classList.add('open');
  $('sheet').classList.add('open');
  setTimeout(() => $('form').elements.name.focus({ preventScroll: true }), 350);
}

function fillSummary(start) {
  const d = new Date(start);
  $('sumMonth').textContent = dtf({ month: 'short' }).format(d);
  $('sumDay').textContent = dtf({ day: 'numeric' }).format(d).replace(/\D/g, '');
  $('sumDate').textContent = dtf({ year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(d);
  $('sumTime').textContent = `${fmtTime(start)} – ${fmtTime(endOf(start))} (${fmtDur(duration)})`;
}

function fillDone() {
  $('doneText').replaceChildren($('sumDate').textContent, Object.assign(document.createElement('span'), { textContent: $('sumTime').textContent }));
  $('doneNote').textContent = mailedTo ? t().mailed(mailedTo) : t().doneNote;
}

function closeSheet() {
  if ($('sheet').hidden) return;
  $('backdrop').classList.remove('open');
  $('sheet').classList.remove('open');
  document.body.style.overflow = '';
  setTimeout(() => { $('backdrop').hidden = true; $('sheet').hidden = true; }, 400);
  lastFocus?.focus?.({ preventScroll: true });
}

$('cancel').onclick = closeSheet;
$('backdrop').onclick = closeSheet;
$('doneClose').onclick = closeSheet;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

$('form').onsubmit = async (e) => {
  e.preventDefault();
  const form = e.target;
  let firstInvalid = null;
  for (const el of [form.elements.name, form.elements.email]) {
    const bad = !el.value.trim() || !el.checkValidity();
    el.closest('.list-row').classList.toggle('invalid', bad);
    if (bad && !firstInvalid) firstInvalid = el;
  }
  if (firstInvalid) {
    $('formError').textContent = firstInvalid.name === 'name' ? t().nameReq : t().emailBad;
    firstInvalid.focus();
    return;
  }

  const btn = $('submit');
  btn.disabled = true;
  btn.classList.add('loading');
  $('formError').textContent = '';
  try {
    const r = await fetch('/api/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...Object.fromEntries(new FormData(form)), start: pickedStart, duration, lang }),
    });
    const data = await r.json();
    if (!r.ok) {
      $('formError').textContent = data.error || t().bookFail;
      if (r.status === 409) load();
      return;
    }
    mailedTo = data.mailed ? form.elements.email.value : '';
    fillDone();
    $('sheetForm').hidden = true;
    $('sheetDone').hidden = false;
    $('doneClose').focus({ preventScroll: true });
    form.elements.note.value = '';
    load();
  } catch {
    $('formError').textContent = t().netFail;
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
  }
};

// ---------- Large Title → ナビバー ----------
new IntersectionObserver(([entry]) => {
  $('navbar').classList.toggle('scrolled', !entry.isIntersecting);
}, { rootMargin: '-44px 0px 0px 0px' }).observe($('largeTitle'));

init();
