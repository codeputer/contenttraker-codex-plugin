import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  createBrowserLauncher,
  resolveBrowserInteraction,
} from "../src/browser-interaction.js";
import type { SecureCredentialStore } from "../src/credential-store.js";
import {
  ContentTrakerOAuthClient,
  type OAuthTokenResponse,
  type OAuthTransport,
} from "../src/oauth-client.js";
import { ContentTrakerOAuthMetadataResolver } from "../src/oauth-metadata.js";
import { DelegatedContentTrakerTokenProvider } from "../src/token-provider.js";
import type { ContentTrakerRequestSecurityContext } from "../src/types.js";

const audience = "https://mcp.staging.contenttraker.com";
const issuer = "https://tokenbroker.staging.contenttraker.com";
const authorizationTimeoutMs = 10_000;
const authorizationStatusWaitMs = 5_000;

const wslEnvironment = {
  CONTENTTRAKER_BROWSER_MODE: "auto",
  WSL_DISTRO_NAME: "Ubuntu",
  DISPLAY: ":0",
};
const nativeSelection = resolveBrowserInteraction(wslEnvironment, {
  platform: "linux",
  kernelRelease: "microsoft-standard-WSL2",
  commandAvailable: (command) => command === "firefox" || command === "xdg-open",
});
assert.equal(nativeSelection.valid, true);
assert.equal(nativeSelection.mode, "wsl-native");
assert.equal(nativeSelection.command, "firefox");

const spawned: Array<{ file: string; args: string[] }> = [];
const nativeLauncher = createBrowserLauncher(wslEnvironment, {
  platform: "linux",
  kernelRelease: "microsoft-standard-WSL2",
  commandAvailable: (command) => command === "firefox" || command === "xdg-open",
  spawnCommand: async (file, args) => { spawned.push({ file, args }); },
});
await nativeLauncher.open(new URL("https://example.test/authorize"));
assert.deepEqual(spawned, [{ file: "firefox", args: ["https://example.test/authorize"] }]);
assert.equal(JSON.stringify(spawned).includes("xdg-open"), false);

const forbiddenWslSystem = resolveBrowserInteraction(
  { ...wslEnvironment, CONTENTTRAKER_BROWSER_MODE: "system" },
  {
    platform: "linux",
    kernelRelease: "microsoft-standard-WSL2",
    commandAvailable: () => true,
  },
);
assert.equal(forbiddenWslSystem.valid, false);
assert.match(forbiddenWslSystem.diagnostics.join(" "), /disabled inside WSL/);

const manualWsl = resolveBrowserInteraction(wslEnvironment, {
  platform: "linux",
  kernelRelease: "microsoft-standard-WSL2",
  commandAvailable: (command) => command === "xdg-open",
});
assert.equal(manualWsl.valid, true);
assert.equal(manualWsl.mode, "manual-url");

const invalidMode = resolveBrowserInteraction(
  { CONTENTTRAKER_BROWSER_MODE: "windows-please" },
  { platform: "win32", commandAvailable: () => true },
);
assert.equal(invalidMode.valid, false);
assert.equal(invalidMode.requestedMode, "invalid");

async function manualAuthorizationCompletesAndStoresCredential(): Promise<void> {
  const store = new MemoryCredentialStore();
  const transport = new RecordingOAuthTransport();
  const provider = providerFor(store, transport, authorizationTimeoutMs);
  const context = security("manual-connection", "manual-session");

  const first = await provider.beginAuthorization(context);
  const second = await provider.beginAuthorization(context);
  assert.equal(first.status, "pending");
  assert.equal(first.interaction, "manual-url");
  assert.equal(second.authorizationUrl, first.authorizationUrl);
  assert.equal(second.redirectUri, first.redirectUri);
  assert.equal(JSON.stringify(first).includes("code_verifier"), false);
  assert.equal(JSON.stringify(first).includes("refresh-token"), false);

  await completeCallback(first, "manual-code");
  const completed = await provider.getAuthorizationStatus(context, authorizationStatusWaitMs);
  assert.equal(completed.status, "authorized");
  assert.equal(completed.authorizationUrl, undefined);
  assert.equal(transport.exchangeCount, 1);
  assert.equal(store.values.size, 1);
  const stored = JSON.parse([...store.values.values()][0] ?? "{}") as Record<string, unknown>;
  assert.equal(stored.refreshToken, "refresh-token-manual-code");
  assert.equal(stored.clientId, "codex-mcp");
  assert.equal(stored.profile, "default");
  assert.equal(JSON.stringify(first).includes("refresh-token-manual-code"), false);

  const credential = await provider.getAuthorizationHeader(context);
  assert.equal(credential.subjectId, "user-manual");
  assert.equal(credential.audience, audience);
  const cancelAfterAuthorization = await provider.cancelAuthorization(context);
  assert.equal(cancelAfterAuthorization.status, "authorized");
}

async function manualAuthorizationCanBeCancelled(): Promise<void> {
  const provider = providerFor(new MemoryCredentialStore(), new RecordingOAuthTransport(), 2_000);
  const context = security("cancel-connection", "cancel-session");
  const pending = await provider.beginAuthorization(context);
  assert.equal(pending.status, "pending");

  const cancelled = await provider.cancelAuthorization(context);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.authorizationUrl, undefined);
  const status = await provider.getAuthorizationStatus(context);
  assert.equal(status.status, "cancelled");
}

async function manualAuthorizationExpires(): Promise<void> {
  const provider = providerFor(new MemoryCredentialStore(), new RecordingOAuthTransport(), 20);
  const context = security("expiry-connection", "expiry-session");
  await provider.beginAuthorization(context);
  const expired = await provider.getAuthorizationStatus(context, 200);
  assert.equal(expired.status, "expired");
  assert.match(expired.diagnostics.join(" "), /expired/);
}

async function authorizationFailuresAreRedacted(): Promise<void> {
  const rawFailure = "raw-access-token raw-refresh-token";
  const provider = providerFor(
    new MemoryCredentialStore(),
    { exchangeToken: async () => { throw new Error(rawFailure); } },
    authorizationTimeoutMs,
  );
  const context = security("failure-connection", "failure-session");
  const pending = await provider.beginAuthorization(context);
  await completeCallback(pending, "failure-code");
  const failed = await provider.getAuthorizationStatus(context, authorizationStatusWaitMs);
  assert.equal(failed.status, "failed");
  assert.equal(JSON.stringify(failed).includes(rawFailure), false);
  assert.equal(JSON.stringify(failed).includes("raw-access-token"), false);
}

async function tokenResponsesMustGrantRequiredScopes(): Promise<void> {
  const provider = providerFor(
    new MemoryCredentialStore(),
    {
      exchangeToken: async () => ({
        accessToken: jwt("scope-user"),
        refreshToken: "scope-refresh-token",
        expiresInSeconds: 3_600,
        scope: "workspaces:read digital_assets:read",
        resource: audience,
      }),
    },
    authorizationTimeoutMs,
  );
  const context = security("scope-connection", "scope-session");
  const pending = await provider.beginAuthorization(context);
  await completeCallback(pending, "scope-code");
  const failed = await provider.getAuthorizationStatus(context, authorizationStatusWaitMs);
  assert.equal(failed.status, "failed");
  assert.equal(JSON.stringify(failed).includes("scope-refresh-token"), false);
}

function providerFor(
  store: SecureCredentialStore,
  transport: OAuthTransport,
  timeoutMs: number,
): DelegatedContentTrakerTokenProvider {
  const environment = delegatedEnvironment();
  const launcher = createBrowserLauncher(
    { CONTENTTRAKER_BROWSER_MODE: "manual" },
    { platform: "linux", kernelRelease: "generic-linux", commandAvailable: () => false },
  );
  const oauthClient = new ContentTrakerOAuthClient(
    issuer,
    launcher,
    transport,
    timeoutMs,
    testMetadataResolver(),
    delegatedEnvironment(),
  );
  return new DelegatedContentTrakerTokenProvider(store, oauthClient, environment);
}

async function completeCallback(
  result: { authorizationUrl?: string; redirectUri?: string },
  code: string,
): Promise<void> {
  assert.ok(result.authorizationUrl);
  assert.ok(result.redirectUri);
  const state = new URL(result.authorizationUrl).searchParams.get("state");
  assert.ok(state);
  const callback = new URL(result.redirectUri);
  callback.searchParams.set("state", state);
  callback.searchParams.set("code", code);
  const response = await fetch(callback);
  assert.equal(response.status, 200);
}

class MemoryCredentialStore implements SecureCredentialStore {
  readonly values = new Map<string, string>();
  async get(handle: string): Promise<string | undefined> { return this.values.get(handle); }
  async set(handle: string, secret: string): Promise<void> { this.values.set(handle, secret); }
  async delete(handle: string): Promise<void> { this.values.delete(handle); }
}

class RecordingOAuthTransport implements OAuthTransport {
  exchangeCount = 0;
  async exchangeToken(_endpoint: URL, parameters: URLSearchParams): Promise<OAuthTokenResponse> {
    this.exchangeCount += 1;
    assert.equal(parameters.get("grant_type"), "authorization_code");
    assert.ok(parameters.get("code_verifier"));
    const code = parameters.get("code") ?? "missing";
    return {
      accessToken: jwt("user-manual"),
      refreshToken: `refresh-token-${code}`,
      expiresInSeconds: 3_600,
      scope: "workspaces:read workspaces:write projects:read projects:write digital_assets:read digital_assets:write digital_assets:review",
      resource: audience,
    };
  }
}

function delegatedEnvironment(): NodeJS.ProcessEnv {
  return {
    CONTENTTRAKER_ENVIRONMENT: "staging",
    CONTENTTRAKER_AUTH_MODE: "delegated",
    CONTENTTRAKER_TOKEN_ISSUER_SHA256: createHash("sha256").update("public-test-issuer").digest("hex"),
  };
}

function testMetadataResolver(): ContentTrakerOAuthMetadataResolver {
  const scopes = [
    "workspaces:read",
    "workspaces:write",
    "projects:read",
    "projects:write",
    "digital_assets:read",
    "digital_assets:write",
    "digital_assets:review",
  ];
  return new ContentTrakerOAuthMetadataResolver({
    getJson: async (url) => url.pathname.includes("oauth-protected-resource")
      ? {
          resource: audience,
          authorization_servers: [issuer],
          scopes_supported: scopes,
          bearer_methods_supported: ["header"],
        }
      : {
          issuer,
          authorization_endpoint: `${issuer}/oauth/authorize`,
          token_endpoint: `${issuer}/oauth/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: scopes,
        },
  });
}

function security(connectionId: string, sessionId: string): ContentTrakerRequestSecurityContext {
  return {
    environment: "staging",
    connectionId,
    sessionId,
    requestId: `${sessionId}-request`,
    correlationId: `${sessionId}-correlation`,
    tokenAudience: audience,
  };
}

function jwt(subject: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    iss: "public-test-issuer",
    aud: audience,
    exp: Math.floor(Date.now() / 1_000) + 3_600,
    appUserId: subject,
    Environment: "staging",
    auth_method: "oauth",
    client_type: "codex",
  })}.test-signature`;
}

await manualAuthorizationCompletesAndStoresCredential();
await manualAuthorizationCanBeCancelled();
await manualAuthorizationExpires();
await authorizationFailuresAreRedacted();
await tokenResponsesMustGrantRequiredScopes();

console.log("ContentTraker authorization interaction tests passed.");
