import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  ConnectionMode,
  applyNodeChanges,
  BackgroundVariant,
  type Node,
  type Edge,
  type NodeChange,
  type Connection,
  type OnBeforeDelete,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api } from '../lib/api.js';
import { useStore } from '../store.js';
import { NodeFrame } from '../components/NodeFrame.js';
import { AddNodeMenu } from '../components/AddNode.js';

const nodeTypes = { sy: NodeFrame };

/** Pan to a node right after it is added so it never lands off-screen. */
function FollowNewNodes({ ids }: { ids: string[] }) {
  const rf = useReactFlow();
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (seen.current === null) {
      if (ids.length) seen.current = new Set(ids);
      else seen.current = new Set();
      return;
    }
    const fresh = ids.filter((id) => !seen.current!.has(id));
    for (const id of ids) seen.current.add(id);
    if (fresh.length === 1)
      setTimeout(
        () =>
          void rf.fitView({ nodes: [{ id: fresh[0]! }], duration: 300, maxZoom: 1, padding: 0.4 }),
        60,
      );
  }, [ids, rf]);
  return null;
}

export function Canvas() {
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const wsId = useStore((s) => s.wsId);
  const notify = useStore((s) => s.notify);
  const set = useStore((s) => s.set);
  const readOnly = useStore((s) => s.readOnly);
  const [rfNodes, setRfNodes] = useState<Node[]>([]);

  useEffect(() => {
    setRfNodes((prev) => {
      const prevMap = new Map(prev.map((n) => [n.id, n]));
      return nodes.map((n) => {
        const p = prevMap.get(n.id);
        const keepPos = p?.dragging || p?.resizing;
        return {
          id: n.id,
          type: 'sy',
          position: keepPos ? p!.position : { x: n.x, y: n.y },
          width: keepPos ? p!.width : n.w,
          height: keepPos ? p!.height : n.h,
          data: { node: n },
          selected: p?.selected ?? false,
          dragHandle: '.node-drag',
        } satisfies Node;
      });
    });
  }, [nodes]);

  const rfEdges: Edge[] = useMemo(
    () =>
      edges.map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        type: 'default',
        className: 'sy-edge',
      })),
    [edges],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setRfNodes((ns) => applyNodeChanges(changes, ns));
      const sel = changes.find((c) => c.type === 'select' && c.selected);
      if (sel && 'id' in sel) set({ selectedId: sel.id });
    },
    [set],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!wsId || !c.source || !c.target || c.source === c.target) return;
      api
        .post(`/api/workspaces/${wsId}/edges`, { from: c.source, to: c.target })
        .then(() => notify('Connected — these nodes can now see and message each other'))
        .catch((e) => notify(String(e.message), 'error'));
    },
    [wsId, notify],
  );

  // Keyboard delete removes connections only; nodes (which may host running agents) go through the node menu.
  const onBeforeDelete: OnBeforeDelete = useCallback(async ({ edges: es }) => {
    for (const e of es) await api.del(`/api/edges/${e.id}`).catch(() => undefined);
    return false;
  }, []);

  return (
    <div className="canvas-root">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onConnect={readOnly ? undefined : onConnect}
        onBeforeDelete={onBeforeDelete}
        onNodeDragStop={(_e, _n, dragged) => {
          const items = dragged.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y }));
          for (const it of items) useStore.getState().patchNodeLocal(it.id, { x: it.x, y: it.y });
          api.put('/api/layout', items).catch(() => undefined);
        }}
        onPaneClick={() => set({ selectedId: null })}
        connectionMode={ConnectionMode.Loose}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        minZoom={0.15}
        maxZoom={2}
        fitView={nodes.length > 0}
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={['Backspace', 'Delete']}
        colorMode="dark"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#2a303b" />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => stateColor((n.data as { node: { state: string } }).node.state)}
          maskColor="rgba(8,10,14,0.7)"
        />
        <Controls showInteractive={false} />
        <FollowNewNodes ids={nodes.map((n) => n.id)} />
      </ReactFlow>
      {nodes.length === 0 && (
        <div className="canvas-empty">
          <div className="empty-card">
            <h3>Empty canvas</h3>
            <p className="muted">
              Add a terminal, an agent, a note or a preview. Drag from a node's edge dot to another
              node to connect them — connected agents can see and message each other.
            </p>
            {!readOnly && <AddNodeMenu inline />}
            <p className="muted small">Tip: ⌘K opens the command palette.</p>
          </div>
        </div>
      )}
    </div>
  );
}

function stateColor(s: string): string {
  return s === 'working'
    ? '#22d3ee'
    : s === 'needs_input'
      ? '#f59e0b'
      : s === 'exited'
        ? '#7f1d1d'
        : '#3b4252';
}
