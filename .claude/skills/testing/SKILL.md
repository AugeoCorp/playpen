---
name: testing
description: Write or change tests to the shared conventions, and grade them against the test rubric. Use when writing, changing or reviewing tests.
---

# Testing

How tests are laid out and named, and what they fake. `test-rubric.md` is what
each test has to earn; run it over the tests before the pull request goes up.

## Name the Describe After the Export

A file usually has one named export, named like the file. The root `describe`
is that export, written the way it's used.

```ts
describe("<HamburgerMenu />", () => {});
describe("describeSandwiches()", () => {});
describe("ingredients", () => {});
```

When a file has several exports, or its name doesn't match the export (Next.js
pages and routes), the root `describe` names the file as briefly as it can and
nests one `describe` per export.

```ts
describe("sandwich/route", () => {
	describe("POST()", () => {});
});
```

## Nest Describes for Context

A context starts with "when", "as", "with" or "without". Put the setup the
context shares in its own `beforeEach`.

```ts
describe("when logged out", () => {
	beforeEach(setupInvalidSession);

	it("redirects to login", () => {});
});
```

Prefer `beforeEach` for isolation; `beforeAll` only when the setup is
expensive. Each hook does one thing: two concerns are two hooks.

Never call the code under test straight in a `describe` body. That runs while
the runner collects the tests, before any hook, and once for the whole file.

```ts
describe("when it builds a sandwich", () => {
	let result: Sandwich;

	beforeEach(() => {
		result = buildSandwich(sandwich);
	});

	it("saves the sandwich", () => {});
	it("returns the sandwich", () => {});
});
```

## Describe What the User Sees

Use `it`, not `test`. Third person, present tense, no "should": "returns the
order's details", not "should fetch the order from the database". Name the
behaviour, not the call that produces it: "shows a success message", not
"calls showToast".

## One Behaviour per Test

When a test fails, it should be clear which behaviour broke. Several
expectations are fine when they check one behaviour together.

## Query What the User Sees

Find elements by role, label or text through the test library's queries, and
click and type through them too: `getByRole("alert")`, not
`container.querySelector(".error")`. A user can't reach the DOM node a render
helper hands back, so the test doesn't either.

## Fake What Adds Complexity

A unit test tests one unit. Fake a dependency when the real one would add setup
or complexity to the test, and checking that the unit called it correctly is
fine. When the real thing is cheap, like es-toolkit or a pure helper, let it
run, and trust it: don't test its behaviour from here.

## Build Data With Factories

Factories, not fixtures. A factory fills in what the test doesn't care about;
the test sets what it does.

```ts
it("skips payment for free orders", () => {
	const order = buildOrder({ total: 0 });
	expect(checkout(order).paymentSkipped).toBe(true);
});
```

Shared setup in a `beforeEach` in the same `describe` is visible enough. A
value that only lives in a factory default or a helper in another file isn't.
