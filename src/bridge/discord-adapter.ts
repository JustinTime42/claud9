import {
  Client,
  GatewayIntentBits,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  type TextChannel,
  type CategoryChannel,
  type Guild,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
  type Interaction,
} from "discord.js";
import { env } from "../config.js";
import { logger } from "../utils/logger.js";
import { chunkMessage } from "../utils/chunker.js";
import type {
  MessagingBridge,
  PermissionRequest,
  PermissionResponse,
  PromptOption,
  SessionStatus,
  ConductorConfig,
} from "./types.js";

const STATUS_EMOJI: Record<SessionStatus, string> = {
  working: "\u{1F7E2}",   // green circle
  waiting: "\u{1F7E1}",   // yellow circle
  idle: "\u26AA",          // white circle
  error: "\u{1F534}",     // red circle
};

const STATUS_LABEL: Record<SessionStatus, string> = {
  working: "Working",
  waiting: "Waiting for input",
  idle: "Idle",
  error: "Error",
};

export class DiscordAdapter implements MessagingBridge {
  private client: Client;
  private guild!: Guild;
  private category!: CategoryChannel;
  private config: ConductorConfig;

  // sessionId -> channelId
  private channelMap = new Map<string, string>();
  // channelId -> sessionId (reverse mapping)
  private reverseChannelMap = new Map<string, string>();

  // Pending permission requests: requestId -> resolve function
  private pendingPermissions = new Map<string, (response: PermissionResponse) => void>();
  // Pending prompt responses: requestId -> resolve function
  private pendingPrompts = new Map<string, (value: string) => void>();

  // Message handlers from SessionManager
  private messageHandlers: Array<(sessionId: string, text: string) => void> = [];

  // Command handler (set by index.ts)
  private commandHandler?: (interaction: ChatInputCommandInteraction) => Promise<void>;
  // Autocomplete handler (set by index.ts)
  private autocompleteHandler?: (interaction: AutocompleteInteraction) => Promise<void>;

  constructor(config: ConductorConfig) {
    this.config = config;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });
  }

  setCommandHandler(handler: (interaction: ChatInputCommandInteraction) => Promise<void>): void {
    this.commandHandler = handler;
  }

  setAutocompleteHandler(handler: (interaction: AutocompleteInteraction) => Promise<void>): void {
    this.autocompleteHandler = handler;
  }

  async initialize(): Promise<void> {
    await this.client.login(env.DISCORD_TOKEN);

    await new Promise<void>((resolve) => {
      this.client.once(Events.ClientReady, () => {
        logger.info(`Discord bot logged in as ${this.client.user?.tag}`);
        resolve();
      });
    });

    // Get the guild
    this.guild = await this.client.guilds.fetch(env.DISCORD_GUILD_ID);
    if (!this.guild) {
      throw new Error(`Guild ${env.DISCORD_GUILD_ID} not found`);
    }

    // Find or create the category
    await this.ensureCategory();

    // Set up event handlers
    this.client.on(Events.InteractionCreate, (interaction) => this.handleInteraction(interaction));
    this.client.on(Events.MessageCreate, (message) => {
      // Ignore bot messages
      if (message.author.bot) return;
      // Security: only allow the configured user
      if (message.author.id !== env.DISCORD_USER_ID) {
        logger.debug({ authorId: message.author.id }, "Ignoring message from unauthorized user");
        return;
      }
      // Only handle messages in session channels
      if (!message.guild) return;

      logger.info({ channelId: message.channelId, content: message.content.slice(0, 100) }, "Message received in guild channel");
      logger.info({ reverseMap: Object.fromEntries(this.reverseChannelMap) }, "Current channel-to-session map");

      const sessionId = this.reverseChannelMap.get(message.channelId);
      if (sessionId) {
        logger.info({ sessionId, channelId: message.channelId }, "Routing message to session");
        for (const handler of this.messageHandlers) {
          handler(sessionId, message.content);
        }
      } else {
        logger.warn({ channelId: message.channelId }, "No session mapped to this channel");
      }
    });

    logger.info("Discord adapter initialized");
  }

  async destroy(): Promise<void> {
    this.client.destroy();
    logger.info("Discord adapter destroyed");
  }

  private async ensureCategory(): Promise<void> {
    const channels = await this.guild.channels.fetch();
    const existing = channels.find(
      (ch) => ch?.type === ChannelType.GuildCategory && ch.name === this.config.categoryName
    );

    if (existing) {
      this.category = existing as CategoryChannel;
      logger.info(`Found existing category: ${this.config.categoryName}`);
    } else {
      this.category = (await this.guild.channels.create({
        name: this.config.categoryName,
        type: ChannelType.GuildCategory,
      })) as CategoryChannel;
      logger.info(`Created category: ${this.config.categoryName}`);
    }
  }

  /** Register a pre-existing channel mapping (from restored sessions) */
  registerChannel(sessionId: string, channelId: string): void {
    this.channelMap.set(sessionId, channelId);
    this.reverseChannelMap.set(channelId, sessionId);
  }

  async createSessionChannel(sessionId: string, name: string): Promise<string> {
    const channelName = `claude-${name}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");

    // Check if channel already exists
    const existing = this.category.children.cache.find((ch) => ch.name === channelName);
    if (existing) {
      this.channelMap.set(sessionId, existing.id);
      this.reverseChannelMap.set(existing.id, sessionId);
      logger.info(`Reusing existing channel: #${channelName}`);
      return existing.id;
    }

    const channel = await this.guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: this.category.id,
      topic: `${STATUS_EMOJI.idle} Idle | Claude Code session`,
    });

    this.channelMap.set(sessionId, channel.id);
    this.reverseChannelMap.set(channel.id, sessionId);
    logger.info(`Created session channel: #${channelName}`);
    return channel.id;
  }

  async destroySessionChannel(sessionId: string): Promise<void> {
    const channelId = this.channelMap.get(sessionId);
    if (!channelId) return;

    try {
      const channel = await this.guild.channels.fetch(channelId);
      if (channel) {
        if (this.config.archiveEndedSessions) {
          // Just rename to indicate it's archived
          await (channel as TextChannel).setName(`archived-${channel.name}`);
          await (channel as TextChannel).setTopic("Archived session");
        } else {
          await channel.delete();
        }
      }
    } catch (err) {
      logger.warn({ err, sessionId }, "Failed to destroy session channel");
    }

    this.reverseChannelMap.delete(channelId);
    this.channelMap.delete(sessionId);
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    const channel = await this.getChannel(sessionId);
    if (!channel) return;

    const chunks = chunkMessage(text, this.config.messageChunkSize);
    for (const chunk of chunks) {
      await channel.send(chunk);
    }
  }

  async sendStatus(sessionId: string, status: SessionStatus, detail?: string): Promise<void> {
    const channel = await this.getChannel(sessionId);
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setColor(status === "error" ? 0xff0000 : status === "waiting" ? 0xffaa00 : status === "working" ? 0x00ff00 : 0x888888)
      .setTitle(`${STATUS_EMOJI[status]} ${STATUS_LABEL[status]}`)
      .setTimestamp();

    if (detail) {
      embed.setDescription(detail);
    }

    await channel.send({ embeds: [embed] });
  }

  async sendInfo(sessionId: string, title: string, detail: string): Promise<void> {
    const channel = await this.getChannel(sessionId);
    if (!channel) return;

    const truncated = detail.length > 1800 ? detail.slice(0, 1800) + "..." : detail;

    const embed = new EmbedBuilder()
      .setColor(0x95a5a6)
      .setTitle(`\u2139\uFE0F ${title}`)
      .setDescription(truncated)
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  }

  async sendStreamUpdate(sessionId: string, text: string, messageId?: string): Promise<string> {
    const channel = await this.getChannel(sessionId);
    if (!channel) return messageId ?? "";

    // Show the tail of the buffer so user sees current output
    const maxLen = this.config.messageChunkSize;
    const display = text.length > maxLen ? "..." + text.slice(-maxLen) : text;

    if (messageId) {
      try {
        const msg = await channel.messages.fetch(messageId);
        await msg.edit(display);
        return messageId;
      } catch {
        // Message may have been deleted; send a new one
      }
    }

    const msg = await channel.send(display);
    return msg.id;
  }

  async sendToolUse(sessionId: string, toolName: string, detail: string): Promise<void> {
    const channel = await this.getChannel(sessionId);
    if (!channel) return;

    // Truncate detail for display
    const truncated = detail.length > 500 ? detail.slice(0, 500) + "..." : detail;

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`\u{1F527} Tool: ${toolName}`)
      .setDescription("```\n" + truncated + "\n```")
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  }

  async sendPrompt(sessionId: string, question: string, options: PromptOption[]): Promise<string> {
    const channel = await this.getChannel(sessionId);
    if (!channel) throw new Error(`No channel for session ${sessionId}`);

    const requestId = `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const embed = new EmbedBuilder()
      .setColor(0xffaa00)
      .setTitle("\u2753 Claude is asking:")
      .setDescription(question)
      .setTimestamp();

    const buttons = options.slice(0, 5).map((opt, i) =>
      new ButtonBuilder()
        .setCustomId(`${requestId}:${opt.value}`)
        .setLabel(opt.label)
        .setStyle(ButtonStyle.Primary)
    );

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
    await channel.send({ embeds: [embed], components: [row] });

    return new Promise<string>((resolve) => {
      this.pendingPrompts.set(requestId, resolve);
    });
  }

  async sendPermissionRequest(sessionId: string, request: PermissionRequest): Promise<PermissionResponse> {
    const channel = await this.getChannel(sessionId);
    if (!channel) throw new Error(`No channel for session ${sessionId}`);

    const requestId = `perm-${request.id}`;

    // Format the input for display
    let inputDisplay = "";
    if (request.toolName === "Bash" && request.input.command) {
      inputDisplay = String(request.input.command);
    } else if (request.toolName === "Edit" && request.input.file_path) {
      inputDisplay = `File: ${request.input.file_path}`;
    } else if (request.toolName === "Write" && request.input.file_path) {
      inputDisplay = `File: ${request.input.file_path}`;
    } else {
      inputDisplay = JSON.stringify(request.input, null, 2);
    }

    if (inputDisplay.length > 800) {
      inputDisplay = inputDisplay.slice(0, 800) + "\n...";
    }

    const embed = new EmbedBuilder()
      .setColor(0xff6600)
      .setTitle("\u{1F510} Permission Request")
      .addFields(
        { name: "Tool", value: request.toolName, inline: true },
        { name: "Details", value: "```\n" + inputDisplay + "\n```" }
      )
      .setTimestamp();

    if (request.description) {
      embed.setDescription(request.description);
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${requestId}:allow`)
        .setLabel("Allow")
        .setStyle(ButtonStyle.Success)
        .setEmoji("\u2705"),
      new ButtonBuilder()
        .setCustomId(`${requestId}:deny`)
        .setLabel("Deny")
        .setStyle(ButtonStyle.Danger)
        .setEmoji("\u274C"),
      new ButtonBuilder()
        .setCustomId(`${requestId}:allowAll`)
        .setLabel(`Allow All ${request.toolName}`)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("\u{1F513}"),
    );

    await channel.send({ embeds: [embed], components: [row] });

    // Send DM notification if configured
    if (this.config.notifyOnPermission) {
      await this.sendNotification(
        `Permission request in **${sessionId}**: ${request.toolName}\n\`${inputDisplay.slice(0, 200)}\``,
        sessionId
      );
    }

    return new Promise<PermissionResponse>((resolve) => {
      this.pendingPermissions.set(requestId, resolve);

      // Set up timeout reminder
      const reminderTimeout = setTimeout(() => {
        this.sendNotification(
          `Reminder: Permission request still waiting in **${sessionId}**`,
          sessionId
        );
      }, env.PERMISSION_REMINDER_MINUTES * 60 * 1000);

      // Store the timeout so we can clear it
      const originalResolve = resolve;
      this.pendingPermissions.set(requestId, (response) => {
        clearTimeout(reminderTimeout);
        originalResolve(response);
      });
    });
  }

  async sendNotification(text: string, sessionName?: string): Promise<void> {
    try {
      const user = await this.client.users.fetch(env.DISCORD_USER_ID);
      const channelId = sessionName ? this.channelMap.get(sessionName) : undefined;
      let fullText = text;
      if (channelId) {
        fullText += `\n\nGo to channel: <#${channelId}>`;
      }
      await user.send(fullText);
    } catch (err) {
      logger.warn({ err }, "Failed to send DM notification");
    }
  }

  async updateSessionStatus(sessionId: string, status: SessionStatus): Promise<void> {
    const channel = await this.getChannel(sessionId);
    if (!channel) return;

    try {
      await channel.setTopic(`${STATUS_EMOJI[status]} ${STATUS_LABEL[status]} | Claude Code session`);
    } catch (err) {
      logger.warn({ err, sessionId }, "Failed to update channel topic");
    }
  }

  onMessage(handler: (sessionId: string, text: string) => void): void {
    this.messageHandlers.push(handler);
  }

  private async getChannel(sessionId: string): Promise<TextChannel | null> {
    const channelId = this.channelMap.get(sessionId);
    if (!channelId) {
      logger.warn(`No channel mapped for session ${sessionId}`);
      return null;
    }

    try {
      const channel = await this.guild.channels.fetch(channelId);
      return channel as TextChannel;
    } catch {
      logger.warn(`Could not fetch channel ${channelId} for session ${sessionId}`);
      return null;
    }
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    // Security: only allow the configured user
    if (interaction.user.id !== env.DISCORD_USER_ID) {
      if (interaction.isRepliable()) {
        await interaction.reply({ content: "You are not authorized to use this bot.", ephemeral: true });
      }
      return;
    }

    if (interaction.isChatInputCommand()) {
      if (this.commandHandler) {
        await this.commandHandler(interaction);
      }
    } else if (interaction.isAutocomplete()) {
      if (this.autocompleteHandler) {
        await this.autocompleteHandler(interaction);
      }
    } else if (interaction.isButton()) {
      await this.handleButton(interaction);
    }
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    const customId = interaction.customId;

    // Permission button: perm-<id>:<action>
    if (customId.startsWith("perm-")) {
      const lastColon = customId.lastIndexOf(":");
      const requestId = customId.slice(0, lastColon);
      const action = customId.slice(lastColon + 1);

      const resolve = this.pendingPermissions.get(requestId);
      if (resolve) {
        this.pendingPermissions.delete(requestId);

        let response: PermissionResponse;
        if (action === "allow") {
          response = { behavior: "allow" };
        } else if (action === "allowAll") {
          response = { behavior: "allow", allowAllForTool: true };
        } else {
          response = { behavior: "deny", message: "User denied this action" };
        }

        // Update the message to show the decision
        const emoji = response.behavior === "allow" ? "\u2705" : "\u274C";
        const label = response.behavior === "allow"
          ? (response.allowAllForTool ? "Allowed (all future)" : "Allowed")
          : "Denied";

        await interaction.update({
          components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId("resolved")
                .setLabel(`${emoji} ${label}`)
                .setStyle(response.behavior === "allow" ? ButtonStyle.Success : ButtonStyle.Danger)
                .setDisabled(true)
            ),
          ],
        });

        resolve(response);
      } else {
        await interaction.reply({ content: "This permission request has already been resolved.", ephemeral: true });
      }
      return;
    }

    // Prompt button: prompt-<id>:<value>
    if (customId.startsWith("prompt-")) {
      const lastColon = customId.lastIndexOf(":");
      const requestId = customId.slice(0, lastColon);
      const value = customId.slice(lastColon + 1);

      const resolve = this.pendingPrompts.get(requestId);
      if (resolve) {
        this.pendingPrompts.delete(requestId);

        await interaction.update({
          components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId("resolved")
                .setLabel(`Selected: ${value}`)
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true)
            ),
          ],
        });

        resolve(value);
      } else {
        await interaction.reply({ content: "This prompt has already been answered.", ephemeral: true });
      }
    }
  }
}
