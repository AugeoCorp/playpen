import assert from "node:assert/strict";
import { test } from "node:test";
import { instanceName, sandboxName } from "../session/identity.ts";
import { pickBase } from "./bake.ts";

test("picks the newest base for the image definition", () => {
  const names = [
    "playpen-base-aaaaaaaa-2026-01-09",
    "playpen-base-aaaaaaaa-2026-09-15",
    "playpen-base-aaaaaaaa-2026-03-22",
  ];
  assert.equal(pickBase(names, "aaaaaaaa"), "playpen-base-aaaaaaaa-2026-09-15");
});

test("ignores bases built from a different image definition", () => {
  const names = ["playpen-base-bbbbbbbb-2026-09-15"];
  assert.equal(pickBase(names, "aaaaaaaa"), null);
});

test("ignores sandboxes, including one for a directory named base", () => {
  const sandbox = instanceName(sandboxName("/home/e/projects/base"));
  assert.equal(pickBase([sandbox, "playpen-unrelated", "other-vm"], "aaaaaaaa"), null);
});

test("no base yields null rather than an arbitrary instance", () => {
  assert.equal(pickBase([], "aaaaaaaa"), null);
});
