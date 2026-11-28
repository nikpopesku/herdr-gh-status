# AGENTS.md

Herdr app mod `gh-status`: a panel of open GitHub PRs and Actions runs. Source is in `mods/gh-status/`; `./install.sh` copies it into `~/.config/herdr-app/mods/` and runs `herdr-app check`.

## Working a Jira ticket (TECH project, e.g. TECH-2)

1. **Start:** move the ticket to **In Progress** before writing code.
2. **Branch and commits:** branch `TECH-<n>-short-description`, commit messages `TECH-<n>: Description`.
3. **Open a PR** to `main` when the work is ready. Put the ticket key in the title (`TECH-<n>: …`).
4. **Then move the ticket to In review** (the review status in the TECH workflow), link the PR on the ticket and **wait for feedback**.
5. **Feedback:** address review comments on the same branch and push. Don't merge the PR yourself. Move the ticket to **Done** only after the user merges it.

## Checks before a PR

- `herdr-app check ~/.config/herdr-app/mods/gh-status` passes.
- Look at the panel in the running app (`herdr-app shot`), not only the check.
- The mod stores no tokens; it uses the user's `gh` login.
- Keep PR polling at 5s or slower and Actions REST polling at 60s or slower, with backoff on errors.
