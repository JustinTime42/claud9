# Claude Conductor

A Discord-based remote control interface for Claude Code sessions. Manage Claude Code from your phone, tablet, or any device with Discord — full bidirectional communication, permission approvals via buttons, and multiple concurrent sessions in dedicated channels.

## What It Does

- **Bidirectional messaging**: Send prompts to Claude and see responses in Discord channels
- **Permission handling**: Approve/deny tool use (file edits, bash commands) via Discord buttons
- **Multi-session**: Run multiple Claude Code sessions simultaneously, each in its own Discord channel
- **DM notifications**: Get pinged when Claude finishes a task or needs your attention
- **Session presets**: Pre-configured settings for your common projects
- **Session resume**: Resume previous sessions by SDK session ID

## Prerequisites

- **Node.js 20+** installed
- **Claude Code** installed and authenticated (`claude` command works in your terminal)
- A **Discord account** and a Discord server you admin

---

## Setup Guide

### 1. Create a Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application**, name it "Claude Conductor"
3. Go to the **Bot** tab:
   - Click **Reset Token** and copy the token — this is your `DISCORD_TOKEN`
   - Enable **Message Content Intent** under Privileged Gateway Intents
4. Go to the **OAuth2** tab:
   - Copy the **Client ID** — this is your `DISCORD_CLIENT_ID`
   - Under **OAuth2 URL Generator**, select scopes: `bot`, `applications.commands`
   - Under **Bot Permissions**, select:
     - Manage Channels
     - Send Messages
     - Embed Links
     - Read Message History
     - Use Slash Commands
   - Copy the generated URL and open it in your browser to invite the bot to your server

### 2. Get Your IDs

- **Guild ID** (`DISCORD_GUILD_ID`): Enable Developer Mode in Discord (Settings > Advanced > Developer Mode), then right-click your server name > Copy Server ID
- **User ID** (`DISCORD_USER_ID`): Right-click your own username > Copy User ID

### 3. Configure the Project

```bash
# Clone or navigate to the project
cd claude-conductor

# Install dependencies
npm install

# Create your .env file
cp .env.example .env
```

Edit `.env` with your values:

```bash
DISCORD_TOKEN=your_bot_token_here
DISCORD_CLIENT_ID=your_client_id_here
DISCORD_GUILD_ID=your_server_id_here
DISCORD_USER_ID=your_user_id_here
```

### 4. Register Slash Commands

This only needs to be done once (or when commands change):

```bash
npm run deploy-commands
```

### 5. Start the Bot

```bash
# Development (with hot reload via tsx)
npm run dev

# Production (compile + run)
npm run build
npm start
```

---

## Usage

### Starting a Session

```
/claude new name:my-project path:C:\Users\you\Code\my-project
```

This creates a `#claude-my-project` channel in the "Claude Sessions" category. Claude will greet you and wait for instructions.

You can optionally pass an initial prompt:

```
/claude new name:api-fix path:C:\Code\api prompt:Fix the failing tests in src/auth
```

### Interacting with Claude

Just type in the session channel. Your message is sent directly to Claude as a prompt. Claude's responses (text, tool use, results) appear in the same channel.

### Permission Requests

When Claude wants to run a command or edit a file, you'll see a permission embed with buttons:

- **Allow** — approve this specific action
- **Deny** — reject this action (Claude gets feedback)
- **Allow All [Tool]** — auto-approve all future uses of this tool in this session

You'll also get a DM notification so your phone buzzes.

### Managing Sessions

```
/claude list          # See all active sessions
/claude dashboard     # Visual dashboard with status and timing
/claude end           # End the session in the current channel
/claude presets       # List available session presets
```

### Resuming Sessions

If you have an SDK session ID from a previous run:

```
/claude resume session-id:abc123 name:my-project path:C:\Code\project
```

### Using Presets

Define presets in `config/conductor.json`:

```json
{
  "presets": {
    "my-api": {
      "path": "C:\\Users\\you\\Code\\my-api",
      "allowedTools": ["Read", "Edit", "Bash"],
      "model": "claude-sonnet-4-5-20250929"
    }
  }
}
```

Then start a session using the preset:

```
/claude new name:my-api path:C:\Code\my-api preset:my-api
```

---

## Configuration

### Environment Variables (`.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_TOKEN` | Yes | Discord bot token |
| `DISCORD_CLIENT_ID` | Yes | Discord application client ID |
| `DISCORD_GUILD_ID` | Yes | Discord server ID |
| `DISCORD_USER_ID` | Yes | Your Discord user ID (security whitelist) |
| `LOG_LEVEL` | No | Logging level: `debug`, `info`, `warn`, `error` (default: `info`) |
| `PERMISSION_TIMEOUT_MINUTES` | No | Minutes before permission reminder DM (default: `30`) |
| `PERMISSION_REMINDER_MINUTES` | No | Minutes before first reminder (default: `10`) |
| `DEFAULT_MODEL` | No | Default Claude model (default: `claude-opus-4-6`) |

### Application Config (`config/conductor.json`)

| Setting | Default | Description |
|---------|---------|-------------|
| `categoryName` | `"Claude Sessions"` | Discord category name for session channels |
| `maxConcurrentSessions` | `5` | Maximum simultaneous sessions |
| `messageChunkSize` | `1900` | Max characters per Discord message |
| `streamDebounceMs` | `1000` | Debounce interval for message batching |
| `showToolUseMessages` | `true` | Show tool use embeds in channel |
| `autoApproveReadOnly` | `false` | Auto-approve read-only tools (Read, Glob, Grep) |
| `notifyOnCompletion` | `true` | DM when a task completes |
| `notifyOnPermission` | `true` | DM when permission is needed |
| `archiveEndedSessions` | `false` | Rename channels instead of deleting on session end |
| `presets` | `{}` | Session presets (see above) |

---

## Architecture

```
Discord (phone/browser)
        |
        v
Claude Conductor (Node.js on your machine)
  ├── Discord Adapter (discord.js v14)
  ├── Session Manager (manages multiple sessions)
  └── Session (wraps Claude Agent SDK query())
        |
        v
  Claude Code (via @anthropic-ai/claude-code SDK)
        |
        v
  Your local filesystem (project directories)
```

Each session maps to:
- One Discord text channel
- One Claude Agent SDK `query()` invocation
- One project directory

The `MessagingBridge` interface makes the Discord layer swappable — you could implement Slack, Telegram, or a web UI adapter.

---

## Using on Any Project

1. **Copy the project** to any machine with Node.js 20+ and Claude Code installed
2. Run `npm install`
3. Set up `.env` with your Discord bot credentials (same bot works across machines)
4. Run `npm run deploy-commands` (once per Discord server)
5. Run `npm start`
6. Use `/claude new` from Discord, pointing to any local project directory

The bot runs as a long-lived process on whatever machine has access to the project files. You interact with it remotely via Discord.

---

## Running as a Background Service

### Using pm2

```bash
npm install -g pm2
pm2 start dist/index.js --name claude-conductor
pm2 save
pm2 startup  # Auto-start on boot
```

### Using systemd (Linux)

Create `/etc/systemd/system/claude-conductor.service`:

```ini
[Unit]
Description=Claude Conductor
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/claude-conductor
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
EnvironmentFile=/path/to/claude-conductor/.env

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl enable claude-conductor
sudo systemctl start claude-conductor
```

---

## Security

- **User whitelist**: Only the Discord user ID in `DISCORD_USER_ID` can interact with the bot. All other users are rejected.
- **No secrets in Discord**: API keys and tokens stay in `.env` on the host machine.
- **Permission-by-default**: Every tool use requires explicit approval unless you use "Allow All" or configure `autoApproveReadOnly`.
- **Directory isolation**: Each session is scoped to its project directory via the SDK's `cwd` option.

---

## Troubleshooting

**Bot doesn't come online**: Check `DISCORD_TOKEN` is correct and Message Content Intent is enabled.

**Slash commands don't appear**: Run `npm run deploy-commands`. Commands can take up to an hour to propagate globally (guild-scoped commands are instant).

**"You are not authorized"**: Check that `DISCORD_USER_ID` matches your actual Discord user ID.

**Permission requests not appearing**: Make sure the bot has "Send Messages" and "Embed Links" permissions in the session channel.

**Claude errors**: Check that `claude` works in your terminal. The SDK uses your existing Claude Code authentication.

---

## Project Structure

```
claude-conductor/
├── src/
│   ├── index.ts                  # Entry point, command handling
│   ├── config.ts                 # Environment and JSON config
│   ├── deploy-commands.ts        # Discord slash command registration
│   ├── core/
│   │   ├── session.ts            # Single session (wraps Agent SDK)
│   │   └── session-manager.ts    # Multi-session lifecycle
│   ├── bridge/
│   │   ├── types.ts              # MessagingBridge interface & types
│   │   └── discord-adapter.ts    # Discord implementation
│   └── utils/
│       ├── logger.ts             # pino logger
│       ├── chunker.ts            # Message chunking (2000 char limit)
│       └── store.ts              # Session state persistence (JSON)
├── config/
│   └── conductor.json            # App configuration & presets
├── .env                          # Secrets (not committed)
├── .env.example                  # Template for .env
├── package.json
├── tsconfig.json
└── README.md
```

## License

MIT
