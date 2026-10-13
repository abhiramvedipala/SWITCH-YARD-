import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import type { SNode } from '../lib/types.js';
import { useStore } from '../store.js';
import { LazyMd, LazyTerminal } from './Lazy.js';
import { ChatView } from './ChatView.js';

function useDebouncedSave(nodeId: string, key: string) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return (value: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      api.patch(`/api/nodes/${nodeId}`, { data: { [key]: value } }).catch(() => undefined);
    }, 400);
  };
}

export function NoteBody({ node }: { node: SNode }) {
  const [text, setText] = useState(String(node.data.text ?? ''));
  const save = useDebouncedSave(node.id, 'text');
  const readOnly = useStore((s) => s.readOnly);
  return (
    <textarea
      className="note-text nodrag nowheel"
      value={text}
      placeholder="Write a note…"
      readOnly={readOnly}
      onChange={(e) => {
        setText(e.target.value);
        save(e.target.value);
      }}
    />
  );
}

export function DocBody({ node }: { node: SNode }) {
  const [content, setContent] = useState(String(node.data.content ?? ''));
  const [editing, setEditing] = useState(!node.data.content && !node.data.readOnly);
  const save = useDebouncedSave(node.id, 'content');
  const ro = node.data.readOnly === true || useStore.getState().readOnly;
  useEffect(() => setContent(String(node.data.content ?? '')), [node.data.content]);
  return (
    <div className="doc nodrag nowheel">
      <div className="doc-bar">
        {ro ? (
          <span className="muted small">
            {node.data.importedFrom
              ? `Imported from ${String(node.data.importedFrom)} · read-only`
              : 'read-only'}
          </span>
        ) : (
          <button className="btn btn-ghost btn-xs" onClick={() => setEditing(!editing)}>
            {editing ? 'Preview' : 'Edit'}
          </button>
        )}
      </div>
      {editing && !ro ? (
        <textarea
          className="doc-edit"
          value={content}
          placeholder="# Markdown…"
          onChange={(e) => {
            setContent(e.target.value);
            save(e.target.value);
          }}
        />
      ) : (
        <div className="doc-view md">
          <LazyMd>{content || '_Empty doc_'}</LazyMd>
        </div>
      )}
    </div>
  );
}

export function BrowserBody({ node }: { node: SNode }) {
  const [url, setUrl] = useState(String(node.data.url ?? 'http://localhost:3000'));
  const [src, setSrc] = useState(url);
  const [nonce, setNonce] = useState(0);
  const go = () => {
    let u = url.trim();
    if (u && !/^https?:\/\//.test(u)) u = `http://${u}`;
    setUrl(u);
    setSrc(u);
    setNonce((n) => n + 1);
    api.patch(`/api/nodes/${node.id}`, { data: { url: u } }).catch(() => undefined);
  };
  return (
    <div className="browser nodrag nowheel">
      <form
        className="url-bar"
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
        <button
          type="button"
          className="icon-btn"
          title="Reload"
          onClick={() => setNonce((n) => n + 1)}
        >
          ↻
        </button>
        <input value={url} onChange={(e) => setUrl(e.target.value)} aria-label="URL" />
      </form>
      <iframe
        key={nonce}
        src={src}
        title={node.title}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />
    </div>
  );
}

export function AgentTerminalBody({ node, primary }: { node: SNode; primary: boolean }) {
  const notify = useStore((s) => s.notify);
  const dead = node.state === 'exited' && node.type === 'agent-terminal';
  return (
    <div className="term-wrap">
      <LazyTerminal nodeId={node.id} primary={primary} />
      {dead && (
        <div className="term-overlay">
          <div>Agent process is not running.</div>
          <div className="row">
            {node.sessionRef && (
              <button
                className="btn"
                onClick={() =>
                  api
                    .post(`/api/nodes/${node.id}/restart`, {})
                    .catch((e) => notify(String(e.message), 'error'))
                }
              >
                Resume session
              </button>
            )}
            <button
              className="btn btn-ghost"
              onClick={() =>
                api
                  .post(`/api/nodes/${node.id}/restart`, { fresh: true })
                  .catch((e) => notify(String(e.message), 'error'))
              }
            >
              Start fresh
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function NodeBody({ node, primary = true }: { node: SNode; primary?: boolean }) {
  switch (node.type) {
    case 'terminal':
    case 'agent-terminal':
      return <AgentTerminalBody node={node} primary={primary} />;
    case 'agent-chat':
      return <ChatView node={node} />;
    case 'note':
      return <NoteBody node={node} />;
    case 'doc':
      return <DocBody node={node} />;
    case 'browser':
      return <BrowserBody node={node} />;
  }
}
