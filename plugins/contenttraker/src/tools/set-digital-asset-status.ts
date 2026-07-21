import type { ContentTrakerApiClient } from "../contenttraker-api-client.js";
import type { ContentTrakerRequestSecurityContext, SetDigitalAssetStatusInput, SetDigitalAssetStatusResult } from "../types.js";
import { loadWorkspaceRegistry, resolveContextFromRegistry } from "../workspace-registry.js";

export async function setDigitalAssetStatus(
  input: SetDigitalAssetStatusInput,
  apiClient: ContentTrakerApiClient,
  securityContext: ContentTrakerRequestSecurityContext,
): Promise<SetDigitalAssetStatusResult> {
  const api = apiClient.getStatus(securityContext);
  const registry = loadWorkspaceRegistry(api.environmentProfile.name);
  const selectedContext = resolveContextFromRegistry(input, registry);
  const result = await apiClient.setDigitalAssetStatus(input, selectedContext, securityContext);

  return {
    ...result,
    diagnostics: [...registry.errors, ...result.diagnostics],
  };
}
