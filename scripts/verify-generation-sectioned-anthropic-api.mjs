import { createSectionedAnthropicProvider } from "../generate/sectioned-providers.mjs";
import { runSectionedApiSmoke } from "./sectioned-api-smoke.mjs";

if (!process.env.ANTHROPIC_API_KEY) {
  console.log("SKIP Phase 4 sectioned Anthropic API smoke: ANTHROPIC_API_KEY is not set.");
  process.exit(0);
}

if (process.env.SAFE_METHOD_RUN_ANTHROPIC_GENERATION !== "1") {
  console.log(
    "SKIP Phase 4 sectioned Anthropic API smoke: set SAFE_METHOD_RUN_ANTHROPIC_GENERATION=1 to call the model.",
  );
  process.exit(0);
}

const result = await runSectionedApiSmoke({
  label: "Phase 4 sectioned Anthropic API smoke",
  provider: createSectionedAnthropicProvider({
    timeoutMs: process.env.SAFE_METHOD_ANTHROPIC_TIMEOUT_MS ?? 240000,
  }),
});

process.exit(result.exitCode);
