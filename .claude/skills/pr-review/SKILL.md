---
name: pr-review
description: Write a pull request description, or review a branch before its pull request goes up, against nam-shub and the comment and test rubrics. Use when starting a change, before a pull request leaves draft, or when The Operator asks for a self review.
---

# Pull Request Review

Catch what The Operator would otherwise ask for in review. Write the description
when the change starts; run the review once the shape has stopped moving. Judge
the code as it needs to be from here on, and don't editorialize about how it got
written.

The rules are in the nam-shub block of `AGENTS.md`. This skill is the
description's shape, the order to check the rules in, and the comment rubric.

## The Description

Write it before the code; it's the plan. A map, kept short.

- **First line:** what it does and why, in one sentence.
- **Where to look:** the one or two judgement calls.
- **Checked:** what you verified and how, and what you didn't.
- **Not in this PR:** what you noticed and left, and the stack position if
  stacked.

No file-by-file restatement, no story of how you got there, no empty headers.
Explain a specific line with a comment on that line of the pull request.

## The Review

1. **Scope.** Read the whole diff and the code it touches, then weigh the
   warning signals in the core together. No one signal decides it. If they point
   at more than one thing, bring The Operator the split as a question. Never
   trim to clear a signal.
2. **Less code.** Look for anything nobody asked for: options, parameters,
   layers, a helper used once, checks the types already rule out. Look the
   other way too: a second use that copied the first instead of sharing it.
3. **Outliers.** Compare against how the codebase already does the same job. An
   outlier goes to The Operator, not into the diff.
4. **Names.** Full words, the terminology doc's term, a name kept once set.
5. **Comments.** Run `comment-rubric.md` over every comment the diff adds or
   touches. Cite the category; for a rename, give the exact new name.
6. **Tests.** Changed behaviour has tests in this pull request. Run
   the `testing` skill's `test-rubric.md` over them and cite the numbers.
7. **Description.** It still matches the change and the shape above.

## What to Report

One line per finding: `path:line`, the rule (step, category or number), the fix.
Fix what's plainly yours to fix. Bring scope and outliers to The Operator as a
question. When nothing is found, say which steps ran.
