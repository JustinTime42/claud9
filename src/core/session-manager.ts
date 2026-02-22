import { randomUUID } from "crypto";
import { logger } from "../utils/logger.js";
import { SessionStore } from "../utils/store.js";
import { Session, type SessionOptions } from "./session.js";
import type {
  MessagingBridge,
  SessionInfo,
  SessionStatus,
  ConductorConfig,
  SessionPreset,
} from "../bridge/types.js";

export class SessionManager {
  private sessions = new Map<string, Session>();
  private store: SessionStore;
  private bridge: MessagingBridge;
  private config: ConductorConfig;

  constructor(bridge: MessagingBridge, config: ConductorConfig) {
    this.bridge = bridge;
    this.config = config;
    this.store = new SessionStore();

    // Listen for user messages and route to sessions
    this.bridge.onMessage((sessionId, text) => {
      this.handleMessage(sessionId, text);
    });
  }

  /**
   * Create a new session and start it with an initial prompt.
   */
  async createSession(
    name: string,
    projectPath: string,
    initialPrompt: string,
    options?: { model?: string; allowedTools?: string[]; preset?: string; skipPermissions?: boolean }
  ): Promise<string> {
    // Check concurrent session limit
    if (this.sessions.size >= this.config.maxConcurrentSessions) {
      throw new Error(
        `Maximum concurrent sessions (${this.config.maxConcurrentSessions}) reached. End a session first.`
      );
    }

    // Apply preset if specified
    let preset: SessionPreset | undefined;
    if (options?.preset && this.config.presets[options.preset]) {
      preset = this.config.presets[options.preset];
      if (!projectPath && preset.path) {
        projectPath = preset.path;
      }
    }

    const id = name; // Use the name as the session ID for easy channel mapping
    const model = options?.model ?? preset?.model;
    const allowedTools = options?.allowedTools ?? preset?.allowedTools;
    const skipPermissions = options?.skipPermissions ?? preset?.skipPermissions ?? false;

    // Create Discord channel
    const channelId = await this.bridge.createSessionChannel(id, name);

    // Create and store session info
    const info: SessionInfo = {
      id,
      name,
      projectPath,
      channelId,
      status: "working",
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      allowedTools: allowedTools ?? [],
      autoApprovedTools: [],
      model,
    };
    this.store.set(info);

    // Create the session object
    const session = new Session({
      id,
      name,
      projectPath,
      bridge: this.bridge,
      config: this.config,
      model,
      allowedTools,
      skipPermissions,
    });

    session.onStatusChange = (sessionId, status) => {
      this.store.updateStatus(sessionId, status);
    };

    session.onSdkSessionId = (sessionId, sdkSessionId) => {
      const stored = this.store.get(sessionId);
      if (stored) {
        stored.sdkSessionId = sdkSessionId;
        this.store.set(stored);
      }
    };

    this.sessions.set(id, session);

    // Send initial status
    await this.bridge.sendStatus(id, "working", `Starting session in \`${projectPath}\``);

    // Start the session (runs in background)
    session.start(initialPrompt).catch((err) => {
      logger.error({ err, sessionId: id }, "Session crashed");
    });

    logger.info({ sessionId: id, name, projectPath }, "Session created");
    return id;
  }

  /**
   * Resume an existing session by its SDK session ID.
   */
  async resumeSession(
    name: string,
    sdkSessionId: string,
    projectPath: string,
    initialPrompt: string,
  ): Promise<string> {
    const id = name;

    const channelId = await this.bridge.createSessionChannel(id, name);

    const info: SessionInfo = {
      id,
      name,
      projectPath,
      channelId,
      status: "working",
      sdkSessionId,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      allowedTools: [],
      autoApprovedTools: [],
    };
    this.store.set(info);

    const session = new Session({
      id,
      name,
      projectPath,
      bridge: this.bridge,
      config: this.config,
      resumeSessionId: sdkSessionId,
    });

    session.onStatusChange = (sessionId, status) => {
      this.store.updateStatus(sessionId, status);
    };

    session.onSdkSessionId = (sessionId, newSdkSessionId) => {
      const stored = this.store.get(sessionId);
      if (stored) {
        stored.sdkSessionId = newSdkSessionId;
        this.store.set(stored);
      }
    };

    this.sessions.set(id, session);

    await this.bridge.sendStatus(id, "working", `Resuming session ${sdkSessionId}`);

    session.start(initialPrompt).catch((err) => {
      logger.error({ err, sessionId: id }, "Session crashed");
    });

    logger.info({ sessionId: id, sdkSessionId }, "Session resumed");
    return id;
  }

  /**
   * End a session.
   */
  async endSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.abort();
      this.sessions.delete(sessionId);
    }

    await this.bridge.sendStatus(sessionId, "idle", "Session ended");
    await this.bridge.destroySessionChannel(sessionId);
    this.store.delete(sessionId);

    logger.info({ sessionId }, "Session ended");
  }

  /**
   * Get info for all sessions.
   */
  listSessions(): SessionInfo[] {
    const stored = this.store.getAll();
    // Update with live status from active sessions
    return stored.map((info) => {
      const live = this.sessions.get(info.id);
      if (live) {
        info.status = live.getStatus();
        info.autoApprovedTools = live.getAutoApprovedTools();
      }
      return info;
    });
  }

  /**
   * Get a specific session's info.
   */
  getSession(sessionId: string): SessionInfo | undefined {
    return this.store.get(sessionId);
  }

  /**
   * Get session by Discord channel ID.
   */
  getSessionByChannel(channelId: string): SessionInfo | undefined {
    return this.store.getByChannelId(channelId);
  }

  /**
   * Handle an incoming message from Discord.
   */
  private handleMessage(sessionId: string, text: string): void {
    logger.info({ sessionId, textLength: text.length, activeSessions: Array.from(this.sessions.keys()) }, "handleMessage called");
    const session = this.sessions.get(sessionId);
    if (!session) {
      logger.warn({ sessionId }, "Message received for unknown session");
      return;
    }

    logger.info({ sessionId, sessionStatus: session.getStatus() }, "Forwarding message to session");
    session.sendMessage(text);
  }

  /**
   * Find session ID by channel ID (used by command handler).
   */
  findSessionByChannel(channelId: string): string | undefined {
    for (const info of this.store.getAll()) {
      if (info.channelId === channelId) return info.id;
    }
    // Also check by reverse lookup on name/id since channelId may not be stored
    return undefined;
  }

  /**
   * Get available presets.
   */
  getPresets(): Record<string, SessionPreset> {
    return this.config.presets;
  }

  /**
   * Get configured project directories.
   */
  getProjects(): Record<string, string> {
    return this.config.projects;
  }

  /**
   * Resolve a project path from a name or path string.
   * Checks projects map first, then presets, then uses as literal path.
   */
  resolveProjectPath(input: string): string {
    // Check projects map
    if (this.config.projects[input]) {
      return this.config.projects[input];
    }
    // Check presets
    if (this.config.presets[input]) {
      return this.config.presets[input].path;
    }
    // Use as literal path
    return input;
  }
}
