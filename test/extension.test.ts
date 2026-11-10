import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import extension from "../extensions/gentle-tokometer-tps.ts";
import { CONFIG_FILE_NAME, DEFAULT_CONFIG, getConfig, setConfig, type TokometerConfig } from "../src/config.ts";
import { ENTRY_TYPE, LEGACY_ENTRY_TYPES, formatTurnStats, type TurnStats } from "../src/format.ts";

type Handler = (event: unknown, ctx: unknown) => void;
type Renderer = (entry: { data?: TurnStats }, options: unknown, theme: unknown) => { text: string } | undefined;

const theme = { fg: (_color: string, text: string) => text };

function createFakePi() {
	const handlers = new Map<string, Handler>();
	const entries: Array<{ type: string; data: unknown }> = [];
	const renderers = new Map<string, Renderer>();
	const pi = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
		},
		appendEntry: (type: string, data: unknown) => {
			entries.push({ type, data });
		},
		registerEntryRenderer: (type: string, renderer: Renderer) => {
			renderers.set(type, renderer);
		},
	};
	return { pi: pi as unknown as ExtensionAPI, handlers, entries, renderers };
}

const tuiContext = { mode: "tui" };

/**
 * Loads the extension with a fake Pi API and without the subagent marker, so the
 * wiring runs the same way it does in a parent agent. The extension resolves its
 * config from Pi's agent dir, so `PI_CODING_AGENT_DIR` points at a throwaway
 * directory: the real agent dir is never read or written. Previous env values are
 * restored and the throwaway directory removed after the test.
 */
function loadExtension(t: { after(fn: () => void): void }, config?: unknown) {
	const agentDir = mkdtempSync(join(tmpdir(), "tokometer-agent-"));
	if (config !== undefined) writeFileSync(join(agentDir, CONFIG_FILE_NAME), JSON.stringify(config));

	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previous = process.env.GENTLE_PI_AGENTS_CHILD;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.GENTLE_PI_AGENTS_CHILD;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previous !== undefined) process.env.GENTLE_PI_AGENTS_CHILD = previous;
		setConfig(DEFAULT_CONFIG);
		rmSync(agentDir, { recursive: true, force: true });
	});

	const fake = createFakePi();
	extension(fake.pi);
	return fake;
}

function emit(handlers: Map<string, Handler>, event: string, payload: unknown, ctx: unknown = tuiContext): void {
	const handler = handlers.get(event);
	assert.ok(handler, `expected a handler for ${event}`);
	handler(payload, ctx);
}

function assistantMessage(usage: Record<string, number> | undefined) {
	return { role: "assistant", usage };
}

test("appends one gentle-tokometer-tps entry with the run stats", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
	const { handlers, entries } = loadExtension(t);

	emit(handlers, "agent_start", {});
	t.mock.timers.tick(500);
	emit(handlers, "message_start", { message: assistantMessage(undefined) });
	t.mock.timers.tick(300);
	emit(handlers, "message_update", { assistantMessageEvent: { type: "text_delta", delta: "" } });
	emit(handlers, "message_update", { assistantMessageEvent: { type: "text_delta", delta: "hi" } });
	t.mock.timers.tick(700);
	emit(handlers, "message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "hm" } });
	t.mock.timers.tick(400);
	emit(handlers, "message_end", {
		message: assistantMessage({ output: 100, input: 50, cacheRead: 10, cacheWrite: 5, totalTokens: 165 }),
	});
	t.mock.timers.tick(100);
	emit(handlers, "agent_end", {});

	assert.deepEqual(entries, [
		{
			type: "gentle-tokometer-tps",
			data: {
				output: 100,
				input: 50,
				cacheRead: 10,
				cacheWrite: 5,
				total: 165,
				streamMs: 1_100,
				e2eMs: 1_400,
				wallMs: 2_000,
				ttftMs: 800,
			},
		},
	]);
});

test("counts tokens but no stream time for a message without deltas", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 0 });
	const { handlers, entries } = loadExtension(t);

	emit(handlers, "agent_start", {});
	t.mock.timers.tick(250);
	emit(handlers, "message_start", { message: assistantMessage(undefined) });
	t.mock.timers.tick(750);
	emit(handlers, "message_end", {
		message: assistantMessage({ output: 12, input: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }),
	});
	emit(handlers, "agent_end", {});

	assert.equal(entries.length, 1);
	const data = entries[0]!.data as TurnStats;
	assert.equal(data.streamMs, 0);
	assert.equal(data.e2eMs, 750);
	assert.equal(data.total, 15);
	assert.equal(data.ttftMs, undefined);
	assert.equal(data.wallMs, 1_000);
	assert.equal(formatTurnStats(data), "TPS - tok/s. TTFT -, out 12, in 3, cache r/w 0/0 (0.0% hit), total 15, 1.0s");
});

test("sums the e2e time of every assistant message", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 0 });
	const { handlers, entries } = loadExtension(t);

	emit(handlers, "agent_start", {});
	// First message: 1200ms end to end, 700ms of it streaming.
	t.mock.timers.tick(200);
	emit(handlers, "message_start", { message: assistantMessage(undefined) });
	t.mock.timers.tick(500);
	emit(handlers, "message_update", { assistantMessageEvent: { type: "text_delta", delta: "a" } });
	t.mock.timers.tick(700);
	emit(handlers, "message_end", {
		message: assistantMessage({ output: 10, input: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }),
	});
	// A tool runs outside any message: it counts for wall time only.
	t.mock.timers.tick(3_000);
	// Second message: 900ms end to end, 400ms of it streaming.
	emit(handlers, "message_start", { message: assistantMessage(undefined) });
	t.mock.timers.tick(500);
	emit(handlers, "message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "b" } });
	t.mock.timers.tick(400);
	emit(handlers, "message_end", {
		message: assistantMessage({ output: 20, input: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 25 }),
	});
	emit(handlers, "agent_end", {});

	assert.equal(entries.length, 1);
	const data = entries[0]!.data as TurnStats;
	assert.equal(data.streamMs, 1_100);
	assert.equal(data.e2eMs, 2_100);
	assert.equal(data.wallMs, 5_300);
});

test("does not append an entry when the run totals zero tokens", (t) => {
	const { handlers, entries } = loadExtension(t);

	emit(handlers, "agent_start", {});
	emit(handlers, "agent_end", {});

	assert.deepEqual(entries, []);
});

test("does not append an entry outside TUI mode", (t) => {
	const { handlers, entries } = loadExtension(t);

	emit(handlers, "agent_start", {});
	emit(handlers, "message_end", {
		message: assistantMessage({ output: 1, input: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }),
	});
	emit(handlers, "agent_end", {}, { mode: "print" });

	assert.deepEqual(entries, []);
});

test("registers the renderer for the current and the legacy entry type", (t) => {
	const { renderers } = loadExtension(t);

	assert.equal(ENTRY_TYPE, "gentle-tokometer-tps");
	assert.deepEqual(LEGACY_ENTRY_TYPES, ["turn-stats"]);
	assert.deepEqual([...renderers.keys()].sort(), ["gentle-tokometer-tps", "turn-stats"]);
});

test("renders stored entries of either type with the same dim line", (t) => {
	const { renderers } = loadExtension(t);
	const stats: TurnStats = {
		output: 470,
		input: 1900,
		cacheRead: 425700,
		cacheWrite: 0,
		total: 428100,
		streamMs: 24227,
		wallMs: 24200,
		ttftMs: 1200,
	};
	const expected =
		"TPS 19.4 tok/s. TTFT 1.2s, out 470, in 1.9k, cache r/w 425.7k/0 (99.6% hit), total 428.1k, 24.2s";

	for (const type of [ENTRY_TYPE, ...LEGACY_ENTRY_TYPES]) {
		const renderer = renderers.get(type);
		assert.ok(renderer, `expected a renderer for ${type}`);
		const rendered = renderer({ data: stats }, {}, theme);
		assert.ok(rendered, `expected ${type} to render`);
		assert.equal(rendered.text, expected);
		assert.equal(renderers.get(type)!({}, {}, theme), undefined);
	}
});

test("renders already stored entries with the config in effect at render time", (t) => {
	setConfig(DEFAULT_CONFIG);
	const { renderers } = loadExtension(t);
	const stats: TurnStats = {
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

	for (const type of [ENTRY_TYPE, ...LEGACY_ENTRY_TYPES]) {
		const renderer = renderers.get(type);
		assert.ok(renderer, `expected a renderer for ${type}`);
		assert.equal(
			renderer({ data: stats }, {}, theme)?.text,
			"TPS 19.4 tok/s. TTFT 1.2s, out 470, in 1.9k, cache r/w 425.7k/0 (99.6% hit), total 428.1k, 24.2s",
		);

		setConfig({ ttft: false, hit: false, tps: "e2e" });
		assert.equal(getConfig().tps, "e2e");
		assert.equal(
			renderer({ data: stats }, {}, theme)?.text,
			"TPS(e2e) 15.0 tok/s. out 470, in 1.9k, cache r/w 425.7k/0, total 428.1k, 24.2s",
		);
		setConfig(DEFAULT_CONFIG);
	}
});

test("loads the config file from the agent dir when the extension loads", (t) => {
	const { renderers } = loadExtension(t, { ttft: false, hit: false, tps: "wall" });
	assert.deepEqual(getConfig(), { ttft: false, hit: false, tps: "wall" });

	const stats: TurnStats = {
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
	assert.equal(
		renderers.get(ENTRY_TYPE)!({ data: stats }, {}, theme)?.text,
		"TPS(wall) 19.4 tok/s. out 470, in 1.9k, cache r/w 425.7k/0, total 428.1k, 24.2s",
	);
});

test("falls back to the defaults when the stored config is unusable", (t) => {
	const { renderers } = loadExtension(t, { ttft: "nope", hit: 1, tps: "fastest" });
	assert.deepEqual(getConfig(), DEFAULT_CONFIG);
	assert.ok(renderers.has(ENTRY_TYPE));
});

test("does nothing in subagent children", (t) => {
	const previous = process.env.GENTLE_PI_AGENTS_CHILD;
	process.env.GENTLE_PI_AGENTS_CHILD = "1";
	t.after(() => {
		if (previous === undefined) delete process.env.GENTLE_PI_AGENTS_CHILD;
		else process.env.GENTLE_PI_AGENTS_CHILD = previous;
	});

	const { pi, handlers, renderers, entries } = createFakePi();
	extension(pi);

	assert.equal(handlers.size, 0);
	assert.equal(renderers.size, 0);
	assert.deepEqual(entries, []);
});
