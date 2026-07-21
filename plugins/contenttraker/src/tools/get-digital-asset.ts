import type { ContentTrakerApiClient } from "../contenttraker-api-client.js";
import type { ContentTrakerRequestSecurityContext, GetDigitalAssetInput, GetDigitalAssetResult } from "../types.js";
import { loadWorkspaceRegistry, resolveContextFromRegistry } from "../workspace-registry.js";

export async function getDigitalAsset(
  input: GetDigitalAssetInput,
  apiClient: ContentTrakerApiClient,
  securityContext: ContentTrakerRequestSecurityContext,
): Promise<GetDigitalAssetResult> {
  const api = apiClient.getStatus(securityContext);
  const registry = loadWorkspaceRegistry(api.environmentProfile.name);
  const selectedContext = resolveContextFromRegistry(input, registry);
  const result = await apiClient.getDigitalAsset(input, selectedContext, securityContext);

  return {
    ...result,
    diagnostics: [...registry.errors, ...result.diagnostics],
  };
}
