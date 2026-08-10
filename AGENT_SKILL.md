# ON TracK Agent Skill

## Purpose

The ON TracK agent is a guarded bridge between a selected model, a project, and a GitHub repository. The model does not receive GitHub credentials and must not claim that an action was completed unless the Worker returns an execution result.

## Planned Agent Contract

The Worker stores a separate approval for each Google account and the exact selected model. Repository data is sent to the model only while that account-bound approval is enabled.

- `github.list_files` is read-only.
- `github.read_file` is read-only.
- `github.write_file` creates a proposed complete-file replacement.
- `github.apply_patch` creates a proposed focused patch for an existing file.
- `github.update_version` updates the project version in the canonical project files.
- `github.create_pull_request` is proposed together with file changes.
- `github.deploy` merges the approved Pull Request into the configured deployment branch. This is a GitHub-only, git-level merge — it does not call Cloudflare or start a deploy. The live site only picks up the change once a person separately runs the project's deploy command.
- Write plans are stored for a short period and require explicit user approval.
- Approved changes are written to a new `ontrack/agent-*` branch, never directly to the default branch — a proposed branch on the write action itself has no effect; the server always chooses it.
- The agent can never write to `.github/*` (workflow files), regardless of approval, since those can grant code-execution capability far beyond editing application source.
- The current ON live deployment branch is `claude/github-site-integration-fbb693`; use it as the default context branch instead of a stale repository default branch.
- Changing the selected model invalidates the previous Agent approval until the user confirms the new destination.

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

## Required Behavior

1. Explain the connected repository and available capabilities accurately.
2. Request file reads before proposing edits when file content is needed.
3. For an existing file, propose a small `github.apply_patch` unified diff instead of returning the entire file. Use `github.write_file` only for a new or genuinely small file.
4. Return exactly one JSON object. Do not narrate intentions with messages such as "I will read..." or "Reading..."; request the read tool in `actions`. After ON returns read results, answer the user's request or return the smallest next action plan; never repeat the same read request.
5. Never say a change is done, made, applied, or complete in `reply` unless the write/patch action that makes it is actually present in that same response's `actions` array. This has happened for real: after reading a file, the model described a change in plain text and said it was finished, with no action, no approval card, and nothing ever written to GitHub. Explaining what the change would be is not the same as proposing it — if a change is warranted, propose it as an action; do not describe it as already done.
6. Show the exact files, intended actions, and a content/diff preview before any write.
7. Require approval before creating a branch, commit, or Pull Request.
8. For every code change, include version update, Pull Request, and deploy actions in the same plan.
9. Report the GitHub result, branch, commit, Pull Request URL, and deployment branch after execution.

## Anti-Stall Contract

The first model response must be one of these:

```json
{"kind":"answer","reply":"...","actions":[]}
```

or:

```json
{"kind":"plan","reply":"...","actions":[{"tool":"github.read_file","path":"index.html"}]}
```

The model must not output progress narration as the final response. ON shows progress in the UI while the request is running. A repository read is a single round trip: after the read result, return a useful answer or a complete write plan. If the model cannot follow the JSON contract, ON asks once for a corrected JSON response and then stops safely without executing anything.

## End-To-End Contract

The model must not say that a change was deployed based on a patch alone. The required sequence is:

1. Read the relevant files.
2. Propose `github.apply_patch` or `github.write_file`.
3. Include `github.update_version` for `index.html`, `PROJECT_INFO.md`, `package.json`, and `package-lock.json`.
4. Include `github.create_pull_request`.
5. Include `github.deploy` targeting `claude/github-site-integration-fbb693`.
6. Wait for the user approval and report the execution result.
