#!/usr/bin/env python3
"""
Dev-only harness for Clear Pulse.

Serves the app AND fakes the two backend surfaces so the real auth code path
can be exercised locally:
  /.netlify/identity/*          -> a minimal GoTrue stand-in
  /.netlify/functions/session   -> replies "cloud_not_configured" so the app
                                   exercises its honest local-mode fallback

This file lives OUTSIDE the app directory and is never deployed.
"""
import json, os, sys, base64, re
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'clear-pulse')

USER = {
    "id": "dev-user-0001",
    "aud": "", "role": "",
    "email": "sara@cleardental.iq",
    "confirmed_at": "2026-01-01T00:00:00Z",
    "app_metadata": {"provider": "email", "roles": ["admin"]},
    "user_metadata": {"full_name": "سارة الحسن"},
    "created_at": "2026-01-01T00:00:00Z",
}
TOKEN = {"access_token": "dev-access-token", "token_type": "bearer",
         "expires_in": 3600, "refresh_token": "dev-refresh-token"}


class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        # dev only: never cache, so edits show up on reload
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(n).decode() if n else ''
        ctype = self.headers.get('Content-Type', '')
        if 'json' in ctype:
            try: return json.loads(raw)
            except Exception: return {}
        return {k: v[0] for k, v in parse_qs(raw).items()}

    def do_POST(self):
        p = urlparse(self.path).path
        data = self._body()
        if p == '/.netlify/identity/token':
            if data.get('grant_type') == 'refresh_token':
                return self._json(200, TOKEN)
            if data.get('password') == 'wrong':
                return self._json(400, {"error": "invalid_grant",
                                        "error_description": "Invalid login credentials"})
            return self._json(200, TOKEN)
        if p == '/.netlify/identity/signup':
            return self._json(200, dict(USER, email=data.get('email', USER['email'])))
        if p == '/.netlify/identity/recover':
            return self._json(200, {})
        if p == '/.netlify/identity/logout':
            return self._json(204, {})
        if p == '/__save':
            # dev only: let the page write generated icons to disk
            name = re.sub(r'[^A-Za-z0-9._-]', '', data.get('name', ''))
            m = re.match(r'^data:[-\w.+/]+;base64,(.+)$', data.get('data', ''), re.S)
            if not name or not m:
                return self._json(400, {"error": "bad_request"})
            sub = 'assets' if name.rsplit('.',1)[-1] in ('png','jpg','jpeg','svg') else '..'
            dest = os.path.join(ROOT, sub, name)
            with open(dest, 'wb') as f:
                f.write(base64.b64decode(m.group(1)))
            return self._json(200, {"saved": name, "bytes": os.path.getsize(dest)})
        if p == '/.netlify/functions/session':
            if not (self.headers.get('Authorization') or '').startswith('Bearer '):
                return self._json(401, {"error": "unauthorized"})
            # No Firebase configured in dev -> the app must fall back to local
            # mode AND say so. That's exactly what we want to verify.
            return self._json(200, {"firebase": None, "token": None,
                                    "reason": "cloud_not_configured",
                                    "user": {"id": USER["id"], "email": USER["email"],
                                             "name": "سارة الحسن", "role": "admin"}})
        self.send_error(404)

    def do_GET(self):
        p = urlparse(self.path).path
        if p == '/.netlify/identity/user':
            if not (self.headers.get('Authorization') or '').startswith('Bearer '):
                return self._json(401, {"error": "unauthorized"})
            return self._json(200, USER)
        if p == '/.netlify/identity/settings':
            return self._json(200, {"external": {}, "disable_signup": False, "autoconfirm": True})
        if p.startswith('/.netlify/'):
            self.send_error(404); return
        # SPA fallback
        fs = os.path.join(ROOT, p.lstrip('/'))
        if p != '/' and not os.path.exists(fs):
            self.path = '/404.html'
        return super().do_GET()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8120
    print(f"Clear Pulse dev harness on http://localhost:{port}  (root: {ROOT})")
    ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
