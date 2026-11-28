# AGENTS.md

Herdr app mod `gh-status`: a panel of open GitHub PRs and Actions runs. Source is in `mods/gh-status/`; `./install.sh` copies it into `~/.config/herdr-app/mods/` and runs `herdr-app check`.

## Contributing

Work on a branch, open a PR to `main`, and let CI (`lint`, `test`) pass. Don't push to `main` directly.

## Checks before a PR

- `herdr-app check ~/.config/herdr-app/mods/gh-status` passes.
- Look at the panel in the running app (`herdr-app shot`), not only the check.
- The mod stores no tokens; it uses the user's `gh` login.
- Keep PR polling at 5s or slower and Actions REST polling at 60s or slower, with backoff on errors.
