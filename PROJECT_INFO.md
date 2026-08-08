# ON TracK Project Info

Version: `0.5.0`
Status: `GitHub modal reorganized into tabs with a real server-side folder picker; top-bar buttons are icon-only with live green/red connection LEDs`

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

## In progress
1. Make the home screen fully product-like
2. Finish the bilingual interface
3. Build real project and library data

## Next
1. Add a project picker
2. Extend the repository connection flow with real actions (branches, commits, PRs) beyond issues
3. Add model execution approval
4. Add controlled actions on GitHub

## Notes
- Local-first now, deployable later
- Keep the UI calm and simple
- Remove any remaining QA-specific leftovers as they appear
