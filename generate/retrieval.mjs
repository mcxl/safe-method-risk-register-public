import {
  buildKnowledgeSnapshot,
  canonicalClone,
  canonicalStringify,
  readJson,
  REPO_ROOT,
} from "../scripts/kb-source.mjs";

export const LEGAL_REFERENCES_PATH = "spec/legal-references.nsw.json";

export async function buildRetrievalPacket(normalisedBrief, options = {}) {
  const snapshot = options.snapshot ?? (await buildKnowledgeSnapshot(options.root ?? REPO_ROOT));
  const projectPackageSet = new Set(normalisedBrief.project.trade_packages);

  const scheduleRows = tableRows(snapshot, "schedule_1");
  const triggerRows = tableRows(snapshot, "hrcw_trigger_map").filter((row) =>
    projectPackageSet.has(row.package),
  );
  const controlRows = tableRows(snapshot, "control_library");
  const holdPointRows = tableRows(snapshot, "hold_point_patterns").filter((row) =>
    (row.applies_to ?? []).some((packageName) => projectPackageSet.has(packageName)),
  );
  const legalReferences = await readJson(options.root ?? REPO_ROOT, LEGAL_REFERENCES_PATH);

  return {
    retrieval_version: "phase4.retrieval.v1",
    brief_id: normalisedBrief.brief_id,
    kb_version: snapshot.kbVersion,
    jurisdiction: snapshot.jurisdiction,
    source_hash_sha256: snapshot.sourceHashSha256,
    source_manifest: canonicalClone(snapshot.sourceManifest),
    project: canonicalClone(normalisedBrief.project),
    package_mappings: canonicalClone(normalisedBrief.package_mappings),
    retrieved: {
      schedule_1: scheduleRows,
      hrcw_trigger_map: triggerRows,
      control_library: controlRows,
      hold_point_patterns: holdPointRows,
      legal_references: legalReferences,
    },
    candidate_summary: {
      note: "HRCW trigger-map rows are candidate triggers only; confirmed status must come from source facts, client confirmation or audited professional override.",
      hrcw_refs: summariseHrcwCandidates(triggerRows),
      control_source_ids: controlRows.map((row) => row.id),
      hold_point_source_pattern_ids: holdPointRows.map((row) => row.id),
    },
  };
}

export function assertRetrievalMatchesFixtureExpectations(brief, retrievalPacket) {
  const expectations = brief.fixture_expectations;
  if (!expectations) {
    return true;
  }

  const actualTriggered = retrievalPacket.candidate_summary.hrcw_refs.map((row) => ({
    ref: row.ref,
    triggered: row.triggered,
  }));
  assertSameCanonicalJson(
    actualTriggered,
    expectations.triggered_hrcw ?? [],
    "fixture_expectations.triggered_hrcw",
  );
  assertSameCanonicalJson(
    retrievalPacket.candidate_summary.hold_point_source_pattern_ids,
    expectations.hold_point_source_pattern_ids ?? [],
    "fixture_expectations.hold_point_source_pattern_ids",
  );
  assertSameCanonicalJson(
    [...retrievalPacket.candidate_summary.control_source_ids].sort(),
    [...(expectations.required_control_source_ids ?? [])].sort(),
    "fixture_expectations.required_control_source_ids",
  );

  return true;
}

export function controlSourceIdSet(retrievalPacket) {
  return new Set(retrievalPacket.candidate_summary.control_source_ids);
}

function tableRows(snapshot, tableName) {
  const file = snapshot.files.find((candidate) => candidate.tableName === tableName);
  if (!file) {
    throw new Error(`KB snapshot is missing table ${tableName}`);
  }
  return file.rowRecords.map((record) => canonicalClone(record.sourceRow));
}

function summariseHrcwCandidates(triggerRows) {
  const byRef = new Map();

  for (const row of triggerRows) {
    for (const trigger of row.triggers ?? []) {
      const existing = byRef.get(trigger.ref) ?? {
        ref: trigger.ref,
        triggered: "CONDITIONAL",
        packages: [],
        trigger_records: [],
      };

      if (trigger.status === "YES") {
        existing.triggered = "YES";
      }
      existing.packages.push(row.package);
      existing.trigger_records.push({
        package: row.package,
        status: trigger.status,
        rationale: trigger.rationale,
        condition: trigger.condition,
      });
      byRef.set(trigger.ref, existing);
    }
  }

  return [...byRef.values()].sort((left, right) => left.ref.localeCompare(right.ref));
}

function assertSameCanonicalJson(actual, expected, label) {
  if (canonicalStringify(actual) !== canonicalStringify(expected)) {
    throw new Error(
      `${label} mismatch.\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`,
    );
  }
}
