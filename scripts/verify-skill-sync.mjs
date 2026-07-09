import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { REPO_ROOT } from "./kb-source.mjs";

const SKILL_ROOT = path.join(
  process.env.CODEX_HOME ?? path.join(homedir(), ".codex"),
  "skills",
  "safe-method-risk-register",
);
const FALLBACK_DIRECTORIES = Object.freeze([
  "scripts",
  "app",
  "render",
  "generate",
  "rules",
  "schemas",
]);
const REQUIRED_SKILL_PHRASES = Object.freeze([
  "handoff manifest",
  "preflight",
  "issue-ready",
  "Do not edit knowledge/",
]);
const REQUIRED_CLAUDE_PHRASES = Object.freeze([
  "AGENTS.md",
  "CODEX_HANDOVER.md",
  "IMPLEMENTATION_PLAN.md",
  "codegraph explore",
  "Do not edit `knowledge/`",
  "handoff manifest",
  "preflight",
  "issue-ready",
]);
const CLAUDE_PATH = path.join(REPO_ROOT, "CLAUDE.md");

if (!existsSync(SKILL_ROOT)) {
  console.log(`SKIP installed skill not found at ${SKILL_ROOT}`);
  process.exit(0);
}

const failures = [];
const fallbackFiles = [];

for (const directory of FALLBACK_DIRECTORIES) {
  const skillDirectory = path.join(SKILL_ROOT, directory);
  if (existsSync(skillDirectory)) {
    fallbackFiles.push(...(await listFiles(skillDirectory)));
  }
}

for (const skillFile of fallbackFiles) {
  const relativePath = path.relative(SKILL_ROOT, skillFile).replace(/\\/gu, "/");
  const repoFile = path.join(REPO_ROOT, relativePath);
  if (!existsSync(repoFile)) {
    failures.push(`${relativePath}: skill fallback has no repo source file`);
    continue;
  }

  const [skillHash, repoHash] = await Promise.all([sha256File(skillFile), sha256File(repoFile)]);
  if (skillHash !== repoHash) {
    failures.push(`${relativePath}: skill fallback hash ${skillHash} != repo hash ${repoHash}`);
  }
}

const skillText = await readFile(path.join(SKILL_ROOT, "SKILL.md"), "utf8");
for (const phrase of REQUIRED_SKILL_PHRASES) {
  if (!skillText.includes(phrase)) {
    failures.push(`SKILL.md missing required phrase: ${phrase}`);
  }
}

if (!existsSync(CLAUDE_PATH)) {
  failures.push("CLAUDE.md is missing");
} else {
  const claudeText = await readFile(CLAUDE_PATH, "utf8");
  for (const phrase of REQUIRED_CLAUDE_PHRASES) {
    if (!claudeText.includes(phrase)) {
      failures.push(`CLAUDE.md missing required phrase: ${phrase}`);
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL ${failure}`);
  }
  process.exit(1);
}

if (fallbackFiles.length === 0) {
  console.log("PASS installed skill has no duplicated repo fallback tooling to hash-sync.");
} else {
  console.log(`PASS ${fallbackFiles.length} installed skill fallback file(s) match repo hashes.`);
}
console.log("PASS Claude adapter carries required repo guardrails.");
console.log("SKILL SYNC GATE: PASS");

async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory)) {
    const absolutePath = path.join(directory, entry);
    const entryStat = await stat(absolutePath);
    if (entryStat.isDirectory()) {
      files.push(...(await listFiles(absolutePath)));
    } else {
      files.push(absolutePath);
    }
  }
  return files;
}

async function sha256File(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}
