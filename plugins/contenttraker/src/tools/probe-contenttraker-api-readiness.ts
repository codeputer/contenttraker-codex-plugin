import type { ContentTrakerApiClient } from "../contenttraker-api-client.js";
import {
  loadWorkspaceRegistry,
  resolveContextFromRegistry,
} from "../workspace-registry.js";
import type { ApiReadinessResult, ContentTrakerRequestSecurityContext, ProbeApiReadinessInput } from "../types.js";

export async function probeContentTrakerApiReadiness(
  input: ProbeApiReadinessInput,
  apiClient: ContentTrakerApiClient,
  securityContext: ContentTrakerRequestSecurityContext,
): Promise<ApiReadinessResult> {
  const api = apiClient.getStatus(securityContext);
  const registry = loadWorkspaceRegistry(api.environmentProfile.name);
  const selectedContext = resolveContextFromRegistry(input, registry);
  const result = await apiClient.probeReadiness(selectedContext, securityContext);

  return {
    ...result,
    diagnostics: [
      ...registry.errors,
      ...result.diagnostics,
    ],
  };
}
