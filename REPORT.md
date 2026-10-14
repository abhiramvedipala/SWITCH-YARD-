# Switchyard — report (2026-10-14)

## Start it

Double-click `~/Applications/Switchyard.app` (or `open ~/Applications/Switchyard.app`). It is a
native window, starts the server if needed and signs you in. ⌘W hides the window, ⌘Q quits the
app; the server keeps running until `cd ~/switchyard && npm run stop`. Rebuild the app after
pulling: `npm run mac:app`. Logs: `~/.switchyard/server.log`.

## What works, verified on this Mac (Apple M3, macOS 27, Node 22.23, Claude Code 2.1.272)

All of it with the mock agent, fake binaries and fake local API servers, so no AI quota was spent:
lint clean · **258 vitest** · e2e (24 PASS lines: bus, mock run with git evidence and `pytest`,
persistent agy session, rooms) · **54 browser checks in Chromium and in WebKit** · selftest (39 MB
footprint) · 20 Mac bundle checks including a real app launch.

- **Canvas, terminals, Board, Runs, Needs you, Chat, Sessions, phone access:** as before, plus the
  `+ Add` menu fix, usage badges on run steps, and WebKit-verified UI.
- **Rooms:** one conversation with several AIs at once. Participants: Claude Code, Codex (ChatGPT),
  Antigravity, Claude / OpenAI / Gemini API chats, the mock. Modes everyone / only @mentioned / one
  after another; @mention chains are capped so two AIs can't loop; Stop; seed from an imported
  Claude.ai, ChatGPT or Claude Code conversation; canvas agents join with `list_rooms`,
  `read_room`, `post_to_room`.
- **Codex (ChatGPT) harness:** `codex exec --json` turns and interactive nodes on your ChatGPT
  subscription; bus tools attached per process; bypass only with YOLO.
- **API-key chats:** opt-in, keys as 0600 files in `~/.switchyard/keys/`, official hosts only; the
  only part of the app that goes online.
- **Claude Desktop connector:** opt-in button writes one `switchyard` entry to Claude Desktop's
  config (`.bak`, Remove) so a Claude Desktop chat can list peers and join Rooms.
- **Native app:** Swift AppKit + WebKit window, floating Needs-you panel (⌥⌘N) and menu-bar count,
  opt-in macOS notifications, `npm run dev` with HMR.
- **Hygiene:** `SWITCHYARD_CAPFILE` identity, identical 401 for every bad credential, revoke on
  exit; whois-verified Tailscale access with an owner pin; the server drops any Claude Code
  session variables it inherited at boot (a real bug found on day two).

## Still unverified (needs you; exact steps in PROGRESS.md → Owner to-do)

- **R1** a Room with two real AIs · **CX** install Codex and sign in · **AK** one API key (optional)
  · **CD** connect Claude Desktop · **F0b/F1** Antigravity refuses the Google account (age check)
  · **A1–A6** acceptance · **F10** phone over Tailscale (optional).
- Real-model behaviour in Rooms (@name etiquette), Codex's `--config mcp_servers.*` override, the
  live API request shapes, the Claude Desktop entry being loaded, the panel's look.

## In flight

"Other CLI agent" presets (Aider, Goose, OpenCode, Copilot CLI, Cursor CLI), a Files block, and
"Continue in…" session hand-off between harnesses.

## Known limitations

- A live claude.ai or chatgpt.com web chat cannot be joined (no API; no browser automation by
  rule). Export it and seed a Room instead.
- No cloud, teams/multiplayer, remote servers, Windows or Linux builds (October has them; out of
  scope here by rule).
- Antigravity identity stays per folder until the F1 probe can run.
- API chats are chat-only (no tools, no files); runs never pick them.
