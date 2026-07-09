# Safe Method Risk Register Public Mirror

This repository is a public-safe code mirror of the private Safe Method Risk
Register implementation. It is intended to show the architecture, schemas,
validators, generation boundaries, renderers, workflow gates and CI wiring
without publishing private client benchmark artifacts.

Safe Method is a document-generation pipeline for project-level WHS control
document sets for Australian construction and civil projects, with NSW as the
default jurisdiction.

The pipeline takes structured project input through a controlled generation and
validation flow, then renders coordinated outputs such as:

- HRCW Register
- SWMS Matrix
- Hold Point Schedule
- Project Risk Register / Risk Assessment
- SWMS benchmark review note and verdict

The repository is built around a strict layer split:

- `knowledge/` contains static, versioned source material.
- `spec/` contains prompt-layer drafting authority.
- `schemas/` contains JSON contracts for generated objects.
- `rules/` contains deterministic validators and verdict logic.
- `generate/` turns validated briefs into structured document-set JSON.
- `render/` turns validated JSON into DOCX or, when expressly requested, XLSX.
- `app/` contains workflow, issue-gate and provenance logic.

## Important Status

This project is a controlled document pipeline, not a standalone WHS authority.
Generated documents remain DRAFT until deterministic validation, required
verification evidence, final preflight and consultant sign-off are all recorded.

No output from this repository should be treated as issue-ready solely because
it was generated successfully.

## Public Mirror Scope

The private repository contains licensed or client-identifying benchmark
fixtures, golden Office masters, vetted knowledge-source data, phase-gate
evidence and generated outputs. Those assets are intentionally omitted here.

The public mirror keeps implementation code and contracts, including:

- `app/`, `generate/`, `render/`, `rules/`, `schemas/`, `scripts/`, `src/`
- package, lint, TypeScript, Supabase and GitHub Actions configuration
- public-facing documentation and prompt/spec files

Some private acceptance commands in `package.json` still document the original
verification surface, but they require omitted private fixtures or local
consultant review evidence. Use `npm run verify:public` for checks that are
expected to run in this mirror.

## Verification

Use the pinned wrapper on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File "scripts\verify.ps1"
```

For this public mirror:

```powershell
npm run verify:public
```

In the private repository, deterministic local checks without credential-gated
model calls use:

```powershell
npm run verify:offline
```

Credential-gated generation smoke tests are skipped unless the relevant API
keys and explicit opt-in environment variables are present.

## Requirements

- Node.js 24 LTS
- npm 11.x
- Python 3.13
- Supabase/Postgres for database-backed KB verification
- Optional Office/LibreOffice tooling for renderer acceptance checks

## Repository Notes

- Secrets belong in ignored `.env` files only.
- Private golden masters, generated outputs and client-identifying fixtures are
  not part of this public mirror.
- `outputs/tmp/` and `outputs/local/` are scratch areas and are ignored.
- Controlled issued outputs, when deliberately created, belong under
  `outputs/issued/<project-slug>/` with a handoff manifest.
- `.docx` is the default rendered output. `.xlsx` output is generated only when
  expressly requested.
- Generated outputs are not issue-ready unless deterministic validation,
  required verifier evidence, final preflight and competent consultant sign-off
  are all recorded.

## License

No open-source license has been granted yet. Public visibility allows review of
the code, but reuse rights are not granted unless a license is added.
