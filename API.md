# QA Dashboard API reference

Base URL (local): `http://localhost:8790`

All requests/responses are JSON (`Content-Type: application/json`).

---

## Data shapes

**State**
```json
{ "version": 12, "stop": false, "nextId": 8,
  "tasks": [ { "id": 1, "text": "לבדוק ש...", "image": null,
              "screen": "טופס עריכת דייר", "steps": "1. ... 2. ...", "expected": "השם נשמר",
              "category": "functional", "browser": "chrome", "resolution": "desktop",
              "module": "login", "status": "open", "result": null,
              "severity": null, "priority": null,
              "note": "", "held": false, "urgent": false,
              "source": "dashboard", "agent": null, "lastAgent": null,
              "thread": [], "created": "2026-07-23T14:11:30.021Z" } ] }
```
`text` is the short summary/title. `screen` (which feature/screen/URL), `steps` (repro steps),
and `expected` (**the acceptance oracle** — what counts as PASS) are optional structured
fields from the New-Check dialog. **`expected` is the criterion you judge PASS/FAIL against.**
If a check lacks the specifics needed to actually test it (no `expected`, no `steps`, vague
`text`), don't guess or hollow-PASS — post a `reply` asking for the missing detail and mark
it `partial`. That is the exact situation this field set exists to prevent.
`status` ∈ `open` · `in_progress` · `partial` · `done`.
`result` ∈ `null` · `"pass"` · `"fail"` — separate from `status`; only set once a check was
actually performed.
`category` ∈ `functional` · `uiux` · `responsive` · `performance` · `security` · `accessibility`
· `other` · `null`.
`browser` ∈ `chrome` · `safari` · `firefox` · `edge` · `other` · `null`.
`resolution` ∈ `desktop` · `tablet` · `mobile` · `null`.
`module` ∈ `login` · `registration` · `profile` · `search` · `forms` · `crud` · `permissions`
· `session` · `navigation` · `upload_download` · `error_handling` · `other` · `null` — the
functional feature area, from the STD (Software Test Design) spec.
`severity` ∈ `null` · `"critical"` · `"high"` · `"medium"` · `"low"` — bug impact, set
alongside `result:"fail"`.
`priority` ∈ `null` · `"p1"` · `"p2"` · `"p3"` · `"p4"` — urgency to fix, set alongside
`result:"fail"`. **Not the same thing as `urgent`** (queue-jump ordering, see `/api/priority`
below) — two unrelated "priority" concepts that happen to share a word.

These tags feed the dashboard's **📊 report view** (KPI tiles including open critical-bug
count, a checks-by-category bar chart with fail counts, a checks-by-browser donut, and a
filter panel across category / module / browser / resolution / agent / status / result /
severity) — set them on `add`/`edit`/`update` when relevant so the report is meaningful;
they're optional and the queue works fine without them.

---

## Endpoints

### Read the queue
```
GET /api/state
```

### Long-poll for changes (returns when state changes, or ~55s)
```
GET /api/wait?since=<version>
```

### QA scope categories / browsers / resolutions / modules / severities / priorities (for building composer dropdowns)
```
GET /api/categories    → [{ "id": "functional", "label": "פונקציונלי" }, …]
GET /api/browsers      → [{ "id": "chrome", "label": "Chrome" }, …]
GET /api/resolutions   → [{ "id": "desktop", "label": "דסקטופ" }, …]
GET /api/modules       → [{ "id": "login", "label": "Login / התחברות" }, …]
GET /api/severities    → [{ "id": "critical", "label": "Critical — המערכת אינה שמישה" }, …]
GET /api/priorities    → [{ "id": "p1", "label": "P1 — מיידי" }, …]
```

### Add a check request
```
POST /api/add
{ "text": "לבדוק ש...", "screen": "טופס X", "steps": "1. ...", "expected": "...",
  "image": "data:image/png;base64,…", "category": "functional",
  "browser": "chrome", "resolution": "desktop", "module": "login",
  "held": false, "agent": "Claude — QA" }   // everything except text/image is optional
→ { "ok": true, "id": 8 }
```
Rejects text that looks like corrupted encoding (mojibake) with `400 {"error": "..."}`.

### Set a check's status/result/severity/priority (this is how an agent reports progress)
```
POST /api/update
{ "id": 8, "status": "done", "result": "pass" }
{ "id": 8, "status": "done", "result": "fail", "severity": "high", "priority": "p2", "note": "concrete bug description" }
{ "id": 8, "status": "partial", "note": "waiting on user input" }
```
Invalid `severity`/`priority` values are silently ignored (not stored), same as an invalid
`category`/`browser`/`resolution`/`module` — the request still succeeds, just without that field applied.

### Reply into a check's thread (user or agent)
```
POST /api/reply
{ "id": 8, "from": "agent", "text": "...", "agent": "Claude — QA" }
```
A user reply sets `awaitingAgent: true` on the check; an agent reply clears it.

### Edit a check request
```
POST /api/edit
{ "id": 8, "text": "new text", "category": "security", "browser": "firefox",
  "resolution": "mobile", "module": "permissions", "image": "data:image/…"|null }
```

### Mark / unmark urgent (jumps ahead of plain FIFO order)
```
POST /api/priority
{ "id": 8, "urgent": true }
```
⚠️ This is queue ordering (`urgent`), unrelated to the bug-tracker `priority` *field*
(`p1`–`p4`) on a check, set via `/api/update` — same word, two different concepts.

### Hold / release a single check (user-only "don't touch yet" — agent must never set this)
```
POST /api/hold
{ "id": 8, "held": true }
```

### Stop flag (pauses the whole cycle)
```
POST /api/flag
{ "stop": true }
```

### Delete a check
```
POST /api/delete
{ "id": 8 }
```

### GitHub connection
```
GET  /api/github/config          → { "enabled": true, "hasToken": true, "owner": "...", "repo": "..." }
POST /api/github/config           { "enabled": true, "owner": "harel", "repo": "my-app", "token": "ghp_…" }
GET  /api/github/issues           → { "issues": [{ "number": 12, "title": "...", "url": "...", "labels": [] }] }
POST /api/github/create-issue     { "title": "QA FAIL: ...", "body": "..." } → { "ok": true, "number": 13, "url": "..." }
```

### External-model trigger (wake the selected external model to work the queue)
```
POST /api/models/test    { "id": "<modelId>" }   → { ok, message } | { error }  (real API ping)
POST /api/agent/run      {}   → { ok, processed, replies, errors }
```
`/api/agent/run` wakes the selected **external** model and runs it over every `open` check
AND every check with a pending user reply (`awaitingAgent`). It posts an analysis/reply per
item (it can't drive a browser, so it never sets PASS/FAIL). Built-in Claude models refuse
here — they run via a Claude Code session, not an API key.

### Forum hand-off + closed loop (QA → forum dev-fix queue → back to QA re-test)
```
POST /api/forum/send   { "id": <checkId> }   → { ok, forumId }
POST /api/forum/sync   {}                     → { ok, created }
```
`/api/forum/send` pushes a check (text + screen/steps/expected + latest analysis + severity)
to the request-tracking forum (`FORUM_URL`, default `http://localhost:8787`) as a fix request,
and records `task.forum = {id, at}`. A background poller (every 20s, or `/api/forum/sync` on
demand) watches those; when the forum marks the fix `done`, it auto-creates a **re-test**
check here (`source:"qa-retest"`, `retestOf:<originalId>`, `urgent:true`) so QA re-verifies
the fix. Work re-test checks like any other — confirm the original bug is gone, including
break attempts around the fix (rule 4c).

### LLM refine service (rewrites a raw draft into a clearer check request — never executes/answers it)
```
GET  /api/config    → { "enabled": true, "hasKey": true, "provider": "gemini", "model": "...", "baseUrl": "..." }
POST /api/config      { "enabled": true, "provider": "openai", "apiKey": "...", "model": "...", "baseUrl": "..." }
POST /api/refine      { "text": "raw draft", "image": "data:image/…" } → { "text": "refined check request" }
```

---

## Examples

**curl**
```bash
curl http://localhost:8790/api/state
curl -X POST http://localhost:8790/api/update \
  -H "Content-Type: application/json" \
  -d '{"id":8,"status":"done","result":"pass"}'
```

**JavaScript (fetch)**
```js
const s = await (await fetch('http://localhost:8790/api/state')).json();
const next = s.tasks.find(t => t.status === 'open' && !t.held);   // FIFO, skip held
await fetch('http://localhost:8790/api/update', {
  method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({ id: next.id, status: 'done', result: 'pass', agent: 'Claude — QA' })
});
```

**Python**
```python
import requests
B = "http://localhost:8790"
s = requests.get(f"{B}/api/state").json()
nxt = next((t for t in s["tasks"] if t["status"] == "open" and not t["held"]), None)
if nxt:
    requests.post(f"{B}/api/update", json={"id": nxt["id"], "status": "done", "result": "pass"})
```

---

## Minimal agent loop (any language)
1. `GET /api/state` — stop if `stop` is true.
2. Collect any check with `awaitingAgent == true` and `held != true`; reply to each first.
3. Take the first check where `status == "open"` and `held != true` (urgent first, then FIFO).
4. `POST /api/update {id, status:"in_progress", agent:"<your name>"}`.
5. **Actually perform the check** — don't guess a result.
6. `POST /api/update {id, status:"done", result:"pass"|"fail", note:"..."}` (or `"partial"` + `note` if blocked).
7. Repeat; when none are open, `GET /api/wait?since=<version>` and resume (or use `/loop` for
   true hands-off operation across turns).
