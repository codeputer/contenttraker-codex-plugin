import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as createBundleGraph } from "esbuild";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(pluginRoot, "../..");
const bundlePath = path.join(pluginRoot, "dist", "server.mjs");
const packageDocument = readJson(path.join(pluginRoot, "package.json"));
const packageLockDocument = readJson(path.join(pluginRoot, "package-lock.json"));
const pluginDocument = readJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"));
const mcpDocument = readJson(path.join(pluginRoot, ".mcp.json"));
const marketplacePath = path.join(repositoryRoot, ".agents", "plugins", "marketplace.json");
const marketplaceDocument = readJson(marketplacePath);
const sourceMetadata = fs.readFileSync(path.join(pluginRoot, "src", "plugin-metadata.ts"), "utf8");
const marketplacePlugin = marketplaceDocument.plugins.find((plugin) => plugin.name === packageDocument.name);
const packagedSkillPaths = [
  path.join("skills", "contenttraker-mcp", "SKILL.md"),
  path.join("skills", "contenttraker-select", "SKILL.md"),
  path.join("skills", "contenttraker-reset", "SKILL.md"),
];
const bundledPackageLicensePaths = new Map([
  ["@modelcontextprotocol/sdk", path.join("THIRD_PARTY_LICENSES", "modelcontextprotocol-sdk.txt")],
  ["ajv", path.join("THIRD_PARTY_LICENSES", "ajv.txt")],
  ["ajv-formats", path.join("THIRD_PARTY_LICENSES", "ajv-formats.txt")],
  ["fast-deep-equal", path.join("THIRD_PARTY_LICENSES", "fast-deep-equal.txt")],
  ["fast-uri", path.join("THIRD_PARTY_LICENSES", "fast-uri.txt")],
  ["json-schema-traverse", path.join("THIRD_PARTY_LICENSES", "json-schema-traverse.txt")],
  ["zod", path.join("THIRD_PARTY_LICENSES", "zod.txt")],
  ["zod-to-json-schema", path.join("THIRD_PARTY_LICENSES", "zod-to-json-schema.txt")],
]);
const packagedLegalPaths = [
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  ...bundledPackageLicensePaths.values(),
];
const packagedArtifactPaths = [...packagedSkillPaths, ...packagedLegalPaths];
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

assert.equal(pluginDocument.version, packageDocument.version);
assert.ok(
  Array.isArray(pluginDocument.interface?.defaultPrompt)
    && pluginDocument.interface.defaultPrompt.length > 0
    && pluginDocument.interface.defaultPrompt.length <= 3,
  "Codex plugin manifests support between one and three default prompts.",
);
assert.ok(marketplacePlugin, `Marketplace is missing plugin ${packageDocument.name}.`);
assert.equal(marketplacePlugin?.version, packageDocument.version);
assert.deepEqual(marketplacePlugin?.source, {
  source: "local",
  path: "./plugins/contenttraker",
});
assert.equal(
  path.resolve(repositoryRoot, marketplacePlugin.source.path),
  pluginRoot,
  "The marketplace source does not resolve to the packaged ContentTraker plugin.",
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
for (const relativePath of packagedSkillPaths) {
  const skillPath = path.join(pluginRoot, relativePath);
  assert.equal(
    fs.existsSync(skillPath) && fs.statSync(skillPath).isFile(),
    true,
    `Packaged plugin is missing skill ${relativePath}.`,
  );
}
for (const relativePath of packagedLegalPaths) {
  const legalPath = path.join(pluginRoot, relativePath);
  assert.equal(
    fs.existsSync(legalPath) && fs.statSync(legalPath).isFile(),
    true,
    `Packaged plugin is missing legal file ${relativePath}.`,
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

const bundledPackages = await inspectBundledDependencyGraph();
assert.equal(
  bundledPackages.has("@hono/node-server"),
  false,
  "@hono/node-server must remain outside the stdio production bundle.",
);
assert.equal(
  bundledPackages.has("fast-uri"),
  true,
  "The bundle graph must identify the embedded fast-uri dependency so it cannot be skipped by a dev-only audit.",
);
assertPatchedFastUri();
auditBundledDependencies(bundledPackages);
assertBundledPackageLicenses(bundledPackages);

await verifyExtractedMarketplaceArtifact();

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

async function inspectBundledDependencyGraph() {
  const result = await createBundleGraph({
    absWorkingDir: pluginRoot,
    entryPoints: ["src/main.ts"],
    bundle: true,
    minify: true,
    platform: "node",
    format: "esm",
    target: "node18",
    outfile: "dist/server.mjs",
    metafile: true,
    write: false,
  });
  assert.equal(result.outputFiles.length, 1);
  assert.equal(
    Buffer.compare(Buffer.from(result.outputFiles[0].contents), fs.readFileSync(bundlePath)),
    0,
    "The dependency graph build does not byte-match the committed production bundle.",
  );

  return new Set(
    Object.keys(result.metafile.inputs)
      .map(packageNameFromModulePath)
      .filter(Boolean),
  );
}

function packageNameFromModulePath(modulePath) {
  const normalized = modulePath.replaceAll("\\", "/");
  const marker = "node_modules/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) {
    return undefined;
  }

  const parts = normalized.slice(markerIndex + marker.length).split("/");
  return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

function assertPatchedFastUri() {
  const version = packageLockDocument.packages?.["node_modules/fast-uri"]?.version;
  assert.equal(typeof version, "string", "package-lock.json does not resolve fast-uri.");
  assert.equal(
    isVersionAtLeast(version, "3.1.4"),
    true,
    `The embedded fast-uri ${version} is vulnerable; version 3.1.4 or later is required.`,
  );
}

function isVersionAtLeast(actual, minimum) {
  const actualParts = actual.split(".").map(Number);
  const minimumParts = minimum.split(".").map(Number);
  for (let index = 0; index < Math.max(actualParts.length, minimumParts.length); index += 1) {
    const difference = (actualParts[index] ?? 0) - (minimumParts[index] ?? 0);
    if (difference !== 0) {
      return difference > 0;
    }
  }
  return true;
}

function auditBundledDependencies(bundledPackages) {
  const npmEntry = process.env.npm_execpath;
  assert.ok(npmEntry, "release-artifact must run through npm so npm_execpath is available.");
  const result = spawnSync(process.execPath, [npmEntry, "audit", "--json"], {
    cwd: pluginRoot,
    env: process.env,
    encoding: "utf8",
  });
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    assert.fail(result.stderr || result.stdout || "npm audit did not return a JSON report.");
  }
  assert.equal(report.auditReportVersion, 2, report.error?.summary ?? "npm audit did not return a v2 report.");
  assert.equal(typeof report.vulnerabilities, "object");

  const advisories = [];
  for (const packageName of bundledPackages) {
    collectBundledAdvisories(packageName, bundledPackages, report.vulnerabilities, new Set(), advisories);
  }
  const uniqueAdvisories = [...new Map(
    advisories.map((advisory) => [`${advisory.source ?? advisory.url}:${advisory.name}`, advisory]),
  ).values()];
  assert.deepEqual(
    uniqueAdvisories,
    [],
    `npm audit found vulnerabilities in dependencies embedded in dist/server.mjs:\n${JSON.stringify(uniqueAdvisories, null, 2)}`,
  );
}

function assertBundledPackageLicenses(bundledPackages) {
  const notices = fs.readFileSync(path.join(pluginRoot, "THIRD_PARTY_NOTICES.md"), "utf8");
  for (const packageName of bundledPackages) {
    const relativeLicensePath = bundledPackageLicensePaths.get(packageName);
    assert.ok(relativeLicensePath, `No packaged licence mapping exists for bundled package ${packageName}.`);
    assert.equal(
      notices.includes(`\`${packageName}\``),
      true,
      `THIRD_PARTY_NOTICES.md does not identify bundled package ${packageName}.`,
    );
    const licence = fs.readFileSync(path.join(pluginRoot, relativeLicensePath), "utf8").trim();
    assert.ok(licence.length > 100, `Packaged licence ${relativeLicensePath} is unexpectedly empty.`);
  }
}

function collectBundledAdvisories(packageName, bundledPackages, vulnerabilities, visited, advisories) {
  if (visited.has(packageName)) {
    return;
  }
  visited.add(packageName);
  const vulnerability = vulnerabilities[packageName];
  if (!vulnerability) {
    return;
  }

  for (const via of vulnerability.via ?? []) {
    if (typeof via === "object") {
      advisories.push({
        name: via.name,
        severity: via.severity,
        title: via.title,
        url: via.url,
        source: via.source,
      });
    } else if (bundledPackages.has(via)) {
      collectBundledAdvisories(via, bundledPackages, vulnerabilities, visited, advisories);
    }
  }
}

async function verifyExtractedMarketplaceArtifact() {
  const extractedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "contenttraker-marketplace-"));
  try {
    const extractedMarketplacePath = path.join(extractedRoot, ".agents", "plugins", "marketplace.json");
    fs.mkdirSync(path.dirname(extractedMarketplacePath), { recursive: true });
    fs.copyFileSync(marketplacePath, extractedMarketplacePath);

    const extractedMarketplace = readJson(extractedMarketplacePath);
    const extractedPluginEntry = extractedMarketplace.plugins.find(
      (plugin) => plugin.name === packageDocument.name,
    );
    assert.ok(extractedPluginEntry);
    const extractedPluginRoot = path.resolve(extractedRoot, extractedPluginEntry.source.path);
    fs.cpSync(pluginRoot, extractedPluginRoot, {
      recursive: true,
      filter: (sourcePath) => !path.relative(pluginRoot, sourcePath).split(path.sep).includes("node_modules"),
    });
    assert.equal(
      containsDirectoryNamed(extractedRoot, "node_modules"),
      false,
      "The extracted marketplace artifact contains node_modules.",
    );
    for (const relativePath of packagedArtifactPaths) {
      assert.equal(
        fs.existsSync(path.join(extractedPluginRoot, relativePath)),
        true,
        `The extracted marketplace artifact is missing required file ${relativePath}.`,
      );
    }

    const extractedMcpDocument = readJson(path.join(extractedPluginRoot, ".mcp.json"));
    const adapter = extractedMcpDocument.mcpServers["contenttraker-codex-adapter"];
    assert.deepEqual(adapter, mcpDocument.mcpServers["contenttraker-codex-adapter"]);
    const responses = await runConfiguredAdapter(adapter, extractedPluginRoot, productionRequests());

    assert.equal(responses.length, 3);
    assert.equal(responses[0].id, 1);
    assert.equal(responses[0].result.serverInfo.name, packageDocument.name);
    assert.equal(responses[0].result.serverInfo.version, packageDocument.version);
    assert.equal(responses[1].id, 2);
    assert.deepEqual(
      responses[1].result.tools.map((tool) => tool.name).sort(),
      [...expectedToolNames].sort(),
      "The extracted production plugin does not expose exactly the expected 27 tools.",
    );
    assert.equal(responses[2].id, 3);
    assert.equal(responses[2].result.isError ?? false, false);
    const capabilities = responses[2].result.structuredContent;
    assert.equal(typeof capabilities, "object");
    assertRuntimeStatus(capabilities);
    assert.equal(capabilities.contentTrakerEnvironment.name, "staging");
  } finally {
    fs.rmSync(extractedRoot, { recursive: true, force: true });
  }
}

function assertRuntimeStatus(runtime) {
  const expected = process.env.CONTENTTRAKER_EXPECT_RUNTIME_STATUS?.trim();
  if (expected) {
    assert.equal(runtime.status, expected);
    return;
  }
  assert.equal(["ready", "blocked"].includes(runtime.status), true);
}

function containsDirectoryNamed(root, expectedName) {
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

function productionRequests() {
  return [
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
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "inspect_runtime_capabilities", arguments: {} },
    },
  ];
}

function runConfiguredAdapter(adapter, extractedPluginRoot, requests) {
  assert.equal(typeof adapter.command, "string");
  assert.equal(Array.isArray(adapter.args), true);
  const adapterWorkingDirectory = path.resolve(extractedPluginRoot, adapter.cwd);
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...adapter.env };
    delete env.CONTENTTRAKER_AUTH_MODE;
    delete env.CONTENTTRAKER_RUNTIME_PROFILE;
    delete env.CONTENTTRAKER_INTERNAL_TEST_ADAPTER;
    const child = spawn(adapter.command, adapter.args, {
      cwd: adapterWorkingDirectory,
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
      try {
        const effectiveStatus = timedOut ? null : status;
        assert.equal(
          effectiveStatus,
          0,
          stderr || `Extracted adapter exited with signal ${signal ?? "unknown"}.`,
        );
        assert.equal(stderr, "");
        resolve(stdout.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(`${requests.map((request) => JSON.stringify(request)).join("\n")}\n`);
  });
}
