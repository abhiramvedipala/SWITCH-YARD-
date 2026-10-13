#!/usr/bin/env node
/**
 * Mock agent — exercises the same bus-mcp server and NDJSON plumbing as real agents, with zero AI usage.
 *
 *   node mock-agent.js          interactive REPL in a terminal node (type `help`)
 *   node mock-agent.js --turn   one driven turn: JSON {prompt, schema, sessionId} on stdin, NDJSON events on stdout
 */
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { connectBusMcp, type BusMcp } from './mcp-client.js';

// ------------------------------------------------------------------ driven mode
interface TurnInput {
  prompt: string;
  schema: { properties?: Record<string, unknown> } | null;
  sessionId: string | null;
}

function out(obj: unknown) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function streamText(s: string) {
  for (const chunk of s.match(/.{1,40}(\s|$)|.+/g) ?? [s]) {
    out({ kind: 'text', delta: chunk });
    await new Promise((r) => setTimeout(r, 15));
  }
}

const HELLO_V1 = `def reverse_string(s):
    return s[::-1]
`;

const HELLO_V2 = `def reverse_string(s: str) -> str:
    """Return s reversed, e.g. reverse_string("abc") == "cba"."""
    return s[::-1]
`;

const TEST_HELLO = `from hello import reverse_string


def test_reverse_basic():
    assert reverse_string("abc") == "cba"


def test_reverse_empty():
    assert reverse_string("") == ""


def test_reverse_palindrome():
    assert reverse_string("racecar") == "racecar"
`;

function planFor(goal: string) {
  const mentionsReview = /review/i.test(goal);
  return {
    summary: `Build what the goal asks for, then ${mentionsReview ? 'have the other agent review it' : 'review it'}.`,
    steps: [
      { id: 'build', role: 'build', harness: 'mock', instruction: goal, dependsOn: [] },
      {
        id: 'review',
        role: 'review',
        harness: 'mock',
        instruction: 'Review the changes for correctness, documentation and test coverage.',
        dependsOn: ['build'],
      },
    ],
  };
}

function reviewCwd() {
  const cwd = process.cwd();
  const findings: { severity: string; file: string; line?: number; note: string }[] = [];
  const hello = join(cwd, 'hello.py');
  if (existsSync(hello)) {
    const src = readFileSync(hello, 'utf8');
    if (!src.includes('"""'))
      findings.push({
        severity: 'minor',
        file: 'hello.py',
        line: 1,
        note: 'reverse_string has no docstring',
      });
    if (!src.includes('-> str'))
      findings.push({
        severity: 'minor',
        file: 'hello.py',
        line: 1,
        note: 'reverse_string has no type hints',
      });
    if (!existsSync(join(cwd, 'test_hello.py')))
      findings.push({ severity: 'major', file: 'test_hello.py', note: 'no tests' });
  } else {
    const files = readdirSync(cwd).filter((f) => !f.startsWith('.'));
    if (files.length === 0)
      findings.push({ severity: 'blocker', file: '.', note: 'no files were produced' });
  }
  return {
    approve:
      findings.every((f) => f.severity !== 'blocker' && f.severity !== 'major') &&
      findings.length === 0,
    findings,
  };
}

async function driven() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw) as TurnInput;
  const sessionId = input.sessionId ?? `mock-${randomBytes(6).toString('hex')}`;
  const props = input.schema?.properties ?? {};
  const cwd = process.cwd();
  if ('steps' in props) {
    const goal = input.prompt.match(/Goal: (.*)/)?.[1] ?? input.prompt;
    await streamText('Drafting a two-step plan (build, then review).\n');
    out({ kind: 'result', ok: true, text: 'plan ready', sessionId, structured: planFor(goal) });
    return;
  }
  if ('approve' in props) {
    out({ kind: 'tool', name: 'read_files', input: { cwd } });
    const verdict = reviewCwd();
    await streamText(
      verdict.approve
        ? 'Looks good. Approving.\n'
        : `Requesting changes: ${verdict.findings.map((f) => f.note).join('; ')}\n`,
    );
    out({
      kind: 'result',
      ok: true,
      text: JSON.stringify(verdict),
      sessionId,
      structured: verdict,
    });
    return;
  }
  const p = input.prompt;
  if (/reviewer requested changes/i.test(p)) {
    if (existsSync(join(cwd, 'hello.py'))) {
      writeFileSync(join(cwd, 'hello.py'), HELLO_V2);
      out({ kind: 'tool', name: 'edit_file', input: { path: 'hello.py' } });
    }
    await streamText('Added a docstring and type hints to reverse_string in hello.py.\n');
    out({
      kind: 'result',
      ok: true,
      text: 'Added a docstring and type hints to reverse_string in hello.py.',
      sessionId,
    });
    return;
  }
  if (/hello\.py|reverse/i.test(p)) {
    writeFileSync(join(cwd, 'hello.py'), HELLO_V1);
    out({ kind: 'tool', name: 'write_file', input: { path: 'hello.py' } });
    writeFileSync(join(cwd, 'test_hello.py'), TEST_HELLO);
    out({ kind: 'tool', name: 'write_file', input: { path: 'test_hello.py' } });
    await streamText(
      'Created hello.py with reverse_string(s) and test_hello.py with three pytest tests.\n',
    );
    out({
      kind: 'result',
      ok: true,
      text: 'Created hello.py (reverse_string) and test_hello.py (3 pytest tests).',
      sessionId,
    });
    return;
  }
  if (p.startsWith('User:') || /Ask Switchyard|workspace snapshot/i.test(p)) {
    const q = p.split('User:').pop()?.trim() ?? p;
    await streamText(
      `(mock) I can't think, but I read your question: "${q.slice(0, 200)}". Switch this chat to Claude or agy for real answers.\n`,
    );
    out({ kind: 'result', ok: true, text: '(mock reply)', sessionId });
    return;
  }
  if (!/step of a Switchyard run/i.test(p)) {
    await streamText(
      `(mock) You said: "${p.slice(0, 300)}". I'm the mock agent, so I only echo. Try commands in a mock terminal node, or switch to Claude/agy.\n`,
    );
    out({ kind: 'result', ok: true, text: '(mock echo)', sessionId });
    return;
  }
  const note = join(cwd, 'MOCK_NOTES.md');
  writeFileSync(note, `# Mock agent notes\n\n${p.slice(0, 2000)}\n`);
  out({ kind: 'tool', name: 'write_file', input: { path: 'MOCK_NOTES.md' } });
  await streamText('(mock) Wrote MOCK_NOTES.md with the instruction.\n');
  out({ kind: 'result', ok: true, text: '(mock) wrote MOCK_NOTES.md', sessionId });
}

// ------------------------------------------------------------------ interactive mode
const HELP = `Mock agent commands (no AI is used):
  peers                         list connected peers
  ctx <peerId>                  peer context
  send <peerId> <intent> <text> message a peer (intent: notify|request)
  reply <messageId> <text>      answer a request you received
  inbox                         check inbox
  wait <messageId> [sec]        wait for a reply
  summary <text>                publish a summary
  tasks | add <title> | claim <id> | done <id> [result]
  status <nodeId> | waitnodes <id,id> [sec]
  ask <question>                ask the human (shows in "Needs you")
  auto                          auto-reply "pong: <body>" to incoming requests
  quit`;

async function interactive() {
  let bus: BusMcp;
  try {
    bus = await connectBusMcp({});
  } catch (err) {
    console.log(`[mock] could not start the switchyard MCP server: ${String(err)}`);
    process.exit(1);
  }
  let autoTimer: NodeJS.Timeout | null = null;
  const lastInbox = new Map<string, string>();
  console.log('[mock] Mock agent ready — type `help`.');
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'mock> ' });
  const show = (o: unknown) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));

  const handleInbox = async (auto: boolean) => {
    const res = await bus.call<{
      messages: { messageId: string; from: string; intent: string; body: string }[];
    }>('check_inbox', {});
    if (!auto || res.messages.length) show(res);
    for (const m of res.messages) {
      lastInbox.set(m.messageId, m.from);
      if (auto && m.intent === 'request') {
        const r = await bus.call('message_peer', {
          peerId: m.from,
          intent: 'response',
          responseTo: m.messageId,
          body: `pong: ${m.body}`,
        });
        show({ autoReplied: m.messageId, ...((r as object) ?? {}) });
      }
    }
  };

  rl.prompt();
  rl.on('line', async (line) => {
    const raw = line.trim();
    if (raw.startsWith('[switchyard]')) {
      console.log('[mock] got a nudge — checking inbox');
      await handleInbox(!!autoTimer).catch((e) => show(String(e)));
      rl.prompt();
      return;
    }
    const [cmd = '', ...rest] = raw.split(/\s+/);
    try {
      switch (cmd) {
        case '':
          break;
        case 'help':
          show(HELP);
          break;
        case 'peers':
          show(await bus.call('list_peers'));
          break;
        case 'ctx':
          show(await bus.call('get_peer_context', { peerId: rest[0] }));
          break;
        case 'send':
          show(
            await bus.call('message_peer', {
              peerId: rest[0],
              intent: rest[1],
              body: rest.slice(2).join(' '),
            }),
          );
          break;
        case 'reply': {
          const to = lastInbox.get(rest[0] ?? '');
          if (!to) throw new Error('unknown messageId — run `inbox` first');
          show(
            await bus.call('message_peer', {
              peerId: to,
              intent: 'response',
              responseTo: rest[0],
              body: rest.slice(1).join(' '),
            }),
          );
          break;
        }
        case 'inbox':
          await handleInbox(false);
          break;
        case 'wait':
          show(
            await bus.call('wait_for_reply', {
              messageId: rest[0],
              timeoutSec: Number(rest[1] ?? 60),
            }),
          );
          break;
        case 'summary':
          show(await bus.call('publish_summary', { text: rest.join(' ') }));
          break;
        case 'tasks':
          show(await bus.call('list_tasks'));
          break;
        case 'add':
          show(await bus.call('add_task', { title: rest.join(' ') }));
          break;
        case 'claim':
          show(await bus.call('claim_task', { taskId: rest[0] }));
          break;
        case 'done':
          show(
            await bus.call('complete_task', {
              taskId: rest[0],
              result: rest.slice(1).join(' ') || undefined,
            }),
          );
          break;
        case 'status':
          show(await bus.call('get_node_status', { nodeId: rest[0] }));
          break;
        case 'waitnodes':
          show(
            await bus.call('wait_for_nodes', {
              nodeIds: (rest[0] ?? '').split(','),
              timeoutSec: Number(rest[1] ?? 60),
            }),
          );
          break;
        case 'ask':
          console.log('[mock] waiting for your answer in the "Needs you" panel…');
          show(await bus.call('ask_user', { question: rest.join(' '), timeoutSec: 600 }));
          break;
        case 'auto':
          if (autoTimer) {
            clearInterval(autoTimer);
            autoTimer = null;
            show('auto-reply off');
          } else {
            autoTimer = setInterval(() => void handleInbox(true).catch(() => undefined), 2000);
            show('auto-reply on: requests get "pong: <body>"');
          }
          break;
        case 'quit':
        case 'exit':
          await bus.close();
          process.exit(0);
          break;
        default:
          show(`unknown command "${cmd}" — type help`);
      }
    } catch (err) {
      show(`error: ${String((err as Error).message ?? err)}`);
    }
    rl.prompt();
  });
  rl.on('close', () => {
    void bus.close().finally(() => process.exit(0));
  });
}

if (process.argv.includes('--turn')) {
  driven().catch((err) => {
    out({ kind: 'result', ok: false, text: '', sessionId: null, error: String(err) });
    process.exit(1);
  });
} else {
  void interactive();
}
