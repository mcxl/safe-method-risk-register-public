# Codex-Assisted Sectioned Generation Runbook

This runbook is operational guidance for the generation layer only. It is not a WHS
source of truth and does not change schemas, deterministic rules, renderers, manifests,
or issue-ready behavior.

## Mode

When `SAFE_METHOD_GENERATION_PROVIDER` is unset, sectioned generation defaults to
`codex_assisted`.

Direct API modes remain explicit:

- `SAFE_METHOD_GENERATION_PROVIDER=anthropic`
- `SAFE_METHOD_GENERATION_PROVIDER=openai`

Anthropic and OpenAI call provider APIs directly. They do not use Codex sub-agents by
default.

## Pinned Npm Runner

Use the pinned npm runner on Windows so verification and generation do not accidentally
pick up system Node:

```powershell
powershell -ExecutionPolicy Bypass -File "scripts\npm-pinned.ps1" <npm-script-name> <script-args>
```

The first argument after the script path is the npm script name. Pass npm script
arguments directly after it; `npm-pinned.ps1` inserts npm's `--` separator internally
when arguments are present. Do not pass a literal `--` to the PowerShell wrapper.

```powershell
powershell -ExecutionPolicy Bypass -File "scripts\npm-pinned.ps1" generate:local:draft --run-id "sample-local-001" --verify targeted
```

If the npm script takes no arguments, omit the separator:

```powershell
powershell -ExecutionPolicy Bypass -File "scripts\npm-pinned.ps1" verify:offline
```

## One-Command DRAFT DOCX Flow

`generate:local:draft` is the local draft acceleration entry point. It is the preferred
operator command for producing a DRAFT DOCX from Codex-assisted section JSON without
claiming final or issue-ready status.

Use explicit arguments for repeatable handoff runs:

```powershell
powershell -ExecutionPolicy Bypass -File "scripts\npm-pinned.ps1" generate:local:draft --brief "fixtures\golden\briefs\sample-project-brief.json" --run-id "sample-local-001" --project-slug "sample" --output-dir "outputs\tmp\codex-assisted\sample-local-001\draft" --verify targeted
```

For local operation, the command also accepts environment fallbacks. Explicit CLI
arguments take precedence over environment variables.

| CLI input | Environment fallback | Use |
| --- | --- | --- |
| `--brief` | `SAFE_METHOD_PROJECT_BRIEF` | Project brief JSON to load. Do not edit source briefs during a draft run unless separately instructed. |
| `--run-id` | `SAFE_METHOD_CODEX_ASSISTED_RUN_ID` | Deterministic run id. Do not derive run ids from the current clock. |
| `--project-slug` | `SAFE_METHOD_PROJECT_SLUG` | Stable project slug for local draft output naming and folders. |
| `--output-dir` | `SAFE_METHOD_OUTPUT_DIR` | Local DRAFT output directory. Use ignored draft locations such as `outputs/tmp/` or `outputs/local/`. |

Environment-based example:

```powershell
$env:SAFE_METHOD_PROJECT_BRIEF = "fixtures\golden\briefs\sample-project-brief.json"
$env:SAFE_METHOD_CODEX_ASSISTED_RUN_ID = "sample-local-001"
$env:SAFE_METHOD_PROJECT_SLUG = "sample"
$env:SAFE_METHOD_OUTPUT_DIR = "outputs\tmp\codex-assisted\sample-local-001\draft"
powershell -ExecutionPolicy Bypass -File "scripts\npm-pinned.ps1" generate:local:draft --verify targeted
```

The command is expected to:

1. load and normalise the project brief;
2. prepare the Codex-assisted run folder;
3. generate worker packets under
   `outputs/tmp/codex-assisted/<run-id>/worker-packets/`;
4. consume completed section JSON files from the run folder;
5. lock hashes, assemble the sectioned document set, and run the selected verification
   policy;
6. render a local DRAFT DOCX only when the draft inputs and selected checks pass.

Draft DOCX output remains local draft evidence. It is not final, issue-ready, consultant
signed off, or filed.

## Fast Verification Policy

Use `--verify` on `generate:local:draft` to choose the local verification depth:

- `--verify targeted` is the normal draft loop. It runs the changed/affected verifier set
  and uses the verify cache for unchanged inputs.
- `--verify full` runs the full local verification policy for the draft flow and refreshes
  cache entries for the current inputs.
- `--verify none` skips verification for packet preparation or very early drafting only.
  Report skipped checks in handoff notes and rerun with `targeted` or `full` before using
  the DOCX for review.

The verify cache is an acceleration aid only. Treat cache hits as draft-loop evidence, not
as issue-ready evidence. Use `--verify full` after changes to schemas, deterministic
rules, renderers, package/toolchain files, source briefs, or any section JSON that could
alter rendered output.

## Worker Packets

`generate:local:draft` writes worker packets under:

```text
outputs/tmp/codex-assisted/<run-id>/worker-packets/
```

Each packet is operational input for a section writer. Packets may include the assigned
section name, output file path, relevant schema contract, retrieval context, and run
metadata. Treat generated packets as read-only disposable instructions; regenerate them
from the command instead of editing them by hand.

The section JSON files remain the only draft content inputs the command consumes:

- `hrcw_register.json`
- `hold_point_schedule.json`
- `swms_matrix.json`
- `risk_register_part_1.json`
- `risk_register_part_2.json`
- `risk_register_part_3.json`
- `risk_register_part_4.json`
- `swms_benchmark_reviews_part_1.json`
- `swms_benchmark_reviews_part_2.json`
- `support_bundle.json`

## Optional Sub-Agent Workflow

Sub-agents are optional. A single operator may write all section JSON files, or the
operator may assign generated worker packets to separate sub-agents.

When using sub-agents:

1. Generate or refresh packets with `generate:local:draft`.
2. Give each sub-agent only its assigned packet and the runbook constraints.
3. Require each sub-agent to write only the assigned section JSON file named in the
   packet.
4. Rerun `generate:local:draft --verify targeted` after section files are returned.
5. Use `--verify full` before any wider review handoff that relies on the DRAFT DOCX.

Sub-agents may not edit `knowledge/`, `schemas/`, `rules/`, renderers, source briefs,
package files, manifests outside their assigned run folder, or any other repo source
unless separately instructed. They may write only the assigned section JSON files for the
current run.

## Manual Section Flow

The older prepare/lock/assemble scripts remain useful for debugging section envelopes or
isolating a failed stage. Prefer `generate:local:draft` for normal draft DOCX operation.

Choose a deterministic run id or an explicit run directory. The repo does not infer run
ids from the clock.

```powershell
$env:SAFE_METHOD_CODEX_ASSISTED_RUN_ID = "sample-local-001"
powershell -ExecutionPolicy Bypass -File "scripts\npm-pinned.ps1" generate:sectioned:codex-assisted:prepare
```

The prepare command writes
`outputs/tmp/codex-assisted/<run-id>/codex-assisted-run.json` with expected section file
names and empty hash slots. Section writer agents or an operator then write complete JSON
section envelopes only.

After all section files are present, lock the run:

```powershell
powershell -ExecutionPolicy Bypass -File "scripts\npm-pinned.ps1" generate:sectioned:codex-assisted:lock
```

Locking validates each section envelope and writes per-section SHA-256 hashes into the
manifest. Missing, malformed, wrong-section, schema-invalid, unlocked, stale, or
hash-mismatched files fail closed.

Then assemble:

```powershell
powershell -ExecutionPolicy Bypass -File "scripts\npm-pinned.ps1" generate:sectioned:codex-assisted:assemble
```

Assembly uses `maxRetries=0` and `maxAssemblyCorrections=0`. Failed local sections are
revised by the agents or operator and the lock/assemble steps are rerun. The repo does not
call a model to repair Codex-assisted files.

## Evidence

Passing one-command draft generation may write a DRAFT DOCX, draft manifest/evidence, and
Codex-assisted run evidence under the selected local output locations. Passing manual
assembly writes DRAFT-only local evidence under the ignored run folder:

- `evidence/assembled-document-set.json`
- `evidence/validation-report.json`
- `evidence/generation-provenance.json`
- `evidence/section-attempts.json`
- `evidence/assembly-attempts.json`

Manual Codex-assisted assembly does not produce DOCX, XLSX, final, or issue-ready output.
The one-command draft flow may produce DOCX only in `draft` mode. Full Ajv validation and
deterministic rules remain the authority. Consultant sign-off is still required before any
final or issue-ready status.

## Verification Quick Reference

The general verification wrapper also uses pinned Node and defaults to the full local
`verify` command:

```powershell
powershell -ExecutionPolicy Bypass -File "scripts\verify.ps1"
powershell -ExecutionPolicy Bypass -File "scripts\verify.ps1" verify:offline
powershell -ExecutionPolicy Bypass -File "scripts\verify.ps1" verify:generation:sectioned
```

Run live provider checks only when the matching API key and explicit opt-in environment
variable are present. Credential-gated checks may skip cleanly when credentials are not
available.
