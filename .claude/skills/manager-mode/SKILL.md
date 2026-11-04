---
name: manager-mode
description: Running a session as the manager of background agents. Use when The Operator turns manager mode on, or when briefing, tracking or cleaning up after subagents.
---

Manager mode exists to keep the manager's **turns free** so The Operator can
always talk. It is off until The Operator asks for it, or the manager suggests
it and The Operator agrees.

## The Line

The test is time, not kind of work. Quick commands are the manager's: PR states,
labels, read-only checks, posting a drafted description, a conflict-free
scripted merge, one scan that answers The Operator's question. Investigation,
edits, builds and tests go to an agent, as does any merge with a conflict that a
codemod can't regenerate.

## How The Operator Likes It Run

- **Questions, then one agent.** Settle all of a PR's questions with
  The Operator, with a recommendation on each, then send one complete brief.
  Decisions that arrive mid-run are batched into one message, or the agent is
  relaunched. See [BRIEFS.md](BRIEFS.md).
- **PR state is honest.** `pr-state` moves the moment work moves; The Operator
  reads the tree to know what's waiting on whom. `approved` is The Operator's
  alone. `self review` means the manager or an agent is still working on the
  PR; once the reviews are done and nothing is left for the manager, it moves
  to `review requested` even while CI runs, and back to `working` if CI fails.
- **Stack sections stay current.** Whenever a PR is opened, retargeted or
  merged, refresh each open PR's Stack section from `pr-tree --description`.
- **A fresh reviewer before `review requested`.** A different agent reviews
  every PR and drafts description fixes for the manager to post. It starts right
  away; open questions go in its brief as things to report, not change.
- **QA means regressions.** Anything also on production is reported separately
  as pre-existing.
- **One worktree per branch,** at `.claude/worktrees/<branch>` with slashes as
  hyphens. A new branch gets a fresh worktree; reviewers and fix-ups reuse the
  branch's own. Stacked PRs are separate branches too: one agent per PR, or
  create the second worktree before briefing, rather than one agent switching
  branches in a single worktree. Rename an isolated agent's `agent-<id>` after
  its completion notification. Merging includes removing the worktree and local
  branch.

The PR scripts (`pr-state`, `pr-tree`, `pr-status`, `pr-comment`) run from the
repo's checkout as `node ${CLAUDE_SKILL_DIR}/scripts/<name>.mjs`; see
[SCRIPTS.md](SCRIPTS.md). For walking The Operator through pages in the
browser, see [WALKTHROUGH.md](WALKTHROUGH.md).

## In a Cloud Session

GraphQL returns 403 here, so the PR scripts don't run. Set states and read the
tree with the GitHub connector tools (`mcp__github__*`, loaded via ToolSearch),
keeping the scripts' rules.

- **Read first.** `pull_request_read` `get` gives state, draft, base, head and
  labels. A PR with no labels has no `labels` key. `issue_read` `get_labels`
  fails on PRs. Refuse a closed or merged PR.
- **Draft next,** with `update_pull_request` `draft`: true for `working`,
  `self review` and `needs decision`, false for `review requested`, untouched
  for `blocked`. Both directions work.
- **Labels last.** `issue_write` `update` with `labels` replaces the whole list,
  so write it complete: every non-state label kept, the one new state label,
  `🥞 stacked` when the base isn't `main`, `👣️ feature` (U+FE0F after the
  footprints) when the head starts with `feature/`. Drop `✅ approved` and any
  other state label; never add `approved`. Read it back.
- **The tree.** `list_pull_requests` (open, `fields` for number, draft, labels,
  head, base, user), nested by base. Its list carries no mergeability, so run
  `pull_request_read` `get` per PR: `mergeable_state` `dirty` is ✕, `unknown`
  is ⭘, anything else is ●. Draw it the way `pr-tree` does: each label as its
  emoji, then the legend.

## Gotchas

- **Generated diffs:** make mechanical many-file changes a rerunnable codemod.
  Conflicts are then resolved by checking out the base and rerunning it. Post
  the codemod on the PR.
- **Background watchers** that rewrite a PR description must replace only their
  own section. One rebuilt the whole body every minute and wiped what another
  agent had added.
- **Isolated agents** can only run git in their own worktree, and one that stops
  without changes loses it, so relaunch rather than resume.

@.claude/extensions/skills/manager-mode/BRIEFS.md
