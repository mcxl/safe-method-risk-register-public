# Deterministic Rules

Phase 3 implements the acceptance criteria in `AGENTS.md` using stable rule IDs and
passing/failing fixtures. These tests run offline and do not call a model or network.

## Rule Suites

Stable rule IDs live in `rules/index.mjs`:

- `CONSISTENCY-001` canonical package references.
- `CONSISTENCY-002` HRCW ref resolution and triggered-row consistency.
- `CONSISTENCY-003` hold-point ref resolution and body/schedule count.
- `CONSISTENCY-004` hold-point body wording against the schedule.
- `CONSISTENCY-005` SWMS title consistency.
- `CONSISTENCY-006` duplicate risk ref with different hazard meaning.
- `CONTENT-001` prohibited approval language for subcontractor SWMS.
- `CONTENT-002` blanket all-packages trigger without justification.
- `CONTENT-003` silica/RCS dust alone coded as H12.
- `CONTENT-004` H06 triggered without confirmed assessment.
- `CONTENT-005` invented licence / non-standard terminology.
- `CONTENT-006` fixed numeric limit without basis metadata.
- `CONTENT-007` CONDITIONAL trigger without condition.
- `CONTENT-008` YES trigger without packages.
- `CONTENT-009` weak-control reject phrase.
- `RISK-001` high-energy Low on administrative/PPE controls alone.
- `RISK-002` crane lift or fall-arrest work below Medium.
- `RISK-003` height or large public-interface work below Medium.
- `RISK-004` structural/access row requiring engineering release without release condition.
- `RISK-005` fall-arrest row without rescue readiness.
- `RISK-006` high-energy row without exclusion-zone or physical segregation.
- `SWMS-001` SWMS criterion 1: project specificity.
- `SWMS-002` SWMS criterion 2: hazard identification.
- `SWMS-003` SWMS criterion 3: control adequacy.
- `SWMS-004` SWMS criterion 4: hold points as named stops.
- `SWMS-005` SWMS criterion 5: responsibility assigned to named roles.

Verdict derivation is in the same module. The model never supplies the verdict.

## Verification

Run:

```powershell
npm run verify:rules
```

The gate validates the golden Unitas document set as `Benchmark Quality Confirmed`,
checks each Phase 3 broken fixture against its expected rule ID, verifies each SWMS
criterion number, proves equivalent-or-stronger control evidence passes criterion 3, and
covers all four verdict ratings.
