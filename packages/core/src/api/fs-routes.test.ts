import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

// The Files block routes: every path is realpath'd inside the node's workspace folder; writes are local-only,
// mtime-checked, size-capped and refused inside Switchyard's own folders.
type Built = Awaited<ReturnType<typeof import('../server.js').buildServer>>;
const PORT = 4797;
let built: Built;
let home: string;
let root: string;
let outside: string;
let filesNode: string;
let noteNode: string;
let homeNode: string;
let homeNodeAllowed: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'sy-fsroutes-home-'));
  process.env.SWITCHYARD_HOME = home;
  const { buildServer } = await import('../server.js');
  built = await buildServer({
    port: PORT,
    dbPath: ':memory:',
    quiet: true,
    whois: async (ip) => (ip === '100.64.0.9' ? 'phone@x' : null),
  });
  const { store, nodes } = built.core;
  root = mkdtempSync(join(tmpdir(), 'sy-fs-ws-'));
  outside = mkdtempSync(join(tmpdir(), 'sy-fs-outside-'));
  writeFileSync(join(root, 'README.md'), '# hi\n');
  writeFileSync(join(root, '.env'), 'SECRET=1\n');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'blob.bin'), Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28]));
  writeFileSync(join(root, 'big.txt'), 'x'.repeat(1024 * 1024 + 1));
  writeFileSync(join(root, 'dot.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  writeFileSync(join(outside, 'secret.txt'), 'not yours\n');
  symlinkSync(join(outside, 'secret.txt'), join(root, 'escape.txt'));
  symlinkSync(outside, join(root, 'escape-dir'));
  const ws = store.createWorkspace('ws', root);
  filesNode = nodes.create(ws.id, { type: 'files' }).id;
  noteNode = nodes.create(ws.id, { type: 'note' }).id;
  // A workspace inside ~/.switchyard (the temp one): writes need the own-folder confirmation.
  writeFileSync(join(home, 'own.txt'), 'private\n');
  const own = store.createWorkspace('own', home);
  expect(() => nodes.create(own.id, { type: 'files' })).toThrow(/private data folder/);
  homeNodeAllowed = nodes.create(own.id, { type: 'files', allowOwnFolder: true }).id;
  homeNode = store.insertNode({
    workspaceId: own.id,
    type: 'files',
    harness: null,
    title: 'Files (unconfirmed)',
    cwd: null,
    x: 0,
    y: 0,
    w: 1,
    h: 1,
    state: 'idle',
    sessionRef: null,
    yolo: false,
    data: {},
    summary: '',
  }).id;
});
afterAll(async () => {
  await built.app.close();
});

/** The outside folder, reached with `..` from the workspace. */
const sibling = () => join('..', basename(outside), 'secret.txt');
const q = (o: Record<string, string>) => new URLSearchParams(o).toString();
const call = (method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown, phone = false) =>
  built.app.inject({
    method,
    url,
    payload: payload as never,
    headers: {
      host: `127.0.0.1:${PORT}`,
      authorization: `Bearer ${built.token}`,
      ...(phone ? { 'x-forwarded-for': '100.64.0.9', 'tailscale-user-login': 'phone@x' } : {}),
    },
  });
const tree = (path: string, extra: Record<string, string> = {}, phone = false) =>
  call('GET', `/api/fs/tree?${q({ nodeId: filesNode, path, ...extra })}`, undefined, phone);
const read = (path: string, nodeId = filesNode) =>
  call('GET', `/api/fs/read?${q({ nodeId, path })}`);
const write = (
  body: { path: string; text: string; expectedMtime: number; nodeId?: string },
  phone = false,
) => call('PUT', '/api/fs/write', { nodeId: filesNode, ...body }, phone);

describe('GET /api/fs/tree', () => {
  it('lists one level, folders first, hiding node_modules, dist and dotfiles', async () => {
    const r = await tree('');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      path: '',
      entries: [
        { name: 'escape-dir', dir: true },
        { name: 'src', dir: true },
        { name: 'big.txt', dir: false },
        { name: 'blob.bin', dir: false },
        { name: 'dot.png', dir: false },
        { name: 'escape.txt', dir: false },
        { name: 'README.md', dir: false },
      ],
    });
    const sub = (await tree('src')).json();
    expect(sub).toEqual({ path: 'src', entries: [{ name: 'a.ts', dir: false }] });
  });
  it('?dotfiles=1 shows dotfiles but never node_modules, .git or dist', async () => {
    const names = (await tree('', { dotfiles: '1' }))
      .json()
      .entries.map((e: { name: string }) => e.name);
    expect(names).toContain('.env');
    expect(names).not.toContain('node_modules');
    expect(names).not.toContain('dist');
  });
  it('only a Files node may be named; unknown paths are 404', async () => {
    const other = await call('GET', `/api/fs/tree?${q({ nodeId: noteNode, path: '' })}`);
    expect(other.statusCode).toBe(404);
    expect(other.json().error).toBe('unknown_node');
    expect((await tree('nope')).statusCode).toBe(404);
  });
  it('a phone session can read the tree', async () => {
    expect((await tree('src', {}, true)).statusCode).toBe(200);
  });
});

describe('GET /api/fs/read: inside the workspace only', () => {
  it('returns UTF-8 text with its mtime', async () => {
    const r = (await read('src/a.ts')).json();
    expect(r).toMatchObject({ kind: 'text', path: 'src/a.ts', text: 'export const a = 1;\n' });
    expect(r.mtime).toBe(statSync(join(root, 'src', 'a.ts')).mtimeMs);
  });
  it('refuses .. and absolute paths outside the folder', async () => {
    for (const p of [sibling(), join(outside, 'secret.txt'), '/etc/hosts', '../../']) {
      const r = await read(p);
      expect(r.statusCode, p).toBe(403);
      expect(r.json().error).toBe('outside_workspace');
      expect(r.body).not.toContain('not yours');
    }
  });
  it('refuses symlinks that escape the folder (file and directory)', async () => {
    expect((await read('escape.txt')).statusCode).toBe(403);
    expect((await read('escape-dir/secret.txt')).statusCode).toBe(403);
    expect((await tree('escape-dir')).statusCode).toBe(403);
  });
  it('shows size only for binaries and files over 1 MB; images come as a data URL', async () => {
    expect((await read('blob.bin')).json()).toMatchObject({ kind: 'binary', size: 5 });
    const big = (await read('big.txt')).json();
    expect(big).toMatchObject({ kind: 'binary', size: 1024 * 1024 + 1 });
    expect(big.text).toBeUndefined();
    expect((await read('dot.png')).json()).toMatchObject({
      kind: 'image',
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    });
  });
});

describe('PUT /api/fs/write', () => {
  it('writes when the mtime matches and returns the new one; a stale mtime is a 409', async () => {
    const before = (await read('README.md')).json();
    const ok = await write({ path: 'README.md', text: '# hello\n', expectedMtime: before.mtime });
    expect(ok.statusCode).toBe(200);
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('# hello\n');
    expect(ok.json().mtime).toBe(statSync(join(root, 'README.md')).mtimeMs);
    const stat = await call('GET', `/api/fs/stat?${q({ nodeId: filesNode, path: 'README.md' })}`);
    expect(stat.json()).toEqual({ mtime: ok.json().mtime, size: 8 });
    const stale = await write({ path: 'README.md', text: '# lost\n', expectedMtime: before.mtime });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('stale');
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('# hello\n');
  });
  it('never writes outside the folder or through an escaping symlink', async () => {
    const mt = statSync(join(outside, 'secret.txt')).mtimeMs;
    for (const path of ['escape.txt', sibling(), join(outside, 'secret.txt')]) {
      const r = await write({ path, text: 'pwned', expectedMtime: mt });
      expect(r.statusCode, path).toBe(403);
    }
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('not yours\n');
  });
  it('caps the text at 1 MB', async () => {
    const mt = statSync(join(root, 'README.md')).mtimeMs;
    const r = await write({
      path: 'README.md',
      text: 'y'.repeat(1024 * 1024 + 1),
      expectedMtime: mt,
    });
    expect(r.statusCode).toBe(400);
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('# hello\n');
  });
  it('is refused from a phone, with remote read-only on or off', async () => {
    const mt = statSync(join(root, 'README.md')).mtimeMs;
    const ro = await write({ path: 'README.md', text: 'phone', expectedMtime: mt }, true);
    expect(ro.statusCode).toBe(403);
    expect(ro.json().error).toBe('read_only');
    const { setSetting } = await import('../db/index.js');
    setSetting(built.core.db, 'remoteReadOnly', false);
    const rw = await write({ path: 'README.md', text: 'phone', expectedMtime: mt }, true);
    expect(rw.statusCode).toBe(403);
    expect(rw.json().error).toBe('local_only');
    setSetting(built.core.db, 'remoteReadOnly', true);
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('# hello\n');
    const reveal = await call(
      'POST',
      '/api/fs/reveal',
      { nodeId: filesNode, path: 'README.md' },
      true,
    );
    expect(reveal.statusCode).toBe(403);
  });
  it("refuses Switchyard's own folders unless the node was added with the confirmation", async () => {
    const mt = statSync(join(home, 'own.txt')).mtimeMs;
    const refused = await write({
      nodeId: homeNode,
      path: 'own.txt',
      text: 'x',
      expectedMtime: mt,
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().message).toMatch(/private data folder/);
    expect(readFileSync(join(home, 'own.txt'), 'utf8')).toBe('private\n');
    expect(built.core.store.getNode(homeNodeAllowed)!.data.allowOwnFolder).toBe(true);
    const ok = await write({
      nodeId: homeNodeAllowed,
      path: 'own.txt',
      text: 'x',
      expectedMtime: mt,
    });
    expect(ok.statusCode).toBe(200);
    expect(readFileSync(join(home, 'own.txt'), 'utf8')).toBe('x');
  });
});
