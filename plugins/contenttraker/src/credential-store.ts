import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { open, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const KEYRING_SERVICE = "ContentTraker Codex Adapter";
const CREDENTIAL_STORE_MODES = [
  "auto",
  "windows-credential-manager",
  "macos-keychain",
  "linux-secret-service",
  "memory",
] as const;

export type CredentialStoreMode = typeof CREDENTIAL_STORE_MODES[number];
export type CredentialStoreProvider = Exclude<CredentialStoreMode, "auto" | "memory"> | "ephemeral-memory" | "unavailable";

export interface CredentialStoreSelection {
  requestedMode: string;
  provider: CredentialStoreProvider;
  persistent: boolean;
  available: boolean;
  command?: string;
  diagnostics: string[];
}

export interface CredentialStoreProbe extends CredentialStoreSelection {
  operational: boolean;
}

export interface SecureCredentialStore {
  readonly provider?: CredentialStoreProvider;
  readonly persistent?: boolean;
  probe?(): Promise<CredentialStoreProbe>;
  get(handle: string): Promise<string | undefined>;
  set(handle: string, secret: string): Promise<void>;
  delete(handle: string): Promise<void>;
}

export interface CredentialCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CredentialCommandRunner = (
  command: string,
  args: string[],
  input?: string,
) => Promise<CredentialCommandResult>;

export interface CredentialStoreOptions {
  platform?: NodeJS.Platform;
  commandAvailable?: (command: string) => boolean;
  runCommand?: CredentialCommandRunner;
}

export function resolveCredentialStore(
  env: NodeJS.ProcessEnv = process.env,
  options: CredentialStoreOptions = {},
): CredentialStoreSelection {
  const requestedMode = env.CONTENTTRAKER_CREDENTIAL_STORE?.trim().toLowerCase() || "auto";
  if (!isCredentialStoreMode(requestedMode)) {
    return unavailable(
      "invalid",
      `CONTENTTRAKER_CREDENTIAL_STORE must be one of: ${CREDENTIAL_STORE_MODES.join(", ")}.`,
    );
  }

  const platform = options.platform ?? process.platform;
  const commandAvailable = options.commandAvailable ?? ((command: string) => commandExists(command, env, platform));
  if (requestedMode === "memory") {
    if (env.CONTENTTRAKER_ENVIRONMENT?.trim().toLowerCase() === "production"
      && !isEnabled(env.CONTENTTRAKER_ALLOW_EPHEMERAL_PRODUCTION)) {
      return unavailable(
        requestedMode,
        "Memory-only delegated credentials in production require CONTENTTRAKER_ALLOW_EPHEMERAL_PRODUCTION=true.",
      );
    }
    return {
      requestedMode,
      provider: "ephemeral-memory",
      persistent: false,
      available: true,
      diagnostics: ["Ephemeral memory was explicitly selected; credentials cannot be restored in a new task."],
    };
  }

  const automatedHost = isEnabled(env.CI)
    || isEnabled(env.CONTENTTRAKER_CONTAINER)
    || Boolean(env.KUBERNETES_SERVICE_HOST?.trim() || env.container?.trim());
  if (requestedMode === "auto" && automatedHost) {
    return unavailable(
      requestedMode,
      "Automatic delegated credential persistence is disabled in containers and CI; select memory explicitly for ephemeral delegated authorization or use supported workload OAuth.",
    );
  }

  const selectedMode = requestedMode === "auto"
    ? platform === "win32"
      ? "windows-credential-manager"
      : platform === "darwin"
        ? "macos-keychain"
        : platform === "linux"
          ? "linux-secret-service"
          : undefined
    : requestedMode;

  if (selectedMode === "windows-credential-manager") {
    if (platform !== "win32") return unavailable(requestedMode, "Windows Credential Manager is available only on Windows.");
    const command = commandAvailable("powershell.exe")
      ? "powershell.exe"
      : commandAvailable("pwsh.exe")
        ? "pwsh.exe"
        : commandAvailable("pwsh")
          ? "pwsh"
          : undefined;
    return command
      ? available(requestedMode, selectedMode, command)
      : unavailable(requestedMode, "Windows Credential Manager requires PowerShell for the native credential API bridge.");
  }

  if (selectedMode === "macos-keychain") {
    if (platform !== "darwin") return unavailable(requestedMode, "macOS Keychain is available only on macOS.");
    return commandAvailable("security")
      ? available(requestedMode, selectedMode, "security")
      : unavailable(requestedMode, "macOS Keychain requires the security command.");
  }

  if (selectedMode === "linux-secret-service") {
    if (platform !== "linux") return unavailable(requestedMode, "Linux Secret Service is available only on Linux.");
    if (!commandAvailable("secret-tool")) return unavailable(requestedMode, "Linux Secret Service requires secret-tool.");
    if (!env.DBUS_SESSION_BUS_ADDRESS?.trim()) {
      return unavailable(requestedMode, "Linux Secret Service requires a D-Bus user session.");
    }
    return available(requestedMode, selectedMode, "secret-tool");
  }

  return unavailable(requestedMode, "No supported secure credential provider exists for this host.");
}

export function createSecureCredentialStore(
  env: NodeJS.ProcessEnv = process.env,
  options: CredentialStoreOptions = {},
): SecureCredentialStore {
  const selection = resolveCredentialStore(env, options);
  const runner = options.runCommand ?? runCredentialCommand;
  if (!selection.available || !selection.command && selection.provider !== "ephemeral-memory") {
    return new UnavailableCredentialStore(selection);
  }

  switch (selection.provider) {
    case "windows-credential-manager":
      return new WindowsCredentialManagerStore(selection.command!, runner, selection.requestedMode);
    case "macos-keychain":
      return new MacOsKeychainCredentialStore(selection.command!, runner, selection.requestedMode);
    case "linux-secret-service":
      return new LinuxSecretServiceCredentialStore(selection.command!, runner, selection.requestedMode);
    case "ephemeral-memory":
      return new EphemeralMemoryCredentialStore(selection.requestedMode, selection.diagnostics);
    default:
      return new UnavailableCredentialStore(selection);
  }
}

export class LinuxSecretServiceCredentialStore implements SecureCredentialStore {
  readonly provider = "linux-secret-service" as const;
  readonly persistent = true;

  constructor(
    private readonly command = "secret-tool",
    private readonly runner: CredentialCommandRunner = runCredentialCommand,
    private readonly requestedMode = "auto",
  ) {}

  async probe(): Promise<CredentialStoreProbe> {
    return operationalProbe(this.requestedMode, this.provider, this.persistent, this.command);
  }

  async get(handle: string): Promise<string | undefined> {
    assertCredentialHandle(handle);
    const result = await this.run("read", ["lookup", "service", KEYRING_SERVICE, "account", handle]);
    if (result.exitCode === 0) return result.stdout.trim() || undefined;
    if (!result.stderr.trim() || /not found|no such|no matching/iu.test(result.stderr)) return undefined;
    throw credentialStoreError(this.provider, "read");
  }

  async set(handle: string, secret: string): Promise<void> {
    assertCredentialHandle(handle);
    const result = await this.run(
      "write",
      ["store", `--label=${KEYRING_SERVICE}`, "service", KEYRING_SERVICE, "account", handle],
      secret,
    );
    if (result.exitCode !== 0) throw credentialStoreError(this.provider, "write");
  }

  async delete(handle: string): Promise<void> {
    assertCredentialHandle(handle);
    if (await this.get(handle) === undefined) return;
    const result = await this.run("delete", ["clear", "service", KEYRING_SERVICE, "account", handle]);
    if (result.exitCode !== 0) throw credentialStoreError(this.provider, "delete");
  }

  private async run(operation: string, args: string[], input?: string): Promise<CredentialCommandResult> {
    try {
      return await this.runner(this.command, args, input);
    } catch {
      throw credentialStoreError(this.provider, operation);
    }
  }
}

export class MacOsKeychainCredentialStore implements SecureCredentialStore {
  readonly provider = "macos-keychain" as const;
  readonly persistent = true;

  constructor(
    private readonly command = "security",
    private readonly runner: CredentialCommandRunner = runCredentialCommand,
    private readonly requestedMode = "auto",
  ) {}

  async probe(): Promise<CredentialStoreProbe> {
    return operationalProbe(this.requestedMode, this.provider, this.persistent, this.command);
  }

  async get(handle: string): Promise<string | undefined> {
    assertCredentialHandle(handle);
    const result = await this.run("read", ["find-generic-password", "-s", KEYRING_SERVICE, "-a", handle, "-w"]);
    if (result.exitCode === 0) return result.stdout.trim() || undefined;
    if (result.exitCode === 44 || /could not be found|not found/iu.test(result.stderr)) return undefined;
    throw credentialStoreError(this.provider, "read");
  }

  async set(handle: string, secret: string): Promise<void> {
    assertCredentialHandle(handle);
    const passwordHex = Buffer.from(secret, "utf8").toString("hex");
    const result = await this.run(
      "write",
      ["-i"],
      `add-generic-password -U -s "${KEYRING_SERVICE}" -a "${handle}" -X ${passwordHex}\n`,
    );
    if (result.exitCode !== 0) throw credentialStoreError(this.provider, "write");
  }

  async delete(handle: string): Promise<void> {
    assertCredentialHandle(handle);
    const result = await this.run("delete", ["delete-generic-password", "-s", KEYRING_SERVICE, "-a", handle]);
    if (result.exitCode !== 0
      && result.exitCode !== 44
      && !/could not be found|not found/iu.test(result.stderr)) {
      throw credentialStoreError(this.provider, "delete");
    }
  }

  private async run(operation: string, args: string[], input?: string): Promise<CredentialCommandResult> {
    try {
      return await this.runner(this.command, args, input);
    } catch {
      throw credentialStoreError(this.provider, operation);
    }
  }
}

export class WindowsCredentialManagerStore implements SecureCredentialStore {
  readonly provider = "windows-credential-manager" as const;
  readonly persistent = true;

  constructor(
    private readonly command = "powershell.exe",
    private readonly runner: CredentialCommandRunner = runCredentialCommand,
    private readonly requestedMode = "auto",
  ) {}

  async probe(): Promise<CredentialStoreProbe> {
    return operationalProbe(this.requestedMode, this.provider, this.persistent, this.command);
  }

  async get(handle: string): Promise<string | undefined> {
    assertCredentialHandle(handle);
    const result = await this.invoke("read", handle);
    if (result.exitCode === 0) return result.stdout.trim() || undefined;
    throw credentialStoreError(this.provider, "read");
  }

  async set(handle: string, secret: string): Promise<void> {
    assertCredentialHandle(handle);
    const result = await this.invoke("write", handle, secret);
    if (result.exitCode !== 0) throw credentialStoreError(this.provider, "write");
  }

  async delete(handle: string): Promise<void> {
    assertCredentialHandle(handle);
    const result = await this.invoke("delete", handle);
    if (result.exitCode !== 0) throw credentialStoreError(this.provider, "delete");
  }

  private async invoke(operation: "read" | "write" | "delete", handle: string, secret?: string): Promise<CredentialCommandResult> {
    const input = JSON.stringify({ operation, target: `${KEYRING_SERVICE}:${handle}`, secret });
    try {
      return await this.runner(
        this.command,
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", WINDOWS_CREDENTIAL_SCRIPT_BASE64],
        input,
      );
    } catch {
      throw credentialStoreError(this.provider, operation);
    }
  }
}

export class EphemeralMemoryCredentialStore implements SecureCredentialStore {
  readonly provider = "ephemeral-memory" as const;
  readonly persistent = false;
  private readonly values = new Map<string, string>();

  constructor(private readonly requestedMode = "memory", private readonly diagnostics: string[] = []) {}

  async probe(): Promise<CredentialStoreProbe> {
    return {
      requestedMode: this.requestedMode,
      provider: this.provider,
      persistent: false,
      available: true,
      operational: true,
      diagnostics: [...this.diagnostics],
    };
  }

  async get(handle: string): Promise<string | undefined> { assertCredentialHandle(handle); return this.values.get(handle); }
  async set(handle: string, secret: string): Promise<void> { assertCredentialHandle(handle); this.values.set(handle, secret); }
  async delete(handle: string): Promise<void> { assertCredentialHandle(handle); this.values.delete(handle); }
}

class UnavailableCredentialStore implements SecureCredentialStore {
  readonly provider = "unavailable" as const;
  readonly persistent = false;

  constructor(private readonly selection: CredentialStoreSelection) {}

  async probe(): Promise<CredentialStoreProbe> {
    return { ...this.selection, operational: false };
  }

  async get(): Promise<undefined> { throw this.error(); }
  async set(): Promise<void> { throw this.error(); }
  async delete(): Promise<void> { throw this.error(); }

  private error(): Error {
    return new Error(this.selection.diagnostics[0] ?? "No secure ContentTraker credential provider is available.");
  }
}

export function createCredentialHandle(cacheKey: string): string {
  return `delegated-${createHash("sha256").update(cacheKey).digest("hex")}`;
}

function assertCredentialHandle(handle: string): void {
  if (!/^delegated-[a-f0-9]{64}$/u.test(handle)) {
    throw new Error("ContentTraker credential handle is invalid.");
  }
}

export async function withCredentialStoreLock<T>(handle: string, action: () => Promise<T>): Promise<T> {
  assertCredentialHandle(handle);

  const lockPath = path.join(os.tmpdir(), `contenttraker-codex-${handle}.lock`);
  const deadline = Date.now() + 15_000;
  let lockFile: Awaited<ReturnType<typeof open>> | undefined;
  while (!lockFile) {
    try {
      lockFile = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (!isFileExistsError(error)) throw new Error("ContentTraker credential rotation lock could not be created.");
      try {
        const existing = await stat(lockPath);
        if (Date.now() - existing.mtimeMs > 120_000) await unlink(lockPath);
      } catch (inspectionError) {
        if (!isFileNotFoundError(inspectionError)) {
          throw new Error("ContentTraker credential rotation lock could not be inspected.");
        }
      }
      if (Date.now() >= deadline) throw new Error("ContentTraker credential rotation lock timed out.");
      await delay(25);
    }
  }

  const acquiredIdentity = await lockFile.stat();
  try {
    return await action();
  } finally {
    await lockFile.close().catch(() => undefined);
    try {
      const currentIdentity = await stat(lockPath);
      if (currentIdentity.dev === acquiredIdentity.dev
        && currentIdentity.ino === acquiredIdentity.ino
        && currentIdentity.birthtimeMs === acquiredIdentity.birthtimeMs) {
        await unlink(lockPath);
      }
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        // The lock is advisory; never replace the action result with cleanup diagnostics.
      }
    }
  }
}

function available(
  requestedMode: string,
  provider: Exclude<CredentialStoreProvider, "ephemeral-memory" | "unavailable">,
  command: string,
): CredentialStoreSelection {
  return { requestedMode, provider, persistent: true, available: true, command, diagnostics: [] };
}

function unavailable(requestedMode: string, diagnostic: string): CredentialStoreSelection {
  return {
    requestedMode,
    provider: "unavailable",
    persistent: false,
    available: false,
    diagnostics: [diagnostic],
  };
}

function operationalProbe(
  requestedMode: string,
  provider: Exclude<CredentialStoreProvider, "ephemeral-memory" | "unavailable">,
  persistent: boolean,
  command: string,
): CredentialStoreProbe {
  return {
    requestedMode,
    provider,
    persistent,
    available: true,
    operational: true,
    command,
    diagnostics: ["Provider availability and unlocked state are verified by credential operations."],
  };
}

function credentialStoreError(provider: CredentialStoreProvider, operation: string): Error {
  return new Error(`ContentTraker ${provider} credential ${operation} failed.`);
}

function runCredentialCommand(command: string, args: string[], input?: string): Promise<CredentialCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", () => reject(new Error("ContentTraker credential helper could not start.")));
    child.once("close", (exitCode) => resolve({ exitCode: exitCode ?? 1, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
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

function isCredentialStoreMode(value: string): value is CredentialStoreMode {
  return CREDENTIAL_STORE_MODES.includes(value as CredentialStoreMode);
}

function isEnabled(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/iu.test(value?.trim() ?? "");
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const WINDOWS_CREDENTIAL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ContentTrakerCredentialApi {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credentialPtr);
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);
  [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
  [DllImport("advapi32.dll", EntryPoint="CredFree")]
  public static extern void CredFree(IntPtr credential);
}
'@
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($request.operation -eq 'read') {
  $pointer = [IntPtr]::Zero
  if (-not [ContentTrakerCredentialApi]::CredRead($request.target, 1, 0, [ref]$pointer)) {
    if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) { exit 0 }
    exit 1
  }
  try {
    $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [type][ContentTrakerCredentialApi+CREDENTIAL])
    [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringUni($credential.CredentialBlob, $credential.CredentialBlobSize / 2))
  } finally { [ContentTrakerCredentialApi]::CredFree($pointer) }
  exit 0
}
if ($request.operation -eq 'write') {
  $bytes = [Text.Encoding]::Unicode.GetBytes([string]$request.secret)
  $blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
  try {
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
    $credential = New-Object ContentTrakerCredentialApi+CREDENTIAL
    $credential.Type = 1
    $credential.TargetName = [string]$request.target
    $credential.CredentialBlobSize = $bytes.Length
    $credential.CredentialBlob = $blob
    $credential.Persist = 2
    $credential.UserName = 'ContentTraker'
    if (-not [ContentTrakerCredentialApi]::CredWrite([ref]$credential, 0)) { exit 1 }
  } finally {
    [Runtime.InteropServices.Marshal]::Copy((New-Object byte[] $bytes.Length), 0, $blob, $bytes.Length)
    [Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
  }
  exit 0
}
if ($request.operation -eq 'delete') {
  if (-not [ContentTrakerCredentialApi]::CredDelete($request.target, 1, 0)) {
    if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) { exit 0 }
    exit 1
  }
  exit 0
}
exit 1
`;

const WINDOWS_CREDENTIAL_SCRIPT_BASE64 = Buffer.from(WINDOWS_CREDENTIAL_SCRIPT, "utf16le").toString("base64");
