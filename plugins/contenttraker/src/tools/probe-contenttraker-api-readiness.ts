import type { ContentTrakerApiClient } from "../contenttraker-api-client.js";
import { resolveOperationContext } from "../context-resolution.js";
import type { ApiReadinessResult, ContentTrakerRequestSecurityContext, ProbeApiReadinessInput } from "../types.js";

export async function probeContentTrakerApiReadiness(
  input: ProbeApiReadinessInput,
  apiClient: ContentTrakerApiClient,
  securityContext: ContentTrakerRequestSecurityContext,
): Promise<ApiReadinessResult> {
  const resolution = await resolveOperationContext(input, apiClient, securityContext);
  if (resolution.blocked) {
    return {
      status: resolution.failureStatus ?? "blocked",
      api: apiClient.getStatus(securityContext),
      contextCorrelationIds: resolution.correlationIds,
      checks: [],
      diagnostics: resolution.diagnostics,
    };
  }
  const result = await apiClient.probeReadiness(resolution.selectedContext, securityContext);

  return {
    ...result,
    contextCorrelationIds: resolution.correlationIds,
    diagnostics: [
      ...resolution.diagnostics,
      ...result.diagnostics,
    ],
  };
}
