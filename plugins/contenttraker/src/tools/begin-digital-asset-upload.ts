import type { ContentTrakerApiClient } from "../contenttraker-api-client.js";
import type { BeginDigitalAssetUploadInput, ContentTrakerRequestSecurityContext, DigitalAssetUploadResult } from "../types.js";
import { loadWorkspaceRegistry, resolveContextFromRegistry } from "../workspace-registry.js";

export async function beginDigitalAssetUpload(
  input: BeginDigitalAssetUploadInput,
  apiClient: ContentTrakerApiClient,
  securityContext: ContentTrakerRequestSecurityContext,
): Promise<DigitalAssetUploadResult> {
  const api = apiClient.getStatus(securityContext);
  const registry = loadWorkspaceRegistry(api.environmentProfile.name);
  const selectedContext = resolveContextFromRegistry(input, registry);
  const result = await apiClient.beginDigitalAssetUpload(input, selectedContext, securityContext);
  return { ...result, diagnostics: [...registry.errors, ...result.diagnostics] };
}
