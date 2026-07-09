import { spawnSync } from "node:child_process";
import path from "node:path";

const failures = [];
const nodeVersion = process.versions.node;
const nodeMajor = Number(nodeVersion.split(".")[0]);

if (nodeMajor !== 24) {
  failures.push(`Node must be 24.x; found ${nodeVersion}`);
} else {
  console.log(`PASS Node ${nodeVersion}`);
}

const pythonCheck = spawnSync(
  process.execPath,
  [
    "scripts/run-python.mjs",
    "-c",
    [
      "import pip, sys",
      "assert sys.version_info[:2] == (3, 13), sys.version",
      "print(f'PASS Python {sys.version.split()[0]}')",
      "print(f'PASS pip {pip.__version__} on Python {sys.version_info.major}.{sys.version_info.minor}')",
    ].join("; "),
  ],
  { encoding: "utf8" },
);

process.stdout.write(pythonCheck.stdout ?? "");
process.stderr.write(pythonCheck.stderr ?? "");
if (pythonCheck.status !== 0) {
  failures.push("Python and pip must resolve through the pinned Python 3.13 environment");
}

const gitRootResult = spawnSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
});
const expectedRoot = path.resolve(process.cwd()).toLowerCase();
const actualRoot = path.resolve((gitRootResult.stdout ?? "").trim()).toLowerCase();

if (gitRootResult.status !== 0 || actualRoot !== expectedRoot) {
  failures.push(`Git root must be ${process.cwd()}; found ${actualRoot || "none"}`);
} else {
  console.log(`PASS Git root ${process.cwd()}`);
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL ${failure}`);
  }
  process.exit(1);
}

console.log("PHASE 0 TOOLCHAIN: PASS");
