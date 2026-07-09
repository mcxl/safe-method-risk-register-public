import assert from "node:assert/strict";
import test from "node:test";

import { loadProjectBrief, normaliseProjectBrief } from "../generate/brief.mjs";
import {
  buildDocumentSetOutputSchema,
  buildDocumentSetSmokeOutputSchema,
} from "../generate/schema-bundle.mjs";
import {
  assertRetrievalMatchesFixtureExpectations,
  buildRetrievalPacket,
} from "../generate/retrieval.mjs";
import { applyConfirmationTransitions } from "../generate/conditional-status.mjs";
import {
  buildGenerationRequest,
  createFixtureProvider,
  createSequenceProvider,
  findUnseededControlSourceIds,
  parseProviderResponse,
  runGenerationPipeline,
} from "../generate/pipeline.mjs";
import {
  buildKnowledgeSnapshot,
  canonicalClone,
  readJson,
  REPO_ROOT,
  sha256Canonical,
} from "../scripts/kb-source.mjs";

const UNITAS_BRIEF = "fixtures/golden/briefs/unitas-project-brief.json";
const UNITAS_DOCUMENT_SET = "fixtures/golden/document-sets/unitas-document-set.json";
const CONDITIONAL_RISK_BRIEF = "fixtures/golden/briefs/conditional-risk-project-brief.json";
const CONDITIONAL_RISK_DOCUMENT_SET =
  "fixtures/golden/document-sets/conditional-risk-document-set.json";

test("Phase 4 project brief validates and normalises package aliases", async () => {
  const snapshot = await buildKnowledgeSnapshot();
  const brief = await loadProjectBrief(UNITAS_BRIEF, { snapshot });
  const normalised = await normaliseProjectBrief(brief, { snapshot });

  assert.equal(normalised.brief_id, "unitas-canonical-project-brief");
  assert.equal(normalised.project.trade_packages.length, 20);
  assert.deepEqual(
    normalised.package_mappings.find((mapping) => mapping.input_name === "Piling"),
    {
      input_name: "Piling",
      canonical_name: "Augered pier footings / bored concrete piers",
      matched_by: "declared_canonical",
    },
  );
});

test("Phase 4 retrieval packet matches the Unitas fixture expectations", async () => {
  const snapshot = await buildKnowledgeSnapshot();
  const brief = await loadProjectBrief(UNITAS_BRIEF, { snapshot });
  const normalised = await normaliseProjectBrief(brief, { snapshot });
  const packet = await buildRetrievalPacket(normalised, { snapshot });

  assert.equal(packet.kb_version, "kb-2026-06-24");
  assertRetrievalMatchesFixtureExpectations(brief, packet);
});

test("fixture-backed generation validates schemas, rules and provenance without network", async () => {
  const result = await runGenerationPipeline({
    briefPath: UNITAS_BRIEF,
    provider: createFixtureProvider(),
    maxRetries: 0,
  });

  assert.equal(result.status, "pass");
  assert.equal(result.validationReport.status, "pass");
  assert.equal(result.provenance.workflow_state, "DRAFT");
  assert.equal(result.provenance.reviewer_signoff.signed_off, false);
  assert.equal(result.provenance.issue_gate.issue_ready, false);
  assert.deepEqual(findUnseededControlSourceIds(result.documentSet, result.retrievalPacket), []);
});

test("conditional-risk fixture preserves conditional HRCW and control status", async () => {
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
  assert.equal(
    result.documentSet.hold_point_schedule.find((row) => row.ref === "HP-05").status,
    "pre_task_blocker",
  );
});

test("confirmed confirmation item applies transition effects audibly", async () => {
  const documentSet = await readJson(REPO_ROOT, CONDITIONAL_RISK_DOCUMENT_SET);
  const confirmed = canonicalClone(documentSet);
  const item = confirmed.confirmation_items.find(
    (candidate) => candidate.id === "ewp-mobile-plant-status",
  );
  item.status = "confirmed";

  const transitioned = applyConfirmationTransitions(confirmed, {
    confirmationItemIds: ["ewp-mobile-plant-status"],
  });

  assert.equal(
    transitioned.hrcw_register.find((row) => row.ref === "H15").trigger_status,
    "confirmed_hrcw",
  );
  assert.equal(transitioned.swms_matrix[0].hrcw_refs.includes("H15"), true);
  assert.equal(
    transitioned.risk_register.find((row) => row.ref === "PG-03").hrcw_categories.includes("H15"),
    true,
  );
});

test("generation retries once when the first structured response is schema-invalid", async () => {
  const golden = await readJson(REPO_ROOT, UNITAS_DOCUMENT_SET);
  const invalid = canonicalClone(golden);
  delete invalid.hrcw_register;
  const provider = createSequenceProvider([invalid, golden]);

  const result = await runGenerationPipeline({
    briefPath: UNITAS_BRIEF,
    provider,
    maxRetries: 1,
  });

  assert.equal(result.status, "pass");
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].validation_report.schema.status, "fail");
  assert.equal(
    provider.calls[1].request.messages[0].content.includes("Correction attempt required"),
    true,
  );
});

test("provider failure reports include fetch cause diagnostics", async () => {
  const cause = Object.assign(new Error("socket closed before response"), {
    code: "UND_ERR_SOCKET",
  });
  const provider = {
    provider_name: "failing-provider",
    model: "fixture:failing-provider",
    async generate() {
      throw new Error("fetch failed", { cause });
    },
  };

  const result = await runGenerationPipeline({
    briefPath: UNITAS_BRIEF,
    provider,
    maxRetries: 0,
  });

  assert.equal(result.status, "fail");
  assert.match(result.validationReport.provider_error, /fetch failed/u);
  assert.match(
    result.validationReport.provider_error,
    /cause: Error: socket closed before response/u,
  );
  assert.match(result.validationReport.provider_error, /code=UND_ERR_SOCKET/u);
});

test("generation request uses Anthropic native structured output config", async () => {
  const snapshot = await buildKnowledgeSnapshot();
  const brief = await loadProjectBrief(UNITAS_BRIEF, { snapshot });
  const normalised = await normaliseProjectBrief(brief, { snapshot });
  const retrievalPacket = await buildRetrievalPacket(normalised, { snapshot });
  const request = await buildGenerationRequest({
    normalisedBrief: normalised,
    retrievalPacket,
    model: "fixture:model",
  });

  assert.equal(request.output_config.format.type, "json_schema");
  assert.equal(request.messages[0].content.includes("Retrieval packet:"), true);
});

test("generation request can use the live smoke output schema", async () => {
  const snapshot = await buildKnowledgeSnapshot();
  const brief = await loadProjectBrief(UNITAS_BRIEF, { snapshot });
  const normalised = await normaliseProjectBrief(brief, { snapshot });
  const retrievalPacket = await buildRetrievalPacket(normalised, { snapshot });
  const outputSchema = buildDocumentSetSmokeOutputSchema();
  const request = await buildGenerationRequest({
    normalisedBrief: normalised,
    retrievalPacket,
    model: "fixture:model",
    outputSchema,
    responseInstructions: [
      "Return the smoke wrapper contract.",
      "Allowed hrcw_register.trigger_status values: confirmed_hrcw.",
    ],
  });

  assert.equal(request.output_config.format.schema, outputSchema);
  assert.equal(request.messages[0].content.includes("Return the smoke wrapper contract."), true);
  assert.equal(request.messages[0].content.includes("confirmed_hrcw"), true);
  assert.equal(request.output_config.format.schema.$defs, undefined);
  assert.equal(request.output_config.format.schema.additionalProperties, false);
  assert.deepEqual(request.output_config.format.schema.required, ["document_set_json"]);
  assert.equal(request.output_config.format.schema.properties.document_set_json.type, "string");
});

test("generation provenance hashes the output schema used for the request", async () => {
  const outputSchema = buildDocumentSetSmokeOutputSchema();
  const result = await runGenerationPipeline({
    briefPath: UNITAS_BRIEF,
    provider: createFixtureProvider(),
    outputSchema,
    maxRetries: 0,
  });

  assert.equal(result.status, "pass");
  assert.equal(
    result.provenance.schema.structured_output_schema_hash_sha256,
    sha256Canonical(outputSchema),
  );
});

test("wrapped live smoke provider responses are parsed before full validation", async () => {
  const golden = await readJson(REPO_ROOT, UNITAS_DOCUMENT_SET);
  const wrapped = {
    document_set_json: JSON.stringify(golden),
  };

  assert.deepEqual(parseProviderResponse(wrapped), golden);

  const result = await runGenerationPipeline({
    briefPath: UNITAS_BRIEF,
    provider: createSequenceProvider([wrapped], { providerName: "wrapped-fixture" }),
    outputSchema: buildDocumentSetSmokeOutputSchema(),
    maxRetries: 0,
  });

  assert.equal(result.status, "pass");
  assert.equal(result.validationReport.schema.status, "pass");
  assert.equal(result.validationReport.rules.status, "pass");
});

test("bundled generation schema rewrites nested schema fragments into local defs", () => {
  const bundledSchema = buildDocumentSetOutputSchema({ anthropic: false });
  const anthropicSchema = buildDocumentSetOutputSchema();

  for (const schema of [bundledSchema, anthropicSchema]) {
    const refs = collectSchemaRefs(schema);
    assert.equal(
      refs.some((ref) => ref.includes(".schema.json")),
      false,
    );
    assert.equal(
      refs.some((ref) => ref.includes("#/$defs/status-taxonomy#")),
      false,
    );
    assert.equal(
      refs.some((ref) => ref.includes("#/$defs/status-taxonomy/$defs")),
      false,
    );
    assert.ok(refs.includes("#/$defs/status-taxonomy__scope_status"));
    assert.ok(refs.includes("#/$defs/status-taxonomy__hrcw_status"));
    assert.ok(refs.includes("#/$defs/status-taxonomy__control_status"));
    assert.equal(Object.hasOwn(schema.$defs, "status-taxonomy"), false);
    assertBundledRefsResolve(schema, refs);
  }
});

function collectSchemaRefs(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectSchemaRefs(item));
  }
  if (!value || typeof value !== "object") {
    return [];
  }

  const refs = [];
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string") {
      refs.push(child);
    } else {
      refs.push(...collectSchemaRefs(child));
    }
  }
  return refs;
}

function assertBundledRefsResolve(schema, refs) {
  for (const ref of refs) {
    if (!ref.startsWith("#/$defs/")) continue;
    const definitionName = ref.slice("#/$defs/".length).split("/")[0];
    assert.ok(schema.$defs[definitionName], `${ref} should resolve to a bundled root $defs entry`);
  }
}
