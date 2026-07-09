import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const manifestPath = path.resolve("fixtures/golden/manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const failures = [];
const phaseFlag = process.argv.indexOf("--phase");
const phaseArg =
  phaseFlag >= 0 && process.argv[phaseFlag + 1] !== undefined ? process.argv[phaseFlag + 1] : "0";
const phase = phaseRank(phaseArg);

if (phase === null) {
  console.error("FAIL --phase must be a non-negative integer, 5A or 5B");
  process.exit(1);
}

for (const fixture of manifest.fixtures) {
  const fixturePath = path.resolve("fixtures/golden", fixture.path);

  if (fixture.status !== "present") {
    const requiredPhase = phaseRank(fixture.required_by_phase);
    if (requiredPhase === null) {
      failures.push(`${fixture.id}: invalid required_by_phase ${fixture.required_by_phase}`);
    } else if (requiredPhase <= phase) {
      failures.push(
        `${fixture.id}: required by Phase ${fixture.required_by_phase}, status is ${fixture.status}`,
      );
    } else {
      console.log(`PENDING ${fixture.id} — required by Phase ${fixture.required_by_phase}`);
    }
    continue;
  }

  if (!existsSync(fixturePath)) {
    failures.push(`${fixture.id}: file missing at ${fixture.path}`);
    continue;
  }

  const content = readFileSync(fixturePath);
  const hash = createHash("sha256").update(content).digest("hex").toUpperCase();
  const size = statSync(fixturePath).size;

  if (hash !== fixture.sha256) {
    failures.push(`${fixture.id}: SHA-256 mismatch`);
  }
  if (size !== fixture.bytes) {
    failures.push(`${fixture.id}: expected ${fixture.bytes} bytes, found ${size}`);
  }
  if (hash === fixture.sha256 && size === fixture.bytes) {
    console.log(`PASS ${fixture.id}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL ${failure}`);
  }
  process.exit(1);
}

console.log(`PHASE ${phaseArg} FIXTURE GATE: PASS`);

function phaseRank(value) {
  const normalized = String(value).trim().toUpperCase();
  if (normalized === "5A") return 5.1;
  if (normalized === "5B") return 5.2;
  if (/^\d+$/u.test(normalized)) return Number(normalized);
  return null;
}
