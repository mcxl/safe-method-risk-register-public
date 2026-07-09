import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildPreparedCodexAssistedRunManifest,
  writeCodexAssistedRunManifest,
} from "../generate/sectioned-providers.mjs";
import {
  buildCodexAssistedGenerationContext,
  parseCodexAssistedArgs,
} from "./generate-sectioned-codex-assisted-assemble.mjs";

export async function runCodexAssistedPrepare(options = {}) {
  const context = await buildCodexAssistedGenerationContext(options);
  const manifest = await buildPreparedCodexAssistedRunManifest({
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
  };
}

export function printCodexAssistedPrepareResult(outcome) {
  console.log(`PASS Codex-assisted run prepared: ${outcome.manifest.run_id}`);
  console.log(`PASS run directory: ${outcome.runDirectory}`);
  console.log("PASS manifest is prepared only; lock it after complete section envelopes exist.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const outcome = await runCodexAssistedPrepare(parseCodexAssistedArgs(process.argv.slice(2)));
    printCodexAssistedPrepareResult(outcome);
    process.exit(outcome.exitCode);
  } catch (error) {
    console.error(`FAIL Codex-assisted run prepare: ${error.message}`);
    process.exit(1);
  }
}
