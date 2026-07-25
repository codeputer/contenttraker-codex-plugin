import assert from "node:assert/strict";

import { EnvironmentContentTrakerApiClient } from "../src/contenttraker-api-client.js";
import type { ContentTrakerServerApiClient, JsonResponse } from "../src/contenttraker-server-api-client.js";
import { resolveContextFromRegistry } from "../src/workspace-registry.js";
import type {
  ContentTrakerContext,
  ContentTrakerRequestSecurityContext,
  RegistrySnapshot,
} from "../src/types.js";

const apiOrigin = "https://mcp.staging.contenttraker.com";
const originalEnvironment = { ...process.env };
Object.assign(process.env, {
  CONTENTTRAKER_ENVIRONMENT: "staging",
  CONTENTTRAKER_STAGING_API_BASE_URL: apiOrigin,
  CONTENTTRAKER_AUTH_MODE: "delegated",
});
delete process.env.CONTENTTRAKER_CREDENTIAL_PROFILE;
delete process.env.CONTENTTRAKER_REQUIRED_USER_EMAIL;
delete process.env.CONTENTTRAKER_REQUIRE_IDENTITY_POLICY;

function explicitWorkspaceDoesNotBecomeProjectIdentity(): void {
  const context = resolveContextFromRegistry(
    { workspaceName: "Requested Workspace" },
    registry(),
  );
  assert.deepEqual(context, {
    environment: "staging",
    workspaceName: "Requested Workspace",
    workspaceId: undefined,
    workspaceKey: undefined,
    source: "explicit-workspace",
  });
  assert.equal(context?.projectName, undefined);
}

function explicitWorkspaceWinsRegistryMapping(): void {
  const context = resolveContextFromRegistry(
    { projectName: "LocalProject", workspaceName: "Requested Workspace" },
    registry(),
  );
  assert.equal(context?.source, "explicit-workspace");
  assert.equal(context?.workspaceName, "Requested Workspace");
  assert.equal(context?.workspaceId, undefined);
  assert.equal(context?.projectId, undefined);
}

function matchingExplicitWorkspaceStillWinsOptionalRegistryProvenance(): void {
  const context = resolveContextFromRegistry(
    { projectName: "LocalProject", workspaceId: "workspace-registry", workspaceName: "Stale Display Name" },
    registry(),
  );
  assert.equal(context?.source, "explicit-workspace");
  assert.equal(context?.workspaceId, "workspace-registry");
  assert.equal(context?.projectId, undefined);
}

function explicitWorkspaceWinsCorruptRegistry(): void {
  const context = resolveContextFromRegistry(
    { projectName: "LocalProject", workspaceId: "workspace-explicit" },
    {
      path: "memory://corrupt-registry.json",
      exists: true,
      loaded: false,
      environment: "staging",
      environmentConfigured: false,
      projectCount: 0,
      errors: ["invalid JSON"],
    },
  );
  assert.equal(context?.source, "explicit-workspace");
  assert.equal(context?.workspaceId, "workspace-explicit");
}

async function unauthorizedWorkspacePreventsWrite(): Promise<void> {
  const server = new FakeServerApiClient(["workspace-authorized"]);
  const client = new EnvironmentContentTrakerApiClient(fakeTokenProvider() as never, server);
  const result = await client.createDigitalAsset(createInput(), explicitContext("workspace-denied"), security());
  assert.equal(result.status, "failed");
  assert.match(result.diagnostics.join(" "), /workspaceId is not authorized/);
  assert.equal(server.postCount, 0);
}

async function currentUserReturnsAuthenticationRequired(): Promise<void> {
  const server = new FakeServerApiClient(["workspace-authorized"]);
  const provider = fakeTokenProvider();
  provider.getAuthorizationHeader = async () => {
    throw new Error("authentication_required: call begin_contenttraker_login, then poll_contenttraker_login, before retrying this operation.");
  };
  const client = new EnvironmentContentTrakerApiClient(provider as never, server);
  const result = await client.getCurrentUser(security());
  assert.equal(result.status, "authentication_required");
  assert.match(String((result.diagnostics as string[])[0]), /begin_contenttraker_login/);
  assert.equal(server.getCount, 0);
}

async function conflictPreventsAnyApiCall(): Promise<void> {
  const server = new FakeServerApiClient(["workspace-authorized"]);
  const client = new EnvironmentContentTrakerApiClient(fakeTokenProvider() as never, server);
  const context: ContentTrakerContext = {
    source: "workspace-conflict",
    workspaceConflict: {
      explicit: { workspaceId: "workspace-explicit", source: "explicit-workspace" },
      registry: { workspaceId: "workspace-registry", source: "registry-project" },
    },
  };
  const result = await client.createDigitalAsset(createInput(), context, security());
  assert.equal(result.status, "blocked");
  assert.match(result.diagnostics.join(" "), /workspace_conflict/);
  assert.equal(server.getCount + server.postCount, 0);
}

async function authorizedDraftCreationRemainsIdempotent(): Promise<void> {
  const server = new FakeServerApiClient(["workspace-authorized"]);
  const client = new EnvironmentContentTrakerApiClient(fakeTokenProvider() as never, server);
  const result = await client.createDigitalAsset(createInput(), explicitContext("workspace-authorized"), security());
  assert.equal(result.status, "idempotent-replay");
  assert.equal(result.asset?.status, "draft");
  assert.equal(server.postCount, 1);
  assert.equal((server.lastBody as Record<string, unknown>).idempotencyKey, "workspace-safety-idempotency");
  assert.equal((server.lastBody as Record<string, unknown>).status, "draft");
}

async function authorizedContextResolutionCanonicalizesProjectMembership(): Promise<void> {
  const server = new FakeServerApiClient(["workspace-authorized"], ["project-authorized"]);
  const client = new EnvironmentContentTrakerApiClient(fakeTokenProvider() as never, server);
  const result = await client.resolveAuthorizedContext({
    environment: "staging",
    workspaceId: "workspace-authorized",
    projectId: "project-authorized",
    source: "worktree-marker",
  }, security());
  assert.equal(result.status, "ready");
  assert.equal(result.selectedContext?.workspaceId, "workspace-authorized");
  assert.equal(result.selectedContext?.projectId, "project-authorized");
  assert.equal(result.selectedContext?.source, "worktree-marker");
}

async function staleProjectResolutionFailsClosed(): Promise<void> {
  const server = new FakeServerApiClient(["workspace-authorized"], ["another-project"]);
  const client = new EnvironmentContentTrakerApiClient(fakeTokenProvider() as never, server);
  const result = await client.resolveAuthorizedContext({
    environment: "staging",
    workspaceId: "workspace-authorized",
    projectId: "project-stale",
    source: "worktree-marker",
  }, security());
  assert.equal(result.status, "blocked");
  assert.equal(result.selectedContext, undefined);
  assert.match(result.diagnostics.join(" "), /context_project_not_authorized/);
}

function registry(): RegistrySnapshot {
  return {
    path: "memory://workspace-registry.json",
    exists: true,
    loaded: true,
    environment: "staging",
    environmentConfigured: true,
    projectCount: 1,
    errors: [],
    documentVersion: 2,
    document: {
      version: 2,
      environments: {
        staging: {
          defaults: { workspaceName: "Default Workspace", workspaceId: "workspace-default" },
          projects: [{
            projectName: "LocalProject",
            workspaceName: "Registry Workspace",
            workspaceId: "workspace-registry",
            contentTrakerProjectName: "Optional Provenance",
            contentTrakerProjectId: "project-provenance",
          }],
        },
        production: { projects: [] },
      },
    },
    environmentDocument: {
      defaults: { workspaceName: "Default Workspace", workspaceId: "workspace-default" },
      projects: [{
        projectName: "LocalProject",
        workspaceName: "Registry Workspace",
        workspaceId: "workspace-registry",
        contentTrakerProjectName: "Optional Provenance",
        contentTrakerProjectId: "project-provenance",
      }],
    },
  };
}

function fakeTokenProvider(): Record<string, unknown> {
  return {
    getStatus: () => ({
      mode: "delegated-user-pkce",
      configured: true,
      accessTokenPresent: true,
      source: "test",
      tokenExpiryStatus: "valid",
    }),
    getAuthorizationHeader: async () => ({
      authorizationHeader: "Bearer test-only",
      environment: "staging",
      authorityIssuer: "https://tokenbroker.staging.contenttraker.com",
      tokenIssuer: "test-issuer",
      subjectId: "test-user",
      audience: apiOrigin,
      expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
      credentialHandle: "delegated-test",
      credentialVersion: "test-version",
      authenticationMode: "delegated-user-pkce",
    }),
    getSecurityDiagnostics: (context: ContentTrakerRequestSecurityContext) => ({
      environment: context.environment,
      authenticationMode: "delegated-user-pkce",
      connectionId: context.connectionId,
      sessionId: context.sessionId,
      requestId: context.requestId,
      tokenAudience: context.tokenAudience,
      tokenExpiryStatus: "valid",
      correlationId: context.correlationId,
      effectiveCallerVerified: false,
    }),
    recordEffectiveCaller: () => undefined,
  };
}

class FakeServerApiClient implements ContentTrakerServerApiClient {
  getCount = 0;
  postCount = 0;
  lastBody: unknown;

  constructor(
    private readonly workspaceIds: string[],
    private readonly projectIds: string[] = [],
  ) {}

  async getJson(_baseUrl: string, path: string): Promise<JsonResponse> {
    this.getCount += 1;
    if (path === "/me") return response({ appUserId: "test-user", email: "operator@example.org" });
    if (path === "/workspaces") return response({ workspaces: this.workspaceIds.map((id) => ({ id })) });
    if (path === "/workspaces/workspace-authorized/projects") {
      return response({ projects: this.projectIds.map((id) => ({ id })) });
    }
    return response({}, 404);
  }

  async postJson(_baseUrl: string, _path: string, _authorization: string, body: unknown): Promise<JsonResponse> {
    this.postCount += 1;
    this.lastBody = body;
    return response({
      digitalAssetId: "asset-test",
      workspaceId: "workspace-authorized",
      status: "draft",
      operation: "idempotent-replay",
    });
  }

  async putJson(): Promise<JsonResponse> { return response({}, 501); }
}

function response(json: unknown, statusCode = 200): JsonResponse {
  return { ok: statusCode >= 200 && statusCode < 300, statusCode, json, correlationId: "test-correlation" };
}

function explicitContext(workspaceId: string): ContentTrakerContext {
  return { environment: "staging", workspaceId, source: "explicit-workspace" };
}

function createInput() {
  return {
    workspaceId: "workspace-authorized",
    title: "Workspace safety test",
    digitalAssetType: "document",
    content: "test",
    userApprovalStatement: "Unit-test approval only",
    idempotencyKey: "workspace-safety-idempotency",
  };
}

function security(): ContentTrakerRequestSecurityContext {
  return {
    environment: "staging",
    connectionId: "test-connection",
    sessionId: "test-session",
    requestId: "test-request",
    correlationId: "test-correlation",
    tokenAudience: apiOrigin,
  };
}

try {
  explicitWorkspaceDoesNotBecomeProjectIdentity();
  explicitWorkspaceWinsRegistryMapping();
  matchingExplicitWorkspaceStillWinsOptionalRegistryProvenance();
  explicitWorkspaceWinsCorruptRegistry();
  await currentUserReturnsAuthenticationRequired();
  await unauthorizedWorkspacePreventsWrite();
  await conflictPreventsAnyApiCall();
  await authorizedDraftCreationRemainsIdempotent();
  await authorizedContextResolutionCanonicalizesProjectMembership();
  await staleProjectResolutionFailsClosed();
  console.log("ContentTraker workspace safety tests passed.");
} finally {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnvironment)) delete process.env[key];
  }
  Object.assign(process.env, originalEnvironment);
}
