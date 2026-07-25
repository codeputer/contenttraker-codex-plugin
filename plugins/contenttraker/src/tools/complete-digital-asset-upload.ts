import type { ContentTrakerApiClient } from "../contenttraker-api-client.js";
import { resolveOperationContext } from "../context-resolution.js";
import type { CompleteDigitalAssetUploadInput, ContentTrakerRequestSecurityContext, DigitalAssetUploadResult } from "../types.js";

export async function completeDigitalAssetUpload(
  input: CompleteDigitalAssetUploadInput,
  apiClient: ContentTrakerApiClient,
  securityContext: ContentTrakerRequestSecurityContext,
): Promise<DigitalAssetUploadResult> {
  const resolution = await resolveOperationContext(input, apiClient, securityContext);
  if (resolution.blocked) {
    return {
      status: resolution.failureStatus ?? "blocked",
      api: apiClient.getStatus(securityContext),
      selectedContext: resolution.selectedContext,
      contextCorrelationIds: resolution.correlationIds,
      diagnostics: resolution.diagnostics,
    };
  }
  const result = await apiClient.completeDigitalAssetUpload(input, resolution.selectedContext, securityContext);
  return {
    ...result,
    contextCorrelationIds: resolution.correlationIds,
    diagnostics: [...resolution.diagnostics, ...result.diagnostics],
  };
}
