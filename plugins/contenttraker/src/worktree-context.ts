import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  assertWorktreeContextUntracked,
  ensureWorktreeContextIgnored,
  WORKTREE_CONTEXT_RELATIVE_PATH,
} from "./repository-identity.js";
import { normalizeContentKeeperAliases } from "./contentkeeper-id.js";
import type {
  ContentTrakerEnvironment,
  RepositoryWorktreeIdentity,
  WorktreeContextBinding,
  WorktreeContextDocument,
  WorktreeContextReset,
  WorktreeContextSnapshot,
} from "./types.js";

const MAX_MARKER_BYTES = 128 * 1024;
const DOCUMENT_KEYS = new Set(["schemaVersion", "contexts", "resets"]);
const BINDING_KEYS = new Set([
  "environment",
  "repositoryIdentity",
  "worktreeId",
  "contentKeeperId",
  "workspaceId",
  "workspaceKey",
  "workspaceName",
  "projectId",
  "projectKey",
  "projectName",
  "confirmationState",
  "confirmedAtUtc",
  "pluginName",
  "pluginVersion",
]);
const RESET_KEYS = new Set([
  "environment",
  "repositoryIdentity",
  "worktreeId",
  "resetAtUtc",
]);
const SECRET_LIKE_FIELD = /^(?:accessToken|refreshToken|token|clientSecret|secret|password|credential|authorization|bearer|cookie|keyring|apiKey|privateKey)$/iu;

export function worktreeContextPath(identity: RepositoryWorktreeIdentity): string {
  return path.join(identity.repositoryRoot, WORKTREE_CONTEXT_RELATIVE_PATH);
}

export function loadWorktreeContext(
  identity: RepositoryWorktreeIdentity,
  environment: ContentTrakerEnvironment,
): WorktreeContextSnapshot {
  const markerPath = worktreeContextPath(identity);
  try {
    assertSafeMarkerLocation(identity, markerPath);
    if (!fs.existsSync(markerPath)) {
      return {
        path: markerPath,
        exists: false,
        loaded: false,
        blocked: false,
        diagnostics: [],
      };
    }
    assertWorktreeContextUntracked(identity);
    const stats = fs.statSync(markerPath);
    if (!stats.isFile() || stats.size > MAX_MARKER_BYTES) {
      throw new Error("context_marker_invalid: marker must be a regular JSON file no larger than 128 KiB.");
    }
    const parsed = JSON.parse(fs.readFileSync(markerPath, "utf8")) as unknown;
    const document = parseDocument(parsed, identity);
    const binding = document.contexts[environment];
    const reset = document.resets[environment];
    if (binding && reset) {
      throw new Error(
        `context_marker_invalid: '${environment}' cannot contain both a confirmed context and a reset tombstone.`,
      );
    }
    return {
      path: markerPath,
      exists: true,
      loaded: true,
      binding,
      reset,
      blocked: false,
      diagnostics: [],
      document,
    };
  } catch (error) {
    return {
      path: markerPath,
      exists: fs.existsSync(markerPath),
      loaded: false,
      blocked: true,
      diagnostics: [safeMarkerDiagnostic(error)],
    };
  }
}

export function writeConfirmedWorktreeContext(
  identity: RepositoryWorktreeIdentity,
  binding: WorktreeContextBinding,
  options: { repairMalformed?: boolean } = {},
): string {
  const markerPath = worktreeContextPath(identity);
  assertSafeMarkerLocation(identity, markerPath);
  ensureWorktreeContextIgnored(identity);
  const snapshot = loadWorktreeContext(identity, binding.environment);
  if (snapshot.blocked && !options.repairMalformed) {
    throw new Error(snapshot.diagnostics[0]);
  }
  const recovery = snapshot.blocked && options.repairMalformed
    ? recoverOtherEnvironmentForReplacement(markerPath, identity, binding.environment)
    : undefined;
  const document = snapshot.document ?? recovery?.document ?? emptyDocument();
  document.contexts[binding.environment] = binding;
  delete document.resets[binding.environment];
  writeDocumentAtomic(markerPath, document);
  return markerPath;
}

export function resetWorktreeContextBinding(
  identity: RepositoryWorktreeIdentity,
  environment: ContentTrakerEnvironment,
  resetAtUtc = new Date().toISOString(),
): {
  markerPath: string;
  bindingCleared: boolean;
  invalidMarkerReplaced: boolean;
  otherEnvironmentsPreserved: boolean;
  tombstone: WorktreeContextReset;
} {
  const markerPath = worktreeContextPath(identity);
  assertSafeMarkerLocation(identity, markerPath);
  ensureWorktreeContextIgnored(identity);
  const snapshot = loadWorktreeContext(identity, environment);
  const invalidMarkerReplaced = snapshot.blocked
    && snapshot.diagnostics.every((diagnostic) =>
      diagnostic.startsWith("context_marker_invalid:")
      || diagnostic.startsWith("context_marker_schema_mismatch:")
      || diagnostic.startsWith("context_marker_secret_field_rejected:"));
  if (snapshot.blocked && !invalidMarkerReplaced) {
    throw new Error(
      `context_marker_reset_blocked: ${snapshot.diagnostics[0]}`,
    );
  }
  const recovery = invalidMarkerReplaced
    ? recoverOtherEnvironmentForReplacement(markerPath, identity, environment)
    : undefined;
  const document = snapshot.document ?? recovery?.document ?? emptyDocument();
  const bindingCleared = recovery?.targetBindingPresent
    ?? Boolean(document.contexts[environment]);
  delete document.contexts[environment];
  delete document.resets[environment];
  const tombstone: WorktreeContextReset = {
    environment,
    repositoryIdentity: identity.repositoryIdentity,
    worktreeId: identity.worktreeId,
    resetAtUtc,
  };
  document.resets[environment] = tombstone;
  writeDocumentAtomic(markerPath, document);
  return {
    markerPath,
    bindingCleared,
    invalidMarkerReplaced,
    otherEnvironmentsPreserved: recovery?.otherEnvironmentsPreserved ?? true,
    tombstone,
  };
}

export function emptyDocument(): WorktreeContextDocument {
  return {
    schemaVersion: 2,
    contexts: {},
    resets: {},
  };
}

function parseDocument(
  value: unknown,
  identity: RepositoryWorktreeIdentity,
): WorktreeContextDocument {
  assertNoSecretLikeFields(value);
  const record = requireRecord(value, "context marker");
  assertOnlyKeys(record, DOCUMENT_KEYS, "context marker");
  if (record.schemaVersion !== 1 && record.schemaVersion !== 2) {
    throw new Error("context_marker_schema_mismatch: schemaVersion must be 1 or 2.");
  }
  const sourceSchemaVersion = record.schemaVersion;
  const contextsRecord = requireEnvironmentMap(record.contexts, "contexts");
  const resetsRecord = requireEnvironmentMap(record.resets, "resets");
  const contexts: WorktreeContextDocument["contexts"] = {};
  const resets: WorktreeContextDocument["resets"] = {};

  for (const environment of ["staging", "production"] as const) {
    if (contextsRecord[environment] !== undefined) {
      contexts[environment] = parseBinding(
        contextsRecord[environment],
        environment,
        identity,
        sourceSchemaVersion,
      );
    }
    if (resetsRecord[environment] !== undefined) {
      resets[environment] = parseReset(resetsRecord[environment], environment, identity);
    }
  }

  return { schemaVersion: 2, contexts, resets };
}

function recoverOtherEnvironmentForReplacement(
  markerPath: string,
  identity: RepositoryWorktreeIdentity,
  targetEnvironment: ContentTrakerEnvironment,
): {
  document: WorktreeContextDocument;
  targetBindingPresent: boolean;
  otherEnvironmentsPreserved: boolean;
} {
  const empty = {
    document: emptyDocument(),
    targetBindingPresent: false,
    otherEnvironmentsPreserved: false,
  };
  let parsed: unknown;
  try {
    const stats = fs.lstatSync(markerPath);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.size > MAX_MARKER_BYTES) {
      return empty;
    }
    parsed = JSON.parse(fs.readFileSync(markerPath, "utf8")) as unknown;
    assertNoSecretLikeFields(parsed);
    const record = requireRecord(parsed, "context marker");
    assertOnlyKeys(record, DOCUMENT_KEYS, "context marker");
    if (record.schemaVersion !== 1 && record.schemaVersion !== 2) return empty;
    const sourceSchemaVersion = record.schemaVersion;
    const contextsRecord = requireEnvironmentMap(record.contexts, "contexts");
    const resetsRecord = requireEnvironmentMap(record.resets, "resets");
    const otherEnvironment: ContentTrakerEnvironment =
      targetEnvironment === "staging" ? "production" : "staging";
    const document = emptyDocument();
    const otherBinding = contextsRecord[otherEnvironment];
    const otherReset = resetsRecord[otherEnvironment];
    if (otherBinding !== undefined && otherReset !== undefined) {
      return {
        document,
        targetBindingPresent: contextsRecord[targetEnvironment] !== undefined,
        otherEnvironmentsPreserved: false,
      };
    }
    if (otherBinding !== undefined) {
      document.contexts[otherEnvironment] = parseBinding(
        otherBinding,
        otherEnvironment,
        identity,
        sourceSchemaVersion,
      );
    }
    if (otherReset !== undefined) {
      document.resets[otherEnvironment] = parseReset(
        otherReset,
        otherEnvironment,
        identity,
      );
    }
    return {
      document,
      targetBindingPresent: contextsRecord[targetEnvironment] !== undefined,
      otherEnvironmentsPreserved: true,
    };
  } catch {
    return empty;
  }
}

function parseBinding(
  value: unknown,
  environment: ContentTrakerEnvironment,
  identity: RepositoryWorktreeIdentity,
  sourceSchemaVersion: 1 | 2,
): WorktreeContextBinding {
  const record = requireRecord(value, `${environment} context`);
  assertOnlyKeys(record, BINDING_KEYS, `${environment} context`);
  const aliases = normalizeContentKeeperAliases({
    contentKeeperId: optionalString(record.contentKeeperId, "contentKeeperId"),
    workspaceId: optionalString(record.workspaceId, "workspaceId"),
  });
  if (aliases.diagnostic) {
    throw new Error(`context_marker_invalid: ${aliases.diagnostic}`);
  }
  if (!aliases.contentKeeperId || (sourceSchemaVersion === 2 && !record.contentKeeperId)) {
    throw new Error(
      sourceSchemaVersion === 1
        ? "context_marker_invalid: workspaceId must be a non-empty string."
        : "context_marker_invalid: contentKeeperId must be a non-empty string.",
    );
  }
  const binding: WorktreeContextBinding = {
    environment: requiredLiteral(record.environment, environment, "environment"),
    repositoryIdentity: requiredString(record.repositoryIdentity, "repositoryIdentity"),
    worktreeId: requiredString(record.worktreeId, "worktreeId"),
    contentKeeperId: aliases.contentKeeperId,
    workspaceId: aliases.workspaceId!,
    workspaceKey: optionalString(record.workspaceKey, "workspaceKey"),
    workspaceName: optionalString(record.workspaceName, "workspaceName"),
    projectId: optionalString(record.projectId, "projectId"),
    projectKey: optionalString(record.projectKey, "projectKey"),
    projectName: optionalString(record.projectName, "projectName"),
    confirmationState: requiredLiteral(
      record.confirmationState,
      "human-confirmed",
      "confirmationState",
    ),
    confirmedAtUtc: requiredUtcTimestamp(record.confirmedAtUtc, "confirmedAtUtc"),
    pluginName: requiredString(record.pluginName, "pluginName"),
    pluginVersion: requiredString(record.pluginVersion, "pluginVersion"),
  };
  assertIdentity(binding.repositoryIdentity, binding.worktreeId, identity);
  return binding;
}

function parseReset(
  value: unknown,
  environment: ContentTrakerEnvironment,
  identity: RepositoryWorktreeIdentity,
): WorktreeContextReset {
  const record = requireRecord(value, `${environment} reset`);
  assertOnlyKeys(record, RESET_KEYS, `${environment} reset`);
  const reset: WorktreeContextReset = {
    environment: requiredLiteral(record.environment, environment, "environment"),
    repositoryIdentity: requiredString(record.repositoryIdentity, "repositoryIdentity"),
    worktreeId: requiredString(record.worktreeId, "worktreeId"),
    resetAtUtc: requiredUtcTimestamp(record.resetAtUtc, "resetAtUtc"),
  };
  assertIdentity(reset.repositoryIdentity, reset.worktreeId, identity);
  return reset;
}

function assertIdentity(
  repositoryIdentity: string,
  worktreeId: string,
  identity: RepositoryWorktreeIdentity,
): void {
  if (repositoryIdentity.toLocaleLowerCase() !== identity.repositoryIdentity.toLocaleLowerCase()) {
    throw new Error(
      `context_marker_repository_mismatch: marker belongs to '${repositoryIdentity}', not '${identity.repositoryIdentity}'.`,
    );
  }
  if (worktreeId !== identity.worktreeId) {
    throw new Error("context_marker_worktree_mismatch: marker was created for a different worktree.");
  }
}

function requireEnvironmentMap(value: unknown, name: string): Record<string, unknown> {
  const record = requireRecord(value, name);
  for (const key of Object.keys(record)) {
    if (key !== "staging" && key !== "production") {
      throw new Error(`context_marker_invalid: ${name} contains unsupported environment '${key}'.`);
    }
  }
  return record;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`context_marker_invalid: ${name} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: Set<string>, name: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`context_marker_invalid: ${name} contains unsupported fields.`);
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`context_marker_invalid: ${name} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, name);
}

function requiredLiteral<T extends string>(value: unknown, literal: T, name: string): T {
  if (value !== literal) {
    throw new Error(`context_marker_invalid: ${name} must be '${literal}'.`);
  }
  return literal;
}

function requiredUtcTimestamp(value: unknown, name: string): string {
  const timestamp = requiredString(value, name);
  if (!timestamp.endsWith("Z") || Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`context_marker_invalid: ${name} must be an ISO 8601 UTC timestamp.`);
  }
  return timestamp;
}

function assertNoSecretLikeFields(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecretLikeFields(item);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_LIKE_FIELD.test(key)) {
      throw new Error("context_marker_secret_field_rejected: secret, token, or credential fields are forbidden.");
    }
    assertNoSecretLikeFields(child);
  }
}

function assertSafeMarkerLocation(
  identity: RepositoryWorktreeIdentity,
  markerPath: string,
): void {
  const directoryPath = path.dirname(markerPath);
  if (fs.existsSync(directoryPath) && fs.lstatSync(directoryPath).isSymbolicLink()) {
    throw new Error("context_marker_symlink_rejected: .contenttraker-codex must not be a symbolic link.");
  }
  if (fs.existsSync(markerPath) && fs.lstatSync(markerPath).isSymbolicLink()) {
    throw new Error("context_marker_symlink_rejected: context.json must not be a symbolic link.");
  }
  const relative = path.relative(identity.repositoryRoot, markerPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("context_marker_path_escape_rejected: marker path leaves the selected worktree.");
  }
}

function writeDocumentAtomic(targetPath: string, document: WorktreeContextDocument): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: number | undefined;
  try {
    handle = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(handle, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.renameSync(temporaryPath, targetPath);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
  }
}

function safeMarkerDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("context_marker_")) return message;
  return "context_marker_invalid: context.json is malformed or unreadable; no registry fallback was used.";
}
