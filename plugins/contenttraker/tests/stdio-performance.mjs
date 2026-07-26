import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(pluginRoot, "dist", "server.mjs");
const sampleCount = Number(process.env.CONTENTTRAKER_STDIO_PERFORMANCE_SAMPLES ?? "9");
const discoveryBudgetMs = Number(process.env.CONTENTTRAKER_STDIO_DISCOVERY_BUDGET_MS ?? "2500");
const firstCallBudgetMs = Number(process.env.CONTENTTRAKER_STDIO_FIRST_CALL_BUDGET_MS ?? "3000");

assert.equal(Number.isInteger(sampleCount) && sampleCount >= 5, true);
assert.equal(Number.isFinite(discoveryBudgetMs) && discoveryBudgetMs > 0, true);
assert.equal(Number.isFinite(firstCallBudgetMs) && firstCallBudgetMs > 0, true);

const samples = [];
for (let index = 0; index < sampleCount; index += 1) {
  samples.push(await measureColdStart());
}

const discoveryDurations = samples.map((sample) => sample.discoveryMs);
const firstCallDurations = samples.map((sample) => sample.firstCallMs);
const result = {
  status: "ready",
  transport: "stdio",
  sampleCount,
  discovery: summarize(discoveryDurations, discoveryBudgetMs),
  firstCall: summarize(firstCallDurations, firstCallBudgetMs),
  measuredAtUtc: new Date().toISOString(),
  platform: process.platform,
  architecture: process.arch,
  nodeVersion: process.version,
};

assert.equal(
  result.discovery.p95Ms <= discoveryBudgetMs,
  true,
  `stdio initialize + tools/list p95 ${result.discovery.p95Ms}ms exceeded ${discoveryBudgetMs}ms`,
);
assert.equal(
  result.firstCall.p95Ms <= firstCallBudgetMs,
  true,
  `stdio first local diagnostic p95 ${result.firstCall.p95Ms}ms exceeded ${firstCallBudgetMs}ms`,
);

console.log(JSON.stringify(result));

function measureColdStart() {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, [serverPath], {
      cwd: pluginRoot,
      env: cleanEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdoutBuffer = "";
    let stderr = "";
    let discoveryMs;
    let firstCallMs;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, Math.max(firstCallBudgetMs * 2, 10_000));

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      for (;;) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.id === 2) {
          discoveryMs = performance.now() - started;
          assert.match(message.result.tools[0].outputSchema.type, /object/);
        }
        if (message.id === 3) {
          firstCallMs = performance.now() - started;
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timeout);
      try {
        assert.equal(timedOut, false, "stdio performance sample timed out");
        assert.equal(status, 0, stderr || `adapter exited with signal ${signal ?? "unknown"}`);
        assert.equal(stderr, "");
        assert.equal(typeof discoveryMs, "number");
        assert.equal(typeof firstCallMs, "number");
        resolve({
          discoveryMs: round(discoveryMs),
          firstCallMs: round(firstCallMs),
        });
      } catch (error) {
        reject(error);
      }
    });

    child.stdin.end(`${[
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "contenttraker-stdio-performance", version: "1.0.0" },
        },
      },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "inspect_runtime_capabilities", arguments: {} },
      },
    ].map((request) => JSON.stringify(request)).join("\n")}\n`);
  });
}

function summarize(values, budgetMs) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    minMs: sorted[0],
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.at(-1),
    budgetMs,
    samplesMs: values,
  };
}

function percentile(sorted, percentileValue) {
  return sorted[Math.ceil(sorted.length * percentileValue) - 1];
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function cleanEnvironment() {
  const env = {
    ...process.env,
    CONTENTTRAKER_ENVIRONMENT: "staging",
    CONTENTTRAKER_RUNTIME_PROFILE: "headless",
    CONTENTTRAKER_AUTH_MODE: "delegated",
    CONTENTTRAKER_BROWSER_MODE: "manual",
    CONTENTTRAKER_CREDENTIAL_STORE: "memory",
    CONTENTTRAKER_CREDENTIAL_PROFILE: "stdio-performance",
    CONTENTTRAKER_REQUIRED_USER_EMAIL: "stdio-performance@example.invalid",
    CONTENTTRAKER_REQUIRE_IDENTITY_POLICY: "true",
  };
  for (const key of Object.keys(env)) {
    if (
      /CONTENTTRAKER_.*(?:ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET)/u.test(key)
      || key === "CONTENTTRAKER_INTERNAL_TEST_ADAPTER"
    ) {
      delete env[key];
    }
  }
  return env;
}
