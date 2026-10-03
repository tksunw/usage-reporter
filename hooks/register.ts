import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

// Claude Code makes the usage call with its own login, and this mod writes the answer to a file
// other tools read. The credential never reaches the mod.
const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage'
const FILE = '.claude/usage-reporter/usage.json'
const FLOOR_MS = 5 * 60_000 // the endpoint rate-limits; one call per five minutes across all sessions
const BACKOFF_MS = 10 * 60_000 // after a 429

/** One usage window. A weekly window with a `label` is scoped to that model family. */
type Window = { kind: 'session' | 'weekly'; label?: string; percent: number; resetsAt?: string; at: string }

/** The file, format version 1. `raw` is Anthropic's last response, unparsed; its shape is theirs. */
type Report = { version: 1; at: string; windows: Window[]; raw?: unknown }

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
  const write = (windows: Window[], raw: unknown) => $.fs.write(path, JSON.stringify({ version: 1, at, windows, raw } satisfies Report))

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
          if (windows.length > 0) return write(windows, raw)
        }
        if (res.status === 429) await $.store.set('nextFetchAt', now + BACKOFF_MS)
      }
    } catch {
      // Refused or offline: fall through to the figures the session already has.
    }
  }

  // Inside the floor, or the call failed: the session and weekly percent Claude Code already holds
  // for its status line, merged into the last report so the model-scoped windows stay.
  const latest = fromRateLimits(rateLimits ?? (await $.session.usage()).rateLimits, at)
  if (latest.length === 0) return
  const last = await $.fs.read(path).then(text => JSON.parse(text) as Partial<Report>, () => ({}) as Partial<Report>)
  await write(merge(last.version === 1 ? (last.windows ?? []) : [], latest), last.raw)
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
