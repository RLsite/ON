// Local QA-testing dashboard server. Core is Node built-ins only; the OPTIONAL local-preview
// browser uses puppeteer-core (drives the machine's installed Chrome) — the server degrades
// gracefully if it isn't installed.
// Independent from the "forum" project: its own port, its own data folder.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
// Optional: local preview browser engine. Absent until `npm install puppeteer-core` is run.
let puppeteer = null;
try { puppeteer = require('puppeteer-core'); } catch {}

const PORT = parseInt(process.env.QA_PORT || '8790', 10);
// The request-tracking "forum" (the dev-fix queue) — QA findings can be handed off to it.
const FORUM_URL = (process.env.FORUM_URL || 'http://localhost:8787').replace(/\/+$/, '');
// Project-local by default — this is one project's QA queue, not a cross-project one.
// Override with QA_DATA to share/relocate it.
const DATA_DIR = process.env.QA_DATA || path.join(__dirname, '..', 'qa-data');
const IMG_DIR = path.join(DATA_DIR, 'images');
const CHECKS_FILE = path.join(DATA_DIR, 'checks.json');
const LLM_CONFIG_FILE = path.join(DATA_DIR, 'llm-config.json');
const GITHUB_CONFIG_FILE = path.join(DATA_DIR, 'github-config.json');
const PROJECT_STATE_FILE = path.join(DATA_DIR, 'project-state.json');
const HTML_FILE = path.join(__dirname, 'index.html');
const PROJECT_INFO_FILE = path.join(__dirname, '..', 'PROJECT_INFO.md');

fs.mkdirSync(IMG_DIR, { recursive: true });

// ---- QA scope categories (from the test-plan spec doc) ----
const CATEGORIES = [
  { id: 'functional', label: 'פונקציונלי' },
  { id: 'uiux', label: 'UI/UX' },
  { id: 'responsive', label: 'רספונסיביות / קרוס-בראוזר' },
  { id: 'performance', label: 'ביצועים' },
  { id: 'security', label: 'אבטחה' },
  { id: 'accessibility', label: 'נגישות' },
  { id: 'other', label: 'אחר' }
];

// ---- browsers / resolutions (from the responsive & cross-browser testing section) ----
const BROWSERS = [
  { id: 'chrome', label: 'Chrome' },
  { id: 'safari', label: 'Safari' },
  { id: 'firefox', label: 'Firefox' },
  { id: 'edge', label: 'Edge' },
  { id: 'other', label: 'אחר' }
];
const RESOLUTIONS = [
  { id: 'desktop', label: 'דסקטופ' },
  { id: 'tablet', label: 'טאבלט' },
  { id: 'mobile', label: 'מובייל' }
];

// ---- functional modules (from the STD — Software Test Design doc, section 8) ----
const MODULES = [
  { id: 'login', label: 'Login / התחברות' },
  { id: 'registration', label: 'Registration / הרשמה' },
  { id: 'profile', label: 'User Profile / פרופיל משתמש' },
  { id: 'search', label: 'Search / חיפוש' },
  { id: 'forms', label: 'Forms / טפסים' },
  { id: 'crud', label: 'CRUD' },
  { id: 'permissions', label: 'Permissions / הרשאות' },
  { id: 'session', label: 'Session / Cookies' },
  { id: 'navigation', label: 'Navigation / ניווט' },
  { id: 'upload_download', label: 'Upload / Download' },
  { id: 'error_handling', label: 'Error Handling / קודי שגיאה' },
  { id: 'other', label: 'אחר' }
];

// ---- bug severity & priority (from the STD doc, sections 20–21 — standard QA taxonomy) ----
const SEVERITIES = [
  { id: 'critical', label: 'Critical — המערכת אינה שמישה' },
  { id: 'high', label: 'High — פונקציה מרכזית אינה עובדת' },
  { id: 'medium', label: 'Medium — תקלה עם פתרון עוקף' },
  { id: 'low', label: 'Low — בעיה קוסמטית' }
];
const PRIORITIES = [
  { id: 'p1', label: 'P1 — מיידי' },
  { id: 'p2', label: 'P2 — גבוה' },
  { id: 'p3', label: 'P3 — בינוני' },
  { id: 'p4', label: 'P4 — נמוך' }
];

// ---- refine service config (Gemini or any OpenAI-compatible API) — same idea as the forum ----
const DEFAULT_LLM_CONFIG = {
  enabled: false,
  provider: 'gemini',           // gemini | openai
  apiKey: null,
  model: 'gemini-2.0-flash',
  baseUrl: 'https://api.openai.com/v1'
};

function loadLlmConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(LLM_CONFIG_FILE, 'utf8'));
    return {
      enabled: !!c.enabled,
      provider: c.provider === 'openai' ? 'openai' : 'gemini',
      apiKey: c.apiKey || null,
      model: c.model || DEFAULT_LLM_CONFIG.model,
      baseUrl: (c.baseUrl || DEFAULT_LLM_CONFIG.baseUrl).replace(/\/+$/, '')
    };
  } catch {
    return { ...DEFAULT_LLM_CONFIG };
  }
}
let llmConfig = loadLlmConfig();
function saveLlmConfig() { fs.writeFileSync(LLM_CONFIG_FILE, JSON.stringify(llmConfig, null, 2)); }
function reloadLlmConfig() { llmConfig = loadLlmConfig(); }

// ---- GitHub connection config (repo + token, for reading/linking issues) ----
const DEFAULT_GH_CONFIG = { enabled: false, owner: null, repo: null, token: null };
function loadGhConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(GITHUB_CONFIG_FILE, 'utf8'));
    return {
      enabled: !!c.enabled,
      owner: c.owner || null,
      repo: c.repo || null,
      token: c.token || null
    };
  } catch {
    return { ...DEFAULT_GH_CONFIG };
  }
}
let ghConfig = loadGhConfig();
function saveGhConfig() { fs.writeFileSync(GITHUB_CONFIG_FILE, JSON.stringify(ghConfig, null, 2)); }
function reloadGhConfig() { ghConfig = loadGhConfig(); }

const DEFAULT_PROJECT_STATE = {
  version: '0.4.0',
  title: 'QA Project',
  status: 'MVP in progress',
  goal: 'Build a structured local workspace for model-assisted project work.',
  completed: [
    'Local QA dashboard running',
    'Model selection UI',
    'GitHub configuration UI',
    'Local repo configuration',
    'Preview/browser capture',
    'Live interactive check flow',
    'MVP readiness banner',
    'Project info file',
    'Help modal',
  ],
  nextSteps: [
    'Project planning flow',
    'Approval step before execution',
    'Persistent milestones',
    'Execution log',
    'Safer project actions'
  ],
  notes: [
    'Local-first product',
    'Choose model -> choose project folder -> plan -> approve -> execute'
  ]
};
const DEFAULT_WORKSPACE = {
  projects: [
    { id: 'ontrack', name: 'ON TracK', status: 'active', note: 'Main workspace' },
    { id: 'sandbox', name: 'Sandbox', status: 'idle', note: 'Experiment space' },
    { id: 'research', name: 'Research', status: 'idle', note: 'Ideas and notes' }
  ],
  libraries: [
    { id: 'docs', name: 'Project Docs', note: 'Specs and guides' },
    { id: 'design', name: 'Design System', note: 'UI patterns and tokens' },
    { id: 'assets', name: 'Shared Assets', note: 'Reusable files' }
  ],
  selectedProjectId: 'ontrack',
  selectedLibraryId: 'docs'
};
let workspaceState = { ...DEFAULT_WORKSPACE };
function loadWorkspaceState() { return { ...DEFAULT_WORKSPACE, ...workspaceState }; }
function saveWorkspaceState() {}
function loadProjectState() {
  try {
    const c = JSON.parse(fs.readFileSync(PROJECT_STATE_FILE, 'utf8'));
    return {
      ...DEFAULT_PROJECT_STATE,
      ...c,
      completed: Array.isArray(c.completed) ? c.completed : DEFAULT_PROJECT_STATE.completed,
      nextSteps: Array.isArray(c.nextSteps) ? c.nextSteps : DEFAULT_PROJECT_STATE.nextSteps,
      notes: Array.isArray(c.notes) ? c.notes : DEFAULT_PROJECT_STATE.notes
    };
  } catch {
    return { ...DEFAULT_PROJECT_STATE };
  }
}
let projectState = loadProjectState();
function saveProjectState() { fs.writeFileSync(PROJECT_STATE_FILE, JSON.stringify(projectState, null, 2)); }
function reloadProjectState() { projectState = loadProjectState(); }

function projectSummary() {
  const state = loadProjectState();
  const ws = loadWorkspaceState();
  const project = ws.projects.find(p => p.id === ws.selectedProjectId) || ws.projects[0];
  const library = ws.libraries.find(l => l.id === ws.selectedLibraryId) || ws.libraries[0];
  return {
    projectState: state,
    workspace: ws,
    selectedProject: project,
    selectedLibrary: library
  };
}

// ---- models registry: which model runs the QA checks (built-in Claude, or external) ----
// The user picks a model; its label is attached (as `agent`) to checks added from the UI,
// so the dashboard records which model handled what. External models carry a provider +
// base URL + API key so the system can call them (OpenAI-compatible or Gemini).
const MODELS_CONFIG_FILE = path.join(DATA_DIR, 'models-config.json');
const BUILTIN_MODELS = [
  { id: 'claude-sonnet', label: 'Claude Sonnet', builtin: true },
  { id: 'claude-opus',   label: 'Claude Opus',   builtin: true },
  { id: 'claude-haiku',  label: 'Claude Haiku',  builtin: true }
];
function loadModelsConfig() {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(MODELS_CONFIG_FILE, 'utf8')); } catch { cfg = null; }
  if (!cfg || !Array.isArray(cfg.models)) {
    cfg = { models: BUILTIN_MODELS.map(m => ({ ...m })), selectedId: 'claude-sonnet' };
    // One-time import: if an old llm-config.json has a key, carry it in as an external model.
    try {
      const old = JSON.parse(fs.readFileSync(LLM_CONFIG_FILE, 'utf8'));
      if (old && old.apiKey) {
        cfg.models.push({
          id: 'imported-' + Date.now(), builtin: false,
          label: (old.model || 'מודל חיצוני') + ' (יובא)',
          provider: old.provider === 'openai' ? 'openai' : 'gemini',
          baseUrl: (old.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, ''),
          model: old.model || '', apiKey: old.apiKey
        });
      }
    } catch {}
  }
  // guarantee the built-ins always exist (so the list can't end up empty)
  BUILTIN_MODELS.forEach(b => { if (!cfg.models.some(m => m.id === b.id)) cfg.models.unshift({ ...b }); });
  if (!cfg.models.some(m => m.id === cfg.selectedId)) cfg.selectedId = cfg.models[0].id;
  return cfg;
}
let modelsConfig = loadModelsConfig();
function saveModelsConfig() { fs.writeFileSync(MODELS_CONFIG_FILE, JSON.stringify(modelsConfig, null, 2)); }
function reloadModelsConfig() { modelsConfig = loadModelsConfig(); }
// Public view — never leak raw API keys to the browser.
function publicModels() {
  return {
    selectedId: modelsConfig.selectedId,
    models: modelsConfig.models.map(m => ({
      id: m.id, label: m.label, builtin: !!m.builtin,
      provider: m.provider || null, baseUrl: m.baseUrl || null, model: m.model || null,
      hasKey: !!m.apiKey
    }))
  };
}
function selectedModelLabel() {
  const m = modelsConfig.models.find(x => x.id === modelsConfig.selectedId);
  return m ? m.label : null;
}

// Detects text mangled by a non-UTF-8 shell/console codepage before it ever
// reached this server (each lost multi-byte character becomes a literal '?').
// There is no way to recover the original text once this has happened — the
// only real fix is rejecting it up front so the caller notices and resends.
function looksLikeMojibake(s) {
  if (!s || typeof s !== 'string') return false;
  if (/\?{3,}/.test(s)) return true;               // e.g. "?????" — a run of lost chars
  const noSpace = s.replace(/\s/g, '');
  if (noSpace.length < 15) return false;
  const qCount = (noSpace.match(/\?/g) || []).length;
  return qCount / noSpace.length > 0.35;             // e.g. "?? ?? ????? ????" — sparser runs
}
const MOJIBAKE_ERR = 'הטקסט נראה כמו קידוד פגום (הרבה סימני "?" רצופים) — ' +
  'ככל הנראה עברית שנהרסה על ידי ה-console codepage של המעטפת שלך לפני שהגיעה לשרת. ' +
  'אל תעביר טקסט עברי דרך שורת פקודה — כתוב אותו לקובץ UTF-8 ושלח עם curl --data-binary @file ' +
  '(ראה AGENTS.md / SKILL.md, "Hebrew encoding safety"). לא נשמר — שלח שוב את הטקסט המקורי.';

function parseImagePart(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null;
  const m = dataUrl.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  const mime = 'image/' + (ext === 'jpg' ? 'jpeg' : ext);
  return { mime, data: m[2] };
}

// Frames the draft directly in the user turn (not just the system prompt) so the model
// can't drift into performing the check itself — some models under-weight system
// instructions, especially when the draft reads like a bug report or a question.
function wrapDraftForRefine(draftText) {
  return 'נסח מחדש את בקשת הבדיקה הבאה (רק שכתוב/חידוד של מה צריך לבדוק) — אל תבצע את הבדיקה ' +
    'בעצמך, אל תדווח על תוצאה, אל תנחש אם זה עובד או לא, ואל תכתוב קוד. אתה לא ראית את המערכת ' +
    'ולא הרצת שום דבר — כל "תוצאה" תהיה המצאה. הפלט שלך הוא עוד בקשת בדיקה לביצוע עתידי ' +
    '(לשון "לבדוק ש..." / "לוודא ש..."), לא דוח בדיקה ולא תוצאה:\n\n"""\n' +
    (draftText || '') + '\n"""';
}

async function refineWithGemini(draftText, imagePart) {
  const parts = [{ text: wrapDraftForRefine(draftText) }];
  if (imagePart) parts.push({ inline_data: { mime_type: imagePart.mime, data: imagePart.data } });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${llmConfig.model}:generateContent?key=${encodeURIComponent(llmConfig.apiKey)}`;
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: REFINE_PROMPT }] },
      contents: [{ parts }]
    })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || 'שגיאה מול שירות Gemini');
  return (j.candidates?.[0]?.content?.parts || []).map(x => x.text || '').join('');
}

function isMultimodalError(msg) {
  const s = String(msg || '').toLowerCase();
  return s.includes('multimodal') || s.includes('image') && s.includes('not support');
}

async function callOpenAIChat(draftText, imagePart) {
  const wrapped = wrapDraftForRefine(draftText);
  const userContent = imagePart
    ? [
        { type: 'text', text: wrapped },
        { type: 'image_url', image_url: { url: `data:${imagePart.mime};base64,${imagePart.data}` } }
      ]
    : wrapped;
  const r = await fetch(`${llmConfig.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${llmConfig.apiKey}`
    },
    body: JSON.stringify({
      model: llmConfig.model,
      messages: [
        { role: 'system', content: REFINE_PROMPT },
        { role: 'user', content: userContent }
      ]
    })
  });
  const j = await r.json();
  if (!r.ok) {
    const err = j.error?.message || j.detail || (typeof j.error === 'string' ? j.error : null) || 'שגיאה מול שירות OpenAI-compatible';
    throw new Error(typeof err === 'string' ? err : JSON.stringify(err));
  }
  return j.choices?.[0]?.message?.content || '';
}

async function refineWithOpenAI(draftText, imagePart) {
  if (!imagePart) return { text: await callOpenAIChat(draftText, null) };
  try {
    return { text: await callOpenAIChat(draftText, imagePart) };
  } catch (e) {
    if (!isMultimodalError(e.message)) throw e;
    const text = await callOpenAIChat(
      (draftText || '') + '\n\n[הערה: צורף צילום מסך לבקשה, אך המודל לא תומך בניתוח תמונות — נסח את הבקשה בהתאם לטקסט בלבד.]',
      null
    );
    return { text, warning: 'המודל לא תומך בתמונות — השיפור בוצע לפי הטקסט בלבד.' };
  }
}

const REFINE_PROMPT = `אתה עוזר לחידוד בקשות בדיקה (QA), משולב בדשבורד בדיקות תוכנה אישי שמזין
סוכן QA — סוכן שתפקידו לבצע בדיקות בפועל על מערכת ווב ולדווח PASS/FAIL, לא לפתח או לתקן קוד.

⚠️ **התפקיד היחיד שלך הוא לנסח מחדש את הטיוטה כבקשת בדיקה — לא לבצע את הבדיקה, לא לדווח
תוצאה, ולא לכתוב קוד.** אתה לא רואה את המערכת, לא מריץ אותה, ואינך יודע אם משהו עובד או לא —
כל "תוצאה" תהיה בהכרח המצאה. הפלט שלך הוא **עוד בקשת בדיקה לעתיד**, לא דוח בדיקה.

אסור בהחלט:
- ❌ קביעה שמשהו "עובד" או "לא עובד", "נכשל" או "עבר" — זו לא בדיקה שבוצעה, רק בקשה שתבוצע.
- ❌ ניחושים טכניים על הסיבה לבעיה (איזה קובץ, איזו פונקציה) — אתה לא ראית את הקוד.
- ❌ רשימת "שלבי תיקון" — זה תפקיד סוכן הפיתוח, לא שלך. אתה מנסח מה **לבדוק**, לא איך **לתקן**.
כלל אצבע: הפלט תמיד בלשון "לבדוק ש...", "לוודא ש...", "לבחון האם..." — לעולם לא בלשון עבר/דיווח.

דוגמה:
טיוטה: "תבדוק אם הכפתור שמירה עובד טוב בנייד"
❌ פלט שגוי (זה דיווח, אסור): "בדקתי את כפתור השמירה בנייד — הוא לא מגיב ללחיצה בגלל בעיה ב-onClick."
✅ פלט נכון (זו בקשת בדיקה, מותר): "לבדוק שכפתור 'שמירה' מגיב ללחיצה במסכי מובייל (iOS ו-Android, לפחות שני breakpoints), כולל אזור מגע של 48px ומצב טעינה תקין עד לקבלת תגובה מהשרת."

קלט: טיוטה גולמית וקצרה בעברית שכתב המשתמש, לעיתים עם צילום מסך של המסך שהוא מדבר עליו.

המשימה שלך: לכתוב מחדש את הבקשה לגרסה ברורה, מפורטת ומובנית, שסוכן QA יוכל לפעול
לפיה ישירות בלי לשאול שאלות הבהרה מיותרות. הקפד על:

1. **דיוק מיקום** — אם יש תמונה, תאר במפורש איזה רכיב/אזור במסך מדובר (מיקום, טקסט על הכפתור,
   צבע וכו') על סמך מה שרואים בה, כדי שהבקשה תהיה חד-משמעית גם בלי לצרף את התמונה בהמשך.
2. **קריטריון קבלה ברור** — נסח כך שיהיה ברור מה נחשב PASS ומה נחשב FAIL.
3. **פירוק לסעיפים רק אם הטיוטה עצמה מבקשת כמה דברים שונים** — לא היתר לפרק לשלבי ביצוע.
4. **בלי המצאות** — אל תוסיף היקף בדיקה שלא נרמז בטיוטה או בתמונה. אם משהו עמום, השאר עמום.
5. **שפה** — עברית תמיד, קולחת ומקצועית.
6. **קיצור לא בא על חשבון בהירות** — מפורט אך לא מייגע.

פלט: רק בקשת הבדיקה המשופרת עצמה — לעולם לא דוח תוצאה. בלי כותרת, בלי הערות מטא.`;

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(CHECKS_FILE, 'utf8'));
    if (s.version === undefined) s.version = 0;
    if (s.stop === undefined) s.stop = false;
    if (!Array.isArray(s.tasks)) s.tasks = [];
    if (s.nextId === undefined) {
      s.nextId = s.tasks.reduce((m, t) => Math.max(m, t.id || 0), 0) + 1;
    }
    return s;
  } catch {
    return { version: 0, stop: false, nextId: 1, tasks: [] };
  }
}

let state = loadState();

function saveState() {
  fs.writeFileSync(CHECKS_FILE, JSON.stringify(state, null, 2));
}

// ---- long-poll support ----
let waiters = [];
function respondState(res) {
  const json = JSON.stringify(state);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(json);
}
function bump() {
  state.version++;
  saveState();
  const now = waiters;
  waiters = [];
  now.forEach(w => { clearTimeout(w.timer); respondState(w.res); });
}

function readBody(req) {
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => (d += c));
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
  });
}

const CT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
             '.gif': 'image/gif', '.webp': 'image/webp' };

// ---- local preview browser: the tool drives the machine's OWN installed Chrome (not the
// Claude session's browser) to load the app, capture DOM/console/screenshot, and feed live
// page state to the external model — real dynamic context, independent of any agent session. ----
const PREVIEW_CONFIG_FILE = path.join(DATA_DIR, 'preview-config.json');
function detectChrome() {
  const cands = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    (process.env.LOCALAPPDATA || '') + '/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch {} }
  return null;
}
function loadPreviewConfig() {
  try { const c = JSON.parse(fs.readFileSync(PREVIEW_CONFIG_FILE, 'utf8')); return { baseUrl: c.baseUrl || null, chromePath: c.chromePath || null }; }
  catch { return { baseUrl: null, chromePath: null }; }
}
let previewConfig = loadPreviewConfig();
function savePreviewConfig() { fs.writeFileSync(PREVIEW_CONFIG_FILE, JSON.stringify(previewConfig, null, 2)); }

let _browser = null;
async function getBrowser() {
  if (!puppeteer) throw new Error('מנוע הדפדפן (puppeteer-core) לא מותקן — הרץ npm install בתיקיית הפרויקט.');
  if (_browser && _browser.connected) return _browser;
  const exe = previewConfig.chromePath || detectChrome();
  if (!exe) throw new Error('לא נמצא Chrome/Edge מותקן — הגדר נתיב ידני ב-CHROME_PATH.');
  _browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  return _browser;
}
// Third-party analytics / ads / tracking hosts — a failed request to one of these is noise,
// not an app bug (blockers/automated browsers routinely abort them). Filtered from findings.
function isNoiseUrl(u) {
  return /google-analytics\.com|googletagmanager\.com|analytics\.google\.com|doubleclick\.net|google-analytics|\bgtag\b|facebook\.(com|net)\/|connect\.facebook|hotjar\.com|clarity\.ms|segment\.(io|com)|mixpanel\.com|sentry\.io|fullstory\.com|amplitude\.com|googlesyndication|adservice\.google|cloudflareinsights\.com|cdn-cgi\/(rum|challenge-platform|beacon)|static\.cloudflareinsights/i.test(u);
}
// A console error is "noise" if it's about a known analytics/beacon host, or the generic
// blocked-request signature (net::ERR_FAILED with no app URL) trackers emit under CORS.
function isNoiseConsole(msg) {
  const s = String(msg || '');
  if (isNoiseUrl(s)) return true;
  if (/Failed to load resource:.*net::ERR_FAILED/i.test(s) && !/https?:\/\/localhost/i.test(s)) return true;
  return false;
}
// Load a URL in the local browser and capture what a tester would look at.
async function previewCapture(url, { shot = true } = {}) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const consoleErrors = [], failedReqs = [];
  page.on('console', m => { if (m.type() === 'error' && !isNoiseConsole(m.text())) consoleErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', e => consoleErrors.push('PageError: ' + e.message.slice(0, 300)));
  page.on('requestfailed', r => { const u = r.url(); if (!u.startsWith('data:') && !isNoiseUrl(u)) failedReqs.push(u + ' — ' + (r.failure() && r.failure().errorText || '')); });
  let title = '', text = '', status = null, screenshot = null;
  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    status = resp ? resp.status() : null;
    title = await page.title();
    text = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 8000) : '');
    if (shot) screenshot = 'data:image/png;base64,' + await page.screenshot({ encoding: 'base64', type: 'png' });
  } finally {
    await page.close().catch(() => {});
  }
  return { url, status, title, text, consoleErrors: consoleErrors.slice(0, 30), failedReqs: failedReqs.slice(0, 20), screenshot };
}
// Resolve a check's target URL: an explicit URL/path on the check's `screen`, else the base URL.
function resolvePreviewUrl(screen) {
  const base = previewConfig.baseUrl;
  if (screen && /^https?:\/\//i.test(screen)) return screen;
  if (base && screen && screen.startsWith('/')) return base.replace(/\/+$/, '') + screen;
  return base;
}

// ---- the tool can START/STOP a local dev server for the app under test (e.g. Alon on :2500),
// so the user clicks one button to bring the app up locally and another to shut it down. ----
const LOCALSERVER_CONFIG_FILE = path.join(DATA_DIR, 'localserver-config.json');
const DEFAULT_LS = { mode: 'static', dir: 'C:/harel/RLAPP ON RL/ALON', port: 2500, command: '', cwd: '' };
function loadLsConfig() {
  try { const c = JSON.parse(fs.readFileSync(LOCALSERVER_CONFIG_FILE, 'utf8')); return { ...DEFAULT_LS, ...c }; }
  catch { return { ...DEFAULT_LS }; }
}
let lsConfig = loadLsConfig();
function saveLsConfig() { fs.writeFileSync(LOCALSERVER_CONFIG_FILE, JSON.stringify(lsConfig, null, 2)); }
let lsProc = null; let lsLog = [];
function lsUrl() { return 'http://localhost:' + lsConfig.port; }
function startLocalServer() {
  if (lsProc) return { already: true };
  lsLog = [];
  if (lsConfig.mode === 'command' && lsConfig.command) {
    lsProc = spawn(lsConfig.command, { shell: true, cwd: lsConfig.cwd || undefined, env: { ...process.env, PORT: String(lsConfig.port) } });
  } else {
    // static serve a folder with the bundled serve-alon.js
    const serveScript = path.join(__dirname, '..', 'internal', 'serve-alon.js');
    lsProc = spawn(process.execPath, [serveScript], { env: { ...process.env, ALON_ROOT: lsConfig.dir, ALON_PORT: String(lsConfig.port) } });
  }
  const cap = d => { lsLog.push(d.toString().slice(0, 500)); if (lsLog.length > 60) lsLog.shift(); };
  lsProc.stdout && lsProc.stdout.on('data', cap);
  lsProc.stderr && lsProc.stderr.on('data', cap);
  lsProc.on('exit', (code) => { lsLog.push('[exited ' + code + ']'); lsProc = null; });
  // point the preview browser at the freshly started local server
  previewConfig.baseUrl = lsUrl(); savePreviewConfig();
  return { started: true, url: lsUrl() };
}
function stopLocalServer() {
  if (!lsProc) return { alreadyStopped: true };
  try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(lsProc.pid), '/T', '/F']); else lsProc.kill('SIGTERM'); } catch {}
  lsProc = null;
  return { stopped: true };
}

// ---- LIVE interactive run: the model drives a real (headful) browser step by step —
// navigate/click/type — and the dashboard shows the live screenshot + action log on the side. ----
let _liveBrowser = null;
async function getHeadfulBrowser() {
  if (!puppeteer) throw new Error('מנוע הדפדפן (puppeteer-core) לא מותקן.');
  if (_liveBrowser && _liveBrowser.connected) return _liveBrowser;
  const exe = previewConfig.chromePath || detectChrome();
  if (!exe) throw new Error('לא נמצא Chrome/Edge מותקן.');
  _liveBrowser = await puppeteer.launch({ executablePath: exe, headless: false, defaultViewport: { width: 1280, height: 820 }, args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1300,900'] });
  return _liveBrowser;
}
// Shared live session the dashboard polls to render the browser view + action log.
// `tally` counts actions across the WHOLE run (steps[] is capped at 40, so it can't be used for a
// summary of a long run); `history` keeps a compact rolling memory fed back to the model each turn.
let liveSession = { active: false, running: false, checkId: null, model: '', url: '', steps: [], verdict: null, note: '', shot: null, startedAt: null, stoppedByUser: false, tally: {}, history: [] };
function resetLive(checkId, model) {
  liveSession = { active: true, running: true, checkId, model, url: '', steps: [], verdict: null, note: '', shot: null, startedAt: new Date().toISOString(), stoppedByUser: false, tally: { saved: 0, clicks: 0, fills: 0, turns: 0 }, history: [] };
}
function pushStep(s) { liveSession.steps.push({ ...s, at: new Date().toISOString() }); if (liveSession.steps.length > 40) liveSession.steps.shift(); }

// The locator logic, injected into the page for both snapshotting and action execution. We do
// NOT stamp attributes on the DOM: apps like Alon re-render constantly, which made a stamped
// index point at the WRONG element seconds later. Instead we re-find the element at action time
// by its (tag, human-label, occurrence), which survives re-renders.
const QA_LOCATOR = `
  const QA_SEL = 'a,button,input,select,textarea,[role="button"],[onclick],[tabindex]';
  function qaVisible(el){ const r=el.getBoundingClientRect(); if(r.width<=1||r.height<=1) return false; const st=getComputedStyle(el); return st.visibility!=='hidden'&&st.display!=='none'&&st.opacity!=='0'; }
  function qaLabel(el){
    let t=(el.innerText||el.value||el.getAttribute('placeholder')||el.getAttribute('aria-label')||el.getAttribute('title')||'').trim();
    if(!t&&el.labels&&el.labels.length)t=(el.labels[0].innerText||'').trim();            // <label for>/wrapping
    if(!t){ const lp=el.closest('label'); if(lp)t=(lp.innerText||'').trim(); }
    if(!t){ let p=el.previousElementSibling,hop=0; while(p&&hop<2&&!t){ if(p.children.length===0&&p.innerText)t=p.innerText.trim(); p=p.previousElementSibling; hop++; } }
    if(!t&&el.parentElement){ const q=el.parentElement.querySelector('label,legend'); if(q&&!q.querySelector(QA_SEL))t=(q.innerText||'').trim(); }
    return t.replace(/\\s+/g,' ').slice(0,70);
  }
  function qaList(){ return [...document.querySelectorAll(QA_SEL)].filter(qaVisible); }
`;
// Snapshot the visible interactive elements the model chooses from, numbered by list order.
// (Wrapped in an IIFE so QA_LOCATOR's declarations are function-scoped — a bare top-level `const`
// passed to page.evaluate would persist in the page realm and collide on the next call.)
async function indexElements(page) {
  return await page.evaluate(`(function(){ ${QA_LOCATOR}
    return qaList().map((el,i)=>({ i, tag: el.tagName.toLowerCase(), type: el.type||'', label: qaLabel(el) }));
  })()`);
}
// Given the snapshot + a model-chosen index, re-locate that element NOW (by tag+label+occurrence)
// and return its on-screen center — so we click the RIGHT element even after a re-render.
async function locateCenter(page, snap, idx) {
  const target = snap[idx];
  if (!target) return null;
  let occ = 0; for (let k = 0; k < idx; k++) if (snap[k].label === target.label && snap[k].tag === target.tag) occ++;
  return await page.evaluate(`(function(){ ${QA_LOCATOR}
    const label=${JSON.stringify(target.label)}, tag=${JSON.stringify(target.tag)}, occ=${occ};
    const cands = qaList().filter(el => el.tagName.toLowerCase()===tag && qaLabel(el)===label);
    const el = cands[occ] || cands[0];
    if(!el) return null;
    el.scrollIntoView({block:'center'});
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), tag: el.tagName.toLowerCase() };
  })()`);
}
// Real click by index: locate fresh, then a genuine mouse click (synthetic .click() is ignored
// by some apps). Returns false if the element couldn't be located.
async function clickIndex(page, snap, idx) {
  const c = await locateCenter(page, snap, idx);
  if (!c) return false;
  await page.mouse.click(c.x, c.y, { delay: 20 });
  return true;
}
// Real type into a field by index: focus via mouse click, clear, then type with real key events.
async function typeIndex(page, snap, idx, text) {
  const c = await locateCenter(page, snap, idx);
  if (!c) return false;
  await page.mouse.click(c.x, c.y);
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(String(text == null ? '' : text), { delay: 12 });
  return true;
}
// Select an <option> by index: match option by value or visible text, set it + fire change.
async function selectIndex(page, snap, idx, val) {
  const target = snap[idx];
  if (!target) return false;
  let occ = 0; for (let k = 0; k < idx; k++) if (snap[k].label === target.label && snap[k].tag === target.tag) occ++;
  return await page.evaluate(`(function(){ ${QA_LOCATOR}
    const label=${JSON.stringify(target.label)}, tag=${JSON.stringify(target.tag)}, occ=${occ}, val=${JSON.stringify(String(val == null ? '' : val))};
    const cands = qaList().filter(el => el.tagName.toLowerCase()===tag && qaLabel(el)===label);
    const el = cands[occ] || cands[0];
    if(!el || el.tagName.toLowerCase()!=='select') return false;
    const o = [...el.options].find(o=>o.value===val || o.text.trim()===val) || [...el.options].find(o=>o.text.trim().includes(val));
    if(!o) return false;
    el.value = o.value; el.dispatchEvent(new Event('change',{bubbles:true})); return true;
  })()`);
}
function parseAction(text) {
  // pull the first {...} JSON object out of the model's reply
  let m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
async function _callModelOnce(m, sys, user) {
  if (m.provider === 'openai') {
    const r = await fetch(`${m.baseUrl}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${m.apiKey}` },
      body: JSON.stringify({ model: m.model, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || ('HTTP ' + r.status));
    return j.choices?.[0]?.message?.content || '';
  } else {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${m.model}:generateContent?key=${encodeURIComponent(m.apiKey)}`;
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents: [{ parts: [{ text: user }] }] }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || ('HTTP ' + r.status));
    return (j.candidates?.[0]?.content?.parts || []).map(x => x.text || '').join('');
  }
}
// Retry transient failures (rate limits, provider overload, network blips) with backoff so a
// single hiccup doesn't kill the whole run. A hard/total quota still surfaces after the retries.
async function callModelText(m, sys, user) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try { return await _callModelOnce(m, sys, user); }
    catch (e) {
      lastErr = e;
      const transient = /resourceexhausted|rate.?limit|quota|too many|\b429\b|\b5\d\d\b|overloaded|temporar|timeout|worker local total request limit|ECONN|network|fetch failed/i.test(e.message || '');
      if (!transient || i === 2) break;
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));   // 2s, then 4s
    }
  }
  throw lastErr;
}
const LIVE_SYS =
  'אתה סוכן QA שמבצע בדיקה אינטראקטיבית אמיתית בדפדפן. בכל תור אתה מקבל: מטרת הבדיקה, התוצאה ' +
  'הצפויה, ורשימת אלמנטים אינטראקטיביים ממוספרים במסך הנוכחי + טקסט הדף. אתה מחזיר **אך ורק JSON** של ' +
  'פעולה אחת, באחד מהפורמטים:\n' +
  '{"thought":"מה אני עושה ולמה","action":"click","index":N}\n' +
  '{"thought":"...","action":"type","index":N,"text":"טקסט"}\n' +
  '{"thought":"...","action":"fill","fields":[{"index":N,"text":"..."},{"index":M,"text":"..."}],"submit":"הוספה"}  (מלא כמה שדות בבת אחת ולחץ על כפתור השמירה — יעיל!)\n' +
  '{"thought":"...","action":"select","index":N,"text":"ערך"}\n' +
  '{"thought":"...","action":"navigate","url":"https://…"}\n' +
  '{"thought":"...","action":"scroll","text":"down|up"}\n' +
  '{"thought":"...","action":"observe"}  (רק לרענן מבט)\n' +
  '{"thought":"סיכום","action":"finish","verdict":"pass|fail","note":"מה נמצא, קונקרטי"}\n' +
  'כללים: השתמש במספרי האלמנטים מהרשימה — התווית (label) של כל שדה מופיעה שם, כך תדע מה למלא בכל שדה. ' +
  '**כשצריך למלא טופס — השתמש בפעולת "fill" אחת: כל השדות + "submit" עם שם כפתור השמירה (למשל "הוספה"). ' +
  'זה ממלא ושומר באותו תור.** אל תפצל ל-type נפרדים, ואל תמלא בלי submit — בלי submit הרשומה לא נשמרת. ' +
  '**למשימה חוזרת (למשל "הוסף 10 רשומות"): אחרי fill+submit הטופס מתנקה ונשאר פתוח — פשוט בצע fill+submit שוב ' +
  'עם נתונים חדשים. אל תנווט מחדש בין רשומה לרשומה. עקוב בשדה thought כמה הוספת עד כה (X מתוך 10) והמשך עד שתסיים.** ' +
  'אם חלון/מודל/באנר קופץ וחוסם את הדף — ' +
  'סגור אותו קודם (חפש כפתור ✕ / "סגור" / "דלג" / "לא תודה" ברשימה). אם קיבלת חיווי שהפעולה הקודמת ' +
  'לא שינתה את הדף — אל תחזור עליה, נסה אלמנט אחר או גלילה. כשהשגת מספיק כדי לקבוע מול התוצאה הצפויה — ' +
  'סיים עם finish ו-verdict. **בטיחות: אל תשלח טפסים/הודעות/תשלומים אמיתיים ואל תמחק נתונים אמיתיים. אם ' +
  'פעולה עלולה לגרום לפעולה חיצונית אמיתית (שליחת וואטסאפ/מייל, חיוב, מחיקה) — אל תבצע אותה, סיים עם ' +
  'verdict:"fail" או note שמסביר שנדרש אישור. בלי טקסט מחוץ ל-JSON.';

// Close startup modals/overlays (welcome dialogs, cookie/promo banners) that would otherwise
// swallow every click in the top layer. Run ONCE before the loop so genuine in-check modals stay.
async function dismissBlockingOverlays(page) {
  try {
    const n = await page.evaluate(() => {
      let closed = 0;
      // native <dialog open> (e.g. Alon's #welcomeDialog) — blocks the whole page via the top layer
      document.querySelectorAll('dialog[open]').forEach(d => { try { d.close(); closed++; } catch {} });
      // common dismiss controls on cookie/promo/welcome overlays
      const rx = /^(✕|✖|×|x|close|סגור|דלג|דלג ›|דלג >|לא תודה|לא,? תודה|הבנתי|אחר כך|מאוחר יותר|skip|no thanks|got it|dismiss|accept|אישור וסגירה)$/i;
      for (const b of document.querySelectorAll('button,a,[role="button"],[aria-label]')) {
        const t = (b.innerText || b.getAttribute('aria-label') || '').trim();
        if (t && rx.test(t)) { try { b.click(); closed++; } catch {} }
      }
      return closed;
    });
    await page.keyboard.press('Escape').catch(() => {});   // fallback for Esc-closable modals
    return n;
  } catch { return 0; }
}
// Turn a raw model-call error into a note that tells the user whether it's a provider limit
// (not a tool bug) vs. a real failure.
function modelErrNote(msg) {
  const s = String(msg || '');
  if (/resourceexhausted|rate.?limit|quota|too many|\b429\b|worker local total request limit|\b\d+\/\d+\b/i.test(s))
    return 'מכסת ה-API של המודל אזלה (' + s.slice(0, 90) + '). זו מגבלת הספק החיצוני, לא באג בכלי — המתן כמה דקות ונסה שוב, או בחר מודל אחר ב-🤖.';
  return 'שגיאת מודל: ' + s;
}

async function runLiveCheck(m, t) {
  const targetUrl = resolvePreviewUrl(t.screen) || previewConfig.baseUrl;
  if (!targetUrl) throw new Error('לא הוגדרה כתובת אתר (Base URL) לבדיקה — פתח 🔗 והגדר.');
  resetLive(t.id, m.label);
  const browser = await getHeadfulBrowser();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', e => { if (e.type() === 'error') consoleErrors.push(e.text().slice(0, 200)); });
  page.on('pageerror', e => consoleErrors.push('PageError: ' + e.message.slice(0, 200)));
  const shot = async () => { try { liveSession.shot = 'data:image/png;base64,' + await page.screenshot({ encoding: 'base64', type: 'png' }); } catch {} };
  try {
    liveSession.url = targetUrl;
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 800));                 // let startup modals render
    const dismissed = await dismissBlockingOverlays(page);      // clear welcome/cookie/promo modals up front
    if (dismissed) pushStep({ action: 'dismiss-overlay', detail: 'נסגרו ' + dismissed + ' חלונות פתיחה חוסמים לפני הבדיקה' });
    await shot();
    pushStep({ action: 'navigate', detail: targetUrl });
    const MAX = 30;
    let prevSig = null, lastActKey = '', repeat = 0, lastChanged = null;
    for (let step = 0; step < MAX && liveSession.running; step++) {
      // Reading the page can throw mid-navigation ("execution context destroyed" / "detached
      // Frame") when an action triggered a reload. Wait for it to settle and retry a few times
      // instead of aborting — only give up (with a report) after several failed attempts.
      let els, pageText, readOk = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          els = await indexElements(page);
          pageText = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 2500) : '');
          readOk = true; break;
        } catch (e) {
          const navving = /detached|execution context|destroyed|Target closed|Session closed/i.test(e.message || '');
          if (attempt < 3 && navving) { try { await page.waitForNavigation({ timeout: 4000 }).catch(() => {}); } catch {} await new Promise(r => setTimeout(r, 800)); continue; }
          pushStep({ action: 'read-error', detail: e.message }); liveSession.note = 'שגיאת קריאת הדף: ' + e.message;
          break;
        }
      }
      if (!readOk) break;
      // A CONTENT-based signature: URL + the interactive-element structure. Element labels change
      // when the view actually changes (the old first-400-chars was header-heavy and missed it),
      // so "did my action change the page?" is accurate and won't send false "nothing happened".
      const sig = page.url() + '||' + els.map(e => e.tag + ':' + e.label).join('|');
      if (prevSig !== null) lastChanged = (sig !== prevSig);
      prevSig = sig;
      // Tell the model WHICH screen it's on — weak models otherwise lose track and re-navigate forever.
      let screenInfo = '';
      try {
        screenInfo = await page.evaluate(() => {
          const heads = [...document.querySelectorAll('h1,h2,h3,h4')]
            .filter(e => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; })
            .map(e => e.innerText.trim().replace(/\s+/g, ' ')).filter(t => t && t.length < 60);
          const emptyInputs = [...document.querySelectorAll('input,textarea')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1 && !e.value; }).length;
          const parts = [];
          if (heads.length) parts.push('כותרות במסך: ' + [...new Set(heads)].slice(0, 5).join(' | '));
          if (emptyInputs) parts.push('⚠️ יש טופס פתוח עם ' + emptyInputs + ' שדות ריקים — זה הזמן למלא אותו (fill+submit), לא לנווט');
          return parts.join(' · ');
        });
      } catch {}
      liveSession.tally.turns++;
      // The model has NO memory between turns — feed it what it has already done, so it can track a
      // count ("add 2 records") and STOP, instead of thinking every turn is "the first one".
      const tl = liveSession.tally;
      const progressLine = (tl.saved || tl.clicks) ?
        ('📋 מה שכבר ביצעת עד כה: ' + (tl.saved ? ('שמרת ' + tl.saved + ' רשומות (fill+submit)') : '') + (tl.clicks ? (tl.saved ? ', ' : '') + tl.clicks + ' לחיצות' : '') +
          '.\n' + (liveSession.history.length ? 'רשומות אחרונות שהוספת: ' + liveSession.history.slice(-6).join(' ; ') + '\n' : '') +
          '❗ ספור מול היעד — אם כבר הגעת למספר המבוקש, סיים מיד עם action:"finish" (אל תוסיף עוד).\n') : '';
      const elList = els.map(e => `[${e.i}] ${e.tag}${e.type ? '/' + e.type : ''} "${e.label}"`).join('\n');
      const user =
        'מטרת הבדיקה: ' + (t.text || '') + '\n' +
        (t.steps ? 'צעדים מבוקשים: ' + t.steps + '\n' : '') +
        (t.expected ? 'תוצאה צפויה (קריטריון PASS): ' + t.expected + '\n' : '') +
        progressLine +
        (screenInfo ? '🧭 המסך הנוכחי: ' + screenInfo + '\n' : '') +
        (consoleErrors.length ? 'שגיאות קונסול עד כה:\n' + consoleErrors.slice(-5).join('\n') + '\n' : '') +
        (lastChanged === false ? '\n⚠️ הפעולה הקודמת לא שינתה את מבנה הדף. בדוק את "המסך הנוכחי" למעלה — ייתכן שכבר הגעת ליעד. אל תחזור על אותה פעולה; אם יש טופס פתוח — מלא אותו (fill+submit).\n' : '') +
        '\nאלמנטים אינטראקטיביים במסך:\n' + (elList || '(אין)') + '\n\nטקסט הדף:\n' + pageText +
        '\n\nהחזר את פעולת ה-JSON הבאה שלך.';
      let raw;
      try { raw = await callModelText(m, LIVE_SYS, user); } catch (e) { pushStep({ action: 'error', detail: e.message }); liveSession.note = modelErrNote(e.message); break; }
      const act = parseAction(raw);
      if (!act || !act.action) { pushStep({ action: 'parse-error', detail: (raw || '').slice(0, 200) }); continue; }
      // Stuck detection: same action+target repeated while the page isn't changing → bail with a
      // clear reason instead of grinding through the whole budget (and the provider's rate limit).
      const actKey = act.action + ':' + (act.index != null ? act.index : '') + ':' + (act.url || '') + ':' + JSON.stringify(act.fields || '');
      repeat = (actKey === lastActKey && lastChanged === false) ? repeat + 1 : 0;
      lastActKey = actKey;
      const stepText = act.action === 'fill' ? ((act.fields || []).length + ' שדות') : (act.text || act.url || '');
      pushStep({ action: act.action, index: act.index, detail: act.thought || '', text: stepText });
      if (repeat >= 2) {
        liveSession.note = 'הסוכן נתקע — חזר על אותה פעולה (' + act.action + (act.index != null ? ' [' + act.index + ']' : '') + ') שלוש פעמים ללא שינוי בדף. ככל הנראה חלון/מודל חוסם או שהאלמנט אינו מגיב.';
        pushStep({ action: 'stuck', detail: liveSession.note });
        await shot(); break;
      }
      try {
        if (act.action === 'finish') { liveSession.verdict = (act.verdict === 'pass' || act.verdict === 'fail') ? act.verdict : null; liveSession.note = act.note || ''; await shot(); break; }
        else if (act.action === 'navigate' && act.url) { await page.goto(act.url, { waitUntil: 'networkidle2', timeout: 30000 }); }
        else if (act.action === 'click' && act.index != null) { const ok = await clickIndex(page, els, act.index); if (ok) liveSession.tally.clicks++; else pushStep({ action: 'note', detail: 'האלמנט [' + act.index + '] לא נמצא לביצוע לחיצה' }); }
        else if (act.action === 'type' && act.index != null) { await typeIndex(page, els, act.index, act.text); }
        else if (act.action === 'fill' && Array.isArray(act.fields)) {
          // Fill several fields in one turn — huge efficiency win for multi-field forms.
          let filled = 0;
          for (const f of act.fields) {
            if (f && f.index != null) { const ok = (f.action === 'select') ? await selectIndex(page, els, f.index, f.text) : await typeIndex(page, els, f.index, f.text); if (ok) filled++; await new Promise(r => setTimeout(r, 120)); }
          }
          liveSession.tally.fills++;
          // Auto-submit in the SAME turn if the model named a submit button — guarantees the record
          // is saved instead of relying on a (weak) model to remember a separate click next turn.
          let submitted = '';
          if (act.submitIndex != null) { const ok = await clickIndex(page, els, act.submitIndex); if (ok) submitted = ' + נשלח (כפתור ' + act.submitIndex + ')'; }
          else if (act.submit) {
            // find a button whose label matches the requested submit text and click it
            const bi = els.findIndex(e => (e.tag === 'button' || e.tag === 'a') && (e.label || '').includes(String(act.submit)));
            if (bi >= 0) { const ok = await clickIndex(page, els, bi); if (ok) submitted = ' + נשלח ("' + act.submit + '")'; }
          }
          if (submitted) {
            liveSession.tally.saved++;
            // remember a short description of the saved record (first couple of field values) so the
            // model can see what it already added and not repeat / overshoot the requested count.
            const desc = act.fields.filter(f => f && f.text).slice(0, 2).map(f => f.text).join(', ');
            liveSession.history.push('#' + liveSession.tally.saved + (desc ? ' (' + desc + ')' : ''));
          }
          pushStep({ action: 'note', detail: 'מולאו ' + filled + '/' + act.fields.length + ' שדות' + submitted + (submitted ? ' [סה"כ נשמרו: ' + liveSession.tally.saved + ']' : '') });
          if (submitted) { await new Promise(r => setTimeout(r, 500)); await dismissBlockingOverlays(page); }  // clear post-save banners/toasts
        }
        else if (act.action === 'select' && act.index != null) { await selectIndex(page, els, act.index, act.text); }
        else if (act.action === 'scroll') { await page.evaluate(d => window.scrollBy(0, d === 'up' ? -600 : 600), act.text); }
        // 'observe' → just re-screenshot
        await new Promise(r => setTimeout(r, 700));
        await shot();
      } catch (e) { pushStep({ action: 'exec-error', detail: e.message }); await shot(); }
    }
    // Explain WHY the loop ended when the model didn't reach a verdict — so the report always has a reason.
    if (!liveSession.verdict && !liveSession.note) {
      if (liveSession.stoppedByUser) liveSession.note = 'הבדיקה נעצרה ידנית על ידי המשתמש.';
      else if (!liveSession.running) liveSession.note = 'הבדיקה הגיעה למקסימום הצעדים (' + MAX + ') בלי שהמודל סיים עם finish.';
    }
  } finally {
    await page.close().catch(() => {});
    liveSession.running = false;
  }
  return liveSession;
}

// ---- local project folder (e.g. the Alon source on disk) as model grounding context ----
const LOCALREPO_CONFIG_FILE = path.join(DATA_DIR, 'localrepo-config.json');
function loadLocalRepo() {
  try { const c = JSON.parse(fs.readFileSync(LOCALREPO_CONFIG_FILE, 'utf8')); return { path: c.path || null }; }
  catch { return { path: null }; }
}
let localRepo = loadLocalRepo();
function saveLocalRepo() { fs.writeFileSync(LOCALREPO_CONFIG_FILE, JSON.stringify(localRepo, null, 2)); }
function reloadLocalRepo() { localRepo = loadLocalRepo(); }
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'qa-data', 'forum-data', '.cache']);
function walkLocal(dir, base, out, cap) {
  if (out.length >= cap) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= cap) return;
    if (e.name.startsWith('.') && e.name !== '.env.example') continue;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walkLocal(path.join(dir, e.name), base, out, cap); }
    else { out.push(path.relative(base, path.join(dir, e.name)).replace(/\\/g, '/')); }
  }
}
const TEXT_EXT = new Set(['.html', '.htm', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.css', '.json', '.md', '.vue', '.svelte', '.txt', '.php']);
function isTextFile(p) { const e = path.extname(p).toLowerCase(); return TEXT_EXT.has(e) || e === ''; }
// Pull excerpts around the term matches so a huge file (a big index.html) still fits the prompt.
function excerptAround(content, terms, maxLen) {
  const lc = content.toLowerCase();
  const hits = [];
  for (const t of terms) { let i = lc.indexOf(t); if (i >= 0) hits.push(i); }
  if (!hits.length) return content.slice(0, maxLen);
  hits.sort((a, b) => a - b);
  let out = '', used = 0; const taken = [];
  for (const pos of hits) {
    if (used >= maxLen) break;
    if (taken.some(([s, e]) => pos >= s && pos <= e)) continue;
    const start = Math.max(0, pos - 250), end = Math.min(content.length, pos + 750);
    taken.push([start, end]);
    out += (out ? '\n…\n' : '') + content.slice(start, end);
    used += end - start;
  }
  return out.slice(0, maxLen);
}
// Real CONTENT search over the local folder — the Alon code holds Hebrew UI strings, so the
// check's Hebrew terms DO match file contents (filename matching alone failed). Attaches the
// most relevant files' excerpts so the model can point at the actual buggy code.
function localRepoContext(text, screen, steps, expected) {
  reloadLocalRepo();
  if (!localRepo.path) return '';
  let stat; try { stat = fs.statSync(localRepo.path); } catch { return ''; }
  if (!stat.isDirectory()) return '';
  const files = [];
  walkLocal(localRepo.path, localRepo.path, files, 800);
  if (!files.length) return '';
  const raw = [text, screen, steps, expected].filter(Boolean).join(' ');
  const terms = [...new Set(
    raw.split(/[^\p{L}\p{N}_]+/u)
      .filter(w => (/[֐-׿]/.test(w) && w.length >= 2) || (/^[A-Za-z0-9_]+$/.test(w) && w.length >= 3))
      .map(w => w.toLowerCase())
  )].slice(0, 14);
  const scored = [];
  for (const f of files) {
    if (!isTextFile(f)) continue;
    let content; try { content = fs.readFileSync(path.join(localRepo.path, f), 'utf8'); } catch { continue; }
    if (content.length > 600000) content = content.slice(0, 600000);
    const lc = content.toLowerCase();
    let score = 0;
    for (const t of terms) { let idx = lc.indexOf(t), c = 0; while (idx >= 0 && c < 50) { c++; idx = lc.indexOf(t, idx + t.length); } score += c; }
    if (/index\.html$|app\.js$|main\.js$|translations\.js$/i.test(f)) score += 2; // entry files
    if (score > 0) scored.push({ f, content, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 3);
  let ctx = 'מבנה הקבצים בתיקייה המקומית (' + localRepo.path + ', עד 800):\n' + files.slice(0, 800).join('\n') + '\n\n';
  if (top.length) {
    ctx += 'קבצים רלוונטיים (נמצאו בחיפוש תוכן לפי מונחי הבדיקה: ' + terms.join(', ') + '):\n\n';
    for (const { f, content } of top) {
      const excerpt = content.length <= 7000 ? content : excerptAround(content, terms, 7000);
      ctx += '=== ' + f + (content.length > 7000 ? ' (קטעים סביב ההתאמות)' : '') + ' ===\n' + excerpt + '\n\n';
    }
  } else {
    ctx += 'לא נמצאו קבצים שמכילים את מונחי הבדיקה (' + terms.join(', ') + ') — דייק את הבדיקה או ציין שם קובץ.\n\n';
  }
  return 'הקשר מהקוד המקומי:\n' + ctx;
}

// Fetch a compact snapshot of the connected GitHub repo (open issues + file-tree paths) to
// feed an external model as grounding context — a chat model has no network of its own, so
// the SERVER (which holds the token) brings the repo to it. Cached briefly to spare rate limits.
let _ghCtxCache = { at: 0, text: '' };
async function githubRepoContext() {
  reloadGhConfig();
  if (!ghConfig.enabled || !ghConfig.owner || !ghConfig.repo) return '';
  if (Date.now() - _ghCtxCache.at < 60000) return _ghCtxCache.text;  // 60s cache
  const headers = { 'User-Agent': 'qa-dashboard', Accept: 'application/vnd.github+json' };
  if (ghConfig.token) headers.Authorization = `Bearer ${ghConfig.token}`;
  const base = `https://api.github.com/repos/${ghConfig.owner}/${ghConfig.repo}`;
  let ctx = '';
  try {
    const r = await fetch(`${base}/issues?state=open&per_page=20`, { headers });
    const j = await r.json();
    if (Array.isArray(j)) {
      const issues = j.filter(i => !i.pull_request).map(i => `#${i.number} ${i.title}`);
      if (issues.length) ctx += 'Issues פתוחים בריפו:\n' + issues.join('\n') + '\n\n';
    }
  } catch {}
  try {
    const r = await fetch(`${base}/git/trees/HEAD?recursive=1`, { headers });
    const j = await r.json();
    if (j && Array.isArray(j.tree)) {
      const paths = j.tree.filter(x => x.type === 'blob').map(x => x.path).slice(0, 200);
      if (paths.length) ctx += 'מבנה הקבצים בריפו (עד 200):\n' + paths.join('\n') + '\n\n';
    }
  } catch {}
  const out = ctx ? ('הקשר מ-GitHub (' + ghConfig.owner + '/' + ghConfig.repo + '):\n' + ctx) : '';
  _ghCtxCache = { at: Date.now(), text: out };
  return out;
}

// ---- Live GitHub connection check — this is the actual "connect" button behind the modal.
// It hits the real GitHub API (repo reachability + token identity) so the UI can show a true
// connected/failed state instead of just "a token string is present". Cached briefly so opening
// the modal or refreshing the MVP banner repeatedly doesn't burn API rate limit.
let _ghStatusCache = { at: 0, data: null };
function invalidateGhStatusCache() { _ghStatusCache = { at: 0, data: null }; }
async function ghConnectionStatus(force) {
  reloadGhConfig();
  if (!force && _ghStatusCache.data && Date.now() - _ghStatusCache.at < 30000) return _ghStatusCache.data;
  if (!ghConfig.enabled) {
    return { ok: false, checked: false, error: 'חיבור GitHub אינו מופעל.' };
  }
  if (!ghConfig.owner || !ghConfig.repo) {
    return { ok: false, checked: true, error: 'חסר Owner ו/או שם ריפו.' };
  }
  const headers = { 'User-Agent': 'on-track-app', Accept: 'application/vnd.github+json' };
  if (ghConfig.token) headers.Authorization = `Bearer ${ghConfig.token}`;
  let data;
  try {
    const r = await fetch(`https://api.github.com/repos/${ghConfig.owner}/${ghConfig.repo}`, { headers });
    const j = await r.json();
    if (!r.ok) {
      data = { ok: false, checked: true, error: j.message || ('GitHub API החזיר שגיאה (' + r.status + ')') };
    } else {
      data = {
        ok: true, checked: true,
        fullName: j.full_name, private: !!j.private,
        defaultBranch: j.default_branch, htmlUrl: j.html_url,
        permissions: j.permissions || null,
        authenticated: false, login: null, scopes: []
      };
      if (ghConfig.token) {
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
    }
  } catch (e) {
    data = { ok: false, checked: true, error: 'שגיאת רשת מול GitHub: ' + e.message };
  }
  _ghStatusCache = { at: Date.now(), data };
  return data;
}

function projectPromptContext(promptText) {
  const raw = (promptText || '').trim();
  if (!raw) return '';
  let s = 'בקשת המשתמש:\n' + raw + '\n\n';
  const codeCtx = localRepoContext(raw, null, null, null);
  if (codeCtx) s += codeCtx + '\n---\n';
  return s;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  try {
    // --- the dashboard page ---
    if (p === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(HTML_FILE));
    }
    if ((p === '/PROJECT_INFO.md' || p === '/project-info.md') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(PROJECT_INFO_FILE));
    }
    if (p === '/api/project/state' && req.method === 'GET') {
      reloadProjectState();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(projectState));
    }
    if (p === '/api/project/state' && req.method === 'POST') {
      const b = await readBody(req);
      reloadProjectState();
      if (typeof b.title === 'string' && b.title.trim()) projectState.title = b.title.trim();
      if (typeof b.status === 'string' && b.status.trim()) projectState.status = b.status.trim();
      if (typeof b.goal === 'string' && b.goal.trim()) projectState.goal = b.goal.trim();
      if (Array.isArray(b.completed)) projectState.completed = b.completed.map(x => String(x).trim()).filter(Boolean);
      if (Array.isArray(b.nextSteps)) projectState.nextSteps = b.nextSteps.map(x => String(x).trim()).filter(Boolean);
      if (Array.isArray(b.notes)) projectState.notes = b.notes.map(x => String(x).trim()).filter(Boolean);
      saveProjectState();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, ...projectState }));
    }
    if (p === '/api/workspace' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(projectSummary()));
    }
    if (p === '/api/workspace/select' && req.method === 'POST') {
      const b = await readBody(req);
      if (typeof b.projectId === 'string' && workspaceState.projects.some(pj => pj.id === b.projectId)) {
        workspaceState.selectedProjectId = b.projectId;
      }
      if (typeof b.libraryId === 'string' && workspaceState.libraries.some(lb => lb.id === b.libraryId)) {
        workspaceState.selectedLibraryId = b.libraryId;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(projectSummary()));
    }

    // --- static category / browser / resolution lists (for the composer dropdowns) ---
    if (p === '/api/categories' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(CATEGORIES));
    }
    if (p === '/api/browsers' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(BROWSERS));
    }
    if (p === '/api/resolutions' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(RESOLUTIONS));
    }
    if (p === '/api/modules' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(MODULES));
    }
    if (p === '/api/severities' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(SEVERITIES));
    }
    if (p === '/api/priorities' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(PRIORITIES));
    }

    // --- current state ---
    if (p === '/api/state' && req.method === 'GET') {
      return respondState(res);
    }

    // --- long poll: resolves when something changes, or after 55s ---
    if (p === '/api/wait' && req.method === 'GET') {
      const since = parseInt(u.searchParams.get('since') || '0', 10);
      if (state.version > since) return respondState(res);
      const w = { res, timer: null };
      w.timer = setTimeout(() => {
        waiters = waiters.filter(x => x !== w);
        respondState(res);
      }, 55000);
      waiters.push(w);
      return;
    }

    // --- add a check request (optionally with a pasted/attached image) ---
    if (p === '/api/add' && req.method === 'POST') {
      const b = await readBody(req);
      const text = (b.text || '').trim();
      const screen = (b.screen || '').trim();
      const steps = (b.steps || '').trim();
      const expected = (b.expected || '').trim();
      if (!text && !b.image) { res.writeHead(400); return res.end('empty'); }
      if ([text, screen, steps, expected].some(looksLikeMojibake)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: MOJIBAKE_ERR }));
      }
      let image = null;
      if (typeof b.image === 'string' && b.image.startsWith('data:image/')) {
        const m = b.image.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/);
        if (m) {
          const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
          const fname = `img_${state.nextId}_${Date.now()}.${ext}`;
          fs.writeFileSync(path.join(IMG_DIR, fname), Buffer.from(m[2], 'base64'));
          image = 'images/' + fname;
        }
      }
      const validCat = CATEGORIES.some(c => c.id === b.category);
      const validBrowser = BROWSERS.some(c => c.id === b.browser);
      const validRes = RESOLUTIONS.some(c => c.id === b.resolution);
      const validMod = MODULES.some(c => c.id === b.module);
      const task = {
        id: state.nextId++,
        text,
        screen: screen || null,        // which feature / screen / URL to test
        steps: steps || null,          // steps to reproduce / how to get there
        expected: expected || null,    // expected result — the oracle for PASS/FAIL
        image,
        category: validCat ? b.category : null,   // functional | uiux | responsive | performance | security | accessibility | other
        browser: validBrowser ? b.browser : null,     // chrome | safari | firefox | edge | other
        resolution: validRes ? b.resolution : null,   // desktop | tablet | mobile
        module: validMod ? b.module : null,           // login | registration | profile | search | forms | crud | permissions | session | navigation | upload_download | error_handling | other
        status: 'open',            // open | in_progress | partial | done
        result: null,              // null | 'pass' | 'fail' — set by the QA agent when done
        severity: null,            // null | critical | high | medium | low — set when result is 'fail'
        priority: null,            // null | p1 | p2 | p3 | p4 — set when result is 'fail'
        note: '',
        held: !!b.held,             // true = agent must not touch this yet (user-controlled)
        source: b.source || 'dashboard',
        agent: (b.agent && String(b.agent).trim()) || null,  // which agent added this, if any
        created: new Date().toISOString()
      };
      state.tasks.push(task);
      bump();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, id: task.id }));
    }

    // --- update a check's status/result/note (used by the agent) ---
    if (p === '/api/update' && req.method === 'POST') {
      const b = await readBody(req);
      const t = state.tasks.find(x => x.id === b.id);
      if (!t) { res.writeHead(404); return res.end('no task'); }
      if (b.note !== undefined && looksLikeMojibake(b.note)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: MOJIBAKE_ERR }));
      }
      if (b.status) t.status = b.status;
      if (b.result === 'pass' || b.result === 'fail' || b.result === null) t.result = b.result;
      if (b.severity === null || SEVERITIES.some(s => s.id === b.severity)) t.severity = b.severity;
      if (b.priority === null || PRIORITIES.some(s => s.id === b.priority)) t.priority = b.priority;
      if (b.note !== undefined) t.note = b.note;
      if (b.agent) t.lastAgent = String(b.agent).trim();
      bump();
      return res.end(JSON.stringify({ ok: true }));
    }

    // --- mark / unmark a check as urgent (jumps ahead in FIFO order) ---
    if (p === '/api/priority' && req.method === 'POST') {
      const b = await readBody(req);
      const t = state.tasks.find(x => x.id === b.id);
      if (!t) { res.writeHead(404); return res.end('no task'); }
      t.urgent = !!b.urgent;
      bump();
      return res.end(JSON.stringify({ ok: true, urgent: t.urgent }));
    }

    // --- hold / release a single check — agent must skip it entirely while held ---
    if (p === '/api/hold' && req.method === 'POST') {
      const b = await readBody(req);
      const t = state.tasks.find(x => x.id === b.id);
      if (!t) { res.writeHead(404); return res.end('no task'); }
      t.held = !!b.held;
      bump();
      return res.end(JSON.stringify({ ok: true, held: t.held }));
    }

    // --- raise / lower the stop flag ---
    if (p === '/api/flag' && req.method === 'POST') {
      const b = await readBody(req);
      state.stop = !!b.stop;
      bump();
      return res.end(JSON.stringify({ ok: true, stop: state.stop }));
    }

    // --- refine-service config: read (never expose the raw key) / write ---
    if (p === '/api/config' && req.method === 'GET') {
      reloadLlmConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        enabled: llmConfig.enabled,
        hasKey: !!llmConfig.apiKey,
        provider: llmConfig.provider,
        model: llmConfig.model,
        baseUrl: llmConfig.baseUrl
      }));
    }
    if (p === '/api/config' && req.method === 'POST') {
      const b = await readBody(req);
      if (typeof b.enabled === 'boolean') llmConfig.enabled = b.enabled;
      if (b.provider === 'openai' || b.provider === 'gemini') llmConfig.provider = b.provider;
      if (typeof b.apiKey === 'string' && b.apiKey.trim()) llmConfig.apiKey = b.apiKey.trim();
      if (b.apiKey === null) llmConfig.apiKey = null;
      if (typeof b.model === 'string' && b.model.trim()) llmConfig.model = b.model.trim();
      if (typeof b.baseUrl === 'string' && b.baseUrl.trim()) llmConfig.baseUrl = b.baseUrl.trim().replace(/\/+$/, '');
      saveLlmConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, enabled: llmConfig.enabled, hasKey: !!llmConfig.apiKey }));
    }

    // --- models registry: which model runs the QA checks (built-in / external) ---
    if (p === '/api/models' && req.method === 'GET') {
      reloadModelsConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(publicModels()));
    }
    if (p === '/api/models/select' && req.method === 'POST') {
      const b = await readBody(req);
      reloadModelsConfig();
      if (modelsConfig.models.some(m => m.id === b.id)) {
        modelsConfig.selectedId = b.id;
        saveModelsConfig();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, selectedId: modelsConfig.selectedId }));
      }
      res.writeHead(404); return res.end('no such model');
    }
    if (p === '/api/models/add' && req.method === 'POST') {
      const b = await readBody(req);
      const label = (b.label || '').trim();
      if (!label) { res.writeHead(400); return res.end('missing label'); }
      if (looksLikeMojibake(label)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: MOJIBAKE_ERR }));
      }
      reloadModelsConfig();
      const m = {
        id: 'ext-' + Date.now(), builtin: false, label,
        provider: b.provider === 'openai' ? 'openai' : 'gemini',
        baseUrl: (b.baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, ''),
        model: (b.model || '').trim(),
        apiKey: (b.apiKey || '').trim() || null
      };
      modelsConfig.models.push(m);
      if (b.select) modelsConfig.selectedId = m.id;
      saveModelsConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, id: m.id }));
    }
    if (p === '/api/models/update' && req.method === 'POST') {
      const b = await readBody(req);
      reloadModelsConfig();
      const m = modelsConfig.models.find(x => x.id === b.id);
      if (!m) { res.writeHead(404); return res.end('no such model'); }
      if (m.builtin) { res.writeHead(400); return res.end('cannot edit a built-in model'); }
      if (typeof b.label === 'string' && b.label.trim()) m.label = b.label.trim();
      if (b.provider === 'openai' || b.provider === 'gemini') m.provider = b.provider;
      if (typeof b.baseUrl === 'string' && b.baseUrl.trim()) m.baseUrl = b.baseUrl.trim().replace(/\/+$/, '');
      if (typeof b.model === 'string') m.model = b.model.trim();
      if (typeof b.apiKey === 'string' && b.apiKey.trim()) m.apiKey = b.apiKey.trim();
      if (b.apiKey === null) m.apiKey = null;
      saveModelsConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (p === '/api/models/delete' && req.method === 'POST') {
      const b = await readBody(req);
      reloadModelsConfig();
      const m = modelsConfig.models.find(x => x.id === b.id);
      if (!m) { res.writeHead(404); return res.end('no such model'); }
      if (m.builtin) { res.writeHead(400); return res.end('cannot delete a built-in model'); }
      modelsConfig.models = modelsConfig.models.filter(x => x.id !== b.id);
      if (modelsConfig.selectedId === b.id) modelsConfig.selectedId = modelsConfig.models[0].id;
      saveModelsConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, selectedId: modelsConfig.selectedId }));
    }
    // --- test that an external model is actually reachable (real minimal API call) ---
    if (p === '/api/models/test' && req.method === 'POST') {
      const b = await readBody(req);
      reloadModelsConfig();
      const m = modelsConfig.models.find(x => x.id === (b.id || modelsConfig.selectedId));
      if (!m) { res.writeHead(404); return res.end('no such model'); }
      if (m.builtin) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, builtin: true,
          message: 'מודל מובנה (Claude) — רץ דרך סשן Claude Code שמושך את התור, לא דרך מפתח API. "מחובר" = יש סשן פעיל שעובד על התור.' }));
      }
      if (!m.apiKey) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'לא הוגדר מפתח API למודל הזה.' }));
      }
      try {
        if (m.provider === 'openai') {
          const r = await fetch(`${m.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${m.apiKey}` },
            body: JSON.stringify({ model: m.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 })
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error?.message || ('HTTP ' + r.status));
        } else {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${m.model}:generateContent?key=${encodeURIComponent(m.apiKey)}`;
          const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: 'ping' }] }] }) });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error?.message || ('HTTP ' + r.status));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, message: 'המודל הגיב בהצלחה — החיבור תקין.' }));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    // --- trigger the selected EXTERNAL model to analyze open checks on the queue ---
    // A chat model can't drive a browser, so it does NOT run tests or assign PASS/FAIL.
    // It produces a QA analysis (expected result, negative scenarios, risks) per open
    // check, posted as an agent reply, and moves the check to in_progress for a human /
    // browser-driving agent to finalize. This keeps the "no hollow PASS" rule intact.
    if (p === '/api/agent/run' && req.method === 'POST') {
      reloadModelsConfig();
      const m = modelsConfig.models.find(x => x.id === modelsConfig.selectedId);
      if (!m) { res.writeHead(404); return res.end('no model selected'); }
      if (m.builtin) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'המודל הנבחר מובנה (Claude) — הוא רץ דרך סשן Claude Code שמושך את התור, לא דרך הכפתור הזה. הכפתור מפעיל מודל חיצוני בלבד.' }));
      }
      if (!m.apiKey) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'לא הוגדר מפתח API למודל הנבחר.' }));
      }
      if (state.stop) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'הדגל 🚩 מורם — הסר אותו כדי להריץ.' }));
      }
      // Grounding context from the actual code (local folder + GitHub). Repo-level GitHub part
      // is cached; local part is per-check (matches files to the check). Computed inside the loop.
      const ghCtx = await githubRepoContext();
      const hasAnyCode = !!ghCtx || !!localRepo.path;
      // Live page state from the tool's OWN local browser (loads the app, reads DOM + console).
      let previewCtx = '';
      if (puppeteer && previewConfig.baseUrl) {
        try {
          const cap = await previewCapture(previewConfig.baseUrl, { shot: false });
          previewCtx = 'מצב הדף החי (נטען מהדפדפן המקומי — ' + cap.url + ', סטטוס HTTP ' + cap.status + '):\n' +
            'כותרת: ' + (cap.title || '') + '\n' +
            (cap.consoleErrors.length ? ('שגיאות קונסול (' + cap.consoleErrors.length + '):\n' + cap.consoleErrors.join('\n') + '\n') : 'אין שגיאות קונסול.\n') +
            (cap.failedReqs.length ? ('בקשות רשת שנכשלו:\n' + cap.failedReqs.join('\n') + '\n') : '') +
            'טקסט הדף (קטע):\n' + (cap.text || '').slice(0, 3000) + '\n';
        } catch (e) { previewCtx = '⚠️ תצוגה מקדימה נכשלה: ' + e.message + '\n'; }
      }
      const hasDynamic = !!previewCtx && !previewCtx.startsWith('⚠️');
      let SYS = hasAnyCode
        ? ('אתה סוכן QA שמבצע **בדיקת קוד סטטית**. צורף לך הקוד האמיתי: מבנה הקבצים, ותוכן/קטעים של ' +
           'הקבצים הרלוונטיים ביותר שנמצאו בחיפוש תוכן, וגם issues פתוחים. **חשוב: התוכן שצורף הוא מה ' +
           'שיש — נתח אותו, אל תבקש קבצים.** אם הקוד הרלוונטי נראה חלקי, הסק מה שאפשר וציין במפורש איזה ' +
           'קטע/פונקציה עוד היית רוצה (כהערה). אתר את הקובץ/הפונקציה/השורה שגורמת לבעיה והצבע עליה בשם ' +
           'קובץ וציטוט קצר. החזר בעברית: (1) ממצא קונקרטי מהקוד (קובץ + ציטוט + הסבר) או "לא נמצא באג ' +
           'בקוד שצורף, החשד הגבוה ביותר: <קובץ/פונקציה>", (2) תוצאה צפויה חד-משמעית, (3) 2-3 תרחישים ' +
           'שליליים/קצה, (4) מה עוד צריך בדיקה דינמית בדפדפן. בלי הקדמות.')
        : ('אתה סוכן QA. אתה פועל דרך API טקסטואלי בלבד ואינך יכול להריץ את האתר, ללחוץ, או לראות את ' +
           'המערכת, ואין לך את הקוד — לכן אסור לך לטעון שבדקת או לקבוע PASS/FAIL. החזר ניתוח בעברית: ' +
           '(1) תוצאה צפויה חד-משמעית, (2) 2-3 תרחישים שליליים/קצה, (3) סיכונים/אזורים מושפעים. ' +
           'עבור תגובת המשך של המשתמש: ענה לגופה. בלי הקדמות.');
      if (hasDynamic) {
        SYS += ' **בנוסף צורף לך מצב הדף החי** (נטען מדפדפן מקומי אמיתי): כותרת, שגיאות קונסול, בקשות ' +
          'רשת שנכשלו, וטקסט הדף. שגיאת קונסול או בקשת רשת שנכשלה הן **ממצא אמיתי** — ציין אותן. עדיין ' +
          'לא בוצעו לחיצות/מילוי טפסים (רק טעינת הדף), אז אל תטען שבדקת זרימה אינטראקטיבית מלאה.';
      }
      // Compose the model input from ALL the structured fields + code context + live page state.
      function taskContext(t) {
        let s = '';
        if (previewCtx) s += previewCtx + '\n---\n';
        const codeCtx = ghCtx + localRepoContext(t.text, t.screen, t.steps, t.expected);
        if (codeCtx) s += codeCtx + '\n---\n';
        s += 'בדיקה: ' + (t.text || '');
        if (t.screen)   s += '\nמסך/כתובת: ' + t.screen;
        if (t.steps)    s += '\nצעדים: ' + t.steps;
        if (t.expected) s += '\nתוצאה צפויה: ' + t.expected;
        // include the recent thread so a follow-up reply has context
        if (Array.isArray(t.thread) && t.thread.length) {
          s += '\n\nשרשור:\n' + t.thread.slice(-6).map(x => (x.from === 'user' ? 'משתמש: ' : 'סוכן: ') + (x.text || '')).join('\n');
        }
        return s;
      }
      // Process both NEW open checks AND checks where the user replied (awaitingAgent) — so a
      // reply DOES get picked up by the trigger, not only brand-new checks.
      const items = state.tasks.filter(t => !t.held && (t.status === 'open' || t.awaitingAgent)).slice(0, 8);
      if (!items.length) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, processed: 0, message: 'אין בדיקות פתוחות או תגובות ממתינות בתור.' }));
      }
      let processed = 0, replies = 0; const errors = [];
      for (const t of items) {
        const isReply = !!t.awaitingAgent;
        try {
          let text;
          if (m.provider === 'openai') {
            const r = await fetch(`${m.baseUrl}/chat/completions`, {
              method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${m.apiKey}` },
              body: JSON.stringify({ model: m.model, messages: [{ role: 'system', content: SYS }, { role: 'user', content: taskContext(t) }] })
            });
            const j = await r.json();
            if (!r.ok) throw new Error(j.error?.message || ('HTTP ' + r.status));
            text = j.choices?.[0]?.message?.content || '';
          } else {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${m.model}:generateContent?key=${encodeURIComponent(m.apiKey)}`;
            const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ systemInstruction: { parts: [{ text: SYS }] }, contents: [{ parts: [{ text: taskContext(t) }] }] }) });
            const j = await r.json();
            if (!r.ok) throw new Error(j.error?.message || ('HTTP ' + r.status));
            text = (j.candidates?.[0]?.content?.parts || []).map(x => x.text || '').join('');
          }
          if (!Array.isArray(t.thread)) t.thread = [];
          const kind = hasDynamic ? 'בדיקה על הדף החי' : (hasAnyCode ? 'ניתוח קוד' : 'ניתוח מקדים');
          const caveat = hasDynamic ? ', נטען הדף החי מדפדפן מקומי; לא בוצעו לחיצות/זרימה'
                       : (hasAnyCode ? ', לא בוצעה בדיקה דינמית בדפדפן' : ', לא בוצעה בדיקה בפועל');
          const prefix = (isReply ? '💬 תגובה — ' : '🔎 ') + kind + ' (' + m.label + caveat + '):\n';
          t.thread.push({ from: 'agent', text: prefix + text, image: null, agent: m.label, created: new Date().toISOString() });
          if (!isReply) t.status = 'in_progress';   // new check → picked up
          t.lastAgent = m.label;
          t.awaitingAgent = false;                   // posting an agent reply clears the waiting flag
          processed++; if (isReply) replies++;
        } catch (e) { errors.push(`#${t.id}: ${e.message}`); }
      }
      bump();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, processed, replies, total: items.length, errors }));
    }

    // --- LIVE interactive run: the model drives a real browser on one check, step by step ---
    if (p === '/api/agent/run-live' && req.method === 'POST') {
      const b = await readBody(req);
      reloadModelsConfig();
      const m = modelsConfig.models.find(x => x.id === modelsConfig.selectedId);
      if (!m) { res.writeHead(404); return res.end('no model selected'); }
      if (m.builtin) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'המודל הנבחר מובנה (Claude) — הרצה חיה כאן היא למודל חיצוני. Claude רץ דרך סשן Claude Code.' })); }
      if (!m.apiKey) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'לא הוגדר מפתח API למודל הנבחר.' })); }
      if (!puppeteer) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'מנוע הדפדפן (puppeteer-core) לא מותקן.' })); }
      if (liveSession.running) { res.writeHead(409, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'הרצה חיה כבר פעילה — המתן שתסתיים.' })); }
      const t = state.tasks.find(x => x.id === b.id);
      if (!t) { res.writeHead(404); return res.end('no task'); }
      // run in the background so the dashboard can poll /api/agent/session live
      (async () => {
        // Run the check; if it throws, still fall through and post a report so the user always
        // gets the transcript + a reason — never a silent "nothing happened".
        try {
          await runLiveCheck(m, t);
        } catch (e) {
          liveSession.running = false;
          if (!liveSession.note) liveSession.note = modelErrNote(e.message);
          pushStep({ action: 'error', detail: e.message });
        }
        try {
          const lines = liveSession.steps.map(s => {
            const a = s.action + (s.index != null ? ' [' + s.index + ']' : '') + (s.text ? ' "' + String(s.text).slice(0, 40) + '"' : '');
            return '• ' + a + (s.detail ? ' — ' + s.detail : '');
          }).join('\n');
          const v = liveSession.verdict;
          const tally = liveSession.tally || {};
          const head = '🖥️ בדיקה חיה בדפדפן (' + m.label + '): ' + (v ? v.toUpperCase() : (liveSession.stoppedByUser ? 'נעצר ידנית' : 'ללא הכרעה')) + (liveSession.note ? ' — ' + liveSession.note : '');
          // A summary the user can read at a glance — what was actually done — before the raw transcript.
          const summ = [];
          summ.push('• תורי פעולה: ' + (tally.turns || 0));
          if (tally.saved) summ.push('• רשומות שנשמרו (fill+submit): ' + tally.saved);
          if (tally.clicks) summ.push('• לחיצות: ' + tally.clicks);
          if (liveSession.history && liveSession.history.length) summ.push('• רשומות שהוספו: ' + liveSession.history.join(' ; '));
          const body = head + '\n\n📊 סיכום:\n' + summ.join('\n') + '\n\n🧾 מהלך מפורט (עד 40 צעדים אחרונים):\n' + (lines || '(לא בוצעו צעדים)');
          if (!Array.isArray(t.thread)) t.thread = [];
          t.thread.push({ from: 'agent', text: body, image: null, agent: m.label, created: new Date().toISOString() });
          t.status = 'done';
          if (v === 'pass' || v === 'fail') t.result = v;
          t.lastAgent = m.label; t.awaitingAgent = false;
          bump();
        } catch (e2) { /* reporting must never throw */ }
      })();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, started: true, checkId: t.id }));
    }
    // --- poll the current live browser session (screenshot + action log) ---
    if (p === '/api/agent/session' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(liveSession));
    }
    // --- stop the live run (user pressed ⏹). Mark it so the report says "stopped manually". ---
    if (p === '/api/agent/stop-live' && req.method === 'POST') {
      liveSession.running = false;
      liveSession.stoppedByUser = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }

    // --- hand a QA finding off to the request-tracking "forum" as a fix request ---
    // Server-to-server POST (no browser CORS). Composes the full check context + latest
    // QA analysis into one forum request the dev agent can act on.
    if (p === '/api/forum/send' && req.method === 'POST') {
      const b = await readBody(req);
      const t = state.tasks.find(x => x.id === b.id);
      if (!t) { res.writeHead(404); return res.end('no task'); }
      let body = 'בקשת תיקון מדשבורד ה-QA (בדיקה #' + t.id + '): ' + (t.text || '');
      if (t.screen)   body += '\nמסך/כתובת: ' + t.screen;
      if (t.steps)    body += '\nצעדים לשחזור: ' + t.steps;
      if (t.expected) body += '\nתוצאה צפויה: ' + t.expected;
      if (t.result === 'fail') {
        body += '\nתוצאה: ❌ FAIL' + (t.severity ? (' · חומרה ' + t.severity) : '') + (t.priority ? (' · עדיפות ' + t.priority) : '');
      }
      if (t.note) body += '\nהערת בודק: ' + t.note;
      const lastAgent = Array.isArray(t.thread) ? [...t.thread].reverse().find(m => m.from === 'agent') : null;
      if (lastAgent && lastAgent.text) body += '\n\n' + lastAgent.text;
      try {
        const r = await fetch(FORUM_URL + '/api/add', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: body, source: 'qa', agent: 'QA Dashboard' })
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        // remember on the check that it was sent, so the UI can show it
        t.forum = { id: j.id, at: new Date().toISOString() };
        bump();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, forumId: j.id }));
      } catch (e) {
        const msg = /ECONNREFUSED|fetch failed/i.test(e.message)
          ? 'הפורום (' + FORUM_URL + ') לא זמין — ודא שהשרת של הפורום רץ.'
          : e.message;
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: msg }));
      }
    }
    // --- manually run the forum-fix sync now (the poller also runs it every 20s) ---
    if (p === '/api/forum/sync' && req.method === 'POST') {
      const before = state.tasks.length;
      await pollForumFixes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, created: state.tasks.length - before }));
    }

    // --- GitHub connection config: read (never expose the raw token) / write ---
    if (p === '/api/github/config' && req.method === 'GET') {
      reloadGhConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        enabled: ghConfig.enabled, hasToken: !!ghConfig.token,
        owner: ghConfig.owner, repo: ghConfig.repo
      }));
    }
    if (p === '/api/github/config' && req.method === 'POST') {
      const b = await readBody(req);
      if (typeof b.enabled === 'boolean') ghConfig.enabled = b.enabled;
      if (typeof b.owner === 'string' && b.owner.trim()) ghConfig.owner = b.owner.trim();
      if (typeof b.repo === 'string' && b.repo.trim()) ghConfig.repo = b.repo.trim();
      if (typeof b.token === 'string' && b.token.trim()) ghConfig.token = b.token.trim();
      if (b.token === null) ghConfig.token = null;
      saveGhConfig();
      invalidateGhStatusCache();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, enabled: ghConfig.enabled, hasToken: !!ghConfig.token }));
    }

    // --- GitHub connection test: actually calls the GitHub API (repo + token identity) so the
    // UI can show a real connected/failed state, not just "fields are filled in". GET returns a
    // short-lived cached result (cheap polling for the header dot / MVP chip); POST forces a
    // fresh check (used by the explicit "בדוק חיבור" button after Save).
    if (p === '/api/github/status' && (req.method === 'GET' || req.method === 'POST')) {
      const data = await ghConnectionStatus(req.method === 'POST');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    }

    // --- local project folder (fed to the external model as code context) ---
    if (p === '/api/localrepo/config' && req.method === 'GET') {
      reloadLocalRepo();
      let ok = false, fileCount = 0;
      if (localRepo.path) { try { ok = fs.statSync(localRepo.path).isDirectory(); } catch {} }
      if (ok) { const f = []; walkLocal(localRepo.path, localRepo.path, f, 400); fileCount = f.length; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ path: localRepo.path, exists: ok, fileCount }));
    }
    if (p === '/api/localrepo/config' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.path === null || b.path === '') localRepo.path = null;
      else if (typeof b.path === 'string') localRepo.path = b.path.trim();
      saveLocalRepo();
      let ok = false, fileCount = 0;
      if (localRepo.path) { try { ok = fs.statSync(localRepo.path).isDirectory(); } catch {} }
      if (ok) { const f = []; walkLocal(localRepo.path, localRepo.path, f, 400); fileCount = f.length; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, path: localRepo.path, exists: ok, fileCount }));
    }

    // --- local preview browser: config + capture ---
    if (p === '/api/preview/config' && req.method === 'GET') {
      previewConfig = loadPreviewConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        baseUrl: previewConfig.baseUrl,
        chromePath: previewConfig.chromePath || detectChrome(),
        engineReady: !!puppeteer,
        chromeFound: !!(previewConfig.chromePath || detectChrome())
      }));
    }
    if (p === '/api/preview/config' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.baseUrl === null || b.baseUrl === '') previewConfig.baseUrl = null;
      else if (typeof b.baseUrl === 'string') previewConfig.baseUrl = b.baseUrl.trim().replace(/\/+$/, '');
      if (b.chromePath === null || b.chromePath === '') previewConfig.chromePath = null;
      else if (typeof b.chromePath === 'string') previewConfig.chromePath = b.chromePath.trim();
      savePreviewConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, baseUrl: previewConfig.baseUrl, engineReady: !!puppeteer, chromeFound: !!(previewConfig.chromePath || detectChrome()) }));
    }
    if (p === '/api/preview/capture' && req.method === 'POST') {
      const b = await readBody(req);
      const url = (typeof b.url === 'string' && b.url.trim()) ? b.url.trim() : resolvePreviewUrl(b.screen);
      if (!url) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'לא הוגדרה כתובת אתר (Base URL) לתצוגה מקדימה.' })); }
      try {
        const cap = await previewCapture(url, { shot: b.shot !== false });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, ...cap }));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    // --- local dev server the tool starts/stops (serve the app under test locally) ---
    if (p === '/api/localserver/config' && req.method === 'GET') {
      lsConfig = loadLsConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ...lsConfig, running: !!lsProc, url: lsUrl(), log: lsLog.slice(-10) }));
    }
    if (p === '/api/localserver/config' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.mode === 'static' || b.mode === 'command') lsConfig.mode = b.mode;
      if (typeof b.dir === 'string') lsConfig.dir = b.dir.trim();
      if (b.port != null && !isNaN(parseInt(b.port, 10))) lsConfig.port = parseInt(b.port, 10);
      if (typeof b.command === 'string') lsConfig.command = b.command.trim();
      if (typeof b.cwd === 'string') lsConfig.cwd = b.cwd.trim();
      saveLsConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, ...lsConfig, running: !!lsProc, url: lsUrl() }));
    }
    if (p === '/api/localserver/start' && req.method === 'POST') {
      try {
        const r = startLocalServer();
        // give it a moment, then report reachability
        await new Promise(rs => setTimeout(rs, 1200));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, running: !!lsProc, url: lsUrl(), ...r, log: lsLog.slice(-6) }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }
    if (p === '/api/localserver/stop' && req.method === 'POST') {
      const r = stopLocalServer();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, running: !!lsProc, ...r }));
    }

    // --- list open GitHub issues on the configured repo (read-only convenience) ---
    if (p === '/api/github/issues' && req.method === 'GET') {
      reloadGhConfig();
      if (!ghConfig.enabled || !ghConfig.owner || !ghConfig.repo) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'חיבור GitHub אינו פעיל, או שחסר owner/repo.' }));
      }
      try {
        const headers = { 'User-Agent': 'qa-dashboard', Accept: 'application/vnd.github+json' };
        if (ghConfig.token) headers.Authorization = `Bearer ${ghConfig.token}`;
        const r = await fetch(`https://api.github.com/repos/${ghConfig.owner}/${ghConfig.repo}/issues?state=open&per_page=50`, { headers });
        const j = await r.json();
        if (!r.ok) throw new Error(j.message || 'שגיאה מול GitHub API');
        const issues = (Array.isArray(j) ? j : []).filter(i => !i.pull_request)
          .map(i => ({ number: i.number, title: i.title, url: i.html_url, state: i.state, labels: (i.labels || []).map(l => l.name) }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ issues }));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    // --- create a GitHub issue from a check (e.g. a confirmed FAIL / bug) ---
    if (p === '/api/github/create-issue' && req.method === 'POST') {
      reloadGhConfig();
      if (!ghConfig.enabled || !ghConfig.owner || !ghConfig.repo || !ghConfig.token) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'חיבור GitHub אינו פעיל, או שחסר owner/repo/token.' }));
      }
      const b = await readBody(req);
      const title = (b.title || '').trim();
      if (!title) { res.writeHead(400); return res.end('missing title'); }
      try {
        const r = await fetch(`https://api.github.com/repos/${ghConfig.owner}/${ghConfig.repo}/issues`, {
          method: 'POST',
          headers: {
            'User-Agent': 'qa-dashboard', Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${ghConfig.token}`, 'Content-Type': 'application/json'
          },
          body: JSON.stringify({ title, body: b.body || '' })
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.message || 'שגיאה מול GitHub API');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, number: j.number, url: j.html_url }));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    // --- send a draft (+ optional image) to the LLM to refine into a fuller check request ---
    if (p === '/api/refine' && req.method === 'POST') {
      reloadLlmConfig();
      const b = await readBody(req);
      if (!llmConfig.enabled || !llmConfig.apiKey) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'שירות השיפור אינו פעיל, או שלא הוגדר מפתח API.' }));
      }
      const imagePart = parseImagePart(b.image);
      try {
        let result;
        if (llmConfig.provider === 'openai') {
          result = await refineWithOpenAI(b.text || '', imagePart);
        } else {
          result = { text: await refineWithGemini(b.text || '', imagePart) };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    // --- post a reply into a check's thread (user OR agent) ---
    if (p === '/api/reply' && req.method === 'POST') {
      const b = await readBody(req);
      const t = state.tasks.find(x => x.id === b.id);
      if (!t) { res.writeHead(404); return res.end('no task'); }
      if (looksLikeMojibake(b.text)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: MOJIBAKE_ERR }));
      }
      if (!Array.isArray(t.thread)) t.thread = [];
      const from = b.from === 'agent' ? 'agent' : 'user';
      let image = null;
      if (typeof b.image === 'string' && b.image.startsWith('data:image/')) {
        const m = b.image.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/);
        if (m) {
          const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
          const fname = `img_${t.id}_${Date.now()}.${ext}`;
          fs.writeFileSync(path.join(IMG_DIR, fname), Buffer.from(m[2], 'base64'));
          image = 'images/' + fname;
        }
      }
      const agentName = from === 'agent' ? ((b.agent && String(b.agent).trim()) || 'סוכן') : undefined;
      t.thread.push({ from, text: (b.text || '').trim(), image, agent: agentName, created: new Date().toISOString() });
      // A user reply flags the check for the agent; an agent reply clears it.
      t.awaitingAgent = (from === 'user');
      if (agentName) t.lastAgent = agentName;
      bump();
      return res.end(JSON.stringify({ ok: true }));
    }

    // --- edit a check's text (and optionally replace/clear its image) ---
    if (p === '/api/edit' && req.method === 'POST') {
      const b = await readBody(req);
      const t = state.tasks.find(x => x.id === b.id);
      if (!t) { res.writeHead(404); return res.end('no task'); }
      if ([b.text, b.screen, b.steps, b.expected].some(v => typeof v === 'string' && looksLikeMojibake(v))) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: MOJIBAKE_ERR }));
      }
      if (typeof b.text === 'string') t.text = b.text.trim();
      if (typeof b.screen === 'string') t.screen = b.screen.trim() || null;
      if (typeof b.steps === 'string') t.steps = b.steps.trim() || null;
      if (typeof b.expected === 'string') t.expected = b.expected.trim() || null;
      if (b.category !== undefined) {
        t.category = CATEGORIES.some(c => c.id === b.category) ? b.category : null;
      }
      if (b.browser !== undefined) {
        t.browser = BROWSERS.some(c => c.id === b.browser) ? b.browser : null;
      }
      if (b.resolution !== undefined) {
        t.resolution = RESOLUTIONS.some(c => c.id === b.resolution) ? b.resolution : null;
      }
      if (b.module !== undefined) {
        t.module = MODULES.some(c => c.id === b.module) ? b.module : null;
      }
      if (b.image === null) {
        t.image = null;                          // image cleared
      } else if (typeof b.image === 'string' && b.image.startsWith('data:image/')) {
        const m = b.image.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/);
        if (m) {
          const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
          const fname = `img_${t.id}_${Date.now()}.${ext}`;
          fs.writeFileSync(path.join(IMG_DIR, fname), Buffer.from(m[2], 'base64'));
          t.image = 'images/' + fname;
        }
      }
      t.edited = new Date().toISOString();
      bump();
      return res.end(JSON.stringify({ ok: true }));
    }

    // --- delete a check ---
    if (p === '/api/delete' && req.method === 'POST') {
      const b = await readBody(req);
      state.tasks = state.tasks.filter(x => x.id !== b.id);
      bump();
      return res.end(JSON.stringify({ ok: true }));
    }

    // --- serve stored images ---
    if (p.startsWith('/images/') && req.method === 'GET') {
      const fp = path.join(IMG_DIR, path.basename(p));
      if (fs.existsSync(fp)) {
        res.writeHead(200, { 'Content-Type': CT[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
        return res.end(fs.readFileSync(fp));
      }
      res.writeHead(404); return res.end('no image');
    }

    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    res.writeHead(500); res.end('error: ' + e.message);
  }
});

// ---- closed loop: watch fix requests we sent to the forum; when the dev agent marks the
// forum task "done", auto-create a re-test check back here so QA re-verifies the fix. ----
async function pollForumFixes() {
  const pending = state.tasks.filter(t => t.forum && t.forum.id && !t.forum.retestCreated);
  if (!pending.length) return;
  let forumState;
  try {
    const r = await fetch(FORUM_URL + '/api/state');
    if (!r.ok) return;
    forumState = await r.json();
  } catch { return; }  // forum not running — try again next tick
  let changed = false;
  for (const t of pending) {
    const ft = (forumState.tasks || []).find(x => x.id === t.forum.id);
    if (ft && ft.status === 'done') {
      const retest = {
        id: state.nextId++,
        text: 'וידוא תיקון (חזר מהפורום #' + t.forum.id + '): ' + (t.text || ''),
        screen: t.screen || null,
        steps: t.steps || null,
        expected: t.expected || null,
        image: null,
        category: t.category || null,
        browser: t.browser || null,
        resolution: t.resolution || null,
        module: t.module || null,
        status: 'open',
        result: null,
        severity: null,
        priority: null,
        note: 'נוצר אוטומטית: הפורום סימן את התיקון של בדיקה #' + t.id + ' כבוצע. יש לוודא שהתקלה תוקנה, כולל ניסיונות שבירה סביב התיקון.',
        held: false,
        urgent: true,          // a re-test of a reported bug jumps the line
        source: 'qa-retest',
        retestOf: t.id,
        agent: null,
        created: new Date().toISOString()
      };
      state.tasks.push(retest);
      t.forum.retestCreated = true;
      t.forum.retestId = retest.id;
      changed = true;
    }
  }
  if (changed) bump();
}
setInterval(() => { pollForumFixes().catch(() => {}); }, 20000);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`QA dashboard running: http://localhost:${PORT}`);
  console.log(`Data: ${DATA_DIR}`);
  console.log(`Forum (fix queue): ${FORUM_URL}`);
});
