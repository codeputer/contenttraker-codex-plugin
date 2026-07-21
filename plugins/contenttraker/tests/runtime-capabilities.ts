import assert from "node:assert/strict";

import { detectRuntimeHostFacts, inspectRuntimeCapabilities } from "../src/runtime-capabilities.js";
import type { RuntimeHostFacts } from "../src/types.js";

const linuxDesktop = facts({
  platform: "linux",
  graphicalSessionAvailable: true,
  dbusSessionAvailable: true,
  browserInteractionMode: "system-browser",
  systemBrowserLauncherAvailable: true,
  linuxSecretToolAvailable: true,
  linuxSecretServicePrerequisitesAvailable: true,
  credentialStoreProvider: "linux-secret-service",
  credentialStoreAvailable: true,
  credentialStorePersistent: true,
  credentialStoreDiagnostics: [],
});

const linuxResult = inspectRuntimeCapabilities(delegatedEnv(), linuxDesktop);
assert.equal(linuxResult.status, "ready");
assert.equal(linuxResult.selectedProfile, "linux-desktop");
assert.equal(linuxResult.selectedStrategy.authentication, "delegated-user-pkce");
assert.equal(linuxResult.selectedStrategy.credentialPersistence, "linux-secret-service");

const wslResult = inspectRuntimeCapabilities(
  delegatedEnv({ CONTENTTRAKER_ENVIRONMENT: "production" }),
  facts({
    platform: "linux",
    isWsl: true,
    graphicalSessionAvailable: true,
    dbusSessionAvailable: true,
    browserInteractionMode: "wsl-native",
    systemBrowserLauncherAvailable: true,
    wslNativeBrowserIsolationAvailable: true,
    linuxSecretToolAvailable: true,
    linuxSecretServicePrerequisitesAvailable: true,
    credentialStoreProvider: "linux-secret-service",
    credentialStoreAvailable: true,
    credentialStorePersistent: true,
    credentialStoreDiagnostics: [],
  }),
);
assert.equal(wslResult.status, "ready");
assert.equal(wslResult.selectedProfile, "wsl-desktop");
assert.equal(wslResult.contentTrakerEnvironment.name, "production");

const detectedWslFacts = detectRuntimeHostFacts(
  {
    WSL_DISTRO_NAME: "Ubuntu",
    DISPLAY: ":0",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
  },
  {
    platform: "linux",
    containerMarkerExists: false,
    commandAvailable: (command) => command === "xdg-open" || command === "secret-tool",
  },
);
assert.equal(detectedWslFacts.isWsl, true);
assert.equal(detectedWslFacts.browserInteractionMode, "manual-url");
assert.equal(detectedWslFacts.systemBrowserLauncherAvailable, false);
assert.equal(detectedWslFacts.linuxSecretServicePrerequisitesAvailable, true);
assert.equal(detectedWslFacts.wslNativeBrowserIsolationAvailable, false);

const detectedWslResult = inspectRuntimeCapabilities(delegatedEnv(), detectedWslFacts);
assert.equal(detectedWslResult.selectedProfile, "headless");
assert.equal(detectedWslResult.status, "ready");
assert.equal(detectedWslResult.selectedStrategy.interaction, "manual-url");

const detectedWindowsFacts = detectRuntimeHostFacts(
  { CI: "0" },
  {
    platform: "win32",
    containerMarkerExists: false,
    commandAvailable: (command) => command === "rundll32.exe" || command === "powershell.exe",
  },
);
assert.equal(detectedWindowsFacts.platform, "windows");
assert.equal(detectedWindowsFacts.browserInteractionMode, "system-browser");
assert.equal(detectedWindowsFacts.systemBrowserLauncherAvailable, true);
assert.equal(detectedWindowsFacts.credentialStoreProvider, "windows-credential-manager");

const detectedContainerFacts = detectRuntimeHostFacts(
  { CI: "1", DISPLAY: ":0" },
  {
    platform: "linux",
    containerMarkerExists: true,
    commandAvailable: () => true,
  },
);
assert.equal(detectedContainerFacts.isContainer, true);
assert.equal(detectedContainerFacts.isCi, true);
assert.equal(detectedContainerFacts.systemBrowserLauncherAvailable, false);

const headlessWsl = inspectRuntimeCapabilities(
  delegatedEnv(),
  facts({ platform: "linux", isWsl: true }),
);
assert.equal(headlessWsl.status, "blocked");
assert.equal(headlessWsl.selectedProfile, "headless");
assert.match(headlessWsl.diagnostics.join(" "), /secret-tool/);

const windowsResult = inspectRuntimeCapabilities(
  delegatedEnv(),
  facts({
    platform: "windows",
    graphicalSessionAvailable: true,
    browserInteractionMode: "system-browser",
    systemBrowserLauncherAvailable: true,
    credentialStoreProvider: "windows-credential-manager",
    credentialStoreAvailable: true,
    credentialStorePersistent: true,
    credentialStoreDiagnostics: [],
  }),
);
assert.equal(windowsResult.selectedProfile, "windows-desktop");
assert.equal(windowsResult.status, "ready");
assert.equal(windowsResult.selectedStrategy.credentialPersistence, "windows-credential-manager");

const macosResult = inspectRuntimeCapabilities(
  delegatedEnv(),
  facts({
    platform: "macos",
    graphicalSessionAvailable: true,
    browserInteractionMode: "system-browser",
    systemBrowserLauncherAvailable: true,
    credentialStoreProvider: "macos-keychain",
    credentialStoreAvailable: true,
    credentialStorePersistent: true,
    credentialStoreDiagnostics: [],
  }),
);
assert.equal(macosResult.selectedProfile, "macos-desktop");
assert.equal(macosResult.status, "ready");
assert.equal(macosResult.selectedStrategy.credentialPersistence, "macos-keychain");

const autoDesktopResult = inspectRuntimeCapabilities(
  { CONTENTTRAKER_ENVIRONMENT: "staging" },
  linuxDesktop,
);
assert.equal(autoDesktopResult.status, "ready");
assert.equal(autoDesktopResult.requestedAuthenticationMode, "auto");
assert.equal(autoDesktopResult.selectedAuthenticationMode, "delegated");
assert.equal(autoDesktopResult.requestedDelegatedFlow, "auto");

const containerResult = inspectRuntimeCapabilities(
  { CONTENTTRAKER_ENVIRONMENT: "staging" },
  facts({ platform: "linux", isContainer: true, isCi: true }),
);
assert.equal(containerResult.status, "blocked");
assert.equal(containerResult.selectedProfile, "container");
assert.equal(containerResult.selectedAuthenticationMode, "workload");
assert.equal(containerResult.selectedStrategy.authentication, "workload-oauth");
assert.match(containerResult.diagnostics.join(" "), /advertises a supported grant/);

const ciResult = inspectRuntimeCapabilities(
  { CONTENTTRAKER_ENVIRONMENT: "staging" },
  facts({ platform: "linux", isCi: true }),
);
assert.equal(ciResult.selectedProfile, "headless");
assert.equal(ciResult.selectedAuthenticationMode, "workload");
assert.equal(ciResult.status, "blocked");

const explicitWorkloadResult = inspectRuntimeCapabilities(
  {
    CONTENTTRAKER_RUNTIME_PROFILE: "headless",
    CONTENTTRAKER_ENVIRONMENT: "staging",
    CONTENTTRAKER_AUTH_MODE: "workload",
  },
  facts({
    platform: "windows",
    graphicalSessionAvailable: true,
    systemBrowserLauncherAvailable: true,
  }),
);
assert.equal(explicitWorkloadResult.status, "blocked");
assert.equal(explicitWorkloadResult.selectedProfile, "headless");
assert.equal(explicitWorkloadResult.selectedAuthenticationMode, "workload");

const ephemeralContainerDelegated = inspectRuntimeCapabilities(
  {
    CONTENTTRAKER_RUNTIME_PROFILE: "container",
    CONTENTTRAKER_ENVIRONMENT: "staging",
    CONTENTTRAKER_AUTH_MODE: "delegated",
    CONTENTTRAKER_CREDENTIAL_STORE: "memory",
  },
  facts({
    platform: "linux",
    isContainer: true,
    isCi: true,
    credentialStoreProvider: "ephemeral-memory",
    credentialStoreAvailable: true,
  }),
);
assert.equal(ephemeralContainerDelegated.status, "ready");
assert.equal(ephemeralContainerDelegated.selectedAuthenticationMode, "delegated");
assert.equal(ephemeralContainerDelegated.selectedStrategy.credentialPersistence, "ephemeral-memory");

const invalidProfile = inspectRuntimeCapabilities(
  delegatedEnv({ CONTENTTRAKER_RUNTIME_PROFILE: "desktop-ish" }),
  linuxDesktop,
);
assert.equal(invalidProfile.status, "invalid");
assert.equal(invalidProfile.selectedProfile, undefined);
assert.match(invalidProfile.diagnostics.join(" "), /CONTENTTRAKER_RUNTIME_PROFILE/);

const contradictoryProfile = inspectRuntimeCapabilities(
  delegatedEnv({ CONTENTTRAKER_RUNTIME_PROFILE: "windows-desktop" }),
  linuxDesktop,
);
assert.equal(contradictoryProfile.status, "invalid");
assert.match(contradictoryProfile.diagnostics.join(" "), /contradicts/);

const invalidEnvironment = inspectRuntimeCapabilities(
  delegatedEnv({ CONTENTTRAKER_ENVIRONMENT: "preview" }),
  linuxDesktop,
);
assert.equal(invalidEnvironment.status, "invalid");
assert.equal(invalidEnvironment.contentTrakerEnvironment.valid, false);

const legacyServiceMode = inspectRuntimeCapabilities(
  { CONTENTTRAKER_ENVIRONMENT: "staging", CONTENTTRAKER_AUTH_MODE: "service" },
  facts({ platform: "linux", isContainer: true }),
);
assert.equal(legacyServiceMode.status, "invalid");
assert.match(legacyServiceMode.diagnostics.join(" "), /Legacy service bearer-token configuration is not supported/);

const invalidAuthMode = inspectRuntimeCapabilities(
  delegatedEnv({ CONTENTTRAKER_AUTH_MODE: "ambient" }),
  linuxDesktop,
);
assert.equal(invalidAuthMode.status, "invalid");
assert.equal(invalidAuthMode.selectedStrategy.authentication, "invalid");

const invalidDelegatedFlow = inspectRuntimeCapabilities(
  delegatedEnv({ CONTENTTRAKER_DELEGATED_FLOW: "password" }),
  linuxDesktop,
);
assert.equal(invalidDelegatedFlow.status, "invalid");
assert.match(invalidDelegatedFlow.diagnostics.join(" "), /CONTENTTRAKER_DELEGATED_FLOW/);

console.log("ContentTraker runtime capability tests passed.");

function facts(overrides: Partial<RuntimeHostFacts> = {}): RuntimeHostFacts {
  return {
    platform: "linux",
    isWsl: false,
    isContainer: false,
    isCi: false,
    graphicalSessionAvailable: false,
    dbusSessionAvailable: false,
    browserInteractionMode: "manual-url",
    systemBrowserLauncherAvailable: false,
    wslNativeBrowserIsolationAvailable: false,
    linuxSecretToolAvailable: false,
    linuxSecretServicePrerequisitesAvailable: false,
    credentialStoreProvider: "unavailable",
    credentialStoreAvailable: false,
    credentialStorePersistent: false,
    credentialStoreDiagnostics: ["Linux Secret Service requires secret-tool."],
    ...overrides,
  };
}

function delegatedEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CONTENTTRAKER_ENVIRONMENT: "staging",
    CONTENTTRAKER_AUTH_MODE: "delegated",
    ...overrides,
  };
}
