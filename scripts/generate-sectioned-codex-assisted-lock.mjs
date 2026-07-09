import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildCodexAssistedRunManifest,
  validateCodexAssistedSectionFiles,
  writeCodexAssistedRunManifest,
} from "../generate/sectioned-providers.mjs";
import {
  buildCodexAssistedGenerationContext,
  parseCodexAssistedArgs,
} from "./generate-sectioned-codex-assisted-assemble.mjs";

export async function runCodexAssistedLock(options = {}) {
  const context = await buildCodexAssistedGenerationContext(options);
  const sectionReports = await validateCodexAssistedSectionFiles({
    root: context.root,
    runDirectory: context.runDirectory,
    retrievalPacket: context.retrievalPacket,
  });
  const manifest = await buildCodexAssistedRunManifest({
    root: context.root,
    runDirectory: context.runDirectory,
    runId:
      options.runId ??
      context.env.SAFE_METHOD_CODEX_ASSISTED_RUN_ID ??
      path.basename(context.runDirectory),
    briefPath: context.briefPath,
    brief: context.brief,
    normalisedBrief: context.normalisedBrief,
    retrievalPacket: context.retrievalPacket,
  });

  await writeCodexAssistedRunManifest({
    runDirectory: context.runDirectory,
    manifest,
  });

  return {
    status: "pass",
    exitCode: 0,
    runDirectory: context.runDirectory,
    manifest,
    sectionReports,
  };
}

export function printCodexAssistedLockResult(outcome) {
  console.log(`PASS Codex-assisted run locked: ${outcome.manifest.run_id}`);
  console.log(`PASS run directory: ${outcome.runDirectory}`);
  console.log(`PASS section envelopes validated: ${outcome.sectionReports.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const outcome = await runCodexAssistedLock(parseCodexAssistedArgs(process.argv.slice(2)));
    printCodexAssistedLockResult(outcome);
    process.exit(outcome.exitCode);
  } catch (error) {
    console.error(`FAIL Codex-assisted run lock: ${error.message}`);
    process.exit(1);
  }
}
