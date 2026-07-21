import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveBrowserInteraction } from "./browser-interaction.js";
import { resolveCredentialStore } from "./credential-store.js";
import { resolveAdapterEnvironment } from "./environment-profile.js";
import type {
  RuntimeCapabilitiesResult,
  RuntimeCapability,
  RuntimeHostFacts,
  RuntimeProfileName,
  SelectedRuntimeProfileName,
} from "./types.js";

const RUNTIME_PROFILES: RuntimeProfileName[] = [
  "auto",
  "windows-desktop",
  "macos-desktop",
  "linux-desktop",
  "wsl-desktop",
  "headless",
  "container",
];

export interface RuntimeDetectionOptions {
  platform?: NodeJS.Platform;
  commandAvailable?: (command: string) => boolean;
  containerMarkerExists?: boolean;
  kernelRelease?: string;
}

export function inspectRuntimeCapabilities(
  env: NodeJS.ProcessEnv = process.env,
  host: RuntimeHostFacts = detectRuntimeHostFacts(env),
): RuntimeCapabilitiesResult {
  const environmentProfile = resolveAdapterEnvironment(env);
  const configuredProfile = env.CONTENTTRAKER_RUNTIME_PROFILE?.trim().toLowerCase() || "auto";
  const configuredCredentialProfile = env.CONTENTTRAKER_CREDENTIAL_PROFILE?.trim() || "default";
  const validCredentialProfile = /^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(configuredCredentialProfile);
  const diagnostics: string[] = [];
  const validRequestedProfile = isRuntimeProfile(configuredProfile);
  const requestedProfile = validRequestedProfile ? configuredProfile : "invalid";
  const selectedProfile = validRequestedProfile
    ? selectRuntimeProfile(configuredProfile, host)
    : undefined;

  if (!validRequestedProfile) {
    diagnostics.push(
      `CONTENTTRAKER_RUNTIME_PROFILE must be one of: ${RUNTIME_PROFILES.join(", ")}.`,
    );
  }

  if (!environmentProfile.status.valid) {
    diagnostics.push(
      `CONTENTTRAKER_ENVIRONMENT must be one of: ${environmentProfile.status.allowedNames.join(", ")}.`,
    );
  }

  if (!validCredentialProfile) {
    diagnostics.push(
      "CONTENTTRAKER_CREDENTIAL_PROFILE must be 1-64 letters, numbers, dots, underscores, or hyphens.",
    );
  }

  if (selectedProfile) {
    diagnostics.push(...validateExplicitProfile(configuredProfile, selectedProfile, host));
  }

  const requestedAuthMode = env.CONTENTTRAKER_AUTH_MODE?.trim().toLowerCase() || "auto";
  const validAuthMode = ["auto", "delegated", "workload"].includes(requestedAuthMode);
  const selectedAuthMode = validAuthMode
    ? requestedAuthMode === "auto"
      ? selectAuthenticationMode(selectedProfile, host)
      : requestedAuthMode as "delegated" | "workload"
    : undefined;
  const delegatedInteractionReady = host.browserInteractionMode !== "invalid";
  const delegatedReady = delegatedInteractionReady
    && host.credentialStoreAvailable;

  const interaction: RuntimeCapability[] = [
    capability(
      "system-browser",
      host.browserInteractionMode === "system-browser" ? "available" : "blocked",
      host.browserInteractionMode === "system-browser"
        ? undefined
        : "System-browser interaction is not selected for this host.",
    ),
    capability(
      "manual-authorization-url",
      "available",
      host.browserInteractionMode === "manual-url"
        ? "Manual authorization URL interaction is selected for this host."
        : "Manual authorization remains available through begin_contenttraker_authorization.",
    ),
    ...(host.isWsl
      ? [capability(
          "wsl-native-browser-isolation",
          host.wslNativeBrowserIsolationAvailable ? "available" : "blocked",
          host.wslNativeBrowserIsolationAvailable
            ? undefined
            : "No supported WSL-native Linux browser launcher is selected; Windows browser interoperability remains disabled.",
        )]
      : []),
  ];

  const authentication: RuntimeCapability[] = [
    capability(
      "delegated-user-pkce",
      delegatedReady ? "available" : "blocked",
      delegatedReady
        ? undefined
        : delegatedBlockedReason(host),
    ),
    capability(
      "device-authorization",
      "external",
      "Requires ContentTraker authorization-server metadata and a device authorization provider.",
    ),
    capability(
      "workload-identity",
      "external",
      "Requires a live ContentTraker workload OAuth grant plus an implemented host workload-identity provider; raw bearer-token configuration is not supported.",
    ),
  ];

  const credentialPersistence: RuntimeCapability[] = [
    capability(
      "linux-secret-service",
      host.credentialStoreProvider === "linux-secret-service" && host.credentialStoreAvailable ? "available" : "blocked",
      host.credentialStoreProvider === "linux-secret-service" && host.credentialStoreAvailable
        ? "Provider availability and unlocked state are verified when a keyring operation runs."
        : linuxSecretServiceBlockedReason(host),
    ),
    capability(
      "windows-credential-manager",
      host.credentialStoreProvider === "windows-credential-manager" && host.credentialStoreAvailable ? "available" : "blocked",
      host.credentialStoreProvider === "windows-credential-manager" && host.credentialStoreAvailable
        ? "Credential operations use the native Windows Credential Manager API through a secret-safe PowerShell bridge."
        : host.platform === "windows"
          ? host.credentialStoreDiagnostics[0]
          : "Windows Credential Manager is not applicable to this host platform.",
    ),
    capability(
      "macos-keychain",
      host.credentialStoreProvider === "macos-keychain" && host.credentialStoreAvailable ? "available" : "blocked",
      host.credentialStoreProvider === "macos-keychain" && host.credentialStoreAvailable
        ? "Credential operations use the macOS security command without passing secret values in process arguments."
        : host.platform === "macos"
          ? host.credentialStoreDiagnostics[0]
          : "macOS Keychain is not applicable to this host platform.",
    ),
    capability(
      "ephemeral-memory",
      host.credentialStoreProvider === "ephemeral-memory" && host.credentialStoreAvailable ? "available" : "blocked",
      host.credentialStoreProvider === "ephemeral-memory" && host.credentialStoreAvailable
        ? "Explicit memory-only credentials are selected; a new task must authorize again."
        : "Set CONTENTTRAKER_CREDENTIAL_STORE=memory to explicitly select non-persistent delegated credentials.",
    ),
  ];

  const sessionRestoration: RuntimeCapability[] = [
    capability(
      "cross-task-refresh-restoration",
      host.credentialStoreAvailable && host.credentialStorePersistent ? "available" : "blocked",
      host.credentialStoreAvailable && host.credentialStorePersistent
        ? "Refresh credentials use a discoverable, binding-validated credential profile independent of MCP connection and session IDs."
        : "Cross-task restoration requires a persistent secure credential provider.",
    ),
  ];

  const selectedStrategy = selectedAuthMode === "workload"
    ? {
        authentication: "workload-oauth" as const,
        interaction: "none" as const,
        credentialProfile: configuredCredentialProfile.toLowerCase(),
        credentialPersistence: "none" as const,
        crossTaskRestoration: false,
      }
    : selectedAuthMode === "delegated"
      ? {
          authentication: "delegated-user-pkce" as const,
          interaction: host.browserInteractionMode === "invalid" ? "none" as const : host.browserInteractionMode,
          credentialProfile: configuredCredentialProfile.toLowerCase(),
          credentialPersistence: host.credentialStoreAvailable
            ? host.credentialStoreProvider === "unavailable"
              ? "none" as const
              : host.credentialStoreProvider
            : "none" as const,
          crossTaskRestoration: host.credentialStoreAvailable && host.credentialStorePersistent,
        }
      : {
          authentication: "invalid" as const,
          interaction: "none" as const,
          credentialProfile: configuredCredentialProfile.toLowerCase(),
          credentialPersistence: "none" as const,
          crossTaskRestoration: false,
        };

  if (!validAuthMode) {
    diagnostics.push("CONTENTTRAKER_AUTH_MODE must be auto, delegated, or workload. Legacy service bearer-token configuration is not supported.");
  } else if (selectedAuthMode === "delegated" && !delegatedReady) {
    diagnostics.push(delegatedBlockedReason(host));
  } else if (selectedAuthMode === "workload") {
    diagnostics.push(
      "Workload OAuth is blocked until live server metadata advertises a supported grant and the plugin implements the selected host workload-identity provider.",
    );
  }

  const invalid = !validRequestedProfile
    || !environmentProfile.status.valid
    || !validCredentialProfile
    || !validAuthMode
    || diagnostics.some((entry) => entry.startsWith("Explicit runtime profile"));
  const ready = !invalid && selectedAuthMode === "delegated" && delegatedReady;

  return {
    status: invalid ? "invalid" : ready ? "ready" : "blocked",
    contentTrakerEnvironment: {
      requestedName: environmentProfile.status.requestedName,
      name: environmentProfile.status.name,
      valid: environmentProfile.status.valid,
    },
    requestedProfile,
    selectedProfile,
    requestedAuthenticationMode: requestedAuthMode,
    selectedAuthenticationMode: selectedAuthMode,
    host,
    selectedStrategy,
    capabilities: {
      interaction,
      authentication,
      credentialPersistence,
      sessionRestoration,
    },
    diagnostics: unique(diagnostics),
  };
}

export function detectRuntimeHostFacts(
  env: NodeJS.ProcessEnv = process.env,
  options: RuntimeDetectionOptions = {},
): RuntimeHostFacts {
  const platform = options.platform ?? process.platform;
  const commandAvailable = options.commandAvailable ?? ((command: string) => commandExists(command, env, platform));
  const kernelRelease = options.kernelRelease ?? os.release();
  const isWsl = platform === "linux" && Boolean(
    env.WSL_DISTRO_NAME?.trim()
      || env.WSL_INTEROP?.trim()
      || /microsoft|wsl/iu.test(kernelRelease),
  );
  const isContainer = options.containerMarkerExists
    ?? Boolean(
      isEnabled(env.CONTENTTRAKER_CONTAINER)
        || env.KUBERNETES_SERVICE_HOST?.trim()
        || env.container?.trim()
        || existsSync("/.dockerenv"),
    );
  const isCi = isEnabled(env.CI);
  const graphicalSessionAvailable = platform === "win32" || platform === "darwin"
    ? !isCi && !isContainer
    : Boolean(env.DISPLAY?.trim() || env.WAYLAND_DISPLAY?.trim());
  const browserSelection = isCi || isContainer
    ? { mode: "manual-url" as const }
    : resolveBrowserInteraction(env, { platform, kernelRelease, commandAvailable });
  const systemBrowserLauncherAvailable = browserSelection.mode === "system-browser"
    || browserSelection.mode === "wsl-native";
  const linuxSecretToolAvailable = platform === "linux" && commandAvailable("secret-tool");
  const dbusSessionAvailable = platform === "linux" && Boolean(env.DBUS_SESSION_BUS_ADDRESS?.trim());
  const credentialStore = resolveCredentialStore(env, { platform, commandAvailable });

  return {
    platform: platform === "win32"
      ? "windows"
      : platform === "darwin"
        ? "macos"
        : platform === "linux"
          ? "linux"
          : "other",
    isWsl,
    isContainer,
    isCi,
    graphicalSessionAvailable,
    dbusSessionAvailable,
    browserInteractionMode: browserSelection.mode,
    systemBrowserLauncherAvailable,
    wslNativeBrowserIsolationAvailable: browserSelection.mode === "wsl-native",
    linuxSecretToolAvailable,
    linuxSecretServicePrerequisitesAvailable: linuxSecretToolAvailable && dbusSessionAvailable,
    credentialStoreProvider: credentialStore.provider,
    credentialStoreAvailable: credentialStore.available,
    credentialStorePersistent: credentialStore.persistent,
    credentialStoreDiagnostics: credentialStore.diagnostics,
  };
}

function selectRuntimeProfile(
  requestedProfile: RuntimeProfileName,
  host: RuntimeHostFacts,
): SelectedRuntimeProfileName {
  if (requestedProfile !== "auto") return requestedProfile;
  if (host.isContainer) return "container";
  if (host.isWsl && host.graphicalSessionAvailable && host.systemBrowserLauncherAvailable) return "wsl-desktop";
  if (host.isWsl) return "headless";
  if (host.platform === "windows" && host.systemBrowserLauncherAvailable) return "windows-desktop";
  if (host.platform === "macos" && host.systemBrowserLauncherAvailable) return "macos-desktop";
  if (host.platform === "linux" && host.graphicalSessionAvailable && host.systemBrowserLauncherAvailable) {
    return "linux-desktop";
  }
  return "headless";
}

function selectAuthenticationMode(
  selectedProfile: SelectedRuntimeProfileName | undefined,
  host: RuntimeHostFacts,
): "delegated" | "workload" {
  return selectedProfile === "container" || host.isContainer || host.isCi
    ? "workload"
    : "delegated";
}

function validateExplicitProfile(
  requestedProfile: string,
  selectedProfile: SelectedRuntimeProfileName,
  host: RuntimeHostFacts,
): string[] {
  if (requestedProfile === "auto" || selectedProfile === "headless") return [];

  const valid = selectedProfile === "container"
    ? host.isContainer
    : selectedProfile === "wsl-desktop"
      ? host.isWsl && host.graphicalSessionAvailable && host.systemBrowserLauncherAvailable
      : selectedProfile === "windows-desktop"
        ? host.platform === "windows" && !host.isContainer && host.systemBrowserLauncherAvailable
        : selectedProfile === "macos-desktop"
          ? host.platform === "macos" && !host.isContainer && host.systemBrowserLauncherAvailable
          : host.platform === "linux"
            && !host.isWsl
            && !host.isContainer
            && host.graphicalSessionAvailable
            && host.systemBrowserLauncherAvailable;

  return valid
    ? []
    : [`Explicit runtime profile '${selectedProfile}' contradicts the detected host capabilities.`];
}

function delegatedBlockedReason(host: RuntimeHostFacts): string {
  if (host.browserInteractionMode === "invalid") {
    return "Delegated PKCE authentication is blocked because browser interaction configuration is invalid.";
  }
  if (!host.credentialStoreAvailable) {
    return host.credentialStoreDiagnostics[0]
      ?? `Delegated PKCE authentication is blocked because no ${platformLabel(host.platform)} secure credential provider is available.`;
  }
  return "Delegated PKCE authentication is blocked by unavailable host capabilities.";
}

function linuxSecretServiceBlockedReason(host: RuntimeHostFacts): string {
  if (host.platform !== "linux") {
    return "Linux Secret Service is not applicable to this host platform.";
  }
  if (!host.linuxSecretToolAvailable) {
    return "Linux Secret Service is blocked because secret-tool is unavailable.";
  }
  if (!host.dbusSessionAvailable) {
    return "Linux Secret Service is blocked because no D-Bus user session is available.";
  }
  return "Linux Secret Service prerequisites are unavailable.";
}

function capability(
  name: string,
  status: RuntimeCapability["status"],
  reason?: string,
): RuntimeCapability {
  return reason ? { name, status, reason } : { name, status };
}

function platformLabel(platform: RuntimeHostFacts["platform"]): string {
  return platform === "windows"
    ? "Windows"
    : platform === "macos"
      ? "macOS"
      : platform === "linux"
        ? "Linux"
        : "host";
}

function commandExists(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  const pathValue = env.PATH ?? env.Path ?? "";
  const extensions = platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];

  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    const normalizedDirectory = directory.replace(/^"|"$/gu, "");
    const hasExtension = platform === "win32" && path.extname(command).length > 0;
    const candidates = hasExtension ? [command] : extensions.map((extension) => `${command}${extension.toLowerCase()}`);
    for (const candidate of candidates) {
      if (existsSync(path.join(normalizedDirectory, candidate))) return true;
      if (platform === "win32" && existsSync(path.join(normalizedDirectory, candidate.toUpperCase()))) return true;
    }
  }
  return false;
}

function isRuntimeProfile(value: string): value is RuntimeProfileName {
  return RUNTIME_PROFILES.includes(value as RuntimeProfileName);
}

function isEnabled(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
