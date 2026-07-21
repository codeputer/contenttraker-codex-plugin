import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createCredentialHandle, createSecureCredentialStore } from "../src/credential-store.js";

const expected = process.env.CONTENTTRAKER_EXPECT_NATIVE_CREDENTIAL_STORE?.trim().toLowerCase();
if (!expected) {
  console.log("ContentTraker native credential-store verification skipped; no provider was requested.");
} else {
  assert.ok(
    expected === "windows-credential-manager" || expected === "macos-keychain" || expected === "linux-secret-service",
    "CONTENTTRAKER_EXPECT_NATIVE_CREDENTIAL_STORE is invalid.",
  );
  const store = createSecureCredentialStore({
    ...process.env,
    CI: "false",
    CONTENTTRAKER_CREDENTIAL_STORE: expected,
    CONTENTTRAKER_ENVIRONMENT: "staging",
  });
  assert.equal(store.provider, expected);
  assert.equal(store.persistent, true);
  const handle = createCredentialHandle(`native-verification-${randomUUID()}`);
  const secret = randomBytes(48).toString("base64url");
  try {
    await store.set(handle, secret);
    assert.equal(await store.get(handle), secret);
  } finally {
    await store.delete(handle);
  }
  assert.equal(await store.get(handle), undefined);
  console.log(`ContentTraker native credential-store verification passed for ${expected}; the temporary entry was deleted.`);
}
