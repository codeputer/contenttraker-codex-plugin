import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { createBrowserLauncher, type BrowserInteractionMode, type BrowserLauncher } from "./browser-interaction.js";
import {
  CONTENTTRAKER_OAUTH_SCOPES,
  ContentTrakerOAuthMetadataResolver,
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
}

export interface OAuthAuthorizationSession {
  authorizationUrl: string;
  redirectUri: string;
  expiresAt: string;
  interactionMode: BrowserInteractionMode;
  complete(): Promise<OAuthTokenResponse>;
  cancel(): Promise<void>;
}

export class ContentTrakerOAuthClient {
  constructor(
    private readonly issuer: string,
    private readonly browserLauncher: BrowserLauncher = createBrowserLauncher(),
    private readonly transport: OAuthTransport = new FetchOAuthTransport(),
    private readonly authorizationTimeoutMs = 180_000,
    private readonly metadataResolver = new ContentTrakerOAuthMetadataResolver(),
  ) {}

  get interactionMode(): BrowserInteractionMode {
    return this.browserLauncher.mode;
  }

  async authorize(
    securityContext: ContentTrakerRequestSecurityContext,
    signal?: AbortSignal,
  ): Promise<OAuthTokenResponse> {
    if (this.browserLauncher.mode === "manual-url") {
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
      } catch (error) {
        await session.cancel();
        throw error;
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

class FetchOAuthTransport implements OAuthTransport {
  async exchangeToken(tokenEndpoint: URL, parameters: URLSearchParams): Promise<OAuthTokenResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    timeout.unref();
    try {
      const response = await fetch(tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: parameters,
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`ContentTraker OAuth token endpoint returned HTTP ${response.status}.`);
      }

      const json = await readBoundedJson(response, 65_536);
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
    } finally {
      clearTimeout(timeout);
    }
  }
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
