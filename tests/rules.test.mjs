import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMutations,
  goldenRuleReport,
  loadPhase3Cases,
  readJson,
  runPhase3Case,
  runVerdictCase,
  PHASE3_VERDICT_FIXTURES,
} from "../rules/phase3-fixtures.mjs";
import { validateDocumentSet } from "../rules/index.mjs";

test("golden Unitas document set passes deterministic rules", () => {
  const report = goldenRuleReport();
  assert.equal(report.status, "pass");
  assert.deepEqual(report.results, []);
  assert.equal(report.verdict.rating, "Benchmark Quality Confirmed");
});

test("Phase 3 broken fixtures fail only the expected stable rule IDs", () => {
  const { sourceDocumentSet, cases } = loadPhase3Cases();
  for (const fixtureCase of cases) {
    const result = runPhase3Case(sourceDocumentSet, fixtureCase);
    assert.deepEqual(result.actualRuleIds, result.expectedRuleIds, fixtureCase.id);
    if (fixtureCase.expected_criterion_number) {
      assert.equal(result.passes, true, `${fixtureCase.id} criterion number`);
    }
  }
});

test("equivalent-or-stronger SWMS control evidence passes criterion 3", () => {
  const { sourceDocumentSet } = loadPhase3Cases();
  const stronger = applyMutations(sourceDocumentSet, [
    {
      op: "set",
      path: ["swms_benchmark_reviews", 0, "criteria_evidence", "control_adequacy"],
      value:
        "Submitted controls exceed the benchmark controls with stronger isolation and engineering verification.",
    },
  ]);
  const report = validateDocumentSet(stronger);
  assert.equal(report.status, "pass");
});

test("verdict fixtures cover all four ratings deterministically", () => {
  const verdictFixtures = readJson(PHASE3_VERDICT_FIXTURES);
  const seenRatings = new Set();
  for (const verdictCase of verdictFixtures.cases) {
    const result = runVerdictCase(verdictCase);
    assert.equal(result.passes, true, verdictCase.id);
    seenRatings.add(result.verdict.rating);
  }
  assert.deepEqual(
    [...seenRatings].sort(),
    [
      "Below Strong Working Draft",
      "Benchmark Quality Confirmed",
      "Benchmark Quality With Caveats",
      "Strong Working Draft",
    ].sort(),
  );
});
