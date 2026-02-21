/**
 * Platform-agnostic messaging bridge interface.
 * Implement this to add support for Discord, Slack, Telegram, etc.
 */

export type VerbosityLevel = "minimal" | "normal" | "verbose";

export interface PermissionRequest {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  description: string;
}

export interface PermissionResponse {
  behavior: "allow" | "deny";
  message?: string;
  /** Auto-approve all future uses of this tool in this session */
  allowAllForTool?: boolean;
}

export interface PromptOption {
  label: string;
  description?: string;
  value: string;
}

export interface MessagingBridge {
  /** Initialize the bridge (connect to platform) */
  initialize(): Promise<void>;

  /** Shut down the bridge */
  destroy(): Promise<void>;

  /** Send a text message to a session channel */
  sendMessage(sessionId: string, text: string): Promise<void>;

  /** Send a status/embed message to a session channel */
  sendStatus(sessionId: string, status: SessionStatus, detail?: string): Promise<void>;

  /** Send a tool use notification */
  sendToolUse(sessionId: string, toolName: string, detail: string): Promise<void>;

  /** Send a message with action buttons, return the user's choice */
  sendPrompt(sessionId: string, question: string, options: PromptOption[]): Promise<string>;

  /** Send a permission request with buttons, return allow/deny */
  sendPermissionRequest(sessionId: string, request: PermissionRequest): Promise<PermissionResponse>;

  /** Send an informational embed (grey, for init summaries, compaction notices, etc.) */
  sendInfo(sessionId: string, title: string, detail: string): Promise<void>;

  /** Send or edit-in-place a streaming message. Returns the message ID for subsequent edits. */
  sendStreamUpdate(sessionId: string, text: string, messageId?: string): Promise<string>;

  /** Send a DM notification to the bot owner */
  sendNotification(text: string, sessionName?: string): Promise<void>;

  /** Register a handler for incoming user messages */
  onMessage(handler: (sessionId: string, text: string) => void): void;

  /** Create a session channel, returns the session ID mapping */
  createSessionChannel(sessionId: string, name: string): Promise<void>;

  /** Remove/archive a session channel */
  destroySessionChannel(sessionId: string): Promise<void>;

  /** Update the channel topic/status indicator */
  updateSessionStatus(sessionId: string, status: SessionStatus): Promise<void>;
}

export type SessionStatus = "working" | "waiting" | "idle" | "error";

export interface SessionInfo {
  id: string;
  name: string;
  projectPath: string;
  channelId: string;
  status: SessionStatus;
  sdkSessionId?: string;
  createdAt: string;
  lastActivity: string;
  allowedTools: string[];
  autoApprovedTools: string[];
  model?: string;
}

export interface SessionPreset {
  path: string;
  allowedTools?: string[];
  permissionMode?: string;
  skipPermissions?: boolean;
  model?: string;
}

export interface ConductorConfig {
  categoryName: string;
  maxConcurrentSessions: number;
  messageChunkSize: number;
  streamDebounceMs: number;
  /** @deprecated Use `verbosity` instead. Kept for backward compatibility. */
  showToolUseMessages?: boolean;
  verbosity: VerbosityLevel;
  autoApproveReadOnly: boolean;
  notifyOnCompletion: boolean;
  notifyOnPermission: boolean;
  archiveEndedSessions: boolean;
  presets: Record<string, SessionPreset>;
  /** Map of short names to project directory paths for quick selection */
  projects: Record<string, string>;
}
