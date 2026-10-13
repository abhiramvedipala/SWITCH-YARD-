#!/usr/bin/env node
// F1 probe: does Antigravity (`agy`) pass its environment to hook commands and MCP children,
// and does it expand `$VAR` inside an MCP entry's `env`? Costs ONE small agy request.
//
// Writes nothing outside a temp folder: the hooks and MCP config are *workspace* files
// (`<tmp>/.agents/hooks.json`, `<tmp>/.agents/mcp_config.json`), so your global agy config is untouched.
// Run:  node scripts/probe-agy-env.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROBE = 'SWITCHYARD_PROBE'; // set in the parent env AND referenced as "$SWITCHYARD_PROBE" in mcp env
const INHERIT = 'SWITCHYARD_PROBE_INHERIT'; // set in the parent env only (not mentioned in any config)
const VALUE = `yes-${process.pid}`;

const which = spawnSync('bash', ['-lc', 'command -v agy'], { encoding: 'utf8' });
const agy = which.stdout.trim();
if (!agy) {
  console.error(
    'agy not found on PATH. Install: curl -fsSL https://antigravity.google/cli/install.sh | bash',
  );
  console.error('then run `agy` once to sign in, then re-run this probe.');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'sy-agy-probe-'));
mkdirSync(join(dir, '.agents'));
const hookEnvFile = join(dir, 'hook-env.txt');
const hookStdinFile = join(dir, 'hook-stdin.json');
const mcpEnvFile = join(dir, 'mcp-env.txt');
const mcpCallFile = join(dir, 'mcp-call.txt');

// Hook: record what the env looks like inside a PreInvocation hook, plus the stdin agy sends.
const hookScript = join(dir, 'hook-probe.mjs');
writeFileSync(
  hookScript,
  `import { writeFileSync } from 'node:fs';
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  writeFileSync(${JSON.stringify(hookEnvFile)}, JSON.stringify({
    ${PROBE}: process.env.${PROBE} ?? null,
    ${INHERIT}: process.env.${INHERIT} ?? null,
  }));
  writeFileSync(${JSON.stringify(hookStdinFile)}, stdin);
  process.stdout.write('{}');
});
`,
);
writeFileSync(
  join(dir, '.agents/hooks.json'),
  JSON.stringify(
    {
      'switchyard-probe': {
        enabled: true,
        PreInvocation: [
          {
            type: 'command',
            command: `"${process.execPath}" "${hookScript}" PreInvocation`,
            timeout: 10,
          },
        ],
      },
    },
    null,
    2,
  ),
);

// MCP server: records its env at startup and exposes one no-op tool that records when it was called.
const mcpScript = join(dir, 'probe-mcp.mjs');
writeFileSync(
  mcpScript,
  `import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(${JSON.stringify(join(process.cwd(), 'package.json'))});
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
writeFileSync(${JSON.stringify(mcpEnvFile)}, JSON.stringify({
  ${PROBE}: process.env.${PROBE} ?? null,
  ${INHERIT}: process.env.${INHERIT} ?? null,
}));
const server = new McpServer({ name: 'switchyard-probe', version: '0.0.1' });
server.tool('probe_ping', 'Replies pong. Call it once.', {}, async () => {
  writeFileSync(${JSON.stringify(mcpCallFile)}, String(Date.now()));
  return { content: [{ type: 'text', text: 'pong' }] };
});
await server.connect(new StdioServerTransport());
`,
);
writeFileSync(
  join(dir, '.agents/mcp_config.json'),
  JSON.stringify(
    {
      mcpServers: {
        'switchyard-probe': {
          command: process.execPath,
          args: [mcpScript],
          env: { [PROBE]: `$${PROBE}` },
          cwd: dir,
          disabled: false,
        },
      },
    },
    null,
    2,
  ),
);

console.log(`probe dir: ${dir}`);
console.log('running agy (one small request, ~1 min max)…');
const run = spawnSync(
  agy,
  [
    '-p',
    'Call the probe_ping tool once, then reply with the single word done.',
    '--output-format',
    'json',
    '--print-timeout',
    '2m',
  ],
  {
    cwd: dir,
    env: { ...process.env, [PROBE]: VALUE, [INHERIT]: VALUE },
    encoding: 'utf8',
    timeout: 150_000,
  },
);

const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : null);
const safeJson = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
const hookEnv = safeJson(read(hookEnvFile) ?? '');
const mcpEnv = safeJson(read(mcpEnvFile) ?? '');
const hookStdin = safeJson(read(hookStdinFile) ?? '');
const envelope = safeJson(run.stdout ?? '');
const stderr = (run.stderr ?? '').trim();

const describe = (v) =>
  v === null || v === undefined ? 'unset' : v === VALUE ? 'inherited ✅' : `literal "${v}"`;
const summary = {
  agyExit: run.status,
  agyStatus: envelope?.status ?? '(no JSON envelope)',
  conversationId: envelope?.conversation_id ?? null,
  hookRan: hookEnv !== null,
  hookEnv: hookEnv
    ? { [PROBE]: describe(hookEnv[PROBE]), [INHERIT]: describe(hookEnv[INHERIT]) }
    : 'hook did not run',
  hookStdinKeys: hookStdin ? Object.keys(hookStdin) : null,
  mcpStarted: mcpEnv !== null,
  mcpEnv: mcpEnv
    ? {
        [`${PROBE} (config "$${PROBE}")`]: describe(mcpEnv[PROBE]),
        [`${INHERIT} (not in config)`]: describe(mcpEnv[INHERIT]),
      }
    : 'MCP server did not start',
  toolCalled: existsSync(mcpCallFile),
  response: envelope?.response ?? null,
  stderrTail: stderr.split('\n').slice(-5).join('\n'),
};

console.log('\n=== F1 PROBE SUMMARY (paste this back) ===');
console.log(JSON.stringify(summary, null, 2));
console.log('==========================================');
if (process.env.KEEP_PROBE_DIR !== '1') rmSync(dir, { recursive: true, force: true });
