// Cloudflare Worker backing the GitHub/model connections on the deployed site, gated behind
// real per-user login (Sign in with Google) — everything except /api/auth/* and the static
// build requires a session. This Worker does not attempt to port server.js's local-machine-only
// features (folder browsing, starting a local dev server, driving a local Chrome for previews):
// those need real filesystem/process/browser access an edge Worker structurally cannot have, so
// they stay local-only by design, not by omission.
//
// All durable state lives in one KV namespace (GH_CONFIG binding — the name predates the model/
// auth additions but nothing depends on it) under distinct key prefixes:
//   session:<sessionId>        ephemeral login session -> {uid, email, name, picture}
//   github_config:<uid>        per-user GitHub owner/repo/token
//   models_config:<uid>        per-user model list + selection + "recently connected"
//   workspace_config:<uid>     per-user projects + libraries
// Before login existed, github_config/models_config were single global keys shared by every
// visitor — anyone who connected a token made it usable by anyone else who opened the site.
// Scoping every key by uid is the actual fix, not just a nicety.

// ---------------------------------------------------------------------------
// Cookies (Workers' fetch API has no built-in cookie jar — small manual helpers)
// ---------------------------------------------------------------------------

function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const out = {};
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function setCookie(name, value, { maxAge, path = '/' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=Lax; Secure; HttpOnly`;
  if (maxAge != null) c += `; Max-Age=${maxAge}`;
  return c;
}

function clearCookie(name, path = '/') {
  return `${name}=; Path=${path}; Max-Age=0; SameSite=Lax; Secure; HttpOnly`;
}

function json(data, status = 200, extraHeaders) {
  const headers = new Headers(extraHeaders || {});
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(data), { status, headers });
}

// ---------------------------------------------------------------------------
// Sessions — a session is an opaque id mapping to {uid, email, name, picture} in KV,
// with its own TTL so a stale login eventually expires server-side too, not just the cookie.
// ---------------------------------------------------------------------------

const SESSION_COOKIE = 'on_session';
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days

async function createSession(env, user) {
  const sessionId = crypto.randomUUID();
  await env.GH_CONFIG.put('session:' + sessionId, JSON.stringify(user), { expirationTtl: SESSION_TTL });
  return sessionId;
}

async function getSession(env, request) {
  const sid = parseCookies(request)[SESSION_COOKIE];
  if (!sid) return null;
  const raw = await env.GH_CONFIG.get('session:' + sid);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function destroySession(env, request) {
  const sid = parseCookies(request)[SESSION_COOKIE];
  if (sid) await env.GH_CONFIG.delete('session:' + sid);
}

// ---------------------------------------------------------------------------
// Google OAuth (authorization-code flow, server-side token exchange)
// ---------------------------------------------------------------------------

async function handleAuth(request, env, url, path) {
  const method = request.method;

  if (path === '/api/auth/login' && method === 'GET') {
    if (!env.GOOGLE_CLIENT_ID) return new Response('Google login is not configured (missing GOOGLE_CLIENT_ID).', { status: 500 });
    const state = crypto.randomUUID();
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', url.origin + '/api/auth/callback');
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'openid email profile');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('access_type', 'online');
    authUrl.searchParams.set('prompt', 'select_account');
    const headers = new Headers({ Location: authUrl.toString() });
    // Short-lived, path-scoped CSRF token — compared against ?state on the way back.
    headers.append('Set-Cookie', setCookie('oauth_state', state, { maxAge: 300, path: '/api/auth' }));
    return new Response(null, { status: 302, headers });
  }

  if (path === '/api/auth/callback' && method === 'GET') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const savedState = parseCookies(request)['oauth_state'];
    if (!code || !state || state !== savedState) {
      return new Response('Invalid or expired login attempt — please try signing in again.', { status: 400 });
    }
    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: url.origin + '/api/auth/callback',
          grant_type: 'authorization_code'
        })
      });
      const tokenJson = await tokenRes.json();
      if (!tokenRes.ok || !tokenJson.access_token) {
        throw new Error(tokenJson.error_description || tokenJson.error || ('token exchange failed (HTTP ' + tokenRes.status + ')'));
      }
      const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: 'Bearer ' + tokenJson.access_token }
      });
      const userJson = await userRes.json();
      if (!userRes.ok || !userJson.sub) throw new Error('failed to fetch Google user info');
      const user = {
        uid: 'google:' + userJson.sub,
        email: userJson.email || null,
        name: userJson.name || null,
        picture: userJson.picture || null
      };
      const sessionId = await createSession(env, user);
      const headers = new Headers({ Location: '/' });
      headers.append('Set-Cookie', setCookie(SESSION_COOKIE, sessionId, { maxAge: SESSION_TTL }));
      headers.append('Set-Cookie', clearCookie('oauth_state', '/api/auth'));
      return new Response(null, { status: 302, headers });
    } catch (e) {
      return new Response('Google login failed: ' + e.message, { status: 502 });
    }
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    await destroySession(env, request);
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(SESSION_COOKIE) });
  }

  if (path === '/api/auth/me' && method === 'GET') {
    const user = await getSession(env, request);
    if (!user) return json({ loggedIn: false });
    return json({ loggedIn: true, email: user.email, name: user.name, picture: user.picture });
  }

  return json({ error: 'not found' }, 404);
}

// ---------------------------------------------------------------------------
// GitHub connection — per-user config, same GitHub-facing logic as before.
// ---------------------------------------------------------------------------

const DEFAULT_GITHUB_CONFIG = { enabled: false, owner: null, repo: null, token: null };

async function loadGithubConfig(env, uid) {
  const raw = await env.GH_CONFIG.get('github_config:' + uid);
  if (!raw) return { ...DEFAULT_GITHUB_CONFIG };
  try {
    const c = JSON.parse(raw);
    return { enabled: !!c.enabled, owner: c.owner || null, repo: c.repo || null, token: c.token || null };
  } catch { return { ...DEFAULT_GITHUB_CONFIG }; }
}

async function saveGithubConfig(env, uid, config) {
  await env.GH_CONFIG.put('github_config:' + uid, JSON.stringify(config));
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

async function handleGithubApi(request, env, path, uid) {
  const method = request.method;

  // Read: never expose the raw token, only whether one is set.
  if (path === '/api/github/config' && method === 'GET') {
    const config = await loadGithubConfig(env, uid);
    return json({ enabled: config.enabled, hasToken: !!config.token, owner: config.owner, repo: config.repo });
  }

  if (path === '/api/github/config' && method === 'POST') {
    const config = await loadGithubConfig(env, uid);
    const b = await request.json().catch(() => ({}));
    if (typeof b.enabled === 'boolean') config.enabled = b.enabled;
    if (typeof b.owner === 'string' && b.owner.trim()) config.owner = b.owner.trim();
    if (typeof b.repo === 'string' && b.repo.trim()) config.repo = b.repo.trim();
    if (typeof b.token === 'string' && b.token.trim()) config.token = b.token.trim();
    if (b.token === null) config.token = null;
    await saveGithubConfig(env, uid, config);
    return json({ ok: true, enabled: config.enabled, hasToken: !!config.token });
  }

  // GET = cheap poll (header dot / MVP chip), POST = forced fresh check after Save+Test.
  // Both behave identically here since this Worker doesn't cache; see note in connectionStatus.
  if (path === '/api/github/status' && (method === 'GET' || method === 'POST')) {
    const config = await loadGithubConfig(env, uid);
    return json(await connectionStatus(config));
  }

  if (path === '/api/github/issues' && method === 'GET') {
    const config = await loadGithubConfig(env, uid);
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
    const config = await loadGithubConfig(env, uid);
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

// ---------------------------------------------------------------------------
// Model connection — per-user config, same GH_CONFIG namespace under a different key prefix.
// ---------------------------------------------------------------------------

const BUILTIN_MODELS = [
  { id: 'claude-sonnet', label: 'Claude Sonnet', builtin: true },
  { id: 'claude-opus', label: 'Claude Opus', builtin: true },
  { id: 'claude-haiku', label: 'Claude Haiku', builtin: true }
];

// Cap on the "recently disconnected" favorites list (see /api/models/delete and /reconnect).
const RECENT_LIMIT = 5;

async function loadModelsConfig(env, uid) {
  const raw = await env.GH_CONFIG.get('models_config:' + uid);
  let cfg = null;
  if (raw) { try { cfg = JSON.parse(raw); } catch {} }
  if (!cfg || !Array.isArray(cfg.models)) cfg = { models: BUILTIN_MODELS.map(m => ({ ...m })), selectedId: 'claude-sonnet' };
  if (!Array.isArray(cfg.recent)) cfg.recent = [];
  // Guarantee the built-ins always exist, same as server.js, so the list can't end up empty.
  BUILTIN_MODELS.forEach(b => { if (!cfg.models.some(m => m.id === b.id)) cfg.models.unshift({ ...b }); });
  if (!cfg.models.some(m => m.id === cfg.selectedId)) cfg.selectedId = cfg.models[0].id;
  return cfg;
}

async function saveModelsConfig(env, uid, cfg) {
  await env.GH_CONFIG.put('models_config:' + uid, JSON.stringify(cfg));
}

// Never leak raw API keys to the browser.
function publicModels(cfg) {
  return {
    selectedId: cfg.selectedId,
    models: cfg.models.map(m => ({
      id: m.id, label: m.label, builtin: !!m.builtin,
      provider: m.provider || null, baseUrl: m.baseUrl || null, model: m.model || null,
      hasKey: !!m.apiKey
    })),
    // Removed external models, most-recent first — kept (including their key) so "reconnect"
    // is a single click instead of retyping everything. Capped at RECENT_LIMIT.
    recent: cfg.recent.map(m => ({
      id: m.id, label: m.label, provider: m.provider || null,
      baseUrl: m.baseUrl || null, model: m.model || null, hasKey: !!m.apiKey
    }))
  };
}

// Shared provider call (OpenAI-compatible chat/completions, or Gemini generateContent).
// Returns the raw text reply. Used by the cheap connection ping (testModel), the real chat
// endpoint (handleChat), so there's one place that knows how to talk to each provider.
async function callModel(m, prompt, maxTokens) {
  if (m.provider === 'openai') {
    const r = await fetch(`${m.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${m.apiKey}` },
      body: JSON.stringify({ model: m.model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${m.model}:generateContent?key=${encodeURIComponent(m.apiKey)}`;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens } }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
  return (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts &&
    j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text) || '';
}

// Real minimal ping to the provider so "connected" means the key actually works, not just
// that a value is present — mirrors server.js's /api/models/test.
async function testModel(m) {
  if (m.builtin) {
    return { ok: true, builtin: true,
      message: 'מודל מובנה (Claude) — רץ דרך סשן Claude Code שמושך את התור, לא דרך מפתח API. "מחובר" = יש סשן פעיל שעובד על התור.' };
  }
  if (!m.apiKey) return { error: 'לא הוגדר מפתח API למודל הזה.', status: 400 };
  try {
    await callModel(m, 'ping', 1);
    return { ok: true, message: 'המודל הגיב בהצלחה — החיבור תקין.' };
  } catch (e) {
    return { error: e.message, status: 502 };
  }
}

async function handleModelsApi(request, env, path, uid) {
  const method = request.method;

  if (path === '/api/models' && method === 'GET') {
    return json(publicModels(await loadModelsConfig(env, uid)));
  }

  if (path === '/api/models/select' && method === 'POST') {
    const cfg = await loadModelsConfig(env, uid);
    const b = await request.json().catch(() => ({}));
    if (!cfg.models.some(m => m.id === b.id)) return new Response('no such model', { status: 404 });
    cfg.selectedId = b.id;
    await saveModelsConfig(env, uid, cfg);
    return json({ ok: true, selectedId: cfg.selectedId });
  }

  if (path === '/api/models/add' && method === 'POST') {
    const cfg = await loadModelsConfig(env, uid);
    const b = await request.json().catch(() => ({}));
    const label = (b.label || '').trim();
    if (!label) return new Response('missing label', { status: 400 });
    const m = {
      id: 'ext-' + Date.now(), builtin: false, label,
      provider: b.provider === 'openai' ? 'openai' : 'gemini',
      baseUrl: (b.baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, ''),
      model: (b.model || '').trim(),
      apiKey: (b.apiKey || '').trim() || null
    };
    cfg.models.push(m);
    if (b.select) cfg.selectedId = m.id;
    await saveModelsConfig(env, uid, cfg);
    return json({ ok: true, id: m.id });
  }

  if (path === '/api/models/update' && method === 'POST') {
    const cfg = await loadModelsConfig(env, uid);
    const b = await request.json().catch(() => ({}));
    const m = cfg.models.find(x => x.id === b.id);
    if (!m) return new Response('no such model', { status: 404 });
    if (m.builtin) return new Response('cannot edit a built-in model', { status: 400 });
    if (typeof b.label === 'string' && b.label.trim()) m.label = b.label.trim();
    if (b.provider === 'openai' || b.provider === 'gemini') m.provider = b.provider;
    if (typeof b.baseUrl === 'string' && b.baseUrl.trim()) m.baseUrl = b.baseUrl.trim().replace(/\/+$/, '');
    if (typeof b.model === 'string') m.model = b.model.trim();
    if (typeof b.apiKey === 'string' && b.apiKey.trim()) m.apiKey = b.apiKey.trim();
    if (b.apiKey === null) m.apiKey = null;
    await saveModelsConfig(env, uid, cfg);
    return json({ ok: true });
  }

  if (path === '/api/models/delete' && method === 'POST') {
    const cfg = await loadModelsConfig(env, uid);
    const b = await request.json().catch(() => ({}));
    const m = cfg.models.find(x => x.id === b.id);
    if (!m) return new Response('no such model', { status: 404 });
    if (m.builtin) return new Response('cannot delete a built-in model', { status: 400 });
    cfg.models = cfg.models.filter(x => x.id !== b.id);
    if (cfg.selectedId === b.id) cfg.selectedId = cfg.models[0].id;
    // Archive it (full config, including the key) instead of discarding, so it can be
    // one-click restored from "recent" without retyping the label/provider/URL/model/key.
    cfg.recent = [m, ...cfg.recent.filter(x => x.id !== m.id)].slice(0, RECENT_LIMIT);
    await saveModelsConfig(env, uid, cfg);
    return json({ ok: true, selectedId: cfg.selectedId });
  }

  // Restores a previously-removed external model from "recent" back into the active list,
  // with a fresh id (the old one may already be reused) and selects it — no retyping needed.
  if (path === '/api/models/reconnect' && method === 'POST') {
    const cfg = await loadModelsConfig(env, uid);
    const b = await request.json().catch(() => ({}));
    const idx = cfg.recent.findIndex(x => x.id === b.id);
    if (idx === -1) return new Response('no such recent model', { status: 404 });
    const old = cfg.recent[idx];
    cfg.recent.splice(idx, 1);
    const m = { ...old, id: 'ext-' + Date.now() };
    cfg.models.push(m);
    cfg.selectedId = m.id;
    await saveModelsConfig(env, uid, cfg);
    return json({ ok: true, id: m.id, selectedId: cfg.selectedId });
  }

  if (path === '/api/models/test' && method === 'POST') {
    const cfg = await loadModelsConfig(env, uid);
    const b = await request.json().catch(() => ({}));
    const m = cfg.models.find(x => x.id === (b.id || cfg.selectedId));
    if (!m) return new Response('no such model', { status: 404 });
    const { status, ...result } = await testModel(m);
    return json(result, status || 200);
  }

  return json({ error: 'not found' }, 404);
}

// ---------------------------------------------------------------------------
// Workspace: the projects/libraries a user organizes their work around. Same
// shape and endpoints as server.js's local-only version, ported to per-user KV
// so it actually works on the deployed site instead of 404ing.
// ---------------------------------------------------------------------------

const DEFAULT_WORKSPACE = {
  projects: [],
  libraries: [],
  selectedProjectId: null,
  selectedLibraryId: null
};

function emptyWorkspace() {
  return { projects: [], libraries: [], selectedProjectId: null, selectedLibraryId: null };
}

function isSeedProject(p) {
  return p && (
    (p.id === 'ontrack' && p.name === 'ON TracK' && p.note === 'Main workspace') ||
    (p.id === 'sandbox' && p.name === 'Sandbox' && p.note === 'Experiment space') ||
    (p.id === 'research' && p.name === 'Research' && p.note === 'Ideas and notes')
  );
}

function isSeedLibrary(l) {
  return l && (
    (l.id === 'docs' && l.name === 'Project Docs' && l.note === 'Specs and guides') ||
    (l.id === 'design' && l.name === 'Design System') ||
    (l.id === 'assets' && l.name === 'Shared Assets')
  );
}

async function loadWorkspace(env, uid) {
  const raw = await env.GH_CONFIG.get('workspace_config:' + uid);
  let ws = null;
  if (raw) { try { ws = JSON.parse(raw); } catch {} }
  let changed = false;
  if (!ws || typeof ws !== 'object') { ws = emptyWorkspace(); changed = !!raw; }
  if (!Array.isArray(ws.projects)) { ws.projects = []; changed = true; }
  if (!Array.isArray(ws.libraries)) { ws.libraries = []; changed = true; }
  const projectsBefore = ws.projects.length;
  const librariesBefore = ws.libraries.length;
  ws.projects = ws.projects.filter(p => !isSeedProject(p));
  ws.libraries = ws.libraries.filter(l => !isSeedLibrary(l));
  changed = changed || projectsBefore !== ws.projects.length || librariesBefore !== ws.libraries.length;
  if (!ws.projects.some(p => p.id === ws.selectedProjectId)) ws.selectedProjectId = ws.projects[0]?.id || null;
  if (!ws.libraries.some(l => l.id === ws.selectedLibraryId)) ws.selectedLibraryId = ws.libraries[0]?.id || null;
  if (changed) await saveWorkspace(env, uid, ws);
  return ws;
}

async function saveWorkspace(env, uid, ws) {
  await env.GH_CONFIG.put('workspace_config:' + uid, JSON.stringify(ws));
}

function workspaceSummary(ws) {
  return {
    workspace: ws,
    selectedProject: ws.projects.find(p => p.id === ws.selectedProjectId) || ws.projects[0] || null,
    selectedLibrary: ws.libraries.find(l => l.id === ws.selectedLibraryId) || ws.libraries[0] || null
  };
}

function slugifyId(raw) {
  return raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
}

async function handleWorkspaceApi(request, env, path, uid) {
  const method = request.method;

  if (path === '/api/workspace' && method === 'GET') {
    return json(workspaceSummary(await loadWorkspace(env, uid)));
  }

  if (path === '/api/workspace/select' && method === 'POST') {
    const ws = await loadWorkspace(env, uid);
    const b = await request.json().catch(() => ({}));
    if (typeof b.projectId === 'string' && ws.projects.some(p => p.id === b.projectId)) ws.selectedProjectId = b.projectId;
    if (typeof b.libraryId === 'string' && ws.libraries.some(l => l.id === b.libraryId)) ws.selectedLibraryId = b.libraryId;
    await saveWorkspace(env, uid, ws);
    return json(workspaceSummary(ws));
  }

  if (path === '/api/workspace/projects' && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name) return json({ error: 'חסר שם פרויקט' }, 400);
    const ws = await loadWorkspace(env, uid);
    const id = (typeof b.id === 'string' && b.id.trim()) ? slugifyId(b.id) : ('proj-' + Date.now());
    if (ws.projects.some(p => p.id === id)) return json({ error: 'פרויקט עם המזהה הזה כבר קיים' }, 409);
    ws.projects.push({
      id, name,
      status: typeof b.status === 'string' && b.status.trim() ? b.status.trim() : 'idle',
      note: typeof b.note === 'string' ? b.note.trim() : '',
      description: typeof b.description === 'string' ? b.description.trim() : ''
    });
    ws.selectedProjectId = id;
    await saveWorkspace(env, uid, ws);
    return json(workspaceSummary(ws));
  }

  if (path === '/api/workspace/projects/update' && method === 'POST') {
    const ws = await loadWorkspace(env, uid);
    const b = await request.json().catch(() => ({}));
    const id = typeof b.id === 'string' ? b.id.trim() : '';
    const project = ws.projects.find(p => p.id === id);
    if (!project) return json({ error: 'הפרויקט לא נמצא' }, 404);
    if (typeof b.name === 'string' && b.name.trim()) project.name = b.name.trim();
    if (typeof b.status === 'string' && b.status.trim()) project.status = b.status.trim();
    if (typeof b.note === 'string') project.note = b.note.trim();
    if (typeof b.description === 'string') project.description = b.description.trim();
    if (typeof b.projectId === 'string' && b.projectId.trim()) {
      const nextId = slugifyId(b.projectId);
      if (nextId !== project.id && !ws.projects.some(p => p.id === nextId)) {
        project.id = nextId;
        ws.selectedProjectId = nextId;
      }
    }
    await saveWorkspace(env, uid, ws);
    return json(workspaceSummary(ws));
  }

  if (path === '/api/workspace/projects/open' && method === 'POST') {
    const ws = await loadWorkspace(env, uid);
    const b = await request.json().catch(() => ({}));
    const project = ws.projects.find(p => p.id === b.id);
    if (!project) return json({ error: 'הפרויקט לא נמצא' }, 404);
    ws.selectedProjectId = project.id;
    await saveWorkspace(env, uid, ws);
    return json(workspaceSummary(ws));
  }

  if (path === '/api/workspace/projects/delete' && method === 'POST') {
    const ws = await loadWorkspace(env, uid);
    const b = await request.json().catch(() => ({}));
    const id = typeof b.id === 'string' ? b.id.trim() : '';
    const index = ws.projects.findIndex(p => p.id === id);
    if (index < 0) return json({ error: 'הפרויקט לא נמצא' }, 404);
    if (ws.projects.length <= 1) return json({ error: 'לא ניתן למחוק את הפרויקט האחרון' }, 400);
    ws.projects.splice(index, 1);
    if (ws.selectedProjectId === id) ws.selectedProjectId = ws.projects[0].id;
    await saveWorkspace(env, uid, ws);
    return json(workspaceSummary(ws));
  }

  return json({ error: 'not found' }, 404);
}

// ---------------------------------------------------------------------------
// Home-screen chat: sends the prompt to the user's own selected model.
// ---------------------------------------------------------------------------

async function handleChat(request, env, uid) {
  if (request.method !== 'POST') return json({ error: 'not found' }, 404);
  const cfg = await loadModelsConfig(env, uid);
  const m = cfg.models.find(x => x.id === cfg.selectedId);
  if (!m) return json({ error: 'לא נבחר מודל.' }, 400);
  const b = await request.json().catch(() => ({}));
  const prompt = (b.prompt || '').trim();
  if (!prompt) return json({ error: 'ההודעה ריקה.' }, 400);
  if (m.builtin) {
    return json({ reply: 'מודל מובנה (Claude) לא עונה ישירות מכאן — הוא פועל דרך סשן Claude Code שמושך את התור. כדי לשוחח איתו, יש להשתמש בסשן Claude Code שלך.' });
  }
  if (!m.apiKey) return json({ error: 'לא הוגדר מפתח API למודל הנבחר. פתח "חיבור למודל" והוסף מפתח.' }, 400);
  try {
    const reply = await callModel(m, prompt, 1024);
    return json({ reply: reply || '(תשובה ריקה מהמודל)' });
  } catch (e) {
    return json({ error: e.message }, 502);
  }
}

// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith('/api/auth/')) return handleAuth(request, env, url, path);

    const needsAuth = path.startsWith('/api/github/') || path.startsWith('/api/models') || path === '/api/chat' || path.startsWith('/api/workspace');
    if (needsAuth) {
      const user = await getSession(env, request);
      if (!user) return json({ error: 'לא מחובר. יש להתחבר עם Google כדי להשתמש בתכונה הזו.', loginRequired: true }, 401);
      if (path.startsWith('/api/github/')) return handleGithubApi(request, env, path, user.uid);
      if (path.startsWith('/api/models')) return handleModelsApi(request, env, path, user.uid);
      if (path === '/api/chat') return handleChat(request, env, user.uid);
      if (path.startsWith('/api/workspace')) return handleWorkspaceApi(request, env, path, user.uid);
    }

    return env.ASSETS.fetch(request);
  }
};
