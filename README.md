# كلير بَلس — Clear Pulse

Internal performance dashboard for **Clear Dental Clinic**'s media team. Arabic-first, RTL,
mobile-first, with realtime multi-device sync and authenticated access.

Built from scratch — no framework, no build step, no bundler. Deploy by dragging the folder
onto Netlify, or by pushing it to a connected repo.

---

## Contents

1. [What it does](#what-it-does)
2. [Deploy in 5 minutes (local mode)](#1-deploy-in-5-minutes-local-mode)
3. [Turn on sign-in (Netlify Identity)](#2-turn-on-sign-in-netlify-identity)
4. [Turn on realtime sync (Firebase)](#3-turn-on-realtime-sync-firebase)
5. [Roles](#roles)
6. [Architecture](#architecture)
7. [Security posture](#security-posture)
8. [Local development](#local-development)
9. [Cost](#cost)

---

## What it does

- **14 doctor accounts**, five metrics each (posts, reels, follower growth, shares, views)
  plus the top three videos per doctor with views / likes / comments.
- **Monthly reports.** Not hardcoded to one month — switch months, compare against the previous
  one, see a 6-month trend. Every month is stored separately.
- **Realtime team sync.** Field-level writes; two people editing different doctors — or
  different fields on the same doctor — never overwrite each other. Remote edits flash the
  affected cell and *never* interrupt a cell you're typing in.
- **Presence.** See which colleagues are in the dashboard right now.
- **Activity log.** Every change recorded with who, what, from → to, and when.
- **Honest sync status.** The badge is driven by Firebase's own `.info/connected` and by the
  actual result of each write. It says "متزامن" only when data really reached the cloud, and
  "محلي فقط" (with a pending count) when it did not. Nothing is ever reported as saved
  when it isn't.
- **Offline-capable.** Writes queue in `localStorage` and flush automatically on reconnect.
  Installable as a PWA.
- **Exports — Excel and PDF only.** `.xlsx` is written by a dependency-free generator in
  `js/xlsx.js` (right-to-left sheet, styled header, frozen pane, real number cells). PDF goes
  through a dedicated print layout with an A4-landscape report header.
- **Data validation.** Field rules (type, range, length) plus cross-field checks — likes can't
  exceed views, the three top videos can't out-view the whole account. Errors block the save;
  warnings are flagged for review. A **فحص البيانات** panel (`V`) audits the whole month, and
  both exports refuse to run silently over broken numbers.
- **Command palette** (`⌘K` / `Ctrl+K`), full keyboard shortcuts, light/dark themes.

---

## 1. Deploy in 5 minutes (local mode)

The app runs immediately with no backend at all. Data is saved per-device in the browser and
the UI clearly says so.

**Option A — drag and drop**
1. Go to <https://app.netlify.com/drop>
2. Drag the `clear-pulse` folder in.
3. Done. Open the URL.

**Option B — Git**
```bash
git init && git add -A && git commit -m "Clear Pulse"
# push to GitHub, then "Add new site → Import an existing project" in Netlify
```
Netlify reads `netlify.toml` automatically. Publish directory is `.`, functions live in
`netlify/functions`. There is no build command.

> At this point the app works, but everyone can open the URL and data does not sync.
> Continue to steps 2 and 3.

---

## 2. Turn on sign-in (Netlify Identity)

1. Netlify dashboard → your site → **Integrations** (or **Identity**) → **Enable Identity**.
2. **Identity → Registration**: set to **Invite only**. This is the important one — it stops
   strangers creating accounts on a dashboard holding staff data.
3. **Identity → Emails**: confirm the invite/confirmation/recovery templates point at your
   site URL.
4. Invite your team: **Identity → Invite users**, enter their work emails.
   They receive a link that lands on the app with `#invite_token=…`; the app picks it up,
   asks them to choose a password, and signs them in.

Nothing in the app renders before Identity confirms the user. If Identity is not enabled yet,
the app says so plainly instead of showing a login box that cannot work.

### Assigning roles
Netlify dashboard → **Identity → (user) → Edit settings → Roles**:

| Role | Value to enter | Can |
|---|---|---|
| Admin | `admin` | everything, including managing the doctor roster |
| Editor | `editor` | enter and edit performance data |
| Viewer | `viewer` | read only |

A user with no role is treated as **editor**, so nobody is locked out before roles are set.

---

## 3. Turn on realtime sync (Firebase)

Free forever on the Spark plan. No credit card.

### 3a. Create the database
1. <https://console.firebase.google.com> → **Add project** (disable Analytics — not needed).
2. **Build → Realtime Database → Create Database**. Pick a region. Start in **locked mode**.
3. Copy the database URL, e.g. `https://clear-pulse-default-rtdb.europe-west1.firebasedatabase.app`

### 3b. Paste the security rules
**Realtime Database → Rules** → paste the contents of [`firebase.rules.json`](firebase.rules.json)
→ **Publish**.

These rules do the real enforcement: authenticated-only access, role-gated writes, per-field
type and range validation, activity entries that can only be created (never edited) and only
under the writer's own uid, and presence writable only by its owner.

### 3c. Create a service account
1. Firebase **Project settings → Service accounts → Generate new private key**.
2. A JSON file downloads. **Do not commit it.**

### 3d. Enable custom-token sign-in
Firebase **Authentication → Get started → Sign-in method** — no provider needs enabling for
custom tokens, but Authentication itself must be initialised once.

### 3e. Set Netlify environment variables
Netlify → **Site configuration → Environment variables**:

| Variable | Value |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | the entire service-account JSON, pasted as one line |
| `FIREBASE_DATABASE_URL` | your database URL from 3a |
| `FIREBASE_API_KEY` | Project settings → General → Web API key |
| `FIREBASE_PROJECT_ID` | your project id |

Redeploy. The sync badge turns green and reads **متزامن**.

> **Why a service account and not a public config?**
> `netlify/functions/session.js` verifies the Netlify Identity user server-side, then mints a
> short-lived Firebase custom token carrying that user's id and role. The browser never sees
> the private key, and the database rules can trust `auth.uid` and `auth.token.role`.
> It signs the token with Node's built-in `crypto` — **zero npm dependencies**, so there is
> nothing to install and nothing to keep patched.

---

## Roles

| | Viewer | Editor | Admin |
|---|:--:|:--:|:--:|
| Read the report | ✅ | ✅ | ✅ |
| Enter / edit data | — | ✅ | ✅ |
| Export, print | ✅ | ✅ | ✅ |
| Manage the doctor roster | — | — | ✅ |

The UI hides what you can't do; the database rules enforce it for real.

---

## Architecture

```
Browser
 ├─ Netlify Identity (GoTrue REST, custom UI)  ── gates the whole app
 │     └─ POST /.netlify/functions/session
 │            └─ verifies Identity user server-side
 │            └─ mints a Firebase custom token (uid + role)
 └─ Firebase RTDB (signInWithCustomToken)
        ├─ realtime listener, diffed per field
        ├─ scoped update() writes  ── never whole-dataset set()
        └─ rules enforce identity, role, type, range
```

```
clear-pulse/
├─ index.html            app shell + icon sprite (no inline JS)
├─ 404.html              custom 404 with internal links
├─ privacy.html          privacy & data-protection policy
├─ robots.txt            Disallow: / — this is private
├─ _headers              CSP, HSTS, X-Frame-Options, Referrer-Policy…
├─ _redirects            HTTPS force, functions passthrough, SPA fallback
├─ netlify.toml          publish dir + functions dir
├─ site.webmanifest      PWA manifest
├─ sw.js                 service worker (never caches auth/functions)
├─ firebase.rules.json   database security rules
├─ css/
│   ├─ app.css           design tokens, primitives, both themes
│   └─ shell.css         app shell, views, components
├─ js/
│   ├─ app.js            bootstrap, routing, wiring
│   ├─ auth.js           GoTrue client + sign-in gate
│   ├─ store.js          data layer, sync, offline queue
│   ├─ ui.js             toasts, entry sheet, command palette
│   ├─ views.js          overview, doctors, analytics, activity
│   ├─ validate.js       field rules + cross-field checks
│   ├─ xlsx.js           dependency-free .xlsx writer
│   └─ util.js           DOM builder, number/Arabic handling
├─ netlify/functions/
│   └─ session.js        Identity → Firebase custom token
└─ assets/               logo, favicon, PWA icons, social image
```

**Design system.** Brand purple `#753BBC` and ink `#1E2123` were sampled directly from the
clinic logo; the ramp and the violet-shifted neutrals are built around them. Type is
IBM Plex Sans Arabic with IBM Plex Mono for figures. The four-blade aperture from the logo is
the app's motion signature — it spins while loading and syncing.

---

## Security posture

| Concern | How it's handled |
|---|---|
| API keys | Service account lives only in Netlify env vars, never in git. Only the public web API key reaches the browser. |
| Server-side auth | `context.clientContext.user` — Netlify verifies the JWT; the function never trusts client claims. |
| Row / record access | RTDB rules require `auth != null`; writes require `admin`/`editor`; a doctor must exist in the roster. |
| Field tampering | Per-field `.validate` on type and range; `"$other": {".validate": false}` rejects unknown fields. |
| Input validation | `js/validate.js` — per-field type/range/length rules and cross-field consistency checks, mirrored by the database rules. Bad input is rejected with a reason, never coerced to zero. |
| Escaping user content | No `innerHTML` anywhere. All DOM built via `createElement`/`textContent`; `el()` throws on `html` or `on*` props. |
| Spreadsheet injection | The `.xlsx` writer emits typed cells — a value is written as a number or as an inline string, never as a formula, so there is no formula-injection surface at all. |
| Passwords | Handled entirely by Netlify Identity (hashed, never seen by this app). |
| Session cookies | Bearer tokens over HTTPS only; short-lived access token + refresh. |
| Login rate limiting | Client-side exponential backoff after 4 failures, plus Identity's own limits. |
| Bot protection | Hidden honeypot field on the auth form. |
| Security headers | CSP (no `unsafe-inline` scripts), HSTS preload, `X-Frame-Options: DENY`, `nosniff`, Referrer-Policy, Permissions-Policy, COOP/CORP. |
| HTTPS | Forced by `_redirects` + HSTS. |
| Search engines | `noindex` meta, `X-Robots-Tag`, and `robots.txt` disallow. |
| Dependencies | Two CDN scripts total, both version-pinned; Chart.js loaded with an SRI hash and only when the analytics tab is opened. |
| Third-party analytics | **None.** No Google Analytics, no trackers, no marketing cookies. |

### Scanning dependencies
There is no `package.json` and no npm dependency to audit — that is deliberate. The only
external code is:

- `cdnjs.cloudflare.com/ajax/libs/Chart.js/4.5.1/chart.umd.min.js` — pinned + SRI
- `www.gstatic.com/firebasejs/10.12.2/*` — pinned, first-party Google

To bump Chart.js, get the new SRI hash and update `js/views.js`:
```bash
curl -s "https://api.cdnjs.com/libraries/Chart.js/<version>?fields=sri" | grep chart.umd.min.js
```

### Purging secrets from git
If a key was ever committed, rotating it is the only real fix:
```bash
# 1. Revoke the exposed key in the Firebase console, generate a new one
# 2. Scrub history
git filter-repo --path <leaked-file> --invert-paths   # or BFG Repo-Cleaner
git push --force
```

---

## Local development

```bash
python3 devserver.py 8120
```

`devserver.py` (kept outside the app folder and never deployed) serves the app and stubs both
backends: a minimal GoTrue stand-in and a `session` endpoint that reports
`cloud_not_configured`, so you can exercise the real auth path and the honest local-mode
fallback without any cloud account.

Any email and password signs you in as an **admin** locally.

To develop against real Netlify Identity and functions instead:
```bash
npm i -g netlify-cli && netlify dev
```

---

## Cost

| | Cost | Card required |
|---|---|---|
| Netlify hosting + Functions | $0 | No |
| Netlify Identity | $0 | No |
| Firebase RTDB + Auth (Spark) | $0 | No |

Roughly 20 KB of data per month for 14 doctors — about 0.03% of the 1 GB free allowance per
year. The Spark plan stops at its limits rather than billing, so there is no surprise-charge
risk.

---

## Known limits

- **Follower growth is entered by hand.** If you later connect Meta's API, note that
  Instagram's `follower_count` insight only covers the last 30 days, so historical months
  cannot be backfilled — you would snapshot it daily going forward.
- Month-over-month deltas and the 6-month trend read the local mirror, so a device sees
  history for months it has actually opened. Open a past month once to populate it.
- The roster editor (add/remove doctors) is admin-gated but not yet exposed in the UI;
  edit `roster` in the Firebase console, or rename inline in the table.

---

© 2026 Clear Dental Clinic — internal tool.
