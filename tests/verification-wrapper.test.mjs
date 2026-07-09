import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("PowerShell verification wrapper delegates npm scripts through pinned Node", async () => {
  const npmPinned = await readFile("scripts/npm-pinned.ps1", "utf8");
  const verify = await readFile("scripts/verify.ps1", "utf8");

  assert.match(npmPinned, /Get-Content -LiteralPath \(Join-Path \$root "\.nvmrc"\)/u);
  assert.match(npmPinned, /\.tools\\node-v\$nodeVersion-win-x64/u);
  assert.match(npmPinned, /Join-Path \$nodeDirectory "npm\.cmd"/u);
  assert.match(npmPinned, /Pinned Node is missing\. Run scripts\\bootstrap\.ps1 first\./u);
  assert.match(npmPinned, /\$env:PATH = "\$nodeDirectory;\$env:PATH"/u);
  assert.match(npmPinned, /& \$npmExecutable run \$ScriptName -- @ScriptArgs/u);
  assert.match(npmPinned, /& \$npmExecutable run \$ScriptName\r?\n/u);

  assert.match(verify, /\[string\]\$ScriptName = "verify"/u);
  assert.match(verify, /Join-Path \$PSScriptRoot "npm-pinned\.ps1"/u);
  assert.match(verify, /& \$runner \$ScriptName @ScriptArgs/u);
});
