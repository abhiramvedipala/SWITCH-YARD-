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

| Phase | Check | How |
|---|---|---|
| 0 | login page → empty canvas after token | `scripts/ui-check.mjs` (headless Chromium) + curl walkthrough; socket confirmed bound to 127.0.0.1 |
| 1 | run a command, reload, output still there | ui-check: types `echo hello-$((40+2))-switchyard` into xterm, reloads, finds `hello-42-switchyard` |
| 2 | 3 nodes + 2 edges, reload → identical | ui-check: nodes added via the UI menu, edges via the API; after reload counts, positions and note text match. Also checks `F`/`Esc` focus and the `Ctrl+K` palette |
| 3 | A request → B inbox → B response → A wait_for_reply; unconnected C sees nothing | `npm run test:e2e` / vitest: real core HTTP server + three real `bus-mcp` processes over MCP stdio. Also in the browser with two mock terminal agents |
| 4 | ask_user shows in Needs you ≤ 2 s and can be answered | ui-check: appears ~100 ms after the mock asks; the sidebar answer reaches the agent's terminal |
| 5 | UI task → claim → In progress → complete → Done | ui-check: card moves columns as the mock agent claims and completes it |
| 6 | demo run in scratch with one review round changing something | e2e + ui-check: mock plan → build → review requests a docstring and type hints → builder fixes → approved in round 2; result card shows `python3 -m pytest -q → passed` |
| 7 | resume a real Claude Code session | listing verified with a fixture transcript in ui-check; resuming needs real `claude` → owner to-do |
| 8 | answer ask_user from a phone over Tailscale | ui-check: 390×844 mobile context with forwarded headers gets the read-only phone layout, writes return 403, answering works, login hits 429 after 8 attempts. Real Tailscale → owner to-do |

Unit tests (33) cover message semantics (edge scoping, durability across DB
reopen, request/response correlation, expiry, claim atomicity, dependencies,
ask_user, wait_for_nodes, messages to and from the human), adapter launch flags
and YOLO gating, stream parsers for both CLIs, agy config editing (keeps other
entries, refuses to overwrite unparseable JSON), session/export parsers, and the
WebSocket origin and remote-detection rules.

## Owner to-do (exact steps)

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
