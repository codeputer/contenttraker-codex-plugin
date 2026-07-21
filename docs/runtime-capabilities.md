# Runtime capabilities

The ContentTraker target environment and the plugin host runtime are independent configuration axes:

- `CONTENTTRAKER_ENVIRONMENT` selects `staging` or `production`.
- `CONTENTTRAKER_RUNTIME_PROFILE` selects how the local adapter evaluates host interaction and credential capabilities.
- `CONTENTTRAKER_CREDENTIAL_STORE` selects `auto`, `windows-credential-manager`, `macos-keychain`, `linux-secret-service`, or `memory`.
- `CONTENTTRAKER_CREDENTIAL_PROFILE` selects the durable delegated-user profile and defaults to `default`.

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

- requested and selected runtime profiles;
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

The tool never returns environment token values, access tokens, refresh tokens, browser state, cookies, keyring contents, or other credentials.

## Selection precedence

1. Validate `CONTENTTRAKER_ENVIRONMENT` independently.
2. Validate an explicit `CONTENTTRAKER_RUNTIME_PROFILE` when provided.
3. Validate the durable credential profile and explicit credential-store mode.
4. With `auto`, prefer a container profile when container evidence exists.
5. Select an interactive desktop profile only when matching host and browser-launch capability evidence exists.
6. Select the matching platform credential provider only when its prerequisites are present.
7. Evaluate `CONTENTTRAKER_AUTH_MODE` against the selected host capabilities.
8. Return `blocked` or `invalid` rather than silently choosing a weaker authentication or credential-storage strategy.

Operating-system identity alone is not sufficient evidence of interactivity. Non-WSL Linux desktop selection requires a graphical-session signal and `xdg-open`; container and CI signals suppress automatic desktop selection. Inside WSL, the plugin launches a known Linux browser executable directly when one is available. It never routes WSL authorization through `xdg-open`; when no native browser is found it selects the manual URL provider. Windows browser interoperability remains disabled.

## Current provider coverage

The current branch implements delegated authorization code + PKCE with system-browser, WSL-native, and manual URL interaction providers. Persistent refresh credentials use Windows Credential Manager, macOS Keychain, or Linux Secret Service. They are stored as binding-validated profiles independent of MCP connection/session IDs and can be rediscovered and refreshed by a new task. Explicit `memory` mode is available for ephemeral hosts; production additionally requires `CONTENTTRAKER_ALLOW_EPHEMERAL_PRODUCTION=true`.

Automatic delegated credential persistence is disabled in containers and CI. Those hosts must explicitly choose memory-only behavior or use service authentication until ContentTraker exposes a supported workload-identity grant. Live metadata currently reports device authorization and workload identity as unavailable; both remain external capabilities.

Service mode currently reports ready only when the selected ContentTraker environment has its matching service token configured. The diagnostic reports presence only and never returns the token.
