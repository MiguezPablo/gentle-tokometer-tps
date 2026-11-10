/**
 * Pure formatting of one turn's stats. No Pi runtime imports: the extension
 * entry, tests and future TUI code all share this module.
 */

/** Token and timing totals for a single agent run. */
export interface TurnStats {
	output: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	streamMs: number;
	wallMs: number;
	ttftMs?: number;
}

/** Entry type written to the session by this extension. */
export const ENTRY_TYPE = "gentle-tokometer-tps";

/** Entry types written by earlier versions that must keep rendering. */
export const LEGACY_ENTRY_TYPES = ["turn-stats"];

const fmt = (n: number) => n < 1000 ? n.toLocaleString("en-US") : `${Number((n / 1000).toFixed(1))}k`;

/**
 * Formats the dim transcript line for one turn, e.g.
 *
 *   TPS 19.4 tok/s. TTFT 1.2s, out 470, in 1.9k, cache r/w 425.7k/0 (99.6% hit), total 428.1k, 24.2s
 *
 * Token counts below 1,000 stay exact; larger counts use k with at most one decimal.
 */
export function formatTurnStats(s: TurnStats): string {
	const tps = s.streamMs > 0 ? (s.output / (s.streamMs / 1000)).toFixed(1) : "-";
	const ttft = s.ttftMs === undefined ? "-" : `${(s.ttftMs / 1000).toFixed(1)}s`;
	const inputTotal = s.input + s.cacheRead + s.cacheWrite;
	const hit = inputTotal > 0 ? `${(100 * s.cacheRead / inputTotal).toFixed(1)}%` : "-";
	return `TPS ${tps} tok/s. TTFT ${ttft}, out ${fmt(s.output)}, in ${fmt(s.input)}, `
		+ `cache r/w ${fmt(s.cacheRead)}/${fmt(s.cacheWrite)} (${hit} hit), total ${fmt(s.total)}, `
		+ `${(s.wallMs / 1000).toFixed(1)}s`;
}
