# Changelog

## Unreleased

- Adds an independent host runtime capability model and unauthenticated `inspect_runtime_capabilities` tool for Windows, macOS, Linux, WSL, headless, container, and CI profile selection.
- Reports current, blocked, future, and externally dependent authentication, interaction, credential-persistence, and cross-task restoration capabilities without exposing credentials.
- Adds platform browser, WSL-native browser, and manual authorization URL providers selected by `CONTENTTRAKER_BROWSER_MODE`.
- Adds begin, bounded status, and cancel tools for connection-scoped authorization while keeping OAuth codes, verifiers, access tokens, and refresh credentials internal.
- Disables `xdg-open` and Windows browser interoperability inside WSL; WSL either launches a known Linux browser directly or returns a manual URL while retaining the loopback listener.
- Adds capability-probed Windows Credential Manager, macOS Keychain, Linux Secret Service, and explicitly selected ephemeral-memory credential providers.
- Replaces connection/session-derived keyring handles with binding-validated durable profiles and restores rotating refresh credentials in new tasks.
- Serializes refresh rotation across adapter processes with metadata-free temporary locks and adds confirmed local credential deletion.
- Negotiates and validates live protected-resource and authorization-server metadata before authorization or refresh, and rejects incomplete scope grants.
- Adds `inspect_contenttraker_oauth_metadata` plus a non-secret staging contract probe for `codex-mcp`, PKCE, requested scopes, and dynamic loopback redirects.
- Defaults authentication selection by host capability, removes raw environment bearer-token authentication, and leaves container/CI workload OAuth fail closed until supported by both server metadata and a host provider.
- Adds capability-gated OAuth device authorization with bounded RFC 8628 polling and the same secure credential-restoration path as PKCE.
- Adds Windows/macOS/Linux Node 18 and Linux-container release gates, native desktop keyring checks, a portable artifact verifier, and an evidence-based host verification matrix.

## 0.1.2 - 2026-07-21

- Records Richard Reukema (`richard@phoenixbussolutions.com`) as the repository creator and release-publishing identity.
- Clarifies that consuming-host ContentTraker identities remain external runtime policy inputs and are never plugin defaults.
- Classifies bundled libraries as build-only dependencies; marketplace installations run the reviewed self-contained adapter bundle and do not install the SDK's unused HTTP/static-server dependency tree.
- Adds CI enforcement and security documentation for the build-time versus shipped-runtime dependency boundary.

## 0.1.1 - 2026-07-21

- Makes the WSL runtime self-contained by using Linux Secret Service through `secret-tool`; no `npm` or native Node keyring package is required after marketplace installation.
- Retains fail-closed behavior when the host has no Secret Service provider or browser/loopback path.

## 0.1.0 - 2026-07-21

- Adds the public `contenttraker` Codex marketplace package.
- Bundles the local MCP adapter and exposes authenticated-user, workspace, context, digital asset, and lifecycle tools.
- Enforces an optional host identity policy through `CONTENTTRAKER_REQUIRED_USER_EMAIL` and repeats `GET /me` verification before API operations.
- Uses ContentTraker OAuth authorization code with PKCE and OS-keyring refresh-token storage; no connector-session or plaintext credential fallback exists.
- Documents installation, upgrade, removal, security, and WSL prerequisites.

Known limitation: a host still needs a browser path that can return to its loopback listener and a supported secure credential provider. The ContentTraker OAuth service does not currently advertise device authorization, so hosts unable to satisfy the loopback flow fail closed.
