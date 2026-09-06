/* ==========================================================================
   views.js — rendering for every screen
   The doctors table is built once and then PATCHED cell by cell. A remote
   edit flashes one cell; it never rebuilds the table under your cursor, and
   it never overwrites an input you are currently typing in.
   ========================================================================== */

import { $, $$, el, icon, mount, clear, on, fmt, fmtCompact, pct, parseNum,
         normalizeAr, timeAgo, monthShort, shiftMonth, engagementRate } from './util.js';
import { store, METRICS, METRIC_META, VIDEOS_PER_DOCTOR } from './store.js';
import { validateField, validateDoctor } from './validate.js';
import { avatar, toast } from './ui.js';

let cellIndex = new Map();     // `${doctorId}.${field}` -> input node
let rowIndex  = new Map();     // doctorId -> <tr>
let sortBy = { key: 'order', dir: 'asc' };
let filterText = '', filterMode = 'all';

/* ================= shared bits ================= */
function deltaChip(now, before) {
  if (before === null || before === undefined) return el('div', { class: 'd flat' }, el('span', { text: 'لا مقارنة سابقة' }));
  const diff = now - before;
  if (!before && !now) return el('div', { class: 'd flat' }, el('span', { text: '—' }));
  if (diff === 0) return el('div', { class: 'd flat' }, el('span', { text: 'بلا تغيير' }));
  const up = diff > 0;
  const p = before ? Math.round((diff / before) * 100) : 100;
  return el('div', { class: 'd ' + (up ? 'up' : 'down') },
    icon(up ? 'i-up' : 'i-down', 13),
    el('span', { text: `${up ? '+' : ''}${fmt(diff)} (${up ? '+' : ''}${p}%)` }));
}

function sparkline(values, color = 'var(--accent)') {
  const w = 84, h = 34, n = values.length;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'spark'); svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('aria-hidden', 'true');
  if (n < 2) return svg;
  const max = Math.max(...values, 1), min = Math.min(...values, 0);
  const span = (max - min) || 1;
  const pt = (v, i) => [ (i / (n - 1)) * w, h - 3 - ((v - min) / span) * (h - 8) ];
  const pts = values.map(pt);
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  area.setAttribute('d', `${d} L ${w} ${h} L 0 ${h} Z`);
  area.setAttribute('fill', color); area.setAttribute('opacity', '.12');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  line.setAttribute('d', d); line.setAttribute('fill', 'none');
  line.setAttribute('stroke', color); line.setAttribute('stroke-width', '1.6');
  line.setAttribute('stroke-linecap', 'round'); line.setAttribute('stroke-linejoin', 'round');
  svg.append(area, line);
  return svg;
}

function history(metric, months = 6) {
  const out = [];
  for (let i = months - 1; i >= 0; i--) {
    const m = shiftMonth(store.month, -i);
    const t = store.totalsFor(m);
    out.push(t ? (t[metric] ?? 0) : 0);
  }
  return out;
}

/* ================= OVERVIEW ================= */
export function renderOverview() {
  const t = store.totals();
  const prev = store.totalsFor(shiftMonth(store.month, -1));

  const cards = [
    { k: 'content',   label: 'منشورات وريلز', icon: 'i-image',  value: t.content },
    { k: 'views',     label: 'إجمالي المشاهدات', icon: 'i-eye',  value: t.views },
    { k: 'followers', label: 'نمو المتابعين', icon: 'i-follow', value: t.followers },
    { k: 'shares',    label: 'مشاركات المحتوى', icon: 'i-share', value: t.shares },
  ];

  mount($('#ov-kpis'), cards.map(c =>
    el('div', { class: 'kpi' },
      el('div', { class: 'k' }, icon(c.icon, 14), el('span', { text: c.label })),
      el('div', { class: 'v', text: fmt(c.value) }),
      deltaChip(c.value, prev ? prev[c.k] : null),
      sparkline(history(c.k)))));

  $('#ov-sub').textContent =
    `${store.roster.length} حساب · ${t.filled} مكتمل · ${monthShort(store.month)}`;

  /* completion */
  const done = t.filled, total = store.roster.length;
  $('#ov-complete-pill').textContent = `${done} / ${total}`;
  const waiting = store.roster.filter(d => !store.isFilled(d.id));
  mount($('#ov-complete'),
    el('div', { class: 'meter mb-16' },
      el('div', { class: 'track' }, el('div', { class: 'fill' + (done === total ? ' full' : ''), style: { width: pct(done, total) + '%' } })),
      el('span', { class: 'pct', text: pct(done, total) + '%' })),
    waiting.length === 0
      ? el('div', { class: 'row gap-8', style: { color: 'var(--ok)' } }, icon('i-check', 17), el('b', { text: 'اكتملت بيانات جميع الأطباء لهذا الشهر.' }))
      : el('div', { class: 'stack gap-8' },
          el('div', { class: 'txt-sm muted', text: `بانتظار الإدخال (${waiting.length}):` }),
          el('div', { class: 'row wrap gap-8' }, waiting.slice(0, 10).map(d => {
            const b = el('button', { class: 'pill pill-warn', type: 'button', title: 'إدخال بيانات ' + d.name }, el('span', { text: d.name }));
            on(b, 'click', () => document.dispatchEvent(new CustomEvent('cp:open-doctor', { detail: store.roster.indexOf(d) })));
            return b;
          }), waiting.length > 10 ? el('span', { class: 'pill pill-neu', text: `+${waiting.length - 10}` }) : null)),
  );

  /* top performers */
  const top = store.roster
    .map(d => ({ d, x: store.get(d.id) }))
    .filter(r => r.x.views > 0)
    .sort((a, b) => b.x.views - a.x.views)
    .slice(0, 5);

  mount($('#ov-top'), top.length === 0
    ? el('p', { class: 'txt-sm muted', text: 'لا توجد مشاهدات مسجّلة بعد لهذا الشهر.' })
    : el('div', { class: 'stack gap-12' }, top.map((r, i) => {
        const share = pct(r.x.views, store.totals().views);
        return el('div', { class: 'row gap-12' },
          el('span', { class: 'num muted', style: { minWidth: '18px' }, text: String(i + 1) }),
          avatar(r.d.name, 'avatar-sm'),
          el('div', { class: 'grow' },
            el('div', { class: 'row', style: { justifyContent: 'space-between', gap: '8px' } },
              el('b', { class: 'txt-sm', text: r.d.name }),
              el('span', { class: 'num txt-sm', text: fmtCompact(r.x.views) })),
            el('div', { class: 'meter', style: { marginTop: '4px' } },
              el('div', { class: 'track' }, el('div', { class: 'fill', style: { width: share + '%' } })))));
      })));

  renderFeed($('#ov-feed'), store.activity.slice(0, 6));
}

/* ================= ACTIVITY FEED ================= */
export function renderFeed(host, list) {
  if (!list.length) {
    mount(host, el('p', { class: 'txt-sm muted', text: 'لا يوجد نشاط مسجّل لهذا الشهر بعد.' }));
    return;
  }
  mount(host, list.map(a => {
    const d = store.roster.find(x => x.id === a.doctorId);
    const meta = METRIC_META[a.field];
    return el('div', { class: 'feed-item' },
      avatar(a.name || 'زميل', 'avatar-sm'),
      el('div', { class: 'body' },
        el('b', { text: a.name || 'زميل' }), ' حدَّث ',
        el('span', { class: 'what', text: meta ? meta.label : a.field }), ' لـ ',
        el('b', { text: d ? d.name : a.doctorId }),
        el('div', { class: 'delta' },
          el('span', { class: 'from', text: fmt(a.from) }), ' → ',
          el('span', { class: 'to', text: fmt(a.to) }))),
      el('time', { datetime: new Date(a.at).toISOString(), text: timeAgo(a.at) }));
  }));
}

/* ================= DOCTORS TABLE ================= */
export function renderDoctors({ onOpen }) {
  const body = $('#dr-body');
  cellIndex = new Map(); rowIndex = new Map();
  const canEdit = store.can('edit');
  $('#dr-mode').textContent = canEdit ? 'قابل للتعديل' : 'للاطّلاع فقط';
  $('#dr-mode').className = 'pill ' + (canEdit ? 'pill-brand' : 'pill-neu');

  const rows = visibleRows();
  clear(body);

  rows.forEach((d, i) => {
    const x = store.get(d.id);
    const tr = el('tr', { dataset: { id: d.id } });

    tr.appendChild(el('td', { class: 'rank', text: String(i + 1) }));

    const nameCell = el('td', {},
      el('div', { class: 'who' }, avatar(d.name, 'avatar-sm'),
        el('div', {}, el('b', { text: d.name }),
          el('div', { class: 'h num', text: store.completeness(d.id) + '% مكتمل' }))));
    tr.appendChild(nameCell);

    for (const k of ['posts', 'reels']) tr.appendChild(metricCell(d, k, canEdit));

    const totalTd = el('td', { class: 'num', dataset: { total: d.id } });
    totalTd.appendChild(el('b', { text: fmt((x.posts || 0) + (x.reels || 0)) }));
    tr.appendChild(totalTd);

    for (const k of ['followers', 'shares', 'views']) tr.appendChild(metricCell(d, k, canEdit));

    const act = el('td', { class: 'act no-print' });
    const btn = el('button', { class: 'btn btn-ghost btn-sm btn-icon', type: 'button', 'aria-label': 'فتح بطاقة ' + d.name, title: 'بطاقة الطبيب' }, icon('i-edit', 16));
    on(btn, 'click', () => onOpen(store.roster.findIndex(r => r.id === d.id)));
    act.appendChild(btn);
    tr.appendChild(act);

    rowIndex.set(d.id, tr);
    body.appendChild(tr);
  });

  renderFoot();
  $('#dr-count').textContent = `${rows.length} من ${store.roster.length} طبيب`;
  $('#nav-count').textContent = String(store.roster.length);

  const empty = $('#dr-empty');
  if (!rows.length) {
    empty.hidden = false;
    mount(empty, el('div', { class: 'card' }, el('div', { class: 'empty' },
      (() => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        s.setAttribute('class', 'mark'); s.setAttribute('width', 46); s.setAttribute('height', 46);
        const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', '#mark'); s.appendChild(u); return s; })(),
      el('h3', { text: 'لا نتائج' }),
      el('p', { text: 'لم نجد طبيباً مطابقاً لبحثك. جرّب اسماً آخر أو غيّر التصفية.' }))));
  } else { empty.hidden = true; clear(empty); }
}

function visibleRows() {
  let rows = store.roster.slice();
  const q = normalizeAr(filterText);
  if (q) rows = rows.filter(d => normalizeAr(d.name).includes(q));
  if (filterMode === 'done') rows = rows.filter(d => store.isFilled(d.id));
  if (filterMode === 'todo') rows = rows.filter(d => !store.isFilled(d.id));

  const { key, dir } = sortBy;
  const sign = dir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    if (key === 'order') return (a.order - b.order) * sign;
    if (key === 'name') return a.name.localeCompare(b.name, 'ar') * sign;
    const va = key === 'total' ? store.get(a.id).posts + store.get(a.id).reels : store.get(a.id)[key];
    const vb = key === 'total' ? store.get(b.id).posts + store.get(b.id).reels : store.get(b.id)[key];
    return ((Number(va) || 0) - (Number(vb) || 0)) * sign;
  });
  return rows;
}

function metricCell(d, field, canEdit) {
  const td = el('td', { class: 'num' });
  const input = el('input', {
    class: 'cell', type: 'text', inputmode: 'numeric', autocomplete: 'off',
    value: fmt(store.get(d.id)[field] || 0), dir: 'ltr',
    'aria-label': `${METRIC_META[field].label} لـ ${d.name}`,
    dataset: { id: d.id, field },
  });
  if (!canEdit) { input.readOnly = true; input.dataset.readonly = '1'; }

  on(input, 'focus', () => { input.value = String(store.get(d.id)[field] || 0); input.select(); });
  on(input, 'keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = fmt(store.get(d.id)[field] || 0); input.blur(); }
  });
  on(input, 'blur', () => commitCell(input, d, field));

  cellIndex.set(`${d.id}.${field}`, input);
  td.appendChild(input);
  return td;
}

function commitCell(input, d, field) {
  if (input.readOnly) return;
  const before = store.get(d.id)[field] || 0;
  const r = validateField(field, input.value);
  if (!r.ok) {
    input.classList.add('is-invalid');
    toast(r.error + ' لم يُحفظ التغيير.', { kind: 'dang', ms: 4500 });
    input.value = fmt(before);
    setTimeout(() => input.classList.remove('is-invalid'), 1400);
    return;
  }
  input.classList.remove('is-invalid');

  // cross-field sanity: warn, but let the value through
  const draft = JSON.parse(JSON.stringify(store.get(d.id)));
  draft[field] = r.value;
  const blocking = validateDoctor(draft, d.name).filter(i => i.level === 'error');
  if (blocking.length) {
    input.classList.add('is-invalid');
    toast(blocking[0].message + ' لم يُحفظ التغيير.', { kind: 'dang', ms: 6000 });
    input.value = fmt(before);
    setTimeout(() => input.classList.remove('is-invalid'), 1400);
    return;
  }
  const changed = store.setMetric(d.id, field, r.value);
  input.value = fmt(r.value);
  if (changed) {
    patchTotal(d.id);
    toast(`${METRIC_META[field].label} لـ ${d.name}: ${fmt(r.value)}`, {
      kind: 'ok',
      undo: () => { store.setMetric(d.id, field, before); patchCell(d.id, field, before); patchTotal(d.id); },
    });
  }
}

/* ---- surgical patching (no full re-render) ---- */
export function patchCell(doctorId, field, value, { flash = false } = {}) {
  const input = cellIndex.get(`${doctorId}.${field}`);
  if (!input) return;
  if (document.activeElement === input) return;   // never stomp on live typing
  input.value = fmt(value);
  if (flash) {
    input.classList.remove('is-remote');
    void input.offsetWidth;
    input.classList.add('is-remote');
  }
  patchTotal(doctorId);
}

function patchTotal(doctorId) {
  const td = $(`td[data-total="${CSS.escape(doctorId)}"]`);
  if (!td) return;
  const x = store.get(doctorId);
  mount(td, el('b', { text: fmt((x.posts || 0) + (x.reels || 0)) }));
  renderFoot();
  const tr = rowIndex.get(doctorId);
  const h = tr?.querySelector('.who .h');
  if (h) h.textContent = store.completeness(doctorId) + '% مكتمل';
}

export function flashRemote(doctorId, field, byName) {
  patchCell(doctorId, field, store.get(doctorId)[field], { flash: true });
  const input = cellIndex.get(`${doctorId}.${field}`);
  const td = input?.closest('td');
  if (!td || !byName) return;
  td.querySelector('.remote-tag')?.remove();
  const tag = el('span', { class: 'remote-tag', text: byName });
  td.appendChild(tag);
  setTimeout(() => tag.remove(), 2500);
}

function renderFoot() {
  const foot = $('#dr-foot');
  if (!foot) return;
  const t = store.totals();
  mount(foot, el('tr', { style: { background: 'var(--surface-2)', fontWeight: '600' } },
    el('td', { class: 'rank' }),
    el('td', {}, el('b', { text: 'المجموع' })),
    el('td', { class: 'num', text: fmt(t.posts) }),
    el('td', { class: 'num', text: fmt(t.reels) }),
    el('td', { class: 'num' }, el('b', { style: { color: 'var(--accent)' }, text: fmt(t.content) })),
    el('td', { class: 'num', text: fmt(t.followers) }),
    el('td', { class: 'num', text: fmt(t.shares) }),
    el('td', { class: 'num' }, el('b', { text: fmt(t.views) })),
    el('td', { class: 'no-print' })));
}

export function bindDoctorControls({ onOpen }) {
  const search = $('#dr-search');
  const filter = $('#dr-filter');
  on(search, 'input', () => { filterText = search.value; renderDoctors({ onOpen }); });
  on(filter, 'change', () => { filterMode = filter.value; renderDoctors({ onOpen }); });

  $$('#dr-table thead th.sortable').forEach(th => {
    on(th, 'click', () => {
      const key = th.dataset.sort;
      if (sortBy.key === key) sortBy.dir = sortBy.dir === 'asc' ? 'desc' : 'asc';
      else sortBy = { key, dir: key === 'name' ? 'asc' : 'desc' };
      $$('#dr-table thead th').forEach(h => h.removeAttribute('aria-sort'));
      th.setAttribute('aria-sort', sortBy.dir === 'asc' ? 'ascending' : 'descending');
      renderDoctors({ onOpen });
    });
  });
}

/* ================= ANALYTICS ================= */
let charts = [];
let chartLibPromise = null;

function loadChartLib() {
  if (chartLibPromise) return chartLibPromise;
  chartLibPromise = new Promise((resolve, reject) => {
    if (window.Chart) return resolve(window.Chart);
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.5.1/chart.umd.min.js';
    s.integrity = 'sha512-WoViKhKD4qI2WruSZqv9+kvM4WfFhUMQCLN4QlDTt5aU56fLQy2gYoxWIqlEnXqJy/+Ac5q/hk1oWfqnMDhwMA==';
    s.crossOrigin = 'anonymous';
    s.referrerPolicy = 'no-referrer';
    s.onload = () => resolve(window.Chart);
    s.onerror = () => reject(new Error('chart-load-failed'));
    document.head.appendChild(s);
  });
  return chartLibPromise;
}

export async function renderAnalytics() {
  const host = $('#an-body');
  const t = store.totals();

  if (t.views === 0 && t.content === 0) {
    mount(host, el('div', { class: 'card' }, el('div', { class: 'empty' },
      (() => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        s.setAttribute('class', 'mark'); s.setAttribute('width', 46); s.setAttribute('height', 46);
        const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', '#mark'); s.appendChild(u); return s; })(),
      el('h3', { text: 'لا توجد بيانات لعرضها' }),
      el('p', { text: 'ابدأ بإدخال بيانات طبيب واحد على الأقل وستظهر الرسوم هنا فوراً. لن نرسم رسوماً وهمية عندما لا توجد أرقام.' }),
      (() => { const b = el('button', { class: 'btn btn-primary', type: 'button' }, icon('i-plus', 17), el('span', { text: 'إدخال بيانات' }));
               on(b, 'click', () => document.dispatchEvent(new CustomEvent('cp:open-doctor', { detail: 0 }))); return b; })())));
    return;
  }

  mount(host,
    el('div', { class: 'two-col' },
      card('توزيع المحتوى', 'بوستات مقابل ريلز لكل طبيب', 'c-type'),
      card('حصة المشاهدات', 'نسبة كل حساب من إجمالي المشاهدات', 'c-views')),
    el('div', { class: 'two-col mt-20' },
      card('الاتجاه الشهري', 'إجمالي المشاهدات عبر آخر ٦ أشهر', 'c-trend'),
      card('معدل التفاعل', 'أعلى الفيديوهات تفاعلاً هذا الشهر', 'c-eng')));

  function card(title, sub, id) {
    return el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('div', {}, el('h3', { text: title }), el('div', { class: 'sub', text: sub }))),
      el('div', { class: 'chartwrap' }, el('canvas', { id })));
  }

  let Chart;
  try { Chart = await loadChartLib(); }
  catch {
    mount(host, el('div', { class: 'alert alert-warn' }, icon('i-alert', 18),
      el('div', { text: 'تعذّر تحميل مكتبة الرسوم البيانية. تحقّق من الاتصال بالإنترنت وأعد المحاولة.' })));
    return;
  }

  charts.forEach(c => { try { c.destroy(); } catch {} });
  charts = [];

  const css = getComputedStyle(document.documentElement);
  const brand = css.getPropertyValue('--accent').trim() || '#753BBC';
  const ink   = css.getPropertyValue('--text-2').trim();
  const grid  = css.getPropertyValue('--line').trim();
  Chart.defaults.font.family = 'IBM Plex Sans Arabic, system-ui, sans-serif';
  Chart.defaults.color = ink;
  Chart.defaults.plugins.legend.labels.boxWidth = 12;
  Chart.defaults.plugins.legend.labels.usePointStyle = true;

  const names = store.roster.map(d => d.name);
  const palette = ['#753BBC','#9E6DD8','#5F2F9A','#BE9BE7','#4A2578','#8850C9','#DAC6F2',
                   '#2A6DB2','#16785B','#A16505','#BE3149','#6BA8E5','#4FC79B','#E0AC4C'];

  charts.push(new Chart($('#c-type'), {
    type: 'bar',
    data: { labels: names, datasets: [
      { label: 'بوستات', data: store.roster.map(d => store.get(d.id).posts), backgroundColor: brand, borderRadius: 5, maxBarThickness: 26 },
      { label: 'ريلز',    data: store.roster.map(d => store.get(d.id).reels), backgroundColor: '#BE9BE7', borderRadius: 5, maxBarThickness: 26 }] },
    options: { responsive: true, maintainAspectRatio: false,
      scales: { x: { grid: { display: false }, ticks: { autoSkip: false, maxRotation: 60, minRotation: 45, font: { size: 10 } } },
                y: { beginAtZero: true, grid: { color: grid }, border: { display: false } } },
      plugins: { legend: { position: 'top', align: 'end' } } },
  }));

  const withViews = store.roster.map(d => ({ d, v: store.get(d.id).views })).filter(r => r.v > 0);
  charts.push(new Chart($('#c-views'), {
    type: 'doughnut',
    data: { labels: withViews.map(r => r.d.name),
      datasets: [{ data: withViews.map(r => r.v), backgroundColor: palette, borderWidth: 2,
                   borderColor: css.getPropertyValue('--surface').trim() }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '58%',
      plugins: { legend: { position: 'right', labels: { boxWidth: 10, font: { size: 11 } } },
        tooltip: { callbacks: { label: (c) => `${c.label}: ${fmt(c.raw)} (${Math.round(c.parsed / withViews.reduce((s, r) => s + r.v, 0) * 100)}%)` } } } },
  }));

  const months = Array.from({ length: 6 }, (_, i) => shiftMonth(store.month, -(5 - i)));
  charts.push(new Chart($('#c-trend'), {
    type: 'line',
    data: { labels: months.map(monthShort),
      datasets: [{ label: 'مشاهدات', data: history('views'), borderColor: brand, backgroundColor: brand + '22',
                   fill: true, tension: .35, pointRadius: 4, pointBackgroundColor: brand, borderWidth: 2.5 }] },
    options: { responsive: true, maintainAspectRatio: false,
      scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: grid }, border: { display: false } } },
      plugins: { legend: { display: false } } },
  }));

  const vids = [];
  store.roster.forEach(d => store.get(d.id).videos.forEach(v => {
    const r = engagementRate(v.likes, v.comments, v.views);
    if (r !== null && v.title) vids.push({ label: `${v.title} — ${d.name}`, rate: r });
  }));
  vids.sort((a, b) => b.rate - a.rate);
  const topVids = vids.slice(0, 8);

  if (topVids.length) {
    charts.push(new Chart($('#c-eng'), {
      type: 'bar',
      data: { labels: topVids.map(v => v.label.length > 30 ? v.label.slice(0, 30) + '…' : v.label),
        datasets: [{ label: 'معدل التفاعل %', data: topVids.map(v => +v.rate.toFixed(2)),
                     backgroundColor: '#16785B', borderRadius: 5, maxBarThickness: 20 }] },
      options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        scales: { x: { beginAtZero: true, grid: { color: grid }, border: { display: false }, ticks: { callback: v => v + '%' } },
                  y: { grid: { display: false }, ticks: { font: { size: 10 } } } },
        plugins: { legend: { display: false } } },
    }));
  } else {
    const wrap = $('#c-eng').closest('.chartwrap');
    mount(wrap, el('div', { class: 'empty' }, el('p', { text: 'أضف عناوين ومشاهدات للفيديوهات لحساب معدل التفاعل.' })));
  }
}

export function destroyCharts() { charts.forEach(c => { try { c.destroy(); } catch {} }); charts = []; }
