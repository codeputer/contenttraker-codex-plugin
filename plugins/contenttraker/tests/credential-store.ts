import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  createSecureCredentialStore,
  createCredentialHandle,
  EphemeralMemoryCredentialStore,
  LinuxSecretServiceCredentialStore,
  MacOsKeychainCredentialStore,
  resolveCredentialStore,
  withCredentialStoreLock,
  WindowsCredentialManagerStore,
  type CredentialCommandResult,
} from "../src/credential-store.js";

const secret = "refresh-secret-that-must-use-stdin";

const windows = resolveCredentialStore({}, {
  platform: "win32",
  commandAvailable: (command) => command === "powershell.exe",
});
assert.equal(windows.provider, "windows-credential-manager");
assert.equal(windows.persistent, true);
assert.equal(windows.available, true);

const macos = resolveCredentialStore({}, {
  platform: "darwin",
  commandAvailable: (command) => command === "security",
});
assert.equal(macos.provider, "macos-keychain");
assert.equal(macos.available, true);

const linux = resolveCredentialStore({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" }, {
  platform: "linux",
  commandAvailable: (command) => command === "secret-tool",
});
assert.equal(linux.provider, "linux-secret-service");
assert.equal(linux.available, true);

const missingLinuxBus = resolveCredentialStore({}, {
  platform: "linux",
  commandAvailable: (command) => command === "secret-tool",
});
assert.equal(missingLinuxBus.available, false);
assert.match(missingLinuxBus.diagnostics.join(" "), /D-Bus/);

const automated = resolveCredentialStore({ CI: "true", DBUS_SESSION_BUS_ADDRESS: "available" }, {
  platform: "linux",
  commandAvailable: () => true,
});
assert.equal(automated.available, false);
assert.match(automated.diagnostics.join(" "), /disabled in containers and CI/);

const productionMemoryBlocked = resolveCredentialStore({
  CONTENTTRAKER_CREDENTIAL_STORE: "memory",
  CONTENTTRAKER_ENVIRONMENT: "production",
}, { platform: "linux", commandAvailable: () => false });
assert.equal(productionMemoryBlocked.available, false);

const productionMemoryAllowed = resolveCredentialStore({
  CONTENTTRAKER_CREDENTIAL_STORE: "memory",
  CONTENTTRAKER_ENVIRONMENT: "production",
  CONTENTTRAKER_ALLOW_EPHEMERAL_PRODUCTION: "true",
}, { platform: "linux", commandAvailable: () => false });
assert.equal(productionMemoryAllowed.provider, "ephemeral-memory");
assert.equal(productionMemoryAllowed.persistent, false);

const invalid = resolveCredentialStore({ CONTENTTRAKER_CREDENTIAL_STORE: "plaintext" }, {
  platform: "linux",
  commandAvailable: () => true,
});
assert.equal(invalid.available, false);
assert.match(invalid.diagnostics.join(" "), /must be one of/);

async function providersKeepSecretsOutOfArguments(): Promise<void> {
  const linuxHandle = createCredentialHandle("linux-test");
  const linuxRunner = new RecordingRunner("linux-stored-value");
  const linuxStore = new LinuxSecretServiceCredentialStore("secret-tool", linuxRunner.run);
  await linuxStore.set(linuxHandle, secret);
  assert.equal(await linuxStore.get(linuxHandle), "linux-stored-value");
  await linuxStore.delete(linuxHandle);
  linuxRunner.assertSecretOnlyInStandardInput(secret);

  const macosHandle = createCredentialHandle("macos-test");
  const macRunner = new RecordingRunner("macos-stored-value");
  const macStore = new MacOsKeychainCredentialStore("security", macRunner.run);
  await macStore.set(macosHandle, secret);
  assert.equal(await macStore.get(macosHandle), "macos-stored-value");
  await macStore.delete(macosHandle);
  macRunner.assertSecretOnlyInStandardInput(secret);

  const windowsHandle = createCredentialHandle("windows-test");
  const windowsRunner = new RecordingRunner("windows-stored-value");
  const windowsStore = new WindowsCredentialManagerStore("powershell.exe", windowsRunner.run);
  await windowsStore.set(windowsHandle, secret);
  assert.equal(await windowsStore.get(windowsHandle), "windows-stored-value");
  await windowsStore.delete(windowsHandle);
  windowsRunner.assertSecretOnlyInStandardInput(secret);
  assert.equal(windowsRunner.calls.every((call) => call.args.includes("-EncodedCommand")), true);
}

async function providerErrorsAreRedacted(): Promise<void> {
  const store = new LinuxSecretServiceCredentialStore("secret-tool", async () => {
    throw new Error(`helper leaked ${secret}`);
  });
  await assert.rejects(
    () => store.set(createCredentialHandle("error-test"), secret),
    (error: Error) => !error.message.includes(secret) && /credential write failed/.test(error.message),
  );
}

async function linuxKeyringFailuresAreActionableAndRedacted(): Promise<void> {
  const handle = createCredentialHandle("locked-keyring-test");
  const locked = new LinuxSecretServiceCredentialStore("secret-tool", async () => ({
    exitCode: 1,
    stdout: "",
    stderr: `The keyring is locked ${secret}`,
  }));
  await assert.rejects(
    () => locked.get(handle),
    (error: Error) => /keyring is locked.*unlock/iu.test(error.message) && !error.message.includes(secret),
  );

  const missingService = new LinuxSecretServiceCredentialStore("secret-tool", async () => ({
    exitCode: 1,
    stdout: "",
    stderr: `org.freedesktop.secrets unavailable ${secret}`,
  }));
  await assert.rejects(
    () => missingService.get(handle),
    (error: Error) => /Secret Service or D-Bus user session is unavailable/iu.test(error.message)
      && !error.message.includes(secret),
  );
}

async function explicitMemoryStoreIsEphemeral(): Promise<void> {
  const store = createSecureCredentialStore({
    CONTENTTRAKER_CREDENTIAL_STORE: "memory",
    CONTENTTRAKER_ENVIRONMENT: "staging",
  }, { platform: "linux", commandAvailable: () => false });
  assert.equal(store instanceof EphemeralMemoryCredentialStore, true);
  const handle = createCredentialHandle("memory-test");
  await store.set(handle, secret);
  assert.equal(await store.get(handle), secret);
  assert.equal((await store.probe?.())?.persistent, false);
}

class RecordingRunner {
  readonly calls: Array<{ command: string; args: string[]; input?: string }> = [];

  constructor(private readonly storedValue: string) {
    this.run = this.run.bind(this);
  }

  async run(command: string, args: string[], input?: string): Promise<CredentialCommandResult> {
    this.calls.push({ command, args: [...args], input });
    const isRead = args.includes("lookup")
      || args.includes("find-generic-password")
      || input?.includes('"operation":"read"');
    return { exitCode: 0, stdout: isRead ? this.storedValue : "", stderr: "" };
  }

  assertSecretOnlyInStandardInput(expectedSecret: string): void {
    const hex = Buffer.from(expectedSecret, "utf8").toString("hex");
    assert.equal(this.calls.some((call) => call.input?.includes(expectedSecret) || call.input?.includes(hex)), true);
    assert.equal(this.calls.some((call) => call.command.includes(expectedSecret)), false);
    assert.equal(this.calls.some((call) => call.args.some((arg) => arg.includes(expectedSecret))), false);
  }
}

await providersKeepSecretsOutOfArguments();
await providerErrorsAreRedacted();
await linuxKeyringFailuresAreActionableAndRedacted();
await explicitMemoryStoreIsEphemeral();
await profileLockSerializesRotations();
await optionalNativeRoundTrip();

console.log("ContentTraker credential-store tests passed.");

async function optionalNativeRoundTrip(): Promise<void> {
  if (process.env.CONTENTTRAKER_TEST_OS_KEYRING !== "1") return;
  const store = createSecureCredentialStore({
    ...process.env,
    CONTENTTRAKER_CREDENTIAL_STORE: "auto",
    CONTENTTRAKER_ENVIRONMENT: "staging",
  });
  const handle = createCredentialHandle(`native-roundtrip-${randomUUID()}`);
  const expected = `native-secret-${randomUUID()}`;
  try {
    await store.set(handle, expected);
    assert.equal(await store.get(handle), expected);
  } finally {
    await store.delete(handle);
  }
  assert.equal(await store.get(handle), undefined);
}

async function profileLockSerializesRotations(): Promise<void> {
  const handle = `delegated-${"a".repeat(64)}`;
  let active = 0;
  let maximumActive = 0;
  const action = async () => await withCredentialStoreLock(handle, async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
  });
  await Promise.all([action(), action(), action()]);
  assert.equal(maximumActive, 1);
}
