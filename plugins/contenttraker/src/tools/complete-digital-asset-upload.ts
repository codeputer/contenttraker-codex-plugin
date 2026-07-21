import type { ContentTrakerApiClient } from "../contenttraker-api-client.js";
import type { CompleteDigitalAssetUploadInput, ContentTrakerRequestSecurityContext, DigitalAssetUploadResult } from "../types.js";
import { loadWorkspaceRegistry, resolveContextFromRegistry } from "../workspace-registry.js";

export async function completeDigitalAssetUpload(
  input: CompleteDigitalAssetUploadInput,
  apiClient: ContentTrakerApiClient,
  securityContext: ContentTrakerRequestSecurityContext,
): Promise<DigitalAssetUploadResult> {
  const api = apiClient.getStatus(securityContext);
  const registry = loadWorkspaceRegistry(api.environmentProfile.name);
  const selectedContext = resolveContextFromRegistry(input, registry);
  const result = await apiClient.completeDigitalAssetUpload(input, selectedContext, securityContext);
  return { ...result, diagnostics: [...registry.errors, ...result.diagnostics] };
}
