/* ==========================================================================
   validate.js — one place that decides whether a value is acceptable

   Three layers, deliberately:
     1. FIELD rules — type, range, length. Wrong input is REJECTED with a
        reason, never silently coerced to zero.
     2. CROSS-FIELD checks — relationships that must hold (likes can't exceed
        views) and relationships that are merely suspicious (a doctor with
        views but no posts). Errors block the save; warnings do not.
     3. The database rules in firebase.rules.json mirror layer 1 server-side,
        so a tampered client still cannot write a bad value.
   ========================================================================== */

import { parseNum, toLatinDigits, fmt } from './util.js';

export const FIELD_RULES = {
  posts:     { label: 'البوستات',       min: 0, max: 2000,       integer: true },
  reels:     { label: 'الريلز',          min: 0, max: 2000,       integer: true },
  followers: { label: 'نمو المتابعين',   min: -1000000, max: 5000000, integer: true },
  shares:    { label: 'المشاركات',       min: 0, max: 50000000,   integer: true },
  views:     { label: 'المشاهدات',       min: 0, max: 5000000000, integer: true },
};

export const VIDEO_RULES = {
  title:    { label: 'اسم الفيديو',  type: 'text', maxLength: 160 },
  date:     { label: 'تاريخ النشر',  type: 'text', maxLength: 40 },
  views:    { label: 'مشاهدات الفيديو', min: 0, max: 5000000000, integer: true },
  likes:    { label: 'الإعجابات',    min: 0, max: 500000000,  integer: true },
  comments: { label: 'التعليقات',    min: 0, max: 50000000,   integer: true },
};

/**
 * Validate one raw input against its rule.
 * @returns {{ok:boolean, value?:*, error?:string}}
 */
export function validateField(field, raw, { video = false } = {}) {
  const rule = (video ? VIDEO_RULES : FIELD_RULES)[field];
  if (!rule) return { ok: true, value: raw };

  if (rule.type === 'text') {
    const s = String(raw ?? '').trim();
    if (s.length > rule.maxLength) {
      return { ok: false, error: `${rule.label}: الحد الأقصى ${rule.maxLength} حرفاً (أدخلت ${s.length}).` };
    }
    return { ok: true, value: s };
  }

  const s = String(raw ?? '').trim();
  if (s === '') return { ok: true, value: 0 };

  // Catch a common slip early with a clearer message than the generic parser
  if (/[٠-٩۰-۹]/.test(s) === false && /[^\d\s,.\-+٬،_']/.test(toLatinDigits(s))) {
    return { ok: false, error: `${rule.label}: يجب أن يكون رقماً فقط.` };
  }

  const r = parseNum(s, { min: rule.min, max: rule.max, integer: rule.integer });
  if (!r.ok) {
    if (/لا يقل/.test(r.error)) {
      return { ok: false, error: rule.min < 0
        ? `${rule.label}: لا يقل عن ${fmt(rule.min)}.`
        : `${rule.label}: لا يمكن أن يكون سالباً.` };
    }
    if (/كبير/.test(r.error)) {
      return { ok: false, error: `${rule.label}: القيمة تتجاوز الحد المسموح (${fmt(rule.max)}).` };
    }
    return { ok: false, error: `${rule.label}: ${r.error}.` };
  }
  return { ok: true, value: r.value };
}

/**
 * Whole-record checks. `doc` is the shape returned by store.get().
 * @returns {Array<{level:'error'|'warn', field?:string, videoIndex?:number, message:string}>}
 */
export function validateDoctor(doc, name = 'هذا الطبيب') {
  const issues = [];
  const num = (v) => Number(v) || 0;

  const posts = num(doc.posts), reels = num(doc.reels);
  const views = num(doc.views), followers = num(doc.followers), shares = num(doc.shares);
  const content = posts + reels;

  doc.videos.forEach((v, i) => {
    const vv = num(v.views), vl = num(v.likes), vc = num(v.comments);
    const hasTitle = String(v.title || '').trim().length > 0;
    const hasNumbers = vv > 0 || vl > 0 || vc > 0;

    if (vl > vv && vv > 0) {
      issues.push({ level: 'error', videoIndex: i, field: 'likes',
        message: `الفيديو ${i + 1}: الإعجابات (${fmt(vl)}) أكبر من المشاهدات (${fmt(vv)}).` });
    }
    if (vc > vv && vv > 0) {
      issues.push({ level: 'error', videoIndex: i, field: 'comments',
        message: `الفيديو ${i + 1}: التعليقات (${fmt(vc)}) أكبر من المشاهدات (${fmt(vv)}).` });
    }
    if (hasNumbers && !hasTitle) {
      issues.push({ level: 'warn', videoIndex: i, field: 'title',
        message: `الفيديو ${i + 1}: أُدخلت أرقام بدون اسم للفيديو.` });
    }
    if (hasTitle && vv === 0) {
      issues.push({ level: 'warn', videoIndex: i, field: 'views',
        message: `الفيديو ${i + 1}: يوجد اسم للفيديو بدون مشاهدات.` });
    }
  });

  const videoViews = doc.videos.reduce((s, v) => s + num(v.views), 0);
  if (views > 0 && videoViews > views) {
    issues.push({ level: 'error', field: 'views',
      message: `مجموع مشاهدات أفضل ٣ فيديوهات (${fmt(videoViews)}) أكبر من إجمالي مشاهدات الحساب (${fmt(views)}).` });
  }

  if (views > 0 && content === 0) {
    issues.push({ level: 'warn', field: 'posts',
      message: 'توجد مشاهدات بدون أي بوستات أو ريلز — تأكد من عدد المنشورات.' });
  }
  if (content > 0 && views === 0) {
    issues.push({ level: 'warn', field: 'views',
      message: 'توجد منشورات بدون أي مشاهدات — تأكد من رقم المشاهدات.' });
  }
  if (content > 0 && views > 0 && views / content > 2_000_000) {
    issues.push({ level: 'warn', field: 'views',
      message: `متوسط ${fmt(Math.round(views / content))} مشاهدة لكل منشور — رقم غير معتاد، تأكد منه.` });
  }
  if (followers > 0 && views > 0 && followers > views) {
    issues.push({ level: 'warn', field: 'followers',
      message: `نمو المتابعين (${fmt(followers)}) أكبر من إجمالي المشاهدات (${fmt(views)}) — تأكد من الرقمين.` });
  }
  if (shares > views && views > 0) {
    issues.push({ level: 'warn', field: 'shares',
      message: `المشاركات (${fmt(shares)}) أكبر من المشاهدات (${fmt(views)}) — تأكد من الرقمين.` });
  }

  return issues;
}

/** Convenience: does this record have anything blocking? */
export const hasErrors = (issues) => issues.some(i => i.level === 'error');

/** Validate the whole month; used before an export so nobody ships bad numbers. */
export function validateAll(roster, getFn) {
  const out = [];
  for (const d of roster) {
    const issues = validateDoctor(getFn(d.id), d.name);
    if (issues.length) out.push({ doctor: d, issues });
  }
  return out;
}
