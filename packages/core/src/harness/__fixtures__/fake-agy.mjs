#!/usr/bin/env node
/**
 * Test-only stand-in for `agy --input-format stream-json --output-format stream-json` (F8). Zero AI.
 * Speaks the documented protocol: one `init`, then per stdin line {"event":"user","message":{"content"}}
 * some `step_update`s and one `result`. Logs what it saw to $FAKE_AGY_LOG (one JSON object per line).
 * Prompt markers: "[slow]" delays the result, "[crash]" exits mid-turn.
 */
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = (o) =>
  process.env.FAKE_AGY_LOG && appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify(o) + '\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const argv = process.argv.slice(2);
const at = argv.indexOf('--conversation');
const conv = at >= 0 ? argv[at + 1] : `conv-${process.pid}`;
const noSlash = argv.includes('--disable-slash-commands');

log({ start: argv, cwd: process.cwd(), node: process.env.SWITCHYARD_NODE ?? null });
out({ event: 'init', init: { conversation_id: conv, cwd: process.cwd() } });

let busy = false;
let turn = 0;
createInterface({ input: process.stdin })
  .on('line', async (line) => {
    const content = JSON.parse(line).message.content;
    log({ recv: content, busy });
    busy = true;
    turn++;
    if (content.includes('[crash]')) process.exit(3);
    if (content.startsWith('/') && !noSlash) {
      out({
        event: 'result',
        result: { status: 'ERROR', error: 'slash command', conversation_id: conv },
      });
      process.exit(1);
    }
    if (content.includes('[slow]')) await new Promise((r) => setTimeout(r, 300));
    const step = (o) => out({ event: 'step_update', step_update: { conversation_id: conv, ...o } });
    step({
      step_index: 0,
      step_type: 'agent_response',
      state: 'ACTIVE',
      text_delta: `echo ${turn}: `,
    });
    step({
      step_index: 0,
      step_type: 'agent_response',
      state: 'ACTIVE',
      text_delta: content.slice(0, 40),
    });
    step({
      step_index: 1,
      step_type: 'tool',
      state: 'DONE',
      tool_info: { name: 'list_dir', parameters: {}, output: 'ok' },
    });
    out({
      event: 'result',
      result: {
        status: 'SUCCESS',
        response: `echo ${turn}: ${content.slice(0, 40)}`,
        conversation_id: conv,
        usage: { input_tokens: 10 * turn, output_tokens: 5 },
      },
    });
    busy = false;
  })
  .on('close', () => {
    log({ stdin: 'end' });
    process.exitCode = 0;
  });
