import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  buildEffectiveEnv,
  evaluateSectionedLivePreflight,
  parseEnvFile,
  runSectionedLiveVerification,
} from "../scripts/verify-sectioned-live-preflight.mjs";

const REPO_ROOT = path.resolve(".");
const GOOD_ENV = {
  PATH: process.env.PATH ?? "",
  ANTHROPIC_API_KEY: "test-provider-key-redacted",
  SAFE_METHOD_RUN_ANTHROPIC_GENERATION: "1",
};

test("sectioned live preflight parses .env values without leaking secrets", () => {
  const parsed = parseEnvFile(
    [
      "# local live smoke credentials",
      "ANTHROPIC_API_KEY='test-provider-key-redacted'",
      "SAFE_METHOD_RUN_ANTHROPIC_GENERATION=1",
    ].join("\n"),
  );

  assert.equal(parsed.ANTHROPIC_API_KEY, "test-provider-key-redacted");
  assert.equal(parsed.SAFE_METHOD_RUN_ANTHROPIC_GENERATION, "1");

  const env = buildEffectiveEnv({
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH ?? "" },
    readEnvFile: (_cwd, fileName) =>
      fileName === ".env"
        ? "ANTHROPIC_API_KEY=test-provider-key-redacted\nSAFE_METHOD_RUN_ANTHROPIC_GENERATION=1\n"
        : null,
  });

  const report = evaluateSectionedLivePreflight({
    cwd: REPO_ROOT,
    env,
    runner: successfulPreflightRunner(),
    readEnvFile: () => null,
  });

  assert.equal(report.status, "pass");
  assert.equal(Object.hasOwn(report, "env"), false);
  assert.equal(JSON.stringify(report).includes("test-provider-key-redacted"), false);
  assert.equal(
    report.checks.some((check) => check.message.includes("test-provider-key-redacted")),
    false,
  );
  assert.equal(
    report.checks.some((check) => check.message.includes("ANTHROPIC_API_KEY present")),
    true,
  );
});

test("missing ANTHROPIC_API_KEY blocks sectioned live smoke preflight", () => {
  const report = evaluateSectionedLivePreflight({
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      SAFE_METHOD_RUN_ANTHROPIC_GENERATION: "1",
    },
    envFileCandidates: [],
    runner: successfulPreflightRunner(),
  });

  assert.equal(report.status, "fail");
  assert.equal(
    report.failures.some((failure) => failure.message.includes("ANTHROPIC_API_KEY")),
    true,
  );
});

test("missing live-generation opt-in blocks sectioned live smoke preflight", () => {
  const report = evaluateSectionedLivePreflight({
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      ANTHROPIC_API_KEY: "test-provider-key-redacted",
    },
    envFileCandidates: [],
    runner: successfulPreflightRunner(),
  });

  assert.equal(report.status, "fail");
  assert.equal(
    report.failures.some((failure) =>
      failure.message.includes("SAFE_METHOD_RUN_ANTHROPIC_GENERATION"),
    ),
    true,
  );
});

test("wrong branch blocks sectioned live smoke preflight", () => {
  const report = evaluateSectionedLivePreflight({
    cwd: REPO_ROOT,
    env: GOOD_ENV,
    envFileCandidates: [],
    runner: successfulPreflightRunner({ branch: "main" }),
  });

  assert.equal(report.status, "fail");
  assert.equal(
    report.failures.some((failure) => failure.name === "branch"),
    true,
  );
});

test("unpinned Node blocks sectioned live smoke preflight", () => {
  const report = evaluateSectionedLivePreflight({
    cwd: REPO_ROOT,
    env: GOOD_ENV,
    envFileCandidates: [],
    runner: successfulPreflightRunner({
      nodeExecPath: path.join("C:", "Program Files", "nodejs", "node.exe"),
      nodeVersion: "24.18.0",
    }),
  });

  assert.equal(report.status, "fail");
  assert.equal(
    report.failures.some((failure) => failure.name === "pinned Node PATH"),
    true,
  );
});

test("dirty knowledge diff blocks sectioned live smoke preflight", () => {
  const report = evaluateSectionedLivePreflight({
    cwd: REPO_ROOT,
    env: GOOD_ENV,
    envFileCandidates: [],
    runner: successfulPreflightRunner({ knowledgeDiff: "knowledge/control_library.json\n" }),
  });

  assert.equal(report.status, "fail");
  assert.equal(
    report.failures.some((failure) => failure.message.includes("knowledge/control_library.json")),
    true,
  );
});

test("staged sectioned live verification runs local gates before live smoke", () => {
  const runner = successfulPreflightRunner();
  const result = runSectionedLiveVerification({
    cwd: REPO_ROOT,
    env: GOOD_ENV,
    envFileCandidates: [],
    runner,
    runLocalGates: true,
    runLive: true,
    printTaxonomy: false,
    quiet: true,
  });

  assert.equal(result.status, "pass");
  assert.equal(JSON.stringify(result).includes(GOOD_ENV.ANTHROPIC_API_KEY), false);

  const labels = runner.calls.map((call) => call.label);
  const liveIndex = labels.indexOf("live sectioned API smoke");
  assert.ok(liveIndex > -1, "live smoke should run");

  for (const label of [
    "unit and fixture gate",
    "deterministic generation gate",
    "sectioned generation gate",
    "offline deterministic repo gate",
    "phase evidence gate",
    "knowledge working tree diff after local gates",
    "knowledge staged diff after local gates",
  ]) {
    assert.ok(labels.indexOf(label) > -1, `${label} should run`);
    assert.ok(labels.indexOf(label) < liveIndex, `${label} should run before live smoke`);
  }

  assert.ok(labels.includes("knowledge working tree diff"));
  assert.ok(labels.includes("knowledge working tree diff after verification"));
});

test("staged sectioned live verification does not run live smoke when a local gate fails", () => {
  const runner = successfulPreflightRunner({ failLabels: new Set(["sectioned generation gate"]) });
  const result = runSectionedLiveVerification({
    cwd: REPO_ROOT,
    env: GOOD_ENV,
    envFileCandidates: [],
    runner,
    runLocalGates: true,
    runLive: true,
    printTaxonomy: false,
    quiet: true,
  });

  assert.equal(result.status, "fail");
  assert.equal(
    runner.calls.some((call) => call.label === "live sectioned API smoke"),
    false,
  );
});

function successfulPreflightRunner(options = {}) {
  const calls = [];
  const failLabels = options.failLabels ?? new Set();
  const branch = options.branch ?? "codex/phase-4-sectioned-generation";
  const knowledgeDiff = options.knowledgeDiff ?? "";
  const nodeExecPath =
    options.nodeExecPath ?? path.join(REPO_ROOT, ".tools", "node-v24.18.0-win-x64", "node.exe");
  const nodeVersion = options.nodeVersion ?? "24.18.0";

  const runner = (_executable, _args, context = {}) => {
    calls.push({ label: context.label, stdio: context.stdio });

    if (failLabels.has(context.label)) {
      return { status: 1, stdout: "", stderr: "forced failure" };
    }

    if (context.label === "current git branch") {
      return { status: 0, stdout: `${branch}\n`, stderr: "" };
    }

    if (context.label === "Node resolved from PATH") {
      return {
        status: 0,
        stdout: `${JSON.stringify({
          execPath: nodeExecPath,
          version: nodeVersion,
        })}\n`,
        stderr: "",
      };
    }

    if (context.label?.includes("knowledge")) {
      return { status: 0, stdout: knowledgeDiff, stderr: "" };
    }

    return { status: 0, stdout: "", stderr: "" };
  };

  runner.calls = calls;
  return runner;
}
