export interface ProviderTransformer {
  use: (string | (string | Record<string, unknown> | { max_tokens: number })[])[];
  [key: string]: any; // Allow for model-specific transformers
}

export interface ProviderModel {
  name: string;
  enabled?: boolean;
}

export interface Provider {
  name: string;
  api_base_url: string;
  api_key: string;
  models: Array<string | ProviderModel>;
  enabled?: boolean;
  models_path?: string;
  transformer?: ProviderTransformer;
}

export interface RouterConfig {
    default: string;
    background: string;
    think: string;
    longContext: string;
    longContextThreshold: number;
    webSearch: string;
    image: string;
    custom?: any;
}

export interface ScopedRouterConfig extends Partial<RouterConfig> {
  [key: string]: string | number | undefined;
}

export type ScopeType = 'global' | 'project' | 'session';
export type ViewMode = 'effective' | 'override';

export interface ProjectItem {
  path: string;
  label: string;
  hasOverride: boolean;
  lastActivityAt?: string;
  source?: 'auto' | 'manual';
}

export interface SessionItem {
  id: string;
  projectPath: string;
  lastActivityAt: string;
  hasOverride: boolean;
}

export interface EffectiveFieldState<T = string | number> {
  value: T;
  source: string;
  overridden: boolean;
}

export interface ScopedConfigState {
  scope: ScopeType;
  viewMode: ViewMode;
  activeProjectPath: string;
  activeSessionId: string;
  projectItems: ProjectItem[];
  sessionItems: SessionItem[];
  projectRouter: ScopedRouterConfig;
  sessionRouter: ScopedRouterConfig;
  scopedAvailable: boolean;
}

export interface Transformer {
    name?: string;
    path: string;
    options?: Record<string, any>;
}

export interface StatusLineModuleConfig {
  type: string;
  icon?: string;
  text: string;
  color?: string;
  background?: string;
  scriptPath?: string; // 用于script类型的模块，指定要执行的Node.js脚本文件路径
}

export interface StatusLineThemeConfig {
  modules: StatusLineModuleConfig[];
}

export interface StatusLineConfig {
  enabled: boolean;
  currentStyle: string;
  default: StatusLineThemeConfig;
  powerline: StatusLineThemeConfig;
  fontFamily?: string;
}

export interface Config {
  Providers: Provider[];
  Router: RouterConfig;
  transformers: Transformer[];
  StatusLine?: StatusLineConfig;
  forceUseImageAgent?: boolean;
  // Top-level settings
  LOG: boolean;
  LOG_LEVEL: string;
  CLAUDE_PATH: string;
  HOST: string;
  PORT: number;
  APIKEY: string;
  API_TIMEOUT_MS: string;
  PROXY_URL: string;
  CUSTOM_ROUTER_PATH?: string;
}

export type AccessLevel = 'restricted' | 'full';
