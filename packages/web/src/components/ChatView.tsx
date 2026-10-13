import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import { api } from '../lib/api.js';
import { socket } from '../lib/ws.js';
import type { ChatMessage, SNode } from '../lib/types.js';
import { useStore } from '../store.js';
import { MicButton } from './bits.js';

/** Transcript + composer for an agent-chat node or the workspace's Project Chat. Streams over the socket. */
export function ChatView({ node, placeholder }: { node: SNode; placeholder?: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>(node.data.messages ?? []);
  const [busy, setBusy] = useState(!!node.busy);
  const [draft, setDraft] = useState('');
  const notify = useStore((s) => s.notify);
  const readOnly = useStore((s) => s.readOnly);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    api
      .get<SNode>(`/api/nodes/${node.id}`)
      .then((n) => {
        if (!alive) return;
        setMessages(n.data.messages ?? []);
        setBusy(!!n.busy);
      })
      .catch(() => undefined);
    const off = socket.on((e) => {
      if (e.t !== 'chat' || e.nodeId !== node.id) return;
      const ev = e.event;
      if (ev.type === 'start') {
        setBusy(true);
        setMessages((m) => [
          ...m,
          ev.message as ChatMessage,
          { id: ev.replyId!, role: 'assistant', text: '', tools: [], at: Date.now() },
        ]);
      } else if (ev.type === 'delta') {
        setMessages((m) =>
          m.map((x) => (x.id === ev.replyId ? { ...x, text: x.text + (ev.delta ?? '') } : x)),
        );
      } else if (ev.type === 'tool') {
        setMessages((m) =>
          m.map((x) =>
            x.id === ev.replyId
              ? { ...x, tools: [...(x.tools ?? []), ev.tool as { name: string }] }
              : x,
          ),
        );
      } else if (ev.type === 'end') {
        setBusy(false);
        api
          .get<SNode>(`/api/nodes/${node.id}`)
          .then((n) => setMessages(n.data.messages ?? []))
          .catch(() => undefined);
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, [node.id]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages]);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    try {
      await api.post(`/api/nodes/${node.id}/chat`, { text });
    } catch (err) {
      notify(String((err as Error).message), 'error');
      setDraft(text);
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="chat nodrag nowheel">
      <div className="chat-scroll" ref={scroller}>
        {messages.length === 0 && (
          <div className="muted small pad">{placeholder ?? 'Send a message to start.'}</div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg msg-${m.role}`}>
            {m.tools && m.tools.length > 0 && (
              <div className="tools">
                {m.tools
                  .filter((t) => t.name !== 'result')
                  .slice(-6)
                  .map((t, i) => (
                    <span key={i} className="tool-pill">
                      {t.name}
                    </span>
                  ))}
              </div>
            )}
            {m.role === 'assistant' ? (
              <div className="md">
                <ReactMarkdown>{m.text || (busy ? '…' : '')}</ReactMarkdown>
              </div>
            ) : (
              <div className="pre">{m.text}</div>
            )}
            {m.error && <div className="error small">⚠ {m.error}</div>}
          </div>
        ))}
      </div>
      {(node.unread ?? 0) > 0 && !busy && (
        <button
          className="inbox-banner"
          onClick={() => setDraft('Call check_inbox and handle the messages there.')}
        >
          {node.unread} unread bus message{node.unread === 1 ? '' : 's'} — ask the agent to check
          its inbox
        </button>
      )}
      <form className="composer" onSubmit={send}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          placeholder={
            readOnly
              ? 'Read-only'
              : busy
                ? 'Answering…'
                : 'Message (Enter to send, Shift+Enter for newline)'
          }
          disabled={readOnly}
          rows={2}
        />
        <div className="composer-actions">
          <MicButton onText={(t) => setDraft((d) => (d ? `${d} ${t}` : t))} />
          {busy ? (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => api.post(`/api/nodes/${node.id}/chat/stop`)}
            >
              Stop
            </button>
          ) : (
            <button type="submit" className="btn" disabled={!draft.trim() || readOnly}>
              Send
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
