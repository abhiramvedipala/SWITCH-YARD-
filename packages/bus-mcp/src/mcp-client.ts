import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
// Works whether this file runs from dist/ or is imported from src/ by tests.
export const BUS_MCP_INDEX = existsSync(join(here, 'index.js'))
  ? join(here, 'index.js')
  : join(here, '../dist/index.js');

export interface BusMcp {
  call<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>;
  tools(): Promise<string[]>;
  close(): Promise<void>;
}

/** Spawn the real bus-mcp server over stdio and talk to it like any MCP host would. */
export async function connectBusMcp(env: Record<string, string>): Promise<BusMcp> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BUS_MCP_INDEX],
    env: { ...(process.env as Record<string, string>), ...env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'switchyard-mock', version: '0.1.0' });
  await client.connect(transport);
  return {
    async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
      const res = (await client.callTool({ name, arguments: args }, undefined, {
        timeout: 15 * 60_000,
      })) as {
        content: { type: string; text?: string }[];
        isError?: boolean;
      };
      const textOut = res.content.map((c) => c.text ?? '').join('');
      if (res.isError) throw new Error(textOut);
      try {
        return JSON.parse(textOut) as T;
      } catch {
        return textOut as T;
      }
    },
    async tools() {
      return (await client.listTools()).tools.map((t) => t.name);
    },
    async close() {
      await client.close();
    },
  };
}
