# gentle-tokometer-tps

A Pi extension that leaves one persistent line per finished turn in the transcript — TPS with three selectable measurement modes, TTFT, input/output tokens, cache read/write with hit %, total and wall time. It is a per-turn summary, not a live meter: there is no continuously updating display, and the numbers are written once, never sent to the model, and survive a reload.

```text
TPS 19.4 tok/s. TTFT 1.2s, out 470, in 1.9k, cache r/w 425.7k/0 (99.6% hit), total 428.1k, 24.2s
```

Every number in that line is defined below, and `/tokometer` changes which ones you see and how TPS is measured.

## Install

With Gentle Shell, pinned to the release (recommended):

```bash
gentle-shell install git:github.com/MiguezPablo/gentle-tokometer-tps@v0.1.0
```

Or track `main`, which also picks up unreleased changes:

```bash
gentle-shell install git:github.com/MiguezPablo/gentle-tokometer-tps
```

Without Gentle Shell, Pi's own `install` takes the same sources:

```bash
pi install git:github.com/MiguezPablo/gentle-tokometer-tps@v0.1.0
# or track main
pi install git:github.com/MiguezPablo/gentle-tokometer-tps
```

A pinned `@v0.1.0` stays on that release until you install again; the unpinned form follows `main`. Reload (`/reload`, or start a new session) after installing so the extension loads.

npm (`npm:gentle-tokometer-tps`) is coming soon.

Try it once without installing:

```bash
pi -e git:github.com/MiguezPablo/gentle-tokometer-tps@v0.1.0
```

The extension loads from `extensions/gentle-tokometer-tps.ts` (see the `pi` key in `package.json`).

## Configure with `/tokometer`

Run `/tokometer` in the TUI to open a settings menu with one row per setting. Enter or space cycles the row's value; every change applies immediately and is saved, including to lines already shown in the transcript.

| Setting | Values | Effect |
|---|---|---|
| `TTFT` | `on` / `off` | Show or hide the `TTFT …` latency segment. |
| `Cache hit %` | `on` / `off` | Show or hide the `(…% hit)` share of `cache r/w`; the cache numbers stay. |
| `TPS mode` | `stream` / `e2e` / `wall` | Which time window output tokens are divided by (see below). Each mode has its own label: `TPS …`, `TPS(e2e) …`, `TPS(wall) …`. |

For scripting, the same settings are accepted as arguments:

```bash
/tokometer ttft off
/tokometer hit on
/tokometer tps wall
```

Arguments apply the value, persist it and report the resulting config; an unknown setting or value prints the usage line listing the valid ones and changes nothing. Without an interactive UI (print or JSON mode) `/tokometer` reports the config in effect instead of opening the menu.

## Metrics

`out` is the provider's output token count for the run, `in` its non-cached input count, and both are summed over the run's assistant messages.

| Segment | Formula |
|---|---|
| `TPS …` (stream, default) | `out / Σ(message_end − first nonempty delta)` per assistant message, in tok/s. Pure decoding speed: neither tool execution nor each request's wait for its first token dilutes it. |
| `TPS(e2e) …` | `out / Σ(message_end − message_start)` per assistant message. Includes the wait for each request's first token. |
| `TPS(wall) …` | `out / (agent_end − agent_start)`. Includes tool execution and everything else in the run. |
| `TTFT` | `first nonempty text/thinking/tool-call delta − agent_start`. Run-level latency, including preparation, not HTTP-only latency. |
| `out` / `in` | Provider output and input tokens for the run. |
| `cache r/w` | Cache read and cache write tokens for the run. |
| `hit` | `100 × cacheRead / (input + cacheRead + cacheWrite)` across the run. |
| `total` | Provider total tokens for the run. |
| trailing time | Wall-clock duration of the whole run, e.g. `24.2s`. |

Counts below 1,000 are shown exactly; larger ones use `k` with at most one decimal. A value that is missing from the entry (older entries have no e2e time), a mode whose window is zero, or an empty cache input shows `-`. Thinking tokens count as output when the provider reports them that way.

## Settings file

Settings live in the Pi agent directory, in `gentle-tokometer-tps.json`:

- `~/.pi/agent/gentle-tokometer-tps.json` for Pi
- `~/.gentle-shell/agent/gentle-tokometer-tps.json` for Gentle Shell
- `$PI_CODING_AGENT_DIR/gentle-tokometer-tps.json` when that variable overrides the agent directory

```json
{
  "ttft": true,
  "hit": true,
  "tps": "stream"
}
```

Those are the defaults. A missing, unreadable or malformed file, or an invalid field, falls back to the defaults one field at a time and never breaks the extension. If a change cannot be written, the extension reports it and the change still applies until the session ends.

## Compatibility and behavior

- Entries stored by earlier versions under the legacy `turn-stats` entry type keep rendering with the same line.
- The line is written as a session entry, so it is never sent to the model and it reappears when a session is resumed.
- No line is shown in subagent child sessions, outside TUI mode, or for a run that reports zero tokens.
- With the defaults the line is byte-for-byte the one the earlier `turn-stats` extension printed.

## License

MIT
