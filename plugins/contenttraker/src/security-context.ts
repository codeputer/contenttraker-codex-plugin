import { randomUUID } from "node:crypto";

import { resolveAdapterEnvironment } from "./environment-profile.js";
import type { ContentTrakerRequestSecurityContext } from "./types.js";

export interface McpRequestIdentity {
  sessionId?: string;
  requestId: string | number;
}

export class ContentTrakerSecurityContextFactory {
  readonly connectionId: string;

  constructor(connectionId = randomUUID()) {
    this.connectionId = connectionId;
  }

  create(request: McpRequestIdentity): ContentTrakerRequestSecurityContext {
    const profile = resolveAdapterEnvironment();
    if (!profile.status.name || !profile.oauthResource) {
      throw new Error("ContentTraker security context cannot be created for an invalid environment profile.");
    }

    return Object.freeze({
      environment: profile.status.name,
      connectionId: this.connectionId,
      sessionId: request.sessionId ?? this.connectionId,
      requestId: String(request.requestId),
      correlationId: randomUUID().replaceAll("-", ""),
      tokenAudience: profile.oauthResource,
    });
  }
}
