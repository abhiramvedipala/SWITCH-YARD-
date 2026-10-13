# SWITCHYARD — FINAL build, harden, and verify prompt for Claude Code

> **Abhiram, how to use this (once):**
> 1. On your Mac: `cd` into the Switchyard repo (`git clone https://github.com/abhiramvedipala/repo-15 switchyard && cd switchyard` if it isn't there yet).
> 2. This file is already in the repo root as `SWITCHYARD_FINAL_PROMPT.md`.
> 3. Run `claude` in that folder and paste exactly:
>    `Read SWITCHYARD_FINAL_PROMPT.md completely, then execute it phase by phase. Resume from PROGRESS.md if it already has F-phase entries.`
> 4. If the session ends or runs out of usage, start `claude` again in the same folder and paste the same line. It resumes.
> 5. When it stops and says **OWNER CHECK**, do exactly what it tells you, paste the result back, and it continues.
>
> This file replaces `SWITCHYARD_ROUND2_PROMPT.md`. You do not need to read anything else.

---

## 0. Who you are and what this is

You are Claude Code working on **Switchyard**, a local-first macOS workspace where AI coding agents (Claude Code `claude`, Google Antigravity CLI `agy`, a built-in `mock` agent, plain shells) run on one canvas, message each other over a local bus, show when they need the human, and run planner → builder → reviewer "runs". One human (Abhiram) supervises. Everything runs on his Mac with his own subscriptions. No cloud, no accounts, no telemetry. Personal use only. Inspired by October Desktop's public feature list; **no October code, assets, or names**.

Current state (read `HANDOFF.md`, `PROGRESS.md`, `REPORT.md`, `NOTICE.md` first):
- npm workspaces, Node 22, TS strict, ESM. `packages/core` (Fastify + WS on 127.0.0.1:4777, better-sqlite3 at `~/.switchyard/switchyard.db`, node-pty, bus, harness adapters, status monitor, chat, runs engine, sessions, auth), `packages/bus-mcp` (stdio MCP server `switchyard` with 13 tools, `hook.js`, `mock-agent.js`), `packages/web` (React 18 + Vite + zustand, @xyflow/react, xterm, @dnd-kit), `extras/xbar`.
- 33 unit tests, 2 e2e scenarios, 26 headless-browser checks, all with the mock agent. **Never run against real `claude` or `agy`.** Built in a Linux container; never run on macOS.

Your job in this file: (1) bring it up on the Mac, (2) fix every known design gap using the verified facts below, (3) prove each fix with automated tests, (4) walk the owner through the real-agent acceptance checks, (5) leave a final report. Do not stop until Section 8's definition of done is met or you are blocked on an OWNER CHECK.

## 1. Hard rules (never break, never "temporarily" relax)

1. Never read, write, or automate Gmail, Google Drive, browsers, cookies, the macOS Keychain, or any credential store. Never ask the owner for passwords, tokens, or recovery codes. Never print secrets into logs or chat.
2. Core binds `127.0.0.1` only. No new listeners. No outbound network calls from Switchyard itself (agents call their own providers; that's fine).
3. Never pass `--dangerously-skip-permissions`, `--permission-mode bypassPermissions`, `--allow-dangerously-skip-permissions`, or agy `--dangerously-skip-permissions` unless that node's red YOLO switch is on. Tests assert this.
4. Automated tests never spawn real `claude`/`agy` and never touch real projects; they use `mock` and temp dirs.
5. Never edit `~/.claude/settings.json` or `~/.claude.json`. Claude settings go per process via `--settings`/`--mcp-config`.
6. Outside the repo you may only write: `~/.switchyard/**`; the `switchyard` entry in `~/.gemini/config/mcp_config.json`; the `switchyard` hook entry in `~/.gemini/config/hooks.json`; the `permissions.allow` entries Switchyard owns in `~/.gemini/antigravity-cli/settings.json`. Each of those three agy edits happens only after the owner clicks an opt-in button in Settings, keeps every other key, refuses invalid JSON, writes a `.bak` first, and has a matching "Remove" button.
7. Never delete user data. Never run `git push`. Commit locally only.
8. Secrets (UI token, per-node capability, per-node hook secret) live in `~/.switchyard/` as `0600` files or in memory; never in env var names containing TOKEN/KEY/SECRET/AUTH/PASSWORD/CREDENTIAL (agy and Gemini-family tools strip those from MCP child envs). Use names like `SWITCHYARD_NODE`, `SWITCHYARD_CAPFILE`.
9. Real-agent runs happen only in the OWNER CHECK steps, inside `~/.switchyard/scratch/...`, typed by the owner or triggered by the owner clicking in the UI. Keep their count minimal to save quota.

## 2. Verified facts (from official docs, checked Oct 2026). Treat as ground truth; if the installed binary disagrees, the binary wins: log it in `DECISIONS.md` and adapt.

### 2.1 Claude Code (installed `claude` ≥ 2.1.296)
Docs: https://code.claude.com/docs/en/hooks.md · /permissions.md · /headless.md · /cross-session-messaging.md · /agent-view.md · /mcp.md

- **Hook events used**: `SessionStart` (matcher `startup|resume|clear|compact|fork`), `UserPromptSubmit` (also fires when a scheduled task, a background subagent report, or a cross-session message starts a turn; default hook timeout 30 s), `PreToolUse`, `PermissionRequest`, `PostToolUse`, `Notification`, `Stop`, `StopFailure`, `SessionEnd` (shared 1.5 s budget).
- **Common hook input**: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name` (+ `prompt_id`, `agent_id`/`agent_type` inside subagents: ignore events that carry `agent_id` when computing node status). Hooks inherit Claude Code's env, so a command hook sees `SWITCHYARD_NODE`.
- **Notification** matcher values: `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`, `elicitation_url_dialog`, `elicitation_complete`, `elicitation_response`, `agent_needs_input`, `agent_completed`, `quota_auto_resume_*`. Notification hooks have **no decision control**.
- **PermissionRequest**: fires when a tool call needs a permission decision; matcher = tool name. Allow/deny via `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` or `"deny"` (optional `updatedInput`). Exit code 2 is **not** honored. Default timeout 600 s; on timeout the hook renders no decision and the normal terminal prompt proceeds (safe). Read the full input schema from the hooks page section `#permissionrequest` before coding (expect `tool_name`, `tool_input`).
- **Stop**: input includes `last_assistant_message`. Output `{"decision":"block","reason":"..."}` keeps Claude working with `reason` as feedback; or `{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"..."}}` for non-blocking context. Guard against loops: if the input has `stop_hook_active: true`, never block again; also cap at 3 consecutive blocks per node per turn.
- **HTTP hooks**: `{"type":"http","url":"http://127.0.0.1:4777/...","timeout":N}`; body = hook JSON; 2xx JSON body = decision; non-2xx/connection error = non-blocking. Allowed unless `allowedHttpHookUrls` is set somewhere: detect a failed delivery and fall back to the `hook.js` command relay.
- **Permissions**: `mcp__switchyard` (or `mcp__switchyard__*`) allows every tool of the `switchyard` server. Rules may be passed in `--settings '{"permissions":{"allow":[...]}}'` or `--allowedTools`. Deny beats allow at every scope. Modes: `default`(Manual), `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`.
- **Workspace trust**: an interactive `claude` started in a folder the owner never trusted shows a **trust dialog first**. Every new run dir under `~/.switchyard/scratch/` will hit this. `-p` runs never show it. Switchyard must surface the trust dialog as `needs_input` ("Accept the trust prompt in this node") and must **not** edit `~/.claude.json` to pre-trust.
- **Headless**: `claude -p "<prompt>" --output-format stream-json --verbose --include-partial-messages`; first event `{"type":"system","subtype":"init",...,"session_id","mcp_servers":[{name,status}]}`; last `{"type":"result",...,"session_id","total_cost_usd","usage","permission_denials"}`. `--resume <id>`, `--json-schema '<schema>'` → `structured_output`. **`--permission-prompts none`** (≥2.1.259): anything that would prompt is denied unless a PermissionRequest hook allows it, and Claude is told not to retry; denials appear as `permission_denied` system messages and in `result.permission_denials`. Do **not** use `--bare` (it ignores the subscription login).
- **Cross-session inbox**: every non-bare session binds a Unix socket; path exported to hooks/Bash as `CLAUDE_CODE_MESSAGING_SOCKET`, token as `CLAUDE_CODE_MESSAGING_TOKEN`; `/status` shows `Peer address`. A delivered message is read between tool calls when busy and **starts a new turn when idle**; a prompting-mode session accepts messages by default; Claude treats them as information from another session, never as approval. The wire format for an external sender is **not documented** → experiment only (F4).
- **Background sessions** (research only, F11): `claude --bg --name N "<prompt>"`, `claude agents --json --all` → `state` `working|blocked|done|failed|stopped`, `status` `busy|waiting|idle`, `waitingFor`; `claude attach <id>`; `--mcp-config`/`--settings` carry over.

### 2.2 Antigravity CLI `agy` (Google's replacement for Gemini CLI for consumer accounts since 2026-06-18)
Docs: https://antigravity.google/docs/cli/headless/ · /docs/hooks/ · /docs/mcp/ · /docs/cli/conversations/ · /docs/cli/install/ · /docs/permissions/

- Install: `curl -fsSL https://antigravity.google/cli/install.sh | bash` → `~/.local/bin/agy`. Sign in once interactively (`agy`); headless reuses the cached login and exits with `authentication required` if not signed in.
- **Headless**: `agy -p "<prompt>" --output-format text|json|stream-json`. JSON envelope: `conversation_id, status (SUCCESS|ERROR|CANCELED|INTERRUPTED|INVALID|WAITING|RUNNING), response, error?, duration_seconds, num_turns, structured_output?, usage{input_tokens,output_tokens,thinking_tokens,cache_read_tokens,total_tokens}`. stream-json: one `init` (`conversation_id`, `init.cwd`, `init.tools`, `init.permission_mode`), many `step_update` (`step_index`, `state` ACTIVE|DONE, `step_type` user_input|agent_response|tool|checkpoint, `text_delta`, `tool_name`, `tool_info{name,parameters,output,error}`, `usage`), one `result` per turn. `--json-schema`, `--model <slug>` (`agy models`), `--effort low|medium|high`, `--continue/-c`, `--conversation <id>`, `--print-timeout 5m` default, `--sandbox`. Unknown `--model` = exit 1, no fallback.
- **Persistent session**: `agy --input-format stream-json --output-format stream-json`; stdin lines `{"event":"user","message":{"content":"..."}}`; wait for the turn's `result` before sending the next; close stdin to end; never send slash commands (session ends with ERROR); `-p` prompt is ignored in this mode.
- **Headless permissions**: workspace file read/write auto-allowed; shell commands soft-denied (run continues, notice on stderr) unless allowed in `~/.gemini/antigravity-cli/settings.json` → `{"permissions":{"allow":["command(git)","command(regex:npm run (build|lint|test))","write_file(src/)"]}}`.
- **MCP**: global `~/.gemini/config/mcp_config.json`, workspace `.agents/mcp_config.json`; `{"mcpServers":{"switchyard":{"command":"node","args":["<abs>/packages/bus-mcp/dist/index.js"],"env":{...},"cwd":"...","disabled":false}}}`; remote servers use `serverUrl`. **MCP tools default to Ask**; allow with `mcp(switchyard/*)` in `permissions.allow`. `$VAR` expansion in `env` and env inheritance into MCP children are **undocumented** (test in F1).
- **Hooks**: `~/.gemini/config/hooks.json` (global), `.agents/hooks.json` (workspace), or inside `~/.gemini/antigravity-cli/settings.json`. Shape:
  ```json
  {"switchyard":{"enabled":true,
    "PreToolUse":[{"matcher":"ask_permission|ask_question","hooks":[{"type":"command","command":"node /abs/hook-agy.js PreToolUse","timeout":300}]}],
    "PreInvocation":[{"type":"command","command":"node /abs/hook-agy.js PreInvocation","timeout":10}],
    "Stop":[{"type":"command","command":"node /abs/hook-agy.js Stop","timeout":10}]}}
  ```
  Only `type:"command"`; default timeout **30 s**. stdin is camelCase JSON with `conversationId`, `workspacePaths`, `transcriptPath`, `artifactDirectoryPath`, `modelName` + per event: PreToolUse `toolCall{name,args}`, `stepIdx`; PreInvocation `invocationNum`, `initialNumSteps`; Stop `executionNum`, `terminationReason`, `error`, `fullyIdle` (bool). Outputs: PreToolUse `{"decision":"allow|deny|ask|force_ask|deny_unless_prior_grant","reason":"...","permissionOverrides":[...]}`; PreInvocation `{"injectSteps":[{"ephemeralMessage":"..."}]}`; Stop `{"decision":"continue","reason":"..."}` re-enters the loop. Relevant tool names: `ask_permission`, `ask_question`, `run_command`, `write_to_file`, `send_message`.
- **Conversations**: no CLI list command; `/resume` is a TUI picker scoped to cwd; transcripts at `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl` (read-only for us).

### 2.3 Tailscale Serve
Serve (tailnet-only) proxies to loopback and adds `x-forwarded-for`, `x-forwarded-proto`, `x-forwarded-host`, plus identity header `tailscale-user-login`; verify with `tailscale whois --json <x-forwarded-for ip>`. Funnel (public) adds **no** identity headers → refuse. Origin becomes `https://<machine>.<tailnet>.ts.net` (WS = `wss://`).

## 3. Working method (how you operate)

1. First action every session: read `PROGRESS.md`. Find the first unticked `F*` item. Continue there.
2. One F-phase at a time: implement → write/adjust tests → run `npm run lint && npm test && npm run test:e2e && npm run test:ui` → all green → `git commit -m "F<n>: <summary>"` → tick it in PROGRESS.md with a 3-line "what changed / how to try it".
3. Before editing a harness adapter, re-read the doc pages listed in §2 for that harness with WebFetch and run `claude --help` / `agy --help`. If reality differs from §2, write one line in `DECISIONS.md` (`date | claim | reality | what I did`).
4. **OWNER CHECK protocol**: when a step needs the owner (sign-in, clicking in the UI, typing into a real agent), stop and print a block titled `OWNER CHECK F<n>` with: numbered steps, the exact text to type, what success looks like, and what to paste back. Also append it to PROGRESS.md under "Owner to-do". Then wait.
5. If blocked for more than ~20 minutes on one problem, write it up in PROGRESS.md ("Blocked: …, tried …, next idea …"), skip to the next independent F-phase, come back later.
6. Keep deps minimal; any new dependency gets a one-line reason in the commit message.
7. Never weaken a test to make it pass. If a test was wrong, say why in the commit.

## 4. Phases (in order). Each has Do / Files / Tests / Done-when.

### F0 — macOS bring-up
**Do:** `node -v` (need 22+; if not, tell the owner `brew install node@22`). `npm ci || npm install`. If `node-pty` or `better-sqlite3` fail: ensure Xcode CLT (`xcode-select -p`; if missing → OWNER CHECK `xcode-select --install`), then `npm rebuild node-pty better-sqlite3`; record the fix in README "macOS notes". Run all four suites. Detect CLIs: `claude --version`, `which agy && agy --version`.
**OWNER CHECK F0** (only if agy missing or not signed in): run `curl -fsSL https://antigravity.google/cli/install.sh | bash`, open a new terminal, run `agy`, sign in with his Google account, `/quit`. Then run `agy -p "reply with the single word pong" --output-format json` and paste the output. Also run `claude` once if it asks to sign in.
**Done-when:** all suites green on macOS arm64; versions recorded in PROGRESS.md; `agy -p` returned `status: SUCCESS`.

### F1 — agy environment-inheritance probe (decides the identity design)
**Do:** write `scripts/probe-agy-env.mjs` that creates a temp dir with `.agents/hooks.json` (PreInvocation hook writes `process.env.SWITCHYARD_PROBE` to `<tmp>/hook-env.txt`) and `.agents/mcp_config.json` (a tiny stdio MCP server that writes its env var to `<tmp>/mcp-env.txt` and exposes one no-op tool), plus `permissions.allow` is NOT changed. It then runs, with `SWITCHYARD_PROBE=yes` in the env: `agy -p "Call the probe tool once, then reply done." --output-format json --print-timeout 2m` from that dir.
**OWNER CHECK F1:** run `node scripts/probe-agy-env.mjs` and paste its summary (it prints whether hook env and MCP env saw the variable, and whether the MCP tool call was asked/denied/allowed). This costs one small agy request.
**Then:** if both inherit → node identity = `SWITCHYARD_NODE` env for hooks and bus-mcp; per-cwd file becomes fallback only. If not → keep per-cwd identity file, enforce "one agy node per folder" in the UI with a clear error. Record result in DECISIONS.md.
**Done-when:** decision recorded; unit test covers whichever identity path is primary.

### F2 — Blast radius: run dirs out of the repo
**Do:** default run/scratch root = `~/.switchyard/scratch/<yyyymmdd-hhmm>-<slug>/`; on creation `git init -q && git commit --allow-empty -qm init` so evidence diffs are real. Keep `./scratch` only for tests (via env `SWITCHYARD_SCRATCH_ROOT`). Guard: refuse to create an agent node or run whose cwd resolves (realpath) inside the Switchyard repo or inside `~/.switchyard` (except `scratch/`), unless the owner ticks "I understand this is the app's own folder".
**Files:** `packages/core/src/runs/engine.ts`, workspace/node creation in core, web new-node dialog.
**Tests:** unit for the guard (symlink case too); e2e mock run asserts non-empty `git diff --stat` in the result card.
**Done-when:** green; result card shows real evidence for the mock run.

### F3 — Permissions so bus tools don't prompt
**Do:**
- Claude nodes: merge into the injected `--settings` JSON `{"permissions":{"allow":["mcp__switchyard"]}}`. Do not add any other allow rules by default.
- Driven Claude (runs/chat): `--permission-mode acceptEdits --permission-prompts none` + the editable allow-list; parse `result.permission_denials` and `permission_denied` events; show them on the step and result card ("unverified: `pytest` was denied").
- agy: extend the existing opt-in "Connect Antigravity" button to also add `"mcp(switchyard/*)"` to `permissions.allow` in `~/.gemini/antigravity-cli/settings.json`. Second opt-in per run dir: "Let agents run tests here" → adds `write_file(<run dir>/)` and `command(regex:(pytest|python -m pytest|npm (test|run (build|lint|test))))` scoped by documented syntax; verify the syntax against /docs/permissions/ first.
- Settings → Agents panel: per harness, green/red checks "installed", "signed in" (from F0 probe), "bus tools allowed", "status hooks installed".
**Tests:** settings-merge unit tests (keeps foreign keys, idempotent, refuses invalid JSON, writes .bak, remove button reverts exactly); adapter flag tests (no bypass flags without YOLO; `--permission-prompts none` present in driven mode).
**Done-when:** green.

### F4 — Message delivery without blind PTY typing
**Do:**
1. Every Claude node's `--settings` gets a **Stop** HTTP hook → `POST http://127.0.0.1:4777/bus/hook/claude/<nodeId>/<hookSecret>`. Core logic: if `stop_hook_active` → `{}`; else if undelivered `request`s for this node → `{"decision":"block","reason":"You have N new switchyard messages (M requests). Call check_inbox, handle them, then stop."}` (max 3 consecutive blocks); else if only `notify`s → `{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"N switchyard notifications are waiting in check_inbox."}}`; else `{}`. Store `last_assistant_message` as the node's summary.
2. agy (when the opt-in hooks are installed): `PreInvocation` → if backlog `{"injectSteps":[{"ephemeralMessage":"N new switchyard messages are waiting; call check_inbox."}]}`; `Stop` with `fullyIdle:true` and pending requests → `{"decision":"continue","reason":"Check your switchyard inbox and answer the pending request, then stop."}` (same 3-block cap keyed by conversationId).
3. **Idle Claude delivery experiment (30-minute timebox, then stop):** a `SessionStart` command hook records `$CLAUDE_CODE_MESSAGING_SOCKET` for the node. Write `scripts/probe-claude-inbox.mjs` that connects to that socket, optionally sends `{"type":"auth","token":"..."}` from the node's recorded token, then tries candidate one-line JSON messages; observe with the owner's `/status` and transcript. **OWNER CHECK F4:** open one Claude node in a scratch dir, run the probe, report whether a message appeared. If a format works, use it for idle delivery (it starts a turn; Claude treats it as information) and document it. If none works, record "undocumented; not used" and move on.
4. **PTY nudge = last resort**: default **off** for Claude nodes; for others fire only when the last *authoritative* event is idle (Claude `Stop` with no later `Notification(permission_prompt|elicitation_*)`/`PermissionRequest`; agy `Stop fullyIdle:true`), never on the quiet heuristic, never while a needs_input item is open; record delivery state `uncertain`.
5. **Safe human replies into a PTY**: wrap multi-line text in bracketed paste `\x1b[200~…\x1b[201~` then `\r`; if a single-line reply starts with `/` or `!`, prefix `Reply: `; strip control chars except `\t`; never send anything while the node is in a permission/elicitation/trust prompt except through the explicit Allow/Deny/Accept buttons.
**Files:** `packages/core/src/harness/claude.ts`, `agy.ts`, `packages/core/src/bus/service.ts`, `packages/core/src/status/monitor.ts`, `packages/bus-mcp/hook.js` (+ new `hook-agy.js`), core routes.
**Tests:** unit tests for the Stop/PreInvocation decision tables (incl. loop cap, stop_hook_active), hook-secret rejection, PTY escaping; e2e: mock agent receives a request via the Stop path with zero PTY writes.
**Done-when:** green; nudge counter in e2e stays 0.

### F5 — Authoritative status + Allow/Deny from the sidebar (keep regexes only as fallback)
**Do:**
- Claude per-node `--settings` hooks (HTTP; 10 s timeout except PermissionRequest 600 s): `SessionStart`→idle (and record socket/token if present); `UserPromptSubmit`→working; `PreToolUse`→working; `Stop`→idle; `StopFailure`→error badge with the error type; `Notification` matcher `permission_prompt|elicitation_dialog|elicitation_url_dialog|idle_prompt|agent_needs_input`→needs_input; `SessionEnd`→exited; ignore events carrying `agent_id`. Trust dialog: before the first `SessionStart` hook arrives, if the PTY shows the trust prompt, mark needs_input with text "Accept the folder trust prompt in this node" and an **Accept** button that sends the documented key for "Yes" (verify by reading the screen once; record in DECISIONS.md).
- **PermissionRequest** → sidebar item showing node, tool name, and a readable summary of `tool_input` (for Bash show the command) with **Allow once / Deny** buttons; the HTTP hook request stays open until the owner clicks, then returns the decision; if the owner doesn't click within 590 s, return `{}` so the normal terminal prompt takes over. Never auto-allow.
- agy (opt-in global hook named `switchyard` per §2.2; keep timeouts explicit): `PreInvocation`→working; `Stop`→idle if `fullyIdle` else working; `PreToolUse` matching `ask_permission|ask_question`→needs_input + sidebar item with Allow/Deny/Ask-in-terminal; return `ask` by default, `allow`/`deny` on click, `ask` on timeout (290 s).
- Map agy hook → node via F1 result (env), else `conversationId`→node table, else `workspacePaths[0]`.
- `/api/attention` includes the new item types. xbar plugin unchanged except new types.
**Files:** `status/monitor.ts`, `harness/claude.ts`, `harness/agy.ts`, core routes, web sidebar.
**Tests:** mock agent emits the same hook payloads; UI check: PermissionRequest item appears ≤1 s, clicking Allow returns the allow JSON to the hook, Deny returns deny, timeout returns `{}`.
**Done-when:** green.

### F6 — Identity & capability hygiene
**Do:** rotate node capability and hook secret on every (re)spawn; invalidate on exit; bus rejects stale/foreign capabilities and wrong secrets (same error for unknown vs unauthorized). Per-node hook URL includes the secret. bus-mcp reads its capability from the `0600` file named in `SWITCHYARD_CAPFILE` (not from env content).
**Tests:** rotation, stale-cap rejection, wrong-secret rejection, cross-node spoof attempt.
**Done-when:** green.

### F7 — Sessions: real agy list + Claude resume polish
**Do:** list agy conversations by scanning `~/.gemini/antigravity-cli/brain/*/.system_generated/logs/transcript.jsonl` read-only (title = first user text ≤80 chars, mtime, workspace from transcript if present); resume = new node running `agy --conversation <id>` in that workspace. Remove the `agy --help` probing/guessing. Claude list unchanged (`~/.claude/projects/**/*.jsonl`, resume `claude --resume <id>`).
**Tests:** fixture-based parser tests for both; tolerate malformed lines.
**Done-when:** green.

### F8 — Persistent agy driven sessions
**Do:** agent-chat nodes and run steps assigned to agy use one long-lived `agy --input-format stream-json --output-format stream-json` process per node; queue prompts; send next only after `result`; restart on crash with `--conversation <last id>`; close stdin on node close. Per-turn `-p --conversation` stays as fallback (toggle in Settings).
**Tests:** mock harness implements the same NDJSON protocol; two-turn round trip; crash-restart.
**Done-when:** green.

### F9 — Usage meter
**Do:** record per turn: Claude `result.total_cost_usd` + `usage`; agy `result.usage`. Show tokens (and $ for Claude) on node cards, run step rows, and the result card totals. Store in SQLite.
**Tests:** mock run totals match the sum of mock turn usages in the UI check.
**Done-when:** green.

### F10 — Remote access hardening (Tailscale Serve)
**Do:** a request is "remote" iff it arrives from loopback **with** `x-forwarded-for`. Remote requests must carry `tailscale-user-login` equal to the owner login saved at first remote setup, and core confirms with `tailscale whois --json <ip>` (cache 60 s); forwarded headers without identity (Funnel) → 403. Accept `https://*.ts.net` as WS origin only for verified remote requests. Keep the bearer token too. Remote stays read-only except answering questions, Allow/Deny, and replies.
**Tests:** synthetic-header unit tests (serve ok, funnel refused, spoofed login refused, whois mismatch refused).
**OWNER CHECK F10 (optional, last):** `brew install tailscale` or the App Store app, sign in, `tailscale serve --bg 4777`, open the printed `https://…ts.net` URL on the phone (same tailnet), answer a pending question. Report result.
**Done-when:** tests green; owner check done or explicitly skipped.

### F11 — Research spike: Claude nodes as background sessions (≤1 hour, no adoption)
Try `claude --bg --name sy-test --mcp-config … --settings …` in a scratch dir, `claude agents --json --all`, `claude attach <id>` inside a node PTY. Write findings (benefits, costs, worktree moves, supervisor behavior) to PROGRESS.md. Uses ≤2 tiny Claude turns; ask OWNER CHECK first.

### F12 — Polish (only after F0–F10 are green)
Code-split the web bundle (route-level `import()`; target main chunk < 400 kB); Vite dev server with HMR proxied to core for `npm run dev`; macOS notifications from core via `osascript -e 'display notification "…" with title "Switchyard"'` for new needs_input items (local only, toggle in Settings); optional Moirai import (`@october-dev/moirai`, Apache-2.0) behind a flag.

## 5. Real-agent acceptance (do after F0–F9; each is an OWNER CHECK, one at a time)

Use a fresh scratch workspace each time. Print the steps exactly like this to the owner and wait for results.

**A1 — Two real agents talk.** UI: New workspace → scratch. Add "Claude Code" node and "Antigravity" node, draw an edge between them. In the Claude node, first accept the trust prompt (sidebar button). Type into Claude: `List your switchyard peers. Send the Antigravity peer a request asking for the single word pong, then wait for the reply and tell me what it said.` Then type into the agy node: `Check your switchyard inbox and answer the request.` **Pass:** Claude reports "pong"; bus log shows request + correlated response; no permission prompts for `switchyard` tools; status chips cycled working→idle on both.

**A2 — Delivery without typing.** Same nodes. Into Claude: `Send the Antigravity peer a notify message saying hello, then stop.` Then into agy: `Do nothing else; just wait.` Next into agy: `Send the Claude peer a request asking what 2+2 is.` **Pass:** Claude answers the request on its next turn end via the Stop-hook path (or immediately via the inbox socket if F4 found a format), with zero PTY nudges in the log.

**A3 — Permission from the sidebar.** Into Claude: `Run the shell command: echo switchyard-ok > ok.txt`. **Pass:** a PermissionRequest item appears in the sidebar within 2 s; clicking Allow runs it; repeat with Deny and confirm Claude reports the denial.

**A4 — ask_user.** Into Claude: `Use the switchyard ask_user tool to ask me which color to use, then tell me my answer.` **Pass:** question appears in Needs you ≤2 s; answer reaches Claude.

**A5 — Real run.** Runs → goal `Create hello.py with a function reverse(s) that reverses a string, plus pytest tests; have the other agent review.` Where = new scratch, Planner = Claude, Builder = Claude, Reviewer = Antigravity. (If agy can't run pytest, approve the F3 "Let agents run tests here" button first.) **Pass:** plan card → approve → result card with files touched, `git diff --stat`, pytest output (or an honest "unverified" with the denial named), usage totals.

**A6 — Resume.** Import sessions → pick a real past Claude Code session → Resume here; pick an agy conversation → Resume. **Pass:** both open with history.

Log each result (pass/fail + notes) in PROGRESS.md under "Acceptance". On a fail: diagnose from logs, fix, add a regression test with the mock, re-run only the failed check.

## 6. Test inventory you must leave behind
- Unit: bus semantics (existing) + F3 settings merge + F4 decision tables + F5 hook payload mapping + F6 capability rotation + F7 parsers + F10 remote auth.
- e2e (`npm run test:e2e`): existing two scenarios + Stop-path delivery (F4) + persistent NDJSON session (F8) + usage totals (F9).
- UI (`npm run test:ui`): existing 26 + PermissionRequest Allow/Deny/timeout + trust-prompt item + usage on result card.
- `npm run test:all` runs lint + all three; must pass on macOS before every commit.

## 7. Documents you must update
- `PROGRESS.md`: F-phase checklist, Owner to-do, Acceptance results, Blocked items.
- `DECISIONS.md`: every doc-vs-binary discrepancy and every design decision from F1/F4/F11.
- `README.md`: macOS install, first run (`npm start`, token), connecting agy (opt-in buttons explained), what each Settings toggle writes and where, how to undo.
- `REPORT.md` (rewrite at the end): what works with real agents, what is still mocked/unverified, known limits (no live claude.ai/Gemini web chat linking, no cloud/multiplayer, agy one-node-per-folder if F1 failed), exact daily-use instructions.

## 8. Definition of done
1. F0–F10 ticked (F11/F12 optional), all suites green on the owner's Mac.
2. A1–A6 passed or each failure documented with cause and next step.
3. `REPORT.md` rewritten; final message to the owner = 10 lines max: what works, how to start it tomorrow (`cd switchyard && npm start`, open http://127.0.0.1:4777), and the top 3 known limitations.
