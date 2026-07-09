import {
  goldenRuleReport,
  loadPhase3Cases,
  readJson,
  runPhase3Case,
  runVerdictCase,
  PHASE3_VERDICT_FIXTURES,
} from "../rules/phase3-fixtures.mjs";

const failures = [];
const goldenReport = goldenRuleReport();

if (
  goldenReport.status !== "pass" ||
  goldenReport.verdict.rating !== "Benchmark Quality Confirmed"
) {
  failures.push(
    `Golden document set expected Benchmark Quality Confirmed, got ${goldenReport.status} ${goldenReport.verdict.rating}`,
  );
} else {
  console.log("PASS golden Sample set: Benchmark Quality Confirmed");
}

const { sourceDocumentSet, cases } = loadPhase3Cases();
for (const fixtureCase of cases) {
  const result = runPhase3Case(sourceDocumentSet, fixtureCase);
  if (!result.passes) {
    failures.push(
      `${fixtureCase.id}: expected ${result.expectedRuleIds.join(", ")}, got ${result.actualRuleIds.join(", ")}`,
    );
    continue;
  }
  console.log(`PASS ${fixtureCase.id}: ${result.actualRuleIds.join(", ")}`);
}

const verdictFixtures = readJson(PHASE3_VERDICT_FIXTURES);
for (const verdictCase of verdictFixtures.cases) {
  const result = runVerdictCase(verdictCase);
  if (!result.passes) {
    failures.push(
      `${verdictCase.id}: expected ${verdictCase.expected_rating}, got ${result.verdict.rating}`,
    );
    continue;
  }
  console.log(`PASS ${verdictCase.id}: ${result.verdict.rating}`);
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL ${failure}`);
  }
  process.exit(1);
}

console.log("PHASE 3 RULE GATE: PASS");
