import { readFileSync } from "node:fs";
import path from "node:path";

import { deriveVerdict, loadDocumentSet, validateDocumentSet } from "./index.mjs";

export const PHASE3_RULE_FIXTURE_MANIFEST = "fixtures/phase3/rule-invalid/manifest.json";
export const PHASE3_VERDICT_FIXTURES = "fixtures/phase3/verdict-cases.json";
export const GOLDEN_DOCUMENT_SET = "fixtures/golden/document-sets/unitas-document-set.json";

export function readJson(relativePath) {
  return JSON.parse(readFileSync(path.resolve(relativePath), "utf8"));
}

export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function applyMutations(value, mutations) {
  const target = cloneJson(value);
  for (const mutation of mutations) {
    applyMutation(target, mutation);
  }
  return target;
}

export function loadPhase3Cases() {
  const manifest = readJson(PHASE3_RULE_FIXTURE_MANIFEST);
  const sourcePath = path.resolve(path.dirname(PHASE3_RULE_FIXTURE_MANIFEST), manifest.source);
  const sourceDocumentSet = JSON.parse(readFileSync(sourcePath, "utf8"));
  return {
    manifest,
    sourceDocumentSet,
    cases: manifest.cases,
  };
}

export function runPhase3Case(sourceDocumentSet, fixtureCase) {
  const mutated = applyMutations(sourceDocumentSet, fixtureCase.mutations);
  const report = validateDocumentSet(mutated, fixtureCase.options ?? {});
  const actualRuleIds = [...new Set(report.results.map((result) => result.rule_id))].sort();
  const expectedRuleIds = [...fixtureCase.expected_rule_ids].sort();

  return {
    fixtureCase,
    report,
    actualRuleIds,
    expectedRuleIds,
    passes:
      JSON.stringify(actualRuleIds) === JSON.stringify(expectedRuleIds) &&
      criterionMatches(report, fixtureCase),
  };
}

export function runVerdictCase(verdictCase) {
  const verdict = deriveVerdict(verdictCase.results, verdictCase.options);
  return {
    verdictCase,
    verdict,
    passes:
      verdict.rating === verdictCase.expected_rating &&
      (!verdictCase.expected_dominant_defect ||
        verdict.dominant_defect === verdictCase.expected_dominant_defect),
  };
}

export function goldenRuleReport() {
  return validateDocumentSet(loadDocumentSet(GOLDEN_DOCUMENT_SET));
}

function applyMutation(target, mutation) {
  const { parent, key } = parentAtPath(target, mutation.path);
  if (mutation.op === "set") {
    parent[key] = cloneJson(mutation.value);
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

function criterionMatches(report, fixtureCase) {
  if (!fixtureCase.expected_criterion_number) return true;
  return report.results.some(
    (result) =>
      result.rule_id === fixtureCase.expected_rule_ids[0] &&
      result.criterion_number === fixtureCase.expected_criterion_number,
  );
}
