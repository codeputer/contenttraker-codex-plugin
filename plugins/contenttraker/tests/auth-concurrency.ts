import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { EnvironmentContentTrakerApiClient } from "../src/contenttraker-api-client.js";
import type { ContentTrakerServerApiClient, JsonResponse } from "../src/contenttraker-server-api-client.js";
import type { SecureCredentialStore } from "../src/credential-store.js";
import type { OAuthTokenResponse } from "../src/oauth-client.js";
import {
  createContentTrakerTokenProvider,
  DelegatedContentTrakerTokenProvider,
  type ContentTrakerAuthorizationSnapshot,
} from "../src/token-provider.js";
import type { ContentTrakerContext, ContentTrakerRequestSecurityContext } from "../src/types.js";

const audience = "https://mcp.staging.contenttraker.com";
process.env.CONTENTTRAKER_ENVIRONMENT = "staging";
process.env.CONTENTTRAKER_STAGING_API_BASE_URL = "https://mcp.staging.contenttraker.com";

async function concurrentUsersRetainDistinctCallerIdentity(): Promise<void> {
  const store = new MemoryCredentialStore();
  const providerA = new DelegatedContentTrakerTokenProvider(
    store,
    new FakeOAuthClient(new Map([["connection-a", "user-a"]])) as never,
    delegatedEnv({ CONTENTTRAKER_CREDENTIAL_PROFILE: "user-a" }),
  );
  const providerB = new DelegatedContentTrakerTokenProvider(
    store,
    new FakeOAuthClient(new Map([["connection-b", "user-b"]])) as never,
    delegatedEnv({ CONTENTTRAKER_CREDENTIAL_PROFILE: "user-b" }),
  );
  const overlap = new Barrier(2);
  const server = new RecordingServerApiClient(overlap);
  const clientA = new EnvironmentContentTrakerApiClient(providerA, server);
  const clientB = new EnvironmentContentTrakerApiClient(providerB, server);
  const contextA = security("connection-a", "session-a", "request-a");
  const contextB = security("connection-b", "session-b", "request-b");
  await Promise.all([
    providerA.getAuthorizationHeader(contextA),
    providerB.getAuthorizationHeader(contextB),
  ]);

  const [resultA, resultB] = await Promise.all([
    clientA.probeReadiness(undefined, contextA),
    clientB.probeReadiness(undefined, contextB),
  ]);

  assert.equal(resultA.status, "ready");
  assert.equal(resultB.status, "ready");
  assert.equal(resultA.api.security?.authenticatedSubjectId, "user-a");
  assert.equal(resultB.api.security?.authenticatedSubjectId, "user-b");
  assert.notEqual(resultA.api.security?.credentialHandle, resultB.api.security?.credentialHandle);
  assert.ok(overlap.arrivals >= 2);
}

async function sameUserSessionsRemainIsolated(): Promise<void> {
  const oauth = new FakeOAuthClient(new Map([["connection-c", "shared-user"], ["connection-d", "shared-user"]]));
  const provider = new DelegatedContentTrakerTokenProvider(new MemoryCredentialStore(), oauth as never, delegatedEnv());
  const contextC = security("connection-c", "session-c", "request-c");
  const contextD = security("connection-d", "session-d", "request-d");
  const [first, second] = await Promise.all([
    provider.getAuthorizationHeader(contextC),
    provider.getAuthorizationHeader(contextD),
  ]);

  assert.equal(first.subjectId, second.subjectId);
  assert.equal(first.credentialHandle, second.credentialHandle);
  assert.notEqual(first.authorizationHeader, second.authorizationHeader);

  const overlap = new Barrier(2);
  const server = new RecordingServerApiClient(overlap, "/digital-assets/types");
  const client = new EnvironmentContentTrakerApiClient(provider, server);
  await Promise.all([
    client.listDigitalAssetTypes({}, workspace("same-user-workspace-one"), { ...contextC, requestId: "same-user-one" }),
    client.listDigitalAssetTypes({}, workspace("same-user-workspace-two"), { ...contextD, requestId: "same-user-two" }),
  ]);
  assert.equal(server.requests.some((request) => request.path.includes("same-user-workspace-one")), true);
  assert.equal(server.requests.some((request) => request.path.includes("same-user-workspace-two")), true);
  const businessRequests = server.requests.filter((request) => request.path.includes("/digital-assets/types"));
  assert.equal(new Set(businessRequests.map((request) => subjectFromAuthorization(request.authorization))).size, 1);
  assert.equal(new Set(businessRequests.map((request) => request.authorization)).size, 2);
}

async function workspaceAndIdentityNeverCross(): Promise<void> {
  const store = new MemoryCredentialStore();
  const providerA = new DelegatedContentTrakerTokenProvider(
    store,
    new FakeOAuthClient(new Map([["connection-e", "user-e"]])) as never,
    delegatedEnv({ CONTENTTRAKER_CREDENTIAL_PROFILE: "user-e" }),
  );
  const providerB = new DelegatedContentTrakerTokenProvider(
    store,
    new FakeOAuthClient(new Map([["connection-f", "user-f"]])) as never,
    delegatedEnv({ CONTENTTRAKER_CREDENTIAL_PROFILE: "user-f" }),
  );
  const overlap = new Barrier(2);
  const server = new RecordingServerApiClient(overlap, "/digital-assets/types");
  const clientA = new EnvironmentContentTrakerApiClient(providerA, server);
  const clientB = new EnvironmentContentTrakerApiClient(providerB, server);
  const workspaceA = workspace("workspace-a");
  const workspaceB = workspace("workspace-b");
  const securityA = security("connection-e", "session-e", "request-e");
  const securityB = security("connection-f", "session-f", "request-f");
  await Promise.all([
    providerA.getAuthorizationHeader(securityA),
    providerB.getAuthorizationHeader(securityB),
  ]);

  await Promise.all([
    clientA.listDigitalAssetTypes({}, workspaceA, securityA),
    clientB.listDigitalAssetTypes({}, workspaceB, securityB),
  ]);

  const requestA = server.requests.find((request) => request.path.includes("workspace-a"));
  const requestB = server.requests.find((request) => request.path.includes("workspace-b"));
  assert.equal(subjectFromAuthorization(requestA?.authorization), "user-e");
  assert.equal(subjectFromAuthorization(requestB?.authorization), "user-f");

  const sameWorkspaceServer = new RecordingServerApiClient(new Barrier(2), "/digital-assets/types");
  const sameWorkspaceClientA = new EnvironmentContentTrakerApiClient(providerA, sameWorkspaceServer);
  const sameWorkspaceClientB = new EnvironmentContentTrakerApiClient(providerB, sameWorkspaceServer);
  await Promise.all([
    sameWorkspaceClientA.listDigitalAssetTypes({}, workspaceA, securityA),
    sameWorkspaceClientB.listDigitalAssetTypes({}, workspaceA, securityB),
  ]);
  assert.deepEqual(
    new Set(sameWorkspaceServer.requests.map((request) => subjectFromAuthorization(request.authorization))),
    new Set(["user-e", "user-f"]),
  );
}

async function oneSessionRefreshAndRevocationDoNotAffectAnother(): Promise<void> {
  const store = new MemoryCredentialStore();
  const oauthA = new FakeOAuthClient(new Map([["connection-g", "user-g"]]));
  const oauthB = new FakeOAuthClient(new Map([["connection-h", "user-h"]]));
  const providerA = new DelegatedContentTrakerTokenProvider(
    store,
    oauthA as never,
    delegatedEnv({ CONTENTTRAKER_CREDENTIAL_PROFILE: "user-g" }),
  );
  const providerB = new DelegatedContentTrakerTokenProvider(
    store,
    oauthB as never,
    delegatedEnv({ CONTENTTRAKER_CREDENTIAL_PROFILE: "user-h" }),
  );
  const contextA = security("connection-g", "session-g", "request-g");
  const contextB = security("connection-h", "session-h", "request-h");
  const initialA = await providerA.getAuthorizationHeader(contextA);
  const initialB = await providerB.getAuthorizationHeader(contextB);

  const [refreshedA, unchangedB] = await Promise.all([
    providerA.getAuthorizationHeader(contextA, { forceRefresh: true }),
    providerB.getAuthorizationHeader(contextB),
  ]);
  assert.notEqual(refreshedA.authorizationHeader, initialA.authorizationHeader);
  assert.equal(unchangedB.authorizationHeader, initialB.authorizationHeader);
  assert.equal(oauthA.refreshCounts.get("connection-g"), 1);
  assert.equal(oauthB.refreshCounts.get("connection-h") ?? 0, 0);

  oauthA.revokedConnections.add("connection-g");
  await assert.rejects(() => providerA.getAuthorizationHeader(contextA, { forceRefresh: true }), /revoked/);
  const stillValidB = await providerB.getAuthorizationHeader(contextB);
  assert.equal(stillValidB.authorizationHeader, initialB.authorizationHeader);
}

async function inFlightRequestRetainsCapturedCredential(): Promise<void> {
  const oauth = new FakeOAuthClient(new Map([["connection-i", "user-i"]]));
  const provider = new DelegatedContentTrakerTokenProvider(new MemoryCredentialStore(), oauth as never, delegatedEnv());
  const reachedTransport = new Deferred<void>();
  const releaseTransport = new Deferred<void>();
  const server = new HoldingServerApiClient(reachedTransport, releaseTransport);
  const client = new EnvironmentContentTrakerApiClient(provider, server);
  const context = security("connection-i", "session-i", "request-i");
  const selectedWorkspace = workspace("workspace-i");
  await provider.getAuthorizationHeader(context);

  const request = client.listDigitalAssetTypes({}, selectedWorkspace, context);
  await reachedTransport.promise;
  const refreshed = await provider.getAuthorizationHeader(context, { forceRefresh: true });
  releaseTransport.resolve();
  await request;

  assert.equal(server.capturedAuthorization, server.authorizationAtRequestStart);
  assert.notEqual(server.capturedAuthorization, refreshed.authorizationHeader);
}

async function environmentIsolationAndNoInteractiveFallback(): Promise<void> {
  const env = delegatedEnv();
  const provider = createContentTrakerTokenProvider(env, new MemoryCredentialStore(), new FakeOAuthClient(new Map()) as never);
  const status = provider.getStatus(security("connection-j", "session-j", "request-j"));
  assert.equal(status.mode, "delegated-user-pkce");
  assert.equal(status.accessTokenPresent, false);

  const oauth = new FakeOAuthClient(new Map([["connection-j", "user-j"]]));
  const delegated = new DelegatedContentTrakerTokenProvider(new MemoryCredentialStore(), oauth as never, delegatedEnv());
  await assert.rejects(
    () => delegated.getAuthorizationHeader({ ...security("connection-j", "session-j", "request-j"), environment: "production", tokenAudience: "https://mcp.prod.contenttraker.com" }),
    /immutable adapter environment/,
  );

  const legacyService = createContentTrakerTokenProvider({
    CONTENTTRAKER_AUTH_MODE: "service",
    CONTENTTRAKER_ENVIRONMENT: "production",
  });
  assert.equal(legacyService.getStatus().mode, "invalid");
  await assert.rejects(
    () => legacyService.getAuthorizationHeader(security("legacy-connection", "legacy-session", "legacy-request")),
    /Legacy service bearer-token configuration is not supported/,
  );

  const automaticWorkload = createContentTrakerTokenProvider({
    CONTENTTRAKER_ENVIRONMENT: "staging",
    CONTENTTRAKER_CONTAINER: "true",
  });
  assert.equal(automaticWorkload.getStatus().mode, "workload-oauth");
  assert.equal((await automaticWorkload.getAuthorizationStatus(
    security("auto-container-connection", "auto-container-session", "auto-container-request"),
  )).status, "blocked");
}

async function effectiveCallerVerificationAndAudienceBindingAreMandatory(): Promise<void> {
  const oauth = new FakeOAuthClient(new Map([["connection-origin", "user-origin"]]));
  const provider = new DelegatedContentTrakerTokenProvider(new MemoryCredentialStore(), oauth as never, delegatedEnv());
  const server = new RecordingServerApiClient();
  const client = new EnvironmentContentTrakerApiClient(provider, server);
  const context = security("connection-origin", "session-origin", "request-origin");
  await provider.getAuthorizationHeader(context);
  const result = await client.listDigitalAssetTypes({}, workspace("workspace-origin"), context);

  assert.equal(result.status, "ready");
  assert.deepEqual(server.requests.map((request) => request.path), [
    "/me",
    "/workspaces/workspace-origin/digital-assets/types",
  ]);
  assert.equal(server.requests[0]?.authorization, server.requests[1]?.authorization);
  assert.equal(result.api.security?.effectiveCallerVerified, true);
  assert.equal(result.api.security?.authenticatedSubjectId, "user-origin");

  const originalBaseUrl = process.env.CONTENTTRAKER_STAGING_API_BASE_URL;
  process.env.CONTENTTRAKER_STAGING_API_BASE_URL = "https://wrong-origin.example";
  try {
    const blockedServer = new RecordingServerApiClient();
    const blockedClient = new EnvironmentContentTrakerApiClient(provider, blockedServer);
    const blocked = await blockedClient.listDigitalAssetTypes({}, workspace("workspace-origin"), context);
    assert.equal(blocked.status, "failed");
    assert.equal(blockedServer.requests.length, 0);
    assert.match(blocked.diagnostics.join(" "), /exactly match the credential audience origin/);
  } finally {
    if (originalBaseUrl === undefined) delete process.env.CONTENTTRAKER_STAGING_API_BASE_URL;
    else process.env.CONTENTTRAKER_STAGING_API_BASE_URL = originalBaseUrl;
  }
}

async function secretsAreRedactedAndUnsupportedModesFailClosed(): Promise<void> {
  const oauth = new FakeOAuthClient(new Map([["connection-k", "user-k"]]));
  const provider = new DelegatedContentTrakerTokenProvider(new MemoryCredentialStore(), oauth as never, delegatedEnv());
  const throwingServer = new ThrowingServerApiClient("Authorization: Bearer raw-token refresh_token=raw-refresh cookie=raw-cookie");
  const client = new EnvironmentContentTrakerApiClient(provider, throwingServer);
  const context = security("connection-k", "session-k", "request-k");
  await provider.getAuthorizationHeader(context);
  const result = await client.listDigitalAssetTypes({}, workspace("workspace-k"), context);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("raw-token"), false);
  assert.equal(serialized.includes("raw-refresh"), false);
  assert.equal(serialized.includes("raw-cookie"), false);
  assert.equal(serialized.includes("[REDACTED]"), true);

  const workload = createContentTrakerTokenProvider({
    CONTENTTRAKER_AUTH_MODE: "workload",
    CONTENTTRAKER_ENVIRONMENT: "staging",
  });
  assert.equal(workload.getStatus().mode, "workload-oauth");
  assert.equal(workload.getStatus().accessTokenPresent, false);
  await assert.rejects(
    () => workload.getAuthorizationHeader(security("workload-connection", "workload-session", "workload-request")),
    /workload OAuth is unavailable/,
  );
  assert.equal((await workload.beginAuthorization(security("workload-connection", "workload-session", "workload-request"))).status, "blocked");
}

async function parallelRefreshUsesSingleFlight(): Promise<void> {
  const oauth = new FakeOAuthClient(new Map([["connection-l", "user-l"]]));
  oauth.refreshDelayMs = 30;
  const provider = new DelegatedContentTrakerTokenProvider(new MemoryCredentialStore(), oauth as never, delegatedEnv());
  const context = security("connection-l", "session-l", "request-l");
  await provider.getAuthorizationHeader(context);

  const results = await Promise.all(Array.from({ length: 12 }, () =>
    provider.getAuthorizationHeader(context, { forceRefresh: true })));
  assert.equal(oauth.refreshCounts.get("connection-l"), 1);
  assert.equal(new Set(results.map((result) => result.authorizationHeader)).size, 1);
}

async function parallelUnauthorizedRetriesUseOneRefresh(): Promise<void> {
  const oauth = new FakeOAuthClient(new Map([["connection-m", "user-m"]]));
  oauth.refreshDelayMs = 30;
  const provider = new DelegatedContentTrakerTokenProvider(new MemoryCredentialStore(), oauth as never, delegatedEnv());
  const server = new UnauthorizedUntilRefreshServer(new Barrier(8));
  const client = new EnvironmentContentTrakerApiClient(provider, server);
  await provider.getAuthorizationHeader(security("connection-m", "session-m", "authorize"));

  const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    client.listDigitalAssetTypes(
      {},
      workspace("workspace-m"),
      security("connection-m", "session-m", `retry-${index}`),
    )));

  assert.equal(results.every((result) => result.status === "ready"), true);
  assert.equal(oauth.refreshCounts.get("connection-m"), 1);
}

class MemoryCredentialStore implements SecureCredentialStore {
  readonly values = new Map<string, string>();
  async get(handle: string): Promise<string | undefined> { return this.values.get(handle); }
  async set(handle: string, secret: string): Promise<void> { this.values.set(handle, secret); }
  async delete(handle: string): Promise<void> { this.values.delete(handle); }
}

class FakeOAuthClient {
  readonly refreshCounts = new Map<string, number>();
  readonly revokedConnections = new Set<string>();
  refreshDelayMs = 0;
  private readonly generations = new Map<string, number>();

  constructor(private readonly subjects: Map<string, string>) {}

  async authorize(context: ContentTrakerRequestSecurityContext): Promise<OAuthTokenResponse> {
    return this.response(context, 0);
  }

  async refresh(_refreshToken: string, context: ContentTrakerRequestSecurityContext): Promise<OAuthTokenResponse> {
    if (this.revokedConnections.has(context.connectionId)) throw new Error("session credential revoked");
    this.refreshCounts.set(context.connectionId, (this.refreshCounts.get(context.connectionId) ?? 0) + 1);
    if (this.refreshDelayMs) await delay(this.refreshDelayMs);
    const generation = (this.generations.get(context.connectionId) ?? 0) + 1;
    this.generations.set(context.connectionId, generation);
    return this.response(context, generation);
  }

  private response(context: ContentTrakerRequestSecurityContext, generation: number): OAuthTokenResponse {
    const subject = this.subjects.get(context.connectionId);
    if (!subject) throw new Error(`No fake subject for ${context.connectionId}.`);
    return {
      accessToken: jwt(subject, context.tokenAudience, context.connectionId, generation),
      refreshToken: `refresh-${context.connectionId}-${generation}`,
      expiresInSeconds: 3600,
      scope: "workspaces:read digital_assets:read digital_assets:write",
      resource: context.tokenAudience,
    };
  }
}

class RecordingServerApiClient implements ContentTrakerServerApiClient {
  readonly requests: Array<{ method: string; path: string; authorization: string; correlationId: string }> = [];
  constructor(private readonly overlap?: Barrier, private readonly overlapPath = "/me") {}

  async getJson(_baseUrl: string, path: string, authorization: string, correlationId: string): Promise<JsonResponse> {
    this.requests.push({ method: "GET", path, authorization, correlationId });
    if (this.overlap && path.includes(this.overlapPath)) await this.overlap.wait();
    const subject = subjectFromAuthorization(authorization);
    if (path === "/me") return ok({ appUserId: subject }, correlationId);
    if (path === "/workspaces") return ok({ workspaces: [] }, correlationId);
    if (path.endsWith("/digital-assets/types")) return ok({ digitalAssetTypes: [], correlationId }, correlationId);
    return ok({}, correlationId);
  }
  async postJson(_baseUrl: string, path: string, authorization: string, _body: unknown, correlationId: string): Promise<JsonResponse> {
    this.requests.push({ method: "POST", path, authorization, correlationId });
    return ok({}, correlationId);
  }
  async putJson(_baseUrl: string, path: string, authorization: string, _body: unknown, correlationId: string): Promise<JsonResponse> {
    this.requests.push({ method: "PUT", path, authorization, correlationId });
    return ok({}, correlationId);
  }
}

class HoldingServerApiClient extends RecordingServerApiClient {
  capturedAuthorization?: string;
  authorizationAtRequestStart?: string;
  constructor(private readonly reached: Deferred<void>, private readonly release: Deferred<void>) { super(); }
  override async getJson(baseUrl: string, path: string, authorization: string, correlationId: string): Promise<JsonResponse> {
    this.authorizationAtRequestStart = authorization;
    this.reached.resolve();
    await this.release.promise;
    this.capturedAuthorization = authorization;
    return await super.getJson(baseUrl, path, authorization, correlationId);
  }
}

class ThrowingServerApiClient extends RecordingServerApiClient {
  constructor(private readonly message: string) { super(); }
  override async getJson(): Promise<JsonResponse> { throw new Error(this.message); }
}

class UnauthorizedUntilRefreshServer extends RecordingServerApiClient {
  constructor(private readonly unauthorizedBarrier: Barrier) { super(); }
  override async getJson(_baseUrl: string, path: string, authorization: string, correlationId: string): Promise<JsonResponse> {
    if (tokenGeneration(authorization) === 0) {
      await this.unauthorizedBarrier.wait();
      return { ok: false, statusCode: 401, json: undefined, correlationId };
    }
    if (path === "/me") return ok({ appUserId: subjectFromAuthorization(authorization) }, correlationId);
    return ok({ digitalAssetTypes: [] }, correlationId);
  }
}

class Barrier {
  arrivals = 0;
  private readonly released = new Deferred<void>();
  constructor(private readonly participants: number) {}
  async wait(): Promise<void> {
    this.arrivals += 1;
    if (this.arrivals === this.participants) this.released.resolve();
    await this.released.promise;
  }
}

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;
  reject!: (reason?: unknown) => void;
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
  }
}

function security(connectionId: string, sessionId: string, requestId: string): ContentTrakerRequestSecurityContext {
  return { environment: "staging", connectionId, sessionId, requestId, correlationId: `correlation-${requestId}`, tokenAudience: audience };
}

function workspace(workspaceId: string): ContentTrakerContext {
  return { environment: "staging", workspaceId, source: "registry-project" };
}

function delegatedEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CONTENTTRAKER_AUTH_MODE: "delegated",
    CONTENTTRAKER_ENVIRONMENT: "staging",
    CONTENTTRAKER_TOKEN_ISSUER_SHA256: createHash("sha256").update("public-test-issuer").digest("hex"),
    ...overrides,
  };
}

function jwt(subject: string, tokenAudience: string, connectionId: string, generation: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    iss: "public-test-issuer",
    aud: tokenAudience,
    exp: Math.floor(Date.now() / 1000) + 3600,
    appUserId: subject,
    Environment: "staging",
    auth_method: "oauth",
    client_type: "codex",
    connection_test: connectionId,
    generation,
  })}.test-signature`;
}

function subjectFromAuthorization(authorization?: string): string | undefined {
  if (!authorization) return undefined;
  const token = authorization.replace(/^Bearer\s+/i, "");
  const payload = token.split(".")[1];
  return payload ? JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).appUserId : undefined;
}

function tokenGeneration(authorization: string): number {
  const token = authorization.replace(/^Bearer\s+/i, "");
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  return payload.generation;
}

function ok(json: unknown, correlationId: string): JsonResponse {
  return { ok: true, statusCode: 200, json, correlationId };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

await concurrentUsersRetainDistinctCallerIdentity();
await sameUserSessionsRemainIsolated();
await workspaceAndIdentityNeverCross();
await oneSessionRefreshAndRevocationDoNotAffectAnother();
await inFlightRequestRetainsCapturedCredential();
await environmentIsolationAndNoInteractiveFallback();
await effectiveCallerVerificationAndAudienceBindingAreMandatory();
await secretsAreRedactedAndUnsupportedModesFailClosed();
await parallelRefreshUsesSingleFlight();
await parallelUnauthorizedRetriesUseOneRefresh();

console.log("ContentTraker delegated-auth concurrency tests passed.");
