import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const PHASE_GATE_PATH = "phase-gates/phase-5a.md";
const phaseGate = readFileSync(path.resolve(PHASE_GATE_PATH), "utf8");

const checks = [
  {
    label: "offline deterministic verification evidence",
    test: () =>
      has(/verify:offline/u) && has(/offline deterministic gate passed|verify:offline` passed/u),
  },
  {
    label: "Docker or remote DB verification evidence",
    test: () =>
      has(/verify:kb:db:docker|kb-db-verification|remote DB/u) &&
      has(/KB DB.*pass|DB gate passed|DATABASE ROUND-TRIP: PASS|kb-db-verification` passed/isu),
  },
  {
    label: "DOCX structural verification evidence",
    test: () =>
      has(/verify:docx/u) &&
      has(/OOXML/u) &&
      has(/handoff manifest/u) &&
      has(/preflight `issue_ready=false`|issue_ready=false/u),
  },
  {
    label: "DOCX visual/open QA status",
    test: () =>
      has(/verify:docx:visual|DOCX visual|Office visual|visual QA/iu) &&
      has(
        /PHASE 5A DOCX VISUAL GATE: PASS|visual.*unresolved|visual QA remains incomplete|visual\/open QA remains unresolved/isu,
      ),
  },
  {
    label: "Anthropic API pass or skip reason",
    test: () =>
      has(/verify:generation:api|Anthropic API/u) && has(/ANTHROPIC_API_KEY|API smoke.*PASS/isu),
  },
  {
    label: "remote CI URL evidence",
    test: () => has(/https:\/\/github\.com\/[^)\s]+\/actions\/runs\/\d+\/job\/\d+/u),
  },
  {
    label: "pull request URL evidence",
    test: () => has(/https:\/\/github\.com\/[^)\s]+\/pull\/\d+/u),
  },
  {
    label: "no knowledge changes statement",
    test: () =>
      has(
        /No files under `knowledge\/` were changed|`knowledge\/` (?:was|remains) (?:not changed|unchanged)/u,
      ),
  },
  {
    label: "manifest/preflight evidence",
    test: () => has(/manifest/u) && has(/preflight/u),
  },
  {
    label: "Phase 5B blocker evidence",
    test: () =>
      has(
        /fixtures\/golden\/briefs\/rpd-rev02-project-brief\.json|rpd-rev02-canonical-project-brief/u,
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

console.log("PHASE 5A EVIDENCE GATE: PASS");

function has(pattern) {
  return pattern.test(phaseGate);
}
