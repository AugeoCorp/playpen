import assert from "node:assert/strict";
import { test } from "node:test";
import { archivePath } from "./history.ts";

test("an archive is named after the sandbox", () => {
  assert.ok(archivePath("playpen-90957d").endsWith("/playpen-90957d.tar"));
});

test("a name that could escape the history directory is refused", () => {
  for (const name of ["../escape", "/etc/passwd", "has space", "UPPER", "", "-leading"]) {
    assert.throws(() => archivePath(name), /invalid sandbox name/, name);
  }
});
