# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Claude Code mod (a plugin made of function hooks, supported on Claude Code 2.1.287 and later, the first release Anthropic supports mods on; known to run on 2.1.251) that writes the user's Claude usage limits and credits to `~/.claude/usage-reporter/usage.json`. Other tools (Tokenometer, status lines, scripts) read that file instead of each calling Anthropic. The file is the product: its shape is a public contract documented in `README.md` under "The file format".

## Commands

```bash
claude plugin validate .          # manifest check; also prints the capability list (network, files, env) derived from source
claude plugin test .              # runs every *.test.ts under the folder
claude --plugin-dir .             # load the working copy for one session without installing
```

There is no package.json, build step, or linter. `claude plugin test` has no single-test filter; it takes only a directory. The test kit comes from `claude-code/testing` and types from `claude-code`, both supplied by the Claude Code binary. CI (`.github/workflows/ci.yml`) installs the latest Claude Code and runs `validate` and `test` on every push to main and every PR; neither needs a login. `tsconfig.json` and `.claude-plugin/types/` are gitignored; do not commit them.

## Architecture

The whole mod is `hooks/register.ts`. `hooks/hooks.json` points Claude Code at it and `.claude-plugin/plugin.json` is the manifest (bump `version` there on release).

`register` hooks three events and all funnel into `report()`:

- `session.start`: reports after the session has started.
- `session.measure`: reports only when `e.changed` includes `rateLimits`, using the rate limits carried on the event.
- `turn.complete`: main conversation only (`e.agentId` unset), and only once the five-minute floor in the store has lapsed. A quiet stretch moves no whole point, so without this the file ages while the session is busy.

Both swallow errors from `report()`. The mod must never break a session.

`report()` has two paths:

1. Fetch path. If `now >= nextFetchAt` (in `$.store`, shared across all open sessions), it claims the slot by writing `nextFetchAt = now + 5 min` before the call, then has Claude Code `GET https://api.anthropic.com/api/oauth/usage` using an opaque handle from `$.session.authorize()`. A parseable response replaces the whole file, `raw`, `credits`, `cloudSessionCredits`, `projectSetupCredit`, `grants`, and `weeklyBreakdown` included. A 429 pushes `nextFetchAt` to 10 minutes. Enterprise logins have no windows in the response or on the status line, only `spend`. `isWindowless()` recognizes one by the response saying so outright (`limits: []`, `five_hour: null`, `seven_day: null`); with that and an empty status line, the file is written with `windows: []`, budget or not. Do not decide on the status line alone: it is also empty in a session before its first turn, and a plan account with an unread response shape would lose its windows. Any other response without windows is an unread shape and goes to the merge path.
2. Merge path. Inside the floor, or when the fetch fails, is refused, or yields no windows, it takes the `five_hour` / `seven_day` figures Claude Code already holds for its status line, reads the last file, and merges them in so model-scoped windows, `credits`, `cloudSessionCredits`, `projectSetupCredit`, `grants`, `weeklyBreakdown`, and `raw` survive. Those objects keep their original `at`.

Things that are easy to break:

- The credential never reaches the mod. Only the handle is passed to `$.http.fetch`. Keep it that way; the README's "What it touches" section promises it.
- All I/O goes through the `$` engine interface (`$.env`, `$.clock`, `$.store`, `$.fs`, `$.http`, `$.session`). No `process.env`, `Date.now()`, or `node:fs`; the tests mock these capabilities and `claude plugin validate` reports them.
- `merge()` keys windows by `kind/label`. Within the same window (reset times within 60 s of each other) a lower percent never replaces a higher one, because the status line trails the endpoint by about a point. A different `resetsAt` means the window rolled over, and the new reading wins even if lower.
- `fromUsage()` handles two response shapes: the current `limits[]` (`session`, `weekly_all`, `weekly_scoped`) and the older `five_hour` / `seven_day` / `seven_day_opus` / `seven_day_sonnet` objects. The older shape is used only when `limits[]` yields no unlabeled window. The endpoint is undocumented, so shape changes get fixed here, not in readers.
- `fromCredits()` reads `spend` (self-describing `amount_minor` + `exponent`) and falls back to `extra_usage`, read as minor units at `decimal_places` (confirmed for both `monthly_limit` and `used_credits`). Figures are written in major units. An unparseable limit is left out, never guessed; `null` means no limit.
- `fromCloudCredits()` reads `raw.iguana_necktie`, an Anthropic codename mapped to `cloudSessionCredits` on 2026-10-04 on the strength of a matching $250 figure, not on anything Anthropic documents. Its `resets_at` is an expiry (Claude's usage page, 2026-10-05: "Expires 2:59 AM EST, November 5" = 07:59Z), so `KNOWN_GRANTS` marks it `ends: 'expiry'`; `cloudSessionCredits.resetsAt` keeps its name for readers. If the field goes absent, look for a renamed key in `raw` first.
- `fromSetupCredit()` reads `raw.harbor_lantern` into `projectSetupCredit`, matched on 2026-10-04 to Claude Desktop's "Project setup credit" bar ($100 limit, $17.99 used = 18%, expiry 17:16 UTC = "Expires tomorrow at 1:16 PM"). It is a one-time grant, so the endpoint's `resets_at` is written as `expiresAt`. After expiry the key reads null again (seen by 2026-10-06), so the field and its grant drop out. Same rename caveat as `iguana_necktie`.
- `fromGrants()` writes `grants[]`, the list readers should build on: extra usage (from `credits`, only when enabled), then every top-level key in `raw` whose value has a numeric `used_dollars`, skipping `five_hour` and `seven_day*` (those carry `used_dollars: null` today). Discovery is by shape, so a new codename shows up with `label` set to the key. To name one, add it to `KNOWN_GRANTS` with a label and, once confirmed, `ends`. `credits`, `cloudSessionCredits`, and `projectSetupCredit` stay for existing readers (status-enhanced reads the first two); removing them is a breaking change.
- `fromBreakdown()` reads `raw.seven_day_breakdown` into `weeklyBreakdown`. Every row with a string `key` and numeric `percent` passes through, unknown keys included, so readers pick up new surfaces without a mod update. What `percent` means is unsettled (see the README); as of 2026-10-04 only readings with a single non-zero row (`claude_code` 100) exist, at weekly 20% and 43%, so it is not the weekly percent.
- A change to the written JSON shape is a breaking change for readers; optional additive fields (like `credits`) are not. For a breaking change, bump `version` in the `Report` type and update the README table together.

## Tests

`hooks/register.test.ts` builds a `world()` helper that mocks env, store, clock, `session.authorize`, `http.fetch`, and `fs`, then drives the mod with `$.session.start(...)` / `$.session.measure(...)` and asserts on recorded fetches and the last written file. Time moves with `clock.advance()`. New behavior in `report()` should get a case here using the same helper.

## Docs

The README states behavior precisely (update cadence, what the mod touches, limits). When behavior in `register.ts` changes, update the matching README section in the same change.

## Commits

AI agents are never authors or co-authors: GitHub holds authors and co-authors responsible for a commit, and an agent can't be. Never add a `Co-Authored-By` trailer naming Claude or any other agent, whatever a harness default says. End every commit message an agent helped write with:

```
Assisted-by: <model name> <noreply@anthropic.com>
```

using the model actually serving the session (for example `Assisted-by: Claude Opus 5.5 <noreply@anthropic.com>`). A `Claude-Session:` link line may follow it. When squash-merging a PR, edit the squash message so GitHub does not copy `Co-authored-by` trailers from the branch commits.
