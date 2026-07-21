import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const KEYRING_SERVICE = "ContentTraker Codex Adapter";

export interface SecureCredentialStore {
  get(handle: string): Promise<string | undefined>;
  set(handle: string, secret: string): Promise<void>;
  delete(handle: string): Promise<void>;
}

export class OsKeyringCredentialStore implements SecureCredentialStore {
  async get(handle: string): Promise<string | undefined> {
    try {
      const result = await runSecretTool(["lookup", "service", KEYRING_SERVICE, "account", handle]);
      return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
    } catch (error) {
      throw credentialStoreError("read", error);
    }
  }

  async set(handle: string, secret: string): Promise<void> {
    try {
      const result = await runSecretTool(
        ["store", `--label=${KEYRING_SERVICE}`, "service", KEYRING_SERVICE, "account", handle],
        secret,
      );
      if (result.exitCode !== 0) throw new Error("Linux Secret Service rejected the credential write.");
    } catch (error) {
      throw credentialStoreError("write", error);
    }
  }

  async delete(handle: string): Promise<void> {
    try {
      await runSecretTool(["clear", "service", KEYRING_SERVICE, "account", handle]);
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      if (!message.includes("not found") && !message.includes("no entry")) {
        throw credentialStoreError("delete", error);
      }
    }
  }
}

export function createCredentialHandle(cacheKey: string): string {
  return `delegated-${createHash("sha256").update(cacheKey).digest("hex")}`;
}

function credentialStoreError(operation: string, error: unknown): Error {
  if (error instanceof Error && error.message.startsWith("Linux Secret Service")) return error;
  const reason = error instanceof Error ? error.name : "unknown-error";
  return new Error(`OS keyring ${operation} failed (${reason}).`);
}

function runSecretTool(args: string[], input?: string): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("secret-tool", args, { stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.once("error", () => reject(new Error("Linux Secret Service tool is unavailable.")));
    child.once("close", (exitCode) => resolve({ exitCode: exitCode ?? 1, stdout }));
    child.stdin.end(input ?? "");
  });
}
