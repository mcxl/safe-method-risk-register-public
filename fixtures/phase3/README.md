# Phase 3 Rule Fixtures

Phase 3 fixtures are mutation manifests over the machine-readable Unitas golden document
set. Each case starts from the passing golden set, applies a small deterministic
mutation, and asserts the exact stable rule ID expected from that defect.

The fixtures do not create new WHS source content. They test deterministic validation
behavior over structured JSON.
