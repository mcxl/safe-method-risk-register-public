import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const PHASE_GATE_PATH = "phase-gates/phase-6.md";
const phaseGate = readFileSync(path.resolve(PHASE_GATE_PATH), "utf8");

const checks = [
  {
    label: "workflow verification evidence",
    test: () => has(/verify:workflow/u) && has(/PHASE 6 WORKFLOW GATE: PASS/u),
  },
  {
    label: "offline regression evidence",
    test: () => has(/verify:offline/u),
  },
  {
    label: "state-machine evidence",
    test: () =>
      has(/DRAFT/u) &&
      has(/REVIEWED/u) &&
      has(/ISSUED/u) &&
      has(/directly from DRAFT to ISSUED|DRAFT cannot transition directly to ISSUED/iu),
  },
  {
    label: "consultant sign-off evidence",
    test: () => has(/consultant.*sign-off|consultant.*review/isu),
  },
  {
    label: "preflight and evidence evidence",
    test: () => has(/preflight/iu) && has(/verifier/iu) && has(/phase-gate/iu),
  },
  {
    label: "content invalidation evidence",
    test: () => has(/content.*invalidat|changed content/isu) && has(/revision/iu),
  },
  {
    label: "provenance hash evidence",
    test: () => has(/provenance/iu) && has(/hash/iu) && has(/tamper/iu),
  },
  {
    label: "authorization evidence",
    test: () => has(/authorization|authorisation/iu) && has(/forbidden|role-scoped/iu),
  },
  {
    label: "immutable persistence evidence",
    test: () => has(/persist/iu) && has(/immutable/iu) && has(/load-time/iu),
  },
  {
    label: "reconstruction evidence",
    test: () => has(/reconstruct/iu) && has(/stored artifacts|source input/iu),
  },
  {
    label: "no guarded-path changes statement",
    test: () =>
      has(
        /No files under `knowledge\/`, `schemas\/`, `rules\/`, `render\/` or `outputs\/issued` were\s+changed/u,
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
  [
    "working tree guarded diff",
    ["diff", "--name-only", "--", "knowledge", "schemas", "rules", "render", "outputs/issued"],
  ],
  [
    "staged guarded diff",
    [
      "diff",
      "--cached",
      "--name-only",
      "--",
      "knowledge",
      "schemas",
      "rules",
      "render",
      "outputs/issued",
    ],
  ],
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

console.log("PHASE 6 EVIDENCE GATE: PASS");

function has(pattern) {
  return pattern.test(phaseGate);
}
