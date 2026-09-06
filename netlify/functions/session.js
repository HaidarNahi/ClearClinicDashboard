/* ==========================================================================
   /.netlify/functions/session
   Server-side gate between Netlify Identity and Firebase.

   Netlify verifies the Identity JWT for us and hands the decoded user on
   context.clientContext.user. We never trust anything the browser claims.
   We then mint a short-lived Firebase custom token carrying that user's id
   and role, so the database rules can enforce identity and permissions.

   Zero npm dependencies: a Firebase custom token is just an RS256 JWT with
   a specific audience, which Node's built-in crypto can sign.

   Required environment variables (set in the Netlify UI, never in git):
     FIREBASE_SERVICE_ACCOUNT   full service-account JSON, as one line
     FIREBASE_DATABASE_URL      https://<project>-default-rtdb.<region>.firebasedatabase.app
     FIREBASE_API_KEY           the web API key (public by design)
     FIREBASE_PROJECT_ID        optional; read from the service account if absent
   ========================================================================== */

const crypto = require('crypto');

const AUD = 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

function signCustomToken(sa, uid, claims) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: AUD,
    iat: now,
    exp: now + 3600,          // Firebase caps custom tokens at one hour
    uid: String(uid).slice(0, 128),
    claims,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const sig = signer.sign(sa.private_key);
  return `${signingInput}.${b64url(sig)}`;
}

const json = (status, body) => ({
  statusCode: status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  },
  body: JSON.stringify(body),
});

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  // Netlify populates this only for a valid, unexpired Identity JWT.
  const user = context.clientContext && context.clientContext.user;
  if (!user || !user.sub) return json(401, { error: 'unauthorized' });

  const roles = (user.app_metadata && user.app_metadata.roles) || [];
  const role = roles.includes('admin') ? 'admin' : roles.includes('viewer') ? 'viewer' : 'editor';

  const dbUrl = process.env.FIREBASE_DATABASE_URL;
  const apiKey = process.env.FIREBASE_API_KEY;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;

  // Cloud not configured yet → tell the client plainly so it can fall back to
  // local mode and SAY so, instead of pretending to be synced.
  if (!dbUrl || !raw) {
    return json(200, {
      firebase: null,
      token: null,
      user: { id: user.sub, email: user.email, name: (user.user_metadata || {}).full_name, role },
      reason: 'cloud_not_configured',
    });
  }

  let sa;
  try {
    sa = JSON.parse(raw);
    if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  } catch {
    return json(500, { error: 'bad_service_account' });
  }

  let token;
  try {
    token = signCustomToken(sa, user.sub, {
      role,
      email: user.email || null,
      name: (user.user_metadata || {}).full_name || null,
    });
  } catch (e) {
    return json(500, { error: 'sign_failed', detail: String(e.message || e) });
  }

  return json(200, {
    firebase: {
      apiKey,
      databaseURL: dbUrl,
      projectId: process.env.FIREBASE_PROJECT_ID || sa.project_id,
    },
    token,
    user: { id: user.sub, email: user.email, name: (user.user_metadata || {}).full_name, role },
  });
};
