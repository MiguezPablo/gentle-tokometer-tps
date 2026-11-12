#!/bin/sh
# gentle-tokometer-tps: hide Gentle Shell's built-in TPS line without editing
# gentle-pi by hand.
#
# Gentle Shell always loads gentle-pi's own extensions/gentle-tps.ts, which
# prints a second TPS line next to this package's line. The launcher only
# honours a settings.json gentle-pi *path* declaration whose resolved directory
# is the gentle-pi installation actually running, and a pnpm global install
# changes that directory (a content hash) on every update. This script installs
# three things:
#
#   1. a thin `gentle-shell` wrapper that repoints a stable symlink at the
#      current gentle-pi root before every run, then execs the real launcher;
#   2. the symlink itself (~/.gentle-shell/gentle-pi-current by default);
#   3. a settings.json package entry that loads that symlink and excludes
#      extensions/gentle-tps.ts.
#
# Usage: sh scripts/disable-gentle-tps.sh [install|uninstall|--help]
#
# Environment overrides:
#   GENTLE_TPS_WRAPPER_DIR   wrapper directory (default ~/.local/bin)
#   GENTLE_TPS_LINK          gentle-pi symlink (default ~/.gentle-shell/gentle-pi-current)
#   GENTLE_SHELL_AGENT_DIR   agent dir holding settings.json (default ~/.gentle-shell/agent)

set -u

MARKER='# gentle-tokometer-tps: gentle-tps wrapper'

usage() {
	cat <<'USAGE'
Usage: sh scripts/disable-gentle-tps.sh [install|uninstall]

  install    (default) install the gentle-shell wrapper, point the gentle-pi
             symlink at the current installation and add the settings entry
             that excludes the built-in TPS extension.
  uninstall  remove the wrapper, the symlink and the settings entry; the
             settings backup is kept.
  --help     show this help.
USAGE
}

fail() {
	printf 'disable-gentle-tps: %s\n' "$1" >&2
	exit 1
}

warn() {
	printf 'disable-gentle-tps: warning: %s\n' "$1" >&2
}

# Absolute form of a path, relative to the current directory.
absolutize() {
	case $1 in
		/*) printf '%s\n' "$1" ;;
		*) printf '%s\n' "$(pwd)/$1" ;;
	esac
}

# Expands a leading ~ or ~/ to $HOME; the launcher and Pi accept both forms.
expand_tilde() {
	# shellcheck disable=SC2088  # literal ~ in patterns, not a tilde expansion
	case $1 in
		'~') printf '%s\n' "$HOME" ;;
		'~/'*) printf '%s\n' "$HOME/${1#"~/"}" ;;
		*) printf '%s\n' "$1" ;;
	esac
}

# Single-quotes a value for the generated wrapper's REAL/LINK assignments.
quote() {
	escaped=$(printf '%s' "$1" | sed "s/'/'\\\\''/g")
	printf "'%s'" "$escaped"
}

is_wrapper() {
	grep -q -- "$MARKER" "$1" 2>/dev/null
}

# Prints the first gentle-shell on PATH that is not this wrapper.
find_real() {
	old_ifs=$IFS
	IFS=:
	found=
	for dir in $PATH; do
		[ -n "$dir" ] || dir=.
		dir=$(absolutize "$dir")
		candidate=$dir/gentle-shell
		[ -f "$candidate" ] || continue
		[ -x "$candidate" ] || continue
		[ "$candidate" = "$WRAPPER" ] && continue
		is_wrapper "$candidate" && continue
		found=$candidate
		break
	done
	IFS=$old_ifs
	[ -n "$found" ] || return 1
	printf '%s\n' "$found"
}

# Resolves the gentle-pi root of a gentle-shell executable: the pnpm shim's
# cmd-shim-target line when present, otherwise the resolved symlink target.
# Prints nothing and returns 1 when neither yields a bin/gentle-shell.mjs.
resolve_root() {
	real=$1
	target=
	if [ -r "$real" ]; then
		target=$(sed -n 's/^# cmd-shim-target=//p' "$real" 2>/dev/null | head -n 1)
	fi
	if [ -z "$target" ]; then
		target=$(readlink -f "$real" 2>/dev/null) || target=
	fi
	case $target in
		*/bin/gentle-shell.mjs) printf '%s\n' "${target%/bin/gentle-shell.mjs}" ;;
		*) return 1 ;;
	esac
}

# Atomically points the symlink at $1, replacing whatever is there.
repoint_link() {
	tmp=$LINK.tmp.$$
	ln -sfn "$1" "$tmp" 2>/dev/null || return 1
	if mv -T "$tmp" "$LINK" 2>/dev/null; then
		return 0
	fi
	# mv -T is GNU-only; fall back to replacing the link in place.
	rm -f "$tmp"
	ln -sfn "$1" "$LINK" 2>/dev/null || return 1
}

write_wrapper() {
	real=$1
	tmp=$WRAPPER.tmp.$$
	{
		printf '#!/bin/sh\n'
		printf '%s\n' "$MARKER"
		printf '%s\n' '# Keeps the gentle-pi symlink on the installation this launcher runs,'
		printf '%s\n' '# then execs the real gentle-shell. Silent and non-fatal on failure.'
		printf 'REAL=%s\n' "$(quote "$real")"
		printf 'LINK=%s\n' "$(quote "$LINK")"
		cat <<'WRAPPER_BODY'

root=
if [ -r "$REAL" ]; then
	target=$(sed -n 's/^# cmd-shim-target=//p' "$REAL" 2>/dev/null | head -n 1)
	if [ -z "$target" ]; then
		target=$(readlink -f "$REAL" 2>/dev/null) || target=
	fi
	case $target in
		*/bin/gentle-shell.mjs) root=${target%/bin/gentle-shell.mjs} ;;
	esac
fi
if [ -n "$root" ] && [ -f "$root/package.json" ]; then
	current=$(readlink "$LINK" 2>/dev/null) || current=
	if [ "$current" != "$root" ]; then
		tmp=$LINK.tmp.$$
		if ln -sfn "$root" "$tmp" 2>/dev/null; then
			mv -T "$tmp" "$LINK" 2>/dev/null || {
				rm -f "$tmp"
				ln -sfn "$root" "$LINK" 2>/dev/null
			}
		fi
	fi
fi
exec "$REAL" "$@"
WRAPPER_BODY
	} >"$tmp" || {
		rm -f "$tmp"
		fail "cannot write $tmp"
	}
	chmod 755 "$tmp" || {
		rm -f "$tmp"
		fail "cannot make $tmp executable"
	}
	mv -f "$tmp" "$WRAPPER" || {
		rm -f "$tmp"
		fail "cannot replace $WRAPPER"
	}
}

# Edits settings.json with node. Returns node's exit code: uninstall exits 3
# when there was no entry to remove.
edit_settings() {
	DISABLE_TPS_MODE=$1
	DISABLE_TPS_SETTINGS=$SETTINGS
	DISABLE_TPS_LINK=$LINK
	DISABLE_TPS_AGENT_DIR=$AGENT_DIR
	DISABLE_TPS_BACKUP=$BACKUP
	export DISABLE_TPS_MODE DISABLE_TPS_SETTINGS DISABLE_TPS_LINK DISABLE_TPS_AGENT_DIR DISABLE_TPS_BACKUP
	node --input-type=commonjs - <<'NODE'
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const mode = process.env.DISABLE_TPS_MODE;
const settingsPath = process.env.DISABLE_TPS_SETTINGS;
const linkPath = process.env.DISABLE_TPS_LINK;
const agentDir = process.env.DISABLE_TPS_AGENT_DIR;
const backupPath = process.env.DISABLE_TPS_BACKUP;
const entry = { source: linkPath, extensions: ["!extensions/gentle-tps.ts"] };

function die(message) {
	process.stderr.write(`disable-gentle-tps: ${message}\n`);
	process.exit(1);
}

function entrySource(value) {
	if (typeof value === "string") return value;
	if (value !== null && typeof value === "object" && typeof value.source === "string") return value.source;
	return undefined;
}

// Same classification the gentle-shell launcher uses: npm:, git: and git URLs
// are package sources, everything else is a filesystem path.
function isPathSource(source) {
	return !source.startsWith("npm:") && !source.startsWith("git:") && !/^(?:https?|ssh|git):\/\//.test(source);
}

function expandHome(source) {
	if (source === "~") return os.homedir();
	if (source.startsWith("~/")) return path.join(os.homedir(), source.slice(2));
	return source;
}

function packageNameOf(dir) {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
		return typeof pkg.name === "string" ? pkg.name : undefined;
	} catch {
		return undefined;
	}
}

let text = "";
if (fs.existsSync(settingsPath)) {
	try {
		text = fs.readFileSync(settingsPath, "utf8");
	} catch (error) {
		die(`cannot read ${settingsPath}: ${error.message}`);
	}
}
if (text === "" && mode === "uninstall") process.exit(3);

let settings = {};
if (text.trim() !== "") {
	try {
		settings = JSON.parse(text);
	} catch (error) {
		die(`cannot parse ${settingsPath}: ${error.message} (left unchanged)`);
	}
}
if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
	die(`${settingsPath} is not a JSON object (left unchanged)`);
}
if (Object.prototype.hasOwnProperty.call(settings, "packages") && !Array.isArray(settings.packages)) {
	die(`${settingsPath}: packages is not an array (left unchanged)`);
}
const packages = settings.packages ?? [];

const next = [];
let removed = 0;
let insertAt = -1;
for (const value of packages) {
	const source = entrySource(value);
	if (mode === "install") {
		// Drop every path package that is a gentle-pi (stale hashed install or an
		// earlier symlink) or that no longer exists, keeping the position of the
		// first one for the fresh entry.
		if (source !== undefined && isPathSource(source)) {
			const dir = path.resolve(agentDir, expandHome(source));
			if (!fs.existsSync(dir) || packageNameOf(dir) === "gentle-pi") {
				if (insertAt === -1) insertAt = next.length;
				removed += 1;
				continue;
			}
		}
	} else if (source === linkPath) {
		removed += 1;
		continue;
	}
	next.push(value);
}

if (mode === "uninstall") {
	if (removed === 0) process.exit(3);
} else if (insertAt === -1) {
	next.push(entry);
} else {
	next.splice(insertAt, 0, entry);
}
settings.packages = next;

const output = `${JSON.stringify(settings, null, 2)}\n`;
if (mode === "install" && text !== "" && !fs.existsSync(backupPath)) {
	try {
		fs.copyFileSync(settingsPath, backupPath);
	} catch (error) {
		die(`cannot write backup ${backupPath}: ${error.message}`);
	}
}
if (output !== text) {
	try {
		fs.writeFileSync(settingsPath, output);
	} catch (error) {
		die(`cannot write ${settingsPath}: ${error.message}`);
	}
}
NODE
}

# Warns when the wrapper would not actually be reached through PATH.
warn_path() {
	real_dir=$(dirname "$1")
	position_wrapper=
	position_real=
	index=0
	old_ifs=$IFS
	IFS=:
	for dir in $PATH; do
		[ -n "$dir" ] || dir=.
		dir=$(absolutize "$dir")
		if [ -z "$position_wrapper" ] && [ "$dir" = "$WRAPPER_DIR" ]; then
			position_wrapper=$index
		fi
		if [ -z "$position_real" ] && [ "$dir" = "$real_dir" ]; then
			position_real=$index
		fi
		index=$((index + 1))
	done
	IFS=$old_ifs
	if [ -z "$position_wrapper" ]; then
		warn "$WRAPPER_DIR is not on PATH; put it before $real_dir so gentle-shell runs the wrapper"
	elif [ -n "$position_real" ] && [ "$position_wrapper" -gt "$position_real" ]; then
		warn "$WRAPPER_DIR comes after $real_dir on PATH; move it before so gentle-shell runs the wrapper"
	fi
}

install_cmd() {
	real=$(find_real) || fail "could not find the real gentle-shell on PATH"

	if [ -e "$WRAPPER" ] && ! is_wrapper "$WRAPPER"; then
		fail "refusing to overwrite $WRAPPER: it is not the gentle-tps wrapper"
	fi

	root=$(resolve_root "$real") || fail "could not resolve the gentle-pi root from $real"
	[ -f "$root/package.json" ] || fail "$root has no package.json; is $real a gentle-shell shim?"

	mkdir -p "$WRAPPER_DIR" || fail "cannot create $WRAPPER_DIR"
	write_wrapper "$real"

	mkdir -p "$(dirname "$LINK")" || fail "cannot create $(dirname "$LINK")"
	repoint_link "$root" || fail "cannot point $LINK at $root"

	mkdir -p "$AGENT_DIR" || fail "cannot create $AGENT_DIR"
	edit_settings install || fail "could not update $SETTINGS"

	warn_path "$real"

	printf 'disable-gentle-tps: wrapper   %s\n' "$WRAPPER"
	printf 'disable-gentle-tps: symlink   %s -> %s\n' "$LINK" "$root"
	printf 'disable-gentle-tps: settings  %s (backup: %s)\n' "$SETTINGS" "$BACKUP"
	printf 'disable-gentle-tps: restart gentle-shell (or run /reload) to hide the built-in TPS line\n'
}

uninstall_cmd() {
	if [ -e "$WRAPPER" ] || [ -L "$WRAPPER" ]; then
		if is_wrapper "$WRAPPER"; then
			rm -f "$WRAPPER" || fail "cannot remove $WRAPPER"
			printf 'disable-gentle-tps: removed wrapper %s\n' "$WRAPPER"
		else
			warn "$WRAPPER is not the gentle-tps wrapper; left it in place"
		fi
	else
		printf 'disable-gentle-tps: no wrapper at %s\n' "$WRAPPER"
	fi

	if [ -L "$LINK" ]; then
		rm -f "$LINK" || fail "cannot remove $LINK"
		printf 'disable-gentle-tps: removed symlink %s\n' "$LINK"
	elif [ -e "$LINK" ]; then
		warn "$LINK is not a symlink; left it in place"
	else
		printf 'disable-gentle-tps: no symlink at %s\n' "$LINK"
	fi

	edit_settings uninstall
	status=$?
	case $status in
		0) printf 'disable-gentle-tps: removed the gentle-pi entry from %s (backup kept: %s)\n' "$SETTINGS" "$BACKUP" ;;
		3) printf 'disable-gentle-tps: no gentle-pi entry in %s\n' "$SETTINGS" ;;
		*) fail "could not update $SETTINGS" ;;
	esac
}

command=install
case ${1:-install} in
	install) ;;
	uninstall) command=uninstall ;;
	--help | -h)
		usage
		exit 0
		;;
	*)
		printf 'disable-gentle-tps: unknown subcommand: %s\n' "$1" >&2
		usage >&2
		exit 2
		;;
esac
if [ $# -gt 1 ]; then
	printf 'disable-gentle-tps: unexpected argument: %s\n' "$2" >&2
	usage >&2
	exit 2
fi

[ -n "${HOME:-}" ] || fail "HOME is not set"

WRAPPER_DIR=$(absolutize "$(expand_tilde "${GENTLE_TPS_WRAPPER_DIR:-$HOME/.local/bin}")")
LINK=$(absolutize "$(expand_tilde "${GENTLE_TPS_LINK:-$HOME/.gentle-shell/gentle-pi-current}")")
AGENT_DIR=$(absolutize "$(expand_tilde "${GENTLE_SHELL_AGENT_DIR:-$HOME/.gentle-shell/agent}")")
WRAPPER=$WRAPPER_DIR/gentle-shell
SETTINGS=$AGENT_DIR/settings.json
BACKUP=$SETTINGS.bak-gentle-tps

if [ "$command" = "uninstall" ]; then
	uninstall_cmd
else
	install_cmd
fi
