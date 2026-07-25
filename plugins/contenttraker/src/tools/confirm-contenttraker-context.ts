import type { ContentTrakerApiClient } from "../contenttraker-api-client.js";
import {
  CONTENTTRAKER_PLUGIN_NAME,
  CONTENTTRAKER_PLUGIN_VERSION,
} from "../plugin-metadata.js";
import { resolveGitWorktreeIdentity } from "../repository-identity.js";
import type {
  ConfirmContentTrakerContextInput,
  ConfirmContentTrakerContextResult,
  ContentTrakerContext,
  ContentTrakerRequestSecurityContext,
  WorktreeContextBinding,
} from "../types.js";
import {
  loadWorktreeContext,
  writeConfirmedWorktreeContext,
} from "../worktree-context.js";

const CONFIRMATION = "CONFIRM_CONTENTTRAKER_CONTEXT";

export async function confirmContentTrakerContext(
  input: ConfirmContentTrakerContextInput,
  apiClient: ContentTrakerApiClient,
  securityContext: ContentTrakerRequestSecurityContext,
): Promise<ConfirmContentTrakerContextResult> {
  const api = apiClient.getStatus(securityContext);
  const environment = api.environmentProfile.name;
  const diagnostics: string[] = [];
  if (!environment) {
    diagnostics.push("context_confirmation_blocked: active ContentTraker environment must be staging or production.");
  }
  if (input.environment && input.environment !== environment) {
    diagnostics.push(
      `context_environment_mismatch: requested '${input.environment}' but the adapter is configured for '${api.environment}'.`,
    );
  }
  if (input.confirmation !== CONFIRMATION) {
    diagnostics.push(`confirmation must be '${CONFIRMATION}'.`);
  }
  if (!input.workspaceId?.trim() && !input.workspaceKey?.trim() && !input.workspaceName?.trim()) {
    diagnostics.push("workspaceId, workspaceKey, or workspaceName is required.");
  }
  if (!input.repositoryRoot?.trim()) {
    diagnostics.push("repositoryRoot is required.");
  }
  if (diagnostics.length > 0 || !environment) {
    return { status: "blocked", environment, correlationIds: [], diagnostics };
  }

  try {
    const identity = resolveGitWorktreeIdentity(input.repositoryRoot);
    const existing = loadWorktreeContext(identity, environment);
    const repairMalformed = existing.blocked
      && existing.diagnostics.every((diagnostic) =>
        diagnostic.startsWith("context_marker_invalid:")
        || diagnostic.startsWith("context_marker_secret_field_rejected:"));
    if (existing.blocked && !repairMalformed) {
      return {
        status: "blocked",
        environment,
        markerPath: existing.path,
        repository: repositorySummary(identity),
        correlationIds: [],
        diagnostics: existing.diagnostics,
      };
    }
    const requestedContext: ContentTrakerContext = {
      environment,
      workspaceId: trimmed(input.workspaceId),
      workspaceKey: trimmed(input.workspaceKey),
      workspaceName: trimmed(input.workspaceName),
      projectId: trimmed(input.projectId),
      projectKey: trimmed(input.projectKey),
      projectName: trimmed(input.projectName),
      source: "explicit-workspace",
    };
    const verified = await apiClient.resolveAuthorizedContext(requestedContext, securityContext);
    if (verified.status !== "ready" || !verified.selectedContext?.workspaceId) {
      return {
        status: verified.status === "blocked" ? "blocked" : "failed",
        environment,
        markerPath: existing.path,
        repository: repositorySummary(identity),
        selectedContext: verified.selectedContext,
        correlationIds: verified.correlationIds,
        diagnostics: verified.diagnostics,
      };
    }
    const selected = verified.selectedContext;
    const binding: WorktreeContextBinding = {
      environment,
      repositoryIdentity: identity.repositoryIdentity,
      worktreeId: identity.worktreeId,
      workspaceId: selected.workspaceId!,
      workspaceKey: selected.workspaceKey,
      workspaceName: selected.workspaceName,
      projectId: selected.projectId,
      projectKey: selected.projectKey,
      projectName: selected.projectName,
      confirmationState: "human-confirmed",
      confirmedAtUtc: new Date().toISOString(),
      pluginName: CONTENTTRAKER_PLUGIN_NAME,
      pluginVersion: CONTENTTRAKER_PLUGIN_VERSION,
    };
    const markerPath = writeConfirmedWorktreeContext(identity, binding, { repairMalformed });
    return {
      status: "confirmed",
      environment,
      markerPath,
      repository: repositorySummary(identity),
      selectedContext: { ...selected, source: "worktree-marker" },
      correlationIds: verified.correlationIds,
      diagnostics: [
        ...verified.diagnostics,
        repairMalformed
          ? "The malformed local marker was replaced after live authorization and human confirmation."
          : "The human-confirmed context was saved locally for this worktree and environment.",
        "No token, credential, or remote ContentTraker asset was written.",
      ],
    };
  } catch (error) {
    return {
      status: "failed",
      environment,
      correlationIds: [],
      diagnostics: [error instanceof Error ? error.message : String(error)],
    };
  }
}

function repositorySummary(identity: ReturnType<typeof resolveGitWorktreeIdentity>) {
  return {
    repositoryRoot: identity.repositoryRoot,
    repositoryIdentity: identity.repositoryIdentity,
    worktreeId: identity.worktreeId,
  };
}

function trimmed(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}
