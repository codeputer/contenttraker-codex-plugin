import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = path.join(pluginRoot, "dist", "server.mjs");
const packageDocument = readJson(path.join(pluginRoot, "package.json"));
const pluginDocument = readJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"));
const mcpDocument = readJson(path.join(pluginRoot, ".mcp.json"));
const marketplaceDocument = readJson(path.resolve(pluginRoot, "../../.agents/plugins/marketplace.json"));
const sourceMetadata = fs.readFileSync(path.join(pluginRoot, "src", "plugin-metadata.ts"), "utf8");

assert.equal(pluginDocument.version, packageDocument.version);
assert.equal(
  marketplaceDocument.plugins.find((plugin) => plugin.name === packageDocument.name)?.version,
  packageDocument.version,
);
assert.match(
  sourceMetadata,
  new RegExp(`CONTENTTRAKER_PLUGIN_VERSION\\s*=\\s*"${packageDocument.version.replaceAll(".", "\\.")}"`),
);
assert.deepEqual(mcpDocument.mcpServers["contenttraker-codex-adapter"], {
  cwd: ".",
  command: "node",
  args: ["./dist/server.mjs"],
  env: { CONTENTTRAKER_ENVIRONMENT: "staging" },
});
assert.deepEqual(packageDocument.dependencies ?? {}, {});
for (const relativePath of [
  path.join("skills", "contenttraker-select", "SKILL.md"),
  path.join("skills", "contenttraker-reset", "SKILL.md"),
]) {
  const skillPath = path.join(pluginRoot, relativePath);
  assert.equal(
    fs.existsSync(skillPath) && fs.statSync(skillPath).isFile(),
    true,
    `Packaged plugin is missing skill ${relativePath}.`,
  );
}

build();
const firstHash = sha256(bundlePath);
build();
const secondHash = sha256(bundlePath);
assert.equal(secondHash, firstHash, "The production bundle is not deterministic.");

const bundle = fs.readFileSync(bundlePath, "utf8");
for (const forbidden of [
  /@napi-rs\/keyring/iu,
  /@hono\/node-server/iu,
  /serve-static|serveStatic/iu,
  /CONTENTTRAKER_INTERNAL_TEST_ADAPTER/u,
  /CONTENTTRAKER_(?:STAGING_|PRODUCTION_)?ACCESS_TOKEN/u,
  /opaque-device-secret-never-expose/u,
  /injected-internal-test-provider/u,
]) {
  assert.equal(forbidden.test(bundle), false, `Forbidden production bundle content matched ${forbidden}.`);
}

const tools = await listProductionTools();
for (const expected of [
  "inspect_runtime_capabilities",
  "inspect_contenttraker_oauth_metadata",
  "begin_contenttraker_authorization",
  "begin_contenttraker_login",
  "get_contenttraker_authorization_status",
  "poll_contenttraker_login",
  "get_contenttraker_auth_status",
  "cancel_contenttraker_authorization",
  "forget_contenttraker_credential",
  "logout_contenttraker",
  "get_current_user",
  "list_workspaces",
  "resolve_contenttraker_context",
  "confirm_contenttraker_context",
  "reset_contenttraker_context",
  "probe_contenttraker_api_readiness",
  "inspect_contenttraker_api_contract",
  "list_digital_asset_types",
  "get_digital_asset",
  "search_digital_assets",
  "create_digital_asset",
  "begin_digital_asset_upload",
  "append_digital_asset_upload_chunk",
  "complete_digital_asset_upload",
  "update_digital_asset",
  "set_digital_asset_status",
  "upsert_contenttraker_registry_mapping",
]) {
  assert.equal(tools.some((tool) => tool.name === expected), true, `Production bundle is missing tool ${expected}.`);
}

console.log(`ContentTraker release artifact verified: SHA256 ${secondHash}`);

function build() {
  const npmEntry = process.env.npm_execpath;
  assert.ok(npmEntry, "release-artifact must run through npm so npm_execpath is available.");
  const result = spawnSync(process.execPath, [npmEntry, "run", "build"], {
    cwd: pluginRoot,
    env: process.env,
    stdio: "inherit",
  });
  assert.equal(result.status, 0, `Production bundle build failed with signal ${result.signal ?? "none"}.`);
}

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

async function listProductionTools() {
  const requests = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "contenttraker-release-verifier", version: "1.0.0" },
      },
    },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ];
  const result = await runBundle(requests);
  assert.equal(result.status, 0, result.stderr || `Production bundle exited with signal ${result.signal ?? "unknown"}.`);
  assert.equal(result.stderr, "");
  const responses = result.stdout.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(responses.length, 2);
  assert.equal(responses[0].id, 1);
  assert.equal(responses[1].id, 2);
  assert.equal(Array.isArray(responses[1].result.tools), true);
  return responses[1].result.tools;
}

function runBundle(requests) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, CONTENTTRAKER_ENVIRONMENT: "staging" };
    delete env.CONTENTTRAKER_AUTH_MODE;
    delete env.CONTENTTRAKER_RUNTIME_PROFILE;
    delete env.CONTENTTRAKER_INTERNAL_TEST_ADAPTER;
    const child = spawn(process.execPath, [bundlePath], {
      cwd: pluginRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timeout);
      resolve({ status: timedOut ? null : status, signal, stdout, stderr });
    });
    child.stdin.end(`${requests.map((request) => JSON.stringify(request)).join("\n")}\n`);
  });
}
