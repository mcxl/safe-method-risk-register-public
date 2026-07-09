import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

export const EXPECTED_SECTIONED_BRANCH = "codex/phase-4-sectioned-generation";
export const ENV_FILE_CANDIDATES = Object.freeze([".env", ".env.local"]);
export const FAILURE_TAXONOMY = Object.freeze([
  "provider/runtime/timeout -> external or model-size blocker",
  "section envelope/schema -> section prompt or retry hardening",
  "assembled deterministic rule -> correction-context hardening",
  "renderer/preflight -> out of scope unless a render command ran",
]);
export const VERIFICATION_WORKER_ROLES = Object.freeze([
  "coordinator owns scope, final decisions and evidence",
  "local-verifier runs deterministic commands",
  "live-smoke verifier runs the API gate and captures diagnostics",
  "evidence verifier checks phase-gate wording and knowledge cleanliness",
]);

const LOCAL_GATE_PLAN = Object.freeze([
  {
    label: "unit and fixture gate",
    command: (context) => ({
      executable: context.nodeExecutable,
      args: ["--test", "tests\\generation.test.mjs", "tests\\sectioned-generation.test.mjs"],
    }),
  },
  {
    label: "deterministic generation gate",
    command: (context) => npmRun(context, "verify:generation"),
  },
  {
    label: "sectioned generation gate",
    command: (context) => npmRun(context, "verify:generation:sectioned"),
  },
  {
    label: "offline deterministic repo gate",
    command: (context) => npmRun(context, "verify:offline"),
  },
  {
    label: "phase evidence gate",
    command: (context) => npmRun(context, "verify:phase5b:evidence"),
  },
]);

const KNOWLEDGE_DIFF_PLAN = Object.freeze([
  {
    label: "knowledge working tree diff",
    args: ["diff", "--name-only", "--", "knowledge"],
  },
  {
    label: "knowledge staged diff",
    args: ["diff", "--cached", "--name-only", "--", "knowledge"],
  },
]);

export function evaluateSectionedLivePreflight(options = {}) {
  return evaluatePreflightContext(buildPreflightContext(options));
}

export function runSectionedLiveVerification(options = {}) {
  const preflightContext = buildPreflightContext(options);
  const { cwd, env, runner } = preflightContext;
  const preflight = evaluatePreflightContext(preflightContext);
  if (!options.quiet) {
    printPreflightReport(preflight, options);
  }

  if (preflight.status !== "pass") {
    return { status: "fail", exitCode: 1, preflight, steps: [] };
  }

  const context = {
    cwd,
    env,
    nodeExecutable: "node",
    npmExecutable: npmExecutable(),
  };
  const steps = [];

  if (options.runLocalGates) {
    for (const gate of LOCAL_GATE_PLAN) {
      const command = gate.command(context);
      const result = runPassthrough(runner, command.executable, command.args, {
        cwd,
        env: context.env,
        label: gate.label,
        quiet: options.quiet,
      });
      steps.push({ label: gate.label, status: result.status });
      if (result.status !== 0) {
        if (!options.quiet) {
          console.error(`FAIL ${gate.label}`);
        }
        return { status: "fail", exitCode: result.status || 1, preflight, steps };
      }
    }

    const knowledgeResult = verifyKnowledgeDiffClean({
      cwd,
      env: context.env,
      runner,
      phase: "after local gates",
      quiet: options.quiet,
    });
    steps.push(...knowledgeResult.steps);
    if (knowledgeResult.status !== "pass") {
      return { status: "fail", exitCode: 1, preflight, steps };
    }
  }

  if (options.runLive) {
    const command = npmRun(context, "verify:generation:sectioned:api");
    const result = runPassthrough(runner, command.executable, command.args, {
      cwd,
      env: context.env,
      label: "live sectioned API smoke",
      quiet: options.quiet,
    });
    steps.push({ label: "live sectioned API smoke", status: result.status });
    if (result.status !== 0) {
      if (!options.quiet) {
        console.error("FAIL live sectioned API smoke");
      }
      return { status: "fail", exitCode: result.status || 1, preflight, steps };
    }
  }

  const finalKnowledgeResult = verifyKnowledgeDiffClean({
    cwd,
    env: context.env,
    runner,
    phase: "after verification",
    quiet: options.quiet,
  });
  steps.push(...finalKnowledgeResult.steps);
  if (finalKnowledgeResult.status !== "pass") {
    return { status: "fail", exitCode: 1, preflight, steps };
  }

  if (!options.quiet) {
    console.log("PHASE 4 SECTIONED LIVE VERIFICATION PREFLIGHT: PASS");
  }
  return { status: "pass", exitCode: 0, preflight, steps };
}

function buildPreflightContext(options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const runner = options.runner ?? runCommand;
  const env = buildEffectiveEnv({
    cwd,
    env: options.env ?? process.env,
    envFileCandidates: options.envFileCandidates ?? ENV_FILE_CANDIDATES,
    readEnvFile: options.readEnvFile,
  });
  return { cwd, runner, env };
}

function evaluatePreflightContext({ cwd, runner, env }) {
  const checks = [];

  const branch = runCapture(runner, "git", ["branch", "--show-current"], {
    cwd,
    env,
    label: "current git branch",
  });
  checks.push(
    checkResult(
      "branch",
      branch.status === 0 && branch.stdout.trim() === EXPECTED_SECTIONED_BRANCH,
      {
        pass: `PASS branch ${EXPECTED_SECTIONED_BRANCH}`,
        fail: `Branch must be ${EXPECTED_SECTIONED_BRANCH}; found ${branch.stdout.trim() || "unknown"}`,
      },
    ),
  );

  const nodeOnPath = runCapture(
    runner,
    "node",
    ["-p", "JSON.stringify({execPath: process.execPath, version: process.versions.node})"],
    { cwd, env, label: "Node resolved from PATH" },
  );
  checks.push(checkNodeOnPath(nodeOnPath, cwd));

  checks.push(
    checkResult("ANTHROPIC_API_KEY", hasSecret(env.ANTHROPIC_API_KEY), {
      pass: `PASS ANTHROPIC_API_KEY present via ${env.__SAFE_METHOD_ANTHROPIC_KEY_SOURCE}`,
      fail: "ANTHROPIC_API_KEY must be present in shell env or .env before live smoke.",
    }),
  );

  checks.push(
    checkResult(
      "SAFE_METHOD_RUN_ANTHROPIC_GENERATION",
      env.SAFE_METHOD_RUN_ANTHROPIC_GENERATION === "1",
      {
        pass: "PASS SAFE_METHOD_RUN_ANTHROPIC_GENERATION=1",
        fail: "SAFE_METHOD_RUN_ANTHROPIC_GENERATION must be set to 1 before live smoke.",
      },
    ),
  );

  for (const diffCheck of KNOWLEDGE_DIFF_PLAN) {
    const diff = runCapture(runner, "git", diffCheck.args, { cwd, env, label: diffCheck.label });
    checks.push(
      checkResult(diffCheck.label, diff.status === 0 && diff.stdout.trim() === "", {
        pass: `PASS no ${diffCheck.label}`,
        fail: `${diffCheck.label} must be empty; found ${diff.stdout.trim() || "command failed"}`,
      }),
    );
  }

  const failures = checks.filter((check) => check.status === "fail");
  return {
    status: failures.length === 0 ? "pass" : "fail",
    cwd,
    env_summary: buildEnvSummary(env),
    checks,
    failures,
  };
}

export function buildEffectiveEnv(options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const baseEnv = { ...(options.env ?? process.env) };
  const envFileCandidates = options.envFileCandidates ?? ENV_FILE_CANDIDATES;
  const readEnvFile = options.readEnvFile ?? readEnvFileFromDisk;
  const envFromFiles = {};
  const envSources = {};

  for (const fileName of envFileCandidates) {
    const content = readEnvFile(cwd, fileName);
    if (content === null) continue;
    for (const [key, value] of Object.entries(parseEnvFile(content))) {
      if (envFromFiles[key] === undefined) {
        envFromFiles[key] = value;
        envSources[key] = fileName;
      }
    }
  }

  const merged = { ...envFromFiles, ...baseEnv };
  if (hasSecret(baseEnv.ANTHROPIC_API_KEY)) {
    merged.__SAFE_METHOD_ANTHROPIC_KEY_SOURCE = "shell env";
  } else if (hasSecret(envFromFiles.ANTHROPIC_API_KEY)) {
    merged.__SAFE_METHOD_ANTHROPIC_KEY_SOURCE = envSources.ANTHROPIC_API_KEY;
  } else {
    merged.__SAFE_METHOD_ANTHROPIC_KEY_SOURCE = "not found";
  }

  return merged;
}

export function parseEnvFile(content) {
  const result = {};
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    result[key] = unquoteEnvValue(rawValue.trim());
  }
  return result;
}

export function printPreflightReport(report, options = {}) {
  for (const check of report.checks) {
    const stream = check.status === "pass" ? process.stdout : process.stderr;
    stream.write(`${check.message}\n`);
  }

  if (options.printTaxonomy !== false) {
    console.log(`INFO failure taxonomy: ${FAILURE_TAXONOMY.join("; ")}.`);
  }

  if (options.printWorkerRoles) {
    console.log(`INFO verification worker roles: ${VERIFICATION_WORKER_ROLES.join("; ")}.`);
  }

  if (report.status === "fail") {
    console.error("FAIL Phase 4 sectioned live verification preflight.");
  }
}

function verifyKnowledgeDiffClean({ cwd, env, runner, phase, quiet = false }) {
  const steps = [];
  for (const diffCheck of KNOWLEDGE_DIFF_PLAN) {
    const result = runCapture(runner, "git", diffCheck.args, {
      cwd,
      env,
      label: `${diffCheck.label} ${phase}`,
    });
    steps.push({ label: `${diffCheck.label} ${phase}`, status: result.status });
    if (result.status !== 0 || result.stdout.trim() !== "") {
      if (!quiet) {
        console.error(
          `FAIL ${diffCheck.label} ${phase}: ${result.stdout.trim() || "command failed"}`,
        );
      }
      return { status: "fail", steps };
    }
    if (!quiet) {
      console.log(`PASS no ${diffCheck.label} ${phase}`);
    }
  }
  return { status: "pass", steps };
}

function checkNodeOnPath(nodeResult, cwd) {
  if (nodeResult.status !== 0) {
    return {
      name: "pinned Node PATH",
      status: "fail",
      message: "Node must resolve from PATH before live smoke; command failed.",
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(nodeResult.stdout);
  } catch {
    return {
      name: "pinned Node PATH",
      status: "fail",
      message: "Node PATH check returned unreadable output.",
    };
  }

  const version = parsed.version ?? "";
  const major = Number(String(version).split(".")[0]);
  const execPath = path.resolve(parsed.execPath ?? "");
  const toolsRoot = path.resolve(cwd, ".tools").toLowerCase();
  const usesPinnedTools = execPath.toLowerCase().startsWith(toolsRoot);

  return checkResult("pinned Node PATH", major === 24 && usesPinnedTools, {
    pass: `PASS pinned Node on PATH ${version} (${redactPath(execPath)})`,
    fail: `Pinned Node 24 under .tools must resolve from PATH; found ${version || "unknown"} at ${redactPath(execPath)}`,
  });
}

function checkResult(name, passed, messages) {
  return {
    name,
    status: passed ? "pass" : "fail",
    message: passed ? messages.pass : `FAIL ${messages.fail}`,
  };
}

function buildEnvSummary(env) {
  return {
    anthropic_api_key: hasSecret(env.ANTHROPIC_API_KEY)
      ? `present via ${env.__SAFE_METHOD_ANTHROPIC_KEY_SOURCE}`
      : "not found",
    safe_method_run_anthropic_generation:
      env.SAFE_METHOD_RUN_ANTHROPIC_GENERATION === "1" ? "1" : "not enabled",
  };
}

function runCapture(runner, executable, args, context) {
  const result = runner(executable, args, { ...context, stdio: "pipe" });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runPassthrough(runner, executable, args, context) {
  if (!context.quiet) {
    console.log(`START ${context.label}`);
  }
  const result = runner(executable, args, { ...context, stdio: "inherit" });
  if ((result.status ?? 1) === 0 && !context.quiet) {
    console.log(`PASS ${context.label}`);
  }
  return { status: result.status ?? 1 };
}

function runCommand(executable, args, options = {}) {
  return spawnSync(executable, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
    shell: process.platform === "win32" && executable.endsWith(".cmd"),
  });
}

function npmRun(context, scriptName) {
  return {
    executable: context.npmExecutable,
    args: ["run", scriptName],
  };
}

function npmExecutable() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function readEnvFileFromDisk(cwd, fileName) {
  const filePath = path.resolve(cwd, fileName);
  if (!existsSync(filePath)) {
    return null;
  }
  return readFileSync(filePath, "utf8");
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function hasSecret(value) {
  return typeof value === "string" && value.trim() !== "";
}

function redactPath(value) {
  if (!value) {
    return "unknown";
  }
  const parts = value.split(/[\\/]+/u);
  return parts.slice(-3).join(path.sep);
}

function parseArgs(argv) {
  return {
    runLocalGates: argv.includes("--run-local-gates"),
    runLive: argv.includes("--run-live"),
    printWorkerRoles: argv.includes("--print-worker-roles"),
    printTaxonomy: !argv.includes("--no-taxonomy"),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runSectionedLiveVerification(parseArgs(process.argv.slice(2)));
  process.exit(result.exitCode);
}
