import { defineConfig } from 'vitest/config';

// Running `npx vitest run` from the repo root must not pick up tests inside
// agent worktrees (.claude/worktrees/*) or the scratch playground.
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**', 'scratch/**', 'switchyard/**'],
  },
});
