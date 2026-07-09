# Excel Output Spec (xlsx)

**When this applies:** Excel is produced **only on express request**. The default and
primary deliverable remains the combined .docx. When Excel *is* requested, it must
follow this spec in full — it is not a by-product of the Word renderer.

Before building, inspect the approved `private-risk-assessment-golden.xlsx` golden fixture
for exact fills, column widths and print setup, and mirror it. The
**Master Project Register** (`private-master-project-register.xlsx`) fixture is
the golden example of this spec realised (five visible business sheets plus hidden
`Lists`, ~126 live formulas, zero errors).

---

## Critical: the xlsx house style is NOT the docx house style

The docx rule is black-and-white, no colour. **The xlsx convention is colour** — they
are distinct and must not be cross-applied. Codex must not apply the B&W docx rule to
the workbook.

| Element | Style |
|---------|-------|
| Header rows / title bands | Navy `1F3864` fill, white bold Calibri |
| Body font | Calibri 9 |
| Risk shading (traffic light) | High `FFCCCC` · Medium `FFE5B4` · Low `C6EFCE` |
| HRCW Triggered cells | YES fill `C6EFCE` text `375623` · COND fill `FFF2CC` text `7F6000` · NO fill `D9D9D9` text `808080` |
| Borders | Thin, `BFBFBF` |
| Sub-text | `404040` · Note background `F2F2F2` |

## Workbook structure — five sheets

1. **Cover** — document information, scope basis, document-level classification, the
   five-criteria SWMS review note.
2. **Dashboard** — the live rollup layer. COUNTIF / AVERAGE pulling dynamically from the
   other sheets: risk-line count, hold-point count, HRCW YES / COND / NO counts, count of
   packages needing a SWMS, initial-vs-residual profile (residual High should resolve to
   0), average risk reduction, and % of lines reduced.
3. **HRCW Register** — all 17 Schedule 1 categories with the shaded Triggered column.
4. **Hold Points Schedule** — the project hold points (HP-01..).
5. **Risk Register** — the full register, plus three appended **live formula columns**:
   Initial Score and Residual Score (each parsing the numeral from the "(3)/(2)/(1)"
   rating text) and Risk Reduction (= Initial − Residual).

Future tabs flagged for a later iteration (do not build unless requested): **SWMS Matrix**
tab and **Risk Matrix** tab, to fully mirror the Sample master workbook.

## The workbook must be live, not static

- **Score extraction:** rating cells display "High (3)" / "Medium (2)" / "Low (1)"; a
  formula column extracts the bracketed numeral so scores recalculate when a rating
  changes. Do not hard-code the numeric score — drive it from the cell.
- **Dropdown data validation** on the Initial and Residual rating cells and the HRCW
  Triggered cells, driven by a **hidden `Lists` sheet**.
- Changing any dropdown recalculates the score columns and the entire Dashboard.

## Print setup (every sheet)

A4 landscape (`paperSize = 9`), `fitToWidth = 1`, `fitToHeight = 0`, horizontally
centred. Footer: filename on the left (size 8), `Page &P of &N` on the right (size 8).

## Data source

The Excel renderer consumes the **same document-set JSON** as the docx renderer — one
source of data, two renderers. Ratings arrive as enums (`High`/`Medium`/`Low`); the
renderer writes the display text plus dropdown validation, and the formula columns derive
the scores. No WHS logic lives in the renderer.

## Excel verification gate

- All formulas evaluate with **zero errors**; dropdowns functional; changing a rating
  recalculates the score columns and Dashboard.
- House style matches the Sample xlsx (navy headers, traffic-light shading, trigger
  colours, thin borders).
- A4 landscape, fit-to-width, footer with filename + page numbers on every sheet.
- Golden check: regenerating the Private Benchmark brief reproduces the Master Project Register.
- Same DRAFT gate as docx — Excel is a generation output requiring consultant review
  before issue.
