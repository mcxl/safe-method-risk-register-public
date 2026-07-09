import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  applyLatestMigration,
  createPostgresClient,
  exportKnowledgeDocuments,
} from "./kb-postgres.mjs";
import { buildKnowledgeSnapshot, canonicalStringify } from "./kb-source.mjs";

const databaseUrl = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL;
const outputIndex = process.argv.indexOf("--out");
const outputDirectory = outputIndex === -1 ? null : process.argv[outputIndex + 1];
const applyMigration = process.argv.includes("--apply-migration");

if (!databaseUrl) {
  throw new Error("Set DATABASE_URL or SUPABASE_DB_URL before exporting the KB.");
}

if (outputIndex !== -1 && !outputDirectory) {
  throw new Error("Pass a directory after --out.");
}

const sql = createPostgresClient(databaseUrl);

try {
  if (applyMigration) {
    await applyLatestMigration(sql);
  }

  const snapshot = await buildKnowledgeSnapshot();
  const exportedDocuments = await exportKnowledgeDocuments(sql, snapshot.kbVersion);

  if (!outputDirectory) {
    console.log(canonicalStringify(exportedDocuments));
  } else {
    for (const [relativePath, document] of Object.entries(exportedDocuments)) {
      const fileName = path.basename(relativePath);
      await writeFile(
        path.join(outputDirectory, fileName),
        `${JSON.stringify(document, null, 2)}\n`,
        "utf8",
      );
    }
    console.log(`Exported ${Object.keys(exportedDocuments).length} KB files to ${outputDirectory}`);
  }
} finally {
  await sql.end();
}
