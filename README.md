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

- `npm run mac:app` builds `~/Applications/Switchyard.app` - a tiny launcher (no Electron). Double-click it (or drag it to the Dock): it starts the server if it is not running and opens the UI already signed in.
- Or open the UI in Safari/Chrome and use *Add to Dock* - a `manifest.webmanifest` is served.
- `npm run stop` stops the server (pid file in `~/.switchyard/server.pid`). Logs: `~/.switchyard/server.log`.
- It stays light: the server idles at ~80 MB and runs with a tiny young-generation heap.

## What's on the canvas

| Node | What it is |
|---|---|
| Terminal | A real shell (node-pty). Keeps running and keeps its scrollback across page reloads. |
| Claude Code / Antigravity agent | The interactive CLI in a terminal, with Switchyard's message-system tools attached. Shows working / idle / needs-you status. |
| Mock agent | A no-AI stand-in that drives the same tools. Type `help` in it. |
| Claude / Antigravity chat | A "driven" agent: headless turns streamed into a chat view. |
| Note, Doc, Browser preview | Plain text, markdown, and an iframe for `localhost` previews. |

**Connections define who can talk to whom.** An agent only sees peers it's
connected to by an edge.

Other views and panels:

- **Board:** shared tasks (Open / In progress / Done). Agents use `list_tasks`, `claim_task` and `complete_task`; you drag cards or "Assign to…" an agent.
- **Runs:** goal → editable plan → approve → build → review (up to 3 rounds) → result card with evidence (files touched, `git diff --stat`, test output, or an honest "unverified").
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
6. Secrets (UI token, per-node capabilities) are `0600` files in `~/.switchyard/`, never environment variables with TOKEN/KEY/SECRET/AUTH/PASSWORD in the name.

Files outside the repo that Switchyard writes: `~/.switchyard/`, plus the
`switchyard` entry in `~/.gemini/config/mcp_config.json` when you start an
Antigravity node (other entries are left alone, and Settings can remove it).
It writes `~/.gemini/config/hooks.json` only if you click "Install status
hooks". It never edits `~/.claude/settings.json`: Claude gets its MCP server
and hooks per process through `--mcp-config` and `--settings`.

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
the computer itself. Logins are rate-limited. Tailscale is the only supported
remote path; don't expose the port any other way.

## Development

```bash
npm run dev        # watch-builds web + bus-mcp, runs core with auto-reload (still on :4777)
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

## Limitations

- **Cloud workspaces and hosted multiplayer:** out of scope. They'd need servers and accounts.
- **Live claude.ai / gemini.google.com chats:** can't be connected, because there's no API for them. Export and import instead.
- **Antigravity listing:** agy documents no command to list conversations, so the import dialog offers "continue most recent here" and "resume by id".
