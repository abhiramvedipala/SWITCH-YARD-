/**
 * Rooms, end to end: real core HTTP server, two mock participants, and a canvas agent talking to the room
 * through the real bus-mcp server over MCP stdio (list_rooms, post_to_room, read_room).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectBusMcp, type BusMcp } from '../../../../bus-mcp/src/mcp-client.js';
import { runFilePath } from '../../auth/capability.js';

interface Msg {
  messageId: string;
  author: string;
  authorKind: string;
  text: string;
}

export async function runRoomsScenario(log: (s: string) => void = () => {}) {
  const home = process.env.SWITCHYARD_HOME;
  if (!home || !home.includes(tmpdir())) throw new Error('set SWITCHYARD_HOME to a temp dir first');
  const { buildServer } = await import('../../server.js');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const { app, core } = await buildServer({ port, dbPath: join(home, 'rooms.db'), quiet: true });
  await app.listen({ host: '127.0.0.1', port });
  let agent: BusMcp | null = null;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    const ws = core.store.createWorkspace('rooms', mkdtempSync(join(tmpdir(), 'sy-e2e-rooms-')));
    const builder = core.nodes.create(ws.id, {
      type: 'agent-chat',
      harness: 'mock',
      title: 'Builder',
    });
    const room = core.rooms.create(ws.id, { title: 'Design review' });
    for (const n of ['Mock A', 'Mock B'])
      core.rooms.addParticipant(room.id, { harness: 'mock', displayName: n });
    const settle = async () => {
      await sleep(50);
      const end = Date.now() + 30_000;
      while (core.rooms.busy(room.id)) {
        if (Date.now() > end) throw new Error('room never settled');
        await sleep(50);
      }
    };
    const replies = () =>
      core.rooms.messages(room.id).filter((m) => m.authorKind === 'participant');

    agent = await connectBusMcp({
      SWITCHYARD_CAPFILE: runFilePath(builder.id),
      SWITCHYARD_HOME: home,
    });
    const listed = (
      await agent.call<{ rooms: { roomId: string; participants: unknown[] }[] }>('list_rooms')
    ).rooms;
    log(`list_rooms -> ${JSON.stringify(listed)}`);

    const fyi = await agent.call<{ messageId: string }>('post_to_room', {
      roomId: room.id,
      text: 'FYI: the build is green',
    });
    await sleep(500);
    const afterFyi = replies().length;
    log(`agent posted an FYI (no mention) -> ${afterFyi} participant replies`);

    await agent.call('post_to_room', { roomId: room.id, text: '@Mock B can you review it?' });
    await settle();
    const afterMention = replies().map((m) => `${m.authorName}: ${m.text}`);
    log(`agent @mentioned Mock B -> ${JSON.stringify(afterMention)}`);

    core.rooms.post(
      room.id,
      { kind: 'human', id: null, name: 'Human' },
      'thanks, everyone: status?',
    );
    await settle();
    const read = (
      await agent.call<{ messages: Msg[] }>('read_room', {
        roomId: room.id,
        since: fyi.messageId,
      })
    ).messages;
    log(`read_room since the FYI -> ${read.map((m) => `[${m.author}/${m.authorKind}]`).join(' ')}`);
    const usageTurns = (
      core.db.prepare('SELECT COUNT(*) n FROM usage WHERE room_id = ?').get(room.id) as {
        n: number;
      }
    ).n;
    return { listed, roomId: room.id, afterFyi, afterMention, read, usageTurns };
  } finally {
    await agent?.close().catch(() => undefined);
    await app.close();
  }
}
