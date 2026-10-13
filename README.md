# Switchyard

A local-first desktop workspace where several AI coding agents (Claude Code,
Google Antigravity CLI, more later) run side by side on one canvas, discover
each other, pass messages and tasks to each other, show when they need a
human, and can be chained into planner → builder → reviewer "runs". One
person supervises everything. Everything runs on your own machine using your
own subscriptions. No cloud, no accounts, no telemetry.

Switchyard is an original, independent implementation. It is inspired by the
publicly described feature set of October Desktop (october.dev) but shares
no code, assets, or branding with it. See [`NOTICE.md`](./NOTICE.md).

## Hard safety rules

These hold everywhere in this codebase — see `PROGRESS.md` for how each is
enforced today:

1. Switchyard never touches your Gmail, Drive, browser sessions, cookies,
   keychain, or credentials. It only orchestrates coding agents on local
   folders.
2. End-to-end tests run inside `./scratch/` or a temp dir — never against
   your real projects.
3. The core server binds to `127.0.0.1` only. Nothing listens on `0.0.0.0`.
4. Agents never run with permission checks bypassed unless you flip the
   clearly-labeled "YOLO mode" switch for that node. Default is
   permission-prompting mode.
5. No analytics, no update checks, no outbound network calls from the app
   itself. Agents make their own calls to their own providers, same as if
   you ran them in a plain terminal.
6. Secrets live in `~/.switchyard/` as `0600` files, never in env vars named
   with TOKEN/KEY/SECRET/AUTH/PASSWORD.

## Prerequisites

- **Node.js 22+** and npm 10+.
- **macOS with Xcode Command Line Tools** if you want to build the native
  modules (`node-pty`, added in Phase 1) from source on your Mac. This repo
  was scaffolded inside a Linux cloud container for development, but the
  app is meant to run on your own machine — clone it there before using it
  for real.
- [`claude`](https://code.claude.com) — Claude Code CLI, signed in with your
  own Claude subscription (`claude` once, interactively, to sign in).
- [`agy`](https://antigravity.google) — Google Antigravity CLI, signed in
  with your own Google account (`agy` once, interactively, to sign in).
  Optional — Switchyard works with just Claude Code, or with neither (using
  the built-in `mock` and `shell` harnesses).

Until real agents are installed/signed in, Switchyard still runs fully
against the `shell` and `mock` harnesses. See `PROGRESS.md` → "Owner to-do"
for exact install/sign-in commands.

## Commands

```bash
npm install
npm run dev     # watch-builds the web UI and runs core with auto-reload
npm run build   # production build of web + core
npm start        # build, then run the built server
npm test         # unit tests across all packages
npm run test:e2e # bus integration test using the mock harness (no AI usage)
npm run lint
npm run format
```

`npm run dev` and `npm start` both serve the UI from the core server at
**http://127.0.0.1:4777**. On first start, a login token is generated and
printed once to the terminal (also saved to `~/.switchyard/ui-session`,
`0600`). Paste it into the login page; it's kept in your browser's
`localStorage` after that.

## Architecture

```
packages/core/     Fastify + WS daemon: PTYs, SQLite-backed bus, harness
                    adapters, runs engine, session import, auth. Serves the
                    built web UI.
packages/bus-mcp/  Stdio MCP server each agent node talks to for discovery,
                    messaging, and shared tasks (added in Phase 3).
packages/web/      React + Vite UI: canvas, terminals, board, runs, chat.
```

See the full phase plan and current status in [`PROGRESS.md`](./PROGRESS.md).

## License / original work

Written from scratch for personal use. No code, assets, CSS, icons, or
strings were copied from October Desktop or any other proprietary app.
Open-source dependencies keep their own licenses (see each package's
`node_modules/*/LICENSE` after install).
