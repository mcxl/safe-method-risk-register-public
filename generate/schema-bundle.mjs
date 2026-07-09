import { CORE_GENERATION_SCHEMA_FILES, readSchemaDocuments } from "../scripts/schema-registry.mjs";

export const DOCUMENT_SET_SCHEMA_FILE = "document-set.schema.json";

const UNSUPPORTED_STRUCTURED_OUTPUT_KEYWORDS = new Set([
  "$schema",
  "$id",
  "default",
  "format",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
]);

export function buildDocumentSetOutputSchema(options = {}) {
  const schemaDocuments = options.schemaDocuments ?? readSchemaDocuments();
  const schemasByFileName = new Map(
    schemaDocuments.map((document) => [document.fileName, document.schema]),
  );
  const requiredFiles = collectReferencedSchemaFiles(DOCUMENT_SET_SCHEMA_FILE, schemasByFileName);
  const root = rewriteRefs(deepClone(schemasByFileName.get(DOCUMENT_SET_SCHEMA_FILE)));
  const defs = {};

  for (const fileName of requiredFiles) {
    if (fileName === DOCUMENT_SET_SCHEMA_FILE) continue;
    const schema = schemasByFileName.get(fileName);
    const bundledDefinition = withoutNestedDefs(rewriteRefs(deepClone(schema)));
    if (hasSchemaAssertions(bundledDefinition)) {
      defs[definitionNameForFileName(fileName)] = bundledDefinition;
    }

    for (const [definitionName, definition] of Object.entries(schema.$defs ?? {})) {
      defs[nestedDefinitionNameForFileName(fileName, definitionName)] = rewriteRefs(
        deepClone(definition),
        fileName,
      );
    }
  }

  const bundled = {
    ...root,
    $defs: defs,
  };

  if (options.anthropic === false) {
    return bundled;
  }

  return prepareForAnthropicStructuredOutputs(bundled, {
    requireAllObjectProperties: options.requireAllObjectProperties ?? true,
  });
}

export function prepareForAnthropicStructuredOutputs(schema, options = {}) {
  return walkSchema(schema, (node) => {
    const next = {};

    for (const [key, value] of Object.entries(node)) {
      if (UNSUPPORTED_STRUCTURED_OUTPUT_KEYWORDS.has(key)) {
        continue;
      }
      next[key] = value;
    }

    if (next.type === "object" && next.properties && next.additionalProperties === undefined) {
      next.additionalProperties = false;
    }

    if (options.requireAllObjectProperties && next.type === "object" && next.properties) {
      next.required = Object.keys(next.properties);
    }

    return next;
  });
}

export function buildDocumentSetSmokeOutputSchema() {
  return {
    title: "WHS Document Set Live Smoke Envelope",
    type: "object",
    additionalProperties: false,
    required: ["document_set_json"],
    properties: {
      document_set_json: {
        type: "string",
        description:
          "A JSON string containing the complete DRAFT WHS document-set object. Local validators parse and validate it against the full document-set schema and deterministic rules.",
      },
    },
  };
}

function collectReferencedSchemaFiles(rootFileName, schemasByFileName, seen = new Set()) {
  if (seen.has(rootFileName)) {
    return seen;
  }

  const schema = schemasByFileName.get(rootFileName);
  if (!schema) {
    throw new Error(`Missing schema ${rootFileName}`);
  }

  seen.add(rootFileName);
  for (const ref of collectRefs(schema)) {
    const fileName = fileNameFromRef(ref);
    if (schemasByFileName.has(fileName)) {
      collectReferencedSchemaFiles(fileName, schemasByFileName, seen);
    }
  }

  for (const fileName of CORE_GENERATION_SCHEMA_FILES) {
    if (schemasByFileName.has(fileName)) {
      collectReferencedSchemaFiles(fileName, schemasByFileName, seen);
    }
  }

  return seen;
}

function collectRefs(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectRefs(item));
  }
  if (!value || typeof value !== "object") {
    return [];
  }

  const refs = [];
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string") {
      refs.push(child);
    } else {
      refs.push(...collectRefs(child));
    }
  }
  return refs;
}

function rewriteRefs(value, currentFileName = null) {
  return walkSchema(value, (node) => {
    const fileName =
      typeof node.$ref === "string" ? fileNameFromRef(node.$ref) || currentFileName : null;
    if (fileName?.endsWith(".schema.json")) {
      return {
        ...node,
        $ref: bundledDefinitionRef(node.$ref, fileName),
      };
    }
    return node;
  });
}

function fileNameFromRef(ref) {
  return String(ref).split("#")[0];
}

function bundledRefFragment(ref) {
  const fragmentIndex = String(ref).indexOf("#");
  if (fragmentIndex === -1) {
    return "";
  }

  const fragment = String(ref).slice(fragmentIndex + 1);
  return fragment.startsWith("/") ? fragment : `/${fragment}`;
}

function bundledDefinitionRef(ref, fileName) {
  const fragment = bundledRefFragment(ref);
  return `#/$defs/${definitionNameForFileNameAndFragment(fileName, fragment)}`;
}

function definitionNameForFileNameAndFragment(fileName, fragment) {
  const match = fragment.match(/^\/\$defs\/([^/]+)$/u);
  if (match) {
    return nestedDefinitionNameForFileName(fileName, match[1]);
  }
  return definitionNameForFileName(fileName);
}

function nestedDefinitionNameForFileName(fileName, definitionName) {
  return `${definitionNameForFileName(fileName)}__${definitionName}`;
}

function withoutNestedDefs(schema) {
  if (!schema || typeof schema !== "object" || !schema.$defs) {
    return schema;
  }

  const schemaWithoutNestedDefs = { ...schema };
  delete schemaWithoutNestedDefs.$defs;
  return schemaWithoutNestedDefs;
}

function hasSchemaAssertions(schema) {
  if (!schema || typeof schema !== "object") {
    return false;
  }

  const metadataOnlyKeywords = new Set(["$schema", "$id", "title", "description"]);
  return Object.keys(schema).some((key) => !metadataOnlyKeywords.has(key));
}

function walkSchema(value, visitor) {
  if (Array.isArray(value)) {
    return value.map((item) => walkSchema(item, visitor));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const walked = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, walkSchema(child, visitor)]),
  );
  return visitor(walked);
}

function definitionNameForFileName(fileName) {
  return fileName.replace(/\.schema\.json$/u, "");
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}
