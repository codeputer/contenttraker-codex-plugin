import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

import type { ContentTrakerRequestSecurityContext } from "./types.js";

const CLIENT_ID = "codex-mcp";
const DEFAULT_SCOPES = [
  "workspaces:read",
  "workspaces:write",
  "projects:read",
  "projects:write",
  "digital_assets:read",
  "digital_assets:write",
  "digital_assets:review",
];

export interface OAuthTokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  scope: string;
  resource: string;
}

export interface BrowserLauncher {
  open(url: URL): Promise<void>;
}

export interface OAuthTransport {
  exchangeToken(tokenEndpoint: URL, parameters: URLSearchParams): Promise<OAuthTokenResponse>;
}

export class ContentTrakerOAuthClient {
  constructor(
    private readonly issuer: string,
    private readonly browserLauncher: BrowserLauncher = new SystemBrowserLauncher(),
    private readonly transport: OAuthTransport = new FetchOAuthTransport(),
  ) {}

  async authorize(
    securityContext: ContentTrakerRequestSecurityContext,
    signal?: AbortSignal,
  ): Promise<OAuthTokenResponse> {
    const issuer = validateHttpsOrigin(this.issuer, "OAuth issuer");
    const authorizationEndpoint = new URL("/oauth/authorize", issuer);
    const tokenEndpoint = new URL("/oauth/token", issuer);
    const verifier = randomBytes(64).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(32).toString("base64url");
    const callback = await createLoopbackCallback(state, signal);

    try {
      const authorizationUrl = new URL(authorizationEndpoint);
      authorizationUrl.search = new URLSearchParams({
        response_type: "code",
        client_id: CLIENT_ID,
        redirect_uri: callback.redirectUri,
        scope: DEFAULT_SCOPES.join(" "),
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: securityContext.tokenAudience,
      }).toString();

      await this.browserLauncher.open(authorizationUrl);
      const code = await callback.authorizationCode;
      return await this.transport.exchangeToken(tokenEndpoint, new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: callback.redirectUri,
        client_id: CLIENT_ID,
        code_verifier: verifier,
        resource: securityContext.tokenAudience,
      }));
    } finally {
      await callback.close();
    }
  }

  async refresh(
    refreshToken: string,
    securityContext: ContentTrakerRequestSecurityContext,
  ): Promise<OAuthTokenResponse> {
    const issuer = validateHttpsOrigin(this.issuer, "OAuth issuer");
    return await this.transport.exchangeToken(new URL("/oauth/token", issuer), new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      resource: securityContext.tokenAudience,
      scope: DEFAULT_SCOPES.join(" "),
    }));
  }
}

class FetchOAuthTransport implements OAuthTransport {
  async exchangeToken(tokenEndpoint: URL, parameters: URLSearchParams): Promise<OAuthTokenResponse> {
    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: parameters,
      redirect: "error",
    });
    if (!response.ok) {
      throw new Error(`ContentTraker OAuth token endpoint returned HTTP ${response.status}.`);
    }

    const json = await response.json() as Record<string, unknown>;
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
}

class SystemBrowserLauncher implements BrowserLauncher {
  async open(url: URL): Promise<void> {
    const command = process.platform === "win32"
      ? { file: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url.toString()] }
      : process.platform === "darwin"
        ? { file: "open", args: [url.toString()] }
        : { file: "xdg-open", args: [url.toString()] };

    await new Promise<void>((resolve, reject) => {
      const child = spawn(command.file, command.args, { detached: true, stdio: "ignore", windowsHide: true });
      child.once("error", () => reject(new Error("ContentTraker OAuth browser launch failed.")));
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  }
}

async function createLoopbackCallback(state: string, signal?: AbortSignal): Promise<{
  redirectUri: string;
  authorizationCode: Promise<string>;
  close: () => Promise<void>;
}> {
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
      resolveCode(code);
    } catch {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("ContentTraker authorization callback failed.");
      rejectCode(new Error("ContentTraker OAuth callback validation failed."));
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

  const timeout = setTimeout(() => rejectCode(new Error("ContentTraker OAuth authorization timed out.")), 180_000);
  timeout.unref();
  signal?.addEventListener("abort", () => rejectCode(new Error("ContentTraker OAuth authorization was cancelled.")), { once: true });

  return {
    redirectUri: `http://127.0.0.1:${address.port}/oauth/callback`,
    authorizationCode,
    close: async () => {
      clearTimeout(timeout);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function validateHttpsOrigin(value: string, name: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an HTTPS origin.`);
  }
  return new URL(url.origin);
}
