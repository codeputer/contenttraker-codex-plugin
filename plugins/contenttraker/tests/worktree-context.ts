import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ContentTrakerApiClient } from "../src/contenttraker-api-client.js";
import { resolveOperationContext } from "../src/context-resolution.js";
import {
  ensureWorktreeContextIgnored,
  normalizeRepositoryRemote,
  resolveGitWorktreeIdentity,
  WORKTREE_CONTEXT_RELATIVE_PATH,
} from "../src/repository-identity.js";
import { confirmContentTrakerContext } from "../src/tools/confirm-contenttraker-context.js";
import { resetContentTrakerContext } from "../src/tools/reset-contenttraker-context.js";
import { getDigitalAsset } from "../src/tools/get-digital-asset.js";
import type {
  ApiClientStatus,
  AuthorizedContextResolutionResult,
  ContentTrakerContext,
  ContentTrakerEnvironment,
  ContentTrakerRequestSecurityContext,
  RepositoryWorktreeIdentity,
  WorktreeContextBinding,
  WorktreeContextDocument,
} from "../src/types.js";
import {
  loadWorktreeContext,
  resetWorktreeContextBinding,
  worktreeContextPath,
  writeConfirmedWorktreeContext,
} from "../src/worktree-context.js";

interface SelectableProject {
  id: string;
  key?: string;
  name?: string;
}

interface SelectableWorkspace {
  id: string;
  key?: string;
  name?: string;
  projects?: SelectableProject[];
}

const originalEnvironment = { ...process.env };
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "contenttraker-worktree-context-"));

async function run(): Promise<void> {
  try {
    process.env.CONTENTTRAKER_ENVIRONMENT = "staging";

    normalizeRepositoryRemotes();

    const primaryRoot = createRepository(
      path.join(temporaryRoot, "primary"),
      "https://github.com/Example/Context-Test.git",
    );
    const secondaryRoot = path.join(temporaryRoot, "secondary");
    git(primaryRoot, ["worktree", "add", "-b", "secondary-context-test", secondaryRoot]);
    const primaryIdentity = resolveGitWorktreeIdentity(primaryRoot);
    const secondaryIdentity = resolveGitWorktreeIdentity(secondaryRoot);

    assert.equal(primaryIdentity.repositoryIdentity, "example/context-test");
    assert.equal(secondaryIdentity.repositoryIdentity, primaryIdentity.repositoryIdentity);
    assert.notEqual(secondaryIdentity.worktreeId, primaryIdentity.worktreeId);
    assert.equal(secondaryIdentity.excludePath, primaryIdentity.excludePath);

    const registryPath = path.join(temporaryRoot, "workspace-registry.json");
    process.env.CONTENTTRAKER_CODEX_REGISTRY = registryPath;
    writeRegistry(registryPath, primaryRoot, secondaryRoot);

    await markerWinsOverRegistry(primaryIdentity);
    await explicitWorkspaceWinsOverMarker(primaryIdentity);
    await confirmToolLiveVerifiesAndRepairs(primaryIdentity);
    await markerIdentityMismatchFailsClosed(primaryIdentity);
    await staleMarkerAuthorizationFailsClosed(primaryIdentity);
    await failedResolutionPreservesStatusAndCorrelation(primaryIdentity);
    twoWorktreesKeepIndependentContexts(primaryIdentity, secondaryIdentity);
    await resetIsWorktreeAndEnvironmentScoped(
      primaryIdentity,
      secondaryIdentity,
      registryPath,
    );
    resetSalvagesValidOtherEnvironment(primaryIdentity);
    malformedAndSecretMarkersAreRejectedAndRepairable(primaryIdentity);
    symlinkMarkerDirectoryIsRejected();
    markerWritesAreAtomicPrivateAndGitClean(primaryIdentity, secondaryIdentity);

    console.log("ContentTraker durable worktree-context tests passed.");
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnvironment)) delete process.env[key];
    }
    Object.assign(process.env, originalEnvironment);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function normalizeRepositoryRemotes(): void {
  assert.equal(
    normalizeRepositoryRemote("https://github.com/Example/Context-Test.git"),
    "example/context-test",
  );
  assert.equal(
    normalizeRepositoryRemote("git@github.com:Example/Context-Test.git"),
    "example/context-test",
  );
  assert.equal(
    normalizeRepositoryRemote("ssh://git@github.com/Example/Context-Test.git"),
    "example/context-test",
  );
}

async function markerWinsOverRegistry(identity: RepositoryWorktreeIdentity): Promise<void> {
  writeConfirmedWorktreeContext(
    identity,
    binding(identity, "staging", "workspace-marker", "project-marker"),
    { repairMalformed: true },
  );
  const api = new FakeContextApi([{
    id: "workspace-marker",
    key: "workspace-marker-key",
    name: "workspace-marker name",
    projects: [{
      id: "project-marker",
      key: "project-marker-key",
      name: "project-marker name",
    }],
  }]);

  const resolved = await resolveOperationContext(
    { repositoryRoot: identity.repositoryRoot },
    apiClient(api),
    security(),
  );

  assert.equal(resolved.blocked, false);
  assert.equal(resolved.selectedContext?.source, "worktree-marker");
  assert.equal(resolved.selectedContext?.workspaceId, "workspace-marker");
  assert.equal(resolved.selectedContext?.projectId, "project-marker");
  assert.equal(api.authorizationCalls.length, 1);
  assert.equal(api.authorizationCalls[0].workspaceId, "workspace-marker");
}

async function explicitWorkspaceWinsOverMarker(
  identity: RepositoryWorktreeIdentity,
): Promise<void> {
  const api = new FakeContextApi([{
    id: "workspace-explicit",
    key: "explicit-key",
    name: "Explicit Workspace",
  }]);

  const resolved = await resolveOperationContext(
    {
      repositoryRoot: identity.repositoryRoot,
      workspaceKey: "explicit-key",
    },
    apiClient(api),
    security(),
  );

  assert.equal(resolved.blocked, false);
  assert.equal(resolved.selectedContext?.source, "explicit-workspace");
  assert.equal(resolved.selectedContext?.workspaceId, "workspace-explicit");
  assert.equal(api.authorizationCalls.length, 1);
  assert.equal(api.authorizationCalls[0].workspaceKey, "explicit-key");
  assert.equal(api.authorizationCalls[0].workspaceId, undefined);
}

async function confirmToolLiveVerifiesAndRepairs(
  identity: RepositoryWorktreeIdentity,
): Promise<void> {
  resetWorktreeContextBinding(identity, "staging", "2026-07-24T20:01:00.000Z");
  const authorized = new FakeContextApi([{
    id: "workspace-confirm",
    key: "workspace-confirm-key",
    name: "Canonical Confirm Workspace",
    projects: [{
      id: "project-confirm",
      key: "project-confirm-key",
      name: "Canonical Confirm Project",
    }],
  }]);
  const confirmationInput = {
    repositoryRoot: identity.repositoryRoot,
    environment: "staging" as const,
    workspaceId: " WORKSPACE-CONFIRM ",
    projectId: " PROJECT-CONFIRM ",
    confirmation: "CONFIRM_CONTENTTRAKER_CONTEXT",
  };

  const environmentMismatch = await confirmContentTrakerContext(
    { ...confirmationInput, environment: "production" },
    apiClient(authorized),
    security(),
  );
  assert.equal(environmentMismatch.status, "blocked");
  assert.match(environmentMismatch.diagnostics.join(" "), /context_environment_mismatch/);
  assert.equal(authorized.authorizationCalls.length, 0);
  assert.equal(loadWorktreeContext(identity, "staging").reset?.environment, "staging");

  const wrongLiteral = await confirmContentTrakerContext(
    { ...confirmationInput, confirmation: "yes" },
    apiClient(authorized),
    security(),
  );
  assert.equal(wrongLiteral.status, "blocked");
  assert.equal(authorized.authorizationCalls.length, 0);
  assert.equal(loadWorktreeContext(identity, "staging").reset?.environment, "staging");

  const unauthorizedProject = new FakeContextApi([{
    id: "workspace-confirm",
    key: "workspace-confirm-key",
    name: "Canonical Confirm Workspace",
    projects: [],
  }]);
  const rejected = await confirmContentTrakerContext(
    confirmationInput,
    apiClient(unauthorizedProject),
    security(),
  );
  assert.equal(rejected.status, "blocked");
  assert.equal(unauthorizedProject.authorizationCalls.length, 1);
  const afterRejected = loadWorktreeContext(identity, "staging");
  assert.equal(afterRejected.binding, undefined);
  assert.equal(afterRejected.reset?.environment, "staging");

  const confirmed = await confirmContentTrakerContext(
    confirmationInput,
    apiClient(authorized),
    security(),
  );
  assert.equal(confirmed.status, "confirmed");
  assert.equal(authorized.authorizationCalls.length, 1);
  assert.equal(confirmed.selectedContext?.source, "worktree-marker");
  assert.deepEqual(confirmed.correlationIds, ["fake-workspaces", "fake-projects"]);
  const confirmedSnapshot = loadWorktreeContext(identity, "staging");
  assert.equal(confirmedSnapshot.reset, undefined);
  assert.equal(confirmedSnapshot.binding?.workspaceId, "workspace-confirm");
  assert.equal(confirmedSnapshot.binding?.workspaceKey, "workspace-confirm-key");
  assert.equal(confirmedSnapshot.binding?.workspaceName, "Canonical Confirm Workspace");
  assert.equal(confirmedSnapshot.binding?.projectId, "project-confirm");
  assert.equal(confirmedSnapshot.binding?.projectKey, "project-confirm-key");
  assert.equal(confirmedSnapshot.binding?.projectName, "Canonical Confirm Project");
  assert.equal(confirmedSnapshot.binding?.confirmationState, "human-confirmed");
  assertNoSecretKeys(readDocument(confirmedSnapshot.path));
  assertNoSecretKeys(confirmed);

  fs.writeFileSync(confirmedSnapshot.path, "{malformed", "utf8");
  const repaired = await confirmContentTrakerContext(
    confirmationInput,
    apiClient(authorized),
    security(),
  );
  assert.equal(repaired.status, "confirmed");
  assert.equal(authorized.authorizationCalls.length, 2);
  assert.match(repaired.diagnostics.join(" "), /malformed local marker was replaced/);
  const repairedSnapshot = loadWorktreeContext(identity, "staging");
  assert.equal(repairedSnapshot.blocked, false);
  assert.equal(repairedSnapshot.binding?.workspaceId, "workspace-confirm");
  assertNoSecretKeys(readDocument(repairedSnapshot.path));
}

async function markerIdentityMismatchFailsClosed(
  identity: RepositoryWorktreeIdentity,
): Promise<void> {
  const markerPath = worktreeContextPath(identity);
  const original = readDocument(markerPath);
  const registryWorkspace = new FakeContextApi([{ id: "workspace-registry" }]);

  const repositoryMismatch = structuredClone(original);
  repositoryMismatch.contexts.staging!.repositoryIdentity = "another-owner/another-repository";
  writeDocument(markerPath, repositoryMismatch);
  const repositorySnapshot = loadWorktreeContext(identity, "staging");
  assert.equal(repositorySnapshot.blocked, true);
  assert.match(repositorySnapshot.diagnostics.join(" "), /context_marker_repository_mismatch/);
  assert.equal(
    JSON.stringify(repositorySnapshot).includes("workspace-registry"),
    false,
  );

  const repositoryResolution = await resolveOperationContext(
    { repositoryRoot: identity.repositoryRoot },
    apiClient(registryWorkspace),
    security(),
  );
  assert.equal(repositoryResolution.blocked, true);
  assert.equal(repositoryResolution.selectedContext, undefined);
  assert.equal(registryWorkspace.authorizationCalls.length, 0);

  const worktreeMismatch = structuredClone(original);
  worktreeMismatch.contexts.staging!.worktreeId = "sha256:not-this-worktree";
  writeDocument(markerPath, worktreeMismatch);
  const worktreeSnapshot = loadWorktreeContext(identity, "staging");
  assert.equal(worktreeSnapshot.blocked, true);
  assert.match(worktreeSnapshot.diagnostics.join(" "), /context_marker_worktree_mismatch/);

  writeConfirmedWorktreeContext(
    identity,
    binding(identity, "staging", "workspace-marker", "project-marker"),
    { repairMalformed: true },
  );
}

async function staleMarkerAuthorizationFailsClosed(
  identity: RepositoryWorktreeIdentity,
): Promise<void> {
  writeConfirmedWorktreeContext(
    identity,
    binding(identity, "staging", "workspace-stale", "project-stale"),
  );

  const unauthorizedWorkspace = new FakeContextApi([]);
  const workspaceResult = await resolveOperationContext(
    { repositoryRoot: identity.repositoryRoot },
    apiClient(unauthorizedWorkspace),
    security(),
  );
  assert.equal(workspaceResult.blocked, true);
  assert.equal(workspaceResult.selectedContext, undefined);
  assert.match(
    workspaceResult.diagnostics.join(" "),
    /context_marker_authorization_rejected.*context_workspace_not_authorized/,
  );

  const staleProject = new FakeContextApi([{
    id: "workspace-stale",
    key: "workspace-stale-key",
    name: "workspace-stale name",
    projects: [{ id: "another-project" }],
  }]);
  const projectResult = await resolveOperationContext(
    { repositoryRoot: identity.repositoryRoot },
    apiClient(staleProject),
    security(),
  );
  assert.equal(projectResult.blocked, true);
  assert.equal(projectResult.selectedContext, undefined);
  assert.match(
    projectResult.diagnostics.join(" "),
    /context_marker_authorization_rejected.*context_project_not_authorized/,
  );

  const blockedRead = await getDigitalAsset(
    {
      repositoryRoot: identity.repositoryRoot,
      digitalAssetId: "must-not-be-requested",
    },
    apiClient(staleProject),
    security(),
  );
  assert.equal(blockedRead.status, "blocked");
  assert.deepEqual(blockedRead.contextCorrelationIds, ["fake-workspaces", "fake-projects"]);
  assert.equal(
    blockedRead.diagnostics.some((diagnostic) => diagnostic === "ContentTraker workspaceId is required."),
    false,
  );
}

async function failedResolutionPreservesStatusAndCorrelation(
  identity: RepositoryWorktreeIdentity,
): Promise<void> {
  const failed = new FailedContextApi();
  const result = await getDigitalAsset(
    {
      repositoryRoot: identity.repositoryRoot,
      workspaceId: "workspace-auth-failure",
      digitalAssetId: "must-not-be-requested",
    },
    apiClient(failed),
    security(),
  );
  assert.equal(result.status, "failed");
  assert.deepEqual(result.contextCorrelationIds, ["fake-authorization-failed"]);
  assert.match(result.diagnostics.join(" "), /context_authorization_failed/);
  assert.equal(failed.authorizationCalls.length, 1);
}

function twoWorktreesKeepIndependentContexts(
  primary: RepositoryWorktreeIdentity,
  secondary: RepositoryWorktreeIdentity,
): void {
  writeConfirmedWorktreeContext(
    primary,
    binding(primary, "staging", "workspace-primary", "project-primary"),
  );
  writeConfirmedWorktreeContext(
    secondary,
    binding(secondary, "staging", "workspace-secondary", "project-secondary"),
  );

  const primarySnapshot = loadWorktreeContext(primary, "staging");
  const secondarySnapshot = loadWorktreeContext(secondary, "staging");
  assert.equal(primarySnapshot.binding?.workspaceId, "workspace-primary");
  assert.equal(secondarySnapshot.binding?.workspaceId, "workspace-secondary");
  assert.notEqual(primarySnapshot.path, secondarySnapshot.path);
}

async function resetIsWorktreeAndEnvironmentScoped(
  primary: RepositoryWorktreeIdentity,
  secondary: RepositoryWorktreeIdentity,
  registryPath: string,
): Promise<void> {
  writeConfirmedWorktreeContext(
    primary,
    binding(primary, "production", "workspace-production", "project-production"),
  );
  const api = new FakeContextApi([{ id: "workspace-explicit-after-reset" }]);
  const callsBeforeReset = api.authorizationCalls.length;

  const reset = resetContentTrakerContext({
    repositoryRoot: primary.repositoryRoot,
    environment: "staging",
    confirmation: "RESET_CONTENTTRAKER_CONTEXT",
  });

  assert.equal(reset.status, "reset");
  assert.equal(reset.cleared.markerBinding, true);
  assert.equal(reset.cleared.registryMappings, 1);
  assert.equal(reset.resetTombstoneCreated, true);
  assert.deepEqual(reset.preserved, {
    oauthAndKeyringCredentials: true,
    otherWorktrees: true,
    otherEnvironments: true,
    remoteContentTrakerAssets: true,
  });
  assert.equal(
    api.authorizationCalls.length,
    callsBeforeReset,
    "reset must not call the ContentTraker API or credential-bearing client",
  );

  const primaryStaging = loadWorktreeContext(primary, "staging");
  const primaryProduction = loadWorktreeContext(primary, "production");
  const secondaryStaging = loadWorktreeContext(secondary, "staging");
  assert.equal(primaryStaging.binding, undefined);
  assert.equal(primaryStaging.reset?.environment, "staging");
  assert.equal(primaryProduction.binding?.workspaceId, "workspace-production");
  assert.equal(secondaryStaging.binding?.workspaceId, "workspace-secondary");

  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
    environments: Record<string, {
      defaults?: { workspaceId?: string };
      projects: Array<{ repositoryRoot?: string; workspaceId?: string }>;
    }>;
  };
  assert.equal(registry.environments.staging.projects.length, 1);
  assert.equal(
    path.resolve(registry.environments.staging.projects[0].repositoryRoot!),
    path.resolve(secondary.repositoryRoot),
  );
  assert.equal(registry.environments.staging.defaults?.workspaceId, "workspace-default");
  assert.equal(registry.environments.production.projects.length, 1);
  assert.equal(
    path.resolve(registry.environments.production.projects[0].repositoryRoot!),
    path.resolve(primary.repositoryRoot),
  );

  const resetResolution = await resolveOperationContext(
    { repositoryRoot: primary.repositoryRoot },
    apiClient(api),
    security(),
  );
  assert.equal(resetResolution.blocked, true);
  assert.equal(resetResolution.reset, true);
  assert.equal(resetResolution.selectedContext, undefined);
  assert.equal(api.authorizationCalls.length, callsBeforeReset);

  const explicitAfterReset = await resolveOperationContext(
    {
      repositoryRoot: primary.repositoryRoot,
      workspaceId: "workspace-explicit-after-reset",
    },
    apiClient(api),
    security(),
  );
  assert.equal(explicitAfterReset.blocked, false);
  assert.equal(explicitAfterReset.selectedContext?.workspaceId, "workspace-explicit-after-reset");
  assert.equal(explicitAfterReset.selectedContext?.source, "explicit-workspace");
  assert.equal(api.authorizationCalls.length, callsBeforeReset + 1);
}

function resetSalvagesValidOtherEnvironment(
  identity: RepositoryWorktreeIdentity,
): void {
  const invalidStaging = binding(
    identity,
    "staging",
    "workspace-invalid-staging",
  );
  invalidStaging.workspaceId = "";
  writeDocument(worktreeContextPath(identity), {
    schemaVersion: 1,
    contexts: {
      staging: invalidStaging,
      production: binding(
        identity,
        "production",
        "workspace-valid-production",
        "project-valid-production",
      ),
    },
    resets: {},
  });

  const reset = resetContentTrakerContext({
    repositoryRoot: identity.repositoryRoot,
    environment: "staging",
    confirmation: "RESET_CONTENTTRAKER_CONTEXT",
  });
  assert.equal(reset.status, "reset");
  assert.equal(reset.cleared.markerBinding, true);
  assert.equal(reset.preserved.otherEnvironments, true);
  assert.match(
    reset.diagnostics.join(" "),
    /preserved the separately validated other-environment marker entry/,
  );
  const staging = loadWorktreeContext(identity, "staging");
  const production = loadWorktreeContext(identity, "production");
  assert.equal(staging.reset?.environment, "staging");
  assert.equal(production.binding?.workspaceId, "workspace-valid-production");
  assert.equal(production.binding?.projectId, "project-valid-production");
}

function malformedAndSecretMarkersAreRejectedAndRepairable(
  identity: RepositoryWorktreeIdentity,
): void {
  const markerPath = worktreeContextPath(identity);
  fs.writeFileSync(markerPath, "{not valid json", "utf8");
  const malformed = loadWorktreeContext(identity, "staging");
  assert.equal(malformed.blocked, true);
  assert.match(malformed.diagnostics.join(" "), /context_marker_invalid/);

  const malformedReset = resetContentTrakerContext({
    repositoryRoot: identity.repositoryRoot,
    environment: "staging",
    confirmation: "RESET_CONTENTTRAKER_CONTEXT",
  });
  assert.equal(malformedReset.status, "reset");
  assert.equal(malformedReset.resetTombstoneCreated, true);
  assert.equal(malformedReset.preserved.otherEnvironments, false);
  assert.match(malformedReset.diagnostics.join(" "), /unreadable or untrusted local marker/);
  assert.equal(loadWorktreeContext(identity, "staging").reset?.environment, "staging");

  writeConfirmedWorktreeContext(
    identity,
    binding(identity, "staging", "workspace-repaired"),
    { repairMalformed: true },
  );
  assert.equal(loadWorktreeContext(identity, "staging").binding?.workspaceId, "workspace-repaired");

  const secretValue = "secret-value-must-never-be-emitted";
  const secretDocument = readDocument(markerPath) as WorktreeContextDocument & {
    accessToken?: string;
  };
  secretDocument.accessToken = secretValue;
  writeDocument(markerPath, secretDocument);
  const secret = loadWorktreeContext(identity, "staging");
  assert.equal(secret.blocked, true);
  assert.match(secret.diagnostics.join(" "), /context_marker_secret_field_rejected/);
  assert.equal(JSON.stringify(secret).includes(secretValue), false);

  writeConfirmedWorktreeContext(
    identity,
    binding(identity, "staging", "workspace-after-secret"),
    { repairMalformed: true },
  );

  fs.writeFileSync(markerPath, "x".repeat((128 * 1024) + 1), "utf8");
  const oversized = loadWorktreeContext(identity, "staging");
  assert.equal(oversized.blocked, true);
  assert.match(oversized.diagnostics.join(" "), /no larger than 128 KiB/);
  const oversizedReset = resetContentTrakerContext({
    repositoryRoot: identity.repositoryRoot,
    environment: "staging",
    confirmation: "RESET_CONTENTTRAKER_CONTEXT",
  });
  assert.equal(oversizedReset.status, "reset");
  assert.equal(oversizedReset.preserved.otherEnvironments, false);
  assert.equal(loadWorktreeContext(identity, "staging").reset?.environment, "staging");

  fs.rmSync(markerPath, { force: true });
  fs.mkdirSync(markerPath);
  const nonRegular = loadWorktreeContext(identity, "staging");
  assert.equal(nonRegular.blocked, true);
  assert.match(nonRegular.diagnostics.join(" "), /regular JSON file/);
  const nonRegularReset = resetContentTrakerContext({
    repositoryRoot: identity.repositoryRoot,
    environment: "staging",
    confirmation: "RESET_CONTENTTRAKER_CONTEXT",
  });
  assert.equal(nonRegularReset.status, "failed");
  assert.equal(nonRegularReset.resetTombstoneCreated, false);
  fs.rmSync(markerPath, { recursive: true, force: true });
  writeConfirmedWorktreeContext(
    identity,
    binding(identity, "staging", "workspace-after-non-regular"),
  );
}

function symlinkMarkerDirectoryIsRejected(): void {
  const repositoryRoot = createRepository(
    path.join(temporaryRoot, "symlink-repository"),
    "https://github.com/Example/Symlink-Context-Test.git",
  );
  const identity = resolveGitWorktreeIdentity(repositoryRoot);
  const target = path.join(temporaryRoot, "symlink-context-target");
  const markerDirectory = path.join(repositoryRoot, ".contenttraker-codex");
  fs.mkdirSync(target, { recursive: true });
  fs.symlinkSync(
    target,
    markerDirectory,
    process.platform === "win32" ? "junction" : "dir",
  );

  const loaded = loadWorktreeContext(identity, "staging");
  assert.equal(loaded.blocked, true);
  assert.match(loaded.diagnostics.join(" "), /context_marker_symlink_rejected/);
  assert.throws(
    () =>
      writeConfirmedWorktreeContext(
        identity,
        binding(identity, "staging", "workspace-symlink"),
      ),
    /context_marker_symlink_rejected/,
  );
}

function markerWritesAreAtomicPrivateAndGitClean(
  primary: RepositoryWorktreeIdentity,
  secondary: RepositoryWorktreeIdentity,
): void {
  ensureWorktreeContextIgnored(primary);
  ensureWorktreeContextIgnored(secondary);
  writeConfirmedWorktreeContext(
    primary,
    binding(primary, "staging", "workspace-private"),
  );
  writeConfirmedWorktreeContext(
    secondary,
    binding(secondary, "staging", "workspace-secondary-private"),
  );

  for (const identity of [primary, secondary]) {
    const markerPath = worktreeContextPath(identity);
    const contextDirectory = path.dirname(markerPath);
    const temporaryFiles = fs.readdirSync(contextDirectory)
      .filter((name) => /^context\.json\..+\.tmp$/u.test(name));
    assert.deepEqual(temporaryFiles, []);
    assert.equal(
      gitStatus(identity.repositoryRoot, [
        "check-ignore",
        "--no-index",
        "-q",
        "--",
        WORKTREE_CONTEXT_RELATIVE_PATH,
      ]),
      0,
    );
    assert.equal(
      gitOutput(identity.repositoryRoot, ["status", "--porcelain", "--untracked-files=all"]),
      "",
    );
  }
}

class FakeContextApi {
  readonly authorizationCalls: ContentTrakerContext[] = [];

  constructor(
    private readonly workspaces: SelectableWorkspace[],
    private readonly environment: ContentTrakerEnvironment = "staging",
  ) {}

  getStatus(): ApiClientStatus {
    return apiStatus(this.environment);
  }

  async resolveAuthorizedContext(
    context: ContentTrakerContext,
  ): Promise<AuthorizedContextResolutionResult> {
    this.authorizationCalls.push({ ...context });
    const workspaces = this.workspaces.filter((workspace) =>
      matchesSelectors(workspace, {
        id: context.workspaceId,
        key: context.workspaceKey,
        name: context.workspaceName,
      }));
    if (workspaces.length !== 1) {
      return {
        status: "blocked",
        correlationIds: ["fake-workspaces"],
        diagnostics: [
          workspaces.length === 0
            ? "context_workspace_not_authorized: fake workspace rejection."
            : "context_workspace_ambiguous: fake workspace ambiguity.",
        ],
      };
    }

    const workspace = workspaces[0];
    const selected: ContentTrakerContext = {
      environment: this.environment,
      workspaceId: workspace.id,
      workspaceKey: workspace.key,
      workspaceName: workspace.name,
      source: context.source,
    };
    const projectSelectorPresent = Boolean(
      context.projectId || context.projectKey || context.projectName,
    );
    if (projectSelectorPresent) {
      const projects = (workspace.projects ?? []).filter((project) =>
        matchesSelectors(project, {
          id: context.projectId,
          key: context.projectKey,
          name: context.projectName,
        }));
      if (projects.length !== 1) {
        return {
          status: "blocked",
          correlationIds: ["fake-workspaces", "fake-projects"],
          diagnostics: [
            projects.length === 0
              ? "context_project_not_authorized: fake project rejection."
              : "context_project_ambiguous: fake project ambiguity.",
          ],
        };
      }
      selected.projectId = projects[0].id;
      selected.projectKey = projects[0].key;
      selected.projectName = projects[0].name;
    }

    return {
      status: "ready",
      selectedContext: selected,
      correlationIds: projectSelectorPresent
        ? ["fake-workspaces", "fake-projects"]
        : ["fake-workspaces"],
      diagnostics: ["Fake live authorization succeeded."],
    };
  }
}

class FailedContextApi extends FakeContextApi {
  constructor() {
    super([]);
  }

  override async resolveAuthorizedContext(
    context: ContentTrakerContext,
  ): Promise<AuthorizedContextResolutionResult> {
    this.authorizationCalls.push({ ...context });
    return {
      status: "failed",
      correlationIds: ["fake-authorization-failed"],
      diagnostics: ["context_authorization_failed: fake upstream failure."],
    };
  }
}

function apiClient(fake: FakeContextApi): ContentTrakerApiClient {
  return fake as unknown as ContentTrakerApiClient;
}

function apiStatus(environment: ContentTrakerEnvironment): ApiClientStatus {
  return {
    environment,
    environmentProfile: {
      requestedName: environment,
      name: environment,
      valid: true,
      allowedNames: ["staging", "production"],
    },
    baseUrl: `https://mcp.${environment}.contenttraker.test`,
    baseUrlSource: "test",
    configured: true,
    accessTokenPresent: true,
    tokenStrategy: {
      mode: "delegated-user-pkce",
      configured: true,
      accessTokenPresent: true,
      source: "worktree-context-test",
      tokenExpiryStatus: "valid",
    },
    writePolicy: {
      writesExposed: environment === "staging",
      productionWritesEnabled: false,
      mode: environment === "staging" ? "staging-writes-enabled" : "production-read-only",
      requiresExplicitConfirmation: true,
      requiresIdempotencyKey: true,
      requiresDraftStatus: false,
      diagnostics: [],
    },
  };
}

function binding(
  identity: RepositoryWorktreeIdentity,
  environment: ContentTrakerEnvironment,
  workspaceId: string,
  projectId?: string,
): WorktreeContextBinding {
  return {
    environment,
    repositoryIdentity: identity.repositoryIdentity,
    worktreeId: identity.worktreeId,
    workspaceId,
    workspaceKey: `${workspaceId}-key`,
    workspaceName: `${workspaceId} name`,
    projectId,
    projectKey: projectId ? `${projectId}-key` : undefined,
    projectName: projectId ? `${projectId} name` : undefined,
    confirmationState: "human-confirmed",
    confirmedAtUtc: "2026-07-24T20:00:00.000Z",
    pluginName: "contenttraker",
    pluginVersion: "0.3.0-test",
  };
}

function matchesSelectors(
  candidate: { id: string; key?: string; name?: string },
  selectors: { id?: string; key?: string; name?: string },
): boolean {
  if (selectors.id && !equals(selectors.id, candidate.id)) return false;
  if (selectors.key && !equals(selectors.key, candidate.key)) return false;
  if (selectors.name && !equals(selectors.name, candidate.name)) return false;
  return Boolean(selectors.id || selectors.key || selectors.name);
}

function equals(left: string, right: string | undefined): boolean {
  return left.trim().toLocaleLowerCase() === right?.trim().toLocaleLowerCase();
}

function security(): ContentTrakerRequestSecurityContext {
  return {
    environment: "staging",
    connectionId: "worktree-context-test",
    sessionId: "worktree-context-test",
    requestId: "worktree-context-test",
    correlationId: "worktree-context-test",
    tokenAudience: "https://mcp.staging.contenttraker.test",
  };
}

function createRepository(repositoryRoot: string, remoteUrl: string): string {
  fs.mkdirSync(repositoryRoot, { recursive: true });
  git(repositoryRoot, ["init"]);
  git(repositoryRoot, ["config", "user.email", "worktree-context-test@example.invalid"]);
  git(repositoryRoot, ["config", "user.name", "Worktree Context Test"]);
  git(repositoryRoot, ["commit", "--allow-empty", "-m", "initial"]);
  git(repositoryRoot, ["remote", "add", "origin", remoteUrl]);
  return fs.realpathSync.native(repositoryRoot);
}

function writeRegistry(
  registryPath: string,
  primaryRoot: string,
  secondaryRoot: string,
): void {
  fs.writeFileSync(
    registryPath,
    `${JSON.stringify({
      version: 2,
      environments: {
        staging: {
          defaults: {
            workspaceId: "workspace-default",
            workspaceName: "Registry Default",
          },
          projects: [
            {
              projectName: "primary-local-project",
              repositoryRoot: primaryRoot,
              workspaceId: "workspace-registry",
              workspaceName: "Registry Workspace",
              contentTrakerProjectId: "project-registry",
              contentTrakerProjectName: "Registry Project",
            },
            {
              projectName: "secondary-local-project",
              repositoryRoot: secondaryRoot,
              workspaceId: "workspace-secondary-registry",
            },
          ],
        },
        production: {
          projects: [
            {
              projectName: "primary-production-project",
              repositoryRoot: primaryRoot,
              workspaceId: "workspace-production-registry",
            },
          ],
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
}

function readDocument(markerPath: string): WorktreeContextDocument {
  return JSON.parse(fs.readFileSync(markerPath, "utf8")) as WorktreeContextDocument;
}

function writeDocument(markerPath: string, document: unknown): void {
  fs.writeFileSync(markerPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

function assertNoSecretKeys(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecretKeys(item);
    return;
  }
  const forbidden = new Set([
    "accesstoken",
    "refreshtoken",
    "token",
    "clientsecret",
    "secret",
    "password",
    "credential",
    "authorization",
    "bearer",
    "cookie",
    "keyring",
    "apikey",
    "privatekey",
  ]);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    assert.equal(
      forbidden.has(key.replace(/[_-]/gu, "").toLocaleLowerCase()),
      false,
      `forbidden secret field '${key}' was emitted`,
    );
    assertNoSecretKeys(child);
  }
}

function git(repositoryRoot: string, args: string[]): void {
  execFileSync("git", ["-C", repositoryRoot, ...args], {
    stdio: "ignore",
    windowsHide: true,
  });
}

function gitOutput(repositoryRoot: string, args: string[]): string {
  return execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

function gitStatus(repositoryRoot: string, args: string[]): number {
  try {
    git(repositoryRoot, args);
    return 0;
  } catch (error) {
    const status = (error as { status?: number }).status;
    return status ?? 1;
  }
}

await run();
