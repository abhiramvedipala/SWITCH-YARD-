# Switchyard — Progress

`APP_NAME = "Switchyard"`. This file is the resume point: a new session should
continue from the first unchecked item.

## Environment note

Built inside a **cloud Linux x86_64 container** (a Claude Code remote session
tied to `github.com/abhiramvedipala/repo-15`), not the owner's Mac. Agreed up
front with the owner:

- Build everything that doesn't need the owner's machine, subscriptions or
  macOS-only APIs, and commit it.
- Write up the real-agent checks and the Mac/Tailscale steps as **owner
  to-do** items with exact commands.
- `agy` isn't installed here and can't sign in here. `claude` is present (it's
  what's running this session), but per working rule #9 no automated test calls
  it. Only `claude --help` was used, to confirm flags.
- Native modules were built for Linux for development. `npm install` on the Mac
  rebuilds them. No binaries are committed.

Later the owner asked for one uninterrupted build to the end instead of stopping
per phase, so Phases 1–8 landed together in one commit after Phase 0. Each
phase's DoD was still checked, as listed below.

## Phases

- [x] **Phase 0:** Scaffold
- [x] **Phase 1:** Terminals
- [x] **Phase 2:** Canvas + workspaces + Focus mode + Board skeleton
- [x] **Phase 3:** Agent nodes + message system (automated DoD ✅; real-agent manual DoD → owner to-do)
- [x] **Phase 4:** Status + attention (automated DoD ✅ with mock; real Claude check → owner to-do)
- [x] **Phase 5:** Board
- [x] **Phase 6:** Driven mode, Project Chat, Runs (mock DoD ✅; real run → owner to-do)
- [x] **Phase 7:** Sessions (listing/import ✅; resuming a real session → owner to-do)
- [x] **Phase 8:** Phone access + hardening (code ✅; phone over Tailscale → owner to-do)
- [~] **Phase 9:** Extras. Done: git-worktree button, push-to-talk (Web Speech API), `/api/attention` + xbar menu-bar plugin. Not done: Electron/Tauri shell, Codex adapter, October-Bus-compatible adapter (optional; see REPORT.md).

## How each DoD was verified

| Phase | Check                                                                           | How                                                                                                                                                                                        |
| ----- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0     | login page → empty canvas after token                                           | `scripts/ui-check.mjs` (headless Chromium) + curl walkthrough; socket confirmed bound to 127.0.0.1                                                                                         |
| 1     | run a command, reload, output still there                                       | ui-check: types `echo hello-$((40+2))-switchyard` into xterm, reloads, finds `hello-42-switchyard`                                                                                         |
| 2     | 3 nodes + 2 edges, reload → identical                                           | ui-check: nodes added via the UI menu, edges via the API; after reload counts, positions and note text match. Also checks `F`/`Esc` focus and the `Ctrl+K` palette                         |
| 3     | A request → B inbox → B response → A wait_for_reply; unconnected C sees nothing | `npm run test:e2e` / vitest: real core HTTP server + three real `bus-mcp` processes over MCP stdio. Also in the browser with two mock terminal agents                                      |
| 4     | ask_user shows in Needs you ≤ 2 s and can be answered                           | ui-check: appears ~100 ms after the mock asks; the sidebar answer reaches the agent's terminal                                                                                             |
| 5     | UI task → claim → In progress → complete → Done                                 | ui-check: card moves columns as the mock agent claims and completes it                                                                                                                     |
| 6     | demo run in scratch with one review round changing something                    | e2e + ui-check: mock plan → build → review requests a docstring and type hints → builder fixes → approved in round 2; result card shows `python3 -m pytest -q → passed`                    |
| 7     | resume a real Claude Code session                                               | listing verified with a fixture transcript in ui-check; resuming needs real `claude` → owner to-do                                                                                         |
| 8     | answer ask_user from a phone over Tailscale                                     | ui-check: 390×844 mobile context with forwarded headers gets the read-only phone layout, writes return 403, answering works, login hits 429 after 8 attempts. Real Tailscale → owner to-do |

Unit tests (33) cover message semantics (edge scoping, durability across DB
reopen, request/response correlation, expiry, claim atomicity, dependencies,
ask_user, wait_for_nodes, messages to and from the human), adapter launch flags
and YOLO gating, stream parsers for both CLIs, agy config editing (keeps other
entries, refuses to overwrite unparseable JSON), session/export parsers, and the
WebSocket origin and remote-detection rules.

## Owner to-do (exact steps)

### OWNER CHECK F0b — make the Google account eligible for Antigravity (blocks F1, A1, A2, A5, A6-agy)

1. Verify your age on the Google account you signed in to agy with (myaccount.google.com → Personal info → Birthday / age verification), or sign in to agy with a different eligible account: run `agy`, then `/logout` and sign in again.
2. `agy -p "reply with the single word pong" --output-format json` → success is `"status": "SUCCESS"`.
3. `node scripts/probe-agy-env.mjs` → paste the summary block.

### OWNER CHECK F0 — install and sign in to Antigravity (`agy` is not on this Mac)

1. In Terminal: `curl -fsSL https://antigravity.google/cli/install.sh | bash`
2. Open a **new** terminal window (so `~/.local/bin` is on PATH), run `agy`, sign in with your Google account in the browser, then `/quit`.
3. Run: `agy -p "reply with the single word pong" --output-format json`
   Success looks like a JSON object with `"status": "SUCCESS"` and `"response": "pong"`.
4. Paste back: the output of `agy --version` and that JSON.

### OWNER CHECK F10 (optional, last) — phone over Tailscale

1. Install Tailscale (`brew install tailscale` or the App Store app) and sign in on the Mac and the phone.
2. `tailscale serve --bg 4777`, open the printed `https://<mac>.<tailnet>.ts.net` URL on the phone, log in with the token, answer a pending question.
3. Success looks like: the phone layout loads, Settings on the Mac shows "Phone access is pinned to <your login>". A second tailnet account gets 403 until you press **Forget** on the Mac.
4. Paste back: whether the page loaded, whether the pin appeared, and one line from `~/.switchyard/server.log` if anything was refused.

### OWNER CHECK F1 — agy env-inheritance probe (one small agy request)

1. From the repo folder: `node scripts/probe-agy-env.mjs`
   It builds a temp folder with workspace-level `.agents/hooks.json` and `.agents/mcp_config.json`, runs one `agy -p` there, and deletes the folder. Your global agy config is not touched.
2. Paste back the block between `=== F1 PROBE SUMMARY ===` and `=====`.
   Success looks like `hookRan: true`, `mcpStarted: true`, `toolCalled: true`, and each env line saying `inherited ✅`, `literal "$…"` or `unset`.
   If the tool call was blocked by a permission prompt, `toolCalled` is false; say so, that is also a result.

Setup on the Mac:

```bash
git clone https://github.com/abhiramvedipala/repo-15 switchyard && cd switchyard
xcode-select --install        # if not already installed (native modules)
npm install
claude                        # sign in once, then /exit
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy                           # browser sign-in once, then exit
npm start                     # note the token it prints
```

- [ ] **Phase 3 manual DoD (real agents).** Open http://127.0.0.1:4777 and log
      in. New workspace → a throwaway folder (`mkdir ~/sy-play`). Add a
      **Claude Code agent** and an **Antigravity agent**, then drag a
      connection between them. In the Claude terminal type:
      `list your switchyard peers and ask the agy peer for the word 'pong', then wait for the reply`.
      Approve the MCP tool prompts. In the agy terminal, if the nudge didn't
      already trigger it, type: `check your switchyard inbox and reply to the request`.
      Confirm Claude prints "pong". If agy shows no `switchyard` tools, check
      Settings → Antigravity → MCP entry is "present", then restart the agy node.
- [ ] **Phase 4 manual check.** In a Claude node type:
      `use the switchyard ask_user tool to ask me which color to use`. It should
      show in **Needs you** within 2 s; answer it there. Then type
      `create a file named test.txt`. The permission prompt should turn the node
      amber and show in Needs you with 1/2/3 key buttons.
- [ ] **Phase 6 manual DoD (real run).** Runs → goal
      `Create hello.py with a function that reverses a string and pytest tests; have the other agent review`,
      Where = scratch, Planner = Claude, Builder = Claude, Reviewer = Antigravity
      → Plan run → Approve & start. Expect a result card. For the "Tests" line
      to show results instead of "unverified", install pytest with
      `python3 -m pip install pytest`.
- [ ] **Phase 7 manual DoD.** Import sessions → Claude Code sessions → pick a
      past session → **Resume here**.
- [ ] **Phase 8 manual DoD.** `tailscale serve --bg 4777`. On the phone, on the
      same tailnet, open `https://<mac>.<tailnet>.ts.net`, log in, and answer an
      `ask_user` question from the Needs you tab.
- [ ] Optional: copy `extras/xbar/switchyard.10s.sh` into xbar/SwiftBar for a
      menu-bar "needs you" count. It needs `jq`.
- [ ] Optional: agy shell permissions in headless runs are soft-denied unless
      allowed in `~/.gemini/antigravity-cli/settings.json`, which Switchyard
      won't edit without your OK. Example:
      `{"permissions":{"allow":["command(git)","command(regex:python3 -m pytest.*)"]}}`

## Rooms: one conversation, several AIs (in flight 2026-10-14)

Owner's ask: combine Claude / ChatGPT / other AI chats so they join one conversation, work at the same time and take instructions. Decisions are in DECISIONS.md (2026-10-14). Four parallel streams:

- [x] **Rooms core** (2026-10-14) — `rooms` / `room_participants` / `room_messages`; orchestration (`all` / `mention` / `round`, a human @mention narrows any mode, participant-to-participant @mentions chain at most 2 replies, Stop, unseen-lines-only prompts, sessions resumed per participant, usage per room and participant); seeding from an imported Claude.ai / ChatGPT export or Claude Code session (20k-char cap); bus tools `list_rooms` / `read_room` / `post_to_room` scoped to the workspace (17 tools); phone can read and post only; Rooms view with streaming and @mention autocomplete. 19 vitest, e2e rooms scenario, 8 ui-checks in Chromium and WebKit. **Not tried with real participants** → OWNER CHECK R1 below.
- [x] **`codex` harness** (2026-10-14) — ChatGPT through OpenAI's Codex CLI: `codex exec --json` driven turns (`--sandbox workspace-write`, `approval_policy=never`, bypass only with YOLO), resume by thread id, bus MCP attached per process via `--config mcp_servers.switchyard.*` (nothing written to `~/.codex`), detection via `codex --version` + `codex login status` exit code. Listed in + Add, Settings and every harness picker. Fake-binary tests only (217 vitest, 43 ui-checks). **Codex is not installed yet** → OWNER CHECK CX below.
- [x] **API-key harnesses** (2026-10-14) — `api-anthropic` (Messages API), `api-openai` (Responses API, `store:false`), `api-gemini` (`streamGenerateContent` SSE): chat-only, no tools; keys as 0600 files in `~/.switchyard/keys/` with local-only routes that return only `{configured, last4}`; official hosts hard-coded, `redirect:'error'`; history in `api_history` (100 turns / ~400k chars per session, 200 sessions); Settings → API keys card, + Add entries, per-node model. Defaults `claude-opus-5-5`, `gpt-6-astra`, `gemini-3.8-flash` (checked against the docs 2026-10-14). 22 vitest against fake 127.0.0.1 servers, 3 ui-checks. **Not tried with a real key** → OWNER CHECK AK below.
- [x] **Claude Desktop connector** (2026-10-14) — config writer (present / absent / stale / invalid, `.bak` once, invalid JSON refused), fixed `claude-desktop` external canvas node with a 0600 run file rotated on Connect and core boot and revoked on Remove, bus-mcp `whoami`, Settings card. 208 vitest, e2e (14 tools), 43 ui-checks. **Not yet tried with a real Claude Desktop** (owner step below).

Not possible, by design: joining a _live_ claude.ai or chatgpt.com web chat. Neither has an API for that and automating the browser is against hard rule #1. Past chats join as imported context.

### Claude.app chats as individual nodes (2026-10-14)

**What changed:** over the one Claude Desktop connector, each chat names itself: `join_switchyard(name)` creates a `claude-desktop:<slug>` node (type `external`, 💬 badge, no capability or run file of its own); every bus and room tool takes `as:<name>`, honoured only when the verified caller is the base `claude-desktop` capability (anyone else gets the shared 401; base + unknown name → 404 "call join_switchyard first"); `leave_switchyard` marks it left, Delete removes it; connector Remove or a workspace move deletes chat nodes. A chat can't be woken, so Needs you shows `<name> chat has N unread — open that chat in Claude and say "check my switchyard inbox"` with no nudge. Server instructions tell the model to join first and pass `as:` afterwards. 19 bus tools.
**How to try it:** OWNER CHECK CD2 below. Tests: 5 vitest, e2e two-chat scenario with a real bus-mcp, 2 ui-checks (63 in Chromium and WebKit).
**Known and documented, not enforced:** any chat in the same Claude Desktop can claim any name (same user, same app, same trust boundary as the connector).
**Unverified:** whether a real Claude Desktop reliably calls `join_switchyard` on "Join Switchyard as X" and keeps passing `as:` later; its tool-call timeout vs the 55 s long polls.

### OWNER CHECK CD2 — an individual Claude.app chat on the canvas

1. OWNER CHECK CD first (Connect, restart Claude Desktop).
2. Open the chat you want (e.g. "GPA - classes management") and type: `Join Switchyard as GPA`. **Pass:** the chat reports it joined; a 💬 **GPA** node appears on the connected workspace's canvas.
3. Draw an edge from GPA to a Claude Code (or Mock) agent. In the agent, type: `Send the GPA peer a request asking which week we are on.`
4. **Pass:** Needs you shows "GPA chat has 1 unread — …". Back in the GPA chat type `check my switchyard inbox and answer it`; the agent receives the response.
5. Paste back what the chat said at steps 2 and 4, and whether Claude Desktop asked you to approve each tool call.

### Usage: Claude cost on resumed turns (2026-10-14)

**What changed:** Claude Code reports a session's running `total_cost_usd` on every resumed turn (docs: "summing results double-counts the restored spend"), and every driven turn resumes a session, so chat / run / room cost badges over-counted. `recordUsage` now bills the per-turn delta per session id (cursor = the session's last usage row; a lower total or a new session id bills the full figure), keeps the raw value in `usage.reported_cost_usd`, and migration 6 repairs existing rows (the owner's $8.45 room → $4.65; global Claude total $8.66 → $4.86). Token counts were already per turn. agy, codex and API harnesses report per turn and are unchanged.
**How to try it:** `npx vitest run packages/core/src/usage` (+4 tests: 0.10 / 0.25 / 0.30 → 0.10 / 0.15 / 0.05, session change, decreasing total, repair pass).
**Caveat:** rows from Claude Code < 2.1.277 were per-turn already and can't be told apart; `modelUsage` is cumulative too and is not recorded.

### Native app: floating Needs-you panel (2026-10-14)

**What changed:** `SwitchyardApp.swift` gained a floating NSPanel (View ▸ Needs You Panel, ⌥⌘N) and a menu-bar item (✓ nothing / ● N / ○ core unreachable). Rows come from `/api/attention` (long-poll while open, `/api/attention/summary` every 30 s while only the menu-bar item shows): answer a question, Allow / Deny / Ask a permission, Accept a trust prompt, Open an unread agent. ⌘W hides it. `make-app.sh` keeps the previous build at `~/.switchyard/Switchyard.app.bak`.
**How to try it:** `npm run mac:app && open ~/Applications/Switchyard.app`, then ⌥⌘N. `SWITCHYARD_MAC_LAUNCH=1 npm run mac:check` (20 checks; a mock question is answered through the panel's own handler via the test-only `SWITCHYARD_PANEL_SELFTEST=1`).
**Unverified by eye:** the panel's layout (no Screen Recording permission for screenshots); typing in the row's text field.

### OWNER CHECK R1 — a Room with two real AIs

1. Restart the app on the current build (`cd ~/switchyard && npm run stop && open ~/Applications/Switchyard.app`).
2. Top bar → **Rooms** → New room (in a scratch workspace) → add participant **Claude Code** (name it `Claude`) and one more: **Codex** (after OWNER CHECK CX), or **Claude API / OpenAI API / Gemini API chat** (after OWNER CHECK AK), or **Mock** just to see the flow.
3. Mode `all`, send: `Each of you: say hello in one line and tell me which model you are.`
4. Then: `@Claude ask the other participant what 2+2 is and report back.`
5. **Pass:** every participant answers the first message; only Claude answers the second, then the other participant answers its @mention, and the chain stops (at most 2 follow-ups). Stop halts a running answer.
6. Paste back the transcript and the usage badges.

### October parity (started 2026-10-14)

- [x] **Files block** — `files` node type: lazy tree of the workspace folder (hides `node_modules`, `.git`, `dist`, dotfiles toggle) next to a plain editor with line numbers, ⌘S, markdown preview, inline images; `/api/fs/{tree,read,stat,write,reveal}` with realpath-inside-root checks (symlink escapes 403), 409 on a stale mtime, 1 MB cap, local-only writes, own-folder confirmation carried on the node (`data.allowOwnFolder`); the open file is polled every 2 s. 13 vitest + 3 ui-checks (57 total).
- [x] **Other CLI agent** (2026-10-14) — `custom` harness with presets aider, goose, opencode, copilot (GitHub Copilot CLI), cursor (Cursor CLI `agent`) and `other` (any command): facts from each tool's official docs; bus tools attach per process only where documented (Goose `--with-extension`, OpenCode `OPENCODE_CONFIG_CONTENT`), Aider / Copilot / Cursor launch without them and Switchyard never edits their config; **no bypass flag is ever passed, `node.yolo` is ignored**; presets with a documented one-shot mode can be stateless chat nodes; kept out of rooms and runs (`perNodeConfig`); Settings → Agents shows preset install state. 9 vitest + 2 ui-checks. **Prompt patterns and every preset are unverified against the real tools** (none installed).
- [x] **Continue in…** (2026-10-14, October's Moirai idea, local) — `sessions/handoff.ts` turns a Claude Code session, an agy conversation or an exported chat into one transcript model and renders `HANDOFF-<slug>.md` (newest turns within 24k chars, tool calls one line each) into the target workspace folder; `POST /api/workspaces/:id/handoff` starts a terminal agent with "Read HANDOFF-<slug>.md first…" as its first prompt (claude positional prompt, agy `-i`, codex positional, mock `--prompt`) or a chat node with the document; refuses phone sessions and the app's own folder before writing. 14 vitest + 2 ui-checks. Mock verified end to end; **real agents unverified**.
- Out of scope by rule: cloud, teams/multiplayer, remote servers, Windows/Linux builds, Themes API.

## Acceptance (real agents; one OWNER CHECK at a time, fresh `~/.switchyard/scratch` workspace each)

Log pass/fail here. On a fail: diagnose from `~/.switchyard/server.log`, fix, add a mock regression test, re-run only that check.

| Check                          | Result  | Notes |
| ------------------------------ | ------- | ----- |
| A1 two real agents talk        | pending |       |
| A2 delivery without typing     | pending |       |
| A3 permission from the sidebar | pending |       |
| A4 ask_user                    | pending |       |
| A5 real run                    | pending |       |
| A6 resume                      | pending |       |

### OWNER CHECK AK — API-key chat (optional; costs tokens on your account)

1. Settings → **API keys** → paste one key (Claude, OpenAI or Gemini) → Save. The field clears; the badge shows `configured · …last4`.
2. - Add → the matching **… API chat**, send `reply with the single word pong`.
3. Paste back the reply or the error text (401/429 wording is what I want to confirm). Remove the key afterwards if you like; it only ever lives in `~/.switchyard/keys/`.

### OWNER CHECK CX — install Codex (ChatGPT) and sign in

```bash
npm install -g @openai/codex      # or: brew install --cask codex
codex login                        # browser: choose "Sign in with ChatGPT"
codex login status                 # should print the ChatGPT login and exit 0
```

Then Settings → **Re-check**: "Codex (ChatGPT)" shows installed. First real use: + Add → **Codex chat**, send `reply with the single word pong`. Paste back the reply and anything odd (an approval prompt, a `--config` error, a git-repo error).

### OWNER CHECK CD — connect a Claude Desktop chat

1. Start Switchyard from `~/switchyard` (the app). Settings → **Claude Desktop** → pick a workspace → **Connect**. The card should say "joined <workspace>" and "switchyard entry present".
2. On that canvas, drag an edge from the new **Claude Desktop** node to each agent it may talk to.
3. Quit Claude Desktop fully (⌘Q) and reopen it. In a new chat ask: `list my switchyard peers` → it should name the connected agents; `who am I on switchyard` → node `claude-desktop`.
4. Paste back what the chat answered, and whether Claude Desktop showed a tool-approval prompt. Undo: Settings → Remove, restart Claude Desktop.

### OWNER CHECK A1 — two real agents talk

1. `npm start` (or open Switchyard.app), log in. **New workspace** → pick **scratch** (a fresh folder under `~/.switchyard/scratch/`).
2. **+ Add → Claude Code agent**, then **+ Add → Antigravity agent**. Drag from the Claude node's edge dot to the agy node to connect them.
3. If **Needs you** shows "Accept the folder trust prompt in this node", click **Accept**.
4. Settings (⚙) → Antigravity: click **Connect Antigravity** (writes the `switchyard` MCP entry + `mcp(switchyard/*)` allow rule; a `.bak` is kept). If the agy node was already running, click its **Restart**.
5. Type into the Claude node:
   `List your switchyard peers. Send the Antigravity peer a request asking for the single word pong, then wait for the reply and tell me what it said.`
6. Type into the agy node: `Check your switchyard inbox and answer the request.`
7. **Pass looks like:** Claude prints "pong"; no permission prompt appeared for `switchyard` tools; both status chips cycled working → idle.
8. Paste back: Claude's last line, whether any prompt appeared, and the last 20 lines of `~/.switchyard/server.log`.

### OWNER CHECK A2 — delivery without typing

Same nodes. Into Claude: `Send the Antigravity peer a notify message saying hello, then stop.` Into agy: `Do nothing else; just wait.` Then into agy: `Send the Claude peer a request asking what 2+2 is.`
**Pass:** Claude answers on its next turn end via the Stop-hook path; Settings → Diagnostics (or `GET /api/attention`) shows nudge count 0. Paste back Claude's answer and `grep -c nudge ~/.switchyard/server.log`.

### OWNER CHECK A3 — permission from the sidebar

Into Claude: `Run the shell command: echo switchyard-ok > ok.txt`
**Pass:** a card with `Bash` and the command appears in Needs you within 2 s; **Allow once** runs it (`ok.txt` exists); repeat with **Deny** and Claude reports the denial. Paste back what you saw.

### OWNER CHECK A4 — ask_user

Into Claude: `Use the switchyard ask_user tool to ask me which color to use, then tell me my answer.`
**Pass:** question in Needs you within 2 s; your answer reaches Claude. Paste back Claude's reply.

### OWNER CHECK A5 — real run

Runs → goal `Create hello.py with a function reverse(s) that reverses a string, plus pytest tests; have the other agent review.` Where = new scratch, Planner = Claude, Builder = Claude, Reviewer = Antigravity. If agy may not run pytest, first click Settings → Antigravity → **Let agents run tests here**. Plan run → edit if you like → Approve & start.
**Pass:** result card with files touched, `git diff --stat`, pytest output (or an honest "unverified" naming the denial), and a `Usage:` total. Paste back the card text.

### OWNER CHECK A6 — resume

Import sessions → Claude Code sessions → pick a real past session → **Resume here**; then Antigravity conversations → pick one → **Resume**.
**Pass:** both open with their history. Paste back yes/no for each.

## Deviations from the brief (working rule #8)

- **`npm run dev`** uses `vite build --watch` (no HMR) so core serves the UI on
  :4777 in dev too, which is what the Phase 0 DoD asks for.
- **Extra dependencies:** `tsx` (TS dev runner), `globals` (ESLint),
  `@types/ws`, and `playwright-core` (drives the pre-installed Chromium for
  `test:ui`; it never downloads a browser). `@fastify/static@10` and
  `vitest@5` were chosen to clear `npm audit`, which is at 0 vulnerabilities.
- **Moirai not used.** Claude.ai and ChatGPT exports are parsed by a small
  in-house parser (`sessions/exports.ts`) to keep the dependency list short.
  Moirai stays an option.
- **agy driven mode is per turn** (`agy -p … --conversation <id> --output-format stream-json`),
  not a persistent `--input-format stream-json` process. Same events, simpler
  lifecycle (stop = abort one process). Claude is also per turn
  (`claude -p … --resume <id>`) rather than the Agent SDK, so there's no extra
  dependency and both CLIs go through the same NDJSON path.
- **agy identity on the message system:** agy's MCP docs don't say whether
  `env` values expand `$VAR`. The global `switchyard` entry sets
  `SWITCHYARD_NODE: "$SWITCHYARD_NODE"`, and `bus-mcp` treats a literal `$…`
  as unset and falls back to a per-folder identity file
  (`~/.switchyard/run/by-cwd/…`). If expansion doesn't work, the limit is
  **one agy node per folder**.
- **agy hooks:** agy only reads hooks from `hooks.json` files (no per-process
  flag) and the brief doesn't list that file as allowed. So agy status uses the
  quiet heuristic (8 s with no output ⇒ idle) plus on-screen prompt patterns,
  and status hooks are an **opt-in** Settings button.
- **agy conversation listing:** no documented command. The UI probes
  `agy --help` and otherwise offers "continue most recent" (`agy -c`) and
  "resume by id".
- **Driven Claude permissions:** `acceptEdits` plus an editable allow-list
  (Settings). `--permission-prompts none` isn't passed because it needs
  Claude ≥ 2.1.259; in `-p` mode with no permission host, prompts are denied
  anyway.
- **Runs evidence:** files touched come from a before/after snapshot (works
  without git). `git diff --stat` is added when the folder is a repo. Tests run
  only if a suite is detected (pytest files or an `npm test` script); otherwise
  the card says "unverified" and why.
- **"Assign to node"** sends the request as from `user`, since the human isn't a
  node. Agents can answer `user` requests but can't otherwise use `user` to get
  around connection scoping.
- **Remote read-only** applies to requests that come through a proxy
  (forwarded headers or a non-loopback Host). Remote sessions can still answer
  questions and reply to prompts.

## Phase log

### Phase 0: Scaffold (commit `phase 0`)

npm workspaces; Fastify core on 127.0.0.1:4777 with a one-time UI token;
React/Vite login page → empty canvas; ESLint, Prettier and Vitest.
Try it: `npm start`, then paste the printed token.

### Phases 1–8 (one commit)

**What changed:** core-owned PTYs with 10k-line replay; React Flow canvas with
terminal, agent-terminal, agent-chat, note, doc and browser nodes, edges,
minimap, `⌘K`, focus mode and persisted layout; `bus-mcp` with 13 tools;
SQLite message system (durable messages, scoping, tasks, ask_user); adapters
for claude, agy, shell and mock; status from Claude hooks plus a quiet/prompt
heuristic; Needs-you sidebar, `/api/attention` and idle-only nudges; Board with
dnd-kit, dependencies and assign; driven chat nodes and Ask Switchyard; Runs
engine (plan → edit → approve → parallel steps → review loop ×3 →
evidence → pause/stop/resume); session import (Claude JSONL, agy, chat
exports); phone layout, remote read-only, login rate limit, socket token and
origin checks; worktree button and push-to-talk.
**How to try it:** `npm start` → workspace → **+ Add → Mock agent** twice →
connect them → in one, type `peers`, then `ask hello?` and answer in Needs you.
Then open Runs and plan the hello.py goal with the Mock harness.

## F-phases (SWITCHYARD_FINAL_PROMPT.md)

- [x] **F0** macOS bring-up: done on the owner's Mac 2026-10-13 (see "F0: macOS bring-up" below)
- [ ] **F1** agy environment probe: **blocked on the Google account.** agy 1.3.4 is installed, but the probe run on 2026-10-13 ended with `Eligibility check failed: Your current account is not eligible for Antigravity. To use Antigravity you must be 18 years old or older … verify your age and try to log in again`. Hooks and the MCP server never started, so there is no result yet. Per-folder identity stays primary until this passes.
- [x] **F2** run dirs out of the repo
- [x] **F3** permissions so bus tools don't prompt
- [x] **F4** message delivery without blind PTY typing (the Claude-socket experiment in step 3 is skipped: needs a real Claude)
- [x] **F5** authoritative status + Allow/Deny from the sidebar (held-open PermissionRequest hooks; ui-checks for Allow / Deny / timeout and the folder-trust prompt)
- [x] **F6** identity and capability hygiene: `SWITCHYARD_CAPFILE` (0600/owner/regular-file checked in bus-mcp), one 401 body for every bad credential, revoke on exit/stop/boot, `--max-semi-space-size=1` on child processes
- [x] **F7** sessions: agy conversation list from `~/.gemini/antigravity-cli/brain` (fixture tests)
- [x] **F8** persistent agy driven sessions (opt-in: Settings → Antigravity, default off; fake-binary tests only, never run against the real agy)
- [x] **F9** usage meter (per-turn `usage` table, `GET /api/usage`, spend badge on chat nodes, usage on run step rows and result cards)
- [x] **F10** remote hardening: Funnel refused (403); every Serve request must carry `tailscale-user-login`, confirmed with `tailscale whois --json <last x-forwarded-for ip>` (injectable runner, 60 s per-IP cache, fail closed + rate-limited log when the CLI is missing); first verified login pinned as `remoteOwnerLogin`, clearable only on the computer (Settings → Forget); `*.ts.net` socket origin accepted only for a verified remote. Real Tailscale → owner to-do.
- [~] **F11** background-session spike: findings from `claude --help` recorded below (zero quota); the two live turns are an optional OWNER CHECK
- [x] **F12** polish: opt-in macOS notifications for new needs-you items (`macNotifications`, default off, local-only, one banner per item, at most 1 per 2 s); `npm run dev` is Vite HMR on 127.0.0.1:5173 proxying to core, `npm run dev:build` is the old watch build; main web chunk 371 kB. Real banner on screen → owner check (allow notifications for Script Editor if none appear).

**Check inventory (2026-10-14 evening, master):** lint clean · 304 vitest · e2e 29 PASS lines · 63 ui-checks in Chromium and WebKit (`npm run test:ui:webkit`) · selftest footprint ~40 MB · `SWITCHYARD_MAC_LAUNCH=1 npm run mac:check` 20. `npm run test:all` runs the core set in order.

**In flight when the session stopped:** a native Swift/WKWebView `Switchyard.app` shell on branch `worktree-agent-a3ccafde8bf1719fa` (worktree under `.claude/worktrees/`), not merged, not reviewed.

### Native Mac app (Swift AppKit + WKWebView, no Electron)

**What changed:** `npm run mac:app` now compiles `scripts/mac/SwitchyardApp.swift` into `~/Applications/Switchyard.app` (ad-hoc signed, icon from the logo; the bash browser launcher remains the fallback when `swiftc` is missing). One window with a transparent titlebar, frame remembered, ⌘W hides, ⌘Q quits the app while the server keeps running, Edit/View/Window menus, mic permission for loopback only, JS dialogs as native alerts, external links to the default browser. It starts the server from the repo it was built in (`~/.switchyard/mac-app.json` says which) and signs in with the token file.
**How to try it:** `npm run mac:app && open ~/Applications/Switchyard.app`; `SWITCHYARD_MAC_LAUNCH=1 npm run mac:check` (17 checks, real launch on a temp port and home).
**Unverified:** nobody has looked at the window yet (no Screen Recording permission for screenshots): titlebar inset, clipboard in terminals, mic prompt, dialogs. Measured ~94 MB app + ~93 MB WebContent.

### F8: persistent agy driven sessions (opt-in)

**What changed:** `harness/agy.ts` gained `AgySession`: one `agy --input-format stream-json --output-format stream-json --disable-slash-commands [--conversation <id>]` process per chat node or run step, a prompt queue (next prompt only after the turn's `result`), crash/Stop/timeout → kill, fail the turn, respawn lazily with `--conversation <last id>`; a YOLO/cwd change also respawns; stdin closed on node delete, Clear chat, harness switch, run stop/finish and core shutdown. Setting `agyPersistentSessions` (default **off**) with a checkbox in the Antigravity card. Planner and review-verdict turns stay on per-turn `-p` because `--json-schema` is per process.
**How to try it:** `npx vitest run packages/core/src/harness/agy-session.test.ts` (9 tests against `__fixtures__/fake-agy.mjs`); `npm run test:e2e` (F8 lines). With a real agy: tick the box, add an Antigravity chat node, send two messages, `pgrep -fl "input-format stream-json"` shows one process.
**Unverified (needs a real agy):** whether stream-json input works without `-p`, the stdin line shape, whether `result.usage` is per turn or cumulative, whether `--disable-slash-commands` stops a `/…` line ending the session, exit on stdin EOF, permission prompts in this mode. Leave the toggle off until A1–A5 pass.

### F11: Claude nodes as background sessions (research only, no adoption)

**What the installed `claude` 2.1.272 offers (from `--help`, no turns spent):** `claude --bg|--background` starts a session detached and prints an id; `claude attach <id|name>` opens it in the current terminal (← returns to the agent view, Ctrl+Z drops back to the shell, the session keeps running either way); `claude logs|stop|rm <id>`; `claude agents --json [--all]` prints active (and completed) sessions as JSON without a TTY; `claude agents --mcp-config … --settings … --permission-mode … --add-dir …` apply to sessions dispatched from the agent view; `--bg --resume <id>` continues a session under the same id.
**How Switchyard could use it:** a Claude node would become `claude --bg --name <node> --mcp-config <per-node> --settings <per-node hooks>` plus `claude attach <id>` inside the node's PTY. Benefits: the session survives a core restart and an accidental node close; `claude agents --json` gives state/status/waitingFor for free (a second authoritative status source next to the hooks); the attached PTY is only a view, so replay/resize bugs can't kill the agent. Costs: one more process per node (the agent-view supervisor), the hook URL/secret rotation on respawn no longer maps 1:1 to the process, worktree moves need `stop` + `--bg --resume`, and the PTY nudge/reply path goes through `attach`, whose key handling (← and Ctrl+Z are reserved) would need the reply escaping extended. Undocumented in `--help`: whether `--mcp-config`/`--settings` given to `claude --bg` itself (not `agents`) carry over, and the JSON field names of `claude agents --json` (`state`, `status`, `waitingFor` per the master plan).
**Decision:** not adopted. Nothing changes until the two live turns below say the flags carry over; even then the gain (restart survival) is small for a single-user desktop app and the attach/reply path is the risky part.

### OWNER CHECK F11 (optional, 2 tiny Claude turns, ≤ 10 min)

1. `mkdir -p ~/.switchyard/scratch/f11 && cd ~/.switchyard/scratch/f11 && git init -q`
2. `claude --bg --name sy-f11 "reply with the single word pong and stop"` → note the printed id.
3. `claude agents --json --all` → paste the JSON object for `sy-f11` (the field names are what F11 wants).
4. `claude attach sy-f11` → see the reply, then Ctrl+Z, then `claude stop sy-f11` and `claude rm sy-f11`.
5. Paste back the JSON from step 3 and whether attach showed the session.

### F0: macOS bring-up (2026-10-13, Apple M3, 16 GB, macOS 27)

**Versions:** Node v22.23.3, npm 10.9.9, `claude` 2.1.272 (Claude Code), Xcode CLT at `/Library/Developer/CommandLineTools`, Python 3.14.6 + pytest 9.0.3, Playwright 1.64 with Chromium 1208 cached. `agy`: **not installed** (OWNER CHECK F0). `tailscale`: not installed.
**What changed:** `npm install` succeeded with prebuilt binaries, but every PTY failed with `posix_spawnp failed`: node-pty 1.1.0's tarball ships `spawn-helper` without the exec bit, so `scripts/postinstall.mjs` restores it. The own-folder guard broke on `/var` → `/private/var` for not-yet-created subpaths (fixed in `paths.real()`); the e2e tests resolved `scratch/` from `process.cwd()` (now from the test file); ui-check now finds Playwright's cached Chromium or Google Chrome.
**Results on arm64:** lint clean · 139 vitest · e2e (bus + mock run with real git evidence and `pytest` passing) · 27/27 ui-checks · selftest idle RSS 31 MB, CPU 0.7 %.
**Note:** `claude` here is 2.1.272 (the container had 2.1.296). `--permission-prompts none` needs ≥ 2.1.259, so still fine; `claude --help` was not re-diffed against the adapter flags yet (done in the acceptance phase).

### F5 leftover: permission cards and the trust prompt in the browser check

**What changed:** `scripts/ui-check.mjs` POSTs a real `PermissionRequest` hook to a mock node's hook URL (`/bus/hook/claude/<node>/<secret>`), clicks **Allow once** / **Deny** and asserts the exact hook JSON; a third request with no click expires to `{}` under the test-only `SWITCHYARD_PERMISSION_TIMEOUT_MS=1500`. Claude's folder-trust dialog ("Do you trust the files in this folder?" + "1. Yes, proceed" in the last 20 screen lines) is now detected in `status/monitor.ts` for any terminal → needs_input item "Accept the folder trust prompt in this node" with an **Accept** button (Enter); free text at that prompt is still refused (409). An answered prompt only counts output written after the answer (`PtySession.totalBytes`), so it no longer re-flags when the next line prints.
**How to try it:** `npm run test:ui` → 8 `F5` checks; vitest `status/trust-prompt.test.ts` (6).
**Unverified:** the real dialog wording/line count (only a real `claude` in an untrusted folder can confirm; widen `TRUST_LINES` in monitor.ts if needed).

### F9 leftover: usage on runs

**What changed:** usage rows carry `step_id` (migration 3); `GET /api/runs/:id` returns `usage {turns, costUsd, inputTokens, outputTokens}` on the run and on each step from one grouped query per read. Web: muted `… tok · $…` badge on each step row and a `Usage:` line on the result card, formatter shared with the chat-node badge (`bits.tsx`). The mock harness reports 100 in / 50 out tokens per turn and no price, so a mock run is 750 tokens.
**How to try it:** Runs → mock/mock/mock → Approve & start → card reads `Usage: 750 tokens`, each step `300 tok`. e2e asserts the run total equals `SUM` over the usage table; ui-check F9 ×3.

### F10 remainder: whois-verified remote access

**What changed:** `auth/remote.ts` verifies every proxied request: `tailscale-user-login` header present, `tailscale whois --json <last x-forwarded-for ip>` (PATH or the App Store bundle) returns the same `UserProfile.LoginName`, result cached 60 s per IP (in-flight promise shared, failures cached, one log line per 60 s). First verified login is pinned (`remoteOwnerLogin`); PATCH accepts only `''` and only from the computer (Settings → Forget). The `/ws` upgrade accepts a `*.ts.net` Origin only after that verification. Bearer 401 still runs first so unauthenticated probes never spawn whois.
**How to try it:** vitest `auth/remote.test.ts` + `remote.test.ts` (real ephemeral listener + `ws` client); ui-check puts a fake `tailscale` first on PATH so the real runner is exercised (+2 checks).
**Unverified:** real Serve header behaviour (appends vs replaces `x-forwarded-for`), real `whois --json` shape, whether the App Store CLI needs `--socket`.

### F6: identity and capability hygiene

**What changed:** core passes each agent process only `SWITCHYARD_NODE`, `SWITCHYARD_HOME` and `SWITCHYARD_CAPFILE` (the _path_ of its 0600 run file; the agy entry carries `"$SWITCHYARD_CAPFILE"` next to `"$SWITCHYARD_NODE"`). bus-mcp resolves CAPFILE → SWITCHYARD_NODE → by-cwd, `lstat`s the file (regular, mode 0600, own uid; symlinks refused) and throws if the file belongs to another node id. Capabilities and hook secrets are revoked in the PTY exit listener, on Stop and at boot for dead terminal agents (driven chat nodes keep theirs). Both bus routes answer every bad credential with one body: `unknown node, stale capability or wrong secret`. `LEAN_NODE_FLAGS` now also has `--max-semi-space-size=1` (bus-mcp, hook.js, hook-agy.js, mock-agent; core unchanged).
**How to try it:** start a mock node, `ls -l ~/.switchyard/run/<id>.json` (0600), stop it → file gone; `curl -H 'x-switchyard-node: <id>' -H 'x-switchyard-cap: nope' http://127.0.0.1:4777/bus/whoami` → the shared 401. Tests: `auth/capfile.test.ts`, `api/bus-auth.test.ts`, `nodes/lifecycle.test.ts`; e2e node B runs on `SWITCHYARD_CAPFILE` alone.
**Unverified:** the other-uid refusal (needs a second user); whether agy expands `$SWITCHYARD_CAPFILE` (F1 probe decides; the by-cwd fallback stays).

### F4: delivery without typing

**What changed:** every Claude node gets an HTTP `Stop` hook (`/bus/hook/claude/<node>/<secret>`, per-node secret rotated with the capability); core answers with block / context / `{}` from the tested decision tables and stores `last_assistant_message` as the node summary. agy gets `hook-agy.js` + `POST /bus/agy/hook` (PreInvocation / Stop). The PTY nudge is last-resort only (off for Claude unless opted in, hook-driven or mock nodes only, never while needs_input, counted in `monitor.nudgeCount`). Human replies go through `pty/input.ts` (bracketed paste, `Reply: ` prefix, control chars stripped) and free text is refused while a node is in needs_input.
**How to try it:** `cd packages/core && npx vitest run src/bus/hook-route.test.ts src/api/reply.test.ts src/pty`.

### Mac packaging, selftest

**What changed:** `npm run mac:app` builds a script-based `Switchyard.app` (no Electron); PWA manifest for Add to Dock; `server.pid` + `npm run stop`; `npm run selftest` checks idle RSS/CPU budget (76 MB / 0.9% measured on Linux).
**How to try it:** `npm run build && npm run selftest`.
