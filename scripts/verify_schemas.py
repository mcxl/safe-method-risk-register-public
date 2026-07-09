"""Validate every project schema as JSON Schema Draft 2020-12."""

import glob
import json
import sys

from jsonschema import Draft202012Validator


CORE_GENERATION_SCHEMAS = {
    "schemas\\document-set.schema.json",
    "schemas\\project-meta.schema.json",
    "schemas\\hrcw-register-row.schema.json",
    "schemas\\swms-matrix-row.schema.json",
    "schemas\\hold-point.schema.json",
    "schemas\\risk-register-row.schema.json",
}

files = sorted(glob.glob("schemas/*.schema.json"))
normalised_files = {filename.replace("/", "\\") for filename in files}
missing = sorted(CORE_GENERATION_SCHEMAS - normalised_files)

if missing:
    print(f"FAIL missing core generation schemas: {', '.join(missing)}", file=sys.stderr)
    raise SystemExit(1)

for filename in files:
    with open(filename, encoding="utf-8") as handle:
        Draft202012Validator.check_schema(json.load(handle))
    print("OK", filename)

print("PYTHON DRAFT 2020-12 SCHEMA GATE: PASS")
