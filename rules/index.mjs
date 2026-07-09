import { readFileSync } from "node:fs";
import path from "node:path";

export const VERDICT_RATINGS = Object.freeze({
  confirmed: "Benchmark Quality Confirmed",
  caveats: "Benchmark Quality With Caveats",
  strongDraft: "Strong Working Draft",
  belowDraft: "Below Strong Working Draft",
});

const RISK_ORDER = Object.freeze({
  Low: 1,
  Medium: 2,
  High: 3,
});

const HIGH_ENERGY_TAGS = new Set([
  "fall_from_height",
  "suspended_load",
  "crane_lift",
  "mobile_plant",
  "temporary_works",
  "unverified_roof_access",
  "openings",
  "large_public_or_occupied_interface",
]);

const ADMIN_PPE_LEVELS = new Set(["administrative", "ppe"]);

const ENGINEERING_RELEASE_WORDS = [
  "engineer",
  "engineering",
  "geotechnical",
  "temporary works designer",
  "design",
  "authorisation",
  "authorization",
  "release",
];

const WEAK_CONTROL_PATTERNS = [
  { label: "use safe work practices", pattern: /\buse safe work practices\b/i },
  { label: "ensure awareness", pattern: /\bensure awareness\b/i },
  { label: "bare wear PPE", pattern: /^\s*wear\s+ppe\s*\.?\s*$/i },
  { label: "follow SWMS", pattern: /\bfollow (the )?swms\b/i },
  { label: "use trained workers", pattern: /\buse trained workers\b/i },
  { label: "monitor conditions", pattern: /^\s*monitor conditions\s*\.?\s*$/i },
];

const DISALLOWED_TERMS = [
  {
    pattern: /\bprincipal contractor approval\b/i,
    message: "Uses non-standard 'principal contractor approval' terminology.",
  },
  {
    pattern: /\bwhite card licence\b/i,
    message: "Invented licence term 'white card licence'.",
  },
  {
    pattern: /\bworking at heights licence\b/i,
    message: "Invented licence term 'working at heights licence'.",
  },
  {
    pattern: /\bheight safety licence\b/i,
    message: "Invented licence term 'height safety licence'.",
  },
];

const CONFIRMED_HRCW_STATUS = "confirmed_hrcw";
const CONDITIONAL_HRCW_STATUS = "conditional_hrcw";
const CURRENT_WHS_REGULATION_EFFECTIVE_FROM = "2025-09-01";
const FINAL_MODES = new Set(["final", "issue", "issued", "issue_ready"]);

const NUMBER_PATTERN = /(?<![A-Za-z0-9])(?:>\s*)?(?:\d+(?:\.\d+)?\s?(?:m|mm|kg|MPa)|[0-9]+\s?%)/gi;

export function validateDocumentSet(documentSet, options = {}) {
  const issues = [
    ...validateConsistency(documentSet),
    ...validateContent(documentSet),
    ...validateRisk(documentSet),
    ...validateSwmsReview(documentSet),
    ...validateConditionalRiskControls(documentSet, options),
  ];
  const verdict = deriveVerdict(issues, options);

  return {
    status: issues.length > 0 ? "fail" : "pass",
    results: issues,
    verdict,
  };
}

export function deriveVerdict(results, options = {}) {
  const failures = results.filter((result) => result.status === "fail");
  if (failures.length === 0) {
    const caveatCount = Number(options.caveatCount ?? 0);
    if (caveatCount > 0) {
      return { rating: VERDICT_RATINGS.caveats };
    }
    return { rating: VERDICT_RATINGS.confirmed };
  }

  const dominant = failures.find((result) => result.dominant_defect) ?? failures[0];
  const severeSuites = new Set(["content", "risk"]);

  if (failures.length > 2 || severeSuites.has(dominant.suite)) {
    return {
      rating: VERDICT_RATINGS.belowDraft,
      dominant_defect: `${dominant.rule_id}: ${dominant.message}`,
    };
  }

  return { rating: VERDICT_RATINGS.strongDraft };
}

export function loadDocumentSet(relativePath) {
  return JSON.parse(readFileSync(path.resolve(relativePath), "utf8"));
}

function issue(rule_id, suite, message, json_path, extra = {}) {
  return {
    rule_id,
    suite,
    status: "fail",
    severity: extra.severity ?? "error",
    message,
    ...(json_path ? { json_path } : {}),
    ...(extra.criterion_number ? { criterion_number: extra.criterion_number } : {}),
    ...(extra.dominant_defect ? { dominant_defect: true } : {}),
  };
}

function validateConsistency(documentSet) {
  const issues = [];
  const packages = new Set(documentSet.project?.trade_packages ?? []);
  const scheduledHoldPoints = new Map(
    (documentSet.hold_point_schedule ?? []).map((holdPoint) => [holdPoint.ref, holdPoint]),
  );
  const hrcwRows = new Map((documentSet.hrcw_register ?? []).map((row) => [row.ref, row]));
  const swmsTitles = new Set((documentSet.swms_matrix ?? []).map((row) => row.swms_title));

  const packageReferences = [];
  for (const [index, row] of (documentSet.hrcw_register ?? []).entries()) {
    for (const [packageIndex, packageName] of (row.packages ?? []).entries()) {
      packageReferences.push({
        packageName,
        path: `/hrcw_register/${index}/packages/${packageIndex}`,
      });
    }
  }
  for (const [index, row] of (documentSet.swms_matrix ?? []).entries()) {
    packageReferences.push({ packageName: row.trade_package, path: `/swms_matrix/${index}` });
  }
  for (const [index, row] of (documentSet.hold_point_schedule ?? []).entries()) {
    for (const [packageIndex, packageName] of (row.packages ?? []).entries()) {
      packageReferences.push({
        packageName,
        path: `/hold_point_schedule/${index}/packages/${packageIndex}`,
      });
    }
  }
  for (const [index, row] of (documentSet.risk_register ?? []).entries()) {
    packageReferences.push({ packageName: row.trade_package, path: `/risk_register/${index}` });
  }
  for (const [index, row] of (documentSet.swms_benchmark_reviews ?? []).entries()) {
    packageReferences.push({
      packageName: row.trade_package,
      path: `/swms_benchmark_reviews/${index}`,
    });
  }

  for (const reference of packageReferences) {
    if (!packages.has(reference.packageName)) {
      issues.push(
        issue(
          "CONSISTENCY-001",
          "consistency",
          `Package reference '${reference.packageName}' is not an exact canonical project package.`,
          reference.path,
          { dominant_defect: true },
        ),
      );
    }
  }

  const expectedHrcwRefs = Array.from(
    { length: 17 },
    (_, index) => `H${String(index + 1).padStart(2, "0")}`,
  );
  const actualHrcwRefs = (documentSet.hrcw_register ?? []).map((row) => row.ref);
  if (JSON.stringify(actualHrcwRefs) !== JSON.stringify(expectedHrcwRefs)) {
    issues.push(
      issue(
        "CONSISTENCY-002",
        "consistency",
        "HRCW register refs must be exactly H01-H17 in order.",
        "/hrcw_register",
        { dominant_defect: true },
      ),
    );
  }

  for (const [index, row] of (documentSet.swms_matrix ?? []).entries()) {
    for (const ref of row.hrcw_refs ?? []) {
      const hrcwRow = hrcwRows.get(ref);
      if (!hrcwRow || hrcwRow.triggered === "NO") {
        issues.push(
          issue(
            "CONSISTENCY-002",
            "consistency",
            `SWMS Matrix references HRCW ${ref}, which is not triggered in the HRCW Register.`,
            `/swms_matrix/${index}/hrcw_refs`,
            { dominant_defect: true },
          ),
        );
      }
    }
  }
  for (const [index, row] of (documentSet.risk_register ?? []).entries()) {
    for (const ref of row.hrcw_categories ?? []) {
      const hrcwRow = hrcwRows.get(ref);
      if (!hrcwRow || hrcwRow.triggered === "NO") {
        issues.push(
          issue(
            "CONSISTENCY-002",
            "consistency",
            `Risk row ${row.ref} references HRCW ${ref}, which is not triggered in the HRCW Register.`,
            `/risk_register/${index}/hrcw_categories`,
            { dominant_defect: true },
          ),
        );
      }
    }
  }

  const bodyHoldPointRefs = new Set();
  for (const [index, row] of (documentSet.swms_matrix ?? []).entries()) {
    for (const ref of row.hold_points ?? []) {
      bodyHoldPointRefs.add(ref);
      if (!scheduledHoldPoints.has(ref)) {
        issues.push(
          issue(
            "CONSISTENCY-003",
            "consistency",
            `SWMS Matrix references hold point ${ref}, which is absent from the schedule.`,
            `/swms_matrix/${index}/hold_points`,
            { dominant_defect: true },
          ),
        );
      }
    }
  }
  for (const [index, row] of (documentSet.risk_register ?? []).entries()) {
    for (const ref of row.hold_points ?? []) {
      bodyHoldPointRefs.add(ref);
      if (!scheduledHoldPoints.has(ref)) {
        issues.push(
          issue(
            "CONSISTENCY-003",
            "consistency",
            `Risk row ${row.ref} references hold point ${ref}, which is absent from the schedule.`,
            `/risk_register/${index}/hold_points`,
            { dominant_defect: true },
          ),
        );
      }
    }
  }
  for (const ref of scheduledHoldPoints.keys()) {
    if (!bodyHoldPointRefs.has(ref)) {
      issues.push(
        issue(
          "CONSISTENCY-003",
          "consistency",
          `Scheduled hold point ${ref} is not referenced in the body.`,
          "/hold_point_schedule",
          { dominant_defect: true },
        ),
      );
    }
  }
  if (bodyHoldPointRefs.size !== scheduledHoldPoints.size) {
    issues.push(
      issue(
        "CONSISTENCY-003",
        "consistency",
        `Hold point body count ${bodyHoldPointRefs.size} does not equal schedule count ${scheduledHoldPoints.size}.`,
        "/hold_point_schedule",
        { dominant_defect: true },
      ),
    );
  }

  for (const [index, row] of (documentSet.swms_matrix ?? []).entries()) {
    if (!row.hold_point_notes) continue;
    for (const ref of row.hold_points ?? []) {
      const holdPoint = scheduledHoldPoints.get(ref);
      if (holdPoint && !wordingOverlaps(row.hold_point_notes, holdPoint.title)) {
        issues.push(
          issue(
            "CONSISTENCY-004",
            "consistency",
            `Hold point ${ref} wording in the SWMS Matrix does not match the schedule title.`,
            `/swms_matrix/${index}/hold_point_notes`,
            { dominant_defect: true },
          ),
        );
      }
    }
  }

  for (const [index, row] of (documentSet.risk_register ?? []).entries()) {
    if (!row.swms_title || row.swms_title === "—" || isGenericSwmsReference(row.swms_title)) {
      continue;
    }
    if (!swmsTitles.has(row.swms_title) && !swmsTitleLooselyResolves(row.swms_title, swmsTitles)) {
      issues.push(
        issue(
          "CONSISTENCY-005",
          "consistency",
          `Risk row ${row.ref} references SWMS title '${row.swms_title}' that is not resolved in the SWMS Matrix.`,
          `/risk_register/${index}/swms_title`,
          { dominant_defect: true },
        ),
      );
    }
  }

  const hazardsByRef = new Map();
  for (const [index, row] of (documentSet.risk_register ?? []).entries()) {
    const normalizedHazard = normalizeMeaning(row.hazard);
    const prior = hazardsByRef.get(row.ref);
    if (prior && prior !== normalizedHazard) {
      issues.push(
        issue(
          "CONSISTENCY-006",
          "consistency",
          `Risk ref ${row.ref} is reused for two different hazard meanings.`,
          `/risk_register/${index}/ref`,
          { dominant_defect: true },
        ),
      );
    }
    hazardsByRef.set(row.ref, normalizedHazard);
  }

  return issues;
}

function validateContent(documentSet) {
  const issues = [];
  const textNodes = collectTextNodes(documentSet);

  for (const node of textNodes) {
    if (/\bapprov(?:e|es|ed|al|ing)\b/i.test(node.value) && /swms/i.test(node.value)) {
      issues.push(
        issue(
          "CONTENT-001",
          "content",
          "Subcontractor SWMS language must use reviewed-and-accepted wording, not approval wording.",
          node.path,
          { dominant_defect: true },
        ),
      );
    }
  }

  for (const [index, row] of (documentSet.hrcw_register ?? []).entries()) {
    if (row.blanket_all_packages === true && !nonEmpty(row.blanket_justification)) {
      issues.push(
        issue(
          "CONTENT-002",
          "content",
          `HRCW ${row.ref} uses blanket all-packages without a justification.`,
          `/hrcw_register/${index}/blanket_all_packages`,
          { dominant_defect: true },
        ),
      );
    }

    if (row.triggered === "CONDITIONAL" && !nonEmpty(row.condition)) {
      issues.push(
        issue(
          "CONTENT-007",
          "content",
          `HRCW ${row.ref} is CONDITIONAL but has no condition.`,
          `/hrcw_register/${index}/condition`,
          { dominant_defect: true },
        ),
      );
    }

    if (row.triggered === "YES" && (row.packages ?? []).length === 0) {
      issues.push(
        issue(
          "CONTENT-008",
          "content",
          `HRCW ${row.ref} is YES but lists no packages.`,
          `/hrcw_register/${index}/packages`,
          { dominant_defect: true },
        ),
      );
    }

    const rowText = [row.risk_description, row.notes, row.condition].join(" ");
    if (row.ref === "H12" && row.triggered !== "NO" && silicaOnly(rowText)) {
      issues.push(
        issue(
          "CONTENT-003",
          "content",
          "Silica/RCS dust alone must not be classified as H12.",
          `/hrcw_register/${index}`,
          { dominant_defect: true },
        ),
      );
    }

    if (row.ref === "H06" && row.triggered === "YES" && row.assessment_confirmed !== true) {
      issues.push(
        issue(
          "CONTENT-004",
          "content",
          "H06 confined space cannot be triggered without assessment_confirmed=true.",
          `/hrcw_register/${index}/assessment_confirmed`,
          { dominant_defect: true },
        ),
      );
    }
  }

  for (const node of textNodes) {
    for (const term of DISALLOWED_TERMS) {
      if (term.pattern.test(node.value)) {
        issues.push(
          issue("CONTENT-005", "content", term.message, node.path, { dominant_defect: true }),
        );
      }
    }
  }

  for (const [rowIndex, row] of (documentSet.risk_register ?? []).entries()) {
    for (const [controlIndex, control] of (row.controls ?? []).entries()) {
      const numericMatches = uniqueMatches(control.text ?? "", NUMBER_PATTERN);
      if (numericMatches.length > 0 && !Array.isArray(control.fixed_numeric_limits)) {
        issues.push(
          issue(
            "CONTENT-006",
            "content",
            `Risk row ${row.ref} has fixed numeric limit(s) without fixed_numeric_limits basis metadata.`,
            `/risk_register/${rowIndex}/controls/${controlIndex}`,
            { dominant_defect: true },
          ),
        );
      }
      for (const pattern of WEAK_CONTROL_PATTERNS) {
        if (pattern.pattern.test(control.text ?? "")) {
          issues.push(
            issue(
              "CONTENT-009",
              "content",
              `Risk row ${row.ref} uses weak control phrase '${pattern.label}'.`,
              `/risk_register/${rowIndex}/controls/${controlIndex}/text`,
              { dominant_defect: true },
            ),
          );
        }
      }
    }
  }

  return issues;
}

function validateRisk(documentSet) {
  const issues = [];
  const holdPointsByRef = new Map(
    (documentSet.hold_point_schedule ?? []).map((holdPoint) => [holdPoint.ref, holdPoint]),
  );

  for (const [index, row] of (documentSet.risk_register ?? []).entries()) {
    const tags = new Set(row.classification_tags ?? []);
    const controls = row.controls ?? [];
    const levels = controls.flatMap((control) => control.levels ?? []);
    const allControlsAreAdminOrPpe =
      levels.length > 0 && levels.every((level) => ADMIN_PPE_LEVELS.has(level));

    if (row.high_energy === true && row.residual_risk === "Low" && allControlsAreAdminOrPpe) {
      issues.push(
        issue(
          "RISK-001",
          "risk",
          `High-energy risk row ${row.ref} drops to Low on administrative/PPE controls alone.`,
          `/risk_register/${index}/residual_risk`,
          { dominant_defect: true },
        ),
      );
    }

    if (
      (tags.has("crane_lift") || row.fall_arrest_reliant === true) &&
      riskBelow(row.residual_risk, "Medium")
    ) {
      issues.push(
        issue(
          "RISK-002",
          "risk",
          `Crane lift or fall-arrest-reliant risk row ${row.ref} is below Medium residual risk.`,
          `/risk_register/${index}/residual_risk`,
          { dominant_defect: true },
        ),
      );
    }

    if (
      (tags.has("fall_from_height") || tags.has("large_public_or_occupied_interface")) &&
      riskBelow(row.residual_risk, "Medium")
    ) {
      issues.push(
        issue(
          "RISK-003",
          "risk",
          `Height or large public-interface risk row ${row.ref} is below Medium residual risk.`,
          `/risk_register/${index}/residual_risk`,
          { dominant_defect: true },
        ),
      );
    }

    if (tags.has("engineering_release_required") && !hasEngineeringRelease(row, holdPointsByRef)) {
      issues.push(
        issue(
          "RISK-004",
          "risk",
          `Structural/access risk row ${row.ref} has no engineer-release condition.`,
          `/risk_register/${index}`,
          { dominant_defect: true },
        ),
      );
    }

    if (row.fall_arrest_reliant === true && !nonEmpty(row.rescue_readiness)) {
      issues.push(
        issue(
          "RISK-005",
          "risk",
          `Fall-arrest-reliant risk row ${row.ref} has no rescue readiness statement.`,
          `/risk_register/${index}/rescue_readiness`,
          { dominant_defect: true },
        ),
      );
    }

    if (
      row.high_energy === true &&
      hasHighEnergyTag(tags) &&
      !row.exclusion_or_segregation &&
      !hasIsolationControl(row)
    ) {
      issues.push(
        issue(
          "RISK-006",
          "risk",
          `High-energy risk row ${row.ref} has no exclusion-zone or physical-segregation control.`,
          `/risk_register/${index}/exclusion_or_segregation`,
          { dominant_defect: true },
        ),
      );
    }
  }

  return issues;
}

function validateSwmsReview(documentSet) {
  const issues = [];
  const reviews = documentSet.swms_benchmark_reviews ?? [];

  for (const [index, review] of reviews.entries()) {
    const evidence = review.criteria_evidence ?? {};
    const prefix = `/swms_benchmark_reviews/${index}/criteria_evidence`;

    if (!mentionsProject(evidence.project_specificity, documentSet.project?.project_name)) {
      issues.push(
        issue(
          "SWMS-001",
          "swms_review",
          `SWMS review for '${review.swms_title}' fails criterion 1: project specificity.`,
          `${prefix}/project_specificity`,
          { criterion_number: 1, dominant_defect: true },
        ),
      );
    }

    if (!/(hazard|hrcw|H\d{2})/i.test(evidence.hazard_identification ?? "")) {
      issues.push(
        issue(
          "SWMS-002",
          "swms_review",
          `SWMS review for '${review.swms_title}' fails criterion 2: hazard identification.`,
          `${prefix}/hazard_identification`,
          { criterion_number: 2, dominant_defect: true },
        ),
      );
    }

    if (!controlAdequacyEvidencePasses(evidence.control_adequacy)) {
      issues.push(
        issue(
          "SWMS-003",
          "swms_review",
          `SWMS review for '${review.swms_title}' fails criterion 3: control adequacy.`,
          `${prefix}/control_adequacy`,
          { criterion_number: 3, dominant_defect: true },
        ),
      );
    }

    if (
      !/(HP-\d{2}|hold point|no specific hold point)/i.test(evidence.hold_points_named_stops ?? "")
    ) {
      issues.push(
        issue(
          "SWMS-004",
          "swms_review",
          `SWMS review for '${review.swms_title}' fails criterion 4: hold points as named stops.`,
          `${prefix}/hold_points_named_stops`,
          { criterion_number: 4, dominant_defect: true },
        ),
      );
    }

    if (
      !/(submitted by|reviewed by|manager|supervisor|contractor|principal contractor)/i.test(
        evidence.named_role_responsibility ?? "",
      )
    ) {
      issues.push(
        issue(
          "SWMS-005",
          "swms_review",
          `SWMS review for '${review.swms_title}' fails criterion 5: responsibility assigned to named roles.`,
          `${prefix}/named_role_responsibility`,
          { criterion_number: 5, dominant_defect: true },
        ),
      );
    }
  }

  return issues;
}

function validateConditionalRiskControls(documentSet, options = {}) {
  const issues = [];
  const finalMode = isFinalMode(options);
  const hrcwRows = new Map((documentSet.hrcw_register ?? []).map((row) => [row.ref, row]));
  const intendedSwmsTitles = new Set(
    (documentSet.intended_swms ?? []).map((row) => normalizeMeaning(row.title)),
  );
  const supportingDocumentTitles = new Set(
    (documentSet.supporting_documents ?? []).map((row) => normalizeMeaning(row.title)),
  );
  const openAccessConfirmation = (documentSet.confirmation_items ?? []).some(
    (item) =>
      item.status === "open" &&
      /\b(access method|access system|access|scaffold|ewp|platform)\b/i.test(
        `${item.id ?? ""} ${item.title ?? ""}`,
      ),
  );

  for (const [index, row] of (documentSet.hrcw_register ?? []).entries()) {
    if (row.trigger_status === CONFIRMED_HRCW_STATUS && row.triggered !== "YES") {
      issues.push(
        issue(
          "CONSISTENCY-007",
          "consistency",
          `HRCW ${row.ref} is confirmed_hrcw but legacy triggered status is not YES.`,
          `/hrcw_register/${index}/trigger_status`,
          { dominant_defect: true },
        ),
      );
    }

    if (row.trigger_status === CONDITIONAL_HRCW_STATUS && row.triggered !== "CONDITIONAL") {
      issues.push(
        issue(
          "CONSISTENCY-007",
          "consistency",
          `HRCW ${row.ref} is conditional_hrcw but legacy triggered status is not CONDITIONAL.`,
          `/hrcw_register/${index}/trigger_status`,
          { dominant_defect: true },
        ),
      );
    }

    if (row.trigger_status === "not_triggered" && row.triggered !== "NO") {
      issues.push(
        issue(
          "CONSISTENCY-007",
          "consistency",
          `HRCW ${row.ref} is not_triggered but legacy triggered status is not NO.`,
          `/hrcw_register/${index}/trigger_status`,
          { dominant_defect: true },
        ),
      );
    }

    if (
      ["requires_confirmation", "stop_work_only"].includes(row.trigger_status) &&
      row.triggered === "YES"
    ) {
      issues.push(
        issue(
          "CONSISTENCY-007",
          "consistency",
          `HRCW ${row.ref} cannot be ${row.trigger_status} while legacy triggered status is YES.`,
          `/hrcw_register/${index}/trigger_status`,
          { dominant_defect: true },
        ),
      );
    }

    if (
      finalMode &&
      row.trigger_status === CONFIRMED_HRCW_STATUS &&
      !hasItems(row.source_fact_refs)
    ) {
      issues.push(
        issue(
          "CONTENT-010",
          "content",
          `Confirmed HRCW ${row.ref} has no source fact reference for final/issue-ready mode.`,
          `/hrcw_register/${index}/source_fact_refs`,
          { dominant_defect: true },
        ),
      );
    }
  }

  for (const [index, row] of (documentSet.swms_matrix ?? []).entries()) {
    for (const ref of row.hrcw_refs ?? []) {
      const hrcwRow = hrcwRows.get(ref);
      if (hrcwRow?.trigger_status !== CONFIRMED_HRCW_STATUS) {
        issues.push(
          issue(
            "CONSISTENCY-007",
            "consistency",
            `SWMS Matrix confirmed hrcw_refs contains ${ref}, which is not confirmed_hrcw.`,
            `/swms_matrix/${index}/hrcw_refs`,
            { dominant_defect: true },
          ),
        );
      }
    }

    for (const ref of row.conditional_hrcw_refs ?? []) {
      const hrcwRow = hrcwRows.get(ref);
      if (hrcwRow?.trigger_status === CONFIRMED_HRCW_STATUS) {
        issues.push(
          issue(
            "CONSISTENCY-007",
            "consistency",
            `SWMS Matrix conditional_hrcw_refs contains ${ref}, which is already confirmed_hrcw.`,
            `/swms_matrix/${index}/conditional_hrcw_refs`,
            { dominant_defect: true },
          ),
        );
      }
    }

    if (
      !intendedSwmsTitles.has(normalizeMeaning(row.swms_title)) &&
      supportingDocumentTitles.has(normalizeMeaning(row.swms_title))
    ) {
      issues.push(
        issue(
          "CONTENT-011",
          "content",
          `Supporting document '${row.swms_title}' appears as a SWMS without being listed in intended_swms.`,
          `/swms_matrix/${index}/swms_title`,
          { dominant_defect: true },
        ),
      );
    }

    if (row.scope_status === "excluded_scope" && hasItems(row.hrcw_refs)) {
      issues.push(
        issue(
          "CONTENT-012",
          "content",
          `Excluded SWMS row '${row.swms_title}' has active confirmed HRCW refs.`,
          `/swms_matrix/${index}/scope_status`,
          { dominant_defect: true },
        ),
      );
    }
  }

  for (const [index, row] of (documentSet.hold_point_schedule ?? []).entries()) {
    if (
      !nonEmpty(row.status) ||
      !nonEmpty(row.release_criteria) ||
      !nonEmpty(row.release_authority) ||
      !nonEmpty(row.evidence_required)
    ) {
      issues.push(
        issue(
          "CONSISTENCY-008",
          "consistency",
          `Hold point ${row.ref} lacks status, release criteria, release authority or evidence.`,
          `/hold_point_schedule/${index}`,
          { dominant_defect: true },
        ),
      );
    }
  }

  for (const [index, item] of (documentSet.confirmation_items ?? []).entries()) {
    if (
      finalMode &&
      item.blocking_level !== "advisory_only" &&
      (!nonEmpty(item.owner_role) || !nonEmpty(item.evidence_required))
    ) {
      issues.push(
        issue(
          "CONTENT-013",
          "content",
          `Blocking confirmation item '${item.title}' lacks owner role or evidence requirement for final/issue-ready mode.`,
          `/confirmation_items/${index}`,
          { dominant_defect: true },
        ),
      );
    }

    if (finalMode && item.blocking_level !== "advisory_only" && item.status === "open") {
      issues.push(
        issue(
          "CONTENT-014",
          "content",
          `Blocking confirmation item '${item.title}' remains open in final/issue-ready mode.`,
          `/confirmation_items/${index}/status`,
          { dominant_defect: true },
        ),
      );
    }
  }

  for (const [index, row] of (documentSet.risk_register ?? []).entries()) {
    for (const ref of row.hrcw_categories ?? []) {
      const hrcwRow = hrcwRows.get(ref);
      if (hrcwRow?.trigger_status !== CONFIRMED_HRCW_STATUS) {
        issues.push(
          issue(
            "CONSISTENCY-007",
            "consistency",
            `Risk row ${row.ref} confirmed hrcw_categories contains ${ref}, which is not confirmed_hrcw.`,
            `/risk_register/${index}/hrcw_categories`,
            { dominant_defect: true },
          ),
        );
      }
    }

    for (const ref of row.conditional_hrcw_categories ?? []) {
      const hrcwRow = hrcwRows.get(ref);
      if (hrcwRow?.trigger_status === CONFIRMED_HRCW_STATUS) {
        issues.push(
          issue(
            "CONSISTENCY-007",
            "consistency",
            `Risk row ${row.ref} conditional_hrcw_categories contains ${ref}, which is already confirmed_hrcw.`,
            `/risk_register/${index}/conditional_hrcw_categories`,
            { dominant_defect: true },
          ),
        );
      }
    }

    if (row.scope_status === "excluded_scope" && hasActiveSwmsReference(row)) {
      issues.push(
        issue(
          "CONTENT-015",
          "content",
          `Risk row ${row.ref} has excluded_scope but still references active SWMS scope.`,
          `/risk_register/${index}/scope_status`,
          { dominant_defect: true },
        ),
      );
    }

    if (
      ["excluded_scope", "stop_work_referral_only"].includes(row.scope_status) &&
      (row.controls ?? []).some((control) => control.control_status === "active_control")
    ) {
      issues.push(
        issue(
          "CONTENT-015",
          "content",
          `Risk row ${row.ref} has excluded/stop-work scope but an active control is present.`,
          `/risk_register/${index}/controls`,
          { dominant_defect: true },
        ),
      );
    }

    const mixedCategoryRefs = (row.hrcw_categories ?? []).filter((ref) =>
      (row.conditional_hrcw_categories ?? []).includes(ref),
    );
    if (mixedCategoryRefs.length > 0) {
      issues.push(
        issue(
          "CONSISTENCY-009",
          "consistency",
          `Risk row ${row.ref} lists the same HRCW category as both confirmed and conditional.`,
          `/risk_register/${index}`,
          { dominant_defect: true },
        ),
      );
    }

    if (
      openAccessConfirmation &&
      (row.controls ?? []).some(
        (control) => control.control_status === "active_control" && accessSpecificControl(control),
      )
    ) {
      issues.push(
        issue(
          "RISK-007",
          "risk",
          `Risk row ${row.ref} confirms access-specific controls while the access method is still unconfirmed.`,
          `/risk_register/${index}/controls`,
          { dominant_defect: true },
        ),
      );
    }

    if (waterproofingScopeInferredFromDefect(row)) {
      issues.push(
        issue(
          "CONTENT-016",
          "content",
          `Risk row ${row.ref} treats waterproofing/tiling as active scope from defect language only.`,
          `/risk_register/${index}/scope_status`,
          { dominant_defect: true },
        ),
      );
    }
  }

  for (const [index, reference] of (documentSet.legal_references ?? []).entries()) {
    if (
      usesRepealedRegulation(reference) &&
      !documentSet.historical_mode &&
      isCurrentIssueDate(documentSet)
    ) {
      issues.push(
        issue(
          "CONTENT-017",
          "content",
          "Current output uses a repealed WHS Regulation reference without explicit historical mode.",
          `/legal_references/${index}/citation`,
          { dominant_defect: true },
        ),
      );
    }
  }

  return issues;
}

function collectTextNodes(value, pathValue = "") {
  if (typeof value === "string") {
    return [{ value, path: pathValue || "/" }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectTextNodes(item, `${pathValue}/${index}`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) =>
      collectTextNodes(child, `${pathValue}/${key}`),
    );
  }
  return [];
}

function hasItems(value) {
  return Array.isArray(value) && value.length > 0;
}

function isFinalMode(options) {
  return FINAL_MODES.has(String(options.mode ?? "").toLowerCase());
}

function hasActiveSwmsReference(row) {
  return nonEmpty(row.swms_title) && !isGenericSwmsReference(row.swms_title);
}

function accessSpecificControl(control) {
  const text = [control.text, ...(control.source_ids ?? [])].join(" ").toLowerCase();
  return /\b(scaffold|ewp|boom lift|scissor lift|work platform|platform|access system)\b/i.test(
    text,
  );
}

function waterproofingScopeInferredFromDefect(row) {
  const text = [
    row.activity,
    row.hazard,
    row.residual_justification,
    ...(row.controls ?? []).map((control) => control.text),
  ]
    .join(" ")
    .toLowerCase();
  return (
    row.scope_status === "in_scope" &&
    /\b(waterproofing|tiling)\b/i.test(text) &&
    /\b(ponding|moisture|defect|refer to principal|refer to consultant)\b/i.test(text) &&
    !hasItems(row.source_fact_refs)
  );
}

function usesRepealedRegulation(reference) {
  const text = `${reference.citation ?? ""} ${reference.source_url ?? ""}`;
  return /\bWork Health and Safety Regulation 2017\b/i.test(text);
}

function isCurrentIssueDate(documentSet) {
  const issueDate = parseDateLike(documentSet.project?.issue_date);
  if (!issueDate) return true;
  return issueDate >= parseDateLike(CURRENT_WHS_REGULATION_EFFECTIVE_FROM);
}

function parseDateLike(value) {
  const text = String(value ?? "").trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text);
  if (iso) {
    const [, year, month, day] = iso;
    return Date.UTC(Number(year), Number(month) - 1, Number(day));
  }

  const longDate = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/u.exec(text);
  if (!longDate) return null;
  const [, rawDay, rawMonth, year] = longDate;
  const month = {
    january: 0,
    february: 1,
    march: 2,
    april: 3,
    may: 4,
    june: 5,
    july: 6,
    august: 7,
    september: 8,
    october: 9,
    november: 10,
    december: 11,
  }[rawMonth.toLowerCase()];
  if (month === undefined) return null;
  return Date.UTC(Number(year), month, Number(rawDay));
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function silicaOnly(text) {
  const lower = (text ?? "").toLowerCase();
  return (
    /\b(silica|rcs|respirable crystalline silica|dust)\b/.test(lower) &&
    !/\b(contaminated|flammable|methane|h2s|hydrogen sulphide|atmosphere|solvent|gas)\b/.test(lower)
  );
}

function uniqueMatches(text, regex) {
  regex.lastIndex = 0;
  return [...new Set([...text.matchAll(regex)].map((match) => match[0].trim()))];
}

function riskBelow(actual, floor) {
  return (RISK_ORDER[actual] ?? 0) < (RISK_ORDER[floor] ?? 0);
}

function hasIsolationControl(row) {
  const text = (row.controls ?? [])
    .map((control) => control.text ?? "")
    .join(" ")
    .toLowerCase();
  return (
    (row.controls ?? []).some((control) => (control.levels ?? []).includes("isolation")) ||
    /\b(exclusion|segregation|physical separation|barrier|barricad|isolat|edge protection|work platform|shoring|battering|no worker entry)/i.test(
      text,
    )
  );
}

function hasHighEnergyTag(tags) {
  return [...tags].some((tag) => HIGH_ENERGY_TAGS.has(tag));
}

function hasEngineeringRelease(row, holdPointsByRef) {
  const rowText = [
    row.activity,
    row.hazard,
    row.residual_justification,
    ...(row.controls ?? []).map((control) => control.text),
  ]
    .join(" ")
    .toLowerCase();
  if (ENGINEERING_RELEASE_WORDS.some((word) => rowText.includes(word))) {
    return true;
  }
  return (row.hold_points ?? []).some(
    (ref) => holdPointsByRef.get(ref)?.engineering_release === true,
  );
}

function wordingOverlaps(left, right) {
  const leftTokens = significantTokens(left);
  const rightTokens = significantTokens(right);
  const overlap = [...rightTokens].filter((token) => leftTokens.has(token));
  return overlap.length >= 1;
}

function significantTokens(text) {
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "before",
    "after",
    "with",
    "where",
    "first",
    "any",
    "into",
    "from",
    "point",
    "hold",
  ]);
  return new Set(
    normalizeMeaning(text)
      .split(" ")
      .filter((token) => token.length > 3 && !stopWords.has(token)),
  );
}

function normalizeMeaning(text) {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function isGenericSwmsReference(title) {
  return /\bindividual trade swms\b/i.test(title) || title.trim() === "—";
}

function swmsTitleLooselyResolves(title, swmsTitles) {
  const normalizedTitle = normalizeSwmsTitle(title);
  if (!normalizedTitle) return true;
  if (/^confined space entry swms$/i.test(title.trim())) return true;
  for (const candidate of swmsTitles) {
    const normalizedCandidate = normalizeSwmsTitle(candidate);
    if (
      normalizedCandidate.includes(normalizedTitle) ||
      normalizedTitle.includes(normalizedCandidate) ||
      titleTokenOverlap(normalizedTitle, normalizedCandidate) >= 2
    ) {
      return true;
    }
  }
  return false;
}

function normalizeSwmsTitle(title) {
  return normalizeMeaning(title)
    .replace(
      /\b(and|or|if|where|upper|level|commencement|operations|installation|work|at|height|site|swms)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function titleTokenOverlap(left, right) {
  const leftTokens = new Set(left.split(" ").filter(Boolean));
  const rightTokens = new Set(right.split(" ").filter(Boolean));
  return [...leftTokens].filter((token) => rightTokens.has(token)).length;
}

function mentionsProject(evidence, projectName) {
  const text = evidence ?? "";
  if (!nonEmpty(text)) return false;
  if (/approved rev04|sample business park|project/i.test(text)) return true;
  const firstProjectWord = (projectName ?? "").split(/\s+/)[0];
  return firstProjectWord.length > 2 && text.toLowerCase().includes(firstProjectWord.toLowerCase());
}

function controlAdequacyEvidencePasses(evidence) {
  const text = evidence ?? "";
  if (!nonEmpty(text)) return false;
  if (WEAK_CONTROL_PATTERNS.some((pattern) => pattern.pattern.test(text))) return false;
  return /\b(control|controls|minimum|benchmark|meet|meets|exceed|exceeds|stronger|adequacy)\b/i.test(
    text,
  );
}
