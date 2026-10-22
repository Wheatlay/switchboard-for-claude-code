# Changelog

## 2.4.1

- No more repeated "not linked to these shared items" warning for items Claude Code has removed from `~/.claude` (e.g. `todos`).
- Plan limits refresh as soon as Claude Code renews an account's login (e.g. right after a switch), instead of showing the last known numbers for up to a minute or two.

## 2.4.0

- **Local artifact preview.** Artifacts that Claude Code publishes from local files open on `http://127.0.0.1:4999` from every account, with no claude.ai login and live reload. Design canvases show their boards with pan and zoom. Artifacts are found in the session logs, so nothing is added to your Claude Code settings. On by default (`claudeAccounts.artifactPreview`); each new artifact opens in the preview by itself (`claudeAccounts.artifactPreviewAutoOpen`).
- Plan limits are read from the same endpoint as Claude Code's `/usage`, so checking them no longer uses any tokens. New `claudeAccounts.planLimits` setting to turn them off.
- `scope`, `shareHistory` and `rules` can only be set in user settings, so a repository's `.vscode/settings.json` can no longer change them.
- Logs in **Output > Switchboard for Claude Code**, and a **Show logs** command.
- An account near its limit keeps its own color: the yellow (75%+) or red (90%+) background now sits on a separate item with the numbers, right next to the account name.
- After switching accounts the window now reloads by default (`claudeAccounts.reloadBehavior`: `always`).

## 2.3.0

- Token usage keeps a long-term history: daily totals per model are saved in a small file, so they survive Claude Code deleting old logs.
- The usage view shows today, 7 days, 30 days and all time, each with an estimate of what it would cost at API prices.
- The usage view is also available when history is shared between accounts.

## 2.2.3

- The 7-day limit now shows in the status bar whenever it is at 50% or more, also next to a high 5-hour number.

## 2.2.2

- New icon: a plan-limit gauge in account colors.

## 2.2.1

- First release of Switchboard for Claude Code, a fork based on Multi-Account Switcher for Claude Code 1.1.0 by Kahuê Costa.
- Plan limits (5-hour and 7-day) per account in the status bar, tooltip and picker, with a **Refresh plan limits** command.

## 1.1.0

- Account identity: e-mail, plan and organization in the status bar, tooltip and picker. Only non-secret fields are read.
- Per-account color (theme-aware palette), icon or emoji, and status-bar style (`name`, `initials`, `icon`).
- Optional image per account in the picker, chosen from a file, or opt-in Gravatar.
- Inline buttons in the account picker: rename, appearance, log in, remove.
- Default-account rules by folder or git-remote pattern (`claudeAccounts.rules`), plus an **Add default-account rule** command.
- Usage-limit assistant: offers switching accounts when the current one hits its limit.
- **Show usage by account**: tokens today and over the last 7 days, from local logs.
- Per-account environment variables, kept locally.
- **Switch to previous account** command (`Ctrl+Alt+Shift+A` / `Cmd+Alt+Shift+A`).
- Settings Sync for account names, colors, icons and repository defaults.
- Data from 1.0 is migrated automatically.

## 1.0.0

First public release.

- Per-window and per-repository account switching through `CLAUDE_CONFIG_DIR`, with no changes to `~/.claude`, the repository or VS Code settings.
- Shared and isolated profiles, convertible in either direction.
- Optional shared conversation history, merging the existing history of every account.
- Integrated-terminal support.
- Detection of an overriding `CLAUDE_CONFIG_DIR` in `claudeCode.environmentVariables`.
- Detection and repair of broken shared links.
- Import of account folders created by earlier installs.
- English and Brazilian Portuguese UI.
