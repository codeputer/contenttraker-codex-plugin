# Credential storage and restoration

The plugin keeps access tokens only in process memory. A delegated refresh credential is stored as a versioned secret envelope in the selected provider:

| Host or explicit mode | Provider | Persistent |
| --- | --- | --- |
| Windows `auto` | Windows Credential Manager | Yes |
| macOS `auto` | macOS Keychain | Yes |
| Linux/WSL `auto` with `secret-tool` and a D-Bus user session | Secret Service/libsecret | Yes |
| `CONTENTTRAKER_CREDENTIAL_STORE=memory` | Process memory | No |
| Container or CI `auto` | None; fails closed | No |

Explicit platform-provider modes must match the host and their required command. Memory mode is never selected automatically. Production memory mode additionally requires `CONTENTTRAKER_ALLOW_EPHEMERAL_PRODUCTION=true`; it still cannot restore authorization in a new process.

## Durable profiles

`CONTENTTRAKER_CREDENTIAL_PROFILE` defaults to `default`. It accepts 1-64 letters, numbers, dots, underscores, or hyphens and is normalized to lowercase. The profile forms a discoverable key from:

- ContentTraker environment;
- OAuth authority;
- API resource/audience;
- public client `codex-mcp`;
- normalized `CONTENTTRAKER_REQUIRED_USER_EMAIL`, or an explicit unbound marker; and
- profile name.

Connection ID and MCP session ID are deliberately excluded. The encrypted provider value contains the refresh credential plus the server-issued subject and binding metadata. On a new task, the adapter loads the profile, validates every binding, refreshes it, validates that the token issuer and subject did not change, rotates the stored refresh credential, and then binds the access token to the new connection/session.

One profile represents one durable ContentTraker subject under one required-email policy. Use distinct profile names for distinct identities. A different subject cannot overwrite an existing profile. `GET /me` remains authoritative: after recovery or refresh, the first API operation verifies both the token subject and the case-insensitive required email before listing workspaces or writing.

## Rotation and cleanup

Within a process, refreshes use single-flight coordination. Persistent providers also use a short-lived, metadata-free lock in the operating-system temporary directory so adapter processes do not rotate the same refresh credential concurrently. If another process has already replaced a rotating credential, the adapter reloads and retries the newer record. Malformed or binding-mismatched records are deleted and reported without returning their contents.

Call `logout_contenttraker` with confirmation `LOGOUT_CONTENTTRAKER` to cancel pending login, delete the selected v2 OS-keyring credential, and clear in-process authorization state. `forget_contenttraker_credential` remains a compatibility alias with its original confirmation. Neither operation calls a server revocation endpoint. Complete server-side revocation through the ContentTraker account security workflow.

## v0.1.2 migration

Version 0.2.0 uses the `ContentTraker Codex Adapter v2` keyring namespace and a stable identity-bound handle. The adapter never reads or enumerates v0.1.2 entries whose handles included connection and session IDs. This logically invalidates them without exposing their contents. Run the explicit login flow once after upgrade. If policy requires physical removal of old entries, delete the old `ContentTraker Codex Adapter` service entries through the operating system's credential UI; do not export or print them.

A missing `secret-tool`, absent D-Bus user session, unavailable Secret Service provider, or locked keyring returns a distinct actionable diagnostic and stops before login. There is no plaintext or alternate-identity fallback.

Removing the plugin does not enumerate or delete keyring entries. Forget the intended profile before removal when local cleanup is required.
