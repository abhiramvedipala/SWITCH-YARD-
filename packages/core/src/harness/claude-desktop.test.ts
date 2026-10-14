import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Never the real Claude Desktop config: every test points SWITCHYARD_CLAUDE_DESKTOP_CONFIG at a temp file.
type Mod = typeof import('./claude-desktop.js');
type Built = Awaited<ReturnType<typeof import('../server.js').buildServer>>;
let mod: Mod;
let home: string;
let cfgPath: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'sy-desktop-home-'));
  process.env.SWITCHYARD_HOME = home;
  mod = await import('./claude-desktop.js');
});
beforeEach(() => {
  cfgPath = join(mkdtempSync(join(tmpdir(), 'sy-desktop-cfg-')), 'claude_desktop_config.json');
  process.env.SWITCHYARD_CLAUDE_DESKTOP_CONFIG = cfgPath;
  expect(mod.claudeDesktopConfigPath().startsWith(tmpdir())).toBe(true);
});

const read = () => JSON.parse(readFileSync(cfgPath, 'utf8'));
const seed = (v: unknown) =>
  writeFileSync(cfgPath, typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const FOREIGN = {
  globalShortcut: 'Alt+Space',
  mcpServers: { filesystem: { command: 'npx', args: ['-y', 'fs-server', '/Users/me'] } },
  preferences: { menuBarEnabled: true, nested: { list: [1, 'two', null] } },
};

describe('Claude Desktop config writer', () => {
  it('adds only mcpServers.switchyard, keeps every foreign key, and backs up first', () => {
    seed(FOREIGN);
    const original = readFileSync(cfgPath, 'utf8');
    expect(mod.desktopEntryState()).toBe('absent');
    expect(mod.addDesktopEntry()).toEqual({ changed: true });
    expect(read()).toEqual({
      ...FOREIGN,
      mcpServers: { ...FOREIGN.mcpServers, switchyard: mod.desktopEntry() },
    });
    expect(readFileSync(`${cfgPath}.bak`, 'utf8')).toBe(original);
    expect(mod.desktopEntryState()).toBe('present');
  });

  it('the entry carries only paths: node binary, bus-mcp, SWITCHYARD_HOME and the capfile path', () => {
    const e = mod.desktopEntry();
    expect(e.command).toBe(process.execPath);
    expect(e.args.at(-1)).toMatch(/packages\/bus-mcp\/dist\/index\.js$/);
    expect(e.env).toEqual({
      SWITCHYARD_HOME: home,
      SWITCHYARD_CAPFILE: join(home, 'run', 'claude-desktop.json'),
    });
  });

  it('is idempotent and makes the .bak once (it keeps the pre-Switchyard file)', () => {
    seed(FOREIGN);
    const original = readFileSync(cfgPath, 'utf8');
    mod.addDesktopEntry();
    const after = readFileSync(cfgPath, 'utf8');
    expect(mod.addDesktopEntry()).toEqual({ changed: false });
    expect(readFileSync(cfgPath, 'utf8')).toBe(after);
    mod.removeDesktopEntry();
    mod.addDesktopEntry();
    expect(readFileSync(`${cfgPath}.bak`, 'utf8')).toBe(original);
  });

  it('creates the file when Claude Desktop has none yet, without a .bak', () => {
    mod.addDesktopEntry();
    expect(read()).toEqual({ mcpServers: { switchyard: mod.desktopEntry() } });
    expect(existsSync(`${cfgPath}.bak`)).toBe(false);
  });

  it('refuses invalid JSON (and a non-object mcpServers) without touching the file', () => {
    for (const bad of ['{ nope', '[1,2]', '{"mcpServers": ["x"]}']) {
      seed(bad);
      expect(mod.desktopEntryState()).toBe('invalid');
      expect(() => mod.addDesktopEntry()).toThrow(/is not valid JSON; refusing to overwrite it/);
      expect(() => mod.removeDesktopEntry()).toThrow(/refusing to overwrite/);
      expect(readFileSync(cfgPath, 'utf8')).toBe(bad);
      expect(existsSync(`${cfgPath}.bak`)).toBe(false);
    }
  });

  it('refuses to create the Claude folder when Claude Desktop is not installed', () => {
    process.env.SWITCHYARD_CLAUDE_DESKTOP_CONFIG = join(cfgPath, '..', 'no-such-dir', 'c.json');
    expect(() => mod.addDesktopEntry()).toThrow(/does not look installed/);
  });

  it('remove reverts exactly: foreign servers kept, an mcpServers block it created is dropped', () => {
    seed(FOREIGN);
    mod.addDesktopEntry();
    expect(mod.removeDesktopEntry()).toEqual({ changed: true });
    expect(read()).toEqual(FOREIGN);
    expect(mod.desktopEntryState()).toBe('absent');

    const noServers = { globalShortcut: 'Alt+Space' };
    seed(noServers);
    mod.addDesktopEntry();
    mod.removeDesktopEntry();
    expect(read()).toEqual(noServers);
    const before = readFileSync(cfgPath, 'utf8');
    expect(mod.removeDesktopEntry()).toEqual({ changed: false });
    expect(readFileSync(cfgPath, 'utf8')).toBe(before);
  });

  it('stale: a switchyard entry from another checkout is reported, and Connect refreshes it', () => {
    const other = {
      ...mod.desktopEntry(),
      args: ['/Users/me/old-switchyard/packages/bus-mcp/dist/index.js'],
    };
    seed({ ...FOREIGN, mcpServers: { ...FOREIGN.mcpServers, switchyard: other } });
    expect(mod.desktopEntryState()).toBe('stale');
    expect(mod.addDesktopEntry()).toEqual({ changed: true });
    expect(mod.desktopEntryState()).toBe('present');
    expect(read().mcpServers.filesystem).toEqual(FOREIGN.mcpServers.filesystem);
  });
});

describe('Claude Desktop identity (core + real bus-mcp)', () => {
  let built: Built;
  let port: number;
  let wsA: string;
  let wsB: string;
  let peer: string;
  const runFile = () => join(home, 'run', 'claude-desktop.json');
  const rf = () => JSON.parse(readFileSync(runFile(), 'utf8')) as { capability: string };
  const host = () => ({ host: `127.0.0.1:${port}` });
  const ui = (method: 'GET' | 'POST', body?: unknown, headers: Record<string, string> = {}) =>
    built.app.inject({
      method,
      url: '/api/claude-desktop',
      headers: { authorization: `Bearer ${built.token}`, ...host(), ...headers },
      payload: body as object,
    });
  const whoami = (cap: string) =>
    built.app.inject({
      method: 'GET',
      url: '/bus/whoami',
      headers: { ...host(), 'x-switchyard-node': 'claude-desktop', 'x-switchyard-cap': cap },
    });
  const UNAUTHORIZED = {
    error: 'unauthorized',
    message: 'unknown node, stale capability or wrong secret',
  };

  beforeAll(async () => {
    const { buildServer } = await import('../server.js');
    port = 20000 + Math.floor(Math.random() * 20000);
    built = await buildServer({
      port,
      dbPath: ':memory:',
      quiet: true,
      whois: async () => 'owner@x',
    });
    await built.app.listen({ host: '127.0.0.1', port });
    const { store, nodes } = built.core;
    wsA = store.createWorkspace('A', mkdtempSync(join(tmpdir(), 'sy-desktop-wsA-'))).id;
    wsB = store.createWorkspace('B', mkdtempSync(join(tmpdir(), 'sy-desktop-wsB-'))).id;
    peer = nodes.create(wsA, { type: 'agent-chat', harness: 'mock', title: 'Builder' }).id;
  });
  afterAll(() => built.app.close());

  it('Connect writes the entry and issues a 0600 run file at the stable path; Connect again rotates it', async () => {
    seed(FOREIGN);
    const r = await ui('POST', { action: 'connect', workspaceId: wsA });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      config: 'present',
      workspaceId: wsA,
      nodeId: 'claude-desktop',
    });
    expect(read().mcpServers.switchyard.env.SWITCHYARD_CAPFILE).toBe(runFile());
    expect(statSync(runFile()).mode & 0o777).toBe(0o600);
    const node = built.core.store.getNode('claude-desktop')!;
    expect(node).toMatchObject({ type: 'external', harness: 'claude-desktop', state: 'external' });

    const first = rf().capability;
    expect((await whoami(first)).statusCode).toBe(200);
    await ui('POST', { action: 'connect', workspaceId: wsA });
    const stale = await whoami(first);
    expect(stale.statusCode).toBe(401);
    expect(stale.json()).toEqual(UNAUTHORIZED);
    expect((await whoami(rf().capability)).statusCode).toBe(200);
  });

  it('core boot rotates the capability, so a copy of the old run file stops working', async () => {
    const before = rf().capability;
    built.core.nodes.onBoot();
    expect(rf().capability).not.toBe(before);
    expect((await whoami(before)).json()).toEqual(UNAUTHORIZED);
    expect(built.core.store.getNode('claude-desktop')!.state).toBe('external');
  });

  it('a real bus-mcp started with exactly the config entry answers whoami and list_peers (edge-scoped)', async () => {
    await ui('POST', { action: 'connect', workspaceId: wsA });
    const entry = read().mcpServers.switchyard as {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
    const transport = new StdioClientTransport({ ...entry, stderr: 'pipe' });
    const client = new Client({ name: 'fake-claude-desktop', version: '0' });
    await client.connect(transport);
    const call = async (name: string) => {
      const res = (await client.callTool({ name, arguments: {} })) as {
        content: { text?: string }[];
        isError?: boolean;
      };
      const text = res.content.map((c) => c.text ?? '').join('');
      if (res.isError) throw new Error(text);
      return JSON.parse(text) as Record<string, unknown>;
    };
    try {
      expect(await call('whoami')).toEqual({
        nodeId: 'claude-desktop',
        title: 'Claude Desktop',
        workspaceId: wsA,
        harness: 'claude-desktop',
      });
      expect(await call('list_peers')).toEqual({ peers: [] });
      built.core.store.createEdge(wsA, 'claude-desktop', peer);
      expect((await call('list_peers')).peers).toEqual([
        expect.objectContaining({ nodeId: peer, title: 'Builder' }),
      ]);
      // The peer sees Claude Desktop too.
      expect(built.core.bus.listPeers(peer)).toEqual([
        expect.objectContaining({
          nodeId: 'claude-desktop',
          harness: 'claude-desktop',
          state: 'external',
        }),
      ]);
      // ...and waiting on it settles at once instead of timing out (it never reports work).
      expect(await built.core.bus.waitForNodes(peer, ['claude-desktop'], 5)).toMatchObject({
        status: 'settled',
      });
      // A core restart rotates the file; the running process re-reads it on 401 and carries on.
      built.core.nodes.onBoot();
      expect((await call('whoami')).nodeId).toBe('claude-desktop');
      // Remove revokes: the run file is gone and the same process is refused.
      expect((await ui('POST', { action: 'remove' })).json()).toMatchObject({
        config: 'absent',
        workspaceId: null,
      });
      expect(existsSync(runFile())).toBe(false);
      await expect(call('whoami')).rejects.toThrow(/no Switchyard run file|unauthorized/);
    } finally {
      await client.close();
    }
  }, 30_000);

  it('Connect to another workspace moves the one identity there and drops its old edges', async () => {
    await ui('POST', { action: 'connect', workspaceId: wsA });
    built.core.store.createEdge(wsA, 'claude-desktop', peer);
    const r = await ui('POST', { action: 'connect', workspaceId: wsB });
    expect(r.json()).toMatchObject({ workspaceId: wsB });
    expect(built.core.store.listNodes(wsA).some((n) => n.id === 'claude-desktop')).toBe(false);
    expect(built.core.store.listEdges(wsA)).toEqual([]);
    expect(built.core.bus.listPeers('claude-desktop')).toEqual([]);
  });

  it('Remove revokes the capability, deletes the run file and the entry, keeps foreign keys', async () => {
    seed(FOREIGN);
    await ui('POST', { action: 'connect', workspaceId: wsB });
    const cap = rf().capability;
    const r = await ui('POST', { action: 'remove' });
    expect(r.json()).toMatchObject({ config: 'absent', workspaceId: null });
    expect(existsSync(runFile())).toBe(false);
    expect((await whoami(cap)).json()).toEqual(UNAUTHORIZED);
    expect(built.core.store.getNode('claude-desktop')).toBeUndefined();
    expect(read()).toEqual(FOREIGN);
  });

  it('refuses Connect/Remove from a remote session, even with remote read-only off', async () => {
    const { setSetting } = await import('../db/index.js');
    setSetting(built.core.db, 'remoteReadOnly', false);
    try {
      seed(FOREIGN);
      const before = readFileSync(cfgPath, 'utf8');
      const remote = { 'x-forwarded-for': '100.64.0.9', 'tailscale-user-login': 'owner@x' };
      const r = await ui('POST', { action: 'connect', workspaceId: wsA }, remote);
      expect(r.statusCode).toBe(400);
      expect(r.json().message).toMatch(/on the computer itself/);
      expect(readFileSync(cfgPath, 'utf8')).toBe(before);
      expect(built.core.store.getNode('claude-desktop')).toBeUndefined();
    } finally {
      setSetting(built.core.db, 'remoteReadOnly', true);
    }
  });

  it('refuses invalid JSON on Connect before issuing any identity', async () => {
    seed('{ broken');
    const r = await ui('POST', { action: 'connect', workspaceId: wsA });
    expect(r.statusCode).toBe(400);
    expect(r.json().message).toMatch(/refusing to overwrite/);
    expect(built.core.store.getNode('claude-desktop')).toBeUndefined();
    expect(existsSync(runFile())).toBe(false);
    expect((await ui('GET')).json()).toMatchObject({ config: 'invalid' });
  });
});
