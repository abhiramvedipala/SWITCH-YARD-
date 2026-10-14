import { useState, type CSSProperties } from 'react';
import { api } from '../lib/api.js';
import type { HarnessId, NodeType } from '../lib/types.js';
import { harnessLabel, useStore } from '../store.js';

export interface AddSpec {
  type: NodeType;
  harness?: HarnessId;
  title?: string;
  yolo?: boolean;
  data?: Record<string, unknown>;
}

export async function addNode(spec: AddSpec): Promise<void> {
  const { wsId, notify } = useStore.getState();
  if (!wsId) {
    notify('Create a workspace first', 'error');
    return;
  }
  try {
    await api.post(`/api/workspaces/${wsId}/nodes`, spec);
  } catch (e) {
    const msg = String((e as Error).message);
    if (
      /own folder|private data folder/.test(msg) &&
      confirm(`${msg}\n\nI understand this is the app's own folder — add the agent anyway?`)
    ) {
      try {
        await api.post(`/api/workspaces/${wsId}/nodes`, { ...spec, allowOwnFolder: true });
        return;
      } catch (e2) {
        notify(String((e2 as Error).message), 'error');
        return;
      }
    }
    notify(msg, 'error');
  }
}

export const ADD_ITEMS: { label: string; hint: string; spec: AddSpec }[] = [
  { label: 'Terminal', hint: 'plain shell', spec: { type: 'terminal' } },
  {
    label: 'Claude Code agent',
    hint: 'interactive, with bus tools',
    spec: { type: 'agent-terminal', harness: 'claude' },
  },
  {
    label: 'Antigravity agent',
    hint: 'agy, with bus tools',
    spec: { type: 'agent-terminal', harness: 'agy' },
  },
  {
    label: 'Codex agent',
    hint: 'ChatGPT via Codex CLI, with bus tools',
    spec: { type: 'agent-terminal', harness: 'codex' },
  },
  {
    label: 'Mock agent',
    hint: 'no AI — for trying the bus',
    spec: { type: 'agent-terminal', harness: 'mock' },
  },
  {
    label: 'Claude chat',
    hint: 'driven, headless turns',
    spec: { type: 'agent-chat', harness: 'claude' },
  },
  {
    label: 'Antigravity chat',
    hint: 'driven, headless turns',
    spec: { type: 'agent-chat', harness: 'agy' },
  },
  {
    label: 'Codex chat',
    hint: 'driven, headless turns',
    spec: { type: 'agent-chat', harness: 'codex' },
  },
  { label: 'Note', hint: 'plain text', spec: { type: 'note' } },
  { label: 'Doc', hint: 'markdown', spec: { type: 'doc' } },
  {
    label: 'Browser preview',
    hint: 'localhost iframe',
    spec: { type: 'browser', data: { url: 'http://localhost:3000' } },
  },
];

export function AddNodeMenu({ inline }: { inline?: boolean }) {
  const [open, setOpen] = useState(!!inline);
  // The top bar scrolls horizontally, so it clips anything absolutely positioned below it.
  // Pin the dropdown to the button's on-screen position instead.
  const [at, setAt] = useState<CSSProperties>();
  const [yolo, setYolo] = useState(false);
  const detections = useStore((s) => s.detections);
  const set = useStore((s) => s.set);
  const missing = (h?: HarnessId) =>
    !!h && h !== 'mock' && detections[h] && !detections[h]!.installed;

  const list = (
    <div
      className={inline ? 'add-grid' : 'menu add-menu'}
      style={inline ? undefined : at}
      onMouseLeave={() => !inline && setOpen(false)}
    >
      {ADD_ITEMS.map((it) => (
        <button
          key={it.label}
          onClick={() => {
            if (!inline) setOpen(false);
            const isAgent = it.spec.type === 'agent-terminal' || it.spec.type === 'agent-chat';
            void addNode({ ...it.spec, yolo: isAgent ? yolo : undefined });
          }}
          title={
            missing(it.spec.harness)
              ? `${harnessLabel(it.spec.harness)} is not installed — ${detections[it.spec.harness!]?.installHint ?? 'see Settings'}`
              : it.hint
          }
        >
          <span>{it.label}</span>
          <span className="muted small">
            {missing(it.spec.harness) ? 'not installed' : it.hint}
          </span>
        </button>
      ))}
      <button
        onClick={() => {
          if (!inline) setOpen(false);
          set({ modal: 'worktree' });
        }}
      >
        <span>Agent in a git worktree…</span>
        <span className="muted small">isolated branch</span>
      </button>
      <label
        className="yolo-toggle"
        title="Agents you add next run with permission checks bypassed"
      >
        <input type="checkbox" checked={yolo} onChange={(e) => setYolo(e.target.checked)} />
        <span>
          <b>YOLO mode</b> for new agents — skips all permission prompts
        </span>
      </label>
    </div>
  );
  if (inline) return list;
  return (
    <span className="menu-anchor">
      <button
        className="btn"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAt({ position: 'fixed', top: r.bottom + 4, left: r.left });
          setOpen(!open);
        }}
      >
        + Add
      </button>
      {open && list}
    </span>
  );
}
