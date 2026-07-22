export type ContentTrakerEnvironment = "staging" | "production";

export type RuntimeProfileName =
  | "auto"
  | "windows-desktop"
  | "macos-desktop"
  | "linux-desktop"
  | "wsl-desktop"
  | "headless"
  | "container";

export type SelectedRuntimeProfileName = Exclude<RuntimeProfileName, "auto">;

export type RuntimeCapabilityStatus = "available" | "blocked" | "future" | "external";

export interface RuntimeHostFacts {
  platform: "windows" | "macos" | "linux" | "other";
  isWsl: boolean;
  isContainer: boolean;
  isCi: boolean;
  graphicalSessionAvailable: boolean;
  dbusSessionAvailable: boolean;
  browserInteractionMode: "system-browser" | "manual-url" | "wsl-native" | "invalid";
  systemBrowserLauncherAvailable: boolean;
  wslNativeBrowserIsolationAvailable: boolean;
  linuxSecretToolAvailable: boolean;
  linuxSecretServicePrerequisitesAvailable: boolean;
  credentialStoreProvider:
    | "windows-credential-manager"
    | "macos-keychain"
    | "linux-secret-service"
    | "ephemeral-memory"
    | "unavailable";
  credentialStoreAvailable: boolean;
  credentialStorePersistent: boolean;
  credentialStoreDiagnostics: string[];
}

export interface RuntimeCapability {
  name: string;
  status: RuntimeCapabilityStatus;
  reason?: string;
}

export interface RuntimeStrategySelection {
  authentication: "delegated-user-pkce" | "workload-oauth" | "invalid";
  interaction: "system-browser" | "manual-url" | "wsl-native" | "none";
  credentialProfile: string;
  credentialPersistence:
    | "windows-credential-manager"
    | "macos-keychain"
    | "linux-secret-service"
    | "ephemeral-memory"
    | "none";
  crossTaskRestoration: boolean;
}

export interface RuntimeCapabilitiesResult {
  status: "ready" | "blocked" | "invalid";
  contentTrakerEnvironment: {
    requestedName: string;
    name?: ContentTrakerEnvironment;
    valid: boolean;
  };
  requestedProfile: string;
  selectedProfile?: SelectedRuntimeProfileName;
  requestedAuthenticationMode: string;
  selectedAuthenticationMode?: "delegated" | "workload";
  requestedDelegatedFlow: string;
  host: RuntimeHostFacts;
  selectedStrategy: RuntimeStrategySelection;
  capabilities: {
    interaction: RuntimeCapability[];
    authentication: RuntimeCapability[];
    credentialPersistence: RuntimeCapability[];
    sessionRestoration: RuntimeCapability[];
  };
  diagnostics: string[];
}

export type AuthorizationFlowStatus =
  | "idle"
  | "pending"
  | "authorized"
  | "failed"
  | "expired"
  | "cancelled"
  | "blocked";

export interface AuthorizationFlowResult {
  status: AuthorizationFlowStatus;
  interaction?: "system-browser" | "manual-url" | "wsl-native" | "device-code";
  authorizationUrl?: string;
  redirectUri?: string;
  verificationUri?: string;
  userCode?: string;
  intervalSeconds?: number;
  expiresAt?: string;
  diagnostics: string[];
}

export type ContextResolutionStatus =
  | "resolved"
  | "defaulted"
  | "workspace_conflict"
  | "unconfigured"
  | "unresolved";

export interface EnvironmentProfileStatus {
  requestedName: string;
  name?: ContentTrakerEnvironment;
  valid: boolean;
  allowedNames: ContentTrakerEnvironment[];
}

export interface TokenStrategyStatus {
  mode: "delegated-user-pkce" | "workload-oauth" | "invalid";
  configured: boolean;
  accessTokenPresent: boolean;
  source?: string;
  credentialStore?:
    | "windows-credential-manager"
    | "macos-keychain"
    | "linux-secret-service"
    | "ephemeral-memory"
    | "unavailable"
    | "custom";
  credentialProfile?: string;
  crossTaskRestoration?: boolean;
  authenticationPending?: boolean;
  subjectId?: string;
  tokenExpiryStatus?: "missing" | "valid" | "expiring" | "expired";
}

export interface ContentTrakerRequestSecurityContext {
  environment: ContentTrakerEnvironment;
  connectionId: string;
  sessionId: string;
  requestId: string;
  correlationId: string;
  tokenAudience: string;
}

export interface RequestSecurityDiagnostics {
  environment: ContentTrakerEnvironment;
  authenticationMode: TokenStrategyStatus["mode"];
  connectionId: string;
  sessionId: string;
  requestId: string;
  authenticatedSubjectId?: string;
  credentialHandle?: string;
  credentialProfile?: string;
  credentialStore?: TokenStrategyStatus["credentialStore"];
  tokenAudience: string;
  tokenExpiryStatus: "missing" | "valid" | "expiring" | "expired";
  tokenExpiresAt?: string;
  correlationId: string;
  contentTrakerCorrelationId?: string;
  effectiveCallerVerified: boolean;
}

export interface WritePolicyStatus {
  writesExposed: boolean;
  productionWritesEnabled: boolean;
  mode:
    | "staging-writes-enabled"
    | "production-read-only"
    | "production-explicit-enabled"
    | "invalid-environment-read-only";
  requiresExplicitConfirmation: boolean;
  requiresIdempotencyKey: boolean;
  requiresDraftStatus: boolean;
  diagnostics: string[];
}

export interface ContentTrakerContext {
  environment?: ContentTrakerEnvironment;
  workspaceName?: string;
  workspaceId?: string;
  projectName?: string;
  projectId?: string;
  source: "explicit-workspace" | "registry-project" | "registry-default" | "workspace-conflict";
  workspaceConflict?: {
    explicit: WorkspaceCandidate;
    registry: WorkspaceCandidate;
  };
}

export interface WorkspaceCandidate {
  workspaceName?: string;
  workspaceId?: string;
  source: "explicit-workspace" | "registry-project";
}

export interface ResolveContextInput {
  projectName?: string;
  workspaceId?: string;
  workspaceName?: string;
  repositoryRoot?: string;
}

export interface ProbeApiReadinessInput extends ResolveContextInput {}

export interface CreateDigitalAssetInput extends ResolveContextInput {
  title: string;
  digitalAssetType: string;
  content: string;
  format?: "markdown" | "text";
  tags?: string;
  sourceSystem?: string;
  sourceConversationId?: string;
  sourceMessageId?: string;
  provenanceNotes?: string;
  visibilityScope?: string;
  requiresReview?: boolean;
  status?: "draft" | "published" | "archived";
  userApprovalStatement: string;
  idempotencyKey: string;
  provenanceProjectId?: string;
  provenanceProjectKey?: string;
  productionConfirmation?: string;
}

export interface SetDigitalAssetStatusInput extends ResolveContextInput {
  digitalAssetId: string;
  status: "draft" | "published" | "archived";
  reason?: string;
  userApprovalStatement: string;
  idempotencyKey: string;
  productionConfirmation?: string;
}

export interface GetDigitalAssetInput extends ResolveContextInput {
  digitalAssetId: string;
  version?: number;
  includeContent?: boolean;
  provenanceProjectId?: string;
  provenanceProjectKey?: string;
}

export interface SearchDigitalAssetsInput extends ResolveContextInput {
  query?: string;
  digitalAssetType?: string;
  status?: "draft" | "published" | "archived";
  tags?: string;
  limit?: number;
  includeContentSnippets?: boolean;
  provenanceProjectId?: string;
  provenanceProjectKey?: string;
}

export interface ListDigitalAssetTypesInput extends ResolveContextInput {}

export interface UpdateDigitalAssetInput extends ResolveContextInput {
  digitalAssetId: string;
  title?: string;
  content?: string;
  tags?: string;
  provenanceNotes?: string;
  changeSummary?: string;
  userApprovalStatement: string;
  productionConfirmation?: string;
}

export interface BeginDigitalAssetUploadInput extends ResolveContextInput {
  title: string;
  digitalAssetType: string;
  fileName?: string;
  format?: "markdown" | "text";
  sourceSystem?: string;
  sourceConversationId?: string;
  sourceMessageId?: string;
  provenanceNotes?: string;
  status?: "draft" | "archived";
  userApprovalStatement: string;
  provenanceProjectId?: string;
  provenanceProjectKey?: string;
  productionConfirmation?: string;
}

export interface AppendDigitalAssetUploadChunkInput extends ResolveContextInput {
  uploadSessionId: string;
  digitalAssetType: string;
  fileName: string;
  chunkIndex: number;
  chunkContent: string;
  contentEncoding?: "utf8" | "base64";
  chunkSha256?: string;
  provenanceProjectId?: string;
  provenanceProjectKey?: string;
  productionConfirmation?: string;
}

export interface CompleteDigitalAssetUploadInput extends ResolveContextInput {
  uploadSessionId: string;
  title: string;
  digitalAssetType: string;
  fileName: string;
  chunkCount: number;
  format?: "markdown" | "text";
  tags?: string;
  sourceSystem?: string;
  sourceConversationId?: string;
  sourceMessageId?: string;
  provenanceNotes?: string;
  visibilityScope?: string;
  status?: "draft" | "archived";
  requiresReview?: boolean;
  userApprovalStatement: string;
  provenanceProjectId?: string;
  provenanceProjectKey?: string;
  productionConfirmation?: string;
}

export interface UpsertRegistryMappingInput {
  environment?: ContentTrakerEnvironment;
  projectName: string;
  repositoryRoot: string;
  workspaceName?: string;
  workspaceId?: string;
  contentTrakerProjectName?: string;
  contentTrakerProjectId?: string;
  setDefault?: boolean;
  dryRun?: boolean;
}

export interface RegistryProjectMapping {
  projectName: string;
  repositoryRoot?: string;
  workspaceName?: string;
  workspaceId?: string;
  contentTrakerProjectName?: string;
  contentTrakerProjectId?: string;
}

export interface WorkspaceRegistryDocument {
  version: 1 | 2;
  defaults?: {
    workspaceName?: string;
    workspaceId?: string;
    projectName?: string;
    projectId?: string;
  };
  projects?: RegistryProjectMapping[];
  environments?: Partial<Record<ContentTrakerEnvironment, WorkspaceRegistryEnvironment>>;
}

export interface WorkspaceRegistryEnvironment {
  defaults?: {
    workspaceName?: string;
    workspaceId?: string;
    projectName?: string;
    projectId?: string;
  };
  projects?: RegistryProjectMapping[];
}

export interface RegistrySnapshot {
  path: string;
  exists: boolean;
  loaded: boolean;
  environment?: ContentTrakerEnvironment;
  environmentConfigured: boolean;
  projectCount: number;
  errors: string[];
  documentVersion?: WorkspaceRegistryDocument["version"];
  document?: WorkspaceRegistryDocument;
  environmentDocument?: WorkspaceRegistryEnvironment;
}

export interface ApiClientStatus {
  environment: string;
  environmentProfile: EnvironmentProfileStatus;
  baseUrl?: string;
  baseUrlSource?: string;
  configured: boolean;
  accessTokenPresent: boolean;
  tokenStrategy: TokenStrategyStatus;
  writePolicy: WritePolicyStatus;
  security?: RequestSecurityDiagnostics;
}

export type ApiCapabilityStatus = "available" | "blocked" | "future";

export interface ApiCapabilityCheck {
  name: string;
  status: ApiCapabilityStatus;
  method?: "GET" | "POST" | "PUT";
  path?: string;
  reason?: string;
}

export interface ApiContractResult {
  status: "ready" | "blocked" | "gaps-found";
  api: ApiClientStatus;
  selectedContext?: ContentTrakerContext;
  capabilities: ApiCapabilityCheck[];
  diagnostics: string[];
}

export interface CreateDigitalAssetResult {
  status: "created" | "idempotent-replay" | "blocked" | "failed";
  api: ApiClientStatus;
  selectedContext?: ContentTrakerContext;
  asset?: {
    digitalAssetId?: string;
    workspaceId?: string;
    workspaceKey?: string;
    projectId?: string;
    projectKey?: string;
    title?: string;
    digitalAssetType?: string;
    status?: string;
    requiresReview?: boolean;
    version?: number;
    createdAt?: string;
    resourceUri?: string;
    indexingJobId?: string;
    operation?: string;
  };
  httpStatus?: number;
  diagnostics: string[];
}

export interface SetDigitalAssetStatusResult {
  status: "changed" | "unchanged" | "blocked" | "failed";
  api: ApiClientStatus;
  selectedContext?: ContentTrakerContext;
  asset?: {
    digitalAssetId?: string;
    workspaceId?: string;
    workspaceKey?: string;
    projectId?: string;
    projectKey?: string;
    previousStatus?: string;
    status?: string;
    indexingJobId?: string;
    changedAt?: string;
    resourceUri?: string;
    operation?: string;
  };
  httpStatus?: number;
  diagnostics: string[];
}

export interface GetDigitalAssetResult {
  status: "found" | "blocked" | "failed";
  api: ApiClientStatus;
  selectedContext?: ContentTrakerContext;
  asset?: Record<string, unknown>;
  httpStatus?: number;
  diagnostics: string[];
}

export interface SearchDigitalAssetsResult {
  status: "ready" | "blocked" | "failed";
  api: ApiClientStatus;
  selectedContext?: ContentTrakerContext;
  workspaceId?: string;
  workspaceKey?: string;
  defaultStatus?: string;
  results: Array<Record<string, unknown>>;
  correlationId?: string;
  httpStatus?: number;
  diagnostics: string[];
}

export interface ListDigitalAssetTypesResult {
  status: "ready" | "blocked" | "failed";
  api: ApiClientStatus;
  selectedContext?: ContentTrakerContext;
  workspaceId?: string;
  workspaceKey?: string;
  digitalAssetTypes: Array<Record<string, unknown>>;
  correlationId?: string;
  httpStatus?: number;
  diagnostics: string[];
}

export interface UpdateDigitalAssetResult {
  status: "updated" | "blocked" | "failed";
  api: ApiClientStatus;
  selectedContext?: ContentTrakerContext;
  asset?: Record<string, unknown>;
  httpStatus?: number;
  diagnostics: string[];
}

export interface DigitalAssetUploadResult {
  status: "ready" | "staged" | "completed" | "blocked" | "failed";
  api: ApiClientStatus;
  selectedContext?: ContentTrakerContext;
  upload?: Record<string, unknown>;
  httpStatus?: number;
  diagnostics: string[];
}

export type ApiReadinessStatus = "ready" | "blocked" | "failed";
export type ApiReadinessCheckStatus = "ok" | "blocked" | "failed" | "skipped";

export interface ApiReadinessCheck {
  name: string;
  method: "GET";
  path: string;
  attempted: boolean;
  status: ApiReadinessCheckStatus;
  httpStatus?: number;
  itemCount?: number;
  matched?: boolean;
  reason?: string;
  correlationId?: string;
}

export interface ApiReadinessResult {
  status: ApiReadinessStatus;
  api: ApiClientStatus;
  selectedContext?: ContentTrakerContext;
  checks: ApiReadinessCheck[];
  diagnostics: string[];
}

export interface ResolveContextResult {
  status: ContextResolutionStatus;
  selectedContext?: ContentTrakerContext;
  workspaceCandidates?: {
    explicit: WorkspaceCandidate;
    registry: WorkspaceCandidate;
  };
  registry: {
    path: string;
    exists: boolean;
    loaded: boolean;
    environment?: ContentTrakerEnvironment;
    environmentConfigured: boolean;
    documentVersion?: WorkspaceRegistryDocument["version"];
    projectCount: number;
  };
  api: ApiClientStatus;
  diagnostics: string[];
}

export interface RegistryUpsertResult {
  status: "created" | "updated" | "unchanged" | "dry-run";
  dryRun: boolean;
  registry: {
    path: string;
    existsBefore: boolean;
    documentVersion: 2;
    environment: ContentTrakerEnvironment;
    projectCount: number;
  };
  selectedContext: ContentTrakerContext;
  diagnostics: string[];
}
