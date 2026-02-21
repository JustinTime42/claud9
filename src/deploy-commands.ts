import { REST, Routes, SlashCommandBuilder, SlashCommandSubcommandBuilder } from "discord.js";
import { config } from "dotenv";

config();

const TOKEN = process.env.DISCORD_TOKEN!;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID!;
const GUILD_ID = process.env.DISCORD_GUILD_ID!;

const commands = [
  new SlashCommandBuilder()
    .setName("claude")
    .setDescription("Manage Claude Code sessions")

    // /claude new <name> [path] [prompt] [yolo] [model] [preset]
    .addSubcommand((sub: SlashCommandSubcommandBuilder) =>
      sub
        .setName("new")
        .setDescription("Start a new Claude Code session")
        .addStringOption((opt) =>
          opt.setName("name").setDescription("Session name (used as channel name)").setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("path")
            .setDescription("Project directory path or project name from config")
            .setRequired(false)
            .setAutocomplete(true)
        )
        .addStringOption((opt) =>
          opt.setName("prompt").setDescription("Initial prompt to send to Claude").setRequired(false)
        )
        .addBooleanOption((opt) =>
          opt.setName("yolo").setDescription("Skip all permission prompts (dangerously-skip-permissions)").setRequired(false)
        )
        .addStringOption((opt) =>
          opt.setName("model").setDescription("Model to use (e.g. claude-opus-4-6)").setRequired(false)
        )
        .addStringOption((opt) =>
          opt.setName("preset").setDescription("Use a preset configuration").setRequired(false)
        )
    )

    // /claude list
    .addSubcommand((sub: SlashCommandSubcommandBuilder) =>
      sub.setName("list").setDescription("List all active sessions")
    )

    // /claude end
    .addSubcommand((sub: SlashCommandSubcommandBuilder) =>
      sub.setName("end").setDescription("End the session in the current channel")
    )

    // /claude resume <session-id> <name> <path>
    .addSubcommand((sub: SlashCommandSubcommandBuilder) =>
      sub
        .setName("resume")
        .setDescription("Resume a previous Claude Code session")
        .addStringOption((opt) =>
          opt.setName("session-id").setDescription("SDK session ID to resume").setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName("name").setDescription("Session name").setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("path")
            .setDescription("Project directory path or project name")
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addStringOption((opt) =>
          opt.setName("prompt").setDescription("Prompt to send on resume").setRequired(false)
        )
    )

    // /claude dashboard
    .addSubcommand((sub: SlashCommandSubcommandBuilder) =>
      sub.setName("dashboard").setDescription("Show a dashboard of all sessions")
    )

    // /claude presets
    .addSubcommand((sub: SlashCommandSubcommandBuilder) =>
      sub.setName("presets").setDescription("List available session presets")
    )

    // /claude projects
    .addSubcommand((sub: SlashCommandSubcommandBuilder) =>
      sub.setName("projects").setDescription("List configured project directories")
    )

    .toJSON(),
];

const rest = new REST({ version: "10" }).setToken(TOKEN);

async function deploy() {
  try {
    console.log("Registering slash commands...");

    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: commands,
    });

    console.log("Slash commands registered successfully!");
  } catch (error) {
    console.error("Failed to register commands:", error);
    process.exit(1);
  }
}

deploy();
