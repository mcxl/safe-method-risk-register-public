import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(".");
const SKIP_DIRECTORIES = new Set([
  ".git",
  ".codegraph",
  ".tools",
  ".venv",
  "node_modules",
  "coverage",
  "dist",
]);

const FORBIDDEN_PATH_PARTS = [
  ".env",
  ".env.1password",
  "fixtures/golden/masters",
  "fixtures/golden/briefs",
  "outputs/tmp",
  "outputs/local",
];

const FORBIDDEN_EXTENSIONS = new Set([".docx", ".xlsx", ".xlsm", ".pdf", ".png", ".jpg", ".jpeg"]);

const SECRET_PATTERNS = [
  { id: "private-key", pattern: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/u },
  { id: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{30,}\b/u },
  { id: "github-fine-grained-token", pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/u },
  { id: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { id: "openai-or-anthropic-key", pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}\b/u },
  { id: "sendgrid-key", pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/u },
];

const PRIVATE_BENCHMARK_TERMS = [
  { id: "private-benchmark-name", term: ["Uni", "tas"].join("") },
  { id: "private-benchmark-name", term: ["Pad", "ding", "ton"].join("") },
  { id: "private-benchmark-name", term: ["R", "P", "D"].join("") },
  { id: "private-site-name", term: ["Coo", "gee"].join("") },
  { id: "private-site-name", term: ["75 ", "Mount"].join("") },
];

const findings = [];

for await (const filePath of walk(ROOT)) {
  const relativePath = toRepoPath(filePath);
  const normalized = relativePath.toLowerCase();
  const extension = path.extname(filePath).toLowerCase();

  if (
    FORBIDDEN_PATH_PARTS.some((part) => normalized === part || normalized.startsWith(`${part}/`))
  ) {
    findings.push({ type: "forbidden-path", file: relativePath });
    continue;
  }
  if (FORBIDDEN_EXTENSIONS.has(extension)) {
    findings.push({ type: "forbidden-binary", file: relativePath });
    continue;
  }

  const fileStat = await stat(filePath);
  if (fileStat.size > 1024 * 1024) continue;

  const text = await readTextIfPossible(filePath);
  if (text === null) continue;

  for (const { id, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      findings.push({ type: "secret-pattern", id, file: relativePath });
    }
  }

  for (const { id, term } of PRIVATE_BENCHMARK_TERMS) {
    const pattern = new RegExp(`\\b${escapeRegExp(term)}\\b`, "iu");
    if (pattern.test(text)) {
      findings.push({ type: "private-benchmark-pattern", id, file: relativePath });
    }
  }
}

if (findings.length > 0) {
  for (const finding of findings) {
    const detail = finding.id ? ` ${finding.id}` : "";
    console.error(`FAIL ${finding.type}${detail}: ${finding.file}`);
  }
  process.exit(1);
}

console.log("PUBLIC SECRET/ARTIFACT SCAN: PASS");

async function* walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      yield* walk(absolute);
    } else if (entry.isFile()) {
      yield absolute;
    }
  }
}

async function readTextIfPossible(filePath) {
  const buffer = await readFile(filePath);
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

function toRepoPath(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/gu, "/");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
