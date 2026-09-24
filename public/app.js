const $ = (id) => document.getElementById(id);
const DOW = ['日', '月', '火', '水', '木', '金', '土'];
let config, days = [], selectedDate = null, duration, pickedStart = null, lastFocus = null, loadSeq = 0;

const dtf = (opts) => new Intl.DateTimeFormat('ja-JP', { timeZone: config.timeZone, ...opts });
const fmtTime = (iso) => dtf({ hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const localHour = (iso) => Number(dtf({ hour: 'numeric', hourCycle: 'h23' }).format(new Date(iso)).replace(/\D/g, ''));
const endOf = (iso) => new Date(new Date(iso).getTime() + duration * 60000).toISOString();
const parts = (date) => date.split('-').map(Number);
const todayLocal = () => dtf({ year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replaceAll('/', '-');

async function init() {
  config = await fetch('/api/config').then((r) => r.json());
  $('owner').textContent = config.ownerName;
  $('tz').textContent = config.timeZone === 'Asia/Tokyo' ? '日本時間 (JST)' : config.timeZone;
  duration = config.durations[0];

  if (config.durations.length < 2) $('durLabel').closest('.section').hidden = true;
  const ds = config.durations;
  if (ds.length > 1) $('durRange').textContent = `${fmtDur(ds[0])}〜${fmtDur(ds.at(-1))}・${fmtDur(ds[1] - ds[0])}単位`;
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
  renderDuration();
  load();
}

const fmtDur = (min) => {
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h}時間${m ? `${m}分` : ''}` : `${m}分`;
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
    const r = await fetch(`/api/slots?duration=${duration}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    if (seq !== loadSeq) return;
    days = data.days;
  } catch (e) {
    if (seq !== loadSeq) return;
    $('slots').innerHTML = '';
    showStatus(e.message || '読み込みに失敗しました');
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
    b.setAttribute('aria-label', `${m}月${day}日 ${DOW[d.weekday]}曜日 ${d.slots.length ? `${d.slots.length}枠` : '空きなし'}`);
    b.innerHTML = `<span class="date-dow">${DOW[d.weekday]}</span><span class="date-num">${day}</span><span class="date-dot"></span>`;
    b.onclick = () => { selectedDate = d.date; renderDays(); renderSlots(); };
    wrap.append(b);
  }
  const sel = wrap.querySelector('[aria-selected="true"]');
  if (sel) wrap.scrollTo({ left: Math.max(0, sel.offsetLeft - wrap.clientWidth / 2 + sel.clientWidth / 2), behavior: 'smooth' });

  const first = parts(days[0].date), last = parts(days.at(-1).date);
  $('monthLabel').textContent = first[1] === last[1] ? `${first[0]}年${first[1]}月` : `${first[0]}年${first[1]}月 – ${last[1]}月`;
}

function renderSlots() {
  const wrap = $('slots');
  wrap.innerHTML = '';
  const day = days.find((d) => d.date === selectedDate);
  if (!day) {
    $('dayLabel').textContent = '';
    showStatus('現在予約できる枠がありません');
    return;
  }
  $('status').hidden = true;
  const [, m, d] = parts(day.date);
  $('dayLabel').textContent = `${m}月${d}日（${DOW[day.weekday]}）· ${day.slots.length}枠`;

  const groups = [
    ['午前', day.slots.filter((s) => localHour(s) < 12)],
    ['午後', day.slots.filter((s) => localHour(s) >= 12 && localHour(s) < 18)],
    ['夜', day.slots.filter((s) => localHour(s) >= 18)],
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
      b.setAttribute('aria-label', `${fmtTime(s)}から${fmtDur(duration)}`);
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
  const d = new Date(start);
  $('sumMonth').textContent = dtf({ month: 'short' }).format(d);
  $('sumDay').textContent = dtf({ day: 'numeric' }).format(d).replace(/\D/g, '');
  $('sumDate').textContent = dtf({ year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(d);
  $('sumTime').textContent = `${fmtTime(start)} – ${fmtTime(endOf(start))}（${fmtDur(duration)}）`;
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
    $('formError').textContent = firstInvalid.name === 'name' ? 'お名前を入力してください' : 'メールアドレスを正しく入力してください';
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
      body: JSON.stringify({ ...Object.fromEntries(new FormData(form)), start: pickedStart, duration }),
    });
    const data = await r.json();
    if (!r.ok) {
      $('formError').textContent = data.error || '予約に失敗しました';
      if (r.status === 409) load();
      return;
    }
    $('doneText').replaceChildren($('sumDate').textContent, Object.assign(document.createElement('span'), { textContent: $('sumTime').textContent }));
    $('sheetForm').hidden = true;
    $('sheetDone').hidden = false;
    $('doneClose').focus({ preventScroll: true });
    form.elements.note.value = '';
    load();
  } catch {
    $('formError').textContent = '通信に失敗しました。もう一度お試しください。';
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
