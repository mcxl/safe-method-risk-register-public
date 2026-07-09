import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { createPostgresClient, runDatabaseRoundTrip } from "./kb-postgres.mjs";

const args = new Set(process.argv.slice(2));
const useDocker = args.has("--docker");

let containerId = null;
let databaseUrl = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL;

if (useDocker) {
  containerId = execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "-d",
      "-e",
      "POSTGRES_PASSWORD=postgres",
      "-e",
      "POSTGRES_DB=postgres",
      "-p",
      "127.0.0.1::5432",
      "postgres:17-alpine",
    ],
    { encoding: "utf8" },
  ).trim();

  const portLine = execFileSync("docker", ["port", containerId, "5432/tcp"], {
    encoding: "utf8",
  }).trim();
  const port = portLine.split(":").at(-1);
  databaseUrl = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
}

if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL/SUPABASE_DB_URL for a local Supabase/Postgres database, or pass --docker.",
  );
}

async function waitForDatabase(url) {
  let lastError;

  for (let attempt = 1; attempt <= 45; attempt += 1) {
    const sql = createPostgresClient(url);
    try {
      await sql`select 1`;
      await sql.end();
      return;
    } catch (error) {
      lastError = error;
      await sql.end({ timeout: 0 }).catch(() => {});
      await delay(1000);
    }
  }

  throw lastError;
}

try {
  if (useDocker) {
    await waitForDatabase(databaseUrl);
  }

  const sql = createPostgresClient(databaseUrl);
  const result = await runDatabaseRoundTrip(sql);
  await sql.end();

  console.log(`PASS  migration applied: ${result.migrationPath}`);
  console.log(`PASS  KB loaded twice without duplicate rows: ${result.snapshot.kbVersion}`);

  for (const [tableName, count] of Object.entries(result.counts)) {
    console.log(`PASS  ${tableName}: ${count} persisted rows`);
  }

  console.log("\nPHASE 1 KB DATABASE ROUND-TRIP: PASS");
} finally {
  if (containerId) {
    execFileSync("docker", ["stop", containerId], { stdio: "ignore" });
  }
}
