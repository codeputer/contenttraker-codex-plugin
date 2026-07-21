import {
  connectContentTrakerMcpServer,
  setContentTrakerTokenProviderForInternalTest,
} from "../src/server.js";
import type {
  ContentTrakerAuthorizationSnapshot,
  ContentTrakerTokenProvider,
} from "../src/token-provider.js";
import type {
  AuthorizationFlowResult,
  ContentTrakerRequestSecurityContext,
  RequestSecurityDiagnostics,
  TokenStrategyStatus,
} from "../src/types.js";

class InternalTestTokenProvider implements ContentTrakerTokenProvider {
  private readonly callers = new Map<string, { subjectId?: string; correlationId?: string }>();

  getStatus(): TokenStrategyStatus {
    return {
      mode: "delegated-user-pkce",
      configured: true,
      accessTokenPresent: true,
      source: "injected-internal-test-provider",
      credentialStore: "custom",
      tokenExpiryStatus: "valid",
    };
  }

  async getAuthorizationHeader(
    context: ContentTrakerRequestSecurityContext,
  ): Promise<ContentTrakerAuthorizationSnapshot> {
    return {
      authorizationHeader: "Bearer internal-smoke-test",
      environment: context.environment,
      authorityIssuer: "internal-test-provider",
      tokenIssuer: "internal-test-provider",
      subjectId: this.callers.get(key(context))?.subjectId ?? "user-1",
      audience: context.tokenAudience,
      expiresAt: Math.floor(Date.now() / 1000) + 3_600,
      credentialHandle: "internal-test-provider",
      credentialVersion: "internal-test-provider-v1",
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

  getSecurityDiagnostics(context: ContentTrakerRequestSecurityContext): RequestSecurityDiagnostics {
    const caller = this.callers.get(key(context));
    return {
      environment: context.environment,
      authenticationMode: "delegated-user-pkce",
      connectionId: context.connectionId,
      sessionId: context.sessionId,
      requestId: context.requestId,
      authenticatedSubjectId: caller?.subjectId,
      credentialHandle: "internal-test-provider",
      credentialStore: "custom",
      tokenAudience: context.tokenAudience,
      tokenExpiryStatus: "valid",
      correlationId: context.correlationId,
      contentTrakerCorrelationId: caller?.correlationId,
      effectiveCallerVerified: Boolean(caller?.subjectId),
    };
  }

  recordEffectiveCaller(
    context: ContentTrakerRequestSecurityContext,
    subjectId: string | undefined,
    contentTrakerCorrelationId?: string,
  ): void {
    this.callers.set(key(context), { subjectId, correlationId: contentTrakerCorrelationId });
  }

  async invalidate(): Promise<void> {
    this.callers.clear();
  }
}

function key(context: ContentTrakerRequestSecurityContext): string {
  return `${context.environment}|${context.connectionId}|${context.sessionId}`;
}

setContentTrakerTokenProviderForInternalTest(new InternalTestTokenProvider());
await connectContentTrakerMcpServer();
