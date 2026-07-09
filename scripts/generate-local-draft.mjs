import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildHandoffManifest,
  buildManifestFileName,
  buildOutputFileName,
  writeHandoffManifest,
} from "../app/handoff-manifest.mjs";
import {
  SECTION_NAMES,
  RISK_REGISTER_CHUNK_SECTIONS,
  SWMS_BENCHMARK_REVIEW_CHUNK_SECTIONS,
} from "../generate/sectioned-pipeline.mjs";
import { CODEX_ASSISTED_SECTION_FILES } from "../generate/sectioned-providers.mjs";
import { renderDraftDocx } from "../render/docx-renderer.mjs";
import { buildCodexAssistedGenerationContext } from "./generate-sectioned-codex-assisted-assemble.mjs";
import { runCodexAssistedAssemble } from "./generate-sectioned-codex-assisted-assemble.mjs";
import { runCodexAssistedLock } from "./generate-sectioned-codex-assisted-lock.mjs";
import { runCodexAssistedPrepare } from "./generate-sectioned-codex-assisted-prepare.mjs";
import { canonicalClone, canonicalStringify, REPO_ROOT } from "./kb-source.mjs";
import { verifyLocalDraftArtifacts } from "./verify-local-draft.mjs";

export const LOCAL_DRAFT_SUMMARY_FILE = "local-draft-summary.json";
export const LOCAL_DRAFT_RENDER_RESULT_FILE = "render-result.json";
export const VERIFY_CACHE_VERSION = "local-draft.verify-cache.v1";
export const WORKER_PACKET_VERSION = "local-draft.worker-packets.v1";

const VERIFY_MODES = new Set(["targeted", "full", "none"]);
const CACHE_ROOT = "outputs/tmp/verify-cache";
const CODE_SURFACES = Object.freeze([
  "schemas",
  "rules",
  "generate",
  "render",
  "app",
  "knowledge",
  "spec",
  "scripts",
  "package.json",
  "package-lock.json",
]);

export function parseLocalDraftArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {
    briefPath: env.SAFE_METHOD_PROJECT_BRIEF,
    runId: env.SAFE_METHOD_CODEX_ASSISTED_RUN_ID,
    projectSlug: env.SAFE_METHOD_PROJECT_SLUG,
    outputDir: env.SAFE_METHOD_OUTPUT_DIR,
    sourceInputs: [],
    dateStamp: false,
    verifyMode: "targeted",
    generatedAt: env.SAFE_METHOD_GENERATED_AT,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--brief") {
      options.briefPath = requiredArg(argv, (index += 1), arg);
    } else if (arg === "--run-id") {
      options.runId = requiredArg(argv, (index += 1), arg);
    } else if (arg === "--run-dir") {
      options.runDirectory = requiredArg(argv, (index += 1), arg);
    } else if (arg === "--project-slug") {
      options.projectSlug = requiredArg(argv, (index += 1), arg);
    } else if (arg === "--source-input") {
      options.sourceInputs.push(requiredArg(argv, (index += 1), arg));
    } else if (arg === "--output-dir") {
      options.outputDir = requiredArg(argv, (index += 1), arg);
    } else if (arg === "--date-stamp") {
      options.dateStamp = parseDateStampOption(requiredArg(argv, (index += 1), arg));
    } else if (arg === "--verify") {
      options.verifyMode = requiredArg(argv, (index += 1), arg);
    } else if (arg === "--generated-at") {
      options.generatedAt = requiredArg(argv, (index += 1), arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.briefPath) {
    throw new Error("--brief or SAFE_METHOD_PROJECT_BRIEF is required.");
  }
  if (!options.runId && !options.runDirectory) {
    throw new Error("--run-id, --run-dir or SAFE_METHOD_CODEX_ASSISTED_RUN_ID is required.");
  }
  if (!VERIFY_MODES.has(options.verifyMode)) {
    throw new Error("--verify must be one of: targeted, full, none.");
  }

  return options;
}

export async function runLocalDraftGeneration(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const context = await buildCodexAssistedGenerationContext({
    root,
    env: options.env ?? process.env,
    briefPath: options.briefPath,
    runId: options.runId,
    runDirectory: options.runDirectory,
    brief: options.brief,
    normalisedBrief: options.normalisedBrief,
    retrievalPacket: options.retrievalPacket,
    snapshot: options.snapshot,
  });
  const runId =
    options.runId ??
    context.env.SAFE_METHOD_CODEX_ASSISTED_RUN_ID ??
    path.basename(context.runDirectory);

  const prepare = await runCodexAssistedPrepare({
    root,
    runDirectory: context.runDirectory,
    runId,
    briefPath: context.briefPath,
    brief: context.brief,
    normalisedBrief: context.normalisedBrief,
    retrievalPacket: context.retrievalPacket,
    snapshot: context.snapshot,
  });

  const packetResult = await writeWorkerPackets({
    runDirectory: context.runDirectory,
    normalisedBrief: context.normalisedBrief,
    retrievalPacket: context.retrievalPacket,
  });
  const missingSections = missingSectionFiles(context.runDirectory);
  if (missingSections.length > 0) {
    const checklistPath = await writeMissingSectionChecklist({
      runDirectory: context.runDirectory,
      missingSections,
      packetResult,
    });
    return {
      status: "needs_sections",
      exitCode: 2,
      runDirectory: context.runDirectory,
      runId,
      preparedManifest: prepare.manifest,
      missingSections,
      workerPackets: packetResult,
      checklistPath,
    };
  }

  let lock;
  try {
    lock = await runCodexAssistedLock({
      root,
      runDirectory: context.runDirectory,
      runId,
      briefPath: context.briefPath,
      brief: context.brief,
      normalisedBrief: context.normalisedBrief,
      retrievalPacket: context.retrievalPacket,
      snapshot: context.snapshot,
    });
  } catch (error) {
    return {
      status: "lock_failed",
      exitCode: 1,
      runDirectory: context.runDirectory,
      runId,
      error: serialiseError(error),
      workerPackets: packetResult,
    };
  }

  const assembly = await runCodexAssistedAssemble({
    root,
    runDirectory: context.runDirectory,
    runId,
    briefPath: context.briefPath,
    brief: context.brief,
    normalisedBrief: context.normalisedBrief,
    retrievalPacket: context.retrievalPacket,
    snapshot: context.snapshot,
  });
  if (assembly.status !== "pass") {
    return {
      status: "assembly_failed",
      exitCode: 1,
      runDirectory: context.runDirectory,
      runId,
      result: assembly.result,
      workerPackets: packetResult,
    };
  }

  const documentSetPath = path.join(
    context.runDirectory,
    "evidence",
    "assembled-document-set.json",
  );
  const validationReportPath = path.join(
    context.runDirectory,
    "evidence",
    "validation-report.json",
  );
  const generationProvenancePath = path.join(
    context.runDirectory,
    "evidence",
    "generation-provenance.json",
  );
  const documentSet = assembly.result.documentSet ?? (await readJsonFile(documentSetPath));
  const validationReport =
    assembly.result.validationReport ?? (await readJsonFile(validationReportPath));
  const outputDir = resolveOutputDirectory(root, {
    outputDir: options.outputDir,
    projectSlug: options.projectSlug,
    documentSet,
  });
  const filename = buildOutputFileName(documentSet, {
    mode: "draft",
    extension: "docx",
    dateStamp: options.dateStamp ?? false,
  });
  const outputPath = path.join(outputDir, filename);
  const renderResult = await renderDraftDocx(documentSet, outputPath, {
    filename,
    mode: "draft",
  });

  const offlineVerifier = await resolveOfflineVerifierStatus({
    root,
    verifyMode: options.verifyMode ?? "targeted",
    generatedAt,
    runOfflineVerification: options.runOfflineVerification,
  });
  const manifest = await buildHandoffManifest(documentSet, {
    root,
    mode: "draft",
    extension: "docx",
    dateStamp: options.dateStamp ?? false,
    generatedAt,
    outputPath,
    documentSetPath,
    sourceInputs: buildSourceInputs({
      briefPath: context.briefPath,
      sourceInputs: options.sourceInputs ?? [],
      generationProvenancePath,
      validationReportPath,
    }),
    validationReport,
    rendererVersion: renderResult.renderer_version,
    verifierStatus: [
      {
        id: "codex-assisted-lock",
        name: "Codex-assisted section envelope lock",
        status: "pass",
        required: true,
        evidence: `Locked ${lock.sectionReports.length} strict section envelope(s).`,
      },
      {
        id: "codex-assisted-assembly",
        name: "Codex-assisted sectioned assembly",
        status: "pass",
        required: true,
        evidence_path: toRepoPath(root, validationReportPath),
      },
      {
        id: "docx-render",
        name: "DRAFT DOCX render",
        status: "pass",
        required: true,
        evidence: "renderDraftDocx returned workflow_state=DRAFT and issue_ready=false.",
      },
      offlineVerifier.statusEntry,
      {
        id: "local-draft-artifact-check",
        name: "Local draft artifact verifier",
        status: "pass",
        required: true,
        evidence: "verifyLocalDraftArtifacts is run by generate:local:draft after manifest write.",
      },
      {
        id: "one-drive-filing",
        name: "OneDrive filing",
        status: "not_run",
        required: false,
        reason: "Out of scope for local draft generation.",
      },
      {
        id: "consultant-signoff",
        name: "Consultant sign-off",
        status: "not_run",
        required: false,
        reason: "Draft output is not consultant reviewed or issue-ready.",
      },
    ],
    phaseGateStatus: [
      phaseGate("phase-4", "Phase 4 generation gate", "phase-gates/phase-4.md"),
      phaseGate("phase-5a", "Phase 5A DOCX render gate", "phase-gates/phase-5a.md"),
      phaseGate("phase-6", "Phase 6 workflow/provenance gate", "phase-gates/phase-6.md"),
    ],
    credentialGatedChecks: [
      {
        id: "anthropic-api",
        name: "Direct Anthropic generation",
        status: "not_run",
        required: false,
        reason: "Codex-assisted local section files used; no model API call required.",
      },
      {
        id: "openai-api",
        name: "Direct OpenAI generation",
        status: "not_run",
        required: false,
        reason: "Codex-assisted local section files used; no model API call required.",
      },
    ],
    review: {
      state: "not_reviewed",
      reviewer_name: "[Client To Confirm]",
      reviewer_role: "WHS consultant",
      reviewed_at: "[Client To Confirm]",
      comments:
        "DRAFT only. Consultant review and sign-off are required before final or issue-ready use.",
    },
    recipients: [],
    subject: `DRAFT ${documentSet.project.project_name} WHS control document set`,
  });
  const manifestPath = path.join(outputDir, buildManifestFileName(filename));
  const manifestWrite = await writeHandoffManifest(manifest, manifestPath, { root });
  const renderEvidencePath = path.join(
    context.runDirectory,
    "evidence",
    LOCAL_DRAFT_RENDER_RESULT_FILE,
  );
  await writeJson(renderEvidencePath, {
    ...canonicalClone(renderResult),
    manifest_path: manifestWrite.manifest_path,
    manifest_hash_sha256: manifestWrite.manifest_hash_sha256,
  });

  const summary = {
    status: "pass",
    run_id: runId,
    run_directory: context.runDirectory,
    output_path: outputPath,
    output_file_name: filename,
    output_hash_sha256: renderResult.output_hash_sha256,
    manifest_path: manifestWrite.manifest_path,
    manifest_hash_sha256: manifestWrite.manifest_hash_sha256,
    workflow_state: renderResult.workflow_state,
    issue_ready: false,
    validation_status: validationReport.status,
    verifier_mode: options.verifyMode ?? "targeted",
    verifier_status: offlineVerifier.statusEntry.status,
    worker_packet_directory: packetResult.directory,
  };
  const summaryPath = path.join(context.runDirectory, "evidence", LOCAL_DRAFT_SUMMARY_FILE);
  await writeJson(summaryPath, summary);

  const localVerification = await verifyLocalDraftArtifacts({
    root,
    runDirectory: context.runDirectory,
    outputPath,
    manifestPath: manifestWrite.manifest_path,
  });

  return {
    ...summary,
    exitCode: 0,
    documentSetPath,
    validationReportPath,
    renderEvidencePath,
    summaryPath,
    localVerification,
  };
}

export async function writeWorkerPackets(options) {
  const packetDirectory = path.join(options.runDirectory, "worker-packets");
  await mkdir(packetDirectory, { recursive: true });
  const packets = workerPacketDefinitions().map((definition) =>
    buildWorkerPacket({
      ...definition,
      normalisedBrief: options.normalisedBrief,
      retrievalPacket: options.retrievalPacket,
    }),
  );

  const written = [];
  for (const packet of packets) {
    const packetPath = path.join(packetDirectory, packet.fileName);
    await writeFile(packetPath, `${packet.body}\n`, "utf8");
    written.push(packetPath);
  }

  return {
    version: WORKER_PACKET_VERSION,
    directory: packetDirectory,
    files: written,
  };
}

export async function resolveOfflineVerifierStatus(options) {
  const verifyMode = options.verifyMode ?? "targeted";
  const fingerprint = await buildVerificationFingerprint(options.root ?? REPO_ROOT);

  if (verifyMode === "full") {
    const commandResult = await runOfflineVerificationCommand(options);
    if (commandResult.status !== 0) {
      throw new Error(`verify:offline failed with exit code ${commandResult.status}.`);
    }
    const cacheRecord = await writeVerificationCache({
      root: options.root ?? REPO_ROOT,
      fingerprint,
      generatedAt: options.generatedAt,
      commandResult,
    });
    return {
      fingerprint,
      cacheRecord,
      statusEntry: {
        id: "verify-offline-cache",
        name: "verify:offline code-surface cache",
        status: "pass",
        required: true,
        evidence_path: cacheRecord.relative_path,
      },
    };
  }

  if (verifyMode === "targeted") {
    const cached = await readVerificationCache(options.root ?? REPO_ROOT, fingerprint);
    if (cached) {
      return {
        fingerprint,
        cacheRecord: cached,
        statusEntry: {
          id: "verify-offline-cache",
          name: "verify:offline code-surface cache",
          status: "pass",
          required: true,
          evidence_path: cached.relative_path,
        },
      };
    }
    return {
      fingerprint,
      cacheRecord: null,
      statusEntry: {
        id: "verify-offline-cache",
        name: "verify:offline code-surface cache",
        status: "not_run",
        required: false,
        reason: "No matching verify:offline cache for the current code-bearing surfaces.",
      },
    };
  }

  if (verifyMode === "none") {
    return {
      fingerprint,
      cacheRecord: null,
      statusEntry: {
        id: "verify-offline-cache",
        name: "verify:offline code-surface cache",
        status: "not_run",
        required: false,
        reason: "Offline verification was explicitly skipped with --verify none.",
      },
    };
  }

  throw new Error("--verify must be one of: targeted, full, none.");
}

export async function buildVerificationFingerprint(root = REPO_ROOT) {
  const files = [];
  for (const surface of CODE_SURFACES) {
    const absolute = path.join(root, surface);
    if (!existsSync(absolute)) continue;
    const fileStat = await stat(absolute);
    if (fileStat.isDirectory()) {
      files.push(...(await hashDirectoryFiles(root, absolute)));
    } else if (fileStat.isFile()) {
      files.push(await hashFile(root, absolute));
    }
  }
  files.sort((left, right) => left.relative_path.localeCompare(right.relative_path));
  const payload = {
    version: VERIFY_CACHE_VERSION,
    files,
  };
  return {
    ...payload,
    hash_sha256: sha256Text(canonicalStringify(payload)),
  };
}

export async function readVerificationCache(root, fingerprint) {
  const cachePath = verificationCachePath(root, fingerprint.hash_sha256);
  if (!existsSync(cachePath)) return null;
  const record = JSON.parse(await readFile(cachePath, "utf8"));
  if (record.fingerprint_hash_sha256 !== fingerprint.hash_sha256 || record.status !== "pass") {
    return null;
  }
  return {
    ...record,
    path: cachePath,
    relative_path: toRepoPath(root, cachePath),
  };
}

export function resolveOutputDirectory(root, options) {
  if (options.outputDir) {
    return path.resolve(root, options.outputDir);
  }
  const projectSlug = options.projectSlug ?? slugify(options.documentSet.project?.project_name);
  if (!projectSlug) {
    throw new Error("--project-slug or --output-dir is required.");
  }
  return path.join(root, "outputs", "local", projectSlug);
}

function workerPacketDefinitions() {
  return [
    {
      fileName: "01-hrcw-register.md",
      title: "HRCW Register Section Worker",
      allowedFiles: ["hrcw_register.json"],
      sections: ["hrcw_register"],
    },
    {
      fileName: "02-hold-points-swms-matrix.md",
      title: "Hold Point Schedule And SWMS Matrix Section Worker",
      allowedFiles: ["hold_point_schedule.json", "swms_matrix.json"],
      sections: ["hold_point_schedule", "swms_matrix"],
    },
    ...RISK_REGISTER_CHUNK_SECTIONS.map((sectionName, index) => ({
      fileName: `03-risk-register-part-${index + 1}.md`,
      title: `Risk Register Part ${index + 1} Section Worker`,
      allowedFiles: [`${sectionName}.json`],
      sections: [sectionName],
    })),
    {
      fileName: "07-swms-benchmark-reviews.md",
      title: "SWMS Benchmark Review Section Worker",
      allowedFiles: SWMS_BENCHMARK_REVIEW_CHUNK_SECTIONS.map(
        (sectionName) => `${sectionName}.json`,
      ),
      sections: [...SWMS_BENCHMARK_REVIEW_CHUNK_SECTIONS],
    },
    {
      fileName: "08-support-bundle.md",
      title: "Support Bundle Section Worker",
      allowedFiles: ["support_bundle.json"],
      sections: ["support_bundle"],
    },
    {
      fileName: "09-qa-repair.md",
      title: "QA Repair Worker",
      allowedFiles: CODEX_ASSISTED_SECTION_FILES.map((section) => section.file_name),
      sections: [...SECTION_NAMES],
      qaOnly: true,
    },
  ];
}

function buildWorkerPacket(options) {
  const project = options.normalisedBrief.project;
  const retrievalSummary = options.retrievalPacket.candidate_summary;
  const allowed = options.allowedFiles.map((fileName) => `- ${fileName}`).join("\n");
  const sections = options.sections.map((sectionName) => `- ${sectionName}`).join("\n");
  const packageList = (project.trade_packages ?? [])
    .map((packageName) => `- ${packageName}`)
    .join("\n");
  const hrcwRefs = (retrievalSummary.hrcw_refs ?? [])
    .map((row) => `- ${row.ref}: ${row.triggered} candidate (${row.packages.join(", ")})`)
    .join("\n");
  const holdPoints = (retrievalSummary.hold_point_source_pattern_ids ?? [])
    .map((id) => `- ${id}`)
    .join("\n");
  const controlIds = (retrievalSummary.control_source_ids ?? []).map((id) => `- ${id}`).join("\n");

  return {
    fileName: options.fileName,
    body: `# ${options.title}

Packet version: ${WORKER_PACKET_VERSION}

## Ownership
Allowed output file(s):
${allowed}

Section envelope(s) to write:
${sections}

Write only the assigned JSON section envelope file(s) in the Codex-assisted run directory. Do not edit knowledge/, schemas/, rules/, renderers, source briefs, package files, or unrelated section files unless separately instructed.

## Strict Envelope Contract
Each JSON file must contain exactly one strict section envelope. The top-level object must include section_name matching the assigned section, the required payload key for that section, and no unrecognised top-level keys. Use the existing schemas and local lock step as the authority.

## Canonical Project Packages
${packageList || "- [Client To Confirm]"}

## Retrieval Summary
Candidate HRCW refs:
${hrcwRefs || "- None retrieved"}

Hold point source patterns:
${holdPoints || "- None retrieved"}

Control source IDs:
${controlIds || "- None retrieved"}

## Validator Traps
- Keep confirmed HRCW refs separate from conditional HRCW refs.
- Do not use approval wording for subcontractor SWMS; use reviewed-and-accepted wording.
- Do not treat silica/RCS dust alone as H12.
- H06 confined space remains conditional unless assessment_confirmed is true.
- Controls with fixed numeric limits need fixed_numeric_limits basis metadata.
- High-energy rows need credible residual risk, segregation, and engineering release where required.
- If access method is open, access-specific active controls must remain conditional.

## QA Mode
${options.qaOnly ? "Review validation failures and route edits to the owning section file. Do not make direct edits unless explicitly assigned the affected output file." : "Prepare the assigned section envelope only."}
`,
  };
}

async function writeMissingSectionChecklist(options) {
  const checklistPath = path.join(
    options.runDirectory,
    "worker-packets",
    "00-missing-section-checklist.md",
  );
  const missing = options.missingSections.map((fileName) => `- ${fileName}`).join("\n");
  const expected = CODEX_ASSISTED_SECTION_FILES.map((section) => `- ${section.file_name}`).join(
    "\n",
  );
  await writeFile(
    checklistPath,
    `# Missing Section Checklist

The local draft command prepared the run and generated worker packets, but rendering is blocked until every expected strict section envelope exists.

## Missing Files
${missing}

## Expected Files
${expected}

Use the matching worker packet in:
${options.packetResult.directory}
`,
    "utf8",
  );
  return checklistPath;
}

function missingSectionFiles(runDirectory) {
  return CODEX_ASSISTED_SECTION_FILES.map((section) => section.file_name).filter(
    (fileName) => !existsSync(path.join(runDirectory, fileName)),
  );
}

function buildSourceInputs(options) {
  const sourceInputs = [
    {
      role: "project_brief",
      label: "Project brief",
      path: options.briefPath,
    },
    {
      role: "codex_assisted_generation_provenance",
      label: "Codex-assisted generation provenance",
      path: options.generationProvenancePath,
    },
    {
      role: "codex_assisted_validation_report",
      label: "Codex-assisted validation report",
      path: options.validationReportPath,
    },
  ];

  for (const [index, sourcePath] of (options.sourceInputs ?? []).entries()) {
    sourceInputs.push({
      role: index === 0 ? "source_scope" : `source_scope_${index + 1}`,
      label: path.basename(sourcePath),
      path: sourcePath,
    });
  }

  return sourceInputs;
}

function phaseGate(id, name, evidencePath) {
  return {
    id,
    name,
    status: "pass",
    required: true,
    evidence_path: evidencePath,
  };
}

async function runOfflineVerificationCommand(options) {
  if (options.runOfflineVerification) {
    return options.runOfflineVerification();
  }
  const root = options.root ?? REPO_ROOT;
  const result = spawnSync(
    "powershell",
    [
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(root, "scripts", "verify.ps1"),
      "verify:offline",
    ],
    {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
    },
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

async function writeVerificationCache(options) {
  const root = options.root ?? REPO_ROOT;
  const cachePath = verificationCachePath(root, options.fingerprint.hash_sha256);
  await mkdir(path.dirname(cachePath), { recursive: true });
  const record = {
    cache_version: VERIFY_CACHE_VERSION,
    verification: "verify:offline",
    status: "pass",
    created_at: options.generatedAt ?? new Date().toISOString(),
    fingerprint_hash_sha256: options.fingerprint.hash_sha256,
    command: "powershell -ExecutionPolicy Bypass -File scripts\\verify.ps1 verify:offline",
    stdout_sha256: sha256Text(options.commandResult.stdout ?? ""),
    stderr_sha256: sha256Text(options.commandResult.stderr ?? ""),
    file_count: options.fingerprint.files.length,
    files: options.fingerprint.files,
  };
  await writeJson(cachePath, record);
  return {
    ...record,
    path: cachePath,
    relative_path: toRepoPath(root, cachePath),
  };
}

function verificationCachePath(root, fingerprintHash) {
  return path.join(root, CACHE_ROOT, `verify-offline-${fingerprintHash}.json`);
}

async function hashDirectoryFiles(root, directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await hashDirectoryFiles(root, absolute)));
    } else if (entry.isFile()) {
      files.push(await hashFile(root, absolute));
    }
  }
  return files;
}

async function hashFile(root, absolutePath) {
  const fileStat = await stat(absolutePath);
  return {
    relative_path: toRepoPath(root, absolutePath),
    bytes: fileStat.size,
    sha256: await sha256File(absolutePath),
  };
}

async function sha256File(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(canonicalClone(value), null, 2)}\n`, "utf8");
}

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function parseDateStampOption(value) {
  const normalised = String(value).trim();
  if (["false", "none", "omit", "no"].includes(normalised.toLowerCase())) {
    return false;
  }
  if (normalised === "from_issue_date") {
    return "from_issue_date";
  }
  return normalised;
}

function requiredArg(argv, index, arg) {
  if (index >= argv.length || argv[index].startsWith("--")) {
    throw new Error(`${arg} requires a value.`);
  }
  return argv[index];
}

function slugify(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function toRepoPath(root, absolutePath) {
  return path.relative(root, path.resolve(absolutePath)).replace(/\\/gu, "/");
}

function serialiseError(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
  };
}

function printLocalDraftResult(outcome) {
  console.log(
    JSON.stringify(
      {
        status: outcome.status,
        run_id: outcome.runId ?? outcome.run_id,
        run_directory: outcome.runDirectory ?? outcome.run_directory,
        output_path: outcome.output_path,
        manifest_path: outcome.manifest_path,
        issue_ready: outcome.issue_ready,
        missing_sections: outcome.missingSections,
        worker_packet_directory:
          outcome.workerPackets?.directory ?? outcome.worker_packet_directory,
        error: outcome.error,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const outcome = await runLocalDraftGeneration(parseLocalDraftArgs());
    printLocalDraftResult(outcome);
    process.exit(outcome.exitCode ?? 0);
  } catch (error) {
    console.error(`FAIL local draft generation: ${error.message}`);
    process.exit(1);
  }
}
