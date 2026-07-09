import { canonicalClone } from "../scripts/kb-source.mjs";

export function applyConfirmationTransitions(documentSet, options = {}) {
  const next = canonicalClone(documentSet);
  const confirmationIds = new Set(options.confirmationItemIds ?? []);
  const confirmedItems = (next.confirmation_items ?? []).filter(
    (item) =>
      item.status === "confirmed" &&
      (confirmationIds.size === 0 || confirmationIds.has(item.id)) &&
      Array.isArray(item.transition_effects),
  );

  for (const item of confirmedItems) {
    for (const effect of item.transition_effects) {
      applyTransitionEffect(next, effect);
    }
  }

  return next;
}

function applyTransitionEffect(documentSet, effect) {
  if (effect.target_type === "hrcw") {
    applyHrcwTransition(documentSet, effect);
    return;
  }
  if (effect.target_type === "risk") {
    applyRiskTransition(documentSet, effect);
    return;
  }
  if (effect.target_type === "control") {
    applyControlTransition(documentSet, effect);
    return;
  }
  if (effect.target_type === "hold_point") {
    applyHoldPointTransition(documentSet, effect);
    return;
  }
  if (effect.target_type === "swms_matrix") {
    applySwmsTransition(documentSet, effect);
  }
}

function applyHrcwTransition(documentSet, effect) {
  for (const ref of effect.refs ?? []) {
    const row = (documentSet.hrcw_register ?? []).find((candidate) => candidate.ref === ref);
    if (!row) continue;
    if (effect.new_status) {
      row.trigger_status = effect.new_status;
      if (effect.new_status === "confirmed_hrcw") {
        row.triggered = "YES";
        row.swms_required = "YES";
      }
      if (effect.new_status === "conditional_hrcw") {
        row.triggered = "CONDITIONAL";
        row.swms_required = "CONDITIONAL";
      }
      if (effect.new_status === "not_triggered") {
        row.triggered = "NO";
        row.swms_required = "NO";
      }
    }
    row.supporting_document_refs = appendUnique(
      row.supporting_document_refs ?? [],
      effect.supporting_document_refs,
    );
  }
}

function applyRiskTransition(documentSet, effect) {
  for (const ref of effect.refs ?? []) {
    const row = (documentSet.risk_register ?? []).find((candidate) => candidate.ref === ref);
    if (!row) continue;
    if (effect.new_status) {
      row.risk_status = effect.new_status;
    }
    promoteRefs(row.hrcw_categories, row.conditional_hrcw_categories, effect.promote_hrcw_refs);
    row.supporting_document_refs = appendUnique(
      row.supporting_document_refs ?? [],
      effect.supporting_document_refs,
    );
  }
}

function applyControlTransition(documentSet, effect) {
  for (const ref of effect.refs ?? []) {
    const [rowRef, sourceId] = ref.split(":");
    const row = (documentSet.risk_register ?? []).find((candidate) => candidate.ref === rowRef);
    if (!row) continue;
    for (const control of row.controls ?? []) {
      if ((control.source_ids ?? []).includes(sourceId) && effect.new_status) {
        control.control_status = effect.new_status;
      }
    }
  }
}

function applyHoldPointTransition(documentSet, effect) {
  for (const ref of effect.refs ?? []) {
    const row = (documentSet.hold_point_schedule ?? []).find((candidate) => candidate.ref === ref);
    if (!row) continue;
    if (effect.new_status) {
      row.status = effect.new_status;
    }
    row.linked_supporting_document_refs = appendUnique(
      row.linked_supporting_document_refs ?? [],
      effect.supporting_document_refs,
    );
  }
}

function applySwmsTransition(documentSet, effect) {
  for (const title of effect.refs ?? []) {
    const row = (documentSet.swms_matrix ?? []).find(
      (candidate) => candidate.swms_title === title || candidate.trade_package === title,
    );
    if (!row) continue;
    if (effect.new_status) {
      row.scope_status = effect.new_status;
    }
    promoteRefs(row.hrcw_refs, row.conditional_hrcw_refs, effect.promote_hrcw_refs);
    row.supporting_document_refs = appendUnique(
      row.supporting_document_refs ?? [],
      effect.supporting_document_refs,
    );
  }
}

function promoteRefs(target = [], source = [], refs = []) {
  for (const ref of refs ?? []) {
    if (!target.includes(ref)) target.push(ref);
    const index = source.indexOf(ref);
    if (index >= 0) source.splice(index, 1);
  }
}

function appendUnique(target = [], values = []) {
  for (const value of values ?? []) {
    if (!target.includes(value)) target.push(value);
  }
  return target;
}
