# Working in this repo

Read `docs/PLAN.md` first; update it when you change what it describes.

## Test

```
npm run typecheck
npm test
```

The sandbox runs these directly. On a Node built without Amaro — most distro
builds, and any base baked before Node 26 — importing `.ts` fails with
`ERR_NO_TYPESCRIPT`; compile out instead:

```
npx tsc --noEmit false --rewriteRelativeImportExtensions --outDir "$OUT"
node --test --experimental-test-module-mocks "$OUT/**/*.test.js"
```

`lifecycle.test.ts` fails there: `mock.module()` takes its specifier as a
runtime string, which `--rewriteRelativeImportExtensions` does not touch, so it
still asks for `.ts` after compilation. Run that file on a Node with type
stripping.

Anything touching a real VM is verified by hand with `playpen up`. Say when you
could not.

## Do not relitigate

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

Before finishing, apply `docs/comment-quality-rubric.md` and
`docs/test-quality-rubric.md`. Report what you verified and what you did not.
