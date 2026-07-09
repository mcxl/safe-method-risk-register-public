import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { assertDocumentSetRenderable } from "./docx-renderer.mjs";
import { REPO_ROOT } from "../scripts/kb-source.mjs";

export const XLSX_RENDERER_VERSION = "phase5b.xlsx-renderer.v1";

export async function renderDraftXlsx(documentSet, outputPath, options = {}) {
  const validationReport = assertDocumentSetRenderable(documentSet, options);
  const filename = options.filename ?? path.basename(outputPath);
  const tempDir = await mkdtemp(path.join(tmpdir(), "safe-method-xlsx-render-"));
  const inputJson = path.join(tempDir, "document-set.json");
  const resultJson = path.join(tempDir, "result.json");

  try {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(inputJson, `${JSON.stringify(documentSet, null, 2)}\n`, "utf8");
    await runPython([
      path.join(REPO_ROOT, "render", "xlsx_renderer.py"),
      "--document-set-json",
      inputJson,
      "--output",
      outputPath,
      "--filename",
      filename,
      "--result-json",
      resultJson,
    ]);

    const renderResult = JSON.parse(await readFile(resultJson, "utf8"));
    return {
      ...renderResult,
      renderer_version: XLSX_RENDERER_VERSION,
      workflow_state: "DRAFT",
      issue_ready: false,
      output_path: outputPath,
      filename,
      validation_report: validationReport,
      output_hash_sha256: await sha256File(outputPath),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function assertPhase5bXlsx(outputPath, documentSet) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "safe-method-xlsx-assert-"));
  const inputJson = path.join(tempDir, "document-set.json");
  try {
    await writeFile(inputJson, `${JSON.stringify(documentSet, null, 2)}\n`, "utf8");
    const stdout = await runPython([
      path.join(REPO_ROOT, "render", "xlsx_assertions.py"),
      "--workbook",
      outputPath,
      "--document-set-json",
      inputJson,
    ]);
    return JSON.parse(stdout);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function scanRecalculatedXlsxValues(outputPath) {
  const stdout = await runPython([
    path.join(REPO_ROOT, "render", "xlsx_assertions.py"),
    "--workbook",
    outputPath,
    "--scan-values",
  ]);
  return JSON.parse(stdout);
}

export function findPython() {
  if (process.env.PYTHON?.trim()) {
    return process.env.PYTHON.trim();
  }

  const venvPython =
    process.platform === "win32"
      ? path.join(REPO_ROOT, ".venv", "Scripts", "python.exe")
      : path.join(REPO_ROOT, ".venv", "bin", "python");
  return existsSync(venvPython) ? venvPython : "python";
}

async function runPython(args) {
  const python = findPython();
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(
            `${python} ${args.join(" ")} failed with exit ${code}: ${stderr || stdout}`.trim(),
          ),
        );
      }
    });
  });
}

async function sha256File(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}
