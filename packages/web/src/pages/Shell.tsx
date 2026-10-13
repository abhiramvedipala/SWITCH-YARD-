import { lazy, Suspense, useEffect, useState } from 'react';
import { socket } from '../lib/ws.js';
import { pollChanged } from '../lib/api.js';
import type { AttentionItem } from '../lib/types.js';
import { refetch, useStore } from '../store.js';
import { Canvas } from './Canvas.js';
import { NeedsYou } from '../components/NeedsYou.js';
import { AddNodeMenu } from '../components/AddNode.js';
import { NodeHeader } from '../components/NodeFrame.js';
import { NodeBody } from '../components/NodeBodies.js';
import { Logo, StatusChip } from '../components/bits.js';

// Loaded on demand: the first screen (canvas) shouldn't pay for views and dialogs you may never open.
const Board = lazy(() => import('./Board.js').then((m) => ({ default: m.Board })));
const Runs = lazy(() => import('./Runs.js').then((m) => ({ default: m.Runs })));
const RunCard = lazy(() => import('./Runs.js').then((m) => ({ default: m.RunCard })));
const ProjectChat = lazy(() =>
  import('../components/ProjectChat.js').then((m) => ({ default: m.ProjectChat })),
);
const SettingsModal = lazy(() =>
  import('../components/Modals.js').then((m) => ({ default: m.SettingsModal })),
);
const ImportModal = lazy(() =>
  import('../components/Modals.js').then((m) => ({ default: m.ImportModal })),
);
const WorkspaceModal = lazy(() =>
  import('../components/Modals.js').then((m) => ({ default: m.WorkspaceModal })),
);
const WorktreeModal = lazy(() =>
  import('../components/Modals.js').then((m) => ({ default: m.WorktreeModal })),
);
const Palette = lazy(() =>
  import('../components/Palette.js').then((m) => ({ default: m.Palette })),
);

function useLiveEvents() {
  useEffect(() => {
    socket.connect();
    const off = socket.on((e) => {
      const s = useStore.getState();
      if (e.t === 'hello') {
        s.set({ remote: s.remote || e.remote, readOnly: s.readOnly || e.readOnly });
        refetch('graph', 0);
        refetch('tasks', 0);
        refetch('runs', 0);
        refetch('attention', 0);
      } else if (e.t === 'status') {
        s.patchNodeLocal(e.nodeId, { state: e.state as never });
        refetch('attention', 300);
      } else if (e.t === 'pty.exit') {
        s.patchNodeLocal(e.id, { alive: false });
      } else if (e.t === 'change') {
        if (e.entity === 'workspaces') void s.loadWorkspaces();
        if (e.workspaceId && e.workspaceId !== s.wsId && e.entity !== 'questions') return;
        if (e.entity === 'nodes' || e.entity === 'edges') refetch('graph');
        if (e.entity === 'messages') {
          refetch('graph', 400);
          refetch('attention', 400);
        }
        if (e.entity === 'tasks') refetch('tasks');
        if (e.entity === 'questions') refetch('attention', 50);
        if (e.entity === 'runs') refetch('runs');
      } else if (e.t === 'run') {
        refetch('runs', 250);
      }
    });
    // Screen-based states (a prompt on the terminal) change without events, so watch the feed with a long-poll:
    // the server holds the request until something changes (or 25 s pass), so an idle tab costs ~1 request per
    // 25 s and updates arrive instantly. Nothing runs while the tab is hidden; it refreshes when you return.
    let ctrl: AbortController | null = null;
    const start = () => {
      if (ctrl) return;
      const mine = new AbortController();
      ctrl = mine;
      void (async () => {
        let hash: string | null = null;
        while (!mine.signal.aborted) {
          try {
            const r: { items: AttentionItem[]; hash: string } | null = await pollChanged<{
              items: AttentionItem[];
              hash: string;
            }>('/api/attention', hash, mine.signal);
            if (r) {
              hash = r.hash;
              useStore.getState().set({ attention: r.items });
            }
          } catch {
            if (mine.signal.aborted) return;
            await new Promise((res) => setTimeout(res, 3000)); // server down: back off, then retry
          }
        }
      })();
    };
    const stop = () => {
      ctrl?.abort();
      ctrl = null;
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else {
        refetch('graph', 0);
        start();
      }
    };
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      off();
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const target = e.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable ||
          !!target.closest('.xterm'));
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        s.set({ modal: s.modal === 'palette' ? 'none' : 'palette' });
        return;
      }
      if (e.key === 'Escape' && s.focusId && s.modal === 'none') {
        // In a focused terminal, Esc belongs to the program unless Shift is held.
        if (target?.closest('.xterm') && !e.shiftKey) return;
        s.set({ focusId: null });
        return;
      }
      if (typing || s.modal !== 'none') return;
      if (e.key === 'f' || e.key === 'F') {
        if (s.selectedId && s.view === 'canvas') {
          e.preventDefault();
          s.set({ focusId: s.selectedId });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function FocusOverlay() {
  const focusId = useStore((s) => s.focusId);
  const node = useStore((s) => s.nodes.find((n) => n.id === s.focusId));
  if (!focusId || !node) return null;
  return (
    <div className="focus-overlay">
      <div className="focus-node">
        <NodeHeader node={node} inFocus />
        {node.summary && <div className="node-summary">{node.summary}</div>}
        <div className="node-body">
          <NodeBody node={node} />
        </div>
      </div>
      <div className="focus-hint muted small">Esc to return (Shift+Esc inside a terminal)</div>
    </div>
  );
}

function WorkspacePicker() {
  const workspaces = useStore((s) => s.workspaces);
  const wsId = useStore((s) => s.wsId);
  const select = useStore((s) => s.selectWorkspace);
  const set = useStore((s) => s.set);
  return (
    <select
      className="ws-picker"
      value={wsId ?? ''}
      onChange={(e) =>
        e.target.value === '__new' ? set({ modal: 'workspace' }) : void select(e.target.value)
      }
      title={workspaces.find((w) => w.id === wsId)?.rootDir}
    >
      {workspaces.map((w) => (
        <option key={w.id} value={w.id}>
          {w.name}
        </option>
      ))}
      <option value="__new">+ New workspace…</option>
    </select>
  );
}

function TopBar() {
  const view = useStore((s) => s.view);
  const panel = useStore((s) => s.panel);
  const set = useStore((s) => s.set);
  const attention = useStore((s) => s.attention);
  const readOnly = useStore((s) => s.readOnly);
  const remote = useStore((s) => s.remote);
  const [connected, setConnected] = useState(socket.connected);
  useEffect(() => socket.onStatus(setConnected), []);
  return (
    <header className="topbar">
      <span className="brand">
        <Logo /> Switchyard
      </span>
      <WorkspacePicker />
      <nav className="views">
        {(['canvas', 'board', 'runs'] as const).map((v) => (
          <button
            key={v}
            className={`tab ${view === v ? 'active' : ''}`}
            onClick={() => set({ view: v })}
          >
            {v[0]!.toUpperCase() + v.slice(1)}
          </button>
        ))}
      </nav>
      {view === 'canvas' && !readOnly && <AddNodeMenu />}
      <span className="spacer" />
      {!connected && <span className="badge badge-wait">reconnecting…</span>}
      {remote && (
        <span className="badge" title="You are connected remotely">
          {readOnly ? 'remote · read-only' : 'remote'}
        </span>
      )}
      <button
        className="btn btn-ghost"
        onClick={() => set({ modal: 'palette' })}
        title="Command palette"
      >
        ⌘K
      </button>
      {!readOnly && (
        <button className="btn btn-ghost" onClick={() => set({ modal: 'import' })}>
          Import sessions
        </button>
      )}
      <button
        className={`btn btn-ghost ${panel === 'chat' ? 'on' : ''}`}
        onClick={() => set({ panel: panel === 'chat' ? 'none' : 'chat' })}
      >
        Ask Switchyard
      </button>
      <button
        className={`btn ${attention.length ? 'btn-attn' : 'btn-ghost'} ${panel === 'needs' ? 'on' : ''}`}
        onClick={() => set({ panel: panel === 'needs' ? 'none' : 'needs' })}
      >
        Needs you{attention.length ? ` · ${attention.length}` : ''}
      </button>
      <button className="icon-btn" onClick={() => set({ modal: 'settings' })} title="Settings">
        ⚙
      </button>
    </header>
  );
}

function NoWorkspace() {
  const set = useStore((s) => s.set);
  return (
    <div className="canvas-empty">
      <div className="empty-card">
        <h3>Welcome to Switchyard</h3>
        <p className="muted">
          Pick a folder to make your first workspace. Agents and terminals you add start in that
          folder. To try things safely, use the scratch playground.
        </p>
        <button className="btn" onClick={() => set({ modal: 'workspace' })}>
          Create a workspace
        </button>
      </div>
    </div>
  );
}

function MobileShell() {
  const [tab, setTab] = useState<'needs' | 'runs' | 'agents'>('needs');
  const attention = useStore((s) => s.attention);
  const runs = useStore((s) => s.runs);
  const nodes = useStore((s) => s.nodes);
  const readOnly = useStore((s) => s.readOnly);
  const set = useStore((s) => s.set);
  return (
    <div className="mobile">
      <header className="mobile-top">
        <Logo /> <b>Switchyard</b>
        <WorkspacePicker />
        {readOnly && <span className="badge">read-only</span>}
      </header>
      <nav className="mobile-tabs">
        <button className={tab === 'needs' ? 'active' : ''} onClick={() => setTab('needs')}>
          Needs you{attention.length ? ` (${attention.length})` : ''}
        </button>
        <button className={tab === 'runs' ? 'active' : ''} onClick={() => setTab('runs')}>
          Runs
        </button>
        <button className={tab === 'agents' ? 'active' : ''} onClick={() => setTab('agents')}>
          Agents
        </button>
      </nav>
      <main className="mobile-main">
        {tab === 'needs' && <NeedsYou />}
        {tab === 'runs' &&
          (runs.length ? (
            <Suspense fallback={null}>
              {runs.map((r) => (
                <RunCard key={r.id} run={r} compact />
              ))}
            </Suspense>
          ) : (
            <div className="muted pad">No runs.</div>
          ))}
        {tab === 'agents' &&
          nodes
            .filter((n) => n.type !== 'note' && n.type !== 'doc' && n.type !== 'browser')
            .map((n) => (
              <button key={n.id} className="mobile-node" onClick={() => set({ focusId: n.id })}>
                <span className="grow">
                  <b>{n.title}</b>
                  {n.summary && <div className="muted small">{n.summary}</div>}
                </span>
                <StatusChip state={n.state} />
              </button>
            ))}
      </main>
      <FocusOverlay />
    </div>
  );
}

function useIsNarrow() {
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 760px)');
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

export function Shell() {
  useLiveEvents();
  useShortcuts();
  const s = useStore();
  const narrow = useIsNarrow();
  useEffect(() => {
    void s.loadWorkspaces();
    void s.loadSettings();
    void s.loadHarnesses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const modals = (
    <>
      <Suspense fallback={null}>
        {s.modal === 'settings' && <SettingsModal />}
        {s.modal === 'import' && <ImportModal />}
        {s.modal === 'workspace' && <WorkspaceModal />}
        {s.modal === 'worktree' && <WorktreeModal />}
        {s.modal === 'palette' && <Palette />}
      </Suspense>
      {s.toast && <div className={`toast toast-${s.toast.kind}`}>{s.toast.text}</div>}
    </>
  );

  if (narrow) {
    return (
      <>
        <MobileShell />
        {modals}
      </>
    );
  }

  return (
    <div className="shell">
      <TopBar />
      <div className="main">
        <section className="stage">
          {!s.wsId ? (
            <NoWorkspace />
          ) : s.view === 'canvas' ? (
            <Canvas />
          ) : s.view === 'board' ? (
            <Suspense fallback={null}>
              <Board />
            </Suspense>
          ) : (
            <Suspense fallback={null}>
              <Runs />
            </Suspense>
          )}
        </section>
        {s.panel !== 'none' && s.wsId && (
          <aside className="side">
            <div className="side-head">
              <b>{s.panel === 'needs' ? 'Needs you' : 'Ask Switchyard'}</b>
              <span className="spacer" />
              <button
                className="icon-btn"
                onClick={() => s.set({ panel: 'none' })}
                aria-label="Close panel"
              >
                ✕
              </button>
            </div>
            {s.panel === 'needs' ? (
              <NeedsYou />
            ) : (
              <Suspense fallback={null}>
                <ProjectChat />
              </Suspense>
            )}
          </aside>
        )}
      </div>
      <FocusOverlay />
      {modals}
    </div>
  );
}
