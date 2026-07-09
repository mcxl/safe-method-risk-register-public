import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  buildSectionEnvelopeFromDocumentSet,
  buildSectionOutputSchema,
  parseSectionProviderResponse,
  runSectionedGenerationPipeline,
  validateSectionEnvelope,
} from "../generate/sectioned-pipeline.mjs";
import {
  assertProviderCredentialGate,
  buildOpenAIResponsesRequest,
  CODEX_ASSISTED_LOCKED_MANIFEST_STATE,
  CODEX_ASSISTED_MANIFEST_FILE,
  CODEX_ASSISTED_PREPARED_MANIFEST_STATE,
  createCodexAssistedSectionProvider,
  createOpenAIProvider,
  parseOpenAISectionResponse,
  redactSecrets,
  resolveGenerationProviderMode,
  SECTIONED_PROVIDER_CONTRACT_VERSION,
} from "../generate/sectioned-providers.mjs";
import { runCodexAssistedAssemble } from "../scripts/generate-sectioned-codex-assisted-assemble.mjs";
import { runCodexAssistedLock } from "../scripts/generate-sectioned-codex-assisted-lock.mjs";
import { runCodexAssistedPrepare } from "../scripts/generate-sectioned-codex-assisted-prepare.mjs";
import { canonicalClone, REPO_ROOT } from "../scripts/kb-source.mjs";
import {
  assertNoRendererOutput,
  buildSampleContext,
  cleanupCodexAssistedTestRuns,
  createCodexAssistedRun,
  TEST_RUN_ROOT,
  writeJson,
} from "./helpers/codex-assisted-runs.mjs";

test.after(async () => {
  await cleanupCodexAssistedTestRuns();
});

test("sectioned provider mode defaults to codex_assisted and rejects unknown providers", () => {
  assert.equal(resolveGenerationProviderMode({}), "codex_assisted");
  assert.equal(
    resolveGenerationProviderMode({ SAFE_METHOD_GENERATION_PROVIDER: "openai" }),
    "openai",
  );
  assert.throws(
    () => resolveGenerationProviderMode({ SAFE_METHOD_GENERATION_PROVIDER: "made_up" }),
    /Unknown SAFE_METHOD_GENERATION_PROVIDER/u,
  );
});

test("provider credential gates are provider-specific", () => {
  assert.throws(() => assertProviderCredentialGate("anthropic", {}), /ANTHROPIC_API_KEY/u);
  assert.throws(
    () =>
      assertProviderCredentialGate("anthropic", {
        ANTHROPIC_API_KEY: "test-provider-key-redacted",
      }),
    /SAFE_METHOD_RUN_ANTHROPIC_GENERATION/u,
  );
  assert.doesNotThrow(() =>
    assertProviderCredentialGate("anthropic", {
      ANTHROPIC_API_KEY: "test-provider-key-redacted",
      SAFE_METHOD_RUN_ANTHROPIC_GENERATION: "1",
    }),
  );

  assert.throws(() => assertProviderCredentialGate("openai", {}), /OPENAI_API_KEY/u);
  assert.throws(
    () => assertProviderCredentialGate("openai", { OPENAI_API_KEY: "test-provider-key" }),
    /SAFE_METHOD_RUN_OPENAI_GENERATION/u,
  );
  assert.doesNotThrow(() =>
    assertProviderCredentialGate("openai", {
      OPENAI_API_KEY: "test-provider-key",
      SAFE_METHOD_RUN_OPENAI_GENERATION: "1",
    }),
  );

  assert.doesNotThrow(() => assertProviderCredentialGate("codex_assisted", {}));
});

test("OpenAI provider request uses Responses structured output format", () => {
  const schema = buildSectionOutputSchema("hrcw_register");
  const request = buildOpenAIResponsesRequest(
    {
      system: "system prompt",
      max_tokens: 1234,
      messages: [{ role: "user", content: "user prompt" }],
      output_config: {
        format: {
          schema,
        },
      },
    },
    "gpt-test",
  );

  assert.equal(request.model, "gpt-test");
  assert.equal(request.instructions, "system prompt");
  assert.equal(request.max_output_tokens, 1234);
  assert.equal(request.store, false);
  assert.equal(request.text.format.type, "json_schema");
  assert.equal(request.text.format.strict, true);
  assert.equal(request.text.format.name, "safe_method_hrcw_register");
  assert.deepEqual(request.text.format.schema, schema);
  assert.deepEqual(request.input[0].content[0], {
    type: "input_text",
    text: "user prompt",
  });
});

test("OpenAI-style structured response parses into the same section envelope contract", async () => {
  const { golden } = await buildSampleContext();
  const envelope = buildSectionEnvelopeFromDocumentSet("swms_matrix", golden);
  const openAiParsed = parseOpenAISectionResponse({
    status: "completed",
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: JSON.stringify(envelope),
          },
        ],
      },
    ],
  });
  const anthropicParsed = parseSectionProviderResponse({
    content: [
      {
        type: "text",
        text: JSON.stringify(envelope),
      },
    ],
  });

  assert.deepEqual(openAiParsed, envelope);
  assert.deepEqual(openAiParsed, anthropicParsed);
  assert.equal(validateSectionEnvelope(openAiParsed, "swms_matrix").status, "pass");
  assert.equal(validateSectionEnvelope(anthropicParsed, "swms_matrix").status, "pass");
});

test("OpenAI response failures fail closed with compact secret-safe errors", async () => {
  assert.throws(
    () =>
      parseOpenAISectionResponse({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      }),
    /max_output_tokens/u,
  );
  assert.throws(
    () =>
      parseOpenAISectionResponse({
        status: "completed",
        output: [{ content: [{ type: "refusal", refusal: "no" }] }],
      }),
    /refusal/u,
  );
  assert.throws(
    () =>
      parseOpenAISectionResponse({
        status: "completed",
        output_text: "{not json",
      }),
    /not valid JSON/u,
  );
  assert.equal(
    redactSecrets("bad test-provider-key-redacted test-provider-key-redacted"),
    "bad [redacted] [redacted]",
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    async text() {
      return "provider rejected test-provider-key-redacted";
    },
  });
  try {
    const provider = createOpenAIProvider({
      apiKey: "test-provider-key-redacted",
      model: "gpt-test",
    });
    assert.equal(provider.provider_contract_version, SECTIONED_PROVIDER_CONTRACT_VERSION);
    await assert.rejects(
      () =>
        provider.generate({
          request: {
            messages: [],
            output_config: {
              format: {
                schema: buildSectionOutputSchema("hrcw_register"),
              },
            },
          },
        }),
      (error) =>
        /OpenAI API 400/u.test(error.message) &&
        /\[redacted\]/u.test(error.message) &&
        !/test-provider-key-redacted/u.test(error.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Codex-assisted golden local sections assemble to the exact full document set", async () => {
  const context = await buildSampleContext();
  const run = await createCodexAssistedRun("golden-assembly", context);
  const provider = await createCodexAssistedSectionProvider({
    root: REPO_ROOT,
    runDirectory: run.runDirectory,
    runId: run.runId,
    ...context,
  });
  const result = await runSectionedGenerationPipeline({
    root: REPO_ROOT,
    brief: context.brief,
    normalisedBrief: context.normalisedBrief,
    retrievalPacket: context.retrievalPacket,
    provider,
    maxRetries: 0,
    maxAssemblyCorrections: 0,
  });

  assert.equal(result.status, "pass");
  assert.equal(result.provenance.model.provider, "codex_assisted");
  assert.equal(result.provenance.model.version, "codex-assisted:local-section-files");
  assert.equal(
    result.provenance.model.provider_contract_version,
    SECTIONED_PROVIDER_CONTRACT_VERSION,
  );
  for (const key of [
    "hrcw_register",
    "swms_matrix",
    "hold_point_schedule",
    "risk_register",
    "swms_benchmark_reviews",
  ]) {
    assert.deepEqual(result.documentSet[key], context.golden[key]);
  }
});

test("Codex-assisted manifest hash mismatch fails closed as stale", async () => {
  const context = await buildSampleContext();
  const run = await createCodexAssistedRun("stale-hash", context);
  const manifestPath = path.join(run.runDirectory, CODEX_ASSISTED_MANIFEST_FILE);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.sections.hrcw_register.sha256 = "bad-hash";
  await writeJson(manifestPath, manifest);

  await assert.rejects(
    () =>
      createCodexAssistedSectionProvider({
        root: REPO_ROOT,
        runDirectory: run.runDirectory,
        runId: run.runId,
        ...context,
      }),
    /stale.*hrcw_register/u,
  );
});

test("Codex-assisted context hash mismatch fails closed as stale", async () => {
  const context = await buildSampleContext();
  const run = await createCodexAssistedRun("stale-context-hash", context);
  const manifestPath = path.join(run.runDirectory, CODEX_ASSISTED_MANIFEST_FILE);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.normalised_brief_hash_sha256 = "bad-hash";
  await writeJson(manifestPath, manifest);

  await assert.rejects(
    () =>
      createCodexAssistedSectionProvider({
        root: REPO_ROOT,
        runDirectory: run.runDirectory,
        runId: run.runId,
        ...context,
      }),
    /normalised_brief_hash_sha256 mismatch/u,
  );
});

test("Codex-assisted expected section filenames mismatch fails closed as stale", async () => {
  const context = await buildSampleContext();
  const run = await createCodexAssistedRun("stale-expected-files", context);
  const manifestPath = path.join(run.runDirectory, CODEX_ASSISTED_MANIFEST_FILE);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.expected_section_filenames = manifest.expected_section_filenames.filter(
    (fileName) => fileName !== "support_bundle.json",
  );
  await writeJson(manifestPath, manifest);

  await assert.rejects(
    () =>
      createCodexAssistedSectionProvider({
        root: REPO_ROOT,
        runDirectory: run.runDirectory,
        runId: run.runId,
        ...context,
      }),
    /expected_section_filenames mismatch/u,
  );
});

test("Codex-assisted manifest with extra section entries fails closed as stale", async () => {
  const context = await buildSampleContext();
  const run = await createCodexAssistedRun("stale-section-list", context);
  const manifestPath = path.join(run.runDirectory, CODEX_ASSISTED_MANIFEST_FILE);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.sections.unexpected_section = {
    file_name: "unexpected_section.json",
    sha256: "0".repeat(64),
  };
  await writeJson(manifestPath, manifest);

  await assert.rejects(
    () =>
      createCodexAssistedSectionProvider({
        root: REPO_ROOT,
        runDirectory: run.runDirectory,
        runId: run.runId,
        ...context,
      }),
    /section list mismatch/u,
  );
});

test("Codex-assisted prepare and lock keep manifest state explicit", async () => {
  const context = await buildSampleContext();
  const preparedRunDirectory = path.join(TEST_RUN_ROOT, "prepare-command");
  const prepared = await runCodexAssistedPrepare({
    root: REPO_ROOT,
    runDirectory: preparedRunDirectory,
    runId: "prepare-command",
    ...context,
  });

  assert.equal(prepared.manifest.manifest_state, CODEX_ASSISTED_PREPARED_MANIFEST_STATE);
  for (const section of Object.values(prepared.manifest.sections)) {
    assert.equal(section.sha256, null);
  }
  await assert.rejects(
    () =>
      createCodexAssistedSectionProvider({
        root: REPO_ROOT,
        runDirectory: prepared.runDirectory,
        runId: "prepare-command",
        ...context,
      }),
    /must be locked/u,
  );

  const run = await createCodexAssistedRun("lock-command", context, {
    manifestState: CODEX_ASSISTED_PREPARED_MANIFEST_STATE,
  });
  const locked = await runCodexAssistedLock({
    root: REPO_ROOT,
    runDirectory: run.runDirectory,
    runId: run.runId,
    ...context,
  });

  assert.equal(locked.manifest.manifest_state, CODEX_ASSISTED_LOCKED_MANIFEST_STATE);
  assert.equal(locked.manifest.provider_contract_version, SECTIONED_PROVIDER_CONTRACT_VERSION);
  for (const section of Object.values(locked.manifest.sections)) {
    assert.match(section.sha256, /^[a-f0-9]{64}$/u);
  }
});

test("Codex-assisted missing section file fails closed", async () => {
  const context = await buildSampleContext();
  const run = await createCodexAssistedRun("missing-file", context);
  await unlink(path.join(run.runDirectory, "support_bundle.json"));

  await assert.rejects(
    () =>
      createCodexAssistedSectionProvider({
        root: REPO_ROOT,
        runDirectory: run.runDirectory,
        runId: run.runId,
        ...context,
      }),
    /support_bundle\.json/u,
  );
});

test("Codex-assisted malformed JSON fails closed without renderer output", async () => {
  const context = await buildSampleContext();
  const run = await createCodexAssistedRun("malformed-json", context, {
    overrides: {
      hrcw_register: "{not json",
    },
  });
  const outcome = await runCodexAssistedAssemble({
    root: REPO_ROOT,
    runDirectory: run.runDirectory,
    runId: run.runId,
    ...context,
  });

  assert.equal(outcome.status, "fail");
  assert.equal(outcome.result.validationReport.section_name, "hrcw_register");
  assert.match(outcome.result.validationReport.provider_error, /JSON/u);
  assertNoRendererOutput(run.runDirectory);
  assert.equal(existsSync(path.join(run.runDirectory, "evidence")), false);
});

test("Codex-assisted wrong section_name and schema-invalid sections fail closed", async () => {
  const context = await buildSampleContext();
  const wrongSectionRun = await createCodexAssistedRun("wrong-section", context, {
    overrides: {
      hrcw_register: {
        ...buildSectionEnvelopeFromDocumentSet("hrcw_register", context.golden),
        section_name: "swms_matrix",
      },
    },
  });
  const wrongSectionOutcome = await runCodexAssistedAssemble({
    root: REPO_ROOT,
    runDirectory: wrongSectionRun.runDirectory,
    runId: wrongSectionRun.runId,
    ...context,
  });

  assert.equal(wrongSectionOutcome.status, "fail");
  assert.equal(wrongSectionOutcome.result.validationReport.section_name, "hrcw_register");
  assert.match(wrongSectionOutcome.result.validationReport.schema.errors, /allowed value/u);

  const invalidEnvelope = canonicalClone(
    buildSectionEnvelopeFromDocumentSet("hrcw_register", context.golden),
  );
  delete invalidEnvelope.hrcw_register;
  const schemaInvalidRun = await createCodexAssistedRun("schema-invalid", context, {
    overrides: {
      hrcw_register: invalidEnvelope,
    },
  });
  const schemaInvalidOutcome = await runCodexAssistedAssemble({
    root: REPO_ROOT,
    runDirectory: schemaInvalidRun.runDirectory,
    runId: schemaInvalidRun.runId,
    ...context,
  });

  assert.equal(schemaInvalidOutcome.status, "fail");
  assert.match(schemaInvalidOutcome.result.validationReport.schema.errors, /hrcw_register/u);
});

test("Codex-assisted lock rejects schema-invalid local section files", async () => {
  const context = await buildSampleContext();
  const invalidEnvelope = canonicalClone(
    buildSectionEnvelopeFromDocumentSet("hrcw_register", context.golden),
  );
  delete invalidEnvelope.hrcw_register;
  const run = await createCodexAssistedRun("lock-schema-invalid", context, {
    manifestState: CODEX_ASSISTED_PREPARED_MANIFEST_STATE,
    overrides: {
      hrcw_register: invalidEnvelope,
    },
  });

  await assert.rejects(
    () =>
      runCodexAssistedLock({
        root: REPO_ROOT,
        runDirectory: run.runDirectory,
        runId: run.runId,
        ...context,
      }),
    /schema-invalid.*hrcw_register/u,
  );
});

test("Codex-assisted passing assembly writes only ignored DRAFT evidence", async () => {
  const context = await buildSampleContext();
  const run = await createCodexAssistedRun("draft-evidence", context);
  const outcome = await runCodexAssistedAssemble({
    root: REPO_ROOT,
    runDirectory: run.runDirectory,
    runId: run.runId,
    ...context,
  });

  assert.equal(outcome.status, "pass");
  assert.equal(
    existsSync(path.join(run.runDirectory, "evidence", "assembled-document-set.json")),
    true,
  );
  assert.equal(existsSync(path.join(run.runDirectory, "evidence", "validation-report.json")), true);
  assert.equal(
    existsSync(path.join(run.runDirectory, "evidence", "generation-provenance.json")),
    true,
  );
  assertNoRendererOutput(run.runDirectory);
});
