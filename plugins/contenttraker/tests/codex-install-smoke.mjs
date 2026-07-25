import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(pluginRoot, "../..");
const packageDocument = readJson(path.join(pluginRoot, "package.json"));
const expectedToolNames = [
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
];
const expectedCodexVersion = "0.146.0-alpha.3.1";
assert.equal(packageDocument.devDependencies?.["@openai/codex"], expectedCodexVersion);
const codexLauncher = path.join(pluginRoot, "node_modules", "@openai", "codex", "bin", "codex.js");
assert.equal(fs.existsSync(codexLauncher), true, "Run npm ci before the Codex installation smoke test.");
const marketplaceName = process.env.CONTENTTRAKER_CODEX_SMOKE_MARKETPLACE?.trim() || "contenttraker";
assert.match(marketplaceName, /^[a-z0-9][a-z0-9-]{0,63}$/u);
const pluginId = `contenttraker@${marketplaceName}`;
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "contenttraker-codex-install-"));
const extractedRoot = path.join(smokeRoot, "marketplace");
const isolatedCodexHome = path.join(smokeRoot, "codex-home");
const codexEnvironment = {
  ...process.env,
  CODEX_HOME: isolatedCodexHome,
};
let pluginInstalled = false;
let marketplaceInstalled = false;

try {
  fs.mkdirSync(isolatedCodexHome, { recursive: true });
  createExtractedMarketplace(extractedRoot);

  const version = runCodex(["--version"]);
  assert.equal(version.stdout.trim(), `codex-cli ${expectedCodexVersion}`);

  const baseline = parseJsonCommand(runCodex(["plugin", "list", "--json"]), "baseline plugin list");
  assert.deepEqual(baseline.installed, []);

  const marketplace = parseJsonCommand(
    runCodex(["plugin", "marketplace", "add", extractedRoot, "--json"]),
    "marketplace add",
  );
  assert.equal(marketplace.marketplaceName, marketplaceName);
  marketplaceInstalled = true;

  const installation = parseJsonCommand(
    runCodex(["plugin", "add", pluginId, "--json"]),
    "plugin add",
  );
  assert.equal(installation.pluginId, pluginId);
  assert.equal(installation.version, packageDocument.version);
  assert.equal(typeof installation.installedPath, "string");
  pluginInstalled = true;

  const listing = parseJsonCommand(runCodex(["plugin", "list", "--json"]), "plugin list");
  const installed = listing.installed.filter((plugin) => plugin.marketplaceName === marketplaceName);
  assert.equal(installed.length, 1);
  assert.equal(installed[0].pluginId, pluginId);
  assert.equal(installed[0].version, packageDocument.version);
  assert.equal(installed[0].installed, true);
  assert.equal(installed[0].enabled, true);

  const installedRoot = path.resolve(installation.installedPath);
  assert.equal(
    isDescendantPath(isolatedCodexHome, installedRoot),
    true,
    `Codex installed outside the isolated smoke-test home: ${installedRoot}`,
  );
  assert.equal(
    containsDirectoryNamed(installedRoot, "node_modules"),
    false,
    "Codex installed node_modules even though the reviewed marketplace artifact excludes it.",
  );
  const mcpDocument = readJson(path.join(installedRoot, ".mcp.json"));
  const adapter = mcpDocument.mcpServers?.["contenttraker-codex-adapter"];
  assert.deepEqual(adapter, {
    cwd: ".",
    command: "node",
    args: ["./dist/server.mjs"],
    env: { CONTENTTRAKER_ENVIRONMENT: "staging" },
  });

  const responses = await runConfiguredAdapter(adapter, installedRoot);
  assert.equal(responses[0].result.serverInfo.name, packageDocument.name);
  assert.equal(responses[0].result.serverInfo.version, packageDocument.version);
  assert.deepEqual(
    responses[1].result.tools.map((tool) => tool.name).sort(),
    [...expectedToolNames].sort(),
  );
  const runtime = responses[2].result.structuredContent;
  assert.equal(typeof runtime, "object");
  assertRuntimeStatus(runtime);

  console.log(
    `Codex installed ${pluginId} ${packageDocument.version} and exposed ${expectedToolNames.length} adapter tools.`,
  );
} finally {
  if (pluginInstalled) {
    runCodex(["plugin", "remove", pluginId, "--json"], true);
  }
  if (marketplaceInstalled) {
    runCodex(["plugin", "marketplace", "remove", marketplaceName, "--json"], true);
  }
  fs.rmSync(smokeRoot, { recursive: true, force: true });
}

function createExtractedMarketplace(destinationRoot) {
  const marketplaceSource = path.join(repositoryRoot, ".agents", "plugins", "marketplace.json");
  const marketplaceDestination = path.join(destinationRoot, ".agents", "plugins", "marketplace.json");
  fs.mkdirSync(path.dirname(marketplaceDestination), { recursive: true });
  fs.copyFileSync(marketplaceSource, marketplaceDestination);
  if (marketplaceName !== "contenttraker") {
    const marketplace = readJson(marketplaceDestination);
    assert.equal(marketplace.name, "contenttraker");
    marketplace.name = marketplaceName;
    fs.writeFileSync(marketplaceDestination, `${JSON.stringify(marketplace, null, 2)}\n`);
  }

  const pluginDestination = path.join(destinationRoot, "plugins", "contenttraker");
  fs.cpSync(pluginRoot, pluginDestination, {
    recursive: true,
    filter: (sourcePath) => !path.relative(pluginRoot, sourcePath).split(path.sep).includes("node_modules"),
  });
  assert.equal(containsDirectoryNamed(destinationRoot, "node_modules"), false);
}

function runCodex(args, ignoreFailure = false) {
  const result = spawnSync(process.execPath, [codexLauncher, ...args], {
    cwd: repositoryRoot,
    env: codexEnvironment,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (!ignoreFailure) {
    assert.equal(
      result.status,
      0,
      result.error?.message
        || result.stderr
        || result.stdout
        || `Codex command failed with signal ${result.signal ?? "unknown"}.`,
    );
    assert.doesNotMatch(
      result.stderr,
      /ignoring interface\.defaultPrompt|maximum of 3 prompts/iu,
      "Codex rejected part of the ContentTraker plugin manifest.",
    );
  }
  return result;
}

function parseJsonCommand(result, operation) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    assert.fail(`${operation} did not return JSON:\n${result.stdout}\n${result.stderr}`);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function containsDirectoryNamed(root, expectedName) {
  if (!fs.existsSync(root)) {
    return false;
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name === expectedName || containsDirectoryNamed(path.join(root, entry.name), expectedName)) {
      return true;
    }
  }
  return false;
}

function isDescendantPath(parentPath, childPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function runConfiguredAdapter(adapter, installedRoot) {
  const requests = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "contenttraker-codex-install-smoke", version: "1.0.0" },
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
      cwd: path.resolve(installedRoot, adapter.cwd),
      env: { ...process.env, ...adapter.env },
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
          stderr || `Installed adapter exited with signal ${signal ?? "unknown"}.`,
        );
        assert.equal(stderr, "");
        const responses = stdout.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
        assert.equal(responses.length, 3);
        resolve(responses);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(`${requests.map((request) => JSON.stringify(request)).join("\n")}\n`);
  });
}

function assertRuntimeStatus(runtime) {
  const expected = process.env.CONTENTTRAKER_EXPECT_RUNTIME_STATUS?.trim();
  if (expected) {
    assert.equal(runtime.status, expected);
    return;
  }
  assert.equal(["ready", "blocked"].includes(runtime.status), true);
}
