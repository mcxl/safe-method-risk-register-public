import assert from "node:assert/strict";

import {
  buildSectionEnvelopeFromDocumentSet,
  RISK_REGISTER_CHUNK_SECTIONS,
  runSectionedGenerationPipeline,
  SECTION_NAMES,
} from "../generate/sectioned-pipeline.mjs";
import { assertDocumentSetRenderable } from "../render/docx-renderer.mjs";
import { canonicalClone, readJson, REPO_ROOT } from "./kb-source.mjs";

const SAMPLE_BRIEF = "fixtures/golden/briefs/sample-project-brief.json";
const SAMPLE_DOCUMENT_SET = "fixtures/golden/document-sets/sample-document-set.json";

const failures = [];

await runCheck(
  "sectioned fixture generation assembles and validates the Sample document set",
  async () => {
    const golden = await readJson(REPO_ROOT, SAMPLE_DOCUMENT_SET);
    const result = await runSectionedGenerationPipeline({
      briefPath: SAMPLE_BRIEF,
      maxRetries: 0,
    });

    assert.equal(result.status, "pass");
    assert.equal(result.validationReport.status, "pass");
    assert.equal(result.provenance.generation_mode, "sectioned");
    assert.equal(result.provenance.workflow_state, "DRAFT");
    assert.equal(result.provenance.issue_gate.issue_ready, false);
    assert.equal(result.provenance.section_attempts.length, SECTION_NAMES.length);

    for (const key of [
      "hrcw_register",
      "swms_matrix",
      "hold_point_schedule",
      "risk_register",
      "swms_benchmark_reviews",
      "intended_swms",
      "supporting_documents",
      "confirmation_items",
      "legal_references",
      "swms_benchmark_note",
      "historical_mode",
    ]) {
      assert.deepEqual(
        result.documentSet[key],
        golden[key],
        `${key} should match the golden section`,
      );
    }

    assert.deepEqual(result.documentSet.project, result.normalisedBrief.project);
    assertDocumentSetRenderable(result.documentSet);
  },
);

await runCheck("malformed section output fails closed with section evidence", async () => {
  const result = await runSectionedGenerationPipeline({
    briefPath: SAMPLE_BRIEF,
    provider: fixedSectionProvider("{not json"),
    maxRetries: 0,
  });

  assertSectionFailure(result, "hrcw_register");
  assert.match(result.validationReport.provider_error, /JSON/u);
});

await runCheck("missing section payload fails closed with section evidence", async () => {
  const result = await runSectionedGenerationPipeline({
    briefPath: SAMPLE_BRIEF,
    provider: fixedSectionProvider({ section_name: "hrcw_register" }),
    maxRetries: 0,
  });

  assertSectionFailure(result, "hrcw_register");
  assert.match(result.validationReport.schema.errors, /hrcw_register/u);
});

await runCheck("extra top-level section key fails closed with section evidence", async () => {
  const golden = await readJson(REPO_ROOT, SAMPLE_DOCUMENT_SET);
  const result = await runSectionedGenerationPipeline({
    briefPath: SAMPLE_BRIEF,
    provider: fixedSectionProvider({
      section_name: "hrcw_register",
      hrcw_register: golden.hrcw_register,
      extra_key: true,
    }),
    maxRetries: 0,
  });

  assertSectionFailure(result, "hrcw_register");
  assert.match(result.validationReport.schema.errors, /additional properties/u);
});

await runCheck("wrong section name fails closed with section evidence", async () => {
  const golden = await readJson(REPO_ROOT, SAMPLE_DOCUMENT_SET);
  const result = await runSectionedGenerationPipeline({
    briefPath: SAMPLE_BRIEF,
    provider: fixedSectionProvider({
      section_name: "risk_register",
      hrcw_register: golden.hrcw_register,
    }),
    maxRetries: 0,
  });

  assertSectionFailure(result, "hrcw_register");
  assert.match(result.validationReport.schema.errors, /allowed value/u);
});

await runCheck("support bundle cannot invent legal references", async () => {
  const golden = await readJson(REPO_ROOT, SAMPLE_DOCUMENT_SET);
  const provider = {
    provider_name: "sectioned-legal-mismatch-fixture",
    model: "fixture:sectioned-legal-mismatch",
    async generate({ sectionName }) {
      if (sectionName !== "support_bundle") {
        return buildSectionEnvelopeFromDocumentSet(sectionName, golden);
      }

      const inventedReferences = canonicalClone(golden.legal_references);
      inventedReferences[0].id = "INVENTED-LEGAL-REF";
      return {
        section_name: "support_bundle",
        intended_swms: canonicalClone(golden.intended_swms),
        supporting_documents: canonicalClone(golden.supporting_documents),
        confirmation_items: canonicalClone(golden.confirmation_items),
        legal_references: inventedReferences,
        swms_benchmark_note: golden.swms_benchmark_note,
        historical_mode: golden.historical_mode,
      };
    },
  };

  const result = await runSectionedGenerationPipeline({
    briefPath: SAMPLE_BRIEF,
    provider,
    maxRetries: 0,
  });

  assertSectionFailure(result, "support_bundle");
  assert.match(result.validationReport.schema.errors, /legal_references/u);
});

await runCheck("assembled deterministic rule failure can be corrected within bound", async () => {
  const golden = await readJson(REPO_ROOT, SAMPLE_DOCUMENT_SET);
  const provider = {
    provider_name: "sectioned-rule-correction-fixture",
    model: "fixture:sectioned-rule-correction",
    async generate({ sectionName, correctionRound }) {
      const envelope = buildSectionEnvelopeFromDocumentSet(sectionName, golden);
      if (sectionName === "support_bundle" && !correctionRound) {
        envelope.swms_benchmark_note =
          "Subcontractor SWMS approval by the principal contractor is recorded for benchmark review.";
      }
      return envelope;
    },
  };

  const result = await runSectionedGenerationPipeline({
    briefPath: SAMPLE_BRIEF,
    provider,
    maxRetries: 0,
    maxAssemblyCorrections: 1,
  });

  assert.equal(result.status, "pass");
  assert.equal(result.validationReport.status, "pass");
  assert.equal(result.correctionAttempts.length, 1);
  assert.equal(result.correctionAttempts[0].section_name, "support_bundle");
  assert.equal(result.assemblyAttempts.length, 2);
});

await runCheck("risk chunk source_ids are repaired by section retry before assembly", async () => {
  const golden = await readJson(REPO_ROOT, SAMPLE_DOCUMENT_SET);
  const result = await runSectionedGenerationPipeline({
    briefPath: SAMPLE_BRIEF,
    provider: riskSourceIdRetryProvider(golden),
    maxRetries: 0,
    sectionMaxRetries: {
      risk_register_part_1: 1,
    },
    maxAssemblyCorrections: 0,
  });

  assert.equal(result.status, "pass");
  assert.equal(result.validationReport.status, "pass");
  assert.deepEqual(
    result.sectionAttempts
      .filter((attempt) => attempt.section_name === "risk_register_part_1")
      .map((attempt) => [attempt.attempt, attempt.status]),
    [
      [1, "fail"],
      [2, "pass"],
    ],
  );
  assert.equal(result.assemblyAttempts.length, 1);
});

await runCheck("targeted rule feedback corrections clear live-style rule failures", async () => {
  const golden = await readJson(REPO_ROOT, SAMPLE_DOCUMENT_SET);
  const provider = liveRuleFeedbackCorrectionProvider(golden);
  const result = await runSectionedGenerationPipeline({
    briefPath: SAMPLE_BRIEF,
    provider,
    maxRetries: 0,
    maxAssemblyCorrections: 1,
  });

  assert.equal(result.status, "pass");
  assert.equal(result.validationReport.status, "pass");
  assert.equal(result.assemblyAttempts.length, 2);

  const correctionSections = provider.calls
    .filter((call) => call.correctionRound)
    .map((call) => call.sectionName);
  assert.equal(correctionSections.includes("support_bundle"), true);
  assert.equal(
    correctionSections.some((sectionName) => sectionName.startsWith("risk_register_part_")),
    true,
  );
});

await runCheck("isolated RISK-007 correction preserves open confirmation and passes", async () => {
  const golden = await readJson(REPO_ROOT, SAMPLE_DOCUMENT_SET);
  const provider = isolatedRisk007CorrectionProvider(golden);
  const result = await runSectionedGenerationPipeline({
    briefPath: SAMPLE_BRIEF,
    provider,
    maxRetries: 0,
    maxAssemblyCorrections: 1,
  });

  assert.equal(result.status, "pass");
  assert.deepEqual(
    result.assemblyAttempts[0].validation_report.rules.results.map((failure) => failure.rule_id),
    ["RISK-007"],
  );
  assert.deepEqual(
    result.correctionAttempts.map((attempt) => attempt.section_name),
    [RISK_REGISTER_CHUNK_SECTIONS[0]],
  );
  assert.equal(result.documentSet.confirmation_items[0].id, "CI-ACCESS-METHOD");
  assert.equal(result.documentSet.confirmation_items[0].status, "open");
  assert.equal(
    result.documentSet.risk_register[0].controls[0].control_status,
    "conditional_control",
  );
});

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL ${failure}`);
  }
  process.exit(1);
}

console.log("PHASE 4 SECTIONED GENERATION GATE: PASS");

async function runCheck(label, check) {
  try {
    await check();
    console.log(`PASS ${label}`);
  } catch (error) {
    failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function fixedSectionProvider(response) {
  return {
    provider_name: "fixed-section-fixture",
    model: "fixture:fixed-section",
    async generate() {
      return response;
    },
  };
}

function assertSectionFailure(result, sectionName) {
  assert.equal(result.status, "fail");
  assert.equal(result.issue_ready_blocked, true);
  assert.equal(result.validationReport.section_name, sectionName);
  assert.equal(result.sectionAttempts.at(-1).section_name, sectionName);
  assert.equal(result.sectionAttempts.at(-1).status, "fail");
}

function riskSourceIdRetryProvider(golden) {
  return {
    provider_name: "risk-source-id-retry-fixture",
    model: "fixture:risk-source-id-retry",
    async generate({ sectionName, attemptNumber }) {
      const envelope = buildSectionEnvelopeFromDocumentSet(sectionName, golden);
      if (sectionName === RISK_REGISTER_CHUNK_SECTIONS[0] && attemptNumber === 1) {
        const invalid = canonicalClone(envelope);
        invalid.risk_register[0].controls[0].source_ids = [];
        return invalid;
      }
      return envelope;
    },
  };
}

function isolatedRisk007CorrectionProvider(golden) {
  const calls = [];
  return {
    calls,
    provider_name: "isolated-risk-007-fixture",
    model: "fixture:isolated-risk-007",
    async generate(call) {
      calls.push(call);
      const envelope = buildSectionEnvelopeFromDocumentSet(call.sectionName, golden);
      if (call.sectionName === "support_bundle") {
        return supportBundleWithOpenAccessConfirmation(envelope);
      }
      if (call.sectionName === RISK_REGISTER_CHUNK_SECTIONS[0]) {
        const invalid = invalidRisk007RiskEnvelope(accessConditionedRiskEnvelope(envelope));
        return call.correctionRound ? accessConditionedRiskEnvelope(invalid) : invalid;
      }
      if (call.sectionName.startsWith("risk_register_part_")) {
        return accessConditionedRiskEnvelope(envelope);
      }
      return envelope;
    },
  };
}

function supportBundleWithOpenAccessConfirmation(envelope) {
  const invalid = canonicalClone(envelope);
  invalid.confirmation_items = [openAccessConfirmationItem()];
  return invalid;
}

function openAccessConfirmationItem() {
  return {
    id: "CI-ACCESS-METHOD",
    title: "Access method confirmation",
    status: "open",
    blocking_level: "blocks_specific_task",
    owner_role: "Principal contractor",
    evidence_required: "Confirm scaffold, EWP, platform or other access system before task work.",
    notes: "Synthetic fixture item for RISK-007 correction routing.",
  };
}

function accessConditionedRiskEnvelope(envelope) {
  const conditioned = canonicalClone(envelope);
  for (const row of conditioned.risk_register ?? []) {
    let rowReferencesAccessConfirmation = false;
    for (const control of row.controls ?? []) {
      if (control.control_status === "active_control" && testAccessSpecificControl(control)) {
        control.control_status = "conditional_control";
        rowReferencesAccessConfirmation = true;
      }
    }
    if (rowReferencesAccessConfirmation) {
      row.confirmation_item_refs = [
        ...new Set([...(row.confirmation_item_refs ?? []), "CI-ACCESS-METHOD"]),
      ];
    }
  }
  return conditioned;
}

function invalidRisk007RiskEnvelope(envelope) {
  const invalid = canonicalClone(envelope);
  invalid.risk_register[0].controls[0].text = [
    invalid.risk_register[0].controls[0].text,
    "EWP access system treated as an active method before access confirmation.",
  ].join("\n");
  invalid.risk_register[0].controls[0].control_status = "active_control";
  invalid.risk_register[0].confirmation_item_refs = [
    ...new Set([...(invalid.risk_register[0].confirmation_item_refs ?? []), "CI-ACCESS-METHOD"]),
  ];
  return invalid;
}

function testAccessSpecificControl(control) {
  const text = [control.text, ...(control.source_ids ?? [])].join(" ");
  return /\b(scaffold|ewp|boom lift|scissor lift|work platform|platform|access system)\b/i.test(
    text,
  );
}

function liveRuleFeedbackCorrectionProvider(golden) {
  const calls = [];
  return {
    calls,
    provider_name: "live-rule-feedback-fixture",
    model: "fixture:live-rule-feedback",
    async generate(call) {
      calls.push(call);
      const envelope = buildSectionEnvelopeFromDocumentSet(call.sectionName, golden);
      if (call.correctionRound) {
        return envelope;
      }
      if (call.sectionName === "support_bundle") {
        return invalidLiveSupportBundleEnvelope(envelope);
      }
      if (call.sectionName === RISK_REGISTER_CHUNK_SECTIONS[0]) {
        return invalidLiveRiskChunkEnvelope(envelope);
      }
      return envelope;
    },
  };
}

function invalidLiveSupportBundleEnvelope(envelope) {
  const invalid = canonicalClone(envelope);
  invalid.swms_benchmark_note =
    "Subcontractor SWMS approval by the principal contractor is recorded for benchmark review.";
  invalid.confirmation_items = [
    {
      id: "CI-ACCESS-METHOD",
      title: "Access method confirmation",
      status: "open",
      blocking_level: "blocks_specific_task",
      owner_role: "Principal contractor",
      evidence_required: "Confirm scaffold, EWP, platform or other access system before task work.",
      notes: "Synthetic fixture item for RISK-007 correction routing.",
    },
  ];
  return invalid;
}

function invalidLiveRiskChunkEnvelope(envelope) {
  const invalid = canonicalClone(envelope);
  invalid.risk_register[0].classification_tags = [
    ...new Set([
      ...(invalid.risk_register[0].classification_tags ?? []),
      "engineering_release_required",
    ]),
  ];
  invalid.risk_register[0].controls[0].text = [
    invalid.risk_register[0].controls[0].text,
    "Scaffold access platform treated as an active method before access confirmation.",
  ].join("\n");
  return invalid;
}
