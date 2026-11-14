import { expect, mock, test } from 'claude-code/testing'

import {
  HUMAN_MARKER,
  ago,
  countIssues,
  issueRefs,
  lastHumanAt,
  linkPrefix,
  parseCutoff,
  parsePrs,
  parseScanOutput,
  projectSlug,
  refLabels,
} from '../hooks/data'

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
const GH = 'https://github.com/o'
const say = (at: number, text: string) =>
  JSON.stringify({ type: 'assistant', timestamp: iso(at), message: { content: [{ type: 'text', text }] } })
// Alpha links four issues: tickets#12 twice (once to a comment), the rest once.
const transcriptA = [
  JSON.stringify({ type: 'user', timestamp: iso(NOW - 90 * MIN), origin: { kind: 'human' } }),
  say(NOW - 80 * MIN, `Filed ${GH}/tickets/issues/12 and ${GH}/tickets/issues/15.`),
  say(NOW - 70 * MIN, `See ${GH}/tickets/issues/12#issuecomment-1, ${GH}/tickets/issues/20 and ${GH}/app/issues/4.`),
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

const record = (
  id: string,
  cli: string,
  focused: number,
  active: number,
  title?: string,
  extra: Record<string, unknown> = {},
) =>
  JSON.stringify({
    sessionId: id,
    cliSessionId: cli,
    cwd: '/w',
    title,
    lastFocusedAt: focused,
    lastActivityAt: active,
    ...extra,
  })

// Alpha has two pull requests (the open one shows first) and one the app
// could not have opened, which is dropped; Gamma has one in the older field.
const alphaPrs = {
  prs: [
    { prNumber: 7, url: `${GH}/app/pull/7`, repo: 'o/app', state: 'MERGED', branch: 'x' },
    { prNumber: 9, url: `${GH}/app/pull/9`, repo: 'o/app', state: 'OPEN', branch: 'y' },
    { prNumber: 5, url: '-a Calculator', repo: 'o/app', state: 'OPEN' },
  ],
}
const gammaPr = { prNumber: 3, prUrl: `${GH}/lib/pull/3`, prRepository: 'o/lib', prState: 'CLOSED' }

const files: Record<string, string> = {
  [`${ORG}/local_a.json`]: record('local_a', 'cli-a', NOW - 50 * MIN, NOW - 40 * MIN, undefined, alphaPrs),
  [`${ORG}/local_b.json`]: record('local_b', 'cli-b', NOW - 25 * 60 * MIN, NOW - 1 * MIN),
  [`${ORG}/local_c.json`]: record('local_c', 'cli-c', NOW - 5 * DAY, NOW - 6 * DAY, 'Gamma task', gammaPr),
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
    // No perl or shell here, so transcripts are read whole; the opener is recorded.
    if (e.argv[0] === 'sh' || e.argv[0] === 'perl') {
      return { value: { exitCode: 127, stdout: '', stderr: 'not here' } }
    }
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
    // Pull requests from the index, issues from the transcript read whole.
    expect((await ui.find({ key: 'pr-local_a-0' }))?.props.label).toBe('app#9 open')
    expect((await ui.find({ key: 'issue-local_a-0' }))?.props.label).toBe('tickets#12')
    expect((await ui.find({ key: 'pr-local_c-0' }))?.props.label).toBe('lib#3 closed')
    expect(await ui.find({ key: 'refs-local_b' })).toBeUndefined()

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
    // The filter matches pull requests and issues too, folded ones included.
    await ui.input({ key: 'filter', text: 'app#4', kind: 'change' })
    expect(await order()).toEqual(['local_a'])
    await ui.input({ key: 'filter', text: 'lib#3', kind: 'change' })
    expect(await order()).toEqual(['local_c'])
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

  const prs = parsePrs(alphaPrs)
  expect(prs.map(pr => [pr.repo, pr.number, pr.state])).toEqual([
    ['o/app', 9, 'open'],
    ['o/app', 7, 'merged'],
  ])
  expect(parsePrs(gammaPr)).toEqual([
    { repo: 'o/lib', number: 3, url: `${GH}/lib/pull/3`, state: 'closed', mentions: 0 },
  ])
  // A repo and number can come from the link alone; the same link twice is one.
  expect(parsePrs({ prs: [{ url: `${GH}/x/pull/2` }, { url: `${GH}/x/pull/2` }], prUrl: 7 })).toEqual([
    { repo: 'o/x', number: 2, url: `${GH}/x/pull/2`, state: null, mentions: 0 },
  ])
  expect(parsePrs({ prs: 'nope' })).toEqual([])

  const counts = countIssues(transcriptA)
  expect([...counts]).toEqual([
    [`${GH}/tickets/issues/12`, 2],
    [`${GH}/tickets/issues/15`, 1],
    [`${GH}/tickets/issues/20`, 1],
    [`${GH}/app/issues/4`, 1],
  ])
  const issues = issueRefs(counts)
  expect(issues.map(one => `${one.repo}#${one.number}x${one.mentions}`)).toEqual([
    'o/tickets#12x2',
    'o/tickets#20x1',
    'o/tickets#15x1',
    'o/app#4x1',
  ])
  // Case is one issue; a link that is not an issue is not counted.
  expect(issueRefs(new Map([[`${GH}/T/issues/1`, 1], [`${GH}/t/issues/1`, 2], ['https://x/y', 5]])))
    .toEqual([{ repo: 'o/T', number: 1, url: `${GH}/T/issues/1`, state: null, mentions: 3 }])
  // One repo's refs stay together and only the first is named.
  expect(refLabels([issues[0]!, issues[3]!, issues[1]!]).map(one => one.label)).toEqual(['tickets#12', '#20', 'app#4'])
  expect(refLabels(prs).map(one => one.label)).toEqual(['app#9 open', '#7 merged'])

  const out = parseScanOutput(`   2 ${GH}/a/issues/3\n"timestamp":"${iso(NOW)}"\n1 ${GH}/a/issues/4\n`)
  expect(out.at).toBe(NOW)
  expect([...out.issues]).toEqual([[`${GH}/a/issues/3`, 2], [`${GH}/a/issues/4`, 1]])
  expect(parseScanOutput('')).toEqual({ at: null, issues: new Map() })
})

/** Answers the lookups of the first test's app: groups, the window, the sessions. */
const app = (on: Parameters<Parameters<typeof test>[1]>[1]) => {
  on('mcp.call', (_, e) => {
    if (e.server === 'ccd_sidebar' && e.tool === 'list_groups') return json(groups)
    if (e.server === 'ccd_window' && e.tool === 'get_window_layout') {
      return json({ this_session: { session_id: 'local_self' }, popout_windows: { sessions: [] } })
    }
    if (e.tool === 'get_session') return json(self)
    if (e.tool === 'list_sessions' && e.args.group === 'g1') return json([alpha])
    if (e.tool === 'list_sessions' && e.args.group === 'g2') return json([beta])
    if (e.tool === 'list_sessions') return json([])

    return { value: { content: [], isError: true } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }))
}

test('perl scans the transcripts; pull requests and issues fold, unfold and open in the browser', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME })
  fakeFiles(on)
  app(on)
  const ran: string[][] = []
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    if (e.argv[0] === 'perl' && e.argv[2] === 'exit 0') return { value: { exitCode: 0, stdout: '', stderr: '' } }
    if (e.argv[0] === 'perl') {
      // perl -e <script> <marker> <path>: a prompt 3 minutes ago, unlike the file read whole.
      expect(e.argv[3]).toBe(HUMAN_MARKER)
      const stdout = e.argv[4] === `${PROJECT}/cli-a.jsonl`
        ? [`"timestamp":"${iso(NOW - 3 * MIN)}"`, ...[...countIssues(transcriptA)].map(([url, n]) => `${n} ${url}`)].join('\n')
        : ''

      return { value: { exitCode: 0, stdout, stderr: '' } }
    }
    if (e.argv[0] === 'sh') return { value: { exitCode: 0, stdout: '', stderr: '' } }

    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: /research · you 3m · any 40m/ })).toBeDefined()
    expect(ran.some(argv => argv[0] === 'sh' && argv[1] === '-c' && argv.length > 3)).toBe(false)

    const labels = async (prefix: string) =>
      (await ui.findAll({ type: 'Button' }))
        .filter(one => one.key?.startsWith(prefix))
        .map(one => one.props.label)
    expect(await labels('pr-local_a-')).toEqual(['app#9 open', '#7 merged'])
    // Three issues until the row is unfolded; the fourth waits under "+1 more".
    expect(await labels('issue-local_a-')).toEqual(['tickets#12', '#20', '#15'])
    expect((await ui.find({ key: 'more-local_a' }))?.props.label).toBe('+1 more')
    await ui.press({ key: 'more-local_a' })
    expect(await labels('issue-local_a-')).toEqual(['tickets#12', '#20', '#15', 'app#4'])
    expect((await ui.find({ key: 'more-local_a' }))?.props.label).toBe('fewer')
    await ui.press({ key: 'more-local_a' })
    expect(await labels('issue-local_a-')).toEqual(['tickets#12', '#20', '#15'])

    // A press opens the link in the browser, with no pop-out first.
    ran.length = 0
    await ui.press({ key: 'issue-local_a-0' })
    await ui.press({ key: 'pr-local_a-1' })
    expect(ran).toEqual([
      ['/usr/bin/open', `${GH}/tickets/issues/12`],
      ['/usr/bin/open', `${GH}/app/pull/7`],
    ])
    await ui.unmount()
  }
})

test('without perl, grep through sh scans the transcripts', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME })
  fakeFiles(on)
  app(on)
  on('process.run', (_, e) => {
    if (e.argv[0] === 'perl') return { value: { exitCode: 127, stdout: '', stderr: 'no perl' } }
    if (e.argv[0] === 'sh' && e.argv[2] === 'exit 0') return { value: { exitCode: 0, stdout: '', stderr: '' } }
    if (e.argv[0] === 'sh' && e.argv[4] === `${PROJECT}/cli-a.jsonl`) {
      expect(e.argv[2]).toMatch(/grep -F -- \/issues\//)
      const stdout = `"timestamp":"${iso(NOW - 4 * MIN)}"\n   1 ${GH}/app/issues/4\n`

      return { value: { exitCode: 0, stdout, stderr: '' } }
    }

    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /research · you 4m · any 40m/ })).toBeDefined()
  expect((await ui.find({ key: 'issue-local_a-0' }))?.props.label).toBe('app#4')
  expect(await ui.find({ key: 'more-local_a' })).toBeUndefined()
  await ui.unmount()
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

test('the sort, cutoff and hidden and kept sessions chosen last come back in a new session', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME })
  fakeFiles(on)
  quietApp(on)
  const saved: Record<string, unknown> = {
    prefs: { sort: 'activity', cutoff: '3d' },
    hidden: ['local_c'],
    kept: ['local_a'],
  }
  fakeStore(on, saved)
  await startSession($, on)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ key: 'sort' }))?.props.label).toBe('Sort: last activity')
  expect((await ui.find({ key: 'cutoff' }))?.props.value).toBe('3d')
  expect(await ui.find({ type: 'Text', text: /2 of 3 sessions within 3 days · 1 kept · 1 hidden/ })).toBeDefined()
  expect((await ui.find({ key: 'local_a' }))?.text).toMatch(/\(kept\)/)
  expect((await ui.find({ key: 'keep-local_a' }))?.props.label).toBe('unkeep')

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
  fakeStore(on, { prefs: { sort: 'sideways', cutoff: 'soon' }, hidden: 'local_a', kept: 'local_c' })
  await startSession($, on)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ key: 'sort' }))?.props.label).toBe('Sort: your last touch')
  expect((await ui.find({ key: 'cutoff-1d' }))?.props.variant).toBe('primary')
  expect((await ui.find({ key: 'show-hidden' }))?.props.label).toBe('Show hidden (0)')
  expect(await ui.find({ key: 'local_c' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /2 of 3 sessions within 1 day · scanned/ })).toBeDefined()
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

test('a kept session stays past the cutoff until let go, and keeping and hiding exclude each other', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME })
  fakeFiles(on)
  quietApp(on)
  const saved: Record<string, unknown> = {}
  fakeStore(on, saved)

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })
    const order = async () =>
      (await ui.findAll({ type: 'Button' }))
        .map(one => one.key)
        .filter(key => key?.startsWith('local_'))
    // Gamma was last touched 5 days ago: outside a day.
    expect(await order()).toEqual(['local_a', 'local_b'])

    await ui.press({ key: 'cutoff-all' })
    expect((await ui.find({ key: 'keep-local_c' }))?.props.label).toBe('keep')
    await ui.press({ key: 'keep-local_c' })
    expect(saved.kept).toEqual(['local_c'])
    await ui.press({ key: 'cutoff-1d' })
    expect(await order()).toEqual(['local_a', 'local_b', 'local_c'])
    expect((await ui.find({ key: 'local_c' }))?.text).toMatch(/Gamma task \(kept\)/)
    expect((await ui.find({ key: 'keep-local_c' }))?.props.label).toBe('unkeep')
    expect(await ui.find({ type: 'Text', text: /3 of 3 sessions within 1 day · 1 kept · scanned/ })).toBeDefined()

    // It keeps its place in the sort, by either time.
    await ui.press({ key: 'sort' })
    expect(await order()).toEqual(['local_b', 'local_a', 'local_c'])
    await ui.press({ key: 'sort' })

    // The filter still narrows kept sessions (without the app, a title is its id).
    await ui.input({ key: 'filter', text: 'local_b' })
    expect(await order()).toEqual(['local_b'])
    await ui.input({ key: 'filter', text: 'gamma' })
    expect(await order()).toEqual(['local_c'])
    await ui.input({ key: 'filter', text: '' })

    // Hiding a kept session lets it go.
    await ui.press({ key: 'hide-local_c' })
    expect(saved.kept).toEqual([])
    expect(saved.hidden).toEqual(['local_c'])
    expect(await order()).toEqual(['local_a', 'local_b'])

    // Keeping a hidden session unhides it.
    await ui.press({ key: 'cutoff-all' })
    await ui.press({ key: 'show-hidden' })
    expect((await ui.find({ key: 'local_c' }))?.text).toMatch(/\(hidden\)/)
    await ui.press({ key: 'keep-local_c' })
    expect(saved.hidden).toEqual([])
    expect(saved.kept).toEqual(['local_c'])
    expect((await ui.find({ key: 'local_c' }))?.text).not.toMatch(/\(hidden\)/)
    await ui.press({ key: 'show-hidden' })
    await ui.press({ key: 'cutoff-1d' })
    expect(await order()).toEqual(['local_a', 'local_b', 'local_c'])

    // Only unkeep lets it go.
    await ui.press({ key: 'keep-local_c' })
    expect(saved.kept).toEqual([])
    expect(await order()).toEqual(['local_a', 'local_b'])
    await ui.unmount()
  }
})
