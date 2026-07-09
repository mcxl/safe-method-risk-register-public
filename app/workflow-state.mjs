import { canonicalClone, sha256Canonical } from "../scripts/kb-source.mjs";

export const WORKFLOW_STATE_VERSION = "phase6.workflow-state.v1";
export const WORKFLOW_ROLE_PERMISSIONS = Object.freeze({
  create_draft: Object.freeze(["workflow_operator", "system_service"]),
  record_review: Object.freeze(["whs_consultant"]),
  issue: Object.freeze(["issue_controller"]),
  invalidate_content: Object.freeze(["workflow_operator", "system_service"]),
  persist_record: Object.freeze(["workflow_operator", "system_service"]),
  load_record: Object.freeze([
    "workflow_operator",
    "whs_consultant",
    "issue_controller",
    "auditor",
    "system_service",
  ]),
  reconstruct_record: Object.freeze([
    "workflow_operator",
    "issue_controller",
    "auditor",
    "system_service",
  ]),
});

export class WorkflowTransitionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkflowTransitionError";
    this.code = code;
  }
}

export function assertWorkflowPermission(actor, action) {
  const allowedRoles = WORKFLOW_ROLE_PERMISSIONS[action];
  if (!allowedRoles) {
    throw new WorkflowTransitionError(
      "AUTH_UNKNOWN_ACTION",
      `Unknown workflow action '${action}'.`,
    );
  }

  const actorId = cleanString(actor?.id);
  const roles = normaliseActorRoles(actor);
  if (!actorId || roles.length === 0) {
    throw new WorkflowTransitionError(
      "AUTH_REQUIRED",
      `Workflow action '${action}' requires an actor id and role.`,
    );
  }

  if (!roles.some((role) => allowedRoles.includes(role))) {
    throw new WorkflowTransitionError(
      "AUTH_FORBIDDEN",
      `Actor '${actorId}' is not authorised for workflow action '${action}'.`,
    );
  }

  return {
    actor_id: actorId,
    roles,
    action,
  };
}

export function actorHasWorkflowPermission(actor, action) {
  try {
    assertWorkflowPermission(actor, action);
    return true;
  } catch (error) {
    if (error instanceof WorkflowTransitionError) {
      return false;
    }
    throw error;
  }
}

export function createDraftWorkflowRecord(options = {}) {
  assertWorkflowPermission(options.actor, "create_draft");
  const validationReport = requireObject(options.validationReport, "validationReport");
  const documentSetHash = resolveDocumentSetHash(options, validationReport);
  assertValidationReportMatchesDocumentSet(validationReport, documentSetHash);

  const output = normaliseOutput(options.output);
  return {
    record_id: requireString(options.recordId, "recordId"),
    document_set_hash: documentSetHash,
    revision: normaliseRevision(options.revision ?? 1),
    workflow_state: "DRAFT",
    source_input: canonicalClone(requireObject(options.sourceInput, "sourceInput")),
    versions: canonicalClone(requireObject(options.versions, "versions")),
    generation: canonicalClone(requireObject(options.generation, "generation")),
    validation_report: canonicalClone(validationReport),
    review: {
      state: "not_reviewed",
    },
    output: {
      draft_available: output.draft_available,
      issue_ready: false,
      output_hash: output.output_hash,
      ...optionalManifestEvidence(output),
    },
    provenance_hashes: buildProvenanceHashes(
      options.sourceInput,
      validationReport,
      output.output_hash,
    ),
    created_at: requireString(options.createdAt, "createdAt"),
    updated_at: requireString(options.updatedAt ?? options.createdAt, "updatedAt"),
  };
}

export function recordConsultantReview(record, options = {}) {
  assertWorkflowPermission(options.actor, "record_review");
  assertState(record, "DRAFT", "REVIEW_REQUIRES_DRAFT");
  assertValidationPassed(record.validation_report, "REVIEW_REQUIRES_VALIDATION_PASS");

  const decision = normaliseReviewDecision(options.decision);
  const reviewerName = requireString(options.reviewerName, "reviewerName");
  const reviewerRole = requireString(options.reviewerRole, "reviewerRole");
  const reviewedAt = requireString(options.reviewedAt, "reviewedAt");
  const next = cloneRecord(record);

  next.workflow_state = decision === "accepted_for_issue" ? "REVIEWED" : "DRAFT";
  next.review = {
    state: decision,
    reviewer_name: reviewerName,
    reviewer_role: reviewerRole,
    reviewed_at: reviewedAt,
    ...(cleanString(options.comments) ? { comments: cleanString(options.comments) } : {}),
  };
  next.output = {
    ...next.output,
    issue_ready: false,
  };
  next.updated_at = reviewedAt;

  return next;
}

export function attemptIssue(record, options = {}) {
  assertWorkflowPermission(options.actor, "issue");
  assertState(record, "REVIEWED", "ISSUE_REQUIRES_REVIEWED");
  assertValidationPassed(record.validation_report, "ISSUE_REQUIRES_VALIDATION_PASS");
  assertAcceptedReview(record.review);
  assertFinalPreflightPassed(options.preflight);

  const verifierStatuses = extractStatusEvidence(options, "verifierStatuses", "verifier_status");
  const phaseGateStatuses = extractStatusEvidence(
    options,
    "phaseGateStatuses",
    "phase_gate_status",
  );
  assertRequiredStatusesPass(verifierStatuses, "ISSUE_REQUIRES_VERIFIER_PASS");
  assertRequiredStatusesPass(phaseGateStatuses, "ISSUE_REQUIRES_PHASE_GATE_PASS");

  const manifestPath =
    cleanString(options.manifestPath) || cleanString(record.output?.manifest_path);
  const manifestHash =
    cleanString(options.manifestHash) || cleanString(record.output?.manifest_hash);
  if (!manifestPath || !isSha256Hex(manifestHash)) {
    throw new WorkflowTransitionError(
      "ISSUE_REQUIRES_MANIFEST_EVIDENCE",
      "Issue requires persisted handoff manifest path and SHA-256 hash evidence.",
    );
  }

  const issuedAt = requireString(options.issuedAt, "issuedAt");
  const next = cloneRecord(record);
  next.workflow_state = "ISSUED";
  next.output = {
    ...next.output,
    issue_ready: true,
    manifest_path: manifestPath,
    manifest_hash: manifestHash,
  };
  next.provenance_hashes = buildProvenanceHashes(
    next.source_input,
    next.validation_report,
    next.output.output_hash,
  );
  next.updated_at = issuedAt;

  return next;
}

export function invalidateForContentChange(record, options = {}) {
  assertWorkflowPermission(options.actor, "invalidate_content");
  const changedAt = requireString(options.changedAt, "changedAt");
  const validationReport = requireObject(options.validationReport, "validationReport");
  const documentSetHash = resolveDocumentSetHash(options, validationReport);
  assertValidationReportMatchesDocumentSet(validationReport, documentSetHash);

  if (documentSetHash === record.document_set_hash) {
    throw new WorkflowTransitionError(
      "CONTENT_CHANGE_REQUIRES_NEW_HASH",
      "Content-change invalidation requires a new document-set hash.",
    );
  }

  const sourceInput = options.sourceInput ?? record.source_input;
  const output = normaliseOutput(options.output);
  const next = cloneRecord(record);

  next.document_set_hash = documentSetHash;
  next.revision = normaliseRevision(record.revision + 1);
  next.workflow_state = "DRAFT";
  next.source_input = canonicalClone(sourceInput);
  next.generation = canonicalClone(options.generation ?? record.generation);
  next.validation_report = canonicalClone(validationReport);
  next.review = {
    state: "not_reviewed",
  };
  next.output = {
    draft_available: output.draft_available,
    issue_ready: false,
    output_hash: output.output_hash,
    ...optionalManifestEvidence(output),
  };
  next.provenance_hashes = buildProvenanceHashes(sourceInput, validationReport, output.output_hash);
  next.updated_at = changedAt;

  return next;
}

export function verifyWorkflowProvenance(record) {
  const results = [];
  addProvenanceResult(
    results,
    "WORKFLOW-PROVENANCE-001",
    sha256Canonical(record.source_input) === record.provenance_hashes?.source_input_hash,
    "source_input hash matches provenance_hashes.source_input_hash.",
  );
  addProvenanceResult(
    results,
    "WORKFLOW-PROVENANCE-002",
    sha256Canonical(record.validation_report) === record.provenance_hashes?.validation_report_hash,
    "validation_report hash matches provenance_hashes.validation_report_hash.",
  );
  addProvenanceResult(
    results,
    "WORKFLOW-PROVENANCE-003",
    record.output?.output_hash === record.provenance_hashes?.output_hash,
    "output.output_hash matches provenance_hashes.output_hash.",
  );
  addProvenanceResult(
    results,
    "WORKFLOW-PROVENANCE-004",
    record.document_set_hash === record.validation_report?.document_set_hash,
    "document_set_hash matches validation_report.document_set_hash.",
  );
  addProvenanceResult(
    results,
    "WORKFLOW-PROVENANCE-005",
    record.workflow_state !== "ISSUED" || record.output?.issue_ready === true,
    "ISSUED records carry output.issue_ready=true.",
  );

  return {
    status: results.every((result) => result.status === "pass") ? "pass" : "fail",
    results,
  };
}

function buildProvenanceHashes(sourceInput, validationReport, outputHash) {
  return {
    source_input_hash: sha256Canonical(sourceInput),
    validation_report_hash: sha256Canonical(validationReport),
    output_hash: requireSha256Hex(outputHash, "output.output_hash"),
  };
}

function resolveDocumentSetHash(options, validationReport) {
  if (options.documentSet) {
    return sha256Canonical(options.documentSet);
  }

  return requireSha256Hex(
    options.documentSetHash ?? validationReport.document_set_hash,
    "documentSetHash",
  );
}

function assertValidationReportMatchesDocumentSet(validationReport, documentSetHash) {
  if (validationReport.document_set_hash !== documentSetHash) {
    throw new WorkflowTransitionError(
      "VALIDATION_REPORT_HASH_MISMATCH",
      "Validation report document_set_hash must match the workflow document_set_hash.",
    );
  }
}

function assertValidationPassed(validationReport, code) {
  if (validationReport?.status !== "pass") {
    throw new WorkflowTransitionError(
      code,
      "Validation must pass before this workflow transition is allowed.",
    );
  }
}

function assertAcceptedReview(review) {
  const accepted =
    review?.state === "accepted_for_issue" &&
    cleanString(review.reviewer_name) &&
    cleanString(review.reviewer_role) &&
    cleanString(review.reviewed_at);

  if (!accepted) {
    throw new WorkflowTransitionError(
      "ISSUE_REQUIRES_CONSULTANT_SIGNOFF",
      "Issue requires consultant acceptance with reviewer identity, role and timestamp.",
    );
  }
}

function assertFinalPreflightPassed(preflight) {
  const report = preflight?.preflight ?? preflight;
  const issueReady = preflight?.issue_ready ?? report?.issue_ready;
  if (report?.status !== "pass" || issueReady !== true) {
    throw new WorkflowTransitionError(
      "ISSUE_REQUIRES_FINAL_PREFLIGHT_PASS",
      "Issue requires final preflight status=pass and issue_ready=true.",
    );
  }
}

function assertRequiredStatusesPass(entries, code) {
  if (entries.length === 0) {
    throw new WorkflowTransitionError(
      code,
      "At least one required evidence entry must be supplied.",
    );
  }

  const failing = entries.find((entry) => entry.required !== false && entry.status !== "pass");
  if (failing) {
    throw new WorkflowTransitionError(
      code,
      `Required evidence '${failing.id ?? failing.name ?? "unnamed"}' must be pass.`,
    );
  }
}

function extractStatusEvidence(options, optionKey, manifestKey) {
  const supplied = options[optionKey] ?? options.preflight?.[manifestKey] ?? [];
  if (!Array.isArray(supplied)) {
    throw new WorkflowTransitionError(
      "INVALID_STATUS_EVIDENCE",
      `${optionKey} must be an array when supplied.`,
    );
  }
  return supplied.map((entry) => ({
    id: cleanString(entry.id) || cleanString(entry.name) || "unnamed",
    name: cleanString(entry.name) || cleanString(entry.id) || "Unnamed",
    status: cleanString(entry.status),
    required: entry.required !== false,
  }));
}

function assertState(record, expectedState, code) {
  if (record?.workflow_state !== expectedState) {
    throw new WorkflowTransitionError(
      code,
      `Workflow state must be ${expectedState}; received ${record?.workflow_state ?? "missing"}.`,
    );
  }
}

function normaliseOutput(output = {}) {
  return {
    draft_available: output.draft_available === true,
    issue_ready: false,
    output_hash: requireSha256Hex(output.output_hash, "output.output_hash"),
    ...optionalManifestEvidence(output),
  };
}

function optionalManifestEvidence(output) {
  const evidence = {};
  const manifestPath = cleanString(output.manifest_path);
  const manifestHash = cleanString(output.manifest_hash);
  if (manifestPath) {
    evidence.manifest_path = manifestPath;
  }
  if (manifestHash) {
    evidence.manifest_hash = requireSha256Hex(manifestHash, "output.manifest_hash");
  }
  return evidence;
}

function normaliseRevision(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new WorkflowTransitionError("INVALID_REVISION", "revision must be an integer >= 1.");
  }
  return value;
}

function normaliseReviewDecision(decision) {
  if (decision === "accepted_for_issue" || decision === "changes_required") {
    return decision;
  }
  throw new WorkflowTransitionError(
    "INVALID_REVIEW_DECISION",
    "review decision must be accepted_for_issue or changes_required.",
  );
}

function normaliseActorRoles(actor) {
  if (!Array.isArray(actor?.roles)) {
    return [];
  }

  return actor.roles.map((role) => cleanString(role)).filter(Boolean);
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkflowTransitionError("MISSING_REQUIRED_VALUE", `${label} must be an object.`);
  }
  return value;
}

function requireString(value, label) {
  const text = cleanString(value);
  if (!text) {
    throw new WorkflowTransitionError("MISSING_REQUIRED_VALUE", `${label} is required.`);
  }
  return text;
}

function requireSha256Hex(value, label) {
  const text = requireString(value, label);
  if (!isSha256Hex(text)) {
    throw new WorkflowTransitionError("INVALID_HASH", `${label} must be a SHA-256 hex string.`);
  }
  return text.toLowerCase();
}

function isSha256Hex(value) {
  return /^[a-f0-9]{64}$/iu.test(String(value ?? ""));
}

function cleanString(value) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

function cloneRecord(record) {
  return canonicalClone(requireObject(record, "record"));
}

function addProvenanceResult(results, ruleId, passed, message) {
  results.push({
    rule_id: ruleId,
    status: passed ? "pass" : "fail",
    severity: passed ? "info" : "error",
    message,
  });
}
