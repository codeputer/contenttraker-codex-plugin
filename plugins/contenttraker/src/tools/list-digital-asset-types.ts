import type { ContentTrakerApiClient } from "../contenttraker-api-client.js";
import type { ContentTrakerRequestSecurityContext, ListDigitalAssetTypesInput, ListDigitalAssetTypesResult } from "../types.js";
import { loadWorkspaceRegistry, resolveContextFromRegistry } from "../workspace-registry.js";

export async function listDigitalAssetTypes(
  input: ListDigitalAssetTypesInput,
  apiClient: ContentTrakerApiClient,
  securityContext: ContentTrakerRequestSecurityContext,
): Promise<ListDigitalAssetTypesResult> {
  const api = apiClient.getStatus(securityContext);
  const registry = loadWorkspaceRegistry(api.environmentProfile.name);
  const selectedContext = resolveContextFromRegistry(input, registry);
  const result = await apiClient.listDigitalAssetTypes(input, selectedContext, securityContext);
  return { ...result, diagnostics: [...registry.errors, ...result.diagnostics] };
}
