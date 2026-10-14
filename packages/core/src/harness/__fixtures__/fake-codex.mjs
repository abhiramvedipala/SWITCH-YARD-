#!/usr/bin/env node
/**
 * Test-only stand-in for the Codex CLI. Zero AI, no network. Speaks the documented `codex exec --json` events:
 * thread.started, turn.started, item.completed (command_execution, mcp_tool_call, agent_message), turn.completed.
 * Answers `--version` and `login status` (exit 0 = signed in; FAKE_CODEX_LOGGED_OUT=1 flips it).
 * Logs argv, cwd, SWITCHYARD_NODE and the stdin prompt to $FAKE_CODEX_LOG. Prompt marker "[fail]" fails the turn.
 */
import { appendFileSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
if (argv[0] === '--version') {
  console.log('codex-cli 0.0.0-fake');
  process.exit(0);
}
if (argv[0] === 'login' && argv[1] === 'status') {
  if (process.env.FAKE_CODEX_LOGGED_OUT) {
    console.error('Not logged in');
    process.exit(1);
  }
  console.log('Logged in using ChatGPT');
  process.exit(0);
}
if (argv[0] !== 'exec') process.exit(2);
const prompt = readFileSync(0, 'utf8');
const at = argv.indexOf('resume');
const thread = at >= 0 ? argv[at + 1] : `thr-${process.pid}`;
if (process.env.FAKE_CODEX_LOG)
  appendFileSync(
    process.env.FAKE_CODEX_LOG,
    JSON.stringify({
      argv,
      cwd: process.cwd(),
      node: process.env.SWITCHYARD_NODE ?? null,
      prompt,
    }) + '\n',
  );
out({ type: 'thread.started', thread_id: thread });
out({ type: 'turn.started' });
if (prompt.includes('[fail]')) {
  out({ type: 'turn.failed', error: { message: 'fake failure' } });
  process.exit(1);
}
const item = (o) => out({ type: 'item.completed', item: o });
item({
  id: 'item_0',
  type: 'command_execution',
  command: 'ls',
  aggregated_output: 'a\n',
  exit_code: 0,
  status: 'completed',
});
item({
  id: 'item_1',
  type: 'mcp_tool_call',
  server: 'switchyard',
  tool: 'check_inbox',
  arguments: {},
  result: { content: [{ type: 'text', text: 'empty' }] },
  status: 'completed',
});
const reply = prompt.includes('JSON Schema')
  ? '{"approve":true,"findings":[]}'
  : `echo: ${prompt.trim().slice(-40)}`;
item({ id: 'item_2', type: 'agent_message', text: reply });
out({
  type: 'turn.completed',
  usage: { input_tokens: 11, cached_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 0 },
});
