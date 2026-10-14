import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, ApiError } from '../lib/api.js';
import type { SNode } from '../lib/types.js';
import { useStore } from '../store.js';
import { LazyMd } from './Lazy.js';

type Entry = { name: string; dir: boolean };
type Opened = { path: string; size: number; mtime: number } & (
  { kind: 'text'; text: string } | { kind: 'image'; dataUrl: string } | { kind: 'binary' }
);

const q = (nodeId: string, path: string) =>
  `nodeId=${encodeURIComponent(nodeId)}&path=${encodeURIComponent(path)}`;
const fmtSize = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1 << 20
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / (1 << 20)).toFixed(1)} MB`;

/** One folder of the tree, fetched when first shown; subfolders are fetched when expanded. */
function Dir({
  nodeId,
  path,
  depth,
  dotfiles,
  nonce,
  selected,
  onOpen,
}: {
  nodeId: string;
  path: string;
  depth: number;
  dotfiles: boolean;
  nonce: number;
  selected: string | null;
  onOpen: (path: string) => void;
}) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let alive = true;
    api
      .get<{ entries: Entry[] }>(`/api/fs/tree?${q(nodeId, path)}${dotfiles ? '&dotfiles=1' : ''}`)
      .then((r) => alive && setEntries(r.entries))
      .catch(() => alive && setEntries([]));
    return () => {
      alive = false;
    };
  }, [nodeId, path, dotfiles, nonce]);
  if (!entries) return depth ? null : <div className="muted small pad">Loading…</div>;
  if (!entries.length && !depth) return <div className="muted small pad">Empty folder</div>;
  return (
    <>
      {entries.map((e) => {
        const p = path ? `${path}/${e.name}` : e.name;
        return (
          <div key={e.name}>
            <button
              type="button"
              className={`tree-row${selected === p ? ' selected' : ''}`}
              style={{ paddingLeft: 8 + depth * 14 }}
              data-path={p}
              data-dir={e.dir ? '1' : undefined}
              data-open={open[e.name] ? '1' : undefined}
              onClick={() => (e.dir ? setOpen((o) => ({ ...o, [e.name]: !o[e.name] })) : onOpen(p))}
            >
              <span className="tree-glyph">{e.dir ? (open[e.name] ? '▾' : '▸') : ''}</span>
              {e.name}
            </button>
            {e.dir && open[e.name] && (
              <Dir
                nodeId={nodeId}
                path={p}
                depth={depth + 1}
                dotfiles={dotfiles}
                nonce={nonce}
                selected={selected}
                onOpen={onOpen}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

/** Arrow keys walk the rows; Right/Left expand or collapse a folder; Enter opens (the row is a button). */
function treeKeys(e: KeyboardEvent<HTMLDivElement>) {
  const rows = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('.tree-row')];
  const i = rows.indexOf(document.activeElement as HTMLButtonElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    rows[Math.min(rows.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && rows[i]?.dataset.dir) {
    e.preventDefault();
    if ((e.key === 'ArrowRight') !== (rows[i]!.dataset.open === '1')) rows[i]!.click();
  }
}

export function FilesBody({ node }: { node: SNode }) {
  const ro = useStore((s) => s.readOnly || s.remote);
  const notify = useStore((s) => s.notify);
  const rootName = useStore(
    (s) =>
      s.workspaces
        .find((w) => w.id === node.workspaceId)
        ?.rootDir.split('/')
        .filter(Boolean)
        .pop() ?? '',
  );
  const [dotfiles, setDotfiles] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [file, setFile] = useState<Opened | null>(null);
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  /** The open file changed on disk while there are unsaved edits. */
  const [changedOnDisk, setChangedOnDisk] = useState(false);
  const [preview, setPreview] = useState(true);
  const gutter = useRef<HTMLPreElement>(null);

  const load = useCallback(
    async (path: string) => {
      try {
        const r = await api.get<Opened>(`/api/fs/read?${q(node.id, path)}`);
        setFile(r);
        setText(r.kind === 'text' ? r.text : '');
        setDirty(false);
        setChangedOnDisk(false);
      } catch (e) {
        notify(String((e as Error).message), 'error');
      }
    },
    [node.id, notify],
  );
  const open = (path: string) => {
    if (path === file?.path) return;
    if (dirty && !confirm('Discard unsaved changes?')) return;
    void load(path);
  };
  const save = async () => {
    if (!file || file.kind !== 'text' || !dirty || ro) return;
    try {
      const r = await api.put<{ mtime: number }>('/api/fs/write', {
        nodeId: node.id,
        path: file.path,
        text,
        expectedMtime: file.mtime,
      });
      setFile({ ...file, text, mtime: r.mtime, size: new Blob([text]).size });
      setDirty(false);
      setChangedOnDisk(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setChangedOnDisk(true);
      notify(String((e as Error).message), 'error');
    }
  };

  // Poll the open file's mtime every 2 s: reload when it changed on disk, or flag it when there are unsaved edits.
  useEffect(() => {
    if (!file) return;
    const t = setInterval(async () => {
      if (document.hidden) return;
      const st = await api
        .get<{ mtime: number }>(`/api/fs/stat?${q(node.id, file.path)}`)
        .catch(() => null);
      if (!st || st.mtime === file.mtime) return;
      if (dirty) setChangedOnDisk(true);
      else void load(file.path);
    }, 2000);
    return () => clearInterval(t);
  }, [file, dirty, node.id, load]);

  const isMd = !!file && /\.(md|markdown)$/i.test(file.path);
  const mac = /Mac/.test(navigator.platform);
  return (
    <div
      className="files nodrag nowheel"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          void save();
        }
      }}
    >
      <div className="files-tree">
        <div className="files-tree-head small">
          <span className="name" title={rootName}>
            {rootName}
          </span>
          <label className="muted" title="Show dotfiles">
            <input
              type="checkbox"
              checked={dotfiles}
              onChange={(e) => setDotfiles(e.target.checked)}
            />
            .files
          </label>
          <button
            type="button"
            className="icon-btn"
            title="Refresh"
            onClick={() => setNonce((n) => n + 1)}
          >
            ↻
          </button>
        </div>
        <div className="files-tree-body" onKeyDown={treeKeys}>
          <Dir
            nodeId={node.id}
            path=""
            depth={0}
            dotfiles={dotfiles}
            nonce={nonce}
            selected={file?.path ?? null}
            onOpen={open}
          />
        </div>
      </div>
      <div className="files-main">
        <div className="doc-bar files-bar small">
          <span className="path mono" title={file?.path}>
            {file ? file.path : 'Pick a file'}
            {dirty && (
              <span className="files-dirty" title="Unsaved changes">
                {' '}
                ●
              </span>
            )}
          </span>
          {file && <span className="muted">{fmtSize(file.size)}</span>}
          {changedOnDisk && (
            <button
              type="button"
              className="btn btn-xs"
              title="The file changed on disk; load the new version (drops your edits)"
              onClick={() => file && void load(file.path)}
            >
              Changed on disk · Reload
            </button>
          )}
          {file?.kind === 'text' && isMd && (
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={() => setPreview(!preview)}
            >
              {preview ? 'Edit' : 'Preview'}
            </button>
          )}
          {file?.kind === 'text' && !ro && (
            <button
              type="button"
              className="btn btn-xs"
              disabled={!dirty}
              title="⌘S"
              onClick={() => void save()}
            >
              Save
            </button>
          )}
          {file && !ro && mac && (
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={() =>
                api
                  .post('/api/fs/reveal', { nodeId: node.id, path: file.path })
                  .catch((e) => notify(String((e as Error).message), 'error'))
              }
            >
              Reveal in Finder
            </button>
          )}
        </div>
        {!file ? (
          <div className="muted small pad">Pick a file on the left.</div>
        ) : file.kind === 'binary' ? (
          <div className="muted small pad">Binary or too large to show · {fmtSize(file.size)}</div>
        ) : file.kind === 'image' ? (
          <div className="files-view">
            <img src={file.dataUrl} alt={file.path} />
          </div>
        ) : isMd && preview ? (
          <div className="doc-view md">
            <LazyMd>{text || '_Empty file_'}</LazyMd>
          </div>
        ) : (
          <div className="files-editor">
            <pre className="files-gutter" ref={gutter} aria-hidden>
              {Array.from({ length: text.split('\n').length }, (_, i) => i + 1).join('\n')}
            </pre>
            <textarea
              className="files-text"
              value={text}
              readOnly={ro}
              spellCheck={false}
              wrap="off"
              aria-label={file.path}
              onChange={(e) => {
                setText(e.target.value);
                setDirty(e.target.value !== file.text);
              }}
              onScroll={(e) => {
                if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
