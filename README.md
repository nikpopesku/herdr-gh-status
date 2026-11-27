# herdr-gh-status

A [Herdr](https://herdr.dev) desktop-app mod: one panel with all your open GitHub PRs (review state, check rollup, per-workflow job progress) and the Actions status of your default branches. It refreshes itself.

- One `gh api graphql` query per poll (cost 1). Uses your existing `gh` login; no token is stored.
- PR query: every 10s while any check is running, 30s otherwise (`poll_seconds` fixes it, minimum 5). Redraws only when data changed. Errors double the wait up to 15 minutes; rate-limit errors wait at least 3 minutes.
- Actions section (REST, one repo at a time): every 60s while a run is in progress, 5 minutes otherwise, none while hidden. Section headers toggle show/hide; the choice is remembered.
- Click a row to expand its workflow runs; click a run or job to open it. Right-click a row to open the PR.

Install: `./install.sh`, then add `{ "type": "block", "content": { "mod": "gh-status", "props": { "repos": ["owner/name"] } } }` to a cloned layout.

Status: work in progress (TECH-2).
