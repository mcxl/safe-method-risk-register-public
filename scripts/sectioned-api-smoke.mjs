import assert from "node:assert/strict";

import {
  RISK_REGISTER_CHUNK_SECTIONS,
  runSectionedGenerationPipeline,
} from "../generate/sectioned-pipeline.mjs";

export const SAMPLE_BRIEF = "fixtures/golden/briefs/sample-project-brief.json";

export async function runSectionedApiSmoke({ label, provider }) {
  const result = await runSectionedGenerationPipeline({
    briefPath: SAMPLE_BRIEF,
    provider: createLoggingProvider(provider),
    maxRetries: 1,
    sectionMaxRetries: Object.fromEntries(
      RISK_REGISTER_CHUNK_SECTIONS.map((sectionName) => [sectionName, 2]),
    ),
  });

  if (result.status !== "pass") {
    console.error(`FAIL ${label}: live sectioned generation did not pass.`);
    console.error(JSON.stringify(buildFailureEvidence(result), null, 2));
    return { status: "fail", exitCode: 1, result };
  }

  assert.equal(result.status, "pass", "status should be pass");
  assert.equal(result.validationReport?.status, "pass", "validationReport.status should be pass");
  assert.equal(result.validationReport?.schema?.status, "pass", "schema.status should be pass");
  assert.equal(result.validationReport?.rules?.status, "pass", "rules.status should be pass");
  assert.equal(result.provenance?.workflow_state, "DRAFT", "workflow_state should be DRAFT");
  assert.equal(
    result.provenance?.generation_mode,
    "sectioned",
    "generation_mode should be sectioned",
  );
  assert.equal(
    result.provenance?.issue_gate?.issue_ready,
    false,
    "issue_gate.issue_ready should be false",
  );

  console.log(`PASS ${label} (full validators passed): ${result.provenance.output_hash_sha256}`);
  console.log(`PASS live smoke status: ${formatPassStatus(result)}`);
  console.log("PASS live smoke produced no renderer output and no issue-ready output.");
  return { status: "pass", exitCode: 0, result };
}

export function createLoggingProvider(provider) {
  return {
    ...provider,
    async generate(call) {
      const startedAt = Date.now();
      const attemptLabel = call.correctionRound
        ? `correction ${call.correctionRound}`
        : `attempt ${call.attemptNumber}`;
      console.log(`START ${call.sectionName} ${attemptLabel}`);
      try {
        const response = await provider.generate(call);
        console.log(`DONE ${call.sectionName} ${attemptLabel} ${Date.now() - startedAt}ms`);
        return response;
      } catch (error) {
        console.log(`FAIL ${call.sectionName} ${attemptLabel} ${Date.now() - startedAt}ms`);
        throw error;
      }
    },
  };
}

function formatPassStatus(result) {
  return [
    `status=${result.status}`,
    result.provenance?.workflow_state ? `workflow_state=${result.provenance.workflow_state}` : null,
    result.provenance?.generation_mode
      ? `generation_mode=${result.provenance.generation_mode}`
      : null,
    result.provenance?.issue_gate?.issue_ready !== undefined
      ? `issue_ready=${result.provenance.issue_gate.issue_ready}`
      : null,
  ]
    .filter(Boolean)
    .join(" ");
}

function buildFailureEvidence(result) {
  return compactObject({
    status: result.status,
    issue_ready_blocked: result.issue_ready_blocked,
    validationReport: compactValidationReport(result.validationReport),
    assemblyAttempts: compactAttempts(result.assemblyAttempts),
    correctionAttempts: compactAttempts(result.correctionAttempts, {
      includeTargetedFailures: true,
    }),
    lastFailed: compactLastFailedAttempt(result),
  });
}

function compactAttempts(attempts, options = {}) {
  if (!Array.isArray(attempts) || attempts.length === 0) {
    return undefined;
  }

  return attempts.map((attempt) =>
    compactObject({
      section_name: attempt.section_name,
      attempt: attempt.attempt,
      correction_round: attempt.correction_round,
      status: attempt.status,
      validation_report: compactValidationReport(attempt.validation_report),
      targeted_failures: options.includeTargetedFailures
        ? compactFailures(attempt.targeted_failures)
        : undefined,
    }),
  );
}

function compactLastFailedAttempt(result) {
  const attempts = Array.isArray(result.attempts)
    ? result.attempts
    : [
        ...(Array.isArray(result.sectionAttempts) ? result.sectionAttempts : []),
        ...(Array.isArray(result.assemblyAttempts) ? result.assemblyAttempts : []),
        ...(Array.isArray(result.correctionAttempts) ? result.correctionAttempts : []),
      ];
  const attempt = attempts.findLast(
    (candidate) => candidate?.status === "fail" || candidate?.validation_report?.status === "fail",
  );
  const report = attempt?.validation_report ?? result.validationReport;

  if (!attempt && !report) {
    return undefined;
  }

  return compactObject({
    section_name: report?.section_name ?? attempt?.section_name,
    attempt: attempt?.attempt,
    correction_round: attempt?.correction_round,
    status: attempt?.status ?? report?.status,
    provider_error: report?.provider_error,
    schema_errors: report?.schema?.errors || undefined,
  });
}

function compactValidationReport(report) {
  if (!report) {
    return undefined;
  }

  return compactObject({
    status: report.status,
    section_name: report.section_name,
    provider_error: report.provider_error,
    schema: compactObject({
      status: report.schema?.status,
      schema_id: report.schema?.schema_id,
      errors: report.schema?.errors || undefined,
    }),
    rules: report.rules
      ? compactObject({
          status: report.rules.status,
          verdict: report.rules.verdict,
          results: compactFailures(report.rules.results),
        })
      : undefined,
  });
}

function compactFailures(failures) {
  if (!Array.isArray(failures) || failures.length === 0) {
    return undefined;
  }

  return failures.map((failure) => compactFailure(failure));
}

function compactFailure(failure) {
  if (!failure || typeof failure !== "object") {
    return failure;
  }

  return compactObject({
    rule_id: failure.rule_id,
    suite: failure.suite,
    status: failure.status,
    severity: failure.severity,
    message: failure.message,
    json_path: failure.json_path,
    criterion_number: failure.criterion_number,
    dominant_defect: failure.dominant_defect,
  });
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, entry]) =>
        entry !== undefined &&
        (!Array.isArray(entry) || entry.length > 0) &&
        (!isPlainObject(entry) || Object.keys(entry).length > 0),
    ),
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
