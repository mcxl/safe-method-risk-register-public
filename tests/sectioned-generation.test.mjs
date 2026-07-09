import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAssemblyCorrectionPlan,
  buildSectionEnvelopeFromDocumentSet,
  buildSectionGenerationRequest,
  buildSectionOutputSchema,
  createSectionedFixtureProvider,
  parseSectionProviderResponse,
  RISK_REGISTER_CHUNK_SECTIONS,
  runSectionedGenerationPipeline,
  SECTION_NAMES,
  SWMS_BENCHMARK_REVIEW_CHUNK_SECTIONS,
} from "../generate/sectioned-pipeline.mjs";
import { loadProjectBrief, normaliseProjectBrief } from "../generate/brief.mjs";
import { buildRetrievalPacket } from "../generate/retrieval.mjs";
import {
  buildKnowledgeSnapshot,
  canonicalClone,
  readJson,
  REPO_ROOT,
} from "../scripts/kb-source.mjs";

const UNITAS_BRIEF = "fixtures/golden/briefs/unitas-project-brief.json";
const UNITAS_DOCUMENT_SET = "fixtures/golden/document-sets/unitas-document-set.json";

test("sectioned fixture provider assembles sections into a validated DRAFT document set", async () => {
  const golden = await readJson(REPO_ROOT, UNITAS_DOCUMENT_SET);
  const result = await runSectionedGenerationPipeline({
    briefPath: UNITAS_BRIEF,
    provider: createSectionedFixtureProvider(),
    maxRetries: 0,
  });

  assert.equal(result.status, "pass");
  assert.equal(result.validationReport.status, "pass");
  assert.equal(result.provenance.generation_mode, "sectioned");
  assert.equal(result.provenance.issue_gate.issue_ready, false);
  assert.equal(result.provenance.section_attempts.length, SECTION_NAMES.length);
  assert.equal(result.attempts.at(-1).section_name, "assembled_document_set");

  for (const sectionName of [
    "hrcw_register",
    "swms_matrix",
    "hold_point_schedule",
    "risk_register",
    "swms_benchmark_reviews",
  ]) {
    assert.deepEqual(result.documentSet[sectionName], golden[sectionName]);
  }

  assert.deepEqual(result.documentSet.legal_references, golden.legal_references);
  assert.deepEqual(result.documentSet.project, result.normalisedBrief.project);
});

test("section output schemas are strict section envelopes", () => {
  const schema = buildSectionOutputSchema("hrcw_register", { anthropic: false });

  assert.deepEqual(schema.required, ["section_name", "hrcw_register"]);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.section_name.enum, ["hrcw_register"]);
  assert.ok(schema.$defs["hrcw-register-row"]);
  assert.equal(Object.hasOwn(schema.$defs, "risk-register-row"), false);
});

test("risk register chunk schemas are strict chunk envelopes", () => {
  const schema = buildSectionOutputSchema("risk_register_part_1", { anthropic: false });

  assert.deepEqual(schema.required, ["section_name", "risk_register"]);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.section_name.enum, ["risk_register_part_1"]);
  assert.ok(schema.$defs["risk-register-row"]);
  assert.equal(Object.hasOwn(schema.$defs, "hrcw-register-row"), false);
});

test("SWMS benchmark review chunk schemas are strict chunk envelopes", () => {
  const schema = buildSectionOutputSchema("swms_benchmark_reviews_part_1", {
    anthropic: false,
  });

  assert.deepEqual(schema.required, ["section_name", "swms_benchmark_reviews"]);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.section_name.enum, ["swms_benchmark_reviews_part_1"]);
  assert.ok(schema.$defs["swms-benchmark-review"]);
  assert.equal(Object.hasOwn(schema.$defs, "risk-register-row"), false);
});

test("risk register chunks assemble to the exact golden risk register", async () => {
  const golden = await readJson(REPO_ROOT, UNITAS_DOCUMENT_SET);
  const rows = [];

  for (const sectionName of RISK_REGISTER_CHUNK_SECTIONS) {
    const envelope = buildSectionEnvelopeFromDocumentSet(sectionName, golden);
    assert.equal(envelope.section_name, sectionName);
    assert.ok(envelope.risk_register.length > 0);
    rows.push(...envelope.risk_register);
  }

  assert.deepEqual(rows, golden.risk_register);
});

test("SWMS benchmark review chunks assemble to the exact golden reviews", async () => {
  const golden = await readJson(REPO_ROOT, UNITAS_DOCUMENT_SET);
  const rows = [];

  for (const sectionName of SWMS_BENCHMARK_REVIEW_CHUNK_SECTIONS) {
    const envelope = buildSectionEnvelopeFromDocumentSet(sectionName, golden);
    assert.equal(envelope.section_name, sectionName);
    assert.ok(envelope.swms_benchmark_reviews.length > 0);
    rows.push(...envelope.swms_benchmark_reviews);
  }

  assert.deepEqual(rows, golden.swms_benchmark_reviews);
});

test("section generation request uses section schema and omits local assembly fields", async () => {
  const snapshot = await buildKnowledgeSnapshot();
  const brief = await loadProjectBrief(UNITAS_BRIEF, { snapshot });
  const normalised = await normaliseProjectBrief(brief, { snapshot });
  const retrievalPacket = await buildRetrievalPacket(normalised, { snapshot });
  const request = await buildSectionGenerationRequest({
    sectionName: "risk_register_part_1",
    normalisedBrief: normalised,
    retrievalPacket,
    model: "fixture:model",
  });

  assert.equal(request.output_config.format.type, "json_schema");
  assert.deepEqual(request.output_config.format.schema.properties.section_name.enum, [
    "risk_register_part_1",
  ]);
  assert.equal(
    request.messages[0].content.includes("Do not return document_level or project"),
    true,
  );
  assert.equal(request.messages[0].content.includes("methodology_sequence positions 1-4"), true);
});

test("section generation request includes accepted prior sections as consistency context", async () => {
  const snapshot = await buildKnowledgeSnapshot();
  const brief = await loadProjectBrief(UNITAS_BRIEF, { snapshot });
  const normalised = await normaliseProjectBrief(brief, { snapshot });
  const retrievalPacket = await buildRetrievalPacket(normalised, { snapshot });
  const request = await buildSectionGenerationRequest({
    sectionName: "swms_matrix",
    normalisedBrief: normalised,
    retrievalPacket,
    model: "fixture:model",
    acceptedSections: {
      hold_point_schedule: [
        {
          ref: "HP-01",
          status: "active",
          title: "Fixture Hold Point",
          packages: ["Site establishment"],
          trigger: "Fixture trigger",
          precondition: "Fixture precondition",
          release_criteria: "Fixture release criteria",
          release_authority: "Principal contractor",
          authority_text: "Principal contractor",
          evidence_required: "Fixture evidence",
          linked_hrcw_refs: ["H01"],
        },
      ],
    },
  });

  assert.equal(
    request.messages[0].content.includes(
      "Accepted prior section outputs are fixed consistency context",
    ),
    true,
  );
  assert.equal(request.messages[0].content.includes("Fixture Hold Point"), true);
  assert.equal(request.messages[0].content.includes("do not invent hold point refs"), true);
});

test("risk chunk request includes non-empty source id contract on first pass", async () => {
  const { normalised, retrievalPacket } = await buildUnitasRequestContext();
  const request = await buildSectionGenerationRequest({
    sectionName: "risk_register_part_4",
    normalisedBrief: normalised,
    retrievalPacket,
    model: "fixture:model",
  });

  assert.equal(
    request.messages[0].content.includes(
      "Every risk_register row control must include controls[].source_ids as a non-empty array.",
    ),
    true,
  );
  assert.equal(
    request.messages[0].content.includes(
      "Each source_ids value must be copied exactly from retrieval_packet.candidate_summary.control_source_ids.",
    ),
    true,
  );
  assert.equal(request.messages[0].content.includes("Risk source_id schema repair context"), false);
});

test("risk chunk retry after empty source ids includes compact source catalogue", async () => {
  const { normalised, retrievalPacket } = await buildUnitasRequestContext();
  const request = await buildSectionGenerationRequest({
    sectionName: "risk_register_part_4",
    normalisedBrief: normalised,
    retrievalPacket,
    model: "fixture:model",
    correctionContext: {
      status: "fail",
      section_name: "risk_register_part_4",
      schema: {
        status: "fail",
        schema_id:
          "https://safemethod.app/schemas/sectioned-generation/risk_register_part_4.schema.json",
        errors: "/risk_register/15/controls/0/source_ids must NOT have fewer than 1 items",
      },
      rules: null,
    },
  });

  assert.equal(request.messages[0].content.includes("Risk source_id schema repair context"), true);
  assert.equal(
    request.messages[0].content.includes("/risk_register/15/controls/0/source_ids"),
    true,
  );
  assert.equal(
    request.messages[0].content.includes("Compact retrieved control source catalogue"),
    true,
  );
  assert.equal(request.messages[0].content.includes("fall-edge-protection"), true);
});

test("risk chunk retry after missing source ids includes compact source catalogue", async () => {
  const { normalised, retrievalPacket } = await buildUnitasRequestContext();
  const request = await buildSectionGenerationRequest({
    sectionName: "risk_register_part_2",
    normalisedBrief: normalised,
    retrievalPacket,
    model: "fixture:model",
    correctionContext: {
      status: "fail",
      section_name: "risk_register_part_2",
      schema: {
        status: "fail",
        schema_id:
          "https://safemethod.app/schemas/sectioned-generation/risk_register_part_2.schema.json",
        errors: "/risk_register/1/controls/0 must have required property 'source_ids'",
      },
      rules: null,
    },
  });

  assert.equal(request.messages[0].content.includes("Risk source_id schema repair context"), true);
  assert.equal(
    request.messages[0].content.includes("/risk_register/1/controls/0/source_ids"),
    true,
  );
});

test("non-risk section retry does not include risk source catalogue", async () => {
  const { normalised, retrievalPacket } = await buildUnitasRequestContext();
  const request = await buildSectionGenerationRequest({
    sectionName: "swms_matrix",
    normalisedBrief: normalised,
    retrievalPacket,
    model: "fixture:model",
    correctionContext: {
      status: "fail",
      section_name: "swms_matrix",
      schema: {
        status: "fail",
        schema_id: "https://safemethod.app/schemas/sectioned-generation/swms_matrix.schema.json",
        errors: "/risk_register/1/controls/0/source_ids must NOT have fewer than 1 items",
      },
      rules: null,
    },
  });

  assert.equal(request.messages[0].content.includes("Risk source_id schema repair context"), false);
  assert.equal(
    request.messages[0].content.includes("Compact retrieved control source catalogue"),
    false,
  );
});

test("assembled correction prompt includes CONTENT-001 wording repair guidance", async () => {
  const { normalised, retrievalPacket } = await buildUnitasRequestContext();
  const request = await buildSectionGenerationRequest({
    sectionName: "support_bundle",
    normalisedBrief: normalised,
    retrievalPacket,
    model: "fixture:model",
    assemblyCorrectionContext: {
      correction_round: 1,
      failures: [
        {
          rule_id: "CONTENT-001",
          suite: "content",
          status: "fail",
          message: "Subcontractor SWMS language must use reviewed-and-accepted wording.",
          json_path: "/swms_benchmark_note",
        },
      ],
    },
  });

  assert.equal(
    request.messages[0].content.includes("Rule-specific deterministic repair guidance"),
    true,
  );
  assert.equal(
    request.messages[0].content.includes(
      "reviewed by the principal contractor and accepted for commencement subject to project requirements and hold points",
    ),
    true,
  );
  assert.equal(
    request.messages[0].content.includes("Remove approve/approves/approved/approval/approving"),
    true,
  );
});

test("assembled correction prompt includes targeted risk repair guidance", async () => {
  const { normalised, retrievalPacket } = await buildUnitasRequestContext();
  const request = await buildSectionGenerationRequest({
    sectionName: "risk_register_part_1",
    normalisedBrief: normalised,
    retrievalPacket,
    model: "fixture:model",
    assemblyCorrectionContext: {
      correction_round: 1,
      failures: [
        {
          rule_id: "RISK-004",
          suite: "risk",
          status: "fail",
          message: "Structural/access risk row SE-01 has no engineer-release condition.",
          json_path: "/risk_register/0",
        },
        {
          rule_id: "RISK-007",
          suite: "risk",
          status: "fail",
          message:
            "Risk row SE-01 confirms access-specific controls while the access method is still unconfirmed.",
          json_path: "/risk_register/0/controls",
        },
      ],
    },
  });

  assert.equal(request.messages[0].content.includes("RISK-004"), true);
  assert.equal(request.messages[0].content.includes("engineer-release condition"), true);
  assert.equal(request.messages[0].content.includes("RISK-007"), true);
  assert.equal(request.messages[0].content.includes("conditional_control"), true);
  assert.equal(request.messages[0].content.includes("active_control"), true);
});

test("RISK-007 correction prompt includes open access confirmation and target controls", async () => {
  const golden = await readJson(REPO_ROOT, UNITAS_DOCUMENT_SET);
  const { normalised, retrievalPacket } = await buildUnitasRequestContext();
  const riskEnvelope = buildSectionEnvelopeFromDocumentSet("risk_register_part_1", golden);
  const acceptedSections = {
    risk_register_part_1: invalidRisk007RiskEnvelope(accessConditionedRiskEnvelope(riskEnvelope))
      .risk_register,
    support_bundle: {
      confirmation_items: [openAccessConfirmationItem()],
    },
  };
  const request = await buildSectionGenerationRequest({
    sectionName: "risk_register_part_1",
    normalisedBrief: normalised,
    retrievalPacket,
    model: "fixture:model",
    acceptedSections,
    assemblyCorrectionContext: {
      correction_round: 1,
      failures: [
        {
          rule_id: "RISK-007",
          suite: "risk",
          status: "fail",
          message:
            "Risk row SE-01 confirms access-specific controls while the access method is still unconfirmed.",
          json_path: "/risk_register/0/controls",
        },
      ],
    },
  });

  assert.equal(
    request.messages[0].content.includes("RISK-007 concrete access-control repair context"),
    true,
  );
  assert.equal(request.messages[0].content.includes("CI-ACCESS-METHOD"), true);
  assert.equal(request.messages[0].content.includes('"row_ref": "SE-01"'), true);
  assert.equal(request.messages[0].content.includes('"control_index": 0'), true);
  assert.equal(
    request.messages[0].content.includes('"required_control_status": "conditional_control"'),
    true,
  );
});

test("assembled correction prompt omits unrelated rule-specific guidance", async () => {
  const { normalised, retrievalPacket } = await buildUnitasRequestContext();
  const request = await buildSectionGenerationRequest({
    sectionName: "swms_matrix",
    normalisedBrief: normalised,
    retrievalPacket,
    model: "fixture:model",
    assemblyCorrectionContext: {
      correction_round: 1,
      failures: [
        {
          rule_id: "CONSISTENCY-003",
          suite: "consistency",
          status: "fail",
          message: "Hold point count mismatch.",
          json_path: "/swms_matrix",
        },
      ],
    },
  });

  assert.equal(
    request.messages[0].content.includes("Rule-specific deterministic repair guidance"),
    false,
  );
  assert.equal(request.messages[0].content.includes("engineer-release condition"), false);
  assert.equal(request.messages[0].content.includes("conditional_control"), false);
});

test("sectioned generation fails closed for wrong section responses", async () => {
  const golden = await readJson(REPO_ROOT, UNITAS_DOCUMENT_SET);
  const result = await runSectionedGenerationPipeline({
    briefPath: UNITAS_BRIEF,
    provider: {
      provider_name: "wrong-section-fixture",
      model: "fixture:wrong-section",
      async generate() {
        return {
          section_name: "risk_register",
          hrcw_register: golden.hrcw_register,
        };
      },
    },
    maxRetries: 0,
  });

  assert.equal(result.status, "fail");
  assert.equal(result.issue_ready_blocked, true);
  assert.equal(result.validationReport.section_name, "hrcw_register");
  assert.equal(result.sectionAttempts[0].section_name, "hrcw_register");
  assert.equal(result.sectionAttempts[0].status, "fail");
  assert.match(result.validationReport.schema.errors, /allowed value/u);
});

test("support bundle legal references must match approved retrieval references", async () => {
  const golden = await readJson(REPO_ROOT, UNITAS_DOCUMENT_SET);
  const provider = {
    provider_name: "legal-mismatch-fixture",
    model: "fixture:legal-mismatch",
    async generate({ sectionName }) {
      const envelope = buildSectionEnvelopeFromDocumentSet(sectionName, golden);
      if (sectionName === "support_bundle") {
        envelope.legal_references = canonicalClone(envelope.legal_references);
        envelope.legal_references[0].id = "INVENTED-LEGAL-REF";
      }
      return envelope;
    },
  };

  const result = await runSectionedGenerationPipeline({
    briefPath: UNITAS_BRIEF,
    provider,
    maxRetries: 0,
  });

  assert.equal(result.status, "fail");
  assert.equal(result.validationReport.section_name, "support_bundle");
  assert.match(result.validationReport.schema.errors, /approved retrieved legal references/u);
});

test("sectionMaxRetries applies to risk chunks while preserving global retry default", async () => {
  const golden = await readJson(REPO_ROOT, UNITAS_DOCUMENT_SET);
  const riskRetryProvider = invalidRiskSourceIdsOnceProvider(golden);
  const riskRetryResult = await runSectionedGenerationPipeline({
    briefPath: UNITAS_BRIEF,
    provider: riskRetryProvider,
    maxRetries: 0,
    sectionMaxRetries: {
      risk_register_part_1: 1,
    },
    maxAssemblyCorrections: 0,
  });

  assert.equal(riskRetryResult.status, "pass");
  assert.deepEqual(
    riskRetryResult.sectionAttempts
      .filter((attempt) => attempt.section_name === "risk_register_part_1")
      .map((attempt) => attempt.attempt),
    [1, 2],
  );
  assert.deepEqual(
    riskRetryResult.sectionAttempts
      .filter((attempt) => attempt.section_name === "hrcw_register")
      .map((attempt) => attempt.attempt),
    [1],
  );

  const nonRiskResult = await runSectionedGenerationPipeline({
    briefPath: UNITAS_BRIEF,
    provider: wrongHrcwOnceProvider(golden),
    maxRetries: 0,
    sectionMaxRetries: {
      risk_register_part_1: 1,
    },
    maxAssemblyCorrections: 0,
  });

  assert.equal(nonRiskResult.status, "fail");
  assert.equal(nonRiskResult.validationReport.section_name, "hrcw_register");
  assert.deepEqual(
    nonRiskResult.sectionAttempts
      .filter((attempt) => attempt.section_name === "hrcw_register")
      .map((attempt) => attempt.attempt),
    [1],
  );
});

test("still schema-invalid risk source id retry fails closed before assembly", async () => {
  const golden = await readJson(REPO_ROOT, UNITAS_DOCUMENT_SET);
  const result = await runSectionedGenerationPipeline({
    briefPath: UNITAS_BRIEF,
    provider: alwaysInvalidRiskSourceIdsProvider(golden),
    maxRetries: 0,
    sectionMaxRetries: {
      risk_register_part_1: 1,
    },
    maxAssemblyCorrections: 0,
  });

  assert.equal(result.status, "fail");
  assert.equal(result.issue_ready_blocked, true);
  assert.equal(result.documentSet, undefined);
  assert.equal(result.validationReport.section_name, "risk_register_part_1");
  assert.match(result.validationReport.schema.errors, /source_ids/u);
  assert.deepEqual(
    result.sectionAttempts
      .filter((attempt) => attempt.section_name === "risk_register_part_1")
      .map((attempt) => [attempt.attempt, attempt.status]),
    [
      [1, "fail"],
      [2, "fail"],
    ],
  );
  assert.equal(result.assemblyAttempts.length, 0);
});

test("assembled rule failure triggers only mapped section correction", async () => {
  const golden = await readJson(REPO_ROOT, UNITAS_DOCUMENT_SET);
  const provider = supportBundleCorrectionProvider(golden, {
    correctionMode: "golden",
  });

  const result = await runSectionedGenerationPipeline({
    briefPath: UNITAS_BRIEF,
    provider,
    maxRetries: 0,
    maxAssemblyCorrections: 1,
  });

  assert.equal(result.status, "pass");
  assert.equal(result.validationReport.status, "pass");
  assert.equal(result.correctionAttempts.length, 1);
  assert.equal(result.correctionAttempts[0].section_name, "support_bundle");
  assert.equal(result.assemblyAttempts.length, 2);
  assert.equal(result.provenance.correction_attempts.length, 1);
  assert.deepEqual(
    provider.calls.filter((call) => call.correctionRound).map((call) => call.sectionName),
    ["support_bundle"],
  );
});

test("targeted live rule feedback corrections reassemble to validation pass", async () => {
  const golden = await readJson(REPO_ROOT, UNITAS_DOCUMENT_SET);
  const provider = liveRuleFeedbackCorrectionProvider(golden);

  const result = await runSectionedGenerationPipeline({
    briefPath: UNITAS_BRIEF,
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

test("isolated RISK-007 correction targets owning risk chunk and preserves open confirmation", async () => {
  const golden = await readJson(REPO_ROOT, UNITAS_DOCUMENT_SET);
  const provider = isolatedRisk007CorrectionProvider(golden);

  const result = await runSectionedGenerationPipeline({
    briefPath: UNITAS_BRIEF,
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
    ["risk_register_part_1"],
  );
  assert.equal(result.documentSet.confirmation_items[0].id, "CI-ACCESS-METHOD");
  assert.equal(result.documentSet.confirmation_items[0].status, "open");
  assert.equal(
    result.documentSet.risk_register[0].controls[0].control_status,
    "conditional_control",
  );
  assert.equal(
    result.documentSet.risk_register[0].confirmation_item_refs.includes("CI-ACCESS-METHOD"),
    true,
  );
});

test("maxAssemblyCorrections 0 preserves isolated RISK-007 fail-closed behavior", async () => {
  const golden = await readJson(REPO_ROOT, UNITAS_DOCUMENT_SET);
  const result = await runSectionedGenerationPipeline({
    briefPath: UNITAS_BRIEF,
    provider: isolatedRisk007CorrectionProvider(golden),
    maxRetries: 0,
    maxAssemblyCorrections: 0,
  });

  assert.equal(result.status, "fail");
  assert.equal(result.issue_ready_blocked, true);
  assert.equal(result.validationReport.schema.status, "pass");
  assert.equal(result.validationReport.rules.status, "fail");
  assert.deepEqual(
    result.validationReport.rules.results.map((failure) => failure.rule_id),
    ["RISK-007"],
  );
  assert.equal(result.validationReport.rules.results[0].json_path, "/risk_register/0/controls");
  assert.equal(result.correctionAttempts.length, 0);
});

test("maxAssemblyCorrections 0 preserves assembled rule failure", async () => {
  const golden = await readJson(REPO_ROOT, UNITAS_DOCUMENT_SET);
  const result = await runSectionedGenerationPipeline({
    briefPath: UNITAS_BRIEF,
    provider: supportBundleCorrectionProvider(golden, {
      correctionMode: "golden",
    }),
    maxRetries: 0,
    maxAssemblyCorrections: 0,
  });

  assert.equal(result.status, "fail");
  assert.equal(result.issue_ready_blocked, true);
  assert.equal(result.validationReport.schema.status, "pass");
  assert.equal(result.validationReport.rules.status, "fail");
  assert.equal(result.correctionAttempts.length, 0);
  assert.equal(result.assemblyAttempts.length, 1);
});

test("malformed assembly correction response fails closed with section evidence", async () => {
  const golden = await readJson(REPO_ROOT, UNITAS_DOCUMENT_SET);
  const result = await runSectionedGenerationPipeline({
    briefPath: UNITAS_BRIEF,
    provider: supportBundleCorrectionProvider(golden, {
      correctionMode: "malformed",
    }),
    maxRetries: 0,
    maxAssemblyCorrections: 1,
  });

  assert.equal(result.status, "fail");
  assert.equal(result.issue_ready_blocked, true);
  assert.equal(result.validationReport.section_name, "support_bundle");
  assert.equal(result.correctionAttempts.at(-1).section_name, "support_bundle");
  assert.equal(result.correctionAttempts.at(-1).status, "fail");
  assert.match(result.validationReport.provider_error, /JSON/u);
});

test("assembly correction bound is respected when rule failures remain", async () => {
  const golden = await readJson(REPO_ROOT, UNITAS_DOCUMENT_SET);
  const result = await runSectionedGenerationPipeline({
    briefPath: UNITAS_BRIEF,
    provider: supportBundleCorrectionProvider(golden, {
      correctionMode: "still-invalid",
    }),
    maxRetries: 0,
    maxAssemblyCorrections: 1,
  });

  assert.equal(result.status, "fail");
  assert.equal(result.issue_ready_blocked, true);
  assert.equal(result.validationReport.schema.status, "pass");
  assert.equal(result.validationReport.rules.status, "fail");
  assert.equal(result.correctionAttempts.length, 1);
  assert.equal(result.assemblyAttempts.length, 2);
});

test("assembly correction plan routes indexed failures to owning chunks", () => {
  const sections = correctionRoutingSections();
  const plan = buildAssemblyCorrectionPlan(
    {
      rules: {
        results: [
          {
            rule_id: "RISK-004",
            suite: "risk",
            status: "fail",
            message: "Risk row failure",
            json_path: "/risk_register/3",
          },
          {
            rule_id: "SWMS-001",
            suite: "swms_review",
            status: "fail",
            message: "SWMS review failure",
            json_path: "/swms_benchmark_reviews/10",
            criterion_number: 1,
          },
        ],
      },
    },
    sections,
  );

  assert.deepEqual(
    plan.map((entry) => entry.section_name),
    ["risk_register_part_2", "swms_benchmark_reviews_part_2"],
  );
});

test("assembly correction plan routes RISK-007 indexed failures to owning risk chunk", () => {
  const sections = correctionRoutingSections();
  const plan = buildAssemblyCorrectionPlan(
    {
      rules: {
        results: [
          {
            rule_id: "RISK-007",
            suite: "risk",
            status: "fail",
            message: "Active access control with open access confirmation.",
            json_path: "/risk_register/3/controls",
          },
        ],
      },
    },
    sections,
  );

  assert.deepEqual(
    plan.map((entry) => entry.section_name),
    ["risk_register_part_2"],
  );
});

test("assembly correction plan routes support and special consistency failures", () => {
  const sections = correctionRoutingSections();
  const plan = buildAssemblyCorrectionPlan(
    {
      rules: {
        results: [
          {
            rule_id: "CONTENT-001",
            suite: "content",
            status: "fail",
            message: "Support wording failure",
            json_path: "/swms_benchmark_note",
          },
          {
            rule_id: "CONSISTENCY-003",
            suite: "consistency",
            status: "fail",
            message: "Hold point count failure",
            json_path: "/hold_point_schedule",
          },
          {
            rule_id: "CONSISTENCY-006",
            suite: "consistency",
            status: "fail",
            message: "Duplicate risk ref",
            json_path: "/risk_register/1/ref",
          },
        ],
      },
    },
    sections,
  );

  assert.deepEqual(
    plan.map((entry) => entry.section_name),
    [
      "hold_point_schedule",
      "swms_matrix",
      "risk_register_part_1",
      "risk_register_part_2",
      "risk_register_part_3",
      "risk_register_part_4",
      "support_bundle",
    ],
  );
});

test("Anthropic-style section text responses parse as section envelopes", async () => {
  const golden = await readJson(REPO_ROOT, UNITAS_DOCUMENT_SET);
  const envelope = buildSectionEnvelopeFromDocumentSet("swms_matrix", golden);
  const parsed = parseSectionProviderResponse({
    content: [
      {
        type: "text",
        text: JSON.stringify(envelope),
      },
    ],
  });

  assert.deepEqual(parsed, envelope);
});

function supportBundleCorrectionProvider(golden, options = {}) {
  const calls = [];
  return {
    calls,
    provider_name: "support-correction-fixture",
    model: "fixture:support-correction",
    async generate(call) {
      calls.push(call);
      const envelope = buildSectionEnvelopeFromDocumentSet(call.sectionName, golden);
      if (call.sectionName !== "support_bundle") {
        return envelope;
      }
      if (!call.correctionRound || options.correctionMode === "still-invalid") {
        return invalidSupportBundleEnvelope(envelope);
      }
      if (options.correctionMode === "malformed") {
        return "{not json";
      }
      return envelope;
    },
  };
}

function invalidSupportBundleEnvelope(envelope) {
  return {
    ...canonicalClone(envelope),
    swms_benchmark_note:
      "Subcontractor SWMS approval by the principal contractor is recorded for benchmark review.",
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
      if (call.sectionName === "risk_register_part_1") {
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
      if (call.sectionName === "risk_register_part_1") {
        return invalidLiveRiskChunkEnvelope(envelope);
      }
      return envelope;
    },
  };
}

function invalidLiveSupportBundleEnvelope(envelope) {
  const invalid = invalidSupportBundleEnvelope(envelope);
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

function correctionRoutingSections() {
  return {
    hrcw_register: [],
    hold_point_schedule: [],
    swms_matrix: [],
    risk_register_part_1: rows(2),
    risk_register_part_2: rows(3),
    risk_register_part_3: rows(4),
    risk_register_part_4: rows(5),
    swms_benchmark_reviews_part_1: rows(10),
    swms_benchmark_reviews_part_2: rows(11),
    support_bundle: {},
  };
}

function rows(count) {
  return Array.from({ length: count }, (_, index) => ({ ref: `ROW-${index}` }));
}

async function buildUnitasRequestContext() {
  const snapshot = await buildKnowledgeSnapshot();
  const brief = await loadProjectBrief(UNITAS_BRIEF, { snapshot });
  const normalised = await normaliseProjectBrief(brief, { snapshot });
  const retrievalPacket = await buildRetrievalPacket(normalised, { snapshot });
  return { snapshot, brief, normalised, retrievalPacket };
}

function invalidRiskSourceIdsOnceProvider(golden) {
  return {
    provider_name: "risk-source-id-retry-fixture",
    model: "fixture:risk-source-id-retry",
    async generate({ sectionName, attemptNumber }) {
      const envelope = buildSectionEnvelopeFromDocumentSet(sectionName, golden);
      if (sectionName === "risk_register_part_1" && attemptNumber === 1) {
        return withFirstRiskControlSourceIds(envelope, []);
      }
      return envelope;
    },
  };
}

function alwaysInvalidRiskSourceIdsProvider(golden) {
  return {
    provider_name: "risk-source-id-invalid-fixture",
    model: "fixture:risk-source-id-invalid",
    async generate({ sectionName }) {
      const envelope = buildSectionEnvelopeFromDocumentSet(sectionName, golden);
      if (sectionName === "risk_register_part_1") {
        return withFirstRiskControlSourceIds(envelope, []);
      }
      return envelope;
    },
  };
}

function wrongHrcwOnceProvider(golden) {
  return {
    provider_name: "wrong-hrcw-section-fixture",
    model: "fixture:wrong-hrcw-section",
    async generate({ sectionName }) {
      if (sectionName === "hrcw_register") {
        return {
          section_name: "risk_register",
          hrcw_register: canonicalClone(golden.hrcw_register),
        };
      }
      return buildSectionEnvelopeFromDocumentSet(sectionName, golden);
    },
  };
}

function withFirstRiskControlSourceIds(envelope, sourceIds) {
  const clone = canonicalClone(envelope);
  clone.risk_register[0].controls[0].source_ids = canonicalClone(sourceIds);
  return clone;
}
