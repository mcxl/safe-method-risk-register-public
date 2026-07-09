import { spawnSync } from "node:child_process";
import path from "node:path";

import { REPO_ROOT } from "./kb-source.mjs";
import {
  cleanDirectory,
  recalculateWithLibreOffice,
  renderSampleXlsx,
} from "./xlsx-verification-utils.mjs";

const OUTPUT_DIR = path.join(REPO_ROOT, "outputs", "tmp", "phase5b-dashboard");
const RECALC_DIR = path.join(OUTPUT_DIR, "recalculated");
const PROFILE_DIR = path.join(OUTPUT_DIR, ".lo-profile");
const PYTHON =
  process.env.PYTHON ??
  (process.platform === "win32"
    ? path.join(REPO_ROOT, ".venv", "Scripts", "python.exe")
    : path.join(REPO_ROOT, ".venv", "bin", "python"));

await cleanDirectory(OUTPUT_DIR);
const { outputXlsx } = await renderSampleXlsx(OUTPUT_DIR);
runPython(["scripts/verify_xlsx_dashboard_scenarios.py", "--workbook", outputXlsx, "--mutate"]);
const recalc = await recalculateWithLibreOffice(outputXlsx, RECALC_DIR, PROFILE_DIR);
const result = runPython([
  "scripts/verify_xlsx_dashboard_scenarios.py",
  "--workbook",
  recalc.recalculatedPath,
  "--assert-recalculated",
]);

console.log(result.stdout.trim());
console.log("PHASE 5B XLSX DASHBOARD SCENARIO GATE: PASS");

function runPython(args) {
  const result = spawnSync(PYTHON, args, { cwd: REPO_ROOT, encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${PYTHON} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}
