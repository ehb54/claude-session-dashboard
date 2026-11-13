import { atom, read, update } from 'claude-code'
import type { EngineInterface, McpToolResult, Register } from 'claude-code'

import type { Row, SortKey, Status } from '../types'
import {
  CUTOFF_PRESETS,
  HUMAN_MARKER,
  ago,
  filterRows,
  lastHumanAt,
  lineTimestamp,
  mergeRows,
  ownRecords,
  parseCutoff,
  parseIndexRecord,
  parseListed,
  projectSlug,
  sortRows,
  touchAt,
  withinCutoff,
} from './data'
import type { IndexRecord, Listed } from './data'

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

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const rowsAtom = atom({ plugin: 'session-dashboard', key: 'rows' } as const, [] as Row[], {
  shape: 'rows-1',
})
const sortAtom = atom({ plugin: 'session-dashboard', key: 'sort' } as const, 'touch' as SortKey)
const cutoffAtom = atom({ plugin: 'session-dashboard', key: 'cutoff' } as const, '1d')
const archivedAtom = atom({ plugin: 'session-dashboard', key: 'archived' } as const, false)
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
const humanCache = new Map<string, Mark & { at: number | null }>()
let scanning: Promise<void> | null = null
let hasShell: boolean | null = null
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

async function shellWorks($: Engine): Promise<boolean> {
  if (hasShell === null) {
    try {
      hasShell = (await $.process.run(['sh', '-c', 'exit 0'], { timeoutMs: 5000 })).exitCode === 0
    } catch {
      hasShell = false
    }
  }

  return hasShell
}

/** The last prompt the person sent in one transcript file. */
async function findHuman($: Engine, path: string, size: number): Promise<number | null> {
  if (await shellWorks($)) {
    // Only the timestamps of the last marked line come back, however long it is.
    const script =
      'grep -F -- "$0" "$1" | tail -n 1 | grep -o \'"timestamp":"[^"]*"\' | tail -n 1'
    const run = await $.process.run(['sh', '-c', script, HUMAN_MARKER, path], {
      timeoutMs: 20_000,
    })
    if (run.exitCode === 0) return lineTimestamp(run.stdout)
  }
  if (size < READ_LIMIT) return lastHumanAt(await $.fs.read(path))
  throw new Error('transcript too large to read without a shell')
}

async function humanAtOf($: Engine, path: string, mark: Mark): Promise<number | null> {
  const hit = humanCache.get(path)
  if (same(hit, mark)) return hit!.at
  let at = hit?.at ?? null
  try {
    at = await findHuman($, path, mark.size)
  } catch {
    // Keep the last time known for this file.
  }
  humanCache.set(path, { size: mark.size, mtimeMs: mark.mtimeMs, at })

  return at
}

/** The person's last prompt per session, from the transcripts it wrote. */
async function scanHuman(
  $: Engine,
  projects: string,
  index: ReadonlyMap<string, IndexRecord>,
  ids: Iterable<string>,
): Promise<Map<string, number | null>> {
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
  const out = new Map<string, number | null>()
  for (let i = 0; i < jobs.length; i += BATCH) {
    const batch = jobs.slice(i, i + BATCH)
    const times = await Promise.all(batch.map(job => humanAtOf($, job.path, job.mark)))
    batch.forEach((job, k) => {
      const at = times[k] ?? null
      const prev = out.get(job.id) ?? null
      out.set(job.id, prev === null || (at !== null && at > prev) ? at : prev)
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
    const humanAt = await scanHuman($, where.projects, index, rows.map(row => row.id))
    rows.forEach(row => {
      row.humanAt = humanAt.get(row.id) ?? null
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

/** Opens the session in the app through its deep link, as the OS routes it. */
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

/** Sets the cutoff from a preset or what the person typed. */
async function setCutoff($: Engine, text: string): Promise<void> {
  const cut = parseCutoff(text)
  if (cut === null) {
    await $.ui.toast(`"${text.trim()}" is not a cutoff: try 30m, 6h, 2d, 1w, 3M or all (m minutes, M months).`)
    return
  }
  await update($, cutoffAtom, () => cut.spec)
}

const isOpen = async ($: Engine): Promise<boolean> =>
  (await $.ui.panes()).some(pane => pane.id === PANE)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'session-dashboard',
      description: 'Open a pane of all sessions, across groups, by your last touch',
    })
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
    const now = await $.clock.now()
    const shown = sortRows(withinCutoff(filterRows(rows, filter), sort, cut.ms, now), sort)
    const age = status.updatedAt === null ? null : ago(status.updatedAt, now)
    const head =
      age === null
        ? 'Scanning sessions…'
        : `${shown.length} of ${rows.length} sessions${cut.ms === null ? '' : ` within ${cut.label}`} · scanned ${age === 'now' ? 'just now' : `${age} ago`} · ● running`

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Button
            key="sort"
            label={sort === 'touch' ? 'Sort: your last touch' : 'Sort: last activity'}
            onPress={() => void update($, sortAtom, now => (now === 'touch' ? 'activity' : 'touch'))}
          />
          <Button
            key="archived"
            label={archived ? 'Hide archived' : 'Show archived'}
            onPress={() => void update($, archivedAtom, now => !now).then(() => refresh($))}
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
          placeholder="Filter by title or group"
          value={filter}
          onInput={value => void update($, filterAtom, () => value)}
          onSubmit={value => void update($, filterAtom, () => value)}
        />
        <Text dimColor>{head}</Text>
        {status.poppedOut === false && (
          <Text dimColor>Opening a session first moves this list into its own window, so it stays in view.</Text>
        )}
        {status.error !== null && <Text color="warning">{status.error}</Text>}
        {shown.map(row => (
          <Box key={`row-${row.id}`} flexDirection="column">
            <Button key={row.id} plain onPress={() => void openSession($, row)}>
              {`${row.isRunning ? '● ' : '  '}${row.title}${row.isSelf ? ' (this session)' : ''}${row.isArchived ? ' (archived)' : ''}`}
            </Button>
            <Text dimColor wrap="truncate-end">
              {`    ${row.group ?? 'no group'} · you ${ago(touchAt(row), now)} · any ${ago(row.activityAt, now)}`}
            </Text>
          </Box>
        ))}
      </Box>
    )
  })
}
