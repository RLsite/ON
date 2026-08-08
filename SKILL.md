---
name: qa-dashboard
description: Local QA testing dashboard with a continuous FIFO check-execution cycle. Use when the user runs /qa or asks to "start the QA dashboard", "run my test queue", or "open the QA tracker". Launches a local HTML dashboard (served by a tiny Node server) where the user writes free-text "what to check" requests — via a "➕ New check" dialog, with pasted/dropped/attached images and an optional QA-scope category/browser/resolution — that a QA agent then works through one by one in order, actually performing each check and marking PASS/FAIL, never letting a check fall through the cracks. The dashboard (KPIs + charts + filters) is the default main screen. A "🤖 Agent selection" panel assigns which agent a new check is meant for. Separate from and unrelated to the "forum" skill. Includes a 🚩 stop-flag for a clean halt and an optional GitHub connection for linking/filing bugs.
---

# QA Dashboard — test-check execution cycle

A local dashboard where the user writes free-text QA requests ("what to check") and a
dedicated **QA agent** works through them in a continuous FIFO loop, actually performing
each check and reporting **PASS** or **FAIL** — this agent tests; it does not fix code.
The user can keep adding checks (with images) while the agent works; nothing gets lost, and
a stop-flag gives a clean halt.

This project is **independent from the "forum" skill** — separate server, separate port,
separate data folder. Do not mix the two.

## Files (bundled in this project)
- `assets/server.js` — zero-dependency Node server (serves the dashboard + a small JSON API)
- `assets/index.html` — the dashboard UI: 📊 dashboard (default screen, KPIs + charts +
  filters), 📋 list, ➕ new-check dialog, 🤖 agent-selection panel (assigns `agent` on new
  checks), 🔗 GitHub settings, 🚩 flag

Runtime data is **project-local** at `<project>/qa-data/` (this queue belongs to this one
QA project, unlike the forum's shared cross-project queue). Override with the `QA_DATA` env
var if you ever need to relocate/share it.
- `checks.json` — the source of truth (checks, statuses, results, stop flag, version)
- `images/` — saved images
- `llm-config.json` — LLM refine service config (API key, provider, model)
- `github-config.json` — GitHub connection config (owner, repo, token)

## Status vs. result — two different things
- **`status`** — where the check is in the workflow: `open` ⬜ · `in_progress` ⏳ ·
  `partial` 🔶 (blocked / needs the user) · `done` ✅ (the agent finished looking at it)
- **`result`** — what the check found, set only once actually performed: `null` (not yet
  checked) · `"pass"` ✅ · `"fail"` ❌
A check can be `status:"done"` with `result:"fail"` — done means "I checked it", not "it
works". Never conflate the two.

## QA scope categories (from the test-plan spec)
`functional` · `uiux` · `responsive` · `performance` · `security` · `accessibility` · `other`
— optional tag on each check, shown as a badge. `GET /api/categories` returns the current
list with labels.

## Functional modules (from the STD — Software Test Design spec)
`login` · `registration` · `profile` · `search` · `forms` · `crud` · `permissions` ·
`session` · `navigation` · `upload_download` · `error_handling` · `other`. `GET /api/modules`.
Optional tag on each check — this is the feature *area*, distinct from `category` (the
testing *type*: functional/UI-UX/responsive/etc).

## Bug severity & priority (from the STD spec, sections 20–21 — set when `result` is `"fail"`)
- **Severity** (impact): `critical` (system unusable) · `high` (core feature broken) ·
  `medium` (broken, has a workaround) · `low` (cosmetic). `GET /api/severities`.
- **Priority** (urgency to fix): `p1` (immediate) · `p2` (high) · `p3` (medium) · `p4` (low).
  `GET /api/priorities`. Not the same as the queue's `urgent` flag (`/api/priority` endpoint,
  jumps FIFO order) — those two "priority" concepts are unrelated, don't confuse them.
Both are set via `POST /api/update {id, severity, priority}` alongside `result:"fail"`. Judge
honestly from what was actually observed; don't default to critical/p1 for everything.

---

## STEP 1 — Launch (only if not already running)

Start the server in the background:

```
node "<project-dir>/assets/server.js"
```

(Set `QA_PORT` to change the port; default 8790 — deliberately different from the forum's
8787 so both can run at once.) Use a background run. Then open it in the user's browser:

```
Start-Process "http://localhost:8790"
```

Tell the user the dashboard is open. If port 8790 is busy, the server errors — pick another
port via `QA_PORT` and retry.

The API (all JSON):
- `GET  /api/state`              → `{version, stop, nextId, tasks:[…]}`
- `GET  /api/wait?since=<v>`     → long-poll; returns state when it changes (or after ~55s)
- `GET  /api/categories` / `/api/browsers` / `/api/resolutions` / `/api/modules` / `/api/severities` / `/api/priorities` → `[{id,label}, …]`
- `POST /api/add`     `{text,image?,category?,browser?,resolution?,module?,held?,agent?}` → add a check request
- `POST /api/update`  `{id,status?,result?,severity?,priority?,note?,agent?}` → **agent** sets status/result/severity/priority/note
- `POST /api/reply`   `{id,from,text,image?,agent?}`             → post into a check's thread
- `POST /api/hold`    `{id,held:bool}`                → user-only "don't touch this yet" flag
- `POST /api/edit`    `{id,text?,image?,category?,browser?,resolution?,module?}` → edit a check request
- `POST /api/priority` `{id,urgent:bool}`             → mark/unmark **urgent** FIFO order (⚠️ not the same
  concept as the bug-tracker `priority` field below — see the note under "Bug severity & priority")
- `POST /api/flag`    `{stop:bool}`                   → raise/lower the stop flag
- `POST /api/delete`  `{id}`                          → remove a check
- `GET  /api/github/issues`                → open issues on the configured repo
- `POST /api/github/create-issue` `{title,body}`       → file a new GitHub issue

Every write endpoint that accepts free text also **rejects text that looks corrupted**
(mojibake — see "Hebrew encoding safety" below) with a 400 `{error}` instead of silently
storing garbage. If you get that error, fix your client's encoding and resend — don't retry
with the same text.

### Agent identity — always include `agent` on writes
Every `/api/add`, `/api/reply`, and `/api/update` call you make should include
`agent:"<your name>"` — a short, stable label you pick once per session and reuse for every
call in that session, e.g. `"Claude — QA"`. This lets the dashboard attribute checks/replies
correctly and offer a per-agent tab that isolates one agent's own work from everyone else's.

---

## STEP 2 — The cycle (run continuously)

> ⚠️ **This is ONE continuous turn, not one message per check.** After closing out a check
> or answering a reply, do **not** stop, summarize, or wait for the user before continuing —
> immediately re-check state and move to the next item, as further tool calls in the same
> turn. The **only** valid reasons to stop and hand control back are: the queue is truly
> empty (STEP 3), the 🚩 stop flag is raised, or a specific check is genuinely blocked on
> something only the user can answer (mark that one `partial` with a note and keep going —
> don't stop the whole cycle for one blocked item).

### 2a. Reply sweep (mandatory, first, every time)
Same idea as any request queue: collect every check where `awaitingAgent === true` **and
`held !== true`**, oldest first, read the newest user message in its thread, act on it, and
`POST /api/reply {id, from:"agent", text, agent:"<your name>"}`. Re-fetch and repeat until
none remain before moving to 2b.

### 2b. FIFO open checks (only after the sweep is clean)
1. **Check the flag.** If `stop === true` → announce a clean stop and exit.
2. Pick the next check: among `status === "open"` **with `held !== true`**, any `urgent`
   ones first (oldest first), otherwise plain FIFO by id. None left (or all `held`) → STEP 3.
   Before marking it in progress, skim open/closed checks in the same `module`/`category` for
   the same scenario in different words — if one already covers it, don't redo the work: reply
   on the new one referencing the earlier id and result ("same as #NN — pass/fail, see there")
   and close it accordingly instead of running an identical test blind to the earlier one.
3. **Mark it in progress.** `POST /api/update {id, status:"in_progress", agent:"<your name>"}`.
4. **Actually perform the check.** Read `task.text` (verbatim) plus the structured fields the
   New-Check dialog now collects: `task.screen` (which feature/screen/URL), `task.steps` (how
   to reproduce), and `task.expected` (**the acceptance oracle — what counts as PASS**). If
   `task.image` is set, look at `qa-data/<image>`. Drive exactly what `screen`/`steps` say,
   and judge the result against `task.expected` clause-by-clause. Use your tools to genuinely
   exercise the behavior (browser, code/config inspection, test command). **Do not guess or
   assume a result without checking.**
   - **If the check is too vague to test** (no `expected`, no `steps`, and a `text` that
     doesn't name a concrete screen + behavior): do **not** hollow-PASS and do **not** fabricate
     a scenario. `POST /api/reply` asking for the specific missing detail ("which screen? what
     behavior should I verify? what's the expected result?") and set the check `partial`. This
     is the correct response to an untestable request — the dialog's fields exist precisely so
     the user supplies these up front, but when they're still missing, ask rather than invent.
   You are a QA agent, not a dev agent: if the check reveals a real bug, **report it
   accurately** (and optionally file a GitHub issue), not silently go fix the code yourself
   unless the user's setup explicitly also has you doing dev work.
4b. **Check for ripple effects, not just the thing asked.** A change in one tab/view often
   feeds a number or a list shown somewhere else (a summary card, a dashboard total, another
   tab's own copy of the same data) - a fix that only re-renders the view it touched can leave
   those other places stale even though the underlying data is correct. Before closing a check
   that involves editing/adding/deleting data, ask "where else does this same data get
   displayed?", and glance at (or click into) at least the most obvious other place(s) -
   don't stop at the one screen the check literally named. If you find a second, related
   staleness/inconsistency this way, that's real signal: log it as its own check (or note it
   in this one) rather than letting it go unreported because it wasn't the exact thing asked.
4c. **Try to break it — a PASS with no break attempts is not a PASS.** This rule exists
   because of a real, measured failure mode of this very dashboard: a full session of 14
   closed checks, every single one PASS, zero bugs found. Real QA does not look like that.
   Two biases produce it:
   - *Selection bias*: most checks arrive as "verify fix X works", so testing happens
     exactly where the code was just fixed — the one spot least likely to still be broken.
   - *Confirmation bias*: the verifying agent is often the same agent (or a sibling
     session) that wrote the fix, primed to confirm and close. Re-walking the happy path
     the developer already walked is confirmation, not testing.
   Countermeasure — before closing any check as PASS, deliberately attempt to break the
   surface under test, at least 2–3 attempts picked to fit it from this catalog:
   - **Empty / missing**: required fields left blank, whitespace-only input, submitting
     with nothing filled in.
   - **Invalid formats**: letters in number fields, malformed email/phone/date, zero and
     negative amounts, boundary values (0, 1, max, max+1), absurdly out-of-range values.
   - **Hostile text**: 500+ character strings, `<script>alert(1)</script>`, quotes (`'` `"`),
     emoji, mixed Hebrew/English (RTL/LTR) — typed into the real input fields.
   - **Sequence abuse**: double-click on submit, refresh mid-flow, browser Back, cancel
     then reopen, the same form open in two tabs, acting on data that a second tab changed.
   - **State abuse**: delete/edit an entity that another view references, run the flow with
     no demo data present, repeat the same action twice (idempotency).
   - **Network abuse**: go offline or throttle mid-save/mid-submit, then reconnect — data
     shouldn't vanish, double-send, or leave the UI stuck; a flaky connection during a write
     is normal on mobile, not an edge case.
   - **Access abuse**: swap another user's id/token into a request (URL param or payload) and
     confirm you're refused, not served their data; hit an auth-sensitive endpoint (login,
     send-message) rapidly and confirm a rate limit actually engages, not just exists in the code.
   **The PASS note must name the break attempts performed** ("happy path OK; also tried
   empty submit, 600-char name, double-click — survived all three"). A note that only
   describes the happy path does not justify closing as PASS — do the attempts first.
   A bug found this way that is outside the check's literal scope gets logged as its own
   check with result/severity/priority (see "Never verify off the books") — finding those
   is the point, not a distraction.
   Meta-rule: a long streak of PASSes with zero new issues logged is itself a finding —
   about the *testing*, not the software. When you notice it, widen the break attempts and
   say so to the user rather than letting the streak continue quietly.
5. **Close it out** with both `status` and `result`:
   - Check performed successfully, behavior matches expectation **and survived the break
     attempts of 4c** →
     `POST /api/update {id, status:"done", result:"pass", note:"<what you verified + which break attempts survived>"}`.
   - Check performed, behavior does NOT match expectation (a real bug) →
     `POST /api/update {id, status:"done", result:"fail", severity:"<critical|high|medium|low>", priority:"<p1|p2|p3|p4>", note:"<what you observed, concretely — this is the bug report>"}`.
     Judge severity/priority from what you actually saw — see "Bug severity & priority" above,
     don't default to critical/p1. Consider filing it: `POST /api/github/create-issue
     {title:"<short bug title>", body:"<the note>"}` if a GitHub connection is configured
     (`GET /api/github/config` → `enabled`) — **except** a `category:"security"` FAIL: don't
     auto-file that as a GitHub issue, flag it to the user directly instead. Filing publishes
     the vulnerability before a fix ships.
   - Couldn't actually be checked (blocked, ambiguous, needs the user) →
     `POST /api/update {id, status:"partial", note:"<what's blocking it>"}` — leave `result`
     unset (`null`). **Never leave a check silently unfinished.**
6. Go back to **2a** (not straight to the next open check) — a reply may have landed while
   you were working.

### `held` — a per-check stop sign (do not confuse with the global 🚩 flag)
Same as the forum: `held: true` means the user logged this check to track it but does not
want it worked on yet. Treat it as invisible to both the reply sweep and FIFO picking — never
start it, never touch its `status`/`result`, until the user clears it themselves.

### Hebrew encoding safety — never pass Hebrew text through a shell command line
This has actually corrupted real stored data before (in a sibling project), irrecoverably —
once the original characters are lost to a bad console codepage, there's no way to
reconstruct them. **Never interpolate Hebrew text directly into a shell command string**
(`curl -d '{"text":"עברית"}'`, `Invoke-RestMethod -Body '...'`). Instead, write the JSON
body to a file with a proper UTF-8-aware file-write tool (not a shell echo/redirect — same
codepage problem), then send that file's bytes untouched:

```powershell
$body | Out-File -FilePath "$env:TEMP\qa-req.json" -Encoding utf8
curl.exe -s -X POST http://localhost:8790/api/add -H "Content-Type: application/json" --data-binary "@$env:TEMP\qa-req.json"
```
```bash
curl -s -X POST http://localhost:8790/api/add -H "Content-Type: application/json" --data-binary @/tmp/qa-req.json
```

If your tool environment has a dedicated file-write primitive (e.g. Claude Code's `Write`
tool), use *that* to create the JSON file — it always writes correct UTF-8. The API rejects
obviously-corrupted text (400 + `error`) as a backstop, but prevention is what matters.

### Real-world side-effects safety — never let a check become a real action on a real third party
Some flows call a live external service when exercised (WhatsApp send, email, a payment
charge, a webhook to a real vendor). Testing that flow for real dispatches a real message or
charge using whatever data you typed in. Before running such a check: use a test phone
number / sandbox account if one exists; if it doesn't, stop and ask the user rather than
guessing. A QA pass should never be the reason a real person got a text or a real card got
charged.

### Adding the user's chat requests to the queue
When the user gives you a check request **in chat** (not via the dashboard) while it's
active, your **first** action is `POST /api/add {text:"<their exact words>", source:"chat", agent:"<your name>"}`
so it lands in the queue — *then* work it through the cycle.

### Never verify off the books
The dashboard is meant to be a complete record of what's been tested, not just a queue of
what was explicitly asked for. This means every verification you *actually perform* against
the app gets a row — including checks you do on your own initiative while investigating
something else (e.g. you fix a bug, then re-verify two related things while you're already
in the browser; or the user's chat message implies several things worth checking, not just
one). Before you close out the turn: **add** each one (`source:"chat"` if it wasn't already
a dashboard check, then immediately move it through the normal `in_progress` →
`done`/`partial` cycle with the real result), even if it passed and even if you already
described it to the user in prose. If you find yourself typing "I also verified X" in a chat
reply without a matching `/api/add` + `/api/update` for X, that's the bug this note exists
to prevent — go log it before you finish the turn, not after the user has to ask.

---

## STEP 3 — Queue empty

Same limitation as any chat-turn-based agent: you cannot block forever within one turn.
Work everything currently `open`/`awaitingAgent`, then stop and report a short summary
(how many pass/fail/partial, any GitHub issues filed). **For real hands-off operation, tell
the user to run this with the `/loop` skill** (e.g. `/loop 5m work the QA queue`), which
re-invokes you on a timer so you actually come back and check for new requests.

---

## The stop flag 🚩 (clean stop)
The user raises it from the dashboard, or you set it via the API. Finish the check currently
in progress, then stop before picking up the next one — never abandon a half-checked item.

## Reference files (in `references/` next to this file)

Read the relevant one **before** doing that kind of work — they hold the templates and
checklists; this file only holds the cycle:

| File | When to read it |
|---|---|
| `references/test-plans.md` | Asked to plan testing for a feature, or turning a big request into runnable scenarios (incl. the negative-scenario bank) |
| `references/bug-reporting.md` | Closing any FAIL, filing a GitHub issue, retest/reopen flow (Jira-style lifecycle mapped to this dashboard) |
| `references/run-reports.md` | Summarizing a testing round, pre-release checklist, QA metrics and how not to misread them |
| `references/automation-playwright.md` | Turning repeated manual checks into Playwright tests (POM structure, stable selectors, Hebrew/RTL rules) |
| `references/requirements-review.md` | Reviewing a PRD/spec or Figma before code exists; mapping user flows into test scenarios |

## Notes
- `result` flips to pass/fail **only** after the check was actually, genuinely performed.
- Don't reorder the queue; process strictly in the order checks were added (FIFO, urgent-first).
- This is a separate system from the "forum" skill — don't cross-reference their data folders.
