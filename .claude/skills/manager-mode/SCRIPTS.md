# PR Scripts

Four scripts in `scripts/`, run the way SKILL.md says. Each defaults to the
current checkout's repo, takes `--repo owner/name` for another, and prints its
usage with `--help`. They need `gh` logged in with GraphQL, so they don't run
in a cloud session (see SKILL.md).

Every `gh` call is hardcoded, with input only ever filling its variables, and
each write is checked against the script's own allowlist of mutations.
`pr-status` and `pr-tree` only read, so they are safe to allow without asking.
Keep `pr-comment` behind a permission prompt.

## pr-state

Sets a PR's state label and keeps its draft status in step. A PR carries one
state label at a time, in any order; setting one swaps out the old one.

| State                 | Argument           | Draft     | Colour   |
| --------------------- | ------------------ | --------- | -------- |
| `🚧 working`          | `working`          | yes       | `F6F8FA` |
| `🔍 self review`      | `self-review`      | yes       | `F6F8FA` |
| `🤔 needs decision`   | `needs-decision`   | yes       | `FCEFE5` |
| `⛔ blocked`          | `blocked`          | unchanged | `FFEDEC` |
| `👀 review requested` | `review-requested` | no        | `E8F4FE` |

```bash
pr-state.mjs 137                    # show the state and draft status
pr-state.mjs 137 review-requested   # set a state
```

`✅ approved` is The Operator's: the script removes it when the state moves on
and never adds it. It also keeps `🥞 stacked` on PRs whose base isn't the
default branch and `👣️ feature` on PRs whose head starts with `feature/`. It
refuses closed and merged PRs.

## pr-tree

Open PRs as a tree nested by base branch, each with its mergeability mark
(● mergeable, ✕ conflicting, ⭘ unknown) and the emoji of each of its labels.
PRs with no emoji label go on one "untracked" line, and a legend at the end
names every mark and label, whether or not it appears.

```bash
pr-tree.mjs                    # every open PR
pr-tree.mjs --description 137  # 137's stack, for its description
```

`--description` prints the stack the PR is in, from the default branch down
through every PR stacked on it, as a `## Stack` section between
`<!-- pr-tree:start -->` and `<!-- pr-tree:end -->`. The tree sits in a `<pre>`
with each PR number linked, the PR's own line in bold, and the legend below.
It only prints; writing it into a description is the manager's job.

## pr-status

Read-only reports, distilled to a few lines so nobody re-parses raw JSON.

```bash
pr-status.mjs summary 137     # state, review, mergeability, checks, threads
pr-status.mjs review 137      # metadata, files, description, threads
pr-status.mjs threads 137     # unresolved review threads, with reply ids
pr-status.mjs diff 137 path/to/file
pr-status.mjs list            # open PRs
```

Also `files`, `checks` and `reviewers`. For any other mix, `view 137 --include
meta,files,body` reads exactly those sections in one call. `--json` prints the
distilled object instead of text.

## pr-comment

Posts comments and thread replies, and nothing else: it can't edit, merge,
close or label.

```bash
pr-comment.mjs comment 137 'General comment on the PR.'
pr-comment.mjs reply PRRT_xxx 'Reply to a review thread.'
pr-comment.mjs line 137 path/to/file.ts 42 'Comment on one diff line.'
```

Thread ids come from `pr-status.mjs threads`. Keep replies to one quick point,
not a paragraph.
