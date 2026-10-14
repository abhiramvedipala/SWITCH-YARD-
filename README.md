# Switchyard

A local-first workspace where several AI coding agents (Claude Code and
Google's Antigravity CLI, with a built-in mock for testing) run side by side on
one canvas. They can find each other, pass messages and tasks, and flag when
they need you, and you can chain them into planner → builder → reviewer
"runs". One person supervises everything. It runs on your own machine with
your own subscriptions: no cloud, no accounts, no telemetry.

Switchyard is an original, independent implementation inspired by the
publicly described feature set of October Desktop. It shares no code, assets
or branding with it. See [`NOTICE.md`](./NOTICE.md).

**Status:** see [`REPORT.md`](./REPORT.md) for what works, what's mocked, and
the three checks to run with real agents. [`PROGRESS.md`](./PROGRESS.md) has
the phase log.

## Quick start

```bash
# Node 22+, plus Xcode Command Line Tools on macOS (node-pty builds natively)
npm install
npm start            # builds everything and serves http://127.0.0.1:4777
```

The first start prints a login token (also saved to
`~/.switchyard/ui-session`, mode `0600`). Paste it into the login page.

Then **New workspace → pick a folder**. The scratch playground is the safe
choice for trying things. After that, **+ Add** a terminal, an agent or a
note, and drag from one node's edge dot to another to connect them.

To use real agents, install and sign in once in a normal terminal:

```bash
claude                                                  # Claude Code: sign in
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy                                                     # Antigravity: browser sign-in
```

Neither is required: the **Mock agent** uses the same message system with no AI.

## Using it on a Mac

- `npm run mac:app` builds `~/Applications/Switchyard.app`: a native AppKit + WebKit window (needs the Xcode Command Line Tools; without `swiftc` it falls back to a launcher that opens your browser). It starts the local server if needed and signs you in with the token from `~/.switchyard/ui-session`. ⌘W hides the window, ⌘Q quits the app; the server keeps running until `npm run stop`. ⌘R reloads, right-click → Inspect Element works. Allow the microphone once for voice input. `npm run mac:check` verifies the bundle; `~/.switchyard/mac-app.json` says which repo the app was built from (re-run `npm run mac:app` if you move the folder).
- **macOS notifications** (Settings → Behavior, off by default): a banner when an agent asks a question, waits for a permission or stops at a prompt. One per item, at most one every 2 s. Changeable only on the computer itself. If none appear, allow notifications for Script Editor in System Settings → Notifications.
- Or open the UI in Safari/Chrome and use _Add to Dock_ - a `manifest.webmanifest` is served.
- `npm run stop` stops the server (pid file in `~/.switchyard/server.pid`). Logs: `~/.switchyard/server.log`.
- It stays light: the server idles at ~80 MB and runs with a tiny young-generation heap.

## What's on the canvas

| Node                            | What it is                                                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Terminal                        | A real shell (node-pty). Keeps running and keeps its scrollback across page reloads.                                         |
| Claude Code / Antigravity agent | The interactive CLI in a terminal, with Switchyard's message-system tools attached. Shows working / idle / needs-you status. |
| Mock agent                      | A no-AI stand-in that drives the same tools. Type `help` in it.                                                              |
| Claude / Antigravity chat       | A "driven" agent: headless turns streamed into a chat view.                                                                  |
| Note, Doc, Browser preview      | Plain text, markdown, and an iframe for `localhost` previews.                                                                |

**Connections define who can talk to whom.** An agent only sees peers it's
connected to by an edge.

Other views and panels:

- **Board:** shared tasks (Open / In progress / Done). Agents use `list_tasks`, `claim_task` and `complete_task`; you drag cards or "Assign to…" an agent.
- **Runs:** goal → editable plan → approve → build → review (up to 3 rounds) → result card with evidence (files touched, `git diff --stat`, test output, or an honest "unverified"). Every step row carries a muted `1.2k tok · $0.03` badge and the card has a `Usage:` total (tokens only when the harness reports no price, e.g. Antigravity or the mock).
- **Needs you:** questions from `ask_user`, permission prompts read off the screen, and idle agents with unread messages. Each item has a reply box.
- **Ask Switchyard:** project chat that sees a snapshot of the canvas. It defaults to Antigravity to save Claude usage.
- **Import sessions:** resume past Claude Code sessions, Antigravity conversations, or Claude.ai / ChatGPT export files (imported as read-only docs).
- **Keyboard:** `⌘K` command palette, `F` focus the selected node, `Esc` to go back (`Shift+Esc` inside a terminal).

## Message-system tools agents get (MCP server `switchyard`)

`list_peers`, `get_peer_context`, `message_peer` (intents `notify` / `request` /
`response`), `check_inbox`, `wait_for_reply`, `publish_summary`, `list_tasks`,
`add_task`, `claim_task`, `complete_task`, `get_node_status`,
`wait_for_nodes`, `ask_user`.

Messages are durable: they're saved to SQLite before they're acknowledged. A
message never starts an agent's turn by itself. Switchyard only nudges an
**idle** terminal agent with `[switchyard] N new messages — call check_inbox`,
and you can turn that off. A message from a peer is information, not
permission: nothing on the message system can change another agent's
permissions.

## Safety rules (enforced in code)

1. Only local coding folders. Switchyard never reads your mail, browser data, keychain or credentials. It doesn't even check whether you're signed in to an agent, because that lives in the keychain.
2. Automated tests use temp dirs and `./scratch/`, never your projects, and never call real agents.
3. The core binds to `127.0.0.1` only (hard-coded).
4. Agents run in their normal permission-prompting mode. Bypass (`--permission-mode bypassPermissions` for Claude, `--dangerously-skip-permissions` for agy) happens only when you turn on the red **YOLO mode** for that node, behind a confirmation.
5. No analytics, no update checks, no outbound calls from Switchyard itself.
6. Secrets (UI token, per-node capabilities and hook secrets) are `0600` files in `~/.switchyard/`, never environment variables with TOKEN/KEY/SECRET/AUTH/PASSWORD in the name. Each agent process only receives `SWITCHYARD_NODE`, `SWITCHYARD_HOME` and `SWITCHYARD_CAPFILE` (the _path_ of its run file); bus-mcp refuses a capfile that is not a regular `0600` file owned by you. Capabilities and hook secrets are rotated on every (re)start and revoked when the process exits, is stopped, or the core restarts; every bad credential gets the same 401.

Files outside the repo that Switchyard writes: `~/.switchyard/` (including
`run/<nodeId>.json`, one `0600` file per live agent node with its capability and
hook secret, deleted on exit, and `run/by-cwd/<sha>.json` with the node id per
agent folder for hosts that don't pass env through), plus the
`switchyard` entry in `~/.gemini/config/mcp_config.json` when you start an
Antigravity node (other entries are left alone, and Settings can remove it).
It writes `~/.gemini/config/hooks.json` only if you click "Install status
hooks". It never edits `~/.claude/settings.json`: Claude gets its MCP server
and hooks per process through `--mcp-config` and `--settings`.

Settings → Antigravity → **Keep one agy process per chat node and run step**
(`agyPersistentSessions`, default off, experimental): chat nodes and run build
steps on agy talk to one long-lived stream-json process instead of one
`agy -p` per turn. It writes nothing outside Switchyard's own database; untick
to undo.

**API-key chats (opt-in):** Settings → **API keys**, paste a Claude, OpenAI or
Gemini key (saved only in `~/.switchyard/keys/`, `0600`, never shown again).
Then **+ Add → Claude / OpenAI / Gemini API chat**. Chat only (no tools, no
files), billed per token to your account, and the only part of Switchyard that
goes online.

**Codex (ChatGPT):** install with `npm install -g @openai/codex` (or
`brew install --cask codex`), run `codex login` and choose _Sign in with
ChatGPT_. Then **+ Add → Codex agent** (terminal) or **Codex chat** (driven).
Bus tools are attached per process; Switchyard never writes `~/.codex`.

**Claude Desktop (opt-in):** Settings → Claude Desktop → pick a workspace →
**Connect**. Switchyard adds only a `switchyard` entry to
`~/Library/Application Support/Claude/claude_desktop_config.json` (`.bak`
first) and puts a Claude Desktop node on that canvas. Connect it to agents with
edges, restart Claude Desktop, then ask a chat `list my switchyard peers`.
**Remove** undoes both.

## Phone access (Tailscale)

The core stays on `127.0.0.1`. To reach it from your phone, use Tailscale's
proxy on the Mac:

```bash
tailscale serve --bg 4777        # https://<your-mac>.<tailnet>.ts.net → 127.0.0.1:4777
tailscale serve reset            # stop
```

Open that URL on a phone on the same tailnet and log in with the token. Remote
sessions get a phone layout (Needs you / Runs / Agents) and are **read-only by
default**: they can answer questions and reply to prompts, but can't add,
delete or type into terminals. You can turn that off in Settings, but only from
the computer itself. Logins are rate-limited. Every request that arrives through Serve must carry
Tailscale's identity header (`tailscale-user-login`), and the core confirms it
with `tailscale whois` on the forwarded IP (cached 60 s). The first tailnet
login that connects is pinned as the owner; any other login gets 403 until you
press **Forget** next to it in Settings on the computer (it cannot be cleared
from the phone). If the `tailscale` CLI is not found (PATH or the App Store
bundle), remote requests are refused and one line is logged. Funnel (public
internet) is always refused. Tailscale is the only supported remote path;
don't expose the port any other way.

## Development

```bash
npm run dev        # Vite dev server with HMR on http://127.0.0.1:5173 (proxies /api, /bus, /ws to core on :4777)
npm run dev:build  # the old mode: watch-builds web and core serves it on :4777 (no HMR)
npm test           # unit + integration tests (mock harness, temp dirs)
npm run test:e2e   # message-system and runs scenarios with real bus-mcp processes, verbose
npm run test:ui    # builds, then drives the UI in headless Chromium through every phase's check
npm run lint
```

Layout: `packages/core` (Fastify + WebSocket daemon, SQLite, PTYs, adapters,
runs engine), `packages/bus-mcp` (stdio MCP server, hook relay, mock agent),
`packages/web` (React + Vite UI). Extras: `extras/xbar/` has a menu-bar
"agents need you" plugin that reads `/api/attention`.

### Native modules

`node-pty` and `better-sqlite3` compile during `npm install`. On macOS that
needs the Xcode Command Line Tools (`xcode-select --install`). If you switch
Node versions, run `npm rebuild node-pty better-sqlite3`.

### macOS notes

Verified on an Apple M3 (arm64), macOS 27, Node 22.23, npm 10.9:

- Both native modules installed from prebuilt binaries (no compile step ran).
- **node-pty 1.1.0's npm tarball ships `prebuilds/darwin-arm64/spawn-helper`
  without the execute bit**, which makes every terminal fail with
  `posix_spawnp failed`. `npm install` now runs `scripts/postinstall.mjs`,
  which restores the bit. If a terminal node still prints that error, run
  `chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper`.
- `$TMPDIR` lives under `/var`, a symlink to `/private/var`; the own-folder
  guard resolves symlinks for paths that don't exist yet too.
- `npm run test:ui` uses Playwright's cached Chromium
  (`~/Library/Caches/ms-playwright`) or Google Chrome; set `CHROMIUM_PATH` to
  override.

### Menu bar / notch widgets (`/api/attention`)

Anything local can show "agents need you" without touching the UI:

- `GET /api/attention/summary` → `{"count":2,"byKind":{"question":1,"permission":1},"hash":"…"}`.
  Cheapest read; poll it every few seconds.
- `GET /api/attention?wait=30&since=<hash>` → long-poll: the server holds the
  request up to 30 s and answers `304` when nothing changed, otherwise
  `{"items":[…],"hash":"…"}`. Each item has `kind`
  (`question` | `needs_input` | `permission` | `unread`), `id`, `nodeId`,
  `nodeTitle`, `workspaceId`, `text`, `createdAt`, and for permissions
  `toolName`, `source`, `options`. `If-None-Match` works the same way.
- Acting on an item: `POST /api/questions/:id/answer {"answer":"…"}`,
  `POST /api/permissions/:id/decide {"decision":"allow"|"deny"|"ask"}`.

Every call needs `Authorization: Bearer <token>` with the token from
`~/.switchyard/ui-session`, and only `http://127.0.0.1:4777` is reachable.
For an iNotch-style notch app: read the token file once, long-poll
`/api/attention` in the background, show `count` in the notch, expand the
items on hover and send the answer or decision from there.
`extras/xbar/switchyard.10s.sh` is the same idea in 15 lines of shell.

## Limitations

- **Cloud workspaces and hosted multiplayer:** out of scope. They'd need servers and accounts.
- **Live claude.ai / gemini.google.com chats:** can't be connected, because there's no API for them. Export and import instead.
- **Antigravity listing:** agy has no list command, so the import dialog reads `~/.gemini/antigravity-cli/brain/*/.system_generated/logs/transcript.jsonl` (read-only) to list conversations.
