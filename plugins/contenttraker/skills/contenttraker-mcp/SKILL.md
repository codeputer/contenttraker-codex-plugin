---
name: contenttraker-mcp
description: Use the local ContentTraker adapter to verify identity, resolve workspace context, and work with digital assets.
---

# ContentTraker Codex Adapter

Use this plugin's local MCP tools. Do not reuse a ChatGPT connector session, request bearer tokens, inspect browser cookies, or require a direct remote MCP registration.

Use `$contenttraker-select` to live-verify and save a workspace plus optional project for the current Git worktree. Use `$contenttraker-reset` to clear only the current worktree and environment's saved context. Plain-language requests for those actions are also supported. Native `/contenttraker-select` and `/contenttraker-reset` aliases are not part of the current plugin contract.

Call `inspect_runtime_capabilities` before authentication troubleshooting or host-specific setup. ContentTraker target environment and host runtime profile are independent; this read-only tool reports the selected profile and redacted host capability diagnostics without authenticating or calling ContentTraker.

Authentication defaults to capability-selected `auto`: delegated OAuth for non-container user hosts and workload OAuth for container or CI hosts. Workload mode remains blocked until both live server metadata and an implemented host provider support it. Never request or configure a raw access token to bypass that boundary.

Call `inspect_contenttraker_oauth_metadata` when diagnosing authorization-server, scope, PKCE, device-flow, workload-flow, or protected-resource readiness. Do not infer a device or workload endpoint. Treat it as available only when this live metadata tool reports it.

If delegated authentication is needed, call `begin_contenttraker_login`. When it returns `pending`, present its authorization URL without rewriting it. For `device-code`, also present `userCode` and `verificationUri`; never request or expose the opaque device code. Then call `poll_contenttraker_login` with a bounded `waitSeconds` value. Do not ask the user for an authorization code, token, verifier, cookie, or refresh credential. Use `cancel_contenttraker_authorization` only to cancel a pending local interaction. After `authorized`, call `get_current_user`; authorization status alone does not prove the effective ContentTraker identity. `authentication_required` means the explicit login sequence is required; business tools must not launch a browser.

The adapter restores a persistent, required-email-bound `CONTENTTRAKER_CREDENTIAL_PROFILE` automatically in a new task. Treat a profile/subject mismatch as an identity boundary and stop; do not switch profiles or delete credentials without user direction. `logout_contenttraker` requires the literal confirmation `LOGOUT_CONTENTTRAKER`, deletes only the selected v2 local profile, and does not revoke server authorization.

Before any write:

1. Call `get_current_user` and stop if it fails or the configured host identity does not match.
2. Call `list_workspaces` and confirm the intended authorized workspace.
3. Pass an explicit `workspaceId`, `workspaceKey`, or `workspaceName`, or pass the absolute `repositoryRoot` so the adapter can load and live-verify the human-confirmed worktree marker. Project is optional provenance, not workspace identity.
4. Obtain explicit user approval for the exact write.

Create assets as drafts unless the user explicitly authorizes another supported lifecycle state. Use a stable idempotency key for create and lifecycle writes.

## Durable worktree context

`confirm_contenttraker_context` writes a versioned, local-only `.contenttraker-codex/context.json` envelope after authenticating and live-verifying the exact workspace and optional project. The envelope has separate `staging` and `production` entries, binds each entry to the normalized repository and physical Git worktree, records `confirmationState: "human-confirmed"`, and contains no credentials or remote content.

Resolution precedence is:

1. explicit per-call workspace selector;
2. live-authorized human-confirmed marker for the current worktree and environment;
3. exact environment-scoped registry mapping when no reset tombstone suppresses it;
4. live resolution and the smallest necessary human confirmation.

Without an explicit workspace selector, `repositoryRoot` is required. A missing root, malformed marker, repository/worktree mismatch, stale authorization, or invalid project blocks fallback with a precise diagnostic. Never silently substitute another workspace.

`reset_contenttraker_context` clears only the selected environment's binding and exact matching registry mapping, then records a worktree/environment reset tombstone. It preserves OAuth and keyring credentials, other worktrees, every separately valid other-environment marker entry, and all ContentTraker assets. If the complete marker is unreadable or untrusted, report that other-environment preservation could not be proven.

Staging is the default environment. The browser login page is not the API endpoint. In WSL, the adapter prefers broker-advertised device authorization for headless interaction and never uses `xdg-open` or Windows browser interoperability. If device authorization is not advertised, or the OS keyring is unavailable or locked, report that exact layer and stop; never use plaintext credential storage or a copied connector credential.
