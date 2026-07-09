import { createAnthropicProvider, runGenerationPipeline } from "../generate/pipeline.mjs";
import { buildDocumentSetSmokeOutputSchema } from "../generate/schema-bundle.mjs";

const SAMPLE_BRIEF = "fixtures/golden/briefs/sample-project-brief.json";

if (!process.env.ANTHROPIC_API_KEY) {
  console.log("SKIP Phase 4 Anthropic API smoke: ANTHROPIC_API_KEY is not set.");
  process.exit(0);
}

if (process.env.SAFE_METHOD_RUN_ANTHROPIC_GENERATION !== "1") {
  console.log(
    "SKIP Phase 4 Anthropic API smoke: set SAFE_METHOD_RUN_ANTHROPIC_GENERATION=1 to call the model.",
  );
  process.exit(0);
}

const schemaMode = process.env.SAFE_METHOD_ANTHROPIC_SCHEMA_MODE ?? "smoke";
if (!["smoke", "full"].includes(schemaMode)) {
  console.error(
    "FAIL Phase 4 Anthropic API smoke: SAFE_METHOD_ANTHROPIC_SCHEMA_MODE must be smoke or full.",
  );
  process.exit(1);
}

const result = await runGenerationPipeline({
  briefPath: SAMPLE_BRIEF,
  provider: createAnthropicProvider(),
  maxRetries: 1,
  outputSchema: schemaMode === "smoke" ? buildDocumentSetSmokeOutputSchema() : undefined,
  responseInstructions:
    schemaMode === "smoke"
      ? [
          "For this live smoke, return an object with exactly one field: document_set_json.",
          "The document_set_json value must be a JSON string containing the complete DRAFT WHS document-set object.",
          "Do not omit any document-set fields inside document_set_json; local Ajv and deterministic rules validate the parsed document.",
          "The parsed document_set_json value must be one object with these exact top-level keys: document_level, project, hrcw_register, swms_matrix, hold_point_schedule, risk_register, swms_benchmark_reviews, swms_benchmark_note, intended_swms, supporting_documents, confirmation_items, legal_references, historical_mode.",
          "Use exact schema field names only. Do not add display/table-only or alternate keys such as item, category, status, action, evidence, legal_basis, or notes_summary when the schema names differ.",
          "project required keys: project_name, site_address, principal_contractor, jurisdiction, revision, issue_date.",
          "Each hrcw_register row required keys: ref, schedule_1_item, category_title, triggered, trigger_status, packages, swms_required, basis_refs. Include all H01 through H17 rows.",
          "Each swms_matrix row required keys: trade_package, scope_status, hrcw_refs, swms_title, submitted_by, reviewed_by, required_before.",
          "Each hold_point_schedule row required keys: ref, source_pattern_id, status, title, packages, precondition, release_criteria, release_authority, authority_text, evidence_required, release_type.",
          "Each risk_register row required keys: ref, trade_package, risk_status, scope_status, phase, activity, hazard, classification_tags, initial_risk, controls, residual_risk, responsible_do.",
          "Each risk_register control required keys: source_ids, text, levels, control_status.",
          "Each swms_benchmark_reviews row required keys: trade_package, swms_title, criteria_evidence.",
          "Each intended_swms row required keys: title, scope_status.",
          "Each supporting_documents row required keys: id, title, status, description.",
          "Each confirmation_items row required keys: id, title, status, blocking_level, owner_role, evidence_required.",
          "Each legal_references row required keys: id, jurisdiction, source_url, citation, effective_from, date_checked, checked_by_process, historical_mode_allowed.",
          "Allowed hrcw_register.trigger_status values: confirmed_hrcw, conditional_hrcw, not_triggered, stop_work_only, requires_confirmation.",
          "Allowed risk_status values: confirmed_risk, conditional_risk, latent_condition, not_applicable, scope_exclusion.",
          "Allowed scope_status values: in_scope, conditional_scope, excluded_scope, stop_work_referral_only.",
          "Allowed hold_point_schedule.status values: confirmed_hold_point, conditional_hold_point, pre_mobilisation_blocker, pre_task_blocker, swms_update_trigger, stop_work_trigger.",
          "Allowed supporting_documents.status values: required_before_issue, required_before_mobilisation, required_before_task, conditional_if_triggered, for_information.",
          "Allowed risk_register controls[].control_status values: active_control, conditional_control, stop_work_control, supporting_document_control, not_applicable_control.",
          "Allowed confirmation_items.status values: open, confirmed, not_required, superseded.",
          "Allowed confirmation_items.blocking_level values: blocks_issue_ready, blocks_mobilisation, blocks_specific_task, blocks_swms_update, advisory_only.",
          "hrcw_register.triggered and hrcw_register.swms_required must be strings using exactly YES, NO, or CONDITIONAL.",
          "initial_risk and residual_risk must be exactly High, Medium, or Low.",
          "Allowed risk_register.classification_tags values: fall_from_height, suspended_load, crane_lift, mobile_plant, temporary_works, unverified_roof_access, openings, public_or_occupied_interface, large_public_or_occupied_interface, structural_loading, access_risk, engineering_release_required, fall_arrest_reliant, non_hrcw, other.",
          "Use HRCW refs exactly H01 through H17. Use hold point refs exactly HP-01, HP-02, etc.; put source pattern IDs such as HP-ENG-LIFT-STUDY only in source_pattern_id, never in ref.",
          "Use risk row refs as two uppercase letters, hyphen, two digits, optionally one uppercase suffix, for example BF-01 or SE-02A.",
          "Every hrcw_register.basis_refs array must contain at least one legal_references id.",
          "swms_benchmark_reviews.criteria_evidence must be an object with keys project_specificity, hazard_identification, control_adequacy, hold_points_named_stops, named_role_responsibility.",
        ]
      : undefined,
});

if (result.status !== "pass") {
  console.error(JSON.stringify(result.validationReport, null, 2));
  process.exit(1);
}

console.log(
  `PASS Phase 4 Anthropic API smoke (${schemaMode} schema, full validators passed): ${result.provenance.output_hash_sha256}`,
);
