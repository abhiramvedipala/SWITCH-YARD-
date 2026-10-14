import { memo, useState } from 'react';
import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react';
import { api } from '../lib/api.js';
import type { SNode } from '../lib/types.js';
import { harnessLabel, useStore } from '../store.js';
import { StatusChip, UsageBadge } from './bits.js';
import { NodeBody } from './NodeBodies.js';

const TYPE_ICON: Record<string, string> = {
  terminal: '❯',
  'agent-terminal': '◆',
  'agent-chat': '✦',
  note: '✎',
  doc: '¶',
  browser: '◎',
  files: '▤',
  external: '◇',
};

export function NodeMenu({ node, onClose }: { node: SNode; onClose: () => void }) {
  const { notify, set } = useStore.getState();
  const act = async (fn: () => Promise<unknown>) => {
    onClose();
    try {
      await fn();
    } catch (e) {
      notify(String((e as Error).message), 'error');
    }
  };
  const isAgent = node.type === 'agent-terminal' || node.type === 'agent-chat';
  const isPty = node.type === 'terminal' || node.type === 'agent-terminal';
  // Claude is served by its Stop hook, so typing nudges is opt-in there; other agents default on.
  const nudgeOn =
    node.harness === 'claude' ? node.data.autoNudge === true : node.data.autoNudge !== false;
  return (
    <div className="menu nodrag" onMouseLeave={onClose}>
      <button onClick={() => act(async () => set({ focusId: node.id }))}>Focus (F)</button>
      <button
        onClick={() =>
          act(async () => {
            const t = prompt('Rename node', node.title);
            if (t?.trim()) await api.patch(`/api/nodes/${node.id}`, { title: t.trim() });
          })
        }
      >
        Rename
      </button>
      {isAgent && (
        <button
          onClick={() =>
            act(async () => {
              const body = prompt(
                `Send a message to ${node.title} (arrives in its switchyard inbox as a request from you)`,
              );
              if (body?.trim()) {
                await api.post(`/api/nodes/${node.id}/message`, { body: body.trim() });
                notify('Message queued in its inbox');
              }
            })
          }
        >
          Message…
        </button>
      )}
      {isPty && (
        <>
          <button onClick={() => act(() => api.post(`/api/nodes/${node.id}/restart`, {}))}>
            {node.type === 'agent-terminal' && node.sessionRef
              ? 'Restart (resume session)'
              : 'Restart'}
          </button>
          {node.type === 'agent-terminal' && (
            <button
              onClick={() => act(() => api.post(`/api/nodes/${node.id}/restart`, { fresh: true }))}
            >
              Restart fresh
            </button>
          )}
          <button onClick={() => act(() => api.post(`/api/nodes/${node.id}/stop`))}>
            Stop process
          </button>
        </>
      )}
      {node.type === 'agent-terminal' && (
        <button
          onClick={() =>
            act(() =>
              api.patch(`/api/nodes/${node.id}`, {
                data: { autoNudge: !nudgeOn },
              }),
            )
          }
        >
          {nudgeOn ? 'Disable' : 'Enable'} inbox nudges (types into the terminal)
        </button>
      )}
      {isAgent && (
        <button
          className={node.yolo ? '' : 'danger'}
          onClick={() =>
            act(async () => {
              if (
                !node.yolo &&
                !confirm(
                  `YOLO mode lets ${node.title} run every tool WITHOUT asking permission (bypass permissions). Only for throwaway folders. Turn it on? It applies the next time the agent starts.`,
                )
              )
                return;
              await api.patch(`/api/nodes/${node.id}`, { yolo: !node.yolo });
            })
          }
        >
          {node.yolo ? 'Turn off YOLO mode' : 'YOLO mode (skip permissions)…'}
        </button>
      )}
      {node.id === 'claude-desktop' ? (
        // The base node is Claude Desktop's identity (every chat acts through it): disconnect, never a bare delete.
        <button
          className="danger"
          onClick={() =>
            act(async () => {
              if (
                confirm(
                  'Disconnect Claude Desktop? This removes the switchyard entry from its config and revokes the identity of every Claude Desktop chat.',
                )
              ) {
                await api.post('/api/claude-desktop', { action: 'remove' });
                notify('Removed the switchyard entry and revoked its identity');
              }
            })
          }
        >
          Disconnect Claude Desktop…
        </button>
      ) : (
        <button
          className="danger"
          onClick={() =>
            act(async () => {
              if (confirm(`Delete "${node.title}"?${isPty ? ' Its process will be stopped.' : ''}`))
                await api.del(`/api/nodes/${node.id}`);
            })
          }
        >
          Delete
        </button>
      )}
    </div>
  );
}

export function NodeHeader({ node, inFocus }: { node: SNode; inFocus?: boolean }) {
  const [menu, setMenu] = useState(false);
  const set = useStore((s) => s.set);
  const readOnly = useStore((s) => s.readOnly);
  const isAgentish =
    node.type === 'agent-terminal' ||
    node.type === 'agent-chat' ||
    node.type === 'terminal' ||
    node.type === 'external';
  return (
    <div className="node-header node-drag">
      <span className="node-icon">{TYPE_ICON[node.type]}</span>
      <span className="node-title" title={node.cwd ?? node.title}>
        {node.title}
      </span>
      {node.data.kind === 'chat' ? (
        <span className="badge badge-chat" title="A chat in Claude.app">
          💬
        </span>
      ) : (
        node.harness &&
        node.harness !== 'shell' && (
          <span className={`badge badge-${node.harness}`}>{harnessLabel(node.harness)}</span>
        )
      )}
      {node.yolo && (
        <span className="badge badge-yolo" title="Permissions bypassed">
          YOLO
        </span>
      )}
      {(node.unread ?? 0) > 0 && (
        <span className="badge badge-unread" title="Unread bus messages">
          {node.unread} ✉
        </span>
      )}
      {node.type === 'agent-chat' && <UsageBadge nodeId={node.id} state={node.state} />}
      <span className="spacer" />
      {isAgentish && <StatusChip state={node.state} />}
      {inFocus ? (
        <button
          className="icon-btn nodrag"
          onClick={() => set({ focusId: null })}
          title="Exit focus (Esc)"
        >
          ✕
        </button>
      ) : (
        <button
          className="icon-btn nodrag"
          onClick={() => set({ focusId: node.id })}
          title="Focus (F)"
        >
          ⤢
        </button>
      )}
      {!readOnly && (
        <span className="menu-anchor nodrag">
          <button className="icon-btn" onClick={() => setMenu(!menu)} aria-label="Node menu">
            ⋯
          </button>
          {menu && <NodeMenu node={node} onClose={() => setMenu(false)} />}
        </span>
      )}
    </div>
  );
}

function NodeFrameInner({ data, selected }: NodeProps) {
  const node = (data as { node: SNode }).node;
  const focusId = useStore((s) => s.focusId);
  const patchLocal = useStore((s) => s.patchNodeLocal);
  return (
    <div className={`node node-${node.type} ${selected ? 'selected' : ''} state-${node.state}`}>
      <NodeResizer
        isVisible={selected}
        minWidth={200}
        minHeight={120}
        lineClassName="resize-line"
        handleClassName="resize-handle"
        onResizeEnd={(_e, p) => {
          patchLocal(node.id, { x: p.x, y: p.y, w: p.width, h: p.height });
          api
            .put('/api/layout', [{ id: node.id, x: p.x, y: p.y, w: p.width, h: p.height }])
            .catch(() => undefined);
        }}
      />
      <Handle type="target" position={Position.Left} className="handle" />
      <Handle type="source" position={Position.Right} className="handle" />
      <NodeHeader node={node} />
      {node.summary && (
        <div className="node-summary" title={node.summary}>
          {node.summary}
        </div>
      )}
      <div className="node-body">
        {focusId === node.id ? (
          <div className="muted small pad">Open in focus mode…</div>
        ) : (
          <NodeBody node={node} />
        )}
      </div>
    </div>
  );
}

export const NodeFrame = memo(NodeFrameInner);
