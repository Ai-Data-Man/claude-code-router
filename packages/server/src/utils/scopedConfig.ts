import { existsSync } from "fs";
import { mkdir, readFile, readdir, stat, writeFile } from "fs/promises";
import { dirname, join } from "path";
import {
  CLAUDE_PROJECTS_DIR,
  CONFIG_FILE,
  HOME_DIR,
  MANUAL_PROJECT_INDEX_FILE,
  getProjectLabel,
  normalizeProjectPath,
  normalizeSharedProviders,
  pickGlobalConfig,
  serializeSharedProviders,
  type GlobalConfigPatch,
  type ProjectIndexItem,
  type ScopedConfigFile,
  type ScopedRouterConfig,
  type SessionIndexItem,
  type SharedProviderConfig,
} from "@CCR/shared";
import { backupConfigFile, readConfigFile, writeConfigFile } from "./index";
import { searchProjectBySession } from "@musistudio/llms";

interface ManualProjectIndexEntry {
  path: string;
  folderName: string;
}

interface ResolvedProject {
  path: string;
  folderName: string;
}

const toProjectFolderName = (projectPath: string): string => {
  const normalized = normalizeProjectPath(projectPath);
  return normalized.replace(/^[A-Za-z]:/, (match) => match[0]).replace(/[:/\\]/g, "-");
};

const ensureParentDir = async (filePath: string) => {
  await mkdir(dirname(filePath), { recursive: true });
};

const readJsonFile = async <T>(filePath: string, fallback: T): Promise<T> => {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
};

const writeJsonFile = async (filePath: string, data: unknown) => {
  await ensureParentDir(filePath);
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
};

const readManualProjectIndex = async (): Promise<ManualProjectIndexEntry[]> => {
  return readJsonFile<ManualProjectIndexEntry[]>(MANUAL_PROJECT_INDEX_FILE, []);
};

const writeManualProjectIndex = async (entries: ManualProjectIndexEntry[]) => {
  await writeJsonFile(MANUAL_PROJECT_INDEX_FILE, entries);
};

const readSessionMetadata = async (sessionFilePath: string): Promise<{ cwd?: string; timestamp?: string } | null> => {
  try {
    const content = await readFile(sessionFilePath, "utf8");
    const lines = content.split(/\r?\n/).filter(Boolean).slice(0, 20);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      if (parsed?.cwd || parsed?.timestamp) {
        return {
          cwd: parsed.cwd,
          timestamp: parsed.timestamp,
        };
      }
    }
  } catch {}
  return null;
};

const getAutoProjects = async (): Promise<ResolvedProject[]> => {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return [];

  const entries = await readdir(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
  const projects: ResolvedProject[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folderPath = join(CLAUDE_PROJECTS_DIR, entry.name);
    const files = await readdir(folderPath);
    const sessionFile = files.find((file) => file.endsWith(".jsonl"));
    const sessionMeta = sessionFile
      ? await readSessionMetadata(join(folderPath, sessionFile))
      : null;
    const projectPath = normalizeProjectPath(sessionMeta?.cwd || entry.name);
    projects.push({
      path: projectPath,
      folderName: entry.name,
    });
  }

  return projects;
};

const resolveFolderNameFromProjectPath = async (normalizedPath: string): Promise<string | null> => {
  const autoProjects = await getAutoProjects();
  const autoMatch = autoProjects.find((item) => item.path === normalizedPath);
  if (autoMatch) return autoMatch.folderName;

  const manualEntries = await readManualProjectIndex();
  const manualMatch = manualEntries.find((item) => normalizeProjectPath(item.path) === normalizedPath);
  if (manualMatch) return manualMatch.folderName;

  return null;
};

export const resolveProjectByPath = async (projectPath: string, logger?: { debug?: (...args: any[]) => void }): Promise<ResolvedProject> => {
  const normalizedPath = normalizeProjectPath(projectPath);
  const existingFolderName = await resolveFolderNameFromProjectPath(normalizedPath);
  logger?.debug?.({ projectPath, normalizedPath, existingFolderName }, "Resolving project scoped config folder");
  if (existingFolderName) {
    return { path: normalizedPath, folderName: existingFolderName };
  }

  const folderName = toProjectFolderName(normalizedPath);
  const manualEntries = await readManualProjectIndex();
  const nextEntries = [...manualEntries.filter((item) => normalizeProjectPath(item.path) !== normalizedPath), { path: normalizedPath, folderName }];
  await writeManualProjectIndex(nextEntries);
  logger?.debug?.({ projectPath, normalizedPath, folderName }, "Created manual project scoped config mapping");
  return { path: normalizedPath, folderName };
};

export const getProjectConfigFilePath = async (projectPath: string, logger?: { debug?: (...args: any[]) => void }): Promise<string> => {
  const project = await resolveProjectByPath(projectPath, logger);
  const filePath = join(HOME_DIR, project.folderName, "config.json");
  logger?.debug?.({ projectPath, resolvedProject: project, filePath }, "Resolved project scoped config file path");
  return filePath;
};

export const getSessionConfigFilePath = async (sessionId: string, projectPath?: string): Promise<string | null> => {
  const folderName = projectPath
    ? (await resolveProjectByPath(projectPath)).folderName
    : await searchProjectBySession(sessionId);
  if (!folderName) return null;
  return join(HOME_DIR, folderName, `${sessionId}.json`);
};

export const readScopedConfigFile = async (filePath: string | null): Promise<ScopedConfigFile> => {
  if (!filePath) return {};
  return readJsonFile<ScopedConfigFile>(filePath, {});
};

export const writeScopedConfigFile = async (filePath: string, config: ScopedConfigFile) => {
  await writeJsonFile(filePath, config);
};

export const getSharedProviders = async (): Promise<SharedProviderConfig[]> => {
  const config = await readConfigFile();
  return normalizeSharedProviders(config.Providers || config.providers || []);
};

export const saveSharedProviders = async (providers: SharedProviderConfig[]) => {
  const config = await readConfigFile();
  const backupPath = await backupConfigFile();
  if (backupPath) {
    console.log(`Backed up existing configuration file to ${backupPath}`);
  }
  await writeConfigFile({
    ...config,
    Providers: serializeSharedProviders(providers),
  });
  return { success: true, message: "Shared providers saved successfully" };
};

export const getGlobalScopedConfig = async (): Promise<GlobalConfigPatch> => {
  const config = await readConfigFile();
  return pickGlobalConfig(config);
};

export const saveGlobalScopedConfig = async (patch: GlobalConfigPatch) => {
  const config = await readConfigFile();
  const backupPath = await backupConfigFile();
  if (backupPath) {
    console.log(`Backed up existing configuration file to ${backupPath}`);
  }
  await writeConfigFile({
    ...config,
    ...patch,
    Router: patch.Router ? { ...(config.Router || {}), ...patch.Router } : config.Router,
  });
  return { success: true, message: "Global config saved successfully" };
};

export const listProjects = async (): Promise<ProjectIndexItem[]> => {
  const autoProjects = await getAutoProjects();
  const manualProjects = await readManualProjectIndex();
  const merged = new Map<string, ProjectIndexItem>();

  for (const project of autoProjects) {
    const configPath = join(HOME_DIR, project.folderName, "config.json");
    const fileStat = existsSync(configPath) ? await stat(configPath) : null;
    merged.set(project.path, {
      path: project.path,
      label: getProjectLabel(project.path),
      hasOverride: existsSync(configPath),
      lastActivityAt: fileStat?.mtime.toISOString(),
      source: "auto",
    });
  }

  for (const entry of manualProjects) {
    const normalizedPath = normalizeProjectPath(entry.path);
    if (merged.has(normalizedPath)) continue;
    const configPath = join(HOME_DIR, entry.folderName, "config.json");
    const fileStat = existsSync(configPath) ? await stat(configPath) : null;
    merged.set(normalizedPath, {
      path: normalizedPath,
      label: getProjectLabel(normalizedPath),
      hasOverride: existsSync(configPath),
      lastActivityAt: fileStat?.mtime.toISOString(),
      source: "manual",
    });
  }

  return [...merged.values()].sort((a, b) => (b.lastActivityAt || "").localeCompare(a.lastActivityAt || ""));
};

export const getProjectScopedConfig = async (projectPath: string): Promise<ScopedConfigFile> => {
  const filePath = await getProjectConfigFilePath(projectPath);
  return readScopedConfigFile(filePath);
};

export const saveProjectScopedConfig = async (projectPath: string, routerConfig: ScopedRouterConfig, logger?: { debug?: (...args: any[]) => void }) => {
  const filePath = await getProjectConfigFilePath(projectPath, logger);
  logger?.debug?.({ projectPath, filePath, router: routerConfig }, "Writing project scoped router config");
  await writeScopedConfigFile(filePath, { Router: routerConfig });
  return { success: true, message: "Project config saved successfully" };
};

export const listRecentSessions = async (options: {
  limit?: number;
  from?: string;
  to?: string;
  projectPath?: string;
}): Promise<SessionIndexItem[]> => {
  const limit = Number(options.limit || 20);
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return [];

  const autoProjects = await getAutoProjects();
  const projectMap = new Map(autoProjects.map((item) => [item.folderName, item.path]));
  const projectFilter = options.projectPath ? normalizeProjectPath(options.projectPath) : undefined;
  const from = options.from ? new Date(options.from).getTime() : undefined;
  const to = options.to ? new Date(options.to).getTime() : undefined;

  const entries = await readdir(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
  const sessions: SessionIndexItem[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folderPath = join(CLAUDE_PROJECTS_DIR, entry.name);
    const projectPath = projectMap.get(entry.name) || normalizeProjectPath(entry.name);
    if (projectFilter && projectPath !== projectFilter) continue;

    const files = await readdir(folderPath);
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const sessionId = file.replace(/\.jsonl$/, "");
      const sessionFilePath = join(folderPath, file);
      const fileStat = await stat(sessionFilePath);
      const lastActivityAt = fileStat.mtime.toISOString();
      const timestamp = fileStat.mtime.getTime();
      if (from !== undefined && timestamp < from) continue;
      if (to !== undefined && timestamp > to) continue;

      const scopedPath = join(HOME_DIR, entry.name, `${sessionId}.json`);
      sessions.push({
        id: sessionId,
        projectPath,
        lastActivityAt,
        hasOverride: existsSync(scopedPath),
      });
    }
  }

  return sessions
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
    .slice(0, limit);
};

export const getSessionScopedConfig = async (sessionId: string, projectPath?: string): Promise<ScopedConfigFile> => {
  const filePath = await getSessionConfigFilePath(sessionId, projectPath);
  return readScopedConfigFile(filePath);
};

export const saveSessionScopedConfig = async (sessionId: string, routerConfig: ScopedRouterConfig, projectPath?: string) => {
  const filePath = await getSessionConfigFilePath(sessionId, projectPath);
  if (!filePath) {
    throw new Error("Session project not found");
  }
  await writeScopedConfigFile(filePath, { Router: routerConfig });
  return { success: true, message: "Session config saved successfully" };
};
