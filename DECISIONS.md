# Decisions and doc-vs-reality notes

Format: `date | claim | reality | what I did`.

2026-10-13 | The brief assumed agy allow rules could be scoped to a run folder | agy's permissions docs (antigravity.google/docs/permissions) say rules live in ONE global file, `~/.gemini/antigravity-cli/settings.json`, and describe no workspace-level CLI file | `write_file(<dir>/)` is per folder, but `command(regex:…)` test-runner rules are global. The Settings button says so, and Remove deletes only rules Switchyard added (tracked in `~/.switchyard/agy-owned-rules.json`).
2026-10-13 | MCP tools in agy | The docs say MCP tools default to Ask; `mcp(server/*)` allows all tools of a server | Opt-in button adds `mcp(switchyard/*)`.
2026-10-13 | F2 guard scope | A guard on every node would break plain shells and the mock agent used by tests | The own-folder guard applies to claude/agy nodes and to runs on a workspace folder only; `allowOwnFolder` overrides it explicitly.
2026-10-13 | Granular commits | Owner asked for one small commit per step or decision so the history is easy to follow | Each F-phase is split into commits (module, tests, API, UI, docs). Commit messages state the decision.
2026-10-13 | Master plan assumes `claude` ≥ 2.1.296 | The Mac has Claude Code 2.1.272; every flag the adapter passes (`--append-system-prompt --include-partial-messages --json-schema --mcp-config --output-format --permission-mode --permission-prompts --resume --settings --verbose`) is present in its `--help` | No adapter change. `--permission-prompts` needs ≥ 2.1.259, satisfied.
2026-10-13 | node-pty "compiles during npm install" on macOS | npm installs node-pty 1.1.0 from prebuilds and ships `darwin-arm64/spawn-helper` as 0644, so every `pty.spawn` dies with `posix_spawnp failed` | `scripts/postinstall.mjs` chmods it 0755 after every install; README "macOS notes".
