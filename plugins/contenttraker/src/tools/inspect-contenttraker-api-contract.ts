import type { ContentTrakerApiClient } from "../contenttraker-api-client.js";
import type { ApiContractResult, ContentTrakerRequestSecurityContext, ResolveContextInput } from "../types.js";
import { resolveOperationContext } from "../context-resolution.js";

export async function inspectContentTrakerApiContract(
  input: ResolveContextInput,
  apiClient: ContentTrakerApiClient,
  securityContext: ContentTrakerRequestSecurityContext,
): Promise<ApiContractResult> {
  const resolution = await resolveOperationContext(input, apiClient, securityContext);
  const result = apiClient.inspectApiContract(resolution.selectedContext, securityContext);

  return {
    ...result,
    status: resolution.blocked ? "blocked" : result.status,
    contextCorrelationIds: resolution.correlationIds,
    diagnostics: [
      ...resolution.diagnostics,
      ...result.diagnostics,
    ],
  };
}
