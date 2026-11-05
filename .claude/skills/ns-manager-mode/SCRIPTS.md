# PR Scripts

Five scripts in `scripts/`, run the way SKILL.md says. Each defaults to the
current checkout's repo, takes `--repo owner/name` for another, and prints its
usage with `--help`. They need Node 22.18 or later, which runs TypeScript
directly, and `gh` logged in with GraphQL, so they don't run in a cloud session
(see SKILL.md).

Every `gh` call is hardcoded, with input only ever filling its variables, and
each write is checked against the script's own allowlist of mutations.
`pr-status` and `pr-tree` only read, so they are safe to allow without asking.
Keep `pr-comment` and `pr-describe` behind a permission prompt.

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
pr-state.ts 137                    # show the state and draft status
pr-state.ts 137 review-requested   # set a state
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
pr-tree.ts                    # every open PR
pr-tree.ts --description 137  # 137's stack, for its description
```

`--description` prints the stack the PR is in, from the default branch down
through every PR stacked on it, as a `## Stack` section between
`<!-- pr-tree:start -->` and `<!-- pr-tree:end -->`. The tree sits in a `<pre>`
with each PR number linked, the PR's own line in bold, and the legend below.
It only prints; `pr-describe` writes it into the description.

## pr-describe

Writes each PR's Stack section, exactly what `pr-tree --description` prints,
into its description, and nothing else: its one write is `updatePullRequest`
setting the body.

```bash
pr-describe.ts                # every open PR
pr-describe.ts 137 138        # just these
pr-describe.ts --dry-run      # print what it would do, write nothing
```

It replaces only the lines from `<!-- pr-tree:start -->` to
`<!-- pr-tree:end -->`, or appends the section when no line holds a marker, so
every byte outside the section stays as it was. A marker counts only on a line
of its own, so one quoted in a sentence is left alone. It prints one line per
PR, in number order: updated, unchanged (the body already matches, so nothing
is written), or skipped, for a PR that isn't open with an emoji label or whose
body has more than one section or a marker without its pair. It reads the open
PRs once for the tree, then reads each body again just before writing it, so
an edit made in between isn't lost; `--dry-run` skips that second read. It
writes one PR at a time and stops at the first write gh refuses, with gh's
error.

## pr-status

Read-only reports, distilled to a few lines so nobody re-parses raw JSON.

```bash
pr-status.ts summary 137     # state, review, mergeability, checks, threads
pr-status.ts review 137      # metadata, files, description, threads
pr-status.ts threads 137     # unresolved review threads, with reply ids
pr-status.ts diff 137 path/to/file
pr-status.ts list            # open PRs
```

Also `files`, `checks` and `reviewers`. For any other mix, `view 137 --include
meta,files,body` reads exactly those sections in one call. `--json` prints the
distilled object instead of text.

## pr-comment

Posts comments and thread replies, and nothing else: it can't edit, merge,
close or label.

```bash
pr-comment.ts comment 137 'General comment on the PR.'
pr-comment.ts reply PRRT_xxx 'Reply to a review thread.'
pr-comment.ts line 137 path/to/file.ts 42 'Comment on one diff line.'
```

Thread ids come from `pr-status.ts threads`. Keep replies to one quick point,
not a paragraph.
