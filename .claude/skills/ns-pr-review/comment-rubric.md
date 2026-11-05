# Comment Quality Rubric

The bar a comment must clear to survive: **it provides information the code
cannot, and that a rename, a smaller function, or a clearer type could not
convey.** Almost nothing clears it. A well-culled file has close to zero
comments, and the ones left are the ones a reader would be stuck without.

Grade against the categories below and cite the one you're invoking, so the
reasoning can be checked rather than taken as a verdict.

This is a cleanup pass before the pull request goes up. Comments are useful
while code is being written; judge each one on whether it earns its place from
here on, and don't editorialize about how it got written.

## The Decision Procedure

Apply in order. Stop at the first that matches.

1. **Is it functional?** Does a tool read it: the interpreter, a linter, a
   formatter, a type checker, a generator, a licence scanner? Keep. Never
   touch. See category A.
2. **Is it wrong?** Does it describe behaviour the code no longer has? Delete
   it, or correct it if the true statement still earns its place. A stale
   comment is worse than none: nothing fails when it drifts, so readers trust
   it and are misled.
3. **Could a rename, an extracted helper, or a clearer type carry it?** Do that
   instead, and delete the comment. This is the outcome for most comments that
   look like they carry meaning.
4. **Does it state a fact from outside the file that the code cannot state at
   all?** Keep, if it also clears category C.
5. **Is it class- or module-level orientation no method name could carry?**
   Keep, if it clears category B.
6. **Otherwise,** delete.

## A: Functional Comments, Never Removed

Removing these changes behaviour, breaks the build, or strips a legal notice.

- Interpreter and encoding pragmas: `#!/usr/bin/env node`,
  `# frozen_string_literal: true`, `"use strict"`.
- Linter, formatter and type checker directives: `// biome-ignore`,
  `// @ts-expect-error`, `// prettier-ignore`, `# rubocop:disable`.
- Generator and build directives, and schema or annotation comments a tool
  parses.
- Licence and copyright headers.

A directive that suppresses a check is functional, but the reason beside it is
a category C comment, judged on its own merits.

## B: Class- and Module-Level Orientation

What this type is, the invariant it maintains, and its role among its siblings.
A reader landing here cold needs the model before the methods make sense.

**Earns its place:** the invariant the type guarantees; the lifecycle or state
machine it implements; why it exists alongside a sibling that looks like it
does the same thing; the constraint that shapes every method in it.

**Does not:** restating the name; an inventory of the methods below; a
speculative docstring added because the file looked bare; parameter and return
descriptions the signature already states.

## C: Load-Bearing Why the Code Cannot Carry

It must name something outside the code, outside this file, this repo or this
language, that no amount of renaming reaches.

**Earns its place:**

- An upstream bug or third-party quirk being worked around, with a link or
  issue reference. Without the reference it is folklore.
- A non-obvious constraint that forced a strange implementation: a wire format,
  an ordering the platform imposes, a measured performance result with its
  number.
- An invariant a caller must uphold that is invisible from the signature.
- A deliberately rejected alternative that a future reader would otherwise
  "fix" back in.

**Does not:** why the author found it tricky; the line below restated in prose;
narration of the change that introduced it; an explanation that would
evaporate if the variable were named properly; a resolved pixel value beside a
token in code that uses it. Beside the token's own definition, it shows the
scale, and stays.

## D: Delete by Default

- **Restatement.** The line below says it.
- **Section headers inside a function.** The function is too long; extract the
  section and the header becomes its name.
- **Change narration.** `// refactored to use a map`. Git carries this.
- **`TODO`, `FIXME`, `XXX`, `HACK`.** Untracked work that nothing surfaces. It
  belongs in an issue.
- **Commented-out code.** Version control has it.
- **Signature echoes.** `@param name The name`.
- **Context-dependent asides.** `// as discussed`, `// per review feedback`.
  Rewrite into the durable fact, or delete.

## Judging the Borderline

When torn, delete. A deleted comment costs a reader one trip through git
history; a kept one that drifts misleads every reader afterwards.

State the category you invoked and, for a proposed rename, the exact new name.
