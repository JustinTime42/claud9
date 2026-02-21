import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { config as loadDotenv } from "dotenv";
import type { ConductorConfig } from "./bridge/types.js";

loadDotenv();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  DISCORD_TOKEN: requireEnv("DISCORD_TOKEN"),
  DISCORD_CLIENT_ID: requireEnv("DISCORD_CLIENT_ID"),
  DISCORD_GUILD_ID: requireEnv("DISCORD_GUILD_ID"),
  DISCORD_USER_ID: requireEnv("DISCORD_USER_ID"),
  LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
  PERMISSION_TIMEOUT_MINUTES: parseInt(process.env.PERMISSION_TIMEOUT_MINUTES ?? "30", 10),
  PERMISSION_REMINDER_MINUTES: parseInt(process.env.PERMISSION_REMINDER_MINUTES ?? "10", 10),
  DEFAULT_MODEL: process.env.DEFAULT_MODEL ?? "claude-opus-4-6",
};

const defaultConfig: ConductorConfig = {
  categoryName: "Claude Sessions",
  maxConcurrentSessions: 5,
  messageChunkSize: 1900,
  streamDebounceMs: 1000,
  showToolUseMessages: true,
  autoApproveReadOnly: false,
  notifyOnCompletion: true,
  notifyOnPermission: true,
  archiveEndedSessions: false,
  presets: {},
  projects: {},
};

export function loadConfig(): ConductorConfig {
  const configPath = resolve("config", "conductor.json");
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf-8");
    return { ...defaultConfig, ...JSON.parse(raw) };
  }
  return defaultConfig;
}
