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
- [ ] **F1** agy environment probe: `scripts/probe-agy-env.mjs` written; needs agy installed (OWNER CHECK F0/F1 below)
- [x] **F2** run dirs out of the repo
- [x] **F3** permissions so bus tools don't prompt
- [x] **F4** message delivery without blind PTY typing (the Claude-socket experiment in step 3 is skipped: needs a real Claude)
- [x] **F5** authoritative status + Allow/Deny from the sidebar (held-open PermissionRequest hooks; ui-checks for Allow / Deny / timeout and the folder-trust prompt)
- [x] **F6** identity and capability hygiene: `SWITCHYARD_CAPFILE` (0600/owner/regular-file checked in bus-mcp), one 401 body for every bad credential, revoke on exit/stop/boot, `--max-semi-space-size=1` on child processes
- [x] **F7** sessions: agy conversation list from `~/.gemini/antigravity-cli/brain` (fixture tests)
- [ ] **F8** persistent agy driven sessions (skipped for now)
- [x] **F9** usage meter (per-turn `usage` table, `GET /api/usage`, spend badge on chat nodes, usage on run step rows and result cards)
- [x] **F10** remote hardening: Funnel refused (403); every Serve request must carry `tailscale-user-login`, confirmed with `tailscale whois --json <last x-forwarded-for ip>` (injectable runner, 60 s per-IP cache, fail closed + rate-limited log when the CLI is missing); first verified login pinned as `remoteOwnerLogin`, clearable only on the computer (Settings → Forget); `*.ts.net` socket origin accepted only for a verified remote. Real Tailscale → owner to-do.
- [ ] **F11** background-session spike (skipped)
- [ ] **F12** polish: code-splitting only so far

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
