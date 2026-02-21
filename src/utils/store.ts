import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import type { SessionInfo } from "../bridge/types.js";
import { logger } from "./logger.js";

const STORE_PATH = resolve("data", "sessions.json");

export class SessionStore {
  private sessions: Map<string, SessionInfo> = new Map();

  constructor() {
    this.load();
  }

  private load(): void {
    if (existsSync(STORE_PATH)) {
      try {
        const raw = readFileSync(STORE_PATH, "utf-8");
        const data: SessionInfo[] = JSON.parse(raw);
        for (const session of data) {
          this.sessions.set(session.id, session);
        }
        logger.info(`Loaded ${this.sessions.size} sessions from store`);
      } catch (err) {
        logger.error({ err }, "Failed to load session store");
      }
    }
  }

  private save(): void {
    const dir = dirname(STORE_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const data = Array.from(this.sessions.values());
    writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), "utf-8");
  }

  get(id: string): SessionInfo | undefined {
    return this.sessions.get(id);
  }

  getByChannelId(channelId: string): SessionInfo | undefined {
    for (const session of this.sessions.values()) {
      if (session.channelId === channelId) return session;
    }
    return undefined;
  }

  getAll(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  getActive(): SessionInfo[] {
    return this.getAll().filter((s) => s.status !== "idle" || s.sdkSessionId);
  }

  set(session: SessionInfo): void {
    this.sessions.set(session.id, session);
    this.save();
  }

  updateStatus(id: string, status: SessionInfo["status"]): void {
    const session = this.sessions.get(id);
    if (session) {
      session.status = status;
      session.lastActivity = new Date().toISOString();
      this.save();
    }
  }

  delete(id: string): void {
    this.sessions.delete(id);
    this.save();
  }
}
