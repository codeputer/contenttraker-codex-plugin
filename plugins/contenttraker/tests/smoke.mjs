import assert from "node:assert/strict";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generate as generateSelfSignedCertificate } from "selfsigned";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(__dirname, "../dist/server.mjs");
const repositoryRoot = path.resolve(__dirname, "../../..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "contenttraker-codex-"));
const testCertificate = await generateSelfSignedCertificate(
  [{ name: "commonName", value: "127.0.0.1" }],
  {
    algorithm: "sha256",
    keySize: 2048,
    extensions: [
      { name: "basicConstraints", cA: true },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true, keyCertSign: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] },
    ],
  },
);
const trustedCertificatePath = path.join(tempRoot, "test-ca.pem");
fs.writeFileSync(trustedCertificatePath, testCertificate.cert, "utf8");
const seenAuthorizationHeaders = [];
const seenWriteBodies = [];
const seenLifecycleBodies = [];
const seenUpdateBodies = [];
const seenUploadBodies = [];

const apiServer = https.createServer({ key: testCertificate.private, cert: testCertificate.cert }, (request, response) => {
  seenAuthorizationHeaders.push(request.headers.authorization);

  response.setHeader("content-type", "application/json");
  response.setHeader("connection", "close");

  if (request.url === "/me") {
    response.end(JSON.stringify({ appUserId: "user-1", email: "operator@example.org", name: "Test Operator", role: "Editor" }));
    return;
  }

  if (request.url === "/workspaces") {
    response.end(JSON.stringify({
      workspaces: [
        {
          id: "workspace-staging",
          name: "ContentTraker Staging",
        },
      ],
    }));
    return;
  }

  if (request.url === "/workspaces/workspace-staging/projects") {
    response.end(JSON.stringify({
      projects: [
        {
          id: "project-staging",
          name: "Sample Project Staging",
        },
      ],
    }));
    return;
  }

  if (request.method === "GET" && request.url === "/workspaces/workspace-staging/digital-assets/types") {
    response.end(JSON.stringify({
      workspaceId: "workspace-staging",
      workspaceKey: "workspace-staging",
      digitalAssetTypes: [{ digitalAssetType: "Report", displayName: "Report" }],
      correlationId: "types-correlation",
    }));
    return;
  }

  if (request.method === "GET" && request.url === "/workspaces/workspace-staging/digital-assets/asset-staging") {
    response.end(JSON.stringify({
      digitalAssetId: "asset-staging",
      workspaceId: "workspace-staging",
      title: "Workspace-level Codex test asset",
      status: "draft",
      version: 1,
      content: "# Test asset",
    }));
    return;
  }

  if (request.method === "GET" && request.url?.startsWith("/workspaces/workspace-staging/digital-assets?")) {
    response.end(JSON.stringify({
      workspaceId: "workspace-staging",
      workspaceKey: "workspace-staging",
      defaultStatus: null,
      results: [{ digitalAssetId: "asset-staging", title: "Workspace-level Codex test asset", status: "draft" }],
      correlationId: "search-correlation",
    }));
    return;
  }

  if (request.method === "POST" && request.url === "/workspaces/workspace-staging/digital-assets") {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      seenWriteBodies.push(parsed);
      response.end(JSON.stringify({
        digitalAssetId: "asset-staging",
        workspaceId: "workspace-staging",
        workspaceKey: "workspace-staging",
        projectId: parsed.projectId ?? null,
        projectKey: parsed.projectKey ?? null,
        title: parsed.title,
        digitalAssetType: parsed.digitalAssetType,
        status: parsed.status,
        requiresReview: parsed.requiresReview,
        version: 1,
        createdAt: "2026-07-04T00:00:00Z",
        resourceUri: "contenttraker://workspaces/workspace-staging/digital-assets/asset-staging",
        operation: "created",
      }));
    });
    return;
  }

  if (request.method === "PUT" && request.url === "/workspaces/workspace-staging/digital-assets/asset-staging/status") {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      seenLifecycleBodies.push(parsed);
      response.end(JSON.stringify({
        digitalAssetId: "asset-staging",
        workspaceId: "workspace-staging",
        workspaceKey: "workspace-staging",
        previousStatus: "draft",
        status: parsed.status,
        indexingJobId: "job-staging",
        changedAt: "2026-07-11T00:00:00Z",
        resourceUri: "contenttraker://workspaces/workspace-staging/digital-assets/asset-staging",
        operation: "status-changed",
      }));
    });
    return;
  }

  if (request.method === "POST" && request.url === "/workspaces/workspace-staging/digital-assets/uploads") {
    readJsonBody(request, (parsed) => {
      seenUploadBodies.push({ step: "begin", body: parsed });
      response.end(JSON.stringify({
        uploadSessionId: "11111111-1111-1111-1111-111111111111",
        digitalAssetId: "11111111-1111-1111-1111-111111111111",
        workspaceId: "workspace-staging",
        fileName: parsed.fileName ?? "large.md",
        maxChunkBytes: 65536,
        maxChunkCount: 50000,
      }));
    });
    return;
  }

  if (request.method === "PUT" && request.url === "/workspaces/workspace-staging/digital-assets/uploads/11111111-1111-1111-1111-111111111111/chunks/0") {
    readJsonBody(request, (parsed) => {
      seenUploadBodies.push({ step: "append", body: parsed });
      response.end(JSON.stringify({
        uploadSessionId: "11111111-1111-1111-1111-111111111111",
        chunkIndex: 0,
        chunkBytes: 7,
        staged: true,
      }));
    });
    return;
  }

  if (request.method === "POST" && request.url === "/workspaces/workspace-staging/digital-assets/uploads/11111111-1111-1111-1111-111111111111/complete") {
    readJsonBody(request, (parsed) => {
      seenUploadBodies.push({ step: "complete", body: parsed });
      response.end(JSON.stringify({
        uploadSessionId: "11111111-1111-1111-1111-111111111111",
        digitalAssetId: "11111111-1111-1111-1111-111111111111",
        workspaceId: "workspace-staging",
        status: "draft",
        chunkCount: parsed.chunkCount,
      }));
    });
    return;
  }

  if (request.method === "PUT" && request.url === "/workspaces/workspace-staging/digital-assets/asset-staging") {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      seenUpdateBodies.push(parsed);
      response.end(JSON.stringify({
        digitalAssetId: "asset-staging",
        workspaceId: "workspace-staging",
        version: 2,
        status: "draft",
        operation: "updated",
      }));
    });
    return;
  }

  response.statusCode = 404;
  response.end(JSON.stringify({ error: "not-found" }));
});

await new Promise((resolve) => apiServer.listen(0, "127.0.0.1", resolve));

try {
  const apiBaseUrl = `https://127.0.0.1:${apiServer.address().port}`;
  const missingRegistryPath = path.join(tempRoot, "missing-registry.json");
  const stagingRegistryPath = path.join(tempRoot, "staging-registry.json");
  const productionRegistryPath = path.join(tempRoot, "production-registry.json");
  const upsertRegistryPath = path.join(tempRoot, "upsert-registry.json");

  fs.writeFileSync(
    stagingRegistryPath,
    JSON.stringify(
      {
        version: 2,
        environments: {
          staging: {
            projects: [
              {
                projectName: "sample-project",
                repositoryRoot,
                workspaceName: "ContentTraker Staging",
                workspaceId: "workspace-staging",
                contentTrakerProjectName: "Sample Project Staging",
                contentTrakerProjectId: "project-staging",
              },
            ],
          },
        },
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    productionRegistryPath,
    JSON.stringify(
      {
        version: 2,
        environments: {
          production: {
            projects: [
              {
                projectName: "sample-project",
                repositoryRoot,
                workspaceName: "ContentTraker Production",
                workspaceId: "workspace-production",
                contentTrakerProjectName: "Sample Project Production",
                contentTrakerProjectId: "project-production",
              },
            ],
          },
        },
      },
      null,
      2,
    ),
  );

  const runtimeCapabilities = await callTool({
    name: "inspect_runtime_capabilities",
    env: {
      CONTENTTRAKER_RUNTIME_PROFILE: "headless",
      CONTENTTRAKER_ENVIRONMENT: "staging",
      CONTENTTRAKER_STAGING_ACCESS_TOKEN: "test-staging-token",
    },
    arguments: {},
  });
  assert.equal(runtimeCapabilities.status, "ready");
  assert.equal(runtimeCapabilities.selectedProfile, "headless");
  assert.equal(runtimeCapabilities.contentTrakerEnvironment.name, "staging");
  assert.equal(JSON.stringify(runtimeCapabilities).includes("test-staging-token"), false);

  const serviceAuthorizationStatus = await callTool({
    name: "get_contenttraker_authorization_status",
    env: {
      CONTENTTRAKER_ENVIRONMENT: "staging",
      CONTENTTRAKER_STAGING_ACCESS_TOKEN: "test-staging-token",
    },
    arguments: {},
  });
  assert.equal(serviceAuthorizationStatus.status, "authorized");
  assert.equal(JSON.stringify(serviceAuthorizationStatus).includes("test-staging-token"), false);

  const serviceAuthorizationBegin = await callTool({
    name: "begin_contenttraker_authorization",
    env: {
      CONTENTTRAKER_ENVIRONMENT: "staging",
      CONTENTTRAKER_STAGING_ACCESS_TOKEN: "test-staging-token",
    },
    arguments: {},
  });
  assert.equal(serviceAuthorizationBegin.status, "blocked");

  const unconfigured = await callTool({
    name: "resolve_contenttraker_context",
    env: {
      CONTENTTRAKER_CODEX_REGISTRY: missingRegistryPath,
    },
  });

  assert.equal(unconfigured.status, "unconfigured");
  assert.equal(unconfigured.registry.exists, false);
  assert.equal(unconfigured.registry.environment, "staging");
  assert.equal(unconfigured.registry.environmentConfigured, false);
  assert.equal(unconfigured.api.environment, "staging");
  assert.equal(unconfigured.api.configured, true);
  assert.equal(unconfigured.api.baseUrlSource, "built-in-environment-profile");
  assert.equal(unconfigured.api.tokenStrategy.configured, false);
  assert.equal(unconfigured.api.writePolicy.mode, "staging-writes-enabled");

  const currentUser = await callTool({
    name: "get_current_user",
    env: {
      CONTENTTRAKER_ENVIRONMENT: "staging",
      CONTENTTRAKER_API_BASE_URL: apiBaseUrl,
      CONTENTTRAKER_STAGING_ACCESS_TOKEN: "test-staging-token",
      CONTENTTRAKER_REQUIRED_USER_EMAIL: "operator@example.org",
    },
    arguments: {},
  });
  assert.equal(currentUser.status, "ready");
  assert.equal(currentUser.user.email, "operator@example.org");
  assert.equal(currentUser.identityPolicy.matched, true);

  const identityMismatch = await callTool({
    name: "get_current_user",
    env: {
      CONTENTTRAKER_ENVIRONMENT: "staging",
      CONTENTTRAKER_API_BASE_URL: apiBaseUrl,
      CONTENTTRAKER_STAGING_ACCESS_TOKEN: "test-staging-token",
      CONTENTTRAKER_REQUIRED_USER_EMAIL: "different@example.org",
    },
    arguments: {},
  });
  assert.equal(identityMismatch.status, "failed");

  const workspaces = await callTool({
    name: "list_workspaces",
    env: {
      CONTENTTRAKER_ENVIRONMENT: "staging",
      CONTENTTRAKER_API_BASE_URL: apiBaseUrl,
      CONTENTTRAKER_STAGING_ACCESS_TOKEN: "test-staging-token",
      CONTENTTRAKER_REQUIRED_USER_EMAIL: "operator@example.org",
    },
    arguments: {},
  });
  assert.equal(workspaces.status, "ready");
  assert.equal(workspaces.workspaces[0].name, "ContentTraker Staging");

  const staging = await callTool({
    name: "resolve_contenttraker_context",
    env: {
      CONTENTTRAKER_CODEX_REGISTRY: stagingRegistryPath,
      CONTENTTRAKER_ENVIRONMENT: "staging",
      CONTENTTRAKER_API_BASE_URL: apiBaseUrl,
      CONTENTTRAKER_STAGING_ACCESS_TOKEN: "test-staging-token",
    },
  });

  assert.equal(staging.status, "resolved");
  assert.equal(staging.selectedContext.environment, "staging");
  assert.equal(staging.selectedContext.workspaceId, "workspace-staging");
  assert.equal(staging.registry.environmentConfigured, true);
  assert.equal(staging.registry.documentVersion, 2);
  assert.equal(staging.api.configured, true);
  assert.equal(staging.api.baseUrlSource, "CONTENTTRAKER_API_BASE_URL");
  assert.equal(staging.api.tokenStrategy.source, "CONTENTTRAKER_STAGING_ACCESS_TOKEN");

  const readiness = await callTool({
    name: "probe_contenttraker_api_readiness",
    env: {
      CONTENTTRAKER_CODEX_REGISTRY: stagingRegistryPath,
      CONTENTTRAKER_ENVIRONMENT: "staging",
      CONTENTTRAKER_API_BASE_URL: apiBaseUrl,
      CONTENTTRAKER_STAGING_ACCESS_TOKEN: "test-staging-token",
    },
  });

  assert.equal(readiness.status, "ready");
  assert.equal(readiness.checks.length, 3);
  assert.equal(readiness.checks.every((check) => check.status === "ok"), true);
  assert.equal(readiness.checks.find((check) => check.name === "workspaces").matched, true);
  assert.equal(readiness.checks.find((check) => check.name === "workspace-projects").matched, true);
  assert.equal(JSON.stringify(readiness).includes("test-staging-token"), false);
  assert.equal(seenAuthorizationHeaders.includes("Bearer test-staging-token"), true);

  const contract = await callTool({
    name: "inspect_contenttraker_api_contract",
    env: {
      CONTENTTRAKER_CODEX_REGISTRY: stagingRegistryPath,
      CONTENTTRAKER_ENVIRONMENT: "staging",
      CONTENTTRAKER_API_BASE_URL: apiBaseUrl,
      CONTENTTRAKER_STAGING_ACCESS_TOKEN: "test-staging-token",
    },
  });

  assert.equal(contract.status, "ready");
  assert.equal(contract.selectedContext.workspaceId, "workspace-staging");
  assert.equal(contract.selectedContext.projectId, "project-staging");
  assert.equal(
    contract.capabilities.find((capability) => capability.name === "digital-asset-search").status,
    "available",
  );
  assert.equal(
    contract.capabilities.find((capability) => capability.name === "digital-asset-write").status,
    "available",
  );
  assert.equal(
    contract.diagnostics.some((diagnostic) => diagnostic.includes("does not call the remote server-side MCP")),
    true,
  );
  assert.equal(JSON.stringify(contract).includes("test-staging-token"), false);

  const assetTypes = await callTool({
    name: "list_digital_asset_types",
    env: {
      CONTENTTRAKER_CODEX_REGISTRY: stagingRegistryPath,
      CONTENTTRAKER_ENVIRONMENT: "staging",
      CONTENTTRAKER_API_BASE_URL: apiBaseUrl,
      CONTENTTRAKER_STAGING_ACCESS_TOKEN: "test-staging-token",
    },
    arguments: { projectName: "sample-project", repositoryRoot },
  });
  assert.equal(assetTypes.status, "ready");
  assert.equal(assetTypes.digitalAssetTypes[0].digitalAssetType, "Report");

  const assetRead = await callTool({
    name: "get_digital_asset",
    env: {
      CONTENTTRAKER_CODEX_REGISTRY: stagingRegistryPath,
      CONTENTTRAKER_ENVIRONMENT: "staging",
      CONTENTTRAKER_API_BASE_URL: apiBaseUrl,
      CONTENTTRAKER_STAGING_ACCESS_TOKEN: "test-staging-token",
    },
    arguments: { projectName: "sample-project", repositoryRoot, digitalAssetId: "asset-staging" },
  });
  assert.equal(assetRead.status, "found");
  assert.equal(assetRead.asset.status, "draft");

  const assetSearch = await callTool({
    name: "search_digital_assets",
    env: {
      CONTENTTRAKER_CODEX_REGISTRY: stagingRegistryPath,
      CONTENTTRAKER_ENVIRONMENT: "staging",
      CONTENTTRAKER_API_BASE_URL: apiBaseUrl,
      CONTENTTRAKER_STAGING_ACCESS_TOKEN: "test-staging-token",
    },
    arguments: { projectName: "sample-project", repositoryRoot, query: "", status: "draft" },
  });
  assert.equal(assetSearch.status, "ready");
  assert.equal(assetSearch.results[0].status, "draft");

  const write = await callTool({
    name: "create_digital_asset",
    env: {
      CONTENTTRAKER_CODEX_REGISTRY: stagingRegistryPath,
      CONTENTTRAKER_ENVIRONMENT: "staging",
      CONTENTTRAKER_API_BASE_URL: apiBaseUrl,
      CONTENTTRAKER_STAGING_ACCESS_TOKEN: "test-staging-token",
    },
    arguments: {
      projectName: "sample-project",
      repositoryRoot,
      title: "Workspace-level Codex test asset",
      digitalAssetType: "Report",
      content: "# Workspace-level asset\n\nProject is optional provenance.",
      userApprovalStatement: "Test approval for staging smoke write.",
      idempotencyKey: "smoke-write-001",
      status: "published",
    },
  });

  assert.equal(write.status, "created");
  assert.equal(write.selectedContext.workspaceId, "workspace-staging");
  assert.equal(write.selectedContext.projectId, "project-staging");
  assert.equal(write.asset.workspaceId, "workspace-staging");
  assert.equal(write.asset.projectId, undefined);
  assert.equal(seenWriteBodies.length, 1);
  assert.equal(seenWriteBodies[0].projectId, undefined);
  assert.equal(seenWriteBodies[0].sourceSystem, "codex");
  assert.equal(seenWriteBodies[0].idempotencyKey, "smoke-write-001");
  assert.equal(seenWriteBodies[0].status, "published");
  assert.equal(write.asset.status, "published");
  assert.equal(JSON.stringify(write).includes("test-staging-token"), false);

  const update = await callTool({
    name: "update_digital_asset",
    env: {
      CONTENTTRAKER_CODEX_REGISTRY: stagingRegistryPath,
      CONTENTTRAKER_ENVIRONMENT: "staging",
      CONTENTTRAKER_API_BASE_URL: apiBaseUrl,
      CONTENTTRAKER_STAGING_ACCESS_TOKEN: "test-staging-token",
    },
    arguments: {
      projectName: "sample-project",
      repositoryRoot,
      digitalAssetId: "asset-staging",
      title: "Updated test asset",
      userApprovalStatement: "Update this staging draft.",
    },
  });
  assert.equal(update.status, "updated");
  assert.equal(update.asset.version, 2);
  assert.equal(seenUpdateBodies[0].title, "Updated test asset");

  const uploadEnvironment = {
    CONTENTTRAKER_CODEX_REGISTRY: stagingRegistryPath,
    CONTENTTRAKER_ENVIRONMENT: "staging",
    CONTENTTRAKER_API_BASE_URL: apiBaseUrl,
    CONTENTTRAKER_STAGING_ACCESS_TOKEN: "test-staging-token",
  };
  const beginUpload = await callTool({
    name: "begin_digital_asset_upload",
    env: uploadEnvironment,
    arguments: {
      projectName: "sample-project",
      repositoryRoot,
      title: "Large staging asset",
      digitalAssetType: "Report",
      fileName: "large.md",
      userApprovalStatement: "Upload this large staging asset.",
    },
  });
  assert.equal(beginUpload.status, "ready");
  assert.equal(beginUpload.upload.maxChunkBytes, 65536);

  const appendUpload = await callTool({
    name: "append_digital_asset_upload_chunk",
    env: uploadEnvironment,
    arguments: {
      projectName: "sample-project",
      repositoryRoot,
      uploadSessionId: beginUpload.upload.uploadSessionId,
      digitalAssetType: "Report",
      fileName: "large.md",
      chunkIndex: 0,
      chunkContent: "# Large",
      contentEncoding: "utf8",
    },
  });
  assert.equal(appendUpload.status, "staged");
  assert.equal(appendUpload.upload.staged, true);

  const completeUpload = await callTool({
    name: "complete_digital_asset_upload",
    env: uploadEnvironment,
    arguments: {
      projectName: "sample-project",
      repositoryRoot,
      uploadSessionId: beginUpload.upload.uploadSessionId,
      title: "Large staging asset",
      digitalAssetType: "Report",
      fileName: "large.md",
      chunkCount: 1,
      userApprovalStatement: "Store the completed large staging asset.",
    },
  });
  assert.equal(completeUpload.status, "completed");
  assert.equal(completeUpload.upload.chunkCount, 1);
  assert.deepEqual(seenUploadBodies.map((entry) => entry.step), ["begin", "append", "complete"]);

  const lifecycleWrite = await callTool({
    name: "set_digital_asset_status",
    env: {
      CONTENTTRAKER_CODEX_REGISTRY: stagingRegistryPath,
      CONTENTTRAKER_ENVIRONMENT: "staging",
      CONTENTTRAKER_API_BASE_URL: apiBaseUrl,
      CONTENTTRAKER_STAGING_ACCESS_TOKEN: "test-staging-token",
    },
    arguments: {
      projectName: "sample-project",
      repositoryRoot,
      digitalAssetId: "asset-staging",
      status: "published",
      reason: "Publish the approved current version.",
      userApprovalStatement: "Publish this asset.",
      idempotencyKey: "smoke-lifecycle-001",
    },
  });

  assert.equal(lifecycleWrite.status, "changed");
  assert.equal(lifecycleWrite.asset.status, "published");
  assert.equal(lifecycleWrite.asset.indexingJobId, "job-staging");
  assert.equal(seenLifecycleBodies.length, 1);
  assert.equal(seenLifecycleBodies[0].idempotencyKey, "smoke-lifecycle-001");
  assert.equal(JSON.stringify(lifecycleWrite).includes("test-staging-token"), false);

  const upsert = await callTool({
    name: "upsert_contenttraker_registry_mapping",
    env: {
      CONTENTTRAKER_CODEX_REGISTRY: upsertRegistryPath,
    },
    arguments: {
      environment: "staging",
      projectName: "sample-project",
      repositoryRoot,
      workspaceName: "ContentTraker Staging",
      workspaceId: "workspace-staging",
      contentTrakerProjectName: "Sample Project Staging",
      contentTrakerProjectId: "project-staging",
      setDefault: true,
    },
  });

  assert.equal(upsert.status, "created");
  assert.equal(upsert.registry.environment, "staging");
  assert.equal(upsert.registry.projectCount, 1);
  assert.equal(fs.existsSync(upsertRegistryPath), true);

  const upsertedDocument = JSON.parse(fs.readFileSync(upsertRegistryPath, "utf8"));
  assert.equal(upsertedDocument.version, 2);
  assert.equal(upsertedDocument.environments.staging.projects.length, 1);

  const productionWithoutScopedConfig = await callTool({
    name: "resolve_contenttraker_context",
    env: {
      CONTENTTRAKER_CODEX_REGISTRY: stagingRegistryPath,
      CONTENTTRAKER_ENVIRONMENT: "production",
      CONTENTTRAKER_API_BASE_URL: "https://generic.contenttraker.test",
      CONTENTTRAKER_STAGING_ACCESS_TOKEN: "generic-token",
    },
  });

  assert.equal(productionWithoutScopedConfig.status, "unconfigured");
  assert.equal(productionWithoutScopedConfig.registry.environment, "production");
  assert.equal(productionWithoutScopedConfig.registry.environmentConfigured, false);
  assert.equal(productionWithoutScopedConfig.api.configured, true);
  assert.equal(productionWithoutScopedConfig.api.baseUrlSource, "built-in-environment-profile");
  assert.equal(productionWithoutScopedConfig.api.tokenStrategy.configured, false);
  assert.equal(productionWithoutScopedConfig.api.writePolicy.mode, "production-read-only");

  const production = await callTool({
    name: "resolve_contenttraker_context",
    env: {
      CONTENTTRAKER_CODEX_REGISTRY: productionRegistryPath,
      CONTENTTRAKER_ENVIRONMENT: "production",
      CONTENTTRAKER_PRODUCTION_API_BASE_URL: "https://api.contenttraker.test",
      CONTENTTRAKER_PRODUCTION_ACCESS_TOKEN: "test-production-token",
      CONTENTTRAKER_ENABLE_PRODUCTION_WRITES: "true",
    },
  });

  assert.equal(production.status, "resolved");
  assert.equal(production.selectedContext.environment, "production");
  assert.equal(production.selectedContext.workspaceId, "workspace-production");
  assert.equal(production.api.configured, true);
  assert.equal(production.api.baseUrlSource, "CONTENTTRAKER_PRODUCTION_API_BASE_URL");
  assert.equal(production.api.tokenStrategy.source, "CONTENTTRAKER_PRODUCTION_ACCESS_TOKEN");
  assert.equal(production.api.writePolicy.mode, "production-explicit-enabled");
  assert.equal(production.api.writePolicy.writesExposed, true);
} finally {
  await new Promise((resolve) => apiServer.close(resolve));
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

async function callTool({ name, env, arguments: toolArguments }) {
  const requests = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: {
          name: "contenttraker-codex-smoke-test",
          version: "0.1.5",
        },
      },
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name,
        arguments: toolArguments ?? {
          projectName: "sample-project",
          repositoryRoot,
        },
      },
    },
  ];

  const result = await runServer(requests, env);

  assert.equal(result.status, 0, result.stderr || `Process exited with signal ${result.signal ?? "unknown"}`);
  assert.equal(result.stderr, "");

  const responses = result.stdout
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));

  assert.equal(responses.length, 3);
  assert.equal(responses[0].id, 1);
  assert.equal(responses[1].id, 2);
  assert.equal(responses[2].id, 3);

  const tools = responses[1].result.tools;
  assert.equal(Array.isArray(tools), true);
  assert.equal(
    tools.some((tool) => tool.name === "resolve_contenttraker_context"),
    true,
  );
  assert.equal(tools.some((tool) => tool.name === "inspect_runtime_capabilities"), true);
  assert.equal(tools.some((tool) => tool.name === "begin_contenttraker_authorization"), true);
  assert.equal(tools.some((tool) => tool.name === "get_contenttraker_authorization_status"), true);
  assert.equal(tools.some((tool) => tool.name === "cancel_contenttraker_authorization"), true);
  assert.equal(tools.some((tool) => tool.name === "get_current_user"), true);
  assert.equal(tools.some((tool) => tool.name === "list_workspaces"), true);
  assert.equal(
    tools.some((tool) => tool.name === "probe_contenttraker_api_readiness"),
    true,
  );
  assert.equal(
    tools.some((tool) => tool.name === "inspect_contenttraker_api_contract"),
    true,
  );
  assert.equal(
    tools.some((tool) => tool.name === "get_digital_asset"),
    true,
  );
  assert.equal(
    tools.some((tool) => tool.name === "list_digital_asset_types"),
    true,
  );
  assert.equal(
    tools.some((tool) => tool.name === "search_digital_assets"),
    true,
  );
  assert.equal(
    tools.some((tool) => tool.name === "create_digital_asset"),
    true,
  );
  assert.equal(
    tools.some((tool) => tool.name === "begin_digital_asset_upload"),
    true,
  );
  assert.equal(
    tools.some((tool) => tool.name === "append_digital_asset_upload_chunk"),
    true,
  );
  assert.equal(
    tools.some((tool) => tool.name === "complete_digital_asset_upload"),
    true,
  );
  assert.equal(
    tools.some((tool) => tool.name === "update_digital_asset"),
    true,
  );
  assert.equal(
    tools.some((tool) => tool.name === "set_digital_asset_status"),
    true,
  );
  assert.equal(
    tools.some((tool) => tool.name === "upsert_contenttraker_registry_mapping"),
    true,
  );

  return responses[2].result.structuredContent;
}

function readJsonBody(request, callback) {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => callback(JSON.parse(body)));
}

function runServer(requests, envOverrides) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      env: cleanEnv(envOverrides),
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
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
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
      resolve({
        status: timedOut ? null : status,
        signal,
        stdout,
        stderr,
      });
    });
    child.stdin.end(`${requests.map((request) => JSON.stringify(request)).join("\n")}\n`);
  });
}

function cleanEnv(overrides) {
  const effectiveOverrides = {
    ...overrides,
    ...(overrides.CONTENTTRAKER_API_BASE_URL && !overrides.CONTENTTRAKER_OAUTH_RESOURCE
      ? { CONTENTTRAKER_OAUTH_RESOURCE: overrides.CONTENTTRAKER_API_BASE_URL }
      : {}),
  };
  const env = {
    ...process.env,
    CONTENTTRAKER_AUTH_MODE: "service",
    NODE_EXTRA_CA_CERTS: trustedCertificatePath,
    ...effectiveOverrides,
  };
  const keys = [
    "CONTENTTRAKER_ENVIRONMENT",
    "CONTENTTRAKER_RUNTIME_PROFILE",
    "CONTENTTRAKER_BROWSER_MODE",
    "CONTENTTRAKER_API_BASE_URL",
    "CONTENTTRAKER_STAGING_API_BASE_URL",
    "CONTENTTRAKER_PRODUCTION_API_BASE_URL",
    "CONTENTTRAKER_OAUTH_RESOURCE",
    "CONTENTTRAKER_STAGING_OAUTH_RESOURCE",
    "CONTENTTRAKER_PRODUCTION_OAUTH_RESOURCE",
    "CONTENTTRAKER_ACCESS_TOKEN",
    "CONTENTTRAKER_STAGING_ACCESS_TOKEN",
    "CONTENTTRAKER_PRODUCTION_ACCESS_TOKEN",
    "CONTENTTRAKER_ENABLE_PRODUCTION_WRITES",
    "CONTENTTRAKER_REQUIRED_USER_EMAIL",
    "CONTENTTRAKER_TOKEN_ISSUER_SHA256",
    "CONTENTTRAKER_CODEX_REGISTRY",
  ];

  for (const key of keys) {
    if (!Object.hasOwn(effectiveOverrides, key)) {
      delete env[key];
    }
  }

  return env;
}
