#!/usr/bin/env node
// pr-describe.ts: Write each PR's Stack section, the one `pr-tree
// --description` prints, into its description.
//
// It replaces only the lines from `<!-- pr-tree:start -->` to
// `<!-- pr-tree:end -->`, or appends the section when no line holds a marker,
// so every byte outside that section stays as it was. A marker counts only on
// a line of its own, and a body with any other set of markers is skipped.
//
// Constrained by construction: the one write is a hardcoded `updatePullRequest`
// that sets the body and nothing else, checked against a local allowlist, with
// user input only ever filling variables. Because it writes to GitHub, keep it
// behind a permission prompt.

import { fileURLToPath } from "node:url";
import {
	execGitHub,
	fail,
	parseCommandLine,
	parsePositiveInteger,
	repoOption,
	resolveRepo,
	runAllowedMutation,
	splitRepo,
} from "./gh-lib.ts";
import type { MutationVariables } from "./gh-lib.ts";
import type { PullRequest } from "./pr-tree.ts";
import {
	readOpenPullRequests,
	STACK_END,
	STACK_START,
	stackSection,
} from "./pr-tree.ts";

const ALLOWED_MUTATIONS = new Set(["updatePullRequest"]);
// GraphQL reads commas as whitespace, so the comparison drops them too.
const ALLOWED_INPUT = "{ pullRequestId: $pullRequestId body: $body }";
const START_LINE = new RegExp(`^[ \\t]*${STACK_START}[ \\t]*$`, "gm");
const END_LINE = new RegExp(`^[ \\t]*${STACK_END}[ \\t]*$`, "gm");

const USAGE = `Write each PR's Stack section into its description (gated behind approval).

Usage: pr-describe [--repo owner/name] [--dry-run] [<pr> ...]

The section is what pr-tree --description prints. It replaces the lines from
pr-tree:start to pr-tree:end, or appends the section when no line holds a
marker, leaving every byte outside the section as it was. A marker counts only
on a line of its own; a body with more than one section, or a marker without
its pair, is skipped. With no PR numbers it does every open PR. Prints one line
per PR, in number order: updated, unchanged or skipped. Stops at the first
write gh refuses, with gh's error.

--dry-run prints what it would do and writes nothing.`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const { values, positionals } = parseCommandLine(USAGE, {
		repo: repoOption,
		"dry-run": { type: "boolean" },
	});
	// Any number of PRs, so they don't fit readPositionals' fixed names.
	const numbers = positionals.map((pr) => parsePositiveInteger(pr, "pr"));
	const dryRun = values["dry-run"] ?? false;
	const repo = resolveRepo(values.repo);
	const pullRequests = readOpenPullRequests(repo);
	const targets = [
		...new Set(numbers.length ? numbers : pullRequests.map((pr) => pr.number)),
	].sort((left, right) => left - right);
	targets.forEach((number) => {
		console.log(
			`#${number} ${writeStackSection(repo, pullRequests, number, dryRun)}`,
		);
	});
}

function writeStackSection(
	repo: string,
	pullRequests: PullRequest[],
	number: number,
	dryRun: boolean,
) {
	const section = stackSection(pullRequests, number);
	const listed = pullRequests.find((pr) => pr.number === number);
	if (section === undefined || listed === undefined) {
		return "skipped: not an open PR with an emoji label";
	}
	// A write starts from a fresh read: the listed body may predate an edit,
	// which writing over it would lose.
	const { id, body } = dryRun ? listed : readBody(repo, number);
	const next = withSection(body, section);
	if (next === undefined) {
		return "skipped: the Stack markers don't make one section";
	}
	if (next === body) {
		return "unchanged";
	}
	if (dryRun) {
		return "would update";
	}
	updateBody(id, next);
	return "updated";
}

function withSection(body: string, section: string) {
	const starts = [...body.matchAll(START_LINE)];
	const ends = [...body.matchAll(END_LINE)];
	if (!starts.length && !ends.length) {
		return body === "" ? section : `${body}\n\n${section}`;
	}
	if (
		starts.length !== 1 ||
		ends.length !== 1 ||
		ends[0].index < starts[0].index
	) {
		return undefined;
	}
	return (
		body.slice(0, starts[0].index) +
		section +
		body.slice(ends[0].index + ends[0][0].length)
	);
}

// ── GitHub calls ─────────────────────────────────────────────────────────────

function readBody(repo: string, number: number) {
	const [owner, name] = splitRepo(repo);
	const query = `
		query ($owner: String!, $name: String!, $number: Int!) {
			repository(owner: $owner, name: $name) {
				pullRequest(number: $number) { id body }
			}
		}`;
	const response = execGitHub(
		[
			"api",
			"graphql",
			"-f",
			`query=${query}`,
			"-f",
			`owner=${owner}`,
			"-f",
			`name=${name}`,
			"-F",
			`number=${number}`,
		],
		{ json: true },
	) as {
		data: { repository: { pullRequest: { id: string; body: string } } };
	};
	return response.data.repository.pullRequest;
}

function updateBody(pullRequestId: string, body: string) {
	runMutation(
		`
		mutation ($pullRequestId: ID!, $body: String!) {
			updatePullRequest(input: { pullRequestId: $pullRequestId, body: $body }) {
				clientMutationId
			}
		}`,
		{ pullRequestId, body },
	);
}

// The allowlist checks the mutation's name; this also checks that every input
// it sends is the body and nothing else, so an edit can't widen it to the
// title, base or state.
export function runMutation(query: string, variables: MutationVariables) {
	const inputs = [...query.matchAll(/\binput[\s,]*:[\s,]*([^)]*)/g)].map(
		(match) => match[1].replace(/[\s,]+/g, " ").trim(),
	);
	if (!inputs.length || inputs.some((input) => input !== ALLOWED_INPUT)) {
		fail("refusing mutation that sets more than the body");
	}
	return runAllowedMutation(query, variables, ALLOWED_MUTATIONS);
}
