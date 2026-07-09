# Supabase persistence

Phase 1 stores the approved `knowledge/*.json` files in a private Postgres schema named
`safe_method_kb`.

The JSON files remain the WHS source of truth. The migration creates tables and
constraints only; the loader reads the approved JSON at runtime, upserts the rows, and
stores each original source row as JSONB so export can prove a lossless round trip.

## Commands

```powershell
# Full local DB gate using an ephemeral Postgres 17 container
npm run verify:kb:db:docker

# Use a local Supabase/Postgres database instead
$env:SUPABASE_DB_URL="postgres://postgres:postgres@127.0.0.1:54322/postgres"
npm run kb:load -- --apply-migration
npm run verify:kb:db
```

Embeddings and vector search are intentionally absent until optional Phase 7.
