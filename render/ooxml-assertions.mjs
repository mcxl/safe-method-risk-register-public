import { readFile } from "node:fs/promises";
import path from "node:path";

import JSZip from "jszip";

import { DOCX_HOUSE_STYLE } from "./docx-renderer.mjs";

export const PHASE5A_EXPECTED_HEADINGS = Object.freeze([
  "Cover And Document Control",
  "HRCW Register",
  "SWMS Matrix",
  "Hold Point Schedule",
  "Project Risk Register",
  "Supporting Documents And Confirmation Items",
  "SWMS Review Benchmark Note And Verdict",
]);

const ALLOWED_TEXT_COLORS = new Set(["000000", "1F1F1F", "404040", "666666", "808080", "FFFFFF"]);
const ALLOWED_SHADING_FILLS = new Set([
  "000000",
  "1F1F1F",
  "404040",
  "666666",
  "808080",
  "F2F2F2",
  "FFFFFF",
]);

export async function assertPhase5aDocx(docxPath, documentSet, options = {}) {
  const inspection = await inspectDocx(docxPath);
  const failures = [];
  const filename = options.filename ?? path.basename(docxPath);

  collectCheck(failures, "A4 landscape page setup", assertA4Landscape(inspection.documentXml));
  collectCheck(failures, "Calibri document font", assertCalibriOnly(inspection));
  collectCheck(failures, "B&W house style colours", assertBlackAndWhiteOnly(inspection));
  collectCheck(failures, "No underline formatting", !/<w:u\b/.test(inspection.combinedXml));
  collectCheck(
    failures,
    "Seven section tables",
    countMatches(inspection.documentXml, /<w:tbl\b/g) === 7,
  );
  collectCheck(failures, "Expected headings in order", assertHeadingsInOrder(inspection.text));
  collectCheck(failures, "Footer filename", inspection.footerText.includes(filename));
  collectCheck(failures, "Footer page fields", assertFooterPageFields(inspection.footerXml));
  collectCheck(failures, "DRAFT marker present", /\bDRAFT\b/.test(inspection.text));
  collectCheck(
    failures,
    "Expected package names present",
    allPresent(inspection.text, documentSet.project.trade_packages),
  );
  collectCheck(
    failures,
    "Expected HRCW refs present",
    allPresent(
      inspection.text,
      Array.from({ length: 17 }, (_, index) => `H${String(index + 1).padStart(2, "0")}`),
    ),
  );
  collectCheck(
    failures,
    "Expected hold-point refs present",
    allPresent(
      inspection.text,
      documentSet.hold_point_schedule.map((row) => row.ref),
    ),
  );
  collectCheck(
    failures,
    "Table headers use near-black fill",
    assertTableHeaderFillCount(inspection),
  );

  if (failures.length > 0) {
    throw new Error(`Phase 5A DOCX assertions failed:\n${failures.join("\n")}`);
  }

  return {
    status: "pass",
    checks: [
      "A4 landscape page setup",
      "Calibri document font",
      "B&W house style colours",
      "no underline formatting",
      "seven section tables",
      "expected headings in order",
      "footer filename and page fields",
      "DRAFT marker",
      "expected package, HRCW and hold-point refs",
      "near-black table headers",
    ],
    page_render_checked: false,
  };
}

export async function inspectDocx(docxPath) {
  const zip = await JSZip.loadAsync(await readFile(docxPath));
  const documentXml = await readZipText(zip, "word/document.xml");
  const stylesXml = await readZipText(zip, "word/styles.xml");
  const footerNames = Object.keys(zip.files).filter((name) => /^word\/footer\d+\.xml$/u.test(name));
  const footerXml = (await Promise.all(footerNames.map((name) => readZipText(zip, name)))).join(
    "\n",
  );
  const combinedXml = [documentXml, footerXml].join("\n");

  return {
    documentXml,
    stylesXml,
    footerXml,
    combinedXml,
    text: extractText(documentXml),
    footerText: extractText(footerXml),
  };
}

function assertA4Landscape(documentXml) {
  const pageSize = documentXml.match(/<w:pgSz\b[^>]*>/u)?.[0] ?? "";
  const width = attribute(pageSize, "w:w");
  const height = attribute(pageSize, "w:h");
  const expectedDimensions = new Set([
    String(DOCX_HOUSE_STYLE.page.widthTwip),
    String(DOCX_HOUSE_STYLE.page.heightTwip),
  ]);
  return (
    expectedDimensions.has(width) &&
    expectedDimensions.has(height) &&
    width !== height &&
    attribute(pageSize, "w:orient") === "landscape"
  );
}

function assertCalibriOnly(inspection) {
  const fonts = [...inspection.combinedXml.matchAll(/<w:rFonts\b[^>]*>/gu)]
    .flatMap((match) => [
      attribute(match[0], "w:ascii"),
      attribute(match[0], "w:hAnsi"),
      attribute(match[0], "w:cs"),
    ])
    .filter(Boolean);

  return fonts.length > 0 && fonts.every((font) => font === DOCX_HOUSE_STYLE.font);
}

function assertBlackAndWhiteOnly(inspection) {
  const colors = [...inspection.combinedXml.matchAll(/<w:color\b[^>]*>/gu)]
    .map((match) => attribute(match[0], "w:val"))
    .filter((color) => color && color !== "auto");
  const fills = [...inspection.combinedXml.matchAll(/<w:shd\b[^>]*>/gu)]
    .map((match) => attribute(match[0], "w:fill"))
    .filter((fill) => fill && fill !== "auto");

  return (
    colors.every((color) => ALLOWED_TEXT_COLORS.has(color.toUpperCase())) &&
    fills.every((fill) => ALLOWED_SHADING_FILLS.has(fill.toUpperCase()))
  );
}

function assertHeadingsInOrder(text) {
  let previousIndex = -1;
  for (const heading of PHASE5A_EXPECTED_HEADINGS) {
    const index = text.indexOf(heading);
    if (index <= previousIndex) {
      return false;
    }
    previousIndex = index;
  }
  return true;
}

function assertFooterPageFields(footerXml) {
  return (
    /<w:instrText[^>]*>\s*PAGE\s*<\/w:instrText>/u.test(footerXml) &&
    /<w:instrText[^>]*>\s*NUMPAGES\s*<\/w:instrText>/u.test(footerXml)
  );
}

function assertTableHeaderFillCount(inspection) {
  return (
    countMatches(
      inspection.documentXml,
      new RegExp(`<w:shd\\b[^>]*w:fill="${DOCX_HOUSE_STYLE.colors.nearBlack}"`, "gu"),
    ) >= PHASE5A_EXPECTED_HEADINGS.length
  );
}

function allPresent(text, expectedValues) {
  return expectedValues.every((value) => text.includes(String(value)));
}

function collectCheck(failures, label, passed) {
  if (!passed) {
    failures.push(`- ${label}`);
  }
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function extractText(xml) {
  return [...xml.matchAll(/<w:t\b[^>]*>(.*?)<\/w:t>/gsu)]
    .map((match) => decodeXml(match[1]))
    .join(" ");
}

function attribute(xmlTag, attributeName) {
  const escapedName = attributeName.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  return xmlTag.match(new RegExp(`${escapedName}="([^"]*)"`, "u"))?.[1] ?? null;
}

function decodeXml(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

async function readZipText(zip, name) {
  const file = zip.file(name);
  if (!file) {
    return "";
  }
  return file.async("text");
}
