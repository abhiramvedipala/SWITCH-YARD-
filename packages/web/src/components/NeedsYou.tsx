import { useState, type FormEvent } from 'react';
import { api } from '../lib/api.js';
import type { AttentionItem } from '../lib/types.js';
import { useStore } from '../store.js';
import { MicButton, timeAgo } from './bits.js';

function Item({ item }: { item: AttentionItem }) {
  const [text, setText] = useState('');
  const notify = useStore((s) => s.notify);
  const set = useStore((s) => s.set);
  const wsId = useStore((s) => s.wsId);
  const selectWorkspace = useStore((s) => s.selectWorkspace);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!text.trim()) return;
    try {
      if (item.kind === 'question')
        await api.post(`/api/questions/${item.id}/answer`, { answer: text.trim() });
      else await api.post(`/api/nodes/${item.nodeId}/reply`, { text: text.trim() });
      setText('');
      notify('Sent');
    } catch (err) {
      notify(String((err as Error).message), 'error');
    }
  };
  const key = (k: string) =>
    api
      .post(`/api/nodes/${item.nodeId}/reply`, { text: k, raw: true })
      .catch((err) => notify(String(err.message), 'error'));
  const jump = async () => {
    if (item.workspaceId !== wsId) await selectWorkspace(item.workspaceId);
    set({ focusId: item.nodeId, view: 'canvas' });
  };

  return (
    <div className={`attn attn-${item.kind}`}>
      <div className="attn-head">
        <span className="attn-kind">
          {item.kind === 'question'
            ? 'asks'
            : item.kind === 'needs_input'
              ? 'waiting on you'
              : 'unread'}
        </span>
        <button className="link" onClick={jump} title="Open in focus mode">
          {item.nodeTitle}
        </button>
        <span className="spacer" />
        <span className="muted small">{timeAgo(item.createdAt)}</span>
      </div>
      {item.kind === 'needs_input' ? (
        <pre className="attn-screen">{item.text}</pre>
      ) : (
        <div className="attn-text">{item.text}</div>
      )}
      {item.kind === 'unread' ? (
        <div className="row">
          <button
            className="btn btn-ghost btn-xs"
            onClick={() =>
              api
                .post(`/api/nodes/${item.nodeId}/reply`, {
                  text: 'Call check_inbox and handle your new messages.',
                })
                .catch(() => undefined)
            }
          >
            Tell it to check its inbox
          </button>
        </div>
      ) : item.kind === 'needs_input' ? (
        <div className="muted small">
          Waiting at a prompt: use the keys below. Typed replies are disabled here so they can't
          answer it by accident.
        </div>
      ) : (
        <form className="reply" onSubmit={submit}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Your answer…"
          />
          <MicButton onText={(t) => setText((d) => (d ? `${d} ${t}` : t))} />
          <button className="btn btn-xs" disabled={!text.trim()}>
            Send
          </button>
        </form>
      )}
      {item.kind === 'needs_input' && (
        <div className="row keys">
          {['1', '2', '3', 'y', 'n'].map((k) => (
            <button key={k} className="key" onClick={() => key(k)}>
              {k}
            </button>
          ))}
          <button className="key" onClick={() => key('enter')}>
            ⏎
          </button>
          <button className="key" onClick={() => key('esc')}>
            Esc
          </button>
          <button className="key" onClick={() => key('up')}>
            ↑
          </button>
          <button className="key" onClick={() => key('down')}>
            ↓
          </button>
        </div>
      )}
      {item.kind === 'question' && (
        <button
          className="link small muted"
          onClick={() => api.post(`/api/questions/${item.id}/dismiss`)}
        >
          dismiss without answering
        </button>
      )}
    </div>
  );
}

export function NeedsYou() {
  const items = useStore((s) => s.attention);
  return (
    <div className="needs">
      {items.length === 0 && (
        <div className="muted pad">
          Nothing needs you right now. Questions from agents (ask_user), permission prompts, and
          idle agents with unread messages show up here.
        </div>
      )}
      {items.map((it) => (
        <Item key={it.id} item={it} />
      ))}
    </div>
  );
}
