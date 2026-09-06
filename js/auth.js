/* ==========================================================================
   auth.js — Netlify Identity (GoTrue) client + the sign-in gate
   Talks to the GoTrue REST API directly rather than loading the third-party
   widget: no extra script on the critical path, and total control of the UI.
   Passwords are never stored — only the short-lived access token and its
   refresh token, and both live in localStorage keyed to this origin.
   ========================================================================== */

import { $, el, icon, mount, clear, on, safeStore, sleep } from './util.js';

const API = '/.netlify/identity';
const TOK = 'cp.session';
const THROTTLE = 'cp.loginThrottle';

/* ---------- low-level API ---------- */
async function req(path, { method = 'GET', body, form, token, timeout = 15000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  const headers = {};
  let payload;
  if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
  else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  if (token) headers['Authorization'] = 'Bearer ' + token;

  let res;
  try {
    res = await fetch(API + path, { method, headers, body: payload, signal: ctrl.signal });
  } catch (e) {
    clearTimeout(t);
    throw Object.assign(new Error('network'), { kind: 'network' });
  }
  clearTimeout(t);

  // Identity not enabled on this site → 404 HTML, not JSON
  if (res.status === 404) throw Object.assign(new Error('identity-off'), { kind: 'identity-off' });

  let data = null;
  const txt = await res.text();
  try { data = txt ? JSON.parse(txt) : null; } catch { data = null; }

  if (!res.ok) {
    const msg = data?.error_description || data?.msg || data?.error || `HTTP ${res.status}`;
    throw Object.assign(new Error(msg), { kind: 'api', status: res.status, data });
  }
  return data;
}

/* ---------- session storage ---------- */
function saveSession(tok) {
  if (!tok) return safeStore.del(TOK);
  safeStore.set(TOK, {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: Date.now() + (Number(tok.expires_in || 3600) * 1000) - 60_000, // 60s safety margin
  });
}
const loadSession = () => safeStore.get(TOK);

/* ---------- login throttling (client-side brake on credential stuffing) --- */
function throttleState() {
  const s = safeStore.get(THROTTLE, { fails: 0, until: 0 });
  return s && typeof s === 'object' ? s : { fails: 0, until: 0 };
}
function throttleCheck() {
  const s = throttleState();
  const left = s.until - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}
function throttleFail() {
  const s = throttleState();
  s.fails = (s.fails || 0) + 1;
  if (s.fails >= 4) s.until = Date.now() + Math.min(2 ** (s.fails - 3), 32) * 15_000;
  safeStore.set(THROTTLE, s);
}
const throttleReset = () => safeStore.del(THROTTLE);

/* ---------- public auth object ---------- */
export const auth = {
  user: null,
  enabled: true,

  get token() { return loadSession()?.access_token || null; },
  get roles() { return this.user?.app_metadata?.roles || []; },
  get name() { return this.user?.user_metadata?.full_name || this.user?.email?.split('@')[0] || 'مستخدم'; },
  get id() { return this.user?.id || null; },

  /** admin > editor > viewer. No role at all still reads — a signed-in
   *  colleague should never hit a blank screen because nobody set roles yet. */
  get role() {
    const r = this.roles.map(String);
    if (r.includes('admin')) return 'admin';
    if (r.includes('viewer')) return 'viewer';
    return 'editor';
  },
  can(action) {
    const role = this.role;
    if (role === 'admin') return true;
    if (role === 'editor') return action !== 'manage';
    return false; // viewer
  },

  async currentUser() {
    const s = loadSession();
    if (!s?.access_token) return null;
    if (Date.now() > (s.expires_at || 0)) {
      if (!s.refresh_token) { saveSession(null); return null; }
      try {
        const tok = await req('/token', { method: 'POST', form: { grant_type: 'refresh_token', refresh_token: s.refresh_token } });
        saveSession(tok);
      } catch (e) {
        if (e.kind === 'identity-off') { this.enabled = false; return null; }
        saveSession(null); return null;
      }
    }
    try {
      this.user = await req('/user', { token: this.token });
      return this.user;
    } catch (e) {
      if (e.kind === 'identity-off') { this.enabled = false; return null; }
      if (e.kind === 'network') return null;   // offline: don't nuke the session
      saveSession(null); return null;
    }
  },

  async login(email, password) {
    const wait = throttleCheck();
    if (wait) throw Object.assign(new Error(`محاولات كثيرة. انتظر ${wait} ثانية.`), { kind: 'throttled' });
    try {
      const tok = await req('/token', { method: 'POST', form: { grant_type: 'password', username: email, password } });
      saveSession(tok);
      throttleReset();
      this.user = await req('/user', { token: tok.access_token });
      return this.user;
    } catch (e) {
      if (e.kind === 'api') throttleFail();
      throw e;
    }
  },

  async signup(email, password, fullName) {
    return req('/signup', { method: 'POST', body: { email, password, data: { full_name: fullName } } });
  },

  async recover(email) { return req('/recover', { method: 'POST', body: { email } }); },

  async verify(type, token) {
    const tok = await req('/verify', { method: 'POST', body: { type, token } });
    saveSession(tok);
    this.user = await req('/user', { token: tok.access_token });
    return this.user;
  },

  async updatePassword(password) {
    return req('/user', { method: 'PUT', token: this.token, body: { password } });
  },

  async logout() {
    const t = this.token;
    saveSession(null);
    this.user = null;
    if (t) { try { await req('/logout', { method: 'POST', token: t }); } catch {} }
  },
};

/* ==========================================================================
   Gate UI
   ========================================================================== */
const MSG = {
  'Invalid login credentials': 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
  'Email not confirmed': 'لم يتم تأكيد البريد بعد. افتح رسالة التأكيد في بريدك.',
  'User already registered': 'هذا البريد مسجّل مسبقاً. سجّل الدخول بدلاً من إنشاء حساب.',
  'Signups not allowed for this instance': 'التسجيل الذاتي مغلق. اطلب من المدير دعوتك.',
  'network': 'تعذّر الاتصال بالخادم. تحقّق من الإنترنت وحاول مجدداً.',
  'identity-off': 'خدمة تسجيل الدخول غير مفعّلة على هذا الموقع بعد.',
};
const humanize = (e) => MSG[e.kind] || MSG[e.message] || e.message || 'حدث خطأ غير متوقع.';

let mode = 'login'; // login | signup | recover | reset

export function initGate({ onSuccess }) {
  const gate    = $('#gate');
  const form    = $('#gate-form');
  const title   = $('#gate-title');
  const lede    = $('#gate-lede');
  const alertEl = $('#gate-alert');
  const submit  = $('#gate-submit');
  const altEl   = $('#gate-alt');
  const forgot  = $('#gate-forgot');
  const fName   = $('#f-name');
  const fPass   = $('#f-pass');
  const passHint= $('#pass-hint');
  const inEmail = $('#in-email');
  const inPass  = $('#in-pass');
  const inName  = $('#in-name');
  const inTrap  = $('#in-company');

  const COPY = {
    login:   { t: 'تسجيل الدخول', l: 'هذه اللوحة مخصّصة لفريق القسم الإعلامي في عيادات كلير. سجّل الدخول بحسابك للمتابعة.', b: 'تسجيل الدخول' },
    signup:  { t: 'إنشاء حساب',   l: 'أنشئ حساباً بالبريد الرسمي للعيادة. سيصلك بريد لتأكيد الحساب قبل أول دخول.', b: 'إنشاء الحساب' },
    recover: { t: 'استعادة كلمة المرور', l: 'أدخل بريدك وسنرسل لك رابطاً لإعادة تعيين كلمة المرور.', b: 'إرسال الرابط' },
    reset:   { t: 'تعيين كلمة مرور جديدة', l: 'اختر كلمة مرور جديدة لحسابك.', b: 'حفظ كلمة المرور' },
  };

  function setAlert(kind, text) {
    if (!text) { alertEl.hidden = true; clear(alertEl); return; }
    alertEl.hidden = false;
    alertEl.className = 'alert alert-' + kind;
    mount(alertEl, icon(kind === 'ok' ? 'i-check' : 'i-alert', 18), el('div', { text }));
  }

  function setMode(m, keepAlert) {
    mode = m;
    const c = COPY[m];
    title.textContent = c.t;
    lede.textContent = c.l;
    mount(submit, el('span', { text: c.b }));
    fName.hidden = m !== 'signup';
    fPass.hidden = m === 'recover';
    passHint.hidden = !(m === 'signup' || m === 'reset');
    $('#f-email').hidden = m === 'reset';
    inPass.autocomplete = (m === 'signup' || m === 'reset') ? 'new-password' : 'current-password';
    forgot.hidden = m !== 'login';
    if (!keepAlert) setAlert(null);

    clear(altEl);
    if (m === 'login') {
      altEl.append(document.createTextNode('ليس لديك حساب؟ '));
      const b = el('button', { type: 'button', text: 'أنشئ واحداً' });
      on(b, 'click', () => setMode('signup'));
      altEl.append(b);
    } else if (m === 'signup' || m === 'recover') {
      altEl.append(document.createTextNode('لديك حساب بالفعل؟ '));
      const b = el('button', { type: 'button', text: 'سجّل الدخول' });
      on(b, 'click', () => setMode('login'));
      altEl.append(b);
    }
    (m === 'reset' ? inPass : inEmail).focus?.();
  }

  function fieldError(field, msg) {
    const wrap = field.closest('.field');
    wrap.classList.toggle('has-err', !!msg);
    wrap.querySelector('.err').textContent = msg || '';
  }

  function busy(is) {
    submit.disabled = is;
    if (is) {
      const sp = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      sp.setAttribute('width', 17); sp.setAttribute('height', 17);
      sp.setAttribute('class', 'mark is-spinning');
      const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      u.setAttribute('href', '#mark'); sp.appendChild(u);
      mount(submit, sp, el('span', { text: 'لحظة…' }));
    } else {
      mount(submit, el('span', { text: COPY[mode].b }));
    }
  }

  on(forgot, 'click', () => setMode('recover'));

  on(form, 'submit', async (e) => {
    e.preventDefault();
    fieldError(inEmail, ''); fieldError(inPass, ''); fieldError(inName, '');

    // honeypot — a real person never fills a field they cannot see
    if (inTrap.value) { await sleep(700); setAlert('dang', 'تعذّر إتمام الطلب.'); return; }

    const email = inEmail.value.trim().toLowerCase();
    const pass  = inPass.value;
    const name  = inName.value.trim();

    if (mode !== 'reset') {
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { fieldError(inEmail, 'أدخل بريداً إلكترونياً صحيحاً.'); inEmail.focus(); return; }
    }
    if (mode !== 'recover') {
      if (!pass) { fieldError(inPass, 'أدخل كلمة المرور.'); inPass.focus(); return; }
      if ((mode === 'signup' || mode === 'reset') && (pass.length < 8 || !/\d/.test(pass) || !/[A-Za-z؀-ۿ]/.test(pass))) {
        fieldError(inPass, '٨ أحرف على الأقل مع رقم وحرف.'); inPass.focus(); return;
      }
    }
    if (mode === 'signup' && name.length < 2) { fieldError(inName, 'أدخل اسمك الكامل.'); inName.focus(); return; }

    busy(true);
    try {
      if (mode === 'login') {
        const u = await auth.login(email, pass);
        onSuccess(u);
      } else if (mode === 'signup') {
        const r = await auth.signup(email, pass, name);
        if (r?.confirmed_at || r?.access_token) {           // confirmation disabled → straight in
          const u = await auth.login(email, pass); onSuccess(u);
        } else {
          setMode('login', true);
          setAlert('ok', 'تم إنشاء الحساب. افتح بريدك واضغط رابط التأكيد ثم سجّل الدخول.');
        }
      } else if (mode === 'recover') {
        await auth.recover(email);
        setMode('login', true);
        setAlert('ok', 'إن كان البريد مسجّلاً فستصلك رسالة بخطوات إعادة التعيين خلال دقائق.');
      } else if (mode === 'reset') {
        await auth.updatePassword(pass);
        const u = await auth.currentUser();
        if (u) onSuccess(u); else { setMode('login', true); setAlert('ok', 'تم تحديث كلمة المرور. سجّل الدخول الآن.'); }
      }
    } catch (err) {
      setAlert('dang', humanize(err));
      if (err.kind === 'identity-off') auth.enabled = false;
    } finally {
      busy(false);
    }
  });

  /* ---- handle GoTrue's email links: #confirmation_token / #recovery_token ---- */
  async function handleHashToken() {
    const h = location.hash.replace(/^#\/?/, '');
    if (!h || !/token=|error/.test(h)) return false;
    const p = new URLSearchParams(h);
    history.replaceState(null, '', location.pathname + location.search);

    if (p.get('error_description') || p.get('error')) {
      setAlert('dang', decodeURIComponent(p.get('error_description') || p.get('error')));
      return false;
    }
    try {
      if (p.get('confirmation_token')) {
        await auth.verify('signup', p.get('confirmation_token'));
        return true;
      }
      if (p.get('invite_token')) {
        await auth.verify('invite', p.get('invite_token'));
        setMode('reset', true);
        setAlert('ok', 'مرحباً بك. اختر كلمة مرور لحسابك للمتابعة.');
        return false;
      }
      if (p.get('recovery_token')) {
        await auth.verify('recovery', p.get('recovery_token'));
        setMode('reset', true);
        setAlert('ok', 'تم التحقق. اختر كلمة مرور جديدة.');
        return false;
      }
    } catch (e) {
      setAlert('dang', humanize(e));
    }
    return false;
  }

  return {
    show(reason) {
      gate.hidden = false;
      setMode(mode === 'reset' ? 'reset' : 'login');
      if (reason) setAlert('warn', reason);
    },
    hide() { gate.hidden = true; },
    handleHashToken,
    setAlert,
  };
}
