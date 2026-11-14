/** A GitHub pull request or issue a session worked on. */
export type Ref = {
  /** `owner/name`. */
  repo: string
  number: number
  url: string
  /** Pull requests: `open`, `merged` or `closed`, as the app last saw it. Issues: null. */
  state: string | null
  /** Issues: how many times the session's transcript links it. Pull requests: 0. */
  mentions: number
}

/** One session as the dashboard lists it. Times are epoch milliseconds. */
export type Row = {
  /** The desktop app's session id (`local_...`). */
  id: string
  title: string
  /** The sidebar group's name, or null when ungrouped or unknown. */
  group: string | null
  /** The app's own deep link to the session, or null when the app gave none. */
  link: string | null
  isRunning: boolean
  isArchived: boolean
  /** The session this dashboard runs in. */
  isSelf: boolean
  /** Last activity of any kind, as the app records it. */
  activityAt: number | null
  /** When the person last opened (focused) the session. */
  focusedAt: number | null
  /** When the person last sent the session a prompt of their own. */
  humanAt: number | null
  /** Pull requests the app linked to the session, open ones first. */
  prs: Ref[]
  /** Issues the session's transcript links, most linked first. */
  issues: Ref[]
}

export type SortKey = 'touch' | 'activity'

export type Status = {
  /** When the last scan finished. */
  updatedAt: number | null
  /** What went wrong on the last scan, if anything. */
  error: string | null
  /** Whether this session shows in a pop-out window of its own; null when unknown. */
  poppedOut: boolean | null
}

declare module 'claude-code' {
  interface PluginState {
    'session-dashboard': {
      rows: Shaped<Row[]>
      sort: SortKey
      /** How far back the sorted time may be: `1d`, `45m`, `2M`, ... or `all`. */
      cutoff: string
      archived: boolean
      /** Ids of the sessions the person hid from the list. */
      hidden: string[]
      /** Whether hidden sessions show anyway, marked. */
      showHidden: boolean
      /** Ids of the sessions the person keeps in the list whatever the cutoff. */
      kept: string[]
      /** Ids of the rows showing all their pull requests and issues. */
      expanded: string[]
      filter: string
      status: Shaped<Status>
    }
  }
}
