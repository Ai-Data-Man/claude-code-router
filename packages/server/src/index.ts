import { existsSync } from "fs";
import { writeFile, readdir, stat, unlink } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { initConfig, initDir } from "./utils";
import { createServer } from "./server";
import { apiKeyAuth } from "./middleware/auth";
import { CONFIG_FILE, HOME_DIR, listPresets } from "@CCR/shared";
import { createStream } from 'rotating-file-stream';
import { sessionUsageCache } from "@musistudio/llms";
import { SSEParserTransform } from "./utils/SSEParser.transform";
import { SSESerializerTransform } from "./utils/SSESerializer.transform";
import { rewriteStream } from "./utils/rewriteStream";
import { ToolCallSanitizerTransform } from "./utils/ToolCallSanitizer.transform";
import JSON5 from "json5";
import { IAgent, ITool } from "./agents/type";
import agentsManager from "./agents";
import { EventEmitter } from "node:events";
import { pluginManager, tokenSpeedPlugin } from "@musistudio/llms";

const event = new EventEmitter()

// P2: Session circuit breaker state
// Tracks consecutive malformed tool calls per session; when >= MAX_TOOL_ERRORS,
// tools are stripped from subsequent requests to break the error loop.
const sessionToolErrorCount = new Map<string, number>();
const MAX_TOOL_ERRORS = 3;

async function initializeClaudeConfig() {
  const homeDir = homedir();
  const configPath = join(homeDir, ".claude.json");
  if (!existsSync(configPath)) {
    const userID = Array.from(
      { length: 64 },
      () => Math.random().toString(16)[2]
    ).join("");
    const configContent = {
      numStartups: 184,
      autoUpdaterStatus: "enabled",
      userID,
      hasCompletedOnboarding: true,
      lastOnboardingVersion: "1.0.17",
      projects: {},
    };
    await writeFile(configPath, JSON.stringify(configContent, null, 2));
  }
}

interface RunOptions {
  port?: number;
  logger?: any;
}

function parseSizeToBytes(value: string): number {
  const match = /^\s*(\d+)\s*([BKMG])\s*$/i.exec(value || "");
  if (!match) return 200 * 1024 * 1024;
  const num = Number(match[1]);
  const unit = match[2].toUpperCase();
  if (unit === "B") return num;
  if (unit === "K") return num * 1024;
  if (unit === "M") return num * 1024 * 1024;
  return num * 1024 * 1024 * 1024;
}

async function trimRotatedLogsByTotalSize(maxSize: string): Promise<void> {
  const limitBytes = parseSizeToBytes(maxSize);
  const logDir = join(HOME_DIR, "logs");

  let entries: Array<{ path: string; size: number; mtimeMs: number }> = [];
  try {
    const files = await readdir(logDir);
    for (const name of files) {
      if (!/^ccr-.*\.log$/i.test(name)) continue;
      const fullPath = join(logDir, name);
      try {
        const s = await stat(fullPath);
        if (!s.isFile()) continue;
        entries.push({ path: fullPath, size: s.size, mtimeMs: s.mtimeMs });
      } catch {}
    }
  } catch {
    return;
  }

  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let total = entries.reduce((sum, item) => sum + item.size, 0);
  if (total <= limitBytes) return;

  for (let i = entries.length - 1; i >= 0 && total > limitBytes; i--) {
    const target = entries[i];
    try {
      await unlink(target.path);
      total -= target.size;
    } catch {}
  }
}

/**
 * Plugin configuration from config file
 */
interface PluginConfig {
  name: string;
  enabled?: boolean;
  options?: Record<string, any>;
}

/**
 * Register plugins from configuration
 * @param serverInstance Server instance
 * @param config Application configuration
 */
async function registerPluginsFromConfig(serverInstance: any, config: any): Promise<void> {
  // Get plugins configuration from config file
  const pluginsConfig: PluginConfig[] = config.plugins || config.Plugins || [];

  for (const pluginConfig of pluginsConfig) {
      const { name, enabled = false, options = {} } = pluginConfig;

      switch (name) {
        case 'token-speed':
          pluginManager.registerPlugin(tokenSpeedPlugin, {
            enabled,
            outputHandlers: [
              {
                type: 'temp-file',
                enabled: true
              }
            ],
            ...options
          });
          break;

        default:
          console.warn(`Unknown plugin: ${name}`);
          break;
      }
    }
  // Enable all registered plugins
  await pluginManager.enablePlugins(serverInstance);
}

async function getServer(options: RunOptions = {}) {
  await initializeClaudeConfig();
  await initDir();
  const config = await initConfig();

  // Check if Providers is configured
  const providers = config.Providers || config.providers || [];
  const hasProviders = providers && providers.length > 0;

  let HOST = config.HOST || "127.0.0.1";

  if (hasProviders) {
    HOST = config.HOST;
    if (!config.APIKEY) {
      HOST = "127.0.0.1";
    }
  } else {
    // When no providers are configured, listen on 0.0.0.0 without authentication
    HOST = "0.0.0.0";
    console.log("ℹ️  No providers configured. Listening on 0.0.0.0 without authentication.");
  }

  const port = config.PORT || 3456;

  // Use port from environment variable if set (for background process)
  const servicePort = process.env.SERVICE_PORT
    ? parseInt(process.env.SERVICE_PORT)
    : port;

  // Configure logger based on config settings or external options
  const pad = (num: number) => (num > 9 ? "" : "0") + num;
  const generator = (time: number | Date | undefined, index: number | undefined) => {
    let date: Date;
    if (!time) {
      date = new Date();
    } else if (typeof time === 'number') {
      date = new Date(time);
    } else {
      date = time;
    }

    const month = date.getFullYear() + "" + pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hour = pad(date.getHours());
    const minute = pad(date.getMinutes());

    return `./logs/ccr-${month}${day}${hour}${minute}${pad(date.getSeconds())}${index ? `_${index}` : ''}.log`;
  };

  // Parse log max size config, default to "200M"
  const logMaxSize = config.LOG_MAX_SIZE || "200M";

  // Trim existing rotated logs on startup to prevent historical bloat
  await trimRotatedLogsByTotalSize(logMaxSize);

  // Use a stable history file name so maxSize cleanup works across restarts
  const logHistoryFile = "ccr-rotate-history.txt";

  let loggerConfig: any;

  // Use external logger configuration if provided
  if (options.logger !== undefined) {
    loggerConfig = options.logger;
  } else {
    // Enable logger if not provided and config.LOG !== false
    if (config.LOG !== false) {
      // Set config.LOG to true (if not already set)
      if (config.LOG === undefined) {
        config.LOG = true;
      }
      loggerConfig = {
        level: config.LOG_LEVEL || "debug",
        stream: createStream(generator, {
          path: HOME_DIR,
          history: logHistoryFile,
          interval: "1d",
          compress: false,
          size: "50M",
          maxSize: logMaxSize,
        }),
      };
    } else {
      loggerConfig = false;
    }
  }

  const presets = await listPresets();

  const serverInstance = await createServer({
    jsonPath: CONFIG_FILE,
    initialConfig: {
      // ...config,
      providers: config.Providers || config.providers,
      HOST: HOST,
      PORT: servicePort,
      LOG_FILE: join(
        homedir(),
        ".claude-code-router",
        "claude-code-router.log"
      ),
    },
    logger: loggerConfig,
  });

  await Promise.allSettled(
      presets.map(async preset => await serverInstance.registerNamespace(`/preset/${preset.name}`, preset.config))
  )

  // Register and configure plugins from config
  await registerPluginsFromConfig(serverInstance, config);

  // Add async preHandler hook for authentication
  serverInstance.addHook("preHandler", async (req: any, reply: any) => {
    return new Promise<void>((resolve, reject) => {
      const done = (err?: Error) => {
        if (err) reject(err);
        else resolve();
      };
      // Call the async auth function
      apiKeyAuth(config)(req, reply, done).catch(reject);
    });
  });
  serverInstance.addHook("preHandler", async (req: any, reply: any) => {
    const url = new URL(`http://127.0.0.1${req.url}`);
    req.pathname = url.pathname;
    if (req.pathname.endsWith("/v1/messages") && req.pathname !== "/v1/messages") {
      req.preset = req.pathname.replace("/v1/messages", "").replace("/", "");
    }
  })

  serverInstance.addHook("preHandler", async (req: any, reply: any) => {
    if (req.pathname.endsWith("/v1/messages")) {
      const useAgents = []

      for (const agent of agentsManager.getAllAgents()) {
        if (agent.shouldHandle(req, config)) {
          // Set agent identifier
          useAgents.push(agent.name)

          // change request body
          agent.reqHandler(req, config);

          // append agent tools (override native tools with same name)
          if (agent.tools.size) {
            if (!req.body?.tools?.length) {
              req.body.tools = []
            }
            const agentToolNames = new Set(agent.tools.keys());
            // Remove native tools that conflict with agent tools (agent version takes priority)
            req.body.tools = req.body.tools.filter((t: any) => !agentToolNames.has(t.name));
            const newTools = Array.from(agent.tools.values()).map(item => ({
              name: item.name,
              description: item.description,
              input_schema: item.input_schema
            }));
            req.body.tools.unshift(...newTools);
          }
        }
      }

      if (useAgents.length) {
        req.agents = useAgents;
      }
    }
  });
  // P2: Circuit breaker — strip tools if session exceeded error threshold
  serverInstance.addHook("preHandler", async (req: any, reply: any) => {
    if (
      req.sessionId &&
      req.pathname?.endsWith("/v1/messages") &&
      Array.isArray(req.body?.tools) &&
      req.body.tools.length > 0
    ) {
      const errorCount = sessionToolErrorCount.get(req.sessionId) || 0;
      if (errorCount >= MAX_TOOL_ERRORS) {
        console.warn(
          `[CCR:circuit-breaker] Stripping tools for session=${req.sessionId} errorCount=${errorCount}`
        );
        req.body.tools = [];
      } else if (errorCount > 0) {
        console.warn(
          `[CCR:circuit-breaker] session=${req.sessionId} errorCount=${errorCount}/${MAX_TOOL_ERRORS} tools=${req.body.tools.length}`
        );
      }
    }
  });
  serverInstance.addHook("onError", async (request: any, reply: any, error: any) => {
    event.emit('onError', request, reply, error);
  })
  serverInstance.addHook("onSend", (req: any, reply: any, payload: any, done: any) => {
    if (req.sessionId && req.pathname.endsWith("/v1/messages")) {
      if (payload instanceof ReadableStream) {
        // SSEParserTransform expects string input, need TextDecoderStream to convert from bytes
        const decoder = new TextDecoderStream();

        // Always parse + sanitize SSE events (P1)
        console.log(
          `[CCR:sanitizer] active sessionId=${req.sessionId} model=${req.body?.model || "?"} agents=${!!req.agents}`
        );
        const eventStream = payload
          .pipeThrough(decoder)
          .pipeThrough(new SSEParserTransform());
        const sanitizedStream = eventStream.pipeThrough(new ToolCallSanitizerTransform({
          onToolSuppressed: (index, reason) => {
            const count = (sessionToolErrorCount.get(req.sessionId) || 0) + 1;
            sessionToolErrorCount.set(req.sessionId, count);
            console.warn(
              `[CCR:sanitizer] suppressed tool call index=${index} reason="${reason}" sessionId=${req.sessionId} errorCount=${count}/${MAX_TOOL_ERRORS}`
            );
          },
          onToolCompleted: () => {
            const prev = sessionToolErrorCount.get(req.sessionId);
            if (prev !== undefined) {
              sessionToolErrorCount.delete(req.sessionId);
              console.warn(
                `[CCR:circuit-breaker] session=${req.sessionId} toolErrorCount reset (was ${prev})`
              );
            }
          },
          onAllToolCallsSuppressed: () => {
            console.warn(
              `[CCR:sanitizer] all tool calls suppressed, stop_reason corrected to end_turn sessionId=${req.sessionId}`
            );
          },
        }));

        if (req.agents) {
          const abortController = new AbortController();
          let currentAgent: undefined | IAgent;
          let currentToolIndex = -1
          let currentToolName = ''
          let currentToolArgs = ''
          let currentToolId = ''
          const toolMessages: any[] = []
          const assistantMessages: any[] = []
          // Store Anthropic format message body, distinguishing text and tool types
          return done(null, rewriteStream(sanitizedStream, async (data, controller) => {
            try {
              // Detect tool call start
              if (data.event === 'content_block_start' && data?.data?.content_block?.name) {
                const agent = req.agents.find((name: string) => agentsManager.getAgent(name)?.tools.get(data.data.content_block.name))
                if (agent) {
                  currentAgent = agentsManager.getAgent(agent)
                  currentToolIndex = data.data.index
                  currentToolName = data.data.content_block.name
                  currentToolId = data.data.content_block.id
                  return undefined;
                }
              }

              // Collect tool arguments
              if (currentToolIndex > -1 && data.data.index === currentToolIndex && data.data?.delta?.type === 'input_json_delta') {
                currentToolArgs += data.data?.delta?.partial_json;
                return undefined;
              }

              // Tool call completed, handle agent invocation
              if (currentToolIndex > -1 && data.data.index === currentToolIndex && data.data.type === 'content_block_stop') {
                try {
                  const args = JSON5.parse(currentToolArgs);
                  assistantMessages.push({
                    type: "tool_use",
                    id: currentToolId,
                    name: currentToolName,
                    input: args
                  })
                  const toolResult = await currentAgent?.tools.get(currentToolName)?.handler(args, {
                    req,
                    config
                  });
                  toolMessages.push({
                    "tool_use_id": currentToolId,
                    "type": "tool_result",
                    "content": toolResult
                  })
                  currentAgent = undefined
                  currentToolIndex = -1
                  currentToolName = ''
                  currentToolArgs = ''
                  currentToolId = ''
                } catch (e) {
                  console.log(e);
                }
                return undefined;
              }

              if (data.event === 'message_delta' && toolMessages.length) {
                req.body.messages.push({
                  role: 'assistant',
                  content: assistantMessages
                })
                req.body.messages.push({
                  role: 'user',
                  content: toolMessages
                })
                console.log(
                  `[CCR:retry] nested agent request start reqId=${req.id} sessionId=${req.sessionId} toolCount=${toolMessages.length} assistantCount=${assistantMessages.length} model=${req.body?.model || "?"}`
                )
                const response = await fetch(`http://127.0.0.1:${config.PORT || 3456}/v1/messages`, {
                  method: "POST",
                  headers: {
                    'x-api-key': config.APIKEY,
                    'content-type': 'application/json',
                  },
                  body: JSON.stringify(req.body),
                })
                console.log(
                  `[CCR:retry] nested agent response reqId=${req.id} ok=${response.ok} status=${response.status} contentType=${response.headers.get('content-type') || '<none>'}`
                )
                if (!response.ok) {
                  console.warn(
                    `[CCR:retry] nested agent request failed reqId=${req.id} status=${response.status}`
                  )
                  return undefined;
                }
                const stream = response.body!
                  .pipeThrough(new TextDecoderStream())
                  .pipeThrough(new SSEParserTransform() as any)
                const reader = stream.getReader()
                let forwardedEvents = 0
                let skippedSystemEvents = 0
                let sawBackpressure = false
                while (true) {
                  try {
                    const {value, done} = await reader.read();
                    if (done) {
                      break;
                    }
                    const eventData = value as any;
                    if (['message_start', 'message_stop'].includes(eventData.event)) {
                      skippedSystemEvents++
                      continue
                    }

                    // Check if stream is still writable
                    if (!controller.desiredSize) {
                      sawBackpressure = true
                      console.warn(
                        `[CCR:retry] nested agent stream backpressure reqId=${req.id} desiredSize=${controller.desiredSize} forwarded=${forwardedEvents} skipped=${skippedSystemEvents}`
                      );
                    }

                    forwardedEvents++
                    controller.enqueue(eventData)
                  }catch (readError: any) {
                    if (readError.name === 'AbortError' || readError.code === 'ERR_STREAM_PREMATURE_CLOSE') {
                      abortController.abort(); // Abort all related operations
                      console.warn(
                        `[CCR:retry] nested agent stream aborted reqId=${req.id} forwarded=${forwardedEvents} skipped=${skippedSystemEvents} backpressure=${sawBackpressure}`
                      );
                      break;
                    }
                    throw readError;
                  }

                }
                console.log(
                  `[CCR:retry] nested agent stream done reqId=${req.id} forwarded=${forwardedEvents} skipped=${skippedSystemEvents} backpressure=${sawBackpressure}`
                )
                return undefined
              }
              return data
            }catch (error: any) {
              console.error('Unexpected error in stream processing:', error);

              // Handle premature stream closure error
              if (error.code === 'ERR_STREAM_PREMATURE_CLOSE') {
                abortController.abort();
                return undefined;
              }

              // Re-throw other errors
              throw error;
            }
          }).pipeThrough(new SSESerializerTransform()))
        }

        // Non-agent path: split sanitized stream into main + background usage tracking
        console.log(
          `[CCR:onSend] non-agent path sessionId=${req.sessionId} using parsed event tracking`
        );
        const [mainStream, usageStream] = sanitizedStream.tee();
        const read = async (stream: ReadableStream) => {
          const reader = stream.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              // Process parsed events for usage tracking
              if (value.event === 'message_delta' && value.data?.usage) {
                sessionUsageCache.put(req.sessionId, value.data.usage);
              }
            }
          } catch (readError: any) {
            if (readError.name === 'AbortError' || readError.code === 'ERR_STREAM_PREMATURE_CLOSE') {
              console.error('Background usage stream closed prematurely');
            } else {
              console.error('Error in background usage reading:', readError);
            }
          } finally {
            reader.releaseLock();
          }
        }
        read(usageStream);
        return done(null, mainStream.pipeThrough(new SSESerializerTransform()))
      }
      sessionUsageCache.put(req.sessionId, payload.usage);
      if (typeof payload ==='object') {
        if (payload.error) {
          return done(payload.error, null)
        } else {
          return done(payload, null)
        }
      }
    }
    if (typeof payload ==='object' && payload.error) {
      return done(payload.error, null)
    }
    done(null, payload)
  });
  serverInstance.addHook("onSend", async (req: any, reply: any, payload: any) => {
    event.emit('onSend', req, reply, payload);
    return payload;
  });

  // Add global error handlers to prevent the service from crashing
  process.on("uncaughtException", (err) => {
    serverInstance.app.log.error("Uncaught exception:", err);
  });

  process.on("unhandledRejection", (reason, promise) => {
    serverInstance.app.log.error("Unhandled rejection at:", promise, "reason:", reason);
  });

  return serverInstance;
}

async function run() {
  const server = await getServer();
  server.app.post("/api/restart", async () => {
    setTimeout(async () => {
      process.exit(0);
    }, 100);

    return { success: true, message: "Service restart initiated" }
  });
  await server.start();
}

export { getServer };
export type { RunOptions };
export type { IAgent, ITool } from "./agents/type";
export { initDir, initConfig, readConfigFile, writeConfigFile, backupConfigFile } from "./utils";
export { pluginManager, tokenSpeedPlugin } from "@musistudio/llms";

// Start service if this file is run directly
if (require.main === module) {
  run().catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
}
