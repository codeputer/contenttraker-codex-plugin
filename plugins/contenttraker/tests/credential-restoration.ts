import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import type { SecureCredentialStore } from "../src/credential-store.js";
import type { OAuthTokenResponse } from "../src/oauth-client.js";
import { DelegatedContentTrakerTokenProvider } from "../src/token-provider.js";
import type { ContentTrakerRequestSecurityContext } from "../src/types.js";

const audience = "https://mcp.staging.contenttraker.com";

class PersistentMemoryCredentialStore implements SecureCredentialStore {
  readonly provider = "linux-secret-service" as const;
  readonly persistent = true;
  readonly values = new Map<string, string>();
  async get(handle: string): Promise<string | undefined> { return this.values.get(handle); }
  async set(handle: string, secret: string): Promise<void> { this.values.set(handle, secret); }
  async delete(handle: string): Promise<void> { this.values.delete(handle); }
}

class RestorationOAuthClient {
  authorizeCount = 0;
  refreshTokens: string[] = [];
  generation = 0;

  constructor(
    private readonly subject: string,
    private readonly beforeRefresh?: (refreshToken: string) => Promise<void>,
  ) {}

  async authorize(context: ContentTrakerRequestSecurityContext): Promise<OAuthTokenResponse> {
    this.authorizeCount += 1;
    return response(this.subject, context, this.generation++);
  }

  async refresh(refreshToken: string, context: ContentTrakerRequestSecurityContext): Promise<OAuthTokenResponse> {
    this.refreshTokens.push(refreshToken);
    await this.beforeRefresh?.(refreshToken);
    return response(this.subject, context, this.generation++);
  }
}

await newTaskRestoresWithoutInteractiveAuthorization();
await nonInteractiveApiAccessRequiresExplicitLogin();
await corruptedBindingIsRejectedAndRemoved();
await subjectChangesAreRejectedWithoutOverwritingProfile();
await distinctProfilesRemainIsolated();
await requiredIdentityIsPartOfTheStableBinding();
await crossProcessRotationRecoveryUsesNewerStoredCredential();
await rejectedRefreshCredentialIsDeleted();
await invalidationRemovesTheDurableProfile();

console.log("ContentTraker credential-restoration tests passed.");

async function newTaskRestoresWithoutInteractiveAuthorization(): Promise<void> {
  const store = new PersistentMemoryCredentialStore();
  const firstOAuth = new RestorationOAuthClient("durable-user");
  const first = provider(store, firstOAuth, "durable-profile");
  const firstCredential = await first.getAuthorizationHeader(security("connection-one", "session-one"));
  assert.equal(firstOAuth.authorizeCount, 1);
  assert.equal(store.values.size, 1);

  const secondOAuth = new RestorationOAuthClient("durable-user");
  const second = provider(store, secondOAuth, "durable-profile");
  const secondContext = security("connection-two", "session-two");
  const status = await second.getAuthorizationStatus(secondContext);
  assert.equal(status.status, "authorized");
  const restored = await second.getAuthorizationHeader(secondContext);
  assert.equal(secondOAuth.authorizeCount, 0);
  assert.equal(secondOAuth.refreshTokens.length, 1);
  assert.equal(restored.credentialHandle, firstCredential.credentialHandle);
  assert.equal(restored.subjectId, "durable-user");
  assert.equal(second.getStatus(secondContext).crossTaskRestoration, true);
  assert.equal(JSON.stringify(status).includes("refresh-durable-user"), false);
}

async function nonInteractiveApiAccessRequiresExplicitLogin(): Promise<void> {
  const store = new PersistentMemoryCredentialStore();
  const oauth = new RestorationOAuthClient("explicit-login-user");
  const next = provider(store, oauth, "explicit-login-profile");
  await assert.rejects(
    () => next.getAuthorizationHeader(security("explicit-login", "explicit-login"), { allowInteractive: false }),
    /authentication_required.*begin_contenttraker_login.*poll_contenttraker_login/,
  );
  assert.equal(oauth.authorizeCount, 0);
  assert.equal(store.values.size, 0);
}

async function corruptedBindingIsRejectedAndRemoved(): Promise<void> {
  const store = new PersistentMemoryCredentialStore();
  const first = provider(store, new RestorationOAuthClient("binding-user"), "binding-profile");
  await first.getAuthorizationHeader(security("binding-one", "binding-one"));
  const [handle, raw] = [...store.values.entries()][0] ?? [];
  assert.ok(handle && raw);
  const envelope = JSON.parse(raw) as Record<string, unknown>;
  envelope.audience = "https://wrong.example";
  store.values.set(handle, JSON.stringify(envelope));

  const nextOAuth = new RestorationOAuthClient("binding-user");
  const next = provider(store, nextOAuth, "binding-profile");
  const status = await next.getAuthorizationStatus(security("binding-two", "binding-two"));
  assert.equal(status.status, "blocked");
  assert.match(status.diagnostics.join(" "), /binding validation/);
  assert.equal(nextOAuth.authorizeCount, 0);
  assert.equal(nextOAuth.refreshTokens.length, 0);
  assert.equal(store.values.size, 0);
}

async function subjectChangesAreRejectedWithoutOverwritingProfile(): Promise<void> {
  const store = new PersistentMemoryCredentialStore();
  const first = provider(store, new RestorationOAuthClient("original-user"), "subject-profile");
  await first.getAuthorizationHeader(security("subject-one", "subject-one"));
  const original = [...store.values.values()][0];

  const changedOAuth = new RestorationOAuthClient("different-user");
  const changed = provider(store, changedOAuth, "subject-profile");
  const status = await changed.getAuthorizationStatus(security("subject-two", "subject-two"));
  assert.equal(status.status, "blocked");
  assert.equal(changedOAuth.authorizeCount, 0);
  assert.equal(store.values.size, 1);
  assert.equal([...store.values.values()][0], original);
}

async function distinctProfilesRemainIsolated(): Promise<void> {
  const store = new PersistentMemoryCredentialStore();
  const first = provider(store, new RestorationOAuthClient("profile-user-a"), "profile-a");
  const second = provider(store, new RestorationOAuthClient("profile-user-b"), "profile-b");
  const credentialA = await first.getAuthorizationHeader(security("profile-a", "profile-a"));
  const credentialB = await second.getAuthorizationHeader(security("profile-b", "profile-b"));
  assert.notEqual(credentialA.credentialHandle, credentialB.credentialHandle);
  assert.equal(store.values.size, 2);
}

async function requiredIdentityIsPartOfTheStableBinding(): Promise<void> {
  const store = new PersistentMemoryCredentialStore();
  const first = provider(store, new RestorationOAuthClient("shared-subject"), "identity-profile", "operator@example.org");
  const second = provider(store, new RestorationOAuthClient("shared-subject"), "identity-profile", "reviewer@example.org");
  const sameIdentityDifferentCase = provider(
    store,
    new RestorationOAuthClient("shared-subject"),
    "identity-profile",
    "OPERATOR@EXAMPLE.ORG",
  );
  const credentialA = await first.getAuthorizationHeader(security("identity-a", "identity-a"));
  const credentialB = await second.getAuthorizationHeader(security("identity-b", "identity-b"));
  const restoredA = await sameIdentityDifferentCase.getAuthorizationHeader(security("identity-c", "identity-c"));
  assert.notEqual(credentialA.credentialHandle, credentialB.credentialHandle);
  assert.equal(credentialA.credentialHandle, restoredA.credentialHandle);
  assert.equal(store.values.size, 2);
  assert.equal([...store.values.values()].every((value) => !value.includes("connection-") && !value.includes("session-")), true);
}

async function crossProcessRotationRecoveryUsesNewerStoredCredential(): Promise<void> {
  const store = new PersistentMemoryCredentialStore();
  const first = provider(store, new RestorationOAuthClient("rotation-user"), "rotation-profile");
  await first.getAuthorizationHeader(security("rotation-one", "rotation-one"));
  const originalRaw = [...store.values.values()][0];
  const original = JSON.parse(originalRaw) as Record<string, unknown>;
  const originalRefreshToken = String(original.refreshToken);
  const externalRefreshToken = "refresh-rotation-user-external";
  let firstAttempt = true;

  const rotationOAuth = new RestorationOAuthClient("rotation-user", async (refreshToken) => {
    if (!firstAttempt) return;
    firstAttempt = false;
    assert.equal(refreshToken, originalRefreshToken);
    const [handle, raw] = [...store.values.entries()][0] ?? [];
    const envelope = JSON.parse(raw) as Record<string, unknown>;
    envelope.refreshToken = externalRefreshToken;
    envelope.revision = createHash("sha256").update(externalRefreshToken).digest("hex");
    envelope.updatedAt = new Date().toISOString();
    store.values.set(handle, JSON.stringify(envelope));
    throw new Error("simulated stale rotating refresh credential");
  });
  const next = provider(store, rotationOAuth, "rotation-profile");
  const restored = await next.getAuthorizationHeader(security("rotation-two", "rotation-two"));
  assert.equal(restored.subjectId, "rotation-user");
  assert.deepEqual(rotationOAuth.refreshTokens, [originalRefreshToken, externalRefreshToken]);
}

async function rejectedRefreshCredentialIsDeleted(): Promise<void> {
  const store = new PersistentMemoryCredentialStore();
  const first = provider(store, new RestorationOAuthClient("rejected-user"), "rejected-profile");
  await first.getAuthorizationHeader(security("rejected-one", "rejected-one"));
  assert.equal(store.values.size, 1);

  const rejectedOAuth = new RestorationOAuthClient("rejected-user", async () => {
    throw new Error("ContentTraker OAuth token endpoint returned HTTP 400.");
  });
  const next = provider(store, rejectedOAuth, "rejected-profile");
  await assert.rejects(
    () => next.getAuthorizationHeader(security("rejected-two", "rejected-two"), { allowInteractive: false }),
    /refresh credential was rejected and deleted.*begin_contenttraker_login/i,
  );
  assert.equal(store.values.size, 0);
  assert.equal(rejectedOAuth.authorizeCount, 0);
}

async function invalidationRemovesTheDurableProfile(): Promise<void> {
  const store = new PersistentMemoryCredentialStore();
  const context = security("revoke-one", "revoke-one");
  const first = provider(store, new RestorationOAuthClient("revoke-user"), "revoke-profile");
  await first.getAuthorizationHeader(context);
  assert.equal(store.values.size, 1);
  await first.invalidate(context);
  assert.equal(store.values.size, 0);

  const nextOAuth = new RestorationOAuthClient("revoke-user");
  const next = provider(store, nextOAuth, "revoke-profile");
  await next.getAuthorizationHeader(security("revoke-two", "revoke-two"));
  assert.equal(nextOAuth.authorizeCount, 1);
}

function provider(
  store: SecureCredentialStore,
  oauth: RestorationOAuthClient,
  credentialProfile: string,
  requiredUserEmail?: string,
): DelegatedContentTrakerTokenProvider {
  return new DelegatedContentTrakerTokenProvider(store, oauth as never, environment(credentialProfile, requiredUserEmail));
}

function environment(credentialProfile: string, requiredUserEmail?: string): NodeJS.ProcessEnv {
  return {
    CONTENTTRAKER_AUTH_MODE: "delegated",
    CONTENTTRAKER_ENVIRONMENT: "staging",
    CONTENTTRAKER_CREDENTIAL_PROFILE: credentialProfile,
    CONTENTTRAKER_REQUIRED_USER_EMAIL: requiredUserEmail,
    CONTENTTRAKER_TOKEN_ISSUER_SHA256: createHash("sha256").update("public-test-issuer").digest("hex"),
  };
}

function security(connectionId: string, sessionId: string): ContentTrakerRequestSecurityContext {
  return {
    environment: "staging",
    connectionId,
    sessionId,
    requestId: `${connectionId}-request`,
    correlationId: `${connectionId}-correlation`,
    tokenAudience: audience,
  };
}

function response(
  subject: string,
  context: ContentTrakerRequestSecurityContext,
  generation: number,
): OAuthTokenResponse {
  return {
    accessToken: jwt(subject, context.tokenAudience, generation),
    refreshToken: `refresh-${subject}-${generation}`,
    expiresInSeconds: 3600,
    scope: "workspaces:read digital_assets:read digital_assets:write",
    resource: context.tokenAudience,
  };
}

function jwt(subject: string, tokenAudience: string, generation: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    iss: "public-test-issuer",
    aud: tokenAudience,
    exp: Math.floor(Date.now() / 1000) + 3600,
    appUserId: subject,
    Environment: "staging",
    auth_method: "oauth",
    client_type: "codex",
    generation,
  })}.test-signature`;
}
