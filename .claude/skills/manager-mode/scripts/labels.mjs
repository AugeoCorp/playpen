// labels.mjs: The labels the PR scripts know, shared so pr-state sets the
// same names pr-tree explains. Each has the colour (hex, no #) and description
// it was created with on GitHub. States come first in workflow order, then the
// branch labels; pr-tree's legend follows this order.

export const LABELS = {
	working: {
		name: "🚧 working",
		color: "F6F8FA",
		description: "An agent or the manager is changing this PR",
	},
	selfReview: {
		name: "🔍 self review",
		color: "F6F8FA",
		description: "Reviews in progress before it goes to The Operator",
	},
	needsDecision: {
		name: "🤔 needs decision",
		color: "FCEFE5",
		description: "Waiting on a decision from The Operator",
	},
	blocked: {
		name: "⛔ blocked",
		color: "FFEDEC",
		description: "Blocked on something outside this PR",
	},
	reviewRequested: {
		name: "👀 review requested",
		color: "E8F4FE",
		description: "Ready for The Operator's review",
	},
	approved: {
		name: "✅ approved",
		color: "E9F6EB",
		description: "Approved by The Operator",
	},
	stacked: {
		name: "🥞 stacked",
		color: "F6F8FA",
		description: "Based on another PR, not main",
	},
	feature: {
		// The variation selector after the footprints is part of the name.
		name: "👣️ feature",
		color: "F6F8FA",
		description: "Head branch starts with feature/",
	},
};
