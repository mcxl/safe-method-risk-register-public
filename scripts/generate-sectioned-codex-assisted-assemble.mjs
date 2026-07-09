import { pathToFileURL } from "node:url";

import { loadProjectBrief, normaliseProjectBrief } from "../generate/brief.mjs";
import { buildRetrievalPacket } from "../generate/retrieval.mjs";
import { runSectionedGenerationPipeline } from "../generate/sectioned-pipeline.mjs";
import {
  createCodexAssistedSectionProvider,
  resolveCodexAssistedRunDirectory,
  writeCodexAssistedDraftEvidence,
} from "../generate/sectioned-providers.mjs";
import { buildKnowledgeSnapshot, REPO_ROOT } from "./kb-source.mjs";

export const DEFAULT_CODEX_ASSISTED_BRIEF = "fixtures/golden/briefs/unitas-project-brief.json";

export async function buildCodexAssistedGenerationContext(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const env = options.env ?? process.env;
  const briefPath =
    options.briefPath ?? env.SAFE_METHOD_PROJECT_BRIEF ?? DEFAULT_CODEX_ASSISTED_BRIEF;
  const runDirectory = resolveCodexAssistedRunDirectory({
    root,
    env,
    runId: options.runId,
    runDirectory: options.runDirectory,
  });
  const snapshot = options.snapshot ?? (await buildKnowledgeSnapshot(root));
  const brief = options.brief ?? (await loadProjectBrief(briefPath, { root, snapshot }));
  const normalisedBrief =
    options.normalisedBrief ?? (await normaliseProjectBrief(brief, { root, snapshot }));
  const retrievalPacket =
    options.retrievalPacket ?? (await buildRetrievalPacket(normalisedBrief, { root, snapshot }));
  return {
    root,
    env,
    briefPath,
    runDirectory,
    snapshot,
    brief,
    normalisedBrief,
    retrievalPacket,
  };
}

export async function runCodexAssistedAssemble(options = {}) {
  const context = await buildCodexAssistedGenerationContext(options);
  const { root, env, briefPath, runDirectory, brief, normalisedBrief, retrievalPacket } = context;
  const provider =
    options.provider ??
    (await createCodexAssistedSectionProvider({
      root,
      runDirectory,
      runId: options.runId ?? env.SAFE_METHOD_CODEX_ASSISTED_RUN_ID,
      briefPath,
      brief,
      normalisedBrief,
      retrievalPacket,
    }));

  const result = await runSectionedGenerationPipeline({
    root,
    brief,
    normalisedBrief,
    retrievalPacket,
    provider,
    maxRetries: 0,
    maxAssemblyCorrections: 0,
  });

  if (result.status !== "pass") {
    return {
      status: "fail",
      exitCode: 1,
      runDirectory,
      result,
    };
  }

  await writeCodexAssistedDraftEvidence({ runDirectory, result });
  return {
    status: "pass",
    exitCode: 0,
    runDirectory,
    result,
  };
}

export function parseCodexAssistedArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--run-id") {
      options.runId = argv[(index += 1)];
    } else if (arg === "--run-dir") {
      options.runDirectory = argv[(index += 1)];
    } else if (arg === "--brief") {
      options.briefPath = argv[(index += 1)];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

export function printCodexAssistedAssembleResult(outcome) {
  if (outcome.status === "pass") {
    console.log(
      `PASS Codex-assisted sectioned assembly: ${outcome.result.provenance.output_hash_sha256}`,
    );
    console.log(`PASS run directory: ${outcome.runDirectory}`);
    console.log("PASS wrote DRAFT local evidence only; no renderer output was produced.");
    return;
  }

  console.error("FAIL Codex-assisted sectioned assembly.");
  console.error(
    JSON.stringify(
      {
        runDirectory: outcome.runDirectory,
        status: outcome.result.status,
        issue_ready_blocked: outcome.result.issue_ready_blocked,
        validationReport: outcome.result.validationReport,
        sectionAttempts: outcome.result.sectionAttempts,
        assemblyAttempts: outcome.result.assemblyAttempts,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const outcome = await runCodexAssistedAssemble(parseCodexAssistedArgs(process.argv.slice(2)));
    printCodexAssistedAssembleResult(outcome);
    process.exit(outcome.exitCode);
  } catch (error) {
    console.error(`FAIL Codex-assisted sectioned assembly: ${error.message}`);
    process.exit(1);
  }
}
