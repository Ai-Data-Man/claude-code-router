export interface SharedModelConfig {
  name: string;
  enabled?: boolean;
}

export interface SharedProviderTransformer {
  use?: (string | (string | Record<string, unknown>)[])[];
  [key: string]: any;
}

export interface SharedProviderConfig {
  name: string;
  api_base_url: string;
  api_key: string;
  models: Array<string | SharedModelConfig>;
  enabled?: boolean;
  transformer?: SharedProviderTransformer;
}

export interface ScopedRouterConfig {
  default?: string;
  background?: string;
  think?: string;
  longContext?: string;
  longContextThreshold?: number;
  webSearch?: string;
  image?: string;
}

export interface GlobalConfigPatch {
  LOG?: boolean;
  LOG_LEVEL?: string;
  CLAUDE_PATH?: string;
  HOST?: string;
  PORT?: number;
  APIKEY?: string;
  API_TIMEOUT_MS?: string;
  PROXY_URL?: string;
  CUSTOM_ROUTER_PATH?: string;
  forceUseImageAgent?: boolean;
  transformers?: any[];
  Router?: ScopedRouterConfig;
}

export interface ProjectIndexItem {
  path: string;
  label: string;
  hasOverride: boolean;
  lastActivityAt?: string;
  source?: "auto" | "manual";
}

export interface SessionIndexItem {
  id: string;
  projectPath: string;
  lastActivityAt: string;
  hasOverride: boolean;
}

export interface ScopedConfigFile {
  Router?: ScopedRouterConfig;
}

export interface ScopedConfigSnapshot {
  sharedProviders: SharedProviderConfig[];
  globalConfig: GlobalConfigPatch;
}

export function normalizeProjectPath(input: string): string {
  return input.replace(/\\/g, "/").replace(/\/+$/, "").trim();
}

export function getProjectLabel(projectPath: string): string {
  const normalized = normalizeProjectPath(projectPath);
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

export function normalizeSharedProviders(providers: any[] = []): SharedProviderConfig[] {
  if (!Array.isArray(providers)) return [];

  return providers
    .filter((provider) => provider && typeof provider === "object")
    .map((provider) => ({
      ...provider,
      enabled: provider.enabled !== false,
      models: Array.isArray(provider.models)
        ? provider.models
            .map((model: any) => {
              if (typeof model === "string") {
                return { name: model, enabled: true };
              }
              if (model && typeof model === "object" && typeof model.name === "string") {
                return { ...model, enabled: model.enabled !== false };
              }
              return null;
            })
            .filter(Boolean)
        : [],
    }));
}

export function serializeSharedProviders(providers: SharedProviderConfig[] = []): any[] {
  return providers.map((provider) => ({
    ...provider,
    enabled: provider.enabled !== false ? undefined : false,
    models: (provider.models || []).map((model) => {
      if (typeof model === "string") {
        return model;
      }
      return model.enabled === false ? { name: model.name, enabled: false } : model.name;
    }),
  }));
}

export function pickGlobalConfig(config: Record<string, any>): GlobalConfigPatch {
  return {
    LOG: config.LOG,
    LOG_LEVEL: config.LOG_LEVEL,
    CLAUDE_PATH: config.CLAUDE_PATH,
    HOST: config.HOST,
    PORT: config.PORT,
    APIKEY: config.APIKEY,
    API_TIMEOUT_MS: config.API_TIMEOUT_MS,
    PROXY_URL: config.PROXY_URL,
    CUSTOM_ROUTER_PATH: config.CUSTOM_ROUTER_PATH,
    forceUseImageAgent: config.forceUseImageAgent,
    transformers: Array.isArray(config.transformers) ? config.transformers : [],
    Router: config.Router || {},
  };
}
