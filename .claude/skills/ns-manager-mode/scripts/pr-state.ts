#!/usr/bin/env node
// pr-state.ts: Set or show a PR's state label, keeping its draft flag in
// step.
//
// A PR carries one state label at a time. Setting a state swaps out whichever
// other state label it has, then marks the PR draft or ready to match, except
// `blocked`, which leaves it. The states are not a pipeline: a PR can move
// between them in any order.
//
// `✅ approved` is The Operator's call, so this tool will remove it when the
// state moves on but never add it.
//
// `🥞 stacked` and `👣️ feature` are not states. Stacked says the PR's base is
// another branch rather than the default one, and feature says its head branch
// starts with `feature/`, so the tool keeps both in step on every run.
//
// Constrained by construction: each write is one hardcoded GraphQL mutation
// checked against a local allowlist, with user input only ever filling
// variables. It touches state labels, the stacked and feature labels, and
// draft status, nothing else.

import type { MutationVariables, PullRequestState } from "./gh-lib.ts";
import {
	execGitHub,
	fail,
	parseCommandLine,
	parsePositiveInteger,
	readPositionals,
	repoOption,
	resolveRepo,
	runAllowedMutation,
	splitRepo,
} from "./gh-lib.ts";
import { LABELS } from "./labels.ts";

// A settable state: its label, and whether the PR should be a draft while in
// it. An undefined draft leaves the PR's draft status as it is.
type State = { label: string; draft: boolean | undefined };

// Each settable state by the plain words the command line takes.
const STATES = new Map<string, State>([
	["working", { label: LABELS.working.name, draft: true }],
	["self review", { label: LABELS.selfReview.name, draft: true }],
	["needs decision", { label: LABELS.needsDecision.name, draft: true }],
	["blocked", { label: LABELS.blocked.name, draft: undefined }],
	["review requested", { label: LABELS.reviewRequested.name, draft: false }],
]);

// State labels the tool clears but never sets.
const REMOVE_ONLY_LABELS = new Set([LABELS.approved.name]);

const STATE_LABELS = new Set([
	...[...STATES.values()].map((state) => state.label),
	...REMOVE_ONLY_LABELS,
]);

const FEATURE_BRANCH_PREFIX = "feature/";

const ALLOWED_MUTATIONS = new Set([
	"addLabelsToLabelable",
	"removeLabelsFromLabelable",
	"convertPullRequestToDraft",
	"markPullRequestReadyForReview",
]);

const USAGE = `Set or show a PR's state label and draft status.

Usage: pr-state <pr> [state] [--repo owner/name]

  <pr>           Show the PR's state label and whether it is a draft.
  <pr> <state>   Set the state by its plain words. Hyphens work for spaces:
                 review-requested sets \`👀 review requested\`.

States: ${[...STATES.keys()].join(", ")}`;

type Label = { id: string; name: string };

// The PR as readPullRequest's query returns it.
type PullRequestNode = {
	id: string;
	number: number;
	url: string;
	state: PullRequestState;
	isDraft: boolean;
	baseRefName: string;
	headRefName: string;
	labels: { nodes: Label[] };
};

type PullRequest = Omit<PullRequestNode, "labels"> & {
	labels: Label[];
	defaultBranch: string;
	repositoryLabels: Label[];
};

const { values, positionals } = parseCommandLine(USAGE, { repo: repoOption });
const { pr, state } = readPositionals(
	positionals,
	{ required: ["pr"], optional: ["state"] },
	USAGE,
);
const prNumber = parsePositiveInteger(pr, "pr");
const nextState = state === undefined ? undefined : parseState(state);
const repo = resolveRepo(values.repo);
const pullRequest = readPullRequest(repo, prNumber);
if (nextState) {
	setState(pullRequest, nextState);
}
syncLabel(pullRequest, LABELS.stacked.name, isStacked(pullRequest));
syncLabel(pullRequest, LABELS.feature.name, isFeature(pullRequest));
report(readPullRequest(repo, prNumber));

// Checks and the draft change come first: draft is the call GitHub is likeliest
// to refuse, and doing it before the labels means a refusal leaves them as-is.
function setState(pullRequest: PullRequest, state: State) {
	if (pullRequest.state !== "OPEN") {
		fail(`#${pullRequest.number} is ${pullRequest.state.toLowerCase()}`);
	}
	const { label: labelName, draft } = state;
	const label = findRepositoryLabel(pullRequest, labelName);

	if (draft === true && !pullRequest.isDraft) {
		convertToDraft(pullRequest.id);
	} else if (draft === false && pullRequest.isDraft) {
		markReady(pullRequest.id);
	}

	const stale = pullRequest.labels.filter(
		(current) => current.name !== labelName && STATE_LABELS.has(current.name),
	);
	if (stale.length) {
		removeLabels(
			pullRequest.id,
			stale.map((label) => label.id),
		);
	}

	if (!pullRequest.labels.some((current) => current.name === labelName)) {
		addLabels(pullRequest.id, [label.id]);
	}
}

// Keeps a label that is not a state on the PR exactly when it applies.
function syncLabel(
	pullRequest: PullRequest,
	labelName: string,
	applies: boolean,
) {
	if (pullRequest.state !== "OPEN") {
		return;
	}
	const label = findRepositoryLabel(pullRequest, labelName);
	const has = pullRequest.labels.some((current) => current.name === label.name);
	if (applies && !has) {
		addLabels(pullRequest.id, [label.id]);
	} else if (!applies && has) {
		removeLabels(pullRequest.id, [label.id]);
	}
}

function isStacked(pullRequest: PullRequest) {
	return pullRequest.baseRefName !== pullRequest.defaultBranch;
}

function isFeature(pullRequest: PullRequest) {
	return pullRequest.headRefName.startsWith(FEATURE_BRANCH_PREFIX);
}

function findRepositoryLabel(pullRequest: PullRequest, labelName: string) {
	const label = pullRequest.repositoryLabels.find(
		(candidate) => candidate.name === labelName,
	);
	if (!label) {
		fail(`the repo has no "${labelName}" label`);
	}
	return label;
}

function report(pullRequest: PullRequest) {
	const states = pullRequest.labels
		.map((label) => label.name)
		.filter((name) => STATE_LABELS.has(name));
	const state = states.length ? states.join(", ") : "no state label";
	const draft = pullRequest.isDraft ? "draft" : "ready for review";
	const branch = [
		...(isFeature(pullRequest) ? ["feature"] : []),
		...(isStacked(pullRequest)
			? [`stacked on ${pullRequest.baseRefName}`]
			: []),
	];
	const branchLine = branch.length ? `\n${branch.join(", ")}` : "";
	process.stdout.write(
		`${pullRequest.url}\n${state} (${draft})${branchLine}\n`,
	);
}

function parseState(raw: string) {
	const name = raw.trim().toLowerCase().replaceAll("-", " ");
	const state = STATES.get(name);
	if (!state) {
		fail(`state: must be one of: ${[...STATES.keys()].join(", ")}`);
	}
	return state;
}

// ── GitHub calls ─────────────────────────────────────────────────────────────

// A read, so it goes straight to the shared runner (not the mutation
// allowlist).
function readPullRequest(repo: string, pr: number): PullRequest {
	const [owner, name] = splitRepo(repo);
	const query = `
		query ($owner: String!, $name: String!, $number: Int!) {
			repository(owner: $owner, name: $name) {
				pullRequest(number: $number) {
					id
					number
					url
					state
					isDraft
					baseRefName
					headRefName
					labels(first: 100) { nodes { id name } }
				}
				defaultBranchRef { name }
				labels(first: 100) { nodes { id name } }
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
	) as {
		data: {
			repository: {
				pullRequest: PullRequestNode | null;
				defaultBranchRef: { name: string };
				labels: { nodes: Label[] };
			};
		};
	};
	const { repository } = response.data;
	if (!repository.pullRequest) {
		fail(`no pull request #${pr} in ${repo}`);
	}
	return {
		...repository.pullRequest,
		labels: repository.pullRequest.labels.nodes,
		defaultBranch: repository.defaultBranchRef.name,
		repositoryLabels: repository.labels.nodes,
	};
}

function addLabels(labelableId: string, labelIds: string[]) {
	runMutation(
		`
		mutation ($labelableId: ID!, $labelIds: [ID!]!) {
			addLabelsToLabelable(
				input: { labelableId: $labelableId, labelIds: $labelIds }
			) {
				clientMutationId
			}
		}`,
		{ labelableId, labelIds },
	);
}

function removeLabels(labelableId: string, labelIds: string[]) {
	runMutation(
		`
		mutation ($labelableId: ID!, $labelIds: [ID!]!) {
			removeLabelsFromLabelable(
				input: { labelableId: $labelableId, labelIds: $labelIds }
			) {
				clientMutationId
			}
		}`,
		{ labelableId, labelIds },
	);
}

function convertToDraft(pullRequestId: string) {
	runMutation(
		`
		mutation ($pullRequestId: ID!) {
			convertPullRequestToDraft(input: { pullRequestId: $pullRequestId }) {
				clientMutationId
			}
		}`,
		{ pullRequestId },
	);
}

function markReady(pullRequestId: string) {
	runMutation(
		`
		mutation ($pullRequestId: ID!) {
			markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
				clientMutationId
			}
		}`,
		{ pullRequestId },
	);
}

function runMutation(query: string, variables: MutationVariables) {
	return runAllowedMutation(query, variables, ALLOWED_MUTATIONS);
}
