# Switchyard — Final report

## Start it

```bash
npm install
npm start          # → http://127.0.0.1:4777, paste the token printed on first start
```

## First run on your Mac

1. `xcode-select --install`, if `npm install` complains about building native modules.
2. `claude`: sign in once with your Claude account, then exit.
3. `curl -fsSL https://antigravity.google/cli/install.sh | bash`, then run `agy` once to sign in through the browser.
4. `npm start`, log in with the token, and create a workspace. Use a throwaway folder or the scratch playground first.
5. Settings (⚙) shows whether each agent is installed.

## What works (verified here)

Everything below was exercised in this repo's automated checks: `npm test`
(33 tests), `npm run test:e2e`, and `npm run test:ui` (26 browser checks in
headless Chromium). None of them spends AI quota.

- **Terminals:** real shells. Output survives page reloads (10k-line replay). Resize, rename, restart, stop.
- **Canvas:** terminal, agent, chat, note, markdown doc and browser-preview nodes. Connections, pan and zoom, minimap, layout saved, `⌘K` palette, `F`/`Esc` focus mode. New nodes land in free space.
- **Message system:** 13 MCP tools through a real stdio MCP server. Durable messages, request/response matching, expiry, connection scoping (unconnected nodes can't see or reach each other), shared tasks with atomic claims and dependencies, `ask_user`, `wait_for_nodes`. Queued delivery: idle agents get one nudge, busy agents are left alone.
- **Status:** working / idle / needs-you chips. Claude uses per-process hooks; agy and the others use a quiet-time heuristic plus on-screen prompt detection. "Needs you" shows questions within about 100 ms, with a reply box and quick keys. `/api/attention` is a JSON feed for widgets.
- **Board:** drag between columns, dependency badges, "Assign to…" sends a request to an agent's inbox, and agents' claims and completions move cards live.
- **Runs:** goal → planner → editable plan (instructions, agent per step, add or remove steps) → approve → parallel steps → reviewer findings go back to the builder (up to 3 rounds) → result card with files touched, `git diff --stat`, real test output (or "unverified" and why) and open findings. Pause, stop and resume work; restarts are handled.
- **Chat:** driven chat nodes and the workspace-wide **Ask Switchyard** chat, which defaults to Antigravity. Responses stream in.
- **Sessions:** list and resume Claude Code sessions from `~/.claude/projects`; agy "continue most recent" or resume by id; Claude.ai and ChatGPT `conversations.json` imported as read-only doc nodes.
- **Remote/phone:** a phone layout, read-only by default for proxied requests (it can still answer and reply), login rate limiting, and a socket that needs the token in its first message plus an origin check.
- **Extras:** "agent in a git worktree" button, push-to-talk (Web Speech API), and an xbar/SwiftBar menu-bar plugin (`extras/xbar/`).

## What's mocked or not verified here

- **Real `claude` and `agy` runs were never made.** That's on purpose (rule #9), and agy can't be installed or signed in to in this container. The adapters are covered by unit tests against the documented stream formats and CLI flags (all Claude flags were checked against `claude --help` 2.1.296), but the first real end-to-end use happens on your Mac. See the three checks below.
- Claude's hook payloads and agy's exact stream-json field names come from the docs. Small differences would show up as wrong status chips or a missing streamed text, not as crashes.
- Phone access over real Tailscale wasn't tested here. Phone mode was tested with forwarded headers.

## Known limitations

- No cloud workspaces or hosted multiplayer. They need servers and accounts, so they're out of scope.
- Live claude.ai or gemini.google.com chats can't be connected because there's no API. Export them and import the file.
- agy has no documented conversation-listing command, and it isn't documented whether its MCP `env` expands `$VAR`. If it doesn't, keep one agy node per folder.
- agy's shell commands in headless runs are soft-denied unless you allow them in `~/.gemini/antigravity-cli/settings.json`. Switchyard won't edit that file for you.
- Phase 9 items not built: an Electron/Tauri window shell (the web UI is ready for one), a Codex CLI adapter, and an October-Bus-compatible adapter. The adapter interface (`packages/core/src/harness/types.ts`) is where those would go.

## The three manual checks with real agents

1. **Two real agents talking (Phase 3).** Add a Claude Code agent and an Antigravity agent and connect them. Tell Claude: `list your switchyard peers and ask the agy peer for the word 'pong', then wait for the reply`. Tell agy: `check your switchyard inbox and reply to the request`. Claude should receive "pong".
2. **A real run (Phase 6).** Runs → goal `Create hello.py with a function that reverses a string and pytest tests; have the other agent review`. Set Where = scratch, Builder = Claude, Reviewer = Antigravity, then Plan run → Approve & start. You should get a result card with evidence.
3. **Resume a past session (Phase 7).** Import sessions → Claude Code sessions → pick one → Resume here.

Also worth a quick look: in a Claude node, ask it to `use the switchyard ask_user tool to ask me which color to use`. It should appear in Needs you within 2 s. For phone access, run `tailscale serve --bg 4777` and answer from your phone.
