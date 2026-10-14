import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { originAllowed } from './ws.js';

const req = (headers: Record<string, string>) => ({ headers }) as unknown as FastifyRequest;

describe('websocket origin check', () => {
  it('allows same-origin, loopback and tailnet origins', () => {
    expect(originAllowed(req({ host: '127.0.0.1:4777', origin: 'http://127.0.0.1:4777' }))).toBe(
      true,
    );
    expect(
      originAllowed(req({ host: '127.0.0.1:4777', origin: 'https://mac.tail1234.ts.net' })),
    ).toBe(true);
    expect(originAllowed(req({ host: '127.0.0.1:4777' }))).toBe(true);
  });
  it('rejects other sites', () => {
    expect(originAllowed(req({ host: '127.0.0.1:4777', origin: 'https://evil.example' }))).toBe(
      false,
    );
    expect(
      originAllowed(req({ host: '127.0.0.1:4777', origin: 'https://ts.net.evil.example' })),
    ).toBe(false);
    expect(originAllowed(req({ host: '127.0.0.1:4777', origin: 'not a url' }))).toBe(false);
  });
});

describe('remote detection', async () => {
  const { isRemoteRequest } = await import('./server.js');
  it('loopback is local; forwarded or non-loopback hosts are remote', () => {
    expect(isRemoteRequest(req({ host: '127.0.0.1:4777' }), 4777)).toBe(false);
    expect(isRemoteRequest(req({ host: 'localhost:4777' }), 4777)).toBe(false);
    expect(
      isRemoteRequest(req({ host: '127.0.0.1:4777', 'x-forwarded-for': '100.64.0.2' }), 4777),
    ).toBe(true);
    expect(isRemoteRequest(req({ host: 'mac.tail1234.ts.net' }), 4777)).toBe(true);
  });
});

describe('funnel detection', async () => {
  const { isFunnelRequest } = await import('./server.js');
  it('flags Tailscale Funnel requests only', () => {
    expect(isFunnelRequest(req({ host: 'x.ts.net', 'tailscale-funnel-request': '?1' }))).toBe(true);
    expect(isFunnelRequest(req({ host: 'x.ts.net', 'tailscale-user-login': 'a@b.c' }))).toBe(false);
  });
});

describe('scrubHostSessionEnv', () => {
  it("drops a parent Claude Code session's markers but keeps user config", async () => {
    const { scrubHostSessionEnv } = await import('./server.js');
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HOME: '/Users/x',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
      CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
      CLAUDE_CODE_HOST_SESSION_ID: 'local_1',
      CLAUDE_AGENT_SDK_VERSION: '0.3',
      CLAUDE_PREVIEW_CLASSIFIER_FLOOR: '1',
      CLAUDE_PID: '123',
      CLAUDE_EFFORT: 'xhigh',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8000',
      CLAUDE_CONFIG_DIR: '/Users/x/.claude',
      ANTHROPIC_MODEL: 'm',
      SWITCHYARD_HOME: '/tmp/h',
    };
    const dropped = scrubHostSessionEnv(env);
    expect(dropped.sort()).toEqual(
      [
        'CLAUDE_AGENT_SDK_VERSION',
        'CLAUDE_CODE_CHILD_SESSION',
        'CLAUDE_CODE_ENTRYPOINT',
        'CLAUDE_CODE_HOST_SESSION_ID',
        'CLAUDE_CODE_MESSAGING_TOKEN',
        'CLAUDE_EFFORT',
        'CLAUDE_PID',
        'CLAUDE_PREVIEW_CLASSIFIER_FLOOR',
      ].sort(),
    );
    expect(Object.keys(env).sort()).toEqual(
      [
        'ANTHROPIC_MODEL',
        'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
        'CLAUDE_CODE_USE_BEDROCK',
        'CLAUDE_CONFIG_DIR',
        'HOME',
        'PATH',
        'SWITCHYARD_HOME',
      ].sort(),
    );
  });
});
