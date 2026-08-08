// Cloudflare Worker backing the GitHub connection UI on the deployed site. Everything except
// /api/github/* falls through to the static build in dist/ (env.ASSETS) — this Worker does not
// attempt to port server.js's local-machine-only features (folder browsing, starting a local dev
// server, driving a local Chrome for previews): those need real filesystem/process/browser access
// that an edge Worker structurally cannot have, so they stay local-only by design, not by omission.
//
// Config (owner/repo/token) lives in KV instead of a local JSON file, since Workers have no
// persistent filesystem — same shape as server.js's qa-data/github-config.json, just durable
// somewhere a stateless edge function can reach it. Requires a KV namespace bound as GH_CONFIG
// (see wrangler.jsonc).

const CONFIG_KEY = 'config';
const DEFAULT_CONFIG = { enabled: false, owner: null, repo: null, token: null };

async function loadConfig(env) {
  const raw = await env.GH_CONFIG.get(CONFIG_KEY);
  if (!raw) return { ...DEFAULT_CONFIG };
  try {
    const c = JSON.parse(raw);
    return {
      enabled: !!c.enabled,
      owner: c.owner || null,
      repo: c.repo || null,
      token: c.token || null
    };
  } catch { return { ...DEFAULT_CONFIG }; }
}

async function saveConfig(env, config) {
  await env.GH_CONFIG.put(CONFIG_KEY, JSON.stringify(config));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function ghHeaders(config) {
  const headers = { 'User-Agent': 'on-track-app', Accept: 'application/vnd.github+json' };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  return headers;
}

// Hits the real GitHub API (repo reachability + token identity) so the UI can show a true
// connected/failed state, not just "fields are filled in" — mirrors server.js's ghConnectionStatus.
async function connectionStatus(config) {
  if (!config.enabled) return { ok: false, checked: false, error: 'חיבור GitHub אינו מופעל.' };
  if (!config.owner || !config.repo) return { ok: false, checked: true, error: 'חסר Owner ו/או שם ריפו.' };
  const headers = ghHeaders(config);
  try {
    const r = await fetch(`https://api.github.com/repos/${config.owner}/${config.repo}`, { headers });
    const j = await r.json();
    if (!r.ok) return { ok: false, checked: true, error: j.message || ('GitHub API החזיר שגיאה (' + r.status + ')') };
    const data = {
      ok: true, checked: true,
      fullName: j.full_name, private: !!j.private,
      defaultBranch: j.default_branch, htmlUrl: j.html_url,
      permissions: j.permissions || null,
      authenticated: false, login: null, scopes: []
    };
    if (config.token) {
      try {
        const ur = await fetch('https://api.github.com/user', { headers });
        const uj = await ur.json();
        if (ur.ok) {
          data.authenticated = true;
          data.login = uj.login;
          const scopesHeader = (ur.headers.get('x-oauth-scopes') || '').trim();
          data.scopes = scopesHeader ? scopesHeader.split(',').map(s => s.trim()).filter(Boolean) : [];
        } else {
          data.authWarning = uj.message || 'הטוקן לא זוהה מול /user.';
        }
      } catch (e) { data.authWarning = e.message; }
    }
    return data;
  } catch (e) {
    return { ok: false, checked: true, error: 'שגיאת רשת מול GitHub: ' + e.message };
  }
}

async function handleApi(request, env, path) {
  const method = request.method;

  // Read: never expose the raw token, only whether one is set.
  if (path === '/api/github/config' && method === 'GET') {
    const config = await loadConfig(env);
    return json({ enabled: config.enabled, hasToken: !!config.token, owner: config.owner, repo: config.repo });
  }

  if (path === '/api/github/config' && method === 'POST') {
    const config = await loadConfig(env);
    const b = await request.json().catch(() => ({}));
    if (typeof b.enabled === 'boolean') config.enabled = b.enabled;
    if (typeof b.owner === 'string' && b.owner.trim()) config.owner = b.owner.trim();
    if (typeof b.repo === 'string' && b.repo.trim()) config.repo = b.repo.trim();
    if (typeof b.token === 'string' && b.token.trim()) config.token = b.token.trim();
    if (b.token === null) config.token = null;
    await saveConfig(env, config);
    return json({ ok: true, enabled: config.enabled, hasToken: !!config.token });
  }

  // GET = cheap poll (header dot / MVP chip), POST = forced fresh check after Save+Test.
  // Both behave identically here since this Worker doesn't cache; see note in connectionStatus.
  if (path === '/api/github/status' && (method === 'GET' || method === 'POST')) {
    const config = await loadConfig(env);
    return json(await connectionStatus(config));
  }

  if (path === '/api/github/issues' && method === 'GET') {
    const config = await loadConfig(env);
    if (!config.enabled || !config.owner || !config.repo) {
      return json({ error: 'חיבור GitHub אינו פעיל, או שחסר owner/repo.' }, 400);
    }
    try {
      const r = await fetch(`https://api.github.com/repos/${config.owner}/${config.repo}/issues?state=open&per_page=50`, { headers: ghHeaders(config) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || 'שגיאה מול GitHub API');
      const issues = (Array.isArray(j) ? j : []).filter(i => !i.pull_request)
        .map(i => ({ number: i.number, title: i.title, url: i.html_url, state: i.state, labels: (i.labels || []).map(l => l.name) }));
      return json({ issues });
    } catch (e) {
      return json({ error: e.message }, 502);
    }
  }

  if (path === '/api/github/create-issue' && method === 'POST') {
    const config = await loadConfig(env);
    if (!config.enabled || !config.owner || !config.repo || !config.token) {
      return json({ error: 'חיבור GitHub אינו פעיל, או שחסר owner/repo/token.' }, 400);
    }
    const b = await request.json().catch(() => ({}));
    const title = (b.title || '').trim();
    if (!title) return new Response('missing title', { status: 400 });
    try {
      const r = await fetch(`https://api.github.com/repos/${config.owner}/${config.repo}/issues`, {
        method: 'POST',
        headers: { ...ghHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body: b.body || '' })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || 'שגיאה מול GitHub API');
      return json({ ok: true, number: j.number, url: j.html_url });
    } catch (e) {
      return json({ error: e.message }, 502);
    }
  }

  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/github/')) return handleApi(request, env, url.pathname);
    return env.ASSETS.fetch(request);
  }
};
