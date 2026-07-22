# Troubleshooting

## `authentication_required`

No usable in-process or v2 keyring credential was found. Run `begin_contenttraker_login`, present only its user-facing URL/code, poll with `poll_contenttraker_login`, then call `get_current_user`. Business tools never launch a browser.

## Device authorization is not advertised

Run `inspect_contenttraker_oauth_metadata`. Fully headless login requires both a `device_authorization_endpoint` and `urn:ietf:params:oauth:grant-type:device_code`. If either is absent, this is a token-broker prerequisite. Do not construct an endpoint or copy an authorization code/token through chat, clipboard, Windows, or a file.

## Linux Secret Service is unavailable or locked

`inspect_runtime_capabilities` must show `secret-tool`, a D-Bus user session, and Linux Secret Service. Start the Secret Service provider in the same WSL user session and unlock its keyring. The adapter stops at this layer and does not fall back to plaintext, Windows Credential Manager, or another identity.

## Stored credential is corrupt or rejected

The adapter deletes a malformed v2 record or a refresh credential rejected with OAuth HTTP 400/401 without printing it, then returns a binding diagnostic. Transient transport and server failures do not delete the credential. Run the explicit login flow again after a rejected credential. If the configured required email changed intentionally, use a separate credential profile or log out the old profile first; never silently reuse a credential bound to another identity policy.

## `workspace_conflict`

The explicit workspace differs from the exact repository/project registry mapping. The result shows both non-sensitive candidates and selects neither. Confirm the intended workspace from `list_workspaces`, retry with its explicit ID, and update the local registry separately only if the existing mapping is stale.

## Workspace is not authorized

The exact selected workspace ID was absent from the authenticated user's `/workspaces` response. No write was sent. Verify `get_current_user`, list workspaces again, and do not substitute a project name or another cached identity.

## Upgrading from v0.1.2

Version 0.2.0 uses a new keyring namespace and does not enumerate old session-derived entries. Complete one explicit login after upgrade. Remove old `ContentTraker Codex Adapter` entries only through the operating system credential UI if local policy requires physical deletion.
