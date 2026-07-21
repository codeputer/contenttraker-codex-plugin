import { createHash } from "node:crypto";

import { resolveAdapterEnvironment } from "./environment-profile.js";
import { createCredentialHandle, OsKeyringCredentialStore, type SecureCredentialStore } from "./credential-store.js";
import {
  ContentTrakerOAuthClient,
  type OAuthAuthorizationSession,
  type OAuthTokenResponse,
} from "./oauth-client.js";
import type {
  AuthorizationFlowResult,
  ContentTrakerRequestSecurityContext,
  RequestSecurityDiagnostics,
  TokenStrategyStatus,
} from "./types.js";

const REFRESH_SKEW_SECONDS = 90;
const DEFAULT_TOKEN_ISSUER_SHA256 = "dbce416ee93da56bbab1b9e402469a21ea9bb124c5749de5002ce0f7bb9ac004";

export interface ContentTrakerAuthorizationSnapshot {
  authorizationHeader: string;
  environment: string;
  authorityIssuer: string;
  tokenIssuer: string;
  subjectId: string;
  audience: string;
  expiresAt: number;
  credentialHandle: string;
  credentialVersion: string;
  authenticationMode: "delegated-user-pkce" | "service";
}

export interface ContentTrakerTokenProvider {
  getStatus(context?: ContentTrakerRequestSecurityContext): TokenStrategyStatus;
  getAuthorizationHeader(
    context: ContentTrakerRequestSecurityContext,
    options?: { forceRefresh?: boolean; rejectedCredentialVersion?: string; signal?: AbortSignal },
  ): Promise<ContentTrakerAuthorizationSnapshot>;
  beginAuthorization(context: ContentTrakerRequestSecurityContext): Promise<AuthorizationFlowResult>;
  getAuthorizationStatus(
    context: ContentTrakerRequestSecurityContext,
    waitMilliseconds?: number,
  ): Promise<AuthorizationFlowResult>;
  cancelAuthorization(context: ContentTrakerRequestSecurityContext): Promise<AuthorizationFlowResult>;
  getSecurityDiagnostics(context: ContentTrakerRequestSecurityContext): RequestSecurityDiagnostics;
  recordEffectiveCaller(
    context: ContentTrakerRequestSecurityContext,
    subjectId: string | undefined,
    contentTrakerCorrelationId?: string,
  ): void;
  invalidate(context: ContentTrakerRequestSecurityContext): Promise<void>;
}

interface CachedCredential {
  cacheKey: string;
  accessToken: string;
  authorityIssuer: string;
  tokenIssuer: string;
  subjectId: string;
  audience: string;
  expiresAt: number;
  credentialHandle: string;
  credentialVersion: string;
}

interface EffectiveCaller {
  subjectId?: string;
  contentTrakerCorrelationId?: string;
}

interface DelegatedAuthorizationFlow {
  session: OAuthAuthorizationSession;
  status: "pending" | "authorized" | "failed" | "expired" | "cancelled";
  diagnostic?: string;
  completion: Promise<CachedCredential>;
}

export function createContentTrakerTokenProvider(
  env: NodeJS.ProcessEnv = process.env,
  credentialStore: SecureCredentialStore = new OsKeyringCredentialStore(),
  oauthClient?: ContentTrakerOAuthClient,
): ContentTrakerTokenProvider {
  const mode = (env.CONTENTTRAKER_AUTH_MODE?.trim().toLowerCase() || "delegated");
  if (mode === "service") {
    return new ServiceContentTrakerTokenProvider(env);
  }
  if (mode !== "delegated") {
    return new InvalidContentTrakerTokenProvider(mode);
  }

  const profile = resolveAdapterEnvironment(env);
  return new DelegatedContentTrakerTokenProvider(
    credentialStore,
    oauthClient ?? new ContentTrakerOAuthClient(profile.oauthIssuer ?? ""),
    env,
  );
}

export class DelegatedContentTrakerTokenProvider implements ContentTrakerTokenProvider {
  private readonly credentialsBySession = new Map<string, CachedCredential>();
  private readonly loginFlights = new Map<string, Promise<CachedCredential>>();
  private readonly refreshFlights = new Map<string, Promise<CachedCredential>>();
  private readonly effectiveCallers = new Map<string, EffectiveCaller>();
  private readonly authorizationFlows = new Map<string, DelegatedAuthorizationFlow>();

  constructor(
    private readonly credentialStore: SecureCredentialStore,
    private readonly oauthClient: ContentTrakerOAuthClient,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  getStatus(context?: ContentTrakerRequestSecurityContext): TokenStrategyStatus {
    const credential = context ? this.credentialsBySession.get(sessionKey(context)) : undefined;
    return {
      mode: "delegated-user-pkce",
      configured: Boolean(resolveAdapterEnvironment(this.env).oauthIssuer),
      accessTokenPresent: Boolean(credential),
      source: "contenttraker-oauth-pkce",
      environmentTokenIgnored: hasAnyEnvironmentToken(this.env),
      credentialStore: "os-keyring",
      authenticationPending: context
        ? this.loginFlights.has(sessionKey(context))
          || this.authorizationFlows.get(sessionKey(context))?.status === "pending"
        : false,
      subjectId: credential?.subjectId,
      tokenExpiryStatus: expiryStatus(credential?.expiresAt),
    };
  }

  async getAuthorizationHeader(
    context: ContentTrakerRequestSecurityContext,
    options: { forceRefresh?: boolean; rejectedCredentialVersion?: string; signal?: AbortSignal } = {},
  ): Promise<ContentTrakerAuthorizationSnapshot> {
    this.assertContextMatchesProfile(context);
    const key = sessionKey(context);
    let credential = this.credentialsBySession.get(key);

    if (!credential) {
      credential = await this.loginSingleFlight(context, options.signal);
    } else if (
      (options.forceRefresh
        && (!options.rejectedCredentialVersion || options.rejectedCredentialVersion === credential.credentialVersion))
      || expiryStatus(credential.expiresAt) !== "valid"
    ) {
      credential = await this.refreshSingleFlight(context, credential);
    }

    return Object.freeze({
      authorizationHeader: `Bearer ${credential.accessToken}`,
      environment: context.environment,
      authorityIssuer: credential.authorityIssuer,
      tokenIssuer: credential.tokenIssuer,
      subjectId: credential.subjectId,
      audience: credential.audience,
      expiresAt: credential.expiresAt,
      credentialHandle: credential.credentialHandle,
      credentialVersion: credential.credentialVersion,
      authenticationMode: "delegated-user-pkce" as const,
    });
  }

  async beginAuthorization(context: ContentTrakerRequestSecurityContext): Promise<AuthorizationFlowResult> {
    this.assertContextMatchesProfile(context);
    const key = sessionKey(context);
    const credential = this.credentialsBySession.get(key);
    if (credential && expiryStatus(credential.expiresAt) === "valid") {
      return { status: "authorized", interaction: interaction(this.oauthClient), diagnostics: [] };
    }

    const existing = this.authorizationFlows.get(key);
    if (existing?.status === "pending") return authorizationFlowResult(existing);
    if (existing) {
      await existing.session.cancel().catch(() => undefined);
      this.authorizationFlows.delete(key);
    }

    try {
      const session = await this.oauthClient.beginAuthorization(context, true);
      let flow!: DelegatedAuthorizationFlow;
      const completion = (async () => {
        try {
          const response = await session.complete();
          const created = await this.createCredential(context, response);
          this.credentialsBySession.set(key, created);
          flow.status = "authorized";
          return created;
        } catch (error) {
          const failure = authorizationFailure(error);
          flow.status = failure.status;
          flow.diagnostic = failure.diagnostic;
          throw error;
        }
      })();
      flow = { session, status: "pending", completion };
      this.authorizationFlows.set(key, flow);
      void completion.catch(() => undefined);
      return authorizationFlowResult(flow);
    } catch (error) {
      return {
        status: "blocked",
        interaction: interaction(this.oauthClient),
        diagnostics: [authorizationFailure(error).diagnostic],
      };
    }
  }

  async getAuthorizationStatus(
    context: ContentTrakerRequestSecurityContext,
    waitMilliseconds = 0,
  ): Promise<AuthorizationFlowResult> {
    this.assertContextMatchesProfile(context);
    const credential = this.credentialsBySession.get(sessionKey(context));
    if (credential && expiryStatus(credential.expiresAt) === "valid") {
      return { status: "authorized", interaction: interaction(this.oauthClient), diagnostics: [] };
    }

    const flow = this.authorizationFlows.get(sessionKey(context));
    if (!flow) return { status: "idle", interaction: interaction(this.oauthClient), diagnostics: [] };

    const boundedWait = Math.max(0, Math.min(waitMilliseconds, 15_000));
    if (flow.status === "pending" && boundedWait > 0) {
      await Promise.race([
        flow.completion.catch(() => undefined),
        delay(boundedWait),
      ]);
    }
    return authorizationFlowResult(flow);
  }

  async cancelAuthorization(context: ContentTrakerRequestSecurityContext): Promise<AuthorizationFlowResult> {
    this.assertContextMatchesProfile(context);
    const key = sessionKey(context);
    const flow = this.authorizationFlows.get(key);
    const credential = this.credentialsBySession.get(key);
    if (!flow) {
      return {
        status: credential ? "authorized" : "idle",
        interaction: interaction(this.oauthClient),
        diagnostics: [],
      };
    }
    if (credential && expiryStatus(credential.expiresAt) === "valid") {
      return { status: "authorized", interaction: interaction(this.oauthClient), diagnostics: [] };
    }
    if (flow.status !== "pending") return authorizationFlowResult(flow);
    await flow.session.cancel();
    flow.status = "cancelled";
    flow.diagnostic = "ContentTraker authorization was cancelled locally.";
    return authorizationFlowResult(flow);
  }

  getSecurityDiagnostics(context: ContentTrakerRequestSecurityContext): RequestSecurityDiagnostics {
    const credential = this.credentialsBySession.get(sessionKey(context));
    const caller = this.effectiveCallers.get(sessionKey(context));
    return {
      environment: context.environment,
      authenticationMode: "delegated-user-pkce",
      connectionId: context.connectionId,
      sessionId: context.sessionId,
      requestId: context.requestId,
      authenticatedSubjectId: caller?.subjectId ?? credential?.subjectId,
      credentialHandle: credential?.credentialHandle,
      tokenAudience: context.tokenAudience,
      tokenExpiryStatus: expiryStatus(credential?.expiresAt),
      tokenExpiresAt: credential ? new Date(credential.expiresAt * 1000).toISOString() : undefined,
      correlationId: context.correlationId,
      contentTrakerCorrelationId: caller?.contentTrakerCorrelationId,
      effectiveCallerVerified: Boolean(caller?.subjectId),
    };
  }

  recordEffectiveCaller(
    context: ContentTrakerRequestSecurityContext,
    subjectId: string | undefined,
    contentTrakerCorrelationId?: string,
  ): void {
    const credential = this.credentialsBySession.get(sessionKey(context));
    if (subjectId && credential && subjectId !== credential.subjectId) {
      throw new Error("ContentTraker /me returned a caller that does not match the delegated credential subject.");
    }
    this.effectiveCallers.set(sessionKey(context), { subjectId, contentTrakerCorrelationId });
  }

  async invalidate(context: ContentTrakerRequestSecurityContext): Promise<void> {
    const key = sessionKey(context);
    const credential = this.credentialsBySession.get(key);
    this.credentialsBySession.delete(key);
    this.effectiveCallers.delete(key);
    const flow = this.authorizationFlows.get(key);
    this.authorizationFlows.delete(key);
    if (flow?.status === "pending") await flow.session.cancel().catch(() => undefined);
    if (credential) {
      await this.credentialStore.delete(credential.credentialHandle);
    }
  }

  private async loginSingleFlight(
    context: ContentTrakerRequestSecurityContext,
    signal?: AbortSignal,
  ): Promise<CachedCredential> {
    const key = sessionKey(context);
    const existing = this.loginFlights.get(key);
    if (existing) return await existing;

    const authorizationFlow = this.authorizationFlows.get(key);
    if (authorizationFlow?.status === "pending") return await authorizationFlow.completion;

    const flight = (async () => {
      const tokenResponse = await this.oauthClient.authorize(context, signal);
      const credential = await this.createCredential(context, tokenResponse);
      this.credentialsBySession.set(key, credential);
      return credential;
    })().finally(() => this.loginFlights.delete(key));

    this.loginFlights.set(key, flight);
    return await flight;
  }

  private async refreshSingleFlight(
    context: ContentTrakerRequestSecurityContext,
    credential: CachedCredential,
  ): Promise<CachedCredential> {
    const existing = this.refreshFlights.get(credential.cacheKey);
    if (existing) return await existing;

    const flight = (async () => {
      const refreshToken = await this.credentialStore.get(credential.credentialHandle);
      if (!refreshToken) {
        throw new Error("ContentTraker refresh credential is unavailable in the OS keyring.");
      }

      const tokenResponse = await this.oauthClient.refresh(refreshToken, context);
      const refreshed = await this.createCredential(context, tokenResponse, credential.subjectId);
      this.credentialsBySession.set(sessionKey(context), refreshed);
      if (refreshed.credentialHandle !== credential.credentialHandle) {
        await this.credentialStore.delete(credential.credentialHandle);
      }
      return refreshed;
    })().catch(async (error) => {
      await this.invalidate(context);
      throw error;
    }).finally(() => this.refreshFlights.delete(credential.cacheKey));

    this.refreshFlights.set(credential.cacheKey, flight);
    return await flight;
  }

  private async createCredential(
    context: ContentTrakerRequestSecurityContext,
    response: OAuthTokenResponse,
    expectedSubjectId?: string,
  ): Promise<CachedCredential> {
    const profile = resolveAdapterEnvironment(this.env);
    if (!profile.oauthIssuer || response.resource !== context.tokenAudience) {
      throw new Error("ContentTraker OAuth returned a credential for the wrong resource.");
    }

    const claims = parseAndValidateJwt(response.accessToken, context, this.env);
    if (expectedSubjectId && claims.subjectId !== expectedSubjectId) {
      throw new Error("ContentTraker token refresh changed the authenticated subject.");
    }

    const cacheKey = [
      context.environment,
      profile.oauthIssuer,
      claims.tokenIssuer,
      claims.subjectId,
      context.connectionId,
      context.sessionId,
    ].join("|");
    const credentialHandle = createCredentialHandle(cacheKey);
    await this.credentialStore.set(credentialHandle, response.refreshToken);

    return Object.freeze({
      cacheKey,
      accessToken: response.accessToken,
      authorityIssuer: profile.oauthIssuer,
      tokenIssuer: claims.tokenIssuer,
      subjectId: claims.subjectId,
      audience: context.tokenAudience,
      expiresAt: claims.expiresAt,
      credentialHandle,
      credentialVersion: createHash("sha256").update(response.accessToken).digest("hex"),
    });
  }

  private assertContextMatchesProfile(context: ContentTrakerRequestSecurityContext): void {
    const profile = resolveAdapterEnvironment(this.env);
    if (profile.status.name !== context.environment || profile.oauthResource !== context.tokenAudience) {
      throw new Error("ContentTraker request security context does not match the immutable adapter environment.");
    }
  }
}

export class ServiceContentTrakerTokenProvider implements ContentTrakerTokenProvider {
  private readonly effectiveCallers = new Map<string, EffectiveCaller>();

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  getStatus(): TokenStrategyStatus {
    const resolved = resolveServiceToken(this.env);
    return {
      mode: "service",
      configured: Boolean(resolved.token),
      accessTokenPresent: Boolean(resolved.token),
      source: resolved.source,
      tokenExpiryStatus: resolved.token ? "valid" : "missing",
    };
  }

  async getAuthorizationHeader(context: ContentTrakerRequestSecurityContext): Promise<ContentTrakerAuthorizationSnapshot> {
    const resolved = resolveServiceToken(this.env);
    if (!resolved.token || !resolved.source) {
      throw new Error("Explicit service authentication mode requires an environment-specific service token.");
    }
    const profile = resolveAdapterEnvironment(this.env);
    if (profile.status.name !== context.environment || profile.oauthResource !== context.tokenAudience) {
      throw new Error("Service credential environment does not match the request environment.");
    }

    return Object.freeze({
      authorizationHeader: `Bearer ${resolved.token}`,
      environment: context.environment,
      authorityIssuer: "service-configuration",
      tokenIssuer: "service-configuration",
      subjectId: this.effectiveCallers.get(sessionKey(context))?.subjectId ?? "service-identity-unverified",
      audience: context.tokenAudience,
      expiresAt: Number.MAX_SAFE_INTEGER,
      credentialHandle: resolved.source,
      credentialVersion: createHash("sha256").update(resolved.token).digest("hex"),
      authenticationMode: "service" as const,
    });
  }

  async beginAuthorization(): Promise<AuthorizationFlowResult> {
    return serviceAuthorizationBlocked();
  }

  async getAuthorizationStatus(): Promise<AuthorizationFlowResult> {
    return this.getStatus().accessTokenPresent
      ? { status: "authorized", diagnostics: [] }
      : serviceAuthorizationBlocked();
  }

  async cancelAuthorization(): Promise<AuthorizationFlowResult> {
    return serviceAuthorizationBlocked();
  }

  getSecurityDiagnostics(context: ContentTrakerRequestSecurityContext): RequestSecurityDiagnostics {
    const caller = this.effectiveCallers.get(sessionKey(context));
    return {
      environment: context.environment,
      authenticationMode: "service",
      connectionId: context.connectionId,
      sessionId: context.sessionId,
      requestId: context.requestId,
      authenticatedSubjectId: caller?.subjectId,
      credentialHandle: resolveServiceToken(this.env).source,
      tokenAudience: context.tokenAudience,
      tokenExpiryStatus: this.getStatus().accessTokenPresent ? "valid" : "missing",
      correlationId: context.correlationId,
      contentTrakerCorrelationId: caller?.contentTrakerCorrelationId,
      effectiveCallerVerified: Boolean(caller?.subjectId),
    };
  }

  recordEffectiveCaller(
    context: ContentTrakerRequestSecurityContext,
    subjectId: string | undefined,
    contentTrakerCorrelationId?: string,
  ): void {
    this.effectiveCallers.set(sessionKey(context), { subjectId, contentTrakerCorrelationId });
  }

  async invalidate(): Promise<void> {
    // Service credentials are immutable process configuration and are never replaced by user credentials.
  }
}

class InvalidContentTrakerTokenProvider implements ContentTrakerTokenProvider {
  constructor(private readonly configuredMode: string) {}
  getStatus(): TokenStrategyStatus {
    return { mode: "invalid", configured: false, accessTokenPresent: false, source: this.configuredMode, tokenExpiryStatus: "missing" };
  }
  async getAuthorizationHeader(): Promise<ContentTrakerAuthorizationSnapshot> {
    throw new Error("CONTENTTRAKER_AUTH_MODE must be delegated or service.");
  }
  async beginAuthorization(): Promise<AuthorizationFlowResult> {
    return invalidAuthorizationMode();
  }
  async getAuthorizationStatus(): Promise<AuthorizationFlowResult> {
    return invalidAuthorizationMode();
  }
  async cancelAuthorization(): Promise<AuthorizationFlowResult> {
    return invalidAuthorizationMode();
  }
  getSecurityDiagnostics(context: ContentTrakerRequestSecurityContext): RequestSecurityDiagnostics {
    return {
      environment: context.environment,
      authenticationMode: "invalid",
      connectionId: context.connectionId,
      sessionId: context.sessionId,
      requestId: context.requestId,
      tokenAudience: context.tokenAudience,
      tokenExpiryStatus: "missing",
      correlationId: context.correlationId,
      effectiveCallerVerified: false,
    };
  }
  recordEffectiveCaller(): void {}
  async invalidate(): Promise<void> {}
}

function parseAndValidateJwt(token: string, context: ContentTrakerRequestSecurityContext, env: NodeJS.ProcessEnv): {
  tokenIssuer: string;
  subjectId: string;
  expiresAt: number;
} {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("ContentTraker OAuth access token is not a JWT.");

  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("ContentTraker OAuth access token claims could not be parsed.");
  }

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const tokenIssuer = typeof claims.iss === "string" ? claims.iss : "";
  const expectedIssuerSha256 = env.CONTENTTRAKER_TOKEN_ISSUER_SHA256?.trim().toLowerCase()
    || DEFAULT_TOKEN_ISSUER_SHA256;
  const actualIssuerSha256 = createHash("sha256").update(tokenIssuer).digest("hex");
  if (actualIssuerSha256 !== expectedIssuerSha256 || !audiences.includes(context.tokenAudience)) {
    throw new Error("ContentTraker OAuth access token issuer or audience is invalid.");
  }
  if (claims.auth_method !== "oauth" || claims.client_type !== "codex") {
    throw new Error("ContentTraker OAuth access token was not issued for the Codex client.");
  }

  const subjectId = typeof claims.appUserId === "string" ? claims.appUserId : undefined;
  const expiresAt = typeof claims.exp === "number" ? claims.exp : undefined;
  if (!subjectId || !expiresAt || expiresAt <= nowSeconds()) {
    throw new Error("ContentTraker OAuth access token subject or expiry is invalid.");
  }

  const tokenEnvironment = typeof claims.Environment === "string" ? claims.Environment.toLowerCase() : "";
  if (tokenEnvironment && tokenEnvironment !== context.environment) {
    throw new Error("ContentTraker OAuth access token belongs to a different environment.");
  }

  return { tokenIssuer, subjectId, expiresAt };
}

function resolveServiceToken(env: NodeJS.ProcessEnv): { token?: string; source?: string } {
  const profile = resolveAdapterEnvironment(env);
  if (!profile.status.name) return {};
  const source = `CONTENTTRAKER_${profile.status.name.toUpperCase()}_ACCESS_TOKEN`;
  const token = env[source]?.trim();
  return token ? { token, source } : {};
}

function hasAnyEnvironmentToken(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.CONTENTTRAKER_ACCESS_TOKEN?.trim()
      || env.CONTENTTRAKER_STAGING_ACCESS_TOKEN?.trim()
      || env.CONTENTTRAKER_PRODUCTION_ACCESS_TOKEN?.trim(),
  );
}

function sessionKey(context: ContentTrakerRequestSecurityContext): string {
  return `${context.environment}|${context.connectionId}|${context.sessionId}`;
}

function expiryStatus(expiresAt?: number): "missing" | "valid" | "expiring" | "expired" {
  if (!expiresAt) return "missing";
  if (expiresAt <= nowSeconds()) return "expired";
  if (expiresAt <= nowSeconds() + REFRESH_SKEW_SECONDS) return "expiring";
  return "valid";
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function authorizationFlowResult(flow: DelegatedAuthorizationFlow): AuthorizationFlowResult {
  return {
    status: flow.status,
    interaction: flow.session.interactionMode === "invalid" ? undefined : flow.session.interactionMode,
    ...(flow.status === "pending"
      ? {
          authorizationUrl: flow.session.authorizationUrl,
          redirectUri: flow.session.redirectUri,
          expiresAt: flow.session.expiresAt,
        }
      : {}),
    diagnostics: flow.diagnostic ? [flow.diagnostic] : [],
  };
}

function authorizationFailure(error: unknown): {
  status: "failed" | "expired" | "cancelled";
  diagnostic: string;
} {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("timed out")) {
    return {
      status: "expired",
      diagnostic: "ContentTraker authorization expired before the loopback callback completed.",
    };
  }
  if (message.includes("cancelled")) {
    return { status: "cancelled", diagnostic: "ContentTraker authorization was cancelled locally." };
  }
  if (message.includes("token endpoint")) {
    return { status: "failed", diagnostic: "ContentTraker authorization-code exchange failed at the token endpoint." };
  }
  if (message.includes("browser") || message.includes("manual authorization") || message.includes("contenttraker_browser_mode")) {
    return {
      status: "failed",
      diagnostic: "ContentTraker authorization interaction is unavailable for the configured host boundary.",
    };
  }
  return { status: "failed", diagnostic: "ContentTraker delegated authorization failed." };
}

function interaction(
  oauthClient: ContentTrakerOAuthClient,
): "system-browser" | "manual-url" | "wsl-native" | undefined {
  return oauthClient.interactionMode === "invalid" ? undefined : oauthClient.interactionMode;
}

function serviceAuthorizationBlocked(): AuthorizationFlowResult {
  return {
    status: "blocked",
    diagnostics: ["Interactive authorization is unavailable when CONTENTTRAKER_AUTH_MODE=service."],
  };
}

function invalidAuthorizationMode(): AuthorizationFlowResult {
  return {
    status: "blocked",
    diagnostics: ["CONTENTTRAKER_AUTH_MODE must be delegated or service."],
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
