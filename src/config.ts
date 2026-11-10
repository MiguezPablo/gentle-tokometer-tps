/**
 * Persisted user configuration of the tokometer line, as JSON in Pi's agent
 * directory. No Pi runtime imports: the path is injected by the caller, so this
 * module stays testable outside Pi.
 *
 * A missing, unreadable or malformed file never breaks the extension: every field
 * falls back to its default on its own, and unknown keys are ignored.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** How TPS is measured. */
export type TpsMode = "stream" | "e2e" | "wall";

/** Valid TPS modes, in the order the command menu shows them. */
export const TPS_MODES: readonly TpsMode[] = ["stream", "e2e", "wall"];

/** Persistent user preferences for the tokometer line. */
export interface TokometerConfig {
	/** Show the `TTFT …` latency segment. */
	ttft: boolean;
	/** Show the `(…% hit)` cache hit rate. */
	hit: boolean;
	/** Which time window TPS divides output tokens by. */
	tps: TpsMode;
}

/** Configuration used when nothing is stored or a field is invalid. */
export const DEFAULT_CONFIG: TokometerConfig = { ttft: true, hit: true, tps: "stream" };

/** File name inside Pi's agent directory. */
export const CONFIG_FILE_NAME = "gentle-tokometer-tps.json";

export function isTpsMode(value: unknown): value is TpsMode {
	return typeof value === "string" && (TPS_MODES as readonly string[]).includes(value);
}

/**
 * Coerces arbitrary parsed JSON into a usable config, field by field: a valid
 * field is kept, an invalid or missing one falls back to its default.
 */
export function normalizeConfig(raw: unknown): TokometerConfig {
	const source = typeof raw === "object" && raw !== null && !Array.isArray(raw)
		? raw as Record<string, unknown>
		: {};
	return {
		ttft: typeof source.ttft === "boolean" ? source.ttft : DEFAULT_CONFIG.ttft,
		hit: typeof source.hit === "boolean" ? source.hit : DEFAULT_CONFIG.hit,
		tps: isTpsMode(source.tps) ? source.tps : DEFAULT_CONFIG.tps,
	};
}

/** Reads the config at `path`; never throws, returning the defaults on any problem. */
export function loadConfig(path: string): TokometerConfig {
	try {
		return normalizeConfig(JSON.parse(readFileSync(path, "utf-8")));
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

/** Writes the config at `path` as pretty JSON, creating the parent directory. */
export function saveConfig(path: string, config: TokometerConfig): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`);
}

/** Path of the config file inside the given Pi agent directory. */
export function configFilePath(agentDir: string): string {
	return join(agentDir, CONFIG_FILE_NAME);
}

let current: TokometerConfig = { ...DEFAULT_CONFIG };

/**
 * Config the renderers must use right now. Entry renderers call this instead of
 * capturing a value, so a change also reapplies to lines already on screen.
 */
export function getConfig(): TokometerConfig {
	return { ...current };
}

/** Replaces the config in memory; the caller persists it with `saveConfig`. */
export function setConfig(config: TokometerConfig): void {
	current = normalizeConfig(config);
}
