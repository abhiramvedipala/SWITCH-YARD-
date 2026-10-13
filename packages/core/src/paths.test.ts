import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let paths: typeof import('./paths.js');
let home: string;
let scratch: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'sy-paths-home-'));
  scratch = join(home, 'scratch');
  mkdirSync(scratch, { recursive: true });
  process.env.SWITCHYARD_HOME = home;
  delete process.env.SWITCHYARD_SCRATCH_ROOT;
  paths = await import('./paths.js');
});

describe('unsafeCwdReason', () => {
  it('allows ordinary folders and the scratch root', () => {
    expect(paths.unsafeCwdReason(tmpdir())).toBeNull();
    expect(paths.unsafeCwdReason(join(scratch, 'run-1'))).toBeNull();
  });
  it("refuses the app's own repo and its private data folder (but not scratch/)", () => {
    expect(paths.unsafeCwdReason(paths.REPO_ROOT)).toMatch(/own folder/);
    expect(paths.unsafeCwdReason(join(paths.REPO_ROOT, 'packages/core'))).toMatch(/own folder/);
    expect(paths.unsafeCwdReason(paths.SWITCHYARD_HOME)).toMatch(/private data/);
    expect(paths.unsafeCwdReason(join(paths.SWITCHYARD_HOME, 'run'))).toMatch(/private data/);
  });
  it('resolves symlinks before deciding', () => {
    const link = join(mkdtempSync(join(tmpdir(), 'sy-link-')), 'sneaky');
    symlinkSync(paths.REPO_ROOT, link);
    expect(paths.unsafeCwdReason(link)).toMatch(/own folder/);
  });
  it('assertSafeCwd can be overridden explicitly', () => {
    expect(() => paths.assertSafeCwd(paths.REPO_ROOT)).toThrow(/own folder/);
    expect(() => paths.assertSafeCwd(paths.REPO_ROOT, true)).not.toThrow();
  });
});
