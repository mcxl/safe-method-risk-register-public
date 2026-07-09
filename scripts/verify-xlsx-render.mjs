import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  buildHandoffManifest,
  buildManifestFileName,
  writeHandoffManifest,
} from "../app/handoff-manifest.mjs";
import { RenderValidationError } from "../render/docx-renderer.mjs";
import {
  XLSX_RENDERER_VERSION,
  assertPhase5bXlsx,
  renderDraftXlsx,
} from "../render/xlsx-renderer.mjs";
import { canonicalClone, readJson, REPO_ROOT } from "./kb-source.mjs";
import { createAjvRegistry, formatAjvErrors } from "./schema-registry.mjs";
import {
  cleanDirectory,
  renderSampleXlsx,
  SAMPLE_DOCUMENT_SET,
} from "./xlsx-verification-utils.mjs";

const OUTPUT_DIR = path.join(REPO_ROOT, "outputs", "tmp", "phase5b");
const failures = [];
let outputXlsx = null;

await runCheck("golden Sample document-set renders to DRAFT XLSX", async () => {
  await cleanDirectory(OUTPUT_DIR);
  const result = await renderSampleXlsx(OUTPUT_DIR);
  outputXlsx = result.outputXlsx;
  assert.equal(result.renderResult.workflow_state, "DRAFT");
  assert.equal(result.renderResult.issue_ready, false);
  assert.equal(result.renderResult.filename, result.outputFileName);
  assert.equal(result.outputFileName, "proj-ra-sample-rev04-draft-whs-control-document-set.xlsx");
  assert.match(result.renderResult.output_hash_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(existsSync(outputXlsx), true);
  assert.ok(statSync(outputXlsx).size > 0);
});

await runCheck("rendered DRAFT XLSX satisfies Phase 5B static assertions", async () => {
  const documentSet = await readJson(REPO_ROOT, SAMPLE_DOCUMENT_SET);
  const assertionReport = await assertPhase5bXlsx(outputXlsx, documentSet);
  assert.equal(assertionReport.status, "pass", JSON.stringify(assertionReport.failures, null, 2));
  assert.ok(assertionReport.formula_count >= documentSet.risk_register.length * 3 + 14);
});

await runCheck("handoff manifest captures XLSX output provenance and draft preflight", async () => {
  const documentSet = await readJson(REPO_ROOT, SAMPLE_DOCUMENT_SET);
  const manifestPath = path.join(OUTPUT_DIR, buildManifestFileName(path.basename(outputXlsx)));
  const manifest = await buildHandoffManifest(documentSet, {
    generatedAt: "2026-07-06T00:00:00.000Z",
    mode: "draft",
    extension: "xlsx",
    rendererVersion: XLSX_RENDERER_VERSION,
    outputPath: outputXlsx,
    documentSetPath: SAMPLE_DOCUMENT_SET,
    recipients: ["[Client To Confirm]"],
    subject: "Safe Method Risk Register DRAFT XLSX handoff - PROJ-RA-SAMPLE-REV04",
    verifierStatus: [
      {
        id: "phase5b-xlsx-static",
        name: "Phase 5B XLSX static assertions",
        status: "pass",
        required: true,
        evidence: "assertPhase5bXlsx pass",
      },
    ],
    phaseGateStatus: [
      {
        id: "phase-5b",
        name: "Phase 5B local static gate",
        phase: "5B",
        status: "pass",
        required: true,
        evidence_path: "phase-gates/phase-5b.md",
      },
    ],
  });

  const validate = createAjvRegistry().getValidator("handoff-manifest.schema.json");
  assert.equal(validate(manifest), true, formatAjvErrors(validate.errors));
  assert.equal(manifest.output.extension, "xlsx");
  assert.equal(manifest.output.file_name, manifest.output.expected_file_name);
  assert.equal(manifest.hashes.renderer.version, XLSX_RENDERER_VERSION);
  assert.equal(manifest.preflight.status, "pass");
  assert.equal(manifest.issue_ready, false);

  const writeResult = await writeHandoffManifest(manifest, manifestPath);
  assert.equal(existsSync(manifestPath), true);
  assert.match(writeResult.manifest_hash_sha256, /^[a-f0-9]{64}$/u);
});

await runCheck("XLSX renderer blocks schema-invalid document-sets before writing", async () => {
  const invalid = canonicalClone(await readJson(REPO_ROOT, SAMPLE_DOCUMENT_SET));
  delete invalid.hrcw_register;
  const outputPath = path.join(OUTPUT_DIR, "invalid.xlsx");
  await assert.rejects(
    () => renderDraftXlsx(invalid, outputPath),
    (error) =>
      error instanceof RenderValidationError && error.validationReport.schema.status === "fail",
  );
  assert.equal(existsSync(outputPath), false);
});

await runCheck("XLSX renderer blocks rule-failing document-sets before writing", async () => {
  const invalid = canonicalClone(await readJson(REPO_ROOT, SAMPLE_DOCUMENT_SET));
  invalid.swms_matrix[0].reviewed_by = "SWMS approval by principal contractor";
  const outputPath = path.join(OUTPUT_DIR, "rule-invalid.xlsx");
  await assert.rejects(
    () => renderDraftXlsx(invalid, outputPath),
    (error) =>
      error instanceof RenderValidationError &&
      error.validationReport.rules.results.some((result) => result.rule_id === "CONTENT-001"),
  );
  assert.equal(existsSync(outputPath), false);
});

await mkdir(OUTPUT_DIR, { recursive: true });

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL ${failure}`);
  }
  process.exit(1);
}

console.log("PHASE 5B XLSX STATIC RENDER GATE: PASS");

async function runCheck(label, check) {
  try {
    await check();
    console.log(`PASS ${label}`);
  } catch (error) {
    failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
