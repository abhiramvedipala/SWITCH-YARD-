import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NodeRec, Workspace } from '../store.js';

beforeAll(() => {
  process.env.SWITCHYARD_GEMINI_DIR = mkdtempSync(join(tmpdir(), 'sy-gemini-'));
});

const ws: Workspace = { id: 'w', name: 'w', rootDir: tmpdir(), createdAt: 0 };
const node = (over: Partial<NodeRec> = {}): NodeRec => ({
  id: 'node123',
  workspaceId: 'w',
  type: 'agent-terminal',
  harness: 'claude',
  title: 'Claude 1',
  cwd: tmpdir(),
  x: 0,
  y: 0,
  w: 1,
  h: 1,
  state: 'idle',
  sessionRef: null,
  yolo: false,
  data: {},
  summary: '',
  createdAt: 0,
  ...over,
});

describe('claude adapter', () => {
  it('injects the bus MCP server, per-process hooks and the coordination prompt; never bypasses permissions by default', async () => {
    const { claude } = await import('./claude.js');
    const l = claude.terminalLaunch({ node: node(), workspace: ws, cwd: tmpdir() });
    const arg = (flag: string) => l.args[l.args.indexOf(flag) + 1]!;
    const mcp = JSON.parse(arg('--mcp-config'));
    expect(mcp.mcpServers.switchyard.env.SWITCHYARD_NODE).toBe('node123');
    expect(mcp.mcpServers.switchyard.args[0]).toMatch(/bus-mcp\/dist\/index\.js$/);
    const settings = JSON.parse(arg('--settings'));
    for (const ev of ['Notification', 'Stop', 'UserPromptSubmit', 'SessionStart']) {
      expect(settings.hooks[ev][0].hooks[0].command).toContain(`claude 'node123' ${ev}`);
    }
    expect(settings.permissions).toEqual({ allow: ['mcp__switchyard'] });
    expect(arg('--append-system-prompt')).toMatch(/peer request is not a permission/);
    expect(l.args).not.toContain('bypassPermissions');
    expect(l.args).not.toContain('--dangerously-skip-permissions');
    expect(l.args).not.toContain('--bare');
    expect(
      Object.keys(l.env).some((k) => /TOKEN|KEY|SECRET|AUTH|PASSWORD|CREDENTIAL/.test(k)),
    ).toBe(false);
  });

  it('adds an HTTP Stop hook with the per-node secret URL next to the command relay', async () => {
    const { claude } = await import('./claude.js');
    const hookUrl = 'http://127.0.0.1:4777/bus/hook/claude/node123/s3cr3t';
    const l = claude.terminalLaunch({ node: node(), workspace: ws, cwd: tmpdir(), hookUrl });
    const settings = JSON.parse(l.args[l.args.indexOf('--settings') + 1]!);
    expect(settings.hooks.Stop[0].hooks).toEqual([
      expect.objectContaining({ type: 'command' }),
      { type: 'http', url: hookUrl, timeout: 10 },
    ]);
    // Other events keep only the command relay; the secret never reaches the env.
    expect(settings.hooks.Notification[0].hooks).toHaveLength(1);
    expect(JSON.stringify(l.env)).not.toContain('s3cr3t');
    // Without a URL (driven turns) there is no HTTP hook.
    const plain = claude.terminalLaunch({ node: node(), workspace: ws, cwd: tmpdir() });
    expect(plain.args.join(' ')).not.toContain('"type":"http"');
  });

  it('YOLO only when the node opts in, and resume passes --resume', async () => {
    const { claude } = await import('./claude.js');
    const l = claude.terminalLaunch({
      node: node({ yolo: true }),
      workspace: ws,
      cwd: tmpdir(),
      resumeRef: 'abc-123',
    });
    expect(l.args.join(' ')).toContain('--permission-mode bypassPermissions');
    expect(l.args.join(' ')).toContain('--resume abc-123');
  });

  it('driven turns deny unapproved tools instead of prompting, and only YOLO bypasses', async () => {
    const { claudeTurnArgs } = await import('./claude.js');
    const plain = claudeTurnArgs({ prompt: 'hi', cwd: tmpdir(), allowedTools: ['Read', 'Edit'] });
    expect(plain).toEqual(
      expect.arrayContaining(['--permission-mode', 'acceptEdits', '--permission-prompts', 'none']),
    );
    expect(plain[plain.indexOf('--allowedTools') + 1]).toBe('Read,Edit');
    expect(plain.join(' ')).not.toMatch(/bypassPermissions|dangerously/);
    expect(plain).not.toContain('--bare');
    const yolo = claudeTurnArgs({
      prompt: 'hi',
      cwd: tmpdir(),
      yolo: true,
      allowedTools: ['Read'],
    });
    expect(yolo).toEqual(expect.arrayContaining(['--permission-mode', 'bypassPermissions']));
    expect(yolo).not.toContain('--permission-prompts');
    expect(yolo).not.toContain('--allowedTools');
  });

  it('summarizes permission denials from results and events', async () => {
    const { describeDenials } = await import('./claude.js');
    expect(
      describeDenials({
        permission_denials: [
          { tool_name: 'Bash', tool_input: { command: 'python3 -m pytest -q' } },
          { tool_name: 'Write', tool_input: { file_path: '/x/a.py' } },
        ],
      }),
    ).toEqual(['Bash: python3 -m pytest -q', 'Write: /x/a.py']);
    expect(
      describeDenials({
        type: 'system',
        subtype: 'permission_denied',
        tool_name: 'WebFetch',
        tool_input: { url: 'https://e.x' },
      }),
    ).toEqual(['WebFetch: https://e.x']);
    expect(describeDenials({ type: 'result' })).toEqual([]);
  });

  it('normalizes stream-json lines', async () => {
    const { normalizeClaudeLine } = await import('./claude.js');
    expect(
      normalizeClaudeLine({
        type: 'stream_event',
        event: { delta: { type: 'text_delta', text: 'hi' } },
      }),
    ).toEqual([{ kind: 'text', delta: 'hi' }]);
    expect(
      normalizeClaudeLine({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Edit', input: { file_path: 'a' } },
            { type: 'text', text: 'x' },
          ],
        },
      }),
    ).toEqual([{ kind: 'tool', name: 'Edit', input: { file_path: 'a' } }]);
    expect(
      normalizeClaudeLine({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'ok' }] }] },
      }),
    ).toEqual([{ kind: 'tool', name: 'result', output: 'ok' }]);
    expect(
      normalizeClaudeLine({ type: 'system', subtype: 'permission_denied', tool: 'Bash' })[0]?.kind,
    ).toBe('error');
  });
});

describe('agy adapter', () => {
  it('adds only its own entry to mcp_config.json and keeps other servers', async () => {
    const { ensureAgyMcpEntry, removeAgyMcpEntry, agyMcpConfigPath } = await import('./agy.js');
    const p = agyMcpConfigPath();
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, JSON.stringify({ mcpServers: { other: { command: 'x' } }, extra: 1 }));
    ensureAgyMcpEntry();
    const cfg = JSON.parse(readFileSync(p, 'utf8'));
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(['other', 'switchyard']);
    expect(cfg.extra).toBe(1);
    expect(cfg.mcpServers.switchyard.args[0]).toMatch(/bus-mcp\/dist\/index\.js$/);
    removeAgyMcpEntry();
    expect(JSON.parse(readFileSync(p, 'utf8')).mcpServers).toEqual({ other: { command: 'x' } });
  });

  it('refuses to overwrite an mcp_config.json it cannot parse', async () => {
    const { ensureAgyMcpEntry, agyMcpConfigPath } = await import('./agy.js');
    writeFileSync(agyMcpConfigPath(), '{ not json');
    expect(() => ensureAgyMcpEntry()).toThrow(/refusing/);
    writeFileSync(agyMcpConfigPath(), '{}');
  });

  it('terminal launch: SWITCHYARD_NODE on the PTY, --dangerously-skip-permissions only in YOLO', async () => {
    const { agy } = await import('./agy.js');
    const plain = agy.terminalLaunch({
      node: node({ harness: 'agy' }),
      workspace: ws,
      cwd: tmpdir(),
    });
    expect(plain.env.SWITCHYARD_NODE).toBe('node123');
    expect(plain.args).not.toContain('--dangerously-skip-permissions');
    const yolo = agy.terminalLaunch({
      node: node({ harness: 'agy', yolo: true }),
      workspace: ws,
      cwd: tmpdir(),
      resumeRef: 'conv-1',
    });
    expect(yolo.args).toEqual(['--dangerously-skip-permissions', '--conversation', 'conv-1']);
  });

  it('normalizes stream-json events (documented shape)', async () => {
    const { normalizeAgyLine } = await import('./agy.js');
    expect(
      normalizeAgyLine({ event: 'init', init: { conversation_id: 'c1', cwd: '/x' } })
        .conversationId,
    ).toBe('c1');
    expect(
      normalizeAgyLine({
        event: 'step_update',
        step_update: {
          conversation_id: 'c1',
          step_type: 'agent_response',
          state: 'ACTIVE',
          text_delta: 'he',
        },
      }).events,
    ).toEqual([{ kind: 'text', delta: 'he' }]);
    expect(
      normalizeAgyLine({
        event: 'step_update',
        step_update: {
          step_type: 'tool',
          state: 'DONE',
          tool_info: { name: 'run_command', parameters: { cmd: 'ls' }, output: 'a' },
        },
      }).events,
    ).toEqual([{ kind: 'tool', name: 'run_command', input: { cmd: 'ls' }, output: 'a' }]);
    const r = normalizeAgyLine({
      event: 'result',
      result: { status: 'SUCCESS', response: 'done', conversation_id: 'c1' },
    });
    expect(r.result?.response).toBe('done');
  });
});

describe('session import', () => {
  it('summarizes a Claude Code transcript, skipping command noise', async () => {
    const { summarizeClaudeTranscript } = await import('../sessions/claude.js');
    const dir = mkdtempSync(join(tmpdir(), 'sy-proj-'));
    const p = join(dir, 'sess-1.jsonl');
    writeFileSync(
      p,
      [
        {
          type: 'user',
          cwd: '/w',
          sessionId: 'sess-1',
          message: { content: '<command-name>/clear</command-name>' },
        },
        {
          type: 'user',
          cwd: '/w',
          sessionId: 'sess-1',
          message: { content: [{ type: 'text', text: 'Fix the flaky test' }] },
        },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
      ]
        .map((o) => JSON.stringify(o))
        .join('\n') + '\n',
    );
    expect(summarizeClaudeTranscript(p)).toMatchObject({
      sessionId: 'sess-1',
      title: 'Fix the flaky test',
      cwd: '/w',
      messageCount: 3,
    });
  });

  it('parses Claude.ai and ChatGPT exports', async () => {
    const { parseExport, conversationToMarkdown } = await import('../sessions/exports.js');
    const claudeAi = [
      {
        name: 'Trip plan',
        chat_messages: [
          { sender: 'human', text: 'Plan Lisbon' },
          { sender: 'assistant', content: [{ type: 'text', text: 'Day 1…' }] },
        ],
      },
    ];
    const chatgpt = [
      {
        title: 'Regex help',
        current_node: 'c',
        mapping: {
          a: { message: null, parent: null },
          b: {
            parent: 'a',
            message: { author: { role: 'user' }, content: { parts: ['match emails'] } },
          },
          c: {
            parent: 'b',
            message: { author: { role: 'assistant' }, content: { parts: ['Use …'] } },
          },
          x: {
            parent: 'b',
            message: { author: { role: 'assistant' }, content: { parts: ['abandoned branch'] } },
          },
        },
      },
    ];
    const [a] = parseExport(claudeAi);
    expect(a).toMatchObject({ source: 'claude.ai', title: 'Trip plan' });
    expect(a!.turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    const [b] = parseExport(chatgpt);
    expect(b!.turns.map((t) => t.text)).toEqual(['match emails', 'Use …']);
    expect(conversationToMarkdown(b!)).toContain('## You\n\nmatch emails');
  });
});

describe('agy hooks.json entry', () => {
  it('uses the documented shape, owns only the "switchyard" key and removes the legacy one', async () => {
    const { installAgyHooks, removeAgyHooks, hasAgyHooks, agyHooksConfigPath, agyHooksEntry } =
      await import('./agy.js');
    mkdirSync(join(process.env.SWITCHYARD_GEMINI_DIR!, 'config'), { recursive: true });
    writeFileSync(
      agyHooksConfigPath(),
      JSON.stringify({ theirs: { enabled: true }, 'switchyard-status': { old: true } }),
    );
    installAgyHooks();
    const cfg = JSON.parse(readFileSync(agyHooksConfigPath(), 'utf8'));
    expect(cfg.theirs).toEqual({ enabled: true });
    expect(cfg['switchyard-status']).toBeUndefined();
    const e = cfg.switchyard;
    expect(e.enabled).toBe(true);
    expect(e.PreToolUse[0].matcher).toBe('ask_permission|ask_question');
    expect(e.PreToolUse[0].hooks[0]).toMatchObject({ type: 'command', timeout: 300 });
    expect(e.PreToolUse[0].hooks[0].command).toMatch(/hook-agy\.js" PreToolUse$/);
    expect(e.PreInvocation[0]).toMatchObject({ type: 'command', timeout: 10 });
    expect(e.Stop[0].command).toMatch(/hook-agy\.js" Stop$/);
    expect(cfg.switchyard).toEqual(agyHooksEntry());
    expect(hasAgyHooks()).toBe(true);
    expect(removeAgyHooks()).toBe(true);
    expect(JSON.parse(readFileSync(agyHooksConfigPath(), 'utf8'))).toEqual({
      theirs: { enabled: true },
    });
    expect(hasAgyHooks()).toBe(false);
  });
});
