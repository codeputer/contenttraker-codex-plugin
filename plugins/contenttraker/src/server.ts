import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { EnvironmentContentTrakerApiClient } from "./contenttraker-api-client.js";
import { createSecureCredentialStore } from "./credential-store.js";
import { resolveAdapterEnvironment } from "./environment-profile.js";
import { ContentTrakerOAuthClient } from "./oauth-client.js";
import { ContentTrakerOAuthMetadataResolver } from "./oauth-metadata.js";
import { ContentTrakerSecurityContextFactory } from "./security-context.js";
import { CONTENTTRAKER_PLUGIN_VERSION } from "./plugin-metadata.js";
import {
  canonicalContentKeeperId,
  normalizeContentKeeperAliases,
} from "./contentkeeper-id.js";
import {
  createContentTrakerTokenProvider,
  type ContentTrakerTokenProvider,
} from "./token-provider.js";
import { appendDigitalAssetUploadChunk } from "./tools/append-digital-asset-upload-chunk.js";
import { beginDigitalAssetUpload } from "./tools/begin-digital-asset-upload.js";
import { completeDigitalAssetUpload } from "./tools/complete-digital-asset-upload.js";
import { confirmContentTrakerContext } from "./tools/confirm-contenttraker-context.js";
import { inspectContentTrakerApiContract } from "./tools/inspect-contenttraker-api-contract.js";
import { inspectContentTrakerRuntimeCapabilities } from "./tools/inspect-runtime-capabilities.js";
import { getDigitalAsset } from "./tools/get-digital-asset.js";
import { listDigitalAssetTypes } from "./tools/list-digital-asset-types.js";
import { probeContentTrakerApiReadiness } from "./tools/probe-contenttraker-api-readiness.js";
import { resolveContentTrakerContext } from "./tools/resolve-contenttraker-context.js";
import { resetContentTrakerContext } from "./tools/reset-contenttraker-context.js";
import { searchDigitalAssets } from "./tools/search-digital-assets.js";
import { createDigitalAsset } from "./tools/create-digital-asset.js";
import { setDigitalAssetStatus } from "./tools/set-digital-asset-status.js";
import { upsertContentTrakerRegistryMapping } from "./tools/upsert-contenttraker-registry-mapping.js";
import { updateDigitalAsset } from "./tools/update-digital-asset.js";

const environmentProfile = resolveAdapterEnvironment();
const oauthMetadataResolver = new ContentTrakerOAuthMetadataResolver();
const oauthClient = new ContentTrakerOAuthClient(
  environmentProfile.oauthIssuer ?? "",
  undefined,
  undefined,
  undefined,
  oauthMetadataResolver,
);
let tokenProvider = createContentTrakerTokenProvider(
  process.env,
  createSecureCredentialStore(),
  oauthClient,
);
let apiClient = new EnvironmentContentTrakerApiClient(tokenProvider);
const securityContextFactory = new ContentTrakerSecurityContextFactory();

export const CONTENTTRAKER_SERVER_INSTRUCTIONS = [
  "Use this local stdio ContentTraker server whenever the user asks to search, read, select, store, update, publish, archive, or troubleshoot ContentTraker content. Before every business operation, verify the effective user with get_current_user and resolve exactly one authorized ContentKeeperId. contentKeeperId is canonical; workspaceId is only an equal-value compatibility alias. Project identifiers are provenance, never authorization.",
  "Prefer the context object: use source='content-keeper' with contentKeeperId for an explicit target, or source='worktree' with repositoryRoot for a saved exact mapping. Never use an environment-wide default for an unmapped worktree. If resolution is blocked, present the diagnostic and request the smallest necessary ContentTraker selection instead of silently falling back.",
  "Before writes, obtain explicit user approval for the exact operation. Default new assets to draft, preserve the supplied content, use stable idempotency keys where required, and require the production confirmation literal when production writes are enabled. Never expose credentials or treat display names, email, repository names, or project IDs as authorization keys.",
].join("\n\n");

const structuredResultOutputSchema = z.object({
  status: z.string().optional(),
  contentKeeperId: z.string().optional(),
  diagnostics: z.array(z.string()).optional(),
}).catchall(z.unknown());

const preferredContextInputSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("content-keeper"),
    contentKeeperId: z.string().min(1).describe("Canonical authorized ContentKeeper identifier."),
    workspaceId: z.string().min(1).optional().describe("Deprecated equal-value alias for contentKeeperId."),
    workspaceKey: z.string().min(1).optional(),
    workspaceName: z.string().min(1).optional(),
  }),
  z.object({
    source: z.literal("worktree"),
    repositoryRoot: z.string().min(1).describe("Absolute path inside the exact Git worktree."),
  }),
]);

const contextAwareToolNames = new Set([
  "resolve_contenttraker_context",
  "probe_contenttraker_api_readiness",
  "inspect_contenttraker_api_contract",
  "list_digital_asset_types",
  "get_digital_asset",
  "search_digital_assets",
  "create_digital_asset",
  "begin_digital_asset_upload",
  "append_digital_asset_upload_chunk",
  "complete_digital_asset_upload",
  "update_digital_asset",
  "set_digital_asset_status",
]);

const remoteToolNames = new Set([
  "inspect_contenttraker_oauth_metadata",
  "begin_contenttraker_authorization",
  "begin_contenttraker_login",
  "get_contenttraker_authorization_status",
  "poll_contenttraker_login",
  "get_contenttraker_auth_status",
  "get_current_user",
  "list_workspaces",
  "confirm_contenttraker_context",
  ...contextAwareToolNames,
]);

export function setContentTrakerTokenProviderForInternalTest(provider: ContentTrakerTokenProvider): void {
  if (process.env.CONTENTTRAKER_INTERNAL_TEST_ADAPTER !== "1") {
    throw new Error("The ContentTraker internal test adapter is disabled.");
  }
  tokenProvider = provider;
  apiClient = new EnvironmentContentTrakerApiClient(tokenProvider);
}

const server = new McpServer({
  name: "contenttraker",
  version: CONTENTTRAKER_PLUGIN_VERSION,
}, {
  instructions: CONTENTTRAKER_SERVER_INSTRUCTIONS,
});

type UntypedToolCallback = (...args: any[]) => any;
type UntypedToolConfig = Record<string, any>;
const rawRegisterTool = server.registerTool.bind(server) as (
  name: string,
  config: UntypedToolConfig,
  callback: UntypedToolCallback,
) => unknown;
const registerStructuredTool = ((
  name: string,
  config: UntypedToolConfig,
  callback: UntypedToolCallback,
) => {
  const inputSchema = contextAwareToolNames.has(name)
    ? {
        context: preferredContextInputSchema.optional().describe(
          "Preferred deterministic ContentKeeper routing contract. Do not combine it with conflicting top-level compatibility selectors.",
        ),
        contentKeeperId: z.string().min(1).optional().describe(
          "Canonical ContentKeeper identifier. Preferred over the deprecated workspaceId alias.",
        ),
        ...config.inputSchema,
        workspaceId: z.string().min(1).optional().describe(
          "Deprecated equal-value compatibility alias for contentKeeperId.",
        ),
      }
    : config.inputSchema;
  const annotations = {
    ...config.annotations,
    ...(remoteToolNames.has(name) ? { openWorldHint: true } : {}),
  };
  return rawRegisterTool(
    name,
    {
      ...config,
      inputSchema,
      outputSchema: structuredResultOutputSchema,
      annotations,
    },
    async (...args: any[]) => normalizeStructuredToolResult(await callback(...args)),
  );
}) as McpServer["registerTool"];

function normalizeStructuredToolResult(result: Record<string, any>): Record<string, any> {
  const structured = isRecord(result.structuredContent)
    ? { ...result.structuredContent }
    : {};
  const selectedContext = isRecord(structured.selectedContext)
    ? { ...structured.selectedContext }
    : undefined;
  const aliases = selectedContext
    ? normalizeContentKeeperAliases(selectedContext)
    : {};
  const contentKeeperId = canonicalContentKeeperId(selectedContext as any)
    ?? (typeof structured.contentKeeperId === "string" ? structured.contentKeeperId : undefined);
  if (selectedContext && !aliases.diagnostic && aliases.contentKeeperId) {
    selectedContext.contentKeeperId = aliases.contentKeeperId;
    selectedContext.workspaceId = aliases.workspaceId;
    structured.selectedContext = selectedContext;
  }
  if (contentKeeperId) {
    structured.contentKeeperId = contentKeeperId;
    structured.workspaceId = contentKeeperId;
    if (isRecord(structured.asset)) {
      structured.asset = {
        ...structured.asset,
        contentKeeperId,
        workspaceId: contentKeeperId,
      };
    }
    if (isRecord(structured.upload)) {
      structured.upload = {
        ...structured.upload,
        contentKeeperId,
        workspaceId: contentKeeperId,
      };
    }
  }
  return {
    ...result,
    content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

registerStructuredTool(
  "inspect_runtime_capabilities",
  {
    title: "Inspect ContentTraker Runtime Capabilities",
    description:
      "Report the host runtime profile and available authentication, interaction, credential persistence, and session-restoration capabilities without authenticating or calling ContentTraker.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const result = inspectContentTrakerRuntimeCapabilities();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  },
);

registerStructuredTool(
  "inspect_contenttraker_oauth_metadata",
  {
    title: "Inspect ContentTraker OAuth Metadata",
    description:
      "Fetch and validate ContentTraker protected-resource and authorization-server metadata without authenticating or returning credentials.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async () => {
    const result = await oauthMetadataResolver.inspect(
      environmentProfile.oauthIssuer ?? "",
      environmentProfile.oauthResource ?? "",
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  },
);

registerStructuredTool(
  "begin_contenttraker_authorization",
  {
    title: "Begin ContentTraker Authorization",
    description:
      "Start or reuse a delegated OAuth authorization-code or device-code interaction and return only its user-facing instructions.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (_input, extra) => {
    const result = await tokenProvider.beginAuthorization(securityContextFactory.create(extra));
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  },
);

registerStructuredTool(
  "begin_contenttraker_login",
  {
    title: "Begin ContentTraker Login",
    description: "Start or reuse the explicit delegated device-code or PKCE login flow without exposing credentials.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (_input, extra) => {
    const result = await tokenProvider.beginAuthorization(securityContextFactory.create(extra));
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  },
);

registerStructuredTool(
  "get_contenttraker_authorization_status",
  {
    title: "Get ContentTraker Authorization Status",
    description:
      "Report the connection-scoped delegated OAuth flow status without returning credentials or calling a ContentTraker business API.",
    inputSchema: {
      waitSeconds: z.number().int().min(0).max(15).optional().describe("Optional bounded wait for callback or device authorization completion."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (input, extra) => {
    const result = await tokenProvider.getAuthorizationStatus(
      securityContextFactory.create(extra),
      (input.waitSeconds ?? 0) * 1_000,
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  },
);

for (const toolName of ["poll_contenttraker_login", "get_contenttraker_auth_status"] as const) {
  registerStructuredTool(
    toolName,
    {
      title: toolName === "poll_contenttraker_login"
        ? "Poll ContentTraker Login"
        : "Get ContentTraker Authentication Status",
      description: "Report or briefly wait for delegated login status without returning credentials or calling a business API.",
      inputSchema: {
        waitSeconds: z.number().int().min(0).max(15).optional().describe("Optional bounded wait for login completion."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, extra) => {
      const result = await tokenProvider.getAuthorizationStatus(
        securityContextFactory.create(extra),
        (input.waitSeconds ?? 0) * 1_000,
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );
}

registerStructuredTool(
  "cancel_contenttraker_authorization",
  {
    title: "Cancel ContentTraker Authorization",
    description:
      "Cancel a pending OAuth callback or device polling interaction without revoking an already-issued server credential.",
    inputSchema: {},
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (_input, extra) => {
    const result = await tokenProvider.cancelAuthorization(securityContextFactory.create(extra));
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  },
);

registerStructuredTool(
  "forget_contenttraker_credential",
  {
    title: "Forget ContentTraker Credential",
    description:
      "Delete the configured delegated credential profile from the selected secure store and clear its in-process authorization state. This does not revoke a credential at the authorization server.",
    inputSchema: {
      confirmation: z.literal("FORGET_CONTENTTRAKER_CREDENTIAL"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (_input, extra) => {
    const context = securityContextFactory.create(extra);
    const before = tokenProvider.getStatus(context);
    if (before.mode !== "delegated-user-pkce") {
      const result = {
        status: "blocked",
        diagnostics: ["Local delegated credential deletion is unavailable in workload or invalid authentication mode."],
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    }

    try {
      await tokenProvider.invalidate(context);
      const result = {
        status: "forgotten",
        credentialProfile: before.credentialProfile,
        credentialStore: before.credentialStore,
        serverAuthorizationRevoked: false,
        diagnostics: ["The local credential was deleted. Use the ContentTraker account security workflow for server-side revocation."],
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    } catch {
      const result = {
        status: "blocked",
        credentialProfile: before.credentialProfile,
        credentialStore: before.credentialStore,
        diagnostics: ["The selected secure credential provider could not delete the local ContentTraker profile."],
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    }
  },
);

registerStructuredTool(
  "logout_contenttraker",
  {
    title: "Log Out of ContentTraker",
    description: "Cancel pending login, clear in-process state, and delete the configured delegated refresh credential from the OS keyring.",
    inputSchema: { confirmation: z.literal("LOGOUT_CONTENTTRAKER") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async (_input, extra) => {
    const context = securityContextFactory.create(extra);
    const before = tokenProvider.getStatus(context);
    if (before.mode !== "delegated-user-pkce") {
      const result = {
        status: "blocked",
        diagnostics: [
          "Logout is unavailable because delegated identity policy is invalid or workload authentication is selected. No local credential was addressed or deleted.",
        ],
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    }
    try {
      await tokenProvider.invalidate(context);
      const result = {
        status: "logged_out",
        credentialProfile: before.credentialProfile,
        credentialStore: before.credentialStore,
        serverAuthorizationRevoked: false,
        diagnostics: ["Local delegated state and the v2 OS-keyring credential were deleted. Use the ContentTraker security workflow for server-side revocation."],
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    } catch {
      const result = {
        status: "blocked",
        credentialProfile: before.credentialProfile,
        credentialStore: before.credentialStore,
        diagnostics: ["Logout could not delete the selected OS-keyring credential. Unlock the keyring and retry."],
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    }
  },
);

registerStructuredTool(
  "get_current_user",
  {
    title: "Get Authenticated ContentTraker User",
    description: "Verify the effective issuer + subject ContentTraker account before any ContentKeeper business operation.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (_input, extra) => {
    const result = await apiClient.getCurrentUser(securityContextFactory.create(extra));
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  },
);

registerStructuredTool(
  "list_workspaces",
  {
    title: "List Authorized ContentTraker ContentKeepers",
    description: "List ContentKeepers authorized for the verified issuer + subject account when the user needs to choose an exact target.",
    inputSchema: {
      searchText: z.string().optional().describe("Optional case-insensitive workspace search text."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (input, extra) => {
    const result = await apiClient.listWorkspaces(input.searchText, securityContextFactory.create(extra));
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  },
);

registerStructuredTool(
  "confirm_contenttraker_context",
  {
    title: "Confirm ContentTraker Context",
    description:
      "Live-verify and save a human-confirmed ContentKeeper, with optional project provenance, for this exact Git worktree and environment. Stores no credentials or remote assets.",
    inputSchema: {
      repositoryRoot: z.string().min(1).describe("Absolute path inside the Git worktree that will own this local context."),
      environment: z.enum(["staging", "production"]).optional().describe("Must match the adapter's active environment."),
      contentKeeperId: z.string().optional().describe("Canonical ContentKeeper identifier to live-verify."),
      workspaceId: z.string().optional().describe("Deprecated equal-value alias for contentKeeperId."),
      workspaceKey: z.string().optional().describe("Workspace key to live-verify."),
      workspaceName: z.string().optional().describe("Workspace name to live-verify."),
      projectId: z.string().optional().describe("Optional project identifier within the selected workspace."),
      projectKey: z.string().optional().describe("Optional project key within the selected workspace."),
      projectName: z.string().optional().describe("Optional project name within the selected workspace."),
      confirmation: z.literal("CONFIRM_CONTENTTRAKER_CONTEXT").describe("Required human-confirmation literal."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (input, extra) => {
    const result = await confirmContentTrakerContext(input, apiClient, securityContextFactory.create(extra));
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  },
);

registerStructuredTool(
  "reset_contenttraker_context",
  {
    title: "Reset ContentTraker Context",
    description:
      "Clear only this Git worktree's selected ContentTraker environment binding and prevent stale registry fallback. Preserves authentication, other worktrees, other environments, and all remote assets.",
    inputSchema: {
      repositoryRoot: z.string().min(1).describe("Absolute path inside the Git worktree whose local context will be reset."),
      environment: z.enum(["staging", "production"]).optional().describe("Must match the adapter's active environment."),
      confirmation: z.literal("RESET_CONTENTTRAKER_CONTEXT").describe("Required reset-confirmation literal."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (input) => {
    const result = resetContentTrakerContext(input);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  },
);

registerStructuredTool(
  "resolve_contenttraker_context",
  {
    title: "Resolve ContentTraker Context",
    description:
      "Resolve the ContentTraker workspace and project context for the current Codex project without writing ContentTraker data.",
    inputSchema: {
      projectName: z.string().optional().describe("Local project or repository name."),
      workspaceId: z.string().optional().describe("Explicit ContentTraker workspace identifier."),
      workspaceKey: z.string().optional().describe("Explicit ContentTraker workspace key."),
      workspaceName: z.string().optional().describe("Preferred ContentTraker workspace name."),
      repositoryRoot: z.string().optional().describe("Absolute local repository root path."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (input, extra) => {
    const result = await resolveContentTrakerContext(input, apiClient, securityContextFactory.create(extra));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  },
);

registerStructuredTool(
  "probe_contenttraker_api_readiness",
  {
    title: "Probe ContentTraker API Readiness",
    description:
      "Probe configured ContentTraker API readiness with read-only GET requests and redacted token reporting.",
    inputSchema: {
      projectName: z.string().optional().describe("Local project or repository name."),
      workspaceId: z.string().optional().describe("Explicit ContentTraker workspace identifier."),
      workspaceKey: z.string().optional().describe("Explicit ContentTraker workspace key."),
      workspaceName: z.string().optional().describe("Preferred ContentTraker workspace name."),
      repositoryRoot: z.string().optional().describe("Absolute local repository root path."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (input, extra) => {
    const result = await probeContentTrakerApiReadiness(input, apiClient, securityContextFactory.create(extra));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  },
);

registerStructuredTool(
  "inspect_contenttraker_api_contract",
  {
    title: "Inspect ContentTraker API Contract",
    description:
      "Report which ContentTraker server-side API capabilities the TypeScript adapter SDK can use, without calling the remote server-side MCP.",
    inputSchema: {
      projectName: z.string().optional().describe("Local project or repository name."),
      workspaceId: z.string().optional().describe("Explicit ContentTraker workspace identifier."),
      workspaceKey: z.string().optional().describe("Explicit ContentTraker workspace key."),
      workspaceName: z.string().optional().describe("Preferred ContentTraker workspace name."),
      repositoryRoot: z.string().optional().describe("Absolute local repository root path."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (input, extra) => {
    const result = await inspectContentTrakerApiContract(input, apiClient, securityContextFactory.create(extra));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  },
);

registerStructuredTool(
  "list_digital_asset_types",
  {
    title: "List Digital Asset Types",
    description: "List valid digital asset type keys from the shared ContentTraker application logic.",
    inputSchema: {
      projectName: z.string().optional().describe("Local project or repository name used to resolve the workspace registry mapping."),
      workspaceId: z.string().optional().describe("Explicit ContentTraker workspace identifier."),
      workspaceKey: z.string().optional().describe("Explicit ContentTraker workspace key."),
      workspaceName: z.string().optional().describe("Preferred ContentTraker workspace name used to resolve the workspace registry mapping."),
      repositoryRoot: z.string().optional().describe("Absolute local repository root path used to resolve the workspace registry mapping."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (input, extra) => {
    const result = await listDigitalAssetTypes(input, apiClient, securityContextFactory.create(extra));
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  },
);

registerStructuredTool(
  "get_digital_asset",
  {
    title: "Get Digital Asset",
    description: "Read one digital asset from the resolved ContentTraker workspace through the shared application logic.",
    inputSchema: {
      projectName: z.string().optional().describe("Local project or repository name used to resolve the workspace registry mapping."),
      workspaceId: z.string().optional().describe("Explicit ContentTraker workspace identifier."),
      workspaceKey: z.string().optional().describe("Explicit ContentTraker workspace key."),
      workspaceName: z.string().optional().describe("Preferred ContentTraker workspace name used to resolve the workspace registry mapping."),
      repositoryRoot: z.string().optional().describe("Absolute local repository root path used to resolve the workspace registry mapping."),
      digitalAssetId: z.string().min(1).describe("Digital asset ID."),
      version: z.number().int().positive().optional().describe("Optional current digital asset version."),
      includeContent: z.boolean().optional().describe("Include markdown/text content. Defaults to true."),
      provenanceProjectId: z.string().optional().describe("Optional project scope."),
      provenanceProjectKey: z.string().optional().describe("Optional project scope key."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (input, extra) => {
    const result = await getDigitalAsset(input, apiClient, securityContextFactory.create(extra));
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  },
);

registerStructuredTool(
  "search_digital_assets",
  {
    title: "Search Digital Assets",
    description: "Search digital assets in the resolved ContentTraker workspace through the shared application logic.",
    inputSchema: {
      projectName: z.string().optional().describe("Local project or repository name used to resolve the workspace registry mapping."),
      workspaceId: z.string().optional().describe("Explicit ContentTraker workspace identifier."),
      workspaceKey: z.string().optional().describe("Explicit ContentTraker workspace key."),
      workspaceName: z.string().optional().describe("Preferred ContentTraker workspace name used to resolve the workspace registry mapping."),
      repositoryRoot: z.string().optional().describe("Absolute local repository root path used to resolve the workspace registry mapping."),
      query: z.string().optional().describe("Search text. Empty returns the newest matching assets."),
      digitalAssetType: z.string().optional().describe("Optional digital asset type filter."),
      status: z.enum(["draft", "published", "archived"]).optional().describe("Lifecycle status. Defaults to published."),
      tags: z.string().optional().describe("Optional tag filters."),
      limit: z.number().int().min(1).max(50).optional().describe("Maximum results. Defaults to 10."),
      includeContentSnippets: z.boolean().optional().describe("Include matching content snippets. Defaults to true."),
      provenanceProjectId: z.string().optional().describe("Optional project scope."),
      provenanceProjectKey: z.string().optional().describe("Optional project scope key."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (input, extra) => {
    const result = await searchDigitalAssets(input, apiClient, securityContextFactory.create(extra));
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  },
);

registerStructuredTool(
  "create_digital_asset",
  {
    title: "Store ContentTraker Digital Asset",
    description:
      "Store a ContentTraker digital asset directly in the resolved workspace with draft, published, or archived lifecycle status. Defaults to draft. Project is optional provenance.",
    inputSchema: {
      projectName: z.string().optional().describe("Local project or repository name used only to resolve the workspace registry mapping."),
      workspaceId: z.string().optional().describe("Explicit ContentTraker workspace identifier."),
      workspaceKey: z.string().optional().describe("Explicit ContentTraker workspace key."),
      workspaceName: z.string().optional().describe("Preferred ContentTraker workspace name used only to resolve the workspace registry mapping."),
      repositoryRoot: z.string().optional().describe("Absolute local repository root path used only to resolve the workspace registry mapping."),
      title: z.string().min(1).describe("Digital asset title."),
      digitalAssetType: z.string().min(1).describe("Server-side ContentTraker digital asset type key."),
      content: z.string().min(1).describe("Markdown or text content to store exactly."),
      format: z.enum(["markdown", "text"]).optional().describe("Content format. Defaults to markdown."),
      tags: z.string().optional().describe("Optional tags as comma, semicolon, or newline separated values."),
      sourceSystem: z.string().optional().describe("Source system metadata. Defaults to codex."),
      sourceConversationId: z.string().optional().describe("Optional source conversation ID metadata."),
      sourceMessageId: z.string().optional().describe("Optional source message ID metadata."),
      provenanceNotes: z.string().optional().describe("Optional provenance notes. Use project/thread/turn capture for full conversation provenance."),
      visibilityScope: z.string().optional().describe("Optional visibility scope metadata."),
      requiresReview: z.boolean().optional().describe("Whether the draft asset requires review. Defaults to true."),
      status: z.enum(["draft", "published", "archived"]).optional().describe("Lifecycle status. Defaults to draft. Publishing immediately queues search indexing and requires approval permission."),
      userApprovalStatement: z.string().min(1).describe("Required user approval statement for storing the asset in a business workspace."),
      idempotencyKey: z.string().min(1).describe("Required stable idempotency key for this write."),
      provenanceProjectId: z.string().optional().describe("Optional project ID used only when linking this asset to captured Project/Thread/Turn provenance."),
      provenanceProjectKey: z.string().optional().describe("Optional project key used only when linking this asset to captured Project/Thread/Turn provenance."),
      productionConfirmation: z.string().optional().describe("Required exact confirmation token for production writes."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (input, extra) => {
    const result = await createDigitalAsset(input, apiClient, securityContextFactory.create(extra));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  },
);

registerStructuredTool(
  "begin_digital_asset_upload",
  {
    title: "Begin Digital Asset Upload",
    description: "Begin the shared bounded large-file upload workflow for a ContentTraker digital asset.",
    inputSchema: {
      projectName: z.string().optional(),
      workspaceId: z.string().optional(),
      workspaceKey: z.string().optional(),
      workspaceName: z.string().optional(),
      repositoryRoot: z.string().optional(),
      title: z.string().min(1),
      digitalAssetType: z.string().min(1),
      fileName: z.string().optional(),
      format: z.enum(["markdown", "text"]).optional(),
      sourceSystem: z.string().optional(),
      sourceConversationId: z.string().optional(),
      sourceMessageId: z.string().optional(),
      provenanceNotes: z.string().optional(),
      status: z.enum(["draft", "archived"]).optional(),
      userApprovalStatement: z.string().min(1),
      provenanceProjectId: z.string().optional(),
      provenanceProjectKey: z.string().optional(),
      productionConfirmation: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (input, extra) => {
    const result = await beginDigitalAssetUpload(input, apiClient, securityContextFactory.create(extra));
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  },
);

registerStructuredTool(
  "append_digital_asset_upload_chunk",
  {
    title: "Append Digital Asset Upload Chunk",
    description: "Stage one idempotent bounded chunk through the shared large-file upload workflow.",
    inputSchema: {
      projectName: z.string().optional(),
      workspaceId: z.string().optional(),
      workspaceKey: z.string().optional(),
      workspaceName: z.string().optional(),
      repositoryRoot: z.string().optional(),
      uploadSessionId: z.string().min(1),
      digitalAssetType: z.string().min(1),
      fileName: z.string().min(1),
      chunkIndex: z.number().int().min(0),
      chunkContent: z.string(),
      contentEncoding: z.enum(["utf8", "base64"]).optional(),
      chunkSha256: z.string().optional(),
      provenanceProjectId: z.string().optional(),
      provenanceProjectKey: z.string().optional(),
      productionConfirmation: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (input, extra) => {
    const result = await appendDigitalAssetUploadChunk(input, apiClient, securityContextFactory.create(extra));
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  },
);

registerStructuredTool(
  "complete_digital_asset_upload",
  {
    title: "Complete Digital Asset Upload",
    description: "Commit staged chunks and create digital asset metadata through the shared large-file upload workflow.",
    inputSchema: {
      projectName: z.string().optional(),
      workspaceId: z.string().optional(),
      workspaceKey: z.string().optional(),
      workspaceName: z.string().optional(),
      repositoryRoot: z.string().optional(),
      uploadSessionId: z.string().min(1),
      title: z.string().min(1),
      digitalAssetType: z.string().min(1),
      fileName: z.string().min(1),
      chunkCount: z.number().int().positive(),
      format: z.enum(["markdown", "text"]).optional(),
      tags: z.string().optional(),
      sourceSystem: z.string().optional(),
      sourceConversationId: z.string().optional(),
      sourceMessageId: z.string().optional(),
      provenanceNotes: z.string().optional(),
      visibilityScope: z.string().optional(),
      status: z.enum(["draft", "archived"]).optional(),
      requiresReview: z.boolean().optional(),
      userApprovalStatement: z.string().min(1),
      provenanceProjectId: z.string().optional(),
      provenanceProjectKey: z.string().optional(),
      productionConfirmation: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (input, extra) => {
    const result = await completeDigitalAssetUpload(input, apiClient, securityContextFactory.create(extra));
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  },
);

registerStructuredTool(
  "update_digital_asset",
  {
    title: "Update Digital Asset",
    description: "Update an existing draft digital asset through the shared ContentTraker application logic.",
    inputSchema: {
      projectName: z.string().optional().describe("Local project or repository name used to resolve the workspace registry mapping."),
      workspaceId: z.string().optional().describe("Explicit ContentTraker workspace identifier."),
      workspaceKey: z.string().optional().describe("Explicit ContentTraker workspace key."),
      workspaceName: z.string().optional().describe("Preferred ContentTraker workspace name used to resolve the workspace registry mapping."),
      repositoryRoot: z.string().optional().describe("Absolute local repository root path used to resolve the workspace registry mapping."),
      digitalAssetId: z.string().min(1).describe("Digital asset ID."),
      title: z.string().optional().describe("Optional replacement title."),
      content: z.string().optional().describe("Optional replacement content."),
      tags: z.string().optional().describe("Optional replacement tags."),
      provenanceNotes: z.string().optional().describe("Optional replacement provenance notes."),
      changeSummary: z.string().optional().describe("Required when content changes."),
      userApprovalStatement: z.string().min(1).describe("Required explicit user approval statement."),
      productionConfirmation: z.string().optional().describe("Required exact confirmation token for production writes."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (input, extra) => {
    const result = await updateDigitalAsset(input, apiClient, securityContextFactory.create(extra));
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  },
);

registerStructuredTool(
  "set_digital_asset_status",
  {
    title: "Set ContentTraker Digital Asset Status",
    description:
      "Change a ContentTraker digital asset to draft, published, or archived. Publishing queues search indexing; draft/archive queues removal.",
    inputSchema: {
      projectName: z.string().optional().describe("Local project or repository name used to resolve the workspace registry mapping."),
      workspaceId: z.string().optional().describe("Explicit ContentTraker workspace identifier."),
      workspaceKey: z.string().optional().describe("Explicit ContentTraker workspace key."),
      workspaceName: z.string().optional().describe("Preferred ContentTraker workspace name used to resolve the workspace registry mapping."),
      repositoryRoot: z.string().optional().describe("Absolute local repository root path used to resolve the workspace registry mapping."),
      digitalAssetId: z.string().min(1).describe("Digital asset ID returned by create_digital_asset or ContentTraker."),
      status: z.enum(["draft", "published", "archived"]).describe("Target lifecycle status."),
      reason: z.string().optional().describe("Optional reason for the lifecycle change."),
      userApprovalStatement: z.string().min(1).describe("Required user approval statement for this lifecycle change."),
      idempotencyKey: z.string().min(1).describe("Required stable idempotency key for this lifecycle change."),
      productionConfirmation: z.string().optional().describe("Required exact confirmation token for production writes."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (input, extra) => {
    const result = await setDigitalAssetStatus(input, apiClient, securityContextFactory.create(extra));
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  },
);

registerStructuredTool(
  "upsert_contenttraker_registry_mapping",
  {
    title: "Upsert ContentTraker Registry Mapping",
    description:
      "Create or update one exact repository-to-ContentKeeper mapping without writing ContentTraker data.",
    inputSchema: {
      environment: z.enum(["staging", "production"]).optional().describe("Target ContentTraker environment."),
      projectName: z.string().min(1).describe("Local project or repository name."),
      repositoryRoot: z.string().min(1).describe("Absolute local repository root path."),
      workspaceName: z.string().optional().describe("ContentTraker workspace name."),
      contentKeeperId: z.string().optional().describe("Canonical ContentKeeper identifier."),
      workspaceId: z.string().optional().describe("Deprecated equal-value alias for contentKeeperId."),
      contentTrakerProjectName: z.string().optional().describe("ContentTraker project name."),
      contentTrakerProjectId: z.string().optional().describe("ContentTraker project identifier."),
      setDefault: z.boolean().optional().describe("Retain a legacy diagnostic default; business operations never route through it."),
      dryRun: z.boolean().optional().describe("Return the planned registry change without writing the file."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (input, extra) => {
    securityContextFactory.create(extra);
    const result = upsertContentTrakerRegistryMapping(input);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  },
);

export async function connectContentTrakerMcpServer(): Promise<void> {
  await server.connect(new StdioServerTransport());
}
