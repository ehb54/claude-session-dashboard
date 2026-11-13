// Pure helpers: parsing what the app and the transcripts hold, merging it
// into rows, sorting and formatting. Nothing here touches the engine.

import type { Row, SortKey } from '../types'

/** A transcript line holding this marker is a prompt the person sent. */
export const HUMAN_MARKER = '"origin":{"kind":"human"}'

const TIMESTAMP = /"timestamp":"([^"]+)"/g

/** What the app's own session index file says about one session. */
export type IndexRecord = {
  sessionId: string
  /** The index folder the record was found in (one per account). */
  dir: string
  /** The CLI transcript ids the session wrote to, newest last, no repeats. */
  cliIds: string[]
  cwd: string | null
  title: string | null
  focusedAt: number | null
  activityAt: number | null
  isArchived: boolean
}

/** One session as the app's session list reports it. */
export type Listed = {
  id: string
  title: string
  group: string | null
  link: string | null
  isRunning: boolean
  isArchived: boolean
  activityAt: number | null
}

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null

const asTime = (value: unknown): number | null => {
  if (typeof value === 'number') return asNumber(value)
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)

  return Number.isNaN(ms) ? null : ms
}

/** Reads one `local_*.json` file of the app's session index. */
export function parseIndexRecord(text: string, dir: string): IndexRecord | null {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  const sessionId = asString(data?.sessionId)
  if (sessionId === null) return null
  const cliIds = [data.cliSessionId, data.lastAssistantCliSessionId]
    .map(asString)
    .filter((id): id is string => id !== null)

  return {
    sessionId,
    dir,
    cliIds: [...new Set(cliIds)],
    cwd: asString(data.cwd),
    title: asString(data.title),
    focusedAt: asNumber(data.lastFocusedAt),
    activityAt: asNumber(data.lastActivityAt),
    isArchived: data.isArchived === true,
  }
}

function toListed(item: Record<string, unknown>): Listed | null {
  const id = asString(item?.sessionId)
  if (id === null) return null
  const group = item.group as { name?: unknown } | null | undefined

  return {
    id,
    title: asString(item.title) ?? id,
    group: asString(group?.name),
    link: asString(item.link),
    isRunning: item.isRunning === true,
    isArchived: item.isArchived === true,
    activityAt: asTime(item.lastActivityAt),
  }
}

/**
 * Reads the app's `list_sessions` answer (an array) or its `get_session`
 * answer (one object), already parsed from JSON.
 */
export function parseListed(data: unknown): Listed[] {
  const items = Array.isArray(data) ? data : [data]

  return items
    .map(item => toListed(item as Record<string, unknown>))
    .filter((one): one is Listed => one !== null)
}

/**
 * The part of the app's session links before the session id, learned from a
 * link the app gave, so a session no lookup returned can still be opened.
 */
export function linkPrefix(listed: Iterable<Listed>): string | null {
  for (const one of listed) {
    if (one.link !== null && one.link.endsWith(one.id)) {
      return one.link.slice(0, one.link.length - one.id.length)
    }
  }

  return null
}

/** The folder name Claude Code keeps a working directory's transcripts in. */
export const projectSlug = (cwd: string): string =>
  cwd.replace(/[^a-zA-Z0-9]/g, '-')

/** The time of the last structural timestamp on a line, or null. */
export function lineTimestamp(line: string): number | null {
  let last: number | null = null
  for (const match of line.matchAll(TIMESTAMP)) {
    const ms = Date.parse(match[1] ?? '')
    if (!Number.isNaN(ms)) last = ms
  }

  return last
}

/** The time of the last prompt the person sent, from a whole transcript. */
export function lastHumanAt(transcript: string): number | null {
  let end = transcript.length
  while (end > 0) {
    const start = transcript.lastIndexOf('\n', end - 1) + 1
    const line = transcript.slice(start, end)
    if (line.includes(HUMAN_MARKER)) {
      const at = lineTimestamp(line)
      if (at !== null) return at
    }
    end = start - 1
  }

  return null
}

const latest = (...times: (number | null)[]): number | null => {
  const known = times.filter((t): t is number => t !== null)

  return known.length === 0 ? null : Math.max(...known)
}

/** When the person last touched the session: opened it or prompted it. */
export const touchAt = (row: Row): number | null =>
  latest(row.focusedAt, row.humanAt)

/**
 * The index records to list: those in this session's own index folder when
 * the index holds this session (one folder per account), else all of them.
 */
export function ownRecords(
  index: ReadonlyMap<string, IndexRecord>,
  selfId: string | null,
): Map<string, IndexRecord> {
  const own = selfId === null ? undefined : index.get(selfId)?.dir

  return new Map([...index].filter(([, rec]) => own === undefined || rec.dir === own))
}

/**
 * Joins the app's index (every session) with what the app's lookups said
 * (groups, links, running) and the transcripts' prompt times.
 */
export function mergeRows(args: {
  index: ReadonlyMap<string, IndexRecord>
  listed: ReadonlyMap<string, Listed>
  selfId: string | null
  humanAt: ReadonlyMap<string, number | null>
  showArchived: boolean
}): Row[] {
  const { index, listed, selfId, humanAt, showArchived } = args
  const prefix = linkPrefix(listed.values())
  const ids = new Set([...index.keys(), ...listed.keys()])
  const rows: Row[] = []
  for (const id of ids) {
    const rec = index.get(id)
    const item = listed.get(id)
    const isArchived = item?.isArchived ?? rec?.isArchived ?? false
    if (isArchived && !showArchived) continue
    rows.push({
      id,
      title: item?.title ?? rec?.title ?? id,
      group: item?.group ?? null,
      link: item?.link ?? (prefix === null ? null : `${prefix}${id}`),
      isRunning: item?.isRunning ?? false,
      isArchived,
      isSelf: id === selfId,
      activityAt: latest(item?.activityAt ?? null, rec?.activityAt ?? null),
      focusedAt: rec?.focusedAt ?? null,
      humanAt: humanAt.get(id) ?? null,
    })
  }

  return rows
}

/** The time a row is sorted and cut off by. */
export const timeFor = (row: Row, key: SortKey): number | null =>
  key === 'touch' ? touchAt(row) : row.activityAt

const MINUTE = 60_000
const UNITS: Record<string, { ms: number; name: string }> = {
  m: { ms: MINUTE, name: 'minute' },
  h: { ms: 60 * MINUTE, name: 'hour' },
  d: { ms: 24 * 60 * MINUTE, name: 'day' },
  w: { ms: 7 * 24 * 60 * MINUTE, name: 'week' },
  M: { ms: 30 * 24 * 60 * MINUTE, name: 'month' },
  y: { ms: 365 * 24 * 60 * MINUTE, name: 'year' },
}

/** The presets shown as buttons. */
export const CUTOFF_PRESETS = ['1d', '1w', '1M', 'all'] as const

/**
 * Reads a cutoff such as `1d`, `90m`, `1.5h` or `2M`: `m` minutes, `h` hours,
 * `d` days, `w` weeks, `M` months (30 days), `y` years; `h`, `d`, `w` and `y`
 * in either case, `m` and `M` as written. `all` (or empty) means no cutoff.
 * Answers the spelling kept, its length in ms (null for none) and its label,
 * or null when the text is not a cutoff.
 */
export function parseCutoff(
  text: string,
): { spec: string; ms: number | null; label: string } | null {
  const raw = text.trim()
  if (raw === '' || raw.toLowerCase() === 'all') return { spec: 'all', ms: null, label: 'all time' }
  const match = /^(\d+(?:\.\d+)?)\s*([mMhHdDwWyY])$/.exec(raw)
  if (match === null) return null
  const count = Number(match[1])
  const letter = match[2] ?? ''
  const unit = UNITS[letter === 'm' || letter === 'M' ? letter : letter.toLowerCase()]
  if (unit === undefined || !(count > 0)) return null

  return {
    spec: `${match[1]}${letter === 'm' || letter === 'M' ? letter : letter.toLowerCase()}`,
    ms: count * unit.ms,
    label: `${match[1]} ${unit.name}${count === 1 ? '' : 's'}`,
  }
}

/** Rows whose sorted time falls within the cutoff; a row with no time only under `all`. */
export function withinCutoff(
  rows: readonly Row[],
  key: SortKey,
  cutoffMs: number | null,
  now: number,
): Row[] {
  if (cutoffMs === null) return [...rows]

  return rows.filter(row => {
    const at = timeFor(row, key)

    return at !== null && at >= now - cutoffMs
  })
}

/** Newest first by the chosen time; rows with no time last, by title. */
export function sortRows(rows: readonly Row[], key: SortKey): Row[] {
  const time = (row: Row) => timeFor(row, key)

  return [...rows].sort((a, b) => {
    const ta = time(a)
    const tb = time(b)
    if (ta !== tb) {
      if (ta === null) return 1
      if (tb === null) return -1

      return tb - ta
    }

    return a.title.localeCompare(b.title)
  })
}

/** Rows whose title or group holds every word of the filter, any case. */
export function filterRows(rows: readonly Row[], filter: string): Row[] {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...rows]

  return rows.filter(row => {
    const hay = `${row.title} ${row.group ?? ''}`.toLowerCase()

    return words.every(word => hay.includes(word))
  })
}

/** A short age: `now`, `42s`, `5m`, `3h`, `2d`, `5w`. */
export function ago(at: number | null, now: number): string {
  if (at === null) return '—'
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 10) return 'now'
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  const d = Math.round(h / 24)
  if (d < 14) return `${d}d`

  return `${Math.round(d / 7)}w`
}
