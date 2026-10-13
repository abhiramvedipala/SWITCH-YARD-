import { describe, it, expect } from 'vitest';
import { planReply, sanitizeReply, rawKeyBytes } from './input.js';

describe('safe replies into a PTY', () => {
  it('sends a plain single line as-is, then Enter', () => {
    expect(planReply('use blue')).toEqual({ body: 'use blue', submit: true });
  });

  it('wraps multi-line text in a bracketed paste', () => {
    expect(planReply('line one\nline two')!.body).toBe('\x1b[200~line one\nline two\x1b[201~');
    expect(planReply('a\r\nb')!.body).toBe('\x1b[200~a\nb\x1b[201~');
  });

  it('prefixes lines that would be a slash command or shell escape', () => {
    expect(planReply('/clear')!.body).toBe('Reply: /clear');
    expect(planReply('!rm -rf /')!.body).toBe('Reply: !rm -rf /');
    expect(planReply('  /compact')!.body).toBe('Reply: /compact');
    expect(planReply('/a\nmore')!.body).toBe('\x1b[200~Reply: /a\nmore\x1b[201~');
    expect(planReply('a /not-leading')!.body).toBe('a /not-leading');
  });

  it('strips control characters except tab, including an attempt to close the paste early', () => {
    expect(sanitizeReply('a\x1b[201~\x03b\x00\x7fc\td')).toBe('a[201~bc\td');
    const out = planReply('x\ny\x1b[201~\rrm -rf ~')!.body;
    expect(out.split('\x1b[201~')).toHaveLength(2); // only our own terminator
    expect(out.endsWith('\x1b[201~')).toBe(true);
    expect(out).not.toContain('\r');
  });

  it('refuses empty and control-only replies', () => {
    expect(planReply('')).toBeNull();
    expect(planReply('  \n ')).toBeNull();
    expect(planReply('\x1b\x03')).toBeNull();
  });

  it('raw keys: named keys or one alphanumeric character only', () => {
    expect(rawKeyBytes('enter')).toBe('\r');
    expect(rawKeyBytes('down')).toBe('\x1b[B');
    expect(rawKeyBytes('y')).toBe('y');
    expect(rawKeyBytes('2')).toBe('2');
    expect(rawKeyBytes('rm -rf')).toBeNull();
    expect(rawKeyBytes('\x1b[A')).toBeNull();
    expect(rawKeyBytes('/')).toBeNull();
  });
});
