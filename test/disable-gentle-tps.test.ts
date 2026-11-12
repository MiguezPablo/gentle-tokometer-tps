import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "disable-gentle-tps.sh");
const MARKER = "# gentle-tokometer-tps: gentle-tps wrapper";

interface Run {
	status: number | null;
	stdout: string;
	stderr: string;
}

interface Fixture {
	home: string;
	binDir: string;
	wrapperDir: string;
	wrapper: string;
	link: string;
	settings: string;
	backup: string;
	/** Creates `<hash>/node_modules/gentle-pi` with a package.json and a bin entry. */
	addPiRoot(hash: string): string;
	/** Creates the pnpm-style `gentle-shell` shim whose cmd-shim-target points at `hash`. */
	addShim(hash: string): string;
	run(...args: string[]): Run;
	/** Runs the installed wrapper directly, with the fixture environment. */
	runWrapper(...args: string[]): Run;
	/** Runs the script with an explicit PATH, keeping the rest of the fixture environment. */
	runOnPath(path: string, ...args: string[]): Run;
}

function writeSettings(path: string, value: unknown): string {
	const text = `${JSON.stringify(value, null, 2)}\n`;
	writeFileSync(path, text);
	return text;
}

/** Names in `dir` that a settings write left behind, e.g. `settings.json.tmp-123`. */
function tempEntries(dir: string): string[] {
	return readdirSync(dir).filter((name) => name.includes(".tmp"));
}

/** A fake HOME with its own PATH, wrapper dir, agent dir and pnpm-style shim. */
function fixture(t: TestContext): Fixture {
	const home = mkdtempSync(join(tmpdir(), "tokometer-disable-tps-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));

	const binDir = join(home, "bin");
	const wrapperDir = join(home, ".local", "bin");
	const agentDir = join(home, ".gentle-shell", "agent");
	mkdirSync(binDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });

	const wrapper = join(wrapperDir, "gentle-shell");
	const link = join(home, ".gentle-shell", "gentle-pi-current");
	const settings = join(agentDir, "settings.json");
	const backup = `${settings}.bak-gentle-tps`;
	// The script calls node for the settings edit, so node's own directory has
	// to stay on the isolated PATH.
	const nodeDir = dirname(process.execPath);

	const env = (): NodeJS.ProcessEnv => ({
		PATH: [binDir, nodeDir, "/usr/bin", "/bin"].join(":"),
		HOME: home,
		GENTLE_TPS_WRAPPER_DIR: wrapperDir,
		GENTLE_TPS_LINK: link,
		GENTLE_SHELL_AGENT_DIR: agentDir,
	});

	const addPiRoot = (hash: string): string => {
		const root = join(home, "global", "v11", hash, "node_modules", "gentle-pi");
		mkdirSync(join(root, "bin"), { recursive: true });
		writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "gentle-pi", version: "1.0.0" }, null, 2)}\n`);
		writeFileSync(join(root, "bin", "gentle-shell.mjs"), "#!/usr/bin/env node\n");
		return root;
	};

	const addShim = (hash: string): string => {
		const root = addPiRoot(hash);
		const shim = join(binDir, "gentle-shell");
		writeFileSync(
			shim,
			[
				"#!/bin/sh",
				`# cmd-shim-target=${join(root, "bin", "gentle-shell.mjs")}`,
				`printf 'real-gentle-shell %s\\n' "$*"`,
				"exit 7",
				"",
			].join("\n"),
		);
		chmodSync(shim, 0o755);
		return root;
	};

	const run = (...args: string[]): Run => {
		const result = spawnSync("/bin/sh", [SCRIPT, ...args], { env: env(), encoding: "utf8" });
		return { status: result.status, stdout: result.stdout, stderr: result.stderr };
	};

	return {
		home,
		binDir,
		wrapperDir,
		wrapper,
		link,
		settings,
		backup,
		addPiRoot,
		addShim,
		run,
		runWrapper: (...args: string[]): Run => {
			const result = spawnSync(wrapper, args, { env: env(), encoding: "utf8" });
			return { status: result.status, stdout: result.stdout, stderr: result.stderr };
		},
		runOnPath: (path: string, ...args: string[]): Run => {
			const result = spawnSync("/bin/sh", [SCRIPT, ...args], { env: { ...env(), PATH: path }, encoding: "utf8" });
			return { status: result.status, stdout: result.stdout, stderr: result.stderr };
		},
	};
}

test("install adds the wrapper, the symlink and a settings entry that replaces stale gentle-pi paths", (t) => {
	const f = fixture(t);
	const currentRoot = f.addShim("ac399-1a1cbe8ed28");
	const staleRoot = f.addPiRoot("old-hash");
	const otherDir = join(f.home, "other-package");
	mkdirSync(otherDir);
	writeFileSync(join(otherDir, "package.json"), `${JSON.stringify({ name: "other-package" })}\n`);
	const missingDir = join(f.home, "gone");

	const original = writeSettings(f.settings, {
		$schema: "https://example.test/settings.schema.json",
		theme: "night",
		packages: [
			"npm:pi-mcp-adapter",
			{ source: staleRoot, extensions: ["!extensions/gentle-tps.ts"] },
			{ source: otherDir },
			"git:github.com/MiguezPablo/gentle-tokometer-tps",
			{ source: missingDir },
		],
	});

	const result = f.run("install");

	assert.equal(result.status, 0);
	assert.equal(
		readFileSync(f.settings, "utf8"),
		`${JSON.stringify(
			{
				$schema: "https://example.test/settings.schema.json",
				theme: "night",
				packages: [
					"npm:pi-mcp-adapter",
					{ source: f.link, extensions: ["!extensions/gentle-tps.ts"] },
					{ source: otherDir },
					"git:github.com/MiguezPablo/gentle-tokometer-tps",
				],
			},
			null,
			2,
		)}\n`,
	);
	assert.equal(readFileSync(f.backup, "utf8"), original);
	assert.equal(readlinkSync(f.link), currentRoot);

	assert.ok(statSync(f.wrapper).mode & 0o111, "the wrapper is executable");
	const wrapperText = readFileSync(f.wrapper, "utf8");
	assert.ok(wrapperText.startsWith("#!/bin/sh\n"), "the wrapper starts with a POSIX shebang");
	assert.ok(wrapperText.includes(MARKER), "the wrapper carries the marker");
	assert.ok(wrapperText.includes(join(f.binDir, "gentle-shell")), "the wrapper hardcodes the real gentle-shell");

	assert.equal(
		result.stdout,
		[
			`disable-gentle-tps: wrapper   ${f.wrapper}`,
			`disable-gentle-tps: symlink   ${f.link} -> ${currentRoot}`,
			`disable-gentle-tps: settings  ${f.settings} (backup: ${f.backup})`,
			"disable-gentle-tps: restart gentle-shell (or run /reload) to hide the built-in TPS line",
			"",
		].join("\n"),
	);
	assert.equal(
		result.stderr,
		`disable-gentle-tps: warning: ${f.wrapperDir} is not on PATH; put it before ${f.binDir} so gentle-shell runs the wrapper\n`,
	);
});

test("install is idempotent: a second run leaves byte-identical files", (t) => {
	const f = fixture(t);
	f.addShim("h1");
	writeSettings(f.settings, { packages: ["npm:pi-mcp-adapter", { source: "~/.gentle-shell/gentle-pi-old" }] });

	const first = f.run("install");
	const wrapperText = readFileSync(f.wrapper, "utf8");
	const settingsText = readFileSync(f.settings, "utf8");
	const backupText = readFileSync(f.backup, "utf8");

	const second = f.run("install");

	assert.equal(first.status, 0);
	assert.equal(second.status, 0);
	assert.equal(readFileSync(f.wrapper, "utf8"), wrapperText);
	assert.equal(readFileSync(f.settings, "utf8"), settingsText);
	assert.equal(readFileSync(f.backup, "utf8"), backupText);
	assert.equal(second.stdout, first.stdout);
	assert.equal(second.stderr, first.stderr);
});

test("install skips its own wrapper on PATH and keeps pointing at the real gentle-shell", (t) => {
	const f = fixture(t);
	f.addShim("h1");
	const shim = join(f.binDir, "gentle-shell");
	assert.equal(f.run("install").status, 0);

	const nodeDir = dirname(process.execPath);
	const result = f.runOnPath([f.wrapperDir, f.binDir, nodeDir, "/usr/bin", "/bin"].join(":"), "install");

	assert.equal(result.status, 0);
	assert.equal(result.stderr, "", "the wrapper directory is already first on PATH");
	const wrapperText = readFileSync(f.wrapper, "utf8");
	assert.ok(wrapperText.includes(`REAL='${shim}'`), "the wrapper still execs the real gentle-shell");
	assert.ok(!wrapperText.includes(`REAL='${f.wrapper}'`), "the wrapper never execs itself");
});

test("the wrapper still execs a shim without cmd-shim-target and leaves the symlink unchanged", (t) => {
	const f = fixture(t);
	const root = f.addShim("h1");
	assert.equal(f.run("install").status, 0);

	// A plain script, not a symlink: readlink -f resolves to the script itself,
	// so the wrapper cannot derive a gentle-pi root from it.
	const shim = join(f.binDir, "gentle-shell");
	writeFileSync(shim, ["#!/bin/sh", `printf 'plain-shim %s\\n' "$*"`, "exit 5", ""].join("\n"));
	chmodSync(shim, 0o755);

	const result = f.runWrapper("--version", "extra");

	assert.equal(result.status, 5);
	assert.equal(result.stdout, "plain-shim --version extra\n");
	assert.equal(result.stderr, "");
	assert.equal(readlinkSync(f.link), root, "the symlink is left unchanged");
});

test("install keeps a relative path entry to an existing non-gentle-pi package in place", (t) => {
	const f = fixture(t);
	f.addShim("h1");
	const relativeSource = "../../x/pi-claude-profile-accounts";
	// A settings-relative path resolves against the agent dir, so this lands in <home>/x.
	const relativeDir = join(f.home, "x", "pi-claude-profile-accounts");
	mkdirSync(relativeDir, { recursive: true });
	writeFileSync(join(relativeDir, "package.json"), `${JSON.stringify({ name: "pi-claude-profile-accounts" })}\n`);
	writeSettings(f.settings, { packages: ["npm:pi-mcp-adapter", relativeSource] });

	const result = f.run("install");

	assert.equal(result.status, 0);
	assert.equal(
		readFileSync(f.settings, "utf8"),
		`${JSON.stringify(
			{
				packages: ["npm:pi-mcp-adapter", relativeSource, { source: f.link, extensions: ["!extensions/gentle-tps.ts"] }],
			},
			null,
			2,
		)}\n`,
	);
});

test("the wrapper follows a moved installation and forwards arguments and exit codes", (t) => {
	const f = fixture(t);
	const firstRoot = f.addShim("h1");
	assert.equal(f.run("install").status, 0);
	assert.equal(readlinkSync(f.link), firstRoot);

	const secondRoot = f.addShim("h2");
	const result = f.runWrapper("--version", "extra");

	assert.equal(result.status, 7);
	assert.equal(result.stdout, "real-gentle-shell --version extra\n");
	assert.equal(result.stderr, "");
	assert.equal(readlinkSync(f.link), secondRoot);
});

test("install refuses a non-symlink at the link path and writes nothing", (t) => {
	const f = fixture(t);
	f.addShim("h1");
	mkdirSync(join(f.link, "nested"), { recursive: true });
	writeFileSync(join(f.link, "nested", "keep.txt"), "keep\n");
	const settingsText = writeSettings(f.settings, { packages: ["npm:pi-mcp-adapter"] });

	const result = f.run("install");

	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.equal(result.stderr, `disable-gentle-tps: refusing to use ${f.link}: it exists and is not a symlink\n`);
	assert.deepEqual(readdirSync(f.link), ["nested"], "nothing is created inside the directory");
	assert.equal(readFileSync(join(f.link, "nested", "keep.txt"), "utf8"), "keep\n", "the directory is untouched");
	assert.equal(readFileSync(f.settings, "utf8"), settingsText, "the settings are unchanged");
	assert.equal(existsSync(f.backup), false, "no backup is written");
	assert.equal(existsSync(f.wrapper), false, "no wrapper is written");
});

test("the wrapper does not create a link inside a non-symlink at the link path", (t) => {
	const f = fixture(t);
	f.addShim("h1");
	assert.equal(f.run("install").status, 0);
	rmSync(f.link);
	mkdirSync(f.link);

	const result = f.runWrapper("--version");

	assert.equal(result.status, 7);
	assert.equal(result.stdout, "real-gentle-shell --version\n");
	assert.deepEqual(readdirSync(f.link), [], "the wrapper leaves the directory empty");
});

test("install refuses to overwrite a foreign gentle-shell at the wrapper path", (t) => {
	const f = fixture(t);
	f.addShim("h1");
	mkdirSync(f.wrapperDir, { recursive: true });
	const foreign = "#!/bin/sh\necho mine\n";
	writeFileSync(f.wrapper, foreign);
	chmodSync(f.wrapper, 0o755);
	const settingsText = writeSettings(f.settings, { packages: ["npm:pi-mcp-adapter"] });

	const result = f.run("install");

	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.equal(
		result.stderr,
		`disable-gentle-tps: refusing to overwrite ${f.wrapper}: it is not the gentle-tps wrapper\n`,
	);
	assert.equal(readFileSync(f.wrapper, "utf8"), foreign);
	assert.equal(readFileSync(f.settings, "utf8"), settingsText);
	assert.equal(existsSync(f.backup), false, "no backup is written");
	assert.equal(existsSync(f.link), false, "no symlink is written");
});

test("uninstall removes the wrapper, the symlink and the settings entry, keeping the backup", (t) => {
	const f = fixture(t);
	f.addShim("h1");
	const otherDir = join(f.home, "other-package");
	mkdirSync(otherDir);
	writeFileSync(join(otherDir, "package.json"), `${JSON.stringify({ name: "other-package" })}\n`);
	const expected = {
		theme: "night",
		packages: ["npm:pi-mcp-adapter", { source: otherDir }],
	};
	writeSettings(f.settings, expected);
	assert.equal(f.run("install").status, 0);
	assert.ok(existsSync(f.wrapper));

	const result = f.run("uninstall");

	assert.equal(result.status, 0);
	assert.equal(existsSync(f.wrapper), false);
	assert.equal(existsSync(f.link), false);
	assert.equal(readFileSync(f.settings, "utf8"), `${JSON.stringify(expected, null, 2)}\n`);
	assert.ok(existsSync(f.backup), "the settings backup is kept");
	assert.equal(
		result.stdout,
		[
			`disable-gentle-tps: removed wrapper ${f.wrapper}`,
			`disable-gentle-tps: removed symlink ${f.link}`,
			`disable-gentle-tps: removed the gentle-pi entry from ${f.settings} (backup kept: ${f.backup})`,
			"",
		].join("\n"),
	);
	assert.equal(result.stderr, "");
});

test("uninstall leaves a foreign wrapper and a non-symlink at the link path intact", (t) => {
	const f = fixture(t);
	mkdirSync(f.wrapperDir, { recursive: true });
	const foreign = "#!/bin/sh\necho mine\n";
	writeFileSync(f.wrapper, foreign);
	chmodSync(f.wrapper, 0o755);
	mkdirSync(join(f.link, "nested"), { recursive: true });
	writeFileSync(join(f.link, "nested", "keep.txt"), "keep\n");
	const settingsText = writeSettings(f.settings, { packages: ["npm:pi-mcp-adapter"] });

	const result = f.run("uninstall");

	assert.equal(result.status, 0);
	assert.equal(readFileSync(f.wrapper, "utf8"), foreign, "the foreign wrapper is untouched");
	assert.equal(readFileSync(join(f.link, "nested", "keep.txt"), "utf8"), "keep\n", "the link path is untouched");
	assert.equal(readFileSync(f.settings, "utf8"), settingsText, "the settings are untouched");
	assert.equal(result.stdout, `disable-gentle-tps: no gentle-pi entry in ${f.settings}\n`);
	assert.equal(
		result.stderr,
		`disable-gentle-tps: warning: ${f.wrapper} is not the gentle-tps wrapper; left it in place\n` +
			`disable-gentle-tps: warning: ${f.link} is not a symlink; left it in place\n`,
	);
});

test("install fails clearly when no real gentle-shell is on PATH", (t) => {
	const f = fixture(t);

	const result = f.run("install");

	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.equal(result.stderr, "disable-gentle-tps: could not find the real gentle-shell on PATH\n");
	assert.equal(existsSync(f.wrapper), false);
});

test("--help prints usage and changes nothing", (t) => {
	const f = fixture(t);

	const result = f.run("--help");

	assert.equal(result.status, 0);
	assert.match(result.stdout, /Usage:/);
	assert.match(result.stdout, /install/);
	assert.match(result.stdout, /uninstall/);
	assert.equal(result.stderr, "");
	assert.equal(existsSync(f.wrapper), false);
});

test("install rolls back the wrapper and the symlink when the settings cannot be parsed", (t) => {
	const f = fixture(t);
	f.addShim("h1");
	writeFileSync(f.settings, "{\n");

	const result = f.run("install");

	assert.equal(result.status, 1);
	assert.equal(result.stdout, "", "nothing is reported as installed");
	assert.match(result.stderr, /cannot parse/);
	assert.ok(result.stderr.endsWith(`disable-gentle-tps: could not update ${f.settings}\n`));
	assert.equal(readFileSync(f.settings, "utf8"), "{\n", "the settings are byte-identical");
	assert.equal(existsSync(f.wrapper), false, "the wrapper written by this run is removed");
	assert.equal(existsSync(f.link), false, "the symlink written by this run is removed");
	assert.equal(existsSync(f.backup), false, "no backup is written");
	assert.deepEqual(tempEntries(dirname(f.settings)), [], "no temp file is left in the agent dir");
	assert.deepEqual(readdirSync(f.wrapperDir), [], "no wrapper temp or snapshot file is left behind");
});

test("install keeps a previous wrapper and symlink when the settings cannot be parsed", (t) => {
	const f = fixture(t);
	const root = f.addShim("h1");
	writeSettings(f.settings, { packages: ["npm:pi-mcp-adapter"] });
	assert.equal(f.run("install").status, 0);
	const wrapperText = readFileSync(f.wrapper, "utf8");
	const backupText = readFileSync(f.backup, "utf8");
	writeFileSync(f.settings, "{\n");

	const result = f.run("install");

	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.equal(readFileSync(f.wrapper, "utf8"), wrapperText, "the previous wrapper is unchanged");
	assert.equal(readlinkSync(f.link), root, "the previous symlink target is unchanged");
	assert.equal(readFileSync(f.settings, "utf8"), "{\n", "the settings are byte-identical");
	assert.equal(readFileSync(f.backup, "utf8"), backupText, "the backup is unchanged");
	assert.deepEqual(tempEntries(dirname(f.settings)), [], "no temp file is left in the agent dir");
	assert.deepEqual(readdirSync(f.wrapperDir), ["gentle-shell"], "no snapshot file is left in the wrapper dir");
});

test("uninstall keeps the wrapper and the symlink when the settings cannot be parsed", (t) => {
	const f = fixture(t);
	const root = f.addShim("h1");
	assert.equal(f.run("install").status, 0);
	const wrapperText = readFileSync(f.wrapper, "utf8");
	writeFileSync(f.settings, "{\n");

	const result = f.run("uninstall");

	assert.equal(result.status, 1);
	assert.equal(result.stdout, "", "nothing is reported as removed");
	assert.equal(readFileSync(f.wrapper, "utf8"), wrapperText, "the wrapper is still installed");
	assert.equal(readlinkSync(f.link), root, "the symlink is still installed");
	assert.equal(readFileSync(f.settings, "utf8"), "{\n", "the settings are byte-identical");
});

test("install replaces settings atomically, keeping a symlink and the file mode", (t) => {
	const f = fixture(t);
	f.addShim("h1");
	const realDir = join(f.home, "dotfiles");
	mkdirSync(realDir);
	const real = join(realDir, "settings.json");
	writeSettings(real, { packages: ["npm:pi-mcp-adapter"] });
	chmodSync(real, 0o600);
	symlinkSync(real, f.settings);
	const inodeBefore = statSync(real).ino;

	const result = f.run("install");

	assert.equal(result.status, 0);
	assert.ok(lstatSync(f.settings).isSymbolicLink(), "the settings.json symlink stays a symlink");
	assert.equal(readlinkSync(f.settings), real, "the symlink keeps its target");
	assert.equal(
		readFileSync(real, "utf8"),
		`${JSON.stringify(
			{ packages: ["npm:pi-mcp-adapter", { source: f.link, extensions: ["!extensions/gentle-tps.ts"] }] },
			null,
			2,
		)}\n`,
		"the link target holds the new settings",
	);
	assert.equal(statSync(real).mode & 0o777, 0o600, "the previous file mode is kept");
	assert.notEqual(statSync(real).ino, inodeBefore, "the file is replaced, not rewritten in place");
	assert.deepEqual(tempEntries(dirname(f.settings)), [], "no temp file is left in the agent dir");
	assert.deepEqual(tempEntries(realDir), [], "no temp file is left next to the link target");
});

test("install writes through a dangling settings symlink instead of replacing it", (t) => {
	const f = fixture(t);
	f.addShim("h1");
	const realDir = join(f.home, "dotfiles");
	const real = join(realDir, "settings.json");
	mkdirSync(realDir);
	symlinkSync(real, f.settings);

	const result = f.run("install");

	assert.equal(result.status, 0);
	assert.ok(lstatSync(f.settings).isSymbolicLink(), "the dangling settings.json symlink stays a symlink");
	assert.equal(readlinkSync(f.settings), real, "the symlink keeps its target");
	assert.ok(existsSync(real), "the link target is created");
	assert.equal(
		readFileSync(real, "utf8"),
		`${JSON.stringify({ packages: [{ source: f.link, extensions: ["!extensions/gentle-tps.ts"] }] }, null, 2)}\n`,
		"the link target holds the new settings",
	);
	assert.deepEqual(tempEntries(realDir), [], "no temp file is left next to the link target");
});

test("install fails cleanly when a dangling settings link points into a missing directory", (t) => {
	const f = fixture(t);
	f.addShim("h1");
	const missingDir = join(f.home, "gone");
	const real = join(missingDir, "settings.json");
	symlinkSync(real, f.settings);

	const result = f.run("install");

	assert.equal(result.status, 1);
	assert.equal(result.stdout, "", "nothing is reported as installed");
	assert.equal(
		result.stderr,
		`disable-gentle-tps: cannot write ${real}: ${missingDir} is not an existing directory (left unchanged)\n` +
			`disable-gentle-tps: could not update ${f.settings}\n`,
	);
	assert.ok(lstatSync(f.settings).isSymbolicLink(), "the dangling symlink is untouched");
	assert.equal(existsSync(real), false, "no settings file is created");
	assert.equal(existsSync(f.wrapper), false, "the wrapper written by this run is removed");
	assert.equal(existsSync(f.link), false, "the symlink written by this run is removed");
	assert.equal(existsSync(f.backup), false, "no backup is written");
	assert.deepEqual(tempEntries(dirname(f.settings)), [], "no temp file is left in the agent dir");
});
