/* ==========================================================================
   util.js — DOM construction, number parsing, Arabic text handling
   Everything here is XSS-safe by construction: nodes are built with
   createElement + textContent. There is no innerHTML anywhere in this app.
   ========================================================================== */

/* ---------- DOM ---------- */
export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * Build an element. Children may be nodes, strings (inserted as TEXT, never
 * parsed as markup), or nested arrays. Attributes starting with "on" are
 * rejected — event handlers must be attached with .on().
 */
export function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (/^on/i.test(k)) throw new Error(`inline handler "${k}" not allowed`);
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = String(v);
    else if (k === 'html') throw new Error('raw html not allowed');
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  add(node, kids);
  return node;
}

function add(parent, kids) {
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue;
    if (Array.isArray(k)) add(parent, k);
    else if (k instanceof Node) parent.appendChild(k);
    else parent.appendChild(document.createTextNode(String(k)));
  }
}

/** <svg><use href="#id"/></svg> — the only SVG we ever inject. */
export function icon(id, size = 18, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (cls) svg.setAttribute('class', cls);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + id);
  svg.appendChild(use);
  return svg;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
export function mount(node, ...kids) { clear(node); add(node, kids); return node; }
export const on = (node, ev, fn, opt) => { node.addEventListener(ev, fn, opt); return () => node.removeEventListener(ev, fn, opt); };

/* ---------- numbers ---------- */
const AR_INDIC = '٠-٩';   // ٠١٢٣٤٥٦٧٨٩
const EA_INDIC = '۰-۹';   // ۰۱۲۳۴۵۶۷۸۹

/** Convert any Arabic-Indic / Eastern Arabic-Indic digits to ASCII. */
export function toLatinDigits(str) {
  return String(str).replace(new RegExp(`[${AR_INDIC}${EA_INDIC}]`, 'g'), (d) => {
    const c = d.codePointAt(0);
    return String(c >= 0x06F0 ? c - 0x06F0 : c - 0x0660);
  });
}

/**
 * Parse a human-typed number. Accepts Arabic-Indic digits, thousands
 * separators (، , ٬ space), and a leading +/-.
 * Returns { ok, value } — never silently coerces bad input to 0, which was
 * the single most damaging bug in the previous build.
 */
export function parseNum(raw, { min = 0, max = 1e12, integer = true } = {}) {
  const s = toLatinDigits(raw ?? '')
    .replace(/[٬،,\s_']/g, '')   // ٬ ، , space _ '
    .replace(/[٫]/g, '.')             // Arabic decimal separator
    .trim();
  if (s === '') return { ok: true, value: 0 };
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return { ok: false, error: 'أدخل رقماً صحيحاً' };
  let n = Number(s);
  if (!Number.isFinite(n)) return { ok: false, error: 'أدخل رقماً صحيحاً' };
  if (integer) n = Math.round(n);
  if (n < min) return { ok: false, error: `لا يقل عن ${min}` };
  if (n > max) return { ok: false, error: 'الرقم كبير بشكل غير منطقي' };
  return { ok: true, value: n };
}

const NF = new Intl.NumberFormat('en-US');
/** One formatter for the whole app — the previous build mixed two numeral
 *  systems on the same screen. Western digits are used everywhere because
 *  they round-trip cleanly through the number inputs. */
export const fmt = (n) => NF.format(Number(n) || 0);

export function fmtCompact(n) {
  n = Number(n) || 0;
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1) + 'M';
  if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(0) + 'K';
  return NF.format(n);
}

export function pct(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 100);
}

/** Engagement rate = (likes + comments) / views */
export function engagementRate(likes, comments, views) {
  if (!views) return null;
  return ((Number(likes) + Number(comments)) / Number(views)) * 100;
}

/* ---------- Arabic text ---------- */
/** Fold alef/teh-marbuta/alef-maqsura variants and strip diacritics so that
 *  searching "احمد" finds "أحمد" and "طيبه" finds "طيبة". */
export function normalizeAr(str) {
  return toLatinDigits(str ?? '')
    .replace(/[ً-ْٰـ]/g, '')   // harakat + tatweel
    .replace(/[آأإٱ]/g, 'ا') // آأإٱ -> ا
    .replace(/ة/g, 'ه')                   // ة -> ه
    .replace(/ى/g, 'ي')                   // ى -> ي
    .replace(/[ؤ]/g, 'و')                 // ؤ -> و
    .replace(/[ئ]/g, 'ي')                 // ئ -> ي
    .toLowerCase()
    .trim();
}

export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  // Arabic names commonly start with "دكتور/دكتورة" — skip the honorific
  const useful = parts.filter(p => !/^(د|دكتور|دكتوره|دكتورة|dr\.?)$/i.test(p));
  const src = useful.length ? useful : parts;
  return (src[0]?.[0] || '؟') + (src[1]?.[0] || '');
}

/** Stable hue per name so avatars are consistent across devices. */
export function hueFor(str) {
  let h = 0;
  for (let i = 0; i < String(str).length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % 360;
}

/* ---------- dates ---------- */
const AR_MONTHS = ['كانون الثاني','شباط','آذار','نيسان','أيار','حزيران',
                   'تموز','آب','أيلول','تشرين الأول','تشرين الثاني','كانون الأول'];
const AR_MONTHS_ALT = ['يناير','فبراير','مارس','أبريل','مايو','يونيو',
                       'يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];

export function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
export function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return `${AR_MONTHS[m - 1]} (${AR_MONTHS_ALT[m - 1]}) ${y}`;
}
export function monthShort(key) {
  const [y, m] = key.split('-').map(Number);
  return `${AR_MONTHS_ALT[m - 1]} ${y}`;
}
export function shiftMonth(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return monthKey(d);
}
/** Recent months, newest first — the report is monthly, not stuck on one date. */
export function recentMonths(count = 18, from = new Date()) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(from.getFullYear(), from.getMonth() - i, 1);
    out.push(monthKey(d));
  }
  return out;
}

const RTF = new Intl.RelativeTimeFormat('ar', { numeric: 'auto' });
export function timeAgo(ts) {
  const diff = (Number(ts) - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60)    return RTF.format(Math.round(diff), 'second');
  if (abs < 3600)  return RTF.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return RTF.format(Math.round(diff / 3600), 'hour');
  if (abs < 2592000) return RTF.format(Math.round(diff / 86400), 'day');
  return new Date(Number(ts)).toLocaleDateString('ar-IQ', { day: 'numeric', month: 'short' });
}

/* ---------- misc ---------- */
export function debounce(fn, ms = 250) {
  let t;
  const wrapped = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  wrapped.cancel = () => clearTimeout(t);
  wrapped.flush = (...a) => { clearTimeout(t); fn(...a); };
  return wrapped;
}

export function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2));
}

/** Escape one CSV field: double the quotes, and defuse formula injection so a
 *  crafted name can't execute when the export is opened in Excel. */
export function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

export function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** localStorage that never throws (private mode, blocked storage, quota). */
export const safeStore = {
  get(k, fallback = null) {
    try { const v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Focus trap for dialogs. Returns a release function. */
export function trapFocus(container, { onEscape } = {}) {
  const SEL = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  const prev = document.activeElement;
  const key = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onEscape?.(); return; }
    if (e.key !== 'Tab') return;
    const items = [...container.querySelectorAll(SEL)].filter(n => n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', key, true);
  return () => {
    document.removeEventListener('keydown', key, true);
    if (prev && prev.isConnected) prev.focus();
  };
}
