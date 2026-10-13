// npm's tarball for node-pty 1.1.0 drops the exec bit on the macOS spawn-helper,
// which makes every pty.spawn fail with "posix_spawnp failed". Restore it.
import { chmodSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';

if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url);
  let helper;
  try {
    helper = require.resolve(`node-pty/prebuilds/darwin-${process.arch}/spawn-helper`);
  } catch {
    helper = null;
  }
  if (helper && existsSync(helper)) chmodSync(helper, 0o755);
}
