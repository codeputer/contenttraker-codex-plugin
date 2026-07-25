# Security policy

## Supported versions

Only the latest published release is supported. Installations should pin a reviewed Git tag or commit.

## Release artifact and build dependencies

Marketplace installations execute the committed `dist/server.mjs` bundle and do not install npm packages. CI requires a clean production-dependency audit and rejects a bundle containing Hono's HTTP/static-server modules.

The MCP SDK used to build version 0.3.0 currently declares `@hono/node-server` in its development dependency tree. npm reports an advisory for that package's Windows static-file serving path. This plugin is a local stdio adapter across its supported host profiles, does not import or use that HTTP/static-file server, and does not include it in the released bundle. The dependency should still be updated when the MCP SDK provides a Node 18-compatible fixed dependency path or the supported host baseline moves to Node 20.

## Reporting a vulnerability

Do not open a public issue containing credentials, tokens, private ContentTraker data, or customer information. Report security concerns to `support@contenttraker.com` with the affected release, operating system, reproduction steps, and whether any credential may have been exposed.

## Credential handling

Interactive authentication is OAuth authorization code with PKCE. Refresh credentials belong only in Windows Credential Manager, macOS Keychain, Linux Secret Service, or an explicitly selected process-memory store. Raw access tokens are not accepted through environment or plugin configuration. The project, plugin files, workspace registry, worktree context marker, command arguments, logs, diagnostics, container images, and Git history must remain credential-free.

Persistent entries are versioned envelopes bound to the ContentTraker environment, OAuth authority, audience/resource, public client, normalized required-user email policy, durable server subject, and configured credential profile. A profile cannot be overwritten by a different subject. The v2 namespace never loads or enumerates v0.1.2 session-derived entries.

Windows passes credential data to a static native-API PowerShell bridge over stdin. macOS uses `security -i` and passes hexadecimal password data over stdin. Linux passes credential data to `secret-tool` over stdin. Rotation locks contain no credential or identity data and are removed from the operating-system temporary directory after use.

Business API tools never launch a browser. They restore the identity-bound keyring entry or return `authentication_required`; interactive login begins only through the explicit login tools. The plugin fails closed when the keyring is missing, unavailable, corrupt, or locked.

OAuth interaction also fails closed until live metadata proves the configured resource/issuer relationship, same-authority HTTPS endpoints, code and refresh grants, public-client token authentication, PKCE `S256`, bearer-header support, and every requested scope. Metadata is cached only in process memory for a bounded interval. Redirects from metadata endpoints are rejected.

Device authorization is used only when metadata advertises both its endpoint and grant. The user code and credential-free HTTPS verification URL may be displayed; the opaque device code, token responses, and polling error bodies never leave the adapter. Polling is bounded, cancellable, and follows RFC 8628 pending and slow-down behavior. Optional browser-launch failure does not cancel device polling.

Every business request verifies `/me`. Every write additionally verifies that the exact selected workspace ID appears in the authenticated user's `/workspaces` response. An explicit per-call workspace selector wins; otherwise a human-confirmed worktree marker is live-verified before registry fallback is considered. Invalid, copied, stale, or unauthorized markers fail closed and never silently select another workspace.

`.contenttraker-codex/context.json` is a strict, versioned, environment-indexed envelope bound to the normalized repository and physical Git worktree. It permits workspace/project identifiers, names, timestamps, confirmation state, and plugin provenance only. Secret-like or unknown fields, symlinks, oversized files, unsupported schemas, and repository/worktree mismatches are rejected. The marker and its atomic temporary files are ignored through Git's private `info/exclude`; the tracked `.gitignore` is not changed.

Reset deletes only the selected environment's local binding and exact registry mappings, then records a worktree/environment tombstone. It does not delete or revoke OAuth/keyring credentials, affect another worktree, or change any remote ContentTraker asset. A separately valid other-environment marker entry is preserved; if the full marker is unreadable or untrusted, the result reports that preservation could not be proven. Production remains read-only unless separately enabled and exactly confirmed; draft remains the default create state, and create/lifecycle writes require stable idempotency keys.
