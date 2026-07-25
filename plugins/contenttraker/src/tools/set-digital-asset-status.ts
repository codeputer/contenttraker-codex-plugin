import type { ContentTrakerApiClient } from "../contenttraker-api-client.js";
import { resolveOperationContext } from "../context-resolution.js";
import type { ContentTrakerRequestSecurityContext, SetDigitalAssetStatusInput, SetDigitalAssetStatusResult } from "../types.js";

export async function setDigitalAssetStatus(
  input: SetDigitalAssetStatusInput,
  apiClient: ContentTrakerApiClient,
  securityContext: ContentTrakerRequestSecurityContext,
): Promise<SetDigitalAssetStatusResult> {
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
  const result = await apiClient.setDigitalAssetStatus(input, resolution.selectedContext, securityContext);

  return {
    ...result,
    contextCorrelationIds: resolution.correlationIds,
    diagnostics: [...resolution.diagnostics, ...result.diagnostics],
  };
}
