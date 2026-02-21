import { query, type Options, type PermissionResult, type SDKMessage, type SDKAssistantMessage, type SDKResultMessage, type SDKSystemMessage } from "@anthropic-ai/claude-code";
import { logger } from "../utils/logger.js";
import { env } from "../config.js";
import type {
  MessagingBridge,
  PermissionResponse,
  SessionStatus,
  ConductorConfig,
} from "../bridge/types.js";

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

    const conversation = query({ prompt, options: opts });

    let messageBuffer = "";
    let lastSendTime = 0;

    for await (const message of conversation) {
      if (this.abortController?.signal.aborted) break;

      // Capture SDK session ID from init message
      if (message.type === "system" && "subtype" in message && (message as SDKSystemMessage).subtype === "init") {
        this.sdkSessionId = message.session_id;
        if (this.sdkSessionId) {
          this.onSdkSessionId?.(this.id, this.sdkSessionId);
        }
        logger.info({ sessionId: this.id, sdkSessionId: this.sdkSessionId }, "SDK session initialized");
        continue;
      }

      // Handle assistant messages
      if (message.type === "assistant") {
        const assistantMsg = message as SDKAssistantMessage;
        const content = assistantMsg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && "text" in block) {
              messageBuffer += (block as any).text;
            } else if (block.type === "tool_use") {
              // Flush any buffered text first
              if (messageBuffer.trim()) {
                await this.bridge.sendMessage(this.id, messageBuffer);
                messageBuffer = "";
              }

              // Show tool use if configured
              if (this.config.showToolUseMessages) {
                const toolBlock = block as any;
                const toolDetail = this.formatToolInput(toolBlock.name, toolBlock.input);
                await this.bridge.sendToolUse(this.id, toolBlock.name, toolDetail);
              }
            }
          }

          // Debounced send of text buffer
          const now = Date.now();
          if (messageBuffer.trim() && now - lastSendTime >= this.config.streamDebounceMs) {
            await this.bridge.sendMessage(this.id, messageBuffer);
            messageBuffer = "";
            lastSendTime = now;
          }
        }
      }

      // Handle result messages
      if (message.type === "result") {
        // Flush remaining buffer
        if (messageBuffer.trim()) {
          await this.bridge.sendMessage(this.id, messageBuffer);
          messageBuffer = "";
        }

        const resultMsg = message as SDKResultMessage;
        const costInfo = resultMsg.total_cost_usd != null
          ? `Cost: $${resultMsg.total_cost_usd.toFixed(4)}`
          : "";
        const durationInfo = resultMsg.duration_ms != null
          ? `Duration: ${(resultMsg.duration_ms / 1000).toFixed(1)}s`
          : "";
        const detail = [costInfo, durationInfo].filter(Boolean).join(" | ");

        await this.bridge.sendStatus(this.id, "idle", detail || "Task completed");
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
