import type { ContentTrakerApiClient } from "../contenttraker-api-client.js";
import { resolveOperationContext } from "../context-resolution.js";
import type {
  AskWorkspaceQuestionInput,
  AskWorkspaceQuestionResult,
  ContentTrakerRequestSecurityContext,
  ResolveContextInput,
} from "../types.js";

const QUESTION_OPERATION_POLICY = {
  stateChanging: true,
  idempotencyKeySupported: false,
  automaticRetry: false,
} as const;

export async function askWorkspaceQuestion(
  input: AskWorkspaceQuestionInput,
  apiClient: ContentTrakerApiClient,
  securityContext: ContentTrakerRequestSecurityContext,
): Promise<AskWorkspaceQuestionResult> {
  const resolutionInput: ResolveContextInput & {
    provenanceProjectId?: string;
    provenanceProjectKey?: string;
  } = {
    ...input,
    provenanceProjectId: input.projectId,
    provenanceProjectKey: input.projectKey,
  };
  const resolution = await resolveOperationContext(
    resolutionInput,
    apiClient,
    securityContext,
  );

  if (resolution.blocked) {
    return {
      status: resolution.failureStatus ?? "blocked",
      api: apiClient.getStatus(securityContext),
      operationPolicy: QUESTION_OPERATION_POLICY,
      selectedContext: resolution.selectedContext,
      contextCorrelationIds: resolution.correlationIds,
      requestCorrelationId: securityContext.correlationId,
      diagnostics: resolution.diagnostics,
    };
  }

  if (!resolution.selectedContext?.projectId) {
    return {
      status: "blocked",
      api: apiClient.getStatus(securityContext),
      operationPolicy: QUESTION_OPERATION_POLICY,
      selectedContext: resolution.selectedContext,
      contextCorrelationIds: resolution.correlationIds,
      requestCorrelationId: securityContext.correlationId,
      diagnostics: [
        ...resolution.diagnostics,
        "project_context_required: ask_workspace_question requires one live-authorized project in the selected ContentKeeper.",
      ],
    };
  }

  const result = await apiClient.askWorkspaceQuestion(
    input,
    resolution.selectedContext,
    securityContext,
  );

  return {
    ...result,
    contextCorrelationIds: resolution.correlationIds,
    diagnostics: [
      ...resolution.diagnostics,
      ...result.diagnostics,
    ],
  };
}
