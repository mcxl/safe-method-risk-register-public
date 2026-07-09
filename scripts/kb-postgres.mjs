import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import postgres from "postgres";

import {
  KNOWLEDGE_SPECS,
  REPO_ROOT,
  assertLosslessExport,
  buildKnowledgeSnapshot,
  canonicalClone,
  tableRowCounts,
} from "./kb-source.mjs";

const KNOWN_TABLE_NAMES = new Set(KNOWLEDGE_SPECS.map((spec) => spec.tableName));

export function createPostgresClient(databaseUrl) {
  return postgres(databaseUrl, {
    max: 1,
    idle_timeout: 1,
    connect_timeout: 10,
  });
}

export async function latestMigrationPath(root = REPO_ROOT) {
  const migrationsDirectory = path.join(root, "supabase", "migrations");
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  if (migrationFiles.length === 0) {
    throw new Error("No Supabase migration SQL files found");
  }

  return path.join(migrationsDirectory, migrationFiles.at(-1));
}

export async function applyLatestMigration(sql, root = REPO_ROOT) {
  const migrationPath = await latestMigrationPath(root);
  const migrationSql = await readFile(migrationPath, "utf8");
  await sql.unsafe(migrationSql);
  return migrationPath;
}

export async function loadKnowledgeSnapshot(sql, snapshot) {
  await sql.begin(async (tx) => {
    await tx`
      insert into safe_method_kb.kb_versions (
        kb_version,
        jurisdiction,
        source_manifest,
        source_hash_sha256,
        loaded_at
      )
      values (
        ${snapshot.kbVersion},
        ${snapshot.jurisdiction},
        ${tx.json(snapshot.sourceManifest)},
        ${snapshot.sourceHashSha256},
        now()
      )
      on conflict (kb_version) do update set
        jurisdiction = excluded.jurisdiction,
        source_manifest = excluded.source_manifest,
        source_hash_sha256 = excluded.source_hash_sha256,
        loaded_at = now()
    `;

    for (const file of snapshot.files) {
      await tx`
        insert into safe_method_kb.kb_source_files (
          kb_version,
          table_name,
          source_path,
          jurisdiction,
          source_meta,
          source_document,
          row_count,
          file_order,
          source_hash_sha256,
          loaded_at
        )
        values (
          ${snapshot.kbVersion},
          ${file.tableName},
          ${file.relativePath},
          ${file.jurisdiction},
          ${tx.json(file.sourceMeta)},
          ${tx.json(file.sourceDocument)},
          ${file.rowCount},
          ${file.fileOrder},
          ${file.sourceHashSha256},
          now()
        )
        on conflict (kb_version, table_name) do update set
          source_path = excluded.source_path,
          jurisdiction = excluded.jurisdiction,
          source_meta = excluded.source_meta,
          source_document = excluded.source_document,
          row_count = excluded.row_count,
          file_order = excluded.file_order,
          source_hash_sha256 = excluded.source_hash_sha256,
          loaded_at = now()
      `;

      await loadRowsForFile(tx, snapshot, file);
    }
  });
}

async function loadRowsForFile(tx, snapshot, file) {
  if (file.tableName === "schedule_1") {
    for (const row of file.rowRecords) {
      await tx`
        insert into safe_method_kb.schedule_1 (
          kb_version,
          jurisdiction,
          ref,
          item,
          category_title,
          row_order,
          source_row,
          source_hash_sha256
        )
        values (
          ${snapshot.kbVersion},
          ${file.jurisdiction},
          ${row.sourceRow.ref},
          ${row.sourceRow.item},
          ${row.sourceRow.category_title},
          ${row.rowOrder},
          ${tx.json(row.sourceRow)},
          ${row.sourceHashSha256}
        )
        on conflict (kb_version, ref) do update set
          jurisdiction = excluded.jurisdiction,
          item = excluded.item,
          category_title = excluded.category_title,
          row_order = excluded.row_order,
          source_row = excluded.source_row,
          source_hash_sha256 = excluded.source_hash_sha256
      `;
    }
    return;
  }

  if (file.tableName === "hrcw_trigger_map") {
    for (const row of file.rowRecords) {
      await tx`
        insert into safe_method_kb.hrcw_trigger_map (
          kb_version,
          jurisdiction,
          package,
          aliases,
          triggers,
          row_order,
          source_row,
          source_hash_sha256
        )
        values (
          ${snapshot.kbVersion},
          ${file.jurisdiction},
          ${row.sourceRow.package},
          ${tx.json(row.sourceRow.aliases)},
          ${tx.json(row.sourceRow.triggers)},
          ${row.rowOrder},
          ${tx.json(row.sourceRow)},
          ${row.sourceHashSha256}
        )
        on conflict (kb_version, package) do update set
          jurisdiction = excluded.jurisdiction,
          aliases = excluded.aliases,
          triggers = excluded.triggers,
          row_order = excluded.row_order,
          source_row = excluded.source_row,
          source_hash_sha256 = excluded.source_hash_sha256
      `;
    }
    return;
  }

  if (file.tableName === "control_library") {
    for (const row of file.rowRecords) {
      await tx`
        insert into safe_method_kb.control_library (
          kb_version,
          jurisdiction,
          id,
          hazard_type,
          control,
          levels,
          residual_floor,
          linked_hold_point,
          requires_rescue_readiness,
          non_hrcw,
          row_order,
          source_row,
          source_hash_sha256
        )
        values (
          ${snapshot.kbVersion},
          ${file.jurisdiction},
          ${row.sourceRow.id},
          ${row.sourceRow.hazard_type},
          ${row.sourceRow.control},
          ${tx.json(row.sourceRow.levels)},
          ${row.sourceRow.residual_floor},
          ${row.sourceRow.linked_hold_point ?? null},
          ${row.sourceRow.requires_rescue_readiness ?? null},
          ${row.sourceRow.non_hrcw ?? null},
          ${row.rowOrder},
          ${tx.json(row.sourceRow)},
          ${row.sourceHashSha256}
        )
        on conflict (kb_version, id) do update set
          jurisdiction = excluded.jurisdiction,
          hazard_type = excluded.hazard_type,
          control = excluded.control,
          levels = excluded.levels,
          residual_floor = excluded.residual_floor,
          linked_hold_point = excluded.linked_hold_point,
          requires_rescue_readiness = excluded.requires_rescue_readiness,
          non_hrcw = excluded.non_hrcw,
          row_order = excluded.row_order,
          source_row = excluded.source_row,
          source_hash_sha256 = excluded.source_hash_sha256
      `;
    }
    return;
  }

  if (file.tableName === "hold_point_patterns") {
    for (const row of file.rowRecords) {
      await tx`
        insert into safe_method_kb.hold_point_patterns (
          kb_version,
          jurisdiction,
          id,
          title,
          applies_to,
          precondition,
          authority_roles,
          authority_text_pattern,
          evidence_required,
          release_type,
          engineering_release,
          row_order,
          source_row,
          source_hash_sha256
        )
        values (
          ${snapshot.kbVersion},
          ${file.jurisdiction},
          ${row.sourceRow.id},
          ${row.sourceRow.title},
          ${tx.json(row.sourceRow.applies_to)},
          ${row.sourceRow.precondition},
          ${tx.json(row.sourceRow.authority_roles)},
          ${row.sourceRow.authority_text_pattern},
          ${row.sourceRow.evidence_required},
          ${row.sourceRow.release_type},
          ${row.sourceRow.engineering_release},
          ${row.rowOrder},
          ${tx.json(row.sourceRow)},
          ${row.sourceHashSha256}
        )
        on conflict (kb_version, id) do update set
          jurisdiction = excluded.jurisdiction,
          title = excluded.title,
          applies_to = excluded.applies_to,
          precondition = excluded.precondition,
          authority_roles = excluded.authority_roles,
          authority_text_pattern = excluded.authority_text_pattern,
          evidence_required = excluded.evidence_required,
          release_type = excluded.release_type,
          engineering_release = excluded.engineering_release,
          row_order = excluded.row_order,
          source_row = excluded.source_row,
          source_hash_sha256 = excluded.source_hash_sha256
      `;
    }
    return;
  }

  throw new Error(`Unsupported KB table: ${file.tableName}`);
}

export async function exportKnowledgeDocuments(sql, kbVersion) {
  const sourceFiles = await sql`
    select
      table_name,
      source_path,
      source_meta,
      file_order
    from safe_method_kb.kb_source_files
    where kb_version = ${kbVersion}
    order by file_order
  `;

  return Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (file) => {
        if (!KNOWN_TABLE_NAMES.has(file.table_name)) {
          throw new Error(`Unexpected KB table name in database: ${file.table_name}`);
        }

        const rows = await sql.unsafe(
          `
          select source_row
          from safe_method_kb.${file.table_name}
          where kb_version = $1
          order by row_order
        `,
          [kbVersion],
        );

        return [
          file.source_path,
          {
            _meta: canonicalClone(file.source_meta),
            rows: rows.map((row) => canonicalClone(row.source_row)),
          },
        ];
      }),
    ),
  );
}

export async function databaseTableCounts(sql, kbVersion) {
  const counts = {};

  for (const spec of KNOWLEDGE_SPECS) {
    const rows = await sql.unsafe(
      `select count(*)::int as count from safe_method_kb.${spec.tableName} where kb_version = $1`,
      [kbVersion],
    );
    counts[spec.tableName] = rows[0].count;
  }

  return counts;
}

export async function assertDatabaseMatchesSnapshot(sql, snapshot) {
  const expectedCounts = tableRowCounts(snapshot);
  const actualCounts = await databaseTableCounts(sql, snapshot.kbVersion);

  for (const [tableName, expectedCount] of Object.entries(expectedCounts)) {
    if (actualCounts[tableName] !== expectedCount) {
      throw new Error(
        `${tableName} row count mismatch: expected ${expectedCount}, actual ${actualCounts[tableName]}`,
      );
    }
  }

  const sourceFileCounts = await sql`
    select count(*)::int as count
    from safe_method_kb.kb_source_files
    where kb_version = ${snapshot.kbVersion}
  `;

  if (sourceFileCounts[0].count !== snapshot.files.length) {
    throw new Error(
      `kb_source_files row count mismatch: expected ${snapshot.files.length}, actual ${sourceFileCounts[0].count}`,
    );
  }

  const exportedDocuments = await exportKnowledgeDocuments(sql, snapshot.kbVersion);
  assertLosslessExport(snapshot, exportedDocuments);

  return actualCounts;
}

export async function runDatabaseRoundTrip(sql) {
  const snapshot = await buildKnowledgeSnapshot();
  const migrationPath = await applyLatestMigration(sql);

  await loadKnowledgeSnapshot(sql, snapshot);
  await loadKnowledgeSnapshot(sql, snapshot);

  const counts = await assertDatabaseMatchesSnapshot(sql, snapshot);

  return {
    snapshot,
    migrationPath,
    counts,
  };
}
