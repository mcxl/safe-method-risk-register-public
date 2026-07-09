import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { scanRecalculatedXlsxValues } from "../render/xlsx-renderer.mjs";
import { REPO_ROOT } from "./kb-source.mjs";
import { cleanDirectory, renderSampleXlsx } from "./xlsx-verification-utils.mjs";

if (process.platform !== "win32") {
  throw new Error(
    "Microsoft Excel CalculateFullRebuild gate requires Windows Excel COM automation.",
  );
}

const OUTPUT_DIR = path.join(REPO_ROOT, "outputs", "tmp", "phase5b-excel");
const EXCEL_DIR = path.join(OUTPUT_DIR, "excel-recalculated");
await cleanDirectory(OUTPUT_DIR);
await mkdir(EXCEL_DIR, { recursive: true });

const { outputXlsx, outputFileName } = await renderSampleXlsx(OUTPUT_DIR);
const excelPath = path.join(EXCEL_DIR, outputFileName);
await copyFile(outputXlsx, excelPath);

const result = spawnSync(
  "powershell",
  [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(REPO_ROOT, "scripts", "verify-xlsx-excel.ps1"),
    "-WorkbookPath",
    excelPath,
  ],
  { cwd: REPO_ROOT, encoding: "utf8", timeout: 120000 },
);

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  throw new Error(`Excel CalculateFullRebuild failed: ${result.stderr || result.stdout}`);
}

const scan = await scanRecalculatedXlsxValues(excelPath);
assert.equal(scan.status, "pass", JSON.stringify(scan.errors, null, 2));
console.log(result.stdout.trim());
console.log("PHASE 5B XLSX EXCEL GATE: PASS");
