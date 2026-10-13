/**
 * Decision tables for delivering bus messages through agent hooks instead of typing into a PTY.
 * Pure functions: the hook endpoints feed them counts, and they return the JSON the agent expects.
 */

/** A hook may keep an agent going at most this many times in a row before we let it stop. */
export const MAX_CONSECUTIVE_BLOCKS = 3;

export interface Backlog {
  requests: number;
  notifies: number;
}

export interface StopInput {
  /** Claude sets this when the Stop hook already forced another turn; never block again then. */
  stopHookActive: boolean;
  backlog: Backlog;
  consecutiveBlocks: number;
}

export interface Decision {
  /** JSON body to return to the agent ({} means "no opinion"). */
  output: Record<string, unknown>;
  /** True when the output keeps the agent working (counts toward the loop cap). */
  blocked: boolean;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Claude Code `Stop` hook. Requests keep Claude working; notifies are only added as context. */
export function claudeStopDecision(i: StopInput): Decision {
  const { requests, notifies } = i.backlog;
  const total = requests + notifies;
  if (i.stopHookActive || total === 0) return { output: {}, blocked: false };
  if (requests > 0 && i.consecutiveBlocks < MAX_CONSECUTIVE_BLOCKS) {
    return {
      blocked: true,
      output: {
        decision: 'block',
        reason: `You have ${plural(total, 'new switchyard message')} (${plural(requests, 'request')}). Call check_inbox, handle them, then stop.`,
      },
    };
  }
  return {
    blocked: false,
    output: {
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext: `${plural(total, 'switchyard message')} ${total === 1 ? 'is' : 'are'} waiting in check_inbox.`,
      },
    },
  };
}

/** Antigravity `PreInvocation`: inject a one-line reminder before the model runs when messages are waiting. */
export function agyPreInvocationDecision(backlog: Backlog): Decision {
  const total = backlog.requests + backlog.notifies;
  if (total === 0) return { output: {}, blocked: false };
  return {
    blocked: false,
    output: {
      injectSteps: [
        {
          ephemeralMessage: `${plural(total, 'new switchyard message')} ${total === 1 ? 'is' : 'are'} waiting; call check_inbox.`,
        },
      ],
    },
  };
}

/** Antigravity `Stop`: re-enter the loop only when the agent is fully idle and a request is unanswered. */
export function agyStopDecision(i: {
  fullyIdle: boolean;
  backlog: Backlog;
  consecutiveBlocks: number;
}): Decision {
  if (!i.fullyIdle || i.backlog.requests === 0 || i.consecutiveBlocks >= MAX_CONSECUTIVE_BLOCKS) {
    return { output: {}, blocked: false };
  }
  return {
    blocked: true,
    output: {
      decision: 'continue',
      reason: 'Check your switchyard inbox and answer the pending request, then stop.',
    },
  };
}

/** Tracks consecutive blocks per key (nodeId, or conversationId for agy) so loops can't run away. */
export class BlockCounter {
  private counts = new Map<string, number>();
  get(key: string): number {
    return this.counts.get(key) ?? 0;
  }
  record(key: string, d: Decision, backlog: Backlog): void {
    if (d.blocked) this.counts.set(key, this.get(key) + 1);
    // Messages handled (or none left): the next turn starts a fresh budget.
    else if (backlog.requests === 0) this.counts.delete(key);
  }
  reset(key: string): void {
    this.counts.delete(key);
  }
}
