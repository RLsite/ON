# ON TracK Project Info

Version: `0.7.1`
Status: `GitHub connection verified working end-to-end on the live site (real repo, real token, read+write scopes confirmed). Clarified the Owner/Repo fields after a real user typed an email and a full URL into them.`

## Goal
Build a web-first workspace where a chosen model can understand a project, connect to repositories, and perform approved actions in a controlled flow.

## Done
- GitHub repository seeded
- Clean web shell started
- Top actions added
- Left rail added
- Hebrew and English support started
- GitHub connection flow: live test button that calls the real GitHub API (repo reachability + token identity), with a true connected/failed status shown in the modal, the header dot, and the MVP readiness chip
- Fixed a bug where every popup dialog (GitHub, settings, model, help, preview, API, new request) failed to appear when opened from the new home screen. Root cause: all dialogs lived inside the legacy `.oldApp` container, which is hidden with `display:none` while the new home screen is being built — a hidden ancestor hides its children no matter what CSS state the dialog itself is in. Fix: on page load, the dialogs are moved to be direct children of `<body>` so they render as normal overlays regardless of the legacy shell's visibility. Verified with a headless-browser click test on each button (GitHub, model, settings, help) confirming the corresponding dialog opens, is visible on screen, and closes correctly.
- Reorganized the GitHub modal into three tabs — "חיבור GitHub", "תיקיית קוד מקומית" (local code folder for model context), and "דפדפן מקומי — כתובת האתר לבדיקה" — instead of one long scroll. Added a real "choose folder" experience: since browsers never expose actual OS paths from an `<input type=file>` picker, added a server-side `/api/fs/browse` endpoint (lists real subdirectories of any path, with Windows drive listing when no path is given yet) and a shared folder-picker dialog UI that lets the user click through real folders on disk and writes the chosen absolute path back into the local-folder and local-server-directory fields.
- Top-bar buttons (settings, help, GitHub, model, language) are now icon-only (with a title tooltip for the label) instead of icon+text, to match a cleaner look. Added a small LED dot on the GitHub and model buttons — green when actually connected, red when not — reusing the existing real-connectivity checks (`/api/github/status`, selected model) that already drove the older header/MVP indicators.
- Merged the `assets/` folder into the repo root: `assets/index.html` → `index.html` and `assets/server.js` → `server.js`, so the app shell and the local server both live in one place instead of being split across the root and a subfolder. Removed the old root `index.html` (a redirect stub for GitHub Pages) since the real app now sits at the root directly. Updated `package.json` (`main`, `start`), `scripts/build.js` (copies from `index.html` instead of `assets/index.html`), and `README.md` accordingly. `wrangler.jsonc` was left untouched — it still only publishes `dist/`, and its Worker `name` stays `on`.
- Rebuilt the language toggle from scratch as one system instead of the two partial, disconnected ones that used to leave stray English on screen. One `#newLangBtn` button, one `I18N` dictionary (130+ keys) driving `data-i18n` / `data-i18n-html` / `data-i18n-title` / `data-i18n-placeholder` across the home screen and all 8 relocated modals, hoisted to the top of the script so JS-generated content (the model-preset dropdown, the help-panel bullet lists) can read the current language too. Verified with a body-text sweep in a real browser: zero Latin-script leftovers in English mode, exact text restored on toggling back to Hebrew.
- Added the RL logo as the site favicon — resized to 64×64 and inlined as base64 to keep it self-contained in the single deployed HTML file.
- Added a clickable version number (Quick Status → Version) that re-fetches the page with the cache bypassed, compares the served `appVersion` against the running one, and offers a one-click reload when they differ.
- Gave the deployed site a real backend for the GitHub connection. Until now `on.rlapp.net` was pure static hosting (Cloudflare serving `dist/` with no server-side code at all), so every `/api/github/*` call 404'd and the whole GitHub modal was non-functional in production even though it worked locally against `server.js`. Added `worker.js` (a Cloudflare Worker `fetch` handler porting the five GitHub endpoints — config read/write, live status check, list issues, create issue — with the same logic as `server.js`) and wired it into `wrangler.jsonc` via `main` + an `ASSETS` binding, so the Worker runs for `/api/github/*` and falls through to the static build for everything else. Config (owner/repo/token) is stored in a KV namespace (`GH_CONFIG` binding) instead of a local JSON file, since Workers have no filesystem. The tool's other local-only features (folder browsing, starting a local dev server, driving a local Chrome for previews) are not and cannot be ported this way — they need real filesystem/process access a Worker structurally doesn't have, so they stay local-only by design.
- Fixed two related bugs found while building the above: (1) `updateConnDots()` called a `fetchJsonSafe` helper that only existed inside a different section's closure — the resulting `ReferenceError` was silently caught and read as "not connected," so the GitHub header LED showed red even when actually connected. Moved `fetchJsonSafe` to the top of the script so every section can reach it. (2) The visible "connect GitHub" button (top-bar icon, and the Settings shortcut) only opened the modal — it never loaded the saved owner/repo/enabled state into the form, so after a page refresh the fields always looked empty even though the config was safely persisted. Added a shared `openGithubModal()` that loads the saved config and refreshes the live status every time the modal opens, and wired every entry point to it.
- Created and bound the `GH_CONFIG` KV namespace in Cloudflare, then verified the whole GitHub connection end-to-end on the live site with a real repo (`RLsite/ON`) and a real Personal Access Token — connected status, read+write scope detection, and the header LED all confirmed correct in production, not just locally.
- A real test run caught a UX gap immediately: a real user typed an email into the Owner field and a full URL into the Repo field, which produced a confusing "Not Found" with no clue why. Reworded both labels to rule out the mistake explicitly, replaced the generic placeholders with this project's own real values (`RLsite` / `ON`), and added a hint line beneath the fields spelling out the breakdown from a full GitHub URL.

## In progress
1. Make the home screen fully product-like
2. Build real project and library data
3. Give the model connection the same Worker-backend treatment as GitHub — `/api/models/*` currently only exists in `server.js`, so it 404s on the deployed site exactly like GitHub did before this round

## Next
1. Add a project picker
2. Extend the repository connection flow with real actions (branches, commits, PRs) beyond issues
3. Add model execution approval
4. Add controlled actions on GitHub

## Notes
- Local-first now, deployable later
- Keep the UI calm and simple
- Remove any remaining QA-specific leftovers as they appear
