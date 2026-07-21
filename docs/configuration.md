# Configuration and strategy selection

Configuration describes non-secret policy and host capabilities. Credentials never belong in the plugin manifest, environment configuration, command arguments, workspace registry, or container image.

| Axis | Variable | Values | Default |
| --- | --- | --- | --- |
| ContentTraker target | `CONTENTTRAKER_ENVIRONMENT` | `staging`, `production` | `staging` |
| Host profile | `CONTENTTRAKER_RUNTIME_PROFILE` | `auto`, `windows-desktop`, `macos-desktop`, `linux-desktop`, `wsl-desktop`, `headless`, `container` | `auto` |
| Authentication | `CONTENTTRAKER_AUTH_MODE` | `auto`, `delegated`, `workload` | `auto` |
| Browser interaction | `CONTENTTRAKER_BROWSER_MODE` | `auto`, `system`, `manual`, `wsl-native` | `auto` |
| Credential provider | `CONTENTTRAKER_CREDENTIAL_STORE` | `auto`, `windows-credential-manager`, `macos-keychain`, `linux-secret-service`, `memory` | `auto` |
| Delegated profile | `CONTENTTRAKER_CREDENTIAL_PROFILE` | 1-64 letters, numbers, dots, underscores, or hyphens | `default` |

The marketplace manifest fixes only the safe ContentTraker target default, `staging`. It does not force an authentication, browser, credential, workspace, customer, or user choice.

## Precedence

1. Validate the ContentTraker target independently from the host profile.
2. Use an explicit runtime profile when it agrees with detected host facts; otherwise return `invalid`.
3. With authentication `auto`, choose workload OAuth for container or CI evidence and delegated OAuth for other hosts.
4. An explicit `delegated` or `workload` value overrides automatic authentication selection but does not make a missing provider available.
5. Delegated mode applies the explicit browser and credential-provider choices, or capability-probes their `auto` values.
6. Before interaction, live OAuth metadata must validate the target resource, authority, endpoints, grants, PKCE, public client, bearer method, and scopes.
7. Any missing layer returns `blocked` or `invalid`; the plugin does not fall back to a raw token, browser cookie, connector session, plaintext file, or Windows browser bridge from WSL.

Non-container user hosts select delegated OAuth by default. Containers and CI select workload OAuth and currently stop at the workload layer because staging advertises no supported workload grant and the plugin has no host workload provider. For an intentionally interactive one-off container, set both `CONTENTTRAKER_AUTH_MODE=delegated` and `CONTENTTRAKER_CREDENTIAL_STORE=memory`; the authorization disappears with the process.

Legacy `CONTENTTRAKER_AUTH_MODE=service` is rejected. There are no supported `CONTENTTRAKER_*_ACCESS_TOKEN` settings.
