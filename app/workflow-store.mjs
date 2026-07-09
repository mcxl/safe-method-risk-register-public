import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { canonicalClone, sha256Canonical } from "../scripts/kb-source.mjs";
import { createAjvRegistry, formatAjvErrors } from "../scripts/schema-registry.mjs";
import {
  assertWorkflowPermission,
  verifyWorkflowProvenance,
  WorkflowTransitionError,
} from "./workflow-state.mjs";

export const WORKFLOW_STORE_VERSION = "phase6.workflow-store.v1";

export async function persistWorkflowRecord(record, options = {}) {
  assertWorkflowPermission(options.actor, "persist_record");
  assertTrustedWorkflowRecord(record);

  const recordPath = workflowRecordPath({
    storeRoot: options.storeRoot,
    recordId: record.record_id,
    revision: record.revision,
  });
  await mkdir(path.dirname(recordPath), { recursive: true });

  try {
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new WorkflowTransitionError(
        "WORKFLOW_RECORD_ALREADY_EXISTS",
        "Persisted workflow records are immutable and cannot be overwritten.",
      );
    }
    throw error;
  }

  return {
    store_version: WORKFLOW_STORE_VERSION,
    record_id: record.record_id,
    revision: record.revision,
    record_path: recordPath,
    record_hash: sha256Canonical(record),
  };
}

export async function loadWorkflowRecord(options = {}) {
  assertWorkflowPermission(options.actor, "load_record");
  const recordPath = workflowRecordPath(options);
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  const provenance = assertTrustedWorkflowRecord(record);

  return {
    store_version: WORKFLOW_STORE_VERSION,
    record_path: recordPath,
    record_hash: sha256Canonical(record),
    provenance,
    record,
  };
}

export function reconstructWorkflowRecordFromArtifacts(record, artifacts = {}, options = {}) {
  assertWorkflowPermission(options.actor, "reconstruct_record");
  const provenance = verifyWorkflowProvenance(record);
  const results = [
    {
      rule_id: "WORKFLOW-RECONSTRUCTION-001",
      status: provenance.status,
      severity: provenance.status === "pass" ? "info" : "error",
      message: "Stored workflow record provenance verifies before reconstruction.",
    },
    buildArtifactResult(
      "WORKFLOW-RECONSTRUCTION-002",
      artifactHashMatches(artifacts.sourceInput, record.provenance_hashes?.source_input_hash),
      "Stored source input reconstructs the workflow source_input_hash.",
    ),
    buildArtifactResult(
      "WORKFLOW-RECONSTRUCTION-003",
      artifactHashMatches(
        artifacts.validationReport,
        record.provenance_hashes?.validation_report_hash,
      ),
      "Stored validation report reconstructs the workflow validation_report_hash.",
    ),
    buildArtifactResult(
      "WORKFLOW-RECONSTRUCTION-004",
      artifacts.outputHash === record.output?.output_hash,
      "Stored output hash matches the workflow output hash.",
    ),
  ];

  if (record.output?.manifest_hash) {
    results.push(
      buildArtifactResult(
        "WORKFLOW-RECONSTRUCTION-005",
        artifacts.manifestHash === record.output.manifest_hash,
        "Stored handoff manifest hash matches the workflow manifest hash.",
      ),
    );
  }

  return {
    status: results.every((result) => result.status === "pass") ? "pass" : "fail",
    record_id: record.record_id,
    revision: record.revision,
    workflow_state: record.workflow_state,
    document_set_hash: record.document_set_hash,
    results,
    reconstructed: {
      source_input: canonicalClone(artifacts.sourceInput),
      validation_report: canonicalClone(artifacts.validationReport),
      output_hash: artifacts.outputHash,
      manifest_hash: artifacts.manifestHash ?? null,
    },
  };
}

export function assertTrustedWorkflowRecord(record) {
  const validate = createAjvRegistry().getValidator("workflow-record.schema.json");
  if (!validate(record)) {
    throw new WorkflowTransitionError(
      "WORKFLOW_RECORD_SCHEMA_INVALID",
      formatAjvErrors(validate.errors),
    );
  }

  const provenance = verifyWorkflowProvenance(record);
  if (provenance.status !== "pass") {
    throw new WorkflowTransitionError(
      "WORKFLOW_RECORD_PROVENANCE_INVALID",
      "Workflow record provenance hashes do not verify.",
    );
  }

  return provenance;
}

export function workflowRecordPath(options = {}) {
  const storeRoot = requireStoreRoot(options.storeRoot);
  const recordId = safePathSegment(options.recordId, "recordId");
  const revision = normaliseRevision(options.revision);
  return path.join(storeRoot, recordId, `rev-${revision}.workflow-record.json`);
}

function buildArtifactResult(ruleId, passed, message) {
  return {
    rule_id: ruleId,
    status: passed ? "pass" : "fail",
    severity: passed ? "info" : "error",
    message,
  };
}

function artifactHashMatches(value, expectedHash) {
  if (value === undefined || !expectedHash) {
    return false;
  }
  return sha256Canonical(value) === expectedHash;
}

function requireStoreRoot(storeRoot) {
  if (!storeRoot || typeof storeRoot !== "string") {
    throw new WorkflowTransitionError("WORKFLOW_STORE_ROOT_REQUIRED", "storeRoot is required.");
  }
  return path.resolve(storeRoot);
}

function safePathSegment(value, label) {
  const text = String(value ?? "").trim();
  if (!/^[A-Za-z0-9._-]+$/u.test(text)) {
    throw new WorkflowTransitionError(
      "WORKFLOW_STORE_UNSAFE_PATH",
      `${label} must contain only letters, numbers, dots, underscores or hyphens.`,
    );
  }
  return text;
}

function normaliseRevision(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new WorkflowTransitionError("INVALID_REVISION", "revision must be an integer >= 1.");
  }
  return value;
}
