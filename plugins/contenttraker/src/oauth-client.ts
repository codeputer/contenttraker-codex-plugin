import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { createBrowserLauncher, type BrowserInteractionMode, type BrowserLauncher } from "./browser-interaction.js";
import {
  CONTENTTRAKER_OAUTH_SCOPES,
  ContentTrakerOAuthMetadataResolver,
  type ResolvedOAuthMetadata,
} from "./oauth-metadata.js";
import type { ContentTrakerRequestSecurityContext } from "./types.js";

export const CONTENTTRAKER_OAUTH_CLIENT_ID = "codex-mcp";

export interface OAuthTokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  scope: string;
  resource: string;
}

export interface OAuthTransport {
  exchangeToken(tokenEndpoint: URL, parameters: URLSearchParams): Promise<OAuthTokenResponse>;
  beginDeviceAuthorization?(
    deviceAuthorizationEndpoint: URL,
    parameters: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<OAuthDeviceAuthorizationResponse>;
  pollDeviceToken?(
    tokenEndpoint: URL,
    parameters: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<OAuthDeviceTokenPollResult>;
}

export interface OAuthDeviceAuthorizationResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

export type OAuthDeviceTokenPollResult =
  | { status: "pending" | "slow-down" }
  | { status: "denied" | "expired" }
  | { status: "authorized"; token: OAuthTokenResponse };

export type OAuthInteractionMode = BrowserInteractionMode | "device-code";

export interface OAuthDevicePollTiming {
  secondsToMilliseconds: number;
  minimumIntervalMilliseconds: number;
  slowDownIncrementMilliseconds: number;
}

type DelegatedFlow = "authorization-code" | "device-code";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const MAXIMUM_DEVICE_LIFETIME_SECONDS = 900;
const MAXIMUM_DEVICE_POLL_INTERVAL_SECONDS = 60;
const DEFAULT_DEVICE_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_DEVICE_POLL_TIMING: OAuthDevicePollTiming = {
  secondsToMilliseconds: 1_000,
  minimumIntervalMilliseconds: 1_000,
  slowDownIncrementMilliseconds: 5_000,
};

export interface OAuthAuthorizationSession {
  authorizationUrl: string;
  redirectUri?: string;
  verificationUri?: string;
  userCode?: string;
  intervalSeconds?: number;
  expiresAt: string;
  interactionMode: OAuthInteractionMode;
  launchDiagnostic?: string;
  complete(): Promise<OAuthTokenResponse>;
  cancel(): Promise<void>;
}

export class ContentTrakerOAuthClient {
  constructor(
    private readonly issuer: string,
    private readonly browserLauncher: BrowserLauncher = createBrowserLauncher(),
    private readonly transport: OAuthTransport = new FetchOAuthTransport(),
    private readonly authorizationTimeoutMs = 600_000,
    private readonly metadataResolver = new ContentTrakerOAuthMetadataResolver(),
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly devicePollTiming: OAuthDevicePollTiming = DEFAULT_DEVICE_POLL_TIMING,
  ) {}

  get interactionMode(): BrowserInteractionMode {
    return this.browserLauncher.mode;
  }

  async authorize(
    securityContext: ContentTrakerRequestSecurityContext,
    signal?: AbortSignal,
  ): Promise<OAuthTokenResponse> {
    const metadata = await this.metadataResolver.resolve(this.issuer, securityContext.tokenAudience);
    const delegatedFlow = resolveDelegatedFlow(this.env, this.browserLauncher.mode, metadata);
    if (delegatedFlow === "authorization-code" && this.browserLauncher.mode === "manual-url") {
      throw new Error(
        "Manual authorization is configured. Call begin_contenttraker_authorization and open the returned URL inside the intended host boundary.",
      );
    }
    const session = await this.beginAuthorization(securityContext, true, signal);
    return await session.complete();
  }

  async beginAuthorization(
    securityContext: ContentTrakerRequestSecurityContext,
    launchBrowser = true,
    signal?: AbortSignal,
  ): Promise<OAuthAuthorizationSession> {
    const metadata = await this.metadataResolver.resolve(this.issuer, securityContext.tokenAudience);
    const delegatedFlow = resolveDelegatedFlow(this.env, this.browserLauncher.mode, metadata);
    if (delegatedFlow === "device-code") {
      return await this.beginDeviceAuthorization(metadata, securityContext, launchBrowser, signal);
    }
    const authorizationEndpoint = new URL(metadata.authorizationEndpoint);
    const tokenEndpoint = new URL(metadata.tokenEndpoint);
    const verifier = randomBytes(64).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(32).toString("base64url");
    const callback = await createLoopbackCallback(state, this.authorizationTimeoutMs, signal);
    const authorizationUrl = new URL(authorizationEndpoint);
    authorizationUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: CONTENTTRAKER_OAUTH_CLIENT_ID,
      redirect_uri: callback.redirectUri,
      scope: CONTENTTRAKER_OAUTH_SCOPES.join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: securityContext.tokenAudience,
    }).toString();

    const completion = (async () => {
      try {
        const code = await callback.authorizationCode;
        return validateTokenResponse(await this.transport.exchangeToken(tokenEndpoint, new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: callback.redirectUri,
          client_id: CONTENTTRAKER_OAUTH_CLIENT_ID,
          code_verifier: verifier,
          resource: securityContext.tokenAudience,
        })), securityContext.tokenAudience);
      } finally {
        await callback.close();
      }
    })();
    void completion.catch(() => undefined);

    const session: OAuthAuthorizationSession = {
      authorizationUrl: authorizationUrl.toString(),
      redirectUri: callback.redirectUri,
      expiresAt: new Date(Date.now() + this.authorizationTimeoutMs).toISOString(),
      interactionMode: this.browserLauncher.mode,
      complete: async () => await completion,
      cancel: async () => await callback.cancel(),
    };

    if (launchBrowser && this.browserLauncher.mode !== "manual-url") {
      try {
        await this.browserLauncher.open(authorizationUrl);
      } catch {
        session.launchDiagnostic =
          "The optional browser launch failed. Open authorizationUrl manually; the adapter is still waiting on its local callback.";
      }
    }

    return session;
  }

  private async beginDeviceAuthorization(
    metadata: ResolvedOAuthMetadata,
    securityContext: ContentTrakerRequestSecurityContext,
    launchBrowser: boolean,
    signal?: AbortSignal,
  ): Promise<OAuthAuthorizationSession> {
    if (!metadata.deviceAuthorizationAvailable || !metadata.deviceAuthorizationEndpoint) {
      throw new Error("ContentTraker OAuth metadata does not advertise device authorization.");
    }
    if (!this.transport.beginDeviceAuthorization || !this.transport.pollDeviceToken) {
      throw new Error("The ContentTraker device authorization provider is unavailable.");
    }

    const response = await this.transport.beginDeviceAuthorization(
      new URL(metadata.deviceAuthorizationEndpoint),
      new URLSearchParams({
        client_id: CONTENTTRAKER_OAUTH_CLIENT_ID,
        scope: CONTENTTRAKER_OAUTH_SCOPES.join(" "),
        resource: securityContext.tokenAudience,
      }),
      signal,
    );
    const lifetimeMilliseconds = Math.min(
      validatePositiveNumber(response.expiresInSeconds, "device authorization expiry") * 1_000,
      MAXIMUM_DEVICE_LIFETIME_SECONDS * 1_000,
      Math.max(1, this.authorizationTimeoutMs),
    );
    let intervalMilliseconds = Math.max(
      this.devicePollTiming.minimumIntervalMilliseconds,
      validatePositiveNumber(response.intervalSeconds, "device polling interval")
        * this.devicePollTiming.secondsToMilliseconds,
    );
    if (intervalMilliseconds > MAXIMUM_DEVICE_POLL_INTERVAL_SECONDS * 1_000) {
      throw new Error("ContentTraker OAuth device polling interval exceeds the supported bound.");
    }
    const expiresAtMilliseconds = Date.now() + lifetimeMilliseconds;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const pollDeviceToken = this.transport.pollDeviceToken.bind(this.transport);

    const completion = (async () => {
      try {
        while (Date.now() < expiresAtMilliseconds) {
          await abortableDelay(intervalMilliseconds, controller.signal);
          if (Date.now() >= expiresAtMilliseconds) break;
          const result = await pollDeviceToken(
            new URL(metadata.tokenEndpoint),
            new URLSearchParams({
              grant_type: DEVICE_GRANT,
              device_code: response.deviceCode,
              client_id: CONTENTTRAKER_OAUTH_CLIENT_ID,
              resource: securityContext.tokenAudience,
            }),
            controller.signal,
          );
          if (result.status === "authorized") {
            return validateTokenResponse(result.token, securityContext.tokenAudience);
          }
          if (result.status === "slow-down") {
            const slowedInterval = intervalMilliseconds + this.devicePollTiming.slowDownIncrementMilliseconds;
            if (slowedInterval > MAXIMUM_DEVICE_POLL_INTERVAL_SECONDS * 1_000) {
              throw new Error("ContentTraker OAuth device polling interval exceeded the supported bound.");
            }
            intervalMilliseconds = slowedInterval;
            continue;
          }
          if (result.status === "denied") {
            throw new Error("ContentTraker OAuth device authorization was denied.");
          }
          if (result.status === "expired") {
            throw new Error("ContentTraker OAuth device authorization expired.");
          }
        }
        throw new Error("ContentTraker OAuth device authorization timed out.");
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    })();
    void completion.catch(() => undefined);

    const authorizationUrl = response.verificationUriComplete ?? response.verificationUri;
    const session: OAuthAuthorizationSession = {
      authorizationUrl,
      verificationUri: response.verificationUri,
      userCode: response.userCode,
      intervalSeconds: intervalMilliseconds / 1_000,
      expiresAt: new Date(expiresAtMilliseconds).toISOString(),
      interactionMode: "device-code",
      complete: async () => await completion,
      cancel: async () => controller.abort(),
    };

    if (launchBrowser && this.browserLauncher.mode !== "manual-url" && this.browserLauncher.mode !== "invalid") {
      try {
        await this.browserLauncher.open(new URL(authorizationUrl));
      } catch {
        session.launchDiagnostic =
          "The optional browser launch failed. Open verificationUri on another device and enter userCode; device polling remains active in this process.";
      }
    }

    return session;
  }

  async refresh(
    refreshToken: string,
    securityContext: ContentTrakerRequestSecurityContext,
  ): Promise<OAuthTokenResponse> {
    const metadata = await this.metadataResolver.resolve(this.issuer, securityContext.tokenAudience);
    return validateTokenResponse(await this.transport.exchangeToken(new URL(metadata.tokenEndpoint), new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CONTENTTRAKER_OAUTH_CLIENT_ID,
      resource: securityContext.tokenAudience,
      scope: CONTENTTRAKER_OAUTH_SCOPES.join(" "),
    })), securityContext.tokenAudience);
  }
}

export class FetchOAuthTransport implements OAuthTransport {
  async exchangeToken(tokenEndpoint: URL, parameters: URLSearchParams): Promise<OAuthTokenResponse> {
    const { response, json } = await postFormJson(tokenEndpoint, parameters);
    if (!response.ok) {
      throw new Error(`ContentTraker OAuth token endpoint returned HTTP ${response.status}.`);
    }
    return tokenResponseFromJson(json);
  }

  async beginDeviceAuthorization(
    deviceAuthorizationEndpoint: URL,
    parameters: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<OAuthDeviceAuthorizationResponse> {
    const { response, json } = await postFormJson(deviceAuthorizationEndpoint, parameters, signal);
    if (!response.ok) throw new Error("ContentTraker OAuth device authorization endpoint rejected the request.");
    const deviceCode = boundedString(json.device_code, "device code", 4_096);
    const userCode = boundedString(json.user_code, "user code", 128);
    const verificationUri = userFacingHttpsUrl(json.verification_uri, "verification URI");
    const verificationUriComplete = json.verification_uri_complete === undefined
      ? undefined
      : userFacingHttpsUrl(json.verification_uri_complete, "complete verification URI");
    const expiresInSeconds = validatePositiveNumber(json.expires_in, "device authorization expiry");
    const intervalSeconds = json.interval === undefined
      ? DEFAULT_DEVICE_POLL_INTERVAL_SECONDS
      : validatePositiveNumber(json.interval, "device polling interval");
    if (intervalSeconds > MAXIMUM_DEVICE_POLL_INTERVAL_SECONDS) {
      throw new Error("ContentTraker OAuth device polling interval exceeds the supported bound.");
    }
    return Object.freeze({
      deviceCode,
      userCode,
      verificationUri,
      verificationUriComplete,
      expiresInSeconds,
      intervalSeconds,
    });
  }

  async pollDeviceToken(
    tokenEndpoint: URL,
    parameters: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<OAuthDeviceTokenPollResult> {
    const { response, json } = await postFormJson(tokenEndpoint, parameters, signal);
    if (response.ok) return { status: "authorized", token: tokenResponseFromJson(json) };
    const code = typeof json.error === "string" ? json.error : "";
    if (code === "authorization_pending") return { status: "pending" };
    if (code === "slow_down") return { status: "slow-down" };
    if (code === "access_denied") return { status: "denied" };
    if (code === "expired_token") return { status: "expired" };
    throw new Error("ContentTraker OAuth device token endpoint rejected the request.");
  }
}

async function postFormJson(
  endpoint: URL,
  parameters: URLSearchParams,
  signal?: AbortSignal,
): Promise<{ response: Response; json: Record<string, unknown> }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  timeout.unref();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: parameters,
      redirect: "error",
      signal: controller.signal,
    });
    return { response, json: await readBoundedJson(response, 65_536) };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

function tokenResponseFromJson(json: Record<string, unknown>): OAuthTokenResponse {
  if (typeof json.access_token !== "string" || typeof json.refresh_token !== "string") {
    throw new Error("ContentTraker OAuth token response did not contain the required credentials.");
  }
  return Object.freeze({
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresInSeconds: typeof json.expires_in === "number" ? json.expires_in : 0,
    scope: typeof json.scope === "string" ? json.scope : "",
    resource: typeof json.resource === "string" ? json.resource : "",
  });
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error("ContentTraker OAuth token response body is missing.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("ContentTraker OAuth token response exceeded the size limit.");
    }
    chunks.push(value);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("ContentTraker OAuth token response was not valid JSON.");
  }
}

async function createLoopbackCallback(state: string, timeoutMs: number, signal?: AbortSignal): Promise<{
  redirectUri: string;
  authorizationCode: Promise<string>;
  close: () => Promise<void>;
  cancel: () => Promise<void>;
}> {
  let settled = false;
  let closed = false;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const authorizationCode = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/oauth/callback" || url.searchParams.get("state") !== state) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("ContentTraker authorization callback was rejected.");
        return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        throw new Error("ContentTraker authorization callback did not include a code.");
      }

      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("ContentTraker authorization succeeded. Return to Codex.");
      if (!settled) {
        settled = true;
        resolveCode(code);
      }
    } catch {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("ContentTraker authorization callback failed.");
      if (!settled) {
        settled = true;
        rejectCode(new Error("ContentTraker OAuth callback validation failed."));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("ContentTraker OAuth loopback callback could not bind to a local port.");
  }

  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectCode(new Error("ContentTraker OAuth authorization timed out."));
    }
  }, timeoutMs);
  timeout.unref();
  const abort = () => {
    if (!settled) {
      settled = true;
      rejectCode(new Error("ContentTraker OAuth authorization was cancelled."));
    }
  };
  signal?.addEventListener("abort", abort, { once: true });

  const close = async () => {
    if (closed) return;
    closed = true;
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    if (!server.listening) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return {
    redirectUri: `http://127.0.0.1:${address.port}/oauth/callback`,
    authorizationCode,
    close,
    cancel: async () => {
      abort();
      await close();
    },
  };
}

function validateTokenResponse(response: OAuthTokenResponse, expectedResource: string): OAuthTokenResponse {
  if (response.resource !== expectedResource) {
    throw new Error("ContentTraker OAuth token response resource does not match the protected resource.");
  }
  const grantedScopes = new Set(response.scope.split(/\s+/u).filter(Boolean));
  if (CONTENTTRAKER_OAUTH_SCOPES.some((scope) => !grantedScopes.has(scope))) {
    throw new Error("ContentTraker OAuth token response did not grant every required scope.");
  }
  return response;
}

function resolveDelegatedFlow(
  env: NodeJS.ProcessEnv,
  browserMode: BrowserInteractionMode,
  metadata: ResolvedOAuthMetadata,
): DelegatedFlow {
  const requested = env.CONTENTTRAKER_DELEGATED_FLOW?.trim().toLowerCase() || "auto";
  if (!["auto", "authorization-code", "device-code"].includes(requested)) {
    throw new Error("CONTENTTRAKER_DELEGATED_FLOW must be auto, authorization-code, or device-code.");
  }
  if (browserMode === "invalid") {
    throw new Error("ContentTraker browser interaction configuration is invalid.");
  }
  if (requested === "device-code") {
    if (!metadata.deviceAuthorizationAvailable || !metadata.deviceAuthorizationEndpoint) {
      throw new Error("ContentTraker OAuth metadata does not advertise device authorization.");
    }
    return "device-code";
  }
  if (requested === "authorization-code") return "authorization-code";
  return browserMode === "manual-url" && metadata.deviceAuthorizationAvailable
    ? "device-code"
    : "authorization-code";
}

function boundedString(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    throw new Error(`ContentTraker OAuth ${label} is invalid.`);
  }
  return value;
}

function userFacingHttpsUrl(value: unknown, label: string): string {
  const raw = boundedString(value, label, 2_048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`ContentTraker OAuth ${label} is invalid.`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(`ContentTraker OAuth ${label} must be a credential-free HTTPS URL.`);
  }
  return url.toString();
}

function validatePositiveNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`ContentTraker OAuth ${label} is invalid.`);
  }
  return value;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("ContentTraker OAuth authorization was cancelled."));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      reject(new Error("ContentTraker OAuth authorization was cancelled."));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
