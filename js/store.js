/* ==========================================================================
   store.js — data layer
   Design rules, all of them learned from auditing the previous build:
     1. Writes are scoped to a single field path. Never the whole dataset,
        so two people editing different doctors can never clobber each other.
     2. Incoming snapshots are DIFFED. We emit per-field change events so the
        view can flash one cell instead of rebuilding the table under
        somebody's cursor.
     3. The UI is told the truth. status is one of connecting/live/saving/
        local/offline and it always reflects reality, never an assumption.
     4. If the cloud is not configured or not reachable, everything still
        works against localStorage — and says so.
   ========================================================================== */

import { safeStore, uid, monthKey } from './util.js';

export const METRICS = ['posts', 'reels', 'followers', 'shares', 'views'];
export const VIDEO_FIELDS = ['title', 'date', 'views', 'likes', 'comments'];
export const VIDEOS_PER_DOCTOR = 3;

export const METRIC_META = {
  posts:     { label: 'بوستات',       icon: 'i-image',  short: 'بوستات' },
  reels:     { label: 'ريلز',          icon: 'i-film',   short: 'ريلز' },
  followers: { label: 'نمو المتابعين', icon: 'i-follow', short: 'متابعون' },
  shares:    { label: 'مشاركات',       icon: 'i-share',  short: 'مشاركات' },
  views:     { label: 'المشاهدات',     icon: 'i-eye',    short: 'مشاهدات' },
};

const SEED_ROSTER = [
  'دكتور زيد', 'دكتور علي كريم', 'دكتور كرار', 'دكتورة طيبة', 'دكتورة شاهي',
  'دكتور عبدالله', 'دكتور احمد مازن', 'دكتور احمد العلي', 'دكتورة مروة',
  'دكتور حسام', 'دكتور حسين سلامة', 'دكتور محمد خليل', 'دكتور مضر', 'دكتور مازن القزازي',
].map((name, i) => ({ id: 'd' + String(i + 1).padStart(2, '0'), name, handle: '', order: i, active: true }));

const LS_ROSTER = 'cp.roster';
const LS_MONTH  = (m) => 'cp.month.' + m;
const LS_QUEUE  = 'cp.queue';
const LS_ACT    = (m) => 'cp.activity.' + m;

const blankDoctor = () => ({
  posts: 0, reels: 0, followers: 0, shares: 0, views: 0,
  videos: Array.from({ length: VIDEOS_PER_DOCTOR },
    () => ({ title: '', date: '', views: 0, likes: 0, comments: 0 })),
});

/* ---------- tiny event bus ---------- */
function bus() {
  const map = new Map();
  return {
    on(ev, fn) { (map.get(ev) || map.set(ev, new Set()).get(ev)).add(fn); return () => map.get(ev)?.delete(fn); },
    emit(ev, payload) { map.get(ev)?.forEach(fn => { try { fn(payload); } catch (e) { console.error(e); } }); },
  };
}

export const store = {
  ...bus(),

  month: monthKey(),
  roster: [],
  data: {},          // { [doctorId]: {posts,...,videos:[]} }
  activity: [],
  peers: [],
  status: 'connecting',
  mode: 'local',     // 'cloud' | 'local'
  me: { id: 'local', name: 'أنا', role: 'editor' },

  /** Permission check, mirrored from the signed-in Identity role so the views
   *  never need to know about the auth module. Enforced for real by the
   *  database rules — this only decides what the UI offers. */
  can(action) {
    const role = this.me.role || 'editor';
    if (role === 'admin') return true;
    if (role === 'editor') return action !== 'manage';
    return false;
  },

  _db: null, _fb: null, _refs: [], _presenceRef: null,
  _queue: safeStore.get(LS_QUEUE, []) || [],
  _muted: new Set(),   // paths this device wrote — suppress our own echo

  /* ================= lifecycle ================= */
  async init({ me }) {
    this.me = me;
    this.roster = safeStore.get(LS_ROSTER, null) || SEED_ROSTER.slice();
    this._loadMonthLocal(this.month);
    this._setStatus('connecting');
    this.emit('ready');

    try {
      const cfg = await this._fetchSession();
      if (!cfg?.firebase?.databaseURL) throw new Error('no-config');
      await this._connect(cfg);
    } catch (e) {
      console.info('[store] cloud unavailable —', e.message, '· running in local mode');
      this.mode = 'local';
      this._setStatus('local');
    }

    addEventListener('online',  () => { if (this.mode === 'cloud') this._flush(); else this._setStatus('local'); });
    addEventListener('offline', () => this._setStatus('offline'));
  },

  async _fetchSession() {
    const { auth } = await import('./auth.js');
    const res = await fetch('/.netlify/functions/session', {
      method: 'POST',
      headers: auth.token ? { Authorization: 'Bearer ' + auth.token } : {},
    });
    if (!res.ok) throw new Error('session ' + res.status);
    return res.json();
  },

  async _connect(cfg) {
    const [{ initializeApp }, dbMod, authMod] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js'),
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js'),
    ]);
    this._fb = dbMod;
    const app = initializeApp(cfg.firebase);

    // Sign in to Firebase with a custom token minted server-side from the
    // verified Netlify Identity user, so database rules can enforce identity.
    if (cfg.token) {
      const a = authMod.getAuth(app);
      const cred = await authMod.signInWithCustomToken(a, cfg.token);
      this.me.id = cred.user.uid;
    }

    this._db = dbMod.getDatabase(app);
    this.mode = 'cloud';

    // real connection state, straight from the SDK — not an assumption
    dbMod.onValue(dbMod.ref(this._db, '.info/connected'), (snap) => {
      if (snap.val() === true) { this._setStatus('live'); this._flush(); this._announce(); }
      else this._setStatus(navigator.onLine ? 'connecting' : 'offline');
    });

    this._watchRoster();
    this._watchMonth(this.month);
    this._watchPresence();
  },

  _setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);
  },

  /* ================= watchers ================= */
  _detach() { this._refs.forEach(off => { try { off(); } catch {} }); this._refs = []; },

  _watchRoster() {
    const { ref, onValue } = this._fb;
    this._refs.push(onValue(ref(this._db, 'roster'), (snap) => {
      const val = snap.val();
      if (val && typeof val === 'object') {
        this.roster = Object.entries(val)
          .map(([id, d]) => ({ id, name: d.name || '', handle: d.handle || '', order: d.order ?? 0, active: d.active !== false }))
          .filter(d => d.active)
          .sort((a, b) => a.order - b.order);
      } else {
        // first run on an empty database — seed it once
        const seed = {};
        SEED_ROSTER.forEach(d => { seed[d.id] = { name: d.name, handle: '', order: d.order, active: true }; });
        this._write('roster', seed);
        this.roster = SEED_ROSTER.slice();
      }
      safeStore.set(LS_ROSTER, this.roster);
      this.emit('roster');
    }));
  },

  _watchMonth(m) {
    const { ref, onValue } = this._fb;
    this._refs.push(onValue(ref(this._db, `months/${m}`), (snap) => {
      this._applyRemote(snap.val() || {});
    }));
    this._refs.push(onValue(
      this._fb.query(ref(this._db, `activity/${m}`), this._fb.limitToLast(60)),
      (snap) => {
        const v = snap.val() || {};
        this.activity = Object.entries(v).map(([k, a]) => ({ key: k, ...a })).sort((a, b) => b.at - a.at);
        safeStore.set(LS_ACT(m), this.activity.slice(0, 60));
        this.emit('activity');
      }));
  },

  /** Diff the incoming snapshot against local state and emit only what
   *  actually changed, field by field. This is what lets the table update
   *  live without destroying an edit in progress. */
  _applyRemote(remote) {
    const changes = [];
    for (const d of this.roster) {
      const r = remote[d.id] || {};
      const cur = this.data[d.id] || (this.data[d.id] = blankDoctor());
      for (const k of METRICS) {
        const rv = Number(r[k] || 0);
        if (rv !== Number(cur[k] || 0)) {
          const path = `${d.id}.${k}`;
          const mine = this._muted.has(path);
          cur[k] = rv;
          if (!mine) changes.push({ doctorId: d.id, field: k, value: rv });
          this._muted.delete(path);
        }
      }
      const rv = r.videos || {};
      for (let i = 0; i < VIDEOS_PER_DOCTOR; i++) {
        const rvi = rv[i] || {};
        for (const f of VIDEO_FIELDS) {
          const nv = f === 'title' || f === 'date' ? String(rvi[f] ?? '') : Number(rvi[f] || 0);
          if (nv !== cur.videos[i][f]) {
            const path = `${d.id}.v${i}.${f}`;
            const mine = this._muted.has(path);
            cur.videos[i][f] = nv;
            if (!mine) changes.push({ doctorId: d.id, videoIndex: i, field: f, value: nv });
            this._muted.delete(path);
          }
        }
      }
    }
    this._persistMonth();
    this.emit('data');
    if (changes.length) this.emit('remote', changes);
  },

  _watchPresence() {
    const { ref, onValue, onDisconnect, set, serverTimestamp } = this._fb;
    this._presenceRef = ref(this._db, `presence/${this.me.id}`);
    onDisconnect(this._presenceRef).remove();
    this._announce();
    this._refs.push(onValue(ref(this._db, 'presence'), (snap) => {
      const v = snap.val() || {};
      const cutoff = Date.now() - 90_000;
      this.peers = Object.entries(v)
        .map(([id, p]) => ({ id, name: p.name || 'زميل', at: p.at || 0 }))
        .filter(p => p.id !== this.me.id && p.at > cutoff);
      this.emit('presence');
    }));
    clearInterval(this._hb);
    this._hb = setInterval(() => this._announce(), 45_000);
  },

  _announce() {
    if (!this._db || !this._presenceRef) return;
    try { this._fb.set(this._presenceRef, { name: this.me.name, at: Date.now() }); } catch {}
  },

  /* ================= month switching ================= */
  async setMonth(m) {
    if (m === this.month) return;
    this.month = m;
    this.data = {};
    this.activity = safeStore.get(LS_ACT(m), []) || [];
    this._loadMonthLocal(m);
    this.emit('data'); this.emit('activity');
    if (this.mode === 'cloud') { this._detach(); this._watchRoster(); this._watchMonth(m); this._watchPresence(); }
  },

  _loadMonthLocal(m) {
    const saved = safeStore.get(LS_MONTH(m), null);
    for (const d of this.roster) {
      const s = saved?.[d.id];
      this.data[d.id] = s ? { ...blankDoctor(), ...s, videos: (s.videos || blankDoctor().videos).map(v => ({ ...v })) } : blankDoctor();
    }
  },
  _persistMonth() { safeStore.set(LS_MONTH(this.month), this.data); },

  /* ================= reads ================= */
  get(doctorId) { return this.data[doctorId] || blankDoctor(); },

  totals() {
    const t = { posts: 0, reels: 0, followers: 0, shares: 0, views: 0, likes: 0, comments: 0, filled: 0 };
    for (const d of this.roster) {
      const x = this.get(d.id);
      METRICS.forEach(k => { t[k] += Number(x[k]) || 0; });
      x.videos.forEach(v => { t.likes += Number(v.likes) || 0; t.comments += Number(v.comments) || 0; });
      if (this.isFilled(d.id)) t.filled++;
    }
    t.content = t.posts + t.reels;
    return t;
  },

  isFilled(id) {
    const x = this.get(id);
    return METRICS.some(k => Number(x[k]) > 0);
  },

  completeness(id) {
    const x = this.get(id);
    let done = 0, total = METRICS.length + VIDEOS_PER_DOCTOR;
    METRICS.forEach(k => { if (Number(x[k]) > 0) done++; });
    x.videos.forEach(v => { if (String(v.title).trim()) done++; });
    return Math.round((done / total) * 100);
  },

  /** Totals for a previous month, read from the local mirror — powers the
   *  month-over-month deltas on the overview. */
  totalsFor(m) {
    const saved = safeStore.get(LS_MONTH(m), null);
    if (!saved) return null;
    const t = { posts: 0, reels: 0, followers: 0, shares: 0, views: 0 };
    for (const id of Object.keys(saved)) METRICS.forEach(k => { t[k] += Number(saved[id]?.[k]) || 0; });
    t.content = t.posts + t.reels;
    return t;
  },

  /* ================= writes ================= */
  setMetric(doctorId, field, value) {
    if (!METRICS.includes(field)) return;
    const cur = this.get(doctorId);
    const from = Number(cur[field]) || 0;
    const to = Number(value) || 0;
    if (from === to) return false;
    cur[field] = to;
    this._persistMonth();
    this._muted.add(`${doctorId}.${field}`);
    this._write(`months/${this.month}/${doctorId}/${field}`, to);
    this._logActivity({ doctorId, field, from, to });
    this.emit('data');
    return true;
  },

  setVideo(doctorId, idx, field, value) {
    if (!VIDEO_FIELDS.includes(field)) return;
    const cur = this.get(doctorId);
    const from = cur.videos[idx][field];
    const to = (field === 'title' || field === 'date') ? String(value).slice(0, 160) : (Number(value) || 0);
    if (from === to) return false;
    cur.videos[idx][field] = to;
    this._persistMonth();
    this._muted.add(`${doctorId}.v${idx}.${field}`);
    this._write(`months/${this.month}/${doctorId}/videos/${idx}/${field}`, to);
    this.emit('data');
    return true;
  },

  renameDoctor(doctorId, name) {
    const d = this.roster.find(x => x.id === doctorId);
    if (!d || !String(name).trim() || d.name === name) return false;
    d.name = String(name).trim().slice(0, 80);
    safeStore.set(LS_ROSTER, this.roster);
    this._write(`roster/${doctorId}/name`, d.name);
    this.emit('roster');
    return true;
  },

  /** One scoped write. Queued if we're offline or cloud-less. */
  _write(path, value) {
    if (this.mode !== 'cloud' || !this._db) { this._enqueue(path, value); return; }
    this._setStatus('saving');
    const { ref, set } = this._fb;
    set(ref(this._db, path), value)
      .then(() => { if (this.status === 'saving') this._setStatus('live'); })
      .catch((err) => {
        console.warn('[store] write failed', path, err?.code || err);
        this._enqueue(path, value);
        this._setStatus(navigator.onLine ? 'local' : 'offline');
        this.emit('writefail', { path, error: err });
      });
  },

  _enqueue(path, value) {
    this._queue = this._queue.filter(q => q.path !== path);
    this._queue.push({ path, value, at: Date.now() });
    if (this._queue.length > 500) this._queue = this._queue.slice(-500);
    safeStore.set(LS_QUEUE, this._queue);
    this.emit('queue', this._queue.length);
  },

  async _flush() {
    if (this.mode !== 'cloud' || !this._db || !this._queue.length) return;
    const { ref, set } = this._fb;
    const pending = this._queue.slice();
    this._setStatus('saving');
    let ok = 0;
    for (const item of pending) {
      try { await set(ref(this._db, item.path), item.value); this._queue = this._queue.filter(q => q !== item); ok++; }
      catch { break; }
    }
    safeStore.set(LS_QUEUE, this._queue);
    this.emit('queue', this._queue.length);
    this._setStatus(this._queue.length ? 'local' : 'live');
    if (ok) this.emit('flushed', ok);
  },

  get pendingCount() { return this._queue.length; },

  _logActivity({ doctorId, field, from, to }) {
    const entry = { at: Date.now(), uid: this.me.id, name: this.me.name, doctorId, field, from, to };
    this.activity.unshift({ key: uid(), ...entry });
    this.activity = this.activity.slice(0, 60);
    safeStore.set(LS_ACT(this.month), this.activity);
    this.emit('activity');
    if (this.mode === 'cloud' && this._db) {
      try { this._fb.push(this._fb.ref(this._db, `activity/${this.month}`), entry); } catch {}
    }
  },
};
