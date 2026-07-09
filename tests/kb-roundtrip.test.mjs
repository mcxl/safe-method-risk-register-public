import assert from "node:assert/strict";
import test from "node:test";

import {
  assertExpectedPackageArchetypes,
  assertLosslessExport,
  buildKnowledgeSnapshot,
  createEmptyKnowledgeStore,
  exportKnowledgeFromStore,
  loadSnapshotIntoStore,
  sha256Canonical,
  sourceDocumentsByPath,
  tableRowCounts,
} from "../scripts/kb-source.mjs";

test("expected package archetypes are explicit and match the trigger map", async () => {
  const snapshot = await buildKnowledgeSnapshot();
  await assertExpectedPackageArchetypes(snapshot);

  const counts = tableRowCounts(snapshot);
  assert.equal(counts.hrcw_trigger_map, 20);
});

test("KB load is idempotent and exports losslessly from row storage", async () => {
  const snapshot = await buildKnowledgeSnapshot();
  const store = createEmptyKnowledgeStore();

  loadSnapshotIntoStore(store, snapshot);
  loadSnapshotIntoStore(store, snapshot);

  const exportedDocuments = exportKnowledgeFromStore(store, snapshot.kbVersion);
  assertLosslessExport(snapshot, exportedDocuments);

  const sourceDocuments = sourceDocumentsByPath(snapshot);
  for (const file of snapshot.files) {
    assert.equal(
      sha256Canonical(exportedDocuments[file.relativePath]),
      sha256Canonical(sourceDocuments[file.relativePath]),
    );
  }
});
