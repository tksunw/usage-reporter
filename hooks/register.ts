import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

// Claude Code makes the usage call with its own login, and this mod writes the answer to a file
// other tools read. The credential never reaches the mod.
const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage'
const FILE = '.claude/usage-reporter/usage.json'
const FLOOR_MS = 5 * 60_000 // the endpoint rate-limits; one call per five minutes across all sessions
const BACKOFF_MS = 10 * 60_000 // after a 429

/** One usage window. A weekly window with a `label` is scoped to that model family. */
type Window = { kind: 'session' | 'weekly'; label?: string; percent: number; resetsAt?: string; at: string }

/**
 * Usage credits, in major units of `currency` (dollars, not cents). `limit` is null when no limit
 * is set, and absent when one is set in a shape this mod does not know.
 */
type Credits = { enabled: boolean; used: number; limit?: number | null; currency?: string; at: string }

/** Cloud session credits, in dollars. `resetsAt` is as the endpoint gives it: a reset or an expiry, unverified. */
type CloudCredits = { used: number; limit?: number; currency: 'USD'; resetsAt?: string; at: string }

/** The one-time Claude Projects setup credit, in dollars. It expires at `expiresAt`; it does not reset. */
type SetupCredit = { used: number; limit?: number; currency: 'USD'; expiresAt?: string; at: string }

/**
 * One dollar credit or grant. `id` is the key it came from (`extra_usage`, or Anthropic's codename),
 * `label` a name for people, the codename itself when the mod does not know it. `limit` is null when
 * no limit is set. `ends` says whether `endsAt` is a reset or an expiry, and is absent when not known.
 */
type Grant = { id: string; label: string; used: number; limit?: number | null; currency: string; endsAt?: string; ends?: 'reset' | 'expiry'; at: string }

/** Codenamed grants the mod knows. Any other top-level object with a numeric `used_dollars` still becomes a grant. */
const KNOWN_GRANTS: Record<string, { label: string; ends?: Grant['ends'] }> = {
  iguana_necktie: { label: 'Cloud sessions' },
  harbor_lantern: { label: 'Project setup', ends: 'expiry' },
}

/** The weekly window's usage by surface (Claude Code, chat, ...). Rows pass through as given, unknown keys included. */
type Breakdown = { windowStartedAt?: string; rows: { key: string; label?: string; percent: number }[]; at: string }

/** The file, format version 1. `raw` is Anthropic's last response, unparsed; its shape is theirs. */
type Report = {
  version: 1
  at: string
  windows: Window[]
  credits?: Credits
  cloudSessionCredits?: CloudCredits
  projectSetupCredit?: SetupCredit
  grants?: Grant[]
  weeklyBreakdown?: Breakdown
  raw?: unknown
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await report($).catch(() => {})
    return started
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await report($, e.rateLimits).catch(() => {})
    return next(e)
  })
}

async function report($: EngineInterface, rateLimits?: readonly SessionRateLimit[]) {
  const home = await $.env.get('HOME')
  if (!home) return
  const path = `${home}/${FILE}`
  const now = await $.clock.now()
  const at = new Date(now).toISOString()
  const write = (rest: Omit<Report, 'version' | 'at'>) => $.fs.write(path, JSON.stringify({ version: 1, at, ...rest } satisfies Report))

  if (now >= Number((await $.store.get('nextFetchAt')) ?? 0)) {
    // Claim the slot before the call so a second session starting now skips it.
    await $.store.set('nextFetchAt', now + FLOOR_MS)
    try {
      const auth = await $.session.authorize()
      if (auth?.kind === 'bearer') {
        const res = await $.http.fetch(ENDPOINT, { headers: { 'anthropic-beta': 'oauth-2025-04-20' }, auth: auth.handle })
        if (res.ok) {
          const raw: unknown = JSON.parse(res.text)
          const windows = fromUsage(raw, at)
          const credits = fromCredits(raw, at)
          if (windows.length > 0)
            return write({
              windows,
              credits,
              cloudSessionCredits: fromCloudCredits(raw, at),
              projectSetupCredit: fromSetupCredit(raw, at),
              grants: fromGrants(raw, credits, at),
              weeklyBreakdown: fromBreakdown(raw, at),
              raw,
            })
        }
        if (res.status === 429) await $.store.set('nextFetchAt', now + BACKOFF_MS)
      }
    } catch {
      // Refused or offline: fall through to the figures the session already has.
    }
  }

  // Inside the floor, or the call failed: the session and weekly percent Claude Code already holds
  // for its status line, merged into the last report so the model-scoped windows and credits stay.
  const latest = fromRateLimits(rateLimits ?? (await $.session.usage()).rateLimits, at)
  if (latest.length === 0) return
  const last = await $.fs.read(path).then(text => JSON.parse(text) as Partial<Report>, () => ({}) as Partial<Report>)
  const { windows = [], credits, cloudSessionCredits, projectSetupCredit, grants, weeklyBreakdown } = last.version === 1 ? last : ({} as Partial<Report>)
  await write({ windows: merge(windows, latest), credits, cloudSessionCredits, projectSetupCredit, grants, weeklyBreakdown, raw: last.raw })
}

/** The usage response: `limits[]` when present, else the older `five_hour` / `seven_day` objects. */
function fromUsage(raw: any, at: string): Window[] {
  const windows: Window[] = []
  for (const limit of Array.isArray(raw?.limits) ? raw.limits : []) {
    if (typeof limit?.percent !== 'number') continue
    const base = { percent: limit.percent, resetsAt: iso(limit.resets_at), at }
    if (limit.kind === 'session') windows.push({ kind: 'session', ...base })
    else if (limit.kind === 'weekly_all') windows.push({ kind: 'weekly', ...base })
    else if (limit.kind === 'weekly_scoped') {
      const scope = limit.scope
      windows.push({ kind: 'weekly', label: scope?.model?.display_name ?? scope?.display_name ?? scope?.name ?? 'Scoped', ...base })
    }
  }
  if (windows.some(w => w.label === undefined)) return windows

  const older = (key: string, kind: Window['kind'], label?: string): Window[] =>
    typeof raw?.[key]?.utilization === 'number' ? [{ kind, label, percent: raw[key].utilization, resetsAt: iso(raw[key].resets_at), at }] : []
  return [...older('five_hour', 'session'), ...older('seven_day', 'weekly'), ...older('seven_day_opus', 'weekly', 'Opus'), ...older('seven_day_sonnet', 'weekly', 'Sonnet')]
}

/** Credits from the usage response: `spend` when it parses, else `extra_usage`. Undefined when neither does. */
function fromCredits(raw: any, at: string): Credits | undefined {
  const spend = raw?.spend
  const used = major(spend?.used)
  if (used !== undefined) {
    // A set limit mirrors `used`. A bare number is unseen; it would be read as minor units at `used`'s exponent.
    const limit = spend.limit === null ? null : major(spend.limit, spend.used.exponent)
    return { enabled: spend.enabled === true, used, limit, currency: text(spend.used.currency), at }
  }

  // Assumes `used_credits` and `monthly_limit` are minor units (cents) at `decimal_places`, 2 when
  // absent. Seen for `monthly_limit` (10000 beside a `spend.limit` of 100.00); `used_credits` has
  // only ever read 0.
  const extra = raw?.extra_usage
  const places = extra?.decimal_places ?? 2
  const spent = major(extra?.used_credits, places)
  if (spent === undefined) return undefined
  const limit = extra.monthly_limit === null ? null : major(extra.monthly_limit, places)
  return { enabled: extra.is_enabled === true, used: spent, limit, currency: text(extra.currency), at }
}

/**
 * Cloud session credits, from `iguana_necktie`. That key is Anthropic's codename, matched to the
 * credit by its amount. When they rename it this field goes absent, and the fix is the key here.
 */
function fromCloudCredits(raw: any, at: string): CloudCredits | undefined {
  const grant = raw?.iguana_necktie
  if (typeof grant?.used_dollars !== 'number') return undefined
  const limit = typeof grant.limit_dollars === 'number' ? grant.limit_dollars : undefined
  return { used: grant.used_dollars, limit, currency: 'USD', resetsAt: iso(grant.resets_at), at }
}

/**
 * The Projects setup credit, from `harbor_lantern`, another codename. Matched on 2026-10-04 to the
 * "Project setup credit" bar in Claude Desktop by its $100 limit, used amount, and expiry time.
 */
function fromSetupCredit(raw: any, at: string): SetupCredit | undefined {
  const grant = raw?.harbor_lantern
  if (typeof grant?.used_dollars !== 'number') return undefined
  const limit = typeof grant.limit_dollars === 'number' ? grant.limit_dollars : undefined
  return { used: grant.used_dollars, limit, currency: 'USD', expiresAt: iso(grant.resets_at), at }
}

/**
 * Every dollar credit in one list: extra usage when it is on, then each top-level object in the
 * response with a numeric `used_dollars`, other than the usage windows (`five_hour`, `seven_day*`).
 * Undefined when there are none.
 */
function fromGrants(raw: any, credits: Credits | undefined, at: string): Grant[] | undefined {
  const grants: Grant[] = []
  if (credits?.enabled) grants.push({ id: 'extra_usage', label: 'Extra usage', used: credits.used, limit: credits.limit, currency: credits.currency ?? 'USD', at })
  for (const [id, grant] of Object.entries<any>(raw && typeof raw === 'object' ? raw : {})) {
    if (id.startsWith('five_hour') || id.startsWith('seven_day') || typeof grant?.used_dollars !== 'number') continue
    const known = KNOWN_GRANTS[id]
    const limit = typeof grant.limit_dollars === 'number' ? grant.limit_dollars : undefined
    grants.push({ id, label: known?.label ?? id, used: grant.used_dollars, limit, currency: 'USD', endsAt: iso(grant.resets_at), ends: known?.ends, at })
  }
  return grants.length > 0 ? grants : undefined
}

/** The weekly breakdown, from `seven_day_breakdown`. Rows without a string key and a numeric percent are dropped. */
function fromBreakdown(raw: any, at: string): Breakdown | undefined {
  const breakdown = raw?.seven_day_breakdown
  const rows = (Array.isArray(breakdown?.rows) ? breakdown.rows : [])
    .filter((row: any) => typeof row?.key === 'string' && typeof row.percent === 'number')
    .map((row: any) => ({ key: row.key, label: text(row.display_name), percent: row.percent }))
  return rows.length > 0 ? { windowStartedAt: iso(breakdown.window_started_at), rows, at } : undefined
}

/** A money figure in major units: `{ amount_minor, exponent }`, or a bare number of minor units at `exponent`. */
function major(value: any, exponent?: unknown): number | undefined {
  const minor = typeof value === 'number' ? value : value?.amount_minor
  const places = value?.exponent ?? exponent
  return typeof minor === 'number' && typeof places === 'number' ? minor / 10 ** places : undefined
}

const text = (value: unknown) => (typeof value === 'string' ? value : undefined)

/** The status line's figures: `five_hour` and `seven_day`, no model-scoped windows. */
function fromRateLimits(rateLimits: readonly SessionRateLimit[], at: string): Window[] {
  const kinds: Record<string, Window['kind']> = { five_hour: 'session', seven_day: 'weekly' }
  return rateLimits.flatMap(limit => {
    const kind = kinds[limit.kind]
    return kind ? [{ kind, percent: limit.percentUsed, resetsAt: iso(limit.resetsAt), at }] : []
  })
}

/**
 * Lays newer windows over the previous ones. The status line trails the endpoint by a point, so
 * inside one window (same reset time) a lower reading never replaces a higher one.
 */
function merge(previous: Window[], latest: Window[]): Window[] {
  const key = (w: Window) => `${w.kind}/${w.label ?? ''}`
  const merged = previous.map(old => {
    const next = latest.find(w => key(w) === key(old))
    if (!next) return old
    const isSameWindow = old.resetsAt !== undefined && next.resetsAt !== undefined && Math.abs(Date.parse(old.resetsAt) - Date.parse(next.resetsAt)) < 60_000
    return isSameWindow && next.percent < old.percent ? old : next
  })
  return [...merged, ...latest.filter(w => !previous.some(old => key(old) === key(w)))]
}

/** A timestamp as ISO 8601 UTC, or as given when it does not parse. */
function iso(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const time = Date.parse(value)
  return Number.isNaN(time) ? value : new Date(time).toISOString()
}
