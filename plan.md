# Claude Conductor — Product Requirement Prompt

**A Discord-based remote control interface for Claude Code sessions**

## Overview

Claude Conductor is a TypeScript application that bridges Discord and Claude Code via the Claude Agent SDK, enabling full bidirectional communication with one or more Claude Code sessions from anywhere — phone, tablet, or another computer. It replaces the terminal as the primary interaction surface when you're away from your workstation.

### The Problem

When running Claude Code on long tasks, you currently must stay at the terminal to:

- See when Claude finishes
- Approve permission requests (file edits, bash commands)
- Respond to numbered selection prompts
- Provide follow-up instructions
- Manage multiple concurrent sessions

Existing tools (afk-code, disclaude, ccremote) attempt to solve this via terminal scraping or file watching. These approaches are fragile, platform-dependent (Unix sockets break on Windows, file watchers fail under WSL), and can't leverage Claude Code's native hooks or SDK callbacks.

### The Solution

Claude Conductor runs Claude Code sessions through the Claude Agent SDK, which provides first-class streaming output, permission callbacks, and session management. Discord serves as the UI layer — each session gets its own channel, messages flow bidirectionally, and permission prompts appear as interactive buttons.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Your Phone / Browser               │
│                      Discord App                     │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│              Claude Conductor (Node.js)               │
│                                                       │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │  Discord     │  │   Session    │  │  Messaging   │ │
│  │  Adapter     │◄─┤   Manager    ├─►│  Bridge      │ │
│  │  (discord.js)│  │              │  │  (interface)  │ │
│  └─────────────┘  └──────┬───────┘  └─────────────┘ │
│                          │                            │
│               ┌──────────┼──────────┐                 │
│               ▼          ▼          ▼                 │
│          ┌─────────┐ ┌────────┐ ┌─────────┐         │
│          │Session 1│ │Session2│ │Session 3│         │
│          │Agent SDK│ │Agent SDK│ │Agent SDK│         │
│          └─────────┘ └────────┘ └─────────┘         │
│                                                       │
└─────────────────────────────────────────────────────┘
                       │
                       ▼
              Your local filesystem
              (project directories)
```

### Key Design Decisions

**Agent SDK over CLI wrapping.** The Claude Agent SDK (TypeScript) provides `query()` which returns an async generator of typed messages. It has a `canUseTool` callback that pauses execution until you return a decision. This is the correct integration point — no terminal scraping, no PTY, no file watching.

**Discord as UI, not the brain.** The Discord adapter is a thin layer. The core logic (session management, message routing, permission handling) lives in a platform-agnostic bridge. This means swapping Discord for Slack, Telegram, or a custom app later requires only writing a new adapter — roughly 200 lines of code.

**One channel per session.** Each Claude Code session maps to a Discord channel within a "Claude Sessions" category. This provides natural isolation, scrollback history, and the ability to manage multiple concurrent sessions by switching channels.

**Persistent process.** Claude Conductor runs as a long-lived Node.js process on your workstation (or a server/VM). It stays running while you're away. Sessions survive your Discord app closing and reopening.

---

## Tech Stack

| Component          | Choice                           | Rationale                                         |
| ------------------ | -------------------------------- | ------------------------------------------------- |
| Runtime            | Node.js 20+                      | Already installed, matches your stack             |
| Language           | TypeScript                       | Type safety for SDK message types                 |
| Claude integration | `@anthropic-ai/claude-agent-sdk` | Official SDK, same capabilities as Claude Code    |
| Discord            | `discord.js` v14                 | Most mature Discord library, excellent TS support |
| Process manager    | pm2 or systemd                   | Keep conductor running when terminal closes       |
| Config             | `.env` + JSON                    | Environment for secrets, JSON for session configs |
| Logging            | pino                             | Structured JSON logs, low overhead                |

---

## Features

### Phase 1 — Core (MVP)

The minimum to replace terminal interaction from your phone.

#### 1.1 Session Management

- `/claude new <name> <path>` — Start a new Claude Code session pointing at a project directory. Creates a Discord channel `#claude-<name>` in the "Claude Sessions" category.
- `/claude list` — Show all active sessions with status (working, waiting for input, idle, errored).
- `/claude end` — End the session in the current channel. Optionally archive the channel.
- `/claude resume <session-id>` — Resume a previous session using the Agent SDK's session persistence.

Implementation notes:

- Use the Agent SDK V2 preview's `createSession()` and `resumeSession()` for session lifecycle.
- Store session metadata (id, name, project path, channel id, status) in a local SQLite database or JSON file.
- On startup, reconnect to any existing sessions and re-bind them to their Discord channels.

#### 1.2 Bidirectional Messaging

**You → Claude:** Type a message in a session channel. Conductor sends it to the corresponding Agent SDK session via `session.send()`.

**Claude → You:** Stream Claude's responses back to the Discord channel. The Agent SDK yields typed messages:

- `AssistantMessage` — Claude's text output. Extract text blocks and post to Discord.
- `ResultMessage` — Task completion. Post a summary with ✅ indicator.
- Tool use messages — Optionally show "🔧 Running: `npm test`" status messages.

Message chunking: Discord has a 2000-character limit per message. Buffer Claude's streaming output and send in chunks, using code blocks for code output. Debounce to avoid rate limits (roughly 1 message per second per channel).

#### 1.3 Permission Handling

This is the killer feature. When Claude wants to use a tool that requires approval, the Agent SDK calls `canUseTool(toolName, input, context)`. Conductor:

1. Posts an embed to the session channel describing what Claude wants to do:

   ```
   🔐 Permission Request
   Tool: Bash
   Command: rm -rf node_modules && npm install
   Description: Reinstalling dependencies

   [✅ Allow]  [❌ Deny]  [✅ Allow All Bash]
   ```

2. Waits for you to click a button.
3. Returns `{ behavior: "allow" }` or `{ behavior: "deny", message: "User denied" }` to the SDK.

Button options:

- **Allow** — Approve this specific request.
- **Deny** — Block this request, Claude gets feedback.
- **Allow All [tool]** — Auto-approve all future uses of this tool in this session (maps to SDK's `allowedTools`).
- **Allow for 10 min** — Timed auto-approval for when you're actively monitoring.

Timeout: If no response within a configurable window (default: 30 min), post a reminder ping. After a longer timeout (configurable, default: 2 hours), either auto-deny or keep waiting based on user preference.

#### 1.4 Selection Prompts

When Claude uses `AskUserQuestion` (the numbered selection prompts), the SDK surfaces this through the message stream. Conductor renders these as Discord buttons:

```
Claude is asking:
How should I handle the existing migration files?

[1️⃣ Keep and add new]  [2️⃣ Replace all]  [3️⃣ Let me specify]
```

For text input prompts, Conductor posts the question and waits for your next message in the channel.

#### 1.5 Status & Notifications

- **DM notifications:** When a session needs your attention (permission request, question, completion), send a DM with a link to the session channel. This ensures your phone buzzes.
- **Status indicators:** Use the Discord channel topic or a pinned message to show current session state: `🟢 Working | 🟡 Waiting for input | 🔴 Error | ⚪ Idle`
- **Activity summary:** When Claude finishes a task, post a brief summary: files modified, commands run, tests passed/failed.

### Phase 2 — Multi-Session & Power Features

#### 2.1 Concurrent Sessions

Run multiple Agent SDK sessions simultaneously, each in its own channel. This is straightforward since each `query()` or `createSession()` call is independent.

- `/claude new api-server ~/Code/my-api` → `#claude-api-server`
- `/claude new frontend ~/Code/my-frontend` → `#claude-frontend`
- `/claude new devjourney ~/Code/devjourney` → `#claude-devjourney`

Show a dashboard view with `/claude dashboard`:

```
Active Sessions:
🟢 api-server    — Working on rate limiting (3 min)
🟡 frontend      — Waiting: permission to run npm build
⚪ devjourney    — Idle (completed 12 min ago)
```

#### 2.2 Session Presets

Define reusable session configurations for common project setups:

```json
{
  "presets": {
    "devjourney": {
      "path": "/mnt/c/Users/justi/Code/devjourney",
      "allowedTools": ["Read", "Edit", "Bash(npm *)", "Bash(git *)"],
      "permissionMode": "acceptEdits",
      "model": "claude-sonnet-4-5-20250929"
    },
    "jobsbored": {
      "path": "/mnt/c/Users/justi/Code/jobsbored",
      "allowedTools": ["Read", "Edit", "Write", "Glob", "Grep"],
      "permissionMode": "default"
    }
  }
}
```

Usage: `/claude new devjourney` — auto-fills path and permissions from preset.

#### 2.3 Hooks Integration

Register Claude Code hooks that fire alongside the SDK session:

- **Stop hook:** When Claude finishes, extract a summary from the transcript and post it. Optionally run a custom script (e.g., run tests, deploy to staging).
- **PreToolUse hook:** Log all tool usage to a dedicated `#claude-audit-log` channel for review.
- **PostToolUse hook:** After file edits, post a diff summary to the session channel.

#### 2.4 Quick Actions

Discord slash commands for common operations:

- `/claude compact` — Trigger context compaction on the current session.
- `/claude cost` — Show token usage and estimated cost for current session.
- `/claude files` — List files Claude has modified in this session.
- `/claude diff` — Show git diff of changes Claude has made.
- `/claude undo` — If using git checkpointing, revert to last checkpoint.
- `/claude screenshot` — If Claude is working on a web UI, capture a screenshot via MCP.

#### 2.5 Voice Messages (stretch)

Use Discord's voice message feature. When you send a voice message:

1. Transcribe it using Whisper or the Anthropic API.
2. Send the transcription to Claude.
3. Optionally, generate a TTS response for Claude's output.

### Phase 3 — Adapter Layer & Extensibility

#### 3.1 Messaging Bridge Interface

Extract the platform-agnostic interface:

```typescript
interface MessagingBridge {
  // Send a text message to the user
  sendMessage(sessionId: string, text: string): Promise<void>;

  // Send a message with action buttons, return the user's choice
  sendPrompt(
    sessionId: string,
    question: string,
    options: string[],
  ): Promise<string>;

  // Send a permission request, return allow/deny
  sendPermissionRequest(
    sessionId: string,
    request: PermissionRequest,
  ): Promise<PermissionResponse>;

  // Send a notification/alert to the user regardless of which session channel they're in
  sendNotification(text: string): Promise<void>;

  // Register a handler for incoming user messages
  onMessage(handler: (sessionId: string, text: string) => void): void;

  // Create/destroy session channels
  createSession(sessionId: string, name: string): Promise<void>;
  destroySession(sessionId: string): Promise<void>;
}
```

#### 3.2 Alternative Adapters

With the bridge interface defined, adding new platforms becomes straightforward:

- **SlackAdapter** — Uses Bolt SDK, Block Kit for buttons/selections. Good for team use with Crushing Digital.
- **TelegramAdapter** — Uses telegraf, inline keyboards for buttons. Simplest bot API, best phone notifications.
- **WebAdapter** — Simple Express + WebSocket server serving a React frontend. Full custom UI, no third-party dependency.

---

## Project Structure

```
claude-conductor/
├── src/
│   ├── index.ts                  # Entry point, process management
│   ├── config.ts                 # Environment and JSON config loading
│   │
│   ├── core/
│   │   ├── session-manager.ts    # Creates/tracks/resumes Agent SDK sessions
│   │   ├── session.ts            # Single session wrapper around Agent SDK
│   │   ├── message-router.ts     # Routes messages between sessions and adapter
│   │   └── permission-handler.ts # Permission request logic, timeouts, auto-rules
│   │
│   ├── bridge/
│   │   ├── types.ts              # MessagingBridge interface
│   │   └── discord-adapter.ts    # Discord implementation
│   │
│   ├── formatters/
│   │   ├── message-formatter.ts  # Formats Claude output for Discord (chunking, code blocks)
│   │   ├── diff-formatter.ts     # Formats file diffs
│   │   └── status-formatter.ts   # Session status embeds
│   │
│   └── utils/
│       ├── logger.ts             # pino logger setup
│       ├── store.ts              # Session state persistence (SQLite or JSON)
│       └── chunker.ts            # Message chunking for Discord's 2000 char limit
│
├── config/
│   ├── presets.json              # Session presets
│   └── conductor.json            # App configuration
│
├── .env                          # Discord token, API keys
├── package.json
├── tsconfig.json
└── CLAUDE.md                     # So Claude Code can work on this project
```

---

## Implementation Plan

### Week 1: Foundation

**Day 1-2: Project scaffolding and Discord bot**

- Initialize TypeScript project with discord.js
- Implement Discord bot with slash command registration
- Create the "Claude Sessions" category and channel management
- Test: bot comes online, creates/deletes channels via commands

**Day 3-4: Single session integration**

- Implement `Session` class wrapping Agent SDK `query()` or V2 `createSession()`
- Wire up message streaming: Claude output → Discord channel
- Wire up input: Discord message → `session.send()`
- Test: send a prompt from Discord, see Claude's response stream back

**Day 5: Permission handling**

- Implement `canUseTool` callback
- Create Discord button embeds for permission requests
- Implement button interaction handlers
- Test: Claude requests permission, button appears, clicking it unblocks Claude

### Week 2: Polish & Multi-Session

**Day 6-7: Message formatting and UX**

- Implement message chunking (2000 char limit)
- Code block detection and formatting
- Status embeds (working/waiting/idle)
- DM notifications for attention-needed events
- Error handling and graceful recovery

**Day 8-9: Multi-session support**

- Implement SessionManager for concurrent sessions
- Channel-to-session routing
- `/claude list` and dashboard command
- Session presets from config file
- Session persistence and reconnection on restart

**Day 10: Process management and deployment**

- pm2 configuration for auto-restart
- Startup script that reconnects existing sessions
- Logging and basic monitoring
- README and setup documentation

### Week 3+ (Phase 2): Power Features

- Quick action commands (diff, cost, files, undo)
- Hooks integration
- Audit logging channel
- Session resume
- Git checkpoint integration
- Voice message support (stretch)

---

## Configuration

### Environment Variables (.env)

```bash
# Discord
DISCORD_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_client_id
DISCORD_GUILD_ID=your_server_id
DISCORD_USER_ID=your_user_id

# Claude Agent SDK
# Uses your existing Claude Code auth by default
# Or set explicitly:
# ANTHROPIC_API_KEY=sk-ant-...

# Optional
LOG_LEVEL=info
PERMISSION_TIMEOUT_MINUTES=30
PERMISSION_REMINDER_MINUTES=10
DEFAULT_MODEL=claude-sonnet-4-5-20250929
```

### Application Config (config/conductor.json)

```json
{
  "categoryName": "Claude Sessions",
  "maxConcurrentSessions": 5,
  "messageChunkSize": 1900,
  "streamDebounceMs": 500,
  "showToolUseMessages": true,
  "autoApproveReadOnly": true,
  "notifyOnCompletion": true,
  "notifyOnPermission": true,
  "archiveEndedSessions": false,
  "presets": {
    "devjourney": {
      "path": "/mnt/c/Users/justi/Code/devjourney",
      "allowedTools": ["Read", "Edit", "Bash(npm *)", "Bash(git *)"],
      "permissionMode": "acceptEdits"
    }
  }
}
```

---

## Security Considerations

- **ALLOWED_USERS whitelist** — Only your Discord user ID can interact with sessions. This is critical since session channels can execute arbitrary code on your machine.
- **No API keys in Discord** — All secrets stay in `.env` on the host machine.
- **Permission defaults** — Start with `permissionMode: "default"` which requires approval for everything. Relax per-session or per-preset as you build trust.
- **Directory isolation** — Each session is scoped to its project directory. The Agent SDK respects the `cwd` option.
- **Audit logging** — Optionally log all tool executions to a dedicated channel or file for review.

---

## Open Questions

1. **Agent SDK auth:** The SDK can use your existing Claude Code auth (Pro/Max subscription) or an API key. Using existing auth avoids per-token costs but may share rate limits with your terminal Claude Code usage. Test whether concurrent SDK sessions + terminal sessions cause issues.

2. **V1 vs V2 SDK:** The V2 TypeScript interface (`unstable_v2_createSession`) has a cleaner session model with `send()`/`stream()` but is marked as preview. V1's `query()` with async generators is stable. Start with V1, migrate to V2 when it stabilizes.

3. **WSL vs native Windows:** The Agent SDK needs Claude Code installed. If running Conductor on WSL, sessions access the Linux filesystem natively. If running on Windows (via Git Bash), there may be path translation issues. WSL is the safer bet.

4. **Session cost tracking:** The Agent SDK may expose token usage in message metadata. If so, surface this per-session. If not, estimate from message lengths.

5. **Rate limits:** With multiple concurrent sessions, you may hit Claude's rate limits faster. The SDK handles retries, but you should surface rate limit events to Discord so you know what's happening.

---

## Success Criteria

The MVP is successful when you can:

1. Start a Claude Code session from your phone via Discord
2. Give Claude instructions and see its responses stream back
3. Approve or deny permission requests via Discord buttons
4. Respond to selection prompts via Discord buttons
5. Get a DM notification when Claude finishes or needs attention
6. Run 2+ sessions simultaneously in separate channels
7. Walk away from the computer and manage everything from Discord

---

## Future Possibilities

- **Open source release** — Clear gap in the ecosystem for a well-built solution. The adapter pattern makes it appealing to Slack/Telegram users too.
- **DevJourney integration** — Auto-generate LinkedIn posts from session transcripts.
- **PRP workflow** — Send a PRP document to a session channel, Claude picks it up and executes.
- **Team mode** — Multiple users in a shared Discord server, each with their own sessions, shared audit log. Relevant for Crushing Digital collaboration.
- **Mobile-optimized web UI** — A PWA that connects to Conductor's WebSocket server, designed specifically for the Claude Code interaction model rather than retrofitting a chat platform.
