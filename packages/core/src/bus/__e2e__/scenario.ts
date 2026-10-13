/**
 * Phase 3 DoD, automated: real core HTTP server + real bus-mcp processes over MCP stdio, three mock nodes.
 * A --request--> B, B replies, A's wait_for_reply gets it; C (unconnected) sees neither.
 * Requires SWITCHYARD_HOME to point at a temp dir before core modules are imported.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectBusMcp, type BusMcp } from '../../../../bus-mcp/src/mcp-client.js';
import { runFilePath } from '../../auth/capability.js';

export interface ScenarioResult {
  reply: { status: string; body: string };
  cPeers: unknown[];
  cInbox: unknown[];
  aPeers: string[];
  tools: string[];
  unconnectedError: string;
}

export async function runBusScenario(log: (s: string) => void = () => {}): Promise<ScenarioResult> {
  const home = process.env.SWITCHYARD_HOME;
  if (!home || !home.includes(tmpdir())) throw new Error('set SWITCHYARD_HOME to a temp dir first');
  const { buildServer } = await import('../../server.js');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const { app, core } = await buildServer({ port, dbPath: join(home, 'e2e.db'), quiet: true });
  await app.listen({ host: '127.0.0.1', port });
  const clients: BusMcp[] = [];
  try {
    const wsDir = mkdtempSync(join(tmpdir(), 'sy-e2e-ws-'));
    const ws = core.store.createWorkspace('e2e', wsDir);
    const mk = (title: string) =>
      core.nodes.create(ws.id, { type: 'agent-chat', harness: 'mock', title });
    const A = mk('A');
    const B = mk('B');
    const C = mk('C');
    core.store.createEdge(ws.id, A.id, B.id);
    log(`nodes: A=${A.id} B=${B.id} C=${C.id} (edge A-B only)`);

    const env = (id: string) => ({ SWITCHYARD_NODE: id, SWITCHYARD_HOME: home });
    // B gets only the path of its 0600 run file (what core's busEnv passes); A and C the node id.
    const capEnv = (id: string) => ({ SWITCHYARD_CAPFILE: runFilePath(id), SWITCHYARD_HOME: home });
    const [a, b, c] = await Promise.all([
      connectBusMcp(env(A.id)),
      connectBusMcp(capEnv(B.id)),
      connectBusMcp(env(C.id)),
    ]);
    clients.push(a, b, c);
    const tools = await a.tools();
    log(`bus-mcp tools: ${tools.join(', ')}`);

    const aPeers = (await a.call<{ peers: { nodeId: string }[] }>('list_peers')).peers.map(
      (p) => p.nodeId,
    );
    const req = await a.call<{ messageId: string }>('message_peer', {
      peerId: B.id,
      intent: 'request',
      body: 'say pong',
    });
    log(`A -> B request ${req.messageId}`);
    const waiting = a.call<{ status: string; body: string }>('wait_for_reply', {
      messageId: req.messageId,
      timeoutSec: 30,
    });

    const inbox = await b.call<{
      messages: { messageId: string; from: string; intent: string; body: string }[];
    }>('check_inbox');
    const got = inbox.messages[0];
    if (!got || got.intent !== 'request' || got.from !== A.id)
      throw new Error(`B inbox wrong: ${JSON.stringify(inbox)}`);
    log(`B got "${got.body}" (${got.intent}) — replying`);
    await b.call('message_peer', {
      peerId: A.id,
      intent: 'response',
      responseTo: got.messageId,
      body: 'pong',
    });

    const reply = await waiting;
    log(`A wait_for_reply -> ${JSON.stringify(reply)}`);

    const cPeers = (await c.call<{ peers: unknown[] }>('list_peers')).peers;
    const cInbox = (await c.call<{ messages: unknown[] }>('check_inbox')).messages;
    let unconnectedError = '';
    try {
      await c.call('message_peer', { peerId: A.id, intent: 'notify', body: 'let me in' });
    } catch (err) {
      unconnectedError = String((err as Error).message);
    }
    log(`C peers=${cPeers.length} inbox=${cInbox.length} send-to-A error="${unconnectedError}"`);
    return { reply, cPeers, cInbox, aPeers, tools, unconnectedError };
  } finally {
    await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
    await app.close();
  }
}
