# Switchyard — handoff brief (paste this into another Claude chat)

> **Your job in this chat:** I'm the owner. A Claude Code session is building this on my Mac right now. Read this brief, then (1) sanity-check the design and the verification story against what you know, (2) tell me what is wrong, risky or missing, and (3) give me a **prioritized to-do list** for what to build or verify next. Where your knowledge contradicts a claim below, say so with your confidence. Ask me for files or logs if you need them.

## 1. What this is

**Switchyard** is a local-first macOS workspace where several AI coding agents (Claude Code `claude`, Google Antigravity CLI `agy`, a built-in `mock` agent and plain shells) run side by side on one canvas, discover each other, pass messages and tasks over a local MCP bus, show when they need me, and can be chained into planner → builder → reviewer "runs". One human supervises. Everything runs on my Mac with my own subscriptions: no cloud, no accounts, no telemetry, no outbound calls from the app itself. Personal use only. Inspired by October Desktop's public feature list; independent from-scratch implementation, no October code, assets or names.

- Repo: `github.com/abhiramvedipala/repo-15`, branch `master`, ~105 commits, one small commit per step/decision.
- Docs in the repo: `README.md`, `PROGRESS.md` (phase log, owner to-do, acceptance), `DECISIONS.md` (`date | claim | reality | what I did`), `REPORT.md`, `SWITCHYARD_FINAL_PROMPT.md` (the master plan: hard rules §1, verified CLI facts §2, phases F0–F12 §4, acceptance A1–A6 §5).

## 2. Architecture (npm workspaces, Node 22, TypeScript strict, ESM)

| Package            | Role                                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core`    | Fastify 5 + `@fastify/websocket` daemon on **127.0.0.1:4777 only** (hard-coded). better-sqlite3 at `~/.switchyard/switchyard.db`, node-pty terminals with 10k-line replay, durable message bus, harness adapters (claude / agy / mock / shell), status monitor, chat service, runs engine, session import, usage meter, auth. Serves the built web UI. |
| `packages/bus-mcp` | stdio MCP server `switchyard` (13 tools), one process per agent node; `hook.js` (Claude hook relay), `hook-agy.js` (agy hook relay), `mock-agent.js`, an MCP test client. Talks to core over HTTP with a per-node capability.                                                                                                                          |
| `packages/web`     | React 18 + Vite + zustand. `@xyflow/react` canvas, xterm.js terminals, `@dnd-kit` board, react-markdown. iNotch-style theme (light/dark, frosted overlays, reduced-transparency/contrast respected), phone layout under 760 px, code-split (main chunk ~370 kB).                                                                                       |
| `extras/xbar`      | menu-bar plugin reading `/api/attention`.                                                                                                                                                                                                                                                                                                              |
| `scripts/`         | `ui-check.mjs` (headless Chromium checks), `selftest.mjs` (idle RSS/CPU budget), `mac/make-app.sh` (`~/Applications/Switchyard.app`, script-based, no Electron), `stop.mjs`, `postinstall.mjs`, `probe-agy-env.mjs` (F1).                                                                                                                              |

**Agent bus (MCP tools):** `list_peers`, `get_peer_context`, `message_peer` (intent `notify|request|response`), `check_inbox`, `wait_for_reply`, `publish_summary`, `list_tasks`, `add_task`, `claim_task`, `complete_task`, `get_node_status`, `wait_for_nodes`, `ask_user`. Rules: only **edge-connected** nodes are visible/reachable (same error for "doesn't exist" and "not connected"); messages persisted before ack; a message never starts an agent turn by itself; `request` expects a `response` with `responseTo`; peer messages are information, never permission grants; the human is pseudo-node `user` (agents may only _respond_ to it).

**How agents get the bus**

- Claude: per-process `--mcp-config` (stdio server, `SWITCHYARD_NODE` + `SWITCHYARD_HOME` in its env) and `--settings` with `{"permissions":{"allow":["mcp__switchyard"]}}` plus **HTTP hooks** (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `Stop`, `StopFailure`, `Notification`, `SessionEnd`) pointing at `http://127.0.0.1:4777/bus/hook/claude/<nodeId>/<hookSecret>`; `hook.js` command relay as fallback. `~/.claude/settings.json` and `~/.claude.json` are never touched. Resume = `--resume <id>`.
- agy: Switchyard writes/refreshes only the `switchyard` entry in `~/.gemini/config/mcp_config.json` (`.bak` first, other entries kept, invalid JSON refused, Remove button). `SWITCHYARD_NODE` is set on the PTY; because agy doesn't document `$VAR` expansion in MCP `env`, bus-mcp treats a literal `$SWITCHYARD_NODE` as unset and falls back to a per-cwd identity file (`~/.switchyard/run/by-cwd/<sha>.json`) → worst case one agy node per folder. Status hooks (`~/.gemini/config/hooks.json`) and permission rules (`mcp(switchyard/*)`, test-runner `command(regex:…)`, `write_file(<run dir>/)` in `~/.gemini/antigravity-cli/settings.json`) are **opt-in Settings buttons**, each with `.bak` + Remove; Switchyard tracks which rules it added.
- Secrets: UI token (`~/.switchyard/ui-session`), per-node capability + hook secret (`~/.switchyard/run/<node>.json`), all `0600`, rotated on every (re)spawn; env var names never contain TOKEN/KEY/SECRET/AUTH/PASSWORD.

**Status model:** `working | idle | needs_input | exited`. Claude is hook-driven (authoritative). agy: opt-in hooks (`PreInvocation` → working, `Stop fullyIdle` → idle, `PreToolUse ask_permission|ask_question` → needs_input with Allow/Deny/Ask-in-terminal), else a quiet heuristic (8 s silent ⇒ idle) + on-screen prompt regexes. `ask_user` → question row in the "Needs you" sidebar. **PermissionRequest** hooks are held open until I click Allow once / Deny / Ask in terminal (590 s → `{}` so the terminal prompt takes over; never auto-allow).

**Message delivery without blind typing (F4):** Claude's `Stop` hook answers `{"decision":"block","reason":"You have N new switchyard messages…"}` when requests are pending (max 3 consecutive blocks, honours `stop_hook_active`), `additionalContext` for notify-only backlogs; agy `PreInvocation` injects an ephemeral step, `Stop` continues once. The PTY nudge (`[switchyard] N new messages — call check_inbox`) is last resort: off for Claude, only on authoritative idle, never while needs_input, counted. Human replies into a PTY use bracketed paste, a `Reply: ` prefix for `/`- or `!`-leading lines, control chars stripped; free text is refused while a node shows a permission/trust prompt.

**Runs engine:** goal → planner (`--json-schema` plan) → editable plan card → approve → steps in parallel when deps allow → reviewer `{approve, findings[]}` (schema-enforced) → findings back to the builder in its own session, max 3 rounds → result card with evidence: files touched (before/after snapshot), `git diff --stat`, test output (pytest or `npm test` if detected) else "unverified: <why>", and `permission_denials` named ("unverified: pytest was denied"). Run dirs default to `~/.switchyard/scratch/<yyyymmdd-hhmm>-<slug>/` with `git init` + empty commit so diffs are real; a guard refuses nodes/runs whose realpath is inside the Switchyard repo or `~/.switchyard` (except `scratch/`) unless I tick "I understand".

**Driven mode:** per-turn headless calls: `claude -p … --output-format stream-json --verbose --include-partial-messages [--resume id] --permission-mode acceptEdits --permission-prompts none` plus an editable allow-list; `agy -p … --output-format stream-json [--conversation id]`. YOLO (`bypassPermissions` / `--dangerously-skip-permissions`) only when the node's red YOLO switch is on; tests assert the flags are absent otherwise.

**Usage meter (F9):** per-turn `usage` table (Claude `total_cost_usd` + tokens, agy tokens), `GET /api/usage?nodeId|runId`, spend badge on driven chat nodes.

**Sessions:** Claude list from `~/.claude/projects/**/*.jsonl` (resume `claude --resume`); agy list by scanning `~/.gemini/antigravity-cli/brain/*/.system_generated/logs/transcript.jsonl` read-only (title = first user text, mtime, workspace), resume `agy --conversation <id>`; Claude.ai / ChatGPT exports imported as read-only docs.

**Remote (Tailscale):** loopback bind stays; `tailscale serve --bg 4777`. A request with forwarding headers is "remote": read-only by default (can still answer questions, Allow/Deny, reply), the read-only switch can only be changed locally, login rate-limited 8/min, WebSocket needs the token in its first message plus an Origin check, Funnel (`tailscale-funnel-request`) → 403.

**Widgets:** `GET /api/attention/summary` (`{count, byKind, hash}`) and `GET /api/attention?wait=30&since=<hash>` (long-poll, ETag/304) for a notch app or menu bar; `POST /api/questions/:id/answer`, `POST /api/permissions/:id/decide`.

**Perf/Mac:** server idles at ~39 MB footprint (`ps` RSS 34-69 MB depending on memory pressure) / 0.7 % CPU on the M3 (`npm run selftest` enforces 140 MB / 3 %); helper processes capped at 64 MB heap; attention feed long-polls instead of timers; canvas renders only visible nodes; `npm run mac:app`, PWA manifest, `npm run stop`, `#token=` launcher sign-in scrubbed from the URL.

## 3. What is verified (all with the mock agent; no AI quota spent)

- **139 vitest tests**: bus semantics (edge scoping, durability across DB reopen, request/response correlation, expiry, atomic claims, dependencies, ask_user, wait_for_nodes, user messages), adapter launch flags + YOLO gating, both CLIs' stream parsers, agy config/hooks/permission-rule editing (keeps other keys, refuses invalid JSON, `.bak`, exact removal), session parsers (fixtures, malformed lines), F2 guard incl. symlinks, F4 Stop/PreInvocation decision tables (loop cap, `stop_hook_active`), hook-secret rejection, PTY reply escaping, F5 hook→status mapping and permission route (card, decide, stale 404, remote may decide only), usage recorder/summary, attention feed ETag/304/long-poll, WS origin + remote detection + Funnel 403, capability rotation.
- **`npm run test:e2e`**: real core + three real bus-mcp processes over MCP stdio (A→B request, B reply, A `wait_for_reply`; unconnected C isolated), a full mock run with real git evidence and `pytest` passing, and the F3 denied-tool evidence path.
- **27 headless-Chromium checks** (`scripts/ui-check.mjs`): login/token, launcher link, terminal replay across reload, 3 nodes + 2 edges persisted, focus mode, ⌘K, two mock agents exchanging request/response, `ask_user` in Needs you in ~1.3 s and answered from the sidebar, board card moves as an agent claims/completes, a run finishes with a result card, project chat streams, import dialog lists a fixture Claude session, phone layout read-only + answering, remote write → 403, login → 429, no page errors.
- **macOS arm64 bring-up (today, F0)**: Apple M3, macOS 27, Node 22.23.3, Claude Code 2.1.272 (all adapter flags present in `claude --help`), Xcode CLT, pytest 9. All suites green after three Mac fixes: node-pty 1.1.0's tarball ships `spawn-helper` without the exec bit (every PTY died with `posix_spawnp failed`; fixed by `scripts/postinstall.mjs`), `/var` → `/private/var` realpath for not-yet-existing subpaths in the own-folder guard, and e2e/ui-check path assumptions from the Linux container.

## 4. In flight right now (four parallel worktree agents, each gated by lint + vitest + e2e + ui-check)

1. **F10**: remote requests verified with a cached (60 s) `tailscale whois --json <x-forwarded-for>` matching `tailscale-user-login`, owner login pinned on first verified use, `https://*.ts.net` WebSocket origin accepted only for verified remote requests; injectable whois runner for tests; fail closed if the binary is missing.
2. **F6**: bus-mcp reads its capability from the `0600` file named in `SWITCHYARD_CAPFILE` (mode/owner checked, never from env content); identical rejection for unknown node / stale cap / foreign cap / wrong hook secret; revoke on exit; `--max-semi-space-size=1` on child processes.
3. **F5 ui-checks**: PermissionRequest Allow / Deny / timeout cards driven end-to-end in the browser, plus detection of Claude's folder-trust dialog as a needs_input item with an Accept button.
4. **F9**: usage totals on run step rows and the result card; e2e asserts the run total equals the sum of turn usages.

## 5. Not yet verified (be skeptical here)

1. **No real `claude` or `agy` run has ever gone through Switchyard.** `agy` is being installed on the Mac right now. Adapters follow the docs; real hook payload fields, agy `stream-json` field names and the trust-dialog text are from docs only.
2. **agy env inheritance / `$VAR` expansion in MCP `env`** is undocumented → `scripts/probe-agy-env.mjs` (F1, one small agy request in a temp folder with workspace-level `.agents/hooks.json` + `.agents/mcp_config.json`) decides whether `SWITCHYARD_NODE` becomes the primary identity or the per-cwd file stays.
3. **Real Tailscale**: `tailscale` is not installed; serve/whois behaviour and cookie/localStorage on the `*.ts.net` origin are untested.
4. Acceptance A1–A6 from the master plan (two real agents exchange "pong"; delivery via the Stop hook with zero PTY nudges; permission from the sidebar; `ask_user`; a real planner→builder→reviewer run with evidence; resume a real Claude session and an agy conversation) are owner-driven, one at a time, each in a fresh `~/.switchyard/scratch` workspace.
5. Skipped by decision: F8 (persistent agy `--input-format stream-json` sessions; per-turn `-p --conversation` is used), F11 (Claude `--bg` background sessions: research only, not started), Electron/Tauri shell, Codex adapter, October-Bus-compatible adapter, Moirai import.

## 6. Hard rules the builder follows

127.0.0.1 only; no outbound calls; never `bypassPermissions` / `--dangerously-skip-permissions` without the node's YOLO switch; tests never run real agents or touch real projects; never edit `~/.claude/settings.json` or `~/.claude.json`; outside the repo only `~/.switchyard/**` and the three opt-in agy files (each with `.bak` and Remove); never touch Gmail/Drive/browser/keychain, never ask for passwords or tokens; secrets as `0600` files; small commits, no force pushes; never weaken a test to make it pass.

## 7. Questions I want you to answer

1. Does the Claude Code hook/permission design (HTTP hooks with per-node secrets, held-open `PermissionRequest`, `Stop`-hook delivery with a 3-block cap, `--permission-prompts none` in driven mode) match current Claude Code 2.1.27x behaviour? Anything that changed recently, or a safer/simpler signal for needs_input than screen regexes for the trust dialog?
2. Do the agy facts hold (`agy -p` JSON envelope, `stream-json` events, `--conversation`, `~/.gemini/config/mcp_config.json`, `hooks.json` shape and camelCase stdin, `permissions.allow` syntax, `brain/<id>/.system_generated/logs/transcript.jsonl`)? Best current way to give agy a per-node identity?
3. Is edge-scoped bus + per-node capability file + hook secret sound? Holes in "a peer request is not a permission", the `user` pseudo-node, or human replies typed into a PTY?
4. Remote: is `tailscale serve` + bearer token + whois-verified identity + read-only-by-default enough before I use it from a phone? What would you change?
5. What do comparable tools do that this misses (protocol features, session portability, notifications, worktree isolation, cost tracking)?
6. Anything in §4/§5 you'd reorder, drop, or add before the real-agent acceptance checks?

## 8. Output format I want back

1. **Verdict** (3–5 sentences): is the design sound; biggest risks.
2. **Discrepancies** (table: claim → what you found → confidence).
3. **Prioritized to-do list**, grouped **Must fix before real use / Should do next / Nice to have**, each with why, effort (S/M/L), how to verify.
4. **A ready-to-paste prompt for Claude Code** to implement the top items in this repo (key files: `packages/core/src/harness/{claude,agy,util}.ts`, `packages/core/src/bus/{service,hooks,delivery}.ts`, `packages/core/src/status/{monitor,permissions}.ts`, `packages/core/src/runs/engine.ts`, `packages/core/src/auth/capability.ts`, `packages/core/src/server.ts`, `packages/core/src/ws.ts`, `packages/bus-mcp/src/index.ts`, `scripts/ui-check.mjs`).
