import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildOutputFileName } from "../app/handoff-manifest.mjs";
import { RenderValidationError, renderDraftDocx } from "../render/docx-renderer.mjs";
import { assertPhase5aDocx } from "../render/ooxml-assertions.mjs";
import { canonicalClone, readJson, REPO_ROOT } from "../scripts/kb-source.mjs";

const UNITAS_DOCUMENT_SET = "fixtures/golden/document-sets/unitas-document-set.json";

test("Phase 5A renders a validated golden document-set as DRAFT DOCX", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "safe-method-docx-"));
  try {
    const documentSet = await readJson(REPO_ROOT, UNITAS_DOCUMENT_SET);
    const outputFileName = buildOutputFileName(documentSet, { mode: "draft" });
    const outputPath = path.join(tempDir, outputFileName);
    const renderResult = await renderDraftDocx(documentSet, outputPath, {
      filename: outputFileName,
    });

    assert.equal(renderResult.workflow_state, "DRAFT");
    assert.equal(renderResult.issue_ready, false);
    assert.equal(renderResult.filename, "proj-ra-unitas-rev04-draft-whs-control-document-set.docx");
    assert.match(renderResult.output_hash_sha256, /^[a-f0-9]{64}$/u);
    assert.equal(existsSync(outputPath), true);

    const assertionReport = await assertPhase5aDocx(outputPath, documentSet);
    assert.equal(assertionReport.status, "pass");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Phase 5A blocks schema-invalid document-sets before writing DOCX", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "safe-method-docx-invalid-"));
  try {
    const documentSet = await readJson(REPO_ROOT, UNITAS_DOCUMENT_SET);
    const invalid = canonicalClone(documentSet);
    delete invalid.hrcw_register;
    const outputPath = path.join(tempDir, "invalid.docx");

    await assert.rejects(
      () => renderDraftDocx(invalid, outputPath),
      (error) =>
        error instanceof RenderValidationError && error.validationReport.schema.status === "fail",
    );
    assert.equal(existsSync(outputPath), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Phase 5A blocks rule-failing document-sets before writing DOCX", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "safe-method-docx-rule-"));
  try {
    const documentSet = await readJson(REPO_ROOT, UNITAS_DOCUMENT_SET);
    const invalid = canonicalClone(documentSet);
    invalid.swms_matrix[0].reviewed_by = "SWMS approval by principal contractor";
    const outputPath = path.join(tempDir, "rule-invalid.docx");

    await assert.rejects(
      () => renderDraftDocx(invalid, outputPath),
      (error) =>
        error instanceof RenderValidationError &&
        error.validationReport.rules.results.some((result) => result.rule_id === "CONTENT-001"),
    );
    assert.equal(existsSync(outputPath), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
