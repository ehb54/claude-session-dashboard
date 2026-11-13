import { expect, mock, test } from 'claude-code/testing'

import { ago, lastHumanAt, linkPrefix, parseCutoff, projectSlug } from '../hooks/data'

const NOW = Date.parse('2026-11-13T12:00:00Z')
const MIN = 60_000
const DAY = 24 * 60 * MIN

const HOME = '/h'
const INDEX = `${HOME}/Library/Application Support/Claude/claude-code-sessions`
const ORG = `${INDEX}/acct/org`
const PROJECT = `${HOME}/.claude/projects/-w`
const LINK = 'claude://claude.ai/epitaxy/'

const iso = (ms: number) => new Date(ms).toISOString()

// "Alpha" was prompted by the person a minute ago but has been quiet since;
// "Beta" was last touched a day ago but Claude worked in it just now;
// "Gamma" is old, ungrouped, and no lookup of the app returns it.
const transcriptA = [
  JSON.stringify({ type: 'user', timestamp: iso(NOW - 90 * MIN), origin: { kind: 'human' } }),
  JSON.stringify({ type: 'user', timestamp: iso(NOW - 1 * MIN), origin: { kind: 'human' } }),
  JSON.stringify({ type: 'assistant', timestamp: iso(NOW - 30 * 1000) }),
].join('\n')
const transcriptB = [
  JSON.stringify({ type: 'user', timestamp: iso(NOW - 20 * 60 * MIN), origin: { kind: 'human' } }),
  JSON.stringify({
    type: 'attachment',
    timestamp: iso(NOW - 2 * MIN),
    attachment: { origin: { kind: 'task-notification' } },
  }),
].join('\n')

const record = (id: string, cli: string, focused: number, active: number, title?: string) =>
  JSON.stringify({
    sessionId: id,
    cliSessionId: cli,
    cwd: '/w',
    title,
    lastFocusedAt: focused,
    lastActivityAt: active,
  })

const files: Record<string, string> = {
  [`${ORG}/local_a.json`]: record('local_a', 'cli-a', NOW - 50 * MIN, NOW - 40 * MIN),
  [`${ORG}/local_b.json`]: record('local_b', 'cli-b', NOW - 25 * 60 * MIN, NOW - 1 * MIN),
  [`${ORG}/local_c.json`]: record('local_c', 'cli-c', NOW - 5 * DAY, NOW - 6 * DAY, 'Gamma task'),
  [`${PROJECT}/cli-a.jsonl`]: transcriptA,
  [`${PROJECT}/cli-b.jsonl`]: transcriptB,
}

const dirs: Record<string, string[]> = {
  [INDEX]: ['acct/'],
  [`${INDEX}/acct`]: ['org/'],
  [ORG]: ['local_a.json', 'local_b.json', 'local_c.json'],
  [PROJECT]: ['cli-a.jsonl', 'cli-b.jsonl'],
}

const alpha = {
  sessionId: 'local_a',
  title: 'Alpha task',
  isArchived: false,
  isRunning: false,
  lastActivityAt: iso(NOW - 40 * MIN),
  group: { id: 'g1', name: 'research' },
  link: `${LINK}local_a`,
}
const beta = {
  sessionId: 'local_b',
  title: 'Beta task',
  isArchived: false,
  isRunning: true,
  lastActivityAt: iso(NOW - 1 * MIN),
  group: { id: 'g2', name: 'servers' },
  link: `${LINK}local_b`,
}
const self = {
  sessionId: 'local_self',
  title: 'Dashboard host',
  isArchived: false,
  isRunning: true,
  lastActivityAt: iso(NOW - 10 * MIN),
  group: null,
  link: `${LINK}local_self`,
}
const groups = [
  { id: 'g1', name: 'research', session_count: 1, order: 0 },
  { id: 'g2', name: 'servers', session_count: 1, order: 1 },
  { id: 'g3', name: 'empty', session_count: 0, order: 2 },
]

const PANE = {
  plugin: 'session-dashboard',
  component: 'Pane',
  requestId: 'session-dashboard',
  props: {
    title: 'Sessions',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const json = (value: unknown) => ({
  value: { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false },
})

const fakeFiles = (on: Parameters<Parameters<typeof test>[1]>[1]) => {
  on('fs.exists', (_, e) => ({ value: e.path === INDEX || e.path === '/usr/bin/open' }))
  on('fs.list', (_, e) => {
    const names = dirs[e.path]
    if (names === undefined) throw new Error(`no such folder: ${e.path}`)

    return {
      value: names.map(name => {
        const clean = name.replace(/\/$/, '')

        return {
          name: clean,
          kind: name.endsWith('/') ? 'dir' : 'file',
          size: (files[`${e.path}/${clean}`] ?? '').length,
          mtimeMs: 1,
          isLink: false,
        }
      }),
    }
  })
  on('fs.read', (_, e) => {
    const body = files[e.path]
    if (body === undefined) throw new Error(`no such file: ${e.path}`)

    return { value: body }
  })
}

test('every session shows, sorted by last touch or activity, filtered, and opens on press', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME })
  fakeFiles(on)
  const opened: string[][] = []
  const asked: unknown[] = []
  const steps: string[] = []
  let poppedOut = false
  on('mcp.call', (_, e) => {
    asked.push({ server: e.server, tool: e.tool, args: e.args })
    if (e.server === 'ccd_sidebar' && e.tool === 'list_groups') return json(groups)
    if (e.server === 'ccd_window' && e.tool === 'get_window_layout') {
      return json({
        this_session: { session_id: 'local_self' },
        popout_windows: { sessions: poppedOut ? [{ session_id: 'local_self' }] : [] },
      })
    }
    if (e.server === 'ccd_window' && e.tool === 'open_session_in') {
      steps.push(`pop ${String(e.args.session_id)} ${String(e.args.target)}`)
      poppedOut = true

      return json({ ok: true })
    }
    if (e.server !== 'ccd_session_mgmt') return { value: { content: [], isError: true } }
    if (e.tool === 'get_session') return json(self)
    if (e.tool === 'list_sessions') {
      if (e.args.group === 'g1') return json([alpha])
      if (e.args.group === 'g2') return json([beta])
      if (e.args.group === undefined) return json([{ ...beta, group: null }])
    }

    return { value: { content: [], isError: true } }
  })
  on('process.run', (_, e) => {
    // No shell here, so transcripts are read whole; the opener is recorded.
    if (e.argv[0] === 'sh') return { value: { exitCode: 127, stdout: '', stderr: 'no sh' } }
    opened.push([...e.argv])
    steps.push(`open ${e.argv[e.argv.length - 1]}`)

    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('ui.panes', () => ({ value: [] }))
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text?: unknown }).text ?? JSON.stringify(e)))

    return { value: undefined }
  })

  for (const surface of ['desktop', 'terminal'] as const) {
    poppedOut = false
    steps.length = 0
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ key: 'popout' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /moves this list into its own window/ })).toBeDefined()

    const order = async () =>
      (await ui.findAll({ type: 'Button' }))
        .map(one => one.key)
        .filter(key => key?.startsWith('local_'))

    // Within 1 day (the default), by last touch: Alpha 1m, Beta 20h.
    expect(await order()).toEqual(['local_a', 'local_b'])
    expect(await ui.find({ type: 'Text', text: /2 of 4 sessions within 1 day · scanned just now/ })).toBeDefined()
    expect((await ui.find({ key: 'cutoff-1d' }))?.props.variant).toBe('primary')

    // All time: Gamma 5d too; this session was never opened or prompted here.
    await ui.press({ key: 'cutoff-all' })
    expect(await order()).toEqual(['local_a', 'local_b', 'local_c', 'local_self'])
    expect((await ui.find({ key: 'local_a' }))?.text).toMatch(/Alpha task/)
    expect((await ui.find({ key: 'local_b' }))?.text).toMatch(/● Beta task/)
    expect((await ui.find({ key: 'local_c' }))?.text).toMatch(/Gamma task/)
    expect((await ui.find({ key: 'local_self' }))?.text).toMatch(/\(this session\)/)
    expect(await ui.find({ type: 'Text', text: /research · you 1m · any 40m/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /servers · you 20h · any 1m/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /no group · you 5d · any 6d/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /4 of 4 sessions · scanned just now/ })).toBeDefined()

    // By last activity: Beta 1m, self 10m, Alpha 40m, Gamma 6d.
    await ui.press({ key: 'sort' })
    expect(await order()).toEqual(['local_b', 'local_self', 'local_a', 'local_c'])
    await ui.press({ key: 'cutoff-1d' })
    expect(await order()).toEqual(['local_b', 'local_self', 'local_a'])
    // Typed cutoffs: m is minutes, M is months.
    await ui.input({ key: 'cutoff', text: '15m' })
    expect(await order()).toEqual(['local_b', 'local_self'])
    expect(await ui.find({ type: 'Text', text: /2 of 4 sessions within 15 minutes/ })).toBeDefined()
    await ui.input({ key: 'cutoff', text: '1M' })
    expect(await order()).toEqual(['local_b', 'local_self', 'local_a', 'local_c'])
    expect(await ui.find({ type: 'Text', text: /within 1 month/ })).toBeDefined()
    toasts.length = 0
    await ui.input({ key: 'cutoff', text: 'soon' })
    expect(toasts.join(' ')).toMatch(/"soon" is not a cutoff/)
    expect(await ui.find({ type: 'Text', text: /within 1 month/ })).toBeDefined()
    await ui.press({ key: 'sort' })
    await ui.press({ key: 'cutoff-all' })

    await ui.input({ key: 'filter', text: 'serv', kind: 'change' })
    expect(await order()).toEqual(['local_b'])
    await ui.input({ key: 'filter', text: '', kind: 'change' })

    opened.length = 0
    await ui.press({ key: 'local_a' })
    // Gamma's link is built from the shape of the links the app gave.
    await ui.press({ key: 'local_c' })
    expect(opened).toEqual([
      ['/usr/bin/open', `${LINK}local_a`],
      ['/usr/bin/open', `${LINK}local_c`],
    ])
    // The list moves to its own window before the first session opens, and only once.
    expect(steps).toEqual([
      'pop self window',
      `open ${LINK}local_a`,
      `open ${LINK}local_c`,
    ])
    expect(await ui.find({ key: 'popout' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /moves this list into its own window/ })).toBeUndefined()
    // Leave the default for the next surface: state outlives a mount.
    await ui.press({ key: 'cutoff-1d' })
    await ui.unmount()
  }

  // Each answer stays small: the recent list is capped, groups go one by one,
  // and an empty group is not asked.
  const lists = asked.filter(one => (one as { tool: string }).tool === 'list_sessions')
  expect(lists).toContainEqual({ server: 'ccd_session_mgmt', tool: 'list_sessions', args: { limit: 30, include_archived: false } })
  expect(lists).toContainEqual({
    server: 'ccd_session_mgmt',
    tool: 'list_sessions',
    args: { group: 'g1', limit: 11, include_archived: false },
  })
  expect(lists.some(one => (one as { args: { group?: string } }).args.group === 'g3')).toBe(false)
})

test('without the app lookups the index still lists every session, and says so', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME })
  fakeFiles(on)
  const toasts: string[] = []
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: 'Error: too large' }], isError: false } }))
  on('process.run', () => ({ value: { exitCode: 127, stdout: '', stderr: '' } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text?: unknown }).text ?? JSON.stringify(e)))

    return { value: undefined }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ type: 'Text', text: /lookups failed/ }))?.text).toMatch(/non-JSON: Error: too large/)
  expect(await ui.find({ type: 'Text', text: /2 of 3 sessions within 1 day/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /no group · you 1m · any 40m/ })).toBeDefined()
  await ui.press({ key: 'local_a' })
  expect(toasts.join(' ')).toMatch(/open it from the sidebar/)
  await ui.unmount()
})

test('helpers', async () => {
  expect(projectSlug('/Users/x/my repo.v2')).toBe('-Users-x-my-repo-v2')
  expect(lastHumanAt(transcriptA)).toBe(NOW - 1 * MIN)
  expect(lastHumanAt(transcriptB)).toBe(NOW - 20 * 60 * MIN)
  expect(lastHumanAt('')).toBe(null)
  expect(linkPrefix([{ id: 'local_x', title: '', group: null, link: `${LINK}local_x`, isRunning: false, isArchived: false, activityAt: null }])).toBe(LINK)
  expect(linkPrefix([])).toBe(null)
  expect(parseCutoff('1m')).toEqual({ spec: '1m', ms: MIN, label: '1 minute' })
  expect(parseCutoff('1M')).toEqual({ spec: '1M', ms: 30 * DAY, label: '1 month' })
  expect(parseCutoff(' 1.5H ')).toEqual({ spec: '1.5h', ms: 90 * MIN, label: '1.5 hours' })
  expect(parseCutoff('2D')?.spec).toBe('2d')
  expect(parseCutoff('3w')?.ms).toBe(21 * DAY)
  expect(parseCutoff('1y')?.label).toBe('1 year')
  expect(parseCutoff('ALL')).toEqual({ spec: 'all', ms: null, label: 'all time' })
  expect(parseCutoff('')?.spec).toBe('all')
  expect(parseCutoff('0d')).toBe(null)
  expect(parseCutoff('d')).toBe(null)
  expect(parseCutoff('5 days')).toBe(null)
  expect(ago(null, NOW)).toBe('—')
  expect(ago(NOW - 5 * 1000, NOW)).toBe('now')
  expect(ago(NOW - 3 * 60 * MIN, NOW)).toBe('3h')
  expect(ago(NOW - 3 * DAY, NOW)).toBe('3d')
})

/** Answers every app lookup with an empty list: rows then come from the index alone. */
const quietApp = (on: Parameters<Parameters<typeof test>[1]>[1]) => {
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: '[]' }], isError: false } }))
  on('process.run', () => ({ value: { exitCode: 127, stdout: '', stderr: '' } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }))
}

/** A store in memory the test can read: what the mod saved across sessions. */
const fakeStore = (on: Parameters<Parameters<typeof test>[1]>[1], saved: Record<string, unknown>) => {
  on('store.get', (_, e) => ({ value: saved[e.key] }))
  on('store.set', (_, e) => {
    saved[e.key] = e.value

    return { value: undefined }
  })
}

const startSession = async ($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1]) => {
  on('command.register', () => ({ value: { command: 'session-dashboard' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
}

test('the sort, cutoff and hidden sessions chosen last come back in a new session', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME })
  fakeFiles(on)
  quietApp(on)
  const saved: Record<string, unknown> = {
    prefs: { sort: 'activity', cutoff: '3d' },
    hidden: ['local_c'],
  }
  fakeStore(on, saved)
  await startSession($, on)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ key: 'sort' }))?.props.label).toBe('Sort: last activity')
  expect((await ui.find({ key: 'cutoff' }))?.props.value).toBe('3d')
  expect(await ui.find({ type: 'Text', text: /2 of 3 sessions within 3 days · 1 hidden/ })).toBeDefined()

  // Each change is saved at once.
  await ui.press({ key: 'sort' })
  expect(saved.prefs).toEqual({ sort: 'touch', cutoff: '3d' })
  await ui.press({ key: 'cutoff-1w' })
  expect(saved.prefs).toEqual({ sort: 'touch', cutoff: '1w' })
  await ui.input({ key: 'cutoff', text: '90m' })
  expect(saved.prefs).toEqual({ sort: 'touch', cutoff: '90m' })
  await ui.unmount()
})

test('saved choices that make no sense are ignored', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME })
  fakeFiles(on)
  quietApp(on)
  fakeStore(on, { prefs: { sort: 'sideways', cutoff: 'soon' }, hidden: 'local_a' })
  await startSession($, on)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ key: 'sort' }))?.props.label).toBe('Sort: your last touch')
  expect((await ui.find({ key: 'cutoff-1d' }))?.props.variant).toBe('primary')
  expect((await ui.find({ key: 'show-hidden' }))?.props.label).toBe('Show hidden (0)')
  await ui.unmount()
})

test('a session can be hidden, shown again under Show hidden, and unhidden', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME })
  fakeFiles(on)
  quietApp(on)
  const saved: Record<string, unknown> = {}
  fakeStore(on, saved)

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'cutoff-all' })
    const order = async () =>
      (await ui.findAll({ type: 'Button' }))
        .map(one => one.key)
        .filter(key => key?.startsWith('local_'))
    expect(await order()).toEqual(['local_a', 'local_b', 'local_c'])
    expect((await ui.find({ key: 'show-hidden' }))?.props.label).toBe('Show hidden (0)')

    await ui.press({ key: 'hide-local_b' })
    expect(await order()).toEqual(['local_a', 'local_c'])
    expect(saved.hidden).toEqual(['local_b'])
    expect((await ui.find({ key: 'show-hidden' }))?.props.label).toBe('Show hidden (1)')
    expect(await ui.find({ type: 'Text', text: /2 of 3 sessions · 1 hidden/ })).toBeDefined()

    await ui.press({ key: 'show-hidden' })
    expect(await order()).toEqual(['local_a', 'local_b', 'local_c'])
    expect((await ui.find({ key: 'local_b' }))?.text).toMatch(/\(hidden\)/)
    expect((await ui.find({ key: 'hide-local_b' }))?.props.label).toBe('unhide')
    expect((await ui.find({ key: 'show-hidden' }))?.props.label).toBe('Hide hidden')

    await ui.press({ key: 'hide-local_b' })
    expect(saved.hidden).toEqual([])
    await ui.press({ key: 'show-hidden' })
    expect(await order()).toEqual(['local_a', 'local_b', 'local_c'])
    await ui.press({ key: 'cutoff-1d' })
    await ui.unmount()
  }
})
