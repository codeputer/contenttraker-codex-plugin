import { resolveAdapterEnvironment } from "../environment-profile.js";
import { resolveGitWorktreeIdentity } from "../repository-identity.js";
import type {
  ResetContentTrakerContextInput,
  ResetContentTrakerContextResult,
} from "../types.js";
import { resetWorktreeContextBinding } from "../worktree-context.js";
import { removeRegistryMappingsForWorktree } from "../workspace-registry.js";

const CONFIRMATION = "RESET_CONTENTTRAKER_CONTEXT";

export function resetContentTrakerContext(
  input: ResetContentTrakerContextInput,
): ResetContentTrakerContextResult {
  const profile = resolveAdapterEnvironment();
  const environment = profile.status.name;
  const preserved = {
    oauthAndKeyringCredentials: true as const,
    otherWorktrees: true as const,
    otherEnvironments: true as const,
    remoteContentTrakerAssets: true as const,
  };
  const diagnostics: string[] = [];
  if (!environment) {
    diagnostics.push("context_reset_blocked: active ContentTraker environment must be staging or production.");
  }
  if (input.environment && input.environment !== environment) {
    diagnostics.push(
      `context_environment_mismatch: requested '${input.environment}' but the adapter is configured for '${profile.status.requestedName}'.`,
    );
  }
  if (input.confirmation !== CONFIRMATION) {
    diagnostics.push(`confirmation must be '${CONFIRMATION}'.`);
  }
  if (!input.repositoryRoot?.trim()) diagnostics.push("repositoryRoot is required.");
  if (diagnostics.length > 0 || !environment) {
    return {
      status: "blocked",
      environment,
      cleared: { markerBinding: false, registryMappings: 0 },
      resetTombstoneCreated: false,
      preserved,
      diagnostics,
    };
  }

  try {
    const identity = resolveGitWorktreeIdentity(input.repositoryRoot);
    const marker = resetWorktreeContextBinding(identity, environment);
    const registry = removeRegistryMappingsForWorktree(environment, identity.repositoryRoot);
    const preservedAfterReset = {
      ...preserved,
      otherEnvironments: marker.otherEnvironmentsPreserved,
    };
    return {
      status: "reset",
      environment,
      markerPath: marker.markerPath,
      repository: {
        repositoryRoot: identity.repositoryRoot,
        repositoryIdentity: identity.repositoryIdentity,
        worktreeId: identity.worktreeId,
      },
      cleared: {
        markerBinding: marker.bindingCleared,
        registryMappings: registry.removedCount,
      },
      resetTombstoneCreated: true,
      preserved: preservedAfterReset,
      diagnostics: [
        ...(marker.invalidMarkerReplaced
          ? [
              marker.otherEnvironmentsPreserved
                ? "Replaced invalid data for the selected environment with a reset tombstone and preserved the separately validated other-environment marker entry."
                : "Replaced an unreadable or untrusted local marker with a reset tombstone; no marker fields were reused or emitted, so other-environment marker entries are not claimed as preserved.",
            ]
          : []),
        marker.bindingCleared
          ? "Cleared the human-confirmed marker binding for this worktree and environment."
          : "No human-confirmed marker binding existed for this worktree and environment.",
        ...registry.diagnostics,
        "Created a worktree/environment reset tombstone so registry defaults cannot silently reselect a workspace.",
        marker.otherEnvironmentsPreserved
          ? "OAuth and keyring credentials, other worktrees, other environments, and all remote ContentTraker assets were preserved."
          : "OAuth and keyring credentials, other worktrees, and all remote ContentTraker assets were preserved; the invalid marker could not safely prove preservation of another environment entry.",
      ],
    };
  } catch (error) {
    return {
      status: "failed",
      environment,
      cleared: { markerBinding: false, registryMappings: 0 },
      resetTombstoneCreated: false,
      preserved,
      diagnostics: [error instanceof Error ? error.message : String(error)],
    };
  }
}
