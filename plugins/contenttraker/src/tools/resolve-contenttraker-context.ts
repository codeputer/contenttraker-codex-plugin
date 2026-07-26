import type { ContentTrakerApiClient } from "../contenttraker-api-client.js";
import { resolveOperationContext } from "../context-resolution.js";
import type { ContentTrakerRequestSecurityContext, ResolveContextInput, ResolveContextResult } from "../types.js";

export async function resolveContentTrakerContext(
  input: ResolveContextInput,
  apiClient: ContentTrakerApiClient,
  securityContext: ContentTrakerRequestSecurityContext,
): Promise<ResolveContextResult> {
  const api = apiClient.getStatus(securityContext);
  const resolution = await resolveOperationContext(input, apiClient, securityContext);
  const selectedContext = resolution.selectedContext;
  const diagnostics: string[] = [
    ...resolution.diagnostics,
    ...api.writePolicy.diagnostics,
  ];

  if (!api.environmentProfile.valid) {
    diagnostics.push(
      `Invalid CONTENTTRAKER_ENVIRONMENT '${api.environmentProfile.requestedName}'; valid values are staging and production.`,
    );
  }

  if (!api.configured) {
    diagnostics.push(
      api.environmentProfile.name === "production"
        ? "CONTENTTRAKER_PRODUCTION_API_BASE_URL is not configured; production API calls are disabled."
        : "CONTENTTRAKER_STAGING_API_BASE_URL or CONTENTTRAKER_API_BASE_URL is not configured; API calls are disabled.",
    );
  }

  if (!api.tokenStrategy.configured) {
    diagnostics.push(api.tokenStrategy.mode === "workload-oauth"
      ? "ContentTraker workload OAuth is not available for this host and authorization-server contract."
      : api.tokenStrategy.mode === "invalid"
        ? "ContentTraker authentication mode configuration is invalid."
        : "ContentTraker delegated OAuth authentication is not configured.");
  }

  if (!resolution.blocked && !resolution.registry.exists && !selectedContext) {
    diagnostics.push("No worktree marker or workspace registry mapping was found; context is unconfigured.");
  } else if (!resolution.blocked && !resolution.registry.loaded) {
    diagnostics.push("Workspace registry exists but could not be loaded.");
  } else if (!resolution.blocked && !resolution.registry.environmentConfigured) {
    diagnostics.push(
      api.environmentProfile.name
        ? `Workspace registry loaded but has no '${api.environmentProfile.name}' environment mapping.`
        : "Workspace registry loaded but no valid environment is selected.",
    );
  } else if (!resolution.blocked && !selectedContext) {
    diagnostics.push(
      api.environmentProfile.name
        ? `Workspace registry loaded for '${api.environmentProfile.name}' but no mapping matched the request.`
        : "Workspace registry loaded but no mapping matched the request.",
    );
  }

  const status = resolution.blocked
    ? resolution.reset
      ? "reset"
      : resolution.failureStatus === "failed"
        ? "failed"
        : "blocked"
    : selectedContext?.source === "explicit-workspace" || selectedContext?.source === "worktree-marker"
      ? "resolved"
      : !resolution.registry.exists || !resolution.registry.environmentConfigured
        ? "unconfigured"
        : selectedContext?.source === "registry-project"
          ? "resolved"
          : "unresolved";

  return {
    status,
    selectedContext,
    registry: {
      path: resolution.registry.path,
      exists: resolution.registry.exists,
      loaded: resolution.registry.loaded,
      environment: resolution.registry.environment,
      environmentConfigured: resolution.registry.environmentConfigured,
      documentVersion: resolution.registry.documentVersion,
      projectCount: resolution.registry.projectCount,
    },
    worktree: resolution.marker ? {
      path: resolution.marker.path,
      exists: resolution.marker.exists,
      loaded: resolution.marker.loaded,
      bindingFound: Boolean(resolution.marker.binding),
      resetActive: Boolean(resolution.marker.reset),
      blocked: resolution.marker.blocked,
    } : undefined,
    correlationIds: resolution.correlationIds,
    api,
    diagnostics,
  };
}
