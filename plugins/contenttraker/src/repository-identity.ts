import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { RepositoryWorktreeIdentity } from "./types.js";

export const WORKTREE_CONTEXT_RELATIVE_PATH = ".contenttraker-codex/context.json";

const PRIVATE_EXCLUDE_PATTERNS = [
  "/.contenttraker-codex/context.json",
  "/.contenttraker-codex/context.json.*.tmp",
];

export function resolveGitWorktreeIdentity(repositoryRoot: string): RepositoryWorktreeIdentity {
  if (!repositoryRoot?.trim()) {
    throw new Error("repository_root_required_for_durable_context: repositoryRoot is required.");
  }

  const requestedRoot = path.resolve(repositoryRoot);
  const gitRoot = gitOutput(requestedRoot, ["rev-parse", "--show-toplevel"]);
  const canonicalRoot = realpathExisting(gitRoot);
  const remoteUrl = gitOutput(canonicalRoot, ["remote", "get-url", "origin"]);
  const repositoryIdentity = normalizeRepositoryRemote(remoteUrl);
  const gitDirectory = resolveGitPath(canonicalRoot, "--git-dir");
  const gitCommonDirectory = resolveGitPath(canonicalRoot, "--git-common-dir");
  const excludePath = gitOutput(canonicalRoot, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "info/exclude",
  ]);
  const fingerprintSource = [
    repositoryIdentity,
    normalizeFilesystemIdentity(canonicalRoot),
    normalizeFilesystemIdentity(gitDirectory),
  ].join("\n");

  return {
    repositoryRoot: canonicalRoot,
    repositoryIdentity,
    worktreeId: `sha256:${createHash("sha256").update(fingerprintSource).digest("hex")}`,
    gitDirectory,
    gitCommonDirectory,
    excludePath: path.resolve(excludePath),
  };
}

export function ensureWorktreeContextIgnored(identity: RepositoryWorktreeIdentity): void {
  const markerPath = path.join(identity.repositoryRoot, WORKTREE_CONTEXT_RELATIVE_PATH);
  assertWorktreeContextUntracked(identity);
  fs.mkdirSync(path.dirname(identity.excludePath), { recursive: true });
  const existing = fs.existsSync(identity.excludePath)
    ? fs.readFileSync(identity.excludePath, "utf8")
    : "";
  const existingLines = new Set(existing.split(/\r?\n/u).map((line) => line.trim()));
  const missing = PRIVATE_EXCLUDE_PATTERNS.filter((pattern) => !existingLines.has(pattern));

  if (missing.length > 0) {
    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    const next = `${existing}${separator}${missing.join("\n")}\n`;
    writeTextAtomic(identity.excludePath, next);
  }

  const ignored = spawnSync(
    "git",
    ["-C", identity.repositoryRoot, "check-ignore", "--no-index", "-q", "--", markerPath],
    { encoding: "utf8", windowsHide: true },
  );
  if (ignored.status !== 0) {
    throw new Error(
      "private_exclude_verification_failed: Git did not confirm that .contenttraker-codex/context.json is ignored.",
    );
  }
}

export function assertWorktreeContextUntracked(identity: RepositoryWorktreeIdentity): void {
  const tracked = spawnSync(
    "git",
    ["-C", identity.repositoryRoot, "ls-files", "--error-unmatch", "--", WORKTREE_CONTEXT_RELATIVE_PATH],
    { encoding: "utf8", windowsHide: true },
  );
  if (tracked.status === 0) {
    throw new Error(
      "tracked_context_marker_rejected: .contenttraker-codex/context.json is tracked by Git; durable context must remain local-only.",
    );
  }
  if (tracked.error) {
    throw tracked.error;
  }
  if (tracked.status !== 1) {
    throw new Error(
      "tracked_context_marker_check_failed: Git could not verify that .contenttraker-codex/context.json is untracked.",
    );
  }
}

export function normalizeRepositoryRemote(remoteUrl: string): string {
  const value = remoteUrl.trim().replace(/[?#].*$/u, "").replace(/\\/gu, "/");
  let repositoryPath: string;

  if (/^[^@/\s]+@[^:/\s]+:/u.test(value)) {
    repositoryPath = value.slice(value.indexOf(":") + 1);
  } else {
    try {
      const parsed = new URL(value.includes("://") ? value : `https://${value}`);
      repositoryPath = parsed.pathname;
    } catch {
      throw new Error("repository_identity_invalid: remote.origin could not be normalized to owner/repository.");
    }
  }

  const parts = repositoryPath
    .replace(/^\/+/u, "")
    .replace(/\.git$/iu, "")
    .split("/")
    .filter(Boolean);
  if (parts.length < 2) {
    throw new Error("repository_identity_invalid: remote.origin must identify an owner/repository.");
  }

  return `${parts.at(-2)}/${parts.at(-1)}`.toLocaleLowerCase();
}

function resolveGitPath(repositoryRoot: string, argument: "--git-dir" | "--git-common-dir"): string {
  const value = gitOutput(repositoryRoot, ["rev-parse", argument]);
  const absolute = path.isAbsolute(value) ? value : path.resolve(repositoryRoot, value);
  return realpathExisting(absolute);
}

function gitOutput(repositoryRoot: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", repositoryRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }).trim();
  } catch {
    throw new Error(
      `repository_identity_unavailable: '${repositoryRoot}' is not an accessible Git worktree with an origin remote.`,
    );
  }
}

function realpathExisting(value: string): string {
  try {
    return fs.realpathSync.native(path.resolve(value));
  } catch {
    throw new Error(`repository_identity_unavailable: '${path.resolve(value)}' does not exist.`);
  }
}

function normalizeFilesystemIdentity(value: string): string {
  const normalized = path.normalize(value).replace(/\\/gu, "/");
  return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}

function writeTextAtomic(targetPath: string, content: string): void {
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: number | undefined;
  try {
    handle = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(handle, content, "utf8");
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.renameSync(temporaryPath, targetPath);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
  }
}
