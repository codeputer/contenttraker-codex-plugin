# ContentTraker Codex Plugin

Public, reviewable Codex marketplace package for the ContentTraker local MCP adapter. The private ContentTraker application remains in a separate private repository; this repository contains only the client adapter, its tests, plugin metadata, and operator documentation.

## Stewardship and runtime identity

This public plugin repository was created and defined by Richard Reukema (`richard@phoenixbussolutions.com`). That Phoenix identity is the repository authorship and release-publishing identity.

An installation's authenticated ContentTraker user is a separate runtime identity supplied and verified inside the consuming host. Customer, organization, host, and workspace identities are not committed as plugin defaults. See [AUTHORS.md](AUTHORS.md).

## Release status

The plugin package is installable and its MCP process starts without the private ContentTraker repository. Delegated sign-in uses capability-negotiated OAuth device authorization or authorization code with PKCE and never reuses a ChatGPT desktop connector session.

An isolated WSL host must also provide:

- Node.js 18 or newer;
- authorization-server support for RFC 8628 device authorization, or a browser path that can return an authorization-code callback to the WSL loopback listener; and
- a working Linux Secret Service keyring for the host user.

Windows browser interoperability remains disabled inside WSL. On a headless host, the plugin uses device authorization only when live metadata advertises both its endpoint and grant. The user may open the verification URL elsewhere, but the WSL adapter performs every token exchange and stores the refresh credential only in its Linux Secret Service keyring. If neither device authorization nor a usable loopback path is available, authentication stops at the broker-capability layer. See [WSL authentication](docs/wsl-authentication.md).

## Install a reviewed release

Version `0.2.0` is the prepared release candidate and is not available by tag until the maintainer explicitly publishes `v0.2.0`. After publication:

```bash
codex plugin marketplace add https://github.com/codeputer/contenttraker-codex-plugin.git --ref v0.2.0
codex plugin marketplace list
codex plugin list
codex plugin add contenttraker@contenttraker
```

Start a new Codex session after installation so the plugin tools and skill are loaded.

## Cross-platform runtime capabilities

The plugin treats the ContentTraker target (`staging` or `production`) separately from the host runtime (`windows-desktop`, `macos-desktop`, `linux-desktop`, `wsl-desktop`, `headless`, or `container`). `CONTENTTRAKER_RUNTIME_PROFILE` defaults to `auto` and selects a desktop profile only when matching host capability evidence exists.

`CONTENTTRAKER_AUTH_MODE` also defaults to `auto`. It selects delegated OAuth for non-container user hosts and workload OAuth for containers or CI. Workload mode currently fails closed because staging advertises no workload grant and no host workload provider is implemented. The plugin does not accept access tokens through configuration. See [Configuration and selection](docs/configuration.md).

Use the unauthenticated `inspect_runtime_capabilities` tool before authentication troubleshooting. It reports the selected profile, available interaction and credential providers, session-restoration support, and redacted blocking diagnostics without calling ContentTraker or exposing credentials. See [Runtime capabilities](docs/runtime-capabilities.md).

Host prerequisites and current evidence are tracked in [Platform support](docs/platform-support.md) and the [Cross-platform verification matrix](docs/verification-matrix.md).

Failure diagnostics and safe recovery steps are in [Troubleshooting](docs/troubleshooting.md).

Use `inspect_contenttraker_oauth_metadata` to validate the live protected-resource and authorization-server contract before authentication. Authorization begins only after exact resource/issuer binding, HTTPS endpoints, code and refresh grants, public-client exchange, PKCE `S256`, bearer headers, and every requested scope are confirmed. See [OAuth metadata](docs/oauth-metadata.md).

Interactive authorization supports platform browser launch, a manual loopback URL, and OAuth device authorization when live server metadata advertises it. `CONTENTTRAKER_DELEGATED_FLOW=auto` keeps authorization code + PKCE for browser-capable hosts and prefers device code for manual/headless interaction when available. Use `begin_contenttraker_login`, then `poll_contenttraker_login` (optionally waiting up to 15 seconds per call). Browser launch is only a convenience; a failed launch leaves the returned flow active. The v0.1 authorization tool names remain as compatibility aliases. See [Authorization interaction](docs/authorization-interaction.md).

Delegated refresh credentials use an OS keyring according to host capabilities. `CONTENTTRAKER_CREDENTIAL_PROFILE` defaults to `default`; its persistent lookup key is stable across tasks and includes environment, issuer, audience, client ID, profile, and normalized `CONTENTTRAKER_REQUIRED_USER_EMAIL`. Connection and session IDs are excluded. A new Codex task refreshes that credential without repeating interactive authorization. See [Credential storage](docs/credential-storage.md).

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

1. `inspect_contenttraker_oauth_metadata`
2. `begin_contenttraker_login` when `get_contenttraker_auth_status` reports `idle`
3. `poll_contenttraker_login`, then `get_current_user`
4. `list_workspaces`
5. `resolve_contenttraker_context` with an explicit `workspaceId` or `workspaceName`
6. `list_digital_asset_types`
7. `create_digital_asset` with the exact approved destination, a stable idempotency key, and `status: "draft"`

`get_current_user` never starts interactive login. Without a recoverable keyring credential it returns `authentication_required` with the explicit login-tool sequence.

Workspace resolution precedence is explicit `workspaceId`, explicit `workspaceName`, exact repository/project registry mapping, then environment default. An explicit workspace that differs from the exact mapping returns `workspace_conflict` with both non-sensitive candidates and performs no API operation. Every write repeats `/me` verification and confirms the exact workspace ID appears in the authenticated user's `/workspaces` response.

Workspace names are runtime inputs. No customer identity, workspace, or project is hardcoded in this repository.

## Upgrade

Codex treats the marketplace Git ref as a snapshot. A different `--ref` does not replace the installed snapshot in place; remove the plugin and marketplace entry, then add the new ref and restart Codex:

```bash
codex plugin remove contenttraker@contenttraker
codex plugin marketplace remove contenttraker
codex plugin marketplace add https://github.com/codeputer/contenttraker-codex-plugin.git --ref v0.2.0
codex plugin add contenttraker@contenttraker
```

Start a new Codex session after upgrading.

## Remove

```bash
codex plugin remove contenttraker@contenttraker
codex plugin marketplace remove contenttraker
```

Removing the plugin does not delete operating-system keyring entries. Revoke ContentTraker authorization through the supported account/security workflow if access must be withdrawn.

Before removal, `logout_contenttraker` with confirmation `LOGOUT_CONTENTTRAKER` deletes the selected v2 local keyring credential. `forget_contenttraker_credential` remains available for compatibility. Neither tool revokes server authorization; use the ContentTraker account security workflow for that separate action.

## Build and verify

```bash
cd plugins/contenttraker
npm ci
npm test
npm run release-artifact
```

The committed `dist/server.mjs` bundles the runtime JavaScript so Codex can start the adapter without running `npm install`. Delegated authentication uses the WSL user's Secret Service through `secret-tool`; no native Node package is downloaded at install time.

## Security and licence

See [SECURITY.md](SECURITY.md), [LICENSE](LICENSE), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
