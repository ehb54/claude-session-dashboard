# Session dashboard for the Claude Code desktop app

A Claude Code mod that adds a **Sessions** pane to the Code tab of the Claude
desktop app: every session you have, in one list, whatever sidebar group it is
filed under, sorted by when **you** last touched it or by its last activity of
any kind. Click a row to jump to that session; the dashboard moves to a window
of its own first, so it stays in view.

The sidebar keeps each custom group in its own section and sorts within it,
so with many groups and many sessions it is hard to see what you worked on
last. This pane answers that.

## What the pane shows

```
[Sort: your last touch] [Show archived] [Refresh] [Pop out]
Within [1d] [1w] [1M] [all]  [or type 30m, 6h, 2w, 3M] [Set]
[Filter by title or group]
12 of 275 sessions within 1 day · scanned just now · ● running
● Build the release scripts
    infra · you 3m · any 1m
  Review the parser change
    no group · you 2h · any 5h
```

- **One row per session**: title (● when it is running), then its sidebar
  group, **you** (your last touch) and **any** (last activity of any kind).
- **Your last touch** is the later of when you last opened the session and
  when you last sent it a prompt yourself. Messages other sessions relayed to
  it and background-task notifications do not count.
- **Sort** switches between your last touch and last activity.
- **Within** hides sessions older than a cutoff, applied to the time you sort
  by. Presets are 1d (the default), 1w, 1M and all; or type your own: a number
  and a unit, `m` minutes, `h` hours, `d` days, `w` weeks, `M` months (30 days),
  `y` years. `h`, `d`, `w` and `y` work in either case; `m` and `M` do not, so
  `90m` is ninety minutes and `2M` two months. Decimals work (`1.5h`). With a
  cutoff set, a session with no time at all (never opened, never prompted)
  shows only under **all**.
- **Filter** keeps rows whose title or group contains every word you type.
- **Show archived** adds archived sessions.
- **Click a row** to open that session in the main window. The first time,
  the dashboard's own session moves into a pop-out window so the list stays
  visible; **Pop out** does that by itself.

The pane rescans every 30 seconds while it is open, and not at all while it is
closed. Only files that changed since the last scan are read again.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install session-dashboard --marketplace ehb54/claude-session-dashboard
```

Answer `y` to add the marketplace, then pick a scope (user scope makes it
available in every session, the desktop app's included).

From a shell:

```
claude plugin install session-dashboard --marketplace ehb54/claude-session-dashboard
```

In the desktop app, where `/plugin` does not run: click **+** next to the
prompt box, then **Plugins**, **Add marketplace** with
`ehb54/claude-session-dashboard`, then **Add plugin**.

## Use

In the session you want to keep as your dashboard, type:

```
/session-dashboard
```

The pane opens beside the conversation. A session that never runs the command
never opens the pane and never scans.

## What it reads

Everything stays on your machine, and the mod writes nothing. It reads:

- **The desktop app's own session tools** (the `ccd_session_mgmt`,
  `ccd_sidebar` and `ccd_window` servers the app provides to its sessions):
  the sidebar groups and their sessions, the 30 most recent sessions (for
  running state), this session's own details, and the window layout. It asks
  for these in small pieces, since a list of hundreds of sessions is too large
  to come back through one call.
- **The app's session index**, one small JSON file per session, for the full
  list, when you last opened each session, and which transcript it writes:
  - macOS: `~/Library/Application Support/Claude/claude-code-sessions/`
  - Windows: `%APPDATA%\Claude\claude-code-sessions\`
  - Linux: `$XDG_CONFIG_HOME/Claude/claude-code-sessions/` (default `~/.config`)
- **Claude Code's transcripts** under `~/.claude/projects/` (or
  `$CLAUDE_CONFIG_DIR/projects/`), only to find the time of your last prompt:
  it runs `grep` for the `"origin":{"kind":"human"}` marker through `sh` and
  keeps only that line's timestamp. Without `sh`, it reads transcripts of up to
  4 MiB directly and skips larger ones.

To open a session it runs the app's own link for it (`claude://...`) through
`open` on macOS, `xdg-open` on Linux, or `start` on Windows.

## Limits

- Built and tested on macOS with Claude Code 2.1.321 in the desktop app. The
  Windows and Linux paths and openers are written but untested.
- It relies on the app's session index files and session tools, which are
  not a documented interface, and on the mod API, which is early access. An
  app update can change either; the pane then shows a warning line saying
  which lookup failed rather than quietly listing fewer sessions.
- Only sessions of the account the dashboard runs under are listed.
- A session no lookup returned gets a link built from the shape of the links
  the app did return.

## Develop

```
claude plugin validate .
claude plugin test .
```

The tests run the pane on the desktop and terminal surfaces against a fake
app: sorting both ways, the cutoff presets and typed values, the filter, the
pop-out before the first open, and the fallback when the app's lookups fail.

## License

MIT, see [LICENSE](LICENSE).
