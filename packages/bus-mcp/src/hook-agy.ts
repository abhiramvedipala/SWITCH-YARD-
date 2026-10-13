#!/usr/bin/env node
/**
 * Antigravity hook relay: `node hook-agy.js <Event>` with agy's camelCase hook JSON on stdin.
 * Posts it to core's capability-authenticated /bus/agy/hook and prints core's decision on stdout.
 * Any failure prints `{}` ("no opinion") so a broken Switchyard can never block or alter agy.
 *
 * Which node am I? SWITCHYARD_NODE when agy passes its env through, else the per-folder identity file for
 * workspacePaths[0] (the same file bus-mcp falls back to).
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

/** Fields core needs; everything else (transcripts, tool output) stays out of the request. */
const KEEP = [
  'conversationId',
  'workspacePaths',
  'fullyIdle',
  'terminationReason',
  'invocationNum',
  'executionNum',
  'stepIdx',
  'modelName',
];

export function slimAgyPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const slim: Record<string, unknown> = {};
  for (const k of KEEP) if (k in payload) slim[k] = payload[k];
  const tc = payload.toolCall as { name?: unknown; args?: unknown } | undefined;
  if (tc && typeof tc === 'object') slim.toolCall = { name: tc.name, args: tc.args };
  return slim;
}

async function main(): Promise<string> {
  const event = process.argv[2] ?? 'unknown';
  const raw = await readStdin();
  let payload: Record<string, unknown> = {};
  try {
    payload = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return '{}';
  }
  const ws0 = Array.isArray(payload.workspacePaths) ? payload.workspacePaths[0] : undefined;
  const nodeId = resolveNodeId(typeof ws0 === 'string' ? ws0 : process.cwd());
  if (!nodeId) return '{}';
  // Permission questions wait for the human (core answers within 290 s); everything else must be quick.
  const waitMs = event === 'PreToolUse' ? 295_000 : 8_000;
  const fallback = event === 'PreToolUse' ? '{"decision":"ask"}' : '{}';
  const client = new BusClient(nodeId);
  const out = await Promise.race([
    client
      .call<Record<string, unknown>>('POST', '/bus/agy/hook', {
        event,
        payload: slimAgyPayload(payload),
      })
      .then((r) => JSON.stringify(r)),
    new Promise<string>((r) => setTimeout(() => r(fallback), waitMs)),
  ]);
  return out;
}

main()
  .catch(() => '{}')
  .then((out) => {
    process.stdout.write(out + '\n', () => process.exit(0));
  });
