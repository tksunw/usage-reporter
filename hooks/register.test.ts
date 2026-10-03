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

// The world beneath the mod: a clock, a store, HOME, a file, and an endpoint that answers `status`.
function world(on: On, status = 200, body: unknown = USAGE) {
  const seen = { fetches: [] as unknown[], writes: [] as { path: string; text: string }[] }
  mock.env(on, { HOME: '/home/t' })
  mock.store(on)
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 3, 18) })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: [...e.changed] }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' as const } }))
  on('http.fetch', (_$, e) => {
    seen.fetches.push(e)
    return { value: { status, ok: status === 200, headers: {}, text: JSON.stringify(body) } }
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
  return { clock, file, ...seen }
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
