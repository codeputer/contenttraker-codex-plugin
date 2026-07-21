# Authorization interaction

The plugin keeps one ContentTraker OAuth contract while selecting an interaction provider from actual host capabilities. `CONTENTTRAKER_BROWSER_MODE` accepts `auto`, `system`, `manual`, or `wsl-native` and defaults to `auto`.

Before binding a loopback listener or launching a browser, the plugin validates the live protected-resource and authorization-server metadata. It uses the advertised authorization and token endpoints rather than constructing endpoint paths. A metadata mismatch stops at that layer.

| Host | Automatic selection |
| --- | --- |
| Windows desktop | `system-browser` through `rundll32.exe` |
| macOS desktop | `system-browser` through `open` |
| Linux desktop | `system-browser` through `xdg-open` when a display is available |
| WSL with WSLg and a known Linux browser | `wsl-native`, launching that browser executable directly |
| WSL or another host without a supported launcher | `manual-url` |

Inside WSL, `system` is invalid. The plugin never invokes `xdg-open` there because it cannot prove that the handler remains inside Linux, and it never falls back to Windows browser interoperability. Explicit `wsl-native` mode requires WSL, a display, and a supported Linux browser executable.

## Manual flow

1. Call `begin_contenttraker_authorization`. A repeated call reuses the pending flow rather than creating another listener.
2. Open the returned `authorizationUrl` before `expiresAt`. The returned `redirectUri` identifies the loopback listener that must receive the callback.
3. Call `get_contenttraker_authorization_status`, optionally with `waitSeconds` from 0 through 15.
4. When the status is `authorized`, call `get_current_user` to verify the effective identity before listing or selecting workspaces.

The status may be `idle`, `pending`, `authorized`, `failed`, `expired`, `cancelled`, or `blocked`. Terminal diagnostics identify the failed layer without returning the raw OAuth error. `cancel_contenttraker_authorization` closes a pending callback listener but does not revoke an already-issued credential.

The authorization URL necessarily contains one-time OAuth request parameters. The plugin never exposes the PKCE verifier, authorization code, access token, or refresh credential through MCP tools, logs, diagnostics, or files. Refresh credentials are written only through the configured secure credential provider.

## Server dependencies

Authorization code interaction requires the ContentTraker authorization server to permit public client `codex-mcp`, the requested scopes, PKCE `S256`, and dynamic loopback redirects in the form `http://127.0.0.1:<port>/oauth/callback`. Device authorization remains unavailable until the server advertises both a device endpoint and device-code grant.
