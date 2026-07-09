import assert from "node:assert/strict";

import { loadProjectBrief, normaliseProjectBrief } from "../generate/brief.mjs";
import {
  assertRetrievalMatchesFixtureExpectations,
  buildRetrievalPacket,
} from "../generate/retrieval.mjs";
import {
  createFixtureProvider,
  createSequenceProvider,
  findUnseededControlSourceIds,
  runGenerationPipeline,
} from "../generate/pipeline.mjs";
import { buildKnowledgeSnapshot, canonicalClone, readJson, REPO_ROOT } from "./kb-source.mjs";

const UNITAS_BRIEF = "fixtures/golden/briefs/unitas-project-brief.json";
const UNITAS_DOCUMENT_SET = "fixtures/golden/document-sets/unitas-document-set.json";
const CONDITIONAL_RISK_BRIEF = "fixtures/golden/briefs/conditional-risk-project-brief.json";
const CONDITIONAL_RISK_DOCUMENT_SET =
  "fixtures/golden/document-sets/conditional-risk-document-set.json";

const failures = [];

await runCheck("Unitas project brief validates and package aliases normalise", async () => {
  const snapshot = await buildKnowledgeSnapshot();
  const brief = await loadProjectBrief(UNITAS_BRIEF, { snapshot });
  const normalised = await normaliseProjectBrief(brief, { snapshot });
  assert.equal(normalised.project.trade_packages.length, 20);
  assert.equal(
    normalised.package_mappings.find((mapping) => mapping.input_name === "Piling").canonical_name,
    "Augered pier footings / bored concrete piers",
  );
});

await runCheck("retrieval packet matches golden HRCW/control/hold-point expectations", async () => {
  const snapshot = await buildKnowledgeSnapshot();
  const brief = await loadProjectBrief(UNITAS_BRIEF, { snapshot });
  const normalised = await normaliseProjectBrief(brief, { snapshot });
  const retrievalPacket = await buildRetrievalPacket(normalised, { snapshot });
  assertRetrievalMatchesFixtureExpectations(brief, retrievalPacket);
});

await runCheck("fixture-backed generation passes schema and deterministic rules", async () => {
  const result = await runGenerationPipeline({
    briefPath: UNITAS_BRIEF,
    provider: createFixtureProvider(),
    maxRetries: 0,
  });

  assert.equal(result.status, "pass");
  assert.equal(result.validationReport.status, "pass");
  assert.equal(result.provenance.workflow_state, "DRAFT");
  assert.equal(result.provenance.issue_gate.issue_ready, false);
  assert.deepEqual(findUnseededControlSourceIds(result.documentSet, result.retrievalPacket), []);
});

await runCheck(
  "conditional-risk synthetic fixture keeps unconfirmed HRCW conditional",
  async () => {
    const result = await runGenerationPipeline({
      briefPath: CONDITIONAL_RISK_BRIEF,
      provider: createFixtureProvider({ fixturePath: CONDITIONAL_RISK_DOCUMENT_SET }),
      maxRetries: 0,
    });

    assert.equal(result.status, "pass");
    const hrcw = new Map(result.documentSet.hrcw_register.map((row) => [row.ref, row]));
    assert.equal(hrcw.get("H01").trigger_status, "confirmed_hrcw");
    assert.equal(hrcw.get("H14").trigger_status, "conditional_hrcw");
    assert.equal(hrcw.get("H15").trigger_status, "conditional_hrcw");
    assert.equal(hrcw.get("H11").trigger_status, "conditional_hrcw");
    assert.equal(hrcw.get("H12").trigger_status, "not_triggered");
    assert.deepEqual(findUnseededControlSourceIds(result.documentSet, result.retrievalPacket), []);
  },
);

await runCheck("schema-invalid structured response is corrected within bounded retry", async () => {
  const golden = await readJson(REPO_ROOT, UNITAS_DOCUMENT_SET);
  const invalid = canonicalClone(golden);
  delete invalid.hrcw_register;

  const result = await runGenerationPipeline({
    briefPath: UNITAS_BRIEF,
    provider: createSequenceProvider([invalid, golden]),
    maxRetries: 1,
  });

  assert.equal(result.status, "pass");
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].validation_report.schema.status, "fail");
});

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL ${failure}`);
  }
  process.exit(1);
}

console.log("PHASE 4 GENERATION GATE: PASS");

async function runCheck(label, check) {
  try {
    await check();
    console.log(`PASS ${label}`);
  } catch (error) {
    failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
