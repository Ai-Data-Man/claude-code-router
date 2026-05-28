import { appendFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

let _logPath: string | null = null;
function resolveLogPath(): string {
  if (!_logPath) {
    _logPath = process.env.LOG_FILE
      || join(homedir(), ".claude-code-router", "claude-code-router.log");
  }
  return _logPath;
}

function writeLogLine(msg: string): void {
  const ts = new Date().toISOString();
  const line = `${ts} ${msg}\n`;
  appendFile(resolveLogPath(), line, "utf-8").catch(() => {
    // best-effort
  });
}

export interface EmptyResponseRetryConfig {
  enabled?: boolean;
  maxAttempts?: number;
  backoffMs?: number;
}

export class EmptyResponseRetryError extends Error {
  constructor(message = "Empty assistant response") {
    super(message);
    this.name = "EmptyResponseRetryError";
  }
}

const DEFAULT_RETRY_CONFIG: Required<EmptyResponseRetryConfig> = {
  enabled: true,
  maxAttempts: 3,
  backoffMs: 1000,
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const hasNonEmptyString = (value: unknown): boolean =>
  typeof value === "string" && value.length > 0;

const hasNonEmptyArray = (value: unknown): boolean =>
  Array.isArray(value) && value.length > 0;

const hasMeaningfulPayloadContent = (data: any): boolean => {
  if (!data || typeof data !== "object") {
    return false;
  }

  if (
    hasNonEmptyString(data.content) ||
    hasNonEmptyString(data.reasoning_content) ||
    hasNonEmptyArray(data.tool_calls)
  ) {
    return true;
  }

  if (Array.isArray(data.content) && data.content.length > 0) {
    return true;
  }

  if (Array.isArray(data.choices)) {
    return data.choices.some((choice: any) =>
      hasMeaningfulPayloadContent(choice?.delta) ||
      hasMeaningfulPayloadContent(choice?.message)
    );
  }

  return false;
};

const hasMeaningfulSseEvent = (event: any): boolean => {
  if (!event || typeof event !== "object") {
    return false;
  }

  return (
    ["content_block_start", "content_block_delta", "error"].includes(
      event.event
    ) || hasMeaningfulPayloadContent(event.data)
  );
};

const hasMeaningfulJsonContent = (data: any): boolean =>
  hasMeaningfulPayloadContent(data);

const validateSseResponse = async (
  response: Response,
  label?: string
): Promise<void> => {
  if (!response.body) {
    throw new Error("Stream response body is null");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventCount = 0;
  let meaningfulEventCount = 0;
  let eventTypes: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\n\n+/);
      buffer = frames.pop() || "";

      for (const frame of frames) {
        eventCount++;
        const event: any = {};
        const lines = frame.split(/\r?\n/).filter(Boolean);

        for (const line of lines) {
          if (line.startsWith("event:")) {
            event.event = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            const data = line.slice(5).trim();
            if (data === "[DONE]") {
              event.data = { type: "done" };
            } else {
              try {
                event.data = JSON.parse(data);
              } catch {
                event.data = { raw: data };
              }
            }
          }
        }

        if (event.event) {
          eventTypes.push(event.event);
        }

        if (hasMeaningfulSseEvent(event)) {
          meaningfulEventCount++;
          writeLogLine(
            `[CCR:retry] ${label || "validateSse"} meaningful event=${event.event} events=${eventCount} meaningful=${meaningfulEventCount} types=[${eventTypes.join(",")}]`
          );
          return;
        }
      }
    }

    writeLogLine(
      `[CCR:retry] ${label || "validateSse"} empty stream events=${eventCount} meaningful=${meaningfulEventCount} types=[${eventTypes.join(",")}]`
    );
    throw new EmptyResponseRetryError();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
};

const validateJsonResponse = async (
  response: Response,
  label?: string
): Promise<void> => {
  const data = await response.json();
  if (!hasMeaningfulJsonContent(data)) {
    const contentLength = Array.isArray(data?.content) ? data.content.length : 0;
    writeLogLine(
      `[CCR:retry] ${label || "validateJson"} empty json response contentLength=${contentLength} keys=[${Object.keys(data || {}).join(",")}]`
    );
    throw new EmptyResponseRetryError();
  }
  writeLogLine(
    `[CCR:retry] ${label || "validateJson"} json meaningful keys=[${Object.keys(data || {}).join(",")}]`
  );
};

const validateResponse = async (
  response: Response,
  label?: string
): Promise<Response> => {
  const contentType = response.headers.get("Content-Type") || "";
  const status = response.status;
  writeLogLine(
    `[CCR:retry] ${label || "validateResponse"} status=${status} contentType=${contentType || "<none>"}`
  );

  if (contentType.includes("text/event-stream")) {
    await validateSseResponse(response.clone(), label);
    return response;
  }

  await validateJsonResponse(response.clone(), label);
  return response;
};

export const retryEmptyResponse = async (options: {
  attempt: () => Promise<Response>;
  retryConfig?: EmptyResponseRetryConfig;
  logger?: {
    warn?: (...args: any[]) => void;
    debug?: (...args: any[]) => void;
  };
  reqId?: string;
  source?: string;
}): Promise<Response> => {
  const retryConfig = {
    ...DEFAULT_RETRY_CONFIG,
    ...(options.retryConfig || {}),
  };

  const maxAttempts = Math.max(1, retryConfig.maxAttempts || 1);
  const enabled = retryConfig.enabled !== false;
  const backoffMs = Math.max(0, retryConfig.backoffMs || 0);
  const source = options.source || "unknown";

  writeLogLine(
    `[CCR:retry] source=${source} enabled=${enabled} maxAttempts=${maxAttempts} backoffMs=${backoffMs} reqId=${options.reqId || "?"}`
  );

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    writeLogLine(
      `[CCR:retry] source=${source} attempt=${attempt}/${maxAttempts} start reqId=${options.reqId || "?"}`
    );
    try {
      const response = await options.attempt();
      const label = `source=${source} reqId=${options.reqId || "?"} attempt=${attempt}/${maxAttempts}`;
      return await validateResponse(response, label);
    } catch (error: any) {
      lastError = error;
      const shouldRetry =
        enabled && error instanceof EmptyResponseRetryError && attempt < maxAttempts;

      if (!shouldRetry) {
        if (error instanceof EmptyResponseRetryError) {
          writeLogLine(
            `[CCR:retry] source=${source} exhausted attempt=${attempt}/${maxAttempts} reqId=${options.reqId || "?"}`
          );
        } else {
          writeLogLine(
            `[CCR:retry] source=${source} non-retryable error reqId=${options.reqId || "?"}: ${error.message}`
          );
        }
        throw error;
      }

      const waitMs = backoffMs * Math.pow(2, attempt - 1);
      writeLogLine(
        `[CCR:retry] source=${source} empty response attempt=${attempt}/${maxAttempts} retrying in ${waitMs}ms reqId=${options.reqId || "?"}`
      );
      options.logger?.warn?.(
        {
          reqId: options.reqId,
          source,
          attempt,
          maxAttempts,
          waitMs,
        },
        "Empty assistant response detected, retrying"
      );

      if (waitMs > 0) {
        await delay(waitMs);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new EmptyResponseRetryError();
};
