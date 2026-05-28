import { get_encoding } from "tiktoken";
import { sessionUsageCache, Usage } from "./cache";
import { readFile } from "fs/promises";
import { opendir, stat } from "fs/promises";
import { join } from "path";
import { CLAUDE_PROJECTS_DIR, HOME_DIR } from "@CCR/shared";
import { LRUCache } from "lru-cache";
import { ConfigService } from "../services/config";
import { TokenizerService } from "../services/tokenizer";

// Types from @anthropic-ai/sdk
interface Tool {
  name: string;
  description?: string;
  input_schema: object;
}

interface ContentBlockParam {
  type: string;
  [key: string]: any;
}

interface MessageParam {
  role: string;
  content: string | ContentBlockParam[];
}

interface MessageCreateParamsBase {
  messages?: MessageParam[];
  system?: string | any[];
  tools?: Tool[];
  [key: string]: any;
}

const enc = get_encoding("cl100k_base");

export const extractSessionIdFromUserId = (
  userId: unknown
): { sessionId?: string; source?: "json" | "object" | "legacy" } => {
  if (!userId) return {};

  if (typeof userId === "object") {
    const objectValue = userId as Record<string, any>;
    if (typeof objectValue.session_id === "string" && objectValue.session_id) {
      return { sessionId: objectValue.session_id, source: "object" };
    }
    if (typeof objectValue.metadata?.session_id === "string" && objectValue.metadata.session_id) {
      return { sessionId: objectValue.metadata.session_id, source: "object" };
    }
    return {};
  }

  if (typeof userId !== "string") return {};

  const trimmed = userId.trim();
  if (!trimmed) return {};

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.session_id === "string" && parsed.session_id) {
        return { sessionId: parsed.session_id, source: "json" };
      }
      if (typeof parsed.metadata?.session_id === "string" && parsed.metadata.session_id) {
        return { sessionId: parsed.metadata.session_id, source: "json" };
      }
    }
  } catch {}

  const legacyMatch = trimmed.match(/_session_([a-f0-9-]+)/i);
  if (legacyMatch) {
    return { sessionId: legacyMatch[1], source: "legacy" };
  }

  const sessionFieldMatch = trimmed.match(/"session_id"\s*:\s*"([^"]+)"/i);
  if (sessionFieldMatch) {
    return { sessionId: sessionFieldMatch[1], source: "json" };
  }

  return {};
};

export const calculateTokenCount = (
  messages: MessageParam[],
  system: any,
  tools: Tool[]
) => {
  let tokenCount = 0;
  if (Array.isArray(messages)) {
    messages.forEach((message) => {
      if (typeof message.content === "string") {
        tokenCount += enc.encode(message.content).length;
      } else if (Array.isArray(message.content)) {
        message.content.forEach((contentPart: any) => {
          if (contentPart.type === "text") {
            tokenCount += enc.encode(contentPart.text).length;
          } else if (contentPart.type === "tool_use") {
            tokenCount += enc.encode(JSON.stringify(contentPart.input)).length;
          } else if (contentPart.type === "tool_result") {
            tokenCount += enc.encode(
              typeof contentPart.content === "string"
                ? contentPart.content
                : JSON.stringify(contentPart.content)
            ).length;
          }
        });
      }
    });
  }
  if (typeof system === "string") {
    tokenCount += enc.encode(system).length;
  } else if (Array.isArray(system)) {
    system.forEach((item: any) => {
      if (item.type !== "text") return;
      if (typeof item.text === "string") {
        tokenCount += enc.encode(item.text).length;
      } else if (Array.isArray(item.text)) {
        item.text.forEach((textPart: any) => {
          tokenCount += enc.encode(textPart || "").length;
        });
      }
    });
  }
  if (tools) {
    tools.forEach((tool: Tool) => {
      if (tool.description) {
        tokenCount += enc.encode(tool.name + tool.description).length;
      }
      if (tool.input_schema) {
        tokenCount += enc.encode(JSON.stringify(tool.input_schema)).length;
      }
    });
  }
  return tokenCount;
};

const getProjectSpecificRouter = async (
  req: any,
  configService: ConfigService
) => {
  req.log?.debug(
    {
      sessionId: req.sessionId,
      metadataUserId: req.body?.metadata?.user_id,
    },
    "Resolving project specific router"
  );

  // Check if there is project-specific configuration
  if (req.sessionId) {
    const project = await searchProjectBySession(req.sessionId, req.log);
    req.log?.debug({ sessionId: req.sessionId, project }, "Resolved project folder from session");
    if (project) {
      const projectConfigPath = join(HOME_DIR, project, "config.json");
      const sessionConfigPath = join(
        HOME_DIR,
        project,
        `${req.sessionId}.json`
      );

      req.log?.debug(
        { sessionId: req.sessionId, project, sessionConfigPath, projectConfigPath },
        "Attempting to load scoped router config files"
      );

      // First try to read sessionConfig file
      try {
        const sessionConfig = JSON.parse(await readFile(sessionConfigPath, "utf8"));
        if (sessionConfig && sessionConfig.Router) {
          req.log?.debug({ sessionId: req.sessionId, project, sessionConfigPath, router: sessionConfig.Router }, "Using session scoped router config");
          return sessionConfig.Router;
        }
        req.log?.debug({ sessionId: req.sessionId, project, sessionConfigPath }, "Session scoped config loaded but Router missing");
      } catch (error: any) {
        req.log?.debug({ sessionId: req.sessionId, project, sessionConfigPath, error: error?.message }, "Failed to load session scoped config");
      }
      try {
        const projectConfig = JSON.parse(await readFile(projectConfigPath, "utf8"));
        if (projectConfig && projectConfig.Router) {
          req.log?.debug({ sessionId: req.sessionId, project, projectConfigPath, router: projectConfig.Router }, "Using project scoped router config");
          return projectConfig.Router;
        }
        req.log?.debug({ sessionId: req.sessionId, project, projectConfigPath }, "Project scoped config loaded but Router missing");
      } catch (error: any) {
        req.log?.debug({ sessionId: req.sessionId, project, projectConfigPath, error: error?.message }, "Failed to load project scoped config");
      }
    }
  }
  req.log?.debug({ sessionId: req.sessionId }, "No scoped router config found; falling back to global router");
  return undefined; // Return undefined to use original configuration
};

const getUseModel = async (
  req: any,
  tokenCount: number,
  configService: ConfigService,
  lastUsage?: Usage | undefined
): Promise<{ model: string; scenarioType: RouterScenarioType }> => {
  const projectSpecificRouter = await getProjectSpecificRouter(req, configService);
  const providers = configService.get<any[]>("providers") || [];
  const Router = projectSpecificRouter || configService.get("Router");
  req.log?.debug(
    {
      sessionId: req.sessionId,
      projectSpecificRouter,
      globalRouter: configService.get("Router"),
      effectiveRouter: Router,
    },
    "Computed effective router configuration"
  );

  if (req.body.model.includes(",")) {
    const [provider, model] = req.body.model.split(",");
    const finalProvider = providers.find(
      (p: any) => p.name.toLowerCase() === provider
    );
    const finalModel = finalProvider?.models?.find(
      (m: any) => m.toLowerCase() === model
    );
    if (finalProvider && finalModel) {
      return { model: `${finalProvider.name},${finalModel}`, scenarioType: 'default' };
    }
    return { model: req.body.model, scenarioType: 'default' };
  }

  // if tokenCount is greater than the configured threshold, use the long context model
  const longContextThreshold = Router?.longContextThreshold || 60000;
  const lastUsageThreshold =
    lastUsage &&
    lastUsage.input_tokens > longContextThreshold &&
    tokenCount > 20000;
  const tokenCountThreshold = tokenCount > longContextThreshold;
  if ((lastUsageThreshold || tokenCountThreshold) && Router?.longContext) {
    req.log.info(
      `Using long context model due to token count: ${tokenCount}, threshold: ${longContextThreshold}`
    );
    return { model: Router.longContext, scenarioType: 'longContext' };
  }
  if (
    req.body?.system?.length > 1 &&
    req.body?.system[1]?.text?.startsWith("<CCR-SUBAGENT-MODEL>")
  ) {
    const model = req.body?.system[1].text.match(
      /<CCR-SUBAGENT-MODEL>(.*?)<\/CCR-SUBAGENT-MODEL>/s
    );
    if (model) {
      req.body.system[1].text = req.body.system[1].text.replace(
        `<CCR-SUBAGENT-MODEL>${model[1]}</CCR-SUBAGENT-MODEL>`,
        ""
      );
      return { model: model[1], scenarioType: 'default' };
    }
  }
  // Use the background model for any Claude Haiku variant
  const globalRouter = configService.get("Router");
  if (
    req.body.model?.includes("claude") &&
    req.body.model?.includes("haiku") &&
    globalRouter?.background
  ) {
    req.log.info(`Using background model for ${req.body.model}`);
    return { model: globalRouter.background, scenarioType: 'background' };
  }
  // The priority of websearch must be higher than thinking.
  if (
    Array.isArray(req.body.tools) &&
    req.body.tools.some((tool: any) => tool.type?.startsWith("web_search")) &&
    Router?.webSearch
  ) {
    return { model: Router.webSearch, scenarioType: 'webSearch' };
  }
  // if exits thinking, use the think model
  if (req.body.thinking && Router?.think) {
    req.log.info(`Using think model for ${req.body.thinking}`);
    return { model: Router.think, scenarioType: 'think' };
  }
  return { model: Router?.default, scenarioType: 'default' };
};

export interface RouterContext {
  configService: ConfigService;
  tokenizerService?: TokenizerService;
  event?: any;
}

export type RouterScenarioType = 'default' | 'background' | 'think' | 'longContext' | 'webSearch';

export interface RouterFallbackConfig {
  default?: string[];
  background?: string[];
  think?: string[];
  longContext?: string[];
  webSearch?: string[];
}

export const router = async (req: any, _res: any, context: RouterContext) => {
  const { configService, event } = context;
  const parsedSession = extractSessionIdFromUserId(req.body.metadata?.user_id);
  if (parsedSession.sessionId) {
    req.sessionId = parsedSession.sessionId;
  }
  req.log?.debug(
    {
      metadataUserId: req.body.metadata?.user_id,
      sessionId: req.sessionId,
      hasSessionDelimiter: typeof req.body.metadata?.user_id === "string" ? req.body.metadata.user_id.includes("_session_") : false,
      sessionIdSource: parsedSession.source,
    },
    "Parsed session id from request metadata"
  );
  const lastMessageUsage = sessionUsageCache.get(req.sessionId);
  const { messages, system = [], tools }: MessageCreateParamsBase = req.body;
  const rewritePrompt = configService.get("REWRITE_SYSTEM_PROMPT");
  if (
    rewritePrompt &&
    system.length > 1 &&
    system[1]?.text?.includes("<env>")
  ) {
    const prompt = await readFile(rewritePrompt, "utf-8");
    system[1].text = `${prompt}<env>${system[1].text.split("<env>").pop()}`;
  }

  try {
    // Try to get tokenizer config for the current model
    const [providerName, modelName] = req.body.model.split(",");
    const tokenizerConfig = context.tokenizerService?.getTokenizerConfigForModel(
      providerName,
      modelName
    );

    // Use TokenizerService if available, otherwise fall back to legacy method
    let tokenCount: number;

    if (context.tokenizerService) {
      const result = await context.tokenizerService.countTokens(
        {
          messages: messages as MessageParam[],
          system,
          tools: tools as Tool[],
        },
        tokenizerConfig
      );
      tokenCount = result.tokenCount;
    } else {
      // Legacy fallback
      tokenCount = calculateTokenCount(
        messages as MessageParam[],
        system,
        tools as Tool[]
      );
    }

    let model;
    const customRouterPath = configService.get("CUSTOM_ROUTER_PATH");
    if (customRouterPath) {
      try {
        const customRouter = require(customRouterPath);
        req.tokenCount = tokenCount; // Pass token count to custom router
        model = await customRouter(req, configService.getAll(), {
          event,
        });
      } catch (e: any) {
        req.log.error(`failed to load custom router: ${e.message}`);
      }
    }
    if (!model) {
      const result = await getUseModel(req, tokenCount, configService, lastMessageUsage);
      model = result.model;
      req.scenarioType = result.scenarioType;
      req.log?.debug(
        {
          sessionId: req.sessionId,
          model,
          scenarioType: req.scenarioType,
        },
        "Selected routed model"
      );
    } else {
      // Custom router doesn't provide scenario type, default to 'default'
      req.scenarioType = 'default';
    }
    req.body.model = model;
  } catch (error: any) {
    req.log.error(`Error in router middleware: ${error.message}`);
    const Router = configService.get("Router");
    req.body.model = Router?.default;
    req.scenarioType = 'default';
  }
  return;
};

// Memory cache for sessionId to project name mapping
// null value indicates previously searched but not found
// Uses LRU cache with max 1000 entries
const sessionProjectCache = new LRUCache<string, string>({
  max: 1000,
});

export const searchProjectBySession = async (
  sessionId: string,
  logger?: { debug?: (...args: any[]) => void; error?: (...args: any[]) => void }
): Promise<string | null> => {
  // Check cache first
  if (sessionProjectCache.has(sessionId)) {
    const result = sessionProjectCache.get(sessionId);
    logger?.debug?.({ sessionId, cacheHit: true, cachedProject: result || null }, "Resolved project folder from session cache");
    if (!result || result === '') {
      return null;
    }
    return result;
  }

  logger?.debug?.({ sessionId, cacheHit: false, claudeProjectsDir: CLAUDE_PROJECTS_DIR }, "Searching project folder by session id");

  try {
    const dir = await opendir(CLAUDE_PROJECTS_DIR);
    const folderNames: string[] = [];

    // Collect all folder names
    for await (const dirent of dir) {
      if (dirent.isDirectory()) {
        folderNames.push(dirent.name);
      }
    }

    logger?.debug?.({ sessionId, claudeProjectsDir: CLAUDE_PROJECTS_DIR, folderCount: folderNames.length }, "Collected Claude project folders for session lookup");

    // Concurrently check each project folder for sessionId.jsonl file
    const checkPromises = folderNames.map(async (folderName) => {
      const sessionFilePath = join(
        CLAUDE_PROJECTS_DIR,
        folderName,
        `${sessionId}.jsonl`
      );
      try {
        const fileStat = await stat(sessionFilePath);
        return fileStat.isFile() ? folderName : null;
      } catch {
        // File does not exist, continue checking next
        return null;
      }
    });

    const results = await Promise.all(checkPromises);

    // Return the first existing project directory name
    for (const result of results) {
      if (result) {
        // Cache the found result
        sessionProjectCache.set(sessionId, result);
        logger?.debug?.({ sessionId, project: result }, "Found project folder containing session transcript");
        return result;
      }
    }

    // Cache not found result (null value means previously searched but not found)
    sessionProjectCache.set(sessionId, '');
    logger?.debug?.({ sessionId, claudeProjectsDir: CLAUDE_PROJECTS_DIR }, "No project folder contains the requested session transcript");
    return null; // No matching project found
  } catch (error: any) {
    logger?.error?.({ sessionId, claudeProjectsDir: CLAUDE_PROJECTS_DIR, error: error?.message }, "Error searching for project by session");
    console.error("Error searching for project by session:", error);
    // Cache null result on error to avoid repeated errors
    sessionProjectCache.set(sessionId, '');
    return null;
  }
};
