#!/usr/bin/env node
// pr-status.mjs: Read-only Pull Request status reporter.
//
// Safe by construction: every report is built from a CLOSED set of named
// SECTIONS and commands, and every GitHub read they make is hardcoded here.
// Callers never supply a query and never parse raw JSON. Every gh call is
// routed through a local read-only allowlist (assertReadOnly), so nothing here
// can mutate a PR, a repo, or anything on GitHub. It is safe to blanket-allow.

import {
	execGitHub,
	fail,
	failWithUsage,
	parseCommandLine,
	parsePositiveInteger,
	printUsage,
	readPositionals,
	repoOption,
	resolveRepo,
	splitRepo,
} from "./gh-lib.mjs";

// Allowed `gh` command prefixes. Every report's gh call must match one.
const READ_ONLY_COMMANDS = [
	["pr", "view"],
	["pr", "diff"],
	["pr", "list"],
	["repo", "view"],
	["api", "graphql"],
];

// ── Sections ─────────────────────────────────────────────────────────────────
// Each section distills one slice of a pull request. It declares the `gh pr
// view` JSON fields it needs (prFields) and/or that it needs the review-threads
// GraphQL read (needsThreads). `view --include` composes sections: the union of
// prFields is fetched in a single `pr view` call, and the threads read fires
// only when some requested section needs it. distill({ pullRequest, threads })
// returns { data, lines }.

const SECTIONS = {
	meta: {
		prFields: [
			"number",
			"title",
			"state",
			"isDraft",
			"author",
			"baseRefName",
			"headRefName",
			"url",
		],
		distill({ pullRequest }) {
			const state = pullRequest.isDraft ? "DRAFT" : pullRequest.state;
			const author = pullRequest.author?.login ?? "unknown";
			const data = {
				number: pullRequest.number,
				title: pullRequest.title,
				state,
				baseRefName: pullRequest.baseRefName,
				headRefName: pullRequest.headRefName,
				author,
				url: pullRequest.url,
			};
			return {
				data,
				lines: [
					`#${data.number} ${data.title}`,
					`State:  ${state}`,
					`Branch: ${data.baseRefName} ← ${data.headRefName}`,
					`Author: ${author}`,
					data.url,
				],
			};
		},
	},

	summary: {
		prFields: [
			"number",
			"title",
			"state",
			"isDraft",
			"mergeable",
			"reviewDecision",
			"statusCheckRollup",
			"url",
		],
		needsThreads: true,
		distill({ pullRequest, threads }) {
			const checks = (pullRequest.statusCheckRollup ?? []).filter(
				(check) => check.name,
			);
			const passing = checks.filter(
				(check) => check.conclusion === "SUCCESS",
			).length;
			const failing = checks.filter((check) =>
				["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT"].includes(
					check.conclusion,
				),
			).length;
			const unresolved = threads.filter((thread) => !thread.resolved).length;

			const data = {
				number: pullRequest.number,
				title: pullRequest.title,
				state: pullRequest.isDraft ? "DRAFT" : pullRequest.state,
				reviewDecision: pullRequest.reviewDecision ?? "none yet",
				mergeable: pullRequest.mergeable,
				checks: { total: checks.length, passing, failing },
				threads: { total: threads.length, unresolved },
				url: pullRequest.url,
			};
			return {
				data,
				lines: [
					`#${data.number} ${data.title}`,
					`State:     ${data.state}`,
					`Review:    ${data.reviewDecision}`,
					`Mergeable: ${data.mergeable}`,
					`Checks:    ${passing}/${checks.length} passing` +
						(failing ? `, ${failing} failing` : ""),
					`Threads:   ${unresolved} unresolved of ${threads.length}`,
					data.url,
				],
			};
		},
	},

	files: {
		prFields: ["changedFiles", "additions", "deletions", "files"],
		distill({ pullRequest }) {
			const files = (pullRequest.files ?? []).map((file) => ({
				path: file.path,
				additions: file.additions,
				deletions: file.deletions,
				changeType: file.changeType,
			}));
			const data = {
				changedFiles: pullRequest.changedFiles,
				additions: pullRequest.additions,
				deletions: pullRequest.deletions,
				files,
			};
			const pathWidth = Math.min(
				Math.max(0, ...files.map((file) => file.path.length)),
				72,
			);
			return {
				data,
				lines: [
					`Files: ${data.changedFiles} changed  +${data.additions}  -${data.deletions}`,
					...(files.length
						? files.map(
								(file) =>
									`  ${changeIcon(file.changeType)}  ${file.path.padEnd(pathWidth)}  +${file.additions}  -${file.deletions}`,
							)
						: ["  (no files reported)"]),
				],
			};
		},
	},

	checks: {
		prFields: ["statusCheckRollup"],
		distill({ pullRequest }) {
			const checks = (pullRequest.statusCheckRollup ?? []).filter(
				(check) => check.name,
			);
			const data = checks.map((check) => ({
				name: check.name,
				result: check.conclusion ?? check.status ?? "PENDING",
			}));
			return {
				data,
				lines: data.length
					? data.map(
							(check) =>
								`${icon(check.result)} ${check.name} — ${check.result}`,
						)
					: ["(no checks reported)"],
			};
		},
	},

	reviewers: {
		prFields: ["reviewRequests", "reviewDecision"],
		distill({ pullRequest }) {
			const pending = (pullRequest.reviewRequests ?? [])
				.map((request) => request.login ?? request.name ?? request.slug)
				.filter(Boolean);
			const data = {
				reviewDecision: pullRequest.reviewDecision ?? "none yet",
				pending,
			};
			return {
				data,
				lines: [
					`Review decision: ${data.reviewDecision}`,
					`Pending:         ${pending.length ? pending.join(", ") : "none"}`,
				],
			};
		},
	},

	threads: {
		needsThreads: true,
		distill({ threads }) {
			const unresolved = threads.filter((thread) => !thread.resolved);
			return {
				data: unresolved,
				lines: unresolved.length
					? unresolved.flatMap((thread) => {
							const location = thread.line
								? `${thread.path}:${thread.line}`
								: thread.path;
							const comments = thread.comments.map(
								(comment) => `  [${comment.author}] ${oneLine(comment.body)}`,
							);
							return [
								`• ${location}`,
								...diffContext(thread.diffHunk),
								...comments,
								`  ↳ reply id: ${thread.id}`,
							];
						})
					: ["No unresolved review threads."],
			};
		},
	},

	body: {
		prFields: ["body"],
		distill({ pullRequest }) {
			const body = cleanBody(pullRequest.body);
			return {
				data: { body },
				lines: body
					? ["Description:", ...body.split("\n").map((line) => `  ${line}`)]
					: ["Description: (none)"],
			};
		},
	},
};

// Purpose-built presets: a named, fixed list of sections so common tasks need
// no thinking about which sections to include. `summary` is the default health
// view; `review` bundles everything needed to review a PR.
const PRESETS = {
	summary: {
		include: ["summary"],
		description: "State, review decision, mergeability, checks, thread counts.",
	},
	review: {
		include: ["meta", "files", "body", "threads"],
		description: "Review prep: metadata, changed files, description, threads.",
	},
	files: {
		include: ["meta", "files"],
		description:
			"Changed files with per-file additions/deletions, plus totals.",
	},
	checks: {
		include: ["checks"],
		description: "Every CI check and its conclusion.",
	},
	threads: {
		include: ["threads"],
		description: "Unresolved review threads (path, line, diff hunk, comments).",
	},
	reviewers: {
		include: ["reviewers"],
		description: "Pending reviewers and the overall review decision.",
	},
};

// ── Composition ──────────────────────────────────────────────────────────────
// Fetch the union of fields the requested sections need (one `pr view` call),
// fetch review threads only if some section needs them, then distill each.

function composeSections(repo, prNumber, includeNames) {
	const sections = includeNames.map((name) => [name, SECTIONS[name]]);

	const prFields = new Set(
		sections.flatMap(([, section]) => section.prFields ?? []),
	);
	const needsThreads = sections.some(([, section]) => section.needsThreads);

	const pullRequest = prFields.size
		? fetchPullRequest(repo, prNumber, [...prFields])
		: undefined;
	const threads = needsThreads ? fetchReviewThreads(repo, prNumber) : undefined;

	const context = { pullRequest, threads };
	const results = sections.map(([name, section]) => [
		name,
		section.distill(context),
	]);
	return {
		data: Object.fromEntries(
			results.map(([name, result]) => [name, result.data]),
		),
		lines: [results.map(([, result]) => result.lines.join("\n")).join("\n\n")],
	};
}

// One file's patch out of a PR diff. Scoped to a single file so the output
// stays small, and follows the same { data, lines } shape as every section.
function fileDiff(repo, prNumber, file) {
	const blocks = splitDiff(fetchDiff(repo, prNumber));
	const match =
		blocks.find((block) => block.path === file) ??
		blocks.find((block) => block.path.endsWith(`/${file}`));
	if (!match) {
		fail(
			`no diff for "${file}" in #${prNumber}. Changed files:\n  ${blocks
				.map((block) => block.path)
				.join("\n  ")}`,
		);
	}
	const patchLines = match.patch.split("\n");
	const additions = patchLines.filter(
		(line) => line.startsWith("+") && !line.startsWith("+++"),
	).length;
	const deletions = patchLines.filter(
		(line) => line.startsWith("-") && !line.startsWith("---"),
	).length;
	const data = {
		path: match.path,
		additions,
		deletions,
		patch: match.patch,
	};
	return {
		data,
		lines: [
			`diff ${match.path}  +${additions}  -${deletions}`,
			"",
			...patchLines,
		],
	};
}

function parseInclude(raw) {
	const names = (raw ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
	const valid = Object.keys(SECTIONS);
	if (!names.length) {
		fail(`--include needs at least one section. Valid: ${valid.join(", ")}`);
	}
	const unknown = names.filter((name) => !valid.includes(name));
	if (unknown.length) {
		fail(
			`unknown section(s): ${unknown.join(", ")}. Valid: ${valid.join(", ")}`,
		);
	}
	return names;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const COMMANDS = {
	...Object.fromEntries(
		Object.entries(PRESETS).map(([name, preset]) => [
			name,
			{
				usage: `${name} <pr>`,
				description: preset.description,
				run(positionals, values) {
					const { pr } = readPositionals(
						positionals,
						{ required: ["pr"] },
						USAGE,
					);
					const prNumber = parsePositiveInteger(pr, "pr");
					return composeSections(
						resolveRepo(values.repo),
						prNumber,
						preset.include,
					);
				},
			},
		]),
	),

	view: {
		usage: "view <pr> --include <sections>",
		description: "Compose any sections in one call.",
		run(positionals, values) {
			const { pr } = readPositionals(positionals, { required: ["pr"] }, USAGE);
			const prNumber = parsePositiveInteger(pr, "pr");
			const sectionNames = parseInclude(values.include);
			return composeSections(resolveRepo(values.repo), prNumber, sectionNames);
		},
	},

	diff: {
		usage: "diff <pr> <file>",
		description: "Unified diff for a single changed file.",
		run(positionals, values) {
			const { pr, file } = readPositionals(
				positionals,
				{ required: ["pr", "file"] },
				USAGE,
			);
			const prNumber = parsePositiveInteger(pr, "pr");
			return fileDiff(resolveRepo(values.repo), prNumber, file);
		},
	},

	list: {
		usage: "list",
		description: "Open pull requests (number, title, branch).",
		run(positionals, values) {
			readPositionals(positionals, { required: [] }, USAGE);
			const repo = resolveRepo(values.repo);
			const pullRequests = runGitHub([
				"pr",
				"list",
				"--repo",
				repo,
				"--state",
				"open",
				"--json",
				"number,title,headRefName,isDraft",
			]);
			return {
				data: pullRequests,
				lines: pullRequests.length
					? pullRequests.map(
							(pullRequest) =>
								`#${pullRequest.number} ${pullRequest.title}` +
								`${pullRequest.isDraft ? " (draft)" : ""} [${pullRequest.headRefName}]`,
						)
					: ["No open pull requests."],
			};
		},
	},
};

const USAGE_WIDTH = Math.max(
	...Object.values(COMMANDS).map((command) => command.usage.length),
);

const USAGE = `Read-only GitHub PR status reporter.

Usage: pr-status <report> [--repo owner/name] [--json]

${Object.values(COMMANDS)
	.map(
		(command) =>
			`  ${command.usage.padEnd(USAGE_WIDTH)}  ${command.description}`,
	)
	.join("\n")}

Sections for view: ${Object.keys(SECTIONS).join(", ")}.
--repo targets another repo (defaults to the current checkout). --json emits
the distilled object instead of text.`;

const { values, positionals } = parseCommandLine(USAGE, {
	repo: repoOption,
	json: { type: "boolean" },
	include: { type: "string" },
});
const [commandName, ...commandPositionals] = positionals;
if (commandName === undefined) {
	printUsage(USAGE);
}
if (!Object.hasOwn(COMMANDS, commandName)) {
	failWithUsage(`unknown report: ${commandName}`, USAGE);
}
emit(COMMANDS[commandName].run(commandPositionals, values), values.json);

function emit(result, json) {
	process.stdout.write(
		json
			? `${JSON.stringify(result.data, undefined, 2)}\n`
			: `${result.lines.join("\n")}\n`,
	);
}

// ── GitHub reads ──────────────────────────────────────────────────────────────

function fetchPullRequest(repo, prNumber, fields) {
	return runGitHub([
		"pr",
		"view",
		String(prNumber),
		"--repo",
		repo,
		"--json",
		fields.join(","),
	]);
}

function fetchDiff(repo, prNumber) {
	return runGitHubText(["pr", "diff", String(prNumber), "--repo", repo]);
}

// Split a unified PR diff into one block per file, keyed by the post-image path
// (the `b/…` side, which is right for additions and renames alike).
function splitDiff(raw) {
	if (!raw.trim()) {
		return [];
	}
	return raw
		.split(/\n(?=diff --git )/)
		.map((part) => {
			const header = part.split("\n", 1)[0];
			const match = header.match(/^diff --git a\/.+ b\/(.+)$/);
			return { path: match ? match[1] : header, patch: part };
		})
		.filter((block) => block.path);
}

function fetchReviewThreads(repo, prNumber) {
	const [owner, name] = splitRepo(repo);
	const query = `
		query ($owner: String!, $name: String!, $number: Int!) {
			repository(owner: $owner, name: $name) {
				pullRequest(number: $number) {
					reviewThreads(last: 50) {
						nodes {
							id
							isResolved
							path
							line
							originalLine
							comments(first: 20) {
								nodes { author { login } body diffHunk }
							}
						}
					}
				}
			}
		}`;

	const response = runGitHub([
		"api",
		"graphql",
		"-f",
		`query=${query}`,
		"-f",
		`owner=${owner}`,
		"-f",
		`name=${name}`,
		"-F",
		`number=${prNumber}`,
	]);

	return response.data.repository.pullRequest.reviewThreads.nodes.map(
		(thread) => {
			const comments = thread.comments.nodes.map((comment) => ({
				author: comment.author?.login ?? "unknown",
				body: comment.body ?? "",
			}));
			const first = comments[0] ?? {};
			return {
				id: thread.id,
				resolved: thread.isResolved,
				author: first.author ?? "unknown",
				path: thread.path ?? "",
				line: thread.line ?? thread.originalLine ?? undefined,
				diffHunk: thread.comments.nodes[0]?.diffHunk ?? "",
				body: first.body ?? "",
				comments,
			};
		},
	);
}

// ── Read-only guard ──────────────────────────────────────────────────────────

// Every report's gh call goes through here: assert it is on the read-only
// allowlist, then run it via the shared (policy-free) gh runner. Keeping the
// allowlist local is what makes this script read-only by construction.
function runGitHub(args) {
	assertReadOnly(args);
	return execGitHub(args, { json: true });
}

// Text variant for reads that are not JSON (e.g. `pr diff`), gated by the same
// read-only allowlist.
function runGitHubText(args) {
	assertReadOnly(args);
	return execGitHub(args, { json: false });
}

function assertReadOnly(args) {
	const allowed = READ_ONLY_COMMANDS.some((prefix) =>
		prefix.every((part, index) => args[index] === part),
	);
	if (!allowed) {
		fail(`refusing non-read-only gh command: gh ${args.slice(0, 2).join(" ")}`);
	}
	args.forEach((argument) => {
		if (argument === "-X" || argument === "--method") {
			fail("refusing gh call with an explicit HTTP method");
		}
		if (/\bmutation\b/.test(argument)) {
			fail("refusing gh call containing a GraphQL mutation");
		}
	});
}

// ── Small helpers ────────────────────────────────────────────────────────────

function icon(result) {
	if (result === "SUCCESS") return "✓";
	if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT"].includes(result))
		return "✗";
	return "•";
}

// Single-letter glyph for a file's change type (ADDED → A, MODIFIED → M, …).
function changeIcon(changeType) {
	return changeType ? changeType.charAt(0).toUpperCase() : "?";
}

function oneLine(text) {
	return text.replace(/\s+/g, " ").trim();
}

// PR descriptions carry the repo's HTML-comment template and ragged blank
// lines; strip both so the distilled body stays compact.
function cleanBody(raw) {
	return (raw ?? "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

// GitHub anchors a comment at the last line of its diff hunk, so the tail is the
// relevant context. Keep the final few lines and mark earlier ones as elided.
function diffContext(diffHunk, tail = 5) {
	if (!diffHunk) {
		return [];
	}
	const lines = diffHunk.split("\n");
	const context = lines.slice(-tail).map((line) => `    ${line}`);
	return lines.length > tail ? ["    …", ...context] : context;
}
