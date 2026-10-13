import { createHash } from 'node:crypto';
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { runCapture, which } from '../harness/util.js';

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'build',
  '.pytest_cache',
  '.next',
  '.cache',
]);
const MAX_FILES = 5000;

export type Snapshot = Map<string, string>;

export function snapshot(root: string): Snapshot {
  const snap: Snapshot = new Map();
  const walk = (dir: string) => {
    if (snap.size >= MAX_FILES) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (snap.size >= MAX_FILES) return;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(p);
      } else if (st.isFile()) {
        let sig = `${st.size}:${st.mtimeMs}`;
        if (st.size < 1024 * 1024) {
          try {
            sig = createHash('sha1').update(readFileSync(p)).digest('hex');
          } catch {
            // unreadable file: fall back to size+mtime
          }
        }
        snap.set(relative(root, p), sig);
      }
    }
  };
  walk(root);
  return snap;
}

export function diffSnapshots(before: Snapshot, after: Snapshot) {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [f, sig] of after) {
    if (!before.has(f)) added.push(f);
    else if (before.get(f) !== sig) modified.push(f);
  }
  for (const f of before.keys()) if (!after.has(f)) deleted.push(f);
  return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort() };
}

export async function gitEvidence(
  cwd: string,
): Promise<{ diffStat: string; status: string } | null> {
  const inside = await runCapture('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return null;
  const stat = await runCapture('git', ['-C', cwd, 'diff', '--stat']);
  const status = await runCapture('git', ['-C', cwd, 'status', '--porcelain']);
  return { diffStat: stat.stdout.trim(), status: status.stdout.trim() };
}

/** A readable unified-ish view of what changed, for the reviewer prompt. */
export function changedFilesExcerpt(cwd: string, files: string[], maxBytes = 24_000): string {
  let out = '';
  for (const f of files) {
    const p = join(cwd, f);
    if (!existsSync(p)) {
      out += `\n--- ${f} (deleted)\n`;
      continue;
    }
    let content = '';
    try {
      content = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    const chunk = `\n--- ${f}\n${content.slice(0, 8000)}\n`;
    if (out.length + chunk.length > maxBytes) {
      out += `\n[... ${files.length} files changed, excerpt truncated ...]\n`;
      break;
    }
    out += chunk;
  }
  return out.trim();
}

export interface TestEvidence {
  command?: string;
  exitCode?: number | null;
  output?: string;
  unverified?: string;
}

function hasPythonTests(cwd: string): boolean {
  const s = snapshot(cwd);
  for (const f of s.keys()) {
    const base = f.split('/').pop() ?? '';
    if (/^test_.*\.py$/.test(base) || /_test\.py$/.test(base)) return true;
  }
  return false;
}

export async function runTests(cwd: string): Promise<TestEvidence> {
  if (hasPythonTests(cwd)) {
    const py = which('python3') ?? which('python');
    if (!py) return { unverified: 'Python tests found but no python3 on PATH' };
    const probe = await runCapture(py, ['-m', 'pytest', '--version'], { cwd });
    if (probe.code !== 0)
      return { unverified: 'Python tests found but pytest is not installed (pip install pytest)' };
    const r = await runCapture(py, ['-m', 'pytest', '-q'], { cwd, timeoutMs: 180_000 });
    return {
      command: 'python3 -m pytest -q',
      exitCode: r.code,
      output: (r.stdout + r.stderr).slice(-6000),
    };
  }
  const pkg = join(cwd, 'package.json');
  if (existsSync(pkg)) {
    try {
      const scripts =
        (JSON.parse(readFileSync(pkg, 'utf8')) as { scripts?: Record<string, string> }).scripts ??
        {};
      if (scripts.test && !/no test specified/.test(scripts.test)) {
        const r = await runCapture('npm', ['test', '--silent'], { cwd, timeoutMs: 300_000 });
        return {
          command: 'npm test',
          exitCode: r.code,
          output: (r.stdout + r.stderr).slice(-6000),
        };
      }
    } catch {
      // fall through
    }
  }
  return { unverified: 'No test suite detected, so tests were not run' };
}
