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
    commandAvailable: (command) => command === "rundll32.exe",
  },
);
assert.equal(detectedWindowsFacts.platform, "windows");
assert.equal(detectedWindowsFacts.browserInteractionMode, "system-browser");
assert.equal(detectedWindowsFacts.systemBrowserLauncherAvailable, true);

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
  }),
);
assert.equal(windowsResult.selectedProfile, "windows-desktop");
assert.equal(windowsResult.status, "blocked");
assert.match(windowsResult.diagnostics.join(" "), /Windows secure credential provider/);

const macosResult = inspectRuntimeCapabilities(
  delegatedEnv(),
  facts({
    platform: "macos",
    graphicalSessionAvailable: true,
    browserInteractionMode: "system-browser",
    systemBrowserLauncherAvailable: true,
  }),
);
assert.equal(macosResult.selectedProfile, "macos-desktop");
assert.equal(macosResult.status, "blocked");
assert.match(macosResult.diagnostics.join(" "), /macOS secure credential provider/);

const serviceToken = "runtime-test-service-token";
const containerResult = inspectRuntimeCapabilities(
  {
    CONTENTTRAKER_ENVIRONMENT: "staging",
    CONTENTTRAKER_AUTH_MODE: "service",
    CONTENTTRAKER_STAGING_ACCESS_TOKEN: serviceToken,
  },
  facts({ platform: "linux", isContainer: true, isCi: true }),
);
assert.equal(containerResult.status, "ready");
assert.equal(containerResult.selectedProfile, "container");
assert.equal(containerResult.selectedStrategy.authentication, "service-environment-token");
assert.equal(JSON.stringify(containerResult).includes(serviceToken), false);

const headlessServiceResult = inspectRuntimeCapabilities(
  {
    CONTENTTRAKER_RUNTIME_PROFILE: "headless",
    CONTENTTRAKER_ENVIRONMENT: "staging",
    CONTENTTRAKER_AUTH_MODE: "service",
    CONTENTTRAKER_STAGING_ACCESS_TOKEN: serviceToken,
  },
  facts({
    platform: "windows",
    graphicalSessionAvailable: true,
    systemBrowserLauncherAvailable: true,
  }),
);
assert.equal(headlessServiceResult.status, "ready");
assert.equal(headlessServiceResult.selectedProfile, "headless");

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

const missingServiceToken = inspectRuntimeCapabilities(
  { CONTENTTRAKER_ENVIRONMENT: "staging", CONTENTTRAKER_AUTH_MODE: "service" },
  facts({ platform: "linux", isContainer: true }),
);
assert.equal(missingServiceToken.status, "blocked");
assert.match(missingServiceToken.diagnostics.join(" "), /environment-specific token is missing/);

const invalidAuthMode = inspectRuntimeCapabilities(
  delegatedEnv({ CONTENTTRAKER_AUTH_MODE: "ambient" }),
  linuxDesktop,
);
assert.equal(invalidAuthMode.status, "invalid");
assert.equal(invalidAuthMode.selectedStrategy.authentication, "invalid");

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
