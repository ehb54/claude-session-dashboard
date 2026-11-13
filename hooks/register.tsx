import { atom, read, update } from 'claude-code'
import type { EngineInterface, McpToolResult, Register } from 'claude-code'

import type { Ref, Row, SortKey, Status } from '../types'
import {
  CUTOFF_PRESETS,
  HUMAN_MARKER,
  ago,
  filterRows,
  issueRefs,
  mergeRows,
  ownRecords,
  parseCutoff,
  parseIndexRecord,
  parseListed,
  parseScanOutput,
  projectSlug,
  refLabels,
  scanTranscriptText,
  sortRows,
  touchAt,
  withinCutoff,
} from './data'
import type { IndexRecord, Listed, TranscriptScan } from './data'

type Engine = EngineInterface

const PANE = 'session-dashboard'
const TITLE = 'Sessions'
/** The desktop app's own MCP servers for sessions and the sidebar. */
const SESSIONS = 'ccd_session_mgmt'
const SIDEBAR = 'ccd_sidebar'
const WINDOW = 'ccd_window'
/**
 * The app's answers are kept small: a whole list of hundreds of sessions is
 * too large to come back through one call, so groups are asked one by one,
 * and the recent list (running state for ungrouped sessions) is capped.
 */
const RECENT = 30
const GROUP_SLACK = 10
const GROUP_BATCH = 6
const REFRESH_MS = 30_000
/** `$.fs.read` refuses files over 4 MiB. */
const READ_LIMIT = 4 * 1024 * 1024
/** Transcripts scanned at once. */
const BATCH = 8
/** Pull requests, and issues, a row shows until it is expanded. */
const REF_LIMIT = 3

/**
 * One pass over a transcript: the timestamps of the last line marked as the
 * person's prompt, then each GitHub issue link with how often it appears.
 * Each line is tested with `index` before a pattern runs, so it keeps up with
 * transcripts of hundreds of MB (several times faster than grep).
 */
const PERL_SCAN = String.raw`my ($mark, $path) = @ARGV; my ($t, %n);
open(my $f, '<', $path) or exit 2;
while (<$f>) {
  if (index($_, $mark) >= 0) { while (/"timestamp":"([^"]*)"/g) { $t = $1 } }
  if (index($_, '/issues/') >= 0) {
    while (m{(https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/issues/[0-9]+)}g) { $n{$1}++ }
  }
}
print qq{"timestamp":"$t"\n} if defined $t;
print "$n{$_} $_\n" for keys %n;`

/** The same through grep, where there is a shell but no perl. */
const GREP_SCAN =
  'grep -F -- "$0" "$1" | tail -n 1 | grep -o \'"timestamp":"[^"]*"\' | tail -n 1; ' +
  'grep -F -- /issues/ "$1" | grep -o -E \'https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/issues/[0-9]+\' | sort | uniq -c'

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const rowsAtom = atom({ plugin: 'session-dashboard', key: 'rows' } as const, [] as Row[], {
  shape: 'rows-2',
})
const sortAtom = atom({ plugin: 'session-dashboard', key: 'sort' } as const, 'touch' as SortKey)
const cutoffAtom = atom({ plugin: 'session-dashboard', key: 'cutoff' } as const, '1d')
const archivedAtom = atom({ plugin: 'session-dashboard', key: 'archived' } as const, false)
const hiddenAtom = atom({ plugin: 'session-dashboard', key: 'hidden' } as const, [] as string[])
const showHiddenAtom = atom({ plugin: 'session-dashboard', key: 'showHidden' } as const, false)
const expandedAtom = atom({ plugin: 'session-dashboard', key: 'expanded' } as const, [] as string[])
const filterAtom = atom({ plugin: 'session-dashboard', key: 'filter' } as const, '')
const statusAtom = atom(
  { plugin: 'session-dashboard', key: 'status' } as const,
  { updatedAt: null, error: null, poppedOut: null } as Status,
  { shape: 'status-2' },
)

type Mark = { size: number; mtimeMs: number }

// Caches keyed by file path; a reload starts them over, which costs one full
// scan and nothing else.
const indexCache = new Map<string, Mark & { rec: IndexRecord | null }>()
const transcriptCache = new Map<string, Mark & TranscriptScan>()
let scanning: Promise<void> | null = null
let scanners: Promise<{ perl: boolean; sh: boolean }> | null = null
let opener: ((link: string) => string[]) | null = null

const message = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

const textOf = (result: McpToolResult): string =>
  result.content.map(block => ('text' in block ? String(block.text) : '')).join('')

const same = (a: Mark | undefined, b: Mark): boolean =>
  a !== undefined && a.size === b.size && a.mtimeMs === b.mtimeMs

/** Where the app's session index and Claude Code's transcripts live. */
async function places($: Engine): Promise<{ index: string | null; projects: string }> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`
  const appData = await $.env.get('APPDATA')
  const xdg = (await $.env.get('XDG_CONFIG_HOME')) ?? `${home}/.config`
  const candidates = [
    `${home}/Library/Application Support/Claude/claude-code-sessions`,
    ...(appData === undefined ? [] : [`${appData}/Claude/claude-code-sessions`]),
    `${xdg}/Claude/claude-code-sessions`,
  ]
  for (const dir of candidates) {
    if (await $.fs.exists(dir)) return { index: dir, projects: `${config}/projects` }
  }

  return { index: null, projects: `${config}/projects` }
}

/** Calls one of the app's tools and parses its JSON answer. */
async function callJson(
  $: Engine,
  server: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await $.mcp.call(server, tool, args)
  const text = textOf(result)
  if (result.isError) throw new Error(`${tool}: ${text.slice(0, 160) || 'failed'}`)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${tool} answered ${text.length} characters of non-JSON: ${text.slice(0, 120)}`)
  }
}

/**
 * What the app says about its sessions: each sidebar group's members, the
 * most recent sessions, and this session (which `list_sessions` leaves out).
 */
async function lookUpSessions(
  $: Engine,
  showArchived: boolean,
): Promise<{ listed: Map<string, Listed>; selfId: string | null; errors: string[] }> {
  const listed = new Map<string, Listed>()
  const errors: string[] = []
  const add = (data: unknown) => {
    for (const one of parseListed(data)) {
      listed.set(one.id, { ...one, group: one.group ?? listed.get(one.id)?.group ?? null })
    }
  }
  let selfId: string | null = null
  try {
    const [me] = parseListed(await callJson($, SESSIONS, 'get_session', { session_id: 'self' }))
    if (me !== undefined) {
      selfId = me.id
      listed.set(me.id, me)
    }
  } catch (err) {
    errors.push(message(err))
  }
  try {
    add(await callJson($, SESSIONS, 'list_sessions', { limit: RECENT, include_archived: showArchived }))
  } catch (err) {
    errors.push(message(err))
  }
  try {
    const groups = await callJson($, SIDEBAR, 'list_groups', {})
    const asks = (Array.isArray(groups) ? groups : [])
      .map(group => group as { id?: unknown; session_count?: unknown })
      .filter(group => typeof group.id === 'string' && Number(group.session_count) > 0)
      .map(group => ({
        group: group.id as string,
        limit: Number(group.session_count) + GROUP_SLACK,
        include_archived: showArchived,
      }))
    for (let i = 0; i < asks.length; i += GROUP_BATCH) {
      const answers = await Promise.allSettled(
        asks.slice(i, i + GROUP_BATCH).map(args => callJson($, SESSIONS, 'list_sessions', args)),
      )
      for (const answer of answers) {
        if (answer.status === 'fulfilled') add(answer.value)
        else errors.push(message(answer.reason))
      }
    }
  } catch (err) {
    errors.push(message(err))
  }

  return { listed, selfId, errors }
}

/** Every `local_*.json` record of the app's index: <root>/<account>/<org>/. */
async function scanIndex($: Engine, root: string): Promise<Map<string, IndexRecord>> {
  const files: (Mark & { path: string; dir: string })[] = []
  for (const account of await $.fs.list(root)) {
    if (account.kind !== 'dir') continue
    for (const org of await $.fs.list(`${root}/${account.name}`)) {
      if (org.kind !== 'dir') continue
      const dir = `${root}/${account.name}/${org.name}`
      for (const file of await $.fs.list(dir)) {
        if (file.kind === 'file' && /^local_.+\.json$/.test(file.name)) {
          files.push({ path: `${dir}/${file.name}`, dir, size: file.size, mtimeMs: file.mtimeMs })
        }
      }
    }
  }
  const out = new Map<string, IndexRecord>()
  for (const file of files) {
    const hit = indexCache.get(file.path)
    let rec: IndexRecord | null
    if (same(hit, file)) {
      rec = hit!.rec
    } else {
      try {
        rec = parseIndexRecord(await $.fs.read(file.path), file.dir)
      } catch {
        rec = null
      }
      indexCache.set(file.path, { size: file.size, mtimeMs: file.mtimeMs, rec })
    }
    if (rec === null) continue
    const prev = out.get(rec.sessionId)
    if (prev === undefined || (rec.activityAt ?? 0) >= (prev.activityAt ?? 0)) {
      out.set(rec.sessionId, rec)
    }
  }

  return out
}

const works = async ($: Engine, argv: string[]): Promise<boolean> => {
  try {
    return (await $.process.run(argv, { timeoutMs: 5000 })).exitCode === 0
  } catch {
    return false
  }
}

/** Which outside scanners run here, asked once. */
function scannersOf($: Engine): Promise<{ perl: boolean; sh: boolean }> {
  scanners ??= (async () => ({
    perl: await works($, ['perl', '-e', 'exit 0']),
    sh: await works($, ['sh', '-c', 'exit 0']),
  }))()

  return scanners
}

/**
 * One transcript file's last prompt from the person and its issue links:
 * through perl, else grep, else read whole when it is small enough. Only the
 * findings come back, however long the file is.
 */
async function scanFile($: Engine, path: string, size: number): Promise<TranscriptScan> {
  const can = await scannersOf($)
  const runs: string[][] = []
  if (can.perl) runs.push(['perl', '-e', PERL_SCAN, HUMAN_MARKER, path])
  if (can.sh) runs.push(['sh', '-c', GREP_SCAN, HUMAN_MARKER, path])
  for (const argv of runs) {
    const run = await $.process.run(argv, { timeoutMs: 60_000 })
    if (run.exitCode === 0) return parseScanOutput(run.stdout)
  }
  if (size < READ_LIMIT) return scanTranscriptText(await $.fs.read(path))
  throw new Error('transcript too large to read without perl or a shell')
}

async function transcriptOf($: Engine, path: string, mark: Mark): Promise<TranscriptScan> {
  const hit = transcriptCache.get(path)
  if (same(hit, mark)) return hit!
  let found: TranscriptScan = { at: hit?.at ?? null, issues: hit?.issues ?? new Map() }
  try {
    found = await scanFile($, path, mark.size)
  } catch {
    // Keep what was last known for this file.
  }
  transcriptCache.set(path, { size: mark.size, mtimeMs: mark.mtimeMs, ...found })

  return found
}

/** Per session, from the transcripts it wrote: the person's last prompt and its issue links. */
async function scanTranscripts(
  $: Engine,
  projects: string,
  index: ReadonlyMap<string, IndexRecord>,
  ids: Iterable<string>,
): Promise<Map<string, TranscriptScan>> {
  const listings = new Map<string, Map<string, Mark>>()
  const listing = async (dir: string) => {
    let names = listings.get(dir)
    if (names === undefined) {
      names = new Map()
      try {
        for (const entry of await $.fs.list(dir)) {
          if (entry.kind === 'file') names.set(entry.name, entry)
        }
      } catch {
        // No transcripts for this folder.
      }
      listings.set(dir, names)
    }

    return names
  }
  const jobs: { id: string; path: string; mark: Mark }[] = []
  for (const id of ids) {
    const rec = index.get(id)
    if (rec === undefined || rec.cwd === null) continue
    const dir = `${projects}/${projectSlug(rec.cwd)}`
    const names = await listing(dir)
    for (const cli of rec.cliIds) {
      const mark = names.get(`${cli}.jsonl`)
      if (mark !== undefined) jobs.push({ id, path: `${dir}/${cli}.jsonl`, mark })
    }
  }
  const out = new Map<string, TranscriptScan>()
  for (let i = 0; i < jobs.length; i += BATCH) {
    const batch = jobs.slice(i, i + BATCH)
    const found = await Promise.all(batch.map(job => transcriptOf($, job.path, job.mark)))
    batch.forEach((job, k) => {
      const one = found[k]
      if (one === undefined) return
      const prev = out.get(job.id)
      if (prev === undefined) {
        out.set(job.id, { at: one.at, issues: new Map(one.issues) })
        return
      }
      if (one.at !== null && (prev.at === null || one.at > prev.at)) prev.at = one.at
      for (const [url, n] of one.issues) prev.issues.set(url, (prev.issues.get(url) ?? 0) + n)
    })
  }

  return out
}

async function scan($: Engine): Promise<void> {
  try {
    const showArchived = await read($, archivedAtom)
    const where = await places($)
    const { listed, selfId, errors } = await lookUpSessions($, showArchived)
    const index = ownRecords(
      where.index === null ? new Map<string, IndexRecord>() : await scanIndex($, where.index),
      selfId,
    )
    const rows = mergeRows({ index, listed, selfId, humanAt: new Map(), showArchived })
    const found = await scanTranscripts($, where.projects, index, rows.map(row => row.id))
    rows.forEach(row => {
      const one = found.get(row.id)
      row.humanAt = one?.at ?? null
      row.issues = issueRefs(one?.issues ?? new Map())
    })
    const notes: string[] = []
    if (errors.length > 0) {
      notes.push(`Some of the app's lookups failed, so some groups or links may be missing: ${errors.slice(0, 2).join('; ')}`)
    }
    if (where.index === null) {
      notes.push("The app's session index was not found: only sessions the app returned are listed, without last-touch times.")
    }
    const now = await $.clock.now()
    const poppedOut = await isPoppedOut($)
    await update($, rowsAtom, () => rows)
    await update($, statusAtom, () => ({
      updatedAt: now,
      error: notes.length > 0 ? notes.join(' ') : null,
      poppedOut,
    }))
  } catch (err) {
    await update($, statusAtom, status => ({ ...status, error: `Scan failed: ${message(err)}` }))
  }
}

/** One scan at a time; a call during a scan joins it. */
function refresh($: Engine): Promise<void> {
  scanning ??= scan($).finally(() => {
    scanning = null
  })

  return scanning
}

async function openerFor($: Engine): Promise<(link: string) => string[]> {
  if (opener === null) {
    if (await $.fs.exists('/usr/bin/open')) opener = link => ['/usr/bin/open', link]
    else if ((await $.env.get('APPDATA')) !== undefined) {
      opener = link => ['cmd', '/c', 'start', '', link]
    } else opener = link => ['xdg-open', link]
  }

  return opener
}

/** Whether this session shows in a pop-out window of its own; null when the app does not say. */
async function isPoppedOut($: Engine): Promise<boolean | null> {
  try {
    const layout = (await callJson($, WINDOW, 'get_window_layout', {})) as {
      popout_windows?: { sessions?: unknown }
      this_session?: { session_id?: unknown }
    }
    const self = layout.this_session?.session_id
    if (typeof self !== 'string') return null

    return JSON.stringify(layout.popout_windows?.sessions ?? []).includes(self)
  } catch {
    return null
  }
}

/**
 * Moves this session, and so the dashboard, into a pop-out window of its own,
 * so opening another session in the main window leaves the list in view.
 */
async function popOut($: Engine): Promise<void> {
  try {
    const result = await $.mcp.call(WINDOW, 'open_session_in', { session_id: 'self', target: 'window' })
    if (result.isError) await $.ui.toast(`Could not pop the dashboard out: ${textOf(result).slice(0, 160)}`)
  } catch (err) {
    await $.ui.toast(`Could not pop the dashboard out: ${message(err)}`)
  }
  const poppedOut = await isPoppedOut($)
  await update($, statusAtom, status => ({ ...status, poppedOut }))
}

/** Opens a pull request or issue in the browser; the app's windows stay as they are. */
async function openRef($: Engine, ref: Ref): Promise<void> {
  const name = `${ref.repo}#${ref.number}`
  try {
    const run = await $.process.run((await openerFor($))(ref.url), { timeoutMs: 10_000 })
    if (run.exitCode !== 0) {
      await $.ui.toast(`Could not open ${name}: ${run.stderr.trim() || `exit ${run.exitCode}`}`)
    }
  } catch (err) {
    await $.ui.toast(`Could not open ${name}: ${message(err)}`)
  }
}

/** Opens the session in the app through its deep link, as the OS routes it. */
async function openSession($: Engine, row: Row): Promise<void> {
  if (row.link === null) {
    await $.ui.toast(`No link for "${row.title}": open it from the sidebar.`)
    return
  }
  // Opening a session replaces what the main window shows: keep the list in
  // a window of its own first, unless it is the session being opened.
  if (!row.isSelf && (await isPoppedOut($)) === false) await popOut($)
  try {
    const run = await $.process.run((await openerFor($))(row.link), { timeoutMs: 10_000 })
    if (run.exitCode !== 0) {
      await $.ui.toast(`Could not open "${row.title}": ${run.stderr.trim() || `exit ${run.exitCode}`}`)
    }
  } catch (err) {
    await $.ui.toast(`Could not open "${row.title}": ${message(err)}`)
  }
}

/** Store keys, kept across sessions: the sort and cutoff chosen, and the sessions hidden. */
const PREFS = 'prefs'
const HIDDEN = 'hidden'

/** Puts back what the person chose last, in any session: sort, cutoff, hidden sessions. */
async function loadPrefs($: Engine): Promise<void> {
  try {
    const saved = (await $.store.get(PREFS)) as { sort?: unknown; cutoff?: unknown } | undefined
    const sort = saved?.sort
    if (sort === 'touch' || sort === 'activity') await update($, sortAtom, () => sort)
    const cut = typeof saved?.cutoff === 'string' ? parseCutoff(saved.cutoff) : null
    if (cut !== null) await update($, cutoffAtom, () => cut.spec)
  } catch {
    // Nothing saved, or the store is unreadable: the defaults stand.
  }
  try {
    const hidden = await $.store.get(HIDDEN)
    if (Array.isArray(hidden)) {
      const ids = hidden.filter((id): id is string => typeof id === 'string')
      await update($, hiddenAtom, () => ids)
    }
  } catch {
    // Nothing hidden yet.
  }
}

/** Hides a session from the list, or shows it again, and remembers that. */
async function setHidden($: Engine, id: string, hide: boolean): Promise<void> {
  await update($, hiddenAtom, ids =>
    hide ? [...new Set([...ids, id])] : ids.filter(one => one !== id),
  )
  try {
    await $.store.set(HIDDEN, await read($, hiddenAtom))
  } catch {
    // It still holds for this session.
  }
}

async function savePrefs($: Engine): Promise<void> {
  try {
    await $.store.set(PREFS, { sort: await read($, sortAtom), cutoff: await read($, cutoffAtom) })
  } catch {
    // The choice still holds for this session.
  }
}

async function toggleSort($: Engine): Promise<void> {
  await update($, sortAtom, now => (now === 'touch' ? 'activity' : 'touch'))
  await savePrefs($)
}

/** Sets the cutoff from a preset or what the person typed. */
async function setCutoff($: Engine, text: string): Promise<void> {
  const cut = parseCutoff(text)
  if (cut === null) {
    await $.ui.toast(`"${text.trim()}" is not a cutoff: try 30m, 6h, 2d, 1w, 3M or all (m minutes, M months).`)
    return
  }
  await update($, cutoffAtom, () => cut.spec)
  await savePrefs($)
}

const isOpen = async ($: Engine): Promise<boolean> =>
  (await $.ui.panes()).some(pane => pane.id === PANE)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'session-dashboard',
      description: 'Open a pane of all sessions, across groups, by your last touch',
    })
    await loadPrefs($)
    // Scans run only while the pane is open, so a session without it costs nothing.
    $.clock.every(REFRESH_MS, async () => {
      if (await isOpen($)) await refresh($)
    })
    if (await isOpen($)) void refresh($)

    return next(e)
  })

  on('command.run', { command: 'session-dashboard' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    void refresh($)

    return { text: 'Session dashboard opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const rows = await read($, rowsAtom)
    const sort = await read($, sortAtom)
    const archived = await read($, archivedAtom)
    const filter = await read($, filterAtom)
    const status = await read($, statusAtom)
    const cut = parseCutoff(await read($, cutoffAtom)) ?? parseCutoff('1d')!
    const isPreset = (CUTOFF_PRESETS as readonly string[]).includes(cut.spec)
    const hidden = new Set(await read($, hiddenAtom))
    const showHidden = await read($, showHiddenAtom)
    const expanded = new Set(await read($, expandedAtom))
    const hiddenCount = rows.filter(row => hidden.has(row.id)).length
    const now = await $.clock.now()
    const visible = filterRows(rows, filter).filter(row => showHidden || !hidden.has(row.id))
    const shown = sortRows(withinCutoff(visible, sort, cut.ms, now), sort)
    const age = status.updatedAt === null ? null : ago(status.updatedAt, now)
    const head =
      age === null
        ? 'Scanning sessions…'
        : `${shown.length} of ${rows.length} sessions${cut.ms === null ? '' : ` within ${cut.label}`}${hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ''} · scanned ${age === 'now' ? 'just now' : `${age} ago`} · ● running`

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Button
            key="sort"
            label={sort === 'touch' ? 'Sort: your last touch' : 'Sort: last activity'}
            onPress={() => void toggleSort($)}
          />
          <Button
            key="archived"
            label={archived ? 'Hide archived' : 'Show archived'}
            onPress={() => void update($, archivedAtom, now => !now).then(() => refresh($))}
          />
          <Button
            key="show-hidden"
            label={showHidden ? 'Hide hidden' : `Show hidden (${hiddenCount})`}
            onPress={() => void update($, showHiddenAtom, now => !now)}
          />
          <Button key="refresh" label="Refresh" onPress={() => void refresh($)} />
          {status.poppedOut !== true && (
            <Button key="popout" label="Pop out" onPress={() => void popOut($)} />
          )}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center">
          <Text dimColor>Within</Text>
          {CUTOFF_PRESETS.map(preset => (
            <Button
              key={`cutoff-${preset}`}
              label={preset}
              variant={cut.spec === preset ? 'primary' : 'secondary'}
              onPress={() => void setCutoff($, preset)}
            />
          ))}
          <Input
            key="cutoff"
            placeholder="or type 30m, 6h, 2w, 3M"
            value={isPreset ? '' : cut.spec}
            submitLabel="Set"
            onSubmit={value => void setCutoff($, value)}
          />
        </Box>
        <Input
          key="filter"
          placeholder="Filter by title, group, PR or issue"
          value={filter}
          onInput={value => void update($, filterAtom, () => value)}
          onSubmit={value => void update($, filterAtom, () => value)}
        />
        <Text dimColor>{head}</Text>
        {status.poppedOut === false && (
          <Text dimColor>Opening a session first moves this list into its own window, so it stays in view.</Text>
        )}
        {status.error !== null && <Text color="warning">{status.error}</Text>}
        {shown.map(row => {
          const isHidden = hidden.has(row.id)
          const isExpanded = expanded.has(row.id)
          const prs = isExpanded ? row.prs : row.prs.slice(0, REF_LIMIT)
          const issues = isExpanded ? row.issues : row.issues.slice(0, REF_LIMIT)
          const more = row.prs.length - prs.length + row.issues.length - issues.length
          const canFold = isExpanded && (row.prs.length > REF_LIMIT || row.issues.length > REF_LIMIT)
          const toggle = () =>
            void update($, expandedAtom, ids =>
              isExpanded ? ids.filter(id => id !== row.id) : [...ids, row.id],
            )

          return (
            <Box key={`row-${row.id}`} flexDirection="column">
              <Button key={row.id} plain onPress={() => void openSession($, row)}>
                {`${row.isRunning ? '● ' : '  '}${row.title}${row.isSelf ? ' (this session)' : ''}${row.isArchived ? ' (archived)' : ''}${isHidden ? ' (hidden)' : ''}`}
              </Button>
              <Box flexDirection="row" columnGap={1}>
                <Text dimColor wrap="truncate-end">
                  {`    ${row.group ?? 'no group'} · you ${ago(touchAt(row), now)} · any ${ago(row.activityAt, now)}`}
                </Text>
                <Button
                  key={`hide-${row.id}`}
                  plain
                  dimColor
                  label={isHidden ? 'unhide' : 'hide'}
                  onPress={() => void setHidden($, row.id, !isHidden)}
                />
              </Box>
              {(prs.length > 0 || issues.length > 0) && (
                <Box key={`refs-${row.id}`} flexDirection="row" flexWrap="wrap" columnGap={1} paddingLeft={4}>
                  {prs.length > 0 && <Text dimColor>PRs</Text>}
                  {refLabels(prs).map(({ ref, label }, i) => (
                    <Button key={`pr-${row.id}-${i}`} plain dimColor label={label} onPress={() => void openRef($, ref)} />
                  ))}
                  {issues.length > 0 && <Text dimColor>{prs.length > 0 ? '· issues' : 'issues'}</Text>}
                  {refLabels(issues).map(({ ref, label }, i) => (
                    <Button key={`issue-${row.id}-${i}`} plain dimColor label={label} onPress={() => void openRef($, ref)} />
                  ))}
                  {more > 0 && <Button key={`more-${row.id}`} plain dimColor label={`+${more} more`} onPress={toggle} />}
                  {canFold && <Button key={`more-${row.id}`} plain dimColor label="fewer" onPress={toggle} />}
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}
