# Workflow Application

Phase 6 owns structured intake, DRAFT review, issue control and provenance.

`workflow-state.mjs` provides the Phase 6 state machine for app-owned workflow records:

- new validated outputs start as immutable `DRAFT` records;
- accepted consultant review moves a passing record to `REVIEWED`;
- issue is allowed only from `REVIEWED` after final preflight, required verifier evidence,
  required phase-gate evidence and persisted handoff manifest evidence pass;
- content-affecting changes increment the revision, clear sign-off and return to `DRAFT`;
- provenance hashes over source input, validation report and output hash are verified
  before a record is trusted.
- workflow actions require explicit actor roles: workflow operator, WHS consultant,
  issue controller, auditor or system service depending on the action.

`workflow-store.mjs` provides deterministic local persistence helpers for Phase 6 tests
and future app integration:

- workflow record files are written under a caller-supplied store root;
- record paths are deterministic by record ID and revision;
- persisted records are immutable and cannot be overwritten;
- loaded records must validate against the workflow schema and pass provenance checks;
- reconstruction verifies stored source input, validation report, output hash and handoff
  manifest hash against the workflow record.

`handoff-manifest.mjs` provides the engineering-only handoff/provenance layer used by
rendered outputs:

- deterministic DOCX file naming for `draft` and `final` modes;
- deliberate date-stamp handling with no implicit current-clock filename stamps;
- SHA-256 hashes for source inputs, rendered outputs, schemas and deterministic rules;
- generator and renderer version reporting;
- unresolved `[Client To Confirm]` marker counts;
- recipients, subject, verifier status, skipped checks, credential-gated checks and
  phase-gate status;
- preflight checks that keep draft output not issue-ready and block final/issue-ready
  output unless validation, gates, verifiers and consultant sign-off are present.

The module does not alter WHS source content and does not replace the Phase 6 state
machine. It supplies the manifest and preflight contract that Phase 6 persists and
enforces.
