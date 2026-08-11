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
//   agent_job:<uid>:<jobId>     resumable Agent checklist, step log, reads, and current state
//   agent_plan:<uid>:<planId>   short-lived approval-gated GitHub write plan
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

// CI/workflow files can grant code-execution capability far beyond editing app source, so the
// agent can never write them regardless of approval — this is checked both before a plan is
// ever shown to the user (validateAgentPlan) and again right before the write executes
// (executeAgentWritePlan), so no future code path can skip it.
function isAgentBlockedWritePath(path) {
  const normalized = String(path || '').toLowerCase();
  return normalized === '.github' || normalized.startsWith('.github/');
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

async function loadAgentRepoContext(config, preferredBranch) {
  const repo = await githubApi(config);
  const defaultBranch = safeAgentBranch(preferredBranch) || repo.default_branch || 'main';
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
- github.read_file: read one text file. Arguments: path, branch (optional), query (optional text to find), or startLine and endLine (optional focused line range, maximum 400 lines). For large files, first use query, then use a line range only when more surrounding context is needed. Never repeat an identical read. Request at most two read actions per round.
- github.apply_patch: prepare a small unified diff for an existing text file. Arguments: path, patch, message. Prefer this for existing files.
- github.write_file: prepare a complete replacement for one new or small text file. Arguments: path, content, message.
- github.create_pull_request: after file changes, request a Pull Request. Arguments: title, body, base (optional).
- github.update_version: update the canonical project version files. Arguments: version, message (optional).
- github.deploy: merge the approved Pull Request into the configured deployment branch. This only merges the branch on GitHub — it does not by itself update the live site; a person must still run the project's deploy command afterward. Arguments: branch, version.

All file writes always go to a new branch created for this change; you cannot target any other branch, including the live branch, directly. Write actions are never executed immediately. They are shown to the user and require approval.
For any request involving a file or repository, do not claim that you completed it unless ON returns an execution result. This applies even to an "answer"-kind reply: never say a change is done, made, applied, or complete in "reply" unless the write/patch action that makes it is actually present in this same response's "actions" array — describing a change in words instead of proposing it as an action is the exact false-completion failure this rule exists to prevent, with no exception for changes that seem small or obvious.
If you need file contents, first return a read action. If read results are supplied in a later message, use them and then return the smallest complete plan.
For an existing file, use github.apply_patch with the smallest focused diff instead of returning the entire file. Use github.write_file only for a new file or when a complete replacement is genuinely small.
Do not narrate intentions as if they were actions. Never answer with phrases such as "I'll read...", "I will update...", or "Reading...". Request the tool in the JSON plan instead.
Do not use unsupported tools, do not output shell commands as if they were executed, and do not make up file contents.

Return JSON only, with this shape:
For an answer: {"kind":"answer","reply":"...","checklist":[],"actions":[]}
For work: {"kind":"plan","reply":"Short explanation in the user's language","checklist":[{"id":"inspect","text":"Inspect the active implementation"},{"id":"prepare","text":"Prepare the smallest safe change"},{"id":"approve","text":"Wait for approval and execute"}],"actions":[{"tool":"github.read_file","path":"index.html","query":"newShell"}]}
Use the user's language. Keep replies concise. A write_file action must contain the full intended file content and a short commit message.
For every work request, create a concrete checklist of 2 to 7 short steps. Keep the same checklist meaning across later read-result responses so ON can show progress and another runner can continue from the stored state.
An apply_patch action must contain a valid unified diff for one file and a short commit message. Return exactly one JSON object and no Markdown fences.
For any code change, include all of these actions in the same plan: a file write, github.update_version, github.create_pull_request, and github.deploy. The deployment branch is claude/github-site-integration-fbb693.
${githubConnected && dataSharingAuthorized ? '' : 'Repository access is not authorized for this request. Explain that clearly and do not create GitHub actions.'}`;
}

function agentWriteTool(tool) {
  return tool === 'github.write_file' || tool === 'github.apply_patch' || tool === 'github.update_version' || tool === 'github.create_pull_request' || tool === 'github.deploy';
}

function agentRepairPrompt(rawText, requestContext) {
  return `Your previous response did not follow the ON TracK Agent contract. Convert it now and return exactly one JSON object, with no Markdown and no narration.
If you need repository information, return a plan with github.read_file or github.list_files.
If you want to change an existing file, return github.apply_patch with a small unified diff.
If no tool is needed, return {"kind":"answer","reply":"...","actions":[]}.
Do not say that you will read or change something; request the tool in actions instead.
For a code change, include the source-file action, github.update_version, github.create_pull_request, and github.deploy in the same plan.
Current user request:
${String(requestContext || '').slice(0, 8000)}
Previous response:
${String(rawText || '').slice(0, 8000)}`;
}

// Used when the model's plan is valid JSON in the right shape but fails a contract rule (e.g.
// a code change missing github.update_version/create_pull_request/deploy) — gives it one chance
// to fix the specific problem instead of the request silently dying with no visible reason.
function agentValidationRepairPrompt(rawText, error, requestContext) {
  return `Your previous plan did not follow the ON TracK Agent contract: ${error}
Return exactly one corrected JSON object with the same {"kind":"plan"|"answer","reply":"...","actions":[...]} shape. Keep the same file changes and intent, and fix the rule above, but also re-check the full contract: any plan that changes a source file must include ALL FOUR of the file-change action, github.update_version, github.create_pull_request, and github.deploy in the SAME actions array — not just the one piece mentioned above. Do not narrate; return the corrected plan directly, with no Markdown fences, and keep the reply field brief so the full JSON fits.
Current user request:
${String(requestContext || '').slice(0, 8000)}
Previous response:
${String(rawText || '').slice(0, 8000)}`;
}

function inferAgentReadPlan(plan, repoContext) {
  if (!plan || plan.kind !== 'answer' || !repoContext?.paths?.length) return plan;
  const text = String(plan.reply || '');
  if (!/(צריך|אקרא|לקרוא|לבדוק|להבין|read|inspect|review|look at)/i.test(text)) return plan;
  const mentioned = [...text.matchAll(/[A-Za-z0-9_.-]+\.(?:html|js|css|json|md|ts|tsx|jsx)/gi)].map(match => match[0].toLowerCase());
  const paths = [];
  for (const name of mentioned) {
    const path = repoContext.paths.find(item => item.toLowerCase() === name || item.toLowerCase().endsWith('/' + name));
    if (path && !paths.includes(path)) paths.push(path);
  }
  if (!paths.length) return plan;
  return {
    kind: 'plan',
    reply: 'אבדוק את הקבצים שצוינו לפני שאציע שינוי.',
    actions: paths.slice(0, 2).map(path => ({ tool: 'github.read_file', path }))
  };
}

function normalizeAgentPlan(rawText) {
  const source = String(rawText || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const candidates = [];
  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < source.length; i += 1) {
      const char = source[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') { inString = true; continue; }
      if (char === '{') depth += 1;
      if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          candidates.push(source.slice(start, i + 1));
          break;
        }
      }
    }
  }
  for (const candidate of candidates) {
    let parsed;
    try { parsed = JSON.parse(candidate); } catch { continue; }
    if (!parsed || !['answer', 'plan'].includes(parsed.kind)) continue;
    const actions = Array.isArray(parsed.actions) ? parsed.actions.slice(0, 8).map(action => ({ ...action, tool: String(action.tool || '') })) : [];
    const checklist = Array.isArray(parsed.checklist) ? parsed.checklist.slice(0, 7).map((item, index) => ({
      id: String(item?.id || `step-${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || `step-${index + 1}`,
      text: String(item?.text || item?.title || '').trim().slice(0, 240)
    })).filter(item => item.text) : [];
    return { kind: parsed.kind, reply: String(parsed.reply || '').slice(0, 6000), checklist, actions };
  }
  return null;
}

function isReadOnlyAgentPlan(plan) {
  return !!(plan && plan.kind === 'plan' && Array.isArray(plan.actions) && plan.actions.length &&
    plan.actions.every(action => action.tool === 'github.list_files' || action.tool === 'github.read_file'));
}

function validateAgentPlan(plan, githubConnected) {
  if (!plan || plan.kind === 'answer') return null;
  if (!githubConnected) return 'GitHub is not connected.';
  if (!Array.isArray(plan.actions) || !plan.actions.length) return 'The model returned an empty action plan.';
  if (plan.actions.filter(action => action.tool === 'github.list_files' || action.tool === 'github.read_file').length > 2) return 'Request at most two repository reads per round.';
  const allowed = new Set(['github.list_files', 'github.read_file', 'github.write_file', 'github.apply_patch', 'github.update_version', 'github.create_pull_request', 'github.deploy']);
  let hasWrite = false;
  let hasSourceWrite = false;
  let hasVersion = false;
  let hasPullRequest = false;
  let hasDeploy = false;
  for (const action of plan.actions) {
    if (!allowed.has(action.tool)) return `Unsupported agent tool: ${action.tool}`;
    if (action.tool === 'github.list_files') {
      if (action.branch && !safeAgentBranch(action.branch)) return 'Invalid branch name.';
      continue;
    }
    if (action.tool === 'github.read_file') {
      if (!safeAgentPath(action.path)) return 'Invalid repository file path.';
      if (action.branch && !safeAgentBranch(action.branch)) return 'Invalid branch name.';
      const hasQuery = action.query !== undefined && action.query !== null;
      const hasStart = action.startLine !== undefined && action.startLine !== null;
      const hasEnd = action.endLine !== undefined && action.endLine !== null;
      if (hasQuery && (typeof action.query !== 'string' || !action.query.trim() || action.query.trim().length > 200)) return 'A read query must be between 1 and 200 characters.';
      if (hasQuery && (hasStart || hasEnd)) return 'Use either a read query or a line range, not both.';
      if (hasStart !== hasEnd) return 'A focused read requires both startLine and endLine.';
      if (hasStart && (!Number.isInteger(action.startLine) || !Number.isInteger(action.endLine) || action.startLine < 1 || action.endLine < action.startLine || action.endLine - action.startLine + 1 > 400)) {
        return 'A focused read range must contain 1 to 400 valid lines.';
      }
    }
    if (action.tool === 'github.write_file' || action.tool === 'github.apply_patch') {
      if (!safeAgentPath(action.path)) return 'Invalid repository file path.';
      if (isAgentBlockedWritePath(safeAgentPath(action.path))) return 'This path cannot be modified by the agent.';
    }
    if (action.tool === 'github.apply_patch') {
      if (typeof action.patch !== 'string' || !action.patch.trim() || action.patch.length > 80000) return 'The proposed patch is missing or too large.';
      if (!String(action.message || '').trim() || String(action.message).length > 180) return 'The proposed commit message is missing or too long.';
      hasWrite = true;
      hasSourceWrite = true;
    }
    if (action.tool === 'github.write_file') {
      hasWrite = true;
      hasSourceWrite = true;
      if (typeof action.content !== 'string' || action.content.length > 300000) return 'The proposed file content is missing or too large.';
      if (!String(action.message || '').trim() || String(action.message).length > 180) return 'The proposed commit message is missing or too long.';
    }
    if (action.tool === 'github.create_pull_request') {
      hasWrite = true;
      hasPullRequest = true;
      if (!String(action.title || '').trim() || String(action.title).length > 180) return 'The Pull Request title is missing or too long.';
      if (action.base && !safeAgentBranch(action.base)) return 'Invalid Pull Request base branch.';
    }
    if (action.tool === 'github.update_version') {
      hasWrite = true;
      hasVersion = true;
      if (!/^\d+\.\d+\.\d+$/.test(String(action.version || '').trim())) return 'Invalid project version.';
    }
    if (action.tool === 'github.deploy') {
      hasWrite = true;
      hasDeploy = true;
      if (action.branch && !safeAgentBranch(action.branch)) return 'Invalid deployment branch.';
      if (!/^\d+\.\d+\.\d+$/.test(String(action.version || '').trim())) return 'Invalid deployment version.';
      if (action.branch && action.branch !== 'claude/github-site-integration-fbb693') return 'Deployment must target the configured live branch.';
    }
  }
  if (plan.actions.some(action => action.tool === 'github.create_pull_request') && !plan.actions.some(action => action.tool === 'github.write_file' || action.tool === 'github.apply_patch')) {
    return 'A Pull Request requires at least one file change.';
  }
  if (hasSourceWrite && !hasVersion) return 'Every code change must include github.update_version.';
  if (hasSourceWrite && !hasPullRequest) return 'Every code change must include github.create_pull_request.';
  if (hasSourceWrite && !hasDeploy) return 'Every code change must include github.deploy.';
  return hasWrite ? null : null;
}

// A write/patch preview limit generous enough to cover the vast majority of the small, focused
// diffs the agent is instructed to produce, while keeping the approval payload bounded.
const AGENT_PLAN_PREVIEW_LIMIT = 8000;

function publicAgentPlan(plan) {
  return {
    kind: plan.kind,
    reply: plan.reply,
    actions: plan.actions.map(action => {
      const raw = typeof action.content === 'string' ? action.content : (typeof action.patch === 'string' ? action.patch : null);
      // write_file/apply_patch always write to the auto-created change branch (see
      // executeAgentWritePlan) — any branch the model supplied for those is ignored, so it's
      // omitted here rather than shown as if it had an effect.
      const isWriteToChangeBranch = action.tool === 'github.write_file' || action.tool === 'github.apply_patch';
      return {
        tool: action.tool,
        path: action.path || null,
        branch: isWriteToChangeBranch ? null : (action.branch || null),
        message: action.message || null,
        title: action.title || null,
        body: action.body ? String(action.body).slice(0, 1200) : null,
        version: action.version || null,
        contentLength: raw ? raw.length : null,
        contentPreview: raw ? raw.slice(0, AGENT_PLAN_PREVIEW_LIMIT) : null,
        contentTruncated: raw ? raw.length > AGENT_PLAN_PREVIEW_LIMIT : false
      };
    })
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

const AGENT_READ_CONTENT_LIMIT = 14000;
const MAX_AGENT_READ_ROUNDS = 2;

function agentReadRanges(lines, requestedRanges) {
  const ranges = [];
  let remaining = AGENT_READ_CONTENT_LIMIT;
  for (const requested of requestedRanges) {
    if (remaining <= 0 || !lines.length) break;
    const startLine = Math.max(1, Math.min(lines.length, requested.startLine));
    const endLine = Math.max(startLine, Math.min(lines.length, requested.endLine));
    let excerpt = lines.slice(startLine - 1, endLine).join('\n');
    const contentTruncated = excerpt.length > remaining;
    if (contentTruncated) excerpt = excerpt.slice(0, remaining);
    ranges.push({ startLine, endLine, content: excerpt, contentTruncated });
    remaining -= excerpt.length;
  }
  return ranges;
}

function agentFileReadResult(action, branch, sha, content) {
  const normalized = String(content || '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const base = {
    tool: action.tool,
    path: action.path,
    branch,
    sha,
    totalLines: lines.length,
    totalCharacters: normalized.length
  };
  const query = typeof action.query === 'string' ? action.query.trim() : '';
  if (query) {
    const needle = query.toLocaleLowerCase();
    const allMatches = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].toLocaleLowerCase().includes(needle)) allMatches.push(index + 1);
    }
    const requestedRanges = [];
    for (const line of allMatches.slice(0, 8)) {
      const next = { startLine: Math.max(1, line - 24), endLine: Math.min(lines.length, line + 24) };
      const previous = requestedRanges[requestedRanges.length - 1];
      if (previous && next.startLine <= previous.endLine + 1) previous.endLine = Math.max(previous.endLine, next.endLine);
      else requestedRanges.push(next);
    }
    return {
      ...base,
      mode: 'query',
      query,
      matchCount: allMatches.length,
      matchesTruncated: allMatches.length > 8,
      ranges: agentReadRanges(lines, requestedRanges),
      instruction: allMatches.length ? 'Use the returned line ranges. Request one focused line range only if more adjacent context is necessary.' : 'No match was found. Try a different specific query; do not repeat this read.'
    };
  }
  if (Number.isInteger(action.startLine) && Number.isInteger(action.endLine)) {
    return {
      ...base,
      mode: 'range',
      requestedStartLine: action.startLine,
      requestedEndLine: action.endLine,
      ranges: agentReadRanges(lines, [{ startLine: action.startLine, endLine: action.endLine }]),
      instruction: 'The range content is exact repository text; line numbers are metadata and are not part of the file.'
    };
  }
  if (normalized.length <= AGENT_READ_CONTENT_LIMIT) return { ...base, mode: 'full', content: normalized, truncated: false };
  return {
    ...base,
    mode: 'overview',
    ranges: agentReadRanges(lines, [
      { startLine: 1, endLine: Math.min(lines.length, 140) },
      { startLine: Math.max(1, lines.length - 39), endLine: lines.length }
    ]),
    truncated: true,
    requiresFocusedRead: true,
    instruction: 'This file is too large for a full read. Request a NEW github.read_file action for this path with a specific query, or with startLine and endLine (maximum 400 lines).'
  };
}

function agentReadActionKey(action, defaultBranch) {
  return JSON.stringify({
    tool: action.tool,
    path: action.path || null,
    branch: safeAgentBranch(action.branch) || defaultBranch,
    query: typeof action.query === 'string' ? action.query.trim().toLocaleLowerCase() : null,
    startLine: Number.isInteger(action.startLine) ? action.startLine : null,
    endLine: Number.isInteger(action.endLine) ? action.endLine : null
  });
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
      results.push(agentFileReadResult(action, branch, file.sha || null, content));
    }
  }
  return results;
}

function agentToolResultsPrompt(results, requestContext, canReadMore) {
  const nextStep = canReadMore
    ? 'If the supplied excerpts are insufficient, you may request one NEW focused github.read_file query or line range. Never repeat an identical read. Otherwise return the final answer or complete write plan now.'
    : 'The read-round limit has been reached. Do not request another read; return the final answer or complete write plan now.';
  return `ON already executed the read-only GitHub tools below. ${nextStep} Keep the original request in mind. If the request needs a code change, return the smallest apply_patch/write_file plan plus update_version, create_pull_request, and deploy — in this exact response, as actions in the JSON, not described in words. If no change is needed, return a useful answer. Never return future-tense narration such as "I will read". Never say a change is done, made, applied, or complete in "reply" unless this same response's "actions" array actually contains the write/patch action that makes it — describing the change instead of including it as an action is exactly the false-completion behavior that must never happen, with no exception for small or obvious changes.\nOriginal user request:\n${String(requestContext || '').slice(0, 8000)}\nRead results:\n${JSON.stringify(results).slice(0, 70000)}`;
}

function agentReadResultsRepairPrompt(rawText, results, requestContext, canReadMore) {
  const readRule = canReadMore
    ? 'If context is still missing, you may request one NEW focused read with query or startLine/endLine, but never repeat an identical read.'
    : 'The read-round limit has been reached, so do not request another read.';
  return `Your previous response did not follow the ON TracK Agent contract. Do not narrate intentions. ${readRule} Return exactly one JSON object now: either an answer with a useful response, a new focused read plan when allowed, or a plan for the requested change. For a code change, include a source-file action, github.update_version, github.create_pull_request, and github.deploy. Use the read results below.\nOriginal user request:\n${String(requestContext || '').slice(0, 8000)}\nPrevious response:\n${String(rawText || '').slice(0, 8000)}\nRead results:\n${JSON.stringify(results).slice(0, 70000)}`;
}

const LIVE_DEPLOY_BRANCH = 'claude/github-site-integration-fbb693';

async function writeGithubTextFile(config, path, branch, content, message) {
  let current = null;
  try { current = await githubApi(config, `/contents/${githubPath(path)}?ref=${encodeURIComponent(branch)}`); }
  catch (e) { if (e.status !== 404) throw e; }
  const body = { message: String(message || 'Update file').trim(), content: encodeBase64Utf8(content), branch };
  if (current?.sha) body.sha = current.sha;
  const updated = await githubApi(config, `/contents/${githubPath(path)}`, { method: 'PUT', body: JSON.stringify(body) });
  return { path, action: current?.sha ? 'updated' : 'created', commit: updated?.commit?.sha || null };
}

async function readGithubTextFile(config, path, branch) {
  const file = await githubApi(config, `/contents/${githubPath(path)}?ref=${encodeURIComponent(branch)}`);
  if (file?.type !== 'file' || typeof file.content !== 'string') throw new Error(`GitHub path is not a text file: ${path}`);
  return decodeBase64Utf8(file.content);
}

async function updateProjectVersion(config, branch, version, message) {
  const files = [];
  const packageJson = JSON.parse(await readGithubTextFile(config, 'package.json', branch));
  packageJson.version = version;
  files.push(await writeGithubTextFile(config, 'package.json', branch, JSON.stringify(packageJson, null, 2) + '\n', message || `Bump version to ${version}`));

  const packageLock = JSON.parse(await readGithubTextFile(config, 'package-lock.json', branch));
  packageLock.version = version;
  if (packageLock.packages && packageLock.packages['']) packageLock.packages[''].version = version;
  files.push(await writeGithubTextFile(config, 'package-lock.json', branch, JSON.stringify(packageLock, null, 2) + '\n', message || `Bump version to ${version}`));

  let html = await readGithubTextFile(config, 'index.html', branch);
  html = html
    .replace(/(id="verBtn"[^>]*>)[^<]*(<\/button>)/, `$1${version} ↻$2`)
    .replace(/(id="appVersion"[^>]*>)[^<]*(<\/b>)/, `$1${version}$2`)
    .replace(/(const appVersion\s*=\s*['"])\d+\.\d+\.\d+(['"])/, `$1${version}$2`);
  files.push(await writeGithubTextFile(config, 'index.html', branch, html, message || `Bump version to ${version}`));

  let info = await readGithubTextFile(config, 'PROJECT_INFO.md', branch);
  if (/^Version:\s*`[^`]*`/m.test(info)) info = info.replace(/^Version:\s*`[^`]*`/m, `Version: \`${version}\``);
  else info = `Version: \`${version}\`\n\n${info}`;
  files.push(await writeGithubTextFile(config, 'PROJECT_INFO.md', branch, info, message || `Bump version to ${version}`));
  return files;
}

// githubApi() throws GitHub's own error text (e.g. "Resource not accessible by personal access
// token") with no indication of which of the ~5 distinct GitHub calls in a write plan produced
// it — branch creation, a file write, the version bump, opening the PR, and merging each need
// different token permissions, so knowing WHICH one failed is the difference between a useless
// generic error and one the user can actually act on (e.g. "the PAT needs Pull requests: write").
async function withStage(label, fn) {
  try {
    return await fn();
  } catch (e) {
    e.message = `Failed while ${label}: ${e.message}`;
    throw e;
  }
}

async function executeAgentWritePlan(config, plan, planId, env) {
  const repo = await withStage('reading the repository', () => githubApi(config));
  const pullAction = plan.actions.find(item => item.tool === 'github.create_pull_request');
  const deployAction = plan.actions.find(item => item.tool === 'github.deploy');
  const deployBranch = safeAgentBranch(deployAction?.branch) || safeAgentBranch(env?.DEPLOY_BRANCH) || LIVE_DEPLOY_BRANCH;
  const baseBranch = safeAgentBranch(pullAction?.base) || deployBranch || repo.default_branch || 'main';
  const baseRef = await withStage('reading the base branch', () => githubApi(config, `/git/ref/heads/${encodeURIComponent(baseBranch)}`));
  const branch = `ontrack/agent-${String(planId).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 18)}`;
  await withStage('creating the change branch', () => githubApi(config, '/git/refs', {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseRef.object.sha })
  }));
  const files = [];
  // Every write always targets the freshly created `branch`, never a model-supplied one — an
  // action.branch override here would let an approved write land directly on any branch,
  // including the live deploy branch, bypassing the whole new-branch/PR/deploy safety flow.
  for (const action of plan.actions.filter(item => item.tool === 'github.write_file' || item.tool === 'github.apply_patch')) {
    const path = safeAgentPath(action.path);
    if (isAgentBlockedWritePath(path)) throw new Error(`This path cannot be modified by the agent: ${path}`);
    let current = null;
    try { current = await githubApi(config, `/contents/${githubPath(path)}?ref=${encodeURIComponent(branch)}`); }
    catch (e) { if (e.status !== 404) throw e; }
    let content = action.content;
    let actionName = 'updated';
    if (action.tool === 'github.apply_patch') {
      if (!current?.content) throw new Error(`Cannot patch a file that does not exist: ${path}`);
      content = applyUnifiedPatch(decodeBase64Utf8(current.content), action.patch);
      actionName = 'patched';
    }
    const body = { message: String(action.message).trim(), content: encodeBase64Utf8(content), branch };
    if (current?.sha) body.sha = current.sha;
    const updated = await withStage(`writing ${path}`, () => githubApi(config, `/contents/${githubPath(path)}`, { method: 'PUT', body: JSON.stringify(body) }));
    files.push({ path, action: current?.sha ? actionName : 'created', commit: updated?.commit?.sha || null });
  }
  const versionAction = plan.actions.find(item => item.tool === 'github.update_version');
  if (versionAction) files.push(...await withStage('updating the version files', () => updateProjectVersion(config, branch, String(versionAction.version).trim(), versionAction.message)));
  let pullRequest = null;
  if (pullAction) {
    const pr = await withStage('creating the Pull Request', () => githubApi(config, '/pulls', {
      method: 'POST',
      body: JSON.stringify({
        title: String(pullAction.title).trim(),
        body: String(pullAction.body || '').trim(),
        head: branch,
        base: safeAgentBranch(pullAction.base) || baseBranch
      })
    }));
    pullRequest = { number: pr.number, url: pr.html_url, title: pr.title };
  }
  let deployment = null;
  if (deployAction) {
    if (!pullRequest?.number) throw new Error('Deployment requires a created Pull Request.');
    if (deployBranch !== baseBranch) throw new Error('Deployment branch and Pull Request base do not match.');
    const merge = await withStage('merging the Pull Request', () => githubApi(config, `/pulls/${pullRequest.number}/merge`, {
      method: 'PUT',
      body: JSON.stringify({ merge_method: 'merge', commit_title: `Deploy ON TracK ${deployAction.version}` })
    }));
    if (!merge?.merged) throw new Error(merge?.message || 'Pull Request was not merged; deployment did not start.');
    deployment = {
      branch: deployBranch, version: deployAction.version, merged: true, commit: merge.sha || null,
      note: 'This merged the change into the branch on GitHub only. The live site is not updated automatically — a person must still run the project deploy command.'
    };
  }
  return { branch, baseBranch, files, pullRequest, deployment };
}

async function handleAgentApproval(request, env, uid) {
  if (request.method !== 'POST') return json({ error: 'not found' }, 404);
  const body = await request.json().catch(() => ({}));
  const planId = typeof body.planId === 'string' ? body.planId.trim() : '';
  if (!planId || !/^[a-zA-Z0-9-]{12,80}$/.test(planId)) return json({ error: 'Invalid or expired agent plan.' }, 400);
  const key = `agent_plan:${uid}:${planId}`;
  const raw = await env.GH_CONFIG.get(key);
  if (!raw) return json({ error: 'This agent plan has expired. Send the request again.' }, 410);
  let stored;
  try { stored = JSON.parse(raw); } catch { return json({ error: 'Invalid agent plan.' }, 400); }
  const consent = await loadAgentConsent(env, uid);
  if (!consent.enabled) return json({ error: 'Agent repository access is disabled. Enable it again and send the request again.' }, 403);
  const config = await loadGithubConfig(env, uid);
  if (!config.enabled || !config.owner || !config.repo || !config.token) return json({ error: 'GitHub is not connected for this account.' }, 400);
  await env.GH_CONFIG.delete(key);
  try {
    const result = await executeAgentWritePlan(config, stored.plan, planId, env);
    let jobView = null;
    if (stored.jobId) {
      const job = await loadAgentJob(env, uid, stored.jobId);
      if (job) {
        job.state = 'complete';
        job.currentStep = null;
        job.error = null;
        job.reply = agentJobText(job, 'הפעולות המאושרות בוצעו ב-GitHub.', 'The approved actions were executed on GitHub.');
        advanceAgentChecklist(job, 'complete');
        addAgentJobStep(job, agentJobText(job, 'האישור בוצע', 'Approval executed'), JSON.stringify(result), 'done');
        await saveAgentJob(env, uid, job);
        jobView = publicAgentJob(job);
      }
    }
    return json({ ok: true, result, job: jobView });
  } catch (e) {
    if (stored.jobId) {
      const job = await loadAgentJob(env, uid, stored.jobId);
      if (job) {
        failAgentJob(job, e.message || 'GitHub write failed.');
        await saveAgentJob(env, uid, job);
      }
    }
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

function modelTextContent(value) {
  if (Array.isArray(value)) return value.map(part => typeof part === 'string' ? part : (part?.text || '')).join('');
  return typeof value === 'string' ? value : '';
}

function modelError(response, data) {
  const detail = data?.error?.message || data?.message || `HTTP ${response.status}`;
  const error = new Error(String(detail).slice(0, 800));
  error.status = response.status;
  error.capacity = response.status === 429 || response.status === 503 || /resourceexhausted|capacity|rate.?limit|overloaded/i.test(error.message);
  return error;
}

// Shared provider call (OpenAI-compatible chat/completions, or Gemini generateContent).
// Returns the raw text reply. Used by the cheap connection ping (testModel), the real chat
// endpoint (handleChat), so there's one place that knows how to talk to each provider.
// One conservative retry on a transient capacity error (429/503/"rate limit"/"overloaded") —
// a single busy provider response used to end the whole agent turn immediately, forcing the
// user to notice and manually hit "refresh request" for what's often a one-second blip.
// Agent jobs deliberately pass an already-used retry budget: every HTTP continuation performs
// at most one provider call, and a busy provider is retried by a later persisted job step rather
// than inside the same request. Single-shot callers such as the connection test keep one retry.
async function callModel(m, prompt, maxTokens, imagePart, systemPrompt, retryBudget) {
  try {
    return await callModelOnce(m, prompt, maxTokens, imagePart, systemPrompt);
  } catch (e) {
    if (!e.capacity) throw e;
    if (retryBudget) {
      if (retryBudget.used) throw e;
      retryBudget.used = true;
    }
    await new Promise(resolve => setTimeout(resolve, 1200));
    return await callModelOnce(m, prompt, maxTokens, imagePart, systemPrompt);
  }
}

async function fetchModelProvider(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 75000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error('The model provider did not respond within 75 seconds. The saved Agent job can continue in a new step.');
      timeoutError.timeout = true;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function callModelOnce(m, prompt, maxTokens, imagePart, systemPrompt) {
  const keyError = modelKeyError(m.apiKey);
  if (keyError) throw new Error(keyError);
  if (m.provider === 'openai') {
    const content = imagePart
      ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:${imagePart.mime};base64,${imagePart.data}` } }]
      : prompt;
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content });
    const r = await fetchModelProvider(`${m.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${m.apiKey}` },
      body: JSON.stringify({ model: m.model, messages, max_tokens: maxTokens })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw modelError(r, j);
    return modelTextContent(j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content);
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${m.model}:generateContent?key=${encodeURIComponent(m.apiKey)}`;
  const parts = [{ text: prompt }];
  if (imagePart) parts.push({ inline_data: { mime_type: imagePart.mime, data: imagePart.data } });
  const payload = { contents: [{ parts }], generationConfig: { maxOutputTokens: maxTokens } };
  if (systemPrompt) payload.systemInstruction = { parts: [{ text: systemPrompt }] };
  const r = await fetchModelProvider(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw modelError(r, j);
  const responseParts = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
  return modelTextContent(responseParts);
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
    id: entry.id || crypto.randomUUID(),
    created: entry.created || new Date().toISOString(),
    prompt: String(entry.prompt || '').slice(0, 8000),
    reply: String(entry.reply || '').slice(0, 12000),
    error: entry.error ? String(entry.error).slice(0, 2000) : null,
    imageAttached: !!entry.imageAttached,
    plan: entry.plan || null,
    planId: entry.planId || null,
    execution: entry.execution || null,
    jobId: entry.jobId || null,
    jobStatus: entry.jobStatus || null,
    checklist: Array.isArray(entry.checklist) ? entry.checklist.slice(0, 7).map(item => ({ id: item.id, text: item.text, status: item.status })) : [],
    steps: Array.isArray(entry.steps) ? entry.steps.slice(-24).map(item => ({ id: item.id, at: item.at, title: item.title, detail: item.detail, status: item.status })) : []
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

async function updateChatHistoryEntry(env, uid, id, patch) {
  if (!id) return null;
  const history = await loadChatHistory(env, uid);
  const index = history.findIndex(item => item.id === id);
  if (index < 0) return null;
  history[index] = compactChatEntry({ ...history[index], ...patch, id: history[index].id, created: history[index].created });
  await env.GH_CONFIG.put('chat_history:' + uid, JSON.stringify(history.slice(-CHAT_HISTORY_LIMIT)));
  return history[index];
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
    const history = await loadChatHistory(env, uid);
    await Promise.all(history.filter(item => item.jobId).map(item => env.GH_CONFIG.delete(`agent_job:${uid}:${item.jobId}`)));
    await env.GH_CONFIG.delete('chat_history:' + uid);
    return json({ ok: true });
  }
  if (request.method === 'POST' && path === '/api/chat/delete') {
    const body = await request.json().catch(() => ({}));
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (!id) return json({ error: 'Missing conversation id.' }, 400);
    const history = await loadChatHistory(env, uid);
    const removed = history.find(item => item.id === id);
    const next = history.filter(item => item.id !== id);
    await env.GH_CONFIG.put('chat_history:' + uid, JSON.stringify(next));
    if (removed?.jobId) await env.GH_CONFIG.delete(`agent_job:${uid}:${removed.jobId}`);
    return json({ ok: true, deleted: next.length !== history.length });
  }
  return json({ error: 'not found' }, 404);
}

const AGENT_JOB_TTL = 86400;
const AGENT_JOB_MAX_TRANSIENT_FAILURES = 3;

function agentJobKey(uid, jobId) {
  return `agent_job:${uid}:${jobId}`;
}

function safeAgentJobId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return /^[a-zA-Z0-9-]{12,80}$/.test(id) ? id : null;
}

function agentJobText(job, he, en) {
  return job.language === 'he' ? he : en;
}

function defaultAgentChecklist(prompt) {
  const he = /[\u0590-\u05ff]/.test(String(prompt || ''));
  const texts = he
    ? ['להבין את הבקשה ולבנות תוכנית', 'לקרוא את קבצי הפרויקט הרלוונטיים', 'להכין שינוי מדויק ובטוח', 'להמתין לאישור ולבצע את פעולות GitHub']
    : ['Understand the request and build a plan', 'Read the relevant project files', 'Prepare an exact and safe change', 'Wait for approval and execute the GitHub actions'];
  return texts.map((text, index) => ({ id: `step-${index + 1}`, text, status: index === 0 ? 'active' : 'pending' }));
}

function adoptAgentChecklist(job, checklist) {
  if (job.checklistAdopted || !Array.isArray(checklist) || !checklist.length) return;
  job.checklist = checklist.slice(0, 7).map((item, index) => ({ ...item, status: index === 0 ? 'active' : 'pending' }));
  job.checklistAdopted = true;
}

function advanceAgentChecklist(job, outcome = 'next') {
  if (!Array.isArray(job.checklist) || !job.checklist.length) return;
  if (outcome === 'complete') {
    job.checklist.forEach(item => { item.status = 'done'; });
    return;
  }
  const activeIndex = job.checklist.findIndex(item => item.status === 'active');
  if (outcome === 'failed') {
    const index = activeIndex >= 0 ? activeIndex : job.checklist.findIndex(item => item.status === 'pending');
    if (index >= 0) job.checklist[index].status = 'failed';
    return;
  }
  if (activeIndex >= 0) job.checklist[activeIndex].status = 'done';
  const nextIndex = job.checklist.findIndex(item => item.status === 'pending');
  if (nextIndex >= 0) job.checklist[nextIndex].status = 'active';
}

function waitForAgentApproval(job) {
  if (!Array.isArray(job.checklist) || !job.checklist.length) return;
  const last = job.checklist.length - 1;
  job.checklist.forEach((item, index) => { item.status = index < last ? 'done' : 'active'; });
}

function addAgentJobStep(job, title, detail, status = 'done') {
  if (!Array.isArray(job.steps)) job.steps = [];
  job.steps.forEach(item => { if (item.status === 'active') item.status = 'done'; });
  job.steps.push({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    title: String(title || '').slice(0, 240),
    detail: String(detail || '').slice(0, 1000),
    status
  });
  job.steps = job.steps.slice(-24);
}

function agentJobPublicStatus(job) {
  if (job.state === 'waiting_approval') return 'waiting';
  if (job.state === 'complete') return 'complete';
  if (job.state === 'failed') return 'failed';
  if (job.state === 'queued') return 'queued';
  return 'running';
}

function publicAgentJob(job) {
  const status = agentJobPublicStatus(job);
  return {
    jobId: job.id,
    historyId: job.historyId || null,
    jobStatus: status,
    reply: job.reply || '',
    error: status === 'failed' ? (job.error || null) : null,
    checklist: job.checklist || [],
    steps: job.steps || [],
    currentStep: job.currentStep || null,
    continueRequired: status === 'queued' || status === 'running',
    retryAfter: job.retryAfter || 350,
    approvalRequired: status === 'waiting',
    plan: job.planPublic || null,
    planId: job.planId || null,
    done: status === 'complete'
  };
}

async function saveAgentJob(env, uid, job) {
  job.updated = new Date().toISOString();
  await env.GH_CONFIG.put(agentJobKey(uid, job.id), JSON.stringify(job), { expirationTtl: AGENT_JOB_TTL });
  if (job.historyId) {
    const view = publicAgentJob(job);
    await updateChatHistoryEntry(env, uid, job.historyId, {
      reply: view.reply,
      error: view.error,
      plan: view.plan,
      planId: view.planId,
      jobId: view.jobId,
      jobStatus: view.jobStatus,
      checklist: view.checklist,
      steps: view.steps
    });
  }
  return job;
}

async function loadAgentJob(env, uid, jobId) {
  const raw = await env.GH_CONFIG.get(agentJobKey(uid, jobId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function failAgentJob(job, message) {
  job.state = 'failed';
  job.error = String(message || 'The Agent job failed.').slice(0, 2000);
  job.reply = job.error;
  job.currentStep = null;
  advanceAgentChecklist(job, 'failed');
  addAgentJobStep(job, agentJobText(job, 'העבודה נעצרה', 'Work stopped'), job.error, 'failed');
}

function describeAgentReads(job, actions) {
  return actions.map(action => {
    if (action.tool === 'github.list_files') return agentJobText(job, 'רשימת קבצי הפרויקט', 'repository file list');
    if (action.query) return `${action.path} · ${agentJobText(job, 'חיפוש', 'query')}: ${action.query}`;
    if (action.startLine) return `${action.path} · ${action.startLine}-${action.endLine}`;
    return action.path;
  }).join(', ');
}

async function acceptAgentJobPlan(env, uid, job, plan, rawReply, githubReady) {
  adoptAgentChecklist(job, plan.checklist);
  job.rawReply = rawReply;
  job.plan = plan;
  const planError = validateAgentPlan(plan, githubReady);
  if (planError) {
    if (job.validationRepairUsed) {
      failAgentJob(job, `${plan.reply ? plan.reply + '\n\n' : ''}⚠️ ${planError}`);
      return;
    }
    job.planError = planError;
    job.state = 'repair_validation';
    job.currentStep = agentJobText(job, 'מתקן את תוכנית הפעולה', 'Correcting the action plan');
    addAgentJobStep(job, agentJobText(job, 'נדרשת התאמה לחוזה', 'Plan contract correction required'), planError, 'active');
    return;
  }
  const readActions = plan.kind === 'plan' ? plan.actions.filter(action => action.tool === 'github.list_files' || action.tool === 'github.read_file') : [];
  if (readActions.length) {
    job.state = 'read';
    job.currentStep = agentJobText(job, 'קורא את הקבצים שנבחרו', 'Reading the selected files');
    job.reply = plan.reply || job.currentStep;
    addAgentJobStep(job, agentJobText(job, 'השלב הבא: קריאת פרויקט', 'Next: repository read'), describeAgentReads(job, readActions), 'active');
    return;
  }
  const writeActions = plan.kind === 'plan' ? plan.actions.filter(action => agentWriteTool(action.tool)) : [];
  if (writeActions.length) {
    const planId = crypto.randomUUID();
    await env.GH_CONFIG.put(`agent_plan:${uid}:${planId}`, JSON.stringify({ prompt: job.prompt, modelId: job.modelId, plan, jobId: job.id }), { expirationTtl: AGENT_JOB_TTL });
    job.planId = planId;
    job.planPublic = publicAgentPlan(plan);
    job.state = 'waiting_approval';
    job.currentStep = agentJobText(job, 'ממתין לאישור שלך', 'Waiting for your approval');
    job.reply = plan.reply || agentJobText(job, 'תוכנית הפעולה מוכנה לאישור.', 'The action plan is ready for approval.');
    waitForAgentApproval(job);
    addAgentJobStep(job, agentJobText(job, 'תוכנית השינוי מוכנה', 'Change plan ready'), agentJobText(job, 'נדרש אישור לפני כתיבה ל-GitHub', 'Approval is required before writing to GitHub'), 'active');
    return;
  }
  job.state = 'complete';
  job.currentStep = null;
  job.reply = plan.reply || rawReply || agentJobText(job, 'העבודה הסתיימה.', 'Work completed.');
  advanceAgentChecklist(job, 'complete');
  addAgentJobStep(job, agentJobText(job, 'העבודה הסתיימה', 'Work completed'), job.reply, 'done');
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
  const language = /[\u0590-\u05ff]/.test(prompt) ? 'he' : 'en';
  const job = {
    id: crypto.randomUUID(),
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    state: 'queued',
    language,
    prompt: prompt.slice(0, 8000),
    imagePart,
    imageAttached: !!imagePart,
    modelId: m.id,
    modelLabel: m.label,
    checklist: defaultAgentChecklist(prompt),
    checklistAdopted: false,
    steps: [],
    readResults: [],
    seenReads: [],
    readRounds: 0,
    formatRepairUsed: false,
    validationRepairUsed: false,
    transientFailures: 0,
    retryAfter: 350,
    reply: agentJobText({ language }, 'הבקשה נשמרה. הסוכן מכין Checklist ומתחיל בשלב הראשון.', 'The request was saved. The Agent is creating a checklist and starting the first step.'),
    currentStep: agentJobText({ language }, 'בניית Checklist ותוכנית עבודה', 'Building the checklist and work plan')
  };
  addAgentJobStep(job, agentJobText(job, 'הבקשה נשמרה', 'Request saved'), agentJobText(job, 'מצב העבודה נשמר בשרת וניתן להמשיך ממנו גם לאחר רענון.', 'The job state is stored on the server and can resume after a refresh.'), 'done');
  addAgentJobStep(job, agentJobText(job, 'בניית Checklist', 'Building checklist'), job.currentStep, 'active');
  const saved = await appendChatHistory(env, uid, {
    prompt,
    reply: job.reply,
    imageAttached: !!imagePart,
    jobId: job.id,
    jobStatus: 'queued',
    checklist: job.checklist,
    steps: job.steps
  });
  job.historyId = saved.id;
  await saveAgentJob(env, uid, job);
  return json(publicAgentJob(job), 202);
}

async function handleAgentJobContinue(request, env, uid) {
  if (request.method !== 'POST') return json({ error: 'not found' }, 404);
  const body = await request.json().catch(() => ({}));
  const jobId = safeAgentJobId(body.jobId);
  if (!jobId) return json({ error: 'Invalid Agent job id.' }, 400);
  const job = await loadAgentJob(env, uid, jobId);
  if (!job) return json({ error: 'This Agent job expired or was deleted.' }, 410);
  if (['waiting_approval', 'complete', 'failed'].includes(job.state)) return json(publicAgentJob(job));

  const cfg = await loadModelsConfig(env, uid);
  const m = cfg.models.find(item => item.id === job.modelId);
  if (!m || m.builtin || !m.apiKey) {
    failAgentJob(job, agentJobText(job, 'המודל ששויך לעבודה כבר אינו זמין.', 'The model assigned to this job is no longer available.'));
    await saveAgentJob(env, uid, job);
    return json(publicAgentJob(job), 409);
  }
  const keyError = modelKeyError(m.apiKey);
  if (keyError) {
    failAgentJob(job, keyError);
    await saveAgentJob(env, uid, job);
    return json(publicAgentJob(job), 400);
  }

  const consent = await loadAgentConsent(env, uid);
  const github = await loadGithubConfig(env, uid);
  const hasGithubFields = !!(github.enabled && github.owner && github.repo && github.token);
  const consentMatchesModel = !!(consent.enabled && consent.modelId === m.id && consent.scopes.includes('repo_metadata'));
  const stageBefore = job.state;
  try {
    if (job.state === 'queued' && !job.repoContext && consentMatchesModel && hasGithubFields) {
      job.currentStep = agentJobText(job, 'טוען את מבנה הפרויקט וה-Skill', 'Loading the project structure and Skill');
      job.repoContext = await loadAgentRepoContext(github, LIVE_DEPLOY_BRANCH);
      addAgentJobStep(job, agentJobText(job, 'הקשר הפרויקט נטען', 'Project context loaded'), `${job.repoContext.fullName} · ${job.repoContext.paths.length} files`, 'done');
    }
    const githubReady = !!(consentMatchesModel && hasGithubFields && job.repoContext);
    const systemPrompt = agentSystemPrompt(githubReady, job.repoContext || null, consentMatchesModel);
    const noInlineRetry = { used: true };

    if (job.state === 'queued') {
      job.currentStep = agentJobText(job, 'המודל בונה Checklist ותוכנית', 'The model is building the checklist and plan');
      const rawReply = await callModel(m, job.prompt, 2600, job.imagePart || null, systemPrompt, noInlineRetry);
      job.imagePart = null;
      const plan = inferAgentReadPlan(normalizeAgentPlan(rawReply), job.repoContext);
      if (!plan) {
        job.rawReply = rawReply;
        job.formatRepairUsed = true;
        job.state = 'repair_format';
        job.currentStep = agentJobText(job, 'מתקן את מבנה תשובת המודל', 'Correcting the model response format');
        addAgentJobStep(job, agentJobText(job, 'תשובת המודל התקבלה', 'Model response received'), agentJobText(job, 'התשובה אינה JSON תקין; התיקון יבוצע בשלב הבא.', 'The response is not valid JSON; it will be corrected in the next step.'), 'active');
      } else {
        addAgentJobStep(job, agentJobText(job, 'ה-Checklist נוצר', 'Checklist created'), plan.reply, 'done');
        await acceptAgentJobPlan(env, uid, job, plan, rawReply, githubReady);
      }
    } else if (job.state === 'read' || job.state === 'analyze_reads') {
      if (job.state === 'read') {
        const readActions = job.plan.actions.filter(action => action.tool === 'github.list_files' || action.tool === 'github.read_file');
        const seen = new Set(job.seenReads || []);
        const newReadActions = readActions.filter(action => {
          const key = agentReadActionKey(action, job.repoContext?.defaultBranch || LIVE_DEPLOY_BRANCH);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        if (!newReadActions.length) throw new Error('The model repeated the same repository read.');
        if (job.readRounds >= MAX_AGENT_READ_ROUNDS) {
          job.state = 'finalize_reads';
        } else {
          const detail = describeAgentReads(job, newReadActions);
          const roundResults = await executeAgentReadActions(github, newReadActions, job.repoContext.defaultBranch);
          job.seenReads = [...seen];
          job.readRounds += 1;
          job.readResults = (job.readResults || []).concat(roundResults);
          job.state = 'analyze_reads';
          job.currentStep = agentJobText(job, 'המודל מנתח את תוצאות הקריאה', 'The model is analyzing the read results');
          advanceAgentChecklist(job);
          addAgentJobStep(job, agentJobText(job, `קריאת פרויקט ${job.readRounds}/${MAX_AGENT_READ_ROUNDS}`, `Repository read ${job.readRounds}/${MAX_AGENT_READ_ROUNDS}`), detail, 'done');
        }
      }
      if (job.state === 'analyze_reads') {
        const canReadMore = job.readRounds < MAX_AGENT_READ_ROUNDS;
        const rawReply = await callModel(m, agentToolResultsPrompt(job.readResults, job.prompt, canReadMore), 5000, null, systemPrompt, noInlineRetry);
        const plan = inferAgentReadPlan(normalizeAgentPlan(rawReply), job.repoContext);
        if (!plan) {
          if (job.formatRepairUsed) failAgentJob(job, agentJobText(job, 'המודל לא החזיר תוכנית Agent תקינה לאחר קריאת הקבצים.', 'The model did not return a valid Agent plan after reading the files.'));
          else {
            job.rawReply = rawReply;
            job.formatRepairUsed = true;
            job.state = 'repair_format';
            job.currentStep = agentJobText(job, 'מתקן את מבנה התוכנית', 'Correcting the plan format');
            addAgentJobStep(job, agentJobText(job, 'נדרש תיקון פורמט', 'Format correction required'), agentJobText(job, 'התיקון ירוץ בבקשת HTTP נפרדת.', 'The repair will run in a separate HTTP request.'), 'active');
          }
        } else if (isReadOnlyAgentPlan(plan) && !canReadMore) {
          job.rawReply = rawReply;
          job.plan = plan;
          job.state = 'finalize_reads';
          job.currentStep = agentJobText(job, 'מסכם את הקריאות לתוכנית סופית', 'Converting the reads into a final plan');
          addAgentJobStep(job, agentJobText(job, 'מכסת הקריאה הסתיימה', 'Read allowance completed'), agentJobText(job, 'בשלב הבא המודל חייב להחזיר תשובה או פעולה לביצוע.', 'In the next step the model must return an answer or executable action.'), 'active');
        } else {
          await acceptAgentJobPlan(env, uid, job, plan, rawReply, githubReady);
        }
      }
    } else if (job.state === 'repair_format') {
      const canReadMore = job.readRounds < MAX_AGENT_READ_ROUNDS;
      const repairPrompt = job.readResults?.length
        ? agentReadResultsRepairPrompt(job.rawReply, job.readResults, job.prompt, canReadMore)
        : agentRepairPrompt(job.rawReply, job.prompt);
      const rawReply = await callModel(m, repairPrompt, 2600, null, systemPrompt, noInlineRetry);
      const plan = inferAgentReadPlan(normalizeAgentPlan(rawReply), job.repoContext);
      if (!plan) failAgentJob(job, agentJobText(job, 'גם ניסיון תיקון הפורמט נכשל. לא בוצע שינוי.', 'The format repair also failed. Nothing was changed.'));
      else {
        addAgentJobStep(job, agentJobText(job, 'מבנה התוכנית תוקן', 'Plan format corrected'), plan.reply, 'done');
        await acceptAgentJobPlan(env, uid, job, plan, rawReply, githubReady);
      }
    } else if (job.state === 'repair_validation') {
      job.validationRepairUsed = true;
      const rawReply = await callModel(m, agentValidationRepairPrompt(job.rawReply, job.planError, job.prompt), 2600, null, systemPrompt, noInlineRetry);
      const plan = inferAgentReadPlan(normalizeAgentPlan(rawReply), job.repoContext);
      if (!plan) failAgentJob(job, agentJobText(job, 'תוכנית הפעולה המתוקנת לא הייתה תקינה. לא בוצע שינוי.', 'The corrected action plan was invalid. Nothing was changed.'));
      else {
        addAgentJobStep(job, agentJobText(job, 'חוזה הפעולה תוקן', 'Action contract corrected'), plan.reply, 'done');
        await acceptAgentJobPlan(env, uid, job, plan, rawReply, githubReady);
      }
    } else if (job.state === 'finalize_reads') {
      const rawReply = await callModel(m, agentReadResultsRepairPrompt(job.rawReply, job.readResults, job.prompt, false), 2600, null, systemPrompt, noInlineRetry);
      const plan = inferAgentReadPlan(normalizeAgentPlan(rawReply), job.repoContext);
      if (!plan || isReadOnlyAgentPlan(plan)) failAgentJob(job, agentJobText(job, 'המודל סיים את מכסת הקריאה בלי להציע פעולה לביצוע. לא בוצע שינוי.', 'The model exhausted the read allowance without proposing an executable action. Nothing was changed.'));
      else await acceptAgentJobPlan(env, uid, job, plan, rawReply, githubReady);
    } else {
      failAgentJob(job, `Unknown Agent job state: ${job.state}`);
    }
    job.transientFailures = 0;
    job.retryAfter = 350;
  } catch (error) {
    if (error.capacity || error.timeout) {
      job.state = stageBefore === 'read' && job.state === 'analyze_reads' ? 'analyze_reads' : job.state;
      job.transientFailures = Number(job.transientFailures || 0) + 1;
      job.retryAfter = Math.min(15000, 2500 * job.transientFailures);
      const detail = error.timeout
        ? agentJobText(job, 'ספק המודל לא ענה בתוך 75 שניות. מצב העבודה נשמר והניסיון הבא ירוץ בבקשה חדשה.', 'The model provider did not answer within 75 seconds. State was saved and the next attempt will use a new request.')
        : agentJobText(job, 'המודל עמוס כרגע. מצב העבודה נשמר והמערכת תנסה שוב בשלב נפרד.', 'The model is busy. State was saved and the system will retry in a separate step.');
      addAgentJobStep(job, agentJobText(job, `המתנה וניסיון נוסף ${job.transientFailures}/${AGENT_JOB_MAX_TRANSIENT_FAILURES}`, `Waiting and retrying ${job.transientFailures}/${AGENT_JOB_MAX_TRANSIENT_FAILURES}`), detail, job.transientFailures >= AGENT_JOB_MAX_TRANSIENT_FAILURES ? 'failed' : 'active');
      if (job.transientFailures >= AGENT_JOB_MAX_TRANSIENT_FAILURES) failAgentJob(job, detail);
      else {
        job.reply = detail;
        job.currentStep = agentJobText(job, 'ממתין לפני ניסיון נוסף', 'Waiting before another attempt');
      }
    } else {
      failAgentJob(job, error.message || 'The Agent step failed.');
    }
  }
  await saveAgentJob(env, uid, job);
  return json(publicAgentJob(job));
}

// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith('/api/auth/')) return handleAuth(request, env, url, path);

    const needsAuth = path.startsWith('/api/github/') || path.startsWith('/api/models') || path.startsWith('/api/chat') || path.startsWith('/api/agent/') || path.startsWith('/api/workspace');
    if (needsAuth) {
      const user = await getSession(env, request);
      if (!user) return json({ error: 'לא מחובר. יש להתחבר עם Google כדי להשתמש בתכונה הזו.', loginRequired: true }, 401);
      if (path.startsWith('/api/github/')) return handleGithubApi(request, env, path, user.uid);
      if (path.startsWith('/api/models')) return handleModelsApi(request, env, path, user.uid);
      if (path === '/api/chat') return handleChat(request, env, user.uid);
      if (path === '/api/chat/continue') return handleAgentJobContinue(request, env, user.uid);
      if (path === '/api/chat/history' || path === '/api/chat/clear' || path === '/api/chat/delete') return handleChatHistory(request, env, user.uid, path);
      if (path === '/api/agent/status' || path === '/api/agent/consent') return handleAgentApi(request, env, path, user.uid);
      if (path === '/api/agent/approve') return handleAgentApproval(request, env, user.uid);
      if (path.startsWith('/api/workspace')) return handleWorkspaceApi(request, env, path, user.uid);
    }

    return env.ASSETS.fetch(request);
  }
};
