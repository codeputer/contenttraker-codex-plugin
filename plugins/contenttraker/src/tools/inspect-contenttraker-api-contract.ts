import type { ContentTrakerApiClient } from "../contenttraker-api-client.js";
import type { ApiContractResult, ContentTrakerRequestSecurityContext, ResolveContextInput } from "../types.js";
import {
  loadWorkspaceRegistry,
  resolveContextFromRegistry,
} from "../workspace-registry.js";

export function inspectContentTrakerApiContract(
  input: ResolveContextInput,
  apiClient: ContentTrakerApiClient,
  securityContext: ContentTrakerRequestSecurityContext,
): ApiContractResult {
  const api = apiClient.getStatus(securityContext);
  const registry = loadWorkspaceRegistry(api.environmentProfile.name);
  const selectedContext = resolveContextFromRegistry(input, registry);
  const result = apiClient.inspectApiContract(selectedContext, securityContext);

  return {
    ...result,
    diagnostics: [
      ...registry.errors,
      ...result.diagnostics,
    ],
  };
}
