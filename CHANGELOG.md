# Changelog

## 0.1.0 - 2026-07-21

- Adds the public `contenttraker` Codex marketplace package.
- Bundles the local MCP adapter and exposes authenticated-user, workspace, context, digital asset, and lifecycle tools.
- Enforces an optional host identity policy through `CONTENTTRAKER_REQUIRED_USER_EMAIL` and repeats `GET /me` verification before API operations.
- Uses ContentTraker OAuth authorization code with PKCE and OS-keyring refresh-token storage; no connector-session or plaintext credential fallback exists.
- Documents installation, upgrade, removal, security, and WSL prerequisites.

Known limitation: headless WSL hosts without both a usable browser/loopback path and Linux Secret Service provider cannot complete delegated authentication. The ContentTraker OAuth service does not currently advertise device authorization, so those hosts fail closed.
