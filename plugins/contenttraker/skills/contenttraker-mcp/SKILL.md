---
name: contenttraker-mcp
description: Use the local ContentTraker adapter to verify identity, resolve workspace context, and work with digital assets.
---

# ContentTraker Codex Adapter

Use this plugin's local MCP tools. Do not reuse a ChatGPT connector session, request bearer tokens, inspect browser cookies, or require a direct remote MCP registration.

Call `inspect_runtime_capabilities` before authentication troubleshooting or host-specific setup. ContentTraker target environment and host runtime profile are independent; this read-only tool reports the selected profile and redacted host capability diagnostics without authenticating or calling ContentTraker.

Before any write:

1. Call `get_current_user` and stop if it fails or the configured host identity does not match.
2. Call `list_workspaces` and confirm the intended authorized workspace.
3. Resolve the workspace context. Project is optional provenance, not identity.
4. Obtain explicit user approval for the exact write.

Create assets as drafts unless the user explicitly authorizes another supported lifecycle state. Use a stable idempotency key for create and lifecycle writes.

Staging is the default environment. The browser login page is not the API endpoint. Interactive authentication uses ContentTraker authorization code with PKCE and the OS keyring inside the host boundary. If the browser/loopback path or OS keyring is unavailable, report that exact layer and stop; never use plaintext credential storage or a copied connector credential.
