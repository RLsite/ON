# QA Dashboard — agent instructions (tool-agnostic)

This file lets **any** AI agent (Codex, Claude, a custom script, etc.) drive the QA
dashboard. It is the vendor-neutral twin of `SKILL.md`. Point your agent at this file, or
paste it into the agent's own instructions convention (Codex reads `AGENTS.md` automatically).

This project is **independent from the "forum" skill** — different server, different port,
different data folder. Don't mix them up.

## What the QA dashboard is
A local web app (`assets/server.js` + `assets/index.html`) where a human writes free-text
"what to check" requests — with optional images and an optional QA-scope category — into a
queue. Your job as the QA agent is to **actually perform each check** (not fix code) and
report the result, so nothing is ever silently dropped or guessed at.

## Start the server (if not already running)
```
node assets/server.js
```
- Serves the dashboard at `http://localhost:8790` (override port with `QA_PORT` — deliberately
  different from the forum's 8787 so both can run at once).
- Data lives in `<project>/qa-data/` (`checks.json` + `images/`) — project-local, not shared
  across projects. Override with `QA_DATA`.
- The base URL is your API root. Everything below is relative to it.

## `status` vs. `result` — do not conflate these
- `status`: workflow state — `open` ⬜ not started · `in_progress` ⏳ working now ·
  `partial` 🔶 blocked/needs the user · `done` ✅ the agent finished looking at it.
- `result`: what the check found — `null` (not yet checked) · `"pass"` · `"fail"`.
A check can be `status:"done"` + `result:"fail"` — "done" means "I checked it", not "it works".

## Severity & priority — set these when `result` is `"fail"`
From the STD (Software Test Design) spec: every real bug gets classified, same as a
professional bug tracker. Set both via `/api/update` alongside `result:"fail"`:
- `severity` (impact on the system): `critical` (system unusable) · `high` (a core feature is
  broken) · `medium` (broken but has a workaround) · `low` (cosmetic). `GET /api/severities`
  for the full labels.
- `priority` (urgency to fix): `p1` (immediate) · `p2` (high) · `p3` (medium) · `p4` (low).
  `GET /api/priorities` for the full labels.
Judge these honestly from what you actually observed — don't default to `critical`/`p1` for
everything. Invalid values are silently ignored by the API (not stored), not rejected.

## HTTP API (all JSON)
| Method & path | Body | Purpose |
|---|---|---|
| `GET /api/state` | — | `{version, stop, nextId, tasks:[…]}` |
| `GET /api/wait?since=<v>` | — | long-poll; returns when state changes or after ~55s |
| `GET /api/categories` / `/api/browsers` / `/api/resolutions` / `/api/modules` / `/api/severities` / `/api/priorities` | — | `[{id,label}, …]` — tag value lists |
| `POST /api/add` | `{text, image?, category?, browser?, resolution?, module?, held?, agent?}` | add a check request |
| `POST /api/update` | `{id, status?, result?, severity?, priority?, note?, agent?}` | **agent** sets status/result/severity/priority/note |
| `POST /api/reply` | `{id, from, text, image?, agent?}` | add a message to a check's thread |
| `POST /api/edit` | `{id, text?, image?, category?, browser?, resolution?, module?}` | edit a check request |
| `POST /api/priority` | `{id, urgent: bool}` | mark/unmark **urgent** (FIFO order) — not the same as bug `priority`, see below |
| `POST /api/hold` | `{id, held: bool}` | user-only stop sign on one check — see below |
| `POST /api/flag` | `{stop: bool}` | raise / lower the stop flag |
| `POST /api/delete` | `{id}` | remove a check |
| `GET /api/github/config` | — | `{enabled, hasToken, owner, repo}` |
| `GET /api/github/issues` | — | open issues on the configured repo |
| `POST /api/github/create-issue` | `{title, body}` | file a new GitHub issue |
| `GET /images/<file>` | — | fetch a stored image |

⚠️ **Two different "priority" concepts, don't confuse them:** `POST /api/priority` +
`urgent` is about FIFO queue ordering (jump the line). The `priority` *field* on a check
(`p1`–`p4`, set via `/api/update`) is the bug-tracker urgency-to-fix rating from the STD
spec. They're unrelated.

Each check: `{id, text, image, category, browser, resolution, module, status, result,
severity, priority, note, source, created, held, agent, lastAgent, thread}`.
`browser`/`resolution`/`module` are optional tags (`GET /api/browsers` / `/api/resolutions` /
`/api/modules` for the valid values) that feed the dashboard's 📊 report view — set them when
relevant. `module` is the functional area from the STD spec (login, registration, profile,
search, forms, crud, permissions, session, navigation, upload_download, error_handling, other).
`/api/add`, `/api/update`, `/api/reply`, and `/api/edit` reject text that looks like
corrupted encoding (mojibake) with a 400 `{error}` — see "Hebrew encoding safety" below.

### Agent identity — always send `agent` on writes
Every `/api/add`, `/api/reply`, and `/api/update` call should include `agent: "<your name>"`
— a short, stable label picked once per session (e.g. `"Claude — QA"`). This attributes
checks/replies correctly and powers a per-agent tab in the dashboard.

### Hebrew encoding safety — never pass Hebrew text through a shell command line
This has actually corrupted real stored data before (in a sibling project), irrecoverably.
On Windows especially, shell console codepages are often not UTF-8, so Hebrew interpolated
directly into a command string (`curl -d '{"text":"..."}'`, `Invoke-RestMethod ... -Body
'...'`) can turn into literal `?` before it ever reaches this API. The API rejects
obviously-corrupted text (400 + `error`), but the real fix is prevention: **write the JSON
body to a file with a proper UTF-8-aware file-write tool first** (not a shell echo/redirect —
same codepage problem), then send that file's bytes untouched, e.g.
`curl --data-binary @request.json`. No Hebrew text should ever transit the shell's own
command-line parsing/encoding layer.

### Real-world side-effects safety — never let a check become a real action on a real third party
Some flows call a live external service when exercised (WhatsApp send, email, a payment
charge, a webhook to a real vendor) — testing that flow for real dispatches a real message
or charge using whatever data you typed in. Use a test phone number / sandbox account if one
exists; if it doesn't, stop and ask the user rather than guessing. A QA pass should never be
the reason a real person got a text or a real card got charged.

### `held` — per-check stop sign (not the same as the global stop flag)
The user can set `held: true` on any check. It means: **logged, but do not touch it yet.**
A `held` check is invisible to you for both the reply sweep and FIFO picking, no matter its
`status` — never start it, never change it, until the user clears it themselves.

## The cycle (run continuously)

> ⚠️ **One continuous run, not one message per check.** After closing a check or answering a
> reply, do not stop or summarize and wait — immediately continue with more tool calls in the
> same turn. Stop only when: the queue is truly empty, the stop flag is up, or — don't stop
> the *whole* cycle for a single blocked check — mark that one `partial` with a note and keep
> going.

Loop until the queue has no `open` checks **or** the stop flag is up. **Every time you start
or resume — before touching any `open` check — do the full reply sweep first, every time:**

### Reply sweep (mandatory, first, every time)
1. `GET /api/state`.
2. Collect **every** check with `awaitingAgent === true` **and `held !== true`** (there can
   be more than one — don't stop after just one). Sort by id, oldest first.
3. For each: read the newest `thread` message from the user (+ image if set), act on it, then
   `POST /api/reply {id, from:"agent", text, agent:"<your name>"}`.
4. Re-fetch `/api/state`; if anything still has `awaitingAgent === true`, repeat. Only move on
   once it comes back empty.

### FIFO open checks (only once the sweep is clean)
1. **Check the flag** — if `stop === true`, stop cleanly and report.
2. **Pick next** — among `status === "open"` checks **with `held !== true`**, any `urgent`
   ones first (oldest urgent first); otherwise the first by id (FIFO). Before marking it in
   progress, skim open/closed checks in the same `module`/`category` for the same scenario in
   different words — if one already covers it, reply on the new one referencing the earlier
   id and result instead of redoing the work blind to it.
3. **Mark it** — `POST /api/update {id, status:"in_progress", agent:"<your name>"}`.
4. **Actually perform the check** — read `task.text` verbatim plus the structured fields
   `task.screen` (feature/screen/URL), `task.steps` (repro), and `task.expected` (**the PASS
   oracle**); if `task.image` is set, open `qa-data/<image>`. Drive what screen/steps say and
   judge against `expected`. **Never guess a result without checking.** **If the check is too
   vague to test** (no `expected`/`steps`, vague `text`), don't hollow-PASS or invent a
   scenario — `POST /api/reply` asking for the missing specifics and set it `partial`. You are
   testing, not developing — report bugs; don't silently fix code unless set up for dev work.
4b. **Check for ripple effects, not just the thing asked.** A change in one tab/view often
   feeds a number or list shown elsewhere too (a summary card, a dashboard total, another
   tab's own copy of the same data). Before closing a check that edits/adds/deletes data, ask
   "where else does this data get displayed?" and glance at the most obvious other place(s) -
   don't stop at the one screen the check literally named. A second, related staleness found
   this way is real signal - log it (its own check, or a note on this one), don't drop it just
   because it wasn't the exact thing asked.
4c. **Try to break it — a PASS with no break attempts is not a PASS.** Re-walking the happy
   path the developer already walked is confirmation, not testing (a real session here once
   closed 14/14 checks PASS — that streak was a testing failure, not great software). Before
   any PASS, run at least 2–3 deliberate break attempts that fit the surface: empty/missing
   required input · invalid formats & boundary values (0, negative, max+1, letters in number
   fields) · hostile text (500+ chars, `<script>alert(1)</script>`, quotes, emoji, mixed
   RTL/LTR) · sequence abuse (double-click submit, refresh mid-flow, Back, two tabs) · state
   abuse (delete an entity another view references, rerun the same action twice) · network
   abuse (go offline/throttle mid-save, then reconnect — no vanished/double-sent data, no
   stuck UI) · access abuse (swap another user's id/token into a request and confirm it's
   refused; hammer an auth-sensitive endpoint and confirm a rate limit actually engages). The
   PASS note must name the attempts that survived. Out-of-scope bugs found this way get logged as
   their own checks — that's the point. And if you notice a long all-PASS streak with nothing
   new logged, treat the streak itself as a finding about your testing and widen the attempts.
5. **Close it out with both `status` and `result`:**
   - Verified working and survived 4c's break attempts →
     `{status:"done", result:"pass", note:"<what you verified + which break attempts survived>"}`.
   - Verified NOT working (a real bug) → `{status:"done", result:"fail", severity:"<critical|
     high|medium|low>", priority:"<p1|p2|p3|p4>", note:"<concrete observation — this is the
     bug report>"}`. Judge severity/priority honestly from what you actually saw (see
     "Severity & priority" above) — don't default to critical/p1. Consider filing it via
     `POST /api/github/create-issue {title, body}` if GitHub is configured (check
     `GET /api/github/config` → `enabled`) — **except** a `category:"security"` FAIL: flag
     that to the user directly instead of filing, which would publish the vulnerability
     before a fix ships.
   - Couldn't be checked (blocked/ambiguous) → `{status:"partial", note:"<what's blocking
     it>"}`, leave `result` unset. **Never leave a check silently unfinished.**
6. Go back to the **reply sweep**, not straight to the next open check — a reply may have
   landed while you were working.

When no `open` checks remain, you may poll a few times with `GET /api/wait?since=<version>`
(blocks up to ~55s), but a single agent run cannot block forever. For real hands-off
operation, re-invoke this cycle on a timer (a cron job, a scheduler, or — for Claude Code —
the `/loop` skill, e.g. `/loop 5m work the QA queue`).

### Never verify off the books
The dashboard should end up as a complete record of everything tested, not just what was
explicitly queued. Any verification you genuinely perform against the app — including one
you did on your own initiative while working on something else, not just checks pulled from
the queue — needs a row: `POST /api/add` it (`source:"chat"` if it wasn't already a check),
then run it through the normal in-progress → done/partial cycle with the real result. If
you catch yourself describing a check you performed only in your reply text, with no
matching add+update call, log it before ending the turn.

## The stop flag 🚩
Clean stop: finish the check in progress, then stop before starting the next one. FIFO order
is fixed — do not reorder the queue.

## Reference files
`references/` next to this file holds the professional templates — read the relevant one
before that kind of work: `test-plans.md` (test plans + scenarios + negative-scenario bank),
`bug-reporting.md` (bug template, taxonomy, Jira-style lifecycle), `run-reports.md` (run
reports, release checklist, metrics), `automation-playwright.md` (Playwright + POM),
`requirements-review.md` (PRD/Figma review, user-flow mapping).

## Notes for non-Claude agents
- **Codex / CLI agents:** place this file as `AGENTS.md` at the project root (done). Trigger
  with "work the QA queue".
- **Web / no-code tools (e.g. Base44):** point HTTP actions at the API table above. No SDK
  needed.
- **Remote:** if the server is hosted, swap `http://localhost:8790` for the public base URL
  and add whatever auth token the deployment requires.
