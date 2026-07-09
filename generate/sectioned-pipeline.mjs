import Ajv2020 from "ajv/dist/2020.js";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { loadProjectBrief, normaliseProjectBrief } from "./brief.mjs";
import { buildRetrievalPacket } from "./retrieval.mjs";
import {
  buildDocumentSetOutputSchema,
  prepareForAnthropicStructuredOutputs,
} from "./schema-bundle.mjs";
import {
  buildGenerationProvenance,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_PROMPT_PATH,
  validateGeneratedDocumentSet,
} from "./pipeline.mjs";
import { formatAjvErrors } from "../scripts/schema-registry.mjs";
import {
  buildKnowledgeSnapshot,
  canonicalClone,
  canonicalStringify,
  readJson,
  REPO_ROOT,
} from "../scripts/kb-source.mjs";

export const SECTIONED_GENERATION_PIPELINE_VERSION = "phase4.sectioned-generation.v1";
export const DEFAULT_SECTIONED_UNITAS_DOCUMENT_SET_PATH =
  "fixtures/golden/document-sets/unitas-document-set.json";
export const SUPPORT_BUNDLE_SECTION = "support_bundle";
export const RISK_REGISTER_CHUNK_SECTIONS = Object.freeze([
  "risk_register_part_1",
  "risk_register_part_2",
  "risk_register_part_3",
  "risk_register_part_4",
]);
export const SWMS_BENCHMARK_REVIEW_CHUNK_SECTIONS = Object.freeze([
  "swms_benchmark_reviews_part_1",
  "swms_benchmark_reviews_part_2",
]);
export const SECTION_NAMES = Object.freeze([
  "hrcw_register",
  "hold_point_schedule",
  "swms_matrix",
  ...RISK_REGISTER_CHUNK_SECTIONS,
  ...SWMS_BENCHMARK_REVIEW_CHUNK_SECTIONS,
  SUPPORT_BUNDLE_SECTION,
]);
const KNOWN_SECTION_NAMES = Object.freeze([
  ...SECTION_NAMES,
  "risk_register",
  "swms_benchmark_reviews",
]);

const RISK_REGISTER_CHUNK_INSTRUCTIONS = Object.freeze({
  risk_register_part_1:
    "For risk_register_part_1, generate only risk_register rows for methodology_sequence positions 1-4 inclusive.",
  risk_register_part_2:
    "For risk_register_part_2, generate only risk_register rows for methodology_sequence positions 5-8 inclusive.",
  risk_register_part_3:
    "For risk_register_part_3, generate only risk_register rows for methodology_sequence positions 9-13 inclusive.",
  risk_register_part_4:
    "For risk_register_part_4, generate only risk_register rows for methodology_sequence position 14 onward, including all-phases standing hazards.",
});

const SWMS_BENCHMARK_REVIEW_CHUNK_INSTRUCTIONS = Object.freeze({
  swms_benchmark_reviews_part_1:
    "For swms_benchmark_reviews_part_1, generate only benchmark review rows for the first half of the SWMS titles in the accepted swms_matrix, preserving their order.",
  swms_benchmark_reviews_part_2:
    "For swms_benchmark_reviews_part_2, generate only benchmark review rows for the second half of the SWMS titles in the accepted swms_matrix, preserving their order.",
});

const ACCESS_SPECIFIC_CONTROL_PATTERN =
  /\b(scaffold|ewp|boom lift|scissor lift|work platform|platform|access system)\b/i;
const OPEN_ACCESS_CONFIRMATION_PATTERN =
  /\b(access method|access system|access|scaffold|ewp|platform)\b/i;

const SECTION_KEYS = Object.freeze({
  hrcw_register: Object.freeze(["hrcw_register"]),
  swms_matrix: Object.freeze(["swms_matrix"]),
  hold_point_schedule: Object.freeze(["hold_point_schedule"]),
  risk_register: Object.freeze(["risk_register"]),
  ...Object.fromEntries(
    RISK_REGISTER_CHUNK_SECTIONS.map((sectionName) => [
      sectionName,
      Object.freeze(["risk_register"]),
    ]),
  ),
  swms_benchmark_reviews: Object.freeze(["swms_benchmark_reviews"]),
  ...Object.fromEntries(
    SWMS_BENCHMARK_REVIEW_CHUNK_SECTIONS.map((sectionName) => [
      sectionName,
      Object.freeze(["swms_benchmark_reviews"]),
    ]),
  ),
  support_bundle: Object.freeze([
    "intended_swms",
    "supporting_documents",
    "confirmation_items",
    "legal_references",
    "swms_benchmark_note",
    "historical_mode",
  ]),
});

export async function runSectionedGenerationPipeline(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const registry = options.registry ?? undefined;
  const snapshot = options.snapshot ?? (await buildKnowledgeSnapshot(root));
  const brief =
    options.brief ?? (await loadProjectBrief(options.briefPath, { root, registry, snapshot }));
  const normalisedBrief =
    options.normalisedBrief ?? (await normaliseProjectBrief(brief, { root, registry, snapshot }));
  const retrievalPacket =
    options.retrievalPacket ?? (await buildRetrievalPacket(normalisedBrief, { root, snapshot }));
  const provider = options.provider ?? createSectionedFixtureProvider({ root });
  const maxRetries = options.maxRetries ?? 1;
  const maxAssemblyCorrections = options.maxAssemblyCorrections ?? 1;
  const sectionNames = options.sectionNames ?? SECTION_NAMES;
  const sectionAttempts = [];
  const assemblyAttempts = [];
  const correctionAttempts = [];
  const sections = {};

  for (const sectionName of sectionNames) {
    const maxSectionRetries = options.sectionMaxRetries?.[sectionName] ?? maxRetries;
    const maxAttempts = maxSectionRetries + 1;
    let correctionContext = null;
    let accepted = false;

    for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
      const request = await buildSectionGenerationRequest({
        root,
        model: provider.model ?? options.model ?? DEFAULT_ANTHROPIC_MODEL,
        sectionName,
        normalisedBrief,
        retrievalPacket,
        acceptedSections: sections,
        correctionContext,
        outputSchema: options.outputSchemas?.[sectionName],
        responseInstructions: options.responseInstructions?.[sectionName],
        max_tokens: options.max_tokens,
      });

      try {
        const providerResponse = await provider.generate({
          request,
          sectionName,
          attemptNumber,
          previousValidation: correctionContext,
        });
        const envelope = parseSectionProviderResponse(providerResponse);
        const validationReport = validateSectionEnvelope(envelope, sectionName, {
          retrievalPacket,
        });
        sectionAttempts.push({
          section_name: sectionName,
          attempt: attemptNumber,
          status: validationReport.status,
          validation_report: validationReport,
        });

        if (validationReport.status === "pass") {
          sections[sectionName] = extractSectionPayload(envelope, sectionName);
          accepted = true;
          break;
        }

        correctionContext = validationReport;
      } catch (error) {
        const validationReport = sectionProviderFailureReport(sectionName, error);
        sectionAttempts.push({
          section_name: sectionName,
          attempt: attemptNumber,
          status: "fail",
          validation_report: validationReport,
        });
        correctionContext = validationReport;
      }
    }

    if (!accepted) {
      return {
        status: "fail",
        normalisedBrief,
        retrievalPacket,
        validationReport: correctionContext,
        attempts: sectionAttempts,
        sectionAttempts,
        assemblyAttempts,
        correctionAttempts,
        issue_ready_blocked: true,
      };
    }
  }

  let documentSet = assembleSectionedDocumentSet({
    normalisedBrief,
    retrievalPacket,
    sections,
  });
  let validationReport = validateGeneratedDocumentSet(documentSet, { registry });
  let assembledAttempt = {
    section_name: "assembled_document_set",
    attempt: 1,
    status: validationReport.status,
    validation_report: validationReport,
  };
  assemblyAttempts.push(assembledAttempt);
  const attempts = [...sectionAttempts, assembledAttempt];

  for (
    let correctionRound = 1;
    validationReport.status !== "pass" && correctionRound <= maxAssemblyCorrections;
    correctionRound += 1
  ) {
    const correctionPlan = buildAssemblyCorrectionPlan(validationReport, sections);
    if (correctionPlan.length === 0) {
      break;
    }

    for (const correction of correctionPlan) {
      const sectionName = correction.section_name;
      const request = await buildSectionGenerationRequest({
        root,
        model: provider.model ?? options.model ?? DEFAULT_ANTHROPIC_MODEL,
        sectionName,
        normalisedBrief,
        retrievalPacket,
        acceptedSections: sections,
        currentSectionPayload: buildSectionEnvelopeFromSections(sectionName, sections),
        assemblyCorrectionContext: {
          correction_round: correctionRound,
          failures: correction.failures,
        },
        outputSchema: options.outputSchemas?.[sectionName],
        responseInstructions: options.responseInstructions?.[sectionName],
        max_tokens: options.max_tokens,
      });

      let correctionValidationReport;
      try {
        const providerResponse = await provider.generate({
          request,
          sectionName,
          attemptNumber: 1,
          correctionRound,
          correctionFailures: correction.failures,
          previousValidation: validationReport,
        });
        const envelope = parseSectionProviderResponse(providerResponse);
        correctionValidationReport = validateSectionEnvelope(envelope, sectionName, {
          retrievalPacket,
        });
        const correctionAttempt = {
          section_name: sectionName,
          attempt: 1,
          correction_round: correctionRound,
          status: correctionValidationReport.status,
          validation_report: correctionValidationReport,
          targeted_failures: correction.failures,
        };
        correctionAttempts.push(correctionAttempt);
        attempts.push(correctionAttempt);

        if (correctionValidationReport.status !== "pass") {
          return {
            status: "fail",
            documentSet,
            normalisedBrief,
            retrievalPacket,
            validationReport: correctionValidationReport,
            attempts,
            sectionAttempts,
            assemblyAttempts,
            correctionAttempts,
            issue_ready_blocked: true,
          };
        }

        sections[sectionName] = extractSectionPayload(envelope, sectionName);
      } catch (error) {
        correctionValidationReport = sectionProviderFailureReport(sectionName, error);
        const correctionAttempt = {
          section_name: sectionName,
          attempt: 1,
          correction_round: correctionRound,
          status: "fail",
          validation_report: correctionValidationReport,
          targeted_failures: correction.failures,
        };
        correctionAttempts.push(correctionAttempt);
        attempts.push(correctionAttempt);

        return {
          status: "fail",
          documentSet,
          normalisedBrief,
          retrievalPacket,
          validationReport: correctionValidationReport,
          attempts,
          sectionAttempts,
          assemblyAttempts,
          correctionAttempts,
          issue_ready_blocked: true,
        };
      }
    }

    documentSet = assembleSectionedDocumentSet({
      normalisedBrief,
      retrievalPacket,
      sections,
    });
    validationReport = validateGeneratedDocumentSet(documentSet, { registry });
    assembledAttempt = {
      section_name: "assembled_document_set",
      attempt: assemblyAttempts.length + 1,
      correction_round: correctionRound,
      status: validationReport.status,
      validation_report: validationReport,
    };
    assemblyAttempts.push(assembledAttempt);
    attempts.push(assembledAttempt);
  }

  if (validationReport.status !== "pass") {
    return {
      status: "fail",
      documentSet,
      normalisedBrief,
      retrievalPacket,
      validationReport,
      attempts,
      sectionAttempts,
      assemblyAttempts,
      correctionAttempts,
      issue_ready_blocked: true,
    };
  }

  const provenance = await buildGenerationProvenance({
    root,
    provider,
    brief,
    normalisedBrief,
    retrievalPacket,
    documentSet,
    validationReport,
    structuredOutputSchema: buildSectionedStructuredOutputManifest(),
  });

  return {
    status: "pass",
    documentSet,
    normalisedBrief,
    retrievalPacket,
    validationReport,
    provenance: {
      ...provenance,
      pipeline_version: SECTIONED_GENERATION_PIPELINE_VERSION,
      generation_mode: "sectioned",
      section_attempts: sectionAttempts,
      assembly_attempts: assemblyAttempts,
      correction_attempts: correctionAttempts,
      assembled_validation: assembledAttempt,
    },
    attempts,
    sectionAttempts,
    assemblyAttempts,
    correctionAttempts,
  };
}

export async function buildSectionGenerationRequest(options) {
  const root = options.root ?? REPO_ROOT;
  const sectionName = assertKnownSection(options.sectionName);
  const promptSystem = await readFile(path.join(root, DEFAULT_PROMPT_PATH), "utf8");
  const outputSchema = options.outputSchema ?? buildSectionOutputSchema(sectionName);
  const acceptedContext = buildAcceptedSectionContext(options.acceptedSections ?? {}, sectionName);
  const acceptedContextText =
    Object.keys(acceptedContext).length > 0
      ? [
          "",
          "Accepted prior section outputs are fixed consistency context:",
          JSON.stringify(acceptedContext, null, 2),
        ].join("\n")
      : "";
  const riskSourceIdRepairText = buildRiskSourceIdRepairText({
    sectionName,
    correctionContext: options.correctionContext,
    retrievalPacket: options.retrievalPacket,
  });
  const currentSectionPayloadText = options.currentSectionPayload
    ? [
        "",
        "Current section payload to correct:",
        JSON.stringify(options.currentSectionPayload, null, 2),
      ].join("\n")
    : "";
  const assemblyCorrectionText = options.assemblyCorrectionContext
    ? [
        "",
        `Assembly rule-feedback correction round ${options.assemblyCorrectionContext.correction_round} for ${sectionName}.`,
        "Return a complete replacement section envelope, not a patch.",
        "Fix only the listed validation failures.",
        "Keep the output DRAFT-only and do not mark anything issue-ready.",
        "Preserve the section schema shape exactly.",
        "Use only retrieved KB records and the supplied project brief; do not invent WHS content.",
        buildAssemblyRuleFeedbackCorrectionText(options.assemblyCorrectionContext.failures),
        buildRisk007AssemblyCorrectionText({
          sectionName,
          failures: options.assemblyCorrectionContext.failures,
          sections: options.acceptedSections ?? {},
        }),
        "Filtered deterministic validation failures for this section:",
        JSON.stringify(options.assemblyCorrectionContext.failures, null, 2),
      ].join("\n")
    : "";
  const correctionText = options.correctionContext
    ? `\n\nCorrection attempt required for ${sectionName}. Previous failure:\n${JSON.stringify(
        options.correctionContext,
        null,
        2,
      )}`
    : "";

  return {
    model: options.model ?? DEFAULT_ANTHROPIC_MODEL,
    max_tokens: options.max_tokens ?? 24000,
    system: promptSystem,
    messages: [
      {
        role: "user",
        content: [
          `Generate only the ${sectionName} section envelope for a DRAFT project-level WHS document set.`,
          "Use only the retrieved KB records for HRCW triggers, controls, hold points and legal references.",
          "Return exactly one JSON object matching the section envelope schema.",
          "Do not return document_level or project; local assembly owns those fields.",
          "Do not add display/table-only keys or alternate field names.",
          "When accepted prior section outputs are supplied, keep HRCW refs, SWMS titles, hold point refs and hold point wording consistent with them.",
          "If an accepted hold_point_schedule is supplied, do not invent hold point refs outside it.",
          sectionInstruction(sectionName),
          ...(options.responseInstructions ?? []),
          "",
          "Normalised project brief:",
          JSON.stringify(options.normalisedBrief, null, 2),
          "",
          "Retrieval packet:",
          JSON.stringify(options.retrievalPacket, null, 2),
          acceptedContextText,
          riskSourceIdRepairText,
          currentSectionPayloadText,
          assemblyCorrectionText,
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

export function buildSectionOutputSchema(sectionName, options = {}) {
  const knownSectionName = assertKnownSection(sectionName);
  const documentSetSchema = buildDocumentSetOutputSchema({ anthropic: false });
  const keys = SECTION_KEYS[knownSectionName];
  const properties = {
    section_name: {
      type: "string",
      enum: [knownSectionName],
      description: "Must match the requested staged-generation section name.",
    },
  };

  for (const key of keys) {
    if (!documentSetSchema.properties[key]) {
      throw new Error(`Document-set schema does not define ${key}.`);
    }
    properties[key] = canonicalClone(documentSetSchema.properties[key]);
  }

  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: sectionSchemaId(knownSectionName),
    title: `WHS Sectioned Generation Envelope - ${knownSectionName}`,
    type: "object",
    additionalProperties: false,
    required: ["section_name", ...keys],
    properties,
    $defs: stripSchemaResourceIds(documentSetSchema.$defs ?? {}),
  };
  pruneUnusedSchemaDefinitions(schema);

  if (options.anthropic === false) {
    return schema;
  }

  return prepareForAnthropicStructuredOutputs(schema, {
    requireAllObjectProperties: options.requireAllObjectProperties ?? true,
  });
}

export function validateSectionEnvelope(envelope, sectionName, options = {}) {
  const knownSectionName = assertKnownSection(sectionName);
  const schema = buildSectionOutputSchema(knownSectionName, { anthropic: false });
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);

  if (!validate(envelope)) {
    return {
      status: "fail",
      section_name: knownSectionName,
      schema: {
        status: "fail",
        schema_id: sectionSchemaId(knownSectionName),
        errors: formatAjvErrors(validate.errors),
      },
      rules: null,
    };
  }

  if (knownSectionName === SUPPORT_BUNDLE_SECTION) {
    const approvedLegalReferences = approvedLegalReferencesFromRetrieval(options.retrievalPacket);
    if (
      canonicalStringify(envelope.legal_references) !== canonicalStringify(approvedLegalReferences)
    ) {
      return {
        status: "fail",
        section_name: knownSectionName,
        schema: {
          status: "fail",
          schema_id: sectionSchemaId(knownSectionName),
          errors: "legal_references must match the approved retrieved legal references.",
        },
        rules: null,
      };
    }
  }

  return {
    status: "pass",
    section_name: knownSectionName,
    schema: {
      status: "pass",
      schema_id: sectionSchemaId(knownSectionName),
      errors: "",
    },
    rules: null,
  };
}

export function buildAssemblyCorrectionPlan(validationReport, sections) {
  const failures = validationReport?.rules?.results;
  if (!Array.isArray(failures) || failures.length === 0) {
    return [];
  }

  const failuresBySection = new Map();
  for (const failure of failures) {
    for (const sectionName of correctionSectionsForFailure(failure, sections)) {
      addCorrectionFailure(failuresBySection, sectionName, failure);
    }
  }

  return correctionSectionOrder(sections)
    .filter((sectionName) => failuresBySection.has(sectionName))
    .map((sectionName) => ({
      section_name: sectionName,
      failures: failuresBySection.get(sectionName),
    }));
}

export function assembleSectionedDocumentSet({ normalisedBrief, retrievalPacket, sections }) {
  const supportBundle = sections[SUPPORT_BUNDLE_SECTION];
  return {
    document_level: "project_benchmark_register",
    project: canonicalClone(normalisedBrief.project),
    hrcw_register: canonicalClone(sections.hrcw_register),
    swms_matrix: canonicalClone(sections.swms_matrix),
    hold_point_schedule: canonicalClone(sections.hold_point_schedule),
    risk_register: canonicalClone(assembleRiskRegisterSections(sections)),
    swms_benchmark_reviews: canonicalClone(assembleSwmsBenchmarkReviewSections(sections)),
    swms_benchmark_note: supportBundle.swms_benchmark_note,
    intended_swms: canonicalClone(supportBundle.intended_swms),
    supporting_documents: canonicalClone(supportBundle.supporting_documents),
    confirmation_items: canonicalClone(supportBundle.confirmation_items),
    legal_references: approvedLegalReferencesFromRetrieval(retrievalPacket),
    historical_mode: supportBundle.historical_mode,
  };
}

export function createSectionedFixtureProvider(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const fixturePath = options.fixturePath ?? DEFAULT_SECTIONED_UNITAS_DOCUMENT_SET_PATH;
  let fixturePromise = null;

  return {
    provider_name: "sectioned-fixture",
    model: options.model ?? "fixture:unitas-golden-sectioned-document-set",
    async generate({ sectionName }) {
      fixturePromise ??= readJson(root, fixturePath);
      const documentSet = await fixturePromise;
      return buildSectionEnvelopeFromDocumentSet(sectionName, documentSet);
    },
  };
}

export function buildSectionEnvelopeFromDocumentSet(sectionName, documentSet) {
  const knownSectionName = assertKnownSection(sectionName);
  const envelope = {
    section_name: knownSectionName,
  };

  for (const key of SECTION_KEYS[knownSectionName]) {
    envelope[key] =
      key === "risk_register"
        ? canonicalClone(riskRegisterRowsForSection(knownSectionName, documentSet[key]))
        : key === "swms_benchmark_reviews"
          ? canonicalClone(swmsBenchmarkReviewRowsForSection(knownSectionName, documentSet[key]))
          : canonicalClone(documentSet[key]);
  }

  return envelope;
}

export function buildSectionEnvelopeFromSections(sectionName, sections) {
  const knownSectionName = assertKnownSection(sectionName);
  const envelope = {
    section_name: knownSectionName,
  };

  for (const key of SECTION_KEYS[knownSectionName]) {
    if (knownSectionName === SUPPORT_BUNDLE_SECTION) {
      envelope[key] = canonicalClone(sections[SUPPORT_BUNDLE_SECTION]?.[key]);
    } else if (key === "risk_register") {
      envelope[key] = canonicalClone(sections[knownSectionName] ?? []);
    } else if (key === "swms_benchmark_reviews") {
      envelope[key] = canonicalClone(sections[knownSectionName] ?? []);
    } else {
      envelope[key] = canonicalClone(sections[key]);
    }
  }

  return envelope;
}

export function parseSectionProviderResponse(response) {
  if (typeof response === "string") {
    return JSON.parse(response);
  }

  if (response?.section_name) {
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
    return parseSectionProviderResponse(JSON.parse(textBlock.text));
  }

  throw new Error("Provider response was not a parseable section envelope.");
}

export function buildSectionedStructuredOutputManifest() {
  return {
    mode: "sectioned",
    sections: SECTION_NAMES.map((sectionName) => ({
      section_name: sectionName,
      output_schema: buildSectionOutputSchema(sectionName),
    })),
  };
}

function extractSectionPayload(envelope, sectionName) {
  if (sectionName === SUPPORT_BUNDLE_SECTION) {
    return Object.fromEntries(
      SECTION_KEYS[sectionName].map((key) => [key, canonicalClone(envelope[key])]),
    );
  }

  if (isRiskRegisterSection(sectionName)) {
    return canonicalClone(envelope.risk_register);
  }

  if (isSwmsBenchmarkReviewSection(sectionName)) {
    return canonicalClone(envelope.swms_benchmark_reviews);
  }

  return canonicalClone(envelope[sectionName]);
}

function assembleRiskRegisterSections(sections) {
  if (sections.risk_register) {
    return sections.risk_register;
  }

  return RISK_REGISTER_CHUNK_SECTIONS.flatMap((sectionName) =>
    canonicalClone(sections[sectionName] ?? []),
  );
}

function assembleSwmsBenchmarkReviewSections(sections) {
  if (sections.swms_benchmark_reviews) {
    return sections.swms_benchmark_reviews;
  }

  return SWMS_BENCHMARK_REVIEW_CHUNK_SECTIONS.flatMap((sectionName) =>
    canonicalClone(sections[sectionName] ?? []),
  );
}

function buildAcceptedSectionContext(sections, sectionName) {
  const context = {};
  for (const key of ["hrcw_register", "hold_point_schedule", "swms_matrix"]) {
    if (sections[key] && key !== sectionName) {
      context[key] = canonicalClone(sections[key]);
    }
  }

  const priorRiskRows = RISK_REGISTER_CHUNK_SECTIONS.filter(
    (chunkName) => chunkName !== sectionName,
  ).flatMap((chunkName) => canonicalClone(sections[chunkName] ?? []));
  if (priorRiskRows.length > 0 && isRiskRegisterChunkSection(sectionName)) {
    context.risk_register_rows_generated_so_far = priorRiskRows.map((row) => ({
      ref: row.ref,
      activity: row.activity,
      hazard: row.hazard,
      swms_title: row.swms_title,
      hold_points: canonicalClone(row.hold_points ?? []),
    }));
  }

  if (sectionName === SUPPORT_BUNDLE_SECTION) {
    return {};
  }

  return context;
}

function buildRiskSourceIdRepairText({ sectionName, correctionContext, retrievalPacket }) {
  if (!isRiskRegisterChunkSection(sectionName)) {
    return "";
  }

  const failedPaths = riskSourceIdFailurePaths(correctionContext);
  if (failedPaths.length === 0) {
    return "";
  }

  return [
    "",
    "Risk source_id schema repair context:",
    "The previous risk chunk response failed because one or more controls had missing or empty source_ids.",
    "Repair the listed controls by selecting non-empty source_ids from the allowed retrieved control source IDs.",
    "Do not invent source_ids. Do not leave source_ids empty. Return a complete replacement risk_register section envelope.",
    "Failed source_id paths:",
    JSON.stringify(failedPaths, null, 2),
    "Allowed control source IDs:",
    JSON.stringify(retrievalPacket?.candidate_summary?.control_source_ids ?? [], null, 2),
    "Compact retrieved control source catalogue:",
    JSON.stringify(compactControlSourceCatalogue(retrievalPacket), null, 2),
  ].join("\n");
}

function riskSourceIdFailurePaths(correctionContext) {
  const errors = correctionContext?.schema?.errors;
  if (typeof errors !== "string" || !errors.includes("source_ids")) {
    return [];
  }

  const paths = new Set();
  for (const match of errors.matchAll(
    /\/risk_register\/\d+\/controls\/\d+\/source_ids(?=\s|;|$)/gu,
  )) {
    paths.add(match[0]);
  }
  for (const match of errors.matchAll(
    /(\/risk_register\/\d+\/controls\/\d+) must have required property 'source_ids'/gu,
  )) {
    paths.add(`${match[1]}/source_ids`);
  }

  return [...paths].sort();
}

function compactControlSourceCatalogue(retrievalPacket) {
  const rows = retrievalPacket?.retrieved?.control_library;
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows.map((row) =>
    Object.fromEntries(
      ["id", "hazard_type", "control", "levels", "linked_hold_point", "residual_floor"]
        .filter((key) => row[key] !== undefined)
        .map((key) => [key, canonicalClone(row[key])]),
    ),
  );
}

function buildAssemblyRuleFeedbackCorrectionText(failures = []) {
  if (!Array.isArray(failures) || failures.length === 0) {
    return "";
  }

  const ruleIds = new Set(failures.map((failure) => failure.rule_id));
  const guidance = [];

  if (ruleIds.has("CONTENT-001")) {
    guidance.push(
      "CONTENT-001: Remove approve/approves/approved/approval/approving wording from subcontractor SWMS text. Required wording for subcontractor SWMS is: reviewed by the principal contractor and accepted for commencement subject to project requirements and hold points.",
    );
  }

  if (ruleIds.has("RISK-004")) {
    guidance.push(
      "RISK-004: For the listed structural/access risk rows, include an engineer-release condition in the corrected risk row control text, residual justification, or an existing linked engineering_release hold point. Reuse accepted hold point refs where supplied; do not invent a new hold point.",
    );
  }

  if (ruleIds.has("RISK-007")) {
    guidance.push(
      "RISK-007: If an access method/access system confirmation item is still open, do not mark scaffold/EWP/platform/access-system controls as active_control. Keep access-specific controls as conditional_control until the access method is confirmed, and preserve the open confirmation item reference/status.",
    );
  }

  if (guidance.length === 0) {
    return "";
  }

  return ["Rule-specific deterministic repair guidance:", ...guidance].join("\n");
}

function buildRisk007AssemblyCorrectionText({ sectionName, failures = [], sections = {} }) {
  if (!isRiskRegisterChunkSection(sectionName)) {
    return "";
  }

  const targets = risk007TargetsForSection({ sectionName, failures, sections });
  if (targets.length === 0) {
    return "";
  }

  const openAccessItems = openAccessConfirmationItems(sections);
  const openAccessItemIds = openAccessItems.map((item) => item.id);

  return [
    "RISK-007 concrete access-control repair context:",
    "For each listed target control, set control_status to conditional_control while the access method/access system confirmation remains open.",
    "Preserve control text, levels and source_ids unless another listed failure requires a content change.",
    "Preserve HRCW refs, hold points, residual risk, residual justification and non-access active controls.",
    "Preserve the open access confirmation item. Do not close it, delete it or invent a new confirmation item.",
    "If the risk row has confirmation_item_refs, include the existing open access confirmation item id; if it is missing, add the existing id only.",
    "Open access confirmation items:",
    JSON.stringify(openAccessItems, null, 2),
    "Existing open access confirmation item ids:",
    JSON.stringify(openAccessItemIds, null, 2),
    "Target controls requiring status repair:",
    JSON.stringify(targets, null, 2),
  ].join("\n");
}

function openAccessConfirmationItems(sections) {
  const confirmationItems = sections?.[SUPPORT_BUNDLE_SECTION]?.confirmation_items;
  if (!Array.isArray(confirmationItems)) {
    return [];
  }

  return confirmationItems
    .filter(
      (item) =>
        item?.status === "open" &&
        OPEN_ACCESS_CONFIRMATION_PATTERN.test(`${item.id ?? ""} ${item.title ?? ""}`),
    )
    .map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      blocking_level: item.blocking_level,
      owner_role: item.owner_role,
      evidence_required: item.evidence_required,
    }));
}

function risk007TargetsForSection({ sectionName, failures, sections }) {
  const rows = sections[sectionName];
  if (!Array.isArray(rows)) {
    return [];
  }

  const offset = riskSectionOffset(sectionName, sections);
  const targets = [];

  for (const failure of failures) {
    if (failure?.rule_id !== "RISK-007") {
      continue;
    }

    const indexMatch = String(failure.json_path ?? "").match(
      /^\/risk_register\/(\d+)\/controls(?:\/|$)/u,
    );
    if (!indexMatch) {
      continue;
    }

    const assembled_row_index = Number(indexMatch[1]);
    const section_row_index = assembled_row_index - offset;
    if (section_row_index < 0 || section_row_index >= rows.length) {
      continue;
    }

    const row = rows[section_row_index];
    const offending_controls = (row.controls ?? [])
      .map((control, control_index) => ({ control, control_index }))
      .filter(
        ({ control }) =>
          control.control_status === "active_control" && accessSpecificControl(control),
      )
      .map(({ control, control_index }) => ({
        control_index,
        current_control_status: control.control_status,
        required_control_status: "conditional_control",
        source_ids: canonicalClone(control.source_ids ?? []),
      }));

    targets.push({
      assembled_row_index,
      section_row_index,
      row_ref: row.ref,
      risk_status: row.risk_status,
      scope_status: row.scope_status,
      confirmation_item_refs: canonicalClone(row.confirmation_item_refs ?? []),
      offending_controls,
    });
  }

  return targets;
}

function riskSectionOffset(sectionName, sections) {
  let offset = 0;
  for (const chunkName of RISK_REGISTER_CHUNK_SECTIONS) {
    if (chunkName === sectionName) {
      return offset;
    }
    offset += Array.isArray(sections[chunkName]) ? sections[chunkName].length : 0;
  }
  return offset;
}

function accessSpecificControl(control) {
  const text = [control?.text, ...(control?.source_ids ?? [])].join(" ");
  return ACCESS_SPECIFIC_CONTROL_PATTERN.test(text);
}

function correctionSectionsForFailure(failure, sections) {
  const sectionNames = new Set(correctionSectionsForJsonPath(failure.json_path, sections));

  if (failure.rule_id === "CONSISTENCY-003" || failure.rule_id === "CONSISTENCY-004") {
    sectionNames.add("hold_point_schedule");
    sectionNames.add("swms_matrix");
  }

  if (failure.rule_id === "CONSISTENCY-005") {
    sectionNames.add("swms_matrix");
    const riskSection = correctionSectionForIndexedPath(
      failure.json_path,
      "risk_register",
      riskCorrectionSectionNames(sections),
      sections,
    );
    if (riskSection) {
      sectionNames.add(riskSection);
    }
  }

  if (failure.rule_id === "CONSISTENCY-006") {
    for (const sectionName of riskCorrectionSectionNames(sections)) {
      sectionNames.add(sectionName);
    }
  }

  return [...sectionNames].filter((sectionName) => KNOWN_SECTION_NAMES.includes(sectionName));
}

function correctionSectionsForJsonPath(jsonPath, sections) {
  if (typeof jsonPath !== "string" || !jsonPath.startsWith("/")) {
    return [];
  }

  if (jsonPath.startsWith("/hrcw_register")) {
    return ["hrcw_register"];
  }
  if (jsonPath.startsWith("/hold_point_schedule")) {
    return ["hold_point_schedule"];
  }
  if (jsonPath.startsWith("/swms_matrix")) {
    return ["swms_matrix"];
  }
  if (jsonPath.startsWith("/risk_register")) {
    return [
      correctionSectionForIndexedPath(
        jsonPath,
        "risk_register",
        riskCorrectionSectionNames(sections),
        sections,
      ),
    ].filter(Boolean);
  }
  if (jsonPath.startsWith("/swms_benchmark_reviews")) {
    return [
      correctionSectionForIndexedPath(
        jsonPath,
        "swms_benchmark_reviews",
        swmsBenchmarkReviewCorrectionSectionNames(sections),
        sections,
      ),
    ].filter(Boolean);
  }
  if (
    [
      "/swms_benchmark_note",
      "/intended_swms",
      "/supporting_documents",
      "/confirmation_items",
      "/legal_references",
      "/historical_mode",
    ].some((pathPrefix) => jsonPath.startsWith(pathPrefix))
  ) {
    return [SUPPORT_BUNDLE_SECTION];
  }

  return [];
}

function correctionSectionForIndexedPath(jsonPath, arrayKey, sectionNames, sections) {
  if (sectionNames.length === 1) {
    return sectionNames[0];
  }

  const indexMatch = jsonPath.match(new RegExp(`^/${arrayKey}/(\\d+)(?:/|$)`, "u"));
  if (!indexMatch) {
    return null;
  }

  const targetIndex = Number(indexMatch[1]);
  let offset = 0;
  for (const sectionName of sectionNames) {
    const length = Array.isArray(sections[sectionName]) ? sections[sectionName].length : 0;
    if (targetIndex >= offset && targetIndex < offset + length) {
      return sectionName;
    }
    offset += length;
  }

  return sectionNames.at(-1) ?? null;
}

function addCorrectionFailure(failuresBySection, sectionName, failure) {
  const failures = failuresBySection.get(sectionName) ?? [];
  const filteredFailure = filteredCorrectionFailure(failure);
  const fingerprint = canonicalStringify(filteredFailure);
  if (!failures.some((existing) => canonicalStringify(existing) === fingerprint)) {
    failures.push(filteredFailure);
  }
  failuresBySection.set(sectionName, failures);
}

function filteredCorrectionFailure(failure) {
  return Object.fromEntries(
    [
      "rule_id",
      "suite",
      "status",
      "severity",
      "message",
      "json_path",
      "criterion_number",
      "dominant_defect",
    ]
      .filter((key) => failure[key] !== undefined)
      .map((key) => [key, canonicalClone(failure[key])]),
  );
}

function correctionSectionOrder(sections) {
  return [
    "hrcw_register",
    "hold_point_schedule",
    "swms_matrix",
    ...riskCorrectionSectionNames(sections),
    ...swmsBenchmarkReviewCorrectionSectionNames(sections),
    SUPPORT_BUNDLE_SECTION,
  ];
}

function riskCorrectionSectionNames(sections) {
  return sections.risk_register ? ["risk_register"] : RISK_REGISTER_CHUNK_SECTIONS;
}

function swmsBenchmarkReviewCorrectionSectionNames(sections) {
  return sections.swms_benchmark_reviews
    ? ["swms_benchmark_reviews"]
    : SWMS_BENCHMARK_REVIEW_CHUNK_SECTIONS;
}

function approvedLegalReferencesFromRetrieval(retrievalPacket) {
  const references = retrievalPacket?.retrieved?.legal_references?.references;
  if (!Array.isArray(references)) {
    throw new Error("Retrieval packet is missing approved legal references.");
  }
  return canonicalClone(references);
}

function sectionProviderFailureReport(sectionName, error) {
  return {
    status: "fail",
    section_name: assertKnownSection(sectionName),
    schema: {
      status: "not_run",
      schema_id: sectionSchemaId(sectionName),
      errors: "",
    },
    rules: null,
    provider_error: formatProviderError(error),
  };
}

function sectionInstruction(sectionName) {
  if (sectionName === SUPPORT_BUNDLE_SECTION) {
    return [
      "For support_bundle, return only intended_swms, supporting_documents, confirmation_items, legal_references, swms_benchmark_note and historical_mode.",
      "legal_references must be copied exactly from retrieval_packet.retrieved.legal_references.references.",
    ].join(" ");
  }

  if (isRiskRegisterChunkSection(sectionName)) {
    return [
      RISK_REGISTER_CHUNK_INSTRUCTIONS[sectionName],
      "Return only section_name and risk_register; do not include any other document-set sections.",
      "Each risk_register row must be complete and must not duplicate rows assigned to another risk_register_part section.",
      "Every risk_register row control must include controls[].source_ids as a non-empty array.",
      "Each source_ids value must be copied exactly from retrieval_packet.candidate_summary.control_source_ids.",
      "Do not invent source_ids and do not emit empty source_ids arrays.",
    ].join(" ");
  }

  if (isSwmsBenchmarkReviewChunkSection(sectionName)) {
    return [
      SWMS_BENCHMARK_REVIEW_CHUNK_INSTRUCTIONS[sectionName],
      "Return only section_name and swms_benchmark_reviews; do not include any other document-set sections.",
      "Each swms_benchmark_reviews row must align to exactly one accepted swms_matrix row.",
    ].join(" ");
  }

  return `Return only section_name and ${sectionName}; do not include any other document-set sections.`;
}

function sectionSchemaId(sectionName) {
  return `https://safemethod.app/schemas/sectioned-generation/${sectionName}.schema.json`;
}

function assertKnownSection(sectionName) {
  if (!KNOWN_SECTION_NAMES.includes(sectionName)) {
    throw new Error(`Unknown sectioned generation section '${sectionName}'.`);
  }
  return sectionName;
}

function isRiskRegisterSection(sectionName) {
  return sectionName === "risk_register" || isRiskRegisterChunkSection(sectionName);
}

function isRiskRegisterChunkSection(sectionName) {
  return RISK_REGISTER_CHUNK_SECTIONS.includes(sectionName);
}

function isSwmsBenchmarkReviewSection(sectionName) {
  return sectionName === "swms_benchmark_reviews" || isSwmsBenchmarkReviewChunkSection(sectionName);
}

function isSwmsBenchmarkReviewChunkSection(sectionName) {
  return SWMS_BENCHMARK_REVIEW_CHUNK_SECTIONS.includes(sectionName);
}

function riskRegisterRowsForSection(sectionName, rows) {
  if (!isRiskRegisterChunkSection(sectionName)) {
    return rows;
  }

  const chunkIndex = RISK_REGISTER_CHUNK_SECTIONS.indexOf(sectionName);
  const chunkSize = Math.ceil(rows.length / RISK_REGISTER_CHUNK_SECTIONS.length);
  const start = chunkIndex * chunkSize;
  return rows.slice(start, start + chunkSize);
}

function swmsBenchmarkReviewRowsForSection(sectionName, rows) {
  if (!isSwmsBenchmarkReviewChunkSection(sectionName)) {
    return rows;
  }

  const chunkIndex = SWMS_BENCHMARK_REVIEW_CHUNK_SECTIONS.indexOf(sectionName);
  const chunkSize = Math.ceil(rows.length / SWMS_BENCHMARK_REVIEW_CHUNK_SECTIONS.length);
  const start = chunkIndex * chunkSize;
  return rows.slice(start, start + chunkSize);
}

function stripSchemaResourceIds(value) {
  if (Array.isArray(value)) {
    return value.map((item) => stripSchemaResourceIds(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "$id" && key !== "$schema")
      .map(([key, child]) => [key, stripSchemaResourceIds(child)]),
  );
}

function pruneUnusedSchemaDefinitions(schema) {
  const defs = schema.$defs ?? {};
  const requiredNames = new Set();
  const queue = [...collectLocalDefinitionRefs({ ...schema, $defs: undefined })];

  while (queue.length > 0) {
    const definitionName = queue.shift();
    if (requiredNames.has(definitionName)) continue;
    requiredNames.add(definitionName);

    const definition = defs[definitionName];
    if (!definition) continue;
    for (const nestedDefinitionName of collectLocalDefinitionRefs(definition)) {
      if (!requiredNames.has(nestedDefinitionName)) {
        queue.push(nestedDefinitionName);
      }
    }
  }

  schema.$defs = Object.fromEntries(
    [...requiredNames]
      .sort()
      .filter((definitionName) => defs[definitionName])
      .map((definitionName) => [definitionName, defs[definitionName]]),
  );
}

function collectLocalDefinitionRefs(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectLocalDefinitionRefs(item));
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  const refs = [];
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string" && child.startsWith("#/$defs/")) {
      refs.push(child.slice("#/$defs/".length).split("/")[0]);
    } else {
      refs.push(...collectLocalDefinitionRefs(child));
    }
  }
  return refs;
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
