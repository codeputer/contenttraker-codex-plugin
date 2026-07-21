import assert from "node:assert/strict";

import {
  CONTENTTRAKER_OAUTH_SCOPES,
  ContentTrakerOAuthMetadataResolver,
  type OAuthMetadataFetcher,
} from "../src/oauth-metadata.js";

const issuer = "https://tokenbroker.staging.contenttraker.com";
const resource = "https://mcp.staging.contenttraker.com";

async function validMetadataIsCachedAndSingleFlight(): Promise<void> {
  const fetcher = new MetadataFetcher();
  const resolver = new ContentTrakerOAuthMetadataResolver(fetcher, 60_000);
  const results = await Promise.all(Array.from({ length: 12 }, () => resolver.resolve(issuer, resource)));
  assert.equal(fetcher.calls.length, 2);
  assert.equal(new Set(results.map((result) => result.expiresAt)).size, 1);
  assert.equal(results[0]?.authorizationEndpoint, `${issuer}/oauth/authorize`);
  assert.equal(results[0]?.tokenEndpoint, `${issuer}/oauth/token`);
  assert.equal(results[0]?.deviceAuthorizationAvailable, false);
  assert.deepEqual(results[0]?.workloadGrantsAdvertised, []);

  const inspection = await resolver.inspect(issuer, resource);
  assert.equal(inspection.status, "ready");
  assert.equal(inspection.delegatedAuthorizationCode, true);
  assert.equal(inspection.deviceAuthorization, false);
  assert.equal(inspection.workloadAuthorization, false);
  assert.deepEqual(inspection.requiredScopes, CONTENTTRAKER_OAUTH_SCOPES);
  assert.equal(JSON.stringify(inspection).includes("cookie"), false);
  assert.equal(fetcher.calls.length, 2);
}

async function deviceAndWorkloadGrantsAreDetectedOnlyWhenAdvertised(): Promise<void> {
  const fetcher = new MetadataFetcher({
    authorizationServer: {
      ...authorizationServerMetadata(),
      device_authorization_endpoint: `${issuer}/oauth/device`,
      grant_types_supported: [
        "authorization_code",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:device_code",
        "client_credentials",
      ],
    },
  });
  const inspection = await new ContentTrakerOAuthMetadataResolver(fetcher).inspect(issuer, resource);
  assert.equal(inspection.status, "ready");
  assert.equal(inspection.deviceAuthorization, true);
  assert.equal(inspection.workloadAuthorization, true);
  assert.deepEqual(inspection.workloadGrantsAdvertised, ["client_credentials"]);
}

async function invalidContractsFailClosed(): Promise<void> {
  await rejectsMetadata(
    { protectedResource: { ...protectedResourceMetadata(), resource: "https://wrong.example" } },
    /protected-resource metadata does not match/,
  );
  await rejectsMetadata(
    { authorizationServer: { ...authorizationServerMetadata(), issuer: "https://wrong.example" } },
    /issuer does not match/,
  );
  await rejectsMetadata(
    { protectedResource: { ...protectedResourceMetadata(), authorization_servers: ["https://wrong.example"] } },
    /does not name the configured authorization server/,
  );
  await rejectsMetadata(
    { authorizationServer: { ...authorizationServerMetadata(), token_endpoint: "https://wrong.example/token" } },
    /configured HTTPS authority origin/,
  );
  await rejectsMetadata(
    { authorizationServer: { ...authorizationServerMetadata(), response_types_supported: ["token"] } },
    /does not support code responses/,
  );
  await rejectsMetadata(
    { authorizationServer: { ...authorizationServerMetadata(), grant_types_supported: ["authorization_code"] } },
    /authorization-code and refresh grants/,
  );
  await rejectsMetadata(
    { authorizationServer: { ...authorizationServerMetadata(), code_challenge_methods_supported: ["plain"] } },
    /PKCE S256/,
  );
  await rejectsMetadata(
    {
      authorizationServer: {
        ...authorizationServerMetadata(),
        scopes_supported: CONTENTTRAKER_OAUTH_SCOPES.filter((scope) => scope !== "digital_assets:write"),
      },
    },
    /required scopes/,
  );
  await rejectsMetadata(
    { authorizationServer: { ...authorizationServerMetadata(), token_endpoint_auth_methods_supported: ["client_secret_basic"] } },
    /public client/,
  );
  await rejectsMetadata(
    { protectedResource: { ...protectedResourceMetadata(), bearer_methods_supported: ["body"] } },
    /bearer headers/,
  );

  const rawFailure = "raw-cookie raw-token";
  const inspection = await new ContentTrakerOAuthMetadataResolver({
    getJson: async () => { throw new Error(rawFailure); },
  }).inspect(issuer, resource);
  assert.equal(inspection.status, "blocked");
  assert.equal(JSON.stringify(inspection).includes(rawFailure), false);
  assert.match(inspection.diagnostics.join(" "), /could not be fetched/);
}

async function rejectsMetadata(
  overrides: ConstructorParameters<typeof MetadataFetcher>[0],
  pattern: RegExp,
): Promise<void> {
  const resolver = new ContentTrakerOAuthMetadataResolver(new MetadataFetcher(overrides));
  await assert.rejects(() => resolver.resolve(issuer, resource), pattern);
  const inspection = await resolver.inspect(issuer, resource);
  assert.equal(inspection.status, "blocked");
}

async function optionalLiveStagingProbe(): Promise<void> {
  if (process.env.CONTENTTRAKER_TEST_LIVE_OAUTH_METADATA !== "1") return;
  const resolver = new ContentTrakerOAuthMetadataResolver();
  const inspection = await resolver.inspect(issuer, resource);
  assert.equal(inspection.status, "ready");
  assert.equal(inspection.delegatedAuthorizationCode, true);
  assert.equal(inspection.deviceAuthorization, false);
  assert.equal(inspection.workloadAuthorization, false);

  const metadata = await resolver.resolve(issuer, resource);
  const redirectUri = `http://127.0.0.1:${40_000 + Math.floor(Math.random() * 20_000)}/oauth/callback`;
  const authorizationUrl = new URL(metadata.authorizationEndpoint);
  authorizationUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: "codex-mcp",
    redirect_uri: redirectUri,
    scope: CONTENTTRAKER_OAUTH_SCOPES.join(" "),
    state: "non-secret-capability-probe",
    code_challenge: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    code_challenge_method: "S256",
    resource,
  }).toString();
  const response = await fetch(authorizationUrl, { redirect: "manual" });
  assert.equal(response.status, 302);
  const location = response.headers.get("location");
  assert.ok(location);
  const next = new URL(location);
  assert.equal(next.protocol, "https:");
  assert.notEqual(next.origin, new URL(redirectUri).origin);
}

class MetadataFetcher implements OAuthMetadataFetcher {
  readonly calls: string[] = [];

  constructor(private readonly overrides: {
    protectedResource?: Record<string, unknown>;
    authorizationServer?: Record<string, unknown>;
  } = {}) {}

  async getJson(url: URL): Promise<unknown> {
    this.calls.push(url.toString());
    await new Promise((resolve) => setTimeout(resolve, 5));
    return url.pathname.includes("oauth-protected-resource")
      ? this.overrides.protectedResource ?? protectedResourceMetadata()
      : this.overrides.authorizationServer ?? authorizationServerMetadata();
  }
}

function protectedResourceMetadata(): Record<string, unknown> {
  return {
    resource,
    authorization_servers: [issuer],
    scopes_supported: [...CONTENTTRAKER_OAUTH_SCOPES, "digital_assets:approve"],
    bearer_methods_supported: ["header"],
  };
}

function authorizationServerMetadata(): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...CONTENTTRAKER_OAUTH_SCOPES, "digital_assets:approve"],
  };
}

await validMetadataIsCachedAndSingleFlight();
await deviceAndWorkloadGrantsAreDetectedOnlyWhenAdvertised();
await invalidContractsFailClosed();
await optionalLiveStagingProbe();

console.log("ContentTraker OAuth metadata tests passed.");
