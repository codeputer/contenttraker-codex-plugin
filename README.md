# ContentTraker Codex Plugin

Public, reviewable Codex marketplace package for the ContentTraker local MCP adapter. The private ContentTraker application remains in a separate private repository; this repository contains only the client adapter, its tests, plugin metadata, and operator documentation.

## Stewardship and runtime identity

This public plugin repository was created and defined by Richard Reukema (`richard@phoenixbussolutions.com`). That Phoenix identity is the repository authorship and release-publishing identity.

An installation's authenticated ContentTraker user is a separate runtime identity supplied and verified inside the consuming host. Customer, organization, host, and workspace identities are not committed as plugin defaults. See [AUTHORS.md](AUTHORS.md).

## Release status

The `development` branch contains the unreleased 0.5.0 Epic #19 candidate. The latest immutable reviewed tag remains `v0.4.1` until 0.5.0 is merged and published. The plugin package starts without the private ContentTraker repository. Delegated sign-in uses capability-negotiated OAuth device authorization or authorization code with PKCE and never reuses a ChatGPT desktop connector session.

## Which ContentTraker interface this is

Codex can expose two independent ContentTraker surfaces:

- `contenttraker@contenttraker` is this local plugin. It launches `contenttraker-codex-adapter` over stdio and that local process calls the ContentTraker HTTPS JSON API.
- `ContentTraker.com` in the Apps UI is a separate app/connector exposed by Codex, with independent metadata and versioning. It is not bundled, registered, authenticated, or reused by this repository.

`inspect_runtime_capabilities` identifies the local plugin ID and version, MCP registration key, stdio host boundary, and HTTPS JSON API upstream without authenticating. A hostname containing `mcp` is still an HTTPS API origin when the local adapter calls it; it does not turn the local adapter into the remote app connection.

The client-side stdio boundary is intentional. Codex starts the bundled adapter locally, receives its server instructions and structured tool schemas immediately, and the adapter calls the HTTPS JSON API only when a tool needs ContentTraker data. The previously attempted remote-first MCP transport is not a fallback.

When both surfaces are visible, Codex project work should use only tools with local `mcp__contenttraker_codex_adapter` provenance. The separate connector is currently observed as `mcp__codex_apps__contenttraker_com`, but that namespace is not controlled by this repository. If only that connector surface is visible, the local plugin tool surface is missing and the task should stop with that exact boundary.

An isolated WSL host must also provide:

- Node.js 18 or newer;
- authorization-server support for RFC 8628 device authorization, or a browser path that can return an authorization-code callback to the WSL loopback listener; and
- a working Linux Secret Service keyring for the host user.

Windows browser interoperability remains disabled inside WSL. On a headless host, the plugin uses device authorization only when live metadata advertises both its endpoint and grant. The user may open the verification URL elsewhere, but the WSL adapter performs every token exchange and stores the refresh credential only in its Linux Secret Service keyring. If neither device authorization nor a usable loopback path is available, authentication stops at the broker-capability layer. See [WSL authentication](docs/wsl-authentication.md).

## Install a reviewed release

The consolidated reviewed release uses the permanent plugin identity `contenttraker@contenttraker`. Install the immutable `v0.4.1` tag:

```bash
codex plugin marketplace add https://github.com/codeputer/contenttraker-codex-plugin.git --ref v0.4.1
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

Delegated refresh credentials use an OS keyring according to host capabilities. The packaged plugin requires a named `CONTENTTRAKER_CREDENTIAL_PROFILE` plus an exact `CONTENTTRAKER_REQUIRED_USER_EMAIL`; it refuses the unbound `default` profile. Its persistent lookup key is stable across tasks and includes environment, issuer, audience, client ID, profile, and normalized required email. Connection and session IDs are excluded. A new Codex task refreshes only that bound credential without repeating interactive authorization. See [Credential storage](docs/credential-storage.md).

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

Set the identity and a host-isolated profile before starting Codex:

```bash
export CONTENTTRAKER_CREDENTIAL_PROFILE='organization-host'
export CONTENTTRAKER_REQUIRED_USER_EMAIL='user@example.org'
codex
```

These are host policy inputs, not credentials, and no organization or user value is built into the public plugin. The plugin manifest allowlists these variable names, and Codex forwards their host values into the local adapter. If either value is missing, the packaged adapter fails before loading any stored credential. `get_current_user` calls `GET /me`, reports the effective ContentTraker identity, and states whether it matches the policy. The durable account key is OAuth token issuer plus authenticated subject; required email is host policy metadata, not the domain key. Every subsequent API operation repeats the same effective-caller check. A mismatch stops the operation before the requested read or write.

For Codex Desktop on Windows, persist the non-secret policy at user scope, then fully restart Codex:

```powershell
[Environment]::SetEnvironmentVariable(
  'CONTENTTRAKER_CREDENTIAL_PROFILE',
  'organization-windows',
  'User'
)
[Environment]::SetEnvironmentVariable(
  'CONTENTTRAKER_REQUIRED_USER_EMAIL',
  'user@example.org',
  'User'
)
```

An isolated WSL identity must be configured inside that WSL environment with its own profile and Linux keyring. Do not place a WSL-only identity in the Windows user environment.

Normal verification order:

1. `inspect_contenttraker_oauth_metadata`
2. `begin_contenttraker_login` when `get_contenttraker_auth_status` reports `idle`
3. `poll_contenttraker_login`, then `get_current_user`
4. `list_workspaces` (the current API name; each returned `workspaceId` is a ContentKeeper identifier)
5. `$contenttraker-select`, which calls `confirm_contenttraker_context` after live verification and human confirmation
6. `resolve_contenttraker_context` with the absolute `repositoryRoot`
7. `list_digital_asset_types`
8. `create_digital_asset` with the exact approved destination, a stable idempotency key, and `status: "draft"`

`get_current_user` never starts interactive login. Without a recoverable keyring credential it returns `authentication_required` with the explicit login-tool sequence.

## Durable worktree context

`$contenttraker-select` saves the exact ContentKeeper and optional project provenance agreed with the user in `.contenttraker-codex/context.json` at the Git worktree root. The underlying `confirm_contenttraker_context` tool authenticates first, verifies the effective issuer + subject account, and confirms that the ContentKeeper and optional project are currently authorized. It then records a versioned, human-confirmed context for the active `staging` or `production` environment.

The marker is an environment-indexed envelope:

```json
{
  "schemaVersion": 2,
  "contexts": {
    "staging": {
      "environment": "staging",
      "repositoryIdentity": "owner/repository",
      "worktreeId": "sha256:...",
      "contentKeeperId": "...",
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

`contentKeeperId` is canonical. `workspaceId` remains an equal-value compatibility alias because the current HTTPS API routes are named `/workspaces/{workspaceId}`. Supplying both with different values is rejected before an API request.

ContentKeeper resolution precedence is:

1. explicit per-call `contentKeeperId` or compatible `workspaceId`, `workspaceKey`, or `workspaceName`;
2. the live-authorized human-confirmed marker for the current worktree and environment;
3. an exact repository-root registry mapping when no reset tombstone applies;
4. block and request the smallest necessary live selection.

The preferred tool input is a discriminated `context`: use `{ "source": "content-keeper", "contentKeeperId": "..." }` for an explicit target or `{ "source": "worktree", "repositoryRoot": "..." }` for durable selection. Top-level selectors remain during migration. The adapter's process directory is the installed plugin, not the user's repository. Without an explicit selector, callers must pass the absolute `repositoryRoot`. Project name never routes authorization. Environment-wide registry defaults are retained only for diagnostics/migration and cannot authorize a business read or write.

The plugin adds the marker and its atomic temporary files to the Git worktree's private `info/exclude` file. It does not modify the repository's tracked `.gitignore`. The marker accepts identifiers, names, timestamps, and plugin provenance only; token, credential, cookie, keyring, secret, and authorization fields are rejected.

`$contenttraker-reset` calls `reset_contenttraker_context`. Reset clears only the current worktree and active environment's marker binding and exact registry mapping, then records a reset tombstone so a stale registry default cannot immediately reselect a workspace. It preserves OAuth/keyring authentication, other worktrees, every valid other-environment marker entry, and every remote ContentTraker asset. If the whole marker is unreadable or untrusted, reset replaces it safely and reports that other-environment marker preservation could not be proven.

Current plugins expose these workflows as skills and MCP tools. Native `/contenttraker-select` and `/contenttraker-reset` aliases are not part of the supported plugin contract; use the `$` skill names or a plain-language request.

Every ContentTraker business operation revalidates the selected ContentKeeper and optional project provenance against the live authenticated API, whether it came from an explicit selector, marker, or exact registry mapping. Every write also repeats the normal write-policy and approval checks. Every tool advertises an MCP `outputSchema`; successful business results return the canonical `contentKeeperId`.

ContentKeeper names are runtime display inputs. No customer identity, ContentKeeper, workspace, or project is hardcoded in this repository. See [ContentKeeper migration](docs/contentkeeper-migration.md).

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
codex plugin marketplace add https://github.com/codeputer/contenttraker-codex-plugin.git --ref v0.4.1
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
npm run codex-install-smoke
```

The committed `dist/server.mjs` bundles the runtime JavaScript so Codex can start the adapter without running `npm install`. Delegated authentication uses the selected host's operating-system credential provider; no native Node package is downloaded at install time.

The test suite includes a nine-sample cold-start benchmark for `initialize`, `tools/list`, and the first local diagnostic. See the recorded [stdio performance baseline](docs/performance-baseline.md).

## Security and licence

See [SECURITY.md](SECURITY.md), [LICENSE](LICENSE), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
