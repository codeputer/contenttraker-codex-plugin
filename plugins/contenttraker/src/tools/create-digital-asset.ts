import type { ContentTrakerApiClient } from "../contenttraker-api-client.js";
import { resolveOperationContext } from "../context-resolution.js";
import type { ContentTrakerRequestSecurityContext, CreateDigitalAssetInput, CreateDigitalAssetResult } from "../types.js";

export async function createDigitalAsset(
  input: CreateDigitalAssetInput,
  apiClient: ContentTrakerApiClient,
  securityContext: ContentTrakerRequestSecurityContext,
): Promise<CreateDigitalAssetResult> {
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
  const result = await apiClient.createDigitalAsset(input, resolution.selectedContext, securityContext);

  return {
    ...result,
    contextCorrelationIds: resolution.correlationIds,
    diagnostics: [
      ...resolution.diagnostics,
      ...result.diagnostics,
    ],
  };
}
