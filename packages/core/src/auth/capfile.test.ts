import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveNodeId,
  loadRunFile,
  capFileProblem,
  BusClient,
} from '../../../bus-mcp/src/client.js';

// bus-mcp's identity resolution, exercised against a throwaway SWITCHYARD_HOME (no core, no network).
const home = mkdtempSync(join(tmpdir(), 'sy-capfile-'));
const run = join(home, 'run');
mkdirSync(run, { recursive: true, mode: 0o700 });
const rf = (nodeId: string, capability: string) =>
  JSON.stringify({ nodeId, workspaceId: 'w', coreUrl: 'http://127.0.0.1:1', capability });
const write = (name: string, content: string, mode = 0o600) => {
  const p = join(run, name);
  writeFileSync(p, content, { mode });
  chmodSync(p, mode);
  return p;
};
const fileA = write('A.json', rf('A', 'cap-A'));
const fileB = write('B.json', rf('B', 'cap-B'));
const loose = write('loose.json', rf('L', 'cap-L'), 0o644);
const link = join(run, 'link.json');
symlinkSync(fileA, link);

process.env.SWITCHYARD_HOME = home;
afterEach(() => {
  delete process.env.SWITCHYARD_CAPFILE;
  delete process.env.SWITCHYARD_NODE;
});

describe('bus-mcp identity: SWITCHYARD_CAPFILE', () => {
  it('reads node id and capability from the 0600 file alone (no SWITCHYARD_NODE needed)', () => {
    process.env.SWITCHYARD_CAPFILE = fileA;
    expect(resolveNodeId()).toBe('A');
    expect(loadRunFile('A').capability).toBe('cap-A');
    expect(new BusClient('A').nodeId).toBe('A');
  });

  it('refuses a file that is not 0600 with a clear error and falls back to SWITCHYARD_NODE', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      process.env.SWITCHYARD_CAPFILE = loose;
      process.env.SWITCHYARD_NODE = 'A';
      expect(capFileProblem(loose)).toMatch(/not 0600/);
      expect(resolveNodeId()).toBe('A');
      expect(loadRunFile('A').capability).toBe('cap-A'); // from <home>/run/A.json, not the loose file
      expect(String(err.mock.calls[0]?.[0])).toMatch(/ignoring SWITCHYARD_CAPFILE .*not 0600/);
    } finally {
      err.mockRestore();
    }
  });

  it('refuses a missing file and a symlink; a literal "$SWITCHYARD_CAPFILE" counts as unset', () => {
    expect(capFileProblem(join(run, 'nope.json'))).toBe('file does not exist');
    expect(capFileProblem(link)).toBe('not a regular file');
    expect(capFileProblem(fileA)).toBeNull();
    process.env.SWITCHYARD_CAPFILE = '$SWITCHYARD_CAPFILE';
    process.env.SWITCHYARD_NODE = 'B';
    expect(resolveNodeId()).toBe('B');
  });

  it("spoof: a process holding node B's capfile is B and cannot act as A", () => {
    process.env.SWITCHYARD_CAPFILE = fileB;
    process.env.SWITCHYARD_NODE = 'A';
    expect(resolveNodeId()).toBe('B');
    expect(() => loadRunFile('A')).toThrow(/belongs to node B, not A/);
    expect(() => new BusClient('A')).toThrow(/belongs to node B/);
    expect(new BusClient('B').nodeId).toBe('B');
  });
});
