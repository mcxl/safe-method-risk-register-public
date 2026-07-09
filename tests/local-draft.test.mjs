import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  buildSectionEnvelopeFromDocumentSet,
  SECTION_NAMES,
} from "../generate/sectioned-pipeline.mjs";
import {
  buildCodexAssistedRunManifest,
  buildPreparedCodexAssistedRunManifest,
  codexAssistedSectionFileName,
  writeCodexAssistedRunManifest,
} from "../generate/sectioned-providers.mjs";
import {
  parseLocalDraftArgs,
  readVerificationCache,
  resolveOfflineVerifierStatus,
  runLocalDraftGeneration,
} from "../scripts/generate-local-draft.mjs";
import {
  parseVerifyLocalDraftArgs,
  verifyLocalDraftArtifacts,
} from "../scripts/verify-local-draft.mjs";
import { canonicalClone, REPO_ROOT } from "../scripts/kb-source.mjs";
import { buildUnitasContext } from "./helpers/codex-assisted-runs.mjs";

const LOCAL_DRAFT_TEST_ROOT = path.join(REPO_ROOT, "outputs", "tmp", "local-draft-tests");

test.after(async () => {
  await rm(LOCAL_DRAFT_TEST_ROOT, { recursive: true, force: true });
  await rm(path.join(REPO_ROOT, "outputs", "tmp", "verify-cache"), {
    recursive: true,
    force: true,
  });
});

test("local draft CLI parsing supports env fallbacks and explicit date stamps", () => {
  const parsed = parseLocalDraftArgs(
    [
      "--source-input",
      "source.pdf",
      "--date-stamp",
      "from_issue_date",
      "--verify",
      "none",
      "--generated-at",
      "2026-07-09T00:00:00+10:00",
    ],
    {
      SAFE_METHOD_PROJECT_BRIEF: "brief.json",
      SAFE_METHOD_CODEX_ASSISTED_RUN_ID: "run-001",
      SAFE_METHOD_PROJECT_SLUG: "project-slug",
      SAFE_METHOD_OUTPUT_DIR: "outputs/local/project-slug",
    },
  );

  assert.equal(parsed.briefPath, "brief.json");
  assert.equal(parsed.runId, "run-001");
  assert.equal(parsed.projectSlug, "project-slug");
  assert.equal(parsed.outputDir, "outputs/local/project-slug");
  assert.deepEqual(parsed.sourceInputs, ["source.pdf"]);
  assert.equal(parsed.dateStamp, "from_issue_date");
  assert.equal(parsed.verifyMode, "none");

  assert.deepEqual(
    parseVerifyLocalDraftArgs(
      ["--run-id", "run-001", "--output", "out.docx", "--manifest", "out.manifest.json"],
      {},
    ),
    {
      runId: "run-001",
      outputPath: "out.docx",
      manifestPath: "out.manifest.json",
    },
  );
});

test("local draft generation renders a DRAFT DOCX, manifest and verifier pass", async () => {
  const context = await buildUnitasContext();
  const run = await createLocalDraftRun("local-draft-pass", context);
  const outputDir = path.join(LOCAL_DRAFT_TEST_ROOT, "local-draft-pass-output");

  const outcome = await runLocalDraftGeneration({
    root: REPO_ROOT,
    runDirectory: run.runDirectory,
    runId: run.runId,
    briefPath: context.briefPath,
    ...context,
    outputDir,
    generatedAt: "2026-07-09T00:00:00+10:00",
    verifyMode: "none",
  });

  assert.equal(outcome.status, "pass");
  assert.equal(outcome.issue_ready, false);
  assert.equal(outcome.workflow_state, "DRAFT");
  assert.equal(existsSync(outcome.output_path), true);
  assert.equal(existsSync(outcome.manifest_path), true);
  assert.equal(outcome.localVerification.status, "pass");

  const manifest = JSON.parse(await readFile(outcome.manifest_path, "utf8"));
  assert.equal(manifest.output_mode, "draft");
  assert.equal(manifest.issue_ready, false);
  assert.equal(manifest.output.file_name, manifest.output.expected_file_name);
  assert.equal(manifest.validation.status, "pass");
  assert.equal(
    manifest.verifier_status.find((entry) => entry.id === "verify-offline-cache")?.status,
    "not_run",
  );
});

test("local draft generation emits worker packets and does not render when sections are missing", async () => {
  const context = await buildUnitasContext();
  const runDirectory = path.join(LOCAL_DRAFT_TEST_ROOT, "local-draft-missing-sections");
  await rm(runDirectory, { recursive: true, force: true });

  const outcome = await runLocalDraftGeneration({
    root: REPO_ROOT,
    runDirectory,
    runId: "local-draft-missing-sections",
    briefPath: context.briefPath,
    ...context,
    outputDir: path.join(LOCAL_DRAFT_TEST_ROOT, "local-draft-missing-output"),
    generatedAt: "2026-07-09T00:00:00+10:00",
    verifyMode: "none",
  });

  assert.equal(outcome.status, "needs_sections");
  assert.equal(outcome.missingSections.length, 10);
  assert.equal(existsSync(outcome.workerPackets.directory), true);
  assert.equal(
    existsSync(path.join(outcome.workerPackets.directory, "00-missing-section-checklist.md")),
    true,
  );
  assert.equal(existsSync(path.join(runDirectory, "evidence")), false);
});

test("local draft generation fails closed on lock and assembly failures", async () => {
  const context = await buildUnitasContext();
  const invalidEnvelope = canonicalClone(
    buildSectionEnvelopeFromDocumentSet("hrcw_register", context.golden),
  );
  delete invalidEnvelope.hrcw_register;
  const lockRun = await createLocalDraftRun("local-draft-lock-fail", context, {
    overrides: {
      hrcw_register: invalidEnvelope,
    },
  });

  const lockOutcome = await runLocalDraftGeneration({
    root: REPO_ROOT,
    runDirectory: lockRun.runDirectory,
    runId: lockRun.runId,
    briefPath: context.briefPath,
    ...context,
    outputDir: path.join(LOCAL_DRAFT_TEST_ROOT, "local-draft-lock-fail-output"),
    generatedAt: "2026-07-09T00:00:00+10:00",
    verifyMode: "none",
  });
  assert.equal(lockOutcome.status, "lock_failed");
  assert.equal(existsSync(path.join(lockRun.runDirectory, "evidence")), false);

  const failingDocumentSet = canonicalClone(context.golden);
  failingDocumentSet.risk_register[0].residual_risk = "Low";
  failingDocumentSet.risk_register[0].controls = [
    {
      source_ids: ["traffic-management-plan"],
      text: "Traffic routes are communicated before deliveries; site manager verifies the record; if the record is absent, deliveries are held.",
      levels: ["administrative"],
      control_status: "active_control",
    },
  ];
  const assemblyRun = await createLocalDraftRun("local-draft-assembly-fail", context, {
    overrides: {
      risk_register_part_1: buildSectionEnvelopeFromDocumentSet(
        "risk_register_part_1",
        failingDocumentSet,
      ),
    },
  });
  const assemblyOutcome = await runLocalDraftGeneration({
    root: REPO_ROOT,
    runDirectory: assemblyRun.runDirectory,
    runId: assemblyRun.runId,
    briefPath: context.briefPath,
    ...context,
    outputDir: path.join(LOCAL_DRAFT_TEST_ROOT, "local-draft-assembly-fail-output"),
    generatedAt: "2026-07-09T00:00:00+10:00",
    verifyMode: "none",
  });

  assert.equal(assemblyOutcome.status, "assembly_failed");
  assert.equal(
    existsSync(path.join(assemblyRun.runDirectory, "evidence", "assembled-document-set.json")),
    false,
  );
});

test("local draft verifier detects output, naming, hash and issue-ready failures", async () => {
  const context = await buildUnitasContext();
  const run = await createLocalDraftRun("local-draft-verifier", context);
  const outcome = await runLocalDraftGeneration({
    root: REPO_ROOT,
    runDirectory: run.runDirectory,
    runId: run.runId,
    briefPath: context.briefPath,
    ...context,
    outputDir: path.join(LOCAL_DRAFT_TEST_ROOT, "local-draft-verifier-output"),
    generatedAt: "2026-07-09T00:00:00+10:00",
    verifyMode: "none",
  });
  const originalManifestText = await readFile(outcome.manifest_path, "utf8");
  const originalManifest = JSON.parse(originalManifestText);

  await assert.rejects(
    () =>
      verifyLocalDraftArtifacts({
        root: REPO_ROOT,
        runDirectory: run.runDirectory,
        outputPath: path.join(LOCAL_DRAFT_TEST_ROOT, "missing.docx"),
        manifestPath: outcome.manifest_path,
      }),
    /ENOENT|no such file/u,
  );

  const wrongName = canonicalClone(originalManifest);
  wrongName.output.file_name = "wrong.docx";
  await writeJson(outcome.manifest_path, wrongName);
  await assert.rejects(
    () =>
      verifyLocalDraftArtifacts({
        root: REPO_ROOT,
        runDirectory: run.runDirectory,
        outputPath: outcome.output_path,
        manifestPath: outcome.manifest_path,
      }),
    /filename/u,
  );

  const wrongOutputHash = canonicalClone(originalManifest);
  wrongOutputHash.output.sha256 = "0".repeat(64);
  await writeJson(outcome.manifest_path, wrongOutputHash);
  await assert.rejects(
    () =>
      verifyLocalDraftArtifacts({
        root: REPO_ROOT,
        runDirectory: run.runDirectory,
        outputPath: outcome.output_path,
        manifestPath: outcome.manifest_path,
      }),
    /output hash/u,
  );

  const finalClaim = canonicalClone(originalManifest);
  finalClaim.issue_ready = true;
  await writeJson(outcome.manifest_path, finalClaim);
  await assert.rejects(
    () =>
      verifyLocalDraftArtifacts({
        root: REPO_ROOT,
        runDirectory: run.runDirectory,
        outputPath: outcome.output_path,
        manifestPath: outcome.manifest_path,
      }),
    /not issue-ready/u,
  );

  const tamperedManifest = canonicalClone(originalManifest);
  tamperedManifest.review.comments = "tampered but schema-valid";
  await writeJson(outcome.manifest_path, tamperedManifest);
  await assert.rejects(
    () =>
      verifyLocalDraftArtifacts({
        root: REPO_ROOT,
        runDirectory: run.runDirectory,
        outputPath: outcome.output_path,
        manifestPath: outcome.manifest_path,
      }),
    /Manifest hash/u,
  );

  await writeFile(outcome.manifest_path, originalManifestText, "utf8");
  assert.equal(
    (
      await verifyLocalDraftArtifacts({
        root: REPO_ROOT,
        runDirectory: run.runDirectory,
        outputPath: outcome.output_path,
        manifestPath: outcome.manifest_path,
      })
    ).status,
    "pass",
  );
});

test("verification cache records full runs and targeted mode reuses matching cache", async () => {
  const root = REPO_ROOT;
  const generatedAt = "2026-07-09T00:00:00+10:00";
  const full = await resolveOfflineVerifierStatus({
    root,
    verifyMode: "full",
    generatedAt,
    runOfflineVerification: async () => ({ status: 0, stdout: "PASS", stderr: "" }),
  });
  assert.equal(full.statusEntry.status, "pass");
  assert.equal(existsSync(full.cacheRecord.path), true);

  const targeted = await resolveOfflineVerifierStatus({
    root,
    verifyMode: "targeted",
    generatedAt,
  });
  assert.equal(targeted.statusEntry.status, "pass");
  assert.equal(targeted.cacheRecord.fingerprint_hash_sha256, full.fingerprint.hash_sha256);

  const cached = await readVerificationCache(root, full.fingerprint);
  assert.equal(cached.status, "pass");
});

async function createLocalDraftRun(runId, context, options = {}) {
  const runDirectory = path.join(LOCAL_DRAFT_TEST_ROOT, runId);
  const overrides = options.overrides ?? {};
  const manifestState = options.manifestState ?? "locked";

  await rm(runDirectory, { recursive: true, force: true });
  await mkdir(runDirectory, { recursive: true });

  if (options.writeSections !== false) {
    for (const sectionName of SECTION_NAMES) {
      const override = overrides[sectionName];
      const value =
        override === undefined
          ? buildSectionEnvelopeFromDocumentSet(sectionName, context.golden)
          : override;
      const filePath = path.join(runDirectory, codexAssistedSectionFileName(sectionName));
      if (typeof value === "string") {
        await writeFile(filePath, value, "utf8");
      } else {
        await writeJson(filePath, value);
      }
    }
  }

  const manifestOptions = {
    root: REPO_ROOT,
    runDirectory,
    runId,
    briefPath: context.briefPath,
    brief: context.brief,
    normalisedBrief: context.normalisedBrief,
    retrievalPacket: context.retrievalPacket,
  };
  const manifest =
    manifestState === "prepared"
      ? await buildPreparedCodexAssistedRunManifest(manifestOptions)
      : await buildCodexAssistedRunManifest(manifestOptions);
  await writeCodexAssistedRunManifest({ runDirectory, manifest });
  return { runDirectory, runId, manifest };
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(canonicalClone(value), null, 2)}\n`, "utf8");
}
