// Freelance clients: one-person site. Static page from ./public, data API on D1, password login.
// Secrets: APP_USER, APP_PASSWORD, SESSION_SECRET (wrangler secret put ...).
const enc = new TextEncoder();
const DAY = 86400;
const SESSION_DAYS = 30;
const MAX_FAILS = 5;            // per IP
const FAIL_WINDOW = 15 * 60;    // seconds
const ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {status, headers: {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers}});
const now = () => Math.floor(Date.now() / 1000);

async function makeSession(env) {
  const exp = now() + SESSION_DAYS * DAY;
  return `${exp}.${await hmac(env.SESSION_SECRET, 'v1.' + exp)}`;
}
async function validSession(req, env) {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.get('cookie') || '');
  if (!m || !env.SESSION_SECRET) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || +exp < now()) return false;
  return safeEq(sig, await hmac(env.SESSION_SECRET, 'v1.' + exp));
}
const cookie = (value, maxAge) => `sid=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

async function login(req, env) {
  if (!env.APP_USER || !env.APP_PASSWORD || !env.SESSION_SECRET) return json({error: 'not_configured'}, 503);
  const ip = req.headers.get('cf-connecting-ip') || 'unknown';
  const since = now() - FAIL_WINDOW;
  const {n} = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_fails WHERE ip = ? AND at > ?').bind(ip, since).first();
  if (n >= MAX_FAILS) return json({error: 'too_many'}, 429);
  let body;
  try { body = await req.json(); } catch { return json({error: 'bad_request'}, 400); }
  const user = String(body?.user ?? ''), pass = String(body?.password ?? '');
  // compare HMACs so length and timing don't leak
  const k = env.SESSION_SECRET;
  const ok = safeEq(await hmac(k, user.trim().toLowerCase()), await hmac(k, env.APP_USER.trim().toLowerCase()))
           & safeEq(await hmac(k, pass), await hmac(k, env.APP_PASSWORD));
  if (!ok) {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO login_fails (ip, at) VALUES (?, ?)').bind(ip, now()),
      env.DB.prepare('DELETE FROM login_fails WHERE at < ?').bind(since),
    ]);
    return json({error: 'wrong'}, 401);
  }
  await env.DB.prepare('DELETE FROM login_fails WHERE ip = ?').bind(ip).run();
  return json({ok: true}, 200, {'set-cookie': cookie(await makeSession(env), SESSION_DAYS * DAY)});
}

async function api(req, env, path) {
  if (path === '/api/login' && req.method === 'POST') return login(req, env);
  if (path === '/api/logout' && req.method === 'POST') return json({ok: true}, 200, {'set-cookie': cookie('', 0)});
  if (!(await validSession(req, env))) return json({error: 'auth'}, 401);
  // writes must be JSON: a cross-site form can't send that without a preflight we never answer
  if (req.method !== 'GET' && req.method !== 'DELETE' && !(req.headers.get('content-type') || '').startsWith('application/json')) return json({error: 'bad_request'}, 415);

  if (path === '/api/me') return json({ok: true});
  if (path === '/api/clients' && req.method === 'GET') {
    const {results} = await env.DB.prepare('SELECT id, data FROM clients').all();
    return json(results.map(r => ({...JSON.parse(r.data), id: r.id})));
  }
  const m = /^\/api\/clients\/([^/]+)$/.exec(path);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (!ID_RE.test(id)) return json({error: 'bad_id'}, 400);
    if (req.method === 'PUT') {
      const text = await req.text();
      if (text.length > 200_000) return json({error: 'too_large'}, 413);
      let data;
      try { data = JSON.parse(text); } catch { return json({error: 'bad_json'}, 400); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return json({error: 'bad_json'}, 400);
      delete data.id;
      await env.DB.prepare('INSERT INTO clients (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
        .bind(id, JSON.stringify(data), now()).run();
      return json({ok: true});
    }
    if (req.method === 'DELETE') {
      await env.DB.prepare('DELETE FROM clients WHERE id = ?').bind(id).run();
      return json({ok: true});
    }
  }
  return json({error: 'not_found'}, 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      try { return await api(req, env, url.pathname); }
      catch (e) { return json({error: 'server'}, 500); }
    }
    return env.ASSETS.fetch(req);
  },
};
