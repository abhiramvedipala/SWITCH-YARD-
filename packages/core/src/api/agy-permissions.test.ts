import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let app: Awaited<ReturnType<typeof import('../server.js').buildServer>>['app'];
let token: string;
let gem: string;
let repoRoot: string;

beforeAll(async () => {
  process.env.SWITCHYARD_HOME = mkdtempSync(join(tmpdir(), 'sy-api-home-'));
  gem = mkdtempSync(join(tmpdir(), 'sy-api-gem-'));
  process.env.SWITCHYARD_GEMINI_DIR = gem;
  delete process.env.SWITCHYARD_SCRATCH_ROOT;
  const { buildServer } = await import('../server.js');
  const built = await buildServer({ port: 4790, dbPath: ':memory:', quiet: true });
  app = built.app;
  token = built.token;
  repoRoot = (await import('../paths.js')).REPO_ROOT;
});
afterAll(async () => {
  await app.close();
});

const post = (body: unknown) =>
  app.inject({
    method: 'POST',
    url: '/api/agy/permissions',
    headers: { authorization: `Bearer ${token}`, host: '127.0.0.1:4790' },
    payload: body as object,
  });
const settings = () => JSON.parse(readFileSync(join(gem, 'antigravity-cli/settings.json'), 'utf8'));

describe('POST /api/agy/permissions (opt-in, reversible)', () => {
  it('requires the UI token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agy/permissions',
      payload: { action: 'remove' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('writes nothing until the owner clicks', () => {
    expect(existsSync(join(gem, 'antigravity-cli/settings.json'))).toBe(false);
  });

  it('allow-bus adds the MCP rule and reports state', async () => {
    const res = await post({ action: 'allow-bus' });
    expect(res.json()).toMatchObject({ bus: true, testCommands: false });
    expect(settings().permissions.allow).toEqual(['mcp(switchyard/*)']);
  });

  it('allow-tests needs a folder and refuses the app’s own folder', async () => {
    expect((await post({ action: 'allow-tests' })).statusCode).toBe(400);
    const own = await post({ action: 'allow-tests', dir: repoRoot });
    expect(own.statusCode).toBe(400);
    expect(own.json().message).toMatch(/own folder/);
  });

  it('allow-tests adds a scoped write rule plus the test-runner rule; remove reverts all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sy-run-'));
    const res = await post({ action: 'allow-tests', dir });
    expect(res.json()).toMatchObject({ bus: true, testCommands: true });
    expect(settings().permissions.allow).toContain(`write_file(${dir}/)`);
    await post({ action: 'remove' });
    expect(settings()).toEqual({});
  });
});
