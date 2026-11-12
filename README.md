# gentle-tokometer-tps

A Pi extension that leaves one persistent line per finished turn in the transcript — TPS with three selectable measurement modes, TTFT, input/output tokens, cache read/write with hit %, total and wall time. It is a per-turn summary, not a live meter: there is no continuously updating display, and the numbers are written once, never sent to the model, and survive a reload.

```text
TPS 15.0 tok/s. TTFT 1.2s, out 470, in 1.9k, cache r/w 425.7k/0 (99.6% hit), total 428.1k, 24.2s
```

Every number in that line is defined below, and `/tokometer` changes which ones you see and how TPS is measured.

## Install

With Gentle Shell (recommended, simplest — it is on npm):

```bash
gentle-shell install npm:gentle-tokometer-tps
```

Pin the release with `npm:gentle-tokometer-tps@0.3.0`. Alternatively install from git, pinned to the release or tracking `main` to also pick up unreleased changes:

```bash
gentle-shell install git:github.com/MiguezPablo/gentle-tokometer-tps@v0.3.0
gentle-shell install git:github.com/MiguezPablo/gentle-tokometer-tps
```

Without Gentle Shell, Pi's own `install` takes the same sources:

```bash
pi install npm:gentle-tokometer-tps
pi install git:github.com/MiguezPablo/gentle-tokometer-tps@v0.3.0
# or track main
pi install git:github.com/MiguezPablo/gentle-tokometer-tps
```

Without a version, an install takes the latest release and `pi update` moves it forward; `@0.3.0` on npm and `@v0.3.0` on git stay pinned until you install again. Reload (`/reload`, or start a new session) after installing so the extension loads.

Try it once without installing:

```bash
pi -e npm:gentle-tokometer-tps
```

The extension loads from `extensions/gentle-tokometer-tps.ts` (see the `pi` key in `package.json`).

## Hide Gentle Shell's built-in TPS line

Gentle Shell ships its own TPS printer: gentle-pi's `extensions/gentle-tps.ts` is always loaded by the launcher and has no toggle, so with this package installed the transcript shows two TPS lines. Pi cannot exclude one extension from a package it loads implicitly, so the only supported way out is a settings declaration that loads gentle-pi as a path package and excludes `extensions/gentle-tps.ts`. The launcher honours that declaration only while the declared directory is the gentle-pi installation it is actually running, and a pnpm global install changes that directory on every update.

`scripts/disable-gentle-tps.sh` wires that up and keeps it valid across updates. Run it once (from a clone, or from the installed package):

```bash
sh scripts/disable-gentle-tps.sh
# installed with Gentle Shell (0.3.0 and later):
sh ~/.gentle-shell/agent/npm/node_modules/gentle-tokometer-tps/scripts/disable-gentle-tps.sh
```

Then restart Gentle Shell (or run `/reload`). The script is idempotent and changes three things:

- installs `~/.local/bin/gentle-shell`, a wrapper that repoints a stable symlink at the current gentle-pi root before every run and then execs the real launcher, so a package update cannot leave a stale path behind;
- creates that symlink at `~/.gentle-shell/gentle-pi-current`;
- adds a `packages` entry for the symlink with `extensions: ["!extensions/gentle-tps.ts"]` to `~/.gentle-shell/agent/settings.json`, backing the file up once to `settings.json.bak-gentle-tps`; it drops gentle-pi path entries (stale hashed installs and earlier symlinks) and also local path entries whose directory no longer exists, for any package, while keeping every other key and entry in order.

The wrapper only runs if its directory comes before the real `gentle-shell` on `PATH` (the script warns when it does not). To undo, run the same script with `uninstall`: it removes the wrapper, the symlink and the settings entry, and keeps the backup. Override the paths with `GENTLE_TPS_WRAPPER_DIR`, `GENTLE_TPS_LINK` and `GENTLE_SHELL_AGENT_DIR`; `sh scripts/disable-gentle-tps.sh --help` lists the subcommands.

## Configure with `/tokometer`

Run `/tokometer` in the TUI to open a settings menu with one row per setting. Enter or space cycles the row's value; every change applies immediately and is saved, including to lines already shown in the transcript.

| Setting | Values | Effect |
|---|---|---|
| `TTFT` | `on` / `off` | Show or hide the `TTFT …` latency segment. |
| `Cache hit %` | `on` / `off` | Show or hide the `(…% hit)` share of `cache r/w`; the cache numbers stay. |
| `TPS mode` | `e2e` (default) / `stream` / `wall` | Which time window output tokens are divided by (see below). The default `e2e` has no label parenthesis; the others are labelled `TPS(stream) …` and `TPS(wall) …`. |

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
| `TPS …` (e2e, default) | `out / Σ(message_end − message_start)` per assistant message, in tok/s. Includes the wait for each request's first token. |
| `TPS(stream) …` | `out / Σ(message_end − first nonempty delta)` per assistant message. Pure decoding speed: neither tool execution nor each request's wait for its first token dilutes it. |
| `TPS(wall) …` | `out / (agent_end − agent_start)`. Includes tool execution and everything else in the run. |
| `TTFT` | `first nonempty text/thinking/tool-call delta − agent_start`. Run-level latency, including preparation, not HTTP-only latency. |
| `out` / `in` | Provider output and input tokens for the run. |
| `cache r/w` | Cache read and cache write tokens for the run. |
| `hit` | `100 × cacheRead / (input + cacheRead + cacheWrite)` across the run. |
| `total` | Provider total tokens for the run. |
| trailing time | Wall-clock duration of the whole run, e.g. `24.2s`. |

Counts below 1,000 are shown exactly; larger ones use `k` with at most one decimal. A mode whose window is zero, or an empty cache input, shows `-`. Thinking tokens count as output when the provider reports them that way.

### Why e2e is the default

`stream` measures how fast visible text arrives, not how fast the provider produced it. When a provider hides its reasoning (Claude, for example), the hidden thinking is billed as output but reaches the client as one burst of deltas near `message_end`, so the stream window collapses and `TPS(stream)` overstates the real speed. `e2e` starts at `message_start`, so hidden thinking is paid for in time and cannot inflate the number. `wall` includes tool execution and is the slowest, most conservative reading.

### Entries without e2e time

Entries stored before 0.2.0, and the legacy `turn-stats` entries, carry no e2e time. In the default `e2e` mode they render their stream value under the `TPS(stream)` label rather than a dash, so old sessions stay readable. An entry whose e2e time is present but zero still shows `TPS - tok/s.`; no fallback applies there.

## Settings file

Settings live in the Pi agent directory, in `gentle-tokometer-tps.json`:

- `~/.pi/agent/gentle-tokometer-tps.json` for Pi
- `~/.gentle-shell/agent/gentle-tokometer-tps.json` for Gentle Shell
- `$PI_CODING_AGENT_DIR/gentle-tokometer-tps.json` when that variable overrides the agent directory

```json
{
  "ttft": true,
  "hit": true,
  "tps": "e2e"
}
```

Those are the defaults (`tps: "e2e"` since 0.2.0; a file still saying `"stream"` is respected). A missing, unreadable or malformed file, or an invalid field, falls back to the defaults one field at a time and never breaks the extension. If a change cannot be written, the extension reports it and the change still applies until the session ends.

## Compatibility and behavior

- Entries stored by earlier versions under the legacy `turn-stats` entry type keep rendering; as they store no e2e time, the default mode shows their stream value labelled `TPS(stream)`.
- The line is written as a session entry, so it is never sent to the model and it reappears when a session is resumed.
- No line is shown in subagent child sessions, outside TUI mode, or for a run that reports zero tokens.
- With the defaults the line keeps the earlier `turn-stats` numbers and format; the TPS segment is now measured end to end and labelled `TPS`.

## License

MIT
