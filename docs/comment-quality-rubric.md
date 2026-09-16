# Comment quality rubric

The bar a comment must clear to survive: **it provides information the code
cannot, and that a rename, a smaller function, or a clearer type could not
convey.** Almost nothing clears it. A well-culled file has close to zero
comments, and the ones left are the ones a reader would genuinely be stuck
without.

Grade against the categories below and cite the one you're invoking, so the
reasoning is auditable rather than a verdict.

> **Why this runs at the end, not the start.** Comments are genuinely useful
> _while_ code is being written — they hold a thought in place while the shape
> is still moving, and reaching for one mid-implementation is not a lapse. This
> is a cleanup pass before the PR goes up, not a standard anyone should have
> been held to an hour ago. Judge each comment on whether it earns its place
> _from here on_, and don't editorialize about how it got written.

---

## The decision procedure

Apply in order. Stop at the first that matches.

1. **Is it functional?** Does any tool read it — the interpreter, a linter, a
   formatter, a type checker, a generator, a licence scanner? → **Keep. Never
   touch.** See category A.
2. **Is it wrong?** Does it describe behaviour the code no longer has? →
   **Delete it, or correct it if the true statement still earns its place.** A
   stale comment is worse than none: nothing fails when it drifts, so readers
   trust it and are misled.
3. **Could a rename, an extracted helper, or a clearer type carry it?** → **Do
   that instead, and delete the comment.** This is the outcome for most comments
   that look like they carry meaning. The comment is what gets written _instead
   of_ that work; it is not an acceptable substitute for it.
4. **Does it state a fact from outside the file that the code cannot state at
   all?** → Keep, if it also clears category C.
5. **Is it class- or module-level orientation no method name could carry?** →
   Keep, if it clears category B.
6. **Otherwise → delete.**

---

## A · Functional comments — never removed

Not commentary. Removing these changes behaviour, breaks the build, or strips a
legal notice.

- Interpreter and encoding pragmas: `#!/usr/bin/env ruby`,
  `# frozen_string_literal: true`, `# -*- coding: utf-8 -*-`, `"use strict"`.
- Linter, formatter, and type-checker directives: `# rubocop:disable`, `# noqa`,
  `# type: ignore`, `// eslint-disable-next-line`, `// @ts-expect-error`,
  `// prettier-ignore`.
- Generator and build directives: `//go:generate`,
  `// Code generated … DO NOT EDIT.`, schema and annotation comments a tool
  parses.
- Licence and copyright headers.

A directive that suppresses a check is functional, but the _reason_ beside it is
a category-C comment and is judged on its own merits.
`# rubocop:disable Metrics/AbcSize — the parser table is one expression by nature`
keeps both halves; `# rubocop:disable Metrics/AbcSize — too long` keeps only the
directive.

## B · Class- and module-level orientation

The one place prose reliably beats naming: what this type _is_, the invariant it
maintains, and its role among its siblings. A reader landing here cold needs the
model before the methods make sense, and no method name can carry a model.

**Earns its place:** the invariant the type guarantees; the lifecycle or state
machine it implements; why it exists alongside a sibling that looks like it does
the same thing; the constraint that shapes every method in it.

**Does not:** restating the name
(`# The UserSerializer class serializes users`); an inventory of the methods
below, which the file already lists and which goes stale the moment one is
added; a speculative docstring added because the file looked bare; parameter and
return descriptions the signature already states.

## C · Load-bearing why the code cannot carry

The rare comment that survives on content. It must name something **outside**
the code — outside this file, this repo, or this language — that no amount of
renaming reaches.

**Earns its place:**

- An upstream bug or third-party quirk being worked around, **with a link or
  issue reference**. Without the reference it is folklore, and the next reader
  cannot check whether it still holds.
- A non-obvious constraint that forced a strange implementation — a wire-format
  requirement, an ordering the hardware or protocol imposes, a measured
  performance result with its number.
- An invariant a **caller** must uphold that is invisible from the signature.
- A deliberately rejected alternative that a future reader would otherwise "fix"
  back in.

**Does not:** why the author found it tricky; a restatement of the line below in
prose; narration of the change that introduced it
(`# now also handles the empty case`); an explanation that would evaporate if
the variable were named properly.

## D · Delete by default

- **Restatement.** The line below says it. `# increment the counter` above
  `counter += 1`.
- **Section headers inside a function.** `# --- validation ---`. The function is
  too long; extract the section into a named one and the header becomes its
  name.
- **Change narration.** `# refactored to use a hash`,
  `# added for the new flow`. Git carries this, and it is meaningless to a
  reader who never saw the old version.
- **`TODO` / `FIXME` / `XXX` / `HACK`.** Untracked work that nothing surfaces.
  It belongs in an issue; if it is not worth an issue it is not worth a line in
  the file.
- **Commented-out code.** Version control has it, and dead code that looks live
  is a trap.
- **Signature echoes.** `@param name The name`. The signature already says this
  and cannot drift from itself.
- **Context-dependent asides.** `# as discussed`, `# per review feedback`,
  `# see the ticket` without a reference. A kept comment must stand alone for a
  reader with none of that context — rewrite it into the durable fact, or delete
  it.

---

## Judging the borderline

When genuinely torn, **delete.** The asymmetry favours it: a deleted comment
costs a reader one trip through git history, while a kept one that drifts out of
sync misleads every reader afterwards and nothing ever catches it.

State the category you invoked and, for a proposed rename, the exact new name.
"This is a category-D restatement" is checkable; "unnecessary" is not.
