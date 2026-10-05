import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PATH = '/home/t/.claude/usage-reporter/usage.json'
const USAGE = {
  limits: [
    { kind: 'session', percent: 71, resets_at: '2026-10-03T19:50:00.902361+00:00', scope: null },
    { kind: 'weekly_all', percent: 20, resets_at: '2026-10-04T23:00:00.902388+00:00', scope: null },
    { kind: 'weekly_scoped', percent: 38, resets_at: '2026-10-04T22:59:59.902740+00:00', scope: { model: { display_name: 'Fable' } } },
  ],
}
// The status line a minute later: session moved on, weekly reads a point behind the endpoint.
const MEASURE = {
  context: { window: 200_000 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 74, resetsAt: '2026-10-03T19:50:00.000Z' },
    { kind: 'seven_day', percentUsed: 19, resetsAt: '2026-10-04T23:00:00.000Z' },
  ],
  changed: ['rateLimits' as const],
}

// The usage response with credits on, in both the shapes it carries them. `spend` is the one read.
const SPEND = { used: { amount_minor: 1234, currency: 'USD', exponent: 2 }, limit: { amount_minor: 5000, currency: 'USD', exponent: 2 }, enabled: true }
const EXTRA = { is_enabled: true, monthly_limit: 10000, used_credits: 250, currency: 'USD', decimal_places: 2 }
const NECKTIE = { utilization: 0, resets_at: '2026-11-05T07:59:00+00:00', limit_dollars: 250, used_dollars: 12.5, remaining_dollars: 237.5, locked_reason: null }
// Captured live on 2026-10-03, plus a surface the mod has never seen.
const BREAKDOWN = {
  as_of: '2026-10-03T17:31:15.937959+00:00',
  window_started_at: '2026-09-27T23:00:00.902388+00:00',
  rows: [
    { key: 'claude_code', display_name: 'Claude Code', percent: 100 },
    { key: 'chat', display_name: 'Chats', percent: 0 },
    { key: 'telescope', display_name: 'Telescope', percent: 0 },
  ],
}
const WEEKLY = {
  windowStartedAt: '2026-09-27T23:00:00.902Z',
  rows: [
    { key: 'claude_code', label: 'Claude Code', percent: 100 },
    { key: 'chat', label: 'Chats', percent: 0 },
    { key: 'telescope', label: 'Telescope', percent: 0 },
  ],
  at: '2026-10-03T18:00:00.000Z',
}
// Captured live on 2026-10-04 while a Project ran; Claude Desktop showed it as 18% used.
const LANTERN = { utilization: 17.993769, resets_at: '2026-10-05T17:16:23.346348+00:00', limit_dollars: 100, used_dollars: 17.993769, remaining_dollars: 82.006231, locked_reason: null }
const CREDITS = { enabled: true, used: 12.34, limit: 50, currency: 'USD', at: '2026-10-03T18:00:00.000Z' }

// The world beneath the mod: a clock, a store, HOME, a file, and an endpoint that answers `reply`.
function world(on: On, status = 200, body: unknown = USAGE, env: Record<string, string> = { HOME: '/home/t' }) {
  const reply = { status, body }
  const seen = { fetches: [] as unknown[], writes: [] as { path: string; text: string }[] }
  mock.env(on, env)
  mock.store(on)
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 3, 18) })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: [...e.changed] }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' as const } }))
  on('http.fetch', (_$, e) => {
    seen.fetches.push(e)
    return { value: { status: reply.status, ok: reply.status === 200, headers: {}, text: JSON.stringify(reply.body) } }
  })
  on('fs.write', (_$, e) => {
    seen.writes.push({ ...e })
    return { value: undefined }
  })
  on('fs.read', () => {
    const last = seen.writes.at(-1)
    return last ? { value: last.text } : { deny: 'ENOENT' }
  })
  const file = () => JSON.parse(seen.writes.at(-1)!.text)
  return { clock, file, reply, ...seen }
}

const start = { cwd: '/w', surface: null, isInteractive: false }

test('session start writes the windows in format 1, asked for with the session credential', async ($, on) => {
  const { fetches, writes, file } = world(on)
  await $.session.start(start)

  expect(fetches).toHaveLength(1)
  expect(fetches[0]).toEqual(expect.objectContaining({ url: 'https://api.anthropic.com/api/oauth/usage' }))
  expect(JSON.stringify(fetches[0])).toContain('"auth":"h"')
  expect(writes[0]?.path).toBe(PATH)
  const at = '2026-10-03T18:00:00.000Z'
  expect(file()).toEqual({
    version: 1,
    at,
    windows: [
      { kind: 'session', percent: 71, resetsAt: '2026-10-03T19:50:00.902Z', at },
      { kind: 'weekly', percent: 20, resetsAt: '2026-10-04T23:00:00.902Z', at },
      { kind: 'weekly', label: 'Fable', percent: 38, resetsAt: '2026-10-04T22:59:59.902Z', at },
    ],
    raw: USAGE,
  })
})

test('with no HOME the file is written under USERPROFILE', async ($, on) => {
  const { writes } = world(on, 200, USAGE, { USERPROFILE: '/win/t' })
  await $.session.start(start)
  expect(writes.at(-1)!.path).toBe('/win/t/.claude/usage-reporter/usage.json')
})

test('inside the five minute floor the status line figures merge into the last report', async ($, on) => {
  const { clock, fetches, file } = world(on)
  await $.session.start(start)
  await clock.advance(60_000)
  await $.session.measure(MEASURE)

  expect(fetches).toHaveLength(1)
  const windows = file().windows
  expect(windows.map((w: { percent: number }) => w.percent)).toEqual([74, 20, 38]) // weekly did not step back to 19
  expect(windows[0].at).toBe('2026-10-03T18:01:00.000Z')
  expect(windows[2].label).toBe('Fable')
  expect(file().raw).toEqual(USAGE)

  await clock.advance(4 * 60_000)
  await $.session.measure(MEASURE)
  expect(fetches).toHaveLength(2)
})

test('a new window replaces the old one even when it reads lower', async ($, on) => {
  const { clock, file } = world(on)
  await $.session.start(start)
  await clock.advance(60_000)
  await $.session.measure({ ...MEASURE, rateLimits: [{ kind: 'five_hour', percentUsed: 2, resetsAt: '2026-10-04T00:50:00.000Z' }] })
  expect(file().windows[0]).toEqual(expect.objectContaining({ kind: 'session', percent: 2 }))
})

test('a 429 writes the status line figures and backs off ten minutes', async ($, on) => {
  const { clock, fetches, file } = world(on, 429)
  await $.session.measure(MEASURE)
  expect(file().windows.map((w: { kind: string; percent: number }) => [w.kind, w.percent])).toEqual([['session', 74], ['weekly', 19]])

  await clock.advance(9 * 60_000)
  await $.session.measure(MEASURE)
  expect(fetches).toHaveLength(1)
})

test('the older response shape still yields windows', async ($, on) => {
  const older = { five_hour: { utilization: 35, resets_at: '2026-02-06T22:00:00+00:00' }, seven_day: { utilization: 14, resets_at: null }, seven_day_opus: { utilization: 9, resets_at: null } }
  const { file } = world(on, 200, older)
  await $.session.start(start)
  expect(file().windows.map((w: { kind: string; label?: string; percent: number }) => [w.kind, w.label, w.percent])).toEqual([
    ['session', undefined, 35],
    ['weekly', undefined, 14],
    ['weekly', 'Opus', 9],
  ])
})

test('credits come from spend, in major units', async ($, on) => {
  const { file } = world(on, 200, { ...USAGE, spend: SPEND, extra_usage: EXTRA })
  await $.session.start(start)
  expect(file().credits).toEqual(CREDITS)
})

test('credits fall back to extra_usage, read as minor units', async ($, on) => {
  const { file } = world(on, 200, { ...USAGE, extra_usage: EXTRA })
  await $.session.start(start)
  expect(file().credits).toEqual({ ...CREDITS, used: 2.5, limit: 100 })
})

test('no limit is null, a bare limit is minor units, an unknown limit is left out', async ($, on) => {
  const { clock, file, reply } = world(on, 200, { ...USAGE, spend: { ...SPEND, limit: null, enabled: false } })
  await $.session.start(start)
  expect(file().credits).toEqual({ ...CREDITS, enabled: false, limit: null })

  for (const [limit, expected] of [[5000, 50], ['unlimited', undefined]] as const) {
    reply.body = { ...USAGE, spend: { ...SPEND, limit } }
    await clock.advance(5 * 60_000)
    await $.session.measure(MEASURE)
    expect(file().credits.limit).toBe(expected)
  }
})

test('credits carry over unchanged inside the floor and after a 429', async ($, on) => {
  const { clock, fetches, file, reply } = world(on, 200, { ...USAGE, spend: SPEND })
  await $.session.start(start)
  await clock.advance(60_000)
  await $.session.measure(MEASURE)
  expect(fetches).toHaveLength(1)
  expect(file().credits).toEqual(CREDITS)

  reply.status = 429
  await clock.advance(4 * 60_000)
  await $.session.measure(MEASURE)
  expect(fetches).toHaveLength(2)
  expect(file().at).toBe('2026-10-03T18:05:00.000Z')
  expect(file().credits).toEqual(CREDITS)
})

test('a response with no credit objects writes no credit fields', async ($, on) => {
  const { file } = world(on)
  await $.session.start(start)
  expect('credits' in file()).toBe(false)
  expect('cloudSessionCredits' in file()).toBe(false)
  expect('projectSetupCredit' in file()).toBe(false)
  expect('grants' in file()).toBe(false)
  expect('weeklyBreakdown' in file()).toBe(false)
})

test('cloud session credits come from iguana_necktie and carry over inside the floor', async ($, on) => {
  const { clock, file } = world(on, 200, { ...USAGE, iguana_necktie: NECKTIE })
  const cloud = { used: 12.5, limit: 250, currency: 'USD', resetsAt: '2026-11-05T07:59:00.000Z', at: '2026-10-03T18:00:00.000Z' }
  await $.session.start(start)
  expect(file().cloudSessionCredits).toEqual(cloud)

  await clock.advance(60_000)
  await $.session.measure(MEASURE)
  expect(file().at).toBe('2026-10-03T18:01:00.000Z')
  expect(file().cloudSessionCredits).toEqual(cloud)
})

test('the weekly breakdown is parsed on a fetch, unknown surfaces kept', async ($, on) => {
  const { file } = world(on, 200, { ...USAGE, seven_day_breakdown: BREAKDOWN })
  await $.session.start(start)
  expect(file().weeklyBreakdown).toEqual(WEEKLY)
})

test('the weekly breakdown carries over inside the floor and after a 429', async ($, on) => {
  const { clock, fetches, file, reply } = world(on, 200, { ...USAGE, seven_day_breakdown: BREAKDOWN })
  await $.session.start(start)
  await clock.advance(60_000)
  await $.session.measure(MEASURE)
  expect(file().at).toBe('2026-10-03T18:01:00.000Z')
  expect(file().weeklyBreakdown).toEqual(WEEKLY)

  reply.status = 429
  await clock.advance(4 * 60_000)
  await $.session.measure(MEASURE)
  expect(fetches).toHaveLength(2)
  expect(file().weeklyBreakdown).toEqual(WEEKLY)
})

test('a breakdown with no usable rows is left out', async ($, on) => {
  const { file } = world(on, 200, { ...USAGE, seven_day_breakdown: { ...BREAKDOWN, rows: [{ key: 'chat' }, { percent: 5 }] } })
  await $.session.start(start)
  expect('projectSetupCredit' in file()).toBe(false)
  expect('grants' in file()).toBe(false)
  expect('weeklyBreakdown' in file()).toBe(false)
})

test('the project setup credit comes from harbor_lantern, expires rather than resets, and carries over', async ($, on) => {
  const { clock, file } = world(on, 200, { ...USAGE, harbor_lantern: LANTERN })
  const setup = { used: 17.993769, limit: 100, currency: 'USD', expiresAt: '2026-10-05T17:16:23.346Z', at: '2026-10-03T18:00:00.000Z' }
  await $.session.start(start)
  expect(file().projectSetupCredit).toEqual(setup)

  await clock.advance(60_000)
  await $.session.measure(MEASURE)
  expect(file().at).toBe('2026-10-03T18:01:00.000Z')
  expect(file().projectSetupCredit).toEqual(setup)
})

test('a null harbor_lantern writes no project setup credit', async ($, on) => {
  const { file } = world(on, 200, { ...USAGE, harbor_lantern: null })
  await $.session.start(start)
  expect('projectSetupCredit' in file()).toBe(false)
})

test('grants list extra usage and every dollar grant, unknown codenames included, and carry over', async ($, on) => {
  const nimbus = { used_dollars: 3, limit_dollars: null, resets_at: null }
  const window = { utilization: 10, used_dollars: 1 } // a window that someday carries dollars is not a grant
  const { clock, file } = world(on, 200, { ...USAGE, spend: SPEND, iguana_necktie: NECKTIE, harbor_lantern: LANTERN, nimbus_quill: nimbus, seven_day_cowork: window, cinder_cove: null })
  const at = '2026-10-03T18:00:00.000Z'
  const grants = [
    { id: 'extra_usage', label: 'Extra usage', used: 12.34, limit: 50, currency: 'USD', at },
    { id: 'iguana_necktie', label: 'Cloud sessions', used: 12.5, limit: 250, currency: 'USD', endsAt: '2026-11-05T07:59:00.000Z', at },
    { id: 'harbor_lantern', label: 'Project setup', used: 17.993769, limit: 100, currency: 'USD', endsAt: '2026-10-05T17:16:23.346Z', ends: 'expiry', at },
    { id: 'nimbus_quill', label: 'nimbus_quill', used: 3, currency: 'USD', at },
  ]
  await $.session.start(start)
  expect(file().grants).toEqual(grants)

  await clock.advance(60_000)
  await $.session.measure(MEASURE)
  expect(file().at).toBe('2026-10-03T18:01:00.000Z')
  expect(file().grants).toEqual(grants)
})

test('extra usage that is turned off is not a grant', async ($, on) => {
  const { file } = world(on, 200, { ...USAGE, spend: { ...SPEND, enabled: false } })
  await $.session.start(start)
  expect(file().credits.enabled).toBe(false)
  expect('grants' in file()).toBe(false)
})
