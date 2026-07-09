import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadProjectBrief, normaliseProjectBrief } from "../../generate/brief.mjs";
import { buildRetrievalPacket } from "../../generate/retrieval.mjs";
import {
  buildSectionEnvelopeFromDocumentSet,
  SECTION_NAMES,
} from "../../generate/sectioned-pipeline.mjs";
import {
  buildCodexAssistedRunManifest,
  buildPreparedCodexAssistedRunManifest,
  codexAssistedSectionFileName,
  writeCodexAssistedRunManifest,
} from "../../generate/sectioned-providers.mjs";
import {
  buildKnowledgeSnapshot,
  canonicalClone,
  readJson,
  REPO_ROOT,
} from "../../scripts/kb-source.mjs";

export const SAMPLE_BRIEF = "fixtures/golden/briefs/sample-project-brief.json";
export const SAMPLE_DOCUMENT_SET = "fixtures/golden/document-sets/sample-document-set.json";
export const TEST_RUN_ROOT = path.join(REPO_ROOT, "outputs", "tmp", "codex-assisted", "tests");

export async function buildSampleContext() {
  const snapshot = await buildKnowledgeSnapshot(REPO_ROOT);
  const brief = await loadProjectBrief(SAMPLE_BRIEF, { root: REPO_ROOT, snapshot });
  const normalisedBrief = await normaliseProjectBrief(brief, { root: REPO_ROOT, snapshot });
  const retrievalPacket = await buildRetrievalPacket(normalisedBrief, {
    root: REPO_ROOT,
    snapshot,
  });
  const golden = await readJson(REPO_ROOT, SAMPLE_DOCUMENT_SET);
  return {
    snapshot,
    brief,
    normalisedBrief,
    retrievalPacket,
    golden,
    briefPath: SAMPLE_BRIEF,
  };
}

export async function createCodexAssistedRun(runId, context, options = {}) {
  const runDirectory = path.join(TEST_RUN_ROOT, runId);
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

export async function cleanupCodexAssistedTestRuns() {
  const resolvedRoot = path.resolve(TEST_RUN_ROOT);
  if (!resolvedRoot.endsWith(path.join("outputs", "tmp", "codex-assisted", "tests"))) {
    throw new Error(`Refusing to clean unexpected test run root: ${resolvedRoot}`);
  }
  await rm(resolvedRoot, { recursive: true, force: true });
}

export async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(canonicalClone(value), null, 2)}\n`, "utf8");
}

export function assertNoRendererOutput(runDirectory) {
  const files = collectFiles(runDirectory);
  assert.equal(
    files.some((filePath) => /\.(?:docx|xlsx)$/iu.test(filePath)),
    false,
    "Codex-assisted assembly must not produce renderer files",
  );
}

function collectFiles(directory) {
  const entries = [];
  for (const entry of readdirSyncSafe(directory)) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      entries.push(...collectFiles(filePath));
    } else {
      entries.push(filePath);
    }
  }
  return entries;
}

function readdirSyncSafe(directory) {
  return existsSync(directory) ? readdirSync(directory, { withFileTypes: true }) : [];
}
