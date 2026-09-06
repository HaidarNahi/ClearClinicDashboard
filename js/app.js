/* ==========================================================================
   app.js — bootstrap, routing, and everything wired together
   ========================================================================== */

import { $, $$, el, icon, mount, clear, on, safeStore, fmt, download,
         recentMonths, monthLabel, monthShort, shiftMonth, monthKey, debounce, trapFocus } from './util.js';
import { buildXlsx, STYLE } from './xlsx.js';
import { validateAll, hasErrors } from './validate.js';
import { auth, initGate } from './auth.js';
import { store, METRICS, METRIC_META } from './store.js';
import { toast, avatar, initSheet, initCmdk } from './ui.js';
import { renderOverview, renderDoctors, renderAnalytics, renderFeed,
         bindDoctorControls, flashRemote, destroyCharts } from './views.js';

/* ================= theme ================= */
const THEME_KEY = 'cp.theme';
function applyTheme(t) {
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  safeStore.set(THEME_KEY, t);
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  const btn = $('#btn-theme');
  if (btn) mount(btn, icon(dark ? 'i-sun' : 'i-moon', 18));
}
function cycleTheme() {
  const cur = safeStore.get(THEME_KEY, 'system');
  const next = cur === 'system' ? 'dark' : cur === 'dark' ? 'light' : 'system';
  applyTheme(next);
  toast(next === 'system' ? 'المظهر يتبع النظام' : next === 'dark' ? 'المظهر الليلي' : 'المظهر النهاري', { kind: 'info', ms: 1800 });
}
applyTheme(safeStore.get(THEME_KEY, 'system'));

/* ================= routing ================= */
const VIEWS = {
  overview: { label: 'نظرة عامة', title: 'نظرة عامة' },
  doctors:  { label: 'الأطباء',    title: 'الأطباء' },
  analytics:{ label: 'التحليلات',  title: 'التحليلات' },
  activity: { label: 'سجل النشاط', title: 'سجل النشاط' },
  help:     { label: 'المساعدة',   title: 'المساعدة' },
};
let current = 'overview';

function route(name, { push = true } = {}) {
  if (!VIEWS[name]) name = 'overview';
  current = name;

  $$('.view').forEach(v => v.classList.toggle('is-on', v.id === 'v-' + name));
  $$('[data-nav]').forEach(b => {
    const on_ = b.dataset.nav === name;
    b.setAttribute('aria-current', on_ ? 'page' : 'false');
    if (!on_) b.removeAttribute('aria-current');
  });

  $('#crumb-view').textContent = VIEWS[name].label;
  document.title = `${VIEWS[name].title} · ${monthShort(store.month)} — كلير بَلس`;
  if (push && location.hash !== '#/' + name) history.pushState(null, '', '#/' + name);

  if (name === 'analytics') renderAnalytics();
  if (name === 'activity') renderFeed($('#ac-feed'), store.activity);
  if (name === 'overview') renderOverview();

  document.querySelector('.content')?.scrollIntoView({ block: 'start', behavior: 'instant' });
  updateStickyCta();
}

const routeFromHash = () => route((location.hash.replace(/^#\/?/, '') || 'overview'), { push: false });

/* ================= sync badge ================= */
const SYNC = {
  connecting: { label: 'جارٍ الاتصال…',  live: true },
  live:       { label: 'متزامن',          live: true },
  saving:     { label: 'جارٍ الحفظ…',    live: true },
  local:      { label: 'محلي فقط',        live: false },
  offline:    { label: 'غير متصل',        live: false },
};
function paintSync() {
  const badge = $('#sync');
  if (!badge) return;
  const s = SYNC[store.status] || SYNC.connecting;
  badge.dataset.state = store.status;
  const pending = store.pendingCount;
  const label = pending ? `${s.label} · ${pending} بانتظار الرفع` : s.label;
  mount(badge, el('span', { class: 'dot' + (s.live ? ' dot-live' : '') }), el('span', { class: 'lbl', text: label }));
  badge.title = store.mode === 'cloud'
    ? `الوضع السحابي — ${label}`
    : 'الوضع المحلي: بياناتك محفوظة على هذا الجهاز فقط ولم تُرفع للفريق بعد.';
  badge.setAttribute('aria-label', badge.title);
}

/* ================= sticky mobile CTA ================= */
let ctaNode = null;
function updateStickyCta() {
  const shouldShow = (current === 'overview' || current === 'doctors')
                  && store.can('edit')
                  && store.totals().filled < store.roster.length;
  if (shouldShow && !ctaNode) {
    const b = el('button', { class: 'btn btn-primary btn-block', type: 'button' },
      icon('i-plus', 17), el('span', { text: 'أكمل إدخال بيانات الشهر' }));
    on(b, 'click', () => {
      const next = store.roster.findIndex(d => !store.isFilled(d.id));
      sheet.open(next < 0 ? 0 : next);
    });
    ctaNode = el('div', { class: 'sticky-cta' }, b);
    document.body.appendChild(ctaNode);
  } else if (!shouldShow && ctaNode) {
    ctaNode.remove(); ctaNode = null;
  }
}

/* ================= month bar ================= */
function buildMonths() {
  const sel = $('#m-select');
  const months = recentMonths(18);
  if (!months.includes(store.month)) months.unshift(store.month);
  mount(sel, months.map(m => el('option', { value: m, selected: m === store.month || null, text: monthLabel(m) })));
  $('#crumb-month').textContent = monthShort(store.month);
}
async function goMonth(m) {
  await store.setMonth(m);
  buildMonths();
  refreshAll();
  toast(`عرض بيانات ${monthShort(m)}`, { kind: 'info', ms: 2000 });
}

/* ================= export ================= */
/* Two formats only: Excel (.xlsx) and PDF (via the print stylesheet).
   Both run a validation sweep first — nobody should ship a report with
   impossible numbers in it. */

function preflight(what) {
  const problems = validateAll(store.roster, (id) => store.get(id));
  const errs = problems.filter(p => hasErrors(p.issues));
  if (!errs.length) return true;
  const names = errs.slice(0, 3).map(p => p.doctor.name).join('، ');
  const more = errs.length > 3 ? ` و${errs.length - 3} غيرهم` : '';
  const ok = confirm(
    `تحذير قبل ${what}:\n\n` +
    `${errs.length} من الأطباء لديهم قيم غير منطقية (${names}${more}).\n` +
    `مثال: ${errs[0].issues.find(i => i.level === 'error').message}\n\n` +
    `هل تريد المتابعة على أي حال؟`
  );
  if (!ok) { route('doctors'); toast('راجع القيم المميّزة ثم أعد المحاولة.', { kind: 'warn', ms: 5000 }); }
  return ok;
}

function exportExcel() {
  if (!preflight('التصدير')) return;

  const H = STYLE.HEADER, B = STYLE.BOLD, N = STYLE.NUM, NB = STYLE.NUM_BOLD;
  const rows = [];

  rows.push([{ v: `تقرير أداء حسابات الأطباء — ${monthLabel(store.month)}`, s: STYLE.TITLE }]);
  rows.push([{ v: `عيادات كلير للأسنان · القسم الإعلامي · صُدّر في ${new Date().toLocaleDateString('ar-IQ')}` }]);
  rows.push([]);

  const head = ['#', 'الطبيب', ...METRICS.map(k => METRIC_META[k].label), 'إجمالي المنشورات', 'نسبة الاكتمال'];
  rows.push(head.map(h => ({ v: h, s: H })));

  store.roster.forEach((d, i) => {
    const x = store.get(d.id);
    rows.push([
      { v: i + 1, s: N },
      { v: d.name, s: 0, t: 's' },
      ...METRICS.map(k => ({ v: Number(x[k]) || 0, s: N })),
      { v: (Number(x.posts) || 0) + (Number(x.reels) || 0), s: NB },
      { v: store.completeness(d.id) / 100, s: N },
    ]);
  });

  const t = store.totals();
  rows.push([
    { v: '', s: B }, { v: 'المجموع', s: B },
    { v: t.posts, s: NB }, { v: t.reels, s: NB }, { v: t.followers, s: NB },
    { v: t.shares, s: NB }, { v: t.views, s: NB }, { v: t.content, s: NB }, { v: '', s: B },
  ]);

  rows.push([]);
  rows.push([{ v: 'أفضل ٣ فيديوهات لكل طبيب', s: STYLE.TITLE }]);
  rows.push(['الطبيب', 'الترتيب', 'اسم الفيديو', 'تاريخ النشر', 'المشاهدات', 'الإعجابات', 'التعليقات', 'معدل التفاعل %']
    .map(h => ({ v: h, s: H })));

  store.roster.forEach((d) => {
    store.get(d.id).videos.forEach((v, j) => {
      if (!String(v.title || '').trim() && !Number(v.views)) return;
      const vv = Number(v.views) || 0;
      const rate = vv ? ((Number(v.likes) + Number(v.comments)) / vv) * 100 : 0;
      rows.push([
        { v: d.name, t: 's' }, { v: j + 1, s: N }, { v: v.title || '', t: 's' },
        { v: v.date || '', t: 's' }, { v: vv, s: N },
        { v: Number(v.likes) || 0, s: N }, { v: Number(v.comments) || 0, s: N },
        { v: Number(rate.toFixed(2)), s: N },
      ]);
    });
  });

  const blob = buildXlsx(rows, {
    sheetName: monthShort(store.month),
    cols: [5, 26, 11, 10, 15, 12, 14, 17, 14],
    rtl: true,
    freezeRow: 4,
  });

  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: `تقرير-كلير-${store.month}.xlsx` });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('تم تنزيل ملف Excel.', { kind: 'ok' });
}

function exportPDF() {
  if (!preflight('الطباعة')) return;

  const back = current;
  route('doctors');

  const head = el('div', { class: 'print-only print-head' },
    el('div', { class: 'ph-top' },
      el('div', {},
        el('h1', { text: 'تقرير أداء حسابات الأطباء على إنستغرام' }),
        el('p', { text: `عيادات كلير للأسنان — القسم الإعلامي · ${monthLabel(store.month)}` })),
      el('div', { class: 'ph-meta' },
        el('div', { text: `صُدّر: ${new Date().toLocaleDateString('ar-IQ')}` }),
        el('div', { text: `${store.roster.length} حساب · ${store.totals().filled} مكتمل` }))),
  );
  document.querySelector('.content').prepend(head);

  const cleanup = () => { head.remove(); route(back); window.removeEventListener('afterprint', cleanup); };
  window.addEventListener('afterprint', cleanup);
  setTimeout(() => { window.print(); setTimeout(cleanup, 1500); }, 120);
}

function exportMenu() {
  const box = el('div', { class: 'card menu-pop' });
  const mk = (label, sub, ic, fn) => {
    const b = el('button', { class: 'cmdk-item', type: 'button' },
      icon(ic, 18),
      el('span', { class: 'grow' }, el('b', { text: label }), el('small', { text: sub })));
    on(b, 'click', () => { close(); fn(); });
    return b;
  };
  mount(box,
    mk('Excel (.xlsx)', 'جدول منسّق يفتح في Excel مباشرة', 'i-download', exportExcel),
    mk('PDF', 'نسخة للطباعة أو الحفظ كـ PDF', 'i-print', exportPDF));

  const anchor = $('#btn-export').getBoundingClientRect();
  box.style.top = (anchor.bottom + 6) + 'px';
  box.style.insetInlineStart = anchor.left + 'px';
  document.body.appendChild(box);
  const close = () => { box.remove(); document.removeEventListener('click', away, true); };
  const away = (e) => { if (!box.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener('click', away, true), 0);
}

/* ================= data-health report ================= */
function showValidationReport() {
  const problems = validateAll(store.roster, (id) => store.get(id));
  const errCount  = problems.reduce((n, p) => n + p.issues.filter(i => i.level === 'error').length, 0);
  const warnCount = problems.reduce((n, p) => n + p.issues.filter(i => i.level === 'warn').length, 0);

  const scrim = el('div', { class: 'scrim is-on', style: { zIndex: '145' } });
  const box = el('div', { class: 'card val-pop', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'فحص صحة البيانات' });

  const close = () => { scrim.remove(); box.remove(); release?.(); };

  const header = el('div', { class: 'card-head' },
    el('div', {},
      el('h3', { text: 'فحص صحة البيانات' }),
      el('div', { class: 'sub', text: `${monthShort(store.month)} · ${store.roster.length} حساب` })),
    (() => { const b = el('button', { class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': 'إغلاق' }, icon('i-x', 18));
             on(b, 'click', close); return b; })());

  const summary = el('div', { class: 'row gap-8 wrap', style: { padding: '14px 20px', borderBottom: '1px solid var(--line)' } },
    el('span', { class: 'pill ' + (errCount ? 'pill-dang' : 'pill-ok') },
      icon(errCount ? 'i-alert' : 'i-check', 13), el('span', { text: `${errCount} خطأ` })),
    el('span', { class: 'pill ' + (warnCount ? 'pill-warn' : 'pill-neu') },
      el('span', { text: `${warnCount} تنبيه` })),
    el('span', { class: 'txt-xs muted', text: 'الأخطاء تمنع التصدير حتى تراجعها. التنبيهات للمراجعة فقط.' }));

  const body = el('div', { class: 'val-body' });
  if (!problems.length) {
    mount(body, el('div', { class: 'empty' },
      icon('i-check', 34), el('h3', { text: 'كل الأرقام سليمة' }),
      el('p', { text: 'لم نجد أي قيمة غير منطقية أو متناقضة في بيانات هذا الشهر.' })));
  } else {
    mount(body, problems.map(p =>
      el('div', { class: 'val-group' },
        (() => {
          const b = el('button', { class: 'val-doc', type: 'button' },
            avatar(p.doctor.name, 'avatar-sm'),
            el('b', { class: 'grow', text: p.doctor.name }),
            el('span', { class: 'pill ' + (p.issues.some(i => i.level === 'error') ? 'pill-dang' : 'pill-warn'),
                         text: `${p.issues.length}` }),
            icon('i-edit', 15));
          on(b, 'click', () => { close(); sheet.open(store.roster.findIndex(d => d.id === p.doctor.id)); });
          return b;
        })(),
        el('ul', { class: 'val-list' }, p.issues.map(i =>
          el('li', { class: 'val-' + i.level },
            icon(i.level === 'error' ? 'i-alert' : 'i-help', 14),
            el('span', { text: i.message })))))));
  }

  const foot = el('div', { class: 'sheet-foot' },
    (() => { const b = el('button', { class: 'btn btn-outline grow', text: 'إغلاق' }); on(b, 'click', close); return b; })(),
    (() => { const b = el('button', { class: 'btn btn-primary grow' }, icon('i-download', 16), el('span', { text: 'تصدير Excel' }));
             on(b, 'click', () => { close(); exportExcel(); }); return b; })());

  mount(box, header, summary, body, foot);
  document.body.append(scrim, box);
  on(scrim, 'click', close);
  const release = trapFocus(box, { onEscape: close });
}

/* ================= presence ================= */
function paintPresence() {
  const host = $('#presence');
  if (!host) return;
  const peers = store.peers.slice(0, 4);
  clear(host);
  peers.forEach(p => { const a = avatar(p.name, 'avatar-sm'); a.title = p.name + ' — متصل الآن'; host.appendChild(a); });
  if (store.peers.length > 4) host.appendChild(el('span', { class: 'more', text: '+' + (store.peers.length - 4) }));
  host.title = store.peers.length ? `${store.peers.length} من الفريق متصلون الآن` : 'لا يوجد زملاء متصلون';
}

/* ================= refresh ================= */
let sheet, cmdk;
const refreshAll = debounce(() => {
  renderOverview();
  renderDoctors({ onOpen: (i) => sheet.open(i) });
  if (current === 'analytics') renderAnalytics();
  if (current === 'activity') renderFeed($('#ac-feed'), store.activity);
  updateStickyCta();
}, 60);

/* ================= keyboard ================= */
const KEYS = [
  ['⌘K / Ctrl+K', 'لوحة الأوامر والبحث السريع'],
  ['N',            'فتح نافذة الإدخال'],
  ['1 – 5',        'التنقل بين الصفحات'],
  ['E',            'تصدير Excel'],
  ['P',            'تصدير PDF / طباعة'],
  ['V',            'فحص صحة البيانات'],
  ['D',            'تبديل المظهر الليلي'],
  ['Esc',          'إغلاق أي نافذة مفتوحة'],
];
function bindKeys() {
  on(document, 'keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); cmdk.show(); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    const names = Object.keys(VIEWS);
    if (k >= '1' && k <= '5') { route(names[Number(k) - 1]); }
    else if (k === 'n') { e.preventDefault(); sheet.open(Math.max(0, store.roster.findIndex(d => !store.isFilled(d.id)))); }
    else if (k === 'e') exportExcel();
    else if (k === 'p') { e.preventDefault(); exportPDF(); }
    else if (k === 'v') showValidationReport();
    else if (k === 'd') cycleTheme();
    else if (k === '/') { e.preventDefault(); route('doctors'); $('#dr-search').focus(); }
  });
}

/* ================= boot ================= */
async function boot() {
  const gate = initGate({ onSuccess: start });

  // GoTrue email links land here as #confirmation_token=… etc.
  const straightIn = await gate.handleHashToken();

  const user = straightIn ? auth.user : await auth.currentUser();

  $('#boot').classList.add('is-done');
  setTimeout(() => { $('#boot').hidden = true; }, 320);

  if (user) { gate.hide(); start(user); return; }

  if (!auth.enabled) {
    // Identity isn't switched on for this site yet. Say so plainly rather
    // than showing a login box that cannot possibly work.
    gate.show();
    gate.setAlert('warn',
      'خدمة تسجيل الدخول (Netlify Identity) غير مفعّلة على هذا الموقع بعد. فعّلها من لوحة Netlify ثم أعد تحميل الصفحة.');
    return;
  }
  gate.show();
}

function start(user) {
  $('#gate').hidden = true;
  $('#app').classList.add('is-on');

  /* identity chip */
  const name = auth.name;
  $('#me-name').textContent = name;
  const roleLabel = { admin: 'مدير', editor: 'محرّر', viewer: 'مشاهد' }[auth.role];
  $('#me-role').textContent = `${roleLabel} · ${auth.user?.email || ''}`;
  $('#me-avatar').replaceWith(Object.assign(avatar(name), { id: 'me-avatar' }));

  /* ui modules (must exist before any store event can fire) */
  sheet = initSheet({
    onSaved: (d, n) => { refreshAll(); },
  });
  cmdk = initCmdk({
    commands: Object.assign(() => ([
      { group: 'التنقل', icon: 'i-gauge',    label: 'نظرة عامة', hint: '1', run: () => route('overview') },
      { group: 'التنقل', icon: 'i-users',    label: 'الأطباء',    hint: '2', run: () => route('doctors') },
      { group: 'التنقل', icon: 'i-chart',    label: 'التحليلات',  hint: '3', run: () => route('analytics') },
      { group: 'التنقل', icon: 'i-activity', label: 'سجل النشاط', hint: '4', run: () => route('activity') },
      { group: 'التنقل', icon: 'i-help',     label: 'المساعدة',   hint: '5', run: () => route('help') },
      { group: 'إجراءات', icon: 'i-plus',     label: 'إدخال بيانات طبيب', hint: 'N', run: () => sheet.open(0) },
      { group: 'إجراءات', icon: 'i-download', label: 'تصدير Excel (.xlsx)', hint: 'E', run: exportExcel },
      { group: 'إجراءات', icon: 'i-print',    label: 'تصدير PDF / طباعة',   hint: 'P', run: exportPDF },
      { group: 'إجراءات', icon: 'i-shield',   label: 'فحص صحة البيانات',    hint: 'V', run: showValidationReport },
      { group: 'إجراءات', icon: 'i-moon',     label: 'تبديل المظهر', hint: 'D', run: cycleTheme },
      { group: 'الشهر',  icon: 'i-right',    label: 'الشهر السابق', run: () => goMonth(shiftMonth(store.month, -1)) },
      { group: 'الشهر',  icon: 'i-left',     label: 'الشهر التالي',  run: () => goMonth(shiftMonth(store.month, +1)) },
      { group: 'الحساب', icon: 'i-logout',   label: 'تسجيل الخروج', run: signOut },
    ]), { openDoctor: (i) => sheet.open(i) }),
  });

  /* nav */
  $$('[data-nav]').forEach(b => on(b, 'click', () => route(b.dataset.nav)));
  $$('[data-open-entry]').forEach(b => on(b, 'click', () => {
    const next = store.roster.findIndex(d => !store.isFilled(d.id));
    sheet.open(next < 0 ? 0 : next);
  }));
  on(window, 'popstate', routeFromHash);
  on(document, 'cp:open-doctor', (e) => sheet.open(e.detail));

  /* topbar */
  on($('#btn-theme'), 'click', cycleTheme);
  on($('#btn-cmdk'), 'click', () => cmdk.show());
  on($('#btn-export'), 'click', exportMenu);
  on($('#btn-print'), 'click', exportPDF);
  on($('#btn-validate'), 'click', showValidationReport);
  on($('#sync'), 'click', () => {
    if (store.mode === 'cloud' && store.status === 'live') toast('كل التغييرات محفوظة ومتزامنة مع الفريق.', { kind: 'ok' });
    else if (store.mode === 'local') toast('الوضع المحلي: البيانات على هذا الجهاز فقط. اتصل بالمدير لتفعيل المزامنة السحابية.', { kind: 'warn', ms: 6000 });
    else toast(`الحالة: ${SYNC[store.status]?.label || store.status}${store.pendingCount ? ` · ${store.pendingCount} تغيير بانتظار الرفع` : ''}`, { kind: 'info' });
  });
  on($('#userchip'), 'click', signOut);

  /* month */
  buildMonths();
  on($('#m-select'), 'change', (e) => goMonth(e.target.value));
  on($('#m-prev'), 'click', () => goMonth(shiftMonth(store.month, -1)));
  on($('#m-next'), 'click', () => {
    const next = shiftMonth(store.month, +1);
    if (next > monthKey()) { toast('لا يمكن عرض شهر في المستقبل.', { kind: 'warn' }); return; }
    goMonth(next);
  });

  bindDoctorControls({ onOpen: (i) => sheet.open(i) });
  bindKeys();

  /* keyboard help table */
  mount($('#help-keys'), KEYS.map(([k, d]) =>
    el('div', { class: 'row gap-12' },
      el('kbd', { class: 'num', style: { border: '1px solid var(--line-2)', borderRadius: '5px', padding: '2px 7px', fontSize: '11.5px', minWidth: '84px', textAlign: 'center' }, text: k }),
      el('span', { class: 'txt-sm muted', text: d }))));

  /* store events — registered BEFORE init so the first 'ready' isn't missed */
  store.on('status', () => { paintSync(); });
  store.on('queue',  () => paintSync());
  store.on('ready',  () => { refreshAll(); paintSync(); });
  store.on('roster', () => refreshAll());
  store.on('data',   () => { renderOverview(); updateStickyCta(); });
  store.on('activity', () => {
    renderFeed($('#ov-feed'), store.activity.slice(0, 6));
    if (current === 'activity') renderFeed($('#ac-feed'), store.activity);
  });
  store.on('presence', paintPresence);
  store.on('flushed', (n) => toast(`تم رفع ${n} تغيير كان بانتظار الاتصال.`, { kind: 'ok' }));
  store.on('writefail', () => toast('تعذّر الحفظ على السحابة. حُفظ محلياً وسيُرفع تلقائياً عند عودة الاتصال.', { kind: 'warn', ms: 6000 }));
  store.on('denied', ({ path }) => toast(
    path === 'roster'
      ? 'صلاحيتك لا تسمح بتعديل قائمة الأطباء. اطلب من المدير فتح اللوحة مرة واحدة.'
      : 'صلاحيتك الحالية لا تسمح بهذا التعديل. تواصل مع المدير.',
    { kind: 'warn', ms: 7000 }));
  store.on('needsSeed', () => toast(
    'قائمة الأطباء غير منشورة على السحابة بعد. تُعرض القائمة الافتراضية حتى يفتحها مدير مرة واحدة.',
    { kind: 'info', ms: 8000 }));

  /* remote edits: flash the specific cells, never rebuild the table */
  store.on('remote', (changes) => {
    const byName = store.peers[0]?.name || 'زميل';
    let n = 0;
    for (const c of changes) {
      if (c.videoIndex === undefined) { flashRemote(c.doctorId, c.field, byName); n++; }
    }
    sheet.refresh?.();
    if (n) toast(`${n} تحديث جديد من الفريق.`, { kind: 'info', ms: 2600 });
  });

  renderDoctors({ onOpen: (i) => sheet.open(i) });
  routeFromHash();
  paintSync();
  paintPresence();

  /* connect last, so every listener above is already attached */
  store.init({ me: { id: auth.id || 'local', name, role: auth.role } });
}

async function signOut() {
  if (!confirm('تسجيل الخروج من اللوحة؟')) return;
  await auth.logout();
  location.reload();
}

/* service worker — offline shell */
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

boot();
