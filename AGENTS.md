<!-- BEGIN:nam-shub@8e44b92 -->
<!-- prettier-ignore-start -->

# nam-shub

The rules for every repo. This block is generated from `core.md` in
`seanhealy/nam-shub` by the `sync-nam-shub` skill and replaced whole on each
update: change it there, never here. The rest of this file is specific to this
repo.

## Less Code, Written Clean

Mutability comes from less code, written clean the first time. Less code means
fewer places to change when the requirements move, and they will.

- Don't write for a future you guessed: no options, parameters, layers or
  config nobody asked for.
- When a real second use arrives, pull out the shared part in that change
  instead of copying.
- Clean means nothing glossed over: no magic values, no loose strings where a
  type belongs, no "fix it later."
- Before writing anything, ask whether it needs to exist, then whether the
  codebase, the standard library or the platform already does it.

## Think First

Read the code the change touches and trace the real flow before writing. Think
about the whole problem, then the piece to start with, then the whole again in
light of that piece.

If you can't know without trying, experiment in a scratch space outside the
change and carry over only what you learned. You're ready when you can explain
the change, what moves where and why, without "this works because I happen to
know..."

Plans too: a proposal says what already exists that it weighed, and why that
isn't enough.

## Guard the Edges, Trust the Types

Validate where data comes in: user input, the network, outside services.
Inside, trust the types and don't re-check what they already rule out. Never
trade away validation, error handling, security or accessibility for size.

## No Outliers

Build things that do the same job the same way, even when a special shape would
be shorter. Consistency lets both of us make assumptions about the codebase. If
the pattern doesn't fit, stop and bring it to The Operator: changing a pattern
everywhere is never small, and a comment explaining an exception is how
outliers get in quietly.

## Names

Full words, not abbreviations (`context`, not `ctx`). One concept, one name; the
repo's terminology doc says which. Once something has a name, keep it.

## Small Pull Requests

One pull request does one thing. Small ones get real review, and they force the
rest of this file: there's no room in one for gold plating.

- Tests for changed behaviour ship in the same pull request.
- Tiny cleanups in code you're touching can ride along. A real refactor gets its
  own pull request, stacked under the change if needed. Anything else goes
  under "Not in this PR".
- Load the `pr-review` skill before writing a change: the description comes
  first, and it's the plan. Load it again before the pull request leaves draft.
- A pull request stays a draft while it has an open question for The Operator.

Show The Operator the plan before writing when any of these fire:

- the one-sentence summary covers two things ("adds the sale badge and reworks
  price formatting")
- more than two judgement calls under "Where to look"
- the change spreads across many files, or past roughly 400 changed lines (not
  counting generated files, lockfiles or migrations)
- it needs an outlier
- you can't explain it without "this works because I know..."

A warning triggers a question, never a trim. If it's still one thing, say in
the description why it's big; if not, split it by behaviour. Readability beats
size, always.

## Speed

Optimize only after it works and a measurement says it matters.

## House Conventions

- `function` declarations for named functions; arrows for anonymous callbacks.
- Named exports, except where a framework needs a default.
- `undefined`, not `null`, for absence; absorb outside nulls with `??` at the
  edge.
- Enumerables (`map`, `filter`, `find`, `reduce`, `forEach`) over `for` loops.
- Most important first: exported functions at the top, helpers below; object
  properties by importance, identifying fields first.
- A directory module's `index.ts` only re-exports; the code lives in a named
  file.
- Comments carry only what the code can't. The `pr-review` skill holds the
  rubric.

## Working With The Operator

- Answer first, reasons after. Plain words; a technical term only when it
  carries meaning, explained once.
- Name the file, the symbol, the line. Say what you checked and what you're
  recalling.
- Ask when a decision is The Operator's: scope, anything hard to undo, an
  outlier.
- Pick each agent's model to fit the job; that's your call. Fable is the
  exception: it needs The Operator's yes every time, even when an earlier plan
  named it.
- Push back once with a concrete case when something smells off, then let
  The Operator decide.
- No em dashes, Title Case headings, straight quotes.

<!-- prettier-ignore-end -->
<!-- END:nam-shub -->

# Working in This Repo

Read `docs/PLAN.md` first; update it when you change what it describes.

## Test

```
npm run typecheck
npm test
```

The sandbox runs these directly. On a Node built without Amaro (most distro
builds, and any base baked before Node 26), importing `.ts` fails with
`ERR_NO_TYPESCRIPT`; compile out instead:

```
npx tsc --noEmit false --rewriteRelativeImportExtensions --outDir "$OUT"
node --test --experimental-test-module-mocks "$OUT/**/*.test.js"
```

`lifecycle.test.ts` fails there: `mock.module()` takes its specifier as a
runtime string, which `--rewriteRelativeImportExtensions` does not touch, so it
still asks for `.ts` after compilation. Run that file on a Node with type
stripping.

Anything touching a real VM is verified by hand with `playpen start`. In a
Claude Code cloud container, the `cloud-vm-test` skill
(`.claude/skills/cloud-vm-test/`) sets that up.

## Do Not Relitigate

- A mask is not a privacy control. Never call `masked` entries hidden.
- Project config runs on the host only via `loadTrustedConfig` in
  `src/session/trust.ts`. It executes a snapshot of the approved import graph,
  never the project file. Approvals live outside the mount.
- Only `assertOurs` paths stop or delete Lima instances.
- `setup` entries run in the guest, through a login shell so mise applies. The
  host only extracts them as data; nothing from a config reaches a host shell.

## Style

Strict tsconfig with `erasableSyntaxOnly`: no enums, no namespaces, `.ts`
extensions on imports, `import type` for types. Spawn with argv, never `sh -c`
interpolation; secrets via stdin.
