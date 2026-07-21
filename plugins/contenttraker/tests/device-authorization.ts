import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import type { BrowserLauncher } from "../src/browser-interaction.js";
import type { SecureCredentialStore } from "../src/credential-store.js";
import {
  CONTENTTRAKER_OAUTH_CLIENT_ID,
  ContentTrakerOAuthClient,
  FetchOAuthTransport,
  type OAuthDeviceAuthorizationResponse,
  type OAuthDeviceTokenPollResult,
  type OAuthTokenResponse,
  type OAuthTransport,
} from "../src/oauth-client.js";
import {
  CONTENTTRAKER_OAUTH_SCOPES,
  ContentTrakerOAuthMetadataResolver,
} from "../src/oauth-metadata.js";
import { DelegatedContentTrakerTokenProvider } from "../src/token-provider.js";
import type { ContentTrakerRequestSecurityContext } from "../src/types.js";

const issuer = "https://tokenbroker.staging.contenttraker.com";
const resource = "https://mcp.staging.contenttraker.com";
const deviceSecret = "opaque-device-secret-never-expose";
const fullScope = CONTENTTRAKER_OAUTH_SCOPES.join(" ");

async function autoManualDeviceFlowPollsAndRedacts(): Promise<void> {
  const transport = new SequenceTransport([
    { status: "pending" },
    { status: "slow-down" },
    { status: "authorized", token: token() },
  ]);
  const client = deviceClient(transport, { CONTENTTRAKER_DELEGATED_FLOW: "auto" });
  const session = await client.beginAuthorization(security(), false);
  assert.equal(session.interactionMode, "device-code");
  assert.equal(session.userCode, "ABCD-EFGH");
  assert.equal(session.verificationUri, "https://login.contenttraker.test/device");
  assert.equal(session.authorizationUrl, "https://login.contenttraker.test/device?user_code=ABCD-EFGH");
  assert.equal(session.redirectUri, undefined);
  assert.equal(JSON.stringify(session).includes(deviceSecret), false);

  const result = await session.complete();
  assert.equal(result.resource, resource);
  assert.equal(transport.beginParameters?.get("client_id"), CONTENTTRAKER_OAUTH_CLIENT_ID);
  assert.equal(transport.beginParameters?.get("scope"), fullScope);
  assert.equal(transport.beginParameters?.get("resource"), resource);
  assert.equal(transport.pollParameters.every((entry) => entry.get("device_code") === deviceSecret), true);
  assert.equal(transport.pollParameters.every((entry) => entry.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code"), true);
}

async function explicitAndAutomaticSelectionFailClosed(): Promise<void> {
  const noDeviceClient = new ContentTrakerOAuthClient(
    issuer,
    manualLauncher,
    new SequenceTransport([]),
    2_000,
    metadataResolver(false),
    { CONTENTTRAKER_DELEGATED_FLOW: "device-code" },
    fastTiming,
  );
  await assert.rejects(
    () => noDeviceClient.beginAuthorization(security(), false),
    /does not advertise device authorization/,
  );
  const blockedProvider = new DelegatedContentTrakerTokenProvider(
    new MemoryStore(),
    noDeviceClient,
    { CONTENTTRAKER_ENVIRONMENT: "staging", CONTENTTRAKER_DELEGATED_FLOW: "device-code" },
  );
  const blocked = await blockedProvider.beginAuthorization(security());
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.diagnostics.join(" "), /does not advertise device authorization/);

  const automaticFallback = new ContentTrakerOAuthClient(
    issuer,
    manualLauncher,
    new SequenceTransport([]),
    2_000,
    metadataResolver(false),
    { CONTENTTRAKER_DELEGATED_FLOW: "auto" },
    fastTiming,
  );
  await assert.rejects(
    () => automaticFallback.authorize(security()),
    /Manual authorization is configured/,
  );

  const explicitCode = new ContentTrakerOAuthClient(
    issuer,
    manualLauncher,
    new SequenceTransport([]),
    2_000,
    metadataResolver(true),
    { CONTENTTRAKER_DELEGATED_FLOW: "authorization-code" },
    fastTiming,
  );
  const codeSession = await explicitCode.beginAuthorization(security(), false);
  assert.equal(codeSession.interactionMode, "manual-url");
  await codeSession.cancel();

  const invalid = new ContentTrakerOAuthClient(
    issuer,
    manualLauncher,
    new SequenceTransport([]),
    2_000,
    metadataResolver(true),
    { CONTENTTRAKER_DELEGATED_FLOW: "password" },
    fastTiming,
  );
  await assert.rejects(() => invalid.beginAuthorization(security(), false), /must be auto, authorization-code, or device-code/);
}

async function deviceTerminalStatesAreBounded(): Promise<void> {
  await terminalState({ status: "denied" }, /was denied/);
  await terminalState({ status: "expired" }, /expired/);

  const cancelTransport = new SequenceTransport([{ status: "pending" }]);
  const cancelled = await deviceClient(cancelTransport).beginAuthorization(security(), false);
  await cancelled.cancel();
  await assert.rejects(() => cancelled.complete(), /cancelled/);

  const timeoutTransport = new SequenceTransport([{ status: "pending" }], undefined, true);
  const timedOut = await deviceClient(timeoutTransport, {}, 10, {
    secondsToMilliseconds: 1,
    minimumIntervalMilliseconds: 20,
    slowDownIncrementMilliseconds: 1,
  })
    .beginAuthorization(security(), false);
  await assert.rejects(() => timedOut.complete(), /timed out/);
}

async function tokenBindingFailuresAreRejected(): Promise<void> {
  await assert.rejects(
    () => deviceClient(new SequenceTransport([{ status: "authorized", token: token("workspaces:read") }]))
      .beginAuthorization(security(), false)
      .then((session) => session.complete()),
    /did not grant every required scope/,
  );
  await assert.rejects(
    () => deviceClient(new SequenceTransport([{ status: "authorized", token: token(fullScope, "https://wrong.example") }]))
      .beginAuthorization(security(), false)
      .then((session) => session.complete()),
    /resource does not match/,
  );
}

async function successfulDeviceFlowUsesDelegatedCredentialStore(): Promise<void> {
  const store = new MemoryStore();
  const transport = new SequenceTransport([{ status: "authorized", token: token(fullScope, resource, jwt("device-user")) }]);
  const env = {
    CONTENTTRAKER_AUTH_MODE: "delegated",
    CONTENTTRAKER_ENVIRONMENT: "staging",
    CONTENTTRAKER_DELEGATED_FLOW: "device-code",
    CONTENTTRAKER_CREDENTIAL_PROFILE: "headless-user",
    CONTENTTRAKER_TOKEN_ISSUER_SHA256: createHash("sha256").update("device-test-issuer").digest("hex"),
  };
  const provider = new DelegatedContentTrakerTokenProvider(store, deviceClient(transport, env), env);
  const pending = await provider.beginAuthorization(security());
  assert.equal(pending.interaction, "device-code");
  assert.equal(pending.userCode, "ABCD-EFGH");
  assert.equal(JSON.stringify(pending).includes(deviceSecret), false);
  const completed = await provider.getAuthorizationStatus(security(), 1_000);
  assert.equal(completed.status, "authorized");
  assert.equal(store.values.size, 1);
  const stored = [...store.values.values()][0] ?? "";
  assert.equal(stored.includes("refresh-device"), true);
  assert.equal(stored.includes(deviceSecret), false);
}

async function fetchTransportValidatesAndRedactsResponses(): Promise<void> {
  const transport = new FetchOAuthTransport();
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => jsonResponse({
      device_code: deviceSecret,
      user_code: "ABCD-EFGH",
      verification_uri: "http://insecure.example/device",
      expires_in: 600,
    });
    await assert.rejects(
      () => transport.beginDeviceAuthorization(new URL(`${issuer}/oauth/device`), new URLSearchParams()),
      /credential-free HTTPS URL/,
    );

    globalThis.fetch = async () => jsonResponse({
      user_code: "ABCD-EFGH",
      verification_uri: "https://login.contenttraker.test/device",
      expires_in: 600,
    });
    await assert.rejects(
      () => transport.beginDeviceAuthorization(new URL(`${issuer}/oauth/device`), new URLSearchParams()),
      /device code is invalid/,
    );

    globalThis.fetch = async () => jsonResponse({ error: "unexpected", error_description: deviceSecret }, 400);
    await assert.rejects(
      () => transport.pollDeviceToken(new URL(`${issuer}/oauth/token`), new URLSearchParams()),
      (error: unknown) => error instanceof Error && !error.message.includes(deviceSecret),
    );

    for (const [error, expected] of [
      ["authorization_pending", "pending"],
      ["slow_down", "slow-down"],
      ["access_denied", "denied"],
      ["expired_token", "expired"],
    ] as const) {
      globalThis.fetch = async () => jsonResponse({ error }, 400);
      assert.equal((await transport.pollDeviceToken(new URL(`${issuer}/oauth/token`), new URLSearchParams())).status, expected);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function optionalLiveStagingBlocker(): Promise<void> {
  if (process.env.CONTENTTRAKER_TEST_LIVE_OAUTH_METADATA !== "1") return;
  const client = new ContentTrakerOAuthClient(
    issuer,
    manualLauncher,
    new SequenceTransport([]),
    2_000,
    new ContentTrakerOAuthMetadataResolver(),
    { CONTENTTRAKER_DELEGATED_FLOW: "device-code" },
    fastTiming,
  );
  await assert.rejects(
    () => client.beginAuthorization(security(), false),
    /does not advertise device authorization/,
  );
}

async function terminalState(result: OAuthDeviceTokenPollResult, pattern: RegExp): Promise<void> {
  const session = await deviceClient(new SequenceTransport([result])).beginAuthorization(security(), false);
  await assert.rejects(() => session.complete(), pattern);
}

class SequenceTransport implements OAuthTransport {
  beginParameters?: URLSearchParams;
  readonly pollParameters: URLSearchParams[] = [];

  constructor(
    private readonly results: OAuthDeviceTokenPollResult[],
    private readonly start: OAuthDeviceAuthorizationResponse = {
      deviceCode: deviceSecret,
      userCode: "ABCD-EFGH",
      verificationUri: "https://login.contenttraker.test/device",
      verificationUriComplete: "https://login.contenttraker.test/device?user_code=ABCD-EFGH",
      expiresInSeconds: 60,
      intervalSeconds: 1,
    },
    private readonly repeatLast = false,
  ) {}

  async exchangeToken(): Promise<OAuthTokenResponse> {
    throw new Error("Authorization-code exchange was not expected.");
  }

  async beginDeviceAuthorization(_endpoint: URL, parameters: URLSearchParams): Promise<OAuthDeviceAuthorizationResponse> {
    this.beginParameters = new URLSearchParams(parameters);
    return this.start;
  }

  async pollDeviceToken(_endpoint: URL, parameters: URLSearchParams): Promise<OAuthDeviceTokenPollResult> {
    this.pollParameters.push(new URLSearchParams(parameters));
    const result = this.results.shift();
    if (result) return result;
    if (this.repeatLast) return { status: "pending" };
    throw new Error("No device polling result was configured.");
  }
}

class MemoryStore implements SecureCredentialStore {
  readonly provider = "ephemeral-memory" as const;
  readonly persistent = false;
  readonly values = new Map<string, string>();
  async get(handle: string): Promise<string | undefined> { return this.values.get(handle); }
  async set(handle: string, secret: string): Promise<void> { this.values.set(handle, secret); }
  async delete(handle: string): Promise<void> { this.values.delete(handle); }
}

const manualLauncher: BrowserLauncher = {
  mode: "manual-url",
  open: async () => { throw new Error("Manual launcher must not open a browser."); },
};
const fastTiming = {
  secondsToMilliseconds: 1,
  minimumIntervalMilliseconds: 1,
  slowDownIncrementMilliseconds: 1,
};

function deviceClient(
  transport: OAuthTransport,
  env: NodeJS.ProcessEnv = {},
  timeoutMilliseconds = 2_000,
  timing = fastTiming,
): ContentTrakerOAuthClient {
  return new ContentTrakerOAuthClient(
    issuer,
    manualLauncher,
    transport,
    timeoutMilliseconds,
    metadataResolver(true),
    env,
    timing,
  );
}

function metadataResolver(device: boolean): ContentTrakerOAuthMetadataResolver {
  return new ContentTrakerOAuthMetadataResolver({
    getJson: async (url) => url.pathname.includes("oauth-protected-resource")
      ? {
          resource,
          authorization_servers: [issuer],
          scopes_supported: [...CONTENTTRAKER_OAUTH_SCOPES],
          bearer_methods_supported: ["header"],
        }
      : {
          issuer,
          authorization_endpoint: `${issuer}/oauth/authorize`,
          token_endpoint: `${issuer}/oauth/token`,
          ...(device ? { device_authorization_endpoint: `${issuer}/oauth/device` } : {}),
          response_types_supported: ["code"],
          grant_types_supported: [
            "authorization_code",
            "refresh_token",
            ...(device ? ["urn:ietf:params:oauth:grant-type:device_code"] : []),
          ],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: [...CONTENTTRAKER_OAUTH_SCOPES],
        },
  });
}

function token(scope = fullScope, audience = resource, accessToken = "access-device"): OAuthTokenResponse {
  return {
    accessToken,
    refreshToken: "refresh-device",
    expiresInSeconds: 3_600,
    scope,
    resource: audience,
  };
}

function jwt(subject: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    iss: "device-test-issuer",
    aud: resource,
    auth_method: "oauth",
    client_type: "codex",
    appUserId: subject,
    exp: Math.floor(Date.now() / 1_000) + 3_600,
    Environment: "staging",
  })}.signature`;
}

function security(): ContentTrakerRequestSecurityContext {
  return {
    environment: "staging",
    connectionId: "device-connection",
    sessionId: "device-session",
    requestId: "device-request",
    correlationId: "device-correlation",
    tokenAudience: resource,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

await autoManualDeviceFlowPollsAndRedacts();
await explicitAndAutomaticSelectionFailClosed();
await deviceTerminalStatesAreBounded();
await tokenBindingFailuresAreRejected();
await successfulDeviceFlowUsesDelegatedCredentialStore();
await fetchTransportValidatesAndRedactsResponses();
await optionalLiveStagingBlocker();

console.log("ContentTraker device authorization tests passed.");
