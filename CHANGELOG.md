# Changelog

## 0.2.0 - 2026-07-21

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
- Adds explicit `begin_contenttraker_login`, `poll_contenttraker_login`, `get_contenttraker_auth_status`, and `logout_contenttraker` tools while retaining the v0.1 authorization tool names for compatibility.
- Makes business API tools non-interactive: `get_current_user` and later operations return `authentication_required` instead of launching a browser.
- Keeps device polling active when the optional browser convenience fails, so headless authorization never depends on a launcher.
- Binds persistent credential handles to the configured required user email and moves them to an identity-isolated v2 OS-keyring namespace; v0.1.2 connection/session-derived entries are never loaded or enumerated.
- Enforces workspace precedence and `workspace_conflict` detection for explicit workspace ID/name versus exact repository/project mappings.
- Rechecks `/me` and the exact workspace ID in `/workspaces` before every write; unauthorized or ambiguous destinations fail before the write request.
- Adds Windows/macOS/Linux Node 18 and Linux-container release gates, native desktop keyring checks, a portable artifact verifier, and an evidence-based host verification matrix.

Migration: restart Codex after upgrading, set the intended `CONTENTTRAKER_REQUIRED_USER_EMAIL`, and run the explicit login flow once. v0.1.2 keyring entries are logically invalidated by the v2 namespace and are not inspected or migrated because their handles contain per-session values. Remove old entries through the operating system's credential UI if local retention policy requires physical deletion.

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

Known limitation for 0.1.x: a host needs a browser path that can return to its loopback listener and a supported secure credential provider. The client-side device provider first ships in 0.2.0; fully headless use also requires the ContentTraker authorization server to advertise and implement RFC 8628 device authorization.
