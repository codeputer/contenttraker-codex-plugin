import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ContentTrakerEnvironment,
  ContentTrakerContext,
  RegistryProjectMapping,
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
  if (!registry.loaded || !registry.document) {
    return undefined;
  }

  const projects = Array.isArray(registry.environmentDocument?.projects)
    ? registry.environmentDocument.projects
    : [];
  const match = projects.find((project) => projectMatches(input, project));

  if (match) {
    return {
      environment: registry.environment,
      workspaceName: match.workspaceName,
      workspaceId: match.workspaceId,
      projectName: match.contentTrakerProjectName ?? match.projectName,
      projectId: match.contentTrakerProjectId,
      source: "registry-project",
    };
  }

  const defaults = registry.environmentDocument?.defaults;
  if (defaults?.workspaceName || defaults?.workspaceId || defaults?.projectName || defaults?.projectId) {
    return {
      environment: registry.environment,
      workspaceName: defaults.workspaceName,
      workspaceId: defaults.workspaceId,
      projectName: defaults.projectName,
      projectId: defaults.projectId,
      source: "registry-default",
    };
  }

  return undefined;
}

export function upsertRegistryMapping(
  input: UpsertRegistryMappingInput,
  registryPath = resolveRegistryPath(),
): RegistryUpsertResult {
  const environment = input.environment ?? "staging";
  const existsBefore = fs.existsSync(registryPath);
  const document = existsBefore
    ? normalizeRegistryDocument(JSON.parse(fs.readFileSync(registryPath, "utf8")) as WorkspaceRegistryDocument)
    : emptyRegistryDocument();

  const environmentDocument = document.environments[environment] ?? { projects: [] };
  const projects = Array.isArray(environmentDocument.projects) ? [...environmentDocument.projects] : [];
  const nextMapping: RegistryProjectMapping = {
    projectName: input.projectName,
    repositoryRoot: path.resolve(input.repositoryRoot),
    workspaceName: input.workspaceName,
    workspaceId: input.workspaceId,
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
      workspaceId: input.workspaceId,
      projectName: input.contentTrakerProjectName ?? input.projectName,
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
      documentVersion: 2,
      environment,
      projectCount: projects.length,
    },
    selectedContext: {
      environment,
      workspaceName: nextMapping.workspaceName,
      workspaceId: nextMapping.workspaceId,
      projectName: nextMapping.contentTrakerProjectName ?? nextMapping.projectName,
      projectId: nextMapping.contentTrakerProjectId,
      source: "registry-project",
    },
    diagnostics: [
      input.dryRun
        ? "Dry run only; registry file was not written."
        : "Local registry was updated; no ContentTraker API write was performed.",
    ],
  };
}

function projectMatches(input: ResolveContextInput, project: RegistryProjectMapping): boolean {
  if (input.projectName && equals(input.projectName, project.projectName)) {
    return true;
  }

  if (input.workspaceName && equals(input.workspaceName, project.workspaceName)) {
    return true;
  }

  if (input.repositoryRoot && project.repositoryRoot) {
    return normalizePath(input.repositoryRoot) === normalizePath(project.repositoryRoot);
  }

  return false;
}

function selectEnvironmentDocument(
  document: WorkspaceRegistryDocument,
  environment: ContentTrakerEnvironment | undefined,
): WorkspaceRegistryEnvironment | undefined {
  if (!environment) {
    return undefined;
  }

  if (document.version === 2) {
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

function emptyRegistryDocument(): WorkspaceRegistryDocument & { version: 2; environments: Record<ContentTrakerEnvironment, WorkspaceRegistryEnvironment> } {
  return {
    version: 2,
    environments: {
      staging: { projects: [] },
      production: { projects: [] },
    },
  };
}

function normalizeRegistryDocument(
  document: WorkspaceRegistryDocument,
): WorkspaceRegistryDocument & { version: 2; environments: Record<ContentTrakerEnvironment, WorkspaceRegistryEnvironment> } {
  if (document.version === 2) {
    return {
      version: 2,
      environments: {
        staging: document.environments?.staging ?? { projects: [] },
        production: document.environments?.production ?? { projects: [] },
      },
    };
  }

  if (document.version === 1) {
    return {
      version: 2,
      environments: {
        staging: {
          defaults: document.defaults,
          projects: document.projects ?? [],
        },
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
  return path.resolve(value).toLocaleLowerCase();
}
