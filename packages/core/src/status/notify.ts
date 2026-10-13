import { execFile } from 'node:child_process';
import { hub, type HubEvent } from '../events.js';
import type { AttentionItem } from './monitor.js';

/** A human has to answer these. `unread` is not one of them. */
const KINDS = new Set<AttentionItem['kind']>(['question', 'permission', 'needs_input']);
/** At most one banner per 2 s; whatever turns up in between goes out as one coalesced banner. */
const GAP_MS = 2000;
/** Let a burst of hub events (and the awaits behind them, e.g. a decided permission resetting the node) settle. */
const SETTLE_MS = 250;

/**
 * Body of an AppleScript string literal: one line, ≤ max characters, `\` and `"` escaped.
 * Control characters and line breaks become spaces; so do box-drawing/block glyphs, which only frame a TUI dialog.
 * Clipped before escaping, so the cut can never split an escape and leave a trailing backslash.
 */
export function appleScriptText(s: string, max = 120): string {
  const flat = s
    // eslint-disable-next-line no-control-regex -- removing control characters is the point
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u2500-\u259f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...flat]; // code points, so an emoji is never cut in half
  const clipped = chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
  return clipped.replace(/[\\"]/g, '\\$&');
}

/** One `display notification` for the new items (oldest first): the item itself, or "N agents need you". */
export function notificationScript(batch: AttentionItem[]): string {
  const last = batch[batch.length - 1]!;
  const agents = new Set(batch.map((i) => i.nodeId)).size;
  const text =
    agents > 1
      ? `${agents} agents need you`
      : last.toolName
        ? `${last.toolName}: ${last.text}`
        : last.text;
  const subtitle =
    agents > 1 ? [...new Set(batch.map((i) => i.nodeTitle))].join(', ') : last.nodeTitle;
  return `display notification "${appleScriptText(text)}" with title "Switchyard" subtitle "${appleScriptText(subtitle)}"`;
}

export interface NotifierDeps {
  /** The whole feed (every workspace). */
  attention: () => AttentionItem[];
  /** The `macNotifications` setting. */
  enabled: () => boolean;
  /** Runs a program with an argument array, never through a shell. Tests inject a fake. */
  exec?: (file: string, args: string[]) => void;
  platform?: NodeJS.Platform;
}

/**
 * macOS banners for new needs-you items. No polling: a 'status' or 'questions' hub event re-reads the feed once
 * the burst settles, so an idle core does no work. Each item id is announced once and forgotten when it leaves.
 */
export class MacNotifier {
  private seen = new Set<string>();
  private queue: AttentionItem[] = [];
  private lastAt = -Infinity;
  private timer: NodeJS.Timeout | null = null;
  private readonly exec: (file: string, args: string[]) => void;
  private readonly onEvent = (e: HubEvent) => {
    if (e.t === 'status' || (e.t === 'change' && e.entity === 'questions'))
      this.schedule(SETTLE_MS);
  };

  constructor(private deps: NotifierDeps) {
    this.exec = deps.exec ?? ((file, args) => execFile(file, args, { timeout: 10_000 }, () => {}));
  }

  private get mac(): boolean {
    return (this.deps.platform ?? process.platform) === 'darwin';
  }

  /** Called by the server entry point only. Items already open at boot are not announced again. */
  start(): void {
    if (!this.mac) return;
    this.seen = new Set(this.relevant().map((i) => i.id));
    hub.on('event', this.onEvent);
  }

  stop(): void {
    hub.off('event', this.onEvent);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Diff the feed against what was already announced, then send what is new (rate-limited). */
  check(): void {
    if (!this.mac) return;
    const items = this.relevant();
    const ids = new Set(items.map((i) => i.id));
    const fresh = items.filter((i) => !this.seen.has(i.id));
    this.seen = ids; // an item that left is forgotten: if it comes back, it is new again
    // Tracked while off too, so switching the setting on does not announce everything already open.
    this.queue = this.deps.enabled() ? [...this.queue.filter((i) => ids.has(i.id)), ...fresh] : [];
    if (this.queue.length === 0) return;
    const wait = this.lastAt + GAP_MS - Date.now();
    if (wait > 0) return this.schedule(wait);
    this.lastAt = Date.now();
    this.exec('osascript', ['-e', notificationScript(this.queue)]);
    this.queue = [];
  }

  private relevant(): AttentionItem[] {
    return this.deps.attention().filter((i) => KINDS.has(i.kind));
  }

  /** One pending re-check at a time; whichever fires first re-reads the feed and reschedules if needed. */
  private schedule(ms: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.check();
      } catch {
        // the DB may be closing on shutdown
      }
    }, ms);
    this.timer.unref();
  }
}
