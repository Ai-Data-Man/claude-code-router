import { UnifiedChatRequest } from "../types/llm";
import { Transformer } from "../types/transformer";
import { extractXmlToolCalls, stripXmlToolCalls, hasXmlToolCalls } from "./tooluse-xml-converter";

export class TooluseTransformer implements Transformer {
  name = "tooluse";

  transformRequestIn(request: UnifiedChatRequest): UnifiedChatRequest {
    request.messages.push({
      role: "system",
      content: `<system-reminder>Tool mode is active. The user expects you to proactively execute the most suitable tool to help complete the task. 
Before invoking a tool, you must carefully evaluate whether it matches the current task. If no available tool is appropriate for the task, you MUST call the \`ExitTool\` to exit tool mode — this is the only valid way to terminate tool mode.
Always prioritize completing the user's task effectively and efficiently by using tools whenever appropriate.</system-reminder>`,
    });
    if (request.tools?.length) {
      // Avoid setting tool_choice="required" when thinking is enabled,
      // as some providers (e.g. Anthropic) reject this combination.
      // Check both request.thinking (set directly) and request.reasoning
      // (set by anthropic transformer when converting incoming thinking).
      const thinkingEnabled =
        request.thinking?.type === "enabled" ||
        request.reasoning?.enabled === true;
      if (!thinkingEnabled) {
        request.tool_choice = "required";
      }
      request.tools.push({
        type: "function",
        function: {
          name: "ExitTool",
          description: `Use this tool when you are in tool mode and have completed the task. This is the only valid way to exit tool mode.
IMPORTANT: Before using this tool, ensure that none of the available tools are applicable to the current task. You must evaluate all available options — only if no suitable tool can help you complete the task should you use ExitTool to terminate tool mode.
Examples:
1. Task: "Use a tool to summarize this document" — Do not use ExitTool if a summarization tool is available.
2. Task: "What’s the weather today?" — If no tool is available to answer, use ExitTool after reasoning that none can fulfill the task.`,
          parameters: {
            type: "object",
            properties: {
              response: {
                type: "string",
                description:
                  "Your response will be forwarded to the user exactly as returned — the tool will not modify or post-process it in any way.",
              },
            },
            required: ["response"],
          },
        },
      });
    }
    return request;
  }

  async transformResponseOut(response: Response): Promise<Response> {
    if (response.headers.get("Content-Type")?.includes("application/json")) {
      const jsonResponse = await response.json();
      if (
        jsonResponse?.choices?.[0]?.message.tool_calls?.length &&
        jsonResponse?.choices?.[0]?.message.tool_calls[0]?.function?.name ===
          "ExitTool"
      ) {
        const toolCall = jsonResponse?.choices[0]?.message.tool_calls[0];
        const toolArguments = JSON.parse(toolCall.function.arguments || "{}");
        jsonResponse.choices[0].message.content = toolArguments.response || "";
        delete jsonResponse.choices[0].message.tool_calls;
      }

      // Handle non-streaming response if needed
      return new Response(JSON.stringify(jsonResponse), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } else if (response.headers.get("Content-Type")?.includes("stream")) {
      if (!response.body) {
        return response;
      }

      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let exitToolIndex = -1;
      let exitToolResponse = "";
      let buffer = ""; // Buffer for incomplete data

      const stream = new ReadableStream({
        async start(controller) {
          const reader = response.body!.getReader();

          const processBuffer = (
            buffer: string,
            controller: ReadableStreamDefaultController,
            encoder: TextEncoder
          ) => {
            const lines = buffer.split("\n");
            for (const line of lines) {
              if (line.trim()) {
                controller.enqueue(encoder.encode(line + "\n"));
              }
            }
          };

          const processLine = (
            line: string,
            context: {
              controller: ReadableStreamDefaultController;
              encoder: TextEncoder;
              exitToolIndex: () => number;
              setExitToolIndex: (val: number) => void;
              exitToolResponse: () => string;
              appendExitToolResponse: (content: string) => void;
            }
          ) => {
            const {
              controller,
              encoder,
              exitToolIndex,
              setExitToolIndex,
              appendExitToolResponse,
            } = context;

            if (
              line.startsWith("data: ") &&
              line.trim() !== "data: [DONE]"
            ) {
              try {
                const data = JSON.parse(line.slice(6));

                // Anthropic-native SSE events have no choices; pass through.
                // Emit the blank line the line-splitting above stripped, so SSE
                // frame boundaries survive.
                if (!data.choices) {
                  controller.enqueue(encoder.encode(line + "\n\n"));
                  return;
                }

                // Check if delta contains XML tool calls in content
                if (data.choices[0]?.delta?.content && hasXmlToolCalls(data.choices[0].delta.content)) {
                  const content = data.choices[0].delta.content;
                  const xmlToolCalls = extractXmlToolCalls(content);
                  if (xmlToolCalls.length > 0) {
                    // Convert XML tool calls to native tool_calls format
                    data.choices[0].delta.tool_calls = xmlToolCalls;
                    // Remove the XML tool call blocks from content, keep any text before/after
                    data.choices[0].delta.content = stripXmlToolCalls(content) || "";
                  }
                }

                // For tool_calls that are ExitTool, handle specially
                if (data.choices[0]?.delta?.tool_calls?.length) {
                  const toolCall = data.choices[0].delta.tool_calls[0];

                  if (toolCall.function?.name === "ExitTool") {
                    setExitToolIndex(toolCall.index);
                    // Don't enqueue the ExitTool call - we'll replace it later
                    return;
                  } else if (
                    exitToolIndex() > -1 &&
                    toolCall.index === exitToolIndex() &&
                    toolCall.function.arguments
                  ) {
                    appendExitToolResponse(toolCall.function.arguments);
                    try {
                      const response = JSON.parse(context.exitToolResponse());
                      // Replace the ExitTool call with a text response
                      data.choices[0].delta = {
                        role: "assistant",
                        content: response.response || "",
                      };
                      delete data.choices[0].delta.tool_calls;
                      const modifiedLine = `data: ${JSON.stringify(
                        data
                      )}\n\n`;
                      controller.enqueue(encoder.encode(modifiedLine));
                    } catch (e) {
                      // Fallback: enqueue original line
                      controller.enqueue(encoder.encode(line + "\n"));
                    }
                    return;
                  }
                }

                // Always enqueue the processed data (original or modified)
                // Check if we have any delta content to send
                const hasDelta = data.choices?.[0]?.delta &&
                  Object.keys(data.choices[0].delta).length > 0;

                // Also send if there are tool_calls (non-ExitTool) that need to be processed
                const hasToolCalls = data.choices?.[0]?.delta?.tool_calls?.length > 0;

                if (hasDelta || hasToolCalls) {
                  const modifiedLine = `data: ${JSON.stringify(data)}\n\n`;
                  controller.enqueue(encoder.encode(modifiedLine));
                }
              } catch (e) {
                // If JSON parsing fails, pass through the original line
                controller.enqueue(encoder.encode(line + "\n"));
              }
            } else {
              // Pass through non-data lines (like [DONE])
              controller.enqueue(encoder.encode(line + "\n"));
            }
          };

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                if (buffer.trim()) {
                  processBuffer(buffer, controller, encoder);
                }
                break;
              }
              const chunk = decoder.decode(value, { stream: true });
              buffer += chunk;
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";
              for (const line of lines) {
                if (!line.trim()) continue;
                try {
                  processLine(line, {
                    controller,
                    encoder,
                    exitToolIndex: () => exitToolIndex,
                    setExitToolIndex: (val) => (exitToolIndex = val),
                    exitToolResponse: () => exitToolResponse,
                    appendExitToolResponse: (content) =>
                      (exitToolResponse += content),
                  });
                } catch (error) {
                  console.error("Error processing line:", line, error);
                  // If parsing fails, pass through the original line
                  controller.enqueue(encoder.encode(line + "\n"));
                }
              }
            }
          } catch (error) {
            console.error("Stream error:", error);
            controller.error(error);
          } finally {
            try {
              reader.releaseLock();
            } catch (e) {
              console.error("Error releasing reader lock:", e);
            }
            controller.close();
          }
        },
      });

      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    return response;
  }
}
