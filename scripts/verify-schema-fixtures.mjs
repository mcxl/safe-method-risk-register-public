import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { createAjvRegistry, formatAjvErrors, REPO_ROOT } from "./schema-registry.mjs";

const registry = createAjvRegistry();
const phase2Directory = path.join(REPO_ROOT, "fixtures", "phase2");
const validDirectory = path.join(phase2Directory, "schema-valid");
const invalidDirectory = path.join(phase2Directory, "schema-invalid");
const goldenDocumentSetPath = path.join(
  REPO_ROOT,
  "fixtures",
  "golden",
  "document-sets",
  "unitas-document-set.json",
);
const goldenBriefsDirectory = path.join(REPO_ROOT, "fixtures", "golden", "briefs");

const validCases = [
  {
    fileName: "document-set-structural-valid.json",
    schema: "document-set.schema.json",
  },
  {
    fileName: "document-set-phase3-conditional-valid.json",
    schema: "document-set.schema.json",
  },
  {
    fileName: "validation-report-valid.json",
    schema: "validation-report.schema.json",
  },
  {
    fileName: "workflow-record-valid.json",
    schema: "workflow-record.schema.json",
  },
  {
    fileName: "handoff-manifest-valid.json",
    schema: "handoff-manifest.schema.json",
  },
];

function readJson(absolutePath) {
  return JSON.parse(readFileSync(absolutePath, "utf8"));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function parentAtPath(target, pathSegments) {
  let current = target;
  for (const segment of pathSegments.slice(0, -1)) {
    current = current[segment];
  }
  return {
    parent: current,
    key: pathSegments[pathSegments.length - 1],
  };
}

function applyMutation(target, mutation) {
  const { parent, key } = parentAtPath(target, mutation.path);
  if (mutation.op === "set") {
    parent[key] = mutation.value;
    return;
  }
  if (mutation.op === "delete") {
    if (Array.isArray(parent)) {
      parent.splice(key, 1);
    } else {
      delete parent[key];
    }
    return;
  }
  throw new Error(`Unsupported mutation op: ${mutation.op}`);
}

function assertValid(filePath, schemaFileName) {
  const value = readJson(filePath);
  const before = JSON.stringify(value);
  const validate = registry.getValidator(schemaFileName);

  if (!validate(value)) {
    throw new Error(`${filePath} should validate: ${formatAjvErrors(validate.errors)}`);
  }

  const after = JSON.stringify(value);
  if (after !== before) {
    throw new Error(`${filePath} was mutated during validation`);
  }

  console.log(`PASS ${path.relative(REPO_ROOT, filePath)} validates as ${schemaFileName}`);
  return value;
}

for (const fixture of validCases) {
  assertValid(path.join(validDirectory, fixture.fileName), fixture.schema);
}

const optionalBooleanFixture = assertValid(
  path.join(validDirectory, "document-set-structural-valid.json"),
  "document-set.schema.json",
);

for (const [pathLabel, value] of [
  [
    "hrcw_register[0].blanket_all_packages",
    optionalBooleanFixture.hrcw_register[0].blanket_all_packages,
  ],
  [
    "risk_register[0].fall_arrest_reliant",
    optionalBooleanFixture.risk_register[0].fall_arrest_reliant,
  ],
  ["risk_register[0].latent_condition", optionalBooleanFixture.risk_register[0].latent_condition],
]) {
  if (value !== undefined) {
    throw new Error(
      `${pathLabel} should remain omitted; schema validation must not inject defaults`,
    );
  }
}
console.log("PASS omitted optional booleans remain omitted after Ajv validation");

const invalidFixtures = readdirSync(invalidDirectory)
  .filter((name) => name.endsWith(".fixture.json"))
  .sort();

for (const fixtureName of invalidFixtures) {
  const fixturePath = path.join(invalidDirectory, fixtureName);
  const fixture = readJson(fixturePath);
  const sourcePath = path.resolve(invalidDirectory, fixture.source);
  const value = cloneJson(readJson(sourcePath));

  for (const mutation of fixture.mutations) {
    applyMutation(value, mutation);
  }

  const validate = registry.getValidator(fixture.schema);
  if (validate(value)) {
    throw new Error(`${fixtureName} should fail validation: ${fixture.description}`);
  }

  console.log(`PASS ${path.relative(REPO_ROOT, fixturePath)} fails as expected`);
}

if (existsSync(goldenDocumentSetPath)) {
  const goldenDocumentSet = assertValid(goldenDocumentSetPath, "document-set.schema.json");
  const expectedGoldenCounts = {
    hrcw_register: 17,
    swms_matrix: 21,
    hold_point_schedule: 8,
    risk_register: 61,
    swms_benchmark_reviews: 21,
  };

  for (const [key, expectedCount] of Object.entries(expectedGoldenCounts)) {
    const actualCount = goldenDocumentSet[key]?.length;
    if (actualCount !== expectedCount) {
      throw new Error(
        `Golden document-set ${key} expected ${expectedCount} rows, found ${actualCount}`,
      );
    }
  }
  console.log("PASS golden Unitas document-set row counts match the Rev04 masters");
} else {
  console.log(
    "PENDING fixtures/golden/document-sets/unitas-document-set.json is required before Phase 2 can be green",
  );
}

if (existsSync(goldenBriefsDirectory)) {
  const goldenBriefs = readdirSync(goldenBriefsDirectory)
    .filter((name) => name.endsWith(".json"))
    .sort();
  for (const briefName of goldenBriefs) {
    assertValid(path.join(goldenBriefsDirectory, briefName), "project-brief.schema.json");
  }
}

console.log("PHASE 2 SCHEMA FIXTURES: PASS");
