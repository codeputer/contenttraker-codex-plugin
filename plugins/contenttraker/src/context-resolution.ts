import type { ContentTrakerApiClient } from "./contenttraker-api-client.js";
import { resolveGitWorktreeIdentity } from "./repository-identity.js";
import type {
  ContentTrakerContext,
  ContentTrakerRequestSecurityContext,
  RegistrySnapshot,
  ResolveContextInput,
  WorktreeContextSnapshot,
} from "./types.js";
import { loadWorktreeContext } from "./worktree-context.js";
import {
  loadWorkspaceRegistry,
  resolveContextFromRegistry,
} from "./workspace-registry.js";

export interface OperationContextResolution {
  selectedContext?: ContentTrakerContext;
  blocked: boolean;
  failureStatus?: "blocked" | "failed";
  reset: boolean;
  diagnostics: string[];
  registry: RegistrySnapshot;
  marker?: WorktreeContextSnapshot;
  correlationIds: string[];
}

export async function resolveOperationContext(
  input: ResolveContextInput,
  apiClient: ContentTrakerApiClient,
  securityContext: ContentTrakerRequestSecurityContext,
): Promise<OperationContextResolution> {
  const api = apiClient.getStatus(securityContext);
  const environment = api.environmentProfile.name;
  const registry = loadWorkspaceRegistry(environment);
  const correlationIds: string[] = [];

  if (!environment) {
    return {
      blocked: true,
      failureStatus: "blocked",
      reset: false,
      diagnostics: ["context_environment_invalid: select staging or production before resolving ContentTraker context."],
      registry,
      correlationIds,
    };
  }

  if (hasExplicitWorkspace(input)) {
    const explicit = withExplicitProject({
      environment,
      workspaceId: trimmed(input.workspaceId),
      workspaceKey: trimmed(input.workspaceKey),
      workspaceName: trimmed(input.workspaceName),
      source: "explicit-workspace",
    }, input);
    const verified = await apiClient.resolveAuthorizedContext(explicit, securityContext);
    return {
      selectedContext: verified.selectedContext,
      blocked: verified.status !== "ready",
      failureStatus: verified.status === "ready" ? undefined : verified.status,
      reset: false,
      diagnostics: verified.diagnostics,
      registry,
      correlationIds: verified.correlationIds,
    };
  }

  if (!input.repositoryRoot?.trim()) {
    return {
      blocked: true,
      failureStatus: "blocked",
      reset: false,
      diagnostics: [
        "repository_root_required_for_durable_context: provide repositoryRoot or an explicit workspaceId/workspaceKey.",
      ],
      registry,
      correlationIds,
    };
  }

  let marker: WorktreeContextSnapshot;
  try {
    const identity = resolveGitWorktreeIdentity(input.repositoryRoot);
    marker = loadWorktreeContext(identity, environment);
  } catch (error) {
    return {
      blocked: true,
      failureStatus: "blocked",
      reset: false,
      diagnostics: [error instanceof Error ? error.message : String(error)],
      registry,
      correlationIds,
    };
  }

  if (marker.blocked) {
    return {
      blocked: true,
      failureStatus: "blocked",
      reset: false,
      diagnostics: marker.diagnostics,
      registry,
      marker,
      correlationIds,
    };
  }

  if (marker.binding) {
    const candidate = withExplicitProject({
      environment,
      workspaceId: marker.binding.workspaceId,
      workspaceKey: marker.binding.workspaceKey,
      workspaceName: marker.binding.workspaceName,
      projectId: marker.binding.projectId,
      projectKey: marker.binding.projectKey,
      projectName: marker.binding.projectName,
      source: "worktree-marker",
    }, input);
    const verified = await apiClient.resolveAuthorizedContext(candidate, securityContext);
    return {
      selectedContext: verified.selectedContext,
      blocked: verified.status !== "ready",
      failureStatus: verified.status === "ready" ? undefined : verified.status,
      reset: false,
      diagnostics: verified.status === "ready"
        ? [
            "Using the live-authorized human-confirmed ContentTraker context for this worktree.",
            ...verified.diagnostics,
          ]
        : [
            "context_marker_authorization_rejected: the saved worktree context is stale or no longer authorized; no registry fallback was used.",
            ...verified.diagnostics,
          ],
      registry,
      marker,
      correlationIds: verified.correlationIds,
    };
  }

  if (marker.reset) {
    return {
      blocked: true,
      failureStatus: "blocked",
      reset: true,
      diagnostics: [
        `context_reset_for_worktree: '${environment}' was explicitly reset at ${marker.reset.resetAtUtc}; select and confirm a workspace before using registry fallback.`,
      ],
      registry,
      marker,
      correlationIds,
    };
  }

  const registryContext = resolveContextFromRegistry(input, registry);
  return {
    selectedContext: registryContext ? withExplicitProject(registryContext, input) : undefined,
    blocked: false,
    reset: false,
    diagnostics: registry.errors,
    registry,
    marker,
    correlationIds,
  };
}

function hasExplicitWorkspace(input: ResolveContextInput): boolean {
  return Boolean(
    input.workspaceId?.trim()
    || input.workspaceKey?.trim()
    || input.workspaceName?.trim(),
  );
}

function withExplicitProject(
  context: ContentTrakerContext,
  input: ResolveContextInput,
): ContentTrakerContext {
  const record = input as ResolveContextInput & {
    provenanceProjectId?: string;
    provenanceProjectKey?: string;
  };
  const projectId = trimmed(record.provenanceProjectId);
  const projectKey = trimmed(record.provenanceProjectKey);
  if (!projectId && !projectKey) return context;
  return {
    ...context,
    projectId,
    projectKey,
    projectName: undefined,
  };
}

function trimmed(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}
