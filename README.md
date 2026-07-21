# ContentTraker Codex Plugin

Public, reviewable Codex marketplace package for the ContentTraker local MCP adapter. The private ContentTraker application remains in a separate private repository; this repository contains only the client adapter, its tests, plugin metadata, and operator documentation.

## Stewardship and runtime identity

This public plugin repository was created and defined by Richard Reukema (`richard@phoenixbussolutions.com`). That Phoenix identity is the repository authorship and release-publishing identity.

An installation's authenticated ContentTraker user is a separate runtime identity supplied and verified inside the consuming host. Customer, organization, host, and workspace identities are not committed as plugin defaults. See [AUTHORS.md](AUTHORS.md).

## Release status

The plugin package is installable and its MCP process starts without the private ContentTraker repository. Delegated sign-in uses ContentTraker's authorization-code flow with PKCE and does not reuse a ChatGPT desktop connector session.

An isolated WSL host must also provide:

- Node.js 18 or newer;
- either a Linux browser available through WSLg or a way to open a displayed manual authorization URL in a browser that can return to the WSL loopback callback; and
- a working Linux Secret Service keyring for the host user.

Windows browser interoperability remains disabled inside WSL. If a WSL-native browser is unavailable, the plugin returns a manual URL and keeps the loopback listener alive while authorization is pending. If the browser/loopback path or keyring is unavailable, authentication stops. There is no bearer-token argument, plaintext credential file, browser-cookie import, or connector-session fallback. See [WSL authentication](docs/wsl-authentication.md).

## Install a reviewed release

```bash
codex plugin marketplace add https://github.com/codeputer/contenttraker-codex-plugin.git --ref v0.1.2
codex plugin marketplace list
codex plugin list
codex plugin add contenttraker@contenttraker
```

Start a new Codex session after installation so the plugin tools and skill are loaded.

## Cross-platform runtime capabilities

The plugin treats the ContentTraker target (`staging` or `production`) separately from the host runtime (`windows-desktop`, `macos-desktop`, `linux-desktop`, `wsl-desktop`, `headless`, or `container`). `CONTENTTRAKER_RUNTIME_PROFILE` defaults to `auto` and selects a desktop profile only when matching host capability evidence exists.

Use the unauthenticated `inspect_runtime_capabilities` tool before authentication troubleshooting. It reports the selected profile, available interaction and credential providers, session-restoration support, and redacted blocking diagnostics without calling ContentTraker or exposing credentials. See [Runtime capabilities](docs/runtime-capabilities.md).

Interactive authorization supports platform browser launch on Windows, macOS, and non-WSL Linux; direct Linux-browser launch inside WSL; and a manual URL flow for headless or isolated hosts. Use `begin_contenttraker_authorization`, then poll `get_contenttraker_authorization_status` (optionally waiting up to 15 seconds per call). Use `cancel_contenttraker_authorization` to close a pending local callback listener. See [Authorization interaction](docs/authorization-interaction.md).

## Authentication and host identity policy

The staging sign-in page is:

```text
https://userweb.staging.contenttraker.com/account/login
```

That page is not the API endpoint. The plugin uses the documented staging integration origins:

```text
API and token audience: https://mcp.staging.contenttraker.com
OAuth issuer:           https://tokenbroker.staging.contenttraker.com
```

Set the identity required by a managed host before starting Codex:

```bash
export CONTENTTRAKER_REQUIRED_USER_EMAIL='user@example.org'
codex
```

The value is a host policy input, not a credential, and is not built into the plugin. `get_current_user` calls `GET /me`, reports the effective ContentTraker identity, and states whether it matches the policy. Every subsequent API operation repeats the same effective-caller check. A configured mismatch stops the operation before the requested read or write.

Normal verification order:

1. `get_current_user`
2. `list_workspaces`
3. `resolve_contenttraker_context`
4. `list_digital_asset_types`
5. `create_digital_asset` with explicit user approval, a stable idempotency key, and `status: "draft"`

Workspace names are runtime inputs. No customer identity, workspace, or project is hardcoded in this repository.

## Upgrade

Pin a new reviewed tag by replacing the marketplace snapshot:

```bash
codex plugin remove contenttraker@contenttraker
codex plugin marketplace remove contenttraker
codex plugin marketplace add https://github.com/codeputer/contenttraker-codex-plugin.git --ref v0.1.2
codex plugin add contenttraker@contenttraker
```

Start a new Codex session after upgrading.

## Remove

```bash
codex plugin remove contenttraker@contenttraker
codex plugin marketplace remove contenttraker
```

Removing the plugin does not delete operating-system keyring entries. Revoke ContentTraker authorization through the supported account/security workflow if access must be withdrawn.

## Build and verify

```bash
cd plugins/contenttraker
npm ci
npm test
```

The committed `dist/server.mjs` bundles the runtime JavaScript so Codex can start the adapter without running `npm install`. Delegated authentication uses the WSL user's Secret Service through `secret-tool`; no native Node package is downloaded at install time.

## Security and licence

See [SECURITY.md](SECURITY.md), [LICENSE](LICENSE), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
