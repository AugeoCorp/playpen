import type { ArgsDef, CommandDef, CommandMeta, Resolvable } from "citty";

/**
 * The generated scripts hold no command names. They forward the words typed so
 * far to `playpen __complete` and paste back what it says, so adding a command
 * or a flag never leaves an installed script stale.
 *
 * The first line of a reply says what to do with the rest.
 */
const DIRECTIVE = {
	words: ":words",
	dirs: ":dirs",
	files: ":files",
	/** After `--`, the next word names a program to run in the guest. */
	commands: ":commands",
} as const;

interface CompletionFlag {
	/** As typed, dashes included: `--keep`, `--no-auth`, `-f`. */
	flag: string;
	/** The arg these spellings share, so typing one retires all of them. */
	key: string;
	description: string;
	/** What to offer after the flag, when it takes a value. */
	value?: "dir" | "file";
}

async function resolve<T>(value: Resolvable<T>): Promise<T> {
	return typeof value === "function"
		? await (value as () => T | Promise<T>)()
		: await value;
}

function flagsOf(args: ArgsDef): CompletionFlag[] {
	const flags: CompletionFlag[] = [];

	for (const [name, def] of Object.entries(args)) {
		if (def.type === "positional") continue;
		const description = (def.description ?? "").replace(/\s+/g, " ").trim();

		flags.push({
			flag: `--${name}`,
			key: name,
			description,
			...(def.type === "string"
				? { value: /dir/i.test(def.valueHint ?? "") ? "dir" : "file" }
				: {}),
		});

		const aliases = "alias" in def ? [def.alias ?? []].flat() : [];
		for (const alias of aliases) {
			flags.push({
				flag: alias.length === 1 ? `-${alias}` : `--${alias}`,
				key: name,
				description,
			});
		}

		// citty parses `--no-x` for any boolean, but it only says anything the
		// bare flag does not when the flag is already on.
		if (def.type === "boolean" && def.default === true) {
			flags.push({
				flag: `--no-${name}`,
				key: name,
				description: `disable --${name}`,
			});
		}
	}

	return flags;
}

/** A positional has nothing to enumerate unless its hint spells the set out. */
function choicesOf(args: ArgsDef): string[] {
	const choices: string[] = [];
	for (const def of Object.values(args)) {
		if (def.type !== "positional") continue;
		for (const choice of (def.valueHint ?? "").split("|")) {
			if (choice.trim()) choices.push(choice.trim());
		}
	}
	return choices;
}

/**
 * Follows the typed subcommands down, resolving only the lazy imports on that
 * path. Completing `playpen cl` must not load the image module graph.
 */
async function descend(
	root: CommandDef,
	typed: string[],
	aliases: Record<string, string>,
): Promise<{ command: CommandDef; depth: number; stranded: boolean }> {
	let command = root;
	let depth = 0;

	for (const word of typed) {
		if (word.startsWith("-")) break;
		const subs = command.subCommands ? await resolve(command.subCommands) : {};
		// Aliases are rewritten at the top level only, so `image ls` is not `list`.
		const alias = depth === 0 ? aliases[word] : undefined;
		const next = subs[word] ?? subs[alias ?? ""];
		if (!next) {
			return { command, depth, stranded: Object.keys(subs).length > 0 };
		}
		command = await resolve(next);
		depth += 1;
	}

	return { command, depth, stranded: false };
}

async function describeOf(sub: Resolvable<CommandDef>): Promise<string> {
	const def = await resolve(sub);
	const meta: CommandMeta = def.meta ? await resolve(def.meta) : {};
	return (meta.description ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Answers one keypress. `argv` is the words typed after `playpen`, the last of
 * them the one being completed, which is empty when the cursor sits on a fresh
 * word. With `--describe` each candidate carries `:<description>` for zsh's
 * menu; bash has nowhere to show one.
 */
export async function complete(
	root: CommandDef,
	argv: string[],
	aliases: Record<string, string> = {},
): Promise<string> {
	const describe = argv[0] === "--describe";
	const rest = describe ? argv.slice(1) : argv;
	// The shells pass `--` so a leading flag in the typed words stays a word.
	const words = rest[0] === "--" ? rest.slice(1) : rest;
	const current = words.at(-1) ?? "";
	const typed = words.slice(0, -1);

	// Everything past `--` belongs to the program being run in the guest: its
	// name first, then arguments this knows nothing about.
	const separator = typed.indexOf("--");
	if (separator >= 0) {
		return separator === typed.length - 1
			? DIRECTIVE.commands
			: DIRECTIVE.files;
	}

	const { command, depth, stranded } = await descend(root, typed, aliases);
	if (stranded) return DIRECTIVE.words;

	const args: ArgsDef = command.args ? await resolve(command.args) : {};
	const subs = command.subCommands ? await resolve(command.subCommands) : {};

	const flags = flagsOf(args);
	const previous = typed.at(-1);
	const awaiting = flags.find((f) => f.flag === previous)?.value;
	if (awaiting) {
		return awaiting === "dir" ? DIRECTIVE.dirs : DIRECTIVE.files;
	}

	flags.push({ flag: "--help", key: "help", description: "show usage" });
	if (depth === 0) {
		const meta: CommandMeta = command.meta ? await resolve(command.meta) : {};
		if (meta.version) {
			flags.push({
				flag: "--version",
				key: "version",
				description: "show version",
			});
		}
	}

	// A flag already on the line is spent: citty takes none of them twice, and
	// re-offering the last one left means every keypress inserts it again.
	// `--mount=/x` counts as `--mount`.
	const present = new Set(typed.map((word) => word.split("=")[0]));
	const spent = new Set(
		flags.filter((f) => present.has(f.flag)).map((f) => f.key),
	);

	const lines: string[] = [DIRECTIVE.words];
	const offer = (value: string, description: string) => {
		if (!value.startsWith(current)) return;
		lines.push(describe ? `${value}:${description}` : value);
	};

	const names = new Set(
		Object.keys(subs).filter((name) => name.startsWith(current)),
	);
	// A candidate that shares no prefix with what was typed, so that `ls` is
	// replaced by the name it stands for rather than completing to nothing.
	if (depth === 0) {
		for (const [alias, name] of Object.entries(aliases)) {
			if (alias.startsWith(current) && name in subs) names.add(name);
		}
	}

	for (const name of names) {
		const sub = subs[name];
		if (!sub) continue;
		lines.push(describe ? `${name}:${await describeOf(sub)}` : name);
	}
	for (const choice of choicesOf(args)) offer(choice, "");
	for (const flag of flags) {
		if (spent.has(flag.key)) continue;
		offer(flag.flag, flag.description);
	}

	return lines.join("\n");
}

function fnName(bin: string): string {
	return `_${bin.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

export function bashScript(bin: string): string {
	const fn = fnName(bin);
	return `# ${bin} completion for bash. Asks ${bin} itself, so it never goes stale.
${fn}() {
	local cur out
	cur="\${COMP_WORDS[COMP_CWORD]}"
	mapfile -t out < <(${bin} __complete -- "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null)

	case "\${out[0]}" in
		:words) COMPREPLY=("\${out[@]:1}") ;;
		:dirs) COMPREPLY=($(compgen -d -- "$cur")) ;;
		:files) COMPREPLY=($(compgen -f -- "$cur")) ;;
		:commands) COMPREPLY=($(compgen -c -- "$cur")) ;;
		*) COMPREPLY=() ;;
	esac
}

# No -o default: an empty reply means there is nothing to offer, and filenames
# are not a better guess than silence.
complete -F ${fn} ${bin}
`;
}

export function zshScript(bin: string): string {
	const fn = fnName(bin);
	return `#compdef ${bin}
# ${bin} completion for zsh. Asks ${bin} itself, so it never goes stale.

${fn}() {
	local -a out cands
	out=("\${(@f)$(${bin} __complete --describe -- "\${(@)words[2,CURRENT]}" 2>/dev/null)}")

	case "\${out[1]}" in
		:words)
			cands=("\${(@)out[2,-1]}")
			_describe -t values '${bin}' cands
			;;
		:dirs) _files -/ ;;
		:files) _files ;;
		:commands) _command_names -e ;;
		*) return 1 ;;
	esac
}

# Sourced rather than autoloaded, the #compdef line above does nothing and the
# function has to register itself.
if [[ \${zsh_eval_context[-1]} == loadautofunc ]]; then
	${fn} "$@"
else
	compdef ${fn} ${bin}
fi
`;
}
