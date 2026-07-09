import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildOutputFileName } from "../app/handoff-manifest.mjs";
import { renderDraftXlsx } from "../render/xlsx-renderer.mjs";
import { readJson, REPO_ROOT } from "./kb-source.mjs";

export const SAMPLE_DOCUMENT_SET = "fixtures/golden/document-sets/sample-document-set.json";

export async function renderSampleXlsx(outputDir) {
  await mkdir(outputDir, { recursive: true });
  const documentSet = await readJson(REPO_ROOT, SAMPLE_DOCUMENT_SET);
  const outputFileName = buildOutputFileName(documentSet, { mode: "draft", extension: "xlsx" });
  const outputXlsx = path.join(outputDir, outputFileName);
  const renderResult = await renderDraftXlsx(documentSet, outputXlsx, {
    filename: outputFileName,
  });
  return { documentSet, outputFileName, outputXlsx, renderResult };
}

export async function cleanDirectory(directory) {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
}

export function findSoffice() {
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

export async function recalculateWithLibreOffice(inputXlsx, outputDir, profileDir) {
  await mkdir(outputDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });
  const soffice = findSoffice();
  if (!soffice) {
    throw new Error(
      "LibreOffice/soffice is required for Phase 5B recalculation. Install LibreOffice or set SOFFICE_PATH.",
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
      `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
      "--convert-to",
      "xlsx",
      "--outdir",
      outputDir,
      inputXlsx,
    ],
    { encoding: "utf8" },
  );

  if (result.error) {
    throw new Error(`LibreOffice could not launch at ${soffice}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const diagnostic = `${result.stderr || ""}${result.stdout || ""}`.trim();
    throw new Error(
      `LibreOffice XLSX recalculation failed at ${soffice} with exit ${result.status}: ${
        diagnostic || "<no stdout/stderr>"
      }`,
    );
  }

  const recalculatedPath = path.join(outputDir, path.basename(inputXlsx));
  if (!existsSync(recalculatedPath)) {
    throw new Error(`LibreOffice did not create recalculated workbook ${recalculatedPath}`);
  }
  const bytes = statSync(recalculatedPath).size;
  if (bytes <= 0) {
    throw new Error(`LibreOffice created an empty workbook at ${recalculatedPath}`);
  }

  return { recalculatedPath, bytes, soffice };
}
