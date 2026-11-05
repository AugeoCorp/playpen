#!/usr/bin/env node
// pr-comment.ts: Write companion to pr-status.ts.
//
// Constrained by construction: this script exposes a CLOSED set of comment
// commands, each running one hardcoded GraphQL mutation that must pass a local
// allowlist of mutation names. It can ONLY post PR comments and review
// threads/replies; it cannot edit, merge, close, label, or run an arbitrary
// `gh` command. User input only ever fills mutation *variables* (via gh's -f/-F
// flags), never the query text, so it cannot inject GraphQL.
//
// Because it writes to GitHub it is intentionally NOT blanket-allowed: keep it
// behind a permission prompt, so every comment is approved before it is posted.

import type { MutationVariables } from "./gh-lib.ts";
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
	runAllowedMutation,
	splitRepo,
} from "./gh-lib.ts";

const ALLOWED_MUTATIONS = new Set([
	"addComment",
	"addPullRequestReviewThreadReply",
	"addPullRequestReviewThread",
]);

const USAGE = `Post a PR comment or review thread reply (gated behind approval).

Usage:
  pr-comment comment <pr> <body>             General comment on the PR.
  pr-comment reply <threadId> <body>         Reply to a review thread.
  pr-comment line <pr> <path> <line> <body>  Comment on one diff line.

Thread ids come from pr-status threads. Quote each body. --repo owner/name
targets another repo for comment and line.`;

// Each command posts one thing and returns its URL.
type Command = (positionals: string[], values: { repo?: string }) => string;

const COMMANDS: Record<string, Command> = {
	comment(positionals, values) {
		const { pr, body } = readPositionals(
			positionals,
			{ required: ["pr", "body"] },
			USAGE,
		);
		const prNumber = parsePositiveInteger(pr, "pr");
		const text = parseText(body, "body");
		return postComment(resolveRepo(values.repo), prNumber, text);
	},

	reply(positionals) {
		const { threadId, body } = readPositionals(
			positionals,
			{ required: ["threadId", "body"] },
			USAGE,
		);
		return postReply(parseText(threadId, "threadId"), parseText(body, "body"));
	},

	line(positionals, values) {
		const { pr, path, line, body } = readPositionals(
			positionals,
			{ required: ["pr", "path", "line", "body"] },
			USAGE,
		);
		const prNumber = parsePositiveInteger(pr, "pr");
		const filePath = parseText(path, "path");
		const lineNumber = parsePositiveInteger(line, "line");
		const text = parseText(body, "body");
		return postLine(
			resolveRepo(values.repo),
			prNumber,
			filePath,
			lineNumber,
			text,
		);
	},
};

const { values, positionals } = parseCommandLine(USAGE, { repo: repoOption });
const [commandName, ...commandPositionals] = positionals;
if (commandName === undefined) {
	printUsage(USAGE);
}
if (!Object.hasOwn(COMMANDS, commandName)) {
	failWithUsage(`unknown command: ${commandName}`, USAGE);
}
announce(COMMANDS[commandName](commandPositionals, values));

// ── Mutations ────────────────────────────────────────────────────────────────

function postComment(repo: string, pr: number, body: string) {
	const subjectId = pullRequestNodeId(repo, pr);
	const query = `
		mutation ($subjectId: ID!, $body: String!) {
			addComment(input: { subjectId: $subjectId, body: $body }) {
				commentEdge { node { url } }
			}
		}`;
	const response = runMutation(query, { subjectId, body }) as {
		data: { addComment: { commentEdge: { node: { url: string } } } };
	};
	return response.data.addComment.commentEdge.node.url;
}

function postReply(threadId: string, body: string) {
	const query = `
		mutation ($threadId: ID!, $body: String!) {
			addPullRequestReviewThreadReply(
				input: { pullRequestReviewThreadId: $threadId, body: $body }
			) {
				comment { url }
			}
		}`;
	const response = runMutation(query, { threadId, body }) as {
		data: { addPullRequestReviewThreadReply: { comment: { url: string } } };
	};
	return response.data.addPullRequestReviewThreadReply.comment.url;
}

function postLine(
	repo: string,
	pr: number,
	path: string,
	line: number,
	body: string,
) {
	const pullRequestId = pullRequestNodeId(repo, pr);
	const query = `
		mutation ($pullRequestId: ID!, $path: String!, $line: Int!, $body: String!) {
			addPullRequestReviewThread(
				input: {
					pullRequestId: $pullRequestId
					path: $path
					line: $line
					side: RIGHT
					body: $body
				}
			) {
				thread { comments(first: 1) { nodes { url } } }
			}
		}`;
	const response = runMutation(query, { pullRequestId, path, line, body }) as {
		data: {
			addPullRequestReviewThread: {
				thread: { comments: { nodes: { url: string }[] } };
			};
		};
	};
	return response.data.addPullRequestReviewThread.thread.comments.nodes[0].url;
}

// ── GitHub calls ───────────────────────────────────────────────────────────

// Look up a PR's GraphQL node id, the subject most mutations anchor to. This is
// a read, so it goes straight to the shared runner (not the mutation allowlist).
function pullRequestNodeId(repo: string, pr: number) {
	const [owner, name] = splitRepo(repo);
	const query = `
		query ($owner: String!, $name: String!, $number: Int!) {
			repository(owner: $owner, name: $name) {
				pullRequest(number: $number) { id }
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
			`number=${pr}`,
		],
		{ json: true },
	) as { data: { repository: { pullRequest: { id: string } } } };
	return response.data.repository.pullRequest.id;
}

function runMutation(query: string, variables: MutationVariables) {
	return runAllowedMutation(query, variables, ALLOWED_MUTATIONS);
}

function parseText(raw: string, name: string) {
	const text = raw.trim();
	if (!text) {
		fail(`${name}: must not be empty`);
	}
	return text;
}

function announce(url: string) {
	process.stdout.write(`Posted: ${url}\n`);
}
