# Autonomous Proactive Agent Research

Research into building a self-directed, proactive coding agent that periodically works on your projects, communicates via Discord, and runs on your Claude subscription.

## Table of Contents

- [Landscape Overview](#landscape-overview)
- [Key Concepts from OpenClaw](#key-concepts-from-openclaw)
- [How the Transcript Author Built Their Own](#how-the-transcript-author-built-their-own)
- [Existing Tools & Prior Art](#existing-tools--prior-art)
- [Critical Constraint: Subscription vs API Billing](#critical-constraint-subscription-vs-api-billing)
- [Rate Limit Strategy](#rate-limit-strategy)
- [Proposed Architecture](#proposed-architecture)
- [Implementation Plan](#implementation-plan)
- [Open Questions & Risks](#open-questions--risks)
- [Sources](#sources)

---

## Landscape Overview

The "proactive AI agent" space has exploded in early 2026. The key players:

| Tool | Stars | Approach | Security Model |
|------|-------|----------|----------------|
| **OpenClaw** | 185k+ | Full personal AI assistant with adapters, memory, heartbeat | Runs on host, plain-text creds, multiple CVEs |
| **NanoClaw** | ~8k | Lightweight OpenClaw alternative | Docker container isolation |
| **OpenHands** | ~80k | Autonomous coding agent (CodeAct architecture) | Sandboxed execution |
| **claude-code-scheduler** | ~2k | Claude Code + cron for scheduled tasks | Uses `claude -p` CLI |
| **claude-flow** | ~5k | Multi-agent orchestration for Claude Code | MCP-based coordination |

The consensus is clear: OpenClaw pioneered the **feel** of a truly proactive agent, but its security model is a liability. The smart move is to extract the concepts that make it work and build a controlled version yourself.

## Key Concepts from OpenClaw

OpenClaw's magic comes from four core components:

### 1. Memory System (Markdown-Driven)
- `soul.md` — Agent identity, evolves over time
- `user.md` — User preferences, context, decisions
- `memory.md` — Core memories, facts, project context
- `agents.md` — Global rules for agent behavior
- Session logs stored per-day
- SQLite with lightweight RAG for search over all markdown files
- **Key insight**: Markdown is the database. Simple, human-editable, version-controllable.

### 2. Heartbeat (Proactive Scheduling)
- A cron-like system that fires every N minutes (default 30)
- Reads `HEARTBEAT.md` — a checklist of what to do proactively
- Agent evaluates: "Is there anything I should do for the user right now?"
- If nothing needs attention: responds `HEARTBEAT_OK` (silent)
- If something is actionable: sends a message to the user
- Supports active hours configuration (e.g., 8am-10pm only)
- Configuration example:
  ```json
  {
    "heartbeat": {
      "every": "30m",
      "activeHours": { "start": "08:00", "end": "22:00" }
    }
  }
  ```

### 3. Channel Adapters
- WhatsApp, Telegram, Slack, Discord, Teams, etc.
- Thread support for concurrent conversations
- You really only need one or two (Discord in our case)

### 4. Skills Registry
- Single-file capability definitions
- "Here's how to build frontends" / "Here's how to generate reports"
- Claude Code already has this via CLAUDE.md and skills

## How the Transcript Author Built Their Own

The YouTube transcript describes a developer who replicated OpenClaw's core in ~2000 lines of Python + markdown:

1. **Cloned OpenClaw repo locally** (MIT licensed)
2. **Pointed Claude Code at it**: "Look at how they built X, now build it for me adapted to my tech stack"
3. **Claude Code one-shotted** the memory system, heartbeat, and adapter
4. **Tech stack**: Python, Markdown (memory), SQLite (local RAG), PostgreSQL (remote), Obsidian (syncing), Claude Agent SDK (proactive agent), Claude Code CLI (primary driver)
5. **Key insight**: Uses Claude Code / Claude Agent SDK directly = uses Anthropic subscription, NOT API credits. This is ToS-compliant unlike OpenClaw which has gotten people's subscriptions banned.
6. **Heartbeat**: Scheduled job every 30 minutes via Claude Agent SDK. Sends a prompt to check emails, calendar, Asana tasks, and memory, then notifies if anything needs attention.

## Existing Tools & Prior Art

### claude-code-scheduler
A Claude Code plugin that automates task execution via native OS schedulers:
- Tasks defined in `.claude/schedules.json`
- Uses `claude -p` (headless CLI) for execution
- Supports cron expressions, one-time tasks, and autonomous tasks
- Git worktree isolation for tasks that modify code (creates branches, commits, pushes)
- Natural language task definition
- **Limitation**: No built-in rate limit handling; delegates to Claude's own limits
- **Limitation**: Uses `--dangerously-skip-permissions` for autonomous mode

### NanoClaw
- Runs in Docker containers for isolation
- Connects to WhatsApp, has memory, scheduled jobs
- Built on Anthropic's Agent SDK
- ~8 minute codebase to understand
- Setup via Claude Code itself (`/setup`)

### OpenHands
- Full autonomous coding platform
- CodeAct architecture with sandboxed execution
- Too heavy for our needs, but good reference for task decomposition patterns

## Critical Constraint: Subscription vs API Billing

This is the most important technical consideration:

| Method | Billing | Rate Limits | Headless? |
|--------|---------|-------------|-----------|
| `claude -p` (CLI) | Subscription (Pro/Max) | Subscription limits | Yes |
| `@anthropic-ai/claude-code` `query()` | Subscription | Subscription limits | Yes |
| `@anthropic-ai/claude-agent-sdk` | API keys only* | API rate limits | Yes |
| Direct Anthropic API | API keys only | API rate limits | Yes |

**The winning approach**: Use `@anthropic-ai/claude-code` with `query()` — which is exactly what claude-conductor already uses. This runs through the Claude Code infrastructure and bills against your subscription.

**Discovered workaround for Agent SDK**: As of Feb 2026, you can use `claude setup-token` to generate an OAuth token, then set `CLAUDE_CODE_OAUTH_TOKEN=TOKEN` to authenticate the Agent SDK against Max plan billing. But since we already use the `@anthropic-ai/claude-code` package, this isn't necessary.

### Subscription Rate Limits (Pro $20/mo, Max $100-200/mo)
- Rolling hourly windows
- Weekly allocation caps
- Max plan has significantly higher limits
- No programmatic way to query remaining quota
- Rate limit signals: the SDK will throw/yield errors when limits are hit

## Rate Limit Strategy

Since we're using subscription billing, we need to be especially careful about rate limits. Here's the proposed strategy:

### Approach: Adaptive Backoff with Budget Awareness

```
┌─────────────────────────────────────────────────┐
│                 Scheduler Loop                   │
│                                                  │
│  1. Check: Is it within active hours?            │
│  2. Check: Are we in a cooldown period?          │
│  3. Pick highest-priority pending task           │
│  4. Execute task via query()                     │
│  5. On success: log result, notify via Discord   │
│  6. On rate limit: enter exponential backoff     │
│     - 5min → 15min → 30min → 1hr → 2hr          │
│  7. On completion: wait for next interval        │
│  8. Track daily token usage estimate             │
│                                                  │
│  Safety valves:                                  │
│  - Max tasks per hour (configurable, e.g., 3)    │
│  - Max tasks per day (configurable, e.g., 20)    │
│  - Minimum gap between tasks (e.g., 10 min)      │
│  - Hard stop on repeated rate limit errors       │
└─────────────────────────────────────────────────┘
```

### Rate Limit Detection
- Catch errors from `query()` — look for rate limit indicators in error messages
- Track the `total_cost_usd` from result messages to estimate budget consumption
- If 3+ rate limits hit in succession, enter long cooldown (2+ hours)

### Priority System
Not all proactive work is equal. Suggested priority tiers:
1. **Critical**: Test failures on main branch, security vulnerability alerts
2. **High**: Run tests on active projects, check for dependency updates
3. **Medium**: Review planned features, draft PRs for small improvements
4. **Low**: Code quality scans, documentation improvements
5. **Background**: Explore upgrade possibilities, research

## Proposed Architecture

Build this as an extension to claude-conductor, not a separate project.

```
claude-conductor/
├── src/
│   ├── index.ts                    # Existing entry point
│   ├── bridge/                     # Existing Discord bridge
│   ├── core/                       # Existing session management
│   │
│   ├── autopilot/                  # NEW - Proactive agent system
│   │   ├── scheduler.ts            # Cron-like scheduler with rate limit awareness
│   │   ├── heartbeat.ts            # Heartbeat loop (checks what to do)
│   │   ├── task-queue.ts           # Priority queue of pending tasks
│   │   ├── task-runner.ts          # Executes a single task via query()
│   │   ├── rate-limiter.ts         # Adaptive backoff + budget tracking
│   │   └── reporters/
│   │       └── discord-reporter.ts # Reports results to Discord channel
│   │
│   ├── memory/                     # NEW - Persistent memory system
│   │   ├── memory-store.ts         # Read/write markdown memory files
│   │   ├── project-registry.ts     # Tracks active projects + their paths
│   │   └── session-log.ts          # Daily session logging
│   │
│   └── config.ts                   # Extended with autopilot settings
│
├── data/
│   ├── sessions.json               # Existing
│   ├── memory/                     # NEW - Memory markdown files
│   │   ├── projects.md             # Active projects, their paths, status
│   │   ├── preferences.md          # User coding preferences
│   │   ├── learnings.md            # What the agent has learned
│   │   └── logs/                   # Daily activity logs
│   │       └── 2026-02-21.md
│   │
│   └── heartbeat.md                # NEW - What to do proactively
│
├── config/
│   └── conductor.json              # Extended with autopilot config
```

### Component Design

#### Scheduler (`scheduler.ts`)
- Node.js `setInterval` or `node-cron` for timing
- Configurable interval (default: 30 minutes)
- Active hours support (e.g., only run 6am-midnight)
- Respects rate limiter state before launching tasks

#### Heartbeat (`heartbeat.ts`)
- Reads `data/heartbeat.md` to determine what to do
- Reads `data/memory/projects.md` to know which projects to check
- Generates a prompt for Claude like: "Check these projects, run tests, look for issues"
- Returns either "nothing to do" or a list of actionable items

#### Task Queue (`task-queue.ts`)
- Priority-ordered queue of tasks to execute
- Tasks can be generated by the heartbeat, scheduled, or manually triggered via Discord
- Persisted to disk so tasks survive restarts
- Deduplication (don't re-run a task that just completed)

#### Task Runner (`task-runner.ts`)
- Uses `@anthropic-ai/claude-code` `query()` to execute tasks
- Each task runs in the context of a specific project directory (`cwd` option)
- Uses `allowedTools` to control what Claude can do per task type
- Captures output, cost, and session ID
- Git worktree isolation for tasks that create PRs

#### Rate Limiter (`rate-limiter.ts`)
- Tracks: tasks executed this hour, tasks today, consecutive rate limit errors
- Exponential backoff on rate limit errors
- Configurable limits (max tasks/hour, max tasks/day)
- Exposes `canExecute()` check for the scheduler

#### Discord Reporter (`discord-reporter.ts`)
- Sends task results to a dedicated Discord channel
- Formats results as embeds (success/failure, what changed, cost)
- Supports buttons for: "Create PR", "Show diff", "Revert", "Run again"
- Daily summary embed at end of active hours

### heartbeat.md Example

```markdown
# Heartbeat - Proactive Tasks

## Every Run (30 min)
- Check if any project has failing tests on the main branch
- Check for critical security advisories in dependencies

## Hourly
- Run the full test suite for the highest-priority active project
- Check for new GitHub issues assigned to me

## Daily (first run of the day)
- Run `npm outdated` / `pip list --outdated` on all active projects
- Review planned features in projects.md and suggest next steps
- Generate a daily summary of yesterday's autonomous work

## Weekly (Monday first run)
- Full dependency audit across all projects
- Look for potential refactoring opportunities in recently changed files
- Review and update memory files for accuracy
```

### projects.md Example

```markdown
# Active Projects

## claude-conductor
- **Path**: C:\Users\justi\Code\claude-conductor
- **Stack**: TypeScript, discord.js, @anthropic-ai/claude-code
- **Priority**: High
- **Test command**: `npm test`
- **Build command**: `npm run build`
- **Planned features**:
  - [ ] Autopilot system (this project!)
  - [ ] Web dashboard for session monitoring

## other-project
- **Path**: C:\Users\justi\Code\other-project
- **Stack**: Python, FastAPI
- **Priority**: Medium
- **Test command**: `pytest`
- **Planned features**:
  - [ ] Add caching layer
  - [ ] Improve error handling
```

## Implementation Plan

### Phase 1: Foundation (MVP)
1. **Rate limiter** — Build the adaptive backoff system first
2. **Scheduler** — Simple `setInterval` with active hours
3. **Task runner** — Wrap `query()` with error handling and rate limit detection
4. **Discord reporter** — Post results to a dedicated channel
5. **Basic heartbeat** — Read heartbeat.md and run tests on one project

Deliverable: Agent runs tests on your projects every 30 min, reports results to Discord, backs off gracefully on rate limits.

### Phase 2: Intelligence
6. **Memory system** — projects.md, preferences.md, learnings.md
7. **Full heartbeat** — Parse heartbeat.md for time-based task selection
8. **Task queue** — Priority ordering, persistence, deduplication
9. **Git worktree isolation** — Create branches for autonomous changes
10. **PR creation** — Auto-create PRs via `gh` CLI for suggested changes

Deliverable: Agent proactively checks dependencies, suggests upgrades, creates PRs.

### Phase 3: Autonomy
11. **Project scanning** — Auto-discover projects and their configurations
12. **Learning loop** — Agent updates memory based on outcomes (test patterns, common failures)
13. **Feature work** — Agent can pick up planned features from projects.md and work on them
14. **Configurable autonomy levels** — "notify only", "draft PR", "auto-merge if tests pass"
15. **Daily/weekly digest** — Comprehensive summary embeds

Deliverable: Full proactive agent that learns, creates PRs, and communicates progress.

### Phase 4: Polish
16. **Discord slash commands** — `/autopilot status`, `/autopilot pause`, `/autopilot add-project`
17. **Web dashboard** — Optional status page
18. **Multi-model support** — Use cheaper models for routine checks, Opus for complex work
19. **Cost tracking dashboard** — Track subscription usage patterns

## Open Questions & Risks

### Questions
1. **Subscription limits**: The Max plan's exact hourly/daily limits aren't publicly documented. We'll need to discover them empirically and tune the rate limiter accordingly.
2. **Concurrent sessions**: Can we run autopilot tasks while also using claude-conductor interactively? Need to test if the subscription supports concurrent `query()` calls.
3. **Permission model**: For autonomous tasks, we need to decide what tools to allow. `--dangerously-skip-permissions` is one option but risky. Better to use `allowedTools` with a curated whitelist per task type.
4. **Git safety**: Autonomous agents creating PRs need guardrails — never force push, never modify main directly, always use branches.

### Risks
1. **Subscription ban**: Anthropic has banned subscriptions used with OpenClaw. Using `@anthropic-ai/claude-code` directly should be ToS-compliant (it's Anthropic's own SDK), but heavy autonomous usage might raise flags. Worth monitoring.
2. **Rate limit storms**: If multiple projects need attention simultaneously, we could burn through limits fast. The priority system and task-per-hour cap mitigate this.
3. **Runaway agent**: An autonomous agent that makes bad changes could create mess. Mitigations: git worktree isolation, "notify only" default mode, Discord approval buttons before PR merge.
4. **Cost visibility**: No programmatic API to check remaining subscription quota. We're flying partially blind on budget.

### Security Considerations (Why Not OpenClaw)
- No third-party skill registry (no malicious packages)
- No web-accessible interface (Discord only, locked to your user ID)
- No plain-text credential storage (use .env with proper permissions)
- Controlled tool access via `allowedTools` per task type
- Git worktree isolation prevents main branch corruption
- All autonomous actions logged and reported to Discord

---

## Sources

- [OpenClaw GitHub Repository](https://github.com/openclaw/openclaw)
- [OpenClaw Official Site](https://openclaw.ai/)
- [OpenClaw Heartbeat Implementation Guide](https://markaicode.com/openclaw-heartbeat-proactive-tasks/)
- [NanoClaw GitHub Repository](https://github.com/qwibitai/nanoclaw)
- [NanoClaw vs OpenClaw (Startup News)](https://startupnews.fyi/2026/02/21/nanoclaws-answer-to-openclaw-is-minimal-code-maximum-isolation/)
- [OpenHands Platform](https://openhands.dev/)
- [OpenHands GitHub Repository](https://github.com/OpenHands/OpenHands)
- [claude-code-scheduler GitHub](https://github.com/jshchnz/claude-code-scheduler)
- [Claude Code Headless Mode Docs](https://code.claude.com/docs/en/headless)
- [Claude Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [Agent SDK Subscription Billing Issue #559](https://github.com/anthropics/claude-agent-sdk-python/issues/559)
- [Claude Code Tasks Update (VentureBeat)](https://venturebeat.com/orchestration/claude-codes-tasks-update-lets-agents-work-longer-and-coordinate-across)
- [Anthropic: Enabling Claude Code Autonomous Work](https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously)
- [Claude Code Rate Limits Guide](https://www.truefoundry.com/blog/claude-code-limits-explained)
- [OpenClaw Alternatives (KDnuggets)](https://www.kdnuggets.com/5-lightweight-and-secure-openclaw-alternatives-to-try-right-now)
- [What is OpenClaw (DigitalOcean)](https://www.digitalocean.com/resources/articles/what-is-openclaw)
- [Building Automated Claude Code Workers with Cron](https://www.blle.co/blog/automated-claude-code-workers)
