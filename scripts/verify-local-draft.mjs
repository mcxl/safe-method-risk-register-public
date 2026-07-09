import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildOutputFileName, countUnresolvedMarkers } from "../app/handoff-manifest.mjs";
import {
  CODEX_ASSISTED_LOCKED_MANIFEST_STATE,
  CODEX_ASSISTED_MANIFEST_FILE,
  CODEX_ASSISTED_SECTION_FILES,
  codexAssistedSectionFileName,
  resolveCodexAssistedRunDirectory,
} from "../generate/sectioned-providers.mjs";
import { assertDocumentSetRenderable } from "../render/docx-renderer.mjs";
import { REPO_ROOT } from "./kb-source.mjs";
import { createAjvRegistry, formatAjvErrors } from "./schema-registry.mjs";

const REQUIRED_EVIDENCE_FILES = Object.freeze([
  "assembled-document-set.json",
  "validation-report.json",
  "generation-provenance.json",
]);

export function parseVerifyLocalDraftArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {
    runId: env.SAFE_METHOD_CODEX_ASSISTED_RUN_ID,
    outputPath: env.SAFE_METHOD_OUTPUT_PATH,
    manifestPath: env.SAFE_METHOD_MANIFEST_PATH,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--run-id") {
      options.runId = requiredArg(argv, (index += 1), arg);
    } else if (arg === "--run-dir") {
      options.runDirectory = requiredArg(argv, (index += 1), arg);
    } else if (arg === "--output") {
      options.outputPath = requiredArg(argv, (index += 1), arg);
    } else if (arg === "--manifest") {
      options.manifestPath = requiredArg(argv, (index += 1), arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.runId && !options.runDirectory) {
    throw new Error("--run-id, --run-dir or SAFE_METHOD_CODEX_ASSISTED_RUN_ID is required.");
  }

  return options;
}

export async function verifyLocalDraftArtifacts(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const runDirectory = resolveRunDirectory(root, options);
  const summary = await readOptionalJson(
    path.join(runDirectory, "evidence", "local-draft-summary.json"),
  );
  const outputPath = path.resolve(root, options.outputPath ?? summary?.output_path ?? "");
  const manifestPath = path.resolve(root, options.manifestPath ?? summary?.manifest_path ?? "");

  if (!outputPath || outputPath === root) {
    throw new Error("--output is required when local-draft-summary.json is absent.");
  }
  if (!manifestPath || manifestPath === root) {
    throw new Error("--manifest is required when local-draft-summary.json is absent.");
  }

  const checks = [];
  const manifest = await readJsonFile(path.join(runDirectory, CODEX_ASSISTED_MANIFEST_FILE));
  assertCondition(
    manifest.manifest_state === CODEX_ASSISTED_LOCKED_MANIFEST_STATE,
    "Codex-assisted run manifest must be locked.",
    checks,
    "RUN-MANIFEST-LOCKED",
  );
  await verifyLockedSectionHashes(runDirectory, manifest, checks);

  const evidenceDirectory = path.join(runDirectory, "evidence");
  for (const fileName of REQUIRED_EVIDENCE_FILES) {
    assertCondition(
      existsSync(path.join(evidenceDirectory, fileName)),
      `Missing required evidence file: ${fileName}.`,
      checks,
      `EVIDENCE-${fileName}`,
    );
  }

  const documentSetPath = path.join(evidenceDirectory, "assembled-document-set.json");
  const validationReportPath = path.join(evidenceDirectory, "validation-report.json");
  const documentSet = await readJsonFile(documentSetPath);
  const validationReport = await readJsonFile(validationReportPath);
  assertCondition(
    validationReport.status === "pass" &&
      validationReport.schema?.status === "pass" &&
      validationReport.rules?.status === "pass",
    "Validation report must be pass for schema and deterministic rules.",
    checks,
    "VALIDATION-REPORT-PASS",
  );
  assertDocumentSetRenderable(documentSet, { mode: "draft" });
  checks.push({ id: "DOCUMENT-SET-RENDERABLE", status: "pass" });

  const outputStat = await stat(outputPath);
  assertCondition(outputStat.isFile(), "Rendered DOCX output must exist.", checks, "OUTPUT-EXISTS");
  const outputHash = await sha256File(outputPath);
  const handoffManifest = await readJsonFile(manifestPath);
  validateHandoffManifestSchema(handoffManifest);
  checks.push({ id: "MANIFEST-SCHEMA", status: "pass" });

  assertCondition(
    handoffManifest.output_mode === "draft" &&
      handoffManifest.issue_ready === false &&
      handoffManifest.preflight?.issue_ready === false,
    "Handoff manifest must remain draft and not issue-ready.",
    checks,
    "DRAFT-NOT-ISSUE-READY",
  );
  assertCondition(
    handoffManifest.preflight?.status === "pass",
    "Draft handoff manifest preflight must pass.",
    checks,
    "PREFLIGHT-PASS",
  );
  assertCondition(
    handoffManifest.output?.sha256 === outputHash,
    "Handoff manifest output hash must match rendered DOCX.",
    checks,
    "OUTPUT-HASH-MATCH",
  );
  assertCondition(
    path.basename(outputPath) === handoffManifest.output?.file_name &&
      handoffManifest.output.file_name === handoffManifest.output.expected_file_name,
    "Rendered output filename must match the deterministic manifest filename.",
    checks,
    "OUTPUT-NAMING",
  );

  const expectedFileName = buildOutputFileName(documentSet, {
    mode: "draft",
    extension: "docx",
    dateStamp: dateStampFromManifest(handoffManifest),
  });
  assertCondition(
    handoffManifest.output.expected_file_name === expectedFileName,
    "Manifest expected filename must match buildOutputFileName for the assembled document set.",
    checks,
    "OUTPUT-NAMING-RULE",
  );

  const unresolved = countUnresolvedMarkers(documentSet);
  assertCondition(
    handoffManifest.unresolved_markers?.total === unresolved.total,
    "Unresolved marker counts must match the assembled document set.",
    checks,
    "UNRESOLVED-MARKERS-REPORTED",
  );
  verifySourceInputHashes(handoffManifest.source_inputs ?? [], checks);

  const renderResult = await readOptionalJson(path.join(evidenceDirectory, "render-result.json"));
  if (renderResult) {
    assertCondition(
      renderResult.workflow_state === "DRAFT" && renderResult.issue_ready === false,
      "Renderer result must be DRAFT and not issue-ready.",
      checks,
      "RENDER-RESULT-DRAFT",
    );
    assertCondition(
      renderResult.output_hash_sha256 === outputHash,
      "Renderer output hash must match rendered DOCX.",
      checks,
      "RENDER-RESULT-OUTPUT-HASH",
    );
  }

  const manifestHash = await sha256File(manifestPath);
  const expectedManifestHash =
    options.expectedManifestHash ??
    summary?.manifest_hash_sha256 ??
    renderResult?.manifest_hash_sha256 ??
    null;
  if (expectedManifestHash) {
    assertCondition(
      manifestHash === expectedManifestHash,
      "Manifest hash must match local draft summary/render evidence.",
      checks,
      "MANIFEST-HASH-MATCH",
    );
  }
  if (summary?.output_hash_sha256) {
    assertCondition(
      summary.output_hash_sha256 === outputHash,
      "Output hash must match local draft summary.",
      checks,
      "SUMMARY-OUTPUT-HASH",
    );
  }

  return {
    status: "pass",
    run_directory: runDirectory,
    output_path: outputPath,
    manifest_path: manifestPath,
    output_hash_sha256: outputHash,
    manifest_hash_sha256: manifestHash,
    checks,
  };
}

function resolveRunDirectory(root, options) {
  return resolveCodexAssistedRunDirectory({
    root,
    env: options.env ?? process.env,
    runId: options.runId,
    runDirectory: options.runDirectory,
  });
}

async function verifyLockedSectionHashes(runDirectory, manifest, checks) {
  const expectedFiles = CODEX_ASSISTED_SECTION_FILES.map((section) => section.file_name);
  assertCondition(
    JSON.stringify(manifest.expected_section_filenames) === JSON.stringify(expectedFiles),
    "Codex-assisted expected section filenames are stale or mismatched.",
    checks,
    "RUN-MANIFEST-SECTIONS",
  );

  for (const section of CODEX_ASSISTED_SECTION_FILES) {
    const sectionEntry = manifest.sections?.[section.section_name];
    assertCondition(
      sectionEntry?.file_name === section.file_name,
      `Run manifest missing section entry for ${section.section_name}.`,
      checks,
      `RUN-MANIFEST-${section.section_name}`,
    );
    assertCondition(
      /^[a-f0-9]{64}$/u.test(sectionEntry.sha256 ?? ""),
      `Run manifest section ${section.section_name} must have a locked SHA-256 hash.`,
      checks,
      `RUN-MANIFEST-HASH-${section.section_name}`,
    );
    const filePath = path.join(runDirectory, codexAssistedSectionFileName(section.section_name));
    assertCondition(
      existsSync(filePath),
      `Locked section file is missing: ${section.file_name}.`,
      checks,
      `SECTION-FILE-${section.section_name}`,
    );
    const actualHash = await sha256File(filePath);
    assertCondition(
      actualHash === sectionEntry.sha256,
      `Locked section file hash mismatch: ${section.file_name}.`,
      checks,
      `SECTION-HASH-${section.section_name}`,
    );
  }
}

function validateHandoffManifestSchema(manifest) {
  const registry = createAjvRegistry();
  const validate = registry.getValidator("handoff-manifest.schema.json");
  if (!validate(manifest)) {
    throw new Error(`Handoff manifest schema failed: ${formatAjvErrors(validate.errors)}`);
  }
}

function verifySourceInputHashes(sourceInputs, checks) {
  assertCondition(
    sourceInputs.length > 0,
    "Handoff manifest must report source inputs.",
    checks,
    "SOURCE-INPUTS",
  );
  for (const [index, sourceInput] of sourceInputs.entries()) {
    assertCondition(
      sourceInput.exists === true,
      `Source input ${index} must exist.`,
      checks,
      `SOURCE-INPUT-${index}-EXISTS`,
    );
    assertCondition(
      /^[a-f0-9]{64}$/u.test(sourceInput.sha256 ?? ""),
      `Source input ${index} must include a SHA-256 hash.`,
      checks,
      `SOURCE-INPUT-${index}-HASH`,
    );
  }
}

function dateStampFromManifest(manifest) {
  const dateStamp = manifest.document?.date_stamp;
  if (!dateStamp || dateStamp.value === null || dateStamp.value === undefined) {
    return false;
  }
  if (dateStamp.source === "project.issue_date") {
    return "from_issue_date";
  }
  return dateStamp.value;
}

function assertCondition(condition, message, checks, id) {
  if (!condition) {
    throw new Error(message);
  }
  checks.push({ id, status: "pass" });
}

async function readOptionalJson(filePath) {
  if (!existsSync(filePath)) return null;
  return readJsonFile(filePath);
}

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function sha256File(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

function requiredArg(argv, index, arg) {
  if (index >= argv.length || argv[index].startsWith("--")) {
    throw new Error(`${arg} requires a value.`);
  }
  return argv[index];
}

function printVerificationResult(result) {
  console.log(
    JSON.stringify(
      {
        status: result.status,
        run_directory: result.run_directory,
        output_path: result.output_path,
        manifest_path: result.manifest_path,
        output_hash_sha256: result.output_hash_sha256,
        manifest_hash_sha256: result.manifest_hash_sha256,
        checks: result.checks.length,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await verifyLocalDraftArtifacts(parseVerifyLocalDraftArgs());
    printVerificationResult(result);
  } catch (error) {
    console.error(`FAIL local draft verification: ${error.message}`);
    process.exit(1);
  }
}
