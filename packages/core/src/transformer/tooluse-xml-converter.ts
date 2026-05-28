/**
 * Convert XML <function_calls> or <tool_calls> format to structured tool calls
 * Used by tooluse.transformer.ts to handle models that output XML instead of native tool_calls
 */

export interface ParsedToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Parse XML content and extract tool calls
 * Supports formats:
 *   <function_calls><invoke name="tool"><parameter name="param" string="true">value</parameter></invoke></function_calls>
 *   <tool_calls><invoke name="tool"><parameter name="param">value</parameter></invoke></tool_calls>
 *   Generic: <tool_name>{"param": "value"}</tool_name>
 */
export function extractXmlToolCalls(content: string): ParsedToolCall[] {
  const toolCalls: ParsedToolCall[] = [];

  // First, handle <function_calls> or <tool_calls> block with <invoke> tags (existing logic)
  const callsMatch = content.match(/<(?:function_calls|tool_calls)>([\s\S]*?)<\/(?:function_calls|tool_calls)>/);
  if (callsMatch) {
    const callsContent = callsMatch[1];
    const invokeRegex = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/g;
    let invokeMatch;
    let toolIndex = 0;

    while ((invokeMatch = invokeRegex.exec(callsContent)) !== null) {
      const toolName = invokeMatch[1];
      const invokeBody = invokeMatch[2];

      const params: Record<string, any> = {};
      const paramRegex = /<parameter\s+name="([^"]+)"(?:\s+string="true")?>([\s\S]*?)<\/parameter>/g;
      let paramMatch;

      while ((paramMatch = paramRegex.exec(invokeBody)) !== null) {
        const paramName = paramMatch[1];
        let paramValue = paramMatch[2].trim();

        if (paramValue.startsWith('{') || paramValue.startsWith('[')) {
          try {
            paramValue = JSON.parse(paramValue);
          } catch {
            // Keep as string
          }
        }
        params[paramName] = paramValue;
      }

      toolCalls.push({
        id: `call_${Date.now()}_${toolIndex++}`,
        type: "function",
        function: {
          name: toolName,
          arguments: JSON.stringify(params),
        },
      });
    }
    return toolCalls;
  }

  // Generic XML tag parsing (exclude function_calls/tool_calls which are already handled above)
  const genericTagRegex = /<([a-zA-Z][a-zA-Z0-9_]*)>([\s\S]*?)<\/\1>/g;
  let genericMatch;
  let toolIndex = 0;

  while ((genericMatch = genericTagRegex.exec(content)) !== null) {
    const tagName = genericMatch[1];
    // Skip function_calls and tool_calls (already handled)
    if (tagName === 'function_calls' || tagName === 'tool_calls') {
      continue;
    }
    let innerContent = genericMatch[2].trim();
    if (!innerContent) continue;

    let params: Record<string, any> = {};
    // Try to parse inner content as JSON
    if (innerContent.startsWith('{') && innerContent.endsWith('}')) {
      try {
        const parsed = JSON.parse(innerContent);
        if (typeof parsed === 'object' && parsed !== null) {
          params = parsed;
        } else {
          params = { content: parsed };
        }
      } catch {
        params = { content: innerContent };
      }
    } else {
      // Not JSON, treat as plain text content
      params = { content: innerContent };
    }

    toolCalls.push({
      id: `call_${Date.now()}_${toolIndex++}`,
      type: "function",
      function: {
        name: tagName,
        arguments: JSON.stringify(params),
      },
    });
  }

  return toolCalls;
}

/**
 * Remove XML tool call blocks from content, leaving only the text
 */
export function stripXmlToolCalls(content: string): string {
  // Remove <function_calls>...</function_calls> sections
  let result = content.replace(/<function_calls>[\s\S]*?<\/function_calls>/g, '');
  // Remove <tool_calls>...</tool_calls> sections
  result = result.replace(/<tool_calls>[\s\S]*?<\/tool_calls>/g, '');
  // Clean up extra newlines
  result = result.replace(/\n{3,}/g, '\n\n').trim();
  return result;
}

/**
 * Check if content contains XML tool call markup
 */
export function hasXmlToolCalls(content: string): boolean {
  return /<(?:function_calls|tool_calls)>[\s\S]*?<\/(?:function_calls|tool_calls)>/i.test(content);
}
