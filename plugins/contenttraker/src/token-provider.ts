import { createHash } from "node:crypto";

import { resolveAdapterEnvironment } from "./environment-profile.js";
import {
  createCredentialHandle,
  createSecureCredentialStore,
  withCredentialStoreLock,
  type SecureCredentialStore,
} from "./credential-store.js";
import {
  CONTENTTRAKER_OAUTH_CLIENT_ID,
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
  credentialProfile: string;
  accessToken: string;
  authorityIssuer: string;
  tokenIssuer: string;
  subjectId: string;
  audience: string;
  expiresAt: number;
  credentialHandle: string;
  credentialVersion: string;
}

interface CredentialBinding {
  profile: string;
  handle: string;
  environment: string;
  authorityIssuer: string;
  audience: string;
  clientId: string;
}

interface StoredDelegatedCredential {
  version: 1;
  profile: string;
  environment: string;
  authorityIssuer: string;
  tokenIssuer: string;
  audience: string;
  clientId: string;
  subjectId: string;
  refreshToken: string;
  revision: string;
  updatedAt: string;
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
  credentialStore: SecureCredentialStore = createSecureCredentialStore(env),
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
  private readonly restorationFlights = new Map<string, Promise<CachedCredential | undefined>>();
  private readonly refreshFlights = new Map<string, Promise<CachedCredential>>();
  private readonly credentialMutationTails = new Map<string, Promise<void>>();
  private readonly effectiveCallers = new Map<string, EffectiveCaller>();
  private readonly authorizationFlows = new Map<string, DelegatedAuthorizationFlow>();

  constructor(
    private readonly credentialStore: SecureCredentialStore,
    private readonly oauthClient: ContentTrakerOAuthClient,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  getStatus(context?: ContentTrakerRequestSecurityContext): TokenStrategyStatus {
    const credential = context ? this.credentialsBySession.get(sessionKey(context)) : undefined;
    const binding = context ? resolveCredentialBinding(context, this.env) : undefined;
    return {
      mode: "delegated-user-pkce",
      configured: Boolean(resolveAdapterEnvironment(this.env).oauthIssuer),
      accessTokenPresent: Boolean(credential),
      source: "contenttraker-oauth-pkce",
      environmentTokenIgnored: hasAnyEnvironmentToken(this.env),
      credentialStore: this.credentialStore.provider ?? "custom",
      credentialProfile: binding?.profile,
      crossTaskRestoration: Boolean(this.credentialStore.persistent),
      authenticationPending: context
        ? this.loginFlights.has(sessionKey(context))
          || this.restorationFlights.has(binding?.handle ?? "")
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
    let credential = this.credentialsBySession.get(key);
    if (credential && expiryStatus(credential.expiresAt) === "valid") {
      return { status: "authorized", interaction: interaction(this.oauthClient), diagnostics: [] };
    }

    try {
      credential = await this.restoreSingleFlight(context);
      if (credential) {
        this.credentialsBySession.set(key, credential);
        return { status: "authorized", interaction: interaction(this.oauthClient), diagnostics: [] };
      }
    } catch (error) {
      return {
        status: "blocked",
        interaction: interaction(this.oauthClient),
        diagnostics: [credentialFailure(error)],
      };
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
    if (!flow) {
      try {
        const restored = await this.restoreSingleFlight(context);
        if (restored) {
          this.credentialsBySession.set(sessionKey(context), restored);
          return { status: "authorized", interaction: interaction(this.oauthClient), diagnostics: [] };
        }
        return { status: "idle", interaction: interaction(this.oauthClient), diagnostics: [] };
      } catch (error) {
        return {
          status: "blocked",
          interaction: interaction(this.oauthClient),
          diagnostics: [credentialFailure(error)],
        };
      }
    }

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
      credentialProfile: credential?.credentialProfile ?? resolveCredentialBinding(context, this.env).profile,
      credentialStore: this.credentialStore.provider ?? "custom",
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
    const handle = this.credentialsBySession.get(key)?.credentialHandle
      ?? resolveCredentialBinding(context, this.env).handle;
    this.credentialsBySession.clear();
    this.effectiveCallers.clear();
    const flows = [...this.authorizationFlows.values()];
    this.authorizationFlows.clear();
    await Promise.all(flows
      .filter((flow) => flow.status === "pending")
      .map(async (flow) => await flow.session.cancel().catch(() => undefined)));
    await this.withCredentialMutation(
      handle,
      async () => await this.withCrossProcessLock(handle, async () => await this.credentialStore.delete(handle)),
    );
  }

  private async loginSingleFlight(
    context: ContentTrakerRequestSecurityContext,
    signal?: AbortSignal,
  ): Promise<CachedCredential> {
    const key = sessionKey(context);
    const existing = this.loginFlights.get(key);
    if (existing) {
      const credential = await existing;
      this.credentialsBySession.set(key, credential);
      return credential;
    }

    const authorizationFlow = this.authorizationFlows.get(key);
    if (authorizationFlow?.status === "pending") return await authorizationFlow.completion;

    const flight = (async () => {
      const restored = await this.restoreSingleFlight(context);
      if (restored) return restored;
      const tokenResponse = await this.oauthClient.authorize(context, signal);
      return await this.createCredential(context, tokenResponse);
    })().finally(() => this.loginFlights.delete(key));

    this.loginFlights.set(key, flight);
    const credential = await flight;
    this.credentialsBySession.set(key, credential);
    return credential;
  }

  private async restoreSingleFlight(
    context: ContentTrakerRequestSecurityContext,
  ): Promise<CachedCredential | undefined> {
    const binding = resolveCredentialBinding(context, this.env);
    const existing = this.restorationFlights.get(binding.handle);
    if (existing) return await existing;

    const flight = this.restoreCredential(context, binding)
      .finally(() => this.restorationFlights.delete(binding.handle));
    this.restorationFlights.set(binding.handle, flight);
    return await flight;
  }

  private async restoreCredential(
    context: ContentTrakerRequestSecurityContext,
    binding: CredentialBinding,
  ): Promise<CachedCredential | undefined> {
    return await this.withCredentialMutation(
      binding.handle,
      async () => await this.withCrossProcessLock(binding.handle, async () => {
        const storedValue = await this.credentialStore.get(binding.handle);
        if (!storedValue) return undefined;

        let stored: StoredDelegatedCredential;
        try {
          stored = parseStoredCredential(storedValue, binding);
        } catch (error) {
          await this.credentialStore.delete(binding.handle).catch(() => undefined);
          throw error;
        }

        const response = await this.refreshWithRotationRecovery(context, binding, storedValue, stored);
        return await this.createCredential(context, response, stored.subjectId, stored.tokenIssuer, true);
      }),
    );
  }

  private async refreshSingleFlight(
    context: ContentTrakerRequestSecurityContext,
    credential: CachedCredential,
  ): Promise<CachedCredential> {
    const existing = this.refreshFlights.get(credential.cacheKey);
    if (existing) {
      const refreshed = await existing;
      this.credentialsBySession.set(sessionKey(context), refreshed);
      return refreshed;
    }

    const flight = (async () => {
      const binding = resolveCredentialBinding(context, this.env);
      return await this.withCredentialMutation(
        binding.handle,
        async () => await this.withCrossProcessLock(binding.handle, async () => {
          const storedValue = await this.credentialStore.get(binding.handle);
          if (!storedValue) throw new Error("ContentTraker refresh credential is unavailable in the selected credential store.");
          const stored = parseStoredCredential(storedValue, binding, credential.subjectId);
          const tokenResponse = await this.refreshWithRotationRecovery(context, binding, storedValue, stored);
          return await this.createCredential(
            context,
            tokenResponse,
            credential.subjectId,
            stored.tokenIssuer,
            true,
          );
        }),
      );
    })().finally(() => this.refreshFlights.delete(credential.cacheKey));

    this.refreshFlights.set(credential.cacheKey, flight);
    const refreshed = await flight;
    this.credentialsBySession.set(sessionKey(context), refreshed);
    return refreshed;
  }

  private async refreshWithRotationRecovery(
    context: ContentTrakerRequestSecurityContext,
    binding: CredentialBinding,
    storedValue: string,
    stored: StoredDelegatedCredential,
  ): Promise<OAuthTokenResponse> {
    try {
      return await this.oauthClient.refresh(stored.refreshToken, context);
    } catch (error) {
      const latestValue = await this.credentialStore.get(binding.handle);
      if (!latestValue || latestValue === storedValue) throw error;
      const latest = parseStoredCredential(latestValue, binding, stored.subjectId);
      return await this.oauthClient.refresh(latest.refreshToken, context);
    }
  }

  private async createCredential(
    context: ContentTrakerRequestSecurityContext,
    response: OAuthTokenResponse,
    expectedSubjectId?: string,
    expectedTokenIssuer?: string,
    lockHeld = false,
  ): Promise<CachedCredential> {
    const profile = resolveAdapterEnvironment(this.env);
    if (!profile.oauthIssuer || response.resource !== context.tokenAudience) {
      throw new Error("ContentTraker OAuth returned a credential for the wrong resource.");
    }

    const claims = parseAndValidateJwt(response.accessToken, context, this.env);
    if (expectedSubjectId && claims.subjectId !== expectedSubjectId) {
      throw new Error("ContentTraker token refresh changed the authenticated subject.");
    }
    if (expectedTokenIssuer && claims.tokenIssuer !== expectedTokenIssuer) {
      throw new Error("ContentTraker token refresh changed the credential token issuer.");
    }

    const binding = resolveCredentialBinding(context, this.env);
    const persist = async (): Promise<CachedCredential> => {
      const existingValue = await this.credentialStore.get(binding.handle);
      if (existingValue) {
        const existing = parseStoredCredential(existingValue, binding);
        if (existing.subjectId !== claims.subjectId) {
          throw new Error("The configured ContentTraker credential profile is already bound to a different subject.");
        }
      }

      const stored: StoredDelegatedCredential = {
        version: 1,
        profile: binding.profile,
        environment: binding.environment,
        authorityIssuer: binding.authorityIssuer,
        tokenIssuer: claims.tokenIssuer,
        audience: binding.audience,
        clientId: binding.clientId,
        subjectId: claims.subjectId,
        refreshToken: response.refreshToken,
        revision: createHash("sha256").update(response.refreshToken).digest("hex"),
        updatedAt: new Date().toISOString(),
      };
      await this.credentialStore.set(binding.handle, JSON.stringify(stored));

      return Object.freeze({
        cacheKey: `${binding.handle}|${claims.subjectId}`,
        credentialProfile: binding.profile,
        accessToken: response.accessToken,
        authorityIssuer: binding.authorityIssuer,
        tokenIssuer: claims.tokenIssuer,
        subjectId: claims.subjectId,
        audience: context.tokenAudience,
        expiresAt: claims.expiresAt,
        credentialHandle: binding.handle,
        credentialVersion: createHash("sha256").update(response.accessToken).digest("hex"),
      });
    };

    if (lockHeld) return await persist();
    return await this.withCredentialMutation(
      binding.handle,
      async () => await this.withCrossProcessLock(binding.handle, persist),
    );
  }

  private async withCredentialMutation<T>(handle: string, action: () => Promise<T>): Promise<T> {
    const previous = this.credentialMutationTails.get(handle) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(action);
    const tail = result.then(() => undefined, () => undefined);
    this.credentialMutationTails.set(handle, tail);
    try {
      return await result;
    } finally {
      if (this.credentialMutationTails.get(handle) === tail) this.credentialMutationTails.delete(handle);
    }
  }

  private async withCrossProcessLock<T>(handle: string, action: () => Promise<T>): Promise<T> {
    return this.credentialStore.persistent
      ? await withCredentialStoreLock(handle, action)
      : await action();
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

function resolveCredentialBinding(
  context: ContentTrakerRequestSecurityContext,
  env: NodeJS.ProcessEnv,
): CredentialBinding {
  const configuredProfile = env.CONTENTTRAKER_CREDENTIAL_PROFILE?.trim() || "default";
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(configuredProfile)) {
    throw new Error(
      "CONTENTTRAKER_CREDENTIAL_PROFILE must be 1-64 letters, numbers, dots, underscores, or hyphens.",
    );
  }
  const profile = configuredProfile.toLowerCase();

  const environment = resolveAdapterEnvironment(env);
  if (!environment.oauthIssuer) {
    throw new Error("ContentTraker OAuth issuer configuration is unavailable for the credential profile.");
  }

  const bindingKey = [
    "v1",
    context.environment,
    environment.oauthIssuer,
    context.tokenAudience,
    CONTENTTRAKER_OAUTH_CLIENT_ID,
    profile,
  ].join("|");
  return {
    profile,
    handle: createCredentialHandle(bindingKey),
    environment: context.environment,
    authorityIssuer: environment.oauthIssuer,
    audience: context.tokenAudience,
    clientId: CONTENTTRAKER_OAUTH_CLIENT_ID,
  };
}

function parseStoredCredential(
  value: string,
  binding: CredentialBinding,
  expectedSubjectId?: string,
): StoredDelegatedCredential {
  let candidate: Partial<StoredDelegatedCredential>;
  try {
    candidate = JSON.parse(value) as Partial<StoredDelegatedCredential>;
  } catch {
    throw new Error("The stored ContentTraker credential record is malformed.");
  }

  const bindingMatches = candidate.version === 1
    && candidate.profile === binding.profile
    && candidate.environment === binding.environment
    && candidate.authorityIssuer === binding.authorityIssuer
    && candidate.audience === binding.audience
    && candidate.clientId === binding.clientId;
  const requiredValuesPresent = typeof candidate.tokenIssuer === "string" && candidate.tokenIssuer.length > 0
    && typeof candidate.subjectId === "string" && candidate.subjectId.length > 0
    && typeof candidate.refreshToken === "string" && candidate.refreshToken.length > 0
    && typeof candidate.revision === "string" && candidate.revision.length > 0
    && typeof candidate.updatedAt === "string" && Number.isFinite(Date.parse(candidate.updatedAt));
  const revisionMatches = typeof candidate.refreshToken === "string"
    && typeof candidate.revision === "string"
    && createHash("sha256").update(candidate.refreshToken).digest("hex") === candidate.revision;
  if (!bindingMatches || !requiredValuesPresent || !revisionMatches) {
    throw new Error("The stored ContentTraker credential binding is invalid.");
  }
  if (expectedSubjectId && candidate.subjectId !== expectedSubjectId) {
    throw new Error("The stored ContentTraker credential belongs to a different subject.");
  }
  return candidate as StoredDelegatedCredential;
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

function credentialFailure(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("credential profile") && message.includes("different subject")) {
    return "The configured ContentTraker credential profile is already bound to a different subject.";
  }
  if (message.includes("subject") || message.includes("token issuer")) {
    return "The restored ContentTraker credential changed its durable subject or token issuer and was rejected.";
  }
  if (message.includes("credential binding") || message.includes("credential record")) {
    return "The stored ContentTraker credential failed binding validation and cannot be restored.";
  }
  if (message.includes("credential") || message.includes("keychain") || message.includes("secret service")) {
    return "ContentTraker credential restoration is unavailable through the selected secure provider.";
  }
  return "ContentTraker credential restoration failed before interactive authorization could begin.";
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
