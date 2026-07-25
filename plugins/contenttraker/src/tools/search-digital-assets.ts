import type { ContentTrakerApiClient } from "../contenttraker-api-client.js";
import { resolveOperationContext } from "../context-resolution.js";
import type { ContentTrakerRequestSecurityContext, SearchDigitalAssetsInput, SearchDigitalAssetsResult } from "../types.js";

export async function searchDigitalAssets(
  input: SearchDigitalAssetsInput,
  apiClient: ContentTrakerApiClient,
  securityContext: ContentTrakerRequestSecurityContext,
): Promise<SearchDigitalAssetsResult> {
  const resolution = await resolveOperationContext(input, apiClient, securityContext);
  if (resolution.blocked) {
    return {
      status: resolution.failureStatus ?? "blocked",
      api: apiClient.getStatus(securityContext),
      selectedContext: resolution.selectedContext,
      contextCorrelationIds: resolution.correlationIds,
      results: [],
      diagnostics: resolution.diagnostics,
    };
  }
  const result = await apiClient.searchDigitalAssets(input, resolution.selectedContext, securityContext);

  return {
    ...result,
    contextCorrelationIds: resolution.correlationIds,
    diagnostics: [...resolution.diagnostics, ...result.diagnostics],
  };
}
