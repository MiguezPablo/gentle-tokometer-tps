import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_CONFIG } from "../src/config.ts";
import { formatTurnStats, type TurnStats } from "../src/format.ts";

const base: TurnStats = {
	output: 0,
	input: 0,
	cacheRead: 0,
	cacheWrite: 0,
	total: 0,
	streamMs: 0,
	wallMs: 0,
};

const reference: TurnStats = {
	output: 470,
	input: 1900,
	cacheRead: 425700,
	cacheWrite: 0,
	total: 428100,
	streamMs: 24227,
	e2eMs: 31333,
	wallMs: 24200,
	ttftMs: 1200,
};

/** Everything after the TPS segment, identical in every mode. */
const TAIL = "TTFT 1.2s, out 470, in 1.9k, cache r/w 425.7k/0 (99.6% hit), total 428.1k, 24.2s";

test("formats the default e2e line without a parenthesized label", () => {
	assert.equal(formatTurnStats(reference), `TPS 15.0 tok/s. ${TAIL}`);
	// No config argument and DEFAULT_CONFIG must agree.
	assert.equal(formatTurnStats(reference, DEFAULT_CONFIG), formatTurnStats(reference));
});

test("labels the stream mode and keeps the decode-speed numbers", () => {
	assert.equal(formatTurnStats(reference, { ...DEFAULT_CONFIG, tps: "stream" }), `TPS(stream) 19.4 tok/s. ${TAIL}`);
});

test("labels the wall-clock mode and divides by the run duration", () => {
	const stats: TurnStats = { ...reference, output: 300, wallMs: 24800 };
	assert.equal(
		formatTurnStats(stats, { ...DEFAULT_CONFIG, tps: "wall" }),
		"TPS(wall) 12.1 tok/s. TTFT 1.2s, out 300, in 1.9k, cache r/w 425.7k/0 (99.6% hit), total 428.1k, 24.8s",
	);
});

test("falls back to the stream value with the stream label when e2e time is absent", () => {
	const { e2eMs: _omitted, ...withoutE2e } = reference;
	assert.equal(formatTurnStats(withoutE2e), `TPS(stream) 19.4 tok/s. ${TAIL}`);
	assert.equal(formatTurnStats(withoutE2e, { ...DEFAULT_CONFIG, tps: "e2e" }), `TPS(stream) 19.4 tok/s. ${TAIL}`);
	// A legacy entry with no stream time either shows the dash under the stream label.
	assert.equal(
		formatTurnStats({ ...withoutE2e, streamMs: 0 }),
		`TPS(stream) - tok/s. ${TAIL}`,
	);
});

test("does not fall back when the e2e time is present but zero", () => {
	assert.equal(formatTurnStats({ ...reference, e2eMs: 0 }), `TPS - tok/s. ${TAIL}`);
	// Zero stream time is irrelevant while e2e time exists.
	assert.equal(formatTurnStats({ ...reference, streamMs: 0 }), "TPS 15.0 tok/s. " + TAIL);
});

test("keeps counts below 1000 exact", () => {
	const line = formatTurnStats({ ...base, output: 470, input: 999, cacheRead: 5, cacheWrite: 0, total: 999, streamMs: 1000, e2eMs: 1000, wallMs: 1000 });
	assert.match(line, /out 470, in 999, cache r\/w 5\/0 /);
	assert.match(line, /total 999, /);
});

test("uses k with at most one decimal from 1000 up", () => {
	const cases: Array<[number, string]> = [
		[1000, "1k"],
		[1500, "1.5k"],
		[1999, "2k"],
		[1234567, "1234.6k"],
	];
	for (const [value, expected] of cases) {
		const line = formatTurnStats({ ...base, total: value, streamMs: 1000, e2eMs: 1000, wallMs: 1000 });
		assert.ok(line.includes(`total ${expected}, `), `total ${value} should render as ${expected}: ${line}`);
	}
});

test("displays a dash for a missing TTFT", () => {
	const line = formatTurnStats({ ...base, output: 10, total: 10, streamMs: 2000, e2eMs: 2000, wallMs: 5000 });
	assert.equal(line, "TPS 5.0 tok/s. TTFT -, out 10, in 0, cache r/w 0/0 (- hit), total 10, 5.0s");
});

test("displays a dash for TPS when no message streamed tokens", () => {
	const line = formatTurnStats({ ...base, output: 10, total: 10, streamMs: 2000, e2eMs: 0, wallMs: 5000, ttftMs: 1000 });
	assert.equal(line, "TPS - tok/s. TTFT 1.0s, out 10, in 0, cache r/w 0/0 (- hit), total 10, 5.0s");
});

test("displays a dash for the cache hit rate when there is no input", () => {
	const line = formatTurnStats({ ...base, output: 10, total: 10, streamMs: 1000, e2eMs: 1000, wallMs: 1000, ttftMs: 500 });
	assert.ok(line.includes("cache r/w 0/0 (- hit), "), line);
});

test("computes the cache hit rate over input, cache read and cache write", () => {
	const line = formatTurnStats({
		...base,
		input: 100,
		cacheRead: 300,
		cacheWrite: 100,
		total: 500,
		streamMs: 1000,
		e2eMs: 1000,
		wallMs: 1000,
		ttftMs: 500,
	});
	assert.ok(line.includes("(60.0% hit)"), line);
});

test("drops the TTFT segment when the ttft toggle is off", () => {
	assert.equal(
		formatTurnStats(reference, { ...DEFAULT_CONFIG, ttft: false }),
		"TPS 15.0 tok/s. out 470, in 1.9k, cache r/w 425.7k/0 (99.6% hit), total 428.1k, 24.2s",
	);
	// The toggle removes the segment even when TTFT is missing instead of leaving a dash.
	const withoutTtft = { ...reference, ttftMs: undefined };
	assert.equal(
		formatTurnStats(withoutTtft, { ...DEFAULT_CONFIG, ttft: false }),
		"TPS 15.0 tok/s. out 470, in 1.9k, cache r/w 425.7k/0 (99.6% hit), total 428.1k, 24.2s",
	);
});

test("drops the hit percentage when the hit toggle is off", () => {
	assert.equal(
		formatTurnStats(reference, { ...DEFAULT_CONFIG, hit: false }),
		"TPS 15.0 tok/s. TTFT 1.2s, out 470, in 1.9k, cache r/w 425.7k/0, total 428.1k, 24.2s",
	);
});

test("combines both toggles off with a labelled TPS mode", () => {
	const stats: TurnStats = { ...reference, output: 300, wallMs: 24800 };
	assert.equal(
		formatTurnStats(stats, { ttft: false, hit: false, tps: "wall" }),
		"TPS(wall) 12.1 tok/s. out 300, in 1.9k, cache r/w 425.7k/0, total 428.1k, 24.8s",
	);
});
