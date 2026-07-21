import type {
  ContentTrakerEnvironment,
  EnvironmentProfileStatus,
  WritePolicyStatus,
} from "./types.js";

const ALLOWED_ENVIRONMENTS: ContentTrakerEnvironment[] = ["staging", "production"];

const DEFAULT_ENVIRONMENT_ENDPOINTS: Record<
  ContentTrakerEnvironment,
  { apiBaseUrl: string; oauthIssuer: string; oauthResource: string }
> = {
  staging: {
    apiBaseUrl: "https://mcp.staging.contenttraker.com",
    oauthIssuer: "https://tokenbroker.staging.contenttraker.com",
    oauthResource: "https://mcp.staging.contenttraker.com",
  },
  production: {
    apiBaseUrl: "https://mcp.prod.contenttraker.com",
    oauthIssuer: "https://tokenbroker.prod.contenttraker.com",
    oauthResource: "https://mcp.prod.contenttraker.com",
  },
};

export interface AdapterEnvironmentProfile {
  status: EnvironmentProfileStatus;
  apiBaseUrl?: string;
  apiBaseUrlSource?: string;
  oauthIssuer?: string;
  oauthResource?: string;
  writePolicy: WritePolicyStatus;
}

export function resolveAdapterEnvironment(env = process.env): AdapterEnvironmentProfile {
  const requestedName = (env.CONTENTTRAKER_ENVIRONMENT?.trim() || "staging").toLowerCase();
  const name = isContentTrakerEnvironment(requestedName) ? requestedName : undefined;
  const status: EnvironmentProfileStatus = {
    requestedName,
    name,
    valid: Boolean(name),
    allowedNames: ALLOWED_ENVIRONMENTS,
  };

  const defaults = name ? DEFAULT_ENVIRONMENT_ENDPOINTS[name] : undefined;
  const apiConfig = resolveEnvironmentValue(name, "API_BASE_URL", "CONTENTTRAKER_API_BASE_URL", env);
  const oauthIssuer = resolveEnvironmentValue(name, "OAUTH_ISSUER", "CONTENTTRAKER_OAUTH_ISSUER", env);
  const oauthResource = resolveEnvironmentValue(name, "OAUTH_RESOURCE", "CONTENTTRAKER_OAUTH_RESOURCE", env);

  return {
    status,
    apiBaseUrl: apiConfig.value ?? defaults?.apiBaseUrl,
    apiBaseUrlSource: apiConfig.source ?? (defaults ? "built-in-environment-profile" : undefined),
    oauthIssuer: oauthIssuer.value ?? defaults?.oauthIssuer,
    oauthResource: oauthResource.value ?? defaults?.oauthResource,
    writePolicy: resolveWritePolicy(status, env),
  };
}

function resolveEnvironmentValue(
  environment: ContentTrakerEnvironment | undefined,
  suffix: "API_BASE_URL" | "OAUTH_ISSUER" | "OAUTH_RESOURCE",
  stagingFallbackName:
    | "CONTENTTRAKER_API_BASE_URL"
    | "CONTENTTRAKER_OAUTH_ISSUER"
    | "CONTENTTRAKER_OAUTH_RESOURCE",
  env: NodeJS.ProcessEnv,
): { value?: string; source?: string } {
  if (!environment) {
    return {};
  }

  const scopedName = `CONTENTTRAKER_${environment.toUpperCase()}_${suffix}`;
  const scopedValue = env[scopedName]?.trim();
  if (scopedValue) {
    return { value: scopedValue, source: scopedName };
  }

  if (environment === "staging") {
    const fallbackValue = env[stagingFallbackName]?.trim();
    if (fallbackValue) {
      return { value: fallbackValue, source: stagingFallbackName };
    }
  }

  return {};
}

function resolveWritePolicy(
  profile: EnvironmentProfileStatus,
  env: NodeJS.ProcessEnv,
): WritePolicyStatus {
  const diagnostics: string[] = [];

  if (!profile.valid) {
    diagnostics.push(
      `CONTENTTRAKER_ENVIRONMENT must be one of: ${ALLOWED_ENVIRONMENTS.join(", ")}.`,
    );

    return {
      writesExposed: false,
      productionWritesEnabled: false,
      mode: "invalid-environment-read-only",
      requiresExplicitConfirmation: true,
      requiresIdempotencyKey: true,
      requiresDraftStatus: false,
      diagnostics,
    };
  }

  const productionWritesEnabled =
    profile.name === "production" && isTrue(env.CONTENTTRAKER_ENABLE_PRODUCTION_WRITES);

  if (profile.name === "production" && !productionWritesEnabled) {
    diagnostics.push(
      "Production writes are disabled unless CONTENTTRAKER_ENABLE_PRODUCTION_WRITES=true and a write tool enforces confirmation, idempotency, user approval, and lifecycle authorization.",
    );
  }

  return {
    writesExposed: profile.name === "staging" || productionWritesEnabled,
    productionWritesEnabled,
    mode:
      profile.name === "production"
        ? productionWritesEnabled
          ? "production-explicit-enabled"
          : "production-read-only"
        : "staging-writes-enabled",
    requiresExplicitConfirmation: true,
    requiresIdempotencyKey: true,
    requiresDraftStatus: false,
    diagnostics,
  };
}

function isContentTrakerEnvironment(value: string): value is ContentTrakerEnvironment {
  return ALLOWED_ENVIRONMENTS.includes(value as ContentTrakerEnvironment);
}

function isTrue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}
