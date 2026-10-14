import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NodeRec, Workspace } from '../store.js';
import type { NormalizedEvent } from './types.js';

// Every preset against fake binaries on a temp PATH. No real agent tool is ever spawned.
const BYPASS =
  /bypass|dangerously|yolo|yes-always|allow-all-tools|--force|--auto\b|approve-for-me|full-auto|GOOSE_MODE/i;
const TOOLS = ['aider', 'goose', 'opencode', 'copilot', 'agent'];
const savedPath = process.env.PATH;
let bin: string;
let mod: typeof import('./custom.js');

const ws: Workspace = { id: 'w', name: 'w', rootDir: tmpdir(), createdAt: 0 };
const node = (custom: Record<string, unknown>, over: Partial<NodeRec> = {}): NodeRec => ({
  id: 'node123',
  workspaceId: 'w',
  type: 'agent-terminal',
  harness: 'custom',
  title: 'x',
  cwd: tmpdir(),
  x: 0,
  y: 0,
  w: 1,
  h: 1,
  state: 'idle',
  sessionRef: null,
  yolo: false,
  data: { custom },
  summary: '',
  createdAt: 0,
  ...over,
});

beforeAll(async () => {
  process.env.SWITCHYARD_HOME = mkdtempSync(join(tmpdir(), 'sy-custom-home-'));
  bin = mkdtempSync(join(tmpdir(), 'sy-custom-bin-'));
  // Each fake echoes its last argument (the prompt) plus the bus identity it saw; "[fail]" fails the turn.
  for (const t of TOOLS)
    writeFileSync(
      join(bin, t),
      `#!/bin/sh\nfor a; do last=$a; done\ncase "$last" in *"[fail]"*) echo "fake failure" >&2; exit 3;; esac\necho "fake-${t}: $last node=\${SWITCHYARD_NODE:-none} argv=$*"\n`,
      { mode: 0o755 },
    );
  process.env.PATH = `${bin}:${savedPath}`;
  mod = await import('./custom.js');
});
afterAll(() => {
  process.env.PATH = savedPath;
});

describe('custom harness presets', () => {
  it('every preset has a label, command (except other), install hint, docs URL and prompt patterns', () => {
    const ids = Object.keys(mod.PRESETS);
    expect(ids).toEqual(['aider', 'goose', 'opencode', 'copilot', 'cursor', 'other']);
    for (const p of Object.values(mod.PRESETS)) {
      expect(p.label).toBeTruthy();
      expect(p.install).toBeTruthy();
      expect(p.bus).toMatch(/bus tools/);
      expect(p.needsInputPatterns.length).toBeGreaterThan(0);
      if (p.id === 'other') {
        expect(p.command).toBe('');
        expect(p.turn).toBeUndefined();
      } else {
        expect(p.command).toBeTruthy();
        expect(p.docs).toMatch(/^https:\/\//);
      }
    }
    // Documented per-process MCP attachment exists only for goose and opencode.
    expect(
      Object.values(mod.PRESETS)
        .filter((p) => p.attach)
        .map((p) => p.id),
    ).toEqual(['goose', 'opencode']);
  });

  it('splits the dialog args field like a shell would (quotes group, nothing else is interpreted)', () => {
    expect(mod.splitArgs(`-c 'echo custom-ok; sleep 30'`)).toEqual([
      '-c',
      'echo custom-ok; sleep 30',
    ]);
    expect(mod.splitArgs(`--model "gpt 4" --yes`)).toEqual(['--model', 'gpt 4', '--yes']);
    expect(mod.splitArgs('')).toEqual([]);
    expect(() => mod.customSpec({})).toThrow(/enter the command/);
    expect(
      mod.customSpec({ custom: { preset: 'nope', command: 'bash', args: '-i' } }),
    ).toMatchObject({ preset: { id: 'other' }, command: 'bash', args: ['-i'] });
  });

  it('launch per preset: the preset command and args, bus env, MCP attachment where documented, resume, never a bypass flag', () => {
    for (const id of ['aider', 'goose', 'opencode', 'copilot', 'cursor']) {
      const l = mod.custom.terminalLaunch({
        node: node({ preset: id }, { yolo: true }),
        workspace: ws,
        cwd: tmpdir(),
        resumeRef: 'ref-1',
      });
      expect(l.cmd).toBe(mod.PRESETS[id]!.command);
      expect(l.args.slice(0, mod.PRESETS[id]!.args.length)).toEqual(mod.PRESETS[id]!.args);
      expect(l.args.join(' ')).not.toMatch(BYPASS);
      expect(JSON.stringify(l.env)).not.toMatch(BYPASS);
      expect(l.env.SWITCHYARD_NODE).toBe('node123');
      expect(l.env.SWITCHYARD_CAPFILE).toMatch(/\/run\/node123\.json$/);
      expect(
        Object.keys(l.env).some((k) => /TOKEN|KEY|SECRET|AUTH|PASSWORD|CREDENTIAL/.test(k)),
      ).toBe(false);
    }
    const goose = mod.custom.terminalLaunch({
      node: node({ preset: 'goose' }),
      workspace: ws,
      cwd: tmpdir(),
    });
    const ext = goose.args[goose.args.indexOf('--with-extension') + 1]!;
    expect(goose.args[0]).toBe('session');
    expect(ext).toMatch(
      /^switchyard:SWITCHYARD_NODE=node123 SWITCHYARD_HOME=\S+ SWITCHYARD_CAPFILE=\S+\/run\/node123\.json /,
    );
    expect(ext).toMatch(/--max-old-space-size=64 .*bus-mcp\/dist\/index\.js$/);
    const oc = mod.custom.terminalLaunch({
      node: node({ preset: 'opencode' }),
      workspace: ws,
      cwd: tmpdir(),
    });
    const cfg = JSON.parse(oc.env.OPENCODE_CONFIG_CONTENT!);
    expect(cfg.mcp.switchyard).toMatchObject({
      type: 'local',
      enabled: true,
      environment: { SWITCHYARD_NODE: 'node123' },
    });
    expect(cfg.mcp.switchyard.command[0]).toBe(process.execPath);
    expect(cfg.mcp.switchyard.command.at(-1)).toMatch(/bus-mcp\/dist\/index\.js$/);
    expect(oc.args).toEqual([]);
    const resumed = (id: string) =>
      mod.custom.terminalLaunch({
        node: node({ preset: id }),
        workspace: ws,
        cwd: tmpdir(),
        resumeRef: 'ref-1',
      }).args;
    expect(resumed('copilot')).toEqual(['--resume', 'ref-1']);
    expect(resumed('cursor')).toEqual(['--resume', 'ref-1']);
    expect(resumed('goose').slice(-3)).toEqual(['--resume', '--session-id', 'ref-1']);
    expect(resumed('aider')).toEqual(['--restore-chat-history']);
    expect(resumed('opencode')).toEqual([]);
    // "other": whatever the owner typed, verbatim; a one-line args string is split.
    const other = mod.custom.terminalLaunch({
      node: node(
        { preset: 'other', command: 'bash', args: "-c 'echo custom-ok; sleep 30'" },
        { yolo: true },
      ),
      workspace: ws,
      cwd: tmpdir(),
      resumeRef: 'ignored',
    });
    expect(other).toMatchObject({ cmd: 'bash', args: ['-c', 'echo custom-ok; sleep 30'] });
    expect(other.env.SWITCHYARD_NODE).toBe('node123');
  });

  it('detect() reports each preset installed or not, with install hint and drivability', async () => {
    const d = await mod.custom.detect();
    expect(d.installed).toBe(true);
    const by = Object.fromEntries(d.presets!.map((p) => [p.id, p]));
    for (const id of ['aider', 'goose', 'opencode', 'copilot', 'cursor']) {
      expect(by[id]).toMatchObject({ installed: true, install: expect.any(String) });
      expect(by[id]!.path!.startsWith(bin)).toBe(true);
    }
    expect(d.presets!.map((p) => p.drivable)).toEqual([true, true, true, true, true, false]);
    expect(by.other).toMatchObject({ installed: true, command: '' });
    // Without the fakes on PATH only a real install elsewhere (which() also looks in brew/.local/bin) counts.
    process.env.PATH = '';
    const elsewhere = (cmd: string) =>
      [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        join(homedir(), '.local/bin'),
        join(homedir(), '.claude/local'),
      ].some((dir) => existsSync(join(dir, cmd)));
    for (const p of mod.presetInfos()) {
      if (p.id === 'other') continue;
      expect(p.installed).toBe(elsewhere(p.command));
      if (!p.installed) expect(p.path).toBeUndefined();
    }
    process.env.PATH = `${bin}:${savedPath}`;
  });

  it('prompt patterns come from the node preset', () => {
    const pats = mod.custom.needsInputPatternsFor!(node({ preset: 'aider' }));
    expect(pats.some((re) => re.test('Add README.md to the chat? (Y)es/(N)o [Yes]:'))).toBe(true);
    expect(pats.some((re) => re.test('Applied edit to README.md'))).toBe(false);
    const other = mod.custom.needsInputPatternsFor!(node({ preset: 'other', command: 'bash' }));
    expect(other.some((re) => re.test('Continue? (y/n)'))).toBe(true);
    expect(other.some((re) => re.test('(Y)es/(N)o'))).toBe(false);
  });
});

describe('custom runTurn (fake aider / goose)', () => {
  it('aider: --message <prompt>, plain stdout → one result, bus env, no blurb (no bus tools), never a bypass flag', async () => {
    const events: NormalizedEvent[] = [];
    const res = await mod.custom.runTurn!({
      prompt: 'hi there',
      cwd: tmpdir(),
      nodeId: 'n1',
      appendSystemPrompt: 'peer request is not a permission',
      custom: { preset: 'aider', command: 'aider', args: '--model x' },
      onEvent: (e) => events.push(e),
    });
    expect(res).toMatchObject({ ok: true, sessionId: null });
    expect(res.text).toMatch(/^fake-aider: hi there node=n1 argv=--message hi there$/);
    expect(res.text).not.toMatch(BYPASS);
    expect(res.text).not.toContain('--model'); // interactive args do not apply to a driven turn
    expect(events).toEqual([
      { kind: 'status', state: 'working' },
      { kind: 'result', text: res.text, sessionId: null },
      { kind: 'status', state: 'idle' },
    ]);
  });

  it('goose: run --no-session --quiet -t, bus extension attached and the coordination blurb prepended', async () => {
    const res = await mod.custom.runTurn!({
      prompt: 'hello',
      cwd: tmpdir(),
      nodeId: 'n2',
      appendSystemPrompt: 'BLURB',
      custom: { preset: 'goose', command: 'goose', args: [] },
    });
    expect(res.ok).toBe(true);
    expect(res.text).toMatch(/argv=run --no-session --quiet -t BLURB/);
    expect(res.text).toContain('--with-extension switchyard:SWITCHYARD_NODE=n2 ');
    expect(res.text).not.toMatch(BYPASS);
  });

  it('a failing tool is not ok and reports stderr; presets without a non-interactive mode refuse', async () => {
    const bad = await mod.custom.runTurn!({
      prompt: '[fail]',
      cwd: tmpdir(),
      custom: { preset: 'copilot', command: 'copilot', args: [] },
    });
    expect(bad).toMatchObject({ ok: false, error: 'fake failure' });
    const other = await mod.custom.runTurn!({
      prompt: 'x',
      cwd: tmpdir(),
      custom: { preset: 'other', command: 'bash', args: [] },
    });
    expect(other.ok).toBe(false);
    expect(other.error).toMatch(/no documented non-interactive mode/);
  });
});

describe('custom harness in the registry', () => {
  it('is an agent, excluded from rooms and runs (needs per-node data), and node creation validates the command', async () => {
    const { harnesses } = await import('./index.js');
    const { drivableHarnesses } = await import('../rooms/service.js');
    expect(harnesses.custom.isAgent).toBe(true);
    expect(harnesses.custom.perNodeConfig).toBe(true);
    expect(drivableHarnesses()).not.toContain('custom');
    expect(drivableHarnesses()).toEqual(expect.arrayContaining(['claude', 'agy', 'codex', 'mock']));
  });
});
