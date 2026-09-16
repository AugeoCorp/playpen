import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INSTANCE_PREFIX,
  baseInstanceName,
  instanceName,
  isBaseInstance,
  isPlaypenInstance,
  parseBaseInstance,
  sandboxFromInstance,
  sandboxName,
} from "./identity.ts";

test("same directory yields the same name", () => {
  assert.equal(sandboxName("/home/e/projects/api"), sandboxName("/home/e/projects/api"));
});

test("same basename in different paths yields different names", () => {
  assert.notEqual(sandboxName("/home/e/a/api"), sandboxName("/home/e/b/api"));
});

test("names are safe as Lima instance names", () => {
  const name = sandboxName("/home/e/My Project (v2)!");
  assert.match(name, /^[a-z0-9][a-z0-9-]*$/);
});

test("non-ascii basenames still produce a valid name", () => {
  const name = sandboxName("/home/e/Augeō/playpen");
  assert.match(name, /^[a-z0-9][a-z0-9-]*$/);
});

test("instance names round-trip", () => {
  const sandbox = sandboxName("/home/e/projects/api");
  const instance = instanceName(sandbox);
  assert.ok(instance.startsWith(INSTANCE_PREFIX));
  assert.equal(sandboxFromInstance(instance), sandbox);
});

test("foreign instances are not recognized as ours", () => {
  assert.equal(isPlaypenInstance("default"), false);
  assert.equal(isPlaypenInstance("playpen-api-abc123"), true);
});

test("a base instance name round-trips its hash and date", () => {
  const name = baseInstanceName("a1b2c3d4", "2026-09-15");
  assert.deepEqual(parseBaseInstance(name), { hash: "a1b2c3d4", date: "2026-09-15" });
});

test("a sandbox for a directory named base is not mistaken for a base image", () => {
  const name = instanceName(sandboxName("/home/e/projects/base"));
  assert.ok(isPlaypenInstance(name));
  assert.equal(isBaseInstance(name), false);
});

test("names that are not dated base images are rejected", () => {
  for (const name of [
    "playpen-base-a1b2c3d4",
    "playpen-base-a1b2c3d4-2026-9-15",
    "playpen-base-nothex00-2026-09-15",
    "base-a1b2c3d4-2026-09-15",
  ]) {
    assert.equal(parseBaseInstance(name), null, name);
  }
});
