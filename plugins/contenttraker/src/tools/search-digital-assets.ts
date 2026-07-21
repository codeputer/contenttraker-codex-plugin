import type { ContentTrakerApiClient } from "../contenttraker-api-client.js";
import type { ContentTrakerRequestSecurityContext, SearchDigitalAssetsInput, SearchDigitalAssetsResult } from "../types.js";
import { loadWorkspaceRegistry, resolveContextFromRegistry } from "../workspace-registry.js";

export async function searchDigitalAssets(
  input: SearchDigitalAssetsInput,
  apiClient: ContentTrakerApiClient,
  securityContext: ContentTrakerRequestSecurityContext,
): Promise<SearchDigitalAssetsResult> {
  const api = apiClient.getStatus(securityContext);
  const registry = loadWorkspaceRegistry(api.environmentProfile.name);
  const selectedContext = resolveContextFromRegistry(input, registry);
  const result = await apiClient.searchDigitalAssets(input, selectedContext, securityContext);

  return {
    ...result,
    diagnostics: [...registry.errors, ...result.diagnostics],
  };
}
