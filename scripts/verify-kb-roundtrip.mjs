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
} from "./kb-source.mjs";

const snapshot = await buildKnowledgeSnapshot();
await assertExpectedPackageArchetypes(snapshot);

const store = createEmptyKnowledgeStore();
loadSnapshotIntoStore(store, snapshot);
loadSnapshotIntoStore(store, snapshot);

const exportedDocuments = exportKnowledgeFromStore(store, snapshot.kbVersion);
assertLosslessExport(snapshot, exportedDocuments);

const sourceDocuments = sourceDocumentsByPath(snapshot);
const counts = tableRowCounts(snapshot);

console.log(`PASS  KB version ${snapshot.kbVersion} (${snapshot.jurisdiction})`);
console.log("PASS  expected package-archetype fixture matches hrcw_trigger_map order");

for (const file of snapshot.files) {
  const sourceHash = sha256Canonical(sourceDocuments[file.relativePath]);
  const exportHash = sha256Canonical(exportedDocuments[file.relativePath]);
  console.log(
    `PASS  ${file.tableName}: ${counts[file.tableName]} rows, source/export hash ${sourceHash}/${exportHash}`,
  );
}

console.log("\nPHASE 1 KB ROUND-TRIP: PASS");
