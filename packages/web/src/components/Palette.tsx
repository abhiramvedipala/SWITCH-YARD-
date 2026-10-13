import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store.js';
import { ADD_ITEMS, addNode } from './AddNode.js';

interface Cmd {
  label: string;
  hint?: string;
  run: () => void;
}

export function Palette() {
  const s = useStore();
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const close = () => s.set({ modal: 'none' });

  const cmds: Cmd[] = useMemo(() => {
    const list: Cmd[] = [
      ...ADD_ITEMS.map((it) => ({
        label: `Add ${it.label}`,
        hint: it.hint,
        run: () => void addNode(it.spec),
      })),
      { label: 'View: Canvas', run: () => s.set({ view: 'canvas' }) },
      { label: 'View: Board', run: () => s.set({ view: 'board' }) },
      { label: 'View: Runs', run: () => s.set({ view: 'runs' }) },
      {
        label: 'Toggle “Needs you”',
        run: () => s.set({ panel: s.panel === 'needs' ? 'none' : 'needs' }),
      },
      { label: 'Ask Switchyard (project chat)', run: () => s.set({ panel: 'chat' }) },
      { label: 'Import my sessions…', run: () => s.set({ modal: 'import' }) },
      { label: 'New workspace…', run: () => s.set({ modal: 'workspace' }) },
      { label: 'Agent in a git worktree…', run: () => s.set({ modal: 'worktree' }) },
      { label: 'Settings', run: () => s.set({ modal: 'settings' }) },
      ...s.nodes.map((n) => ({
        label: `Focus: ${n.title}`,
        hint: n.type,
        run: () => s.set({ focusId: n.id, view: 'canvas' }),
      })),
      ...s.workspaces
        .filter((w) => w.id !== s.wsId)
        .map((w) => ({
          label: `Switch to workspace: ${w.name}`,
          hint: w.rootDir,
          run: () => void s.selectWorkspace(w.id),
        })),
    ];
    return list;
  }, [s]);

  const filtered = cmds.filter((c) => c.label.toLowerCase().includes(q.toLowerCase())).slice(0, 14);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => setIdx(0), [q]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette">
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Type a command…"
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
            if (e.key === 'ArrowDown') setIdx((i) => Math.min(filtered.length - 1, i + 1));
            if (e.key === 'ArrowUp') setIdx((i) => Math.max(0, i - 1));
            if (e.key === 'Enter' && filtered[idx]) {
              close();
              filtered[idx]!.run();
            }
          }}
        />
        <div className="palette-list">
          {filtered.map((c, i) => (
            <button
              key={c.label}
              className={i === idx ? 'active' : ''}
              onMouseEnter={() => setIdx(i)}
              onClick={() => {
                close();
                c.run();
              }}
            >
              <span>{c.label}</span>
              {c.hint && <span className="muted small">{c.hint}</span>}
            </button>
          ))}
          {filtered.length === 0 && <div className="muted pad">No matches</div>}
        </div>
      </div>
    </div>
  );
}
