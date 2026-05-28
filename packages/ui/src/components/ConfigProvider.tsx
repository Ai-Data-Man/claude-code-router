import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { ReactNode, Dispatch, SetStateAction } from 'react';
import { api } from '@/lib/api';
import type { Config, ScopedConfigState, ScopedRouterConfig, EffectiveFieldState, RouterConfig } from '@/types';

interface ConfigContextType {
  config: Config | null;
  setConfig: Dispatch<SetStateAction<Config | null>>;
  error: Error | null;
  scoped: ScopedConfigState;
  setScoped: Dispatch<SetStateAction<ScopedConfigState>>;
  getEffectiveRouter: () => RouterConfig;
  getFieldSource: (field: keyof RouterConfig) => EffectiveFieldState;
  saveScopedRouter: (router: ScopedRouterConfig) => Promise<void>;
  saveSharedProviders: (providers: Config['Providers']) => Promise<void>;
  refreshSharedProviders: () => Promise<void>;
  refreshProjectIndex: () => Promise<void>;
  refreshSessionIndex: (options?: { limit?: number; from?: string; to?: string; projectPath?: string }) => Promise<void>;
}

const defaultScoped: ScopedConfigState = {
  scope: 'global',
  viewMode: 'effective',
  activeProjectPath: '',
  activeSessionId: '',
  projectItems: [],
  sessionItems: [],
  projectRouter: {},
  sessionRouter: {},
  scopedAvailable: false,
};

const ConfigContext = createContext<ConfigContextType | undefined>(undefined);

// eslint-disable-next-line react-refresh/only-export-components
export function useConfig() {
  const context = useContext(ConfigContext);
  if (context === undefined) {
    throw new Error('useConfig must be used within a ConfigProvider');
  }
  return context;
}

interface ConfigProviderProps {
  children: ReactNode;
}

const normalizeProviders = (providers: any[]): Config['Providers'] => {
  if (!Array.isArray(providers)) return [];
  return providers.filter(Boolean).map((p: any) => ({
    ...p,
    enabled: p.enabled !== false,
    models: Array.isArray(p.models)
      ? p.models.map((m: any) => typeof m === 'string' ? { name: m, enabled: true } : { ...m, enabled: m.enabled !== false })
      : [],
  }));
};

const normalizeRouter = (router: any): RouterConfig => ({
  default: router?.default ?? '',
  background: router?.background ?? '',
  think: router?.think ?? '',
  longContext: router?.longContext ?? '',
  longContextThreshold: router?.longContextThreshold ?? 60000,
  webSearch: router?.webSearch ?? '',
  image: router?.image ?? '',
});

export function ConfigProvider({ children }: ConfigProviderProps) {
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [hasFetched, setHasFetched] = useState<boolean>(false);
  const [apiKey, setApiKey] = useState<string | null>(localStorage.getItem('apiKey'));
  const [scoped, setScoped] = useState<ScopedConfigState>(defaultScoped);

  useEffect(() => {
    const handleStorageChange = () => setApiKey(localStorage.getItem('apiKey'));
    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  useEffect(() => {
    setHasFetched(false);
    setConfig(null);
    setError(null);
  }, [apiKey]);

  const refreshProjectIndex = useCallback(async () => {
    if (!scoped.scopedAvailable) return;
    try {
      const { projects } = await api.listProjects();
      setScoped(prev => ({ ...prev, projectItems: projects }));
    } catch {}
  }, [scoped.scopedAvailable]);

  const refreshSessionIndex = useCallback(async (options?: { limit?: number; from?: string; to?: string; projectPath?: string }) => {
    if (!scoped.scopedAvailable) return;
    try {
      const { sessions } = await api.listRecentSessions(options);
      setScoped(prev => ({ ...prev, sessionItems: sessions }));
    } catch {}
  }, [scoped.scopedAvailable]);

  useEffect(() => {
    const fetchConfig = async () => {
      if (hasFetched) return;
      setHasFetched(true);

      let scopedAvailable = false;
      try {
        scopedAvailable = await api.probeScopedConfig();
      } catch {
        scopedAvailable = false;
      }

      try {
        const data = await api.getConfig();

        let sharedProviders = normalizeProviders(data.Providers || (data as any).providers || []);
        if (scopedAvailable) {
          try {
            const shared = await api.getSharedProviders();
            sharedProviders = normalizeProviders(shared.providers || []);
          } catch {
            // Fall back to base config providers
          }
        }

        const validConfig: Config = {
          LOG: typeof data.LOG === 'boolean' ? data.LOG : false,
          LOG_LEVEL: typeof data.LOG_LEVEL === 'string' ? data.LOG_LEVEL : 'debug',
          LOG_MAX_SIZE: typeof data.LOG_MAX_SIZE === 'string' && data.LOG_MAX_SIZE ? data.LOG_MAX_SIZE : '200M',
          CLAUDE_PATH: typeof data.CLAUDE_PATH === 'string' ? data.CLAUDE_PATH : '',
          HOST: typeof data.HOST === 'string' ? data.HOST : '127.0.0.1',
          PORT: typeof data.PORT === 'number' ? data.PORT : 3456,
          APIKEY: typeof data.APIKEY === 'string' ? data.APIKEY : '',
          API_TIMEOUT_MS: typeof data.API_TIMEOUT_MS === 'string' ? data.API_TIMEOUT_MS : '600000',
          PROXY_URL: typeof data.PROXY_URL === 'string' ? data.PROXY_URL : '',
          transformers: Array.isArray(data.transformers) ? data.transformers : [],
          Providers: sharedProviders,
          StatusLine: data.StatusLine && typeof data.StatusLine === 'object' ? {
            enabled: typeof data.StatusLine.enabled === 'boolean' ? data.StatusLine.enabled : false,
            currentStyle: typeof data.StatusLine.currentStyle === 'string' ? data.StatusLine.currentStyle : 'default',
            default: data.StatusLine.default && typeof data.StatusLine.default === 'object' && Array.isArray(data.StatusLine.default.modules) ? data.StatusLine.default : { modules: [] },
            powerline: data.StatusLine.powerline && typeof data.StatusLine.powerline === 'object' && Array.isArray(data.StatusLine.powerline.modules) ? data.StatusLine.powerline : { modules: [] }
          } : { enabled: false, currentStyle: 'default', default: { modules: [] }, powerline: { modules: [] } },
          Router: normalizeRouter(data.Router),
          CUSTOM_ROUTER_PATH: typeof data.CUSTOM_ROUTER_PATH === 'string' ? data.CUSTOM_ROUTER_PATH : ''
        };
        setConfig(validConfig);
        setScoped(prev => ({ ...prev, scopedAvailable }));

        if (scopedAvailable) {
          try {
            const { projects } = await api.listProjects();
            setScoped(prev => ({ ...prev, projectItems: projects }));
          } catch {}
        }
      } catch (err) {
        console.error('Failed to fetch config:', err);
        if ((err as Error).message !== 'Unauthorized') {
          setConfig({
            LOG: false, LOG_LEVEL: 'debug', CLAUDE_PATH: '', HOST: '127.0.0.1', PORT: 3456,
            APIKEY: '', API_TIMEOUT_MS: '600000', PROXY_URL: '', transformers: [], Providers: [],
            StatusLine: undefined,
            Router: { default: '', background: '', think: '', longContext: '', longContextThreshold: 60000, webSearch: '', image: '' },
            CUSTOM_ROUTER_PATH: ''
          });
          setError(err as Error);
        }
      }
    };
    fetchConfig();
  }, [hasFetched, apiKey]);

  useEffect(() => {
    const loadProjectRouter = async () => {
      if (!scoped.scopedAvailable || !scoped.activeProjectPath) {
        setScoped(prev => ({ ...prev, projectRouter: {} }));
        return;
      }
      try {
        const projectConfig = await api.getProjectConfig(scoped.activeProjectPath);
        setScoped(prev => ({ ...prev, projectRouter: projectConfig.Router || {} }));
      } catch {
        setScoped(prev => ({ ...prev, projectRouter: {} }));
      }
    };
    loadProjectRouter();
  }, [scoped.scopedAvailable, scoped.activeProjectPath]);

  useEffect(() => {
    const loadSessionRouter = async () => {
      if (!scoped.scopedAvailable || !scoped.activeSessionId) {
        setScoped(prev => ({ ...prev, sessionRouter: {} }));
        return;
      }
      try {
        const sessionConfig = await api.getSessionConfig(scoped.activeSessionId, scoped.activeProjectPath || undefined);
        setScoped(prev => ({ ...prev, sessionRouter: sessionConfig.Router || {} }));
      } catch {
        setScoped(prev => ({ ...prev, sessionRouter: {} }));
      }
    };
    loadSessionRouter();
  }, [scoped.scopedAvailable, scoped.activeSessionId, scoped.activeProjectPath]);

  const getEffectiveRouter = useCallback((): RouterConfig => {
    const globalRouter = config?.Router ?? normalizeRouter({});
    if (scoped.scope === 'global' || !scoped.scopedAvailable) return globalRouter;
    if (scoped.scope === 'project') {
      return { ...globalRouter, ...scoped.projectRouter };
    }
    if (scoped.scope === 'session') {
      return { ...globalRouter, ...scoped.projectRouter, ...scoped.sessionRouter };
    }
    return globalRouter;
  }, [config?.Router, scoped]);

  const getFieldSource = useCallback((field: keyof RouterConfig): EffectiveFieldState => {
    const value = getEffectiveRouter()[field];
    if (scoped.scope === 'global' || !scoped.scopedAvailable) {
      return { value: value as string | number, source: '全局定义', overridden: false };
    }
    if (scoped.scope === 'session') {
      if ((scoped.sessionRouter as any)?.[field] !== undefined) {
        return { value: value as string | number, source: '当前会话覆盖', overridden: true };
      }
      if ((scoped.projectRouter as any)?.[field] !== undefined) {
        return { value: value as string | number, source: '继承自项目', overridden: false };
      }
      return { value: value as string | number, source: '继承自全局', overridden: false };
    }
    if (scoped.scope === 'project') {
      if ((scoped.projectRouter as any)?.[field] !== undefined) {
        return { value: value as string | number, source: '当前项目覆盖', overridden: true };
      }
      return { value: value as string | number, source: '继承自全局', overridden: false };
    }
    return { value: value as string | number, source: '全局定义', overridden: false };
  }, [getEffectiveRouter, scoped]);

  const saveScopedRouter = useCallback(async (router: ScopedRouterConfig) => {
    if (!scoped.scopedAvailable) {
      if (config) {
        setConfig({ ...config, Router: { ...config.Router, ...router } as RouterConfig });
      }
      return;
    }
    if (scoped.scope === 'global') {
      if (config) {
        setConfig({ ...config, Router: { ...config.Router, ...router } as RouterConfig });
        await api.updateConfig({ ...config, Router: { ...config.Router, ...router } });
      }
    } else if (scoped.scope === 'project' && scoped.activeProjectPath) {
      await api.saveProjectConfig(scoped.activeProjectPath, router);
      setScoped(prev => ({ ...prev, projectRouter: router }));
    } else if (scoped.scope === 'session' && scoped.activeSessionId) {
      await api.saveSessionConfig(scoped.activeSessionId, router, scoped.activeProjectPath || undefined);
      setScoped(prev => ({ ...prev, sessionRouter: router }));
    }
  }, [config, scoped]);

  const refreshSharedProviders = useCallback(async () => {
    try {
      const { providers } = await api.getSharedProviders();
      setConfig(prev => prev ? { ...prev, Providers: normalizeProviders(providers) } : prev);
    } catch {
      // Keep existing config for compatibility fallback.
    }
  }, []);

  const saveSharedProviders = useCallback(async (providers: Config['Providers']) => {
    const normalized = normalizeProviders(providers);
    await api.saveSharedProviders(normalized);
    setConfig(prev => prev ? { ...prev, Providers: normalized } : prev);
  }, []);

  return (
    <ConfigContext.Provider value={{ config, setConfig, error, scoped, setScoped, getEffectiveRouter, getFieldSource, saveScopedRouter, saveSharedProviders, refreshSharedProviders, refreshProjectIndex, refreshSessionIndex }}>
      {children}
    </ConfigContext.Provider>
  );
}
