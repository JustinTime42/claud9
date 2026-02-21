# Claude Conductor

Discord-based remote control for Claude Code sessions via the Agent SDK.

## Tech Stack

- **TypeScript** with ESM modules (`"type": "module"` in package.json)
- **discord.js v14** for the Discord bot
- **@anthropic-ai/claude-code** SDK for Claude Code integration (uses `query()` function)
- **pino** for structured logging

## Architecture

- `src/bridge/types.ts` — Platform-agnostic `MessagingBridge` interface and all shared types
- `src/bridge/discord-adapter.ts` — Discord implementation of the bridge
- `src/core/session.ts` — Wraps a single Claude SDK `query()` call with multi-turn support
- `src/core/session-manager.ts` — Manages multiple concurrent sessions
- `src/index.ts` — Entry point, wires everything together, handles slash commands
- `src/deploy-commands.ts` — One-time script to register Discord slash commands

## Key Patterns

- Sessions use the SDK's `query()` with `resume` option for multi-turn conversations
- Permission handling uses `canUseTool` callback which blocks until Discord button click
- Message chunking splits output at 1900 chars respecting code block boundaries
- All session state persisted to `data/sessions.json`
- Security: only `DISCORD_USER_ID` can interact with the bot

## Build & Run

```bash
npm install
npm run build    # TypeScript compile to dist/
npm start        # Run compiled output
npm run dev      # Run with tsx (no compile step)
npm run deploy-commands  # Register slash commands with Discord
```

## Config

- `.env` — Discord credentials and optional settings
- `config/conductor.json` — App config, session presets
