/**
 * ToolCallSanitizer - Defensive filter for malformed tool call SSE events.
 *
 * When the upstream provider (e.g., DeepSeek) emits tool_calls where the first
 * chunk has an empty `function.name`, the AnthropicTransformer falls back to
 * naming it `tool_<index>`. This non-existent tool name causes the client
 * (Claude Code) to reject it with "Invalid tool parameters".
 *
 * This TransformStream sits between SSEParserTransform and the rest of the
 * pipeline. It tracks `content_block_start` events by index and suppresses
 * any tool_use block whose name is empty or matches the fallback pattern,
 * along with all subsequent deltas and the closing stop event.
 */
export class ToolCallSanitizerTransform extends TransformStream<any, any> {
  private blockStates = new Map<number, { status: 'valid' | 'suppressed' }>();
  private onToolSuppressed?: (index: number, reason: string) => void;
  private onToolCompleted?: (index: number) => void;
  private onAllToolCallsSuppressed?: () => void;
  private validCount = 0;
  private suppressedCount = 0;
  /** Whether the current response contains any tool_use content blocks */
  private hasSeenToolUseInResponse = false;

  constructor(opts?: {
    onToolSuppressed?: (index: number, reason: string) => void;
    onToolCompleted?: (index: number) => void;
    onAllToolCallsSuppressed?: () => void;
  }) {
    super({
      transform: (event: any, controller: TransformStreamDefaultController<any>) => {
        this.processEvent(event, controller);
      },
      flush: () => {
        if (this.suppressedCount > 0 || this.validCount > 0) {
          console.warn(
            `[CCR:sanitizer] summary valid=${this.validCount} suppressed=${this.suppressedCount}`
          );
        }
        this.blockStates.clear();
        this.hasSeenToolUseInResponse = false;
      },
    });
    this.onToolSuppressed = opts?.onToolSuppressed;
    this.onToolCompleted = opts?.onToolCompleted;
    this.onAllToolCallsSuppressed = opts?.onAllToolCallsSuppressed;
  }

  private isFallbackName(name: string): boolean {
    return !name || /^tool_\d+$/.test(name);
  }

  private processEvent(event: any, controller: TransformStreamDefaultController<any>): void {
    const eventType = event?.event;
    const data = event?.data || {};
    const index = data.index;

    // ── content_block_start ──────────────────────────────────────────────
    if (eventType === 'content_block_start') {
      const block = data.content_block || {};
      if (block.type === 'tool_use') {
        this.hasSeenToolUseInResponse = true;
        const name = block.name || '';
        if (this.isFallbackName(name)) {
          this.blockStates.set(index, { status: 'suppressed' });
          this.suppressedCount++;
          const reason = name ? `fallback name "${name}"` : 'empty name';
          this.onToolSuppressed?.(index, reason);
          return; // DROP
        }
        this.blockStates.set(index, { status: 'valid' });
        this.validCount++;
        controller.enqueue(event);
        return;
      }
      // Non-tool blocks (text, thinking, etc.) pass through
      controller.enqueue(event);
      return;
    }

    // ── content_block_delta ──────────────────────────────────────────────
    if (eventType === 'content_block_delta') {
      const state = this.blockStates.get(index);

      // Delta arrived without a preceding content_block_start — treat as malformed
      if (!state && data.delta?.type === 'input_json_delta') {
        this.blockStates.set(index, { status: 'suppressed' });
        this.suppressedCount++;
        this.onToolSuppressed?.(index, 'delta without preceding start');
        return; // DROP
      }

      if (state?.status === 'suppressed') {
        return; // DROP
      }

      controller.enqueue(event);
      return;
    }

    // ── content_block_stop ───────────────────────────────────────────────
    if (eventType === 'content_block_stop') {
      const state = this.blockStates.get(index);

      if (state?.status === 'suppressed') {
        this.blockStates.delete(index);
        return; // DROP
      }

      if (state?.status === 'valid') {
        this.blockStates.delete(index);
        this.onToolCompleted?.(index);
        controller.enqueue(event);
        return;
      }

      // Unknown index — pass through but don't leak state
      controller.enqueue(event);
      return;
    }

    // ── message_delta ───────────────────────────────────────────────────
    if (eventType === 'message_delta') {
      // If the response had tool_use blocks but ALL were suppressed,
      // the CLI will reject "tool_use" stop_reason with no tool_use blocks.
      if (
        this.hasSeenToolUseInResponse &&
        this.validCount === 0 &&
        this.suppressedCount > 0 &&
        data.delta?.stop_reason === 'tool_use'
      ) {
        const modifiedData = {
          ...data,
          delta: {
            ...data.delta,
            stop_reason: 'end_turn',
          },
        };
        this.onAllToolCallsSuppressed?.();
        controller.enqueue({
          ...event,
          data: modifiedData,
        });
        return;
      }
      controller.enqueue(event);
      return;
    }

    // ── All other events (message_start, message_stop, etc.) ──
    controller.enqueue(event);
  }
}
