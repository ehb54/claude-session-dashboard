# Session dashboard for the Claude Code desktop app

A Claude Code mod that adds a **Sessions** pane to the Code tab of the Claude
desktop app: every session you have, in one list, whatever sidebar group it is
filed under, sorted by when **you** last touched it or by its last activity of
any kind, with the pull requests and issues each one worked on. Click a row
to jump to that session; the dashboard moves to a window of its own first, so
it stays in view.

The sidebar keeps each custom group in its own section and sorts within it,
so with many groups and many sessions it is hard to see what you worked on
last. This pane answers that.

## Install

Add this repository as a marketplace, then install the plugin from it. At the
prompt of a Claude Code terminal session:

```
/plugin marketplace add ehb54/claude-session-dashboard
/plugin install session-dashboard@claude-session-dashboard
```

The part after `@` is the marketplace's name from
[`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json), not the
repository path. Pick a scope when asked: user scope makes the plugin
available in every session, the desktop app's included, because terminal
sessions, the desktop app's local sessions and the VS Code extension read the
same settings.

On Claude Code 2.1.275 or later, one line does both steps:

```
/plugin install session-dashboard --marketplace ehb54/claude-session-dashboard
```

It shows the marketplace it resolved and asks you to confirm before adding it.
Older versions do not know `--marketplace`; use the two lines above.

From a shell, without starting a session:

```
claude plugin marketplace add ehb54/claude-session-dashboard
claude plugin install session-dashboard@claude-session-dashboard
```

This installs at user scope; pass `--scope project` or `--scope local` for
another. On Claude Code 2.1.292 or later, `claude plugin install
session-dashboard --marketplace ehb54/claude-session-dashboard` does both
steps in one.

In the desktop app, where `/plugin` does not run: click **+** next to the
prompt box, then **Plugins**, **Add marketplace** with
`ehb54/claude-session-dashboard`, then **Add plugin**. Or install it from a
terminal at user scope as above.

A session that was already open when you installed picks the plugin up after
`/reload-plugins`, so a long-running session does not need a restart. New
sessions load it when they start.

## Use

In the session you want to keep as your dashboard, type:

```
/session-dashboard
```

The pane opens beside the conversation. A session that never runs the command
never opens the pane and never scans.

## What the pane shows

```
[Sort: your last touch] [Show archived] [Show hidden (2)] [Refresh] [Pop out]
Within [1d] [1w] [1M] [all]  [or type 30m, 6h, 2w, 3M] [Set]
[Filter by title, group, PR or issue]
13 of 275 sessions within 1 day · 1 kept · 2 hidden · scanned just now · ● running
● Build the release scripts
    infra · you 3m · any 1m  keep  hide
    PRs tools#41 open #38 merged · issues tickets#212 #208 #199 +2 more
  Review the parser change
    no group · you 2h · any 5h  keep  hide
    PRs parser#17 open
  Grant renewal figures (kept)
    writing · you 9d · any 9d  unkeep  hide
```

- **One row per session**: title (● when it is running), then its sidebar
  group, **you** (your last touch) and **any** (last activity of any kind).
- **PRs and issues** the session worked on, on a third line when it has any:
  - **PRs** are the pull requests the app linked to the session, with their
    state as the app last saw it, open ones first.
  - **issues** are the GitHub issues the session's transcript links, the most
    linked first.
  - A repository is named once, then just `#number`. Up to three of each
    show; **+N more** shows the rest, **fewer** folds them again.
  - Click one to open it in your browser.
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
  shows only under **all**, unless you keep it.
- **Filter** keeps rows whose title, group, PRs or issues contain every word
  you type: `tickets#212` or `#212` finds the sessions on that issue, folded
  ones included.
- **keep** on a row keeps that session in the list whatever the cutoff, marked
  "(kept)", in its place in the sort, until you press **unkeep**. The filter
  and **Show archived** still apply to it. Hiding a kept session lets it go;
  keeping a hidden one unhides it.
- **hide** on a row takes that session off the list. **Show hidden (N)** brings
  hidden sessions back, marked "(hidden)", each with **unhide**.
- **Show archived** adds archived sessions.
- Your sort, cutoff, and kept and hidden sessions are remembered: a dashboard in any
  session starts with the choices you made last.
- **Click a row** to open that session in the main window. The first time,
  the dashboard's own session moves into a pop-out window so the list stays
  visible; **Pop out** does that by itself.

The pane rescans every 30 seconds while it is open, and not at all while it is
closed. Only files that changed since the last scan are read again.

## What it reads

Everything stays on your machine. The only thing the mod writes is its own
small store in Claude Code (your sort, cutoff, and kept and hidden session ids). It
reads:

- **The desktop app's own session tools** (the `ccd_session_mgmt`,
  `ccd_sidebar` and `ccd_window` servers the app provides to its sessions):
  the sidebar groups and their sessions, the 30 most recent sessions (for
  running state), this session's own details, and the window layout. It asks
  for these in small pieces, since a list of hundreds of sessions is too large
  to come back through one call.
- **The app's session index**, one small JSON file per session, for the full
  list, when you last opened each session, the pull requests the app linked
  to it, and which transcript it writes:
  - macOS: `~/Library/Application Support/Claude/claude-code-sessions/`
  - Windows: `%APPDATA%\Claude\claude-code-sessions\`
  - Linux: `$XDG_CONFIG_HOME/Claude/claude-code-sessions/` (default `~/.config`)
- **Claude Code's transcripts** under `~/.claude/projects/` (or
  `$CLAUDE_CONFIG_DIR/projects/`), only to find the time of your last prompt
  (the last line with the `"origin":{"kind":"human"}` marker) and the GitHub
  issue links. One `perl` pass per transcript reads each file once and prints
  just those findings. Without `perl` it does the same with `grep` through
  `sh`, which is several times slower. Without either, it reads transcripts
  of up to 4 MiB directly and skips larger ones. A transcript is read again
  only after it changes.

To open a session it runs the app's own link for it (`claude://...`) through
`open` on macOS, `xdg-open` on Linux, or `start` on Windows. A PR or issue
opens the same way, with its `https://` link. Only `https://` links are ever
opened.

## Limits

- Built and tested on macOS with Claude Code 2.1.321 in the desktop app. The
  Windows and Linux paths and openers are written but untested.
- It relies on the app's session index files and session tools, which are
  not a documented interface, and on the mod API, which is early access. An
  app update can change either; the pane then shows a warning line saying
  which lookup failed rather than quietly listing fewer sessions.
- Only sessions of the account the dashboard runs under are listed.
- Issues are counted from full `https://github.com/<owner>/<repo>/issues/<n>`
  links anywhere in the transcript: in your prompts, in Claude's replies, and
  in tool output. A bare `#12` is not counted, and neither is GitHub
  Enterprise. An issue a session only listed in passing can show up, usually
  below the ones it worked on, since those are linked more often.
- A PR's state is the one the app last recorded, which can lag behind GitHub.
- A session no lookup returned gets a link built from the shape of the links
  the app did return.

## Update and uninstall

Claude Code auto-updates only its official marketplaces by default, so this
one stays at the version you installed until you update it. From a shell:

```
claude plugin marketplace update claude-session-dashboard
claude plugin update session-dashboard@claude-session-dashboard
```

Or, in a terminal session, run `/plugin`, open the **Marketplaces** tab,
select `claude-session-dashboard` and choose **Update marketplace**. The same
place turns auto-update on. A running session keeps the version it loaded
until you run `/reload-plugins` in it.

To uninstall:

```
claude plugin uninstall session-dashboard@claude-session-dashboard
claude plugin marketplace remove claude-session-dashboard
```

Removing the marketplace also uninstalls every plugin installed from it, so
the second line alone does both. In a session the same commands are
`/plugin uninstall ...` and `/plugin marketplace remove ...`.

## Troubleshooting

- **`/plugin isn't available in this environment`**: you typed `/plugin` in
  the desktop app's Code tab, or another surface without a terminal. Use a
  terminal session, a shell, or the desktop app's **+** menu, as under
  [Install](#install).
- **`--marketplace` is not accepted**: your Claude Code is older than 2.1.275
  (2.1.292 for the shell command). Add the marketplace first, then install
  `session-dashboard@claude-session-dashboard`.
- **`Plugin "session-dashboard" not found`**: the marketplace has not been
  added yet, or the `@claude-session-dashboard` suffix is missing.
- **`/session-dashboard` is not a command**: the session started before the
  install. Run `/reload-plugins` in it, or start a new session.

## Develop

Load a working copy into one session without installing it:

```
claude --plugin-dir .
```

Claude Code hot-reloads the hooks module whenever a file in it changes. It
also writes the type definitions for your Claude Code version into
`.claude-plugin/types/`, which `tsconfig.json` extends and `.gitignore`
leaves out.

Check and test from a shell:

```
claude plugin validate .
claude plugin test .
```

The tests run the pane on the desktop and terminal surfaces against a fake
app: sorting both ways, the cutoff presets and typed values, the filter, the
pop-out before the first open, hiding and unhiding, keeping past the cutoff, choices saved and restored
across sessions, PRs and issues folding, unfolding and opening, the perl,
grep and in-memory transcript scans, and the fallback when the app's lookups
fail.

Installed copies are cached by version, so bump `version` in
[`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) for every release,
or `claude plugin update` finds nothing new.

## License

MIT, see [LICENSE](LICENSE).
