# Test quality rubric

The nine properties a test needs to earn its place in the suite. Grade against
these and cite the numbers you're invoking, so the reasoning is auditable rather
than a verdict.

> **Why this rubric runs at the end, not the start.** Mediocre tests are
> genuinely useful _while_ the code is being written — they pin behaviour down
> while it's still moving, and reaching for them during implementation is the
> right call, not a lapse. This is a cleanup pass before the PR goes up, not a
> standard anyone should have been held to an hour ago. Judge the tests as they
> need to be _from here on_, and don't editorialize about how they got written.

1. **Tests behaviour, not implementation.** It exercises the surface a caller
   uses. Renaming a private method, reordering internal calls, or swapping a
   data structure must not break it. A test that asserts on internals is coupled
   to today's code and will cost more in false failures than it ever returns in
   caught bugs.

2. **Mocks the minimal set.** Only what genuinely can't run in a test — the
   network, the clock, a paid API, something slow or destructive. Every extra
   mock is an assumption about the implementation baked into the test, and a
   chance for the test to keep passing after the real thing has broken.

3. **Covers the obvious edge cases.** Empty, absent, zero, negative, one, many,
   duplicate, too-large, wrong-type, and the error paths — not just the path
   where everything works.

4. **Reads well as prose.** Someone reading only the test descriptions, without
   opening the implementation, should come away understanding what the system
   does. The descriptions are the specification; treat them as writing, not
   labels.

5. **Written for a junior developer.** Plain, common language. Don't name design
   patterns or lean on jargon — say what actually happens in the domain's own
   words.

6. **Deterministic and isolated.** No dependence on the wall clock, the network,
   randomness, the order tests run in, or state another test left behind. The
   same input gives the same result on every run, in any order, run alone or
   with the whole suite.

7. **Fails when the behaviour breaks, and only then.** Both halves matter and
   they're the same property from two sides. It must genuinely fail if the
   behaviour breaks — no assertions that can't fail, no asserting on a value the
   test itself configured on a mock, nothing that would still pass against a
   deliberately broken implementation; a test that can't fail is worse than no
   test, because it reports safety it isn't checking. And it must _not_ fail
   when only the implementation changes — rename a private method, reorder
   internal calls, swap a data structure, and it should stay green. A test that
   fails in both cases is noise; a test that fails in neither is decoration.

8. **Fails with a diagnostic message.** When it goes red, the output alone says
   what broke and why. Nobody should have to open the test source to interpret a
   failure.

9. **Setup reveals intent, and holds no logic.** The values that matter to the
   behaviour are visible in the test body rather than buried in a shared factory
   default. And the test itself contains no conditionals, loops, or computed
   expected values — logic in a test is untested code that can be wrong in the
   same direction as the thing it's checking.
