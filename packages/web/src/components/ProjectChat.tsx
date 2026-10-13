import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import type { HarnessId, SNode } from '../lib/types.js';
import { harnessLabel, useStore } from '../store.js';
import { ChatView } from './ChatView.js';

/** "Ask Switchyard": a workspace-level chat that sees a snapshot of the canvas each turn. Defaults to agy to spare Claude usage. */
export function ProjectChat() {
  const wsId = useStore((s) => s.wsId);
  const available = useStore((s) => s.available);
  const notify = useStore((s) => s.notify);
  const [node, setNode] = useState<SNode | null>(null);
  const [gen, setGen] = useState(0);
  useEffect(() => {
    if (!wsId) return;
    api
      .post<SNode>(`/api/workspaces/${wsId}/project-chat`, {})
      .then(setNode)
      .catch((e) => notify(String(e.message), 'error'));
  }, [wsId, notify]);
  if (!node) return <div className="muted pad">Loading…</div>;
  const switchTo = (h: HarnessId) =>
    api
      .post<SNode>(`/api/workspaces/${wsId}/project-chat`, { harness: h })
      .then(setNode)
      .catch((e) => notify(String(e.message), 'error'));
  return (
    <div className="project-chat">
      <div className="row pc-bar">
        <span className="muted small">Answers with</span>
        <select
          value={node.harness ?? 'agy'}
          onChange={(e) => switchTo(e.target.value as HarnessId)}
        >
          {(['agy', 'claude', 'mock'] as HarnessId[]).map((h) => (
            <option key={h} value={h}>
              {harnessLabel(h)}
              {h !== 'mock' && !available.includes(h) ? ' (not installed)' : ''}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <button
          className="btn btn-ghost btn-xs"
          onClick={() =>
            api.post(`/api/nodes/${node.id}/chat/clear`).then(() => setGen((g) => g + 1))
          }
        >
          New conversation
        </button>
      </div>
      <ChatView
        key={`${node.id}-${node.harness}-${gen}`}
        node={node}
        placeholder="Ask about this workspace: what each agent is doing, what's blocked, where something lives in the code…"
      />
    </div>
  );
}
