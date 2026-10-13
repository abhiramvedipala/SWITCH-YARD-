#!/usr/bin/env node
/* global document */
// Drives the built app in headless Chromium and checks each phase's DoD with the mock harness (no AI usage).
// Everything lives in temp dirs + ./scratch; the real ~/.switchyard and ~/.claude are never touched.
// Usage: npm run build && node scripts/ui-check.mjs   (CHROMIUM_PATH=... to pick a browser)
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const home = mkdtempSync(join(tmpdir(), 'sy-ui-home-'));
const claudeProjects = mkdtempSync(join(tmpdir(), 'sy-ui-claude-'));
const wsDir = join(root, 'scratch', 'ui-check');
rmSync(wsDir, { recursive: true, force: true });
mkdirSync(wsDir, { recursive: true });
const shots = join(root, 'scratch', 'ui-shots');
mkdirSync(shots, { recursive: true });

// A fake Claude Code transcript so the import dialog has something to list.
mkdirSync(join(claudeProjects, '-tmp-demo'), { recursive: true });
writeFileSync(
  join(claudeProjects, '-tmp-demo', '11111111-2222-3333-4444-555555555555.jsonl'),
  [
    JSON.stringify({
      type: 'user',
      cwd: wsDir,
      sessionId: '11111111-2222-3333-4444-555555555555',
      message: { role: 'user', content: 'Refactor the parser into smaller functions' },
    }),
    JSON.stringify({
      type: 'assistant',
      cwd: wsDir,
      sessionId: '11111111-2222-3333-4444-555555555555',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Sure.' }] },
    }),
  ].join('\n') + '\n',
);

const port = 4799;
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [join(root, 'packages/core/dist/server.js')], {
  env: {
    ...process.env,
    SWITCHYARD_HOME: home,
    SWITCHYARD_PORT: String(port),
    SWITCHYARD_CLAUDE_PROJECTS: claudeProjects,
    SWITCHYARD_SCRATCH_ROOT: join(root, 'scratch'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

const results = [];
const check = (ok, msg) => {
  results.push({ ok, msg });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10_000, step = 150) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // retry
    }
    if (Date.now() > end) return null;
    await sleep(step);
  }
}

let browser;
try {
  await until(() => serverLog.includes('listening'), 15_000);
  const token = readFileSync(join(home, 'ui-session'), 'utf8').trim();
  const api = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  };

  const exe =
    process.env.CHROMIUM_PATH ||
    ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find(
      existsSync,
    );
  browser = await chromium.launch({ executablePath: exe, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  // ---------------- Phase 0: login
  await page.goto(base);
  await page.waitForSelector('.login-card');
  await page.fill('input[type=password]', 'wrong');
  await page.click('button[type=submit]');
  check(
    !!(await until(() => page.isVisible('.login-card .error'))),
    'P0 wrong token rejected on the login page',
  );
  await page.fill('input[type=password]', token);
  await page.click('button[type=submit]');
  check(
    !!(await until(() => page.isVisible('text=Welcome to Switchyard'))),
    'P0 correct token → app (empty state)',
  );

  const ws = (await api('POST', '/api/workspaces', { rootDir: wsDir, name: 'UI check' })).data;
  await page.reload();
  check(
    !!(await until(() => page.isVisible('text=Empty canvas'))),
    'P0/P2 workspace shows an empty canvas',
  );

  // ---------------- Phase 1: terminal survives reload
  const term = (
    await api('POST', `/api/workspaces/${ws.id}/nodes`, {
      type: 'terminal',
      title: 'Shell',
      x: 40,
      y: 40,
      w: 560,
      h: 320,
    })
  ).data;
  await until(() => page.isVisible('.xterm'));
  await page.click(`.react-flow__node[data-id="${term.id}"] .xterm`);
  await page.keyboard.type('echo hello-$((40+2))-switchyard');
  await page.keyboard.press('Enter');
  const sawOutput = await until(async () =>
    (await page.textContent(`.react-flow__node[data-id="${term.id}"] .xterm-rows`))?.includes(
      'hello-42-switchyard',
    ),
  );
  check(!!sawOutput, 'P1 typed a command into the terminal and saw its output');
  await page.reload();
  const stillThere = await until(
    async () =>
      (await page.textContent(`.react-flow__node[data-id="${term.id}"] .xterm-rows`))?.includes(
        'hello-42-switchyard',
      ),
    8000,
  );
  check(!!stillThere, 'P1 after reload, the terminal output is still there (scrollback replay)');

  // ---------------- Phase 2: 3 nodes + 2 edges persist
  await page.click('button:has-text("+ Add")');
  await page.click('.add-menu button:has-text("Note")');
  await until(async () => (await page.$$('.react-flow__node')).length === 2);
  await page.click('button:has-text("+ Add")');
  await page.click('.add-menu button:has-text("Browser preview")');
  await until(async () => (await page.$$('.react-flow__node')).length === 3);
  const g1 = (await api('GET', `/api/workspaces/${ws.id}/graph`)).data;
  const [n1, n2, n3] = g1.nodes;
  await api('POST', `/api/workspaces/${ws.id}/edges`, { from: n1.id, to: n2.id });
  await api('POST', `/api/workspaces/${ws.id}/edges`, { from: n2.id, to: n3.id });
  const note = g1.nodes.find((n) => n.type === 'note');
  await page.fill(`.react-flow__node[data-id="${note.id}"] textarea`, 'remember the milk');
  await sleep(700);
  await page.reload();
  await until(async () => (await page.$$('.react-flow__edge')).length === 2);
  const nodesAfter = (await page.$$('.react-flow__node')).length;
  const edgesAfter = (await page.$$('.react-flow__edge')).length;
  const g2 = (await api('GET', `/api/workspaces/${ws.id}/graph`)).data;
  const samePos = g1.nodes.every((a) =>
    g2.nodes.some((b) => b.id === a.id && b.x === a.x && b.y === a.y),
  );
  const noteText = await page.inputValue(`.react-flow__node[data-id="${note.id}"] textarea`);
  check(
    nodesAfter === 3 && edgesAfter === 2 && samePos && noteText === 'remember the milk',
    `P2 after reload: ${nodesAfter} nodes, ${edgesAfter} edges, same positions, note text kept`,
  );
  await page.screenshot({ path: join(shots, 'p2-canvas.png') });

  // focus mode
  await page.click(`.react-flow__node[data-id="${note.id}"] .node-header`);
  await page.keyboard.press('f');
  check(!!(await until(() => page.isVisible('.focus-overlay'))), 'P2 F opens focus mode');
  await page.keyboard.press('Escape');
  check(
    !!(await until(async () => !(await page.isVisible('.focus-overlay')))),
    'P2 Esc leaves focus mode',
  );
  await page.keyboard.press('Control+k');
  check(
    !!(await until(() => page.isVisible('.palette'))),
    'P2 ⌘K/Ctrl+K opens the command palette',
  );
  await page.keyboard.press('Escape');

  // ---------------- Phase 3/4: mock agents, ask_user → Needs you → answer
  const A = (
    await api('POST', `/api/workspaces/${ws.id}/nodes`, {
      type: 'agent-terminal',
      harness: 'mock',
      title: 'Mock A',
      x: 700,
      y: 40,
    })
  ).data;
  const B = (
    await api('POST', `/api/workspaces/${ws.id}/nodes`, {
      type: 'agent-terminal',
      harness: 'mock',
      title: 'Mock B',
      x: 700,
      y: 520,
    })
  ).data;
  await api('POST', `/api/workspaces/${ws.id}/edges`, { from: A.id, to: B.id });
  const termText = (id) => page.textContent(`.react-flow__node[data-id="${id}"] .xterm-rows`);
  await until(async () => (await termText(A.id))?.includes('Mock agent ready'), 15_000);
  await until(async () => (await termText(B.id))?.includes('Mock agent ready'), 15_000);
  const typeIn = async (id, text) => {
    await page.click(`.react-flow__node[data-id="${id}"] .xterm`, { position: { x: 24, y: 12 } });
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
  };
  await typeIn(A.id, 'peers');
  check(
    !!(await until(async () => (await termText(A.id))?.includes('Mock B'), 8000)),
    'P3 mock A lists connected peer B through bus-mcp',
  );
  await typeIn(B.id, 'auto');
  await typeIn(A.id, `send ${B.id} request ping`);
  const msgId = await until(
    async () => (await termText(A.id))?.match(/"messageId": "([^"]+)"/)?.[1],
    8000,
  );
  await typeIn(A.id, `wait ${msgId} 20`);
  check(
    !!(await until(async () => (await termText(A.id))?.includes('pong: ping'), 15_000)),
    'P3 A → request → B (auto) → response → A wait_for_reply got "pong: ping"',
  );

  const t0 = Date.now();
  await typeIn(A.id, 'ask Should I ship it?');
  const appeared = await until(() => page.isVisible('button.btn-attn'), 5000, 100);
  const latency = Date.now() - t0;
  check(
    !!appeared && latency < 2500,
    `P4 ask_user shows in "Needs you" (${latency} ms after typing; DoD ≤ 2 s from the agent asking)`,
  );
  await page.click('button.btn-attn');
  await page.waitForSelector('.attn-question');
  await page.screenshot({ path: join(shots, 'p4-needs-you.png') });
  await page.fill('.attn-question .reply input', 'yes, ship it');
  await page.click('.attn-question .reply button:has-text("Send")');
  check(
    !!(await until(async () => (await termText(A.id))?.includes('yes, ship it'), 8000)),
    'P4 answer from the sidebar reached the agent',
  );
  const feed = (await api('GET', '/api/attention')).data;
  check(Array.isArray(feed.items), 'P4 /api/attention JSON feed responds');
  const states = (await api('GET', `/api/workspaces/${ws.id}/graph`)).data.nodes
    .filter((n) => n.harness === 'mock')
    .map((n) => n.state);
  check(
    states.every((s) => ['idle', 'working'].includes(s)),
    `P4 status chips report states (${states.join(', ')})`,
  );

  // ---------------- Phase 5: board task claimed/completed by a mock agent
  await page.click('.side-head .icon-btn');
  await page.click('.views button:has-text("Board")');
  await page.fill('.board-add input', 'Write the README');
  await page.click('.board-add button:has-text("Add task")');
  await until(() => page.isVisible('.card:has-text("Write the README")'));
  const task = (await api('GET', `/api/workspaces/${ws.id}/tasks`)).data.tasks[0];
  const colOf = async () =>
    page.evaluate((id) => {
      const card = [...document.querySelectorAll('.card')].find((c) =>
        c.textContent.includes(`#${id}`),
      );
      return card?.closest('.column')?.querySelector('.column-head')?.textContent ?? '';
    }, task.id);
  check((await colOf()).startsWith('Open'), 'P5 new task appears in Open');
  await api('POST', `/api/nodes/${A.id}/reply`, { text: `claim ${task.id}` });
  check(
    !!(await until(async () => (await colOf()).startsWith('In progress'), 8000)),
    'P5 mock agent claim_task → card moves to In progress',
  );
  await api('POST', `/api/nodes/${A.id}/reply`, { text: `done ${task.id} wrote it` });
  check(
    !!(await until(async () => (await colOf()).startsWith('Done'), 8000)),
    'P5 complete_task → card moves to Done',
  );
  await page.screenshot({ path: join(shots, 'p5-board.png') });

  // ---------------- Phase 6: a run through the UI (mock harness)
  await page.click('.views button:has-text("Runs")');
  await page.fill(
    '.new-run textarea',
    'Create hello.py with a function that reverses a string and pytest tests; have the other agent review',
  );
  for (const sel of await page.$$('.new-run select')) {
    const opts = await sel.$$eval('option', (os) => os.map((o) => o.value));
    if (opts.includes('mock')) await sel.selectOption('mock');
  }
  await page.click('.new-run button:has-text("Plan run")');
  await until(() => page.isVisible('button:has-text("Approve & start")'), 15_000);
  await page.click('button:has-text("Approve & start")');
  const finished = await until(() => page.isVisible('.result-card'), 30_000);
  const resultText = finished ? await page.textContent('.result-card') : '';
  check(
    !!finished && /approved by review/.test(resultText) && /2 rounds/.test(resultText),
    `P6 run finished with a result card (“${resultText.slice(0, 80)}…”)`,
  );
  await page.screenshot({ path: join(shots, 'p6-runs.png'), fullPage: true });

  // Project chat (mock)
  await api('PATCH', '/api/settings', { projectChatHarness: 'mock' });
  await page.click('button:has-text("Ask Switchyard")');
  await page.waitForSelector('.project-chat textarea');
  await page.selectOption('.pc-bar select', 'mock');
  await sleep(300);
  await page.fill('.project-chat textarea', 'what is everyone doing?');
  await page.keyboard.press('Enter');
  check(
    !!(await until(
      async () => (await page.textContent('.project-chat'))?.includes('read your question'),
      10_000,
    )),
    'P6 Ask Switchyard streams a reply (mock)',
  );

  // ---------------- Phase 7: import dialog lists Claude sessions
  await page.click('button:has-text("Import sessions")');
  check(
    !!(await until(() => page.isVisible('text=Refactor the parser into smaller functions'))),
    'P7 import dialog lists Claude Code sessions from the projects folder',
  );
  await page.screenshot({ path: join(shots, 'p7-import.png') });
  await page.keyboard.press('Escape');

  // ---------------- Phase 8: remote/mobile view is read-only but can answer
  const remoteHeaders = { 'X-Forwarded-For': '100.101.102.103' };
  const blocked = await api(
    'POST',
    `/api/workspaces/${ws.id}/nodes`,
    { type: 'note' },
    remoteHeaders,
  );
  check(
    blocked.status === 403,
    `P8 remote write is blocked while read-only (HTTP ${blocked.status})`,
  );
  const mctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    extraHTTPHeaders: remoteHeaders,
    isMobile: true,
    hasTouch: true,
  });
  const mobile = await mctx.newPage();
  await mobile.goto(base);
  await mobile.fill('input[type=password]', token);
  await mobile.click('button[type=submit]');
  await mobile.waitForSelector('.mobile');
  check(
    await mobile.isVisible('.mobile-top .badge:has-text("read-only")'),
    'P8 phone layout loads and shows read-only',
  );
  await api('POST', `/api/nodes/${A.id}/reply`, { text: 'ask Deploy to staging?' });
  await until(() => mobile.isVisible('.attn-question'), 8000);
  await mobile.fill('.attn-question .reply input', 'go ahead');
  await mobile.click('.attn-question .reply button:has-text("Send")');
  const answered = await until(
    async () => (await api('GET', '/api/attention')).data.items.every((i) => i.kind !== 'question'),
    8000,
  );
  check(!!answered, 'P8 answered an ask_user question from the phone layout');
  await mobile.screenshot({ path: join(shots, 'p8-mobile.png') });
  const loginSpam = [];
  for (let i = 0; i < 10; i++)
    loginSpam.push(
      (
        await fetch(base + '/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-Forwarded-For': '9.9.9.9' },
          body: '{"token":"x"}',
        })
      ).status,
    );
  check(loginSpam.includes(429), `P8 login is rate-limited (${loginSpam.join(',')})`);

  check(
    errors.length === 0,
    `no uncaught page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`,
  );
} catch (err) {
  check(false, `ui-check crashed: ${err?.stack ?? err}`);
} finally {
  await browser?.close().catch(() => undefined);
  server.kill('SIGTERM');
}
const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed. Screenshots: scratch/ui-shots/`,
);
if (failed.length) console.log(serverLog.slice(-3000));
process.exit(failed.length ? 1 : 0);
