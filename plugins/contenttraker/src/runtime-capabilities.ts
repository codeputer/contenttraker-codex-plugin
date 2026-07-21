import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveBrowserInteraction } from "./browser-interaction.js";
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

  if (selectedProfile) {
    diagnostics.push(...validateExplicitProfile(configuredProfile, selectedProfile, host));
  }

  const authMode = env.CONTENTTRAKER_AUTH_MODE?.trim().toLowerCase() || "delegated";
  const serviceTokenConfigured = hasEnvironmentServiceToken(env, environmentProfile.status.name);
  const delegatedInteractionReady = host.browserInteractionMode !== "invalid";
  const delegatedReady = delegatedInteractionReady
    && host.linuxSecretServicePrerequisitesAvailable;
  const serviceReady = authMode === "service" && serviceTokenConfigured;

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
      "service-environment-token",
      serviceTokenConfigured ? "available" : "blocked",
      serviceTokenConfigured
        ? undefined
        : "No environment-specific service token is configured.",
    ),
    capability(
      "workload-identity",
      "external",
      "Requires a supported ContentTraker workload OAuth grant and a host workload-identity provider.",
    ),
  ];

  const credentialPersistence: RuntimeCapability[] = [
    capability(
      "linux-secret-service",
      host.linuxSecretServicePrerequisitesAvailable ? "available" : "blocked",
      host.linuxSecretServicePrerequisitesAvailable
        ? "Provider availability and unlocked state are verified when a keyring operation runs."
        : linuxSecretServiceBlockedReason(host),
    ),
    capability(
      "windows-credential-manager",
      "future",
      "The Windows Credential Manager provider is not implemented yet.",
    ),
    capability(
      "macos-keychain",
      "future",
      "The macOS Keychain provider is not implemented yet.",
    ),
    capability(
      "ephemeral-memory",
      "future",
      "An explicit production memory-only credential profile is not implemented yet.",
    ),
  ];

  const sessionRestoration: RuntimeCapability[] = [
    capability(
      "cross-task-refresh-restoration",
      "future",
      "Persistent refresh credentials are currently keyed to the MCP connection and session.",
    ),
  ];

  const selectedStrategy = authMode === "service"
    ? {
        authentication: "service-environment-token" as const,
        interaction: "none" as const,
        credentialPersistence: serviceTokenConfigured
          ? "environment-service-token" as const
          : "none" as const,
        crossTaskRestoration: false,
      }
    : authMode === "delegated"
      ? {
          authentication: "delegated-user-pkce" as const,
          interaction: host.browserInteractionMode === "invalid" ? "none" as const : host.browserInteractionMode,
          credentialPersistence: host.linuxSecretServicePrerequisitesAvailable
            ? "linux-secret-service" as const
            : "none" as const,
          crossTaskRestoration: false,
        }
      : {
          authentication: "invalid" as const,
          interaction: "none" as const,
          credentialPersistence: "none" as const,
          crossTaskRestoration: false,
        };

  if (authMode !== "delegated" && authMode !== "service") {
    diagnostics.push("CONTENTTRAKER_AUTH_MODE must be delegated or service.");
  } else if (authMode === "delegated" && !delegatedReady) {
    diagnostics.push(delegatedBlockedReason(host));
  } else if (authMode === "service" && !serviceReady) {
    diagnostics.push("Service authentication is selected but its environment-specific token is missing.");
  }

  const invalid = !validRequestedProfile
    || !environmentProfile.status.valid
    || authMode !== "delegated" && authMode !== "service"
    || diagnostics.some((entry) => entry.startsWith("Explicit runtime profile"));
  const ready = !invalid && (authMode === "delegated" ? delegatedReady : serviceReady);

  return {
    status: invalid ? "invalid" : ready ? "ready" : "blocked",
    contentTrakerEnvironment: {
      requestedName: environmentProfile.status.requestedName,
      name: environmentProfile.status.name,
      valid: environmentProfile.status.valid,
    },
    requestedProfile,
    selectedProfile,
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
  if (!host.linuxSecretServicePrerequisitesAvailable) {
    return host.platform === "linux"
      ? linuxSecretServiceBlockedReason(host)
      : `Delegated PKCE authentication is blocked because the ${platformLabel(host.platform)} secure credential provider is not implemented yet.`;
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

function hasEnvironmentServiceToken(
  env: NodeJS.ProcessEnv,
  environment: "staging" | "production" | undefined,
): boolean {
  if (!environment) return false;
  return Boolean(env[`CONTENTTRAKER_${environment.toUpperCase()}_ACCESS_TOKEN`]?.trim());
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
