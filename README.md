# usage-reporter

A Claude Code mod that writes your Claude usage limits and credits to a file, so menu bar apps, status lines, scripts, and other mods can read them without each one asking Anthropic.

It writes `~/.claude/usage-reporter/usage.json`:

```json
{
  "version": 1,
  "at": "2026-10-03T19:51:50.920Z",
  "windows": [
    { "kind": "session", "percent": 7, "resetsAt": "2026-10-04T00:50:00.000Z", "at": "2026-10-03T19:51:50.920Z" },
    { "kind": "weekly", "percent": 25, "resetsAt": "2026-10-04T23:00:00.000Z", "at": "2026-10-03T19:51:50.920Z" },
    { "kind": "weekly", "label": "Fable", "percent": 48, "resetsAt": "2026-10-04T22:59:59.000Z", "at": "2026-10-03T19:49:51.598Z" }
  ],
  "credits": { "enabled": false, "used": 0, "limit": null, "currency": "USD", "at": "2026-10-03T19:51:50.920Z" },
  "cloudSessionCredits": { "used": 0, "limit": 250, "currency": "USD", "resetsAt": "2026-11-05T07:59:00.000Z", "at": "2026-10-03T19:51:50.920Z" },
  "projectSetupCredit": { "used": 17.993769, "limit": 100, "currency": "USD", "expiresAt": "2026-10-05T17:16:23.346Z", "at": "2026-10-04T18:37:30.984Z" },
  "grants": [
    { "id": "extra_usage", "label": "Extra usage", "used": 0, "limit": 100, "currency": "USD", "at": "2026-10-04T18:37:30.984Z" },
    { "id": "iguana_necktie", "label": "Cloud sessions", "used": 1.864015, "limit": 250, "currency": "USD", "endsAt": "2026-11-05T07:59:00.000Z", "ends": "expiry", "at": "2026-10-04T18:37:30.984Z" },
    { "id": "harbor_lantern", "label": "Project setup", "used": 17.993769, "limit": 100, "currency": "USD", "endsAt": "2026-10-05T17:16:23.346Z", "ends": "expiry", "at": "2026-10-04T18:37:30.984Z" }
  ],
  "weeklyBreakdown": {
    "windowStartedAt": "2026-09-27T23:00:00.902Z",
    "rows": [
      { "key": "claude_code", "label": "Claude Code", "percent": 100 },
      { "key": "chat", "label": "Chats", "percent": 0 },
      { "key": "cowork", "label": "Cowork", "percent": 0 },
      { "key": "other", "label": "Other", "percent": 0 }
    ],
    "at": "2026-10-03T19:51:50.920Z"
  },
  "raw": {}
}
```

## Install

Requires a Claude Code version with mods (Anthropic supports mods on 2.1.287 and later; the mod has also run on 2.1.251) and a Claude subscription login.

```bash
git clone https://github.com/tksunw/usage-reporter ~/.claude/mods/usage-reporter
```

Then point Claude Code at that folder's parent in `~/.claude/settings.json`, if it does not already:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods"
  }
}
```

Claude Code loads every folder under `~/.claude/mods` as a mod, which is why it lives there and not in `~/.claude/skills`: pointing `CLAUDE_CODE_PLUGIN_DIRS` at the skills folder would try to load every skill as a mod.

Start a new Claude Code session. The file appears after the session starts. To remove the mod, delete `~/.claude/mods/usage-reporter`; the last report stays in `~/.claude/usage-reporter/` until you delete that too.

To try it for one session without installing: `claude --plugin-dir /path/to/usage-reporter`.

## Update

Pull the latest version into the folder you cloned:

```bash
git -C ~/.claude/mods/usage-reporter pull
```

The next Claude Code session you start runs the new version.

## The file format

Format version 1. A reader should check `version` and stop if it is not one it knows.

| Field | Meaning |
|---|---|
| `version` | `1` |
| `at` | When the file was last written, ISO 8601 UTC |
| `windows[]` | One entry per usage window. Empty on an Enterprise login, which has no windows, only a spend budget in `credits` (and in `grants` when spending is enabled) |
| `windows[].kind` | `session` (the 5-hour window) or `weekly` (the 7-day window) |
| `windows[].label` | Present on a weekly window scoped to one model family, for example `Fable`. Absent on the all-models windows |
| `windows[].percent` | Percent of the window used, 0 to 100 |
| `windows[].resetsAt` | When the window resets, ISO 8601 UTC. Can be absent |
| `windows[].at` | When this window's figure was read. Scoped windows can be older than the others |
| `credits` | Usage credits (extra usage). Absent when Anthropic's response carries no credit figures |
| `credits.enabled` | Whether credits are turned on |
| `credits.used` | Credits spent, a number in major units of `currency` (dollars, not cents) |
| `credits.limit` | The spend limit, in the same units. `null` when no limit is set. Absent when a limit is set in a shape the mod does not know |
| `credits.currency` | ISO 4217 code, for example `USD`. Can be absent |
| `credits.at` | When the credit figures were read. Can be older than the file's `at` |
| `cloudSessionCredits` | The credit grant for cloud sessions. Absent when Anthropic's response does not carry it |
| `cloudSessionCredits.used` | Dollars spent |
| `cloudSessionCredits.limit` | Dollars granted. Can be absent |
| `cloudSessionCredits.currency` | `USD` |
| `cloudSessionCredits.resetsAt` | When the credit expires, ISO 8601 UTC. Despite the name it is an expiry, as Claude's usage page shows it; the name stays for existing readers. Can be absent |
| `cloudSessionCredits.at` | When the figures were read. Can be older than the file's `at` |
| `projectSetupCredit` | The one-time Claude Projects setup credit, shown in Claude Desktop as "Project setup credit". Absent when Anthropic's response does not carry it, which includes before it is granted |
| `projectSetupCredit.used` | Dollars spent |
| `projectSetupCredit.limit` | Dollars granted. Can be absent |
| `projectSetupCredit.currency` | `USD` |
| `projectSetupCredit.expiresAt` | When the credit expires, ISO 8601 UTC. It does not reset. Can be absent |
| `projectSetupCredit.at` | When the figures were read. Can be older than the file's `at` |
| `grants[]` | Every dollar credit in one list, for readers that want to show them all without knowing each kind: extra usage when it is turned on, then every grant in Anthropic's response, including ones this mod has never seen. Absent when there are none. Build on this rather than the three fields above |
| `grants[].id` | Where it came from: `extra_usage`, or Anthropic's codename for the grant (`iguana_necktie`, `harbor_lantern`). Stable; use it to tell grants apart |
| `grants[].label` | A name to show, for example `Cloud sessions`. For a grant the mod does not know, the codename itself |
| `grants[].used` | Dollars spent |
| `grants[].limit` | Dollars available. `null` when no limit is set. Can be absent |
| `grants[].currency` | ISO 4217 code, for example `USD` |
| `grants[].endsAt` | When the grant resets or expires, ISO 8601 UTC. Can be absent |
| `grants[].ends` | `reset` or `expiry`, saying which `endsAt` is. Absent when not known |
| `grants[].at` | When the figures were read. Can be older than the file's `at` |
| `weeklyBreakdown` | The weekly window's usage split by surface, account-wide (claude.ai chat included). Absent when Anthropic's response does not carry it |
| `weeklyBreakdown.windowStartedAt` | When the weekly window began, ISO 8601 UTC. Can be absent |
| `weeklyBreakdown.rows[]` | One entry per surface, in Anthropic's order. Keys not listed here are passed through; show them rather than dropping them |
| `weeklyBreakdown.rows[].key` | Surface id. Seen: `claude_code`, `chat`, `cowork`, `other` |
| `weeklyBreakdown.rows[].label` | Anthropic's display name, for example `Chats`. Can be absent |
| `weeklyBreakdown.rows[].percent` | See below. Not the percent of the weekly limit |
| `weeklyBreakdown.at` | When the figures were read. Can be older than the file's `at` |
| `raw` | Anthropic's last usage response, unparsed, for debugging. Its shape is theirs and changes without notice. Do not build on it |

What `weeklyBreakdown.rows[].percent` measures is not settled. Every reading so far had one non-zero row, `claude_code` at 100, while the weekly window stood at 20% and later 43%. So it is not the weekly percent, and it fits "share of this week's usage, rows summing to 100", but no reading with two non-zero rows has confirmed that. Treat it as a relative share until one does.

A window whose `resetsAt` has passed has rolled over; treat it as empty until the next report.

Reading it from a shell:

```bash
jq -r '.windows[] | "\(.kind) \(.label // "all") \(.percent)%"' ~/.claude/usage-reporter/usage.json
```

## When it updates

Only while a Claude Code session is running. Nothing runs on a timer.

- On session start, whenever Claude Code reports that a limit moved, and at the end of a turn once five minutes have passed since the last call, the mod has Claude Code call Anthropic's usage endpoint. At most one call per five minutes across all open sessions, ten minutes after a 429.
- Between those calls it writes the session and weekly percent Claude Code already holds for its status line, merged into the last report. No request is made for those. Model-scoped windows, `credits`, `cloudSessionCredits`, `projectSetupCredit`, `grants`, and `weeklyBreakdown` come only from the endpoint, so they carry over unchanged until the next call.
- The status line figures trail the endpoint by about a point, so inside one window a lower reading never replaces a higher one.

So session and weekly follow each turn, and model-scoped windows and credits update at most every five minutes. Usage from claude.ai chat or Claude Desktop shows up at the next Claude Code turn.

## What it touches

- **Your login**: the mod never sees it. It calls `$.session.authorize()`, gets an opaque handle, and passes the handle to `$.http.fetch`. Claude Code attaches the credential on its side.
- **Network**: one request, `GET https://api.anthropic.com/api/oauth/usage`, made by Claude Code. This is the call behind `/usage`.
- **Files**: writes `~/.claude/usage-reporter/usage.json` and reads it back to merge. The file holds percentages, reset times, credit figures, the per-surface split, and `raw`, Anthropic's last response as given. No token, no prompts. The mod cannot set the file's mode, so it gets your default permissions; on a Mac with other accounts that can reach `~/.claude`, they can read your usage and credit figures.
- **Environment**: reads `HOME`, else `USERPROFILE`.

`claude plugin validate .` prints the same list from the source. The whole mod is `hooks/register.ts`.

## Limits

- The usage endpoint is not documented by Anthropic and can change. When it does, the mod falls back to the session and weekly figures, and the fix belongs here, not in the tools that read the file.
- `cloudSessionCredits` is read from a key Anthropic names by codename (`iguana_necktie`), matched to the credit by its amount. If they rename it, the field goes absent until the mod is updated.
- `grants` treats any top-level object in Anthropic's response with a numeric `used_dollars` as a grant, other than the usage windows. A new grant appears there under its codename without a mod update, but with no friendly label or `ends` until the mod learns it.
- `projectSetupCredit` is read from `harbor_lantern`, another codename, matched to Claude Desktop's "Project setup credit" bar by its limit, spend, and expiry. Whether the key goes null after the credit expires has not been seen yet.
- It needs a subscription login. With an API key there are no usage windows and nothing is written.
- An Enterprise login has no session or weekly windows, only a monthly spend budget. The mod recognizes one by Anthropic's response (an empty `limits[]` with null `five_hour` and `seven_day`) while the status line has no windows either. The file then has an empty `windows[]` and the budget in `credits`, and in `grants` when spending is enabled, refreshed at most every five minutes. Any other response without windows is treated as a shape the mod cannot read, and the last report's windows stay. The response carries no reset date for the budget, so none is written; Claude's settings page shows it resetting at the start of each month.
- With `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` set, Claude Code refuses the call and you get session and weekly only.
- This is unofficial and not affiliated with Anthropic.

## Development

```bash
claude plugin validate .
claude plugin test .
```

CI runs both on every push to main and every pull request, against the latest Claude Code.

## License

MIT. See [LICENSE](LICENSE).
