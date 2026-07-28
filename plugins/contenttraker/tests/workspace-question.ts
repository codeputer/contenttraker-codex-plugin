import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { EnvironmentContentTrakerApiClient } from "../src/contenttraker-api-client.js";
import type {
  ContentTrakerServerApiClient,
  JsonResponse,
} from "../src/contenttraker-server-api-client.js";
import { askWorkspaceQuestion } from "../src/tools/ask-workspace-question.js";
import type {
  ContentTrakerAuthorizationSnapshot,
  ContentTrakerTokenProvider,
} from "../src/token-provider.js";
import type {
  AuthorizationFlowResult,
  ContentTrakerContext,
  ContentTrakerRequestSecurityContext,
  RequestSecurityDiagnostics,
  TokenStrategyStatus,
} from "../src/types.js";

const stagingAudience = "https://mcp.staging.contenttraker.com";
const productionAudience = "https://mcp.prod.contenttraker.com";

configureStaging();

function upstreamSourceContainsNoRemoteMcpCall(): void {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), "src", "contenttraker-api-client.ts"),
    "utf8",
  );
  assert.equal(source.includes("\"/mcp\""), false);
  assert.match(
    source,
    /\/projects\/\$\{encodeURIComponent\(projectId!\)\}\/questions/,
  );
}

async function routeBodySelectorsAndCorrelationsArePreserved(): Promise<void> {
  const provider = new FakeTokenProvider();
  const server = new QuestionServerApiClient();
  const client = new EnvironmentContentTrakerApiClient(provider, server);
  const context = selectedContext("workspace-a", "project-a");
  const requestContext = security("request-new");

  const created = await client.askWorkspaceQuestion({
    question: "What does the workspace say?",
    threadName: "Workspace contract",
    questionSource: "Copilot",
    scopeMode: "Both",
    callerApp: "Codex",
    referenceScopes: [
      { workspaceId: "workspace-reference", projectId: "project-reference" },
    ],
    userApprovalStatement: "Ask this staging workspace question.",
  }, context, requestContext);

  assert.equal(created.status, "answered");
  assert.deepEqual(created.operationPolicy, {
    stateChanging: true,
    idempotencyKeySupported: false,
    automaticRetry: false,
  });
  assert.equal(created.contentKeeperId, "workspace-a");
  assert.equal(created.projectId, "project-a");
  assert.equal(created.httpCorrelationId, "http-question-1");
  assert.equal(created.responseCorrelationId, "response-question-1");
  assert.equal(created.requestCorrelationId, "request-correlation-request-new");
  assert.equal(created.response?.threadId, "thread-1");
  assert.equal(created.response?.answer, "Answer 1");
  assert.equal(created.response?.scopedRetrievalProvisioned, true);
  assert.equal(created.response?.promptTokens, 10);
  assert.deepEqual(created.response?.persistence, { persisted: true, version: 1 });
  assert.equal(provider.effectiveCallerVerified, true);

  const request = server.questionRequests[0];
  assert.equal(
    request?.path,
    "/workspaces/workspace-a/projects/project-a/questions",
  );
  assert.equal(request?.path.includes("/mcp"), false);
  assert.deepEqual(request?.body, {
    question: "What does the workspace say?",
    threadId: undefined,
    sessionId: undefined,
    threadName: "Workspace contract",
    questionSource: "Copilot",
    scopeMode: "Both",
    callerApp: "Codex",
    referenceScopes: [
      { workspaceId: "workspace-reference", projectId: "project-reference" },
    ],
  });
  assert.equal(
    Object.hasOwn(request?.body ?? {}, "userApprovalStatement"),
    false,
  );
  assert.equal(
    Object.hasOwn(request?.body ?? {}, "productionConfirmation"),
    false,
  );

  const existing = await client.askWorkspaceQuestion({
    question: "Continue the explicit thread.",
    threadId: "thread-existing",
    userApprovalStatement: "Continue this staging thread.",
  }, context, security("request-existing"));
  assert.equal(existing.status, "answered");
  assert.equal(existing.response?.threadId, "thread-existing");
  assert.equal(existing.response?.isNewThread, false);
  assert.equal(server.questionRequests[1]?.body.threadId, "thread-existing");

  const firstSession = await client.askWorkspaceQuestion({
    question: "Start a stable session.",
    sessionId: "session-stable",
    userApprovalStatement: "Start this staging session.",
  }, context, security("request-session-one"));
  const secondSession = await client.askWorkspaceQuestion({
    question: "Continue a stable session.",
    sessionId: "session-stable",
    userApprovalStatement: "Continue this staging session.",
  }, context, security("request-session-two"));
  assert.equal(firstSession.response?.threadId, secondSession.response?.threadId);
  assert.equal(firstSession.response?.isNewThread, true);
  assert.equal(secondSession.response?.isNewThread, false);
  assert.equal(server.questionRequests[2]?.body.sessionId, "session-stable");
  assert.equal(server.questionRequests[3]?.body.sessionId, "session-stable");
}

async function contextResolutionFailsClosed(): Promise<void> {
  process.env.CONTENTTRAKER_CODEX_REGISTRY = path.join(
    os.tmpdir(),
    `contenttraker-question-missing-${process.pid}.json`,
  );

  const missingProvider = new FakeTokenProvider();
  const missingServer = new QuestionServerApiClient();
  const missingClient = new EnvironmentContentTrakerApiClient(
    missingProvider,
    missingServer,
  );
  const missingContext = await askWorkspaceQuestion({
    question: "No destination.",
    userApprovalStatement: "Ask only if the destination resolves.",
  }, missingClient, security("missing-context"));
  assert.equal(missingContext.status, "blocked");
  assert.match(
    missingContext.diagnostics.join(" "),
    /repository_root_required_for_durable_context/,
  );
  assert.equal(missingServer.questionRequests.length, 0);

  const missingProject = await askWorkspaceQuestion({
    contentKeeperId: "workspace-a",
    question: "No project.",
    userApprovalStatement: "Ask only if a project resolves.",
  }, missingClient, security("missing-project"));
  assert.equal(missingProject.status, "blocked");
  assert.match(
    missingProject.diagnostics.join(" "),
    /project_context_required/,
  );
  assert.equal(missingServer.questionRequests.length, 0);

  const ambiguousWorkspaceServer = new QuestionServerApiClient();
  ambiguousWorkspaceServer.workspaces = [
    { id: "workspace-duplicate", name: "Duplicate One" },
    { id: "workspace-duplicate", name: "Duplicate Two" },
  ];
  const ambiguousWorkspace = await askWorkspaceQuestion({
    contentKeeperId: "workspace-duplicate",
    projectId: "project-a",
    question: "Ambiguous workspace.",
    userApprovalStatement: "Ask only if the workspace is unique.",
  }, new EnvironmentContentTrakerApiClient(
    new FakeTokenProvider(),
    ambiguousWorkspaceServer,
  ), security("ambiguous-workspace"));
  assert.equal(ambiguousWorkspace.status, "blocked");
  assert.match(
    ambiguousWorkspace.diagnostics.join(" "),
    /context_workspace_ambiguous/,
  );
  assert.equal(ambiguousWorkspaceServer.questionRequests.length, 0);

  const ambiguousProjectServer = new QuestionServerApiClient();
  ambiguousProjectServer.projects = [
    { id: "project-duplicate", name: "Duplicate One" },
    { id: "project-duplicate", name: "Duplicate Two" },
  ];
  const ambiguousProject = await askWorkspaceQuestion({
    contentKeeperId: "workspace-a",
    projectId: "project-duplicate",
    question: "Ambiguous project.",
    userApprovalStatement: "Ask only if the project is unique.",
  }, new EnvironmentContentTrakerApiClient(
    new FakeTokenProvider(),
    ambiguousProjectServer,
  ), security("ambiguous-project"));
  assert.equal(ambiguousProject.status, "blocked");
  assert.match(
    ambiguousProject.diagnostics.join(" "),
    /context_project_ambiguous/,
  );
  assert.equal(ambiguousProjectServer.questionRequests.length, 0);
}

async function productionConfirmationIsExactAndStagingRejectsIt(): Promise<void> {
  const stagingServer = new QuestionServerApiClient();
  const stagingClient = new EnvironmentContentTrakerApiClient(
    new FakeTokenProvider(),
    stagingServer,
  );
  const stagingResult = await stagingClient.askWorkspaceQuestion({
    question: "Wrong environment confirmation.",
    userApprovalStatement: "Ask this staging question.",
    productionConfirmation: "CONFIRM_PRODUCTION_CONTENTTRAKER_WRITE",
  }, selectedContext("workspace-a", "project-a"), security("staging-confirmation"));
  assert.equal(stagingResult.status, "blocked");
  assert.match(
    stagingResult.diagnostics.join(" "),
    /productionConfirmation is only valid/,
  );
  assert.equal(stagingServer.questionRequests.length, 0);

  configureProduction();
  try {
    const provider = new FakeTokenProvider();
    const server = new QuestionServerApiClient();
    const client = new EnvironmentContentTrakerApiClient(provider, server);
    const context = selectedContext(
      "workspace-production",
      "project-production",
      "production",
    );
    const missing = await client.askWorkspaceQuestion({
      question: "Production without confirmation.",
      userApprovalStatement: "Ask this production question.",
    }, context, security("production-missing", "production"));
    assert.equal(missing.status, "blocked");
    assert.match(
      missing.diagnostics.join(" "),
      /CONFIRM_PRODUCTION_CONTENTTRAKER_WRITE/,
    );
    assert.equal(server.questionRequests.length, 0);

    const confirmed = await client.askWorkspaceQuestion({
      question: "Production with confirmation.",
      userApprovalStatement: "Ask this production question.",
      productionConfirmation: "CONFIRM_PRODUCTION_CONTENTTRAKER_WRITE",
    }, context, security("production-confirmed", "production"));
    assert.equal(confirmed.status, "answered");
    assert.equal(server.questionRequests.length, 1);
  } finally {
    configureStaging();
  }
}

async function problemDetailsAreCategorizedAndSafe(): Promise<void> {
  const cases: Array<{
    mode: QuestionServerApiClient["mode"];
    category: string;
    pattern: RegExp;
  }> = [
    { mode: "validation", category: "validation", pattern: /question is required/ },
    { mode: "authorization", category: "authorization", pattern: /not authorized/ },
    { mode: "entitlement", category: "entitlement", pattern: /AI-backed workspace questions are blocked/ },
    { mode: "persistence", category: "persistence", pattern: /could not be saved/ },
  ];

  for (const testCase of cases) {
    const server = new QuestionServerApiClient();
    server.mode = testCase.mode;
    const result = await new EnvironmentContentTrakerApiClient(
      new FakeTokenProvider(),
      server,
    ).askWorkspaceQuestion({
      question: "Exercise safe failure mapping.",
      userApprovalStatement: "Ask this staging question.",
    }, selectedContext("workspace-a", "project-a"), security(`failure-${testCase.mode}`));

    assert.equal(result.status, "failed");
    assert.equal(result.error?.category, testCase.category);
    assert.match(result.diagnostics.join(" "), testCase.pattern);
    assert.equal(JSON.stringify(result).includes("raw-secret"), false);
    assert.equal(JSON.stringify(result).includes("[REDACTED]"), testCase.mode === "authorization");
  }
}

async function nonIdempotentUnauthorizedPostIsNotRetried(): Promise<void> {
  const provider = new FakeTokenProvider();
  const server = new QuestionServerApiClient();
  server.mode = "unauthorized";
  const result = await new EnvironmentContentTrakerApiClient(
    provider,
    server,
  ).askWorkspaceQuestion({
    question: "Do not retry this POST.",
    userApprovalStatement: "Ask once only.",
  }, selectedContext("workspace-a", "project-a"), security("unauthorized"));

  assert.equal(result.status, "failed");
  assert.equal(result.error?.category, "authentication");
  assert.equal(server.questionRequests.length, 1);
  assert.equal(provider.authorizationOptions.length, 1);
  assert.equal(provider.authorizationOptions[0]?.forceRefresh, undefined);
}

class FakeTokenProvider implements ContentTrakerTokenProvider {
  readonly authorizationOptions: Array<{
    forceRefresh?: boolean;
    rejectedCredentialVersion?: string;
  }> = [];
  effectiveCallerVerified = false;
  private subjectId?: string;
  private contentTrakerCorrelationId?: string;

  getStatus(): TokenStrategyStatus {
    return {
      mode: "delegated-user-pkce",
      configured: true,
      accessTokenPresent: true,
      source: "workspace-question-test",
      credentialStore: "custom",
      tokenExpiryStatus: "valid",
      subjectId: this.subjectId,
    };
  }

  async getAuthorizationHeader(
    context: ContentTrakerRequestSecurityContext,
    options: {
      forceRefresh?: boolean;
      rejectedCredentialVersion?: string;
    } = {},
  ): Promise<ContentTrakerAuthorizationSnapshot> {
    this.authorizationOptions.push(options);
    return {
      authorizationHeader: options.forceRefresh
        ? "Bearer refreshed-workspace-question-test"
        : "Bearer workspace-question-test",
      environment: context.environment,
      authorityIssuer: "workspace-question-test",
      tokenIssuer: "workspace-question-test",
      subjectId: "user-question",
      audience: context.tokenAudience,
      expiresAt: Math.floor(Date.now() / 1000) + 3_600,
      credentialHandle: "workspace-question-test",
      credentialVersion: options.forceRefresh ? "v2" : "v1",
      authenticationMode: "delegated-user-pkce",
    };
  }

  async beginAuthorization(): Promise<AuthorizationFlowResult> {
    return { status: "authorized", diagnostics: [] };
  }

  async getAuthorizationStatus(): Promise<AuthorizationFlowResult> {
    return { status: "authorized", diagnostics: [] };
  }

  async cancelAuthorization(): Promise<AuthorizationFlowResult> {
    return { status: "authorized", diagnostics: [] };
  }

  getSecurityDiagnostics(
    context: ContentTrakerRequestSecurityContext,
  ): RequestSecurityDiagnostics {
    return {
      environment: context.environment,
      authenticationMode: "delegated-user-pkce",
      connectionId: context.connectionId,
      sessionId: context.sessionId,
      requestId: context.requestId,
      authenticatedSubjectId: this.subjectId,
      authenticatedTokenIssuer: this.subjectId
        ? "workspace-question-test"
        : undefined,
      durableAccountKey: this.subjectId
        ? `workspace-question-test|${this.subjectId}`
        : undefined,
      credentialHandle: "workspace-question-test",
      credentialStore: "custom",
      tokenAudience: context.tokenAudience,
      tokenExpiryStatus: "valid",
      correlationId: context.correlationId,
      contentTrakerCorrelationId: this.contentTrakerCorrelationId,
      effectiveCallerVerified: this.effectiveCallerVerified,
    };
  }

  recordEffectiveCaller(
    _context: ContentTrakerRequestSecurityContext,
    subjectId: string | undefined,
    contentTrakerCorrelationId?: string,
  ): void {
    this.subjectId = subjectId;
    this.contentTrakerCorrelationId = contentTrakerCorrelationId;
    this.effectiveCallerVerified = Boolean(subjectId);
  }

  async invalidate(): Promise<void> {
    this.subjectId = undefined;
    this.contentTrakerCorrelationId = undefined;
    this.effectiveCallerVerified = false;
  }
}

class QuestionServerApiClient implements ContentTrakerServerApiClient {
  mode:
    | "success"
    | "validation"
    | "authorization"
    | "entitlement"
    | "persistence"
    | "unauthorized" = "success";
  workspaces: Array<Record<string, unknown>> = [
    { id: "workspace-a", name: "Workspace A" },
    { id: "workspace-production", name: "Workspace Production" },
  ];
  projects: Array<Record<string, unknown>> = [
    { id: "project-a", name: "Project A" },
    { id: "project-production", name: "Project Production" },
  ];
  readonly questionRequests: Array<{
    path: string;
    authorization: string;
    correlationId: string;
    body: Record<string, unknown>;
  }> = [];
  private readonly sessionThreads = new Map<string, string>();

  async getJson(
    _baseUrl: string,
    pathValue: string,
    _authorization: string,
    correlationId: string,
  ): Promise<JsonResponse> {
    if (pathValue === "/me") {
      return response(200, {
        appUserId: "user-question",
        email: "question@example.org",
      }, `http-me-${correlationId}`);
    }
    if (pathValue === "/workspaces") {
      return response(200, { workspaces: this.workspaces }, `http-workspaces-${correlationId}`);
    }
    if (pathValue.endsWith("/projects")) {
      return response(200, { projects: this.projects }, `http-projects-${correlationId}`);
    }
    return response(404, problem(404, "Not Found", "The route was not found."), correlationId);
  }

  async postJson(
    _baseUrl: string,
    pathValue: string,
    authorization: string,
    body: unknown,
    correlationId: string,
  ): Promise<JsonResponse> {
    const parsed = isRecord(body) ? body : {};
    this.questionRequests.push({
      path: pathValue,
      authorization,
      correlationId,
      body: parsed,
    });
    const sequence = this.questionRequests.length;

    if (this.mode === "unauthorized") {
      return response(401, problem(401, "Unauthorized", "Delegated authentication is required."), `http-question-${sequence}`);
    }
    if (this.mode === "validation") {
      return response(400, problem(400, "Invalid Request", "question is required."), `http-question-${sequence}`);
    }
    if (this.mode === "authorization") {
      return response(
        403,
        problem(
          403,
          "Forbidden",
          "The effective user is not authorized. Authorization: Bearer raw-secret",
        ),
        `http-question-${sequence}`,
      );
    }
    if (this.mode === "entitlement") {
      return response(
        409,
        problem(
          409,
          "Question Failed",
          "AI-backed workspace questions are blocked for this account. No entitlement is active.",
        ),
        `http-question-${sequence}`,
      );
    }
    if (this.mode === "persistence") {
      return response(
        409,
        problem(
          409,
          "Question Failed",
          "The knowledge-base thread was processed but could not be saved.",
        ),
        `http-question-${sequence}`,
      );
    }

    const explicitThreadId = stringValue(parsed.threadId);
    const sessionId = stringValue(parsed.sessionId);
    const existingSessionThread = sessionId
      ? this.sessionThreads.get(sessionId)
      : undefined;
    const threadId = explicitThreadId
      ?? existingSessionThread
      ?? `thread-${sequence}`;
    const isNewThread = !explicitThreadId && !existingSessionThread;
    if (sessionId && !existingSessionThread) {
      this.sessionThreads.set(sessionId, threadId);
    }

    return response(200, {
      success: true,
      correlationId: `response-question-${sequence}`,
      workspaceId: pathValue.split("/")[2],
      workspaceName: "Workspace A",
      projectId: pathValue.split("/")[4],
      projectName: "Project A",
      threadId,
      threadName: stringValue(parsed.threadName) ?? "Workspace question",
      foundryThreadId: `foundry-${threadId}`,
      question: parsed.question,
      questionSource: stringValue(parsed.questionSource) ?? "Human",
      callerApp: parsed.callerApp,
      sessionId,
      queryScopeMode: stringValue(parsed.scopeMode) ?? "Both",
      queryLane: "KBA",
      scopedRetrievalProvisioned: true,
      scopedRetrievalUnavailable: false,
      answer: `Answer ${sequence}`,
      homeAnswer: `Home answer ${sequence}`,
      answerSources: [{
        workspaceId: pathValue.split("/")[2],
        projectId: pathValue.split("/")[4],
        threadId,
        success: true,
        answer: `Answer ${sequence}`,
      }],
      answerRole: "Assistant",
      turnCount: sequence * 2,
      usedDigitalAssets: true,
      promptTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      isNewThread,
      referenceAnswers: parsed.referenceScopes ?? [],
      persistence: { persisted: true, version: sequence },
      message: isNewThread
        ? "Workspace question answered in a new thread."
        : "Workspace question answered in an existing thread.",
    }, `http-question-${sequence}`);
  }

  async putJson(
    _baseUrl: string,
    _path: string,
    _authorization: string,
    _body: unknown,
    correlationId: string,
  ): Promise<JsonResponse> {
    return response(405, problem(405, "Method Not Allowed", "PUT is not supported."), correlationId);
  }
}

function configureStaging(): void {
  process.env.CONTENTTRAKER_ENVIRONMENT = "staging";
  process.env.CONTENTTRAKER_STAGING_API_BASE_URL = stagingAudience;
  process.env.CONTENTTRAKER_STAGING_OAUTH_RESOURCE = stagingAudience;
  delete process.env.CONTENTTRAKER_PRODUCTION_API_BASE_URL;
  delete process.env.CONTENTTRAKER_PRODUCTION_OAUTH_RESOURCE;
  delete process.env.CONTENTTRAKER_ENABLE_PRODUCTION_WRITES;
  delete process.env.CONTENTTRAKER_REQUIRED_USER_EMAIL;
  delete process.env.CONTENTTRAKER_REQUIRE_IDENTITY_POLICY;
}

function configureProduction(): void {
  process.env.CONTENTTRAKER_ENVIRONMENT = "production";
  process.env.CONTENTTRAKER_PRODUCTION_API_BASE_URL = productionAudience;
  process.env.CONTENTTRAKER_PRODUCTION_OAUTH_RESOURCE = productionAudience;
  process.env.CONTENTTRAKER_ENABLE_PRODUCTION_WRITES = "true";
}

function security(
  requestId: string,
  environment: "staging" | "production" = "staging",
): ContentTrakerRequestSecurityContext {
  return {
    environment,
    connectionId: `connection-${requestId}`,
    sessionId: `session-${requestId}`,
    requestId,
    correlationId: `request-correlation-${requestId}`,
    tokenAudience: environment === "production"
      ? productionAudience
      : stagingAudience,
  };
}

function selectedContext(
  workspaceId: string,
  projectId: string,
  environment: "staging" | "production" = "staging",
): ContentTrakerContext {
  return {
    environment,
    contentKeeperId: workspaceId,
    workspaceId,
    projectId,
    source: "explicit-workspace",
  };
}

function response(
  statusCode: number,
  json: unknown,
  correlationId: string,
): JsonResponse {
  return {
    ok: statusCode >= 200 && statusCode < 300,
    statusCode,
    json,
    correlationId,
  };
}

function problem(
  status: number,
  title: string,
  detail: string,
): Record<string, unknown> {
  return {
    type: `https://contenttraker.test/problems/${status}`,
    title,
    status,
    detail,
    instance: "/workspace-question-test",
    traceId: `trace-${status}`,
    errorCode: `question-${status}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

upstreamSourceContainsNoRemoteMcpCall();
await routeBodySelectorsAndCorrelationsArePreserved();
await contextResolutionFailsClosed();
await productionConfirmationIsExactAndStagingRejectsIt();
await problemDetailsAreCategorizedAndSafe();
await nonIdempotentUnauthorizedPostIsNotRetried();

console.log("ContentTraker workspace-question contract tests passed.");
