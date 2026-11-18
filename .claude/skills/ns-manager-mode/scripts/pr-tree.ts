#!/usr/bin/env node
// pr-tree.ts: Print open PRs as a tree nested by base branch, or one PR's
// stack as a section for its description. Read-only.
//
// A label counts when its name starts with an emoji, and each PR shows only
// that emoji; the legend names every mark and label the scripts know. Branch
// labels (feature, stacked) print after the state.

import { fileURLToPath } from "node:url";
import type { Mergeable } from "./gh-lib.ts";
import {
	execGitHub,
	fail,
	parseCommandLine,
	parsePositiveInteger,
	readPositionals,
	repoOption,
	resolveRepo,
} from "./gh-lib.ts";
import { LABELS } from "./labels.ts";

// A mergeability mark: its glyph, the ANSI colour code it prints in, and its
// name in the legend.
type Mark = { glyph: string; color: string; name: string };

// An open PR as the `pr list` call below returns it.
export type PullRequest = {
	id: string;
	number: number;
	title: string;
	url: string;
	baseRefName: string;
	headRefName: string;
	isDraft: boolean;
	labels: { name: string }[];
	mergeable: Mergeable;
	author: { login: string };
	body: string;
};

type TreeRow = {
	pr: PullRequest;
	lead: string;
	name: string;
	padding: string;
	mark: Mark;
	emojis: string;
};

const MARKS: Record<Mergeable, Mark> = {
	MERGEABLE: { glyph: "●", color: "32", name: "mergeable" },
	CONFLICTING: { glyph: "✕", color: "31", name: "conflicting" },
	UNKNOWN: { glyph: "⭘", color: "2", name: "unknown" },
};
const DRAFT_LABEL = "📝 draft";
const LEGEND_LABELS = [
	...Object.values(LABELS).map((label) => label.name),
	DRAFT_LABEL,
];
export const STACK_START = "<!-- pr-tree:start -->";
export const STACK_END = "<!-- pr-tree:end -->";
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
	const pullRequests = readOpenPullRequests(repo);
	if (described === undefined) {
		printTree(readDefaultBranch(repo), pullRequests);
	} else {
		const section = stackSection(pullRequests, described);
		if (section === undefined) {
			fail(`#${described} is not an open PR with an emoji label in ${repo}`);
		}
		console.log(section);
	}
}

export function readOpenPullRequests(repo: string) {
	return execGitHub(
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
			"id,number,title,url,baseRefName,headRefName,isDraft,labels,mergeable,author,body",
		],
		{ json: true },
	) as PullRequest[];
}

// The PR's stack as a "## Stack" section between the markers: the chain of PRs
// it sits on, from the root branch down, and every PR stacked on it, forks
// included. Undefined when the PR isn't open with an emoji label.
export function stackSection(pullRequests: PullRequest[], number: number) {
	const ours = pullRequests.filter(isTracked);
	const pullRequest = ours.find((pr) => pr.number === number);
	if (!pullRequest) {
		return undefined;
	}
	const ancestors = ancestorsOf(ours, pullRequest);
	const stack = new Set(
		[...ancestors, pullRequest, ...descendantsOf(ours, pullRequest)].map(
			(pr) => pr.number,
		),
	);
	const root = (ancestors[0] ?? pullRequest).baseRefName;
	const rows = treeRows(ours, root, "", (pr) => stack.has(pr.number));
	const lines = rows.map((row) => {
		const link = `<a href="${escapeHtml(row.pr.url)}">#${row.pr.number}</a>`;
		const text =
			`${row.mark.glyph} ${link} ${escapeHtml(row.pr.headRefName)}${row.padding} ${escapeHtml(row.emojis)}`.trimEnd();
		return row.pr.number === number
			? `${row.lead}<b>${text}  ◀ this PR</b>`
			: `${row.lead}${text}`;
	});
	return [
		STACK_START,
		"## Stack",
		"",
		"<pre>",
		escapeHtml(root),
		...lines,
		"</pre>",
		"",
		legend((mark) => mark.glyph).join("\n\n"),
		STACK_END,
	].join("\n");
}

function readDefaultBranch(repo: string) {
	const repository = execGitHub(
		["repo", "view", repo, "--json", "defaultBranchRef"],
		{ json: true },
	) as { defaultBranchRef: { name: string } };
	return repository.defaultBranchRef.name;
}

function printTree(defaultBranch: string, pullRequests: PullRequest[]) {
	const ours = pullRequests.filter(isTracked);
	const untracked = pullRequests.filter((pr) => !isTracked(pr));
	// A base that is neither the default branch nor an open PR's head gets a
	// root of its own.
	const roots = [
		defaultBranch,
		...new Set(
			ours
				.map((pr) => pr.baseRefName)
				.filter(
					(base) =>
						base !== defaultBranch &&
						!ours.some((pr) => pr.headRefName === base),
				),
		),
	];
	roots.forEach((root) => {
		console.log(root);
		treeRows(ours, root, "", () => true).forEach((row) => {
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

// Every PR under the branch that `include` accepts, depth first, with the
// connectors that draw it into the tree.
function treeRows(
	ours: PullRequest[],
	branch: string,
	prefix: string,
	include: (pr: PullRequest) => boolean,
): TreeRow[] {
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
		const row: TreeRow = {
			pr,
			lead,
			name,
			padding: " ".repeat(Math.max(0, NAME_WIDTH - lead.length - name.length)),
			mark: MARKS[pr.mergeable] ?? MARKS.UNKNOWN,
			emojis: labels.map(emojiOf).join(" "),
		};
		return [
			row,
			...treeRows(
				ours,
				pr.headRefName,
				prefix + (last ? "   " : "│  "),
				include,
			),
		];
	});
}

// One line for the marks, drawn by `drawMark`, and one for the labels.
function legend(drawMark: (mark: Mark) => string) {
	return [
		Object.values(MARKS)
			.map((mark) => `${drawMark(mark)} ${mark.name}`)
			.join(" · "),
		LEGEND_LABELS.join(" · "),
	];
}

function ancestorsOf(ours: PullRequest[], pr: PullRequest): PullRequest[] {
	const parent = ours.find(
		(candidate) => candidate.headRefName === pr.baseRefName,
	);
	return parent ? [...ancestorsOf(ours, parent), parent] : [];
}

function descendantsOf(ours: PullRequest[], pr: PullRequest): PullRequest[] {
	return ours
		.filter((child) => child.baseRefName === pr.headRefName)
		.flatMap((child) => [child, ...descendantsOf(ours, child)]);
}

function paint(mark: Mark) {
	return color ? `\x1b[${mark.color}m${mark.glyph}\x1b[0m` : mark.glyph;
}

function escapeHtml(text: string) {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function emojiOf(label: string) {
	return label.split(" ", 1)[0];
}

function isTracked(pr: PullRequest) {
	return pr.labels.some((label) => isEmojiLabel(label.name));
}

function isEmojiLabel(name: string) {
	return /^\p{Extended_Pictographic}/u.test(name);
}

function isBranchLabel(name: string) {
	return /^\P{L}+ (feature|stacked)$/u.test(name);
}
