import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, ["--test", "tests/workflow-state.test.mjs"], {
  stdio: "inherit",
});

if ((result.status ?? 1) !== 0) {
  process.exit(result.status ?? 1);
}

console.log("PHASE 6 WORKFLOW GATE: PASS");
