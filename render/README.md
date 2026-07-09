# Renderers

Phase 5 owns the separate DOCX and expressly-requested XLSX renderers. Renderers consume
validated JSON and contain no WHS judgment.

## Phase 5A DOCX

`docx-renderer.mjs` renders a validated document-set JSON object to a DRAFT `.docx`.
It blocks rendering before writing any file if the document-set fails schema validation
or any deterministic Phase 3 rule.

The Phase 5A gate writes a handoff manifest beside the DOCX. The manifest captures the
deterministic file name, output path and hash, source document-set hash, schema/rule
hashes, generator and renderer versions, recipients, subject, unresolved placeholder
counts, verifier status, skipped checks, credential-gated checks and phase-gate status.
Draft manifests keep `issue_ready=false`.

The renderer applies the Safe Method DOCX house style:

- A4 landscape;
- Calibri;
- near-black table headers with white text;
- black/grey/white only;
- Capitalise Each Word section headings;
- no underline formatting;
- footer containing filename and page fields;
- DRAFT state only, never issue-ready.

Run the local DOCX gate with:

```powershell
npm run verify:docx
```

The structural gate renders the Unitas golden document-set into
`outputs/tmp/phase5a/`, checks the OOXML contract, validates the handoff manifest
and confirms draft-only preflight status. Visual/open QA is intentionally separate:
run `npm run verify:docx:visual` when LibreOffice/`soffice` is available. That gate
fails explicitly if the office renderer is missing or cannot produce a nonempty PDF.

Controlled issued outputs belong under `outputs/issued/<project-slug>/` with
their handoff manifests. Local renderer scratch belongs under `outputs/tmp/` or
`outputs/local/`.
