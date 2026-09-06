/* ==========================================================================
   ui.js — toasts, the entry sheet, and the command palette
   ========================================================================== */

import { $, $$, el, icon, mount, clear, on, initials, hueFor, parseNum, fmt,
         trapFocus, normalizeAr, debounce } from './util.js';
import { store, METRICS, METRIC_META, VIDEOS_PER_DOCTOR } from './store.js';
import { validateField, validateDoctor, hasErrors } from './validate.js';

/* ================= toasts ================= */
const toastHost = () => $('#toasts');

export function toast(message, { kind = 'ok', ms = 3600, undo } = {}) {
  const host = toastHost();
  const ic = kind === 'ok' ? 'i-check' : kind === 'dang' ? 'i-alert' : kind === 'warn' ? 'i-alert' : 'i-cloud';
  const node = el('div', { class: `toast t-${kind}` }, icon(ic, 17), el('span', { text: message }));

  if (undo) {
    const b = el('button', { class: 'undo', type: 'button', text: 'تراجع' });
    on(b, 'click', () => { undo(); close(); });
    node.appendChild(b);
  }
  host.appendChild(node);

  let timer = setTimeout(close, ms);
  on(node, 'mouseenter', () => clearTimeout(timer));
  on(node, 'mouseleave', () => { timer = setTimeout(close, 1400); });

  function close() {
    clearTimeout(timer);
    node.classList.add('is-out');
    setTimeout(() => node.remove(), 240);
  }
  return close;
}

/* ================= avatar ================= */
export function avatar(name, size = '') {
  const h = hueFor(name);
  return el('span', {
    class: 'avatar ' + size,
    style: { background: `hsl(${h} 46% 46%)` },
    'aria-hidden': 'true',
    text: initials(name),
  });
}

/* ================= entry sheet ================= */
let sheetState = { index: 0, release: null, dirty: false };

export function initSheet({ onSaved }) {
  const sheet  = $('#sheet');
  const scrim  = $('#scrim');
  const body   = $('#sheet-body');
  const title  = $('#sheet-title');
  const sub    = $('#sheet-sub');
  const avaHost= $('#sheet-avatar');

  const close = () => closeSheet();

  on($('#sheet-close'), 'click', close);
  on(scrim, 'click', close);
  on($('#sheet-prev'), 'click', () => step(-1));
  on($('#sheet-next'), 'click', () => step(+1));
  on($('#sheet-save'), 'click', () => { save(); close(); });

  // drag-to-dismiss on touch
  const grab = $('#sheet-grab');
  let startY = 0, dy = 0, dragging = false;
  on(grab, 'pointerdown', (e) => { dragging = true; startY = e.clientY; sheet.style.transition = 'none'; grab.setPointerCapture(e.pointerId); });
  on(grab, 'pointermove', (e) => {
    if (!dragging) return;
    dy = Math.max(0, e.clientY - startY);
    sheet.style.transform = `translateY(${dy}px)`;
  });
  on(grab, 'pointerup', () => {
    if (!dragging) return;
    dragging = false; sheet.style.transition = ''; sheet.style.transform = '';
    if (dy > 110) close();
    dy = 0;
  });

  function step(dir) {
    save();
    const n = store.roster.length;
    if (!n) return;
    sheetState.index = (sheetState.index + dir + n) % n;
    render();
  }

  function render() {
    const d = store.roster[sheetState.index];
    if (!d) return;
    const x = store.get(d.id);
    const readOnly = !store.can('edit');

    title.textContent = d.name;
    sub.textContent = `${store.completeness(d.id)}% مكتمل · ${sheetState.index + 1} من ${store.roster.length}`;
    avaHost.replaceWith(avatar(d.name, 'avatar-lg'));
    $('#sheet-avatar')?.remove();
    const fresh = sheet.querySelector('.sheet-head .avatar');
    if (fresh) fresh.id = 'sheet-avatar';

    const metricFields = METRICS.map(k => {
      const m = METRIC_META[k];
      const input = el('input', {
        class: 'input', type: 'text', inputmode: 'numeric', id: 'e-' + k,
        value: x[k] || 0, dir: 'ltr', disabled: readOnly || null,
        'data-metric': k, autocomplete: 'off',
      });
      const errEl = el('div', { class: 'err' });
      const field = el('div', { class: 'field' },
        el('label', { for: 'e-' + k }, icon(m.icon, 13), ' ', m.label), input, errEl);
      on(input, 'input', () => check(input, field, errEl, k, false));
      on(input, 'blur',  () => check(input, field, errEl, k, false));
      return field;
    });

    const videoBoxes = Array.from({ length: VIDEOS_PER_DOCTOR }, (_, i) => {
      const v = x.videos[i];
      const mk = (f, label, opts = {}) => {
        const input = el('input', {
          class: 'input', id: `e-v${i}-${f}`, type: 'text',
          inputmode: opts.numeric ? 'numeric' : null,
          dir: opts.numeric ? 'ltr' : null,
          value: v[f] ?? (opts.numeric ? 0 : ''),
          placeholder: opts.ph || '', disabled: readOnly || null,
          'data-video': i, 'data-vfield': f, autocomplete: 'off', maxlength: opts.numeric ? 12 : 160,
        });
        const errEl = el('div', { class: 'err' });
        const field = el('div', { class: 'field' }, el('label', { for: `e-v${i}-${f}`, text: label }), input, errEl);
        on(input, 'input', () => check(input, field, errEl, f, true));
        on(input, 'blur',  () => check(input, field, errEl, f, true));
        return field;
      };
      return el('div', { class: 'vidbox' },
        el('div', { class: 'h' },
          el('b', { text: `الفيديو رقم ${i + 1}` }),
          el('span', { class: 'pill pill-neu', text: v.views ? fmt(v.views) + ' مشاهدة' : 'فارغ' })),
        mk('title', 'اسم / وصف الفيديو', { ph: 'مثال: نصائح تبييض الأسنان' }),
        el('div', { class: 'grid2' },
          mk('date', 'تاريخ النشر', { ph: '١٥ تموز' }),
          mk('views', 'المشاهدات', { numeric: true })),
        el('div', { class: 'grid2' },
          mk('likes', 'الإعجابات', { numeric: true }),
          mk('comments', 'التعليقات', { numeric: true })),
      );
    });

    mount(body,
      readOnly ? el('div', { class: 'alert alert-info' }, icon('i-lock', 17),
        el('div', { text: 'صلاحيتك للاطّلاع فقط. تواصل مع المدير للحصول على صلاحية التعديل.' })) : null,
      el('div', { id: 'sheet-issues', class: 'stack gap-8' }),
      el('div', { class: 'formsec' },
        el('h4', { text: 'إحصائيات الحساب' }),
        el('div', { class: 'grid3' }, metricFields)),
      el('div', { class: 'formsec' },
        el('h4', { text: 'أفضل ٣ فيديوهات تفاعلاً' }),
        el('div', { class: 'stack gap-12' }, videoBoxes)),
      el('p', { class: 'txt-xs muted', text: 'يُحفظ كل حقل على حدة فور الحفظ، فلا يمكن لتعديلك أن يمحو تعديل زميلك.' }),
    );

    on(body, 'input', () => refreshIssues());
    refreshIssues();
    const first = body.querySelector('input:not([disabled])');
    setTimeout(() => first?.focus(), 60);
  }

  function check(input, field, errEl, name, isVideo) {
    const r = validateField(name, input.value, { video: isVideo });
    field.classList.toggle('has-err', !r.ok);
    errEl.textContent = r.ok ? '' : r.error;
    return r;
  }

  /** Re-run the cross-field checks and paint the panel above the form. */
  function refreshIssues() {
    const d = store.roster[sheetState.index];
    if (!d) return [];
    // read the live form values, not the stored ones, so the panel reacts as you type
    const draft = JSON.parse(JSON.stringify(store.get(d.id)));
    $$('input[data-metric]', body).forEach(inp => {
      const r = validateField(inp.dataset.metric, inp.value);
      if (r.ok) draft[inp.dataset.metric] = r.value;
    });
    $$('input[data-vfield]', body).forEach(inp => {
      const i = Number(inp.dataset.video), f = inp.dataset.vfield;
      const r = validateField(f, inp.value, { video: true });
      if (r.ok) draft.videos[i][f] = r.value;
    });

    const issues = validateDoctor(draft, d.name);
    const host = $('#sheet-issues', body);
    if (!host) return issues;
    const errors = issues.filter(i => i.level === 'error');
    const warns  = issues.filter(i => i.level === 'warn');
    clear(host);
    if (errors.length) host.appendChild(issueBox('error', 'قيم غير منطقية — لن تُحفظ', errors));
    if (warns.length)  host.appendChild(issueBox('warn',  'تنبيهات للمراجعة', warns));
    const save = $('#sheet-save');
    save.disabled = errors.length > 0;
    save.title = errors.length ? 'صحّح القيم غير المنطقية أولاً' : '';
    return issues;
  }

  function issueBox(level, title, list) {
    return el('div', { class: 'issue-box lvl-' + level },
      el('b', {}, icon(level === 'error' ? 'i-alert' : 'i-help', 15), el('span', { text: title })),
      el('ul', {}, list.map(i => el('li', { text: i.message }))));
  }

  function save() {
    const d = store.roster[sheetState.index];
    if (!d || !store.can('edit')) return 0;
    let n = 0, bad = 0;

    const issues = refreshIssues();
    if (hasErrors(issues)) {
      toast('لم يُحفظ: راجع القيم غير المنطقية المعروضة أعلى النموذج.', { kind: 'dang', ms: 5000 });
      return 0;
    }

    $$('input[data-metric]', body).forEach(inp => {
      const r = validateField(inp.dataset.metric, inp.value);
      if (!r.ok) { bad++; return; }
      if (store.setMetric(d.id, inp.dataset.metric, r.value)) n++;
    });

    $$('input[data-vfield]', body).forEach(inp => {
      const i = Number(inp.dataset.video), f = inp.dataset.vfield;
      const r = validateField(f, inp.value, { video: true });
      if (!r.ok) { bad++; return; }
      if (store.setVideo(d.id, i, f, r.value)) n++;
    });

    if (bad) toast(`${bad} حقل يحتوي قيمة غير صالحة ولم يُحفظ.`, { kind: 'warn' });
    if (n) onSaved?.(d, n);
    return n;
  }

  function openSheet(index = 0) {
    sheetState.index = Math.max(0, Math.min(index, store.roster.length - 1));
    sheet.hidden = false; scrim.hidden = false;
    requestAnimationFrame(() => { sheet.classList.add('is-on'); scrim.classList.add('is-on'); });
    render();
    sheetState.release = trapFocus(sheet, { onEscape: closeSheet });
    document.body.style.overflow = 'hidden';
  }

  function closeSheet() {
    const saved = save();
    if (saved) toast(`تم حفظ ${saved} حقل ومزامنته.`, { kind: 'ok' });
    sheet.classList.remove('is-on'); scrim.classList.remove('is-on');
    sheetState.release?.(); sheetState.release = null;
    document.body.style.overflow = '';
    setTimeout(() => { sheet.hidden = true; scrim.hidden = true; }, 340);
  }

  return { open: openSheet, close: closeSheet, refresh: () => { if (!sheet.hidden) render(); } };
}

/* ================= command palette ================= */
export function initCmdk({ commands }) {
  const root = $('#cmdk-root');
  let open = false, release = null, items = [], sel = 0;

  function build(list, query) {
    const box = el('div', { class: 'cmdk-box', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'لوحة الأوامر' });
    const input = el('input', { type: 'text', placeholder: 'ابحث عن طبيب أو أمر…', value: query, 'aria-label': 'بحث' });
    box.appendChild(el('div', { class: 'cmdk-in' }, icon('i-search', 17), input, el('kbd', { text: 'ESC' })));

    const listEl = el('div', { class: 'cmdk-list', role: 'listbox' });
    if (!list.length) {
      listEl.appendChild(el('div', { class: 'cmdk-empty', text: 'لا نتائج مطابقة.' }));
    } else {
      let lastGroup = null;
      list.forEach((it, i) => {
        if (it.group !== lastGroup) { listEl.appendChild(el('div', { class: 'cmdk-group', text: it.group })); lastGroup = it.group; }
        const b = el('button', { class: 'cmdk-item', type: 'button', role: 'option', 'aria-selected': i === sel ? 'true' : 'false' },
          icon(it.icon || 'i-right', 17), el('span', { text: it.label }),
          it.hint ? el('span', { class: 'k', text: it.hint }) : null);
        on(b, 'click', () => { close(); it.run(); });
        on(b, 'mousemove', () => { sel = i; sync(listEl); });
        listEl.appendChild(b);
      });
    }
    box.appendChild(listEl);
    return { box, input, listEl };
  }

  function sync(listEl) {
    $$('.cmdk-item', listEl).forEach((n, i) => n.setAttribute('aria-selected', i === sel ? 'true' : 'false'));
    $$('.cmdk-item', listEl)[sel]?.scrollIntoView({ block: 'nearest' });
  }

  function collect(q) {
    const nq = normalizeAr(q);
    const all = [
      ...commands().map(c => ({ ...c, group: c.group || 'أوامر' })),
      ...store.roster.map((d, i) => ({
        group: 'الأطباء', icon: 'i-users', label: d.name,
        hint: store.isFilled(d.id) ? 'مكتمل' : 'بانتظار الإدخال',
        run: () => commands.openDoctor?.(i),
      })),
    ];
    if (!nq) return all.slice(0, 40);
    return all.filter(it => normalizeAr(it.label).includes(nq)).slice(0, 40);
  }

  function show(query = '') {
    if (open) return;
    open = true; sel = 0;
    items = collect(query);
    const { box, input, listEl } = build(items, query);
    const overlay = el('div', { class: 'cmdk' }, box);
    on(overlay, 'mousedown', (e) => { if (e.target === overlay) close(); });
    mount(root, overlay);

    const rerender = debounce(() => {
      sel = 0; items = collect(input.value);
      const rebuilt = build(items, input.value);
      box.replaceWith(rebuilt.box);
      wire(rebuilt);
    }, 90);

    function wire(parts) {
      on(parts.input, 'input', rerender);
      on(parts.input, 'keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); sync(parts.listEl); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); sync(parts.listEl); }
        else if (e.key === 'Enter') { e.preventDefault(); const it = items[sel]; if (it) { close(); it.run(); } }
      });
      parts.input.focus();
      parts.input.setSelectionRange(parts.input.value.length, parts.input.value.length);
    }
    wire({ input, listEl });
    release = trapFocus(overlay, { onEscape: close });
  }

  function close() {
    if (!open) return;
    open = false; release?.(); release = null; clear(root);
  }

  return { show, close, get isOpen() { return open; } };
}
