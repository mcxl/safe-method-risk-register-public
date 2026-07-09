import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { createAnthropicProvider, DEFAULT_PROMPT_PATH } from "./pipeline.mjs";
import {
  buildSectionedStructuredOutputManifest,
  SECTIONED_GENERATION_PIPELINE_VERSION,
  SECTION_NAMES,
  validateSectionEnvelope,
} from "./sectioned-pipeline.mjs";
import { canonicalClone, sha256Canonical, REPO_ROOT } from "../scripts/kb-source.mjs";

export const DEFAULT_SECTIONED_GENERATION_PROVIDER = "codex_assisted";
export const SECTIONED_PROVIDER_CONTRACT_VERSION = "sectioned-provider.v1";
export const SECTIONED_GENERATION_PROVIDERS = Object.freeze([
  "codex_assisted",
  "anthropic",
  "openai",
]);
export const DEFAULT_OPENAI_MODEL = "gpt-5.5";
export const CODEX_ASSISTED_MODEL = "codex-assisted:local-section-files";
export const CODEX_ASSISTED_DEFAULT_ROOT = "outputs/tmp/codex-assisted";
export const CODEX_ASSISTED_MANIFEST_FILE = "codex-assisted-run.json";
export const CODEX_ASSISTED_PREPARED_MANIFEST_STATE = "prepared";
export const CODEX_ASSISTED_LOCKED_MANIFEST_STATE = "locked";
export const CODEX_ASSISTED_SECTION_FILES = Object.freeze(
  SECTION_NAMES.map((sectionName) => ({
    section_name: sectionName,
    file_name: `${sectionName}.json`,
  })),
);

const SECRET_PATTERNS = Object.freeze([/sk-[A-Za-z0-9_-]+/gu, /sk-ant-[A-Za-z0-9_-]+/gu]);

export function resolveGenerationProviderMode(env = process.env) {
  const rawMode = env.SAFE_METHOD_GENERATION_PROVIDER ?? DEFAULT_SECTIONED_GENERATION_PROVIDER;
  const mode = String(rawMode).trim().toLowerCase();
  if (!SECTIONED_GENERATION_PROVIDERS.includes(mode)) {
    throw new Error(
      `Unknown SAFE_METHOD_GENERATION_PROVIDER '${rawMode}'. Expected one of: ${SECTIONED_GENERATION_PROVIDERS.join(", ")}.`,
    );
  }
  return mode;
}

export function assertProviderCredentialGate(mode, env = process.env) {
  const providerMode = assertKnownProviderMode(mode);
  if (providerMode === "anthropic") {
    if (!hasSecret(env.ANTHROPIC_API_KEY)) {
      throw new Error("ANTHROPIC_API_KEY is required for Anthropic sectioned generation.");
    }
    if (env.SAFE_METHOD_RUN_ANTHROPIC_GENERATION !== "1") {
      throw new Error(
        "SAFE_METHOD_RUN_ANTHROPIC_GENERATION=1 is required before Anthropic sectioned generation.",
      );
    }
  }

  if (providerMode === "openai") {
    if (!hasSecret(env.OPENAI_API_KEY)) {
      throw new Error("OPENAI_API_KEY is required for OpenAI sectioned generation.");
    }
    if (env.SAFE_METHOD_RUN_OPENAI_GENERATION !== "1") {
      throw new Error(
        "SAFE_METHOD_RUN_OPENAI_GENERATION=1 is required before OpenAI sectioned generation.",
      );
    }
  }
}

export function createProviderForMode(mode, options = {}) {
  const providerMode = assertKnownProviderMode(mode);
  if (providerMode === "anthropic") {
    return createSectionedAnthropicProvider(options.anthropic ?? options);
  }
  if (providerMode === "openai") {
    return createOpenAIProvider(options.openai ?? options);
  }
  throw new Error(
    "Codex-assisted providers require createCodexAssistedSectionProvider because run context hashes must be supplied.",
  );
}

export function createSectionedAnthropicProvider(options = {}) {
  return withSectionedProviderContract(createAnthropicProvider(options));
}

export function createOpenAIProvider(options = {}) {
  const env = options.env ?? process.env;
  const apiKey = options.apiKey ?? env.OPENAI_API_KEY;
  const model = options.model ?? env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
  const endpoint = options.endpoint ?? "https://api.openai.com/v1/responses";
  const timeoutMs = Number(options.timeoutMs ?? env.SAFE_METHOD_OPENAI_TIMEOUT_MS ?? 0);

  return {
    provider_name: "openai",
    model,
    provider_contract_version: SECTIONED_PROVIDER_CONTRACT_VERSION,
    async generate({ request }) {
      if (!apiKey) {
        throw new Error("OPENAI_API_KEY is required for OpenAI generation.");
      }

      const response = await globalThis.fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        signal: timeoutMs > 0 ? globalThis.AbortSignal.timeout(timeoutMs) : undefined,
        body: JSON.stringify(buildOpenAIResponsesRequest(request, model)),
      });
      const text = await response.text();

      if (!response.ok) {
        throw new Error(`OpenAI API ${response.status}: ${redactSecrets(compactText(text))}`);
      }

      return parseOpenAISectionResponse(JSON.parse(text));
    },
  };
}

export function buildOpenAIResponsesRequest(sectionRequest, model) {
  const schema = sectionRequest.output_config?.format?.schema;
  if (!schema || typeof schema !== "object") {
    throw new Error("Section request is missing output_config.format.schema.");
  }

  return {
    model,
    instructions: sectionRequest.system,
    input: (sectionRequest.messages ?? []).map((message) => ({
      role: message.role,
      content: [
        {
          type: "input_text",
          text: message.content,
        },
      ],
    })),
    max_output_tokens: sectionRequest.max_tokens,
    store: false,
    text: {
      format: {
        type: "json_schema",
        name: openAiSchemaName(schema),
        schema,
        strict: true,
      },
    },
  };
}

export function parseOpenAISectionResponse(response) {
  if (response?.error) {
    throw new Error(`OpenAI response error: ${redactSecrets(response.error.message ?? "unknown")}`);
  }

  if (response?.status === "incomplete" || response?.incomplete_details) {
    const reason = response.incomplete_details?.reason ?? "unknown";
    throw new Error(`OpenAI response incomplete: ${reason}`);
  }

  if (["failed", "cancelled"].includes(response?.status)) {
    throw new Error(`OpenAI response status was ${response.status}.`);
  }

  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return parseOpenAIJsonText(response.output_text);
  }

  for (const outputItem of response?.output ?? []) {
    for (const contentItem of outputItem.content ?? []) {
      if (contentItem.type === "refusal" || contentItem.refusal) {
        throw new Error("OpenAI response included a refusal.");
      }
      if (
        (contentItem.type === "output_text" || contentItem.type === "text") &&
        typeof contentItem.text === "string"
      ) {
        return parseOpenAIJsonText(contentItem.text);
      }
    }
  }

  throw new Error("OpenAI response did not include parseable structured output text.");
}

export async function createCodexAssistedSectionProvider(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const runDirectory = resolveCodexAssistedRunDirectory({ ...options, root });
  const manifest = await readJsonFile(path.join(runDirectory, CODEX_ASSISTED_MANIFEST_FILE));
  await assertCodexAssistedManifest({
    root,
    runDirectory,
    manifest,
    runId: options.runId ?? manifest.run_id,
    briefPath: options.briefPath,
    brief: options.brief,
    normalisedBrief: options.normalisedBrief,
    retrievalPacket: options.retrievalPacket,
  });

  return {
    provider_name: "codex_assisted",
    model: options.model ?? CODEX_ASSISTED_MODEL,
    provider_contract_version: SECTIONED_PROVIDER_CONTRACT_VERSION,
    codex_assisted_run: {
      run_id: manifest.run_id,
      run_dir: runDirectory,
    },
    async generate({ sectionName }) {
      const filePath = path.join(runDirectory, codexAssistedSectionFileName(sectionName));
      return readJsonFile(filePath);
    },
  };
}

export async function buildPreparedCodexAssistedRunManifest(options = {}) {
  const manifest = await buildCodexAssistedManifestBase({
    ...options,
    manifestState: CODEX_ASSISTED_PREPARED_MANIFEST_STATE,
  });

  return {
    ...manifest,
    sections: Object.fromEntries(
      CODEX_ASSISTED_SECTION_FILES.map((entry) => [
        entry.section_name,
        {
          file_name: entry.file_name,
          sha256: null,
        },
      ]),
    ),
  };
}

export async function buildCodexAssistedRunManifest(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const runDirectory = path.resolve(root, options.runDirectory);
  const expectedSections = await codexAssistedSectionHashEntries(runDirectory);
  const manifest = await buildCodexAssistedManifestBase({
    ...options,
    manifestState: CODEX_ASSISTED_LOCKED_MANIFEST_STATE,
  });

  return {
    ...manifest,
    sections: Object.fromEntries(
      expectedSections.map((entry) => [
        entry.section_name,
        {
          file_name: entry.file_name,
          sha256: entry.sha256,
        },
      ]),
    ),
  };
}

export async function writeCodexAssistedRunManifest({ runDirectory, manifest }) {
  await mkdir(runDirectory, { recursive: true });
  await writeJsonFile(path.join(runDirectory, CODEX_ASSISTED_MANIFEST_FILE), manifest);
}

export async function validateCodexAssistedSectionFiles(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const runDirectory = path.resolve(root, options.runDirectory);
  const reports = [];

  for (const entry of CODEX_ASSISTED_SECTION_FILES) {
    const filePath = path.join(runDirectory, entry.file_name);
    const envelope = await readJsonFile(filePath);
    const report = validateSectionEnvelope(envelope, entry.section_name, {
      retrievalPacket: options.retrievalPacket,
    });
    reports.push(report);

    if (report.status !== "pass") {
      throw new Error(
        `Codex-assisted section ${entry.section_name} is schema-invalid: ${report.schema.errors}`,
      );
    }
  }

  return reports;
}

export async function writeCodexAssistedDraftEvidence({ runDirectory, result }) {
  if (result.status !== "pass") {
    throw new Error("Codex-assisted draft evidence is written only for passing assemblies.");
  }

  const evidenceDirectory = path.join(runDirectory, "evidence");
  await mkdir(evidenceDirectory, { recursive: true });
  await Promise.all([
    writeJsonFile(path.join(evidenceDirectory, "assembled-document-set.json"), result.documentSet),
    writeJsonFile(path.join(evidenceDirectory, "validation-report.json"), result.validationReport),
    writeJsonFile(path.join(evidenceDirectory, "generation-provenance.json"), result.provenance),
    writeJsonFile(path.join(evidenceDirectory, "section-attempts.json"), result.sectionAttempts),
    writeJsonFile(path.join(evidenceDirectory, "assembly-attempts.json"), result.assemblyAttempts),
  ]);
}

export function resolveCodexAssistedRunDirectory(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const env = options.env ?? process.env;
  const runDirectory = options.runDirectory ?? env.SAFE_METHOD_CODEX_ASSISTED_RUN_DIR;
  if (runDirectory) {
    return path.resolve(root, runDirectory);
  }

  const runId = options.runId ?? env.SAFE_METHOD_CODEX_ASSISTED_RUN_ID;
  if (!runId) {
    throw new Error(
      "Codex-assisted generation requires SAFE_METHOD_CODEX_ASSISTED_RUN_DIR or an explicit run_id.",
    );
  }

  return path.resolve(root, CODEX_ASSISTED_DEFAULT_ROOT, runId);
}

export function codexAssistedSectionFileName(sectionName) {
  const entry = CODEX_ASSISTED_SECTION_FILES.find(
    (candidate) => candidate.section_name === sectionName,
  );
  if (!entry) {
    throw new Error(`Unknown Codex-assisted section '${sectionName}'.`);
  }
  return entry.file_name;
}

export function redactSecrets(text) {
  let redacted = String(text);
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "[redacted]");
  }
  return redacted;
}

async function assertCodexAssistedManifest(options) {
  const manifest = options.manifest;

  if (manifest.manifest_state !== CODEX_ASSISTED_LOCKED_MANIFEST_STATE) {
    throw new Error("Codex-assisted run manifest must be locked before assembly.");
  }

  const expectedManifest = await buildCodexAssistedRunManifest(options);

  for (const key of [
    "run_id",
    "manifest_state",
    "provider_contract_version",
    "brief_path",
    "brief_hash_sha256",
    "normalised_brief_hash_sha256",
    "retrieval_packet_hash_sha256",
    "schema_hash_sha256",
    "prompt_hash_sha256",
    "pipeline_version",
  ]) {
    if (manifest[key] !== expectedManifest[key]) {
      throw new Error(`Codex-assisted run manifest is stale: ${key} mismatch.`);
    }
  }

  if (
    JSON.stringify(manifest.expected_section_filenames) !==
    JSON.stringify(expectedManifest.expected_section_filenames)
  ) {
    throw new Error("Codex-assisted run manifest is stale: expected_section_filenames mismatch.");
  }

  const actualSectionNames = Object.keys(manifest.sections ?? {}).sort();
  const expectedSectionNames = [...SECTION_NAMES].sort();
  if (JSON.stringify(actualSectionNames) !== JSON.stringify(expectedSectionNames)) {
    throw new Error("Codex-assisted run manifest is stale: section list mismatch.");
  }

  for (const sectionName of SECTION_NAMES) {
    const actual = manifest.sections?.[sectionName];
    const expected = expectedManifest.sections[sectionName];
    if (!actual) {
      throw new Error(`Codex-assisted run manifest is missing section ${sectionName}.`);
    }
    if (actual.file_name !== expected.file_name || actual.sha256 !== expected.sha256) {
      throw new Error(`Codex-assisted section file is stale: ${sectionName} hash mismatch.`);
    }
  }
}

async function buildCodexAssistedManifestBase(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const promptText = await readFile(path.join(root, DEFAULT_PROMPT_PATH), "utf8");

  return {
    run_id: options.runId,
    manifest_state: options.manifestState,
    provider_contract_version: SECTIONED_PROVIDER_CONTRACT_VERSION,
    brief_path: normaliseManifestPath(options.briefPath),
    brief_hash_sha256: sha256Canonical(options.brief),
    normalised_brief_hash_sha256: sha256Canonical(options.normalisedBrief),
    retrieval_packet_hash_sha256: sha256Canonical(options.retrievalPacket),
    schema_hash_sha256: sha256Canonical(buildSectionedStructuredOutputManifest()),
    prompt_hash_sha256: sha256Canonical(promptText),
    pipeline_version: SECTIONED_GENERATION_PIPELINE_VERSION,
    expected_section_filenames: CODEX_ASSISTED_SECTION_FILES.map((entry) => entry.file_name),
  };
}

async function codexAssistedSectionHashEntries(runDirectory) {
  return Promise.all(
    CODEX_ASSISTED_SECTION_FILES.map(async (entry) => ({
      ...entry,
      sha256: await sha256File(path.join(runDirectory, entry.file_name)),
    })),
  );
}

async function sha256File(filePath) {
  const contents = await readFile(filePath);
  return createHash("sha256").update(contents).digest("hex");
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${path.basename(filePath)} could not be read as JSON: ${message}`);
  }
}

async function writeJsonFile(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(canonicalClone(value), null, 2)}\n`, "utf8");
}

function openAiSchemaName(schema) {
  const sectionName = schema?.properties?.section_name?.enum?.[0] ?? "section";
  return `safe_method_${sectionName}`.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 64);
}

function parseOpenAIJsonText(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`OpenAI structured output was not valid JSON: ${message}`);
  }
}

function compactText(text) {
  const value = String(text).replace(/\s+/gu, " ").trim();
  return value.length > 2000 ? `${value.slice(0, 2000)}...` : value;
}

function normaliseManifestPath(value) {
  return String(value).replace(/\\/gu, "/");
}

function assertKnownProviderMode(mode) {
  if (!SECTIONED_GENERATION_PROVIDERS.includes(mode)) {
    throw new Error(
      `Unknown sectioned generation provider '${mode}'. Expected one of: ${SECTIONED_GENERATION_PROVIDERS.join(", ")}.`,
    );
  }
  return mode;
}

function withSectionedProviderContract(provider) {
  return {
    ...provider,
    provider_contract_version: SECTIONED_PROVIDER_CONTRACT_VERSION,
  };
}

function hasSecret(value) {
  return typeof value === "string" && value.trim() !== "";
}
