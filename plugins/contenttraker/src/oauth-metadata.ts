const REQUIRED_SCOPES = [
  "workspaces:read",
  "workspaces:write",
  "projects:read",
  "projects:write",
  "digital_assets:read",
  "digital_assets:write",
  "digital_assets:review",
] as const;
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const WORKLOAD_GRANTS = [
  "client_credentials",
  "urn:ietf:params:oauth:grant-type:token-exchange",
  "urn:ietf:params:oauth:grant-type:jwt-bearer",
] as const;

export const CONTENTTRAKER_OAUTH_SCOPES: readonly string[] = REQUIRED_SCOPES;

export interface ResolvedOAuthMetadata {
  issuer: string;
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  deviceAuthorizationEndpoint?: string;
  scopesSupported: string[];
  grantTypesSupported: string[];
  deviceAuthorizationAvailable: boolean;
  workloadGrantsAdvertised: string[];
  fetchedAt: string;
  expiresAt: string;
}

export interface OAuthMetadataInspectionResult {
  status: "ready" | "blocked";
  issuer: string;
  resource: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  requiredScopes: string[];
  supportedScopes: string[];
  delegatedAuthorizationCode: boolean;
  deviceAuthorization: boolean;
  workloadAuthorization: boolean;
  workloadGrantsAdvertised: string[];
  metadataExpiresAt?: string;
  diagnostics: string[];
}

export interface OAuthMetadataFetcher {
  getJson(url: URL): Promise<unknown>;
}

interface CachedMetadata {
  value: ResolvedOAuthMetadata;
  expiresAtMilliseconds: number;
}

export class ContentTrakerOAuthMetadataResolver {
  private readonly cache = new Map<string, CachedMetadata>();
  private readonly flights = new Map<string, Promise<ResolvedOAuthMetadata>>();

  constructor(
    private readonly fetcher: OAuthMetadataFetcher = new FetchOAuthMetadataFetcher(),
    private readonly cacheTtlMilliseconds = 300_000,
  ) {}

  async resolve(issuer: string, resource: string): Promise<ResolvedOAuthMetadata> {
    const validatedIssuer = validateHttpsOrigin(issuer, "OAuth issuer");
    const validatedResource = validateHttpsOrigin(resource, "OAuth protected resource");
    const key = `${validatedIssuer.origin}|${validatedResource.origin}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAtMilliseconds > Date.now()) return cached.value;

    const existing = this.flights.get(key);
    if (existing) return await existing;
    const flight = this.fetchAndValidate(validatedIssuer, validatedResource)
      .then((value) => {
        this.cache.set(key, { value, expiresAtMilliseconds: Date.parse(value.expiresAt) });
        return value;
      })
      .finally(() => this.flights.delete(key));
    this.flights.set(key, flight);
    return await flight;
  }

  async inspect(issuer: string, resource: string): Promise<OAuthMetadataInspectionResult> {
    try {
      const metadata = await this.resolve(issuer, resource);
      return {
        status: "ready",
        issuer: metadata.issuer,
        resource: metadata.resource,
        authorizationEndpoint: metadata.authorizationEndpoint,
        tokenEndpoint: metadata.tokenEndpoint,
        requiredScopes: [...REQUIRED_SCOPES],
        supportedScopes: metadata.scopesSupported,
        delegatedAuthorizationCode: true,
        deviceAuthorization: metadata.deviceAuthorizationAvailable,
        workloadAuthorization: metadata.workloadGrantsAdvertised.length > 0,
        workloadGrantsAdvertised: metadata.workloadGrantsAdvertised,
        metadataExpiresAt: metadata.expiresAt,
        diagnostics: [
          ...(metadata.deviceAuthorizationAvailable
            ? []
            : ["The authorization server does not advertise device authorization."]),
          ...(metadata.workloadGrantsAdvertised.length > 0
            ? []
            : ["The authorization server does not advertise a supported workload OAuth grant."]),
        ],
      };
    } catch (error) {
      return {
        status: "blocked",
        issuer: safeOrigin(issuer),
        resource: safeOrigin(resource),
        requiredScopes: [...REQUIRED_SCOPES],
        supportedScopes: [],
        delegatedAuthorizationCode: false,
        deviceAuthorization: false,
        workloadAuthorization: false,
        workloadGrantsAdvertised: [],
        diagnostics: [metadataFailure(error)],
      };
    }
  }

  clear(): void {
    this.cache.clear();
  }

  private async fetchAndValidate(issuer: URL, resource: URL): Promise<ResolvedOAuthMetadata> {
    let protectedResourceRaw: unknown;
    let authorizationServerRaw: unknown;
    try {
      [protectedResourceRaw, authorizationServerRaw] = await Promise.all([
        this.fetcher.getJson(new URL("/.well-known/oauth-protected-resource", resource)),
        this.fetcher.getJson(new URL("/.well-known/oauth-authorization-server", issuer)),
      ]);
    } catch {
      throw new Error("ContentTraker OAuth metadata could not be fetched over HTTPS.");
    }

    const protectedResource = objectRecord(protectedResourceRaw, "protected-resource");
    const authorizationServer = objectRecord(authorizationServerRaw, "authorization-server");
    if (protectedResource.resource !== resource.origin) {
      throw new Error("ContentTraker protected-resource metadata does not match the configured resource.");
    }
    const authorizationServers = stringArray(protectedResource.authorization_servers);
    if (!authorizationServers.includes(issuer.origin)) {
      throw new Error("ContentTraker protected-resource metadata does not name the configured authorization server.");
    }
    if (authorizationServer.issuer !== issuer.origin) {
      throw new Error("ContentTraker authorization-server metadata issuer does not match configuration.");
    }

    const authorizationEndpoint = sameOriginHttpsEndpoint(
      authorizationServer.authorization_endpoint,
      issuer,
      "authorization endpoint",
    );
    const tokenEndpoint = sameOriginHttpsEndpoint(
      authorizationServer.token_endpoint,
      issuer,
      "token endpoint",
    );
    const responseTypes = stringArray(authorizationServer.response_types_supported);
    const grants = stringArray(authorizationServer.grant_types_supported);
    const challengeMethods = stringArray(authorizationServer.code_challenge_methods_supported);
    const tokenAuthMethods = stringArray(authorizationServer.token_endpoint_auth_methods_supported);
    const authorizationScopes = stringArray(authorizationServer.scopes_supported);
    const resourceScopes = stringArray(protectedResource.scopes_supported);
    const bearerMethods = stringArray(protectedResource.bearer_methods_supported);

    requireAll(REQUIRED_SCOPES, authorizationScopes, "authorization-server scopes");
    requireAll(REQUIRED_SCOPES, resourceScopes, "protected-resource scopes");
    if (!responseTypes.includes("code")) throw new Error("ContentTraker OAuth metadata does not support code responses.");
    if (!grants.includes("authorization_code") || !grants.includes("refresh_token")) {
      throw new Error("ContentTraker OAuth metadata does not support authorization-code and refresh grants.");
    }
    if (!challengeMethods.includes("S256")) throw new Error("ContentTraker OAuth metadata does not support PKCE S256.");
    if (!tokenAuthMethods.includes("none")) throw new Error("ContentTraker OAuth metadata does not support the public client.");
    if (!bearerMethods.includes("header")) throw new Error("ContentTraker protected-resource metadata does not support bearer headers.");

    const deviceEndpointValue = authorizationServer.device_authorization_endpoint;
    const deviceAuthorizationEndpoint = typeof deviceEndpointValue === "string"
      ? sameOriginHttpsEndpoint(deviceEndpointValue, issuer, "device authorization endpoint").toString()
      : undefined;
    const deviceAuthorizationAvailable = Boolean(deviceAuthorizationEndpoint && grants.includes(DEVICE_GRANT));
    const workloadGrantsAdvertised = WORKLOAD_GRANTS.filter((grant) => grants.includes(grant));
    const fetchedAtMilliseconds = Date.now();
    return Object.freeze({
      issuer: issuer.origin,
      resource: resource.origin,
      authorizationEndpoint: authorizationEndpoint.toString(),
      tokenEndpoint: tokenEndpoint.toString(),
      deviceAuthorizationEndpoint,
      scopesSupported: unique(authorizationScopes.filter((scope) => resourceScopes.includes(scope))),
      grantTypesSupported: unique(grants),
      deviceAuthorizationAvailable,
      workloadGrantsAdvertised: [...workloadGrantsAdvertised],
      fetchedAt: new Date(fetchedAtMilliseconds).toISOString(),
      expiresAt: new Date(fetchedAtMilliseconds + this.cacheTtlMilliseconds).toISOString(),
    });
  }
}

class FetchOAuthMetadataFetcher implements OAuthMetadataFetcher {
  async getJson(url: URL): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    timeout.unref();
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("OAuth metadata endpoint returned an error.");
      return await readBoundedJson(response, 65_536);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function validateHttpsOrigin(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is invalid.`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error(`${label} must be a credential-free HTTPS origin.`);
  }
  return url;
}

function sameOriginHttpsEndpoint(value: unknown, issuer: URL, label: string): URL {
  if (typeof value !== "string") throw new Error(`ContentTraker OAuth ${label} is missing.`);
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error(`ContentTraker OAuth ${label} is invalid.`);
  }
  if (endpoint.protocol !== "https:" || endpoint.origin !== issuer.origin
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error(`ContentTraker OAuth ${label} must use the configured HTTPS authority origin.`);
  }
  return endpoint;
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  if (!response.body) throw new Error("ContentTraker OAuth metadata response body is missing.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("ContentTraker OAuth metadata response exceeded the size limit.");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("ContentTraker OAuth metadata response was not valid JSON.");
  }
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`ContentTraker ${label} metadata is invalid.`);
  }
  return value as Record<string, unknown>;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function requireAll(required: readonly string[], available: string[], label: string): void {
  if (required.some((scope) => !available.includes(scope))) {
    throw new Error(`ContentTraker OAuth ${label} do not include all required scopes.`);
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function metadataFailure(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("fetch")) return "ContentTraker OAuth metadata could not be fetched over HTTPS.";
  if (message.includes("scope")) return "ContentTraker OAuth metadata is missing required scopes.";
  if (message.includes("pkce")) return "ContentTraker OAuth metadata does not advertise PKCE S256.";
  if (message.includes("public client")) return "ContentTraker OAuth metadata does not permit public-client token exchange.";
  if (message.includes("protected-resource")) return "ContentTraker protected-resource metadata binding is invalid.";
  if (message.includes("issuer") || message.includes("authority") || message.includes("endpoint")) {
    return "ContentTraker authorization-server metadata binding is invalid.";
  }
  return "ContentTraker OAuth metadata does not satisfy the required delegated contract.";
}

function safeOrigin(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : "invalid";
  } catch {
    return "invalid";
  }
}
