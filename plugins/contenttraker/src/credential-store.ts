import { createHash } from "node:crypto";

const KEYRING_SERVICE = "ContentTraker Codex Adapter";

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(secret: string): void;
  deletePassword(): void;
}

let keyringModule: Promise<{ Entry: new (service: string, handle: string) => KeyringEntry }> | undefined;

export interface SecureCredentialStore {
  get(handle: string): Promise<string | undefined>;
  set(handle: string, secret: string): Promise<void>;
  delete(handle: string): Promise<void>;
}

export class OsKeyringCredentialStore implements SecureCredentialStore {
  async get(handle: string): Promise<string | undefined> {
    try {
      return (await createEntry(handle)).getPassword() ?? undefined;
    } catch (error) {
      throw credentialStoreError("read", error);
    }
  }

  async set(handle: string, secret: string): Promise<void> {
    try {
      (await createEntry(handle)).setPassword(secret);
    } catch (error) {
      throw credentialStoreError("write", error);
    }
  }

  async delete(handle: string): Promise<void> {
    try {
      (await createEntry(handle)).deletePassword();
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      if (!message.includes("not found") && !message.includes("no entry")) {
        throw credentialStoreError("delete", error);
      }
    }
  }
}

async function createEntry(handle: string): Promise<KeyringEntry> {
  try {
    keyringModule ??= import("@napi-rs/keyring") as Promise<{
      Entry: new (service: string, handle: string) => KeyringEntry;
    }>;
    const { Entry } = await keyringModule;
    return new Entry(KEYRING_SERVICE, handle);
  } catch (error) {
    throw credentialStoreError("load", error);
  }
}

export function createCredentialHandle(cacheKey: string): string {
  return `delegated-${createHash("sha256").update(cacheKey).digest("hex")}`;
}

function credentialStoreError(operation: string, error: unknown): Error {
  const reason = error instanceof Error ? error.name : "unknown-error";
  return new Error(`OS keyring ${operation} failed (${reason}).`);
}
