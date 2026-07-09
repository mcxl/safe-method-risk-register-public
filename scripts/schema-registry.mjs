import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(scriptsDirectory, "..");
export const SCHEMA_DIRECTORY = path.join(REPO_ROOT, "schemas");
export const SCHEMA_ID_BASE = "https://safemethod.app/schemas/";

export const CORE_GENERATION_SCHEMA_FILES = Object.freeze([
  "document-set.schema.json",
  "project-meta.schema.json",
  "hrcw-register-row.schema.json",
  "swms-matrix-row.schema.json",
  "hold-point.schema.json",
  "risk-register-row.schema.json",
]);

export function schemaIdForFileName(fileName) {
  return `${SCHEMA_ID_BASE}${fileName}`;
}

export function schemaFileNames(schemaDirectory = SCHEMA_DIRECTORY) {
  return readdirSync(schemaDirectory)
    .filter((name) => name.endsWith(".schema.json"))
    .sort();
}

export function readSchemaDocuments(schemaDirectory = SCHEMA_DIRECTORY) {
  return schemaFileNames(schemaDirectory).map((fileName) => {
    const absolutePath = path.join(schemaDirectory, fileName);
    return {
      fileName,
      absolutePath,
      schema: JSON.parse(readFileSync(absolutePath, "utf8")),
    };
  });
}

export function assertCoreGenerationSchemasPresent(schemaDocuments) {
  const present = new Set(schemaDocuments.map((document) => document.fileName));
  const missing = CORE_GENERATION_SCHEMA_FILES.filter((fileName) => !present.has(fileName));

  if (missing.length > 0) {
    throw new Error(`Missing core generation schema(s): ${missing.join(", ")}`);
  }
}

export function createAjvRegistry(schemaDocuments = readSchemaDocuments()) {
  assertCoreGenerationSchemasPresent(schemaDocuments);

  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
  });

  for (const { schema } of schemaDocuments) {
    ajv.addSchema(schema);
  }

  for (const { fileName, schema } of schemaDocuments) {
    const validSchema = ajv.validateSchema(schema);
    if (!validSchema) {
      throw new Error(`${fileName} is not a valid Draft 2020-12 schema`);
    }

    if (!ajv.getSchema(schema.$id)) {
      throw new Error(`${fileName} did not compile`);
    }
  }

  return {
    ajv,
    schemaDocuments,
    getValidator(fileName) {
      const validator = ajv.getSchema(schemaIdForFileName(fileName));
      if (!validator) {
        throw new Error(`No compiled schema for ${fileName}`);
      }
      return validator;
    },
  };
}

export function formatAjvErrors(errors) {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
}
