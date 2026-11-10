import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_CONFIG, type TokometerConfig } from "../src/config.ts";
import {
	SETTINGS,
	USAGE,
	applySetting,
	currentValue,
	describeConfig,
	parseCommandArgs,
	settingRows,
} from "../src/menu.ts";

const base: TokometerConfig = { ...DEFAULT_CONFIG };

test("toggles TTFT off and on, keeping the other settings", () => {
	const off = applySetting({ ttft: true, hit: false, tps: "wall" }, "ttft", "off");
	assert.deepEqual(off, { ttft: false, hit: false, tps: "wall" });
	assert.deepEqual(applySetting(off!, "ttft", "on"), { ttft: true, hit: false, tps: "wall" });
});

test("toggles the cache hit percentage off and on, keeping the other settings", () => {
	const off = applySetting({ ttft: false, hit: true, tps: "e2e" }, "hit", "off");
	assert.deepEqual(off, { ttft: false, hit: false, tps: "e2e" });
	assert.deepEqual(applySetting(off!, "hit", "on"), { ttft: false, hit: true, tps: "e2e" });
});

test("selects each TPS mode, keeping the other settings", () => {
	for (const tps of ["stream", "e2e", "wall"] as const) {
		assert.deepEqual(applySetting({ ttft: true, hit: true, tps: "stream" }, "tps", tps), {
			ttft: true,
			hit: true,
			tps,
		});
	}
});

test("accepts values in any case and with surrounding spaces", () => {
	assert.deepEqual(applySetting(base, "ttft", " OFF "), { ...base, ttft: false });
	assert.deepEqual(applySetting(base, "tps", "Wall"), { ...base, tps: "wall" });
});

test("rejects an unknown setting or value", () => {
	assert.equal(applySetting(base, "ttft", "maybe"), undefined);
	assert.equal(applySetting(base, "tps", "fastest"), undefined);
	assert.equal(applySetting(base, "hit", "1"), undefined);
	assert.equal(applySetting(base, "colour", "on"), undefined);
});

test("shows the current value of every setting in the menu rows", () => {
	const rows = settingRows({ ttft: false, hit: true, tps: "e2e" });
	assert.deepEqual(
		rows.map((row) => [row.id, row.label, row.currentValue]),
		[
			["ttft", "TTFT", "off"],
			["hit", "Cache hit %", "on"],
			["tps", "TPS mode", "e2e"],
		],
	);
	assert.deepEqual(rows.map((row) => row.values), [["on", "off"], ["on", "off"], ["e2e", "stream", "wall"]]);
});

test("describes each TPS mode with its own measurement window", () => {
	const describe = (value: string) => SETTINGS.find((spec) => spec.id === "tps")!.describe(value);
	assert.match(describe("stream"), /first delta to message_end/);
	assert.match(describe("e2e"), /message_start to message_end/);
	assert.match(describe("e2e"), /first-token wait/);
	assert.match(describe("e2e"), /default/i);
	assert.match(describe("wall"), /wall time/);
	assert.match(describe("wall"), /tool execution/);
});

test("presents e2e as the default, first TPS value", () => {
	assert.equal(DEFAULT_CONFIG.tps, "e2e");
	assert.deepEqual(SETTINGS.find((spec) => spec.id === "tps")!.values, ["e2e", "stream", "wall"]);
	const rows = settingRows(DEFAULT_CONFIG);
	assert.equal(rows.find((row) => row.id === "tps")!.currentValue, "e2e");
	assert.match(rows.find((row) => row.id === "tps")!.description, /default/i);
});

test("summarizes the config in effect for the non-interactive notification", () => {
	assert.equal(
		describeConfig({ ttft: true, hit: false, tps: "wall" }),
		"TTFT on, cache hit % off, TPS mode wall",
	);
});

test("reads the setting and value arguments", () => {
	assert.deepEqual(parseCommandArgs(""), { kind: "menu" });
	assert.deepEqual(parseCommandArgs("   "), { kind: "menu" });
	assert.deepEqual(parseCommandArgs("ttft off"), { kind: "set", setting: "ttft", value: "off" });
	assert.deepEqual(parseCommandArgs(" HIT On "), { kind: "set", setting: "hit", value: "on" });
	assert.deepEqual(parseCommandArgs("tps wall"), { kind: "set", setting: "tps", value: "wall" });
});

test("rejects arguments that do not name one known setting and value", () => {
	for (const args of ["ttft", "ttft maybe", "ttft on off", "colour on", "tps fastest", "menu"]) {
		assert.deepEqual(parseCommandArgs(args), { kind: "invalid" }, `expected ${JSON.stringify(args)} to be invalid`);
	}
});

test("usage lists every valid setting and value", () => {
	assert.match(USAGE, /\/tokometer \[ttft on\|off\]/);
	assert.match(USAGE, /hit on\|off/);
	assert.match(USAGE, /tps stream\|e2e\|wall/);
	assert.equal(currentValue({ ttft: true, hit: false, tps: "stream" }, "hit"), "off");
});
