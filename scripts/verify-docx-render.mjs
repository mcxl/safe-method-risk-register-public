import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import {
  buildHandoffManifest,
  buildManifestFileName,
  buildOutputFileName,
  writeHandoffManifest,
} from "../app/handoff-manifest.mjs";
import { renderDraftDocx } from "../render/docx-renderer.mjs";
import { assertPhase5aDocx } from "../render/ooxml-assertions.mjs";
import { readJson, REPO_ROOT } from "./kb-source.mjs";
import { createAjvRegistry, formatAjvErrors } from "./schema-registry.mjs";

const UNITAS_DOCUMENT_SET = "fixtures/golden/document-sets/unitas-document-set.json";
const OUTPUT_DIR = path.join(REPO_ROOT, "outputs", "tmp", "phase5a");

const failures = [];
let outputDocx = null;

await runCheck("golden Unitas document-set renders to DRAFT DOCX", async () => {
  await rm(OUTPUT_DIR, { recursive: true, force: true });
  await mkdir(OUTPUT_DIR, { recursive: true });

  const documentSet = await readJson(REPO_ROOT, UNITAS_DOCUMENT_SET);
  const outputFileName = buildOutputFileName(documentSet, { mode: "draft" });
  outputDocx = path.join(OUTPUT_DIR, outputFileName);
  const renderResult = await renderDraftDocx(documentSet, outputDocx, { filename: outputFileName });

  assert.equal(renderResult.workflow_state, "DRAFT");
  assert.equal(renderResult.issue_ready, false);
  assert.equal(renderResult.filename, outputFileName);
  assert.match(renderResult.output_hash_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(existsSync(outputDocx), true);
  assert.ok(statSync(outputDocx).size > 0);
});

await runCheck("rendered DRAFT DOCX satisfies Phase 5A OOXML assertions", async () => {
  const documentSet = await readJson(REPO_ROOT, UNITAS_DOCUMENT_SET);
  const assertionReport = await assertPhase5aDocx(outputDocx, documentSet);
  assert.equal(assertionReport.status, "pass");
});

await runCheck("handoff manifest captures output provenance and preflight status", async () => {
  const documentSet = await readJson(REPO_ROOT, UNITAS_DOCUMENT_SET);
  const manifestPath = path.join(OUTPUT_DIR, buildManifestFileName(path.basename(outputDocx)));
  const manifest = await buildHandoffManifest(documentSet, {
    generatedAt: "2026-06-27T00:00:00.000Z",
    mode: "draft",
    outputPath: outputDocx,
    documentSetPath: UNITAS_DOCUMENT_SET,
    recipients: ["[Client To Confirm]"],
    subject: "Safe Method Risk Register DRAFT handoff - PROJ-RA-UNITAS-REV04",
    verifierStatus: [
      {
        id: "phase5a-docx-ooxml",
        name: "Phase 5A DOCX OOXML assertions",
        status: "pass",
        required: true,
        evidence: "assertPhase5aDocx pass",
      },
    ],
    phaseGateStatus: [
      {
        id: "phase-5a",
        name: "Phase 5A local deterministic gate",
        phase: "5A",
        status: "pass",
        required: true,
        evidence_path: "phase-gates/phase-5a.md",
      },
    ],
    credentialGatedChecks: [
      {
        id: "anthropic-api-smoke",
        name: "Anthropic API smoke",
        status: "skip",
        required: false,
        reason: "ANTHROPIC_API_KEY not set for local deterministic verification.",
      },
    ],
  });

  const validate = createAjvRegistry().getValidator("handoff-manifest.schema.json");
  assert.equal(validate(manifest), true, formatAjvErrors(validate.errors));
  assert.equal(manifest.output.file_name, manifest.output.expected_file_name);
  assert.equal(manifest.preflight.status, "pass");
  assert.equal(manifest.issue_ready, false);
  assert.match(manifest.output.sha256, /^[a-f0-9]{64}$/u);
  assert.ok(manifest.hashes.schemas.length > 0);
  assert.ok(manifest.hashes.rules.length > 0);

  const writeResult = await writeHandoffManifest(manifest, manifestPath);
  assert.equal(existsSync(manifestPath), true);
  assert.match(writeResult.manifest_hash_sha256, /^[a-f0-9]{64}$/u);
});

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL ${failure}`);
  }
  process.exit(1);
}

console.log("PHASE 5A DOCX RENDER GATE: PASS");

async function runCheck(label, check) {
  try {
    await check();
    console.log(`PASS ${label}`);
  } catch (error) {
    failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
