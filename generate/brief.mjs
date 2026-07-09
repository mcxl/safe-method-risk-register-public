import path from "node:path";

import {
  createAjvRegistry,
  formatAjvErrors,
  REPO_ROOT as SCHEMA_REPO_ROOT,
} from "../scripts/schema-registry.mjs";
import {
  buildKnowledgeSnapshot,
  canonicalClone,
  readJson,
  REPO_ROOT as KB_REPO_ROOT,
} from "../scripts/kb-source.mjs";

export const PROJECT_BRIEF_SCHEMA_FILE = "project-brief.schema.json";

export async function loadProjectBrief(relativePath, options = {}) {
  const root = options.root ?? KB_REPO_ROOT;
  const brief = await readJson(root, relativePath);
  validateProjectBrief(brief, options);
  return brief;
}

export function validateProjectBrief(brief, options = {}) {
  const registry = options.registry ?? createAjvRegistry();
  const validate = registry.getValidator(PROJECT_BRIEF_SCHEMA_FILE);

  if (!validate(brief)) {
    throw new Error(
      `${PROJECT_BRIEF_SCHEMA_FILE} validation failed: ${formatAjvErrors(validate.errors)}`,
    );
  }

  return true;
}

export async function normaliseProjectBrief(brief, options = {}) {
  validateProjectBrief(brief, options);

  const snapshot = options.snapshot ?? (await buildKnowledgeSnapshot(options.root ?? KB_REPO_ROOT));
  assertBriefJurisdictionMatchesKnowledge(brief, snapshot);

  const triggerMapFile = snapshot.files.find((file) => file.tableName === "hrcw_trigger_map");
  const packageIndex = createPackageIndex(
    triggerMapFile.rowRecords.map((record) => record.sourceRow),
  );
  const packageMappings = brief.trade_packages.map((tradePackage) =>
    resolvePackageMapping(tradePackage, packageIndex),
  );
  const canonicalPackages = uniqueInOrder(packageMappings.map((mapping) => mapping.canonical_name));

  return {
    brief: canonicalClone(brief),
    brief_id: brief.brief_id,
    schema_version: brief.schema_version,
    kb_version: snapshot.kbVersion,
    jurisdiction: snapshot.jurisdiction,
    project: {
      ...canonicalClone(brief.project),
      methodology_sequence: canonicalClone(brief.methodology_sequence),
      trade_packages: canonicalPackages,
      interfaces_constraints: canonicalClone(brief.interfaces_constraints),
    },
    package_mappings: packageMappings,
  };
}

export function createPackageIndex(triggerRows) {
  const index = new Map();
  const canonicalNames = new Set();

  for (const row of triggerRows) {
    canonicalNames.add(row.package);
    addPackageIndexEntry(index, row.package, row.package, "canonical");

    for (const alias of row.aliases ?? []) {
      addPackageIndexEntry(index, alias, row.package, "alias");
    }
  }

  return { index, canonicalNames };
}

export function normaliseLookupKey(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function resolvePackageMapping(tradePackage, packageIndex) {
  const requestedCanonical = tradePackage.canonical_name;

  if (requestedCanonical) {
    const requestedCanonicalKey = normaliseLookupKey(requestedCanonical);
    const canonicalHit = packageIndex.index.get(requestedCanonicalKey);
    if (!canonicalHit || canonicalHit.canonical_name !== requestedCanonical) {
      throw new Error(
        `Project brief package '${tradePackage.input_name}' declares unknown canonical package '${requestedCanonical}'.`,
      );
    }

    return {
      input_name: tradePackage.input_name,
      canonical_name: requestedCanonical,
      matched_by: "declared_canonical",
    };
  }

  const inputKey = normaliseLookupKey(tradePackage.input_name);
  const hit = packageIndex.index.get(inputKey);
  if (!hit) {
    throw new Error(`Project brief package '${tradePackage.input_name}' did not match a KB alias.`);
  }

  return {
    input_name: tradePackage.input_name,
    canonical_name: hit.canonical_name,
    matched_by: hit.matched_by,
  };
}

function addPackageIndexEntry(index, name, canonicalName, matchedBy) {
  const key = normaliseLookupKey(name);
  if (!key) {
    throw new Error(`Empty package name in KB trigger map for ${canonicalName}`);
  }

  const existing = index.get(key);
  if (existing && existing.canonical_name !== canonicalName) {
    throw new Error(
      `Package alias '${name}' maps to both '${existing.canonical_name}' and '${canonicalName}'.`,
    );
  }

  index.set(key, {
    canonical_name: canonicalName,
    matched_by: matchedBy,
  });
}

function uniqueInOrder(values) {
  const seen = new Set();
  const unique = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      unique.push(value);
    }
  }
  return unique;
}

function assertBriefJurisdictionMatchesKnowledge(brief, snapshot) {
  const briefJurisdiction = brief.project?.jurisdiction;
  if (briefJurisdiction !== snapshot.jurisdiction) {
    throw new Error(
      `Project brief jurisdiction '${briefJurisdiction}' does not match KB jurisdiction '${snapshot.jurisdiction}'.`,
    );
  }
}

export function resolveRepoPath(...parts) {
  return path.join(SCHEMA_REPO_ROOT, ...parts);
}
