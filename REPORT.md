# Switchyard — report (2026-10-13, first day on the Mac)

## Start it tomorrow

```bash
cd ~/switchyard && npm start      # builds, serves http://127.0.0.1:4777, prints the token once
```

Or double-click `~/Applications/Switchyard.app` (`npm run mac:app` builds it; it starts the
server if needed and opens the UI signed in). `npm run stop` stops the server. Logs:
`~/.switchyard/server.log`.

## What works, verified on this Mac (Apple M3, macOS 27, Node 22.23, Claude Code 2.1.272)

All of it with the mock agent and real shells, so no AI quota was spent:

- `npm run lint` clean · **192 vitest** · `npm run test:e2e` (real core + three real bus-mcp
  processes over MCP stdio; a full mock run with real git evidence, `pytest` passing, denied-tool
  evidence, run usage totals) · **40 headless-Chromium checks** · `npm run selftest` (39 MB footprint, under 1 % CPU against a 140 MB / 3 % budget) · `npm run mac:check`.
- **Terminals:** real shells (node-pty), 10k-line replay across reloads, resize/rename/restart/stop.
- **Canvas:** terminal, agent, chat, note, doc and browser-preview nodes, connections, minimap,
  ⌘K, focus mode, layout persisted, visible-only rendering, iNotch-style light/dark theme.
- **Message system:** 13 MCP tools, durable messages, request/response matching, expiry,
  connection scoping, shared tasks with atomic claims, `ask_user`, `wait_for_nodes`. Delivery
  through Claude's `Stop` hook and agy's `PreInvocation`/`Stop` hooks; PTY nudge only as a
  last resort.
- **Status and Needs you:** hook-driven for Claude, quiet heuristic + prompt patterns otherwise.
  `ask_user` questions, held-open **PermissionRequest** cards (Allow once / Deny / Ask in
  terminal, `{}` on timeout), and the Claude **folder-trust dialog** (Accept button) all show in
  the sidebar and in `/api/attention`.
- **Board, Runs, Chat, Sessions:** as before, plus usage badges on run step rows and a `Usage:`
  total on the result card; agy conversations listed from `~/.gemini/antigravity-cli/brain`.
- **Identity:** each agent process gets only `SWITCHYARD_NODE`, `SWITCHYARD_HOME` and
  `SWITCHYARD_CAPFILE` (path of its 0600 run file); capabilities and hook secrets rotate on every
  start and are revoked on exit/stop/boot; every bad credential gets one identical 401.
- **Remote:** loopback bind; proxied requests must carry `tailscale-user-login`, confirmed with
  a cached `tailscale whois`; first login pinned (Forget in Settings, computer only); Funnel
  refused; `*.ts.net` socket origin accepted only after verification; read-only by default.
- **Widgets:** `/api/attention/summary` and long-poll `/api/attention` for a notch or menu-bar app
  (README has the field list); `extras/xbar/` plugin.

## Still unverified (needs you, in this order; exact steps in PROGRESS.md → Owner to-do)

**Blocker found 2026-10-13:** `agy` refuses this Google account ("not eligible for Antigravity … 18 years old or older"). Until OWNER CHECK F0b passes, everything that needs agy (F1, A1, A2, the agy reviewer in A5, agy resume in A6) cannot run; the Claude-only checks (A3, A4, Claude resume in A6, A5 with Claude as reviewer) can.

1. **OWNER CHECK F0** — install and sign in to `agy`, run the `pong` request.
2. **OWNER CHECK F1** — `node scripts/probe-agy-env.mjs` (one small agy request) decides whether
   `SWITCHYARD_NODE`/`SWITCHYARD_CAPFILE` reach agy's hooks and MCP children or the per-folder
   identity file stays primary.
3. **Acceptance A1–A6** (SWITCHYARD_FINAL_PROMPT.md §5): two real agents exchange "pong";
   delivery through the Stop hook with zero PTY nudges; permission from the sidebar; `ask_user`;
   a real planner → builder → reviewer run with evidence; resume a real Claude session and an
   agy conversation. Each in a fresh `~/.switchyard/scratch` workspace.
4. **OWNER CHECK F10** (optional) — phone over `tailscale serve`.
5. **F11** (optional research spike, ≤ 1 h, two tiny Claude turns): Claude nodes as `claude --bg`
   background sessions. Findings only.

Facts that only a real run can confirm: Claude hook payload fields, the exact trust-dialog
text, agy `stream-json` field names, real `total_cost_usd`/`usage` values, Tailscale Serve's
header behaviour and `whois --json` shape.

## Known limitations

- No cloud workspaces or multiplayer; no live claude.ai / gemini.google.com chat linking
  (export and import instead).
- If F1 shows agy does not pass env through, agy identity stays per folder: one agy node per
  folder.
- agy shell commands in headless runs are soft-denied unless the opt-in "Let agents run tests
  here" button added the rules to `~/.gemini/antigravity-cli/settings.json`.
- Not built: Electron/Tauri shell, Codex adapter, October-Bus-compatible adapter, persistent agy
  `--input-format stream-json` sessions (per-turn `-p --conversation` is used).
