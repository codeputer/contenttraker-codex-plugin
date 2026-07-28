---
name: contenttraker-mcp
description: Use the local ContentTraker adapter to verify identity, resolve workspace context, ask workspace questions, and work with digital assets.
---

# ContentTraker Local Adapter

Use this plugin's local `contenttraker-codex-adapter` MCP tools. Their Codex provenance is `mcp__contenttraker_codex_adapter`; the adapter runs locally over stdio and calls the ContentTraker HTTPS JSON API.

The local stdio surface is authoritative. Its MCP server instructions and structured tool schemas are part of the contract; do not replace it with a remote-first MCP registration when API access or selection is slow.

`ContentTraker.com` is a separate app/connector exposed by Codex. Its tools are currently observed with `mcp__codex_apps__contenttraker_com` provenance, but that namespace is not controlled by this repository. Never use that surface as this plugin, reuse its connector session, or treat its displayed version as the local plugin version. If the local adapter tools are absent and only the app/connector is exposed, report `wrong_contenttraker_interface: local contenttraker-codex-adapter tools are not exposed in this Codex task` and stop. Do not request bearer tokens, inspect browser cookies, or require a direct remote MCP registration.

Use `$contenttraker-select` to live-verify and save a workspace plus optional project for the current Git worktree. Use `$contenttraker-reset` to clear only the current worktree and environment's saved context. Plain-language requests for those actions are also supported. Native `/contenttraker-select` and `/contenttraker-reset` aliases are not part of the current plugin contract.

Call `inspect_runtime_capabilities` before authentication troubleshooting or host-specific setup. ContentTraker target environment and host runtime profile are independent; this read-only tool reports the local adapter identity, plugin version, stdio transport, HTTPS API upstream, selected profile, identity-policy readiness, and redacted host capability diagnostics without authenticating or calling ContentTraker.

Authentication defaults to capability-selected `auto`: delegated OAuth for non-container user hosts and workload OAuth for container or CI hosts. Workload mode remains blocked until both live server metadata and an implemented host provider support it. Never request or configure a raw access token to bypass that boundary.

Call `inspect_contenttraker_oauth_metadata` when diagnosing authorization-server, scope, PKCE, device-flow, workload-flow, or protected-resource readiness. Do not infer a device or workload endpoint. Treat it as available only when this live metadata tool reports it.

If delegated authentication is needed, call `begin_contenttraker_login`. When it returns `pending`, present its authorization URL without rewriting it. For `device-code`, also present `userCode` and `verificationUri`; never request or expose the opaque device code. Then call `poll_contenttraker_login` with a bounded `waitSeconds` value. Do not ask the user for an authorization code, token, verifier, cookie, or refresh credential. Use `cancel_contenttraker_authorization` only to cancel a pending local interaction. After `authorized`, call `get_current_user`; authorization status alone does not prove the effective ContentTraker identity. The durable account key is token issuer plus authenticated subject. Required email is host policy metadata and never replaces that account key. `authentication_required` means the explicit login sequence is required; business tools must not launch a browser.

The packaged adapter requires both a named `CONTENTTRAKER_CREDENTIAL_PROFILE` and `CONTENTTRAKER_REQUIRED_USER_EMAIL`. It restores only that persistent, required-email-bound profile in a new task. If either host value is missing, it blocks before inspecting or restoring any stored credential. Treat a profile/subject mismatch as an identity boundary and stop; do not switch profiles or delete credentials without user direction. `logout_contenttraker` requires the literal confirmation `LOGOUT_CONTENTTRAKER`, deletes only the selected v2 local profile, and does not revoke server authorization.

Before any write:

1. Call `get_current_user` and stop if it fails or the configured host identity does not match.
2. Call `list_workspaces` and confirm the intended authorized ContentKeeper. The current API calls its identifier `workspaceId`.
3. Prefer `context: { source: "content-keeper", contentKeeperId: "..." }` or `context: { source: "worktree", repositoryRoot: "..." }`. Top-level `workspaceId` remains an equal-value compatibility alias. Never supply divergent aliases. Project is optional provenance, not ContentKeeper identity.
4. Obtain explicit user approval for the exact write.

Create assets as drafts unless the user explicitly authorizes another supported lifecycle state. Use a stable idempotency key for create and lifecycle writes.

`ask_workspace_question` is also a write because it invokes AI and persists conversation state. Require one live-authorized project plus the user's approval statement. Reference scopes must contain explicit workspace/project IDs; their authorization, entitlement, retrieval, and policy remain server-owned. The current HTTP question contract has no idempotency key, so advertise the operation as non-idempotent, send it once, and never automatically retry it after an HTTP failure. Production requires `CONFIRM_PRODUCTION_CONTENTTRAKER_WRITE`.

## Durable worktree context

`confirm_contenttraker_context` writes a versioned, local-only `.contenttraker-codex/context.json` envelope after authenticating and live-verifying the exact workspace and optional project. The envelope has separate `staging` and `production` entries, binds each entry to the normalized repository and physical Git worktree, records `confirmationState: "human-confirmed"`, and contains no credentials or remote content.

Resolution precedence is:

1. explicit per-call canonical `contentKeeperId` or compatible workspace selector;
2. live-authorized human-confirmed marker for the current worktree and environment;
3. exact repository-root registry mapping when no reset tombstone suppresses it, followed by live authorization;
4. block with `contentkeeper_selection_required` and obtain the smallest necessary human confirmation.

Environment defaults and project-name-only mappings never authorize business operations. Without an explicit ContentKeeper selector, `repositoryRoot` is required. A missing root, malformed marker, repository/worktree mismatch, stale authorization, alias mismatch, or invalid project blocks fallback with a precise diagnostic. Never silently substitute another ContentKeeper.

Every successful business result returns canonical `contentKeeperId`, and every structured tool advertises an output schema. Treat output-schema or structured-content mismatch as a plugin contract failure.

`reset_contenttraker_context` clears only the selected environment's binding and exact matching registry mapping, then records a worktree/environment reset tombstone. It preserves OAuth and keyring credentials, other worktrees, every separately valid other-environment marker entry, and all ContentTraker assets. If the complete marker is unreadable or untrusted, report that other-environment preservation could not be proven.

Staging is the default environment. The browser login page is not the API endpoint. In WSL, the adapter prefers broker-advertised device authorization for headless interaction and never uses `xdg-open` or Windows browser interoperability. If device authorization is not advertised, or the OS keyring is unavailable or locked, report that exact layer and stop; never use plaintext credential storage or a copied connector credential.
