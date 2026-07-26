import type {
  ContentTrakerContext,
  ResolveContextInput,
} from "./types.js";

export const CONTENT_KEEPER_ALIAS_MISMATCH =
  "content_keeper_alias_mismatch: contentKeeperId and workspaceId must contain the exact same value.";

export interface CanonicalContentKeeperAliases {
  contentKeeperId?: string;
  workspaceId?: string;
}

export interface NormalizedResolveContextInput {
  input: ResolveContextInput;
  diagnostics: string[];
}

export function normalizeContentKeeperAliases(
  value: { contentKeeperId?: string; workspaceId?: string },
): CanonicalContentKeeperAliases & { diagnostic?: string } {
  const contentKeeperId = trimmed(value.contentKeeperId);
  const workspaceId = trimmed(value.workspaceId);
  if (contentKeeperId && workspaceId && contentKeeperId !== workspaceId) {
    return { contentKeeperId, workspaceId, diagnostic: CONTENT_KEEPER_ALIAS_MISMATCH };
  }
  const canonical = contentKeeperId ?? workspaceId;
  return {
    contentKeeperId: canonical,
    workspaceId: canonical,
  };
}

export function normalizeResolveContextInput(
  value: ResolveContextInput,
): NormalizedResolveContextInput {
  const diagnostics: string[] = [];
  const legacyAliases = normalizeContentKeeperAliases(value);
  if (legacyAliases.diagnostic) diagnostics.push(legacyAliases.diagnostic);

  const preferred = value.context;
  if (!preferred) {
    return {
      input: {
        ...value,
        contentKeeperId: legacyAliases.contentKeeperId,
        workspaceId: legacyAliases.workspaceId,
        repositoryRoot: trimmed(value.repositoryRoot),
      },
      diagnostics,
    };
  }

  if (preferred.source === "worktree") {
    const preferredRoot = trimmed(preferred.repositoryRoot);
    const legacyRoot = trimmed(value.repositoryRoot);
    if (legacyRoot && preferredRoot && legacyRoot !== preferredRoot) {
      diagnostics.push(
        "contenttraker_context_mismatch: context.repositoryRoot and repositoryRoot must contain the exact same value.",
      );
    }
    if (
      legacyAliases.contentKeeperId
      || trimmed(value.workspaceKey)
      || trimmed(value.workspaceName)
    ) {
      diagnostics.push(
        "contenttraker_context_mismatch: worktree context cannot be combined with explicit ContentKeeper selectors.",
      );
    }
    return {
      input: {
        ...value,
        context: preferred,
        repositoryRoot: preferredRoot,
        contentKeeperId: undefined,
        workspaceId: undefined,
        workspaceKey: undefined,
        workspaceName: undefined,
      },
      diagnostics,
    };
  }

  const preferredAliases = normalizeContentKeeperAliases(preferred);
  if (preferredAliases.diagnostic) diagnostics.push(preferredAliases.diagnostic);
  if (
    legacyAliases.contentKeeperId
    && preferredAliases.contentKeeperId
    && legacyAliases.contentKeeperId !== preferredAliases.contentKeeperId
  ) {
    diagnostics.push(
      "contenttraker_context_mismatch: context ContentKeeper identifier and top-level compatibility identifier must match.",
    );
  }
  if (trimmed(value.repositoryRoot)) {
    diagnostics.push(
      "contenttraker_context_mismatch: explicit ContentKeeper context cannot be combined with repositoryRoot.",
    );
  }

  return {
    input: {
      ...value,
      context: preferred,
      repositoryRoot: undefined,
      contentKeeperId: preferredAliases.contentKeeperId ?? legacyAliases.contentKeeperId,
      workspaceId: preferredAliases.workspaceId ?? legacyAliases.workspaceId,
      workspaceKey: preferred.workspaceKey ?? value.workspaceKey,
      workspaceName: preferred.workspaceName ?? value.workspaceName,
    },
    diagnostics,
  };
}

export function withCanonicalContentKeeperId(
  context: ContentTrakerContext,
): ContentTrakerContext {
  const aliases = normalizeContentKeeperAliases(context);
  if (aliases.diagnostic) {
    throw new Error(aliases.diagnostic);
  }
  return {
    ...context,
    contentKeeperId: aliases.contentKeeperId,
    workspaceId: aliases.workspaceId,
  };
}

export function canonicalContentKeeperId(
  context: ContentTrakerContext | undefined,
): string | undefined {
  if (!context) return undefined;
  const aliases = normalizeContentKeeperAliases(context);
  return aliases.diagnostic ? undefined : aliases.contentKeeperId;
}

function trimmed(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}
