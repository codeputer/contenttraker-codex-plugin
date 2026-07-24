import type { ContentTrakerApiClient } from "../contenttraker-api-client.js";
import { resolveOperationContext } from "../context-resolution.js";
import type { ContentTrakerRequestSecurityContext, ListDigitalAssetTypesInput, ListDigitalAssetTypesResult } from "../types.js";

export async function listDigitalAssetTypes(
  input: ListDigitalAssetTypesInput,
  apiClient: ContentTrakerApiClient,
  securityContext: ContentTrakerRequestSecurityContext,
): Promise<ListDigitalAssetTypesResult> {
  const resolution = await resolveOperationContext(input, apiClient, securityContext);
  if (resolution.blocked) {
    return {
      status: resolution.failureStatus ?? "blocked",
      api: apiClient.getStatus(securityContext),
      selectedContext: resolution.selectedContext,
      contextCorrelationIds: resolution.correlationIds,
      digitalAssetTypes: [],
      diagnostics: resolution.diagnostics,
    };
  }
  const result = await apiClient.listDigitalAssetTypes(input, resolution.selectedContext, securityContext);
  return {
    ...result,
    contextCorrelationIds: resolution.correlationIds,
    diagnostics: [...resolution.diagnostics, ...result.diagnostics],
  };
}
