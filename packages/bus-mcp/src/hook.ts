#!/usr/bin/env node
/**
 * Hook relay: `node hook.js <harness> <nodeId|-> <EventName>` with the hook JSON on stdin.
 * Forwards to core's /bus/hook. Always exits 0 quickly so it can never block or alter the agent's turn.
 */
import { BusClient, resolveNodeId } from './client.js';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    let data = '';
    const t = setTimeout(() => resolve(data), 2000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (data += d));
    process.stdin.on('end', () => {
      clearTimeout(t);
      resolve(data);
    });
  });
}

async function main() {
  const [harness = 'unknown', nodeArg = '-', event = 'unknown'] = process.argv.slice(2);
  const nodeId = nodeArg !== '-' ? nodeArg : resolveNodeId();
  const raw = await readStdin();
  if (!nodeId) return;
  let payload: Record<string, unknown> = {};
  try {
    payload = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    payload = {};
  }
  // Keep only small, non-sensitive fields.
  const slim: Record<string, unknown> = {};
  for (const k of [
    'session_id',
    'conversationId',
    'hook_event_name',
    'notification_type',
    'cwd',
    'terminationReason',
    'fullyIdle',
  ]) {
    if (k in payload) slim[k] = payload[k];
  }
  if (typeof payload.message === 'string') slim.message = payload.message.slice(0, 300);
  const client = new BusClient(nodeId);
  await Promise.race([
    client.call('POST', '/bus/hook', { harness, event, payload: slim }),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
}

main()
  .catch(() => undefined)
  .finally(() => process.exit(0));
