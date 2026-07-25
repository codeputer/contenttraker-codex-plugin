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

The consolidated reviewed release uses the permanent plugin identity `contenttraker@contenttraker`. Install the immutable `v0.4.0` tag:

```bash
codex plugin marketplace add https://github.com/codeputer/contenttraker-codex-plugin.git --ref v0.4.0
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
5. `$contenttraker-select`, which calls `confirm_contenttraker_context` after live verification and human confirmation
6. `resolve_contenttraker_context` with the absolute `repositoryRoot`
7. `list_digital_asset_types`
8. `create_digital_asset` with the exact approved destination, a stable idempotency key, and `status: "draft"`

`get_current_user` never starts interactive login. Without a recoverable keyring credential it returns `authentication_required` with the explicit login-tool sequence.

## Durable worktree context

`$contenttraker-select` saves the exact workspace and optional project agreed with the user in `.contenttraker-codex/context.json` at the Git worktree root. The underlying `confirm_contenttraker_context` tool authenticates first, verifies the effective ContentTraker user, and confirms that the workspace and optional project are currently authorized. It then records a versioned, human-confirmed context for the active `staging` or `production` environment.

The marker is an environment-indexed envelope:

```json
{
  "schemaVersion": 1,
  "contexts": {
    "staging": {
      "environment": "staging",
      "repositoryIdentity": "owner/repository",
      "worktreeId": "sha256:...",
      "workspaceId": "...",
      "workspaceKey": "...",
      "workspaceName": "...",
      "projectId": "...",
      "projectKey": "...",
      "projectName": "...",
      "confirmationState": "human-confirmed",
      "confirmedAtUtc": "2026-07-24T00:00:00.000Z",
      "pluginName": "contenttraker",
      "pluginVersion": "..."
    }
  },
  "resets": {}
}
```

Workspace resolution precedence is:

1. explicit per-call `workspaceId`, `workspaceKey`, or `workspaceName`;
2. the live-authorized human-confirmed marker for the current worktree and environment;
3. an exact environment-scoped registry mapping when no reset tombstone applies;
4. live resolution and the smallest necessary user confirmation.

The adapter's process directory is the installed plugin, not the user's repository. Without an explicit workspace selector, callers must pass the absolute `repositoryRoot`. A missing root, malformed marker, environment mismatch, repository/worktree mismatch, unauthorized workspace, or invalid project fails closed and does not silently fall back to a different workspace.

The plugin adds the marker and its atomic temporary files to the Git worktree's private `info/exclude` file. It does not modify the repository's tracked `.gitignore`. The marker accepts identifiers, names, timestamps, and plugin provenance only; token, credential, cookie, keyring, secret, and authorization fields are rejected.

`$contenttraker-reset` calls `reset_contenttraker_context`. Reset clears only the current worktree and active environment's marker binding and exact registry mapping, then records a reset tombstone so a stale registry default cannot immediately reselect a workspace. It preserves OAuth/keyring authentication, other worktrees, every valid other-environment marker entry, and every remote ContentTraker asset. If the whole marker is unreadable or untrusted, reset replaces it safely and reports that other-environment marker preservation could not be proven.

Current plugins expose these workflows as skills and MCP tools. Native `/contenttraker-select` and `/contenttraker-reset` aliases are not part of the supported plugin contract; use the `$` skill names or a plain-language request.

Every ContentTraker operation using a saved marker revalidates its workspace and optional project against the live authenticated API. Every write also repeats the normal write-policy and approval checks.

Workspace names are runtime inputs. No customer identity, workspace, or project is hardcoded in this repository.

## Upgrade

Codex treats the marketplace Git ref as a snapshot. A different `--ref` does not replace the installed snapshot in place.

First run `codex plugin list`. Remove every installed ContentTraker plugin identity that it reports before removing the marketplace:

```bash
codex plugin remove contenttraker@contenttraker
```

Older private/local installations used a separate legacy identity. Remove that identity instead, or remove both identities if both are present:

```bash
codex plugin remove contenttraker-codex@contenttraker
```

Then replace the marketplace snapshot and install the permanent public identity:

```bash
codex plugin marketplace remove contenttraker
codex plugin marketplace add https://github.com/codeputer/contenttraker-codex-plugin.git --ref v0.4.0
codex plugin add contenttraker@contenttraker
```

Start a new Codex session after upgrading.

Plugin and marketplace removal preserve operating-system keyring credentials, worktree context markers, registry mappings, and all remote ContentTraker assets. Do not call `logout_contenttraker` during this migration unless credential deletion is separately intended.

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

The committed `dist/server.mjs` bundles the runtime JavaScript so Codex can start the adapter without running `npm install`. Delegated authentication uses the selected host's operating-system credential provider; no native Node package is downloaded at install time.

## Security and licence

See [SECURITY.md](SECURITY.md), [LICENSE](LICENSE), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
