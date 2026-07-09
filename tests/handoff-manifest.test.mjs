import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildHandoffManifest,
  buildOutputFileName,
  countUnresolvedMarkers,
  normaliseDateStamp,
  resolveDateStamp,
} from "../app/handoff-manifest.mjs";
import { createAjvRegistry, formatAjvErrors } from "../scripts/schema-registry.mjs";
import { canonicalClone, readJson, REPO_ROOT } from "../scripts/kb-source.mjs";

const UNITAS_DOCUMENT_SET = "fixtures/golden/document-sets/unitas-document-set.json";

test("handoff output naming is deterministic and date stamps are explicit", async () => {
  const documentSet = await readJson(REPO_ROOT, UNITAS_DOCUMENT_SET);

  assert.equal(
    buildOutputFileName(documentSet, { mode: "draft" }),
    "proj-ra-unitas-rev04-draft-whs-control-document-set.docx",
  );
  assert.equal(
    buildOutputFileName(documentSet, { mode: "final", dateStamp: "from_issue_date" }),
    "proj-ra-unitas-rev04-2026-03-24-final-whs-control-document-set.docx",
  );
  assert.deepEqual(resolveDateStamp(documentSet, false), { source: "omitted", value: null });
  assert.equal(normaliseDateStamp("2026-03-24"), "2026-03-24");
  assert.throws(() => normaliseDateStamp("[Client To Confirm]"), /concrete date/u);
  assert.equal(
    buildOutputFileName(documentSet, { mode: "draft", extension: "xlsx" }),
    "proj-ra-unitas-rev04-draft-whs-control-document-set.xlsx",
  );
});

test("draft handoff manifest validates and remains not issue-ready", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "safe-method-manifest-"));
  try {
    const documentSet = await readJson(REPO_ROOT, UNITAS_DOCUMENT_SET);
    const outputFileName = buildOutputFileName(documentSet, { mode: "draft" });
    const outputPath = path.join(tempDir, outputFileName);
    await writeFile(outputPath, "draft output bytes");

    const manifest = await buildHandoffManifest(documentSet, {
      generatedAt: "2026-06-27T00:00:00.000Z",
      mode: "draft",
      outputPath,
      documentSetPath: UNITAS_DOCUMENT_SET,
      recipients: ["[Client To Confirm]"],
      verifierStatus: [
        {
          id: "phase5a-docx-ooxml",
          name: "Phase 5A DOCX OOXML assertions",
          status: "pass",
          required: true,
        },
      ],
      phaseGateStatus: [
        {
          id: "phase-5a",
          name: "Phase 5A local gate",
          phase: "5A",
          status: "pass",
          required: true,
        },
      ],
    });

    const validate = createAjvRegistry().getValidator("handoff-manifest.schema.json");
    assert.equal(validate(manifest), true, formatAjvErrors(validate.errors));
    assert.equal(manifest.preflight.status, "pass");
    assert.equal(manifest.issue_ready, false);
    assert.equal(manifest.output.file_name, manifest.output.expected_file_name);
    assert.match(manifest.hashes.document_set_canonical_sha256, /^[a-f0-9]{64}$/u);
    assert.ok(
      manifest.hashes.schemas.some((entry) => entry.relative_path.endsWith(".schema.json")),
    );
    assert.ok(manifest.hashes.rules.some((entry) => entry.relative_path === "rules/index.mjs"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("final handoff is blocked without sign-off, gates and required verifier pass", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "safe-method-final-manifest-"));
  try {
    const documentSet = await readJson(REPO_ROOT, UNITAS_DOCUMENT_SET);
    const outputFileName = buildOutputFileName(documentSet, {
      mode: "final",
      dateStamp: "from_issue_date",
    });
    const outputPath = path.join(tempDir, outputFileName);
    await writeFile(outputPath, "final output bytes");

    const manifest = await buildHandoffManifest(documentSet, {
      generatedAt: "2026-06-27T00:00:00.000Z",
      mode: "final",
      dateStamp: "from_issue_date",
      outputPath,
      documentSetPath: UNITAS_DOCUMENT_SET,
      verifierStatus: [
        {
          id: "phase5a-docx-ooxml",
          name: "Phase 5A DOCX OOXML assertions",
          status: "skip",
          required: true,
          reason: "Verifier intentionally skipped in test.",
        },
      ],
      phaseGateStatus: [
        {
          id: "phase-5a",
          name: "Phase 5A local gate",
          phase: "5A",
          status: "pass",
          required: true,
        },
      ],
    });

    assert.equal(manifest.preflight.status, "blocked");
    assert.equal(manifest.issue_ready, false);
    assert.ok(manifest.preflight.checks.some((check) => check.id === "REVIEW-SIGNOFF"));
    assert.ok(manifest.preflight.checks.some((check) => check.id === "VERIFIERS"));
    assert.ok(manifest.skipped_checks.some((check) => check.id === "phase5a-docx-ooxml"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("unresolved placeholder counts are reported without mutating WHS content", async () => {
  const documentSet = await readJson(REPO_ROOT, UNITAS_DOCUMENT_SET);
  const withPlaceholder = canonicalClone(documentSet);
  withPlaceholder.project.whs_consultant = "[Client To Confirm]";
  withPlaceholder.project.review_date = "[Client To Confirm]";

  const counts = countUnresolvedMarkers(withPlaceholder);
  assert.equal(counts.total, 2);
  assert.deepEqual(counts.locations.map((location) => location.json_path).sort(), [
    "/project/review_date",
    "/project/whs_consultant",
  ]);
});
