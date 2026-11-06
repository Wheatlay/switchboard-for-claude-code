# Changelog


## 2.5.16

- The Continue button on the "continue will be sent once idle" notification (after a switch or a limit reset) now sends "continue" right away, even while you are using keyboard and mouse. Before, it only filled the input box, and a click during an idle check was ignored.
## 2.5.15

- Switching profiles carries over only the text typed (not yet sent) in Claude Code's input box of the window (Windows). The last sent prompt is no longer copied; with an empty input nothing is carried over.

## 2.5.14

- Fewer notifications: after a switch the "last prompt" note and simple confirmations (sent "continue", repository default set or removed) show briefly in the status bar instead of as pop-ups.

## 2.5.13

- Shared-profile accounts get the MCP servers from your default profile (`~/.claude.json`). They are copied when an account is added, relinked or switched to a shared profile, and again at startup. Only missing servers are added; an account's own servers are never changed or removed.

## 2.5.12

- `experimental.preventSleep`: the helper that holds off sleep ends by itself if VS Code crashes or is killed, so the computer can sleep again.

## 2.5.11

- Fix: auto-continue and keep-alive pings no longer give up when the VS Code window has to be brought to the front. The Alt press used for that counted as your input and failed the last idle check.
- The log says when auto-continue starts waiting for you to be idle.

## 2.5.10

- Idle times are now set in seconds: `experimental.autoContinueIdleSeconds` (default 60) and `experimental.keepCacheWarmIdleSeconds` (default 60). Values set in the old ...IdleMinutes settings are still used until you set the new ones.
- The auto-continue notifications show the idle time you set instead of a fixed 3 minutes.
- Switching profiles carries your last prompt over even when Switchboard had not seen it while typing (e.g. a new profile whose projects folder appeared or was linked after VS Code started): it is read from the newest session file of the folder.
- Keep-alive pings and auto-continue work behind a screen saver (one without a password): it is ended for a few seconds without counting as input, the message is typed, and the screen saver starts again. A locked screen is skipped and logged.
- Keep-alive checks that the ping arrived in the conversation and tries again a minute later if it did not. Pings start 5 minutes before a 1-hour cache expires, which leaves room for retries.
- New `experimental.afterTyping`: after typing behind a screen saver, bring the screen saver back (default) or turn the screen off.
- New `experimental.preventSleep` (off): keeps the computer from sleeping while a ping or auto-continue is waiting.
- New command **Test auto-continue behind the screen saver (experimental)**.

## 2.5.9

- No more repeated "not linked to these shared items: settings.json" warning. When Claude Code saves settings.json over the link, the next start relinks it silently: identical content is just relinked, a newer edit made in the account becomes the shared version (the previous one is backed up as settings.json.bak-<time>). The warning remains only when ~/.claude has the newer version.
- Auto-continue brings the right VS Code window to the front more reliably (any title format) and logs why when it cannot.
- Keep-alive pings are no longer scheduled for conversations whose cache already expired before VS Code started.

## 2.5.8

- Experimental `claudeAccounts.experimental.keepCacheWarm` (off, Windows only, at your own risk): while you are away, keeps the prompt cache of a large conversation warm with a short `[keep-alive]` ping shortly before the cache expires. At most `keepCacheWarmPings` pings (default 2) after your last prompt; only for contexts of at least `keepCacheWarmMinContext` tokens (default 100k), after `keepCacheWarmIdleMinutes` (default 2) without input, and not while Claude is working or a limit is reached.
- Auto-continue and keep-alive pings no longer touch what you have typed in Claude Code: the draft is moved aside, the message is sent, and the draft is put back. Your clipboard is restored.
- New `claudeAccounts.experimental.autoContinueIdleMinutes` (default 3): idle time before auto-continue types `continue`.

## 2.5.7

- The wait for a limit reset is also checked every minute, so a long wait (a weekly reset days away) is not thrown off when the computer sleeps.

## 2.5.6

- After any account switch, your last sent prompt is typed back into Claude Code (the same conversation with shared history, a new one otherwise) and copied to the clipboard. Pasted images are not carried over.
- New `claudeAccounts.remindOnLimitReset` (on by default): when the limit resets, a notification offers to continue the interrupted conversation with `continue` typed in.
- Experimental `claudeAccounts.experimental.autoContinue` (off, Windows only, at your own risk): after the reset, once keyboard and mouse have been idle for 3 minutes, brings the VS Code window to the front and types `continue` + Enter. Retries every minute for up to 6 hours; several windows take turns. With auto-switch and shared history, the account switched to continues right away. Command **Test auto-continue (experimental)** tries the keystrokes.
- With auto-switch on and every account used up, the extension waits for whichever account resets first and switches to it.
- The **More** menu is grouped (Accounts, This repository, Usage, Tools); shared history is shown as an on/off toggle, and "..." marks items that open another list.
- **Token usage** opens at once and fills in, without a progress notification; with shared history it is named **Token usage (local logs)**.
- Brazilian Portuguese translation removed; the UI is English only.
- Settings are regrouped into Switching accounts, Default account per repository, Shared files and history, Usage limits, After a limit resets, Status bar and account picker, Artifact preview and Advanced; outdated descriptions are fixed.

## 2.5.5

- Log in and log out work without `claude` on PATH: when it is missing, the CLI bundled with the Claude Code extension is used. If neither is found, a clear error replaces a failing terminal.
- Creating an account with an isolated profile now says that CLAUDE.md, agents, skills and settings from `~/.claude` do not apply to it, and offers to switch it to a shared profile.

## 2.5.4

- Artifact preview also picks up pages published with the artifacts connector (`publish_files`), not only the built-in Artifact tool. The page is served from the folder of its published files.

## 2.5.3

- Logging in or out of an account other than the selected one now acts on that account. Before, with `claudeAccounts.applyToTerminal` on, the terminal got the selected account's folder.
- Logging in or out of the selected account reloads the window as set in `claudeAccounts.reloadBehavior`, so the Claude Code panel picks up the change.

## 2.5.2

- Settings are grouped into sections (Accounts, Shared files and history, Status bar and account picker, Usage limits, Artifact preview), and every reload choice has a description.
- Setting descriptions link to the settings they depend on.
- Turning `claudeAccounts.shareHistory` on or off in Settings now goes through the same dialog as the command, so existing history is merged or copied instead of being silently relinked.
- All settings now apply to every window (user settings only); per-workspace values are ignored.

## 2.5.1

- Items that appear in `~/.claude` after an account was set up (e.g. `agents`) are linked into the account automatically when it has nothing there, instead of a "not linked" warning.
- The "last prompt is in the clipboard" notice shows only when there was a prompt to copy.

## 2.5.0

- **Auto-switch on usage limit** (`claudeAccounts.autoSwitchOnLimit`, off by default). When the current account hits its limit, the window switches to the account with the most headroom and reloads. The prompt you sent last is copied to the clipboard, ready to paste again.
- The "hit its usage limit" notice no longer comes back after switching accounts with shared history on.

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
