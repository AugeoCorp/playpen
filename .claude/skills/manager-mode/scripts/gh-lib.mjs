// gh-lib.mjs: Shared helpers for the PR scripts: gh execution, repo
// resolution, and argument parsing. Node's standard library only, so the
// scripts run from any repo's checkout without installing anything.
//
// The gh runner is deliberately POLICY-FREE: `execGitHub` runs whatever argv it
// is handed. The safety guarantees live in each caller: pr-status routes every
// call through its own read-only allowlist, and the write tools pass their own
// mutation allowlist to `runAllowedMutation`, so the trust boundary stays
// visible inside each script.

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

// Run `gh` with a fixed argument array (never a shell string, so there is no
// command injection). Returns trimmed stdout text, or the parsed object when
// `json` is set.
export function execGitHub(args, { json = false } = {}) {
	let output;
	try {
		output = execFileSync("gh", args, {
			encoding: "utf8",
			maxBuffer: 10 * 1024 * 1024,
		});
	} catch (error) {
		fail(
			`gh command failed: ${error.stderr?.toString().trim() ?? error.message}`,
		);
	}

	if (!json) {
		return output.trim();
	}
	try {
		return JSON.parse(output);
	} catch {
		fail(
			`could not parse gh output as JSON for: gh ${args.slice(0, 2).join(" ")}`,
		);
	}
}

// Run a mutation that must be on the caller's allowlist. Variables are passed
// as gh flags, numbers via -F (so an Int stays an Int) and everything else via
// -f, never interpolated into the query, so user input cannot alter it. Array
// variables repeat the flag with a `name[]=` key, which gh sends as a list.
export function runAllowedMutation(query, variables, allowedMutations) {
	assertAllowedMutation(query, allowedMutations);
	const variableFlags = Object.entries(variables).flatMap(([name, value]) => {
		const key = Array.isArray(value) ? `${name}[]` : name;
		return [value]
			.flat()
			.flatMap((item) => [
				typeof item === "number" ? "-F" : "-f",
				`${key}=${item}`,
			]);
	});
	return execGitHub(
		["api", "graphql", "-f", `query=${query}`, ...variableFlags],
		{ json: true },
	);
}

// Accept the query only if it is a mutation whose every `name(input:` call is
// on the allowlist. A backstop: the queries are hardcoded in each script, so
// this guards against one being edited to call something destructive.
function assertAllowedMutation(query, allowedMutations) {
	if (!/^\s*mutation\b/.test(query)) {
		fail("refusing gh call that is not a mutation");
	}
	const calls = [...query.matchAll(/(\w+)\s*\(\s*input:/g)].map(
		(match) => match[1],
	);
	if (!calls.length || calls.some((name) => !allowedMutations.has(name))) {
		fail("refusing mutation off the allowlist");
	}
}

function resolveCurrentRepo() {
	return execGitHub(["repo", "view", "--json", "nameWithOwner"], { json: true })
		.nameWithOwner;
}

export function splitRepo(repo) {
	const [owner, name] = repo.split("/");
	if (!owner || !name) {
		fail(`could not parse repo: ${repo}`);
	}
	return [owner, name];
}

// ── Command line ─────────────────────────────────────────────────────────────

// The `--repo` flag the scripts accept.
export const repoOption = { type: "string" };

// Parse the script's arguments against its flags. `--help` prints the usage
// and exits; a flag the script doesn't take fails with the usage.
export function parseCommandLine(usage, options) {
	let parsed;
	try {
		parsed = parseArgs({
			args: process.argv.slice(2),
			options: { ...options, help: { type: "boolean" } },
			allowPositionals: true,
		});
	} catch (error) {
		failWithUsage(error.message, usage);
	}
	if (parsed.values.help) {
		printUsage(usage);
	}
	return parsed;
}

// Name the positionals in order, failing with the usage unless every required
// one is there and nothing is left over. A missing optional one is undefined.
export function readPositionals(
	positionals,
	{ required, optional = [] },
	usage,
) {
	const names = [...required, ...optional];
	if (positionals.length < required.length) {
		failWithUsage(`missing <${required[positionals.length]}>`, usage);
	}
	if (positionals.length > names.length) {
		failWithUsage(
			`unexpected argument: ${positionals[names.length]} (quote text with spaces)`,
			usage,
		);
	}
	return Object.fromEntries(
		names.map((name, index) => [name, positionals[index]]),
	);
}

export function parsePositiveInteger(raw, name) {
	if (!/^\d+$/.test(raw) || Number(raw) === 0) {
		fail(`${name}: must be a positive integer`);
	}
	return Number(raw);
}

// Validate the optional --repo flag and fall back to the current checkout.
export function resolveRepo(repoFlag) {
	if (repoFlag === undefined) {
		return resolveCurrentRepo();
	}
	if (!/^[\w.-]+\/[\w.-]+$/.test(repoFlag)) {
		fail("repo: must look like owner/name");
	}
	return repoFlag;
}

export function printUsage(usage) {
	process.stdout.write(`${usage}\n`);
	process.exit(0);
}

export function failWithUsage(message, usage) {
	fail(`${message}\n\n${usage}`);
}

export function fail(message) {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}
