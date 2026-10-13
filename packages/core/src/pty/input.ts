/**
 * Safe text for a human reply typed into an agent's terminal.
 * Goal: whatever the reply contains, it reaches the agent as ONE message, never as terminal control input
 * or as a slash/bash command the human did not mean to run.
 */

export const BRACKETED_PASTE_START = '\x1b[200~';
export const BRACKETED_PASTE_END = '\x1b[201~';

/** Named keys the explicit buttons may send (and the only raw input accepted besides one letter/digit). */
export const RAW_KEYS: Record<string, string> = {
  enter: '\r',
  esc: '\x1b',
  up: '\x1b[A',
  down: '\x1b[B',
  tab: '\t',
  'ctrl-c': '\x03',
};

/** Keys for the explicit prompt buttons: a named key or a single alphanumeric character. */
export function rawKeyBytes(name: string): string | null {
  if (name in RAW_KEYS) return RAW_KEYS[name]!;
  return /^[A-Za-z0-9]$/.test(name) ? name : null;
}

/* eslint-disable no-control-regex -- stripping control characters is the point */
const UNSAFE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
/* eslint-enable no-control-regex */

/** Drops every control character except tab and newline (so ESC, CR, DEL, C1 and bracketed-paste markers cannot survive). */
export function sanitizeReply(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(UNSAFE, '')
    .replace(/^\n+|\n+$/g, '');
}

/** Text that starts with `/` or `!` gets a `Reply: ` prefix so it can't run as a slash command or shell escape. */
export function defuseCommand(text: string): string {
  return /^\s*[/!]/.test(text) ? `Reply: ${text.trimStart()}` : text;
}

export interface ReplyWrite {
  /** Text to write first. */
  body: string;
  /** Then press Enter. */
  submit: boolean;
}

/**
 * Plan the PTY writes for a reply. Returns null when nothing is left after sanitising.
 * - a line that starts with `/` or `!` is prefixed with `Reply: ` so it can't trigger a slash command or shell escape;
 * - multi-line text goes in as a bracketed paste so embedded newlines don't submit early.
 */
export function planReply(text: string, submit = true): ReplyWrite | null {
  const clean = defuseCommand(sanitizeReply(text));
  if (!clean.trim()) return null;
  const body = clean.includes('\n')
    ? `${BRACKETED_PASTE_START}${clean}${BRACKETED_PASTE_END}`
    : clean;
  return { body, submit };
}
