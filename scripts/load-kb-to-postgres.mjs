import {
  applyLatestMigration,
  createPostgresClient,
  loadKnowledgeSnapshot,
} from "./kb-postgres.mjs";
import { buildKnowledgeSnapshot } from "./kb-source.mjs";

const databaseUrl = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL;
const applyMigration = process.argv.includes("--apply-migration");

if (!databaseUrl) {
  throw new Error("Set DATABASE_URL or SUPABASE_DB_URL before loading the KB.");
}

const sql = createPostgresClient(databaseUrl);

try {
  if (applyMigration) {
    const migrationPath = await applyLatestMigration(sql);
    console.log(`Applied migration: ${migrationPath}`);
  }

  const snapshot = await buildKnowledgeSnapshot();
  await loadKnowledgeSnapshot(sql, snapshot);
  console.log(`Loaded KB ${snapshot.kbVersion} (${snapshot.jurisdiction})`);
} finally {
  await sql.end();
}
