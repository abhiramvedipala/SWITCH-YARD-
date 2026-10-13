import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import type { HarnessId, SessionSummary, Settings } from '../lib/types.js';
import { harnessLabel, useStore } from '../store.js';
import { Modal, timeAgo } from './bits.js';

// ------------------------------------------------------------------ settings
export function SettingsModal() {
  const set = useStore((s) => s.set);
  const settings = useStore((s) => s.settings);
  const detections = useStore((s) => s.detections);
  const agy = useStore((s) => s.agyConfig);
  const remote = useStore((s) => s.remote);
  const wsRoot = useStore((s) => s.workspaces.find((w) => w.id === s.wsId)?.rootDir);
  const { loadSettings, loadHarnesses, notify } = useStore.getState();
  const [tools, setTools] = useState('');
  const [scratch, setScratch] = useState('');
  useEffect(() => {
    void loadSettings();
    void loadHarnesses(true);
    api
      .get<{ scratchDir: string }>('/api/meta')
      .then((m) => setScratch(m.scratchDir))
      .catch(() => undefined);
  }, [loadSettings, loadHarnesses]);
  useEffect(() => setTools((settings?.allowedTools ?? []).join('\n')), [settings?.allowedTools]);
  const save = async (patch: Partial<Settings>) => {
    try {
      await api.patch('/api/settings', patch);
      await loadSettings();
    } catch (e) {
      notify(String((e as Error).message), 'error');
    }
  };
  const agyAct = async (what: 'mcp' | 'hooks', action: 'install' | 'remove') => {
    try {
      await api.post(`/api/agy/${what}`, { action });
      await loadHarnesses();
    } catch (e) {
      notify(String((e as Error).message), 'error');
    }
  };
  const agyPerm = async (action: 'allow-bus' | 'allow-tests' | 'remove', dir?: string) => {
    try {
      await api.post('/api/agy/permissions', { action, dir });
      await loadHarnesses();
      notify(action === 'remove' ? 'Removed the rules Switchyard added' : 'Allow rule added');
    } catch (e) {
      notify(String((e as Error).message), 'error');
    }
  };
  return (
    <Modal title="Settings" onClose={() => set({ modal: 'none' })} wide>
      <h3>Agents on this computer</h3>
      <div className="harness-list">
        {(['claude', 'agy', 'mock', 'shell'] as HarnessId[]).map((h) => {
          const d = detections[h];
          return (
            <div key={h} className="harness">
              <div className="row">
                <b>{harnessLabel(h)}</b>
                <span className={`badge ${d?.installed ? 'badge-ok' : 'badge-wait'}`}>
                  {d ? (d.installed ? 'installed' : 'not installed') : '…'}
                </span>
                {d?.version && <span className="muted small">{d.version}</span>}
              </div>
              {d?.path && <div className="muted small mono">{d.path}</div>}
              {d && !d.installed && d.installHint && (
                <div className="small">
                  Install: <code>{d.installHint}</code>
                </div>
              )}
              {d?.loginHint && <div className="muted small">{d.loginHint}</div>}
              {d?.notes?.map((n) => (
                <div key={n} className="muted small">
                  • {n}
                </div>
              ))}
              {h === 'agy' && d?.installed && (
                <div className="row wrap small">
                  <span>
                    MCP entry in ~/.gemini/config/mcp_config.json:{' '}
                    {agy.mcpEntry ? 'present' : 'absent'}
                  </span>
                  <button
                    className="btn btn-ghost btn-xs"
                    onClick={() => agyAct('mcp', agy.mcpEntry ? 'remove' : 'install')}
                  >
                    {agy.mcpEntry ? 'Remove' : 'Add'}
                  </button>
                  <span>Status hooks (optional): {agy.hooks ? 'installed' : 'off'}</span>
                  <button
                    className="btn btn-ghost btn-xs"
                    onClick={() => agyAct('hooks', agy.hooks ? 'remove' : 'install')}
                  >
                    {agy.hooks ? 'Remove' : 'Install'}
                  </button>
                </div>
              )}
              {h === 'agy' && d?.installed && (
                <div className="perm-box small">
                  <div className="row wrap">
                    <span className={agy.permissions.bus ? 'ok-text' : 'warn-text'}>
                      {agy.permissions.bus ? '✓' : '✗'} bus tools allowed
                    </span>
                    {!agy.permissions.bus && (
                      <button className="btn btn-ghost btn-xs" onClick={() => agyPerm('allow-bus')}>
                        Allow switchyard tools
                      </button>
                    )}
                    <span className={agy.permissions.testCommands ? 'ok-text' : 'muted'}>
                      {agy.permissions.testCommands ? '✓' : '○'} test commands allowed
                    </span>
                  </div>
                  <div className="row wrap">
                    <span className="muted">Let agents run tests and write files in:</span>
                    {scratch && (
                      <button
                        className="btn btn-ghost btn-xs"
                        onClick={() => agyPerm('allow-tests', scratch)}
                      >
                        the scratch folder
                      </button>
                    )}
                    {wsRoot && (
                      <button
                        className="btn btn-ghost btn-xs"
                        onClick={() => agyPerm('allow-tests', wsRoot)}
                      >
                        this workspace
                      </button>
                    )}
                    {(agy.permissions.bus ||
                      agy.permissions.testCommands ||
                      agy.permissions.writeDirs.length > 0) && (
                      <button className="btn btn-ghost btn-xs" onClick={() => agyPerm('remove')}>
                        Remove all Switchyard rules
                      </button>
                    )}
                  </div>
                  <div className="muted">
                    Writes to ~/.gemini/antigravity-cli/settings.json (a .bak is saved first). The
                    test-command rule applies to every folder, because agy has one global settings
                    file.
                    {agy.permissions.writeDirs.length > 0 && (
                      <> Write access: {agy.permissions.writeDirs.join(', ')}</>
                    )}
                  </div>
                </div>
              )}
              {h === 'agy' && settings && (
                <label className="check small">
                  <input
                    type="checkbox"
                    checked={settings.agyPersistentSessions}
                    onChange={(e) => save({ agyPersistentSessions: e.target.checked })}
                  />
                  Keep one agy process per chat node and run step (
                  <code>--input-format stream-json</code>) instead of one <code>agy -p</code> per
                  turn. Experimental: not yet tried with a real agy.
                </label>
              )}
              {h === 'claude' && d?.installed && (
                <div className="small ok-text">
                  ✓ bus tools are pre-allowed for Claude nodes (per process, nothing is written to
                  your Claude settings)
                </div>
              )}
            </div>
          );
        })}
      </div>
      <button className="btn btn-ghost btn-xs" onClick={() => loadHarnesses(true)}>
        Re-check
      </button>

      {settings && (
        <>
          <h3>Behavior</h3>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.autoNudge}
              onChange={(e) => save({ autoNudge: e.target.checked })}
            />
            Last-resort nudge: when an idle agent has unread messages and its hooks can't deliver
            them, type a one-line reminder into its terminal. Claude agents are served by hooks and
            skip this unless you turn it on for that node.
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.runTestsForEvidence}
              onChange={(e) => save({ runTestsForEvidence: e.target.checked })}
            />
            Run the detected test suite at the end of a run for the result card’s evidence
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.remoteReadOnly}
              disabled={remote}
              onChange={(e) => save({ remoteReadOnly: e.target.checked })}
            />
            Remote access (phone via Tailscale) is read-only, except answering questions and
            replying to prompts{' '}
            {remote && <span className="muted">(change this on the computer)</span>}
          </label>
          {settings.remoteOwnerLogin && (
            <div className="row">
              <span className="small">
                Phone access is pinned to <b>{settings.remoteOwnerLogin}</b> (the first tailnet
                login that connected)
              </span>
              <button
                className="btn btn-ghost btn-xs"
                disabled={remote}
                onClick={() => save({ remoteOwnerLogin: '' })}
              >
                Forget
              </button>
            </div>
          )}
          <div className="row wrap">
            <label>
              Ask Switchyard uses
              <select
                value={settings.projectChatHarness}
                onChange={(e) => save({ projectChatHarness: e.target.value as HarnessId })}
              >
                {(['agy', 'claude', 'mock'] as HarnessId[]).map((h) => (
                  <option key={h} value={h}>
                    {harnessLabel(h)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Default builder
              <select
                value={settings.defaultBuilder}
                onChange={(e) => save({ defaultBuilder: e.target.value as HarnessId })}
              >
                {(['claude', 'agy', 'mock'] as HarnessId[]).map((h) => (
                  <option key={h} value={h}>
                    {harnessLabel(h)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Default reviewer
              <select
                value={settings.defaultReviewer}
                onChange={(e) => save({ defaultReviewer: e.target.value as HarnessId })}
              >
                {(['agy', 'claude', 'mock'] as HarnessId[]).map((h) => (
                  <option key={h} value={h}>
                    {harnessLabel(h)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <h3>Pre-approved tools for driven Claude turns (chat nodes & runs)</h3>
          <p className="muted small">
            Claude permission-rule syntax, one per line. Driven turns run in{' '}
            <code>acceptEdits</code> mode; anything not listed is denied (no one is there to answer
            a prompt). Antigravity uses its own rules in{' '}
            <code>~/.gemini/antigravity-cli/settings.json</code>; Switchyard only changes them when
            you click the buttons in the Antigravity card above.
          </p>
          <textarea
            className="mono"
            rows={6}
            value={tools}
            onChange={(e) => setTools(e.target.value)}
            onBlur={() =>
              save({
                allowedTools: tools
                  .split('\n')
                  .map((t) => t.trim())
                  .filter(Boolean),
              })
            }
          />
        </>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ workspace (folder picker)
export function WorkspaceModal() {
  const set = useStore((s) => s.set);
  const { notify, loadWorkspaces, selectWorkspace } = useStore.getState();
  const [path, setPath] = useState('');
  const [listing, setListing] = useState<{
    path: string;
    parent: string | null;
    dirs: string[];
  } | null>(null);
  const [name, setName] = useState('');
  const [scratch, setScratch] = useState('');
  const browse = (p?: string) =>
    api
      .get<{ path: string; parent: string | null; dirs: string[] }>(
        `/api/fs/list${p ? `?path=${encodeURIComponent(p)}` : ''}`,
      )
      .then((l) => {
        setListing(l);
        setPath(l.path);
      })
      .catch((e) => notify(String(e.message), 'error'));
  useEffect(() => {
    void browse();
    api
      .get<{ scratchDir: string }>('/api/meta')
      .then((m) => setScratch(m.scratchDir))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const create = async (rootDir: string, nm?: string) => {
    try {
      if (rootDir === scratch) await api.post('/api/fs/mkdir', { path: scratch });
      const ws = await api.post<{ id: string }>('/api/workspaces', {
        rootDir,
        name: nm || undefined,
      });
      await loadWorkspaces();
      await selectWorkspace(ws.id);
      set({ modal: 'none' });
    } catch (e) {
      notify(String((e as Error).message), 'error');
    }
  };
  return (
    <Modal title="New workspace" onClose={() => set({ modal: 'none' })}>
      <p className="muted small">
        A workspace is a canvas tied to a folder. New terminals and agents start in that folder.
      </p>
      <div className="row">
        <input
          className="grow mono"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && browse(path)}
        />
        <button className="btn btn-ghost" onClick={() => browse(path)}>
          Go
        </button>
      </div>
      {listing && (
        <div className="dir-list">
          {listing.parent && (
            <button onClick={() => browse(listing.parent!)} className="dir">
              ↰ ..
            </button>
          )}
          {listing.dirs.map((d) => (
            <button key={d} className="dir" onClick={() => browse(`${listing.path}/${d}`)}>
              📁 {d}
            </button>
          ))}
          {listing.dirs.length === 0 && <div className="muted small pad">No subfolders</div>}
        </div>
      )}
      <div className="row">
        <input
          className="grow"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name (optional)"
        />
        <button className="btn" onClick={() => create(path, name)}>
          Use this folder
        </button>
      </div>
      {scratch && (
        <button className="btn btn-ghost" onClick={() => create(scratch, 'Scratch')}>
          Use the scratch playground ({scratch})
        </button>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ worktree
export function WorktreeModal() {
  const set = useStore((s) => s.set);
  const wsId = useStore((s) => s.wsId);
  const notify = useStore((s) => s.notify);
  const [branch, setBranch] = useState('agent/feature');
  const [harness, setHarness] = useState<HarnessId>('claude');
  const go = async () => {
    try {
      await api.post(`/api/workspaces/${wsId}/worktree`, { harness, branch });
      set({ modal: 'none' });
      notify('Worktree created and agent started');
    } catch (e) {
      notify(String((e as Error).message), 'error');
    }
  };
  return (
    <Modal title="New agent in a git worktree" onClose={() => set({ modal: 'none' })}>
      <p className="muted small">
        Runs <code>git worktree add -b &lt;branch&gt; ../&lt;repo&gt;-wt-&lt;branch&gt;</code> next
        to the workspace repo and starts an agent there, so it can’t step on your working copy.
      </p>
      <div className="row">
        <input className="grow mono" value={branch} onChange={(e) => setBranch(e.target.value)} />
        <select value={harness} onChange={(e) => setHarness(e.target.value as HarnessId)}>
          <option value="claude">Claude Code</option>
          <option value="agy">Antigravity</option>
          <option value="mock">Mock</option>
        </select>
        <button className="btn" onClick={go}>
          Create
        </button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ import sessions
type ImportTab = 'claude' | 'agy' | 'export';

export function ImportModal() {
  const set = useStore((s) => s.set);
  const wsId = useStore((s) => s.wsId);
  const notify = useStore((s) => s.notify);
  const [tab, setTab] = useState<ImportTab>('claude');
  const [claude, setClaude] = useState<SessionSummary[] | null>(null);
  const [agy, setAgy] = useState<{ sessions: SessionSummary[]; note?: string } | null>(null);
  const [q, setQ] = useState('');
  const [agyId, setAgyId] = useState('');
  const [exportJson, setExportJson] = useState<string | null>(null);
  const [convs, setConvs] = useState<
    { index: number; title: string; source: string; turns: number }[]
  >([]);
  const [picked, setPicked] = useState<number[]>([]);

  useEffect(() => {
    if (tab === 'claude' && !claude)
      api
        .get<{ sessions: SessionSummary[] }>('/api/sessions/claude')
        .then((r) => setClaude(r.sessions))
        .catch((e) => notify(String(e.message), 'error'));
    if (tab === 'agy' && !agy)
      api
        .get<{ sessions: SessionSummary[]; note?: string }>('/api/sessions/agy')
        .then(setAgy)
        .catch((e) => notify(String(e.message), 'error'));
  }, [tab, claude, agy, notify]);

  const filtered = useMemo(() => {
    const s = q.toLowerCase();
    return (claude ?? [])
      .filter(
        (c) => !s || c.title.toLowerCase().includes(s) || (c.cwd ?? '').toLowerCase().includes(s),
      )
      .slice(0, 200);
  }, [claude, q]);

  const resume = async (body: Record<string, unknown>) => {
    try {
      await api.post(`/api/workspaces/${wsId}/resume`, body);
      set({ modal: 'none', view: 'canvas' });
      notify('Session resumed in a new node');
    } catch (e) {
      notify(String((e as Error).message), 'error');
    }
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const text = await f.text();
    try {
      const r = await api.post<{ conversations: typeof convs }>('/api/import/parse', {
        json: text,
      });
      setExportJson(text);
      setConvs(r.conversations);
      setPicked(r.conversations.length === 1 ? [0] : []);
      if (r.conversations.length === 0)
        notify('No Claude.ai or ChatGPT conversations found in that file', 'error');
    } catch (e) {
      notify(`Could not read that file: ${(e as Error).message}`, 'error');
    }
  };

  return (
    <Modal title="Import my sessions" onClose={() => set({ modal: 'none' })} wide>
      <div className="tabs">
        {(['claude', 'agy', 'export'] as ImportTab[]).map((t) => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t === 'claude'
              ? 'Claude Code sessions'
              : t === 'agy'
                ? 'Antigravity conversations'
                : 'Chat export file'}
          </button>
        ))}
      </div>
      {tab === 'claude' && (
        <>
          <p className="muted small">
            From ~/.claude/projects. “Resume here” opens a Claude node running{' '}
            <code>claude --resume &lt;id&gt;</code> in the session’s original folder.
          </p>
          <input
            className="grow"
            placeholder="Filter…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="session-list">
            {claude === null && <div className="muted pad">Loading…</div>}
            {claude?.length === 0 && (
              <div className="muted pad">No Claude Code sessions found on this computer.</div>
            )}
            {filtered.map((s) => (
              <div key={s.path ?? s.sessionId} className="session">
                <div className="grow">
                  <div className="session-title">{s.title}</div>
                  <div className="muted small mono">
                    {s.cwd ?? '?'} · {timeAgo(s.mtime)} · {s.messageCount ?? 0} msgs
                  </div>
                </div>
                <button
                  className="btn btn-xs"
                  onClick={() =>
                    resume({
                      harness: 'claude',
                      sessionId: s.sessionId,
                      cwd: s.cwd ?? undefined,
                      title: s.title.slice(0, 40),
                    })
                  }
                >
                  Resume here
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      {tab === 'agy' && (
        <>
          {agy?.note && <p className="muted small">{agy.note}</p>}
          <div className="session-list">
            {agy?.sessions.map((s) => (
              <div key={s.sessionId} className="session">
                <div className="grow">
                  <div className="session-title">{s.title}</div>
                  <div className="muted small mono">{s.cwd ?? ''}</div>
                </div>
                <button
                  className="btn btn-xs"
                  onClick={() =>
                    resume({
                      harness: 'agy',
                      sessionId: s.sessionId,
                      cwd: s.cwd ?? undefined,
                      title: s.title.slice(0, 40),
                    })
                  }
                >
                  Resume here
                </button>
              </div>
            ))}
          </div>
          <div className="row">
            <button
              className="btn btn-ghost"
              onClick={() =>
                resume({ harness: 'agy', continueLatest: true, title: 'agy (continued)' })
              }
            >
              Continue most recent (agy -c) in this workspace’s folder
            </button>
          </div>
          <div className="row">
            <input
              className="grow mono"
              placeholder="conversation id"
              value={agyId}
              onChange={(e) => setAgyId(e.target.value)}
            />
            <button
              className="btn"
              disabled={!agyId.trim()}
              onClick={() => resume({ harness: 'agy', sessionId: agyId.trim() })}
            >
              Resume by id
            </button>
          </div>
        </>
      )}
      {tab === 'export' && (
        <>
          <p className="muted small">
            Live claude.ai / Gemini web chats can’t be connected (there’s no API for that). Export
            them instead — Claude.ai: Settings → Privacy → Export data; ChatGPT: Settings → Data
            controls → Export — and pick the <code>conversations.json</code> from the zip. Each chat
            becomes a read-only doc node you can connect an agent to for context.
          </p>
          <input
            type="file"
            accept=".json,application/json"
            onChange={(e) => onFile(e.target.files?.[0])}
          />
          {convs.length > 0 && (
            <>
              <div className="session-list">
                {convs.map((c) => (
                  <label key={c.index} className="session check">
                    <input
                      type="checkbox"
                      checked={picked.includes(c.index)}
                      onChange={(e) =>
                        setPicked(
                          e.target.checked
                            ? [...picked, c.index]
                            : picked.filter((i) => i !== c.index),
                        )
                      }
                    />
                    <span className="grow">{c.title}</span>
                    <span className="muted small">
                      {c.source} · {c.turns} turns
                    </span>
                  </label>
                ))}
              </div>
              <button
                className="btn"
                disabled={picked.length === 0 || picked.length > 50}
                onClick={async () => {
                  try {
                    await api.post(`/api/workspaces/${wsId}/import`, {
                      json: exportJson,
                      indices: picked,
                    });
                    set({ modal: 'none', view: 'canvas' });
                    notify(
                      `Imported ${picked.length} conversation${picked.length === 1 ? '' : 's'} as doc nodes`,
                    );
                  } catch (e) {
                    notify(String((e as Error).message), 'error');
                  }
                }}
              >
                Import {picked.length || ''} as doc node{picked.length === 1 ? '' : 's'}
              </button>
            </>
          )}
        </>
      )}
    </Modal>
  );
}
