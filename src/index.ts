import { type ChatInputCommandInteraction, type AutocompleteInteraction, EmbedBuilder } from "discord.js";
import { env, loadConfig } from "./config.js";
import { logger } from "./utils/logger.js";
import { DiscordAdapter } from "./bridge/discord-adapter.js";
import { SessionManager } from "./core/session-manager.js";
import type { VerbosityLevel } from "./bridge/types.js";

const STATUS_EMOJI: Record<string, string> = {
  working: "\u{1F7E2}",
  waiting: "\u{1F7E1}",
  idle: "\u26AA",
  error: "\u{1F534}",
};

async function main() {
  logger.info("Starting Claude Conductor...");

  const config = loadConfig();
  const adapter = new DiscordAdapter(config);
  const manager = new SessionManager(adapter, config);

  // Set up command handler
  adapter.setCommandHandler(async (interaction: ChatInputCommandInteraction) => {
    await handleCommand(interaction, manager, adapter, config);
  });

  // Set up autocomplete handler for path suggestions
  adapter.setAutocompleteHandler(async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name === "path") {
      const query = focused.value.toLowerCase();
      const choices: { name: string; value: string }[] = [];

      // Add projects
      for (const [name, path] of Object.entries(config.projects)) {
        choices.push({ name: `${name} → ${path}`, value: path });
      }
      // Add presets (if they have a path)
      for (const [name, preset] of Object.entries(config.presets)) {
        if (preset.path && !choices.some((c) => c.value === preset.path)) {
          choices.push({ name: `${name} → ${preset.path}`, value: preset.path });
        }
      }

      const filtered = query
        ? choices.filter((c) => c.name.toLowerCase().includes(query))
        : choices;

      await interaction.respond(filtered.slice(0, 25));
    }
  });

  // Initialize Discord connection
  await adapter.initialize();

  // Restore existing sessions' channel mappings
  const existingSessions = manager.listSessions();
  for (const session of existingSessions) {
    if (session.channelId) {
      adapter.registerChannel(session.id, session.channelId);
    }
  }

  logger.info("Claude Conductor is running!");
  logger.info(`Authorized user: ${env.DISCORD_USER_ID}`);
  logger.info(`Default model: ${env.DEFAULT_MODEL}`);
  logger.info(`Max concurrent sessions: ${config.maxConcurrentSessions}`);

  // Handle graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    // End all active sessions
    for (const session of manager.listSessions()) {
      try {
        await manager.endSession(session.id);
      } catch {
        // Ignore errors during shutdown
      }
    }
    await adapter.destroy();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function handleCommand(
  interaction: ChatInputCommandInteraction,
  manager: SessionManager,
  adapter: DiscordAdapter,
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();

  try {
    switch (subcommand) {
      case "new":
        await handleNew(interaction, manager);
        break;
      case "list":
        await handleList(interaction, manager);
        break;
      case "end":
        await handleEnd(interaction, manager);
        break;
      case "resume":
        await handleResume(interaction, manager);
        break;
      case "dashboard":
        await handleDashboard(interaction, manager);
        break;
      case "presets":
        await handlePresets(interaction, manager);
        break;
      case "projects":
        await handleProjects(interaction, manager);
        break;
      case "verbosity":
        await handleVerbosity(interaction, config);
        break;
      default:
        await interaction.reply({ content: `Unknown subcommand: ${subcommand}`, ephemeral: true });
    }
  } catch (err: unknown) {
    logger.error({ err, subcommand }, "Command handler error");
    const message = err instanceof Error ? err.message : String(err);
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply(`Error: ${message}`);
    } else {
      await interaction.reply({ content: `Error: ${message}`, ephemeral: true });
    }
  }
}

async function handleNew(
  interaction: ChatInputCommandInteraction,
  manager: SessionManager,
): Promise<void> {
  const name = interaction.options.getString("name", true);
  const rawPath = interaction.options.getString("path") ?? undefined;
  const prompt = interaction.options.getString("prompt") ?? "Hello! I'm ready to work on this project. What would you like me to do?";
  const model = interaction.options.getString("model") ?? undefined;
  const preset = interaction.options.getString("preset") ?? undefined;
  const yolo = interaction.options.getBoolean("yolo") ?? false;

  // Resolve path: from explicit arg, preset, projects map, or the name itself
  let projectPath = rawPath
    ? manager.resolveProjectPath(rawPath)
    : (preset ? manager.resolveProjectPath(preset) : manager.resolveProjectPath(name));

  if (!projectPath) {
    await interaction.reply({
      content: "Could not resolve project path. Provide a `path`, use a `preset`, or configure a project in `config/conductor.json`.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const sessionId = await manager.createSession(name, projectPath, prompt, {
    model,
    preset,
    skipPermissions: yolo,
  });

  const yoloNote = yolo ? " (permissions bypassed)" : "";
  await interaction.editReply(
    `Session **${name}** started${yoloNote}! Check the new channel for Claude's responses.`
  );
}

async function handleList(
  interaction: ChatInputCommandInteraction,
  manager: SessionManager,
): Promise<void> {
  const sessions = manager.listSessions();

  if (sessions.length === 0) {
    await interaction.reply({ content: "No active sessions.", ephemeral: true });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle("Active Claude Sessions")
    .setColor(0x5865f2)
    .setTimestamp();

  for (const session of sessions) {
    const emoji = STATUS_EMOJI[session.status] ?? "\u26AA";
    const model = session.model ? ` | ${session.model}` : "";
    embed.addFields({
      name: `${emoji} ${session.name}`,
      value: `Path: \`${session.projectPath}\`${model}\nStatus: ${session.status}`,
    });
  }

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleEnd(
  interaction: ChatInputCommandInteraction,
  manager: SessionManager,
): Promise<void> {
  // Find the session for the current channel
  const sessions = manager.listSessions();
  const channelId = interaction.channelId;
  const session = sessions.find((s) => s.channelId === channelId);

  // Also try to find by checking reverse channel map
  let sessionId: string | undefined = session?.id;

  // Try to find by channel name matching
  if (!sessionId) {
    const channel = interaction.channel;
    if (channel && "name" in channel) {
      const channelName = (channel as any).name as string;
      const matchingSession = sessions.find(
        (s) => `claude-${s.name}`.toLowerCase() === channelName
      );
      if (matchingSession) {
        sessionId = matchingSession.id;
      }
    }
  }

  if (!sessionId) {
    await interaction.reply({
      content: "No session found for this channel. Use `/claude list` to see active sessions.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  await manager.endSession(sessionId);
  await interaction.editReply(`Session ended.`);
}

async function handleResume(
  interaction: ChatInputCommandInteraction,
  manager: SessionManager,
): Promise<void> {
  const sdkSessionId = interaction.options.getString("session-id", true);
  const name = interaction.options.getString("name", true);
  const path = interaction.options.getString("path", true);
  const prompt = interaction.options.getString("prompt") ?? "Continue where we left off.";

  await interaction.deferReply({ ephemeral: true });

  await manager.resumeSession(name, sdkSessionId, path, prompt);

  await interaction.editReply(
    `Session **${name}** resumed! Check the new channel.`
  );
}

async function handleDashboard(
  interaction: ChatInputCommandInteraction,
  manager: SessionManager,
): Promise<void> {
  const sessions = manager.listSessions();

  if (sessions.length === 0) {
    await interaction.reply({ content: "No sessions to display.", ephemeral: true });
    return;
  }

  const lines = sessions.map((s) => {
    const emoji = STATUS_EMOJI[s.status] ?? "\u26AA";
    const age = getTimeAgo(s.lastActivity);
    return `${emoji} **${s.name}** — ${s.status} (${age})`;
  });

  const embed = new EmbedBuilder()
    .setTitle("Claude Conductor Dashboard")
    .setDescription(lines.join("\n"))
    .setColor(0x5865f2)
    .setFooter({ text: `${sessions.length} session(s)` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handlePresets(
  interaction: ChatInputCommandInteraction,
  manager: SessionManager,
): Promise<void> {
  const presets = manager.getPresets();
  const names = Object.keys(presets);

  if (names.length === 0) {
    await interaction.reply({
      content: "No presets configured. Add presets to `config/conductor.json`.",
      ephemeral: true,
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle("Session Presets")
    .setColor(0x5865f2)
    .setTimestamp();

  for (const [name, preset] of Object.entries(presets)) {
    const tools = preset.allowedTools?.join(", ") ?? "default";
    embed.addFields({
      name,
      value: `Path: \`${preset.path}\`\nModel: ${preset.model ?? "default"}\nTools: ${tools}`,
    });
  }

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleProjects(
  interaction: ChatInputCommandInteraction,
  manager: SessionManager,
): Promise<void> {
  const projects = manager.getProjects();
  const entries = Object.entries(projects);

  if (entries.length === 0) {
    await interaction.reply({
      content: 'No projects configured. Add projects to `config/conductor.json`:\n```json\n"projects": {\n  "my-app": "C:\\\\Users\\\\you\\\\Code\\\\my-app"\n}\n```',
      ephemeral: true,
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle("Configured Projects")
    .setColor(0x5865f2)
    .setDescription(entries.map(([name, path]) => `**${name}** → \`${path}\``).join("\n"))
    .setFooter({ text: "Use these names in the path field for autocomplete" })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleVerbosity(
  interaction: ChatInputCommandInteraction,
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  const level = interaction.options.getString("level", true) as VerbosityLevel;
  const previous = config.verbosity;
  config.verbosity = level;
  logger.info({ previous, new: level }, "Verbosity level changed");
  await interaction.reply({
    content: `Verbosity changed: **${previous}** \u2192 **${level}**`,
    ephemeral: true,
  });
}

function getTimeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

main().catch((err) => {
  logger.error({ err }, "Fatal error");
  process.exit(1);
});
