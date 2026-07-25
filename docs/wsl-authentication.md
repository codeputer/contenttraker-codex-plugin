# WSL authentication

## Supported contract

Interactive sessions use public client ID `codex-mcp` with OAuth device authorization when the broker advertises RFC 8628, otherwise authorization code with PKCE (`S256`). The adapter performs the token exchange inside WSL, validates token routing claims, and calls `GET /me` before any business operation. `get_current_user` never launches a browser; login starts only through the explicit login tool.

The access token stays in the adapter process. The rotating refresh credential is stored only in the operating-system keyring. The workspace registry contains identifiers and names only; it never contains credentials.

The plugin does not:

- reuse a ChatGPT or desktop connector credential;
- read browser cookies;
- accept a delegated bearer token through tool input;
- fall back to an environment token in interactive mode; or
- store a refresh credential in a plaintext file.

## WSL prerequisites

The WSL user session needs all of the following:

1. Node.js 18 or newer.
2. Broker-advertised OAuth device authorization, or a supported Linux browser/callback path for PKCE.
3. A functioning Secret Service implementation available on the user's D-Bus session, with the `secret-tool` command available.
4. Network access to the documented OAuth issuer and MCP/API origin.

Merely having a D-Bus session is not enough; an actual Secret Service provider must be present and unlocked.

Run `inspect_runtime_capabilities` before starting interactive authorization. Inside WSL, `CONTENTTRAKER_BROWSER_MODE=auto` launches a known Linux browser directly when a display and executable are available; otherwise it selects `manual-url`. The adapter never invokes `xdg-open` in WSL, and `CONTENTTRAKER_BROWSER_MODE=system` is rejected there so Windows browser interoperability cannot be selected accidentally.

`CONTENTTRAKER_DELEGATED_FLOW=auto` uses device authorization instead of the manual loopback flow when the live authorization-server metadata advertises it. The tool then returns a `verificationUri` and `userCode`; it never returns the opaque device code.

For delegated interaction:

1. Call `begin_contenttraker_login`.
2. For device code, open `verificationUri` on any device and enter `userCode`; for PKCE, open `authorizationUrl` where the callback can reach the WSL listener.
3. Call `poll_contenttraker_login`, optionally with `waitSeconds` from 0 through 15, until it reports `authorized` or a terminal failure.
4. Call `get_current_user` and verify the effective ContentTraker identity.

The verification/user code is safe to display, but the opaque device code, PKCE verifier, authorization code, access token, and refresh credential are never returned by the tool. A failed optional browser launch leaves device polling active. `cancel_contenttraker_authorization` closes only a pending local flow; it does not revoke an issued credential.

Set a named credential profile for the isolated WSL host. Its key includes the normalized required user email and excludes connection/session IDs. Each profile binds to exactly one server-issued subject and cannot be silently overwritten by another user. A subsequent task in the same WSL user session reads the profile from Secret Service, rotates its refresh credential, and then verifies `/me` before business operations without repeating interactive authorization.

## Fail-closed behavior

If broker capability, callback, keyring availability/unlock, token validation, `GET /me`, or host identity matching fails, the plugin stops at that exact layer. Do not work around the failure with a copied token, a committed credential, a desktop connector session, or a plaintext token cache.

The 2026-07-21 staging metadata evidence advertises authorization-code and refresh-token grants but no device endpoint or device-code grant. The plugin-side RFC 8628 provider is ready; a clean headless host remains blocked until the authorization server publishes the device contract described in [Authorization interaction](authorization-interaction.md). Re-run `inspect_contenttraker_oauth_metadata` when remote verification is authorized rather than treating this dated evidence as current forever.

## Clean headless acceptance

Start WSL with no display variables, Windows interoperability, or drive automount. Verify `inspect_runtime_capabilities` reports headless/manual interaction and Linux Secret Service. Then inspect OAuth metadata, run the explicit device login, verify `/me`, list workspaces, select an explicit workspace ID, restart Codex and WSL, and repeat `/me` plus workspace listing without login. A draft write is a separate step requiring fresh approval and a stable idempotency key. Confirm the test used no Windows executable, credential, connector, cookie, mounted drive, or filesystem token.

## Host identity check

Set both `CONTENTTRAKER_CREDENTIAL_PROFILE` and `CONTENTTRAKER_REQUIRED_USER_EMAIL` in the isolated WSL environment that launches Codex. Use a profile name specific to that WSL host and identity. After sign-in, call `get_current_user`. The plugin compares the server-returned email with the configured value using a case-insensitive exact match. The same policy is enforced again before every ContentTraker API operation.
