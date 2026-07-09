import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  actorHasWorkflowPermission,
  attemptIssue,
  createDraftWorkflowRecord,
  invalidateForContentChange,
  recordConsultantReview,
  verifyWorkflowProvenance,
} from "../app/workflow-state.mjs";
import {
  loadWorkflowRecord,
  persistWorkflowRecord,
  reconstructWorkflowRecordFromArtifacts,
} from "../app/workflow-store.mjs";
import { createAjvRegistry, formatAjvErrors } from "../scripts/schema-registry.mjs";

const DOCUMENT_SET_HASH = "a".repeat(64);
const NEXT_DOCUMENT_SET_HASH = "b".repeat(64);
const OUTPUT_HASH = "c".repeat(64);
const NEXT_OUTPUT_HASH = "d".repeat(64);
const MANIFEST_HASH = "e".repeat(64);
const CREATED_AT = "2026-07-09T00:00:00.000Z";
const REVIEWED_AT = "2026-07-09T01:00:00.000Z";
const ISSUED_AT = "2026-07-09T02:00:00.000Z";
const CHANGED_AT = "2026-07-09T03:00:00.000Z";
const WORKFLOW_OPERATOR = Object.freeze({
  id: "operator-1",
  roles: Object.freeze(["workflow_operator"]),
});
const CONSULTANT = Object.freeze({
  id: "consultant-1",
  roles: Object.freeze(["whs_consultant"]),
});
const ISSUE_CONTROLLER = Object.freeze({
  id: "issue-controller-1",
  roles: Object.freeze(["issue_controller"]),
});
const AUDITOR = Object.freeze({
  id: "auditor-1",
  roles: Object.freeze(["auditor"]),
});
const SYSTEM_ACTOR = Object.freeze({
  id: "system-1",
  roles: Object.freeze(["system_service"]),
});

test("draft workflow record validates against schema and provenance", () => {
  const record = buildDraftRecord();
  const validate = createAjvRegistry().getValidator("workflow-record.schema.json");

  assert.equal(validate(record), true, formatAjvErrors(validate.errors));
  assert.equal(record.workflow_state, "DRAFT");
  assert.equal(record.output.issue_ready, false);
  assert.equal(verifyWorkflowProvenance(record).status, "pass");
});

test("DRAFT cannot transition directly to ISSUED", () => {
  assert.throws(
    () =>
      attemptIssue(buildDraftRecord(), {
        actor: ISSUE_CONTROLLER,
        preflight: passingPreflight(),
        verifierStatuses: passingVerifierStatuses(),
        phaseGateStatuses: passingPhaseGateStatuses(),
        manifestPath: "outputs/issued/unitas/proj-ra-unitas.manifest.json",
        manifestHash: MANIFEST_HASH,
        issuedAt: ISSUED_AT,
      }),
    /Workflow state must be REVIEWED/u,
  );
});

test("workflow authorisation is explicit and role-scoped", () => {
  assert.throws(() => buildDraftRecord({ actor: undefined }), /requires an actor id and role/u);
  assert.equal(actorHasWorkflowPermission(CONSULTANT, "record_review"), true);
  assert.equal(actorHasWorkflowPermission(CONSULTANT, "issue"), false);

  assert.throws(
    () =>
      recordConsultantReview(buildDraftRecord(), {
        actor: WORKFLOW_OPERATOR,
        decision: "accepted_for_issue",
        reviewerName: "Pat Consultant",
        reviewerRole: "WHS Consultant",
        reviewedAt: REVIEWED_AT,
      }),
    /not authorised/u,
  );

  assert.throws(
    () =>
      attemptIssue(buildReviewedRecord(), {
        actor: CONSULTANT,
        preflight: passingPreflight(),
        verifierStatuses: passingVerifierStatuses(),
        phaseGateStatuses: passingPhaseGateStatuses(),
        manifestPath: "outputs/issued/unitas/proj-ra-unitas.manifest.json",
        manifestHash: MANIFEST_HASH,
        issuedAt: ISSUED_AT,
      }),
    /not authorised/u,
  );
});

test("failed validation blocks review and issue", () => {
  const draft = buildDraftRecord({ validationReport: failedValidationReport() });

  assert.throws(
    () =>
      recordConsultantReview(draft, {
        actor: CONSULTANT,
        decision: "accepted_for_issue",
        reviewerName: "Consultant",
        reviewerRole: "WHS Consultant",
        reviewedAt: REVIEWED_AT,
      }),
    /Validation must pass/u,
  );

  const reviewedWithFailure = {
    ...draft,
    workflow_state: "REVIEWED",
    review: acceptedReview(),
  };
  assert.throws(
    () =>
      attemptIssue(reviewedWithFailure, {
        actor: ISSUE_CONTROLLER,
        preflight: passingPreflight(),
        verifierStatuses: passingVerifierStatuses(),
        phaseGateStatuses: passingPhaseGateStatuses(),
        manifestPath: "outputs/issued/unitas/proj-ra-unitas.manifest.json",
        manifestHash: MANIFEST_HASH,
        issuedAt: ISSUED_AT,
      }),
    /Validation must pass/u,
  );
});

test("accepted consultant review creates REVIEWED record", () => {
  const reviewed = recordConsultantReview(buildDraftRecord(), {
    actor: CONSULTANT,
    decision: "accepted_for_issue",
    reviewerName: "Pat Consultant",
    reviewerRole: "WHS Consultant",
    reviewedAt: REVIEWED_AT,
    comments: "Accepted for issue subject to final preflight.",
  });

  assert.equal(reviewed.workflow_state, "REVIEWED");
  assert.equal(reviewed.review.state, "accepted_for_issue");
  assert.equal(reviewed.review.reviewer_role, "WHS Consultant");
  assert.equal(reviewed.output.issue_ready, false);
});

test("missing consultant sign-off blocks issue", () => {
  const reviewedWithoutSignoff = {
    ...buildDraftRecord(),
    workflow_state: "REVIEWED",
  };

  assert.throws(
    () =>
      attemptIssue(reviewedWithoutSignoff, {
        actor: ISSUE_CONTROLLER,
        preflight: passingPreflight(),
        verifierStatuses: passingVerifierStatuses(),
        phaseGateStatuses: passingPhaseGateStatuses(),
        manifestPath: "outputs/issued/unitas/proj-ra-unitas.manifest.json",
        manifestHash: MANIFEST_HASH,
        issuedAt: ISSUED_AT,
      }),
    /consultant acceptance/u,
  );
});

test("missing or failing verifier evidence blocks issue", () => {
  const reviewed = buildReviewedRecord();

  assert.throws(
    () =>
      attemptIssue(reviewed, {
        actor: ISSUE_CONTROLLER,
        preflight: passingPreflight(),
        phaseGateStatuses: passingPhaseGateStatuses(),
        manifestPath: "outputs/issued/unitas/proj-ra-unitas.manifest.json",
        manifestHash: MANIFEST_HASH,
        issuedAt: ISSUED_AT,
      }),
    /At least one required evidence entry/u,
  );

  assert.throws(
    () =>
      attemptIssue(reviewed, {
        actor: ISSUE_CONTROLLER,
        preflight: passingPreflight(),
        verifierStatuses: [{ id: "offline", status: "skip", required: true }],
        phaseGateStatuses: passingPhaseGateStatuses(),
        manifestPath: "outputs/issued/unitas/proj-ra-unitas.manifest.json",
        manifestHash: MANIFEST_HASH,
        issuedAt: ISSUED_AT,
      }),
    /must be pass/u,
  );
});

test("missing or failing phase-gate evidence blocks issue", () => {
  const reviewed = buildReviewedRecord();

  assert.throws(
    () =>
      attemptIssue(reviewed, {
        actor: ISSUE_CONTROLLER,
        preflight: passingPreflight(),
        verifierStatuses: passingVerifierStatuses(),
        manifestPath: "outputs/issued/unitas/proj-ra-unitas.manifest.json",
        manifestHash: MANIFEST_HASH,
        issuedAt: ISSUED_AT,
      }),
    /At least one required evidence entry/u,
  );

  assert.throws(
    () =>
      attemptIssue(reviewed, {
        actor: ISSUE_CONTROLLER,
        preflight: passingPreflight(),
        verifierStatuses: passingVerifierStatuses(),
        phaseGateStatuses: [{ id: "phase-6", status: "fail", required: true }],
        manifestPath: "outputs/issued/unitas/proj-ra-unitas.manifest.json",
        manifestHash: MANIFEST_HASH,
        issuedAt: ISSUED_AT,
      }),
    /must be pass/u,
  );
});

test("final preflight failure blocks issue", () => {
  assert.throws(
    () =>
      attemptIssue(buildReviewedRecord(), {
        actor: ISSUE_CONTROLLER,
        preflight: { status: "blocked", issue_ready: false },
        verifierStatuses: passingVerifierStatuses(),
        phaseGateStatuses: passingPhaseGateStatuses(),
        manifestPath: "outputs/issued/unitas/proj-ra-unitas.manifest.json",
        manifestHash: MANIFEST_HASH,
        issuedAt: ISSUED_AT,
      }),
    /final preflight/u,
  );
});

test("REVIEWED transitions to ISSUED only after preflight and evidence pass", () => {
  const issued = attemptIssue(buildReviewedRecord(), {
    actor: ISSUE_CONTROLLER,
    preflight: passingPreflight(),
    verifierStatuses: passingVerifierStatuses(),
    phaseGateStatuses: passingPhaseGateStatuses(),
    manifestPath: "outputs/issued/unitas/proj-ra-unitas.manifest.json",
    manifestHash: MANIFEST_HASH,
    issuedAt: ISSUED_AT,
  });

  assert.equal(issued.workflow_state, "ISSUED");
  assert.equal(issued.output.issue_ready, true);
  assert.equal(issued.output.manifest_hash, MANIFEST_HASH);
  assert.equal(verifyWorkflowProvenance(issued).status, "pass");
});

test("content changes invalidate sign-off and increment revision", () => {
  const reviewed = buildReviewedRecord();
  const invalidated = invalidateForContentChange(reviewed, {
    actor: WORKFLOW_OPERATOR,
    documentSetHash: NEXT_DOCUMENT_SET_HASH,
    sourceInput: { project_name: "Unitas", scope_revision: 2 },
    validationReport: passingValidationReport(NEXT_DOCUMENT_SET_HASH),
    output: {
      draft_available: true,
      output_hash: NEXT_OUTPUT_HASH,
    },
    changedAt: CHANGED_AT,
  });

  assert.equal(invalidated.revision, 2);
  assert.equal(invalidated.workflow_state, "DRAFT");
  assert.equal(invalidated.review.state, "not_reviewed");
  assert.equal(invalidated.output.issue_ready, false);
  assert.equal(invalidated.document_set_hash, NEXT_DOCUMENT_SET_HASH);
  assert.equal(verifyWorkflowProvenance(invalidated).status, "pass");
});

test("workflow records persist immutably and load with provenance verification", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "safe-method-workflow-store-"));
  try {
    const record = buildReviewedRecord();
    const persisted = await persistWorkflowRecord(record, {
      actor: SYSTEM_ACTOR,
      storeRoot: tempDir,
    });
    const loaded = await loadWorkflowRecord({
      actor: AUDITOR,
      storeRoot: tempDir,
      recordId: record.record_id,
      revision: record.revision,
    });

    assert.equal(persisted.record_hash, loaded.record_hash);
    assert.deepEqual(loaded.record, record);
    assert.equal(loaded.provenance.status, "pass");

    await assert.rejects(
      () =>
        persistWorkflowRecord(record, {
          actor: SYSTEM_ACTOR,
          storeRoot: tempDir,
        }),
      /immutable and cannot be overwritten/u,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("tampered persisted workflow records fail load", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "safe-method-workflow-tamper-"));
  try {
    const record = buildReviewedRecord();
    const persisted = await persistWorkflowRecord(record, {
      actor: SYSTEM_ACTOR,
      storeRoot: tempDir,
    });
    const tampered = {
      ...record,
      source_input: {
        ...record.source_input,
        project_name: "Tampered Project",
      },
    };
    await writeFile(persisted.record_path, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");

    await assert.rejects(
      () =>
        loadWorkflowRecord({
          actor: AUDITOR,
          storeRoot: tempDir,
          recordId: record.record_id,
          revision: record.revision,
        }),
      /provenance hashes do not verify/u,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("workflow reconstruction verifies stored source, validation, output and manifest artifacts", () => {
  const issued = attemptIssue(buildReviewedRecord(), {
    actor: ISSUE_CONTROLLER,
    preflight: passingPreflight(),
    verifierStatuses: passingVerifierStatuses(),
    phaseGateStatuses: passingPhaseGateStatuses(),
    manifestPath: "outputs/issued/unitas/proj-ra-unitas.manifest.json",
    manifestHash: MANIFEST_HASH,
    issuedAt: ISSUED_AT,
  });
  const reconstruction = reconstructWorkflowRecordFromArtifacts(
    issued,
    {
      sourceInput: issued.source_input,
      validationReport: issued.validation_report,
      outputHash: issued.output.output_hash,
      manifestHash: issued.output.manifest_hash,
    },
    { actor: AUDITOR },
  );

  assert.equal(reconstruction.status, "pass");
  assert.equal(reconstruction.workflow_state, "ISSUED");

  const failed = reconstructWorkflowRecordFromArtifacts(
    issued,
    {
      sourceInput: issued.source_input,
      validationReport: {
        ...issued.validation_report,
        status: "fail",
      },
      outputHash: issued.output.output_hash,
      manifestHash: issued.output.manifest_hash,
    },
    { actor: AUDITOR },
  );
  assert.equal(failed.status, "fail");
  assert.ok(
    failed.results.some(
      (result) => result.rule_id === "WORKFLOW-RECONSTRUCTION-003" && result.status === "fail",
    ),
  );
});

test("provenance tampering is detected", () => {
  const record = buildDraftRecord();
  const tampered = {
    ...record,
    source_input: {
      ...record.source_input,
      project_name: "Tampered Project",
    },
  };

  const report = verifyWorkflowProvenance(tampered);
  assert.equal(report.status, "fail");
  assert.ok(
    report.results.some(
      (result) => result.rule_id === "WORKFLOW-PROVENANCE-001" && result.status === "fail",
    ),
  );
});

function buildDraftRecord(overrides = {}) {
  return createDraftWorkflowRecord({
    actor: WORKFLOW_OPERATOR,
    recordId: "wf-unitas-001",
    documentSetHash: DOCUMENT_SET_HASH,
    sourceInput: { project_name: "Unitas", scope_revision: 1 },
    versions: {
      kb_version: "kb-2026-06-24",
      schema_version: "schemas-2026-07-09",
      prompt_version: "prompt-v1",
      model_version: "fixture",
    },
    generation: {
      request_id: "generation-fixture-001",
      model: "fixture",
      generated_at: CREATED_AT,
      attempt_count: 1,
    },
    validationReport: passingValidationReport(DOCUMENT_SET_HASH),
    output: {
      draft_available: true,
      output_hash: OUTPUT_HASH,
    },
    createdAt: CREATED_AT,
    ...overrides,
  });
}

function buildReviewedRecord() {
  return recordConsultantReview(buildDraftRecord(), {
    actor: CONSULTANT,
    decision: "accepted_for_issue",
    reviewerName: "Pat Consultant",
    reviewerRole: "WHS Consultant",
    reviewedAt: REVIEWED_AT,
  });
}

function passingValidationReport(documentSetHash = DOCUMENT_SET_HASH) {
  return {
    schema_version: "validation-report.v1",
    document_set_hash: documentSetHash,
    validated_at: CREATED_AT,
    status: "pass",
    results: [],
    verdict: {
      rating: "Benchmark Quality Confirmed",
    },
  };
}

function failedValidationReport() {
  return {
    ...passingValidationReport(),
    status: "fail",
    results: [
      {
        rule_id: "CONTENT-001",
        suite: "content",
        status: "fail",
        severity: "error",
        message: "Subcontractor SWMS approval wording is not allowed.",
      },
    ],
    verdict: {
      rating: "Below Strong Working Draft",
      dominant_defect: "Subcontractor SWMS approval wording.",
    },
  };
}

function acceptedReview() {
  return {
    state: "accepted_for_issue",
    reviewer_name: "Pat Consultant",
    reviewer_role: "WHS Consultant",
    reviewed_at: REVIEWED_AT,
  };
}

function passingPreflight() {
  return {
    status: "pass",
    issue_ready: true,
  };
}

function passingVerifierStatuses() {
  return [{ id: "verify-offline", status: "pass", required: true }];
}

function passingPhaseGateStatuses() {
  return [{ id: "phase-6", status: "pass", required: true }];
}
