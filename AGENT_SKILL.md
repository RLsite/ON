# ON TracK Agent Skill

## Purpose

The ON TracK agent is a guarded bridge between a selected model, a project, and a GitHub repository. The model does not receive GitHub credentials and must not claim that an action was completed unless the Worker returns an execution result.

## Planned Agent Contract

The Worker stores a separate approval for each Google account and the exact selected model. Repository data is sent to the model only while that account-bound approval is enabled.

- `github.list_files` is read-only.
- `github.read_file` is read-only. It accepts `path` plus either a focused `query`, or `startLine` and `endLine` (maximum 400 lines). `query` is one literal case-insensitive substring, not semantic search and not several selector guesses separated by spaces. Use exact text such as `id="brandLogo"`, `.brandMark`, or a quoted attribute. Large files return an overview instead of a misleading partial file. Each result has a strict 6,000-character budget; very long embedded-data/minified lines are visibly compacted and omission markers must never be copied into a patch. Request at most two repository reads in one round so all returned excerpts fit in the next model call, and use at most four distinct read rounds.
- `github.write_file` creates a proposed complete-file replacement.
- `github.apply_patch` creates a proposed focused patch for an existing file.
- `github.update_version` updates the project version in the canonical project files.
- `github.create_pull_request` is proposed together with file changes.
- `github.deploy` merges the approved Pull Request into the configured deployment branch. This is a GitHub-only, git-level merge — it does not call Cloudflare or start a deploy. The live site only picks up the change once a person separately runs the project's deploy command.
- Write plans are stored with their resumable Job for up to 24 hours and require explicit user approval.
- A GitHub execution failure must not delete its approval plan. Keep the same plan and Job in `waiting_approval`, explain the failed stage, and allow the user to fix the connection and approve again. A missing plan key may be recovered only from the same user's Job when both `jobId` and `planId` match.
- Approved changes are written to a new `ontrack/agent-*` branch, never directly to the default branch — a proposed branch on the write action itself has no effect; the server always chooses it.
- The agent can never write to `.github/*` (workflow files), regardless of approval, since those can grant code-execution capability far beyond editing application source.
- The current ON live deployment branch is `claude/github-site-integration-fbb693`; use it as the default context branch instead of a stale repository default branch.
- Changing the selected model invalidates the previous Agent approval until the user confirms the new destination.
- Every work request creates a server-stored Job with a model-generated checklist and an append-only step log. Each continuation performs at most one model-provider call, then stores the exact handoff state before another runner starts.

## Data Boundary

The GitHub token stays in the Cloudflare Worker. Repository metadata or file contents are sent to the exact model recorded in the per-user approval. Without that authorization, the model can still answer general questions but cannot inspect or modify private repository files.

## Local Skill Folders

The web UI can record a browser-selected local Skill folder as library metadata. A live Worker cannot read `C:\` paths. Actual Skill file loading requires a local Agent that runs on the user's computer and sends only the approved Skill content to the selected model.

## index.html contains a dead legacy shell — do not edit it

`index.html` has two visually similar sections with overlapping class names, and only one of
them is ever shown to a user:

- The live UI is `<div class="newShell">` (search for that exact string first). Its sidebar is
  `.newSidebar`, and its brand mark is inside `.newSidebar`'s own `.railBrand`
  (`<div class="brandMark"><img id="brandLogo"></div>`).
- `<div class="oldApp">` is a separate, older container elsewhere in the file, hidden with
  `.oldApp{display:none}` in the stylesheet — it is never visible to any user, on any device, in
  any state. It happens to contain its *own* similarly-named elements (its own `.railBrand`,
  `.brandMark`, `.sideRail`, `.topDock`, `.dockActions`) left over from an earlier version of the
  UI. This has already caused a real failure: a plan that patched `.oldApp`'s copy of these
  elements was syntactically valid and passed every check, but changed nothing a user could see,
  because it targeted dead markup.

Before proposing any `github.write_file`/`github.apply_patch` for `index.html`, confirm the
element you are changing is inside `.newShell` and not inside `.oldApp` — read enough
surrounding context in the file to be sure which container an element belongs to; matching class
name alone is not enough. If a task is about something the user can currently see, the element
almost certainly lives in `.newShell`, not `.oldApp`.

For a request about the visible ON TracK brand logo, query `id="brandLogo"` or `.brandMark`.
For the circular account/profile control that can show the signed-in user's initials such as
`RL`, query `id="authBtn"` or `#authBtn`; those initials are runtime account data and do not appear
as literal markup. Do not query `RL` (it also matches `URL`, `rlapp`, repository examples, and
embedded image data), and never query a guessed string such as `menu .icon .rl` because queries
are literal, not selector composition.

## Required Behavior

1. Explain the connected repository and available capabilities accurately.
2. Request file reads before proposing edits when file content is needed.
3. For an existing file, propose a small `github.apply_patch` unified diff instead of returning the entire file. Use `github.write_file` only for a new or genuinely small file.
4. Return exactly one JSON object with `kind`, `reply`, `checklist`, and `actions`. For a work request, create 2-7 concrete checklist entries in the user's language and keep their meaning stable in every later response. Do not narrate intentions with messages such as "I will read..." or "Reading..."; request the read tool in `actions`. For a large file, use one literal, specific `query` first, inspect `matchLocations`, and request a focused line range only when adjacent context is still missing. After ON returns read results, answer the user's request, request one new focused read while the safe allowance remains, or return the smallest next action plan; never repeat the same read request.
5. Never say a change is done, made, applied, or complete in `reply` unless the write/patch action that makes it is actually present in that same response's `actions` array. This has happened for real: after reading a file, the model described a change in plain text and said it was finished, with no action, no approval card, and nothing ever written to GitHub. Explaining what the change would be is not the same as proposing it — if a change is warranted, propose it as an action; do not describe it as already done. ON enforces this server-side: an `answer` that claims it added, changed, moved, fixed, removed, created, or deployed something without a write action is rejected and sent through contract repair instead of being marked complete.
6. Show the exact files, intended actions, and a content/diff preview before any write.
7. Require approval before creating a branch, commit, or Pull Request.
8. For every code change, include version update, Pull Request, and deploy actions in the same plan.
9. Report the GitHub result, branch, commit, Pull Request URL, and deployment branch after execution.

## Anti-Stall Contract

Before planning a Hebrew request, ON runs a separate translation stage. Store the faithful English translation in the Job, show it in the step log, and use that English request for all planning, repository reads, repairs, and finalization. Preserve filenames, URLs, code identifiers, and quoted text exactly. The original user language remains Hebrew, so every user-facing `reply` and checklist item must still be written in Hebrew. An English request completes this stage without another provider call.

The first model response must be one of these:

```json
{"kind":"answer","reply":"...","checklist":[],"actions":[]}
```

or:

```json
{"kind":"plan","reply":"...","checklist":[{"id":"inspect","text":"Inspect the active implementation"},{"id":"prepare","text":"Prepare the change"},{"id":"approve","text":"Wait for approval and execute"}],"actions":[{"tool":"github.read_file","path":"index.html","query":"newShell"}]}
```

The model must not output progress narration as the final response. ON shows progress in the UI while the request is running. ON permits at most four distinct repository-read rounds so a large file can be narrowed safely without creating an unbounded model loop. Each later read must use a new path, literal query, or line range. When the allowance ends, return a useful answer or a complete write plan. If the model cannot follow the JSON contract, ON asks once for a corrected JSON response and then stops safely without executing anything.

## Step Handoff Contract

1. `/api/chat` stores the original request and returns immediately; it does not wait for model work.
2. The first stage prepares a persisted English working request. `/api/chat/continue` runs one bounded stage with at most one model-provider call.
3. Before continuing, use the stored original request, checklist, completed step log, read results, read fingerprints, and current state. Never restart a completed stage.
4. After every stage, store a plain-language log entry that says what was attempted, what completed, and what the next runner must do.
5. Provider capacity or timeout errors do not erase the Job. Store the interruption and retry from the same state in a later HTTP request. A provider call is capped at 60 seconds and a Job gets at most two consecutive transient attempts before failing clearly.
6. A page refresh or another runner continues by Job id; it must not create a second Job for the same request. A completed/failed Job with saved reads and remaining read allowance may use `Continue from here`, preserving its Job id, read results, read fingerprints, and read-round count. `Retry from beginning` is the only control that intentionally creates a new Job.
7. A Job with state `canceled`, or with a persisted cancellation marker, is terminal. Do not call the provider, execute a pending plan, resume a stage, or overwrite it with a late result. Cancellation must also invalidate any unexecuted approval plan.

## Model Consent Contract

Repository and Skill access belongs to the exact external destination the user approved: the selected connection id, provider, provider model id, API base URL, and repository/file scopes must all match. Selecting another model, reconnecting a removed model, or editing a connection to point to a different destination requires a new explicit approval. When GitHub is configured and consent does not match, do not call the provider and do not create chat history; return `AGENT_CONSENT_REQUIRED`. A persisted Job whose model no longer matches the active consent must stop clearly instead of continuing without repository context.

## End-To-End Contract

The model must not say that a change was deployed based on a patch alone. The required sequence is:

1. Read the relevant files.
2. Propose `github.apply_patch` or `github.write_file`.
3. Include `github.update_version` for `index.html`, `PROJECT_INFO.md`, `package.json`, and `package-lock.json`.
4. Include `github.create_pull_request`.
5. Include `github.deploy` targeting `claude/github-site-integration-fbb693`.
6. Wait for the user approval and report the execution result.
