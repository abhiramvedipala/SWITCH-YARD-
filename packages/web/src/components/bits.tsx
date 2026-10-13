import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { NodeState } from '../lib/types.js';
import { api } from '../lib/api.js';

const STATE_LABEL: Record<string, string> = {
  working: 'working',
  idle: 'idle',
  needs_input: 'needs you',
  exited: 'exited',
  starting: 'starting',
};

export function StatusChip({ state }: { state: NodeState | string }) {
  return (
    <span className={`chip chip-${state}`} title={`status: ${STATE_LABEL[state] ?? state}`}>
      <span className="dot" />
      {STATE_LABEL[state] ?? state}
    </span>
  );
}

export function Logo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <path d="M16 27 V17" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M16 17 L8 7" stroke="#22d3ee" strokeWidth="2.6" strokeLinecap="round" fill="none" />
      <path d="M16 17 L24 7" stroke="#a78bfa" strokeWidth="2.6" strokeLinecap="round" fill="none" />
      <circle cx="16" cy="17" r="2" fill="currentColor" />
    </svg>
  );
}

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

interface SpeechRec {
  start(): void;
  stop(): void;
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

function speechCtor(): (new () => SpeechRec) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRec;
    webkitSpeechRecognition?: new () => SpeechRec;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Push-to-talk via the browser's Web Speech API (hold the button). macOS dictation also works in any text box. */
export function MicButton({ onText }: { onText: (t: string) => void }) {
  const [on, setOn] = useState(false);
  const rec = useRef<SpeechRec | null>(null);
  const Ctor = speechCtor();
  if (!Ctor) return null;
  const start = () => {
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = false;
    r.lang = navigator.language || 'en-US';
    r.onresult = (e) => {
      const parts: string[] = [];
      for (let i = 0; i < e.results.length; i++) parts.push(e.results[i]![0]!.transcript);
      const text = parts.join(' ').trim();
      if (text) onText(text);
    };
    r.onend = () => setOn(false);
    r.onerror = () => setOn(false);
    rec.current = r;
    r.start();
    setOn(true);
  };
  const stop = () => rec.current?.stop();
  return (
    <button
      type="button"
      className={`icon-btn mic ${on ? 'mic-on' : ''}`}
      title="Hold to talk"
      onMouseDown={start}
      onMouseUp={stop}
      onMouseLeave={() => on && stop()}
      onTouchStart={(e) => {
        e.preventDefault();
        start();
      }}
      onTouchEnd={stop}
    >
      ●
    </button>
  );
}

export function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export const fmtUsd = (c: number): string => `$${c < 1 ? c.toFixed(3) : c.toFixed(2)}`;
export const fmtTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n);
/** "1.2k tok · $0.03", or tokens only when nothing reported a price. */
export const usageLabel = (
  u: { inputTokens: number; outputTokens: number; costUsd: number },
  unit = 'tok',
): string =>
  `${fmtTokens(u.inputTokens + u.outputTokens)} ${unit}${u.costUsd > 0 ? ` · ${fmtUsd(u.costUsd)}` : ''}`;

/** Spend of a driven node so far. Fetched on mount and whenever the node's state changes (a turn just ended); renders nothing at $0. */
export function UsageBadge({ nodeId, state }: { nodeId: string; state: string }) {
  const [cost, setCost] = useState(0);
  useEffect(() => {
    let live = true;
    api
      .get<{ total: { costUsd: number } }>(`/api/usage?nodeId=${nodeId}`)
      .then((u) => live && setCost(u.total.costUsd))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [nodeId, state]);
  if (cost <= 0) return null;
  return (
    <span className="badge badge-usage" title="Spent by this node so far">
      {fmtUsd(cost)}
    </span>
  );
}
