import { query, type Options, type PermissionResult, type SDKMessage, type SDKAssistantMessage, type SDKResultMessage, type SDKSystemMessage, type SDKPartialAssistantMessage, type SDKCompactBoundaryMessage, type SDKUserMessage } from "@anthropic-ai/claude-code";
import { logger } from "../utils/logger.js";
import { env } from "../config.js";
import type {
  MessagingBridge,
  PermissionResponse,
  SessionStatus,
  ConductorConfig,
  VerbosityLevel,
} from "../bridge/types.js";

const VERBOSITY_ORDER: VerbosityLevel[] = ["minimal", "normal", "verbose"];

export interface SessionOptions {
  id: string;
  name: string;
  projectPath: string;
  bridge: MessagingBridge;
  config: ConductorConfig;
  model?: string;
  allowedTools?: string[];
  resumeSessionId?: string;
  skipPermissions?: boolean;
}

/**
 * Wraps a single Claude Agent SDK session.
 * Handles message streaming, permission callbacks, and lifecycle.
 */
export class Session {
  readonly id: string;
  readonly name: string;
  readonly projectPath: string;
  private bridge: MessagingBridge;
  private config: ConductorConfig;
  private model: string;
  private abortController: AbortController | null = null;
  private status: SessionStatus = "idle";
  private sdkSessionId?: string;
  private resumeSessionId?: string;
  private autoApprovedTools = new Set<string>();
  private allowedTools?: string[];
  private skipPermissions: boolean;

  // Streaming state (verbose mode)
  private currentStreamMessageId: string | undefined;
  private lastStreamUpdateTime = 0;
  private streamBuffer = "";
  private streamedCurrentMessage = false;

  // Queued user messages for multi-turn
  private messageQueue: string[] = [];
  private messageResolver: ((value: string) => void) | null = null;

  // Status change callback
  onStatusChange?: (sessionId: string, status: SessionStatus) => void;
  // SDK session ID captured callback
  onSdkSessionId?: (sessionId: string, sdkSessionId: string) => void;

  constructor(options: SessionOptions) {
    this.id = options.id;
    this.name = options.name;
    this.projectPath = options.projectPath;
    this.bridge = options.bridge;
    this.config = options.config;
    this.model = options.model ?? env.DEFAULT_MODEL;
    this.allowedTools = options.allowedTools;
    this.resumeSessionId = options.resumeSessionId;
    this.skipPermissions = options.skipPermissions ?? false;
  }

  getStatus(): SessionStatus {
    return this.status;
  }

  getSdkSessionId(): string | undefined {
    return this.sdkSessionId;
  }

  getAutoApprovedTools(): string[] {
    return Array.from(this.autoApprovedTools);
  }

  private setStatus(status: SessionStatus): void {
    this.status = status;
    this.onStatusChange?.(this.id, status);
  }

  /** Check if the current verbosity level is at least the given level */
  private atLeast(level: VerbosityLevel): boolean {
    return VERBOSITY_ORDER.indexOf(this.config.verbosity) >= VERBOSITY_ORDER.indexOf(level);
  }

  /**
   * Send a message to the session. If the session is waiting for input,
   * this resolves the pending promise. Otherwise it's queued for the next turn.
   */
  sendMessage(text: string): void {
    if (this.messageResolver) {
      const resolve = this.messageResolver;
      this.messageResolver = null;
      resolve(text);
    } else {
      this.messageQueue.push(text);
    }
  }

  /**
   * Wait for the next user message from Discord.
   */
  private waitForMessage(): Promise<string> {
    // Check if there's already a queued message
    if (this.messageQueue.length > 0) {
      return Promise.resolve(this.messageQueue.shift()!);
    }
    // Otherwise wait for one
    return new Promise<string>((resolve) => {
      this.messageResolver = resolve;
    });
  }

  /**
   * Start a conversation with an initial prompt.
   * This runs the Agent SDK query loop, streaming messages back to Discord.
   */
  async start(initialPrompt: string): Promise<void> {
    this.abortController = new AbortController();
    this.setStatus("working");

    await this.bridge.updateSessionStatus(this.id, "working");

    try {
      await this.runConversation(initialPrompt);
    } catch (err: unknown) {
      if (this.abortController?.signal.aborted) {
        logger.info({ sessionId: this.id }, "Session aborted");
        this.setStatus("idle");
        return;
      }
      logger.error({ err, sessionId: this.id }, "Session error");
      this.setStatus("error");
      await this.bridge.sendStatus(this.id, "error", String(err));
      await this.bridge.updateSessionStatus(this.id, "error");
    }
  }

  private async runConversation(prompt: string): Promise<void> {
    let currentPrompt = prompt;
    let isFirstTurn = true;

    // Multi-turn loop: after each result, wait for user's next message
    while (true) {
      this.setStatus("working");
      await this.bridge.updateSessionStatus(this.id, "working");

      const result = await this.runSingleTurn(currentPrompt, isFirstTurn);
      isFirstTurn = false;

      if (this.abortController?.signal.aborted) break;

      // Post completion status
      this.setStatus("idle");
      await this.bridge.updateSessionStatus(this.id, "idle");

      if (this.config.notifyOnCompletion) {
        await this.bridge.sendNotification(
          `Session **${this.name}** completed a task.`,
          this.id
        );
      }

      // Wait for next user message
      this.setStatus("waiting");
      await this.bridge.updateSessionStatus(this.id, "waiting");

      currentPrompt = await this.waitForMessage();

      if (this.abortController?.signal.aborted) break;
    }
  }

  private async runSingleTurn(prompt: string, isFirstTurn: boolean): Promise<void> {
    const opts: Options = {
      abortController: this.abortController ?? undefined,
      cwd: this.projectPath,
      model: this.model,
      permissionMode: this.skipPermissions ? "bypassPermissions" : "default",
      ...(!this.skipPermissions && {
        canUseTool: (toolName: string, toolInput: Record<string, unknown>, _options: any) =>
          this.handlePermission(toolName, toolInput),
      }),
    };

    if (this.allowedTools && this.allowedTools.length > 0) {
      opts.allowedTools = this.allowedTools;
    }

    // Resume previous session if available
    if (this.sdkSessionId) {
      opts.resume = this.sdkSessionId;
    } else if (isFirstTurn && this.resumeSessionId) {
      opts.resume = this.resumeSessionId;
    }

    // Enable partial messages for verbose streaming
    if (this.atLeast("verbose")) {
      opts.includePartialMessages = true;
    }

    const conversation = query({ prompt, options: opts });

    let messageBuffer = "";
    let lastSendTime = 0;

    // Reset streaming state for this turn
    this.currentStreamMessageId = undefined;
    this.lastStreamUpdateTime = 0;
    this.streamBuffer = "";
    this.streamedCurrentMessage = false;

    for await (const message of conversation) {
      if (this.abortController?.signal.aborted) break;

      // --- system messages ---
      if (message.type === "system") {
        const sysMsg = message as SDKSystemMessage;

        // Capture SDK session ID from init message
        if (sysMsg.subtype === "init") {
          this.sdkSessionId = message.session_id;
          if (this.sdkSessionId) {
            this.onSdkSessionId?.(this.id, this.sdkSessionId);
          }
          logger.info({ sessionId: this.id, sdkSessionId: this.sdkSessionId }, "SDK session initialized");

          // normal+: show init summary
          if (this.atLeast("normal")) {
            const lines = [`**Model:** ${this.model}`];
            if (this.skipPermissions) lines.push("**Permissions:** bypassed");
            if (this.allowedTools?.length) {
              if (this.atLeast("verbose")) {
                lines.push(`**Tools:** ${this.allowedTools.join(", ")}`);
              } else {
                lines.push(`**Tools:** ${this.allowedTools.length} allowed`);
              }
            }
            await this.bridge.sendInfo(this.id, "Session Initialized", lines.join("\n"));
          }
          continue;
        }

        // verbose: compact boundary notification
        if (sysMsg.subtype === "compact_boundary" && this.atLeast("verbose")) {
          const compactMsg = message as SDKCompactBoundaryMessage;
          const trigger = compactMsg.compact_metadata?.trigger ?? "unknown";
          const preTokens = compactMsg.compact_metadata?.pre_tokens;
          const detail = preTokens
            ? `Trigger: ${trigger} | Pre-compaction tokens: ${preTokens.toLocaleString()}`
            : `Trigger: ${trigger}`;
          await this.bridge.sendInfo(this.id, "Context Compacted", detail);
        }
        continue;
      }

      // --- stream_event (verbose only) ---
      if (message.type === "stream_event" && this.atLeast("verbose")) {
        const partial = message as SDKPartialAssistantMessage;
        const event = partial.event;

        if (event.type === "content_block_delta" && "delta" in event) {
          const delta = event.delta as any;
          if (delta.type === "text_delta" && delta.text) {
            this.streamBuffer += delta.text;

            // Debounced edit-in-place (~1/sec)
            const now = Date.now();
            if (now - this.lastStreamUpdateTime >= this.config.streamDebounceMs) {
              this.currentStreamMessageId = await this.bridge.sendStreamUpdate(
                this.id,
                this.streamBuffer,
                this.currentStreamMessageId,
              );
              this.lastStreamUpdateTime = now;
            }
          }
        }

        // On message_stop, finalize stream and mark as already sent
        if (event.type === "message_stop") {
          if (this.streamBuffer.trim()) {
            // Final update with complete text
            await this.bridge.sendStreamUpdate(
              this.id,
              this.streamBuffer,
              this.currentStreamMessageId,
            );
            this.streamedCurrentMessage = true;
          }
          // Reset for next message
          this.streamBuffer = "";
          this.currentStreamMessageId = undefined;
          this.lastStreamUpdateTime = 0;
        }
        continue;
      }

      // --- user messages (verbose: show tool results) ---
      if (message.type === "user" && this.atLeast("verbose")) {
        const userMsg = message as SDKUserMessage;
        if (userMsg.isSynthetic && userMsg.message?.content) {
          const content = userMsg.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "tool_result" && "content" in block) {
                const resultText = typeof block.content === "string"
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content
                        .filter((c: any) => c.type === "text")
                        .map((c: any) => c.text)
                        .join("\n")
                    : "";
                if (resultText) {
                  const truncated = resultText.length > 300
                    ? resultText.slice(0, 300) + "..."
                    : resultText;
                  await this.bridge.sendToolUse(this.id, "Result", truncated);
                }
              }
            }
          }
        }
        continue;
      }

      // --- assistant messages ---
      if (message.type === "assistant") {
        const assistantMsg = message as SDKAssistantMessage;
        const content = assistantMsg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && "text" in block) {
              // In verbose mode, skip text if already streamed
              if (this.streamedCurrentMessage) continue;
              messageBuffer += (block as any).text;
            } else if (block.type === "tool_use") {
              // Flush any buffered text first
              if (messageBuffer.trim()) {
                await this.bridge.sendMessage(this.id, messageBuffer);
                messageBuffer = "";
              }

              // Show tool use at normal+ verbosity
              if (this.atLeast("normal")) {
                const toolBlock = block as any;
                const toolDetail = this.formatToolInput(toolBlock.name, toolBlock.input);
                await this.bridge.sendToolUse(this.id, toolBlock.name, toolDetail);
              }
            }
          }

          // Reset streamed flag after processing the full assistant message
          this.streamedCurrentMessage = false;

          // Debounced send of text buffer
          const now = Date.now();
          if (messageBuffer.trim() && now - lastSendTime >= this.config.streamDebounceMs) {
            await this.bridge.sendMessage(this.id, messageBuffer);
            messageBuffer = "";
            lastSendTime = now;
          }
        }
      }

      // --- result messages ---
      if (message.type === "result") {
        // Flush remaining buffer
        if (messageBuffer.trim()) {
          await this.bridge.sendMessage(this.id, messageBuffer);
          messageBuffer = "";
        }

        const resultMsg = message as SDKResultMessage;
        const parts: string[] = [];

        // minimal: cost + duration
        if (resultMsg.total_cost_usd != null) {
          parts.push(`Cost: $${resultMsg.total_cost_usd.toFixed(4)}`);
        }
        if (resultMsg.duration_ms != null) {
          parts.push(`Duration: ${(resultMsg.duration_ms / 1000).toFixed(1)}s`);
        }

        // normal+: token breakdown, num_turns, error subtype, denials
        if (this.atLeast("normal")) {
          if (resultMsg.num_turns != null) {
            parts.push(`Turns: ${resultMsg.num_turns}`);
          }
          if (resultMsg.usage) {
            const u = resultMsg.usage;
            const inTokens = (u as any).input_tokens ?? 0;
            const outTokens = (u as any).output_tokens ?? 0;
            const cacheRead = (u as any).cache_read_input_tokens ?? 0;
            if (inTokens || outTokens) {
              let tokenStr = `Tokens: ${inTokens.toLocaleString()} in / ${outTokens.toLocaleString()} out`;
              if (cacheRead) tokenStr += ` (${cacheRead.toLocaleString()} cached)`;
              parts.push(tokenStr);
            }
          }
          if (resultMsg.subtype && resultMsg.subtype !== "success") {
            parts.push(`Status: ${resultMsg.subtype}`);
          }
          if (resultMsg.permission_denials?.length) {
            const denials = resultMsg.permission_denials.map(
              (d: any) => d.tool_name ?? d.toolName ?? "unknown"
            );
            parts.push(`Denials: ${denials.join(", ")}`);
          }
        }

        // verbose: per-model usage breakdown
        if (this.atLeast("verbose") && resultMsg.modelUsage) {
          const modelLines: string[] = [];
          for (const [model, usage] of Object.entries(resultMsg.modelUsage)) {
            const mu = usage as any;
            modelLines.push(
              `  ${model}: $${mu.costUSD?.toFixed(4) ?? "?"} (${mu.inputTokens?.toLocaleString() ?? 0} in / ${mu.outputTokens?.toLocaleString() ?? 0} out)`
            );
          }
          if (modelLines.length > 0) {
            parts.push(`Model breakdown:\n${modelLines.join("\n")}`);
          }
        }

        const detail = parts.join(" | ") || "Task completed";
        await this.bridge.sendStatus(this.id, "idle", detail);
      }
    }

    // Flush any remaining buffer
    if (messageBuffer.trim()) {
      await this.bridge.sendMessage(this.id, messageBuffer);
    }
  }

  private formatToolInput(toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
      case "Bash":
        return String(input.command ?? "");
      case "Read":
        return String(input.file_path ?? "");
      case "Write":
        return `Write to ${input.file_path ?? "unknown"}`;
      case "Edit":
        return `Edit ${input.file_path ?? "unknown"}`;
      case "Glob":
        return String(input.pattern ?? "");
      case "Grep":
        return `${input.pattern ?? ""} in ${input.path ?? "."}`;
      case "WebSearch":
        return String(input.query ?? "");
      case "WebFetch":
        return String(input.url ?? "");
      case "Task":
        return String(input.description ?? "");
      default:
        return JSON.stringify(input).slice(0, 300);
    }
  }

  private async handlePermission(
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<PermissionResult> {
    // Check auto-approved tools
    if (this.autoApprovedTools.has(toolName)) {
      return { behavior: "allow", updatedInput: toolInput };
    }

    // Check read-only auto-approve
    const readOnlyTools = ["Read", "Glob", "Grep", "WebSearch", "WebFetch"];
    if (this.config.autoApproveReadOnly && readOnlyTools.includes(toolName)) {
      return { behavior: "allow", updatedInput: toolInput };
    }

    // Ask user via Discord
    this.setStatus("waiting");
    await this.bridge.updateSessionStatus(this.id, "waiting");

    const request = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      toolName,
      input: toolInput,
      description: "",
    };

    const response: PermissionResponse = await this.bridge.sendPermissionRequest(this.id, request);

    // Handle "allow all" for this tool
    if (response.allowAllForTool) {
      this.autoApprovedTools.add(toolName);
    }

    this.setStatus("working");
    await this.bridge.updateSessionStatus(this.id, "working");

    if (response.behavior === "allow") {
      return { behavior: "allow", updatedInput: toolInput };
    } else {
      return { behavior: "deny", message: response.message ?? "User denied this action" };
    }
  }

  /**
   * Abort the current session.
   */
  abort(): void {
    this.abortController?.abort();
    this.setStatus("idle");
    // Resolve any pending message wait
    if (this.messageResolver) {
      this.messageResolver("");
      this.messageResolver = null;
    }
  }
}
