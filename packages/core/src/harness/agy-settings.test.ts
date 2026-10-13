import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let mod: typeof import('./agy-settings.js');

beforeEach(async () => {
  process.env.SWITCHYARD_HOME = mkdtempSync(join(tmpdir(), 'sy-agyset-home-'));
  process.env.SWITCHYARD_GEMINI_DIR = mkdtempSync(join(tmpdir(), 'sy-agyset-gem-'));
  mod = await import('./agy-settings.js');
});

const read = () => JSON.parse(readFileSync(mod.agySettingsPath(), 'utf8'));
const seed = (obj: unknown) => {
  mkdirSync(join(mod.agySettingsPath(), '..'), { recursive: true });
  writeFileSync(mod.agySettingsPath(), typeof obj === 'string' ? obj : JSON.stringify(obj));
};

describe('agy settings.json allow rules', () => {
  it('creates the file when missing and adds only what it is asked to', () => {
    expect(mod.addAllowRules([mod.BUS_RULE]).added).toEqual([mod.BUS_RULE]);
    expect(read()).toEqual({ permissions: { allow: ['mcp(switchyard/*)'] } });
  });

  it('keeps foreign keys and the owner’s own rules, and backs up first', () => {
    seed({ theme: 'dark', permissions: { allow: ['command(git)'], deny: ['command(rm)'] } });
    mod.addAllowRules([mod.BUS_RULE]);
    expect(read()).toEqual({
      theme: 'dark',
      permissions: { allow: ['command(git)', 'mcp(switchyard/*)'], deny: ['command(rm)'] },
    });
    const bak = JSON.parse(readFileSync(`${mod.agySettingsPath()}.bak`, 'utf8'));
    expect(bak.permissions.allow).toEqual(['command(git)']);
  });

  it('is idempotent', () => {
    mod.addAllowRules([mod.BUS_RULE]);
    expect(mod.addAllowRules([mod.BUS_RULE]).added).toEqual([]);
    expect(read().permissions.allow).toEqual(['mcp(switchyard/*)']);
  });

  it('refuses to touch invalid JSON', () => {
    seed('{ nope');
    expect(() => mod.addAllowRules([mod.BUS_RULE])).toThrow(/refusing to overwrite/);
    expect(readFileSync(mod.agySettingsPath(), 'utf8')).toBe('{ nope');
  });

  it('Remove reverts exactly what Switchyard added and nothing else', () => {
    seed({ theme: 'dark', permissions: { allow: ['command(git)'] } });
    mod.addAllowRules([mod.BUS_RULE, mod.TEST_COMMAND_RULE, mod.writeRuleFor('/tmp/run-1')]);
    expect(mod.removeAllowRules().removed).toHaveLength(3);
    expect(read()).toEqual({ theme: 'dark', permissions: { allow: ['command(git)'] } });
  });

  it('never removes a rule the owner already had, even if it matches ours', () => {
    seed({ permissions: { allow: ['mcp(switchyard/*)'] } });
    expect(mod.addAllowRules([mod.BUS_RULE]).added).toEqual([]);
    expect(mod.removeAllowRules().removed).toEqual([]);
    expect(read().permissions.allow).toEqual(['mcp(switchyard/*)']);
  });

  it('removes the whole permissions block when it created it from nothing', () => {
    mod.addAllowRules([mod.BUS_RULE]);
    mod.removeAllowRules();
    expect(read()).toEqual({});
    expect(existsSync(`${mod.agySettingsPath()}.bak`)).toBe(true);
  });

  it('reports state for the Settings panel', () => {
    expect(mod.allowRuleState()).toEqual({ bus: false, testCommands: false, writeDirs: [] });
    mod.addAllowRules([mod.BUS_RULE, mod.writeRuleFor('/tmp/x')]);
    expect(mod.allowRuleState()).toEqual({
      bus: true,
      testCommands: false,
      writeDirs: ['write_file(/tmp/x/)'],
    });
  });
});
