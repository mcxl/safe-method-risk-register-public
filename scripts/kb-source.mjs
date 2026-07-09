import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(scriptsDirectory, "..");

export const KNOWLEDGE_SPECS = Object.freeze([
  {
    tableName: "schedule_1",
    fileName: "schedule_1.json",
    relativePath: "knowledge/schedule_1.json",
    keyField: "ref",
  },
  {
    tableName: "hrcw_trigger_map",
    fileName: "hrcw_trigger_map.json",
    relativePath: "knowledge/hrcw_trigger_map.json",
    keyField: "package",
  },
  {
    tableName: "control_library",
    fileName: "control_library.json",
    relativePath: "knowledge/control_library.json",
    keyField: "id",
  },
  {
    tableName: "hold_point_patterns",
    fileName: "hold_point_patterns.json",
    relativePath: "knowledge/hold_point_patterns.json",
    keyField: "id",
  },
]);

export const EXPECTED_PACKAGE_ARCHETYPES_PATH = "fixtures/phase1/expected-package-archetypes.json";

export function canonicalClone(value) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalClone(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalClone(value[key])]),
    );
  }

  return value;
}

export function canonicalStringify(value) {
  return JSON.stringify(canonicalClone(value));
}

export function sha256Canonical(value) {
  return createHash("sha256").update(canonicalStringify(value), "utf8").digest("hex");
}

export async function readJson(root, relativePath) {
  const contents = await readFile(path.join(root, relativePath), "utf8");
  return JSON.parse(contents);
}

function assertUniqueRows(spec, rows) {
  const seen = new Set();
  for (const row of rows) {
    const key = row[spec.keyField];
    if (typeof key !== "string" || key.length === 0) {
      throw new Error(`${spec.fileName} has a row without ${spec.keyField}`);
    }

    if (seen.has(key)) {
      throw new Error(`${spec.fileName} has duplicate ${spec.keyField}: ${key}`);
    }

    seen.add(key);
  }
}

function exactlyOne(values, label) {
  const unique = [...new Set(values)];
  if (unique.length !== 1) {
    throw new Error(`Expected one ${label}, found: ${unique.join(", ")}`);
  }
  return unique[0];
}

export async function buildKnowledgeSnapshot(root = REPO_ROOT) {
  const files = [];

  for (const [fileIndex, spec] of KNOWLEDGE_SPECS.entries()) {
    const sourceDocument = await readJson(root, spec.relativePath);
    const sourceMeta = sourceDocument._meta;
    const rows = sourceDocument.rows;

    if (!sourceMeta || typeof sourceMeta !== "object") {
      throw new Error(`${spec.fileName} is missing _meta`);
    }

    if (sourceMeta.table !== spec.tableName) {
      throw new Error(
        `${spec.fileName} declares table ${sourceMeta.table}; expected ${spec.tableName}`,
      );
    }

    if (!Array.isArray(rows)) {
      throw new Error(`${spec.fileName} rows must be an array`);
    }

    assertUniqueRows(spec, rows);

    files.push({
      ...spec,
      fileOrder: fileIndex + 1,
      jurisdiction: sourceMeta.jurisdiction,
      kbVersion: sourceMeta.version,
      rowCount: rows.length,
      sourceMeta: canonicalClone(sourceMeta),
      sourceDocument: canonicalClone(sourceDocument),
      sourceHashSha256: sha256Canonical(sourceDocument),
      rowRecords: rows.map((row, rowIndex) => ({
        key: row[spec.keyField],
        rowOrder: rowIndex + 1,
        sourceRow: canonicalClone(row),
        sourceHashSha256: sha256Canonical(row),
      })),
    });
  }

  const kbVersion = exactlyOne(
    files.map((file) => file.kbVersion),
    "KB version",
  );
  const jurisdiction = exactlyOne(
    files.map((file) => file.jurisdiction),
    "jurisdiction",
  );

  const sourceManifest = {
    kb_version: kbVersion,
    jurisdiction,
    files: files.map((file) => ({
      table_name: file.tableName,
      source_path: file.relativePath,
      row_count: file.rowCount,
      source_hash_sha256: file.sourceHashSha256,
    })),
  };

  return {
    kbVersion,
    jurisdiction,
    sourceManifest,
    sourceHashSha256: sha256Canonical(sourceManifest),
    files,
  };
}

export function createEmptyKnowledgeStore() {
  return {
    versions: new Map(),
    sourceFiles: new Map(),
    rowTables: Object.fromEntries(KNOWLEDGE_SPECS.map((spec) => [spec.tableName, new Map()])),
  };
}

export function loadSnapshotIntoStore(store, snapshot) {
  store.versions.set(snapshot.kbVersion, {
    kbVersion: snapshot.kbVersion,
    jurisdiction: snapshot.jurisdiction,
    sourceManifest: canonicalClone(snapshot.sourceManifest),
    sourceHashSha256: snapshot.sourceHashSha256,
  });

  for (const file of snapshot.files) {
    store.sourceFiles.set(`${snapshot.kbVersion}:${file.tableName}`, {
      kbVersion: snapshot.kbVersion,
      tableName: file.tableName,
      sourcePath: file.relativePath,
      jurisdiction: file.jurisdiction,
      sourceMeta: canonicalClone(file.sourceMeta),
      sourceDocument: canonicalClone(file.sourceDocument),
      rowCount: file.rowCount,
      fileOrder: file.fileOrder,
      sourceHashSha256: file.sourceHashSha256,
    });

    const table = store.rowTables[file.tableName];
    for (const row of file.rowRecords) {
      table.set(`${snapshot.kbVersion}:${row.key}`, {
        kbVersion: snapshot.kbVersion,
        jurisdiction: file.jurisdiction,
        key: row.key,
        rowOrder: row.rowOrder,
        sourceRow: canonicalClone(row.sourceRow),
        sourceHashSha256: row.sourceHashSha256,
      });
    }
  }
}

export function exportKnowledgeFromStore(store, kbVersion) {
  const sourceFiles = [...store.sourceFiles.values()]
    .filter((file) => file.kbVersion === kbVersion)
    .sort((left, right) => left.fileOrder - right.fileOrder);

  return Object.fromEntries(
    sourceFiles.map((file) => {
      const rows = [...store.rowTables[file.tableName].values()]
        .filter((row) => row.kbVersion === kbVersion)
        .sort((left, right) => left.rowOrder - right.rowOrder)
        .map((row) => canonicalClone(row.sourceRow));

      return [
        file.sourcePath,
        {
          _meta: canonicalClone(file.sourceMeta),
          rows,
        },
      ];
    }),
  );
}

export function sourceDocumentsByPath(snapshot) {
  return Object.fromEntries(
    snapshot.files.map((file) => [file.relativePath, canonicalClone(file.sourceDocument)]),
  );
}

export function assertLosslessExport(snapshot, exportedDocuments) {
  const sourceDocuments = sourceDocumentsByPath(snapshot);
  const diffs = [];

  for (const file of snapshot.files) {
    const source = sourceDocuments[file.relativePath];
    const exported = exportedDocuments[file.relativePath];

    if (!exported) {
      diffs.push(`${file.relativePath}: missing export`);
      continue;
    }

    const sourceHash = sha256Canonical(source);
    const exportHash = sha256Canonical(exported);
    if (sourceHash !== exportHash) {
      diffs.push(`${file.relativePath}: ${sourceHash} != ${exportHash}`);
    }
  }

  if (diffs.length > 0) {
    throw new Error(`KB round-trip lost data:\n${diffs.join("\n")}`);
  }
}

export function tableRowCounts(snapshot) {
  return Object.fromEntries(snapshot.files.map((file) => [file.tableName, file.rowRecords.length]));
}

export async function readExpectedPackageArchetypes(root = REPO_ROOT) {
  const fixture = await readJson(root, EXPECTED_PACKAGE_ARCHETYPES_PATH);
  if (!Array.isArray(fixture.packages)) {
    throw new Error(`${EXPECTED_PACKAGE_ARCHETYPES_PATH} packages must be an array`);
  }
  return fixture.packages;
}

export async function assertExpectedPackageArchetypes(snapshot, root = REPO_ROOT) {
  const expected = await readExpectedPackageArchetypes(root);
  const triggerFile = snapshot.files.find((file) => file.tableName === "hrcw_trigger_map");
  const actual = triggerFile.rowRecords.map((row) => row.sourceRow.package);

  if (canonicalStringify(actual) !== canonicalStringify(expected)) {
    throw new Error(
      `Package archetype fixture mismatch.\nExpected: ${JSON.stringify(
        expected,
      )}\nActual: ${JSON.stringify(actual)}`,
    );
  }
}
