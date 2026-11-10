/**
 * The `/tokometer` settings: one row per setting, the pure mapping from a setting
 * id plus a chosen value to the next config, and the argument parser used by the
 * command. No Pi runtime imports: the extension, the menu component and the tests
 * share this module.
 */

import { isTpsMode, normalizeConfig, type TokometerConfig } from "./config.ts";

/** Settings the command can change. */
export type SettingId = "ttft" | "hit" | "tps";

/** One setting, its values in menu cycle order and what each value does. */
export interface SettingSpec {
	id: SettingId;
	/** Row label in the menu. */
	label: string;
	/** Values Enter/Space cycles through, in display order. */
	values: readonly string[];
	/** One-line explanation of a value, shown while its row is selected. */
	describe(value: string): string;
}

/** Every setting, in the order the menu shows them. */
export const SETTINGS: readonly SettingSpec[] = [
	{
		id: "ttft",
		label: "TTFT",
		values: ["on", "off"],
		describe: (value) =>
			value === "on"
				? "Shows the run-level time to the first token."
				: "Hides the TTFT segment.",
	},
	{
		id: "hit",
		label: "Cache hit %",
		values: ["on", "off"],
		describe: (value) =>
			value === "on"
				? "Shows cache reads as a share of all input tokens."
				: "Hides the hit percentage and keeps cache read/write.",
	},
	{
		id: "tps",
		label: "TPS mode",
		values: ["stream", "e2e", "wall"],
		describe: (value) => {
			if (value === "e2e") return "Out over message_start to message_end per message: includes each request's first-token wait.";
			if (value === "wall") return "Out over the whole run's wall time: includes tool execution.";
			return "Out over each message's first delta to message_end: pure decode speed.";
		},
	},
];

/** A row of Pi's `SettingsList`, structurally compatible with its `SettingItem`. */
export interface SettingRow {
	id: SettingId;
	label: string;
	currentValue: string;
	values: string[];
	description: string;
}

/** The command-line usage listed when the arguments are not understood. */
export const USAGE =
	"Usage: /tokometer [ttft on|off] [hit on|off] [tps stream|e2e|wall]. Run /tokometer without arguments to open the menu.";

/** What a command invocation asks for. */
export type CommandAction =
	| { kind: "menu" }
	| { kind: "set"; setting: SettingId; value: string }
	| { kind: "invalid" };

function specOf(setting: string): SettingSpec | undefined {
	return SETTINGS.find((spec) => spec.id === setting);
}

/** The value a setting currently has, as shown in the menu. */
export function currentValue(config: TokometerConfig, setting: SettingId): string {
	if (setting === "tps") return config.tps;
	return config[setting] ? "on" : "off";
}

/** Explanation of one value of one setting; empty for an unknown value. */
export function describeSetting(setting: SettingId, value: string): string {
	return specOf(setting)?.describe(value) ?? "";
}

/** Rows of the settings menu for the config in effect. */
export function settingRows(config: TokometerConfig): SettingRow[] {
	return SETTINGS.map((spec) => ({
		id: spec.id,
		label: spec.label,
		currentValue: currentValue(config, spec.id),
		values: [...spec.values],
		description: spec.describe(currentValue(config, spec.id)),
	}));
}

/**
 * The config that results from giving `setting` the value `value`, or undefined
 * when the setting or the value is unknown. The other settings are preserved.
 */
export function applySetting(
	config: TokometerConfig,
	setting: string,
	value: string,
): TokometerConfig | undefined {
	const spec = specOf(setting);
	const normalized = value.trim().toLowerCase();
	if (!spec || !spec.values.includes(normalized)) return undefined;
	const next = normalizeConfig(config);
	if (spec.id === "tps") return isTpsMode(normalized) ? { ...next, tps: normalized } : undefined;
	return { ...next, [spec.id]: normalized === "on" };
}

/** One line with the config in effect, used when no menu can be opened. */
export function describeConfig(config: TokometerConfig): string {
	return `TTFT ${currentValue(config, "ttft")}, cache hit % ${currentValue(config, "hit")}, TPS mode ${config.tps}`;
}

/** Reads `/tokometer <setting> <value>` arguments; anything else is invalid. */
export function parseCommandArgs(args: string): CommandAction {
	const tokens = args.trim().split(/\s+/).filter((token) => token.length > 0);
	if (tokens.length === 0) return { kind: "menu" };
	if (tokens.length !== 2) return { kind: "invalid" };

	const setting = tokens[0]!.toLowerCase();
	const value = tokens[1]!.toLowerCase();
	const spec = specOf(setting);
	if (!spec || !spec.values.includes(value)) return { kind: "invalid" };
	return { kind: "set", setting: spec.id, value };
}
