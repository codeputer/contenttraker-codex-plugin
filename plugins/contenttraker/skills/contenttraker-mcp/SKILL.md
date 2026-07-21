---
name: contenttraker-mcp
description: Use the local ContentTraker adapter to verify identity, resolve workspace context, and work with digital assets.
---

# ContentTraker Codex Adapter

Use this plugin's local MCP tools. Do not reuse a ChatGPT connector session, request bearer tokens, inspect browser cookies, or require a direct remote MCP registration.

Call `inspect_runtime_capabilities` before authentication troubleshooting or host-specific setup. ContentTraker target environment and host runtime profile are independent; this read-only tool reports the selected profile and redacted host capability diagnostics without authenticating or calling ContentTraker.

Authentication defaults to capability-selected `auto`: delegated OAuth for non-container user hosts and workload OAuth for container or CI hosts. Workload mode remains blocked until both live server metadata and an implemented host provider support it. Never request or configure a raw access token to bypass that boundary.

Call `inspect_contenttraker_oauth_metadata` when diagnosing authorization-server, scope, PKCE, device-flow, workload-flow, or protected-resource readiness. Do not infer a device or workload endpoint. Treat it as available only when this live metadata tool reports it.

If delegated authentication is needed, call `begin_contenttraker_authorization`. When it returns `pending`, present its authorization URL to the user without rewriting it, then call `get_contenttraker_authorization_status` with a bounded `waitSeconds` value. Do not ask the user for an authorization code, token, verifier, cookie, or refresh credential. Use `cancel_contenttraker_authorization` only to close a pending local callback listener. After `authorized`, call `get_current_user`; authorization status alone does not prove the effective ContentTraker identity.

The adapter restores a persistent `CONTENTTRAKER_CREDENTIAL_PROFILE` automatically in a new task. Treat a profile/subject mismatch as an identity boundary and stop; do not switch profiles or delete credentials without user direction. `forget_contenttraker_credential` requires the literal confirmation `FORGET_CONTENTTRAKER_CREDENTIAL`, deletes only the selected local profile, and does not revoke server authorization.

Before any write:

1. Call `get_current_user` and stop if it fails or the configured host identity does not match.
2. Call `list_workspaces` and confirm the intended authorized workspace.
3. Resolve the workspace context. Project is optional provenance, not identity.
4. Obtain explicit user approval for the exact write.

Create assets as drafts unless the user explicitly authorizes another supported lifecycle state. Use a stable idempotency key for create and lifecycle writes.

Staging is the default environment. The browser login page is not the API endpoint. Interactive authentication uses ContentTraker authorization code with PKCE and the OS keyring inside the host boundary. In WSL, the adapter launches only a known Linux browser executable or returns a manual URL; it never uses `xdg-open` or Windows browser interoperability. If the browser/loopback path or OS keyring is unavailable, report that exact layer and stop; never use plaintext credential storage or a copied connector credential.
