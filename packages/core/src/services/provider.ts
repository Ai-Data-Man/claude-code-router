import { TransformerConstructor } from "@/types/transformer";
import {
  LLMProvider,
  RegisterProviderRequest,
  ModelRoute,
  RequestRouteInfo,
  ConfigProvider,
} from "../types/llm";
import { ConfigService } from "./config"; 
import { TransformerService } from "./transformer";

export class ProviderService {
  private providers: Map<string, LLMProvider> = new Map();
  private modelRoutes: Map<string, ModelRoute> = new Map();

  constructor(private readonly configService: ConfigService, private readonly transformerService: TransformerService, private readonly logger: any) {
    this.initializeCustomProviders();
  }

  private initializeCustomProviders() {
    const providersConfig =
      this.configService.get<ConfigProvider[]>("providers") ??
      this.configService.get<ConfigProvider[]>("Providers");
    if (providersConfig && Array.isArray(providersConfig)) {
      this.initializeFromProvidersArray(providersConfig);
      return;
    }
  }

  /**
   * Rebuild in-memory providers and model routes from the current config.
   * Called after config reload so provider/transformer changes apply
   * without a service restart. Reuses the same instance, so the
   * fastify-decorated reference stays valid.
   */
  reloadFromConfig(): void {
    this.providers.clear();
    this.modelRoutes.clear();
    this.initializeCustomProviders();
    this.logger.info("ProviderService reloaded from config");
  }

  private initializeFromProvidersArray(providersConfig: ConfigProvider[]) {
    providersConfig.forEach((providerConfig: ConfigProvider) => {
      try {
        if (
          !providerConfig.name ||
          !providerConfig.api_base_url ||
          !providerConfig.api_key
        ) {
          return;
        }

        const transformer: LLMProvider["transformer"] = {}

        const resolveTransformerEntry = (entry: any): any => {
          if (Array.isArray(entry) && typeof entry[0] === 'string') {
            const Constructor = this.transformerService.getTransformer(entry[0]);
            return Constructor
              ? new (Constructor as TransformerConstructor)(entry[1])
              : undefined;
          }
          if (typeof entry === 'string') {
            const transformerInstance = this.transformerService.getTransformer(entry);
            if (typeof transformerInstance === 'function') {
              return new transformerInstance();
            }
            return transformerInstance;
          }
          // UI round-trip serializes transformer instances into plain objects
          // (e.g. {"name":"Anthropic",...}); resolve by name instead of dropping.
          if (entry && typeof entry === 'object' && typeof entry.name === 'string') {
            const transformerInstance = this.transformerService.getTransformer(entry.name);
            if (typeof transformerInstance === 'function') {
              return new transformerInstance(entry.options);
            }
            return transformerInstance;
          }
          return undefined;
        };

        if (providerConfig.transformer) {
          Object.keys(providerConfig.transformer).forEach(key => {
            if (key === 'use') {
              if (Array.isArray(providerConfig.transformer.use)) {
                transformer.use = providerConfig.transformer.use
                  .map(resolveTransformerEntry)
                  .filter((transformer: any) => typeof transformer !== 'undefined');
              }
            } else {
              if (Array.isArray(providerConfig.transformer[key]?.use)) {
                transformer[key] = {
                  use: providerConfig.transformer[key].use
                    .map(resolveTransformerEntry)
                    .filter((transformer: any) => typeof transformer !== 'undefined')
                }
              }
            }
          })
        }

        this.registerProvider({
          name: providerConfig.name,
          baseUrl: providerConfig.api_base_url,
          apiKey: providerConfig.api_key,
          models: providerConfig.models || [],
          transformer: providerConfig.transformer ? transformer : undefined,
        });

        this.logger.info(`${providerConfig.name} provider registered`);
      } catch (error) {
        this.logger.error(`${providerConfig.name} provider registered error: ${error}`);
      }
    });
  }

  registerProvider(request: RegisterProviderRequest): LLMProvider {
    const provider: LLMProvider = {
      ...request,
    };

    this.providers.set(provider.name, provider);

    request.models.forEach((model) => {
      const fullModel = `${provider.name},${model}`;
      const route: ModelRoute = {
        provider: provider.name,
        model,
        fullModel,
      };
      this.modelRoutes.set(fullModel, route);
      if (!this.modelRoutes.has(model)) {
        this.modelRoutes.set(model, route);
      }
    });

    return provider;
  }

  getProviders(): LLMProvider[] {
    return Array.from(this.providers.values());
  }

  getProvider(name: string): LLMProvider | undefined {
    return this.providers.get(name);
  }

  updateProvider(
    id: string,
    updates: Partial<LLMProvider>
  ): LLMProvider | null {
    const provider = this.providers.get(id);
    if (!provider) {
      return null;
    }

    const updatedProvider = {
      ...provider,
      ...updates,
      updatedAt: new Date(),
    };

    this.providers.set(id, updatedProvider);

    if (updates.models) {
      provider.models.forEach((model) => {
        const fullModel = `${provider.name},${model}`;
        this.modelRoutes.delete(fullModel);
        this.modelRoutes.delete(model);
      });

      updates.models.forEach((model) => {
        const fullModel = `${provider.name},${model}`;
        const route: ModelRoute = {
          provider: provider.name,
          model,
          fullModel,
        };
        this.modelRoutes.set(fullModel, route);
        if (!this.modelRoutes.has(model)) {
          this.modelRoutes.set(model, route);
        }
      });
    }

    return updatedProvider;
  }

  deleteProvider(id: string): boolean {
    const provider = this.providers.get(id);
    if (!provider) {
      return false;
    }

    provider.models.forEach((model) => {
      const fullModel = `${provider.name},${model}`;
      this.modelRoutes.delete(fullModel);
      this.modelRoutes.delete(model);
    });

    this.providers.delete(id);
    return true;
  }

  toggleProvider(name: string, enabled: boolean): boolean {
    const provider = this.providers.get(name);
    if (!provider) {
      return false;
    }
    return true;
  }

  resolveModelRoute(modelName: string): RequestRouteInfo | null {
    const route = this.modelRoutes.get(modelName);
    if (!route) {
      return null;
    }

    const provider = this.providers.get(route.provider);
    if (!provider) {
      return null;
    }

    return {
      provider,
      originalModel: modelName,
      targetModel: route.model,
    };
  }

  getAvailableModelNames(): string[] {
    const modelNames: string[] = [];
    this.providers.forEach((provider) => {
      provider.models.forEach((model) => {
        modelNames.push(model);
        modelNames.push(`${provider.name},${model}`);
      });
    });
    return modelNames;
  }

  getModelRoutes(): ModelRoute[] {
    return Array.from(this.modelRoutes.values());
  }

  private parseTransformerConfig(transformerConfig: any): any {
    if (!transformerConfig) return {};

    if (Array.isArray(transformerConfig)) {
      return transformerConfig.reduce((acc, item) => {
        if (Array.isArray(item)) {
          const [name, config = {}] = item;
          acc[name] = config;
        } else {
          acc[item] = {};
        }
        return acc;
      }, {});
    }

    return transformerConfig;
  }

  async getAvailableModels(): Promise<{
    object: string;
    data: Array<{
      id: string;
      object: string;
      owned_by: string;
      provider: string;
    }>;
  }> {
    const models: Array<{
      id: string;
      object: string;
      owned_by: string;
      provider: string;
    }> = [];

    this.providers.forEach((provider) => {
      provider.models.forEach((model) => {
        models.push({
          id: model,
          object: "model",
          owned_by: provider.name,
          provider: provider.name,
        });

        models.push({
          id: `${provider.name},${model}`,
          object: "model",
          owned_by: provider.name,
          provider: provider.name,
        });
      });
    });

    return {
      object: "list",
      data: models,
    };
  }
}
