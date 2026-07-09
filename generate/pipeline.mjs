import { readFile } from "node:fs/promises";
import path from "node:path";

import { loadProjectBrief, normaliseProjectBrief } from "./brief.mjs";
import { buildRetrievalPacket } from "./retrieval.mjs";
import { buildDocumentSetOutputSchema, DOCUMENT_SET_SCHEMA_FILE } from "./schema-bundle.mjs";
import { validateDocumentSet } from "../rules/index.mjs";
import {
  createAjvRegistry,
  formatAjvErrors,
  readSchemaDocuments,
  schemaIdForFileName,
} from "../scripts/schema-registry.mjs";
import {
  buildKnowledgeSnapshot,
  canonicalClone,
  readJson,
  sha256Canonical,
  REPO_ROOT,
} from "../scripts/kb-source.mjs";

export const GENERATION_PIPELINE_VERSION = "phase4.generation.v1";
export const PROMPT_VERSION = "phase4.prompt-system.v1";
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
export const DEFAULT_PROMPT_PATH = "spec/30-prompt-system.md";
export const DEFAULT_UNITAS_DOCUMENT_SET_PATH =
  "fixtures/golden/document-sets/unitas-document-set.json";

export async function runGenerationPipeline(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const registry = options.registry ?? createAjvRegistry();
  const snapshot = options.snapshot ?? (await buildKnowledgeSnapshot(root));
  const brief =
    options.brief ?? (await loadProjectBrief(options.briefPath, { root, registry, snapshot }));
  const normalisedBrief =
    options.normalisedBrief ?? (await normaliseProjectBrief(brief, { root, registry, snapshot }));
  const retrievalPacket =
    options.retrievalPacket ?? (await buildRetrievalPacket(normalisedBrief, { root, snapshot }));
  const provider = options.provider ?? createFixtureProvider({ root });
  const maxRetries = options.maxRetries ?? 1;
  const maxAttempts = maxRetries + 1;
  const attempts = [];
  let correctionContext = null;

  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
    const request = await buildGenerationRequest({
      root,
      model: provider.model ?? options.model ?? DEFAULT_ANTHROPIC_MODEL,
      normalisedBrief,
      retrievalPacket,
      correctionContext,
      outputSchema: options.outputSchema,
      responseInstructions: options.responseInstructions,
    });

    try {
      const providerResponse = await provider.generate({
        request,
        attemptNumber,
        previousValidation: correctionContext,
      });
      const documentSet = parseProviderResponse(providerResponse);
      const validationReport = validateGeneratedDocumentSet(documentSet, { registry });
      const attempt = {
        attempt: attemptNumber,
        status: validationReport.status,
        validation_report: validationReport,
      };
      attempts.push(attempt);

      if (validationReport.status === "pass") {
        return {
          status: "pass",
          documentSet,
          normalisedBrief,
          retrievalPacket,
          validationReport,
          provenance: await buildGenerationProvenance({
            root,
            provider,
            brief,
            normalisedBrief,
            retrievalPacket,
            documentSet,
            validationReport,
            structuredOutputSchema: request.output_config.format.schema,
          }),
          attempts,
        };
      }

      correctionContext = validationReport;
    } catch (error) {
      const validationReport = providerFailureReport(error);
      attempts.push({
        attempt: attemptNumber,
        status: "fail",
        validation_report: validationReport,
      });
      correctionContext = validationReport;
    }
  }

  return {
    status: "fail",
    normalisedBrief,
    retrievalPacket,
    validationReport: correctionContext,
    attempts,
    issue_ready_blocked: true,
  };
}

export async function buildGenerationRequest(options) {
  const promptSystem = await readPromptSystem(options.root ?? REPO_ROOT);
  const outputSchema =
    options.outputSchema ?? buildDocumentSetOutputSchema({ requireAllObjectProperties: true });
  const correctionText = options.correctionContext
    ? `\n\nCorrection attempt required. Previous validation failures:\n${JSON.stringify(
        options.correctionContext,
        null,
        2,
      )}`
    : "";

  return {
    model: options.model ?? DEFAULT_ANTHROPIC_MODEL,
    max_tokens: options.max_tokens ?? 64000,
    system: promptSystem,
    messages: [
      {
        role: "user",
        content: [
          "Generate a DRAFT project-level WHS document set as JSON.",
          "Use only the retrieved KB records for HRCW triggers, controls, and hold points.",
          "Return JSON only. Local validators decide whether the draft can proceed to review.",
          ...(options.responseInstructions ?? []),
          "",
          "Normalised project brief:",
          JSON.stringify(options.normalisedBrief, null, 2),
          "",
          "Retrieval packet:",
          JSON.stringify(options.retrievalPacket, null, 2),
          correctionText,
        ].join("\n"),
      },
    ],
    output_config: {
      format: {
        type: "json_schema",
        schema: outputSchema,
      },
    },
  };
}

export function validateGeneratedDocumentSet(documentSet, options = {}) {
  const registry = options.registry ?? createAjvRegistry();
  const validate = registry.getValidator(DOCUMENT_SET_SCHEMA_FILE);

  if (!validate(documentSet)) {
    return {
      status: "fail",
      schema: {
        status: "fail",
        schema_id: schemaIdForFileName(DOCUMENT_SET_SCHEMA_FILE),
        errors: formatAjvErrors(validate.errors),
      },
      rules: null,
    };
  }

  const rules = validateDocumentSet(documentSet);
  return {
    status: rules.status,
    schema: {
      status: "pass",
      schema_id: schemaIdForFileName(DOCUMENT_SET_SCHEMA_FILE),
      errors: "",
    },
    rules,
  };
}

export function parseProviderResponse(response) {
  if (typeof response === "string") {
    return JSON.parse(response);
  }

  if (response?.documentSet) {
    return canonicalClone(response.documentSet);
  }

  if (typeof response?.document_set_json === "string") {
    return JSON.parse(response.document_set_json);
  }

  if (response?.document_level) {
    return canonicalClone(response);
  }

  if (Array.isArray(response?.content)) {
    if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
      throw new Error(`Anthropic response stopped with ${response.stop_reason}`);
    }

    const textBlock = response.content.find((block) => block.type === "text" && block.text);
    if (!textBlock) {
      throw new Error("Anthropic response did not include a text content block.");
    }
    return parseProviderResponse(JSON.parse(textBlock.text));
  }

  throw new Error("Provider response was not a document set or parseable structured response.");
}

export function createFixtureProvider(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const fixturePath = options.fixturePath ?? DEFAULT_UNITAS_DOCUMENT_SET_PATH;

  return {
    provider_name: "fixture",
    model: options.model ?? "fixture:unitas-golden-document-set",
    async generate() {
      return readJson(root, fixturePath);
    },
  };
}

export function createSequenceProvider(responses, options = {}) {
  let index = 0;
  const calls = [];

  return {
    provider_name: options.providerName ?? "sequence-fixture",
    model: options.model ?? "fixture:sequence",
    calls,
    async generate(call) {
      calls.push(call);
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return typeof response === "function" ? response(call) : response;
    },
  };
}

export function createAnthropicProvider(options = {}) {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const model = options.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
  const endpoint = options.endpoint ?? "https://api.anthropic.com/v1/messages";
  const timeoutMs = Number(options.timeoutMs ?? process.env.SAFE_METHOD_ANTHROPIC_TIMEOUT_MS ?? 0);

  return {
    provider_name: "anthropic",
    model,
    async generate({ request }) {
      if (!apiKey) {
        throw new Error("ANTHROPIC_API_KEY is required for Anthropic generation.");
      }

      const response = await globalThis.fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: timeoutMs > 0 ? globalThis.AbortSignal.timeout(timeoutMs) : undefined,
        body: JSON.stringify({
          ...request,
          model,
        }),
      });
      const text = await response.text();

      if (!response.ok) {
        throw new Error(`Anthropic API ${response.status}: ${text}`);
      }

      return JSON.parse(text);
    },
  };
}

export function findUnseededControlSourceIds(documentSet, retrievalPacket) {
  const seeded = new Set(retrievalPacket.candidate_summary.control_source_ids);
  const used = new Set(
    (documentSet.risk_register ?? []).flatMap((row) =>
      (row.controls ?? []).flatMap((control) => control.source_ids ?? []),
    ),
  );
  return [...used].filter((sourceId) => !seeded.has(sourceId)).sort();
}

export async function buildGenerationProvenance(options) {
  const promptText = await readPromptSystem(options.root ?? REPO_ROOT);
  const schemaDocuments = readSchemaDocuments();
  const documentSchema = schemaDocuments.find(
    (document) => document.fileName === DOCUMENT_SET_SCHEMA_FILE,
  );
  const schemaBundle =
    options.structuredOutputSchema ??
    buildDocumentSetOutputSchema({ requireAllObjectProperties: true });
  const validationReport = canonicalClone(options.validationReport);

  return {
    provenance_version: "phase4.provenance.v1",
    pipeline_version: GENERATION_PIPELINE_VERSION,
    workflow_state: "DRAFT",
    input: {
      brief_id: options.brief.brief_id,
      project_brief_schema_version: options.brief.schema_version,
      input_hash_sha256: sha256Canonical(options.brief),
      normalised_input_hash_sha256: sha256Canonical(options.normalisedBrief),
    },
    kb: {
      version: options.retrievalPacket.kb_version,
      jurisdiction: options.retrievalPacket.jurisdiction,
      source_hash_sha256: options.retrievalPacket.source_hash_sha256,
    },
    schema: {
      document_set_schema_id: schemaIdForFileName(DOCUMENT_SET_SCHEMA_FILE),
      document_set_schema_hash_sha256: documentSchema
        ? sha256Canonical(documentSchema.schema)
        : "[Client To Confirm]",
      structured_output_schema_hash_sha256: sha256Canonical(schemaBundle),
    },
    prompt: {
      version: PROMPT_VERSION,
      path: DEFAULT_PROMPT_PATH,
      hash_sha256: sha256Canonical(promptText),
    },
    model: {
      provider: options.provider.provider_name ?? "unknown",
      version: options.provider.model ?? "[Client To Confirm]",
      provider_contract_version:
        options.provider.provider_contract_version ?? "[Client To Confirm]",
    },
    validation_report: validationReport,
    output_hash_sha256: sha256Canonical(options.documentSet),
    reviewer_signoff: {
      state: "not_reviewed",
      signed_off: false,
      reviewer: null,
      signed_off_at: null,
    },
    issue_gate: {
      issue_ready: false,
      reason: "Generated sets remain DRAFT until validator pass and consultant review/sign-off.",
      direct_draft_to_issued_allowed: false,
    },
  };
}

async function readPromptSystem(root = REPO_ROOT) {
  return readFile(path.join(root, DEFAULT_PROMPT_PATH), "utf8");
}

function providerFailureReport(error) {
  return {
    status: "fail",
    schema: {
      status: "not_run",
      schema_id: schemaIdForFileName(DOCUMENT_SET_SCHEMA_FILE),
      errors: "",
    },
    rules: null,
    provider_error: formatProviderError(error),
  };
}

function formatProviderError(error) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const parts = [error.message];
  if (error.cause) {
    parts.push(`cause: ${formatErrorCause(error.cause)}`);
  }
  return parts.join(" | ");
}

function formatErrorCause(cause) {
  if (cause instanceof Error) {
    const details = [`${cause.name}: ${cause.message}`];
    const fields = [];
    for (const key of ["code", "errno", "syscall", "hostname"]) {
      const value = cause[key];
      if (typeof value === "string" || typeof value === "number") {
        fields.push(`${key}=${value}`);
      }
    }
    if (fields.length > 0) {
      details.push(`(${fields.join(", ")})`);
    }
    return details.join(" ");
  }

  if (cause && typeof cause === "object") {
    const fields = Object.entries(cause)
      .filter(([, value]) => typeof value === "string" || typeof value === "number")
      .map(([key, value]) => `${key}=${value}`);
    return fields.length > 0 ? fields.join(", ") : String(cause);
  }

  return String(cause);
}
