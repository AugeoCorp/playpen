# Briefs

The agent knows only the brief and the repo. What it can't find there:

- **The goal, the constraints and what's out of scope.** Never the
  implementation: no "shape" section, and no extras (focus handling, request
  cancelling, fallbacks, preloads) The Operator didn't ask for.
- **The Operator's decisions,** in The Operator's words where the wording
  matters. Mark anything the manager added as the manager's, so a reviewer can
  challenge it.
- **Where to work.** A new branch: worktree isolation, base on `origin/<base>`,
  `git push origin HEAD:<branch>`. An existing branch: no isolation, the
  worktree path, `git pull --ff-only` first.
- **Which calls to report rather than make.** Edge cases a reviewer raises
  (performance, accessibility extras) go to The Operator as questions, not as
  work already decided.
- **A plan first** for non-trivial work: what already exists, whether it needs
  to exist, the smallest version (core.md's Think First). The Operator sees it
  before any code.
- **The method,** when the obvious one is slow: start from data already in hand,
  script mechanical edits, name the concurrency for bulk fetches.
- **The Operator's standing rules:** one-line commit subjects; never push to
  main, stash, `--no-verify` or force-push; labels belong to the manager; open
  the draft PR as soon as the change exists and self check while it sits at
  `self review`.
- **The report wanted:** short, with PR number, shas, what was checked and the
  judgement calls.

A reviewer's brief opens with the standing question: what here doesn't need to
exist? It also gets the PR's intent and decisions, fixes only mechanical
defects, and drafts description changes to the scratchpad. A browser agent works
in background tabs of The Operator's one window (`Target.createTarget` with
`background: true`) and touches only its own tabs. Long research runs report at
checkpoints.

## Rules to Paste

Paste this at the end of every brief, word for word, filling in the angle
brackets. It restates the rules above and in the repo's instructions file so
the agent can't miss them.

```
## Rules
- New branch: work in worktree isolation, based on `origin/<base>`; push with
  `git push origin HEAD:<branch>`. Existing branch: no isolation, work in
  <worktree path>, `git pull --ff-only` first.
- Open the draft PR as soon as the change exists; self check while it sits at
  `self review`.
- Before pushing, run only the tests for what changed, plus the repo's lint,
  typecheck and formatter on the changed files. Never the full suite; CI runs
  it.
- One-line commit subjects. Never push to main, stash, `--no-verify` or
  force-push.
- Never print env values.
- Labels and draft state are the manager's. Don't post on GitHub unless this
  brief says to.
- Report short: PR number, shas, what was checked, the judgement calls.
- Non-trivial work: send the plan first (what exists, does it need to exist,
  the smallest version). No code until The Operator has seen it.
- Build only what this brief names. Anything extra, and any edge case you
  find, is a question for The Operator.
- Reviewers: start with what here doesn't need to exist; fix only mechanical
  defects; draft description changes to the scratchpad.
```
