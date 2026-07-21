import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { EnvironmentContentTrakerApiClient } from "./contenttraker-api-client.js";
import { createSecureCredentialStore } from "./credential-store.js";
import { resolveAdapterEnvironment } from "./environment-profile.js";
import { ContentTrakerOAuthClient } from "./oauth-client.js";
import { ContentTrakerOAuthMetadataResolver } from "./oauth-metadata.js";
import { ContentTrakerSecurityContextFactory } from "./security-context.js";
import { createContentTrakerTokenProvider } from "./token-provider.js";
import { appendDigitalAssetUploadChunk } from "./tools/append-digital-asset-upload-chunk.js";
import { beginDigitalAssetUpload } from "./tools/begin-digital-asset-upload.js";
import { completeDigitalAssetUpload } from "./tools/complete-digital-asset-upload.js";
import { inspectContentTrakerApiContract } from "./tools/inspect-contenttraker-api-contract.js";
import { inspectContentTrakerRuntimeCapabilities } from "./tools/inspect-runtime-capabilities.js";
import { getDigitalAsset } from "./tools/get-digital-asset.js";
import { listDigitalAssetTypes } from "./tools/list-digital-asset-types.js";
import { probeContentTrakerApiReadiness } from "./tools/probe-contenttraker-api-readiness.js";
import { resolveContentTrakerContext } from "./tools/resolve-contenttraker-context.js";
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
const tokenProvider = createContentTrakerTokenProvider(
  process.env,
  createSecureCredentialStore(),
  oauthClient,
);
const apiClient = new EnvironmentContentTrakerApiClient(tokenProvider);
const securityContextFactory = new ContentTrakerSecurityContextFactory();

const server = new McpServer({
  name: "contenttraker",
  version: "0.1.2",
});

server.registerTool(
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

server.registerTool(
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

server.registerTool(
  "begin_contenttraker_authorization",
  {
    title: "Begin ContentTraker Authorization",
    description:
      "Start or reuse a connection-scoped delegated OAuth authorization flow and return its one-time authorization URL without returning credentials.",
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

server.registerTool(
  "get_contenttraker_authorization_status",
  {
    title: "Get ContentTraker Authorization Status",
    description:
      "Report the connection-scoped delegated OAuth flow status without returning credentials or calling a ContentTraker business API.",
    inputSchema: {
      waitSeconds: z.number().int().min(0).max(15).optional().describe("Optional bounded wait for callback completion."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
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

server.registerTool(
  "cancel_contenttraker_authorization",
  {
    title: "Cancel ContentTraker Authorization",
    description:
      "Cancel the pending connection-scoped OAuth callback listener without revoking an already-issued server credential.",
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

server.registerTool(
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
        diagnostics: ["Local delegated credential deletion is unavailable in service or invalid authentication mode."],
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

server.registerTool(
  "get_current_user",
  {
    title: "Get Authenticated ContentTraker User",
    description: "Return and verify the authenticated ContentTraker user before any write.",
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

server.registerTool(
  "list_workspaces",
  {
    title: "List Authorized ContentTraker Workspaces",
    description: "List workspaces authorized for the verified ContentTraker user.",
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

server.registerTool(
  "resolve_contenttraker_context",
  {
    title: "Resolve ContentTraker Context",
    description:
      "Resolve the ContentTraker workspace and project context for the current Codex project without writing ContentTraker data.",
    inputSchema: {
      projectName: z.string().optional().describe("Local project or repository name."),
      workspaceName: z.string().optional().describe("Preferred ContentTraker workspace name."),
      repositoryRoot: z.string().optional().describe("Absolute local repository root path."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (input, extra) => {
    const result = resolveContentTrakerContext(input, apiClient, securityContextFactory.create(extra));

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

server.registerTool(
  "probe_contenttraker_api_readiness",
  {
    title: "Probe ContentTraker API Readiness",
    description:
      "Probe configured ContentTraker API readiness with read-only GET requests and redacted token reporting.",
    inputSchema: {
      projectName: z.string().optional().describe("Local project or repository name."),
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

server.registerTool(
  "inspect_contenttraker_api_contract",
  {
    title: "Inspect ContentTraker API Contract",
    description:
      "Report which ContentTraker server-side API capabilities the TypeScript adapter SDK can use, without calling the remote server-side MCP.",
    inputSchema: {
      projectName: z.string().optional().describe("Local project or repository name."),
      workspaceName: z.string().optional().describe("Preferred ContentTraker workspace name."),
      repositoryRoot: z.string().optional().describe("Absolute local repository root path."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (input, extra) => {
    const result = inspectContentTrakerApiContract(input, apiClient, securityContextFactory.create(extra));

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

server.registerTool(
  "list_digital_asset_types",
  {
    title: "List Digital Asset Types",
    description: "List valid digital asset type keys from the shared ContentTraker application logic.",
    inputSchema: {
      projectName: z.string().optional().describe("Local project or repository name used to resolve the workspace registry mapping."),
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

server.registerTool(
  "get_digital_asset",
  {
    title: "Get Digital Asset",
    description: "Read one digital asset from the resolved ContentTraker workspace through the shared application logic.",
    inputSchema: {
      projectName: z.string().optional().describe("Local project or repository name used to resolve the workspace registry mapping."),
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

server.registerTool(
  "search_digital_assets",
  {
    title: "Search Digital Assets",
    description: "Search digital assets in the resolved ContentTraker workspace through the shared application logic.",
    inputSchema: {
      projectName: z.string().optional().describe("Local project or repository name used to resolve the workspace registry mapping."),
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

server.registerTool(
  "create_digital_asset",
  {
    title: "Store ContentTraker Digital Asset",
    description:
      "Store a ContentTraker digital asset directly in the resolved workspace with draft, published, or archived lifecycle status. Defaults to draft. Project is optional provenance.",
    inputSchema: {
      projectName: z.string().optional().describe("Local project or repository name used only to resolve the workspace registry mapping."),
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

server.registerTool(
  "begin_digital_asset_upload",
  {
    title: "Begin Digital Asset Upload",
    description: "Begin the shared bounded large-file upload workflow for a ContentTraker digital asset.",
    inputSchema: {
      projectName: z.string().optional(),
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

server.registerTool(
  "append_digital_asset_upload_chunk",
  {
    title: "Append Digital Asset Upload Chunk",
    description: "Stage one idempotent bounded chunk through the shared large-file upload workflow.",
    inputSchema: {
      projectName: z.string().optional(),
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

server.registerTool(
  "complete_digital_asset_upload",
  {
    title: "Complete Digital Asset Upload",
    description: "Commit staged chunks and create digital asset metadata through the shared large-file upload workflow.",
    inputSchema: {
      projectName: z.string().optional(),
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

server.registerTool(
  "update_digital_asset",
  {
    title: "Update Digital Asset",
    description: "Update an existing draft digital asset through the shared ContentTraker application logic.",
    inputSchema: {
      projectName: z.string().optional().describe("Local project or repository name used to resolve the workspace registry mapping."),
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

server.registerTool(
  "set_digital_asset_status",
  {
    title: "Set ContentTraker Digital Asset Status",
    description:
      "Change a ContentTraker digital asset to draft, published, or archived. Publishing queues search indexing; draft/archive queues removal.",
    inputSchema: {
      projectName: z.string().optional().describe("Local project or repository name used to resolve the workspace registry mapping."),
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

server.registerTool(
  "upsert_contenttraker_registry_mapping",
  {
    title: "Upsert ContentTraker Registry Mapping",
    description:
      "Create or update the local ContentTraker workspace registry mapping without writing ContentTraker data.",
    inputSchema: {
      environment: z.enum(["staging", "production"]).optional().describe("Target ContentTraker environment."),
      projectName: z.string().min(1).describe("Local project or repository name."),
      repositoryRoot: z.string().min(1).describe("Absolute local repository root path."),
      workspaceName: z.string().optional().describe("ContentTraker workspace name."),
      workspaceId: z.string().optional().describe("ContentTraker workspace identifier."),
      contentTrakerProjectName: z.string().optional().describe("ContentTraker project name."),
      contentTrakerProjectId: z.string().optional().describe("ContentTraker project identifier."),
      setDefault: z.boolean().optional().describe("Also set this mapping as the environment default."),
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

const transport = new StdioServerTransport();
await server.connect(transport);
