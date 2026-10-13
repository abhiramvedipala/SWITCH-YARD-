# Decisions and doc-vs-reality notes

Format: `date | claim | reality | what I did`.

2026-10-13 | The brief assumed agy allow rules could be scoped to a run folder | agy's permissions docs (antigravity.google/docs/permissions) say rules live in ONE global file, `~/.gemini/antigravity-cli/settings.json`, and describe no workspace-level CLI file | `write_file(<dir>/)` is per folder, but `command(regex:…)` test-runner rules are global. The Settings button says so, and Remove deletes only rules Switchyard added (tracked in `~/.switchyard/agy-owned-rules.json`).
2026-10-13 | MCP tools in agy | The docs say MCP tools default to Ask; `mcp(server/*)` allows all tools of a server | Opt-in button adds `mcp(switchyard/*)`.
2026-10-13 | F2 guard scope | A guard on every node would break plain shells and the mock agent used by tests | The own-folder guard applies to claude/agy nodes and to runs on a workspace folder only; `allowOwnFolder` overrides it explicitly.
2026-10-13 | Granular commits | Owner asked for one small commit per step or decision so the history is easy to follow | Each F-phase is split into commits (module, tests, API, UI, docs). Commit messages state the decision.
