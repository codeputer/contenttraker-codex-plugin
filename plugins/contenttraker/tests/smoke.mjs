import assert from "node:assert/strict";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generate as generateSelfSignedCertificate } from "selfsigned";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(__dirname, "../node_modules/.cache/contenttraker-internal-test-server.mjs");
const productionServerPath = path.resolve(__dirname, "../dist/server.mjs");
const repositoryRoot = path.resolve(__dirname, "../../..");
const mcpManifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../.mcp.json"), "utf8"));
assert.deepEqual(mcpManifest.mcpServers["contenttraker-codex-adapter"], {
  cwd: ".",
  command: "node",
  args: ["./dist/server.mjs"],
  env: {
    CONTENTTRAKER_REQUIRE_IDENTITY_POLICY: "true",
  },
  env_vars: [
    "CONTENTTRAKER_ENVIRONMENT",
    "CONTENTTRAKER_RUNTIME_PROFILE",
    "CONTENTTRAKER_AUTH_MODE",
    "CONTENTTRAKER_DELEGATED_FLOW",
    "CONTENTTRAKER_BROWSER_MODE",
    "CONTENTTRAKER_CREDENTIAL_STORE",
    "CONTENTTRAKER_CREDENTIAL_PROFILE",
    "CONTENTTRAKER_REQUIRED_USER_EMAIL",
    "CONTENTTRAKER_ALLOW_EPHEMERAL_PRODUCTION",
    "CONTENTTRAKER_ENABLE_PRODUCTION_WRITES",
  ],
});
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
const seenQuestionBodies = [];

const apiServer = https.createServer({ key: testCertificate.private, cert: testCertificate.cert }, (request, response) => {
  seenAuthorizationHeaders.push(request.headers.authorization);
  const requestUrl = new URL(request.url ?? "/", "https://contenttraker.test");

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
        {
          id: "workspace-production",
          name: "ContentTraker Production",
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

  if (request.url === "/workspaces/workspace-production/projects") {
    response.end(JSON.stringify({
      projects: [
        {
          id: "project-production",
          name: "Sample Project Production",
        },
      ],
    }));
    return;
  }

  if (
    request.method === "POST"
    && request.url === "/workspaces/workspace-staging/projects/project-staging/questions"
  ) {
    readJsonBody(request, (parsed) => {
      seenQuestionBodies.push(parsed);
      response.setHeader("x-correlation-id", "smoke-question-http-correlation");
      response.end(JSON.stringify({
        success: true,
        correlationId: "smoke-question-response-correlation",
        workspaceId: "workspace-staging",
        workspaceName: "ContentTraker Staging",
        projectId: "project-staging",
        projectName: "Sample Project Staging",
        threadId: "thread-smoke",
        threadName: parsed.threadName,
        foundryThreadId: "foundry-thread-smoke",
        question: parsed.question,
        questionSource: parsed.questionSource,
        callerApp: parsed.callerApp,
        sessionId: parsed.sessionId,
        queryScopeMode: parsed.scopeMode,
        queryLane: "KBA",
        scopedRetrievalProvisioned: true,
        scopedRetrievalUnavailable: false,
        answer: "The smoke-test workspace answer.",
        homeAnswer: "The smoke-test workspace answer.",
        answerSources: [{
          workspaceId: "workspace-staging",
          projectId: "project-staging",
          threadId: "thread-smoke",
          success: true,
          answer: "The smoke-test workspace answer.",
        }],
        answerRole: "Assistant",
        turnCount: 2,
        usedDigitalAssets: true,
        promptTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
        isNewThread: true,
        referenceAnswers: parsed.referenceScopes,
        persistence: { persisted: true },
        message: "Workspace question answered in a new thread.",
      }));
    });
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

  if (
    request.method === "GET"
    && requestUrl.pathname === "/workspaces/workspace-staging/digital-assets/asset-staging"
  ) {
    assert.equal(requestUrl.searchParams.get("projectId"), "project-staging");
    response.end(JSON.stringify({
      digitalAssetId: "asset-staging",
      workspaceId: "workspace-staging",
      projectId: "project-staging",
      title: "Workspace-level Codex test asset",
      status: "draft",
      version: 1,
      content: "# Test asset",
    }));
    return;
  }

  if (
    request.method === "GET"
    && requestUrl.pathname === "/workspaces/workspace-staging/digital-assets"
  ) {
    assert.equal(requestUrl.searchParams.get("projectId"), "project-staging");
    assert.equal(requestUrl.searchParams.get("status"), "draft");
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
  const workspaceOnlyRegistryPath = path.join(tempRoot, "workspace-only-registry.json");
  const defaultOnlyRegistryPath = path.join(tempRoot, "default-only-registry.json");

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
    defaultOnlyRegistryPath,
    JSON.stringify({
      version: 3,
      environments: {
        staging: {
          defaults: {
            contentKeeperId: "workspace-staging",
            workspaceId: "workspace-staging",
          },
          projects: [],
        },
      },
    }, null, 2),
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
      CONTENTTRAKER_AUTH_MODE: "delegated",
      CONTENTTRAKER_CREDENTIAL_STORE: "memory",
    },
    arguments: {},
  });
  assert.equal(runtimeCapabilities.status, "ready");
  assert.equal(runtimeCapabilities.selectedProfile, "headless");
  assert.equal(runtimeCapabilities.contentTrakerEnvironment.name, "staging");
  assert.equal(JSON.stringify(runtimeCapabilities).includes("internal-smoke-test"), false);

  const injectedAuthorizationStatus = await callTool({
    name: "get_contenttraker_authorization_status",
    env: {
      CONTENTTRAKER_ENVIRONMENT: "staging",
    },
    arguments: {},
  });
  assert.equal(injectedAuthorizationStatus.status, "authorized");
  assert.equal(JSON.stringify(injectedAuthorizationStatus).includes("internal-smoke-test"), false);

  const injectedAuthorizationBegin = await callTool({
    name: "begin_contenttraker_authorization",
    env: {
      CONTENTTRAKER_ENVIRONMENT: "staging",
    },
    arguments: {},
  });
  assert.equal(injectedAuthorizationBegin.status, "authorized");

  const unconfigured = await callTool({
    name: "resolve_contenttraker_context",
    env: {
      CONTENTTRAKER_CODEX_REGISTRY: missingRegistryPath,
    },
  });

  assert.equal(
    unconfigured.status,
    "blocked",
    `Unexpected unconfigured context result: ${JSON.stringify(unconfigured)}`,
  );
  assert.equal(unconfigured.registry.exists, false);
  assert.equal(unconfigured.registry.environment, "staging");
  assert.equal(unconfigured.registry.environmentConfigured, false);
  assert.equal(unconfigured.api.environment, "staging");
  assert.equal(unconfigured.api.configured, true);
  assert.equal(unconfigured.api.baseUrlSource, "built-in-environment-profile");
  assert.equal(unconfigured.api.tokenStrategy.configured, true);
  assert.equal(unconfigured.api.tokenStrategy.source, "injected-internal-test-provider");
  assert.equal(unconfigured.api.writePolicy.mode, "staging-writes-enabled");
  assert.match(unconfigured.diagnostics.join(" "), /contentkeeper_selection_required/);

  const defaultRejected = await callTool({
    name: "resolve_contenttraker_context",
    env: {
      CONTENTTRAKER_CODEX_REGISTRY: defaultOnlyRegistryPath,
    },
  });
  assert.equal(defaultRejected.status, "blocked");
  assert.equal(defaultRejected.selectedContext, undefined);
  assert.match(defaultRejected.diagnostics.join(" "), /contentkeeper_selection_required/);

  const aliasMismatch = await callTool({
    name: "resolve_contenttraker_context",
    env: {
      CONTENTTRAKER_CODEX_REGISTRY: missingRegistryPath,
    },
    arguments: {
      contentKeeperId: "workspace-staging",
      workspaceId: "workspace-production",
    },
  });
  assert.equal(aliasMismatch.status, "blocked");
  assert.match(aliasMismatch.diagnostics.join(" "), /content_keeper_alias_mismatch/);

  const currentUser = await callTool({
    name: "get_current_user",
    env: {
      CONTENTTRAKER_ENVIRONMENT: "staging",
      CONTENTTRAKER_API_BASE_URL: apiBaseUrl,
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
    },
  });

  assert.equal(staging.status, "resolved");
  assert.equal(staging.selectedContext.environment, "staging");
  assert.equal(staging.contentKeeperId, "workspace-staging");
  assert.equal(staging.selectedContext.contentKeeperId, "workspace-staging");
  assert.equal(staging.selectedContext.workspaceId, "workspace-staging");
  assert.equal(staging.registry.environmentConfigured, true);
  assert.equal(staging.registry.documentVersion, 2);
  assert.equal(staging.api.configured, true);
  assert.equal(staging.api.baseUrlSource, "CONTENTTRAKER_API_BASE_URL");
  assert.equal(staging.api.tokenStrategy.source, "injected-internal-test-provider");

  const preferredExplicit = await callTool({
    name: "resolve_contenttraker_context",
    env: {
      CONTENTTRAKER_CODEX_REGISTRY: missingRegistryPath,
      CONTENTTRAKER_ENVIRONMENT: "staging",
      CONTENTTRAKER_API_BASE_URL: apiBaseUrl,
    },
    arguments: {
      context: {
        source: "content-keeper",
        contentKeeperId: "workspace-staging",
      },
    },
  });
  assert.equal(preferredExplicit.status, "resolved");
  assert.equal(preferredExplicit.contentKeeperId, "workspace-staging");
  assert.equal(preferredExplicit.workspaceId, "workspace-staging");

  const readiness = await callTool({
    name: "probe_contenttraker_api_readiness",
    env: {
      CONTENTTRAKER_CODEX_REGISTRY: stagingRegistryPath,
      CONTENTTRAKER_ENVIRONMENT: "staging",
      CONTENTTRAKER_API_BASE_URL: apiBaseUrl,
    },
  });

  assert.equal(readiness.status, "ready");
  assert.equal(readiness.contentKeeperId, "workspace-staging");
  assert.equal(readiness.checks.length, 3);
  assert.equal(readiness.checks.every((check) => check.status === "ok"), true);
  assert.equal(readiness.checks.find((check) => check.name === "workspaces").matched, true);
  assert.equal(readiness.checks.find((check) => check.name === "workspace-projects").matched, true);
  assert.equal(JSON.stringify(readiness).includes("internal-smoke-test"), false);
  assert.equal(seenAuthorizationHeaders.includes("Bearer internal-smoke-test"), true);

  const contract = await callTool({
    name: "inspect_contenttraker_api_contract",
    env: {
      CONTENTTRAKER_CODEX_REGISTRY: stagingRegistryPath,
      CONTENTTRAKER_ENVIRONMENT: "staging",
      CONTENTTRAKER_API_BASE_URL: apiBaseUrl,
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
    contract.capabilities.find((capability) => capability.name === "workspace-question").status,
    "available",
  );
  assert.match(
    contract.capabilities.find((capability) => capability.name === "workspace-question").reason,
    /non-idempotent/,
  );
  assert.equal(
    contract.diagnostics.some((diagnostic) => diagnostic.includes("does not call the remote server-side MCP")),
    true,
  );
  assert.equal(JSON.stringify(contract).includes("internal-smoke-test"), false);

  const question = await callTool({
    name: "ask_workspace_question",
    env: {
      CONTENTTRAKER_CODEX_REGISTRY: stagingRegistryPath,
      CONTENTTRAKER_ENVIRONMENT: "staging",
      CONTENTTRAKER_API_BASE_URL: apiBaseUrl,
    },
    arguments: {
      projectName: "sample-project",
      repositoryRoot,
      question: "What does the smoke-test workspace say?",
      sessionId: "smoke-session",
      threadName: "Smoke workspace question",
      questionSource: "Copilot",
      scopeMode: "Both",
      callerApp: "Codex smoke test",
      referenceScopes: [{
        workspaceId: "workspace-reference",
        projectId: "project-reference",
      }],
      userApprovalStatement: "Ask this staging smoke-test question.",
    },
  });
  assert.equal(question.status, "answered");
  assert.deepEqual(question.operationPolicy, {
    stateChanging: true,
    idempotencyKeySupported: false,
    automaticRetry: false,
  });
  assert.equal(question.contentKeeperId, "workspace-staging");
  assert.equal(question.workspaceId, "workspace-staging");
  assert.equal(question.projectId, "project-staging");
  assert.equal(question.httpCorrelationId, "smoke-question-http-correlation");
  assert.equal(question.responseCorrelationId, "smoke-question-response-correlation");
  assert.equal(question.response.threadId, "thread-smoke");
  assert.equal(question.response.answer, "The smoke-test workspace answer.");
  assert.equal(question.response.scopedRetrievalProvisioned, true);
  assert.equal(question.response.totalTokens, 20);
  assert.deepEqual(question.response.persistence, { persisted: true });
  assert.equal(seenQuestionBodies.length, 1);
  assert.deepEqual(seenQuestionBodies[0].referenceScopes, [{
    workspaceId: "workspace-reference",
    projectId: "project-reference",
  }]);
  assert.equal(Object.hasOwn(seenQuestionBodies[0], "userApprovalStatement"), false);
  assert.equal(Object.hasOwn(seenQuestionBodies[0], "idempotencyKey"), false);

  const assetTypes = await callTool({
    name: "list_digital_asset_types",
    env: {
      CONTENTTRAKER_CODEX_REGISTRY: stagingRegistryPath,
      CONTENTTRAKER_ENVIRONMENT: "staging",
      CONTENTTRAKER_API_BASE_URL: apiBaseUrl,
    },
    arguments: { projectName: "sample-project", repositoryRoot },
  });
  assert.equal(assetTypes.status, "ready");
  assert.equal(assetTypes.contentKeeperId, "workspace-staging");
  assert.equal(assetTypes.workspaceId, "workspace-staging");
  assert.equal(assetTypes.digitalAssetTypes[0].digitalAssetType, "Report");

  const assetRead = await callTool({
    name: "get_digital_asset",
    env: {
      CONTENTTRAKER_CODEX_REGISTRY: stagingRegistryPath,
      CONTENTTRAKER_ENVIRONMENT: "staging",
      CONTENTTRAKER_API_BASE_URL: apiBaseUrl,
    },
    arguments: { projectName: "sample-project", repositoryRoot, digitalAssetId: "asset-staging" },
  });
  assert.equal(assetRead.status, "found");
  assert.equal(assetRead.contentKeeperId, "workspace-staging");
  assert.equal(assetRead.workspaceId, "workspace-staging");
  assert.equal(assetRead.selectedContext.projectId, "project-staging");
  assert.equal(assetRead.asset.status, "draft");
  assert.equal(assetRead.asset.projectId, "project-staging");

  const assetSearch = await callTool({
    name: "search_digital_assets",
    env: {
      CONTENTTRAKER_CODEX_REGISTRY: stagingRegistryPath,
      CONTENTTRAKER_ENVIRONMENT: "staging",
      CONTENTTRAKER_API_BASE_URL: apiBaseUrl,
    },
    arguments: { projectName: "sample-project", repositoryRoot, query: "", status: "draft" },
  });
  assert.equal(assetSearch.status, "ready");
  assert.equal(assetSearch.contentKeeperId, "workspace-staging");
  assert.equal(assetSearch.workspaceId, "workspace-staging");
  assert.equal(assetSearch.selectedContext.projectId, "project-staging");
  assert.equal(assetSearch.results[0].status, "draft");

  const write = await callTool({
    name: "create_digital_asset",
    env: {
      CONTENTTRAKER_CODEX_REGISTRY: stagingRegistryPath,
      CONTENTTRAKER_ENVIRONMENT: "staging",
      CONTENTTRAKER_API_BASE_URL: apiBaseUrl,
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
  assert.equal(write.contentKeeperId, "workspace-staging");
  assert.equal(write.workspaceId, "workspace-staging");
  assert.equal(write.selectedContext.contentKeeperId, "workspace-staging");
  assert.equal(write.selectedContext.workspaceId, "workspace-staging");
  assert.equal(write.selectedContext.projectId, "project-staging");
  assert.equal(write.asset.workspaceId, "workspace-staging");
  assert.equal(write.asset.contentKeeperId, "workspace-staging");
  assert.equal(write.asset.projectId, "project-staging");
  assert.equal(seenWriteBodies.length, 1);
  assert.equal(seenWriteBodies[0].projectId, "project-staging");
  assert.equal(seenWriteBodies[0].sourceSystem, "codex");
  assert.equal(seenWriteBodies[0].idempotencyKey, "smoke-write-001");
  assert.equal(seenWriteBodies[0].status, "published");
  assert.equal(write.asset.status, "published");
  assert.equal(JSON.stringify(write).includes("internal-smoke-test"), false);

  const update = await callTool({
    name: "update_digital_asset",
    env: {
      CONTENTTRAKER_CODEX_REGISTRY: stagingRegistryPath,
      CONTENTTRAKER_ENVIRONMENT: "staging",
      CONTENTTRAKER_API_BASE_URL: apiBaseUrl,
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
  assert.equal(JSON.stringify(lifecycleWrite).includes("internal-smoke-test"), false);

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
  assert.equal(upsertedDocument.version, 3);
  assert.equal(upsertedDocument.environments.staging.projects[0].contentKeeperId, "workspace-staging");
  assert.equal(upsertedDocument.environments.staging.projects.length, 1);

  const workspaceOnlyUpsert = await callTool({
    name: "upsert_contenttraker_registry_mapping",
    env: {
      CONTENTTRAKER_CODEX_REGISTRY: workspaceOnlyRegistryPath,
    },
    arguments: {
      environment: "staging",
      projectName: "local-project-only",
      repositoryRoot,
      workspaceName: "ContentTraker Staging",
      workspaceId: "workspace-staging",
      setDefault: true,
    },
  });

  assert.equal(workspaceOnlyUpsert.status, "created");
  assert.equal(workspaceOnlyUpsert.selectedContext.projectName, undefined);
  assert.equal(workspaceOnlyUpsert.selectedContext.projectId, undefined);

  const workspaceOnlyDocument = JSON.parse(fs.readFileSync(workspaceOnlyRegistryPath, "utf8"));
  assert.equal(workspaceOnlyDocument.environments.staging.projects[0].projectName, "local-project-only");
  assert.equal(workspaceOnlyDocument.environments.staging.defaults.projectName, undefined);

  const workspaceOnlyReadiness = await callTool({
    name: "probe_contenttraker_api_readiness",
    env: {
      CONTENTTRAKER_CODEX_REGISTRY: workspaceOnlyRegistryPath,
      CONTENTTRAKER_ENVIRONMENT: "staging",
      CONTENTTRAKER_API_BASE_URL: apiBaseUrl,
    },
    arguments: {
      projectName: "local-project-only",
      repositoryRoot,
    },
  });

  assert.equal(workspaceOnlyReadiness.status, "ready");
  assert.equal(workspaceOnlyReadiness.selectedContext.projectName, undefined);
  assert.equal(workspaceOnlyReadiness.checks.length, 3);
  const workspaceOnlyProjectsCheck = workspaceOnlyReadiness.checks.find((check) => check.name === "workspace-projects");
  assert.equal(workspaceOnlyProjectsCheck.status, "ok");
  assert.equal(workspaceOnlyProjectsCheck.matched, undefined);

  const productionWithoutScopedConfig = await callTool({
    name: "resolve_contenttraker_context",
    env: {
      CONTENTTRAKER_CODEX_REGISTRY: stagingRegistryPath,
      CONTENTTRAKER_ENVIRONMENT: "production",
      CONTENTTRAKER_API_BASE_URL: "https://generic.contenttraker.test",
    },
  });

  assert.equal(
    productionWithoutScopedConfig.status,
    "blocked",
    `Unexpected production context result: ${JSON.stringify(productionWithoutScopedConfig)}`,
  );
  assert.equal(productionWithoutScopedConfig.registry.environment, "production");
  assert.equal(productionWithoutScopedConfig.registry.environmentConfigured, false);
  assert.equal(productionWithoutScopedConfig.api.configured, true);
  assert.equal(productionWithoutScopedConfig.api.baseUrlSource, "built-in-environment-profile");
  assert.equal(productionWithoutScopedConfig.api.tokenStrategy.configured, true);
  assert.equal(productionWithoutScopedConfig.api.tokenStrategy.source, "injected-internal-test-provider");
  assert.equal(productionWithoutScopedConfig.api.writePolicy.mode, "production-read-only");

  const production = await callTool({
    name: "resolve_contenttraker_context",
    env: {
      CONTENTTRAKER_CODEX_REGISTRY: productionRegistryPath,
      CONTENTTRAKER_ENVIRONMENT: "production",
      CONTENTTRAKER_PRODUCTION_API_BASE_URL: apiBaseUrl,
      CONTENTTRAKER_PRODUCTION_OAUTH_RESOURCE: apiBaseUrl,
      CONTENTTRAKER_ENABLE_PRODUCTION_WRITES: "true",
    },
  });

  assert.equal(production.status, "resolved");
  assert.equal(production.selectedContext.environment, "production");
  assert.equal(production.contentKeeperId, "workspace-production");
  assert.equal(production.selectedContext.contentKeeperId, "workspace-production");
  assert.equal(production.selectedContext.workspaceId, "workspace-production");
  assert.equal(production.api.configured, true);
  assert.equal(production.api.baseUrlSource, "CONTENTTRAKER_PRODUCTION_API_BASE_URL");
  assert.equal(production.api.tokenStrategy.source, "injected-internal-test-provider");
  assert.equal(production.api.writePolicy.mode, "production-explicit-enabled");
  assert.equal(production.api.writePolicy.writesExposed, true);
  await verifyProductionBundleStarts();
} finally {
  await new Promise((resolve) => apiServer.close(resolve));
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

async function verifyProductionBundleStarts() {
  const bundle = fs.readFileSync(productionServerPath, "utf8");
  assert.equal(bundle.includes("CONTENTTRAKER_STAGING_ACCESS_TOKEN"), false);
  assert.equal(bundle.includes("CONTENTTRAKER_PRODUCTION_ACCESS_TOKEN"), false);
  assert.equal(bundle.includes("CONTENTTRAKER_INTERNAL_TEST_ADAPTER"), false);
  const result = await runServer([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "contenttraker-production-bundle-smoke-test", version: "0.1.0" },
      },
    },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "logout_contenttraker",
        arguments: { confirmation: "LOGOUT_CONTENTTRAKER" },
      },
    },
  ], {
    CONTENTTRAKER_ENVIRONMENT: "staging",
    CONTENTTRAKER_REQUIRE_IDENTITY_POLICY: "true",
  }, productionServerPath, false);
  assert.equal(result.status, 0, result.stderr || `Production bundle exited with signal ${result.signal ?? "unknown"}`);
  assert.equal(result.stderr, "");
  const responses = result.stdout.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(responses.length, 3);
  assert.match(responses[0].result.instructions, /local stdio ContentTraker server/);
  assert.match(responses[0].result.instructions.slice(0, 512), /ContentKeeperId/);
  assert.equal(
    responses[1].result.tools.every((tool) => tool.outputSchema?.type === "object"),
    true,
  );
  assert.equal(responses[1].result.tools.some((tool) => tool.name === "inspect_runtime_capabilities"), true);
  assert.equal(responses[1].result.tools.some((tool) => tool.name === "confirm_contenttraker_context"), true);
  assert.equal(responses[1].result.tools.some((tool) => tool.name === "reset_contenttraker_context"), true);
  assert.equal(responses[2].result.structuredContent.status, "blocked");
  assert.match(
    responses[2].result.structuredContent.diagnostics.join(" "),
    /No local credential was addressed or deleted/,
  );
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

  let result = await runServer(requests, env);
  if (process.platform === "win32" && result.status === 3221226505 && result.stderr === "") {
    // Node can occasionally terminate a rapidly spawned Windows test child with
    // STATUS_STACK_BUFFER_OVERRUN before emitting adapter output. Retry once;
    // a deterministic adapter crash still fails on the second attempt.
    result = await runServer(requests, env);
  }

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
  assert.match(responses[0].result.instructions, /local stdio ContentTraker server/);
  assert.match(responses[0].result.instructions.slice(0, 512), /ContentKeeperId/);
  assert.equal(tools.every((tool) => tool.outputSchema?.type === "object"), true);
  const searchTool = tools.find((tool) => tool.name === "search_digital_assets");
  assert.equal(searchTool.inputSchema.properties.contentKeeperId.type, "string");
  assert.equal(Array.isArray(searchTool.inputSchema.properties.context.anyOf), true);
  assert.equal(searchTool.inputSchema.properties.context.anyOf.length, 2);
  assert.match(searchTool.inputSchema.properties.workspaceId.description, /Deprecated equal-value .*alias/);
  const questionTool = tools.find((tool) => tool.name === "ask_workspace_question");
  assert.ok(questionTool);
  assert.equal(questionTool.annotations.readOnlyHint, false);
  assert.equal(questionTool.annotations.destructiveHint, false);
  assert.equal(questionTool.annotations.idempotentHint, false);
  assert.equal(questionTool.annotations.openWorldHint, true);
  assert.equal(questionTool.inputSchema.properties.question.type, "string");
  assert.equal(questionTool.inputSchema.properties.projectId.type, "string");
  assert.equal(questionTool.inputSchema.properties.userApprovalStatement.type, "string");
  assert.equal(questionTool.inputSchema.properties.idempotencyKey, undefined);
  assert.equal(questionTool.outputSchema.properties.response.type, "object");
  assert.equal(questionTool.outputSchema.properties.httpCorrelationId.type, "string");
  assert.equal(questionTool.outputSchema.properties.responseCorrelationId.type, "string");
  assert.equal(
    tools.some((tool) => tool.name === "resolve_contenttraker_context"),
    true,
  );
  assert.equal(tools.some((tool) => tool.name === "confirm_contenttraker_context"), true);
  assert.equal(tools.some((tool) => tool.name === "reset_contenttraker_context"), true);
  assert.equal(tools.some((tool) => tool.name === "inspect_runtime_capabilities"), true);
  assert.equal(tools.some((tool) => tool.name === "inspect_contenttraker_oauth_metadata"), true);
  assert.equal(tools.some((tool) => tool.name === "begin_contenttraker_authorization"), true);
  assert.equal(tools.some((tool) => tool.name === "begin_contenttraker_login"), true);
  assert.equal(tools.some((tool) => tool.name === "get_contenttraker_authorization_status"), true);
  assert.equal(tools.some((tool) => tool.name === "poll_contenttraker_login"), true);
  assert.equal(tools.some((tool) => tool.name === "get_contenttraker_auth_status"), true);
  assert.equal(tools.some((tool) => tool.name === "cancel_contenttraker_authorization"), true);
  assert.equal(tools.some((tool) => tool.name === "forget_contenttraker_credential"), true);
  assert.equal(tools.some((tool) => tool.name === "logout_contenttraker"), true);
  assert.equal(tools.some((tool) => tool.name === "get_current_user"), true);
  assert.equal(tools.some((tool) => tool.name === "list_workspaces"), true);
  assert.equal(tools.some((tool) => tool.name === "ask_workspace_question"), true);
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

function runServer(requests, envOverrides, executablePath = serverPath, internalTest = true) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [executablePath], {
      env: internalTest ? cleanEnv(envOverrides) : cleanProductionEnv(envOverrides),
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

function cleanProductionEnv(overrides) {
  const env = cleanEnv(overrides);
  delete env.CONTENTTRAKER_INTERNAL_TEST_ADAPTER;
  return env;
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
    CONTENTTRAKER_INTERNAL_TEST_ADAPTER: "1",
    NODE_EXTRA_CA_CERTS: trustedCertificatePath,
    ...effectiveOverrides,
  };
  const keys = [
    "CONTENTTRAKER_ENVIRONMENT",
    "CONTENTTRAKER_RUNTIME_PROFILE",
    "CONTENTTRAKER_AUTH_MODE",
    "CONTENTTRAKER_DELEGATED_FLOW",
    "CONTENTTRAKER_BROWSER_MODE",
    "CONTENTTRAKER_CREDENTIAL_STORE",
    "CONTENTTRAKER_CREDENTIAL_PROFILE",
    "CONTENTTRAKER_ALLOW_EPHEMERAL_PRODUCTION",
    "CONTENTTRAKER_API_BASE_URL",
    "CONTENTTRAKER_STAGING_API_BASE_URL",
    "CONTENTTRAKER_PRODUCTION_API_BASE_URL",
    "CONTENTTRAKER_OAUTH_RESOURCE",
    "CONTENTTRAKER_STAGING_OAUTH_RESOURCE",
    "CONTENTTRAKER_PRODUCTION_OAUTH_RESOURCE",
    "CONTENTTRAKER_OAUTH_ISSUER",
    "CONTENTTRAKER_STAGING_OAUTH_ISSUER",
    "CONTENTTRAKER_PRODUCTION_OAUTH_ISSUER",
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
