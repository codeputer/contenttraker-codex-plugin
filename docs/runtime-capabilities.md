# Runtime capabilities

The ContentTraker target environment and the plugin host runtime are independent configuration axes:

- `CONTENTTRAKER_ENVIRONMENT` selects `staging` or `production`.
- `CONTENTTRAKER_RUNTIME_PROFILE` selects how the local adapter evaluates host interaction and credential capabilities.
- `CONTENTTRAKER_AUTH_MODE` selects `auto`, `delegated`, or `workload` and defaults to `auto`.
- `CONTENTTRAKER_DELEGATED_FLOW` selects `auto`, `authorization-code`, or `device-code` and defaults to `auto`.
- `CONTENTTRAKER_CREDENTIAL_STORE` selects `auto`, `windows-credential-manager`, `macos-keychain`, `linux-secret-service`, or `memory`.
- `CONTENTTRAKER_CREDENTIAL_PROFILE` selects the durable delegated-user profile; the packaged plugin requires a named profile and normalized `CONTENTTRAKER_REQUIRED_USER_EMAIL`.

The runtime profile defaults to `auto`. Valid values are:

- `auto`
- `windows-desktop`
- `macos-desktop`
- `linux-desktop`
- `wsl-desktop`
- `headless`
- `container`

An explicit profile does not manufacture missing host capabilities. If the selected profile contradicts the detected host—for example, `wsl-desktop` without WSL, a graphical session, and a Linux browser launcher—the diagnostic result is `invalid` and authentication remains fail closed.

## Diagnostic tool

Call `inspect_runtime_capabilities` before authentication troubleshooting or host-specific setup. It does not authenticate, read ContentTraker business data, or call the ContentTraker API.

Host capability inspection is intentionally offline. Call `inspect_contenttraker_oauth_metadata` for the separate live server-capability check. That tool does not authenticate or access business data.

The result reports only non-secret facts:

- the local plugin ID/version, `contenttraker-codex-adapter` registration, stdio transport, HTTPS JSON API upstream, and the package-scoped fact that this plugin does not bundle a remote app mapping;
- whether the required-email and named-profile identity policy is configured, without returning the email;
- requested and selected runtime and authentication profiles;
- the independently selected ContentTraker environment;
- platform, WSL, container, CI, display, D-Bus, browser-launcher, and secure-store prerequisite facts;
- authentication, interaction, credential-persistence, and session-restoration capability status;
- the currently selected strategy; and
- precise redacted diagnostics.

Capability status values are:

- `available`: the current plugin and detected host can use the capability;
- `blocked`: a required host capability or configuration is missing;
- `future`: the provider is part of the cross-platform design but is not implemented in the plugin yet; and
- `external`: the capability also requires ContentTraker authorization-server or host-platform support.

The tool never returns access tokens, refresh tokens, browser state, cookies, keyring contents, or other credentials.

## Selection precedence

1. Validate `CONTENTTRAKER_ENVIRONMENT` independently.
2. Validate an explicit `CONTENTTRAKER_RUNTIME_PROFILE` when provided.
3. Validate the durable credential profile and explicit credential-store mode.
4. With `auto`, prefer a container profile when container evidence exists.
5. Select an interactive desktop profile only when matching host and browser-launch capability evidence exists.
6. Select the matching platform credential provider only when its prerequisites are present.
7. With authentication `auto`, select workload OAuth for container or CI evidence and delegated OAuth otherwise.
8. In delegated `auto`, use device authorization only when interaction is manual/headless and live metadata advertises the device endpoint and grant; otherwise retain authorization code + PKCE.
9. Apply explicit authentication and delegated-flow overrides without manufacturing missing capabilities.
10. Return `blocked` or `invalid` rather than silently choosing a weaker authentication or credential-storage strategy.

Operating-system identity alone is not sufficient evidence of interactivity. Non-WSL Linux desktop selection requires a graphical-session signal and `xdg-open`; container and CI signals suppress automatic desktop selection. Inside WSL, the plugin launches a known Linux browser executable directly when one is available. It never routes WSL authorization through `xdg-open`; when no native browser is found it selects the manual URL provider. Windows browser interoperability remains disabled.

## Current provider coverage

The current branch implements delegated authorization code + PKCE with system-browser, WSL-native, and manual URL interaction providers, plus RFC 8628 device authorization gated by live metadata. Persistent refresh credentials use Windows Credential Manager, macOS Keychain, or Linux Secret Service. They are stored as required-email-bound profiles independent of MCP connection/session IDs and can be rediscovered and refreshed by a new task. Explicit `memory` mode is available for ephemeral hosts; production additionally requires `CONTENTTRAKER_ALLOW_EPHEMERAL_PRODUCTION=true`.

Automatic delegated credential persistence is disabled in containers and CI. An intentionally interactive ephemeral container may explicitly select `CONTENTTRAKER_AUTH_MODE=delegated` and `CONTENTTRAKER_CREDENTIAL_STORE=memory`; it must authorize again after restart. Automatic container/CI selection uses workload OAuth and currently reports blocked because ContentTraker exposes no supported workload grant and the plugin has no host workload provider.

Raw bearer-token and legacy `service` configuration are unsupported. `service` and unknown authentication modes return `invalid` with a migration diagnostic. The dated 2026-07-21 staging evidence reports device authorization and workload OAuth as unavailable; re-run the metadata inspection when remote verification is authorized.
