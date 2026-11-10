/**
 * Tokometer TPS: after each agent run, shows a dim line in the transcript with
 * output speed and token usage, e.g.
 *
 *   TPS 19.4 tok/s. TTFT 1.2s, out 470, in 1.9k, cache r/w 425.7k/0 (99.6% hit), total 428.1k, 24.2s
 *
 * Token counts below 1,000 stay exact; larger counts use k with at most one decimal.
 *
 * Three TPS modes are stored, and the configured one is displayed with its own
 * label: `TPS …` (stream, the default), `TPS(e2e) …` and `TPS(wall) …`. All divide
 * the turn's output tokens by a different window:
 * - stream: time assistant messages spent streaming, measured per message from its
 *   first nonempty text/thinking/tool-call delta to message_end. Neither tool
 *   execution nor each message's wait for its first token dilutes it; a message
 *   with no nonempty delta adds tokens but no time.
 * - e2e: time assistant messages spent from message_start to message_end, so the
 *   wait for each request's first token is included.
 * - wall: the wall-clock duration of the whole run, including tool execution.
 * A mode whose window is zero or absent from the entry (older entries have no e2e
 * time) displays a dash.
 *
 * TTFT measures agent_start to the first nonempty text/thinking/tool-call delta.
 * It is run-level latency, including initial preparation, not HTTP-only latency.
 * Cache hit percentage is read / (input + cacheRead + cacheWrite), across the run.
 * Missing TTFT (including older entries) and empty input display a dash.
 * Thinking tokens count as output when the provider reports them that way.
 *
 * The TTFT segment and the hit percentage can be hidden with the settings stored in
 * `<agent-dir>/gentle-tokometer-tps.json` (see `src/config.ts`); the renderers read
 * the in-memory config, so a change applies to lines already on screen.
 * The trailing time is the wall-clock duration of the whole run.
 * The line is stored with appendEntry, so it is never sent to the model.
 * Entries written by earlier versions under the legacy entry type keep rendering
 * with the same line.
 */

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { configFilePath, getConfig, loadConfig, setConfig } from "../src/config.ts";
import { ENTRY_TYPE, LEGACY_ENTRY_TYPES, formatTurnStats, type TurnStats } from "../src/format.ts";

const ENTRY_TYPES = [ENTRY_TYPE, ...LEGACY_ENTRY_TYPES];

export default function tokometerTps(pi: ExtensionAPI) {
	// Subagent children have no transcript worth annotating.
	if (process.env.GENTLE_PI_AGENTS_CHILD !== undefined) return;

	// Load the stored settings once; renderers read the live config, so updating it
	// (the /tokometer command does) re-renders entries already in the transcript.
	setConfig(loadConfig(configFilePath(getAgentDir())));

	let run: (TurnStats & { startedAt: number }) | undefined;
	let firstDeltaAt: number | undefined;
	let messageStartedAt: number | undefined;

	for (const entryType of ENTRY_TYPES) {
		pi.registerEntryRenderer<TurnStats>(entryType, (entry, _options, theme) => {
			if (!entry.data) return undefined;
			return new Text(theme.fg("dim", formatTurnStats(entry.data, getConfig())), 1, 0);
		});
	}

	pi.on("agent_start", () => {
		run = {
			output: 0,
			input: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
			streamMs: 0,
			e2eMs: 0,
			wallMs: 0,
			startedAt: Date.now(),
		};
		firstDeltaAt = undefined;
		messageStartedAt = undefined;
	});

	pi.on("message_start", (event) => {
		if (event.message.role !== "assistant") return;
		firstDeltaAt = undefined;
		messageStartedAt = Date.now();
	});

	pi.on("message_update", (event) => {
		if (!run) return;
		const delta = event.assistantMessageEvent;
		if ((delta.type !== "text_delta" && delta.type !== "thinking_delta" && delta.type !== "toolcall_delta")
			|| delta.delta.length === 0) return;
		const now = Date.now();
		firstDeltaAt ??= now;
		run.ttftMs ??= now - run.startedAt;
	});

	pi.on("message_end", (event) => {
		const message = event.message;
		if (!run || message.role !== "assistant") return;
		const endedAt = Date.now();
		if (firstDeltaAt !== undefined) run.streamMs += endedAt - firstDeltaAt;
		if (messageStartedAt !== undefined) run.e2eMs = (run.e2eMs ?? 0) + (endedAt - messageStartedAt);
		firstDeltaAt = undefined;
		messageStartedAt = undefined;
		const usage = message.usage;
		if (!usage) return;
		run.output += usage.output ?? 0;
		run.input += usage.input ?? 0;
		run.cacheRead += usage.cacheRead ?? 0;
		run.cacheWrite += usage.cacheWrite ?? 0;
		run.total += usage.totalTokens ?? 0;
	});

	pi.on("agent_end", (_event, ctx) => {
		const finished = run;
		run = undefined;
		if (!finished || ctx.mode !== "tui" || finished.total === 0) return;
		const { startedAt, ...stats } = finished;
		pi.appendEntry<TurnStats>(ENTRY_TYPE, { ...stats, wallMs: Date.now() - startedAt });
	});
}
