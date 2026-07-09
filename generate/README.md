# Generation

Phase 4 owns retrieval-seeded Anthropic structured generation. Model output must pass
local schema and deterministic validation before rendering.

Generation provenance records the source brief hash, normalised brief hash, KB source
hash, schema hash, prompt hash, model/provider version and DRAFT issue gate state. Render
handoff manifests add the rendered-output path/hash and preflight evidence before any
filing, export or final issue workflow.
