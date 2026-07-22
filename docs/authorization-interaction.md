# Authorization interaction

The plugin keeps one ContentTraker OAuth contract while selecting an interaction provider from actual host and server capabilities. `CONTENTTRAKER_BROWSER_MODE` accepts `auto`, `system`, `manual`, or `wsl-native`. `CONTENTTRAKER_DELEGATED_FLOW` accepts `auto`, `authorization-code`, or `device-code`. Both default to `auto`.

Before binding a loopback listener or launching a browser, the plugin validates the live protected-resource and authorization-server metadata. It uses the advertised authorization and token endpoints rather than constructing endpoint paths. A metadata mismatch stops at that layer.

| Host | Automatic selection |
| --- | --- |
| Windows desktop | `system-browser` through `rundll32.exe` |
| macOS desktop | `system-browser` through `open` |
| Linux desktop | `system-browser` through `xdg-open` when a display is available |
| WSL with WSLg and a known Linux browser | `wsl-native`, launching that browser executable directly |
| WSL or another host without a supported launcher | `manual-url` |

When interaction would otherwise be `manual-url`, delegated-flow `auto` selects `device-code` only if live metadata advertises both the device endpoint and device-code grant. Browser-capable hosts retain authorization code + PKCE. Explicit `device-code` fails at the metadata layer when server support is absent.

Inside WSL, `system` is invalid. The plugin never invokes `xdg-open` there because it cannot prove that the handler remains inside Linux, and it never falls back to Windows browser interoperability. Explicit `wsl-native` mode requires WSL, a display, and a supported Linux browser executable.

## Manual flow

1. Call `begin_contenttraker_login`. A repeated call reuses the pending flow rather than creating another listener.
2. Open the returned `authorizationUrl` before `expiresAt`. The returned `redirectUri` identifies the loopback listener that must receive the callback.
3. Call `poll_contenttraker_login`, optionally with `waitSeconds` from 0 through 15.
4. When the status is `authorized`, call `get_current_user` to verify the effective identity before listing or selecting workspaces.

The status may be `idle`, `pending`, `authorized`, `failed`, `expired`, `cancelled`, or `blocked`. `get_contenttraker_auth_status` is the non-waiting status tool. Terminal diagnostics identify the failed layer without returning the raw OAuth error. `cancel_contenttraker_authorization` closes a pending callback listener but does not revoke an already-issued credential. The v0.1 begin/status tool names remain compatibility aliases.

The authorization URL necessarily contains one-time OAuth request parameters. The plugin never exposes the PKCE verifier, authorization code, access token, or refresh credential through MCP tools, logs, diagnostics, or files. Refresh credentials are written only through the configured secure credential provider.

## Device flow

1. Call `begin_contenttraker_login`.
2. Open `authorizationUrl` or `verificationUri` and enter the returned `userCode` before `expiresAt`. A complete verification URL may already contain the code.
3. Poll `poll_contenttraker_login` until it returns `authorized` or a terminal status. The adapter follows server polling intervals and RFC 8628 pending, slow-down, denial, expiry, cancellation, and timeout behavior.
4. Call `get_current_user` before workspace operations.

The opaque device code is retained only inside the adapter and is never returned. A browser launch is optional: if it fails, the tool returns the verification URI and user code while polling continues. The WSL process performs the token exchange itself. On success, token scope/resource validation and secure refresh-credential storage are identical to authorization code + PKCE.

## Server dependencies

Authorization code interaction requires the ContentTraker authorization server to permit public client `codex-mcp`, the requested scopes, PKCE `S256`, and dynamic loopback redirects in the form `http://127.0.0.1:<port>/oauth/callback`.

For fully headless WSL, the token broker must implement RFC 8628 and publish a credential-free HTTPS `device_authorization_endpoint` plus `urn:ietf:params:oauth:grant-type:device_code` in `grant_types_supported`. The device endpoint must issue bounded `device_code`, `user_code`, `verification_uri`, expiry, and polling interval values. The token endpoint must implement `authorization_pending`, `slow_down`, `access_denied`, and `expired_token`, and return the same audience/resource, scopes, access token, and rotating refresh credential used by delegated PKCE. Until metadata advertises that contract, the plugin reports the server-side prerequisite and does not invent an out-of-band code flow.
