import type {
  ApiClientStatus,
  ApiContractResult,
  ApiReadinessCheck,
  ApiReadinessResult,
  AuthorizedContextResolutionResult,
  AppendDigitalAssetUploadChunkInput,
  BeginDigitalAssetUploadInput,
  ContentTrakerContext,
  CompleteDigitalAssetUploadInput,
  ContentTrakerRequestSecurityContext,
  GetDigitalAssetInput,
  GetDigitalAssetResult,
  ListDigitalAssetTypesInput,
  ListDigitalAssetTypesResult,
  SearchDigitalAssetsInput,
  SearchDigitalAssetsResult,
  UpdateDigitalAssetInput,
  UpdateDigitalAssetResult,
  CreateDigitalAssetInput,
  CreateDigitalAssetResult,
  DigitalAssetUploadResult,
  SetDigitalAssetStatusInput,
  SetDigitalAssetStatusResult,
} from "./types.js";
import {
  NodeContentTrakerServerApiClient,
  type ContentTrakerServerApiClient,
  type JsonResponse,
} from "./contenttraker-server-api-client.js";
import { resolveAdapterEnvironment } from "./environment-profile.js";
import {
  createContentTrakerTokenProvider,
  type ContentTrakerTokenProvider,
} from "./token-provider.js";

export interface ContentTrakerApiClient {
  getStatus(securityContext?: ContentTrakerRequestSecurityContext): ApiClientStatus;
  getCurrentUser(securityContext: ContentTrakerRequestSecurityContext): Promise<Record<string, unknown>>;
  listWorkspaces(searchText: string | undefined, securityContext: ContentTrakerRequestSecurityContext): Promise<Record<string, unknown>>;
  resolveAuthorizedContext(
    context: ContentTrakerContext,
    securityContext: ContentTrakerRequestSecurityContext,
  ): Promise<AuthorizedContextResolutionResult>;
  inspectApiContract(context: ContentTrakerContext | undefined, securityContext: ContentTrakerRequestSecurityContext): ApiContractResult;
  probeReadiness(context: ContentTrakerContext | undefined, securityContext: ContentTrakerRequestSecurityContext): Promise<ApiReadinessResult>;
  getDigitalAsset(input: GetDigitalAssetInput, context: ContentTrakerContext | undefined, securityContext: ContentTrakerRequestSecurityContext): Promise<GetDigitalAssetResult>;
  searchDigitalAssets(input: SearchDigitalAssetsInput, context: ContentTrakerContext | undefined, securityContext: ContentTrakerRequestSecurityContext): Promise<SearchDigitalAssetsResult>;
  listDigitalAssetTypes(input: ListDigitalAssetTypesInput, context: ContentTrakerContext | undefined, securityContext: ContentTrakerRequestSecurityContext): Promise<ListDigitalAssetTypesResult>;
  updateDigitalAsset(input: UpdateDigitalAssetInput, context: ContentTrakerContext | undefined, securityContext: ContentTrakerRequestSecurityContext): Promise<UpdateDigitalAssetResult>;
  beginDigitalAssetUpload(input: BeginDigitalAssetUploadInput, context: ContentTrakerContext | undefined, securityContext: ContentTrakerRequestSecurityContext): Promise<DigitalAssetUploadResult>;
  appendDigitalAssetUploadChunk(input: AppendDigitalAssetUploadChunkInput, context: ContentTrakerContext | undefined, securityContext: ContentTrakerRequestSecurityContext): Promise<DigitalAssetUploadResult>;
  completeDigitalAssetUpload(input: CompleteDigitalAssetUploadInput, context: ContentTrakerContext | undefined, securityContext: ContentTrakerRequestSecurityContext): Promise<DigitalAssetUploadResult>;
  createDigitalAsset(input: CreateDigitalAssetInput, context: ContentTrakerContext | undefined, securityContext: ContentTrakerRequestSecurityContext): Promise<CreateDigitalAssetResult>;
  setDigitalAssetStatus(input: SetDigitalAssetStatusInput, context: ContentTrakerContext | undefined, securityContext: ContentTrakerRequestSecurityContext): Promise<SetDigitalAssetStatusResult>;
}

export class EnvironmentContentTrakerApiClient implements ContentTrakerApiClient {
  constructor(
    private readonly tokenProvider: ContentTrakerTokenProvider = createContentTrakerTokenProvider(),
    private readonly serverApiClient: ContentTrakerServerApiClient = new NodeContentTrakerServerApiClient(),
  ) {}

  getStatus(securityContext?: ContentTrakerRequestSecurityContext): ApiClientStatus {
    const profile = resolveAdapterEnvironment();
    const tokenStatus = this.tokenProvider.getStatus(securityContext);

    return {
      environment: profile.status.name ?? profile.status.requestedName,
      environmentProfile: profile.status,
      baseUrl: profile.apiBaseUrl,
      baseUrlSource: profile.apiBaseUrlSource,
      configured: profile.status.valid && Boolean(profile.apiBaseUrl),
      accessTokenPresent: tokenStatus.accessTokenPresent,
      tokenStrategy: tokenStatus,
      writePolicy: profile.writePolicy,
      security: securityContext ? this.tokenProvider.getSecurityDiagnostics(securityContext) : undefined,
    };
  }

  async getCurrentUser(securityContext: ContentTrakerRequestSecurityContext): Promise<Record<string, unknown>> {
    const api = this.getStatus(securityContext);
    try {
      const response = await this.sendAuthorized("GET", api, "/me", securityContext);
      if (!response.ok) {
        return { status: "failed", httpStatus: response.statusCode, diagnostics: [`ContentTraker /me returned HTTP ${response.statusCode}.`] };
      }
      const payload = isRecord(response.json) ? response.json : {};
      const requiredEmail = process.env.CONTENTTRAKER_REQUIRED_USER_EMAIL?.trim();
      const email = stringValue(payload.email);
      return {
        status: "ready",
        environment: api.environment,
        user: {
          appUserId: stringValue(payload.appUserId) ?? stringValue(payload.id),
          email,
          name: stringValue(payload.name),
          role: stringValue(payload.role),
        },
        identityPolicy: {
          configured: Boolean(requiredEmail),
          requiredEmail: requiredEmail || undefined,
          matched: requiredEmail ? email?.toLowerCase() === requiredEmail.toLowerCase() : undefined,
        },
        correlationId: response.correlationId,
      };
    } catch (error) {
      const diagnostic = safeErrorMessage(error);
      return {
        status: diagnostic.startsWith("authentication_required:") ? "authentication_required" : "failed",
        environment: api.environment,
        diagnostics: [diagnostic],
      };
    }
  }

  async listWorkspaces(searchText: string | undefined, securityContext: ContentTrakerRequestSecurityContext): Promise<Record<string, unknown>> {
    const api = this.getStatus(securityContext);
    const query = searchText?.trim() ? `?search=${encodeURIComponent(searchText.trim())}` : "";
    try {
      const response = await this.sendAuthorized("GET", api, `/workspaces${query}`, securityContext);
      if (!response.ok) {
        return { status: "failed", httpStatus: response.statusCode, diagnostics: [`ContentTraker /workspaces returned HTTP ${response.statusCode}.`] };
      }
      const payload = response.json;
      const workspaces = Array.isArray(payload)
        ? payload
        : isRecord(payload) && Array.isArray(payload.workspaces)
          ? payload.workspaces
          : [];
      return { status: "ready", environment: api.environment, workspaces, correlationId: response.correlationId };
    } catch (error) {
      return { status: "failed", environment: api.environment, diagnostics: [safeErrorMessage(error)] };
    }
  }

  async resolveAuthorizedContext(
    context: ContentTrakerContext,
    securityContext: ContentTrakerRequestSecurityContext,
  ): Promise<AuthorizedContextResolutionResult> {
    const api = this.getStatus(securityContext);
    const correlationIds: string[] = [];
    if (!api.environmentProfile.valid || !api.configured || !api.tokenStrategy.configured) {
      return {
        status: "blocked",
        correlationIds,
        diagnostics: [
          "context_authorization_blocked: ContentTraker environment, API configuration, and authentication must be ready.",
        ],
      };
    }
    if (!context.workspaceId && !context.workspaceKey && !context.workspaceName) {
      return {
        status: "blocked",
        correlationIds,
        diagnostics: ["context_authorization_blocked: a workspaceId, workspaceKey, or workspaceName is required."],
      };
    }

    try {
      const workspaceResponse = await this.sendAuthorized(
        "GET",
        api,
        "/workspaces",
        securityContext,
      );
      if (workspaceResponse.correlationId) correlationIds.push(workspaceResponse.correlationId);
      if (!workspaceResponse.ok) {
        return {
          status: "failed",
          correlationIds,
          diagnostics: [`context_authorization_failed: /workspaces returned HTTP ${workspaceResponse.statusCode}.`],
        };
      }
      const workspaceMatches = matchingItems(workspaceResponse.json, {
        id: context.workspaceId,
        key: context.workspaceKey,
        name: context.workspaceName,
      }, "workspace");
      if (workspaceMatches.length !== 1) {
        return {
          status: "blocked",
          correlationIds,
          diagnostics: [
            workspaceMatches.length === 0
              ? "context_workspace_not_authorized: the requested workspace was not found in the verified user's authorized workspace list."
              : "context_workspace_ambiguous: the supplied workspace selectors matched more than one authorized workspace.",
          ],
        };
      }
      const workspace = selectableItem(workspaceMatches[0], "workspace");
      if (!workspace.id) {
        return {
          status: "blocked",
          correlationIds,
          diagnostics: ["context_workspace_invalid: the authorized workspace did not return a stable workspaceId."],
        };
      }
      const selectedContext: ContentTrakerContext = {
        environment: api.environmentProfile.name,
        workspaceId: workspace.id,
        workspaceKey: workspace.key,
        workspaceName: workspace.name,
        source: context.source,
      };

      if (context.projectId || context.projectKey || context.projectName) {
        const projectsResponse = await this.sendAuthorized(
          "GET",
          api,
          `/workspaces/${encodeURIComponent(workspace.id)}/projects`,
          securityContext,
        );
        if (projectsResponse.correlationId) correlationIds.push(projectsResponse.correlationId);
        if (!projectsResponse.ok) {
          return {
            status: "failed",
            correlationIds,
            diagnostics: [
              `context_project_authorization_failed: workspace projects returned HTTP ${projectsResponse.statusCode}.`,
            ],
          };
        }
        const projectMatches = matchingItems(projectsResponse.json, {
          id: context.projectId,
          key: context.projectKey,
          name: context.projectName,
        }, "project");
        if (projectMatches.length !== 1) {
          return {
            status: "blocked",
            correlationIds,
            diagnostics: [
              projectMatches.length === 0
                ? "context_project_not_authorized: the requested project is not a member of the selected authorized workspace."
                : "context_project_ambiguous: the supplied project selectors matched more than one project in the selected workspace.",
            ],
          };
        }
        const project = selectableItem(projectMatches[0], "project");
        if (!project.id) {
          return {
            status: "blocked",
            correlationIds,
            diagnostics: ["context_project_invalid: the authorized project did not return a stable projectId."],
          };
        }
        selectedContext.projectId = project.id;
        selectedContext.projectKey = project.key;
        selectedContext.projectName = project.name;
      }

      return {
        status: "ready",
        selectedContext,
        correlationIds,
        diagnostics: ["ContentTraker workspace and optional project were live-verified for the authenticated user."],
      };
    } catch (error) {
      return {
        status: "failed",
        correlationIds,
        diagnostics: [`context_authorization_failed: ${safeErrorMessage(error)}`],
      };
    }
  }

  async probeReadiness(
    context: ContentTrakerContext | undefined,
    securityContext: ContentTrakerRequestSecurityContext,
  ): Promise<ApiReadinessResult> {
    const api = this.getStatus(securityContext);
    const diagnostics: string[] = [...api.writePolicy.diagnostics];
    const checks: ApiReadinessCheck[] = [];

    if (!api.environmentProfile.valid) {
      diagnostics.push(
        `Invalid CONTENTTRAKER_ENVIRONMENT '${api.environmentProfile.requestedName}'; valid values are staging and production.`,
      );
    }

    if (!api.configured) {
      diagnostics.push("ContentTraker API base URL is not configured; readiness probe is blocked.");
    }

    if (!api.tokenStrategy.configured) {
      diagnostics.push("ContentTraker bearer token is not configured; authenticated readiness probe is blocked.");
    }

    if (!api.configured || !api.tokenStrategy.configured) {
      return {
        status: "blocked",
        api,
        selectedContext: context,
        checks,
        diagnostics,
      };
    }

    checks.push(await this.getJsonCheck(api, "/me", "current-user", securityContext));
    checks.push(await this.getJsonCheck(api, "/workspaces", "workspaces", securityContext, (json) =>
      context?.workspaceId || context?.workspaceName
        ? itemListHasMatch(json, context.workspaceId, context.workspaceName)
        : undefined,
    ));

    if (context?.workspaceId) {
      const projectsPath = `/workspaces/${encodeURIComponent(context.workspaceId)}/projects`;
      checks.push(await this.getJsonCheck(api, projectsPath, "workspace-projects", securityContext, (json) =>
        context.projectId || context.projectName
          ? itemListHasMatch(json, context.projectId, context.projectName)
          : undefined,
      ));
    }

    const failed = checks.some((check) => check.status === "failed");
    const blocked = checks.some((check) => check.status === "blocked");

    if (context?.workspaceId) {
      validateWorkspaceMatch(context, checks, diagnostics);
    }

    if (context?.projectId) {
      validateProjectMatch(context, checks, diagnostics);
    }

    return {
      status: failed ? "failed" : blocked ? "blocked" : "ready",
      api: this.getStatus(securityContext),
      selectedContext: context,
      checks,
      diagnostics,
    };
  }

  inspectApiContract(
    context: ContentTrakerContext | undefined,
    securityContext: ContentTrakerRequestSecurityContext,
  ): ApiContractResult {
    const api = this.getStatus(securityContext);
    const diagnostics = [
      ...api.writePolicy.diagnostics,
      "Phase 4 uses the TypeScript server-API client boundary and does not call the remote server-side MCP.",
    ];

    if (!api.configured) {
      diagnostics.push("ContentTraker API base URL is not configured.");
    }

    if (!api.tokenStrategy.configured) {
      diagnostics.push("ContentTraker bearer token is not configured.");
    }

    const capabilities = [
      {
        name: "current-user",
        status: "available" as const,
        method: "GET" as const,
        path: "/me",
      },
      {
        name: "workspace-list",
        status: "available" as const,
        method: "GET" as const,
        path: "/workspaces",
      },
      {
        name: "project-list",
        status: "available" as const,
        method: "GET" as const,
        path: "/workspaces/{workspaceId}/projects",
      },
      {
        name: "digital-asset-search",
        status: "available" as const,
        method: "GET" as const,
        path: "/workspaces/{workspaceId}/digital-assets",
      },
      {
        name: "digital-asset-read",
        status: "available" as const,
        method: "GET" as const,
        path: "/workspaces/{workspaceId}/digital-assets/{digitalAssetId}",
      },
      {
        name: "digital-asset-type-list",
        status: "available" as const,
        method: "GET" as const,
        path: "/workspaces/{workspaceId}/digital-assets/types",
      },
      {
        name: "digital-asset-update",
        status: "available" as const,
        method: "PUT" as const,
        path: "/workspaces/{workspaceId}/digital-assets/{digitalAssetId}",
      },
      {
        name: "digital-asset-write",
        status: "available" as const,
        method: "POST" as const,
        path: "/workspaces/{workspaceId}/digital-assets",
        reason: "The write path stores workspace digital assets with an explicit draft, published, or archived lifecycle status; project is optional provenance.",
      },
      {
        name: "digital-asset-lifecycle-status",
        status: "available" as const,
        method: "PUT" as const,
        path: "/workspaces/{workspaceId}/digital-assets/{digitalAssetId}/status",
        reason: "Lifecycle changes are approval-gated and queue search-index updates through shared server-side business logic.",
      },
      {
        name: "digital-asset-chunk-upload",
        status: "available" as const,
        method: "POST" as const,
        path: "/workspaces/{workspaceId}/digital-assets/uploads",
        reason: "Begin, append, and complete routes expose the shared large-file upload workflow.",
      },
    ];

    return {
      status: !api.configured || !api.tokenStrategy.configured ? "blocked" : "ready",
      api,
      selectedContext: context,
      capabilities,
      diagnostics,
    };
  }

  async getDigitalAsset(
    input: GetDigitalAssetInput,
    context: ContentTrakerContext | undefined,
    securityContext: ContentTrakerRequestSecurityContext,
  ): Promise<GetDigitalAssetResult> {
    const api = this.getStatus(securityContext);
    const diagnostics = validateReadInput(api, context);
    if (!input.digitalAssetId.trim()) {
      diagnostics.push("digitalAssetId is required.");
    }
    if (diagnostics.length > 0) {
      return { status: "blocked", api, selectedContext: context, diagnostics };
    }

    const query = new URLSearchParams();
    if (input.version !== undefined) query.set("version", String(input.version));
    if (input.includeContent !== undefined) query.set("includeContent", String(input.includeContent));
    if (input.provenanceProjectId ?? context?.projectId) query.set("projectId", input.provenanceProjectId ?? context!.projectId!);
    if (input.provenanceProjectKey ?? context?.projectKey) query.set("projectKey", input.provenanceProjectKey ?? context!.projectKey!);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const path = `/workspaces/${encodeURIComponent(context!.workspaceId!)}/digital-assets/${encodeURIComponent(input.digitalAssetId)}${suffix}`;

    try {
      const response = await this.sendAuthorized("GET", api, path, securityContext);
      if (!response.ok) {
        return {
          status: "failed",
          api,
          selectedContext: context,
          httpStatus: response.statusCode,
          diagnostics: [`ContentTraker digital asset read failed with HTTP ${response.statusCode}.`],
        };
      }

      return {
        status: "found",
        api,
        selectedContext: context,
        asset: isRecord(response.json) ? response.json : undefined,
        httpStatus: response.statusCode,
        diagnostics: [],
      };
    } catch (error) {
      return {
        status: "failed",
        api,
        selectedContext: context,
        diagnostics: [safeErrorMessage(error)],
      };
    }
  }

  async searchDigitalAssets(
    input: SearchDigitalAssetsInput,
    context: ContentTrakerContext | undefined,
    securityContext: ContentTrakerRequestSecurityContext,
  ): Promise<SearchDigitalAssetsResult> {
    const api = this.getStatus(securityContext);
    const diagnostics = validateReadInput(api, context);
    if (diagnostics.length > 0) {
      return { status: "blocked", api, selectedContext: context, results: [], diagnostics };
    }

    const query = new URLSearchParams();
    if (input.query) query.set("query", input.query);
    if (input.digitalAssetType) query.set("digitalAssetType", input.digitalAssetType);
    if (input.status) query.set("status", input.status);
    if (input.tags) query.set("tags", input.tags);
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    if (input.includeContentSnippets !== undefined) query.set("includeContentSnippets", String(input.includeContentSnippets));
    if (input.provenanceProjectId ?? context?.projectId) query.set("projectId", input.provenanceProjectId ?? context!.projectId!);
    if (input.provenanceProjectKey ?? context?.projectKey) query.set("projectKey", input.provenanceProjectKey ?? context!.projectKey!);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const path = `/workspaces/${encodeURIComponent(context!.workspaceId!)}/digital-assets${suffix}`;

    try {
      const response = await this.sendAuthorized("GET", api, path, securityContext);
      if (!response.ok) {
        return {
          status: "failed",
          api,
          selectedContext: context,
          results: [],
          httpStatus: response.statusCode,
          diagnostics: [`ContentTraker digital asset search failed with HTTP ${response.statusCode}.`],
        };
      }

      const payload = isRecord(response.json) ? response.json : {};
      return {
        status: "ready",
        api,
        selectedContext: context,
        workspaceId: stringValue(payload.workspaceId),
        workspaceKey: stringValue(payload.workspaceKey),
        defaultStatus: stringValue(payload.defaultStatus),
        results: Array.isArray(payload.results) ? payload.results.filter(isRecord) : [],
        correlationId: stringValue(payload.correlationId),
        httpStatus: response.statusCode,
        diagnostics: [],
      };
    } catch (error) {
      return {
        status: "failed",
        api,
        selectedContext: context,
        results: [],
        diagnostics: [safeErrorMessage(error)],
      };
    }
  }

  async listDigitalAssetTypes(
    _input: ListDigitalAssetTypesInput,
    context: ContentTrakerContext | undefined,
    securityContext: ContentTrakerRequestSecurityContext,
  ): Promise<ListDigitalAssetTypesResult> {
    const api = this.getStatus(securityContext);
    const diagnostics = validateReadInput(api, context);
    if (diagnostics.length > 0) {
      return { status: "blocked", api, selectedContext: context, digitalAssetTypes: [], diagnostics };
    }

    const path = `/workspaces/${encodeURIComponent(context!.workspaceId!)}/digital-assets/types`;
    try {
      const response = await this.sendAuthorized("GET", api, path, securityContext);
      if (!response.ok) {
        return { status: "failed", api, selectedContext: context, digitalAssetTypes: [], httpStatus: response.statusCode, diagnostics: [`ContentTraker digital asset type list failed with HTTP ${response.statusCode}.`] };
      }

      const payload = isRecord(response.json) ? response.json : {};
      return {
        status: "ready",
        api,
        selectedContext: context,
        workspaceId: stringValue(payload.workspaceId),
        workspaceKey: stringValue(payload.workspaceKey),
        digitalAssetTypes: Array.isArray(payload.digitalAssetTypes) ? payload.digitalAssetTypes.filter(isRecord) : [],
        correlationId: stringValue(payload.correlationId),
        httpStatus: response.statusCode,
        diagnostics: [],
      };
    } catch (error) {
      return { status: "failed", api, selectedContext: context, digitalAssetTypes: [], diagnostics: [safeErrorMessage(error)] };
    }
  }

  async updateDigitalAsset(
    input: UpdateDigitalAssetInput,
    context: ContentTrakerContext | undefined,
    securityContext: ContentTrakerRequestSecurityContext,
  ): Promise<UpdateDigitalAssetResult> {
    const api = this.getStatus(securityContext);
    const diagnostics = validateUpdateInput(api, input, context);
    if (diagnostics.length > 0) {
      return { status: "blocked", api, selectedContext: context, diagnostics };
    }

    const path = `/workspaces/${encodeURIComponent(context!.workspaceId!)}/digital-assets/${encodeURIComponent(input.digitalAssetId)}`;
    const body = {
      title: input.title,
      content: input.content,
      tags: input.tags,
      provenanceNotes: input.provenanceNotes,
      changeSummary: input.changeSummary,
      userApprovalStatement: input.userApprovalStatement,
    };
    try {
      const response = await this.sendAuthorized("PUT", api, path, securityContext, body, context);
      if (!response.ok) {
        return { status: "failed", api, selectedContext: context, httpStatus: response.statusCode, diagnostics: [`ContentTraker digital asset update failed with HTTP ${response.statusCode}.`] };
      }
      return { status: "updated", api, selectedContext: context, asset: isRecord(response.json) ? response.json : undefined, httpStatus: response.statusCode, diagnostics: [] };
    } catch (error) {
      return { status: "failed", api, selectedContext: context, diagnostics: [safeErrorMessage(error)] };
    }
  }

  async beginDigitalAssetUpload(
    input: BeginDigitalAssetUploadInput,
    context: ContentTrakerContext | undefined,
    securityContext: ContentTrakerRequestSecurityContext,
  ): Promise<DigitalAssetUploadResult> {
    const api = this.getStatus(securityContext);
    const diagnostics = validateUploadWriteInput(api, context, input.productionConfirmation);
    if (!input.title?.trim()) diagnostics.push("title is required.");
    if (!input.digitalAssetType?.trim()) diagnostics.push("digitalAssetType is required.");
    if (!input.userApprovalStatement?.trim()) diagnostics.push("userApprovalStatement is required.");
    if (diagnostics.length > 0) return { status: "blocked", api, selectedContext: context, diagnostics };

    const path = `/workspaces/${encodeURIComponent(context!.workspaceId!)}/digital-assets/uploads`;
    const body = {
      title: input.title,
      digitalAssetType: input.digitalAssetType,
      fileName: input.fileName,
      projectId: input.provenanceProjectId ?? context?.projectId,
      projectKey: input.provenanceProjectKey ?? context?.projectKey,
      format: input.format,
      sourceSystem: input.sourceSystem ?? "codex",
      sourceConversationId: input.sourceConversationId,
      sourceMessageId: input.sourceMessageId,
      provenanceNotes: input.provenanceNotes,
      status: input.status ?? "draft",
      userApprovalStatement: input.userApprovalStatement,
    };
    return this.sendUploadRequest("POST", api, context, path, securityContext, body, "ready");
  }

  async appendDigitalAssetUploadChunk(
    input: AppendDigitalAssetUploadChunkInput,
    context: ContentTrakerContext | undefined,
    securityContext: ContentTrakerRequestSecurityContext,
  ): Promise<DigitalAssetUploadResult> {
    const api = this.getStatus(securityContext);
    const diagnostics = validateUploadWriteInput(api, context, input.productionConfirmation);
    if (!input.uploadSessionId?.trim()) diagnostics.push("uploadSessionId is required.");
    if (!input.digitalAssetType?.trim()) diagnostics.push("digitalAssetType is required.");
    if (!input.fileName?.trim()) diagnostics.push("fileName is required.");
    if (input.chunkIndex < 0) diagnostics.push("chunkIndex must be zero or greater.");
    if (input.chunkContent === undefined) diagnostics.push("chunkContent is required.");
    if (diagnostics.length > 0) return { status: "blocked", api, selectedContext: context, diagnostics };

    const path = `/workspaces/${encodeURIComponent(context!.workspaceId!)}/digital-assets/uploads/${encodeURIComponent(input.uploadSessionId)}/chunks/${input.chunkIndex}`;
    const body = {
      digitalAssetType: input.digitalAssetType,
      fileName: input.fileName,
      chunkIndex: input.chunkIndex,
      chunkContent: input.chunkContent,
      contentEncoding: input.contentEncoding ?? "utf8",
      chunkSha256: input.chunkSha256,
      projectId: input.provenanceProjectId ?? context?.projectId,
      projectKey: input.provenanceProjectKey ?? context?.projectKey,
    };
    return this.sendUploadRequest("PUT", api, context, path, securityContext, body, "staged");
  }

  async completeDigitalAssetUpload(
    input: CompleteDigitalAssetUploadInput,
    context: ContentTrakerContext | undefined,
    securityContext: ContentTrakerRequestSecurityContext,
  ): Promise<DigitalAssetUploadResult> {
    const api = this.getStatus(securityContext);
    const diagnostics = validateUploadWriteInput(api, context, input.productionConfirmation);
    if (!input.uploadSessionId?.trim()) diagnostics.push("uploadSessionId is required.");
    if (!input.title?.trim()) diagnostics.push("title is required.");
    if (!input.digitalAssetType?.trim()) diagnostics.push("digitalAssetType is required.");
    if (!input.fileName?.trim()) diagnostics.push("fileName is required.");
    if (input.chunkCount <= 0) diagnostics.push("chunkCount must be greater than zero.");
    if (!input.userApprovalStatement?.trim()) diagnostics.push("userApprovalStatement is required.");
    if (diagnostics.length > 0) return { status: "blocked", api, selectedContext: context, diagnostics };

    const path = `/workspaces/${encodeURIComponent(context!.workspaceId!)}/digital-assets/uploads/${encodeURIComponent(input.uploadSessionId)}/complete`;
    const body = {
      title: input.title,
      digitalAssetType: input.digitalAssetType,
      fileName: input.fileName,
      chunkCount: input.chunkCount,
      projectId: input.provenanceProjectId ?? context?.projectId,
      projectKey: input.provenanceProjectKey ?? context?.projectKey,
      format: input.format,
      tags: input.tags,
      sourceSystem: input.sourceSystem ?? "codex",
      sourceConversationId: input.sourceConversationId,
      sourceMessageId: input.sourceMessageId,
      provenanceNotes: input.provenanceNotes,
      visibilityScope: input.visibilityScope,
      status: input.status ?? "draft",
      requiresReview: input.requiresReview ?? true,
      userApprovalStatement: input.userApprovalStatement,
    };
    return this.sendUploadRequest("POST", api, context, path, securityContext, body, "completed");
  }

  private async sendUploadRequest(
    method: "POST" | "PUT",
    api: ApiClientStatus,
    context: ContentTrakerContext | undefined,
    path: string,
    securityContext: ContentTrakerRequestSecurityContext,
    body: unknown,
    successStatus: "ready" | "staged" | "completed",
  ): Promise<DigitalAssetUploadResult> {
    try {
      const response = await this.sendAuthorized(method, api, path, securityContext, body, context);
      if (!response.ok) {
        return {
          status: "failed",
          api,
          selectedContext: context,
          httpStatus: response.statusCode,
          diagnostics: [`ContentTraker chunk upload failed with HTTP ${response.statusCode}.`],
        };
      }
      return {
        status: successStatus,
        api,
        selectedContext: context,
        upload: isRecord(response.json) ? response.json : undefined,
        httpStatus: response.statusCode,
        diagnostics: [],
      };
    } catch (error) {
      return {
        status: "failed",
        api,
        selectedContext: context,
        diagnostics: [safeErrorMessage(error)],
      };
    }
  }

  async createDigitalAsset(
    input: CreateDigitalAssetInput,
    context: ContentTrakerContext | undefined,
    securityContext: ContentTrakerRequestSecurityContext,
  ): Promise<CreateDigitalAssetResult> {
    const api = this.getStatus(securityContext);
    const diagnostics = validateCreateDigitalAssetInput(api, input, context);

    if (diagnostics.length > 0) {
      return {
        status: "blocked",
        api,
        selectedContext: context,
        diagnostics,
      };
    }

    const path = `/workspaces/${encodeURIComponent(context!.workspaceId!)}/digital-assets`;
    const body = {
      title: input.title,
      digitalAssetType: input.digitalAssetType,
      content: input.content,
      projectId: input.provenanceProjectId ?? context?.projectId,
      projectKey: input.provenanceProjectKey ?? context?.projectKey,
      format: input.format ?? "markdown",
      tags: input.tags,
      sourceSystem: input.sourceSystem ?? "codex",
      sourceConversationId: input.sourceConversationId,
      sourceMessageId: input.sourceMessageId,
      provenanceNotes: input.provenanceNotes,
      visibilityScope: input.visibilityScope,
      status: input.status ?? "draft",
      requiresReview: input.requiresReview ?? true,
      userApprovalStatement: input.userApprovalStatement,
      idempotencyKey: input.idempotencyKey,
    };

    try {
      const response = await this.sendAuthorized("POST", api, path, securityContext, body, context);
      if (!response.ok) {
        return {
          status: "failed",
          api,
          selectedContext: context,
          httpStatus: response.statusCode,
          diagnostics: [`ContentTraker API write failed with HTTP ${response.statusCode}.`],
        };
      }

      const asset = normalizeDigitalAssetWriteResponse(response.json);
      return {
        status: asset?.operation === "idempotent-replay" ? "idempotent-replay" : "created",
        api,
        selectedContext: context,
        asset,
        httpStatus: response.statusCode,
        diagnostics: [],
      };
    } catch (error) {
      return {
        status: "failed",
        api,
        selectedContext: context,
        diagnostics: [safeErrorMessage(error)],
      };
    }
  }

  async setDigitalAssetStatus(
    input: SetDigitalAssetStatusInput,
    context: ContentTrakerContext | undefined,
    securityContext: ContentTrakerRequestSecurityContext,
  ): Promise<SetDigitalAssetStatusResult> {
    const api = this.getStatus(securityContext);
    const diagnostics = validateLifecycleWriteInput(api, input, context);
    if (diagnostics.length > 0) {
      return { status: "blocked", api, selectedContext: context, diagnostics };
    }

    const path = `/workspaces/${encodeURIComponent(context!.workspaceId!)}/digital-assets/${encodeURIComponent(input.digitalAssetId)}/status`;
    const body = {
      status: input.status,
      reason: input.reason,
      userApprovalStatement: input.userApprovalStatement,
      idempotencyKey: input.idempotencyKey,
    };

    try {
      const response = await this.sendAuthorized("PUT", api, path, securityContext, body, context);
      if (!response.ok) {
        return {
          status: "failed",
          api,
          selectedContext: context,
          httpStatus: response.statusCode,
          diagnostics: [`ContentTraker lifecycle status write failed with HTTP ${response.statusCode}.`],
        };
      }

      const asset = normalizeDigitalAssetStatusResponse(response.json);
      return {
        status: asset?.operation === "status-unchanged" || asset?.operation === "idempotent-replay" ? "unchanged" : "changed",
        api,
        selectedContext: context,
        asset,
        httpStatus: response.statusCode,
        diagnostics: [],
      };
    } catch (error) {
      return {
        status: "failed",
        api,
        selectedContext: context,
        diagnostics: [safeErrorMessage(error)],
      };
    }
  }

  private async getJsonCheck(
    api: ApiClientStatus,
    path: string,
    name: string,
    securityContext: ContentTrakerRequestSecurityContext,
    matcher?: (json: unknown) => boolean | undefined,
  ): Promise<ApiReadinessCheck> {
    try {
      const response = await this.sendAuthorized("GET", api, path, securityContext);
      const matched = response.ok ? matcher?.(response.json) : undefined;
      const status = response.ok && matched !== false ? "ok" : "failed";
      return {
        name,
        method: "GET",
        path,
        attempted: true,
        status,
        httpStatus: response.statusCode,
        itemCount: countItems(response.json),
        matched,
        correlationId: response.correlationId,
        reason: response.ok
          ? matched === false
            ? "Configured registry mapping was not found in API response."
            : undefined
          : `HTTP ${response.statusCode}`,
      };
    } catch (error) {
      return {
        name,
        method: "GET",
        path,
        attempted: true,
        status: "failed",
        reason: safeErrorMessage(error),
      };
    }
  }

  private async sendAuthorized(
    method: "GET" | "POST" | "PUT",
    api: ApiClientStatus,
    path: string,
    securityContext: ContentTrakerRequestSecurityContext,
    body?: unknown,
    writeContext?: ContentTrakerContext,
  ): Promise<JsonResponse> {
    const send = async (options: { forceRefresh?: boolean; rejectedCredentialVersion?: string }): Promise<{
      response: JsonResponse;
      credentialVersion: string;
    }> => {
      const credential = await this.tokenProvider.getAuthorizationHeader(securityContext, {
        ...options,
        allowInteractive: false,
      });
      if (credential.environment !== api.environment || credential.audience !== securityContext.tokenAudience) {
        throw new Error("ContentTraker credential does not match the request environment or audience.");
      }

      assertHttpsAudienceBoundApi(api.baseUrl!, credential.audience);

      if (path !== "/me") {
        const callerResponse = await this.serverApiClient.getJson(
          api.baseUrl!, "/me", credential.authorizationHeader, securityContext.correlationId,
        );
        if (!callerResponse.ok) {
          return { response: callerResponse, credentialVersion: credential.credentialVersion };
        }
        this.recordVerifiedCaller(api, securityContext, callerResponse);
      }

      if (method !== "GET") {
        if (!writeContext?.workspaceId) {
          throw new Error("ContentTraker write blocked because an explicit resolved workspaceId is required.");
        }
        const workspacesResponse = await this.serverApiClient.getJson(
          api.baseUrl!, "/workspaces", credential.authorizationHeader, securityContext.correlationId,
        );
        if (workspacesResponse.statusCode === 401) {
          return { response: workspacesResponse, credentialVersion: credential.credentialVersion };
        }
        if (!workspacesResponse.ok) {
          throw new Error(`ContentTraker write blocked because authorized workspace verification returned HTTP ${workspacesResponse.statusCode}.`);
        }
        if (!itemListHasIdMatch(workspacesResponse.json, writeContext.workspaceId)) {
          throw new Error("ContentTraker write blocked because the selected workspaceId is not authorized for the verified user.");
        }
      }

      if (method === "GET") {
        const response = await this.serverApiClient.getJson(
          api.baseUrl!, path, credential.authorizationHeader, securityContext.correlationId,
        );
        if (path === "/me" && response.ok) this.recordVerifiedCaller(api, securityContext, response);
        return {
          response,
          credentialVersion: credential.credentialVersion,
        };
      }
      if (method === "POST") {
        return {
          response: await this.serverApiClient.postJson(
            api.baseUrl!, path, credential.authorizationHeader, body, securityContext.correlationId,
          ),
          credentialVersion: credential.credentialVersion,
        };
      }
      return {
        response: await this.serverApiClient.putJson(
          api.baseUrl!, path, credential.authorizationHeader, body, securityContext.correlationId,
        ),
        credentialVersion: credential.credentialVersion,
      };
    };

    const firstAttempt = await send({});
    if (firstAttempt.response.statusCode !== 401 || api.tokenStrategy.mode !== "delegated-user-pkce") {
      return firstAttempt.response;
    }

    const retry = await send({
      forceRefresh: true,
      rejectedCredentialVersion: firstAttempt.credentialVersion,
    });
    return retry.response;
  }

  private recordVerifiedCaller(
    api: ApiClientStatus,
    securityContext: ContentTrakerRequestSecurityContext,
    response: JsonResponse,
  ): void {
    const payload = isRecord(response.json) ? response.json : {};
    const subjectId = stringValue(payload.appUserId) ?? stringValue(payload.id);
    if (!subjectId) {
      throw new Error("ContentTraker /me did not return an authenticated subject identifier.");
    }
    const requiredEmail = process.env.CONTENTTRAKER_REQUIRED_USER_EMAIL?.trim();
    if (requiredEmail) {
      const email = stringValue(payload.email);
      if (!email || email.toLowerCase() !== requiredEmail.toLowerCase()) {
        throw new Error("Authenticated ContentTraker identity does not match this host's required identity policy.");
      }
    }
    this.tokenProvider.recordEffectiveCaller(
      securityContext,
      subjectId,
      response.correlationId ?? stringValue(payload.correlationId),
    );
    const verifiedStatus = this.getStatus(securityContext);
    api.accessTokenPresent = verifiedStatus.accessTokenPresent;
    api.tokenStrategy = verifiedStatus.tokenStrategy;
    api.security = verifiedStatus.security;
  }
}

const PRODUCTION_CONFIRMATION = "CONFIRM_PRODUCTION_CONTENTTRAKER_WRITE";

function validateReadInput(
  api: ApiClientStatus,
  context: ContentTrakerContext | undefined,
): string[] {
  const diagnostics: string[] = [];
  if (!api.environmentProfile.valid) diagnostics.push("ContentTraker environment is invalid.");
  if (!api.configured) diagnostics.push("ContentTraker API base URL is not configured; digital asset read is blocked.");
  if (!api.tokenStrategy.configured) diagnostics.push("ContentTraker bearer token is not configured; digital asset read is blocked.");
  if (context?.source === "workspace-conflict") {
    diagnostics.push("workspace_conflict: the explicit workspace differs from the exact repository/project registry mapping; no ContentTraker operation was attempted.");
  }
  if (!context?.workspaceId) diagnostics.push("ContentTraker workspaceId is required.");
  return diagnostics;
}

function validateUpdateInput(
  api: ApiClientStatus,
  input: UpdateDigitalAssetInput,
  context: ContentTrakerContext | undefined,
): string[] {
  const diagnostics = validateReadInput(api, context);
  if (!api.writePolicy.writesExposed) diagnostics.push("ContentTraker write policy does not expose digital asset updates for this environment.");
  if (!input.digitalAssetId?.trim()) diagnostics.push("digitalAssetId is required.");
  if (!input.userApprovalStatement?.trim()) diagnostics.push("userApprovalStatement is required for digital asset updates.");
  if (input.content && !input.changeSummary?.trim()) diagnostics.push("changeSummary is required when content changes.");
  if (input.productionConfirmation && api.environment !== "production") diagnostics.push("productionConfirmation is only valid when CONTENTTRAKER_ENVIRONMENT=production.");
  if (api.environment === "production" && input.productionConfirmation !== PRODUCTION_CONFIRMATION) {
    diagnostics.push(`productionConfirmation must be '${PRODUCTION_CONFIRMATION}' for production writes.`);
  }
  return diagnostics;
}

function validateUploadWriteInput(
  api: ApiClientStatus,
  context: ContentTrakerContext | undefined,
  productionConfirmation: string | undefined,
): string[] {
  const diagnostics = validateReadInput(api, context);
  if (!api.writePolicy.writesExposed) diagnostics.push("ContentTraker write policy does not expose chunk uploads for this environment.");
  if (productionConfirmation && api.environment !== "production") diagnostics.push("productionConfirmation is only valid when CONTENTTRAKER_ENVIRONMENT=production.");
  if (api.environment === "production" && productionConfirmation !== PRODUCTION_CONFIRMATION) {
    diagnostics.push(`productionConfirmation must be '${PRODUCTION_CONFIRMATION}' for production writes.`);
  }
  return diagnostics;
}

function validateCreateDigitalAssetInput(
  api: ApiClientStatus,
  input: CreateDigitalAssetInput,
  context: ContentTrakerContext | undefined,
): string[] {
  const diagnostics = [...api.writePolicy.diagnostics];

  if (!api.environmentProfile.valid) {
    diagnostics.push(
      `Invalid CONTENTTRAKER_ENVIRONMENT '${api.environmentProfile.requestedName}'; valid values are staging and production.`,
    );
  }

  if (!api.configured) {
    diagnostics.push("ContentTraker API base URL is not configured; digital asset write is blocked.");
  }

  if (!api.tokenStrategy.configured) {
    diagnostics.push("ContentTraker bearer token is not configured; digital asset write is blocked.");
  }

  if (!api.writePolicy.writesExposed) {
    diagnostics.push("ContentTraker write policy does not expose digital asset writes for this environment.");
  }

  if (context?.source === "workspace-conflict") {
    diagnostics.push("workspace_conflict: the explicit workspace differs from the exact repository/project registry mapping; no ContentTraker write was attempted.");
  }

  if (!context?.workspaceId) {
    diagnostics.push("ContentTraker workspaceId is required; projectId is optional provenance and is not required.");
  }

  if (!input.title?.trim()) {
    diagnostics.push("title is required.");
  }

  if (!input.digitalAssetType?.trim()) {
    diagnostics.push("digitalAssetType is required.");
  }

  if (!input.content?.trim()) {
    diagnostics.push("content is required.");
  }

  if (!input.userApprovalStatement?.trim()) {
    diagnostics.push("userApprovalStatement is required for ContentTraker digital asset writes.");
  }

  if (!input.idempotencyKey?.trim()) {
    diagnostics.push("idempotencyKey is required for ContentTraker digital asset writes.");
  }

  if (input.status && !["draft", "published", "archived"].includes(input.status)) {
    diagnostics.push("status must be draft, published, or archived.");
  }

  if (input.productionConfirmation && api.environment !== "production") {
    diagnostics.push("productionConfirmation is only valid when CONTENTTRAKER_ENVIRONMENT=production.");
  }

  if (api.environment === "production" && input.productionConfirmation !== PRODUCTION_CONFIRMATION) {
    diagnostics.push(`productionConfirmation must be '${PRODUCTION_CONFIRMATION}' for production writes.`);
  }

  return diagnostics;
}

function validateLifecycleWriteInput(
  api: ApiClientStatus,
  input: SetDigitalAssetStatusInput,
  context: ContentTrakerContext | undefined,
): string[] {
  const diagnostics = [...api.writePolicy.diagnostics];

  if (!api.environmentProfile.valid) diagnostics.push("ContentTraker environment is invalid.");
  if (!api.configured) diagnostics.push("ContentTraker API base URL is not configured; lifecycle write is blocked.");
  if (!api.tokenStrategy.configured) diagnostics.push("ContentTraker bearer token is not configured; lifecycle write is blocked.");
  if (!api.writePolicy.writesExposed) diagnostics.push("ContentTraker write policy does not expose lifecycle writes for this environment.");
  if (context?.source === "workspace-conflict") diagnostics.push("workspace_conflict: the explicit workspace differs from the exact repository/project registry mapping; no ContentTraker write was attempted.");
  if (!context?.workspaceId) diagnostics.push("ContentTraker workspaceId is required.");
  if (!input.digitalAssetId?.trim()) diagnostics.push("digitalAssetId is required.");
  if (!["draft", "published", "archived"].includes(input.status)) diagnostics.push("status must be draft, published, or archived.");
  if (!input.userApprovalStatement?.trim()) diagnostics.push("userApprovalStatement is required for lifecycle writes.");
  if (!input.idempotencyKey?.trim()) diagnostics.push("idempotencyKey is required for lifecycle writes.");
  if (input.productionConfirmation && api.environment !== "production") {
    diagnostics.push("productionConfirmation is only valid when CONTENTTRAKER_ENVIRONMENT=production.");
  }
  if (api.environment === "production" && input.productionConfirmation !== PRODUCTION_CONFIRMATION) {
    diagnostics.push(`productionConfirmation must be '${PRODUCTION_CONFIRMATION}' for production writes.`);
  }

  return diagnostics;
}

function normalizeDigitalAssetWriteResponse(value: unknown): CreateDigitalAssetResult["asset"] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return {
    digitalAssetId: stringValue(record.digitalAssetId),
    workspaceId: stringValue(record.workspaceId),
    workspaceKey: stringValue(record.workspaceKey),
    projectId: stringValue(record.projectId),
    projectKey: stringValue(record.projectKey),
    title: stringValue(record.title),
    digitalAssetType: stringValue(record.digitalAssetType),
    status: stringValue(record.status),
    requiresReview: booleanValue(record.requiresReview),
    version: numberValue(record.version),
    createdAt: stringValue(record.createdAt),
    resourceUri: stringValue(record.resourceUri),
    indexingJobId: stringValue(record.indexingJobId),
    operation: stringValue(record.operation),
  };
}

function normalizeDigitalAssetStatusResponse(value: unknown): SetDigitalAssetStatusResult["asset"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return {
    digitalAssetId: stringValue(record.digitalAssetId),
    workspaceId: stringValue(record.workspaceId),
    workspaceKey: stringValue(record.workspaceKey),
    projectId: stringValue(record.projectId),
    projectKey: stringValue(record.projectKey),
    previousStatus: stringValue(record.previousStatus),
    status: stringValue(record.status),
    indexingJobId: stringValue(record.indexingJobId),
    changedAt: stringValue(record.changedAt),
    resourceUri: stringValue(record.resourceUri),
    operation: stringValue(record.operation),
  };
}

function countItems(value: unknown): number | undefined {
  const items = extractItems(value);
  return items ? items.length : undefined;
}

function validateWorkspaceMatch(
  context: ContentTrakerContext,
  checks: ApiReadinessCheck[],
  diagnostics: string[],
): void {
  const workspaceCheck = checks.find((check) => check.name === "workspaces");
  if (workspaceCheck?.matched !== false || workspaceCheck.itemCount === undefined) {
    return;
  }

  diagnostics.push(
    `Workspace mapping '${context.workspaceId ?? context.workspaceName}' was not found in /workspaces response.`,
  );
}

function validateProjectMatch(
  context: ContentTrakerContext,
  checks: ApiReadinessCheck[],
  diagnostics: string[],
): void {
  const projectsCheck = checks.find((check) => check.name === "workspace-projects");
  if (projectsCheck?.matched !== false || projectsCheck.itemCount === undefined) {
    return;
  }

  diagnostics.push(
    `Project mapping '${context.projectId ?? context.projectName}' was not found in /workspaces/{workspaceId}/projects response.`,
  );
}

function extractItems(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  for (const key of ["items", "value", "workspaces", "projects", "data"]) {
    const candidate = (value as Record<string, unknown>)[key];
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function itemListHasMatch(value: unknown, id: string | undefined, name: string | undefined): boolean | undefined {
  const items = extractItems(value);
  if (!items) {
    return undefined;
  }

  return items.some((item) => itemMatches(item, id, name));
}

function itemListHasIdMatch(value: unknown, id: string): boolean {
  const items = extractItems(value);
  return Boolean(items?.some((item) => {
    if (!isRecord(item)) return false;
    const itemId = stringValue(item.id) ?? stringValue(item.workspaceId);
    return equals(id, itemId);
  }));
}

function matchingItems(
  value: unknown,
  selectors: { id?: string; key?: string; name?: string },
  kind: "workspace" | "project",
): unknown[] {
  const items = extractItems(value) ?? [];
  return items.filter((item) => {
    const candidate = selectableItem(item, kind);
    if (selectors.id && !equals(selectors.id, candidate.id)) return false;
    if (selectors.key && !equals(selectors.key, candidate.key)) return false;
    if (selectors.name && !equals(selectors.name, candidate.name)) return false;
    return Boolean(selectors.id || selectors.key || selectors.name);
  });
}

function selectableItem(
  value: unknown,
  kind: "workspace" | "project",
): { id?: string; key?: string; name?: string } {
  if (!isRecord(value)) return {};
  return kind === "workspace"
    ? {
        id: stringValue(value.id) ?? stringValue(value.workspaceId),
        key: stringValue(value.key) ?? stringValue(value.workspaceKey),
        name: stringValue(value.name) ?? stringValue(value.workspaceName),
      }
    : {
        id: stringValue(value.id) ?? stringValue(value.projectId),
        key: stringValue(value.key) ?? stringValue(value.projectKey),
        name: stringValue(value.name) ?? stringValue(value.projectName),
      };
}

function itemMatches(value: unknown, id: string | undefined, name: string | undefined): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  const itemId = stringValue(record.id) ?? stringValue(record.workspaceId) ?? stringValue(record.projectId);
  const itemName = stringValue(record.name) ?? stringValue(record.workspaceName) ?? stringValue(record.projectName);

  return Boolean(
    (id && equals(id, itemId)) ||
      (name && equals(name, itemName)),
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function equals(left: string, right: string | undefined): boolean {
  return left.trim().toLocaleLowerCase() === right?.trim().toLocaleLowerCase();
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(access_token|refresh_token|device_code|code_verifier|authorization_code|client_secret|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

function assertHttpsAudienceBoundApi(baseUrl: string, audience: string): void {
  const api = new URL(baseUrl);
  const resource = new URL(audience);
  if (
    api.protocol !== "https:"
    || resource.protocol !== "https:"
    || api.username
    || api.password
    || resource.username
    || resource.password
    || api.origin !== resource.origin
  ) {
    throw new Error("ContentTraker API origin must be HTTPS and exactly match the credential audience origin.");
  }
}
