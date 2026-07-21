# Security policy

## Supported versions

Only the latest published release is supported. Installations should pin a reviewed Git tag or commit.

## Reporting a vulnerability

Do not open a public issue containing credentials, tokens, private ContentTraker data, or customer information. Report security concerns to `support@contenttraker.com` with the affected release, operating system, reproduction steps, and whether any credential may have been exposed.

## Credential handling

Interactive authentication is connection-scoped OAuth authorization code with PKCE. Refresh credentials belong only in the operating-system keyring. The project, plugin files, workspace registry, tool arguments, logs, diagnostics, and Git history must remain credential-free.

The plugin deliberately fails closed when the secure browser or keyring prerequisites are unavailable.
