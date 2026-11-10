/**
 * Pure formatting of one turn's stats. No Pi runtime imports: the extension
 * entry, tests and future TUI code all share this module.
 */

import { DEFAULT_CONFIG, type TpsMode, type TokometerConfig } from "./config.ts";

/** Token and timing totals for a single agent run. */
export interface TurnStats {
	output: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	streamMs: number;
	/** Sum of assistant message_start to message_end spans. Absent in older entries. */
	e2eMs?: number;
	wallMs: number;
	ttftMs?: number;
}

/** Entry type written to the session by this extension. */
export const ENTRY_TYPE = "gentle-tokometer-tps";

/** Entry types written by earlier versions that must keep rendering. */
export const LEGACY_ENTRY_TYPES = ["turn-stats"];

const fmt = (n: number) => n < 1000 ? n.toLocaleString("en-US") : `${Number((n / 1000).toFixed(1))}k`;

/**
 * Label prefix that tells the user which window TPS was measured over. The
 * default mode carries no parenthesis.
 */
const TPS_LABELS: Record<TpsMode, string> = { stream: "TPS(stream)", e2e: "TPS", wall: "TPS(wall)" };

/**
 * The mode actually displayed and the window it divides output tokens by. In e2e
 * mode an entry without e2e time (older entries) shows the stream value under the
 * stream label instead of a dash; an entry whose e2e time is present but zero has
 * no such fallback.
 */
function tpsWindow(s: TurnStats, mode: TpsMode): { mode: TpsMode; ms: number | undefined } {
	if (mode === "e2e") return s.e2eMs === undefined ? { mode: "stream", ms: s.streamMs } : { mode, ms: s.e2eMs };
	if (mode === "wall") return { mode, ms: s.wallMs };
	return { mode, ms: s.streamMs };
}

/**
 * Formats the dim transcript line for one turn, e.g.
 *
 *   TPS 15.0 tok/s. TTFT 1.2s, out 470, in 1.9k, cache r/w 425.7k/0 (99.6% hit), total 428.1k, 24.2s
 *
 * Token counts below 1,000 stay exact; larger counts use k with at most one decimal.
 * `config` hides the TTFT and hit segments and selects the TPS window; the default
 * `e2e` mode is labelled `TPS`, the others `TPS(stream)` and `TPS(wall)` so the
 * reader knows which window is shown. A missing or zero denominator renders a dash.
 */
export function formatTurnStats(s: TurnStats, config: TokometerConfig = DEFAULT_CONFIG): string {
	const window = tpsWindow(s, config.tps);
	const measured = window.ms;
	const tps = measured !== undefined && measured > 0 ? (s.output / (measured / 1000)).toFixed(1) : "-";
	const inputTotal = s.input + s.cacheRead + s.cacheWrite;
	const hit = inputTotal > 0 ? `${(100 * s.cacheRead / inputTotal).toFixed(1)}%` : "-";

	const segments: string[] = [];
	if (config.ttft) segments.push(`TTFT ${s.ttftMs === undefined ? "-" : `${(s.ttftMs / 1000).toFixed(1)}s`}`);
	segments.push(`out ${fmt(s.output)}`);
	segments.push(`in ${fmt(s.input)}`);
	segments.push(`cache r/w ${fmt(s.cacheRead)}/${fmt(s.cacheWrite)}${config.hit ? ` (${hit} hit)` : ""}`);
	segments.push(`total ${fmt(s.total)}`);

	return `${TPS_LABELS[window.mode]} ${tps} tok/s. ${segments.join(", ")}, ${(s.wallMs / 1000).toFixed(1)}s`;
}
