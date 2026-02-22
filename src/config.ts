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

// If an OAuth token is set (Max/Pro subscription), remove ANTHROPIC_API_KEY
// from the process environment so the SDK subprocess uses subscription billing.
if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  delete process.env.ANTHROPIC_API_KEY;
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
  verbosity: "normal",
  autoApproveReadOnly: false,
  notifyOnCompletion: true,
  notifyOnPermission: true,
  archiveEndedSessions: false,
  presets: {},
  projects: {},
};

export function loadConfig(): ConductorConfig {
  const configPath = resolve("config", "conductor.json");
  let raw: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  }

  const config: ConductorConfig = { ...defaultConfig, ...raw } as ConductorConfig;

  // Backward compat: if config has showToolUseMessages but no verbosity, infer it
  if (!("verbosity" in raw) && "showToolUseMessages" in raw) {
    config.verbosity = raw.showToolUseMessages ? "normal" : "minimal";
  }

  return config;
}
