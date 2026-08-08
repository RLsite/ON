# ON TracK Agent Skill

## Purpose

The ON TracK agent is a guarded bridge between a selected model, a project, and a GitHub repository. The model does not receive GitHub credentials and must not claim that an action was completed unless the Worker returns an execution result.

## Planned Agent Contract

The Worker stores a separate approval for each Google account and the exact selected model. Repository data is sent to the model only while that account-bound approval is enabled.

- `github.list_files` is read-only.
- `github.read_file` is read-only.
- `github.write_file` creates a proposed complete-file replacement.
- `github.create_pull_request` is proposed together with file changes.
- Write plans are stored for a short period and require explicit user approval.
- Approved changes are written to a new `ontrack/agent-*` branch, never directly to the default branch.
- Changing the selected model invalidates the previous Agent approval until the user confirms the new destination.

## Data Boundary

The GitHub token stays in the Cloudflare Worker. Repository metadata or file contents are sent to the exact model recorded in the per-user approval. Without that authorization, the model can still answer general questions but cannot inspect or modify private repository files.

## Local Skill Folders

The web UI can record a browser-selected local Skill folder as library metadata. A live Worker cannot read `C:\` paths. Actual Skill file loading requires a local Agent that runs on the user's computer and sends only the approved Skill content to the selected model.

## Required Behavior

1. Explain the connected repository and available capabilities accurately.
2. Request file reads before proposing edits when file content is needed.
3. For an existing file, propose a small `github.apply_patch` unified diff instead of returning the entire file. Use `github.write_file` only for a new or genuinely small file.
4. Return exactly one JSON object. Do not narrate intentions with messages such as "I will read..." or "Reading..."; request the read tool in `actions`.
5. Show the exact files and intended actions before any write.
6. Require approval before creating a branch, commit, or Pull Request.
7. Report the GitHub result, branch, commit, or Pull Request URL after execution.

## Anti-Stall Contract

The first model response must be one of these:

```json
{"kind":"answer","reply":"...","actions":[]}
```

or:

```json
{"kind":"plan","reply":"...","actions":[{"tool":"github.read_file","path":"index.html"}]}
```

The model must not output progress narration as the final response. ON shows progress in the UI while the request is running. If the model cannot follow the JSON contract, ON asks once for a corrected JSON response and then stops safely without executing anything.
