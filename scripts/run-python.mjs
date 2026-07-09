import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const venvPython =
  process.platform === "win32"
    ? path.join(root, ".venv", "Scripts", "python.exe")
    : path.join(root, ".venv", "bin", "python");

const python = process.env.PYTHON ?? (existsSync(venvPython) ? venvPython : "python");
const args = process.argv.slice(2);
const result = spawnSync(python, args, { cwd: root, stdio: "inherit" });

if (result.error) {
  console.error(`Unable to run ${python}: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
