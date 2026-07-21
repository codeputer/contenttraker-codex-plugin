import type { ContentTrakerApiClient } from "../contenttraker-api-client.js";
import {
  loadWorkspaceRegistry,
  resolveContextFromRegistry,
} from "../workspace-registry.js";
import type { ContentTrakerRequestSecurityContext, ResolveContextInput, ResolveContextResult } from "../types.js";

export function resolveContentTrakerContext(
  input: ResolveContextInput,
  apiClient: ContentTrakerApiClient,
  securityContext: ContentTrakerRequestSecurityContext,
): ResolveContextResult {
  const api = apiClient.getStatus(securityContext);
  const environment = api.environmentProfile.name;
  const registry = loadWorkspaceRegistry(environment);
  const selectedContext = resolveContextFromRegistry(input, registry);
  const diagnostics: string[] = [
    ...registry.errors,
    ...api.writePolicy.diagnostics,
  ];

  if (!api.environmentProfile.valid) {
    diagnostics.push(
      `Invalid CONTENTTRAKER_ENVIRONMENT '${api.environmentProfile.requestedName}'; valid values are staging and production.`,
    );
  }

  if (!api.configured) {
    diagnostics.push(
      environment === "production"
        ? "CONTENTTRAKER_PRODUCTION_API_BASE_URL is not configured; production API calls are disabled."
        : "CONTENTTRAKER_STAGING_API_BASE_URL or CONTENTTRAKER_API_BASE_URL is not configured; API calls are disabled.",
    );
  }

  if (!api.tokenStrategy.configured) {
    diagnostics.push(api.tokenStrategy.mode === "service"
      ? "Explicit service authentication mode is missing its environment-specific service token."
      : "ContentTraker delegated OAuth authentication is not configured.");
  }

  if (!registry.exists) {
    diagnostics.push("No workspace registry was found; context mapping is unconfigured.");
  } else if (!registry.loaded) {
    diagnostics.push("Workspace registry exists but could not be loaded.");
  } else if (!registry.environmentConfigured) {
    diagnostics.push(
      environment
        ? `Workspace registry loaded but has no '${environment}' environment mapping.`
        : "Workspace registry loaded but no valid environment is selected.",
    );
  } else if (!selectedContext) {
    diagnostics.push(
      environment
        ? `Workspace registry loaded for '${environment}' but no mapping matched the request.`
        : "Workspace registry loaded but no mapping matched the request.",
    );
  }

  const status = !registry.exists || !registry.environmentConfigured
    ? "unconfigured"
    : selectedContext?.source === "registry-project"
      ? "resolved"
      : selectedContext?.source === "registry-default"
        ? "defaulted"
        : "unresolved";

  return {
    status,
    selectedContext,
    registry: {
      path: registry.path,
      exists: registry.exists,
      loaded: registry.loaded,
      environment: registry.environment,
      environmentConfigured: registry.environmentConfigured,
      documentVersion: registry.documentVersion,
      projectCount: registry.projectCount,
    },
    api,
    diagnostics,
  };
}
