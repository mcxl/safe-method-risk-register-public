import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";

test("Phase 0 scaffold contains the required source directories", () => {
  for (const directory of ["knowledge", "schemas", "spec", "rules", "generate", "render"]) {
    assert.equal(existsSync(directory), true, `${directory} should exist`);
  }
});
