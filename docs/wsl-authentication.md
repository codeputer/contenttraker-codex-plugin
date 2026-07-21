# WSL authentication

## Supported contract

Interactive sessions use ContentTraker OAuth authorization code with PKCE (`S256`) and public client ID `codex-mcp`. The adapter opens the authorization URL, listens on a loopback callback, exchanges the one-time code inside the adapter process, validates token routing claims, and calls `GET /me` before any business operation.

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
2. A URL handler available to the adapter (`xdg-open`) that can return the loopback OAuth callback to the same WSL host.
3. A functioning Secret Service implementation available on the user's D-Bus session, plus the `@napi-rs/keyring` Linux runtime package.
4. Network access to the documented OAuth issuer and MCP/API origin.

Merely having a D-Bus session is not enough; an actual Secret Service provider must be present and unlocked.

## Fail-closed behavior

If URL launch, loopback callback, native keyring loading, keyring access, token validation, `GET /me`, or host identity matching fails, the plugin stops at that layer. Do not work around the failure with a copied token, a committed credential, a desktop connector session, or a plaintext token cache.

The current ContentTraker OAuth metadata advertises authorization-code and refresh-token grants. It does not advertise an OAuth device authorization grant. A headless WSL host with no usable browser bridge therefore has an authentication blocker until a supported browser/loopback path or device authorization flow is provided.

## Host identity check

Set `CONTENTTRAKER_REQUIRED_USER_EMAIL` in the environment that launches Codex. After sign-in, call `get_current_user`. The plugin compares the server-returned email with the configured value using a case-insensitive exact match. The same policy is enforced again before every ContentTraker API operation.
