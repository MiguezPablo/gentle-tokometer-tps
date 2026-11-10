import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	CONFIG_FILE_NAME,
	DEFAULT_CONFIG,
	configFilePath,
	getConfig,
	loadConfig,
	saveConfig,
	setConfig,
} from "../src/config.ts";

/** Scratch directory outside the worktree, removed when the test ends. */
async function scratch(t: { after(fn: () => Promise<void>): void }): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "tokometer-config-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

test("defaults to ttft on, hit on and stream TPS", () => {
	assert.deepEqual(DEFAULT_CONFIG, { ttft: true, hit: true, tps: "stream" });
});

test("uses the defaults when the config file is missing", async (t) => {
	const dir = await scratch(t);
	assert.deepEqual(loadConfig(join(dir, "absent.json")), DEFAULT_CONFIG);
});

test("uses the defaults when the path is not a readable file", async (t) => {
	const dir = await scratch(t);
	assert.deepEqual(loadConfig(dir), DEFAULT_CONFIG);
});

test("uses the defaults when the file is not JSON", async (t) => {
	const dir = await scratch(t);
	const path = join(dir, "broken.json");
	await writeFile(path, "{ not json");
	assert.deepEqual(loadConfig(path), DEFAULT_CONFIG);
});

test("uses the defaults when the JSON is not an object", async (t) => {
	const dir = await scratch(t);
	for (const [name, content] of [["null.json", "null"], ["list.json", "[1,2]"], ["string.json", "\"on\""]] as const) {
		const path = join(dir, name);
		await writeFile(path, content);
		assert.deepEqual(loadConfig(path), DEFAULT_CONFIG, name);
	}
});

test("keeps valid fields and falls back per field on wrong types", async (t) => {
	const dir = await scratch(t);
	const path = join(dir, "partial.json");
	await writeFile(path, JSON.stringify({ ttft: false, hit: "yes", tps: "e2e" }));
	assert.deepEqual(loadConfig(path), { ttft: false, hit: true, tps: "e2e" });
});

test("falls back on an unknown TPS mode", async (t) => {
	const dir = await scratch(t);
	const path = join(dir, "mode.json");
	await writeFile(path, JSON.stringify({ tps: "E2E" }));
	assert.deepEqual(loadConfig(path), DEFAULT_CONFIG);
});

test("ignores unknown keys and missing fields", async (t) => {
	const dir = await scratch(t);
	const path = join(dir, "extra.json");
	await writeFile(path, JSON.stringify({ color: "blue", tps: "wall" }));
	assert.deepEqual(loadConfig(path), { ttft: true, hit: true, tps: "wall" });
});

test("saves pretty JSON that loads back unchanged, creating the parent directory", async (t) => {
	const dir = await scratch(t);
	const path = join(dir, "nested", "deeper", CONFIG_FILE_NAME);
	const config = { ttft: false, hit: false, tps: "e2e" } as const;

	saveConfig(path, config);

	const written = await readFile(path, "utf-8");
	assert.equal(written, `${JSON.stringify(config, null, 2)}\n`);
	assert.deepEqual(loadConfig(path), config);
});

test("resolves the config file name inside the given agent directory", () => {
	assert.equal(CONFIG_FILE_NAME, "gentle-tokometer-tps.json");
	assert.equal(configFilePath("/home/user/.gentle-shell/agent"), "/home/user/.gentle-shell/agent/gentle-tokometer-tps.json");
});

test("holds the current config for renderers to read", (t) => {
	t.after(() => setConfig(DEFAULT_CONFIG));

	assert.deepEqual(getConfig(), DEFAULT_CONFIG);
	setConfig({ ttft: false, hit: true, tps: "wall" });
	assert.deepEqual(getConfig(), { ttft: false, hit: true, tps: "wall" });
	// Callers cannot mutate the live config by holding on to the returned object.
	getConfig().ttft = true;
	assert.equal(getConfig().ttft, false);
});
