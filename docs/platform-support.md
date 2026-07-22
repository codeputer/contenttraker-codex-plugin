# Platform support

The plugin ships one bundled Node.js adapter. Target environment, host profile, authentication, delegated flow, browser interaction, and credential provider remain independent choices; see [Configuration and strategy selection](configuration.md).

| Host | Default authentication | Interaction | Persistent delegated credential |
| --- | --- | --- | --- |
| Windows desktop | Delegated | Windows system browser | Windows Credential Manager |
| macOS desktop | Delegated | `open` | macOS Keychain |
| Linux desktop | Delegated | `xdg-open` with a display | Secret Service through `secret-tool` |
| Isolated WSL | Delegated | Known WSLg Linux browser, device code when advertised, or manual loopback URL | Linux Secret Service, never Windows Credential Manager |
| Headless Linux | Delegated | Device code when advertised; otherwise blocked unless an external browser can reach the loopback callback | Linux Secret Service or explicit ephemeral memory |
| Docker, Kubernetes, CI | Workload OAuth | None | Host workload identity; no user keyring or embedded credential |

All hosts require Node.js 18 or newer and network access to the selected ContentTraker resource and OAuth authority.

## Desktop hosts

Windows uses the native Credential Manager API through a PowerShell bridge; secret values travel over stdin. macOS uses the built-in `security` command in interactive-command mode; secret bytes are hexadecimal stdin data. Neither provider adds a native Node dependency.

Linux desktop requires a graphical session, `xdg-open`, `secret-tool`, a D-Bus user session, and an unlocked Secret Service provider such as GNOME Keyring. On Debian/Ubuntu, `secret-tool` is normally supplied by `libsecret-tools`; the keyring provider is a separate prerequisite. Package names differ by distribution.

## WSL and headless Linux

WSL authorization never invokes `xdg-open` and never crosses into a Windows browser. With WSLg, the adapter launches only a known Linux browser executable. Without one, delegated-flow `auto` uses device code when live metadata advertises it; otherwise it returns a manual PKCE URL whose loopback callback must still be reachable. A clean headless host without that callback path is blocked at the broker-capability layer.

Persistent restoration still requires `secret-tool`, an existing D-Bus user session, an operational Secret Service provider, and an unlocked keyring. A display or D-Bus address alone does not prove those capabilities. Explicit `CONTENTTRAKER_CREDENTIAL_STORE=memory` permits one-process delegated use but requires authorization again after restart.

## Containers and automation

Container and CI detection selects workload OAuth and disables automatic user-keyring selection. Current ContentTraker metadata advertises no supported workload grant, so unattended container/Kubernetes/CI use stops at that external layer. Do not inject a raw bearer token, refresh token, browser cookie, or client secret into an image, manifest, environment variable, or command argument.

An intentionally interactive disposable container may explicitly select delegated authentication and memory storage:

```text
CONTENTTRAKER_AUTH_MODE=delegated
CONTENTTRAKER_CREDENTIAL_STORE=memory
```

That exception is ephemeral user authorization, not unattended workload identity.

## Diagnostic order

1. `inspect_runtime_capabilities`
2. `inspect_contenttraker_oauth_metadata`
3. `begin_contenttraker_login` and `poll_contenttraker_login` for delegated hosts
4. `get_current_user`
5. `list_workspaces`
6. `resolve_contenttraker_context`

Report the first failed layer: runtime profile, interaction, credential provider, OAuth metadata, device/workload grant, token exchange, identity policy, API readiness, or workspace context.
