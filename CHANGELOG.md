# Changelog

## Unreleased

- Adds an independent host runtime capability model and unauthenticated `inspect_runtime_capabilities` tool for Windows, macOS, Linux, WSL, headless, container, and CI profile selection.
- Reports current, blocked, future, and externally dependent authentication, interaction, credential-persistence, and cross-task restoration capabilities without exposing credentials.

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

Known limitation: headless WSL hosts without both a usable browser/loopback path and Linux Secret Service provider cannot complete delegated authentication. The ContentTraker OAuth service does not currently advertise device authorization, so those hosts fail closed.
