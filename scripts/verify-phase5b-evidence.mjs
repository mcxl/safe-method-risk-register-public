import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const PHASE_GATE_PATH = "phase-gates/phase-5b.md";
const phaseGate = readFileSync(path.resolve(PHASE_GATE_PATH), "utf8");

const checks = [
  {
    label: "XLSX static gate evidence",
    test: () => has(/verify:xlsx/u) && has(/PHASE 5B XLSX STATIC RENDER GATE: PASS/u),
  },
  {
    label: "LibreOffice recalculation evidence",
    test: () =>
      has(/verify:xlsx:libreoffice/u) &&
      has(/PHASE 5B XLSX LIBREOFFICE GATE: PASS|LibreOffice.*blocked/isu),
  },
  {
    label: "Excel CalculateFullRebuild evidence",
    test: () =>
      has(/verify:xlsx:excel/u) &&
      has(/PHASE 5B XLSX EXCEL GATE: PASS|Excel.*blocked|Excel.*not available/isu),
  },
  {
    label: "dashboard scenario evidence",
    test: () =>
      has(/verify:xlsx:dashboard/u) && has(/PHASE 5B XLSX DASHBOARD SCENARIO GATE: PASS/u),
  },
  {
    label: "fixture and offline regression evidence",
    test: () => has(/verify:phase5b:fixtures/u) && has(/verify:offline/u),
  },
  {
    label: "draft-only and no issue-ready claim",
    test: () => has(/DRAFT-only|DRAFT output|not issue-ready/iu),
  },
  {
    label: "consultant sign-off status",
    test: () => has(/consultant.*not.*run|consultant.*required|sign-off.*required/isu),
  },
  {
    label: "no knowledge changes statement",
    test: () =>
      has(
        /No files under `knowledge\/` were changed|`knowledge\/` (?:was|remains) (?:not changed|unchanged)/u,
      ),
  },
];

const failures = [];
for (const check of checks) {
  if (check.test()) {
    console.log(`PASS ${check.label}`);
  } else {
    failures.push(check.label);
  }
}

for (const diffCheck of [
  ["working tree knowledge diff", ["diff", "--name-only", "--", "knowledge"]],
  ["staged knowledge diff", ["diff", "--cached", "--name-only", "--", "knowledge"]],
]) {
  const [label, args] = diffCheck;
  const output = execFileSync("git", args, { encoding: "utf8" }).trim();
  if (output) {
    failures.push(`${label}: ${output}`);
  } else {
    console.log(`PASS no ${label}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL ${failure}`);
  }
  process.exit(1);
}

console.log("PHASE 5B EVIDENCE GATE: PASS");

function has(pattern) {
  return pattern.test(phaseGate);
}
