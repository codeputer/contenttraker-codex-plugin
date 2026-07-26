import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeContentKeeperAliases } from "./contentkeeper-id.js";
import type {
  ContentTrakerEnvironment,
  ContentTrakerContext,
  RegistryProjectMapping,
  RegistryMappingRemovalResult,
  RegistrySnapshot,
  RegistryUpsertResult,
  ResolveContextInput,
  UpsertRegistryMappingInput,
  WorkspaceRegistryEnvironment,
  WorkspaceRegistryDocument,
} from "./types.js";

export function defaultRegistryPath(): string {
  return path.join(os.homedir(), ".codex", "contenttraker", "workspace-registry.json");
}

export function resolveRegistryPath(): string {
  return process.env.CONTENTTRAKER_CODEX_REGISTRY?.trim() || defaultRegistryPath();
}

export function loadWorkspaceRegistry(
  environment: ContentTrakerEnvironment | undefined,
  registryPath = resolveRegistryPath(),
): RegistrySnapshot {
  if (!fs.existsSync(registryPath)) {
    return {
      path: registryPath,
      exists: false,
      loaded: false,
      environment,
      environmentConfigured: false,
      projectCount: 0,
      errors: [],
    };
  }

  try {
    const raw = fs.readFileSync(registryPath, "utf8");
    const document = JSON.parse(raw) as WorkspaceRegistryDocument;
    const environmentDocument = selectEnvironmentDocument(document, environment);
    const projects = Array.isArray(environmentDocument?.projects) ? environmentDocument.projects : [];

    return {
      path: registryPath,
      exists: true,
      loaded: true,
      environment,
      environmentConfigured: Boolean(environmentDocument),
      projectCount: projects.length,
      errors: [],
      documentVersion: document.version,
      document,
      environmentDocument,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      path: registryPath,
      exists: true,
      loaded: false,
      environment,
      environmentConfigured: false,
      projectCount: 0,
      errors: [message],
    };
  }
}

export function resolveContextFromRegistry(
  input: ResolveContextInput,
  registry: RegistrySnapshot,
): ContentTrakerContext | undefined {
  const aliases = normalizeContentKeeperAliases(input);
  if (aliases.diagnostic) return undefined;
  const explicit = aliases.contentKeeperId || input.workspaceKey?.trim() || input.workspaceName?.trim()
    ? {
        environment: registry.environment,
        contentKeeperId: aliases.contentKeeperId,
        workspaceId: aliases.workspaceId,
        workspaceKey: input.workspaceKey?.trim() || undefined,
        workspaceName: input.workspaceName?.trim() || undefined,
        source: "explicit-workspace" as const,
      }
    : undefined;
  if (explicit) return explicit;
  if (!registry.loaded || !registry.document) {
    const registryCouldHideAProjectConflict = registry.exists
      && Boolean(input.projectName?.trim() || input.repositoryRoot?.trim());
    return registryCouldHideAProjectConflict ? undefined : explicit;
  }

  const projects = Array.isArray(registry.environmentDocument?.projects)
    ? registry.environmentDocument.projects
    : [];
  const match = projects.find((project) => projectMatches(input, project));

  if (match) {
    const mappedAliases = normalizeContentKeeperAliases(match);
    if (mappedAliases.diagnostic || !mappedAliases.contentKeeperId) return undefined;
    const mapped = {
      environment: registry.environment,
      workspaceName: match.workspaceName,
      contentKeeperId: mappedAliases.contentKeeperId,
      workspaceId: mappedAliases.workspaceId,
      projectName: match.contentTrakerProjectName,
      projectId: match.contentTrakerProjectId,
      source: "registry-project" as const,
    };
    return mapped;
  }

  return undefined;
}

export function upsertRegistryMapping(
  input: UpsertRegistryMappingInput,
  registryPath = resolveRegistryPath(),
): RegistryUpsertResult {
  const environment = input.environment ?? "staging";
  const aliases = normalizeContentKeeperAliases(input);
  if (aliases.diagnostic || !aliases.contentKeeperId) {
    return {
      status: "blocked",
      dryRun: Boolean(input.dryRun),
      registry: {
        path: registryPath,
        existsBefore: fs.existsSync(registryPath),
        documentVersion: 3,
        environment,
        projectCount: 0,
      },
      diagnostics: [
        aliases.diagnostic
          ?? "contentKeeperId is required for an exact repository registry mapping.",
      ],
    };
  }
  const existsBefore = fs.existsSync(registryPath);
  const document = existsBefore
    ? normalizeRegistryDocument(JSON.parse(fs.readFileSync(registryPath, "utf8")) as WorkspaceRegistryDocument)
    : emptyRegistryDocument();

  const environmentDocument = document.environments[environment] ?? { projects: [] };
  const projects = Array.isArray(environmentDocument.projects) ? [...environmentDocument.projects] : [];
  const nextMapping: RegistryProjectMapping = {
    projectName: input.projectName,
    repositoryRoot: canonicalFilesystemPath(input.repositoryRoot),
    contentKeeperId: aliases.contentKeeperId,
    workspaceName: input.workspaceName,
    workspaceId: aliases.workspaceId,
    contentTrakerProjectName: input.contentTrakerProjectName,
    contentTrakerProjectId: input.contentTrakerProjectId,
  };

  const index = projects.findIndex((project) => mappingMatches(nextMapping, project));
  const previous = index >= 0 ? projects[index] : undefined;
  const changed = !previous || JSON.stringify(previous) !== JSON.stringify(nextMapping);
  const status = input.dryRun
    ? "dry-run"
    : !previous
      ? "created"
      : changed
        ? "updated"
        : "unchanged";

  if (index >= 0) {
    projects[index] = nextMapping;
  } else {
    projects.push(nextMapping);
  }

  environmentDocument.projects = projects;

  if (input.setDefault) {
    environmentDocument.defaults = {
      workspaceName: input.workspaceName,
      contentKeeperId: aliases.contentKeeperId,
      workspaceId: aliases.workspaceId,
      projectName: input.contentTrakerProjectName,
      projectId: input.contentTrakerProjectId,
    };
  }

  document.environments[environment] = environmentDocument;

  if (!input.dryRun) {
    writeRegistryDocument(registryPath, document);
  }

  return {
    status,
    dryRun: Boolean(input.dryRun),
    registry: {
      path: registryPath,
      existsBefore,
      documentVersion: 3,
      environment,
      projectCount: projects.length,
    },
    selectedContext: {
      environment,
      contentKeeperId: aliases.contentKeeperId,
      workspaceName: nextMapping.workspaceName,
      workspaceId: aliases.workspaceId,
      projectName: nextMapping.contentTrakerProjectName,
      projectId: nextMapping.contentTrakerProjectId,
      source: "registry-project",
    },
    diagnostics: [
      input.dryRun
        ? "Dry run only; registry file was not written."
        : "Local registry was updated; no ContentTraker API write was performed.",
      input.setDefault
        ? "The environment default is retained for diagnostics and migration only; business operations never route through it."
        : "Business operations can use this mapping only when repositoryRoot matches exactly and live authorization succeeds.",
    ],
  };
}

function projectMatches(input: ResolveContextInput, project: RegistryProjectMapping): boolean {
  return Boolean(
    input.repositoryRoot
    && project.repositoryRoot
    && normalizePath(input.repositoryRoot) === normalizePath(project.repositoryRoot),
  );
}

export function removeRegistryMappingsForWorktree(
  environment: ContentTrakerEnvironment,
  repositoryRoot: string,
  registryPath = resolveRegistryPath(),
): RegistryMappingRemovalResult {
  if (!fs.existsSync(registryPath)) {
    return {
      path: registryPath,
      environment,
      loaded: false,
      removedCount: 0,
      remainingProjectCount: 0,
      diagnostics: ["No workspace registry exists; no registry mapping was removed."],
    };
  }

  try {
    const document = normalizeRegistryDocument(
      JSON.parse(fs.readFileSync(registryPath, "utf8")) as WorkspaceRegistryDocument,
    );
    const environmentDocument = document.environments[environment] ?? { projects: [] };
    const projects = Array.isArray(environmentDocument.projects) ? environmentDocument.projects : [];
    const normalizedRoot = normalizePath(repositoryRoot);
    const remaining = projects.filter((project) =>
      !project.repositoryRoot || normalizePath(project.repositoryRoot) !== normalizedRoot);
    const removedCount = projects.length - remaining.length;
    environmentDocument.projects = remaining;
    document.environments[environment] = environmentDocument;
    if (removedCount > 0) writeRegistryDocument(registryPath, document);

    return {
      path: registryPath,
      environment,
      loaded: true,
      removedCount,
      remainingProjectCount: remaining.length,
      diagnostics: [
        removedCount > 0
          ? `Removed ${removedCount} exact registry mapping(s) for this worktree and environment.`
          : "No exact registry mapping matched this worktree and environment.",
        "Environment defaults were preserved; the worktree reset tombstone suppresses them locally.",
      ],
    };
  } catch (error) {
    return {
      path: registryPath,
      environment,
      loaded: false,
      removedCount: 0,
      remainingProjectCount: 0,
      diagnostics: [
        `Workspace registry could not be updated: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

function selectEnvironmentDocument(
  document: WorkspaceRegistryDocument,
  environment: ContentTrakerEnvironment | undefined,
): WorkspaceRegistryEnvironment | undefined {
  if (!environment) {
    return undefined;
  }

  if (document.version === 2 || document.version === 3) {
    return document.environments?.[environment];
  }

  if (document.version === 1 && environment === "staging") {
    return {
      defaults: document.defaults,
      projects: document.projects,
    };
  }

  return undefined;
}

function emptyRegistryDocument(): WorkspaceRegistryDocument & { version: 3; environments: Record<ContentTrakerEnvironment, WorkspaceRegistryEnvironment> } {
  return {
    version: 3,
    environments: {
      staging: { projects: [] },
      production: { projects: [] },
    },
  };
}

function normalizeRegistryDocument(
  document: WorkspaceRegistryDocument,
): WorkspaceRegistryDocument & { version: 3; environments: Record<ContentTrakerEnvironment, WorkspaceRegistryEnvironment> } {
  if (document.version === 2 || document.version === 3) {
    return {
      version: 3,
      environments: {
        staging: normalizeEnvironmentDocument(document.environments?.staging),
        production: normalizeEnvironmentDocument(document.environments?.production),
      },
    };
  }

  if (document.version === 1) {
    return {
      version: 3,
      environments: {
        staging: normalizeEnvironmentDocument({
          defaults: document.defaults,
          projects: document.projects ?? [],
        }),
        production: { projects: [] },
      },
    };
  }

  throw new Error("Unsupported workspace registry version.");
}

function writeRegistryDocument(registryPath: string, document: WorkspaceRegistryDocument): void {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  const temporaryPath = `${registryPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, registryPath);
}

function mappingMatches(left: RegistryProjectMapping, right: RegistryProjectMapping): boolean {
  if (left.repositoryRoot && right.repositoryRoot && normalizePath(left.repositoryRoot) === normalizePath(right.repositoryRoot)) {
    return true;
  }

  return equals(left.projectName, right.projectName);
}

function equals(left: string, right: string | undefined): boolean {
  return left.trim().toLocaleLowerCase() === right?.trim().toLocaleLowerCase();
}

function normalizePath(value: string): string {
  const canonical = canonicalFilesystemPath(value);
  return process.platform === "win32" ? canonical.toLocaleLowerCase() : canonical;
}

function normalizeEnvironmentDocument(
  document: WorkspaceRegistryEnvironment | undefined,
): WorkspaceRegistryEnvironment {
  const defaults = document?.defaults;
  const defaultAliases = normalizeContentKeeperAliases(defaults ?? {});
  return {
    defaults: defaults
      ? {
          ...defaults,
          contentKeeperId: defaultAliases.contentKeeperId,
          workspaceId: defaultAliases.workspaceId,
        }
      : undefined,
    projects: (document?.projects ?? []).map((project) => {
      const aliases = normalizeContentKeeperAliases(project);
      return {
        ...project,
        contentKeeperId: aliases.contentKeeperId,
        workspaceId: aliases.workspaceId,
      };
    }),
  };
}

function canonicalFilesystemPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}
