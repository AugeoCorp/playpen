#!/usr/bin/env node
// pr-tree.mjs: Print open PRs as a tree nested by base branch, or one PR's
// stack as a section for its description. Read-only.
//
// A label counts when its name starts with an emoji, and each PR shows only
// that emoji; the legend names every mark and label the scripts know. Branch
// labels (feature, stacked) print after the state.

import {
	execGitHub,
	fail,
	parseCommandLine,
	parsePositiveInteger,
	readPositionals,
	repoOption,
	resolveRepo,
} from "./gh-lib.mjs";
import { LABELS } from "./labels.mjs";

const MARKS = {
	MERGEABLE: { glyph: "●", color: "32", name: "mergeable" },
	CONFLICTING: { glyph: "✕", color: "31", name: "conflicting" },
	UNKNOWN: { glyph: "⭘", color: "2", name: "unknown" },
};
const DRAFT_LABEL = "📝 draft";
const LEGEND_LABELS = [
	...Object.values(LABELS).map((label) => label.name),
	DRAFT_LABEL,
];
// The width of a line's connectors and PR name together, so the emojis after
// it line up.
const NAME_WIDTH = 46;
const color = !process.env.NO_COLOR;

const USAGE = `Print open PRs as a tree nested by base branch.

Usage: pr-tree [--repo owner/name] [--description <pr>]

Leading mark: ● mergeable, ✕ conflicting, ⭘ unknown (coloured unless NO_COLOR
is set), then the emoji of each emoji label. PRs with no emoji label go on one
"untracked" line, author in brackets. A legend at the end names every mark and
label.

--description <pr> prints that PR's stack instead, as a "## Stack" section for
its description between pr-tree:start and pr-tree:end markers, with every PR
linked. It only prints; it never edits the PR.`;

const { values, positionals } = parseCommandLine(USAGE, {
	repo: repoOption,
	description: { type: "string" },
});
readPositionals(positionals, { required: [] }, USAGE);
const described =
	values.description === undefined
		? undefined
		: parsePositiveInteger(values.description, "description");
const repo = resolveRepo(values.repo);

const defaultBranch = execGitHub(
	["repo", "view", repo, "--json", "defaultBranchRef"],
	{ json: true },
).defaultBranchRef.name;
const all = execGitHub(
	[
		"pr",
		"list",
		"--repo",
		repo,
		"--state",
		"open",
		"--limit",
		"200",
		"--json",
		"number,title,url,baseRefName,headRefName,isDraft,labels,mergeable,author",
	],
	{ json: true },
);
const ours = all.filter(isTracked);
const untracked = all.filter((pr) => !isTracked(pr));
const byHead = new Map(ours.map((pr) => [pr.headRefName, pr]));

if (described === undefined) {
	printTree();
} else {
	printDescription(described);
}

function printTree() {
	// A base that is neither the default branch nor an open PR's head gets a
	// root of its own.
	const roots = [
		defaultBranch,
		...new Set(
			ours
				.map((pr) => pr.baseRefName)
				.filter((base) => base !== defaultBranch && !byHead.has(base)),
		),
	];
	roots.forEach((root) => {
		console.log(root);
		treeRows(root, "", () => true).forEach((row) => {
			console.log(
				`${row.lead}${paint(row.mark)} ${row.name}${row.padding} ${row.emojis}`.trimEnd(),
			);
		});
	});
	if (untracked.length > 0) {
		const list = untracked
			.map((pr) => `#${pr.number} ${pr.headRefName} [${pr.author.login}]`)
			.join(", ");
		console.log(`\n${paint(MARKS.UNKNOWN)} untracked: ${list}`);
	}
	console.log(`\n${legend(paint).join("\n")}`);
}

// The PR's stack: the chain of PRs it sits on, from the root branch down, and
// every PR stacked on it, forks included.
function printDescription(number) {
	const pullRequest = ours.find((pr) => pr.number === number);
	if (!pullRequest) {
		fail(`#${number} is not an open PR with an emoji label in ${repo}`);
	}
	const ancestors = ancestorsOf(pullRequest);
	const stack = new Set(
		[...ancestors, pullRequest, ...descendantsOf(pullRequest)].map(
			(pr) => pr.number,
		),
	);
	const root = (ancestors[0] ?? pullRequest).baseRefName;
	const rows = treeRows(root, "", (pr) => stack.has(pr.number));
	const lines = rows.map((row) => {
		const link = `<a href="${escapeHtml(row.pr.url)}">#${row.pr.number}</a>`;
		const text =
			`${row.mark.glyph} ${link} ${escapeHtml(row.pr.headRefName)}${row.padding} ${escapeHtml(row.emojis)}`.trimEnd();
		return row.pr.number === number
			? `${row.lead}<b>${text}  ◀ this PR</b>`
			: `${row.lead}${text}`;
	});
	console.log(
		[
			"<!-- pr-tree:start -->",
			"## Stack",
			"",
			"<pre>",
			escapeHtml(root),
			...lines,
			"</pre>",
			"",
			legend((mark) => mark.glyph).join("\n\n"),
			"<!-- pr-tree:end -->",
		].join("\n"),
	);
}

// Every PR under the branch that `include` accepts, depth first, with the
// connectors that draw it into the tree.
function treeRows(branch, prefix, include) {
	const siblings = ours.filter(
		(pr) => pr.baseRefName === branch && include(pr),
	);
	return siblings.flatMap((pr, index) => {
		const last = index === siblings.length - 1;
		const lead = `${prefix}${last ? "└─ " : "├─ "}`;
		const name = `#${pr.number} ${pr.headRefName}`;
		const emojiLabels = pr.labels
			.map((label) => label.name)
			.filter(isEmojiLabel);
		const labels = [
			...emojiLabels.filter((label) => !isBranchLabel(label)),
			...emojiLabels.filter(isBranchLabel),
			...(pr.isDraft ? [DRAFT_LABEL] : []),
		];
		const row = {
			pr,
			lead,
			name,
			padding: " ".repeat(Math.max(0, NAME_WIDTH - lead.length - name.length)),
			mark: MARKS[pr.mergeable] ?? MARKS.UNKNOWN,
			emojis: labels.map(emojiOf).join(" "),
		};
		return [
			row,
			...treeRows(pr.headRefName, prefix + (last ? "   " : "│  "), include),
		];
	});
}

// One line for the marks, drawn by `drawMark`, and one for the labels.
function legend(drawMark) {
	return [
		Object.values(MARKS)
			.map((mark) => `${drawMark(mark)} ${mark.name}`)
			.join(" · "),
		LEGEND_LABELS.join(" · "),
	];
}

function ancestorsOf(pr) {
	const parent = byHead.get(pr.baseRefName);
	return parent ? [...ancestorsOf(parent), parent] : [];
}

function descendantsOf(pr) {
	return ours
		.filter((child) => child.baseRefName === pr.headRefName)
		.flatMap((child) => [child, ...descendantsOf(child)]);
}

function paint(mark) {
	return color ? `\x1b[${mark.color}m${mark.glyph}\x1b[0m` : mark.glyph;
}

function escapeHtml(text) {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function emojiOf(label) {
	return label.split(" ", 1)[0];
}

function isTracked(pr) {
	return pr.labels.some((label) => isEmojiLabel(label.name));
}

function isEmojiLabel(name) {
	return /^\p{Extended_Pictographic}/u.test(name);
}

function isBranchLabel(name) {
	return /^\P{L}+ (feature|stacked)$/u.test(name);
}
