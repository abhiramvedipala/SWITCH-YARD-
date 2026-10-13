# Switchyard — Progress

`APP_NAME = "Switchyard"`. This file is the resume point: if a session ends,
start a new one in this folder and continue from the first unchecked item
below.

## Environment note (read first)

This repo was built inside a **cloud Linux x86_64 container** (a Claude Code
remote session tied to a GitHub repo), not the owner's Mac that the original
build brief assumes. Decisions that follow from that, confirmed with the
owner up front:

- Build everything that doesn't require the owner's local machine, real
  agent subscriptions, or macOS-only APIs — commit it to this repo phase by
  phase, exactly as the brief's working rules describe.
- Document Phase 8 (Tailscale phone access) and most of Phase 9 (menu-bar/
  notch widget, Electron packaging, real sign-ins) as **owner to-do**, since
  they are structurally tied to the owner's own Mac, network, and accounts.
- `agy` (Google Antigravity CLI) is not installed here and has no way to do
  an interactive browser sign-in in this container. All automated
  development and testing uses the `mock` harness per working rule #4 and
  #9. Real-agent manual DoDs are written up for the owner to run themselves.
- Native modules (`node-pty`, `better-sqlite3`) are built here against Linux
  x86_64 for development only; npm will rebuild them automatically against
  macOS arm64 when the owner runs `npm install` on their own Mac. No
  prebuilt binaries are committed.

## Owner to-do

Things only the owner can do, with exact commands:

- [ ] Install Antigravity CLI: `curl -fsSL https://antigravity.google/cli/install.sh | bash`
- [ ] Sign in once, interactively: `agy` (opens a browser; caches the token
      in Keychain) — do this on your Mac, not in a cloud session.
- [ ] Sign in to Claude Code once, interactively, on your Mac: `claude`
- [ ] Clone this repo to your Mac and run `npm install` there so native
      modules build for macOS arm64.
- [ ] Phase 3 manual DoD (real agents) — exact steps will be written here
      when Phase 3 lands.
- [ ] Phase 6 manual DoD (real run) — exact steps will be written here when
      Phase 6 lands.
- [ ] Phase 7 manual DoD (resume a real Claude Code session) — written here
      when Phase 7 lands.
- [ ] Phase 8 (Tailscale phone access) and Phase 9 (menu-bar widget,
      Electron shell, worktree button, voice) — these need your Mac,
      your Tailscale network, and your own call on whether you want them at
      all. Written up as a punch list when earlier phases are done.

## Phases

- [x] **Phase 0** — Scaffold
- [ ] **Phase 1** — Terminals
- [ ] **Phase 2** — Canvas + workspaces + Focus mode + Board skeleton
- [ ] **Phase 3** — Agent nodes + Bus
- [ ] **Phase 4** — Status + attention
- [ ] **Phase 5** — Board
- [ ] **Phase 6** — Driven mode, Project Chat, Runs
- [ ] **Phase 7** — Sessions
- [ ] **Phase 8** — Phone access + hardening (owner to-do, see above)
- [ ] **Phase 9** — Optional extras (owner to-do / decision, see above)

## Deviations from the brief (logged per working rule #8)

- `npm run dev` runs `vite build --watch` for the web package instead of
  Vite's HMR dev server, so core can serve `packages/web/dist` directly on
  `127.0.0.1:4777` in both dev and prod — matching the Phase 0 DoD exactly
  ("`npm run dev` → `http://127.0.0.1:4777` shows login page"). Trade-off:
  no hot module reload yet; full rebuild on save (~1s). Revisit if iteration
  speed on the web package becomes painful — a dev-time proxy from core to
  a real Vite dev server is the natural upgrade.
- Added `tsx` (run TS directly, no separate build step for core's dev loop)
  and `globals` (Node/browser globals for ESLint's flat-config `no-undef`)
  beyond the brief's dependency list — both tiny, mainstream dev tooling.
- Bumped `@fastify/static` to `^10.1.6` and `vitest` to `^5.0.4` (the
  versions in `npm audit`'s fix) because the brief doesn't pin versions and
  the first ones installed had known path-traversal/RCE advisories in
  their dependency trees. `npm audit` is clean at `0 vulnerabilities`.

## Phase log

### Phase 0 — Scaffold (done)

**What changed:** npm workspace with `packages/core` (Fastify server) and
`packages/web` (React + Vite). Core generates a one-time UI token on first
start (`~/.switchyard/ui-session`, `0600`), exposes `/api/auth/login` and
`/api/auth/check`, serves the built web app with an SPA fallback, and binds
only to `127.0.0.1:4777`. Web app shows a login screen until a valid token
is stored in `localStorage`, then an empty-canvas placeholder. ESLint
(flat config), Prettier, and a Vitest unit test for the constant-time token
comparison are wired up; `npm audit` is clean.

**How to try it:**
```bash
npm install
npm run build && npm start   # or: npm run dev
# terminal prints a token; open http://127.0.0.1:4777, paste it in
```
You should see the login card, and after submitting the correct token, the
"Empty canvas — add a node to get started." placeholder.

**Verified for this commit:** `npm run build`, `npm test`, `npm run lint`,
and a manual HTTP walkthrough (wrong token → 401, correct token → 200,
`/api/auth/check` without a token → 401, static asset + SPA-fallback route
both → 200, token file is `0600`, listening socket confirmed bound to
`127.0.0.1` only via `/proc/net/tcp`).
