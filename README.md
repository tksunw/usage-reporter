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
  "raw": {}
}
```

## Install

Requires a Claude Code version with mods (2.1.288 or later) and a Claude subscription login.

```bash
git clone https://github.com/tksunw/usage-reporter ~/.claude/skills/usage-reporter
```

Start a new Claude Code session. The file appears after the session starts. To remove the mod, delete that folder.

To try it for one session without installing: `claude --plugin-dir /path/to/usage-reporter`.

## The file format

Format version 1. A reader should check `version` and stop if it is not one it knows.

| Field | Meaning |
|---|---|
| `version` | `1` |
| `at` | When the file was last written, ISO 8601 UTC |
| `windows[]` | One entry per usage window |
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
| `cloudSessionCredits.resetsAt` | The date the endpoint gives for the grant, ISO 8601 UTC. Whether it is a reset or an expiry is not confirmed. Can be absent |
| `cloudSessionCredits.at` | When the figures were read. Can be older than the file's `at` |
| `raw` | Anthropic's last usage response, unparsed, for debugging. Its shape is theirs and changes without notice. Do not build on it |

A window whose `resetsAt` has passed has rolled over; treat it as empty until the next report.

Reading it from a shell:

```bash
jq -r '.windows[] | "\(.kind) \(.label // "all") \(.percent)%"' ~/.claude/usage-reporter/usage.json
```

## When it updates

Only while a Claude Code session is running. Nothing runs on a timer.

- On session start, and whenever Claude Code reports that a limit moved, the mod has Claude Code call Anthropic's usage endpoint. At most one call per five minutes across all open sessions, ten minutes after a 429.
- Between those calls it writes the session and weekly percent Claude Code already holds for its status line, merged into the last report. No request is made for those. Model-scoped windows, `credits`, and `cloudSessionCredits` come only from the endpoint, so they carry over unchanged until the next call.
- The status line figures trail the endpoint by about a point, so inside one window a lower reading never replaces a higher one.

So session and weekly follow each turn, and model-scoped windows and credits update at most every five minutes. Usage from claude.ai chat or Claude Desktop shows up at the next Claude Code turn.

## What it touches

- **Your login**: the mod never sees it. It calls `$.session.authorize()`, gets an opaque handle, and passes the handle to `$.http.fetch`. Claude Code attaches the credential on its side.
- **Network**: one request, `GET https://api.anthropic.com/api/oauth/usage`, made by Claude Code. This is the call behind `/usage`.
- **Files**: writes `~/.claude/usage-reporter/usage.json` and reads it back to merge. The file holds percentages, reset times, and credit figures. No token, no prompts.
- **Environment**: reads `HOME`.

`claude plugin validate .` prints the same list from the source. The whole mod is `hooks/register.ts`.

## Limits

- The usage endpoint is not documented by Anthropic and can change. When it does, the mod falls back to the session and weekly figures, and the fix belongs here, not in the tools that read the file.
- `cloudSessionCredits` is read from a key Anthropic names by codename (`iguana_necktie`), matched to the credit by its amount. If they rename it, the field goes absent until the mod is updated.
- It needs a subscription login. With an API key there are no usage windows and nothing is written.
- With `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` set, Claude Code refuses the call and you get session and weekly only.
- This is unofficial and not affiliated with Anthropic.

## Development

```bash
claude plugin validate .
claude plugin test .
```

## License

MIT. See [LICENSE](LICENSE).
