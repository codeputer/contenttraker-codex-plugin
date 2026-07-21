# WSL authentication

## Supported contract

Interactive sessions use ContentTraker OAuth authorization code with PKCE (`S256`) and public client ID `codex-mcp`. The adapter listens on a loopback callback, opens the authorization URL with a known Linux browser executable or displays the URL for manual opening, exchanges the one-time code inside the adapter process, validates token routing claims, and calls `GET /me` before any business operation.

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
2. Either a supported Linux browser executable available through WSLg (`firefox`, `firefox-esr`, `google-chrome`, `chromium`, `chromium-browser`, or `microsoft-edge`) or a browser path for the manual URL that can return the callback to the WSL loopback listener.
3. A functioning Secret Service implementation available on the user's D-Bus session, with the `secret-tool` command available.
4. Network access to the documented OAuth issuer and MCP/API origin.

Merely having a D-Bus session is not enough; an actual Secret Service provider must be present and unlocked.

Run `inspect_runtime_capabilities` before starting interactive authorization. Inside WSL, `CONTENTTRAKER_BROWSER_MODE=auto` launches a known Linux browser directly when a display and executable are available; otherwise it selects `manual-url`. The adapter never invokes `xdg-open` in WSL, and `CONTENTTRAKER_BROWSER_MODE=system` is rejected there so Windows browser interoperability cannot be selected accidentally.

`CONTENTTRAKER_DELEGATED_FLOW=auto` uses device authorization instead of the manual loopback flow when the live authorization-server metadata advertises it. The tool then returns a `verificationUri` and `userCode`; it never returns the opaque device code.

For manual interaction:

1. Call `begin_contenttraker_authorization`.
2. Open the returned `authorizationUrl` inside the intended Linux isolation boundary before `expiresAt`.
3. Call `get_contenttraker_authorization_status`, optionally with `waitSeconds` from 0 through 15, until it reports `authorized` or a terminal failure.
4. Call `get_current_user` and verify the effective ContentTraker identity.

The authorization URL contains one-time OAuth request parameters, but the code verifier, authorization code, access token, and refresh credential are never returned by the tool. `cancel_contenttraker_authorization` closes only a pending local listener; it does not revoke an issued credential.

The default credential profile is `default`. Set `CONTENTTRAKER_CREDENTIAL_PROFILE` before launching Codex when the WSL distribution needs more than one durable ContentTraker identity. Each profile binds to exactly one server-issued subject and cannot be silently overwritten by another user. A subsequent task in the same WSL user session reads the profile from Secret Service and rotates its refresh credential without repeating browser authorization.

## Fail-closed behavior

If URL launch, loopback callback, native keyring loading, keyring access, token validation, `GET /me`, or host identity matching fails, the plugin stops at that layer. Do not work around the failure with a copied token, a committed credential, a desktop connector session, or a plaintext token cache.

The current ContentTraker OAuth metadata advertises authorization-code and refresh-token grants. It does not advertise a device endpoint or OAuth device-code grant. The plugin-side provider is ready, but a host that cannot open the displayed URL and route the callback to its loopback listener remains blocked until the authorization server publishes device authorization or another supported flow.

## Host identity check

Set `CONTENTTRAKER_REQUIRED_USER_EMAIL` in the environment that launches Codex. After sign-in, call `get_current_user`. The plugin compares the server-returned email with the configured value using a case-insensitive exact match. The same policy is enforced again before every ContentTraker API operation.
