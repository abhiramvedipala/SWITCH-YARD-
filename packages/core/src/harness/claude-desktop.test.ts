import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import http from 'node:http';
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
      await expect(call('whoami')).rejects.toThrow(
        "Switchyard's Claude Desktop connection is not active. In Switchyard: Settings → Claude Desktop → Connect.",
      );
    } finally {
      await client.close();
    }
  }, 30_000);

  it('deleting the base node is refused (409) unless forced; then the card reports detached', async () => {
    await ui('POST', { action: 'connect', workspaceId: wsA });
    expect((await ui('GET')).json()).toMatchObject({ config: 'present', status: 'connected' });
    const del = (q = '') =>
      built.app.inject({
        method: 'DELETE',
        url: `/api/nodes/claude-desktop${q}`,
        headers: { authorization: `Bearer ${built.token}`, ...host() },
      });
    const r = await del();
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({
      error: 'desktop_identity',
      message:
        "This node is Claude Desktop's identity; use Settings → Claude Desktop → Remove to disconnect",
    });
    expect(built.core.store.getNode('claude-desktop')).toBeDefined();
    expect(existsSync(runFile())).toBe(true);

    expect((await del('?force=1')).statusCode).toBe(200);
    expect(built.core.store.getNode('claude-desktop')).toBeUndefined();
    expect((await ui('GET')).json()).toMatchObject({
      config: 'present',
      status: 'detached',
      workspaceId: null,
    });
    // A Claude Desktop restarted now gets told how to fix it, not "not attached to a Switchyard node".
    const entry = read().mcpServers.switchyard;
    const client = new Client({ name: 'fake-claude-desktop', version: '0' });
    await client.connect(new StdioClientTransport({ ...entry, stderr: 'pipe' }));
    try {
      const res = (await client.callTool({ name: 'whoami', arguments: {} })) as {
        content: { text: string }[];
        isError?: boolean;
      };
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toBe(
        "Error — Switchyard's Claude Desktop connection is not active. In Switchyard: Settings → Claude Desktop → Connect.",
      );
    } finally {
      await client.close();
    }
    expect((await ui('POST', { action: 'remove' })).json()).toMatchObject({ status: 'off' });
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

  // ---------------------------------------------------------------- per-chat identities (join_switchyard / as)
  const GPA = 'claude-desktop:gpa';
  const ESSAY = 'claude-desktop:essay';
  const UNREAD_TEXT =
    'GPA chat has 2 unread — open that chat in Claude and say "check my switchyard inbox"';
  /** A /bus call with the base Claude Desktop capability; `as` names the chat to act as. */
  const bus = (
    method: 'GET' | 'POST',
    url: string,
    body?: unknown,
    as?: string,
    node = 'claude-desktop',
    cap = rf().capability,
  ) =>
    built.app.inject({
      method,
      url,
      headers: {
        ...host(),
        'x-switchyard-node': node,
        'x-switchyard-cap': cap,
        ...(as === undefined ? {} : { 'x-switchyard-as': as }),
      },
      payload: body as object,
    });
  let peerCap: string;

  it('join_switchyard creates claude-desktop:<slug> in the connector workspace and reuses it by slug', async () => {
    await ui('POST', { action: 'connect', workspaceId: wsA });
    peerCap = built.core.caps.issue(peer, wsA).capability;
    const r = await bus('POST', '/bus/join', { name: 'GPA' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      nodeId: GPA,
      name: 'GPA',
      hint: "Pass as:'GPA' in every later switchyard call.",
      peers: [],
    });
    expect(built.core.store.getNode(GPA)).toMatchObject({
      workspaceId: wsA,
      type: 'external',
      harness: 'claude-desktop',
      title: 'GPA',
      state: 'external',
      data: { kind: 'chat' },
      w: 220,
    });
    // Same slug, same node (and the canvas title is left alone); nothing else is created.
    expect((await bus('POST', '/bus/join', { name: ' gpa! ' })).json().nodeId).toBe(GPA);
    expect(built.core.store.getNode(GPA)!.title).toBe('GPA');
    expect(
      built.core.store.listNodes(wsA).filter((n) => n.harness === 'claude-desktop').length,
    ).toBe(2);
    expect((await bus('POST', '/bus/join', { name: '!!!' })).json()).toMatchObject({
      error: 'bad_name',
    });
    // Agents started from the canvas already have a node: they cannot join.
    const foreign = await bus('POST', '/bus/join', { name: 'X' }, undefined, peer, peerCap);
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().error).toBe('not_claude_desktop');
    expect(built.core.store.getNode('claude-desktop:x')).toBeUndefined();
  });

  it('`as` is honoured for the base identity only; any other caller gets the shared 401', async () => {
    expect((await bus('GET', '/bus/whoami', undefined, 'GPA')).json()).toEqual({
      nodeId: GPA,
      title: 'GPA',
      workspaceId: wsA,
      harness: 'claude-desktop',
    });
    for (const r of [
      await bus('GET', '/bus/whoami', undefined, 'GPA', peer, peerCap), // a peer naming a chat
      await bus('GET', '/bus/whoami', undefined, 'nope', peer, peerCap), // ...or a non-chat
      await bus('GET', '/bus/whoami', undefined, undefined, GPA), // the chat id with the base cap
    ]) {
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual(UNAUTHORIZED);
    }
    const unknown = await bus('GET', '/bus/whoami', undefined, 'Nope');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: 'unknown_chat' });
    expect(existsSync(join(home, 'run', `${GPA}.json`))).toBe(false);
  });

  it('each chat is scoped by its own edges: peers, inbox and responses per sub-node', async () => {
    await bus('POST', '/bus/join', { name: 'Essay' });
    built.core.store.createEdge(wsA, GPA, peer);
    expect((await bus('GET', '/bus/peers', undefined, 'GPA')).json().peers).toEqual([
      expect.objectContaining({ nodeId: peer }),
    ]);
    expect((await bus('GET', '/bus/peers', undefined, 'Essay')).json().peers).toEqual([]);
    expect(built.core.bus.listPeers(peer)).toEqual([expect.objectContaining({ nodeId: GPA })]);

    const { messageId } = built.core.bus.sendMessage(peer, {
      peerId: GPA,
      intent: 'request',
      body: 'grade this',
    });
    expect(() =>
      built.core.bus.sendMessage(peer, { peerId: ESSAY, intent: 'notify', body: 'hi' }),
    ).toThrow(/not connected/);
    expect((await bus('POST', '/bus/inbox', {}, 'Essay')).json().messages).toEqual([]);
    expect((await bus('POST', '/bus/inbox', {}, 'GPA')).json().messages).toEqual([
      expect.objectContaining({ messageId, from: peer, body: 'grade this', needsReply: true }),
    ]);
    const answer = await bus(
      'POST',
      '/bus/messages',
      { peerId: peer, intent: 'response', responseTo: messageId, body: 'A-' },
      'GPA',
    );
    expect(answer.statusCode).toBe(200);
    expect(await built.core.bus.waitForReply(peer, messageId, 5)).toMatchObject({
      status: 'replied',
      from: GPA,
      body: 'A-',
    });
    expect(await built.core.bus.waitForNodes(peer, [GPA], 5)).toMatchObject({ status: 'settled' });
    await bus('POST', '/bus/summary', { text: 'grading' }, 'GPA');
    expect(built.core.store.getNode(GPA)!.summary).toBe('grading');
    expect(built.core.store.getNode('claude-desktop')!.summary).toBe('');
  });

  it('wait_inbox stands by as the chat; the shared 401 for anyone else; a hang-up frees the listener', async () => {
    const t0 = Date.now();
    const waiting = bus('POST', '/bus/wait_inbox', { timeoutMs: 10_000 }, 'GPA');
    setTimeout(
      () => built.core.bus.sendMessage(peer, { peerId: GPA, intent: 'notify', body: 'ping' }),
      100,
    );
    const r = await waiting;
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      messages: [expect.objectContaining({ from: peer, body: 'ping' })],
      timedOut: false,
    });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect((await bus('POST', '/bus/wait_inbox', { timeoutMs: 50 }, 'GPA')).json()).toEqual({
      messages: [],
      timedOut: true,
    });
    const foreign = await bus('POST', '/bus/wait_inbox', {}, 'GPA', peer, peerCap);
    expect(foreign.statusCode).toBe(401);
    expect(foreign.json()).toEqual(UNAUTHORIZED);

    // A real socket that hangs up mid-wait: the wait ends and its wake-up listener goes with it.
    const signals = built.core.bus['signals'];
    const base = signals.listenerCount('message');
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/bus/wait_inbox',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-switchyard-node': 'claude-desktop',
        'x-switchyard-cap': rf().capability,
        'x-switchyard-as': 'GPA',
      },
    });
    req.on('error', () => undefined);
    req.end(JSON.stringify({ timeoutMs: 30_000 }));
    await vi.waitFor(() => expect(signals.listenerCount('message')).toBe(base + 1));
    req.destroy();
    await vi.waitFor(() => expect(signals.listenerCount('message')).toBe(base));
    // ...and a message that lands afterwards waits for the chat's next call.
    built.core.bus.sendMessage(peer, { peerId: GPA, intent: 'notify', body: 'after hang-up' });
    expect((await bus('POST', '/bus/inbox', {}, 'GPA')).json().messages).toEqual([
      expect.objectContaining({ body: 'after hang-up' }),
    ]);
  });

  it('unread messages to a chat show in Needs you with the relay instruction, with no PTY nudge', async () => {
    built.core.bus.sendFromUser(GPA, { intent: 'notify', body: 'one' });
    built.core.bus.sendFromUser(GPA, { intent: 'notify', body: 'two' });
    await new Promise((r) => setTimeout(r, 400));
    expect(built.core.monitor.attention(wsA)).toEqual([
      expect.objectContaining({
        kind: 'unread',
        nodeId: GPA,
        nodeTitle: 'GPA',
        nodeType: 'external',
        count: 2,
        text: UNREAD_TEXT,
      }),
    ]);
    expect(built.core.monitor.nudgeCount).toBe(0);
    await bus('POST', '/bus/inbox', {}, 'GPA');
    expect(built.core.monitor.attention(wsA)).toEqual([]);
  });

  it('leave marks the chat left (node kept), join clears it, Delete and Remove drop chat nodes', async () => {
    expect((await bus('POST', '/bus/leave', { name: 'GPA' })).json()).toEqual({
      nodeId: GPA,
      left: true,
    });
    expect(built.core.store.getNode(GPA)!.data).toEqual({ kind: 'chat', left: true });
    expect((await bus('GET', '/bus/whoami', undefined, 'GPA')).statusCode).toBe(200);
    await bus('POST', '/bus/join', { name: 'GPA' });
    expect(built.core.store.getNode(GPA)!.data).toEqual({ kind: 'chat' });
    expect((await bus('POST', '/bus/leave', { name: 'Nope' })).statusCode).toBe(404);
    // A boot rotates the base identity only: chat nodes never get a run file.
    built.core.nodes.onBoot();
    expect(existsSync(join(home, 'run', `${GPA}.json`))).toBe(false);
    expect((await bus('GET', '/bus/whoami', undefined, 'GPA')).statusCode).toBe(200);
    // Delete from the node menu removes the chat and its edges.
    built.core.store.createEdge(wsA, ESSAY, peer);
    const del = await built.app.inject({
      method: 'DELETE',
      url: `/api/nodes/${ESSAY}`,
      headers: { authorization: `Bearer ${built.token}`, ...host() },
    });
    expect(del.statusCode).toBe(200);
    expect(built.core.store.getNode(ESSAY)).toBeUndefined();
    expect(built.core.store.listEdges(wsA).some((e) => e.from === ESSAY || e.to === ESSAY)).toBe(
      false,
    );
    // Remove takes the base identity and every chat that acted through it.
    await ui('POST', { action: 'remove' });
    expect(built.core.store.getNode(GPA)).toBeUndefined();
    expect(built.core.store.listEdges(wsA)).toEqual([]);
  });
});
