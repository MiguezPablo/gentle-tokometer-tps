# gentle-tokometer-tps

A Pi extension that prints a dim TPS / TTFT / token-usage line under every agent turn.

```text
TPS 19.4 tok/s. TTFT 1.2s, out 470, in 1.9k, cache r/w 425.7k/0 (99.6% hit), total 428.1k, 24.2s
```

## Install

```bash
pi install npm:gentle-tokometer-tps
pi install git:github.com/MiguezPablo/gentle-tokometer-tps
```

## Metrics

- **TPS** — output tokens divided by the time assistant messages spent streaming, from each message's first nonempty delta to that message's end. Tool execution and the wait for the first token do not dilute it.
- **TTFT** — time from the start of the run to the first nonempty text, thinking or tool-call delta. It is run-level latency, including initial preparation, not HTTP-only latency.
- **out / in** — output and input tokens for the run. Counts below 1,000 stay exact; larger counts use `k` with at most one decimal.
- **cache r/w** — cache read and cache write tokens.
- **hit** — `read / (input + read + write)` across the run.
- **total** — total tokens reported by the provider.
- **trailing time** — wall-clock duration of the whole run.

A missing value, an older entry without the data, or a run where no message streamed tokens shows `-`. The line is stored as a session entry, so it is never sent to the model and it reappears when a session is resumed.

## License

MIT
