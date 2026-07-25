# Configuration and strategy selection

Configuration describes non-secret policy and host capabilities. Credentials never belong in the plugin manifest, environment configuration, command arguments, workspace registry, or container image.

| Axis | Variable | Values | Default |
| --- | --- | --- | --- |
| ContentTraker target | `CONTENTTRAKER_ENVIRONMENT` | `staging`, `production` | `staging` |
| Host profile | `CONTENTTRAKER_RUNTIME_PROFILE` | `auto`, `windows-desktop`, `macos-desktop`, `linux-desktop`, `wsl-desktop`, `headless`, `container` | `auto` |
| Authentication | `CONTENTTRAKER_AUTH_MODE` | `auto`, `delegated`, `workload` | `auto` |
| Delegated flow | `CONTENTTRAKER_DELEGATED_FLOW` | `auto`, `authorization-code`, `device-code` | `auto` |
| Browser interaction | `CONTENTTRAKER_BROWSER_MODE` | `auto`, `system`, `manual`, `wsl-native` | `auto` |
| Credential provider | `CONTENTTRAKER_CREDENTIAL_STORE` | `auto`, `windows-credential-manager`, `macos-keychain`, `linux-secret-service`, `memory` | `auto` |
| Delegated profile | `CONTENTTRAKER_CREDENTIAL_PROFILE` | 1-64 letters, numbers, dots, underscores, or hyphens | `default`; packaged plugin requires a named value |
| Required user | `CONTENTTRAKER_REQUIRED_USER_EMAIL` | Case-insensitive exact email policy, for example `operator@example.org` | Unset; packaged plugin requires a value |
| Require identity policy | `CONTENTTRAKER_REQUIRE_IDENTITY_POLICY` | `true`, `false` | `true` in the packaged plugin |

The marketplace manifest requires a host-owned identity policy but does not contain a profile, email, credential, workspace, customer, or user value. Its `env_vars` allowlist forwards supported non-secret configuration from the process that launches Codex. The adapter itself defaults the ContentTraker target to `staging`; an explicit forwarded environment may select `production`, which remains read-only unless its separate write policy is enabled.

## Precedence

1. Validate the ContentTraker target independently from the host profile.
2. Validate the durable credential profile and exact required-user policy. The packaged plugin stops before credential restoration when the profile is missing/default or the required email is absent.
3. Use an explicit runtime profile when it agrees with detected host facts; otherwise return `invalid`.
4. With authentication `auto`, choose workload OAuth for container or CI evidence and delegated OAuth for other hosts.
5. An explicit `delegated` or `workload` value overrides automatic authentication selection but does not make a missing provider available.
6. Delegated mode validates `CONTENTTRAKER_DELEGATED_FLOW`. Its `auto` value keeps authorization code + PKCE for browser-capable hosts and selects device code only for manual/headless interaction when live metadata advertises it.
7. Apply the explicit browser and credential-provider choices, or capability-probe their `auto` values.
8. Before interaction, live OAuth metadata must validate the target resource, authority, endpoints, grants, PKCE, public client, bearer method, and scopes.
9. Any missing layer returns `blocked` or `invalid`; the plugin does not fall back to a raw token, browser cookie, connector session, plaintext file, or Windows browser bridge from WSL.

Business API tools never initiate interactive authorization. Call `begin_contenttraker_login` and `poll_contenttraker_login`; `get_current_user` returns `authentication_required` when no credential can be restored.

Workspace context has a separate fail-closed precedence:

1. explicit per-call `workspaceId`, `workspaceKey`, or `workspaceName`;
2. a live-authorized, human-confirmed marker for the current Git worktree and environment;
3. an exact environment-scoped registry mapping when the worktree has not been explicitly reset;
4. live resolution and the smallest necessary human confirmation.

An explicit per-call selector intentionally wins over the marker. Without an explicit selector, the absolute `repositoryRoot` is required because the adapter process runs from the installed plugin directory. A missing root or an invalid, copied, stale, unauthorized, or malformed marker blocks fallback instead of silently selecting a registry/default workspace.

## Durable worktree selection

Use `$contenttraker-select` or ask plainly to select the ContentTraker context. The skill verifies the effective caller and exact live workspace/project before calling `confirm_contenttraker_context`. That tool requires the literal confirmation `CONFIRM_CONTENTTRAKER_CONTEXT` and writes `.contenttraker-codex/context.json` only after the user's exact choice is confirmed.

The versioned file keeps separate `staging` and `production` entries. Each binding records the normalized repository identity, a worktree fingerprint, stable workspace identifiers and names, optional project provenance, confirmation timestamp, and plugin provenance. It never stores a token, refresh credential, authorization code, cookie, keyring value, password, secret, or remote asset content.

The marker is automatically added to Git's private worktree-safe `info/exclude` rules, including its atomic temporary files. The plugin does not edit the tracked `.gitignore`, and it refuses to use a marker path that is already tracked.

Use `$contenttraker-reset` or ask plainly to reset the current worktree's ContentTraker context. `reset_contenttraker_context` requires `RESET_CONTENTTRAKER_CONTEXT`, clears only the active environment's binding and exact matching registry entries, and adds a reset tombstone. The tombstone prevents an environment default from undoing the reset before a new live selection is confirmed. Authentication, other worktrees, valid other-environment marker entries, and remote assets are preserved. If the marker is wholly unreadable or untrusted, the result explicitly says that another environment entry could not be safely preserved instead of claiming otherwise.

Native `/contenttraker-select` and `/contenttraker-reset` aliases are not supported by the current plugin contract.

Non-container user hosts select delegated OAuth by default. Containers and CI select workload OAuth and currently stop at the workload layer because staging advertises no supported workload grant and the plugin has no host workload provider. For an intentionally interactive one-off container, set both `CONTENTTRAKER_AUTH_MODE=delegated` and `CONTENTTRAKER_CREDENTIAL_STORE=memory`; the authorization disappears with the process.

Legacy `CONTENTTRAKER_AUTH_MODE=service` is rejected. There are no supported `CONTENTTRAKER_*_ACCESS_TOKEN` settings.
