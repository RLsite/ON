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
// ON TracK agent bridge — the model never receives the GitHub token. It plans
// through a small JSON contract, while this Worker performs the actual API
// calls and keeps write operations behind an explicit user approval.
// ---------------------------------------------------------------------------

function githubRepoBase(config) {
  return `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
}

function githubPath(path) {
  return String(path || '').split('/').map(encodeURIComponent).join('/');
}

async function githubApi(config, suffix = '', options = {}) {
  const headers = { ...ghHeaders(config), 'Content-Type': 'application/json' };
  const response = await fetch(githubRepoBase(config) + suffix, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = { message: raw.slice(0, 500) }; }
  if (!response.ok) {
    const error = new Error(data?.message || `GitHub API returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function safeAgentPath(value) {
  const path = typeof value === 'string' ? value.trim() : '';
  if (!path || path.length > 240 || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) return null;
  return path;
}

function safeAgentBranch(value) {
  const branch = typeof value === 'string' ? value.trim() : '';
  if (!branch || branch.length > 200 || branch.startsWith('/') || branch.endsWith('/') || branch.includes('..') || /[~^:?*\[\\\s]/.test(branch)) return null;
  return branch;
}

function encodeBase64Utf8(value) {
  const bytes = new TextEncoder().encode(String(value));
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function decodeBase64Utf8(value) {
  const binary = atob(String(value || '').replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function loadAgentRepoContext(config) {
  const repo = await githubApi(config);
  const defaultBranch = repo.default_branch || 'main';
  let paths = [];
  try {
    const tree = await githubApi(config, `/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`);
    paths = Array.isArray(tree?.tree) ? tree.tree.filter(item => item.type === 'blob').map(item => item.path).slice(0, 240) : [];
  } catch {}
  let skill = null;
  try {
    const file = await githubApi(config, `/contents/AGENT_SKILL.md?ref=${encodeURIComponent(defaultBranch)}`);
    if (file?.type === 'file' && typeof file.content === 'string') skill = decodeBase64Utf8(file.content).slice(0, 18000);
  } catch {}
  return {
    fullName: repo.full_name || `${config.owner}/${config.repo}`,
    private: !!repo.private,
    defaultBranch,
    permissions: repo.permissions || null,
    paths,
    skill
  };
}

function agentSystemPrompt(githubConnected, repoContext, dataSharingAuthorized) {
  const repoText = repoContext
    ? JSON.stringify(repoContext)
    : 'null';
  return `You are the ON TracK project agent. You work for the user through a secure server bridge.
The server, not you, holds the GitHub token. Never ask for, reveal, invent, or echo a token.
You do not browse GitHub directly. You may request only the tools listed below; ON executes them.
GitHub connected: ${githubConnected ? 'yes' : 'no'}.
Private repository data sharing authorized for this session: ${dataSharingAuthorized ? 'yes' : 'no'}.
Repository context (safe metadata only): ${repoText}

Available tools:
- github.list_files: read the repository file tree. Arguments: branch (optional).
- github.read_file: read one text file. Arguments: path, branch (optional).
- github.apply_patch: prepare a small unified diff for an existing text file. Arguments: path, patch, message, branch (optional). Prefer this for existing files.
- github.write_file: prepare a complete replacement for one new or small text file. Arguments: path, content, message.
- github.create_pull_request: after file changes, request a Pull Request. Arguments: title, body, base (optional).

Write actions are never executed immediately. They are shown to the user and require approval.
For any request involving a file or repository, do not claim that you completed it unless ON returns an execution result.
If you need file contents, first return a read action. If read results are supplied in a later message, use them and then return the smallest complete plan.
For an existing file, use github.apply_patch with the smallest focused diff instead of returning the entire file. Use github.write_file only for a new file or when a complete replacement is genuinely small.
Do not narrate intentions as if they were actions. Never answer with phrases such as "I'll read...", "I will update...", or "Reading...". Request the tool in the JSON plan instead.
Do not use unsupported tools, do not output shell commands as if they were executed, and do not make up file contents.

Return JSON only, with this shape:
For an answer: {"kind":"answer","reply":"...","actions":[]}
For work: {"kind":"plan","reply":"Short explanation in the user's language","actions":[{"tool":"github.read_file","path":"..."}]}
Use the user's language. Keep replies concise. A write_file action must contain the full intended file content and a short commit message.
An apply_patch action must contain a valid unified diff for one file and a short commit message. Return exactly one JSON object and no Markdown fences.
${githubConnected && dataSharingAuthorized ? '' : 'Repository access is not authorized for this request. Explain that clearly and do not create GitHub actions.'}`;
}

function agentWriteTool(tool) {
  return tool === 'github.write_file' || tool === 'github.apply_patch' || tool === 'github.create_pull_request';
}

function agentRepairPrompt(rawText) {
  return `Your previous response did not follow the ON TracK Agent contract. Convert it now and return exactly one JSON object, with no Markdown and no narration.
If you need repository information, return a plan with github.read_file or github.list_files.
If you want to change an existing file, return github.apply_patch with a small unified diff.
If no tool is needed, return {"kind":"answer","reply":"...","actions":[]}.
Do not say that you will read or change something; request the tool in actions instead.
Previous response:
${String(rawText || '').slice(0, 8000)}`;
}

function normalizeAgentPlan(rawText) {
  const source = String(rawText || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed;
  try { parsed = JSON.parse(source.slice(start, end + 1)); } catch { return null; }
  if (!parsed || !['answer', 'plan'].includes(parsed.kind)) return null;
  const actions = Array.isArray(parsed.actions) ? parsed.actions.slice(0, 6).map(action => ({ ...action, tool: String(action.tool || '') })) : [];
  return { kind: parsed.kind, reply: String(parsed.reply || '').slice(0, 6000), actions };
}

function validateAgentPlan(plan, githubConnected) {
  if (!plan || plan.kind === 'answer') return null;
  if (!githubConnected) return 'GitHub is not connected.';
  if (!Array.isArray(plan.actions) || !plan.actions.length) return 'The model returned an empty action plan.';
  const allowed = new Set(['github.list_files', 'github.read_file', 'github.write_file', 'github.create_pull_request']);
  let hasWrite = false;
  for (const action of plan.actions) {
    if (!allowed.has(action.tool)) return `Unsupported agent tool: ${action.tool}`;
    if (action.tool === 'github.list_files') {
      if (action.branch && !safeAgentBranch(action.branch)) return 'Invalid branch name.';
      continue;
    }
    if (action.tool === 'github.read_file' || action.tool === 'github.write_file') {
      if (!safeAgentPath(action.path)) return 'Invalid repository file path.';
      if (action.branch && !safeAgentBranch(action.branch)) return 'Invalid branch name.';
    }
    if (action.tool === 'github.apply_patch') {
      if (!safeAgentPath(action.path)) return 'Invalid repository file path.';
      if (action.branch && !safeAgentBranch(action.branch)) return 'Invalid branch name.';
      if (typeof action.patch !== 'string' || !action.patch.trim() || action.patch.length > 80000) return 'The proposed patch is missing or too large.';
      if (!String(action.message || '').trim() || String(action.message).length > 180) return 'The proposed commit message is missing or too long.';
      hasWrite = true;
    }
    if (action.tool === 'github.write_file') {
      hasWrite = true;
      if (typeof action.content !== 'string' || action.content.length > 300000) return 'The proposed file content is missing or too large.';
      if (!String(action.message || '').trim() || String(action.message).length > 180) return 'The proposed commit message is missing or too long.';
    }
    if (action.tool === 'github.create_pull_request') {
      hasWrite = true;
      if (!String(action.title || '').trim() || String(action.title).length > 180) return 'The Pull Request title is missing or too long.';
      if (action.base && !safeAgentBranch(action.base)) return 'Invalid Pull Request base branch.';
    }
  }
  if (plan.actions.some(action => action.tool === 'github.create_pull_request') && !plan.actions.some(action => action.tool === 'github.write_file' || action.tool === 'github.apply_patch')) {
    return 'A Pull Request requires at least one file change.';
  }
  return hasWrite ? null : null;
}

function publicAgentPlan(plan) {
  return {
    kind: plan.kind,
    reply: plan.reply,
    actions: plan.actions.map(action => ({
      tool: action.tool,
      path: action.path || null,
      branch: action.branch || null,
      message: action.message || null,
      title: action.title || null,
      body: action.body ? String(action.body).slice(0, 1200) : null,
      contentLength: typeof action.content === 'string' ? action.content.length : (typeof action.patch === 'string' ? action.patch.length : null)
    }))
  };
}

function applyUnifiedPatch(original, patchText) {
  const source = String(original || '').replace(/\r\n/g, '\n');
  const rawLines = String(patchText || '').replace(/\r\n/g, '\n').split('\n');
  const hunks = [];
  for (let i = 0; i < rawLines.length; i++) {
    const header = rawLines[i].match(/^@@\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@@/);
    if (!header) continue;
    const oldStart = Math.max(1, Number(header[1]));
    const lines = [];
    for (i += 1; i < rawLines.length && !/^@@\s*-\d+/.test(rawLines[i]); i++) {
      const line = rawLines[i];
      if (line === '\\ No newline at end of file') continue;
      if (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-')) lines.push(line);
    }
    i -= 1;
    hunks.push({ oldStart, lines });
  }
  if (!hunks.length) throw new Error('The model returned an invalid unified patch.');
  const output = source.split('\n');
  let searchFrom = 0;
  for (const hunk of hunks) {
    const oldLines = hunk.lines.filter(line => line[0] === ' ' || line[0] === '-').map(line => line.slice(1));
    const newLines = hunk.lines.filter(line => line[0] === ' ' || line[0] === '+').map(line => line.slice(1));
    const preferred = Math.min(output.length, Math.max(0, hunk.oldStart - 1));
    let found = -1;
    for (const start of [preferred, searchFrom]) {
      if (start < 0 || start > output.length) continue;
      let matches = true;
      for (let j = 0; j < oldLines.length; j++) if (output[start + j] !== oldLines[j]) { matches = false; break; }
      if (matches) { found = start; break; }
    }
    if (found < 0) {
      for (let start = searchFrom; start <= output.length - oldLines.length; start++) {
        let matches = true;
        for (let j = 0; j < oldLines.length; j++) if (output[start + j] !== oldLines[j]) { matches = false; break; }
        if (matches) { found = start; break; }
      }
    }
    if (found < 0) throw new Error(`The patch context did not match ${hunk.oldStart}.`);
    output.splice(found, oldLines.length, ...newLines);
    searchFrom = found + newLines.length;
  }
  return output.join('\n');
}

async function executeAgentReadActions(config, actions, defaultBranch) {
  const results = [];
  for (const action of actions) {
    const branch = safeAgentBranch(action.branch) || defaultBranch;
    if (action.tool === 'github.list_files') {
      const tree = await githubApi(config, `/git/trees/${encodeURIComponent(branch)}?recursive=1`);
      const files = Array.isArray(tree?.tree) ? tree.tree.filter(item => item.type === 'blob').map(item => item.path).slice(0, 400) : [];
      results.push({ tool: action.tool, branch, files });
    } else if (action.tool === 'github.read_file') {
      const file = await githubApi(config, `/contents/${githubPath(action.path)}?ref=${encodeURIComponent(branch)}`);
      if (file?.type !== 'file' || typeof file.content !== 'string') throw new Error(`GitHub path is not a text file: ${action.path}`);
      const content = decodeBase64Utf8(file.content);
      results.push({ tool: action.tool, path: action.path, branch, sha: file.sha || null, content: content.slice(0, 50000), truncated: content.length > 50000 });
    }
  }
  return results;
}

function agentToolResultsPrompt(results) {
  return `ON executed these read-only GitHub tools. Use only these results; do not claim other access. Return the final JSON plan now.\n${JSON.stringify(results).slice(0, 70000)}`;
}

async function executeAgentWritePlan(config, plan, planId) {
  const repo = await githubApi(config);
  const baseBranch = safeAgentBranch(plan.actions.find(action => action.base)?.base) || repo.default_branch || 'main';
  const baseRef = await githubApi(config, `/git/ref/heads/${encodeURIComponent(baseBranch)}`);
  const branch = `ontrack/agent-${String(planId).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 18)}`;
  await githubApi(config, '/git/refs', {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseRef.object.sha })
  });
  const files = [];
  for (const action of plan.actions.filter(item => item.tool === 'github.write_file' || item.tool === 'github.apply_patch')) {
    const path = safeAgentPath(action.path);
    const ref = safeAgentBranch(action.branch) || branch;
    let current = null;
    try { current = await githubApi(config, `/contents/${githubPath(path)}?ref=${encodeURIComponent(ref)}`); }
    catch (e) { if (e.status !== 404) throw e; }
    let content = action.content;
    let actionName = 'updated';
    if (action.tool === 'github.apply_patch') {
      if (!current?.content) throw new Error(`Cannot patch a file that does not exist: ${path}`);
      content = applyUnifiedPatch(decodeBase64Utf8(current.content), action.patch);
      actionName = 'patched';
    }
    const body = { message: String(action.message).trim(), content: encodeBase64Utf8(content), branch: ref };
    if (current?.sha) body.sha = current.sha;
    const updated = await githubApi(config, `/contents/${githubPath(path)}`, { method: 'PUT', body: JSON.stringify(body) });
    files.push({ path, action: current?.sha ? actionName : 'created', commit: updated?.commit?.sha || null });
  }
  let pullRequest = null;
  const pullAction = plan.actions.find(item => item.tool === 'github.create_pull_request');
  if (pullAction) {
    const pr = await githubApi(config, '/pulls', {
      method: 'POST',
      body: JSON.stringify({
        title: String(pullAction.title).trim(),
        body: String(pullAction.body || '').trim(),
        head: branch,
        base: safeAgentBranch(pullAction.base) || baseBranch
      })
    });
    pullRequest = { number: pr.number, url: pr.html_url, title: pr.title };
  }
  return { branch, baseBranch, files, pullRequest };
}

async function handleAgentApproval(request, env, uid) {
  if (request.method !== 'POST') return json({ error: 'not found' }, 404);
  const body = await request.json().catch(() => ({}));
  const planId = typeof body.planId === 'string' ? body.planId.trim() : '';
  if (!planId || !/^[a-zA-Z0-9-]{12,80}$/.test(planId)) return json({ error: 'Invalid or expired agent plan.' }, 400);
  const key = `agent_plan:${uid}:${planId}`;
  const raw = await env.GH_CONFIG.get(key);
  if (!raw) return json({ error: 'This agent plan has expired. Send the request again.' }, 410);
  await env.GH_CONFIG.delete(key);
  let stored;
  try { stored = JSON.parse(raw); } catch { return json({ error: 'Invalid agent plan.' }, 400); }
  const consent = await loadAgentConsent(env, uid);
  if (!consent.enabled) return json({ error: 'Agent repository access is disabled. Enable it again and send the request again.' }, 403);
  const config = await loadGithubConfig(env, uid);
  if (!config.enabled || !config.owner || !config.repo || !config.token) return json({ error: 'GitHub is not connected for this account.' }, 400);
  try {
    const result = await executeAgentWritePlan(config, stored.plan, planId);
    return json({ ok: true, result });
  } catch (e) {
    return json({ error: e.message || 'GitHub write failed.' }, e.status === 401 || e.status === 403 ? 502 : 502);
  }
}

async function loadAgentConsent(env, uid) {
  const raw = await env.GH_CONFIG.get('agent_consent:' + uid);
  if (!raw) return { enabled: false, updated: null, modelId: null, scopes: [] };
  try {
    const value = JSON.parse(raw);
    return { enabled: !!value.enabled, updated: value.updated || null, approvedAt: value.approvedAt || null, modelId: value.modelId || null, provider: value.provider || null, model: value.model || null, label: value.label || null, scopes: Array.isArray(value.scopes) ? value.scopes : [] };
  } catch { return { enabled: false, updated: null, modelId: null, scopes: [] }; }
}

async function handleAgentApi(request, env, path, uid) {
  if (path === '/api/agent/status' && request.method === 'GET') {
    const consent = await loadAgentConsent(env, uid);
    const github = await loadGithubConfig(env, uid);
    const models = await loadModelsConfig(env, uid);
    const selectedModel = models.models.find(item => item.id === models.selectedId) || null;
    const workspace = await loadWorkspace(env, uid);
    return json({
      enabled: consent.enabled,
      updated: consent.updated,
      approvedAt: consent.approvedAt,
      consentModelId: consent.modelId,
      consentLabel: consent.label,
      scopes: consent.scopes,
      selectedModel: selectedModel ? { id: selectedModel.id, label: selectedModel.label, builtin: !!selectedModel.builtin, provider: selectedModel.provider || null, model: selectedModel.model || null } : null,
      matchesSelectedModel: !!(consent.enabled && selectedModel && consent.modelId === selectedModel.id),
      githubConfigured: !!(github.enabled && github.owner && github.repo && github.token),
      repository: github.owner && github.repo ? `${github.owner}/${github.repo}` : null,
      skillFolders: workspace.libraries.filter(item => item.type === 'skill-folder').map(item => ({ id: item.id, name: item.name, location: item.location }))
    });
  }
  if (path === '/api/agent/consent' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const enabled = body.enabled === true;
    const models = await loadModelsConfig(env, uid);
    const selectedModel = models.models.find(item => item.id === models.selectedId) || null;
    if (enabled && (!selectedModel || selectedModel.builtin || selectedModel.id !== body.modelId)) {
      return json({ error: 'Select the external model you want to authorize, then try again.' }, 400);
    }
    const scopes = enabled && Array.isArray(body.scopes) ? body.scopes.filter(item => ['repo_metadata', 'file_contents', 'skill_contents'].includes(item)) : [];
    if (enabled && !scopes.includes('repo_metadata')) return json({ error: 'Repository metadata permission is required.' }, 400);
    const now = new Date().toISOString();
    const value = enabled ? {
      enabled: true, updated: now, approvedAt: now,
      modelId: selectedModel.id, label: selectedModel.label,
      provider: selectedModel.provider || null, model: selectedModel.model || null,
      scopes
    } : { enabled: false, updated: now, approvedAt: null, modelId: null, label: null, provider: null, model: null, scopes: [] };
    await env.GH_CONFIG.put('agent_consent:' + uid, JSON.stringify(value));
    return json({ ok: true, ...value });
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
function modelKeyError(apiKey) {
  if (/^(?:github_pat_|gh[psour]_)/i.test(String(apiKey || '').trim())) {
    return 'This key looks like a GitHub token. Enter the model provider API key here, not the GitHub token.';
  }
  return null;
}

function parseImagePart(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null;
  const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!m || m[2].length > 8 * 1024 * 1024) return null;
  return { mime: m[1].toLowerCase(), data: m[2] };
}
function publicModels(cfg) {
  return {
    selectedId: cfg.selectedId,
    models: cfg.models.map(m => ({
      id: m.id, label: m.label, builtin: !!m.builtin,
      provider: m.provider || null, baseUrl: m.baseUrl || null, model: m.model || null,
      hasKey: !!m.apiKey, keyLooksLikeGithub: !!modelKeyError(m.apiKey)
    })),
    // Removed external models, most-recent first — kept (including their key) so "reconnect"
    // is a single click instead of retyping everything. Capped at RECENT_LIMIT.
    recent: cfg.recent.map(m => ({
      id: m.id, label: m.label, provider: m.provider || null,
      baseUrl: m.baseUrl || null, model: m.model || null, hasKey: !!m.apiKey,
      keyLooksLikeGithub: !!modelKeyError(m.apiKey)
    }))
  };
}

// Shared provider call (OpenAI-compatible chat/completions, or Gemini generateContent).
// Returns the raw text reply. Used by the cheap connection ping (testModel), the real chat
// endpoint (handleChat), so there's one place that knows how to talk to each provider.
async function callModel(m, prompt, maxTokens, imagePart, systemPrompt) {
  const keyError = modelKeyError(m.apiKey);
  if (keyError) throw new Error(keyError);
  if (m.provider === 'openai') {
    const content = imagePart
      ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:${imagePart.mime};base64,${imagePart.data}` } }]
      : prompt;
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content });
    const r = await fetch(`${m.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${m.apiKey}` },
      body: JSON.stringify({ model: m.model, messages, max_tokens: maxTokens })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${m.model}:generateContent?key=${encodeURIComponent(m.apiKey)}`;
  const parts = [{ text: prompt }];
  if (imagePart) parts.push({ inline_data: { mime_type: imagePart.mime, data: imagePart.data } });
  const payload = { contents: [{ parts }], generationConfig: { maxOutputTokens: maxTokens } };
  if (systemPrompt) payload.systemInstruction = { parts: [{ text: systemPrompt }] };
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload) });
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
  const keyError = modelKeyError(m.apiKey);
  if (keyError) return { error: keyError, status: 400 };
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
    const keyError = modelKeyError(m.apiKey);
    if (keyError) return json({ error: keyError }, 400);
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
    const keyError = modelKeyError(m.apiKey);
    if (keyError) return json({ error: keyError }, 400);
    await saveModelsConfig(env, uid, cfg);
    return json({ ok: true });
  }

  if (path === '/api/models/delete' && method === 'POST') {
    const cfg = await loadModelsConfig(env, uid);
    const b = await request.json().catch(() => ({}));
    const m = cfg.models.find(x => x.id === b.id);
    if (!m) {
      const hadRecent = cfg.recent.some(x => x.id === b.id);
      if (!hadRecent) return new Response('no such model', { status: 404 });
      cfg.recent = cfg.recent.filter(x => x.id !== b.id);
      await saveModelsConfig(env, uid, cfg);
      return json({ ok: true, selectedId: cfg.selectedId });
    }
    if (m.builtin) return new Response('cannot delete a built-in model', { status: 400 });
    cfg.models = cfg.models.filter(x => x.id !== b.id);
    if (cfg.selectedId === b.id) cfg.selectedId = cfg.models[0].id;
    // Archive it (full config, including the key) instead of discarding, so it can be
    // one-click restored from "recent" without retyping the label/provider/URL/model/key.
    cfg.recent = cfg.recent.filter(x => x.id !== m.id);
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

  if (path === '/api/workspace/libraries' && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    const type = ['info-site', 'network-folder', 'local-folder', 'skill-folder'].includes(b.type) ? b.type : 'info-site';
    const location = typeof b.location === 'string' ? b.location.trim() : '';
    if (!name) return json({ error: 'Library name is required.' }, 400);
    if (!location) return json({ error: 'URL or path is required.' }, 400);
    const ws = await loadWorkspace(env, uid);
    const id = 'lib-' + Date.now();
    ws.libraries.push({ id, name, type, location, note: typeof b.note === 'string' ? b.note.trim() : '' });
    ws.selectedLibraryId = id;
    await saveWorkspace(env, uid, ws);
    return json(workspaceSummary(ws));
  }

  if (path === '/api/workspace/libraries/update' && method === 'POST') {
    const ws = await loadWorkspace(env, uid);
    const b = await request.json().catch(() => ({}));
    const library = ws.libraries.find(l => l.id === b.id);
    if (!library) return json({ error: 'Library not found.' }, 404);
    if (typeof b.name === 'string' && b.name.trim()) library.name = b.name.trim();
    if (['info-site', 'network-folder', 'local-folder', 'skill-folder'].includes(b.type)) library.type = b.type;
    if (typeof b.location === 'string' && b.location.trim()) library.location = b.location.trim();
    if (typeof b.note === 'string') library.note = b.note.trim();
    await saveWorkspace(env, uid, ws);
    return json(workspaceSummary(ws));
  }

  if (path === '/api/workspace/libraries/delete' && method === 'POST') {
    const ws = await loadWorkspace(env, uid);
    const b = await request.json().catch(() => ({}));
    const index = ws.libraries.findIndex(l => l.id === b.id);
    if (index < 0) return json({ error: 'Library not found.' }, 404);
    ws.libraries.splice(index, 1);
    if (ws.selectedLibraryId === b.id) ws.selectedLibraryId = ws.libraries[0]?.id || null;
    await saveWorkspace(env, uid, ws);
    return json(workspaceSummary(ws));
  }

  return json({ error: 'not found' }, 404);
}

// ---------------------------------------------------------------------------
// Home-screen chat: sends the prompt to the user's own selected model.
// ---------------------------------------------------------------------------

const CHAT_HISTORY_LIMIT = 40;

function compactChatEntry(entry) {
  return {
    id: crypto.randomUUID(),
    created: new Date().toISOString(),
    prompt: String(entry.prompt || '').slice(0, 8000),
    reply: String(entry.reply || '').slice(0, 12000),
    error: entry.error ? String(entry.error).slice(0, 2000) : null,
    imageAttached: !!entry.imageAttached,
    plan: entry.plan || null,
    planId: entry.planId || null,
    execution: entry.execution || null
  };
}

async function loadChatHistory(env, uid) {
  const raw = await env.GH_CONFIG.get('chat_history:' + uid);
  if (!raw) return [];
  try {
    const items = JSON.parse(raw);
    return Array.isArray(items) ? items.slice(-CHAT_HISTORY_LIMIT) : [];
  } catch { return []; }
}

async function appendChatHistory(env, uid, entry) {
  const history = await loadChatHistory(env, uid);
  const saved = compactChatEntry(entry);
  history.push(saved);
  await env.GH_CONFIG.put('chat_history:' + uid, JSON.stringify(history.slice(-CHAT_HISTORY_LIMIT)));
  return saved;
}

async function chatJson(env, uid, entry, payload, status = 200) {
  try {
    const saved = await appendChatHistory(env, uid, entry);
    if (payload && typeof payload === 'object') payload.historyId = saved.id;
  } catch {}
  return json(payload, status);
}

async function handleChatHistory(request, env, uid, path) {
  if (request.method === 'GET' && path === '/api/chat/history') return json({ history: await loadChatHistory(env, uid) });
  if (request.method === 'POST' && path === '/api/chat/clear') {
    await env.GH_CONFIG.delete('chat_history:' + uid);
    return json({ ok: true });
  }
  if (request.method === 'POST' && path === '/api/chat/delete') {
    const body = await request.json().catch(() => ({}));
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (!id) return json({ error: 'Missing conversation id.' }, 400);
    const history = await loadChatHistory(env, uid);
    const next = history.filter(item => item.id !== id);
    await env.GH_CONFIG.put('chat_history:' + uid, JSON.stringify(next));
    return json({ ok: true, deleted: next.length !== history.length });
  }
  return json({ error: 'not found' }, 404);
}

async function handleLegacyChat(request, env, uid) {
  if (request.method !== 'POST') return json({ error: 'not found' }, 404);
  const cfg = await loadModelsConfig(env, uid);
  const m = cfg.models.find(x => x.id === cfg.selectedId);
  if (!m) return json({ error: 'לא נבחר מודל.' }, 400);
  const b = await request.json().catch(() => ({}));
  const prompt = (b.prompt || '').trim();
  const imagePart = parseImagePart(b.image);
  if (!prompt) return json({ error: 'ההודעה ריקה.' }, 400);
  if (m.builtin) {
    return json({ reply: 'מודל מובנה (Claude) לא עונה ישירות מכאן — הוא פועל דרך סשן Claude Code שמושך את התור. כדי לשוחח איתו, יש להשתמש בסשן Claude Code שלך.' });
  }
  if (!m.apiKey) return json({ error: 'לא הוגדר מפתח API למודל הנבחר. פתח "חיבור למודל" והוסף מפתח.' }, 400);
  const keyError = modelKeyError(m.apiKey);
  if (keyError) return json({ error: keyError }, 400);
  try {
    const reply = await callModel(m, prompt, 1024, imagePart);
    return json({ reply: reply || '(תשובה ריקה מהמודל)' });
  } catch (e) {
    return json({ error: e.message }, 502);
  }
}

async function handlePlainChat(request, env, uid) {
  if (request.method !== 'POST') return json({ error: 'not found' }, 404);
  const cfg = await loadModelsConfig(env, uid);
  const m = cfg.models.find(x => x.id === cfg.selectedId);
  if (!m) return json({ error: 'No model is selected.' }, 400);
  const b = await request.json().catch(() => ({}));
  const prompt = (b.prompt || '').trim();
  const imagePart = parseImagePart(b.image);
  if (!prompt) return chatJson(env, uid, { prompt: '', error: 'The message is empty.', imageAttached: !!imagePart }, { error: 'The message is empty.' }, 400);
  if (m.builtin) {
    const reply = 'The built-in Claude model runs through a Claude Code session, not through this provider API.';
    return chatJson(env, uid, { prompt, reply, imageAttached: !!imagePart }, { reply });
  }
  if (!m.apiKey) return chatJson(env, uid, { prompt, error: 'No API key is configured for the selected model.', imageAttached: !!imagePart }, { error: 'No API key is configured for the selected model.' }, 400);
  const keyError = modelKeyError(m.apiKey);
  if (keyError) return chatJson(env, uid, { prompt, error: keyError, imageAttached: !!imagePart }, { error: keyError }, 400);
  try {
    const reply = await callModel(m, prompt, 1024, imagePart);
    return chatJson(env, uid, { prompt, reply: reply || '(empty model response)', imageAttached: !!imagePart }, { reply: reply || '(empty model response)' });
  } catch (e) {
    return chatJson(env, uid, { prompt, error: e.message, imageAttached: !!imagePart }, { error: e.message }, 502);
  }
}

async function handleChat(request, env, uid) {
  if (request.method !== 'POST') return json({ error: 'not found' }, 404);
  const cfg = await loadModelsConfig(env, uid);
  const m = cfg.models.find(x => x.id === cfg.selectedId);
  if (!m) return json({ error: 'No model is selected.' }, 400);
  const body = await request.json().catch(() => ({}));
  const prompt = (body.prompt || '').trim();
  const imagePart = parseImagePart(body.image);
  if (!prompt) return chatJson(env, uid, { prompt: '', error: 'The message is empty.', imageAttached: !!imagePart }, { error: 'The message is empty.' }, 400);
  if (m.builtin) {
    const reply = 'The built-in Claude model runs through a Claude Code session, not through this provider API.';
    return chatJson(env, uid, { prompt, reply, imageAttached: !!imagePart }, { reply });
  }
  if (!m.apiKey) return chatJson(env, uid, { prompt, error: 'No API key is configured for the selected model.', imageAttached: !!imagePart }, { error: 'No API key is configured for the selected model.' }, 400);
  const keyError = modelKeyError(m.apiKey);
  if (keyError) return chatJson(env, uid, { prompt, error: keyError, imageAttached: !!imagePart }, { error: keyError }, 400);
  try {
    const consent = await loadAgentConsent(env, uid);
    const github = await loadGithubConfig(env, uid);
    const hasGithubFields = !!(github.enabled && github.owner && github.repo && github.token);
    const consentMatchesModel = !!(consent.enabled && consent.modelId === m.id && consent.scopes.includes('repo_metadata'));
    let repoContext = null;
    if (consentMatchesModel && hasGithubFields) {
      try { repoContext = await loadAgentRepoContext(github); } catch {}
    }
    const githubReady = !!(consentMatchesModel && hasGithubFields && repoContext);
    const systemPrompt = agentSystemPrompt(githubReady, repoContext, consentMatchesModel);
    let rawReply = await callModel(m, prompt, 1800, imagePart, systemPrompt);
    let plan = normalizeAgentPlan(rawReply);
    if (!plan) {
      const repairedReply = await callModel(m, agentRepairPrompt(rawReply), 1200, null, systemPrompt);
      plan = normalizeAgentPlan(repairedReply);
      if (plan) rawReply = repairedReply;
    }
    if (!plan) {
      const reply = 'The model returned an invalid Agent response. Nothing was executed. Please send the request again.';
      return chatJson(env, uid, { prompt, error: reply, imageAttached: !!imagePart }, { error: reply }, 502);
    }
    let readResults = [];
    if (plan && !validateAgentPlan(plan, githubReady)) {
      const readActions = plan.actions.filter(action => action.tool === 'github.list_files' || action.tool === 'github.read_file');
      if (readActions.length && repoContext) {
        readResults = await executeAgentReadActions(github, readActions, repoContext.defaultBranch);
        let followReply = await callModel(m, agentToolResultsPrompt(readResults), 3200, null, systemPrompt);
        let followPlan = normalizeAgentPlan(followReply);
        if (!followPlan) {
          const repairedFollowReply = await callModel(m, agentRepairPrompt(followReply), 1200, null, systemPrompt);
          followPlan = normalizeAgentPlan(repairedFollowReply);
          if (followPlan) followReply = repairedFollowReply;
        }
        if (followPlan) {
          rawReply = followReply;
          plan = followPlan;
        } else {
          rawReply = followReply || rawReply;
        }
      }
    }
    const planError = plan ? validateAgentPlan(plan, githubReady) : null;
    if (planError) {
      const reply = plan.reply || rawReply || 'Agent access is not enabled for this request.';
      return chatJson(env, uid, { prompt, reply, imageAttached: !!imagePart }, { reply, agentAccessRequired: true });
    }
    if (plan && plan.kind === 'plan') {
      const publicPlan = publicAgentPlan(plan);
      const writeActions = plan.actions.filter(action => agentWriteTool(action.tool));
      if (writeActions.length) {
        const planId = crypto.randomUUID();
        await env.GH_CONFIG.put(`agent_plan:${uid}:${planId}`, JSON.stringify({ prompt, modelId: m.id, plan }), { expirationTtl: 900 });
        const reply = plan.reply || 'I prepared an action plan for your approval.';
        return chatJson(env, uid, { prompt, reply, plan: publicPlan, planId, imageAttached: !!imagePart }, { reply, plan: publicPlan, planId, approvalRequired: true });
      }
      const reply = plan.reply || (readResults.length ? 'I read the requested repository information.' : rawReply);
      return chatJson(env, uid, { prompt, reply, plan: publicPlan, imageAttached: !!imagePart }, { reply, results: readResults, plan: publicPlan });
    }
    const reply = plan?.reply || rawReply || '(empty model response)';
    return chatJson(env, uid, { prompt, reply, imageAttached: !!imagePart }, { reply });
  } catch (e) {
    return chatJson(env, uid, { prompt, error: e.message, imageAttached: !!imagePart }, { error: e.message }, 502);
  }
}

// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith('/api/auth/')) return handleAuth(request, env, url, path);

    const needsAuth = path.startsWith('/api/github/') || path.startsWith('/api/models') || path === '/api/chat' || path === '/api/chat/history' || path === '/api/chat/clear' || path === '/api/chat/delete' || path.startsWith('/api/agent/') || path.startsWith('/api/workspace');
    if (needsAuth) {
      const user = await getSession(env, request);
      if (!user) return json({ error: 'לא מחובר. יש להתחבר עם Google כדי להשתמש בתכונה הזו.', loginRequired: true }, 401);
      if (path.startsWith('/api/github/')) return handleGithubApi(request, env, path, user.uid);
      if (path.startsWith('/api/models')) return handleModelsApi(request, env, path, user.uid);
      if (path === '/api/chat') return handleChat(request, env, user.uid);
      if (path === '/api/chat/history' || path === '/api/chat/clear' || path === '/api/chat/delete') return handleChatHistory(request, env, user.uid, path);
      if (path === '/api/agent/status' || path === '/api/agent/consent') return handleAgentApi(request, env, path, user.uid);
      if (path === '/api/agent/approve') return handleAgentApproval(request, env, user.uid);
      if (path.startsWith('/api/workspace')) return handleWorkspaceApi(request, env, path, user.uid);
    }

    return env.ASSETS.fetch(request);
  }
};
