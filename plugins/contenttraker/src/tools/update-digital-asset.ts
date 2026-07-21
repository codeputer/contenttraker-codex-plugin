import type { ContentTrakerApiClient } from "../contenttraker-api-client.js";
import type { ContentTrakerRequestSecurityContext, UpdateDigitalAssetInput, UpdateDigitalAssetResult } from "../types.js";
import { loadWorkspaceRegistry, resolveContextFromRegistry } from "../workspace-registry.js";

export async function updateDigitalAsset(
  input: UpdateDigitalAssetInput,
  apiClient: ContentTrakerApiClient,
  securityContext: ContentTrakerRequestSecurityContext,
): Promise<UpdateDigitalAssetResult> {
  const api = apiClient.getStatus(securityContext);
  const registry = loadWorkspaceRegistry(api.environmentProfile.name);
  const selectedContext = resolveContextFromRegistry(input, registry);
  const result = await apiClient.updateDigitalAsset(input, selectedContext, securityContext);
  return { ...result, diagnostics: [...registry.errors, ...result.diagnostics] };
}
