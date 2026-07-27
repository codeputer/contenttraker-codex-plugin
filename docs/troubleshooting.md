# Troubleshooting

## Wrong ContentTraker surface or version is shown

The reported screenshot showed `ContentTraker.com 1.0.0` in the Apps UI. That is a separate app/connector exposed by Codex, and its version is independent of this plugin. This local plugin is `contenttraker@contenttraker`; its MCP registration is `contenttraker-codex-adapter`, and its tools have `mcp__contenttraker_codex_adapter` provenance.

Call the local `inspect_runtime_capabilities` tool. It must report `hostBoundary: local-codex-plugin`, `codexTransport: stdio`, `upstreamInterface: contenttraker-https-json-api`, and `bundlesRemoteAppMapping: false`. If the local tool is absent, first verify that `contenttraker@contenttraker` is installed and enabled, then open a fresh task or restart Codex to refresh the plugin catalog. Require the local namespace after refresh; if it is still absent, report the exact task tool-surface failure. The separate connector is currently observed as `mcp__codex_apps__contenttraker_com`, but that namespace is not a contract owned by this repository.

This repository cannot disable an unrelated app from its plugin manifest. Codex host configuration can disable the exact app ID returned by Codex's app catalog while keeping `[plugins."contenttraker@contenttraker".mcp_servers."contenttraker-codex-adapter"]` enabled. Never guess the app ID from its display name.

## Identity policy is required

The packaged plugin blocks before credential restoration unless the Codex host supplies both a named `CONTENTTRAKER_CREDENTIAL_PROFILE` and `CONTENTTRAKER_REQUIRED_USER_EMAIL`. Set them in the environment that launches Codex, restart Codex, open a new task, and call `inspect_runtime_capabilities`. Its `identityPolicy` must be valid before authentication.

Do not work around this diagnostic with the `default` profile, an app/connector session, a raw token, or another user's stored credential.

## `authentication_required`

No usable in-process or v2 keyring credential was found. Run `begin_contenttraker_login`, present only its user-facing URL/code, poll with `poll_contenttraker_login`, then call `get_current_user`. Business tools never launch a browser.

## Device authorization is not advertised

Run `inspect_contenttraker_oauth_metadata`. Fully headless login requires both a `device_authorization_endpoint` and `urn:ietf:params:oauth:grant-type:device_code`. If either is absent, this is a token-broker prerequisite. Do not construct an endpoint or copy an authorization code/token through chat, clipboard, Windows, or a file.

## Linux Secret Service is unavailable or locked

`inspect_runtime_capabilities` must show `secret-tool`, a D-Bus user session, and Linux Secret Service. Start the Secret Service provider in the same WSL user session and unlock its keyring. The adapter stops at this layer and does not fall back to plaintext, Windows Credential Manager, or another identity.

## Stored credential is corrupt or rejected

The adapter deletes a malformed v2 record or a refresh credential rejected with OAuth HTTP 400/401 without printing it, then returns a binding diagnostic. Transient transport and server failures do not delete the credential. Run the explicit login flow again after a rejected credential. If the configured required email changed intentionally, use a separate credential profile or log out the old profile first; never silently reuse a credential bound to another identity policy.

## `repository_root_required_for_durable_context`

The operation did not include an explicit ContentKeeper selector or an absolute `repositoryRoot`. Pass canonical `contentKeeperId` (or compatible `workspaceId`/`workspaceKey`) for a one-call override, or pass the current Git worktree root so the adapter can validate `.contenttraker-codex/context.json`. The adapter cannot infer the user's worktree from its own installed-plugin directory.

## `content_keeper_alias_mismatch`

`contentKeeperId` and compatibility `workspaceId` were both supplied with different trimmed values. Correct the caller so both names contain the exact same ContentKeeper identifier, or send only `contentKeeperId`. No authorization lookup or business API request is attempted.

## `contentkeeper_selection_required`

The worktree has no human-confirmed marker and no exact repository-root registry mapping. An environment default or project-name-only mapping may exist, but it cannot authorize business operations. Call `get_current_user`, `list_workspaces`, and `$contenttraker-select`, or pass an explicit authorized `contentKeeperId`.

## `context_registry_authorization_rejected`

The exact repository mapping exists but its ContentKeeper or project provenance is stale or no longer authorized for the effective issuer + subject account. No environment default is used. Verify the effective user, list authorized ContentKeepers, and confirm the intended target again.

## Context marker is malformed or belongs elsewhere

Diagnostics beginning with `context_marker_invalid`, `context_marker_repository_mismatch`, `context_marker_worktree_mismatch`, or `context_marker_secret_field_rejected` mean the local marker cannot be trusted. No registry fallback is used. Run `$contenttraker-select` and confirm the exact live target. A live-confirmed selection can replace malformed or secret-field-rejected JSON; repository/worktree mismatches remain blocked so a copied marker cannot be silently adopted. `$contenttraker-reset` can also replace malformed JSON with a reset tombstone. It preserves a separately valid other-environment entry when that entry can be validated, and reports `otherEnvironments: false` when an unreadable or untrusted envelope makes that impossible to prove.

Do not hand-edit identifiers into the marker or copy it between worktrees. Never place tokens, credentials, cookies, authorization codes, keyring data, or secrets in it.

## `context_marker_authorization_rejected`

The saved workspace or optional project is stale or no longer authorized for the verified ContentTraker user. No registry fallback was used. Call `get_current_user`, list the live workspaces, then run `$contenttraker-select` for the correct target. Do not substitute a similarly named workspace.

## `context_reset_for_worktree`

This worktree and environment were deliberately reset. The tombstone prevents an old registry mapping or environment default from silently restoring the previous selection. Run `$contenttraker-select` or pass an explicit workspace selector for a single operation.

## `context_environment_mismatch`

The requested selection/reset environment differs from the adapter's active environment. Restart the adapter with the intended `CONTENTTRAKER_ENVIRONMENT` or retry against its current environment. Reset never changes the adapter environment.

## Marker cannot be privately ignored

`tracked_context_marker_rejected` means `.contenttraker-codex/context.json` is already tracked by Git. Remove it from version control through the owning repository's normal review workflow before selecting a durable context. `private_exclude_verification_failed` means Git did not confirm the private ignore rule; no marker should be treated as safely stored until that is corrected. Do not add customer context or credentials to tracked `.gitignore` workarounds.

## Select/reset skill name is not in the slash menu

Use `$contenttraker-select`, `$contenttraker-reset`, or plain language. Native `/contenttraker-select` and `/contenttraker-reset` aliases are not part of the current plugin contract. After installing or upgrading the plugin, restart Codex and open a new task so the skills and MCP tool catalog reload.

## ContentKeeper is not authorized

The exact selected ContentKeeper ID/key was absent from the authenticated user's `/workspaces` response. No business request was sent. Verify `get_current_user`, list ContentKeepers again, and do not substitute a project name, display name, environment default, or another cached identity.

## Migrating to the account-aware v0.5.0 plugin

Version 0.5.0 is the immutable account-aware local stdio release. Replace the marketplace snapshot with `v0.5.0`, fully restart Codex Desktop, and open a new task so Codex receives the current server instructions and output schemas. Opening only a new task can be insufficient after an in-process marketplace upgrade because the Desktop host can retain the previous tool catalog or a closed adapter transport.

Existing explicit `workspaceId` calls remain valid. Marker v1 and registry v1/v2 remain readable; the next confirmed marker write emits v2 and the next registry update emits v3 with canonical `contentKeeperId`. Environment defaults remain present for diagnostics but stop routing business operations. See [ContentKeeper identity and migration](contentkeeper-migration.md).

## Migrating from older plugin identities

Run `codex plugin list --json` before changing the installation. Public releases use `contenttraker@contenttraker`; a separate older private/local package used `contenttraker-codex@contenttraker`. Remove every installed ContentTraker identity that the list actually reports before removing the `contenttraker` marketplace, because both identities register the same `contenttraker-codex-adapter` MCP key.

Add the marketplace again at `v0.5.0`, install only `contenttraker@contenttraker`, fully restart Codex Desktop, and start a new task. The final plugin list must contain exactly that one ContentTraker plugin at version 0.5.0. Configure the named profile and exact required email in the environment that launches Codex before restarting.

Plugin and marketplace removal do not delete operating-system keyring entries or remote assets. Since version 0.4.0 the plugin uses the identity-bound v2 keyring namespace and never enumerates old session-derived entries. Version 0.4.1 also prevents the packaged adapter from loading an unbound/default profile. Remove legacy `ContentTraker Codex Adapter` credentials only through the operating-system credential UI when local retention policy requires physical deletion.
