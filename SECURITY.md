# Security policy

## Supported versions

Only the latest published release is supported. Installations should pin a reviewed Git tag or commit.

## Release artifact and build dependencies

Marketplace installations execute the committed `dist/server.mjs` bundle and do not install npm packages. CI requires a clean production-dependency audit and rejects a bundle containing Hono's HTTP/static-server modules.

The MCP SDK used to build version 0.1.2 currently declares `@hono/node-server` in its development dependency tree. npm reports an advisory for that package's Windows static-file serving path. This plugin is a WSL stdio server, does not import or use that HTTP/static-file server, and does not include it in the released bundle. The dependency should still be updated when the MCP SDK provides a Node 18-compatible fixed dependency path or the supported host baseline moves to Node 20.

## Reporting a vulnerability

Do not open a public issue containing credentials, tokens, private ContentTraker data, or customer information. Report security concerns to `support@contenttraker.com` with the affected release, operating system, reproduction steps, and whether any credential may have been exposed.

## Credential handling

Interactive authentication is connection-scoped OAuth authorization code with PKCE. Refresh credentials belong only in the operating-system keyring. The project, plugin files, workspace registry, tool arguments, logs, diagnostics, and Git history must remain credential-free.

The plugin deliberately fails closed when the secure browser or keyring prerequisites are unavailable.
