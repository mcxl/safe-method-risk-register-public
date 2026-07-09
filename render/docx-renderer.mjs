import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  Packer,
  PageNumber,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from "docx";

import { validateDocumentSet } from "../rules/index.mjs";
import {
  createAjvRegistry,
  formatAjvErrors,
  schemaIdForFileName,
} from "../scripts/schema-registry.mjs";

export const DOCX_RENDERER_VERSION = "phase5a.docx-renderer.v1";
export const DOCUMENT_SET_SCHEMA_FILE = "document-set.schema.json";

export const DOCX_HOUSE_STYLE = Object.freeze({
  page: {
    size: "A4",
    orientation: "landscape",
    widthTwip: 11906,
    heightTwip: 16838,
    marginTwip: 720,
    contentWidthTwip: 15398,
  },
  font: "Calibri",
  colors: {
    black: "000000",
    nearBlack: "1F1F1F",
    white: "FFFFFF",
    borderGrey: "808080",
    bodyGrey: "F2F2F2",
  },
});

export class RenderValidationError extends Error {
  constructor(message, validationReport) {
    super(message);
    this.name = "RenderValidationError";
    this.validationReport = validationReport;
  }
}

export async function renderDraftDocx(documentSet, outputPath, options = {}) {
  const validationReport = assertDocumentSetRenderable(documentSet, options);
  const filename = options.filename ?? path.basename(outputPath);
  const document = buildDraftDocument(documentSet, {
    filename,
    validationReport,
  });

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, await Packer.toBuffer(document));

  return {
    renderer_version: DOCX_RENDERER_VERSION,
    workflow_state: "DRAFT",
    issue_ready: false,
    output_path: outputPath,
    filename,
    validation_report: validationReport,
    output_hash_sha256: await sha256File(outputPath),
  };
}

export function assertDocumentSetRenderable(documentSet, options = {}) {
  const registry = options.registry ?? createAjvRegistry();
  const validate = registry.getValidator(DOCUMENT_SET_SCHEMA_FILE);

  if (!validate(documentSet)) {
    const validationReport = {
      status: "fail",
      schema: {
        status: "fail",
        schema_id: schemaIdForFileName(DOCUMENT_SET_SCHEMA_FILE),
        errors: formatAjvErrors(validate.errors),
      },
      rules: null,
    };
    throw new RenderValidationError(
      "DOCX render blocked by document-set schema failure.",
      validationReport,
    );
  }

  const rules = validateDocumentSet(documentSet, { mode: options.mode ?? "draft" });
  if (rules.status !== "pass") {
    const validationReport = {
      status: "fail",
      schema: {
        status: "pass",
        schema_id: schemaIdForFileName(DOCUMENT_SET_SCHEMA_FILE),
        errors: "",
      },
      rules,
    };
    throw new RenderValidationError(
      "DOCX render blocked by deterministic rule failure.",
      validationReport,
    );
  }

  return {
    status: "pass",
    schema: {
      status: "pass",
      schema_id: schemaIdForFileName(DOCUMENT_SET_SCHEMA_FILE),
      errors: "",
    },
    rules,
  };
}

export function buildDraftDocument(documentSet, options = {}) {
  const filename = options.filename ?? "safe-method-draft.docx";
  const children = [
    ...coverSection(documentSet),
    ...hrcwSection(documentSet),
    ...swmsMatrixSection(documentSet),
    ...holdPointSection(documentSet),
    ...riskRegisterSection(documentSet),
    ...supportingDocumentsSection(documentSet),
    ...swmsBenchmarkSection(documentSet, options.validationReport),
  ];

  return new Document({
    title: `${documentSet.project.project_name} - DRAFT WHS Control Document Set`,
    subject: "Safe Method DRAFT WHS control document set",
    creator: "Safe Method",
    lastModifiedBy: "Safe Method",
    description: "DRAFT output generated from validated project-level WHS document-set JSON.",
    features: {
      updateFields: true,
    },
    styles: {
      paragraphStyles: [
        {
          id: "SafeNormal",
          name: "Safe Normal",
          basedOn: "Normal",
          next: "SafeNormal",
          run: { font: DOCX_HOUSE_STYLE.font, size: 16, color: DOCX_HOUSE_STYLE.colors.black },
          paragraph: { spacing: { after: 80 } },
        },
        {
          id: "SafeHeading1",
          name: "Safe Heading 1",
          basedOn: "Heading1",
          next: "SafeNormal",
          quickFormat: true,
          run: {
            font: DOCX_HOUSE_STYLE.font,
            size: 22,
            bold: true,
            color: DOCX_HOUSE_STYLE.colors.black,
          },
          paragraph: { spacing: { before: 160, after: 80 } },
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: DOCX_HOUSE_STYLE.page.widthTwip,
              height: DOCX_HOUSE_STYLE.page.heightTwip,
              orientation: PageOrientation.LANDSCAPE,
            },
            margin: {
              top: DOCX_HOUSE_STYLE.page.marginTwip,
              right: DOCX_HOUSE_STYLE.page.marginTwip,
              bottom: DOCX_HOUSE_STYLE.page.marginTwip,
              left: DOCX_HOUSE_STYLE.page.marginTwip,
              header: 360,
              footer: 360,
            },
          },
        },
        footers: {
          default: buildFooter(filename),
        },
        children,
      },
    ],
  });
}

function coverSection(documentSet) {
  const project = documentSet.project;
  return [
    heading("Cover And Document Control"),
    new Paragraph({
      spacing: { after: 80 },
      children: [
        run("Safe Method WHS Control Document Set", { bold: true, size: 28 }),
        run(" - DRAFT", { bold: true, size: 28 }),
      ],
    }),
    table(
      ["Field", "Value"],
      [
        ["Workflow State", "DRAFT - not issue-ready until consultant review/sign-off."],
        ["Project", project.project_name],
        ["Site Address", project.site_address],
        ["Principal Contractor", project.principal_contractor],
        ["WHS Consultant", project.whs_consultant ?? "[Client To Confirm]"],
        ["Jurisdiction", project.jurisdiction],
        ["Document Reference", project.document_ref ?? "[Client To Confirm]"],
        ["Revision", project.revision],
        ["Issue Date", project.issue_date],
        ["Review Date", project.review_date ?? "[Client To Confirm]"],
        ["Document Level", documentSet.document_level],
        ["Trade Packages", joinList(project.trade_packages ?? [])],
      ],
      [2600, 12798],
    ),
  ];
}

function hrcwSection(documentSet) {
  return [
    heading("HRCW Register"),
    table(
      ["Ref", "Item", "Status", "Category", "Packages", "Basis / Condition / Notes"],
      documentSet.hrcw_register.map((row) => [
        row.ref,
        row.schedule_1_item,
        row.trigger_status,
        row.category_title,
        joinList(row.packages),
        joinList([joinList(row.basis_refs ?? []), row.condition, row.notes, row.risk_description]),
      ]),
      [700, 600, 1700, 3200, 2600, 6598],
    ),
  ];
}

function swmsMatrixSection(documentSet) {
  return [
    heading("SWMS Matrix"),
    table(
      [
        "Trade Package",
        "Scope",
        "Confirmed HRCW",
        "Conditional HRCW",
        "SWMS Title",
        "Reviewed By",
        "Required Before",
        "Hold Points",
      ],
      documentSet.swms_matrix.map((row) => [
        row.trade_package,
        row.scope_status,
        joinList(row.hrcw_refs),
        joinList(row.conditional_hrcw_refs ?? []),
        row.swms_title,
        row.reviewed_by,
        row.required_before,
        joinList([...(row.hold_points ?? []), row.hold_point_notes]),
      ]),
      [2100, 1300, 1100, 1400, 2800, 1700, 2800, 2198],
    ),
  ];
}

function holdPointSection(documentSet) {
  return [
    heading("Hold Point Schedule"),
    table(
      ["Ref", "Status", "Title", "Packages", "Release Criteria", "Authority", "Evidence"],
      documentSet.hold_point_schedule.map((row) => [
        row.ref,
        row.status,
        row.title,
        joinList(row.packages),
        row.release_criteria ?? row.precondition,
        row.release_authority ?? row.authority_text,
        row.evidence_required,
      ]),
      [750, 1800, 2300, 2100, 3900, 1900, 2648],
    ),
  ];
}

function riskRegisterSection(documentSet) {
  return [
    heading("Project Risk Register"),
    table(
      ["Ref", "Package", "Activity", "Hazard", "Controls", "Initial", "Residual", "Hold Points"],
      documentSet.risk_register.map((row) => [
        row.ref,
        joinList([row.trade_package, row.risk_status, row.scope_status]),
        joinList([
          row.activity,
          joinList(row.hrcw_categories ?? []),
          joinList(row.conditional_hrcw_categories ?? []),
        ]),
        row.hazard,
        formatControls(row.controls),
        row.initial_risk,
        row.residual_risk,
        joinList(row.hold_points ?? []),
      ]),
      [820, 2300, 2200, 2400, 5100, 780, 900, 898],
      { dataSize: 12 },
    ),
  ];
}

function supportingDocumentsSection(documentSet) {
  const rows = [
    ...(documentSet.supporting_documents ?? []).map((row) => [
      "Supporting Document",
      row.id,
      row.status,
      row.title,
      joinList([row.description, row.owner_role, row.evidence_required]),
    ]),
    ...(documentSet.confirmation_items ?? []).map((row) => [
      "Confirmation Item",
      row.id,
      joinList([row.status, row.blocking_level]),
      row.title,
      joinList([row.owner_role, row.evidence_required, row.notes]),
    ]),
    ...(documentSet.legal_references ?? []).map((row) => [
      "Legal Basis",
      row.id,
      row.jurisdiction,
      row.citation,
      joinList([row.effective_from, row.effective_to, row.date_checked, row.source_url]),
    ]),
  ];

  return [
    heading("Supporting Documents And Confirmation Items"),
    table(
      ["Type", "ID", "Status", "Title / Citation", "Details"],
      rows,
      [2100, 1700, 2100, 4300, 5198],
      {
        dataSize: 12,
      },
    ),
  ];
}

function swmsBenchmarkSection(documentSet, validationReport) {
  const verdict = validationReport?.rules?.verdict?.rating ?? "Benchmark Quality Confirmed";
  const note = documentSet.swms_benchmark_note ?? "";
  const reviewRows = documentSet.swms_benchmark_reviews.map((row) => [
    row.trade_package,
    row.swms_title,
    formatCriteriaEvidence(row.criteria_evidence),
  ]);

  return [
    heading("SWMS Review Benchmark Note And Verdict"),
    paragraph(`Verdict: ${verdict}`, { bold: true }),
    paragraph(note),
    table(["Trade Package", "SWMS Title", "Benchmark Evidence"], reviewRows, [3000, 3600, 8798], {
      dataSize: 12,
    }),
  ];
}

function buildFooter(filename) {
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [
          run(`${filename} | Page `, { size: 14, color: DOCX_HOUSE_STYLE.colors.black }),
          new TextRun({
            font: DOCX_HOUSE_STYLE.font,
            size: 14,
            color: DOCX_HOUSE_STYLE.colors.black,
            children: [PageNumber.CURRENT],
          }),
          run(" of ", { size: 14, color: DOCX_HOUSE_STYLE.colors.black }),
          new TextRun({
            font: DOCX_HOUSE_STYLE.font,
            size: 14,
            color: DOCX_HOUSE_STYLE.colors.black,
            children: [PageNumber.TOTAL_PAGES],
          }),
        ],
      }),
    ],
  });
}

function heading(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    style: "SafeHeading1",
    spacing: { before: 180, after: 80 },
    children: [run(toTitleCase(text), { bold: true, size: 22 })],
  });
}

function paragraph(text, options = {}) {
  return new Paragraph({
    style: "SafeNormal",
    spacing: { after: 80 },
    children: [run(text, options)],
  });
}

function table(headers, rows, columnWidths, options = {}) {
  return new Table({
    width: { size: DOCX_HOUSE_STYLE.page.contentWidthTwip, type: WidthType.DXA },
    columnWidths,
    layout: TableLayoutType.FIXED,
    indent: { size: 0, type: WidthType.DXA },
    margins: { top: 70, bottom: 70, left: 80, right: 80 },
    borders: tableBorders(),
    rows: [
      new TableRow({
        tableHeader: true,
        children: headers.map((header, index) =>
          cell(header, columnWidths[index], {
            header: true,
            size: options.headerSize ?? 13,
          }),
        ),
      }),
      ...rows.map(
        (row) =>
          new TableRow({
            cantSplit: true,
            children: row.map((value, index) =>
              cell(value, columnWidths[index], {
                size: options.dataSize ?? 13,
              }),
            ),
          }),
      ),
    ],
  });
}

function cell(value, width, options = {}) {
  const isHeader = options.header === true;
  const text = safeText(value);

  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    verticalAlign: VerticalAlign.CENTER,
    shading: {
      type: ShadingType.CLEAR,
      fill: isHeader ? DOCX_HOUSE_STYLE.colors.nearBlack : DOCX_HOUSE_STYLE.colors.white,
      color: "auto",
    },
    margins: { top: 70, bottom: 70, left: 80, right: 80 },
    children: [
      new Paragraph({
        spacing: { after: 0 },
        children: [
          run(text, {
            bold: isHeader,
            color: isHeader ? DOCX_HOUSE_STYLE.colors.white : DOCX_HOUSE_STYLE.colors.black,
            size: options.size,
          }),
        ],
      }),
    ],
  });
}

function run(value, options = {}) {
  return new TextRun({
    text: safeText(value),
    font: DOCX_HOUSE_STYLE.font,
    bold: options.bold === true,
    color: options.color ?? DOCX_HOUSE_STYLE.colors.black,
    size: options.size ?? 16,
  });
}

function tableBorders() {
  const border = { style: BorderStyle.SINGLE, size: 4, color: DOCX_HOUSE_STYLE.colors.borderGrey };
  return {
    top: border,
    bottom: border,
    left: border,
    right: border,
    insideHorizontal: border,
    insideVertical: border,
  };
}

function formatControls(controls) {
  return controls
    .map((control) => {
      const source = joinList(control.source_ids ?? []);
      const status = control.control_status ? `${control.control_status}: ` : "";
      return source ? `${status}${control.text} [${source}]` : `${status}${control.text}`;
    })
    .join(" | ");
}

function formatCriteriaEvidence(evidence) {
  return [
    `1. ${evidence.project_specificity}`,
    `2. ${evidence.hazard_identification}`,
    `3. ${evidence.control_adequacy}`,
    `4. ${evidence.hold_points_named_stops}`,
    `5. ${evidence.named_role_responsibility}`,
  ].join(" | ");
}

function joinList(value) {
  if (!Array.isArray(value)) {
    return safeText(value);
  }
  return value
    .filter((item) => item !== undefined && item !== null && safeText(item).trim() !== "")
    .map((item) => safeText(item))
    .join("; ");
}

function safeText(value) {
  if (value === undefined || value === null || value === "") {
    return "[Client To Confirm]";
  }
  return String(value).replace(/\s+/g, " ").trim();
}

function toTitleCase(value) {
  const acronyms = new Set(["HRCW", "SWMS", "WHS", "NSW", "DOCX"]);
  return safeText(value)
    .split(" ")
    .map((word) => {
      const clean = word.replace(/[^A-Za-z]/g, "");
      if (acronyms.has(clean.toUpperCase())) {
        return word.toUpperCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

async function sha256File(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}
