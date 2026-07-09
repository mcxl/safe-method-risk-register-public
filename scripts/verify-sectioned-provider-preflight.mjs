import { existsSync } from "node:fs";
import path from "node:path";

import {
  assertProviderCredentialGate,
  CODEX_ASSISTED_MANIFEST_FILE,
  resolveCodexAssistedRunDirectory,
  resolveGenerationProviderMode,
} from "../generate/sectioned-providers.mjs";
import { REPO_ROOT } from "./kb-source.mjs";
import { buildEffectiveEnv } from "./verify-sectioned-live-preflight.mjs";

const env = buildEffectiveEnv({ cwd: REPO_ROOT });
const mode = resolveGenerationProviderMode(env);
const failures = [];

try {
  assertProviderCredentialGate(mode, env);
} catch (error) {
  failures.push(error.message);
}

if (mode === "codex_assisted") {
  try {
    const runDirectory = resolveCodexAssistedRunDirectory({ root: REPO_ROOT, env });
    if (!existsSync(runDirectory)) {
      failures.push(`Codex-assisted run directory does not exist: ${runDirectory}`);
    }
    if (!existsSync(path.join(runDirectory, CODEX_ASSISTED_MANIFEST_FILE))) {
      failures.push(`Codex-assisted run manifest is missing: ${CODEX_ASSISTED_MANIFEST_FILE}`);
    }
  } catch (error) {
    failures.push(error.message);
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL ${failure}`);
  }
  process.exit(1);
}

console.log(`PASS sectioned provider preflight: ${mode}`);
