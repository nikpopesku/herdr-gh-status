# herdr-gh-status

A [Herdr](https://herdr.dev) desktop-app mod: one panel with all your open GitHub PRs (review state, check rollup, per-workflow job progress) and the Actions status of your default branches. It refreshes itself.

- One `gh api graphql` query per poll (cost 1). Uses your existing `gh` login; no token is stored.
- Polls every 30s by default (`poll_seconds`, minimum 15); redraws only when data changed. Errors double the wait up to 15 minutes; rate-limit errors wait at least 3 minutes.
- Click a row to expand its workflow runs; click a run or job to open it. Right-click a row to open the PR.

Install: `./install.sh`, then add `{ "type": "block", "content": { "mod": "gh-status", "props": { "repos": ["owner/name"] } } }` to a cloned layout.

Status: work in progress (TECH-2).
