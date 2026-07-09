import assert from "node:assert/strict";
import path from "node:path";

import { scanRecalculatedXlsxValues } from "../render/xlsx-renderer.mjs";
import { REPO_ROOT } from "./kb-source.mjs";
import {
  cleanDirectory,
  recalculateWithLibreOffice,
  renderUnitasXlsx,
} from "./xlsx-verification-utils.mjs";

const OUTPUT_DIR = path.join(REPO_ROOT, "outputs", "tmp", "phase5b-libreoffice");
const RECALC_DIR = path.join(OUTPUT_DIR, "recalculated");
const PROFILE_DIR = path.join(OUTPUT_DIR, ".lo-profile");

await cleanDirectory(OUTPUT_DIR);
const { outputXlsx } = await renderUnitasXlsx(OUTPUT_DIR);
const recalc = await recalculateWithLibreOffice(outputXlsx, RECALC_DIR, PROFILE_DIR);
const scan = await scanRecalculatedXlsxValues(recalc.recalculatedPath);

assert.equal(scan.status, "pass", JSON.stringify(scan.errors, null, 2));
console.log(
  `PASS LibreOffice recalculated DRAFT XLSX: ${recalc.recalculatedPath} (${recalc.bytes} bytes)`,
);
console.log("PHASE 5B XLSX LIBREOFFICE GATE: PASS");
