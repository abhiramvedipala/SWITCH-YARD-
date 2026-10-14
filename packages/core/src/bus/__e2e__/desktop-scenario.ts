/**
 * Claude Desktop chats, end to end: ONE bus-mcp process started exactly as Claude Desktop starts it (the
 * claude-desktop capfile env) joins twice as two chats; each chat is scoped by its own edges and exchanges a
 * request/response with a mock agent node that talks through its own real bus-mcp. Claude Desktop's config is
 * a temp file (SWITCHYARD_CLAUDE_DESKTOP_CONFIG), never the real one.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectBusMcp, type BusMcp } from '../../../../bus-mcp/src/mcp-client.js';
import { runFilePath } from '../../auth/capability.js';

export async function runDesktopScenario(log: (s: string) => void = () => {}) {
  const home = process.env.SWITCHYARD_HOME;
  if (!home || !home.includes(tmpdir())) throw new Error('set SWITCHYARD_HOME to a temp dir first');
  process.env.SWITCHYARD_CLAUDE_DESKTOP_CONFIG = join(
    mkdtempSync(join(tmpdir(), 'sy-e2e-desktop-cfg-')),
    'claude_desktop_config.json',
  );
  const { buildServer } = await import('../../server.js');
  const { connectClaudeDesktop, DESKTOP_NODE } = await import('../../harness/claude-desktop.js');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const { app, core } = await buildServer({ port, dbPath: join(home, 'desktop.db'), quiet: true });
  await app.listen({ host: '127.0.0.1', port });
  const clients: BusMcp[] = [];
  try {
    const ws = core.store.createWorkspace('desktop', mkdtempSync(join(tmpdir(), 'sy-e2e-cd-')));
    const builderNode = core.nodes.create(ws.id, {
      type: 'agent-chat',
      harness: 'mock',
      title: 'Builder',
    });
    connectClaudeDesktop(core, ws.id);
    const [desktop, builder] = await Promise.all([
      connectBusMcp({ SWITCHYARD_CAPFILE: runFilePath(DESKTOP_NODE), SWITCHYARD_HOME: home }),
      connectBusMcp({ SWITCHYARD_NODE: builderNode.id, SWITCHYARD_HOME: home }),
    ]);
    clients.push(desktop, builder);
    const tools = await desktop.tools();

    type Joined = { nodeId: string; name: string; hint: string; peers: unknown[] };
    const gpa = await desktop.call<Joined>('join_switchyard', { name: 'GPA' });
    const essay = await desktop.call<Joined>('join_switchyard', { name: 'Essay' });
    log(`joined ${gpa.nodeId} and ${essay.nodeId} from one process`);
    core.store.createEdge(ws.id, gpa.nodeId, builderNode.id);
    const peersOf = async (as: string) =>
      (await desktop.call<{ peers: { nodeId: string }[] }>('list_peers', { as })).peers.map(
        (p) => p.nodeId,
      );
    const gpaPeers = await peersOf('GPA');
    const essayPeers = await peersOf('Essay');

    // Builder asks GPA through its own bus-mcp; Essay (no edge) sees nothing.
    const req = await builder.call<{ messageId: string }>('message_peer', {
      peerId: gpa.nodeId,
      intent: 'request',
      body: 'what grade?',
    });
    const waiting = builder.call<{ status: string; body: string; from: string }>('wait_for_reply', {
      messageId: req.messageId,
      timeoutSec: 30,
    });
    const unreadText = core.monitor.attention(ws.id).find((i) => i.nodeId === gpa.nodeId)?.text;
    type Inbox = { messages: { messageId: string; from: string; body: string }[] };
    const essayInbox = (await desktop.call<Inbox>('check_inbox', { as: 'Essay' })).messages;
    const gpaInbox = (await desktop.call<Inbox>('check_inbox', { as: 'GPA' })).messages;
    log(`GPA inbox: ${gpaInbox.length}, Essay inbox: ${essayInbox.length}`);
    await desktop.call('message_peer', {
      as: 'GPA',
      peerId: builderNode.id,
      intent: 'response',
      responseTo: req.messageId,
      body: 'B+',
    });
    const reply = await waiting;
    log(`Builder wait_for_reply -> ${JSON.stringify(reply)}`);

    const errorOf = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        return '';
      } catch (err) {
        return String((err as Error).message);
      }
    };
    const essayError = await errorOf(() =>
      desktop.call('message_peer', {
        as: 'Essay',
        peerId: builderNode.id,
        intent: 'notify',
        body: 'let me in',
      }),
    );
    // An agent naming a chat is refused like a bad capability.
    const foreignAsError = await errorOf(() => builder.call('list_peers', { as: 'GPA' }));
    const left = await desktop.call<{ left: boolean }>('leave_switchyard', { name: 'Essay' });
    log(`Essay send error="${essayError}"; Builder as:GPA error="${foreignAsError}"`);
    return {
      tools,
      gpa,
      essay,
      gpaPeers,
      essayPeers,
      unreadText,
      gpaInbox,
      essayInbox,
      reply,
      essayError,
      foreignAsError,
      left,
      chatNodes: core.store
        .listNodes(ws.id)
        .filter((n) => n.data.kind === 'chat')
        .map((n) => ({ id: n.id, title: n.title, left: n.data.left === true })),
    };
  } finally {
    await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
    await app.close();
  }
}
