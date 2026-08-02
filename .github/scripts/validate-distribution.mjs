import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pluginRoot = path.join(repositoryRoot, "plugins", "contenttraker");
const provenance = readJson(path.join(repositoryRoot, "DISTRIBUTION_PROVENANCE.json"));
const marketplace = readJson(path.join(repositoryRoot, ".agents", "plugins", "marketplace.json"));
const plugin = readJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"));
const mcp = readJson(path.join(pluginRoot, ".mcp.json"));
const packageDocument = readJson(path.join(pluginRoot, "package.json"));

const expectedToolNames = [
  "append_digital_asset_upload_chunk",
  "begin_contenttraker_authorization",
  "begin_contenttraker_login",
  "begin_digital_asset_upload",
  "cancel_contenttraker_authorization",
  "complete_digital_asset_upload",
  "confirm_contenttraker_context",
  "create_digital_asset",
  "forget_contenttraker_credential",
  "get_contenttraker_auth_status",
  "get_contenttraker_authorization_status",
  "get_current_user",
  "get_digital_asset",
  "inspect_contenttraker_api_contract",
  "inspect_contenttraker_oauth_metadata",
  "inspect_runtime_capabilities",
  "list_digital_asset_types",
  "list_workspaces",
  "logout_contenttraker",
  "poll_contenttraker_login",
  "probe_contenttraker_api_readiness",
  "reset_contenttraker_context",
  "resolve_contenttraker_context",
  "search_digital_assets",
  "set_digital_asset_status",
  "update_digital_asset",
  "upsert_contenttraker_registry_mapping",
].sort();

const tracked = trackedFiles();
const forbiddenTracked = tracked.filter((file) =>
  /^plugins\/contenttraker\/(?:src|tests|node_modules|\.cache)\//u.test(file)
  || /^plugins\/contenttraker\/(?:package-lock\.json|tsconfig(?:\.tests)?\.json)$/u.test(file)
  || /(?:^|\/)\.env(?:\.|$)|\.log$/u.test(file),
);
assert.deepEqual(forbiddenTracked, [], `Non-distribution files are tracked:\n${forbiddenTracked.join("\n")}`);

for (const required of [
  ".agents/plugins/marketplace.json",
  "AGENTS.md",
  "DISTRIBUTION_PROVENANCE.json",
  "plugins/contenttraker/.codex-plugin/plugin.json",
  "plugins/contenttraker/.mcp.json",
  "plugins/contenttraker/dist/server.mjs",
  "plugins/contenttraker/package.json",
  "plugins/contenttraker/skills/contenttraker-mcp/SKILL.md",
  "plugins/contenttraker/skills/contenttraker-reset/SKILL.md",
  "plugins/contenttraker/skills/contenttraker-select/SKILL.md",
  "plugins/contenttraker/LICENSE",
  "plugins/contenttraker/THIRD_PARTY_NOTICES.md",
]) {
  assert.ok(tracked.includes(required), `Required distribution file is not tracked: ${required}`);
}

assert.equal(provenance.distributionRepository, "PhxBiz/contenttraker-codex-plugin");
assert.equal(provenance.authoritativeSource.repository, "PhxBiz/ArticleMngrSLN");
assert.equal(provenance.authoritativeSource.branch, "development");
assert.equal(provenance.authoritativeSource.componentPath, "components/contenttraker-codex-plugin");
assert.equal(provenance.release.version, packageDocument.version);
assert.equal(provenance.release.tag, `v${packageDocument.version}`);
assert.equal(
  sha256(path.join(repositoryRoot, provenance.release.runtimeArtifact.path)),
  provenance.release.runtimeArtifact.sha256,
  "The packaged runtime differs from the reviewed release artifact.",
);

const marketplacePlugin = marketplace.plugins.find((entry) => entry.name === packageDocument.name);
assert.ok(marketplacePlugin, `Marketplace is missing ${packageDocument.name}.`);
assert.equal(marketplacePlugin.version, packageDocument.version);
assert.deepEqual(marketplacePlugin.source, {
  source: "local",
  path: "./plugins/contenttraker",
});
assert.equal(plugin.version, packageDocument.version);
assert.equal(plugin.homepage, "https://github.com/PhxBiz/contenttraker-codex-plugin");
assert.equal(plugin.repository, "https://github.com/PhxBiz/contenttraker-codex-plugin");
assert.equal(packageDocument.private, true);
assert.equal(packageDocument.scripts, undefined);
assert.equal(packageDocument.dependencies, undefined);
assert.equal(packageDocument.devDependencies, undefined);

const adapter = mcp.mcpServers?.["contenttraker-codex-adapter"];
assert.deepEqual(adapter?.args, ["./dist/server.mjs"]);
assert.equal(adapter?.command, "node");
const responses = await runAdapter(adapter);
assert.equal(responses[0].result.serverInfo.name, packageDocument.name);
assert.equal(responses[0].result.serverInfo.version, packageDocument.version);
assert.deepEqual(
  responses[1].result.tools.map((tool) => tool.name).sort(),
  expectedToolNames,
);
assert.equal(
  responses[1].result.tools.every((tool) => tool.outputSchema?.type === "object"),
  true,
  "Every tool must retain its structured output schema.",
);
assert.deepEqual(responses[2].result.structuredContent.adapterIdentity, {
  pluginId: "contenttraker@contenttraker",
  pluginName: "contenttraker",
  pluginVersion: packageDocument.version,
  mcpRegistrationKey: "contenttraker-codex-adapter",
  hostBoundary: "local-codex-plugin",
  codexTransport: "stdio",
  upstreamInterface: "contenttraker-https-json-api",
  bundlesRemoteAppMapping: false,
});

console.log(
  `ContentTraker ${packageDocument.version} distribution verified: `
  + `${provenance.release.runtimeArtifact.sha256}; ${expectedToolNames.length} tools.`,
);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
}

function trackedFiles() {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr || "Unable to inventory tracked distribution files.");
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .filter((file) => fs.existsSync(path.join(repositoryRoot, file)));
}

function runAdapter(adapter) {
  const requests = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "contenttraker-distribution-validator", version: "1.0.0" },
      },
    },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "inspect_runtime_capabilities", arguments: {} },
    },
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(adapter.command, adapter.args, {
      cwd: path.resolve(pluginRoot, adapter.cwd),
      env: {
        ...process.env,
        ...adapter.env,
        CONTENTTRAKER_AUTH_MODE: "workload",
        CONTENTTRAKER_CREDENTIAL_PROFILE: "distribution-validation",
        CONTENTTRAKER_REQUIRED_USER_EMAIL: "distribution-validation@example.invalid",
      },
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
      try {
        assert.equal(
          timedOut ? null : status,
          0,
          stderr || `Adapter exited with signal ${signal ?? "unknown"}.`,
        );
        assert.equal(stderr, "");
        const responses = stdout.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
        assert.equal(responses.length, requests.length);
        resolve(responses);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(`${requests.map((request) => JSON.stringify(request)).join("\n")}\n`);
  });
}
