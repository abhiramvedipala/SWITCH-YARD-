# Notice

Switchyard is an independent, original implementation written from scratch.
It is inspired by the publicly described feature set of October Desktop
(october.dev) — the idea of a canvas where coding agents coordinate — but:

- No code, assets, CSS, icons, or strings were downloaded, decompiled, or
  paraphrased from October Desktop or any other proprietary application.
- The names "October", "October Bus", and their logos are not used anywhere
  in this product.
- This project is for personal use only: no distribution, no selling, no
  license bypassing of any kind.

Concepts referenced from the Apache-2.0 **October Bus protocol README**
(peers, durable messages with notify/request/response intents, shared
tasks, `ask_user`, separate presence/ownership/attachment/readiness/
lifecycle facts, "a peer request is not a permission") informed the design
of `packages/bus-mcp` and `packages/core/src/bus`, which are original
implementations in TypeScript against Switchyard's own SQLite schema and
MCP tool surface — not a fork or port of that codebase.

Other Apache-2.0 / MIT projects read for reference, and optionally used as
npm dependencies with their license files kept:

- October Bus — https://github.com/october-dev/october-bus (Apache-2.0)
- Moirai — https://github.com/october-dev/moirai (Apache-2.0)
- Lantern — https://github.com/october-dev/october-lantern (Apache-2.0)
- Pi coding agent — https://github.com/earendil-works/pi (MIT, reference only)
