import { createAjvRegistry, readSchemaDocuments } from "./schema-registry.mjs";

const registry = createAjvRegistry();
const schemas = readSchemaDocuments();

for (const { fileName } of schemas) {
  registry.getValidator(fileName);
  console.log(`OK ${fileName}`);
}

console.log("AJV DRAFT 2020-12 SCHEMA GATE: PASS");
