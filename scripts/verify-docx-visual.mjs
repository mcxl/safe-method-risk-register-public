import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildOutputFileName } from "../app/handoff-manifest.mjs";
import { renderDraftDocx } from "../render/docx-renderer.mjs";
import { readJson, REPO_ROOT } from "./kb-source.mjs";

const UNITAS_DOCUMENT_SET = "fixtures/golden/document-sets/unitas-document-set.json";
const OUTPUT_DIR = path.join(REPO_ROOT, "outputs", "tmp", "phase5a-visual");
const RENDER_DIR = path.join(OUTPUT_DIR, "libreoffice-pdf");
const PROFILE_DIR = path.join(OUTPUT_DIR, ".lo-profile");

await rm(OUTPUT_DIR, { recursive: true, force: true });
await mkdir(RENDER_DIR, { recursive: true });
await mkdir(PROFILE_DIR, { recursive: true });

const documentSet = await readJson(REPO_ROOT, UNITAS_DOCUMENT_SET);
const outputFileName = buildOutputFileName(documentSet, { mode: "draft" });
const outputDocx = path.join(OUTPUT_DIR, outputFileName);
const renderResult = await renderDraftDocx(documentSet, outputDocx, { filename: outputFileName });

assert.equal(renderResult.workflow_state, "DRAFT");
assert.equal(renderResult.issue_ready, false);
assert.equal(existsSync(outputDocx), true);
assert.ok(statSync(outputDocx).size > 0);

const soffice = findSoffice();
if (!soffice) {
  throw new Error(
    "LibreOffice/soffice is required for Phase 5A visual QA. Install LibreOffice or set SOFFICE_PATH.",
  );
}

const result = spawnSync(
  soffice,
  [
    "--headless",
    "--norestore",
    "--nolockcheck",
    "--nodefault",
    "--nofirststartwizard",
    `-env:UserInstallation=${pathToFileURL(PROFILE_DIR).href}`,
    "--convert-to",
    "pdf",
    "--outdir",
    RENDER_DIR,
    outputDocx,
  ],
  { encoding: "utf8" },
);

if (result.error) {
  throw new Error(`LibreOffice could not launch at ${soffice}: ${result.error.message}`);
}

if (result.status !== 0) {
  const diagnostic = `${result.stderr || ""}${result.stdout || ""}`.trim();
  throw new Error(
    `LibreOffice visual conversion failed at ${soffice} with exit ${result.status}: ${
      diagnostic || "<no stdout/stderr>"
    }`,
  );
}

const pdfPath = path.join(RENDER_DIR, `${path.basename(outputDocx, ".docx")}.pdf`);
assert.equal(existsSync(pdfPath), true, `LibreOffice did not create ${pdfPath}`);
const pdfBytes = statSync(pdfPath).size;
assert.ok(pdfBytes > 0, `LibreOffice created an empty PDF at ${pdfPath}`);

console.log(`PASS LibreOffice converted DRAFT DOCX to PDF: ${pdfPath} (${pdfBytes} bytes)`);
console.log("PHASE 5A DOCX VISUAL GATE: PASS");

function findSoffice() {
  const configuredPath = process.env.SOFFICE_PATH?.trim();
  if (configuredPath) {
    return existsSync(configuredPath) ? configuredPath : null;
  }

  const command = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(command, ["soffice"], { encoding: "utf8" });
  if (result.status !== 0) {
    return null;
  }
  const candidates = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  if (process.platform === "win32") {
    return candidates.find((line) => line.toLowerCase().endsWith("soffice.exe")) ?? candidates[0];
  }
  return candidates[0] ?? null;
}
