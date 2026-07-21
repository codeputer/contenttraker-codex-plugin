import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type BrowserMode = "auto" | "system" | "manual" | "wsl-native";
export type BrowserInteractionMode = "system-browser" | "manual-url" | "wsl-native" | "invalid";

export interface BrowserInteractionSelection {
  requestedMode: string;
  mode: BrowserInteractionMode;
  valid: boolean;
  command?: string;
  diagnostics: string[];
}

export interface BrowserLauncher {
  readonly mode: BrowserInteractionMode;
  open(url: URL): Promise<void>;
}

export interface BrowserInteractionOptions {
  platform?: NodeJS.Platform;
  kernelRelease?: string;
  commandAvailable?: (command: string) => boolean;
  spawnCommand?: (file: string, args: string[]) => Promise<void>;
}

const BROWSER_MODES: BrowserMode[] = ["auto", "system", "manual", "wsl-native"];
const WSL_NATIVE_BROWSERS = [
  "firefox",
  "firefox-esr",
  "google-chrome",
  "chromium",
  "chromium-browser",
  "microsoft-edge",
];

export function resolveBrowserInteraction(
  env: NodeJS.ProcessEnv = process.env,
  options: BrowserInteractionOptions = {},
): BrowserInteractionSelection {
  const requestedMode = env.CONTENTTRAKER_BROWSER_MODE?.trim().toLowerCase() || "auto";
  if (!isBrowserMode(requestedMode)) {
    return {
      requestedMode: "invalid",
      mode: "invalid",
      valid: false,
      diagnostics: [`CONTENTTRAKER_BROWSER_MODE must be one of: ${BROWSER_MODES.join(", ")}.`],
    };
  }

  const platform = options.platform ?? process.platform;
  const kernelRelease = options.kernelRelease ?? os.release();
  const commandAvailable = options.commandAvailable ?? ((command: string) => commandExists(command, env, platform));
  const isWsl = platform === "linux" && Boolean(
    env.WSL_DISTRO_NAME?.trim()
      || env.WSL_INTEROP?.trim()
      || /microsoft|wsl/iu.test(kernelRelease),
  );
  const graphicalSessionAvailable = platform === "linux"
    ? Boolean(env.DISPLAY?.trim() || env.WAYLAND_DISPLAY?.trim())
    : true;
  const nativeWslBrowser = isWsl && graphicalSessionAvailable
    ? WSL_NATIVE_BROWSERS.find((command) => commandAvailable(command))
    : undefined;

  if (requestedMode === "manual") {
    return { requestedMode, mode: "manual-url", valid: true, diagnostics: [] };
  }

  if (requestedMode === "wsl-native") {
    if (!isWsl) {
      return invalid(requestedMode, "CONTENTTRAKER_BROWSER_MODE=wsl-native is valid only inside WSL.");
    }
    if (!graphicalSessionAvailable) {
      return invalid(requestedMode, "WSL-native browser authorization requires DISPLAY or WAYLAND_DISPLAY.");
    }
    if (!nativeWslBrowser) {
      return invalid(requestedMode, "No supported Linux browser executable was found inside WSL.");
    }
    return { requestedMode, mode: "wsl-native", valid: true, command: nativeWslBrowser, diagnostics: [] };
  }

  if (requestedMode === "system") {
    if (isWsl) {
      return invalid(
        requestedMode,
        "CONTENTTRAKER_BROWSER_MODE=system is disabled inside WSL because xdg-open cannot prove that authorization remains inside Linux.",
      );
    }
    return systemSelection(requestedMode, platform, graphicalSessionAvailable, commandAvailable);
  }

  if (isWsl) {
    return nativeWslBrowser
      ? { requestedMode, mode: "wsl-native", valid: true, command: nativeWslBrowser, diagnostics: [] }
      : {
          requestedMode,
          mode: "manual-url",
          valid: true,
          diagnostics: [
            "No supported Linux browser executable was found inside WSL; manual authorization URL interaction was selected.",
          ],
        };
  }

  const system = systemSelection(requestedMode, platform, graphicalSessionAvailable, commandAvailable);
  return system.valid
    ? system
    : {
        requestedMode,
        mode: "manual-url",
        valid: true,
        diagnostics: [
          ...system.diagnostics,
          "Manual authorization URL interaction was selected because no supported system launcher is available.",
        ],
      };
}

export function createBrowserLauncher(
  env: NodeJS.ProcessEnv = process.env,
  options: BrowserInteractionOptions = {},
): BrowserLauncher {
  const selection = resolveBrowserInteraction(env, options);
  const spawnCommand = options.spawnCommand ?? spawnDetached;

  if (!selection.valid || selection.mode === "invalid") {
    return new FailingBrowserLauncher("invalid", selection.diagnostics[0] ?? "Browser interaction configuration is invalid.");
  }
  if (selection.mode === "manual-url") {
    return new FailingBrowserLauncher(
      "manual-url",
      "Manual authorization is configured. Call begin_contenttraker_authorization and open the returned URL inside the intended host boundary.",
    );
  }
  if (!selection.command) {
    return new FailingBrowserLauncher(selection.mode, "ContentTraker OAuth browser launch is unavailable.");
  }

  const platform = options.platform ?? process.platform;
  return new CommandBrowserLauncher(
    selection.mode,
    selection.command,
    platform === "win32" ? ["url.dll,FileProtocolHandler"] : [],
    spawnCommand,
  );
}

class CommandBrowserLauncher implements BrowserLauncher {
  constructor(
    readonly mode: BrowserInteractionMode,
    private readonly command: string,
    private readonly leadingArgs: string[],
    private readonly spawnCommand: (file: string, args: string[]) => Promise<void>,
  ) {}

  async open(url: URL): Promise<void> {
    await this.spawnCommand(this.command, [...this.leadingArgs, url.toString()]);
  }
}

class FailingBrowserLauncher implements BrowserLauncher {
  constructor(readonly mode: BrowserInteractionMode, private readonly reason: string) {}
  async open(): Promise<void> {
    throw new Error(this.reason);
  }
}

function systemSelection(
  requestedMode: string,
  platform: NodeJS.Platform,
  graphicalSessionAvailable: boolean,
  commandAvailable: (command: string) => boolean,
): BrowserInteractionSelection {
  const command = platform === "win32"
    ? "rundll32.exe"
    : platform === "darwin"
      ? "open"
      : platform === "linux"
        ? "xdg-open"
        : undefined;

  if (!command || !commandAvailable(command) || platform === "linux" && !graphicalSessionAvailable) {
    return invalid(requestedMode, "No supported system browser launcher was found for this host.");
  }
  return { requestedMode, mode: "system-browser", valid: true, command, diagnostics: [] };
}

function invalid(requestedMode: string, diagnostic: string): BrowserInteractionSelection {
  return { requestedMode, mode: "invalid", valid: false, diagnostics: [diagnostic] };
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

function spawnDetached(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", () => reject(new Error("ContentTraker OAuth browser launch failed.")));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function isBrowserMode(value: string): value is BrowserMode {
  return BROWSER_MODES.includes(value as BrowserMode);
}
