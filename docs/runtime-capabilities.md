# Runtime capabilities

The ContentTraker target environment and the plugin host runtime are independent configuration axes:

- `CONTENTTRAKER_ENVIRONMENT` selects `staging` or `production`.
- `CONTENTTRAKER_RUNTIME_PROFILE` selects how the local adapter evaluates host interaction and credential capabilities.

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

The result reports only non-secret facts:

- requested and selected runtime profiles;
- the independently selected ContentTraker environment;
- platform, WSL, container, CI, display, D-Bus, browser-launcher, and Linux Secret Service prerequisite booleans;
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
3. With `auto`, prefer a container profile when container evidence exists.
4. Select an interactive desktop profile only when matching host and browser-launch capability evidence exists.
5. Otherwise select `headless`.
6. Evaluate `CONTENTTRAKER_AUTH_MODE` against the selected host capabilities.
7. Return `blocked` or `invalid` rather than silently choosing a weaker authentication or credential-storage strategy.

Operating-system identity alone is not sufficient evidence of interactivity. Linux and WSL require a graphical-session signal and `xdg-open`; container and CI signals suppress automatic desktop selection. The current `xdg-open` provider cannot prove that a WSL authorization stayed inside a Linux browser, so `wsl-native-browser-isolation` remains a separate blocked/future capability and Windows browser interoperability remains disabled by default.

## Current provider coverage

Version 0.1.2 implements delegated authorization code + PKCE with a system browser launcher and Linux Secret Service through `secret-tool`. Windows Credential Manager, macOS Keychain, manual authorization URL completion, device authorization, workload identity, explicit production memory-only credentials, and durable cross-task restoration are reported as future or external capabilities until their Epic #2 work is completed.

Service mode currently reports ready only when the selected ContentTraker environment has its matching service token configured. The diagnostic reports presence only and never returns the token.
