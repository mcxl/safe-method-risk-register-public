import {
  assertProviderCredentialGate,
  createOpenAIProvider,
  createSectionedAnthropicProvider,
  resolveGenerationProviderMode,
} from "../generate/sectioned-providers.mjs";
import {
  printCodexAssistedAssembleResult,
  runCodexAssistedAssemble,
} from "./generate-sectioned-codex-assisted-assemble.mjs";
import { runSectionedApiSmoke } from "./sectioned-api-smoke.mjs";

const mode = resolveGenerationProviderMode(process.env);

if (mode === "codex_assisted") {
  const outcome = await runCodexAssistedAssemble();
  printCodexAssistedAssembleResult(outcome);
  process.exit(outcome.exitCode);
}

try {
  assertProviderCredentialGate(mode, process.env);
} catch (error) {
  console.error(`FAIL ${mode} sectioned provider preflight: ${error.message}`);
  process.exit(1);
}

const provider =
  mode === "anthropic"
    ? createSectionedAnthropicProvider({
        timeoutMs: process.env.SAFE_METHOD_ANTHROPIC_TIMEOUT_MS ?? 240000,
      })
    : createOpenAIProvider({
        timeoutMs: process.env.SAFE_METHOD_OPENAI_TIMEOUT_MS ?? 240000,
      });

const result = await runSectionedApiSmoke({
  label: `Phase 4 sectioned ${mode} provider smoke`,
  provider,
});
process.exit(result.exitCode);
