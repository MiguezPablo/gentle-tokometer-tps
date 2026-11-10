/**
 * Tokometer TPS: after each agent run, shows a dim line in the transcript with
 * output speed and token usage, e.g.
 *
 *   TPS 15.0 tok/s. TTFT 1.2s, out 470, in 1.9k, cache r/w 425.7k/0 (99.6% hit), total 428.1k, 24.2s
 *
 * Token counts below 1,000 stay exact; larger counts use k with at most one decimal.
 *
 * Three TPS modes are stored, and the configured one is displayed with its own
 * label: `TPS …` (e2e, the default, no parenthesis), `TPS(stream) …` and
 * `TPS(wall) …`. All divide the turn's output tokens by a different window:
 * - e2e: time assistant messages spent from message_start to message_end, so the
 *   wait for each request's first token is included.
 * - stream: time assistant messages spent streaming, measured per message from its
 *   first nonempty text/thinking/tool-call delta to message_end. Neither tool
 *   execution nor each message's wait for its first token dilutes it; a message
 *   with no nonempty delta adds tokens but no time. It overstates speed whenever a
 *   provider hides thinking, because the hidden reasoning arrives as one burst of
 *   deltas near message_end, which is why e2e is the default.
 * - wall: the wall-clock duration of the whole run, including tool execution.
 * In e2e mode an entry without e2e time (turn-stats entries and entries written
 * before 0.2.0) shows the stream value under the `TPS(stream)` label instead of a
 * dash; an entry whose window is present but zero, or whose fallback window is
 * zero, displays a dash.
 *
 * TTFT measures agent_start to the first nonempty text/thinking/tool-call delta.
 * It is run-level latency, including initial preparation, not HTTP-only latency.
 * Cache hit percentage is read / (input + cacheRead + cacheWrite), across the run.
 * Missing TTFT (including older entries) and empty input display a dash.
 * Thinking tokens count as output when the provider reports them that way.
 *
 * The TTFT segment and the hit percentage can be hidden, and the TPS mode chosen,
 * with `/tokometer`: it opens a menu with one row per setting, and also accepts
 * `/tokometer ttft on|off`, `/tokometer hit on|off` and
 * `/tokometer tps stream|e2e|wall` for scripting. Settings persist in
 * `<agent-dir>/gentle-tokometer-tps.json` (see `src/config.ts`); every change
 * updates the in-memory config and the transcript is invalidated, so lines already
 * on screen redraw with the new settings. Without an interactive UI the command
 * reports the config in effect instead of opening the menu.
 * The trailing time is the wall-clock duration of the whole run.
 * The line is stored with appendEntry, so it is never sent to the model.
 * Entries written by earlier versions under the legacy entry type keep rendering
 * with the same line, except that in the default e2e mode they show their stream
 * value labelled `TPS(stream)`, since they store no e2e time.
 */

import {
	getAgentDir,
	getSettingsListTheme,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text } from "@earendil-works/pi-tui";

import { configFilePath, getConfig, loadConfig, saveConfig, setConfig, type TokometerConfig } from "../src/config.ts";
import { ENTRY_TYPE, LEGACY_ENTRY_TYPES, formatTurnStats, type TurnStats } from "../src/format.ts";
import {
	applySetting,
	describeConfig,
	describeSetting,
	parseCommandArgs,
	settingRows,
	USAGE,
} from "../src/menu.ts";

const ENTRY_TYPES = [ENTRY_TYPE, ...LEGACY_ENTRY_TYPES];

export default function tokometerTps(pi: ExtensionAPI) {
	// Subagent children have no transcript worth annotating.
	if (process.env.GENTLE_PI_AGENTS_CHILD !== undefined) return;

	// Load the stored settings once; renderers read the live config, so updating it
	// (the /tokometer command does) re-renders entries already in the transcript.
	const configPath = configFilePath(getAgentDir());
	setConfig(loadConfig(configPath));

	/**
	 * Applies one setting change: the in-memory config changes first, so entries
	 * already on screen show it, then it is written to disk. A failed write is
	 * returned for the caller to report; the in-memory change is never reverted.
	 */
	function changeSetting(setting: string, value: string): { config: TokometerConfig; error?: string } | undefined {
		const next = applySetting(getConfig(), setting, value);
		if (!next) return undefined;
		setConfig(next);
		try {
			saveConfig(configPath, next);
			return { config: next };
		} catch (error) {
			return { config: next, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async function openMenu(ctx: ExtensionCommandContext): Promise<void> {
		await ctx.ui.custom<undefined>((tui, theme, _keybindings, done) => {
			const rows = settingRows(getConfig());
			const container = new Container();
			container.addChild(new Text(theme.fg("accent", theme.bold("Tokometer settings")), 1, 0));

			// One row per setting; each change applies and persists immediately and
			// invalidates the transcript so the lines already shown are re-formatted.
			const list = new SettingsList(
				rows,
				rows.length + 2,
				getSettingsListTheme(),
				(id, newValue) => {
					const change = changeSetting(id, newValue);
					if (!change) return;
					if (change.error) {
						ctx.ui.notify(saveFailure(change.error), "error");
					}
					const row = rows.find((candidate) => candidate.id === id);
					if (row) row.description = describeSetting(row.id, newValue);
					list.updateValue(id, newValue);
					list.invalidate();
					tui.invalidate();
					tui.requestRender();
				},
				() => done(undefined),
			);
			container.addChild(list);

			return {
				// Let PageUp/PageDown page the list instead of scrolling the transcript.
				capturesViewportInput: list.capturesViewportInput,
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					list.handleInput?.(data);
					tui.requestRender();
				},
			};
		});
	}

	function saveFailure(reason: string): string {
		return `Tokometer: could not save the settings to ${configPath} (${reason}). The change applies until this session ends.`;
	}

	pi.registerCommand("tokometer", {
		description: "Tokometer settings: TTFT, cache hit %, TPS mode",
		handler: async (args, ctx) => {
			const action = parseCommandArgs(args);

			if (action.kind === "invalid") {
				ctx.ui.notify(USAGE, "warning");
				return;
			}

			if (action.kind === "set") {
				const change = changeSetting(action.setting, action.value);
				if (!change) {
					ctx.ui.notify(USAGE, "warning");
				} else if (change.error) {
					ctx.ui.notify(saveFailure(change.error), "error");
				} else {
					ctx.ui.notify(`Tokometer: ${describeConfig(change.config)}`, "info");
				}
				return;
			}

			// Without a dialog-capable TUI the menu cannot open, so report the config
			// in effect rather than failing silently.
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify(`Tokometer: ${describeConfig(getConfig())}`, "info");
				return;
			}

			await openMenu(ctx);
		},
	});

	for (const entryType of ENTRY_TYPES) {
		pi.registerEntryRenderer<TurnStats>(entryType, (entry, _options, theme) => {
			if (!entry.data) return undefined;
			const data = entry.data;
			// The line is formatted on every render, so a settings change also reaches
			// entries that were already displayed.
			const text = new Text("", 1, 0);
			let shown: string | undefined;
			return {
				render: (width: number) => {
					const line = theme.fg("dim", formatTurnStats(data, getConfig()));
					if (line !== shown) {
						shown = line;
						text.setText(line);
					}
					return text.render(width);
				},
				invalidate: () => text.invalidate(),
			};
		});
	}

	let run: (TurnStats & { startedAt: number }) | undefined;
	let firstDeltaAt: number | undefined;
	let messageStartedAt: number | undefined;

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
