import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { GENERATION_PIPELINE_VERSION, PROMPT_VERSION } from "../generate/pipeline.mjs";
import {
  DOCX_RENDERER_VERSION,
  RenderValidationError,
  assertDocumentSetRenderable,
} from "../render/docx-renderer.mjs";
import { REPO_ROOT, sha256Canonical } from "../scripts/kb-source.mjs";

export const HANDOFF_MANIFEST_VERSION = "phase5a.handoff-manifest.v1";
export const DEFAULT_UNRESOLVED_MARKERS = Object.freeze(["[Client To Confirm]"]);
export const DEFAULT_OUTPUT_EXTENSION = "docx";
export const SUPPORTED_OUTPUT_EXTENSIONS = Object.freeze(["docx", "xlsx"]);

const MONTHS = Object.freeze({
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
});

export async function buildHandoffManifest(documentSet, options = {}) {
  const root = options.root ?? REPO_ROOT;
  const generatedAt = requireGeneratedAt(options.generatedAt);
  const outputMode = normaliseOutputMode(options.mode ?? "draft");
  const extension = normaliseExtension(options.extension ?? DEFAULT_OUTPUT_EXTENSION);
  const expectedFileName = buildOutputFileName(documentSet, {
    mode: outputMode,
    extension,
    dateStamp: options.dateStamp,
  });
  const outputPath = options.outputPath ? path.resolve(root, options.outputPath) : null;
  const output = await describeOutput(outputPath, expectedFileName, extension, root);
  const validationReport =
    options.validationReport ?? getValidationReport(documentSet, { mode: outputMode });
  const validation = summariseValidationReport(validationReport);
  const unresolvedMarkers = countUnresolvedMarkers(
    documentSet,
    options.unresolvedMarkers ?? DEFAULT_UNRESOLVED_MARKERS,
  );
  const verifierStatus = normaliseStatusList(options.verifierStatus ?? []);
  const phaseGateStatus = normaliseStatusList(options.phaseGateStatus ?? []);
  const review = normaliseReview(options.review);
  const recipients = normaliseStringList(options.recipients ?? []);
  const subject = options.subject ?? buildDefaultSubject(documentSet, outputMode);
  const sourceInputs = await describeSourceInputs(root, [
    ...(options.documentSetPath
      ? [{ role: "document_set", label: "Document set JSON", path: options.documentSetPath }]
      : []),
    ...(options.sourceInputs ?? []),
  ]);
  const dateStamp = resolveDateStamp(documentSet, options.dateStamp);
  const preflight = buildPreflight({
    outputMode,
    output,
    validation,
    review,
    verifierStatus,
    phaseGateStatus,
    recipients,
    subject,
    unresolvedMarkers,
    confirmationItems: documentSet.confirmation_items ?? [],
  });

  return {
    manifest_version: HANDOFF_MANIFEST_VERSION,
    generated_at: generatedAt,
    output_mode: outputMode,
    issue_ready: preflight.issue_ready,
    document: {
      project_name: documentSet.project?.project_name ?? "[Client To Confirm]",
      document_ref: documentSet.project?.document_ref ?? "[Client To Confirm]",
      revision: documentSet.project?.revision ?? "[Client To Confirm]",
      issue_date: documentSet.project?.issue_date ?? "[Client To Confirm]",
      date_stamp: dateStamp,
    },
    handoff: {
      recipients,
      subject,
    },
    output,
    source_inputs: sourceInputs,
    hashes: {
      document_set_canonical_sha256: sha256Canonical(documentSet),
      schemas: await hashDirectory(root, "schemas", (name) => name.endsWith(".schema.json")),
      rules: await hashDirectory(root, "rules", (name) => name.endsWith(".mjs")),
      generator: {
        version: GENERATION_PIPELINE_VERSION,
        prompt_version: PROMPT_VERSION,
      },
      renderer: {
        version: options.rendererVersion ?? DOCX_RENDERER_VERSION,
      },
    },
    unresolved_markers: unresolvedMarkers,
    validation,
    verifier_status: verifierStatus,
    phase_gate_status: phaseGateStatus,
    skipped_checks: verifierStatus
      .filter((entry) => entry.status === "skip" || entry.status === "not_run")
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        status: entry.status,
        reason: entry.reason ?? "[Client To Confirm]",
        required: entry.required,
      })),
    credential_gated_checks: normaliseStatusList(options.credentialGatedChecks ?? []),
    review,
    preflight,
  };
}

export function buildOutputFileName(documentSet, options = {}) {
  const outputMode = normaliseOutputMode(options.mode ?? "draft");
  const extension = normaliseExtension(options.extension ?? DEFAULT_OUTPUT_EXTENSION);
  const dateStamp = resolveDateStamp(documentSet, options.dateStamp);
  const documentRef = cleanValue(documentSet.project?.document_ref);
  const baseParts = documentRef
    ? [documentRef]
    : [documentSet.project?.project_name, documentSet.project?.revision];
  const slug = baseParts
    .map((part) => slugify(part))
    .filter(Boolean)
    .join("-");
  const parts = [
    slug || "safe-method",
    dateStamp.value,
    outputMode,
    "whs-control-document-set",
  ].filter(Boolean);

  return `${parts.join("-")}.${extension}`;
}

export function buildManifestFileName(outputFileName) {
  return outputFileName.replace(/\.[^.]+$/u, ".manifest.json");
}

export async function writeHandoffManifest(manifest, manifestPath, options = {}) {
  const root = options.root ?? REPO_ROOT;
  const resolvedPath = path.resolve(root, manifestPath);
  await mkdir(path.dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return {
    manifest_path: resolvedPath,
    manifest_hash_sha256: await sha256File(resolvedPath),
  };
}

export function countUnresolvedMarkers(value, markers = DEFAULT_UNRESOLVED_MARKERS) {
  const markerCounts = new Map(markers.map((marker) => [marker, 0]));
  const locations = [];

  for (const node of collectTextNodes(value)) {
    for (const marker of markers) {
      const count = countOccurrences(node.value, marker);
      if (count > 0) {
        markerCounts.set(marker, markerCounts.get(marker) + count);
        locations.push({
          marker,
          json_path: node.path,
          count,
        });
      }
    }
  }

  return {
    total: [...markerCounts.values()].reduce((sum, count) => sum + count, 0),
    markers: [...markerCounts.entries()].map(([marker, count]) => ({ marker, count })),
    locations,
  };
}

export function resolveDateStamp(documentSet, dateStamp = false) {
  if (dateStamp === false || dateStamp === null || dateStamp === undefined) {
    return { source: "omitted", value: null };
  }

  if (dateStamp === true || dateStamp === "from_issue_date") {
    return {
      source: "project.issue_date",
      value: normaliseDateStamp(documentSet.project?.issue_date),
    };
  }

  if (typeof dateStamp === "string") {
    return {
      source: "explicit",
      value: normaliseDateStamp(dateStamp),
    };
  }

  throw new Error("dateStamp must be false, true, 'from_issue_date' or a date string.");
}

export function normaliseDateStamp(value) {
  const text = cleanValue(value);
  if (!text || text === "[Client To Confirm]") {
    throw new Error("A concrete date is required for a date-stamped output name.");
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text);
  if (iso) {
    const [, year, month, day] = iso;
    assertValidIsoDate(year, month, day);
    return `${year}-${month}-${day}`;
  }

  const longDate = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/u.exec(text);
  if (longDate) {
    const [, rawDay, rawMonth, year] = longDate;
    const month = MONTHS[rawMonth.toLowerCase()];
    if (!month) {
      throw new Error(`Unsupported date month '${rawMonth}'.`);
    }
    const day = rawDay.padStart(2, "0");
    assertValidIsoDate(year, month, day);
    return `${year}-${month}-${day}`;
  }

  throw new Error(`Unsupported date stamp '${text}'. Use YYYY-MM-DD or 'D Month YYYY'.`);
}

function buildPreflight(options) {
  const checks = [];
  addCheck(
    checks,
    "VALIDATION-PASS",
    options.validation.status === "pass",
    "Document-set schema and deterministic validators must pass before output handoff.",
  );
  addCheck(
    checks,
    "OUTPUT-EXISTS",
    options.output.exists === true,
    "Rendered output must exist before handoff.",
  );
  addCheck(
    checks,
    "OUTPUT-NAMING",
    options.output.file_name === options.output.expected_file_name,
    "Rendered output filename must match the deterministic naming rule.",
  );
  checks.push({
    id: "UNRESOLVED-MARKERS",
    status: options.unresolvedMarkers.total > 0 ? "warning" : "pass",
    message:
      options.unresolvedMarkers.total > 0
        ? `${options.unresolvedMarkers.total} unresolved marker(s) remain; issue with placeholders is allowed only when reported.`
        : "No unresolved placeholder markers detected.",
  });

  if (options.outputMode === "final") {
    addCheck(
      checks,
      "REVIEW-SIGNOFF",
      options.review.state === "accepted_for_issue" &&
        cleanValue(options.review.reviewer_name) &&
        cleanValue(options.review.reviewed_at),
      "Final issue requires consultant review acceptance with reviewer identity and timestamp.",
    );
    addCheck(
      checks,
      "PHASE-GATES",
      options.phaseGateStatus.length > 0 &&
        options.phaseGateStatus.every(
          (entry) => entry.required === false || entry.status === "pass",
        ),
      "Final issue requires supplied required phase gates to be pass.",
    );
    addCheck(
      checks,
      "VERIFIERS",
      options.verifierStatus.length > 0 &&
        options.verifierStatus.every(
          (entry) => entry.required === false || entry.status === "pass",
        ),
      "Final issue requires supplied required verifiers to be pass.",
    );
    addCheck(
      checks,
      "HANDOFF-RECIPIENTS",
      options.recipients.length > 0,
      "Final handoff requires at least one recipient.",
    );
    addCheck(
      checks,
      "HANDOFF-SUBJECT",
      cleanValue(options.subject),
      "Final handoff requires a subject line.",
    );
    addCheck(
      checks,
      "CONFIRMATION-ITEMS",
      (options.confirmationItems ?? []).every(
        (item) =>
          item.blocking_level === "advisory_only" ||
          item.status === "confirmed" ||
          item.status === "not_required",
      ),
      "Final issue requires all blocking confirmation items to be confirmed or not required.",
    );
  } else {
    checks.push({
      id: "DRAFT-MODE",
      status: "pass",
      message: "Draft handoff is not issue-ready and does not claim consultant sign-off.",
    });
  }

  const blocked = checks.some((check) => check.status === "fail");
  return {
    status: blocked ? "blocked" : "pass",
    issue_ready: options.outputMode === "final" && !blocked,
    checks,
  };
}

function getValidationReport(documentSet, options = {}) {
  try {
    return assertDocumentSetRenderable(documentSet, options);
  } catch (error) {
    if (error instanceof RenderValidationError) {
      return error.validationReport;
    }
    throw error;
  }
}

function summariseValidationReport(report) {
  const ruleResults = report.rules?.results ?? [];
  const failures = ruleResults.filter((result) => result.status === "fail");
  return {
    status: report.status,
    schema_status: report.schema?.status ?? "not_run",
    rule_status: report.rules?.status ?? "not_run",
    verdict: report.rules?.verdict ?? null,
    failure_count: failures.length,
    failures: failures.map((failure) => ({
      rule_id: failure.rule_id,
      suite: failure.suite,
      message: failure.message,
      json_path: failure.json_path ?? null,
    })),
  };
}

async function describeOutput(outputPath, expectedFileName, extension, root) {
  if (!outputPath) {
    return {
      exists: false,
      expected_file_name: expectedFileName,
      file_name: null,
      extension,
      relative_path: null,
      absolute_path: null,
      bytes: 0,
      sha256: null,
    };
  }

  const fileName = path.basename(outputPath);
  const relativePath = toRepoRelativePath(root, outputPath);
  const fileStat = await statOrNull(outputPath);
  return {
    exists: Boolean(fileStat?.isFile()),
    expected_file_name: expectedFileName,
    file_name: fileName,
    extension,
    relative_path: relativePath,
    absolute_path: outputPath,
    bytes: fileStat?.isFile() ? fileStat.size : 0,
    sha256: fileStat?.isFile() ? await sha256File(outputPath) : null,
  };
}

async function describeSourceInputs(root, inputs) {
  const described = [];
  for (const input of inputs) {
    const resolvedPath = input.path ? path.resolve(root, input.path) : null;
    const fileStat = resolvedPath ? await statOrNull(resolvedPath) : null;
    described.push({
      role: input.role ?? "source_input",
      label: input.label ?? input.role ?? "Source input",
      relative_path: resolvedPath ? toRepoRelativePath(root, resolvedPath) : null,
      absolute_path: resolvedPath,
      exists: resolvedPath ? Boolean(fileStat?.isFile()) : null,
      bytes: fileStat?.isFile() ? fileStat.size : null,
      sha256: fileStat?.isFile()
        ? await sha256File(resolvedPath)
        : input.value !== undefined
          ? sha256Canonical(input.value)
          : (input.sha256 ?? null),
    });
  }
  return described;
}

async function hashDirectory(root, relativeDirectory, predicate) {
  const directory = path.join(root, relativeDirectory);
  const names = (await readdir(directory)).filter(predicate).sort();
  const files = [];
  for (const name of names) {
    const relativePath = `${relativeDirectory}/${name}`;
    const absolutePath = path.join(root, relativePath);
    const fileStat = await stat(absolutePath);
    files.push({
      relative_path: relativePath,
      absolute_path: absolutePath,
      bytes: fileStat.size,
      sha256: await sha256File(absolutePath),
    });
  }
  return files;
}

function addCheck(checks, id, condition, message) {
  checks.push({
    id,
    status: condition ? "pass" : "fail",
    message,
  });
}

function normaliseOutputMode(mode) {
  const value = String(mode).trim().toLowerCase();
  if (value === "draft") return "draft";
  if (["final", "issue", "issued"].includes(value)) return "final";
  throw new Error(`Unsupported output mode '${mode}'. Use draft or final.`);
}

function normaliseExtension(extension) {
  const value = String(extension).trim().replace(/^\./u, "").toLowerCase();
  if (!SUPPORTED_OUTPUT_EXTENSIONS.includes(value)) {
    throw new Error(
      `Unsupported output extension '${extension}'. Use one of: ${SUPPORTED_OUTPUT_EXTENSIONS.join(
        ", ",
      )}.`,
    );
  }
  return value;
}

function normaliseStatusList(entries) {
  return entries.map((entry) => {
    const statusEntry = {
      id: cleanValue(entry.id) || cleanValue(entry.phase) || cleanValue(entry.name) || "unnamed",
      name: cleanValue(entry.name) || cleanValue(entry.id) || cleanValue(entry.phase) || "Unnamed",
      status: normaliseStatus(entry.status),
      required: entry.required !== false,
    };

    for (const key of ["phase", "evidence", "evidence_path", "reason"]) {
      const value = cleanValue(entry[key]);
      if (value) {
        statusEntry[key] = value;
      }
    }

    return statusEntry;
  });
}

function normaliseStatus(status) {
  const value = String(status ?? "not_run")
    .trim()
    .toLowerCase();
  if (["pass", "fail", "skip", "blocked", "not_run", "warning"].includes(value)) {
    return value;
  }
  throw new Error(`Unsupported status '${status}'.`);
}

function normaliseReview(review = {}) {
  return {
    state: review.state ?? "not_reviewed",
    reviewer_name: review.reviewer_name ?? null,
    reviewer_role: review.reviewer_role ?? null,
    reviewed_at: review.reviewed_at ?? null,
    comments: review.comments ?? null,
  };
}

function normaliseStringList(values) {
  return values.map((value) => String(value).trim()).filter(Boolean);
}

function buildDefaultSubject(documentSet, outputMode) {
  const ref =
    cleanValue(documentSet.project?.document_ref) || cleanValue(documentSet.project?.project_name);
  return `Safe Method Risk Register ${outputMode.toUpperCase()} handoff - ${ref || "[Client To Confirm]"}`;
}

function collectTextNodes(value, pathValue = "") {
  if (typeof value === "string") {
    return [{ value, path: pathValue || "/" }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectTextNodes(item, `${pathValue}/${index}`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) =>
      collectTextNodes(child, `${pathValue}/${key}`),
    );
  }
  return [];
}

function countOccurrences(value, marker) {
  if (!marker) return 0;
  return value.split(marker).length - 1;
}

function slugify(value) {
  return cleanValue(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^A-Za-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase();
}

function cleanValue(value) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

function requireGeneratedAt(value) {
  const text = cleanValue(value);
  if (!text) {
    throw new Error("generatedAt is required so manifest timestamps are deliberate.");
  }
  return text;
}

async function sha256File(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

async function statOrNull(filePath) {
  try {
    return await stat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function toRepoRelativePath(root, absolutePath) {
  return path.relative(root, absolutePath).replace(/\\/gu, "/");
}

function assertValidIsoDate(year, month, day) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() + 1 !== Number(month) ||
    date.getUTCDate() !== Number(day)
  ) {
    throw new Error(`Invalid date '${year}-${month}-${day}'.`);
  }
}
