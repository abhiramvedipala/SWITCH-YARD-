# Switchyard — handoff brief (paste this into another Claude chat)

> **Your job in this chat:** you have access to a lot of research the builder did not. Read this brief, then (1) sanity-check the design against your research, (2) tell me what is wrong, risky or missing, and (3) give me a **prioritized to-do list** for what to build or verify next. Where your research contradicts a claim below, say so. Ask me for files or logs if you need them.

## 1. What this is

**Switchyard** is a local-first workspace where several AI coding agents (Claude Code `claude`, Google Antigravity CLI `agy`, plus a built-in `mock` agent and plain shells) run side by side on one canvas, discover each other, pass messages and tasks, flag when they need a human, and can be chained into planner → builder → reviewer "runs". One human supervises. Everything runs on the owner's Mac with their own subscriptions: no cloud, no accounts, no telemetry.

- Repo: `github.com/abhiramvedipala/repo-15`, branch `master`. Two commits: `phase 0`, then `phases 1-8`.
- Inspired by the public feature list of October Desktop; **independent from-scratch implementation**. No October code, assets or names. Personal use only.
- Docs in the repo: `README.md`, `PROGRESS.md` (phase log, deviations, owner to-do), `REPORT.md` (what works / mocked / manual checks), `NOTICE.md`.

## 2. Architecture (npm workspaces, Node 22, TypeScript strict, ESM)

| Package | Role |
|---|---|
| `packages/core` | Fastify + `@fastify/websocket` daemon on **127.0.0.1:4777 only** (hard-coded). better-sqlite3 (`~/.switchyard/switchyard.db`), node-pty terminals with 10k-line replay, durable message bus, harness adapters, status monitor, chat service, runs engine, session import, auth. Serves the built web UI. |
| `packages/bus-mcp` | stdio MCP server (`@modelcontextprotocol/sdk`, zod) with 13 tools, one process per agent node; a hook relay (`hook.js`) for status; a mock agent (`mock-agent.js`); an MCP test client. Talks to core over HTTP with a per-node capability. |
| `packages/web` | React 18 + Vite + zustand. `@xyflow/react` canvas, xterm.js terminals, `@dnd-kit` board, react-markdown. Dark UI, phone layout under 760px. |
| `extras/xbar` | menu-bar plugin that reads `/api/attention`. |

**Agent bus (MCP server name `switchyard`)**: `list_peers`, `get_peer_context`, `message_peer` (intent `notify|request|response`), `check_inbox`, `wait_for_reply`, `publish_summary`, `list_tasks`, `add_task`, `claim_task`, `complete_task`, `get_node_status`, `wait_for_nodes`, `ask_user`. Rules: only **edge-connected** nodes are visible/reachable (same error for "doesn't exist" and "not connected"); messages are persisted before ack; a message never starts an agent turn; an idle terminal agent gets one PTY nudge `[switchyard] N new messages — call check_inbox` (throttled 30 s, can be disabled); `request` expects a `response` with `responseTo`; peer messages are information, never permission grants. The human is pseudo-node `user` (not edge-scoped; agents may only *respond* to it).

**How agents get the bus**
- Claude: per-process `--mcp-config` (stdio server, `SWITCHYARD_NODE` in its env), `--settings` with hooks (`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Notification`, `Stop`, `SessionEnd`) that run `hook.js` → `POST /bus/hook`, and `--append-system-prompt`. `~/.claude/settings.json` is never touched. Resume = `--resume <id>`.
- agy: writes/refreshes only the `switchyard` entry in `~/.gemini/config/mcp_config.json`; `SWITCHYARD_NODE` set on the PTY. Because agy docs don't say whether `env` values expand `$VAR`, bus-mcp treats a literal `$SWITCHYARD_NODE` as unset and falls back to a per-cwd identity file (`~/.switchyard/run/by-cwd/<hash>.json`). agy status hooks are an **opt-in** Settings button (writes `~/.gemini/config/hooks.json`).
- Secrets: UI token (`~/.switchyard/ui-session`) and per-node capability files, all `0600`; env var names avoid TOKEN/KEY/SECRET/AUTH/PASSWORD.

**Status model**: `working | idle | needs_input | exited`. Claude is hook-driven. agy/mock/shell use a quiet heuristic (8 s without output ⇒ idle) plus on-screen prompt regexes for `needs_input`. `ask_user` creates a question row, shown in the "Needs you" sidebar with a reply box; answering unblocks the agent.

**Runs engine**: goal → planner (`--json-schema` plan) → editable plan card → approve → steps run in parallel when dependencies allow → reviewer returns `{approve, findings[]}` (schema-enforced) → findings go back to the builder in its own session, max 3 rounds → result card with evidence: files touched (before/after snapshot), `git diff --stat` if a repo, test output if a suite is detected (pytest files or `npm test`), otherwise honestly "unverified". Pause / stop / resume; restart marks in-flight work paused.

**Driven mode**: per-turn headless calls, not persistent processes: `claude -p … --output-format stream-json --verbose --include-partial-messages [--resume id]` and `agy -p … --output-format stream-json [--conversation id]`. Driven Claude uses `--permission-mode acceptEdits` plus an editable allow-list. YOLO (`bypassPermissions` / `--dangerously-skip-permissions`) only when the node's red YOLO switch is on.

**Security posture**: loopback bind; UI bearer token in `localStorage`; WebSocket needs the token in its first message and passes an Origin check; login rate-limited (8/min/IP); requests arriving through a proxy (forwarded headers or non-loopback Host, i.e. Tailscale) are "remote" and **read-only by default** except answering questions/replying; remote read-only can only be changed from the machine itself.

## 3. What was verified (all with the mock agent — no AI quota spent)

- 33 vitest unit tests: bus semantics (edge scoping, durability across DB reopen, request/response correlation, expiry, atomic claim, dependencies, ask_user, wait_for_nodes, user messages), adapter launch flags and YOLO gating, both CLIs' stream parsers (against documented shapes), agy config editing (preserves other servers, refuses to overwrite invalid JSON), session/export parsers, WS origin and remote detection.
- `npm run test:e2e`: real core HTTP server + three real bus-mcp processes over MCP stdio: A→B request, B reply, A `wait_for_reply` gets it; unconnected C sees nothing and can't message. Plus a full mock run (build → review requests docstring/type hints → fix → approve in round 2; pytest passes).
- `npm run test:ui`: 26 checks in headless Chromium: login, terminal output survives reload, 3 nodes + 2 edges + positions persist, focus mode, command palette, two mock terminal agents exchanging request/response, `ask_user` appears in Needs you in ~100 ms and the answer reaches the agent, board card moves Open → In progress → Done as an agent claims/completes, a run finishes with a result card, project chat streams, import dialog lists a fixture Claude session, phone layout is read-only and can answer, remote writes → 403, login → 429.
- Lint clean, `npm audit` 0 vulnerabilities, all Claude CLI flags used exist in the installed `claude` 2.1.296.
- Bugs found and fixed by those checks: DB-closed crash from a deferred nudge timer; stale `needs_input` after answering an `ask_user`; phone view ignoring read-only state; new nodes overlapping existing ones.

## 4. What was NOT verified (be skeptical here)

1. **No real `claude` or `agy` run has ever happened.** The build ran in a Linux cloud container: `agy` isn't installable/sign-in-able there, and tests deliberately never call real agents. Adapters follow the docs only.
2. Real Claude **hook payload fields** (e.g. `notification_type` values) and real **agy `stream-json` field names** are taken from docs; a mismatch would show up as wrong status chips or missing streamed text.
3. **agy MCP `env` `$VAR` expansion** is undocumented; the cwd-identity fallback means worst case is **one agy node per folder**.
4. agy has **no documented command to list conversations**, so the import dialog probes `agy --help` for a `conversations` subcommand (guessing `conversations list --output-format json`) and otherwise offers "continue most recent (`agy -c`)" or resume by id.
5. agy headless soft-denies shell commands unless allowed in `~/.gemini/antigravity-cli/settings.json`, which Switchyard does not edit.
6. **Tailscale phone access** was only simulated with forwarded headers; `tailscale serve` header/Host behavior, WebSocket origin handling behind it, and cookie/localStorage over the `*.ts.net` origin are untested.
7. macOS specifics untested: native build of node-pty/better-sqlite3 on arm64, `$SHELL` login shells, Keychain-based sign-in state (deliberately never read).
8. Phase 9 not built: Electron/Tauri shell, Codex adapter, October-Bus-compatible adapter. Built: git-worktree button, Web Speech push-to-talk, xbar plugin.
9. Known simplifications: driven turns are per-process (no persistent agy `--input-format stream-json` session); no tests for the React components themselves beyond the browser script; the bundle is one ~890 kB chunk; `npm run dev` has no HMR (it uses `vite build --watch`).

## 5. Manual checks the owner still has to run (on their Mac)

```bash
git clone https://github.com/abhiramvedipala/repo-15 switchyard && cd switchyard
xcode-select --install          # if native modules fail to build
npm install
claude                          # sign in once
curl -fsSL https://antigravity.google/cli/install.sh | bash && agy   # sign in once
npm start                       # prints the UI token once
```
1. **Two real agents talking:** add a Claude Code agent + an Antigravity agent, connect them; tell Claude: `list your switchyard peers and ask the agy peer for the word 'pong', then wait for the reply`; tell agy: `check your switchyard inbox and reply to the request`. Expect Claude to receive "pong".
2. **Real run:** Runs → goal `Create hello.py with a function that reverses a string and pytest tests; have the other agent review`, Where = scratch, Builder = Claude, Reviewer = Antigravity → expect a result card with evidence.
3. **Resume a real past Claude Code session** via Import sessions.
4. Also: Claude node `use the switchyard ask_user tool to ask me which color to use` → appears in Needs you ≤ 2 s; a permission prompt turns the node amber; `tailscale serve --bg 4777` and answer a question from a phone.

## 6. Questions I want you to answer with your research

1. Do the **documented Claude Code hook events/fields and `--settings`/`--mcp-config` behaviors** match what my adapter assumes (section 2)? Any flag, field or permission-mode behavior that changed recently? Is `--permission-prompts none` worth adopting?
2. Do the **agy CLI facts** hold: `agy -p`, `--output-format stream-json` event shapes, `--conversation`, MCP config path/shape, `env` expansion, hooks file location/shape, and any way to list conversations? What is the current best way to give agy persistent identity per node?
3. Is the **edge-scoped bus + capability-file auth** sound? Any hole in "a peer request is not a permission", the `user` pseudo-node, or the nudge-by-typing-into-PTY approach (prompt-injection risk, unintended input into a non-idle prompt)?
4. Is **screen-scraping prompts for `needs_input`** (regexes over stripped ANSI) too brittle? What's the better signal for Claude and agy?
5. What do comparable tools (October's published bus protocol, Moirai, Lantern, and others you've researched) do that this design misses: protocol features, session portability, notification UX, worktree isolation, cost/usage tracking?
6. Remote access: is `tailscale serve` + token + read-only-by-default adequate? What would you change before the owner uses it from a phone?

## 7. Output format I want back

1. **Verdict** (3–5 sentences): is the design sound; biggest risks.
2. **Discrepancies** between this brief and your research (table: claim → what you found → source/confidence).
3. **Prioritized to-do list**, grouped **Must fix before real use / Should do next / Nice to have**, each item with: why, rough effort (S/M/L), and how to verify it.
4. **A ready-to-paste prompt for Claude Code** to implement the top items in this repo, written so it can be followed without this conversation (include file paths where you can; key files: `packages/core/src/harness/{claude,agy}.ts`, `packages/core/src/bus/service.ts`, `packages/core/src/status/monitor.ts`, `packages/core/src/runs/engine.ts`, `packages/bus-mcp/src/index.ts`, `scripts/ui-check.mjs`).

Constraints to respect: never touch the owner's Gmail/Drive/browser/keychain/credentials; core stays bound to 127.0.0.1; never enable bypass-permissions except via the per-node YOLO switch; no outbound calls from the app itself; automated tests must never run real agents or touch real projects; personal use only (no distribution, no copying October code or branding).
