import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { api } from '../lib/api.js';
import { socket } from '../lib/ws.js';
import type {
  HarnessId,
  Room,
  RoomMessage,
  RoomMode,
  RoomParticipant,
  UsageTotals,
} from '../lib/types.js';
import { harnessLabel, useStore } from '../store.js';
import { MicButton, timeAgo, usageLabel } from '../components/bits.js';
import { LazyMd } from '../components/Lazy.js';

interface RoomView {
  room: Room;
  busy: boolean;
  participants: RoomParticipant[];
  messages: RoomMessage[];
}

const MODES: { value: RoomMode; label: string }[] = [
  { value: 'all', label: 'Everyone answers' },
  { value: 'mention', label: 'Only @mentioned' },
  { value: 'round', label: 'One after another' },
];
const COLORS = ['#59c7ff', '#a78bfa', '#f0b27a', '#4cd964', '#ff8fb1', '#ffd166'];
const fail = (e: unknown) => useStore.getState().notify(String((e as Error).message), 'error');

/** Rooms: one conversation with several AIs (each a harness) plus you and, via the bus, canvas agents. */
export function Rooms() {
  const wsId = useStore((s) => s.wsId);
  const readOnly = useStore((s) => s.readOnly);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [sel, setSel] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!wsId) return;
    const r = await api.get<{ rooms: Room[] }>(`/api/workspaces/${wsId}/rooms`);
    setRooms(r.rooms);
    setSel((s) => (s && r.rooms.some((x) => x.id === s) ? s : (r.rooms[0]?.id ?? null)));
  }, [wsId]);

  useEffect(() => {
    load().catch(() => undefined);
    const off = socket.on((e) => {
      if (e.t === 'change' && e.entity === 'rooms') load().catch(() => undefined);
    });
    return () => {
      off();
    };
  }, [load]);

  const create = async () => {
    try {
      const r = await api.post<Room>(`/api/workspaces/${wsId}/rooms`, {});
      await load();
      setSel(r.id);
    } catch (e) {
      fail(e);
    }
  };

  return (
    <div className="rooms">
      <aside className="room-list">
        <div className="room-list-head">
          <h3>Rooms</h3>
          <span className="spacer" />
          {!readOnly && (
            <button className="btn btn-xs" onClick={create}>
              + New room
            </button>
          )}
        </div>
        {rooms.map((r) => (
          <button
            key={r.id}
            className={`room-item ${r.id === sel ? 'active' : ''}`}
            onClick={() => setSel(r.id)}
          >
            <span className="grow">{r.title}</span>
            {r.busy && (
              <span className="chip chip-working" title="answering">
                <span className="dot" />
              </span>
            )}
            <span className="muted small">{r.participants ?? 0}</span>
          </button>
        ))}
        {rooms.length === 0 && (
          <p className="muted small pad">
            A room is one conversation with several AIs at once. Add Claude, Antigravity or any
            other agent you have, then talk to all of them, or to one with @name.
          </p>
        )}
      </aside>
      {sel ? (
        <RoomPane key={sel} roomId={sel} />
      ) : (
        <div className="room-empty muted">No room yet.</div>
      )}
    </div>
  );
}

function RoomPane({ roomId }: { roomId: string }) {
  const readOnly = useStore((s) => s.readOnly);
  const set = useStore((s) => s.set);
  const [v, setV] = useState<RoomView | null>(null);
  /** Text streaming in per turn, keyed by replyId; dropped when the turn ends (the stored message replaces it). */
  const [streams, setStreams] = useState<Record<string, { participantId: string; text: string }>>(
    {},
  );
  const scroller = useRef<HTMLDivElement>(null);

  const reload = useCallback(
    () =>
      api
        .get<RoomView>(`/api/rooms/${roomId}`)
        .then(setV)
        .catch(() => undefined),
    [roomId],
  );

  useEffect(() => {
    void reload();
    const off = socket.on((e) => {
      if (e.t !== 'room' || e.roomId !== roomId) return;
      const ev = e.event;
      const working = (pid: string | undefined, on: boolean) =>
        setV(
          (cur) =>
            cur && {
              ...cur,
              participants: cur.participants.map((p) =>
                p.id === pid ? { ...p, working: on, error: on ? null : p.error } : p,
              ),
            },
        );
      if (ev.type === 'message') {
        const m = ev.message as RoomMessage;
        setV((cur) =>
          cur && !cur.messages.some((x) => x.id === m.id)
            ? { ...cur, messages: [...cur.messages, m] }
            : cur,
        );
      } else if (ev.type === 'start') {
        setStreams((s) => ({
          ...s,
          [ev.replyId!]: { participantId: ev.participantId!, text: '' },
        }));
        working(ev.participantId, true);
      } else if (ev.type === 'delta') {
        setStreams((s) => {
          const cur = s[ev.replyId!];
          return cur ? { ...s, [ev.replyId!]: { ...cur, text: cur.text + (ev.delta ?? '') } } : s;
        });
      } else if (ev.type === 'end') {
        setStreams((s) => {
          const rest = { ...s };
          delete rest[ev.replyId!];
          return rest;
        });
        void reload();
      } else if (ev.type === 'busy') {
        setV((cur) => cur && { ...cur, busy: !!ev.busy });
      } else void reload(); // participants changed, or a seed landed
    });
    return () => {
      off();
    };
  }, [roomId, reload]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [v?.messages.length, streams]);

  if (!v) return <div className="room" />;
  const color = (pid: string | null) => {
    const i = v.participants.findIndex((p) => p.id === pid);
    return i < 0 ? 'var(--muted)' : COLORS[i % COLORS.length]!;
  };
  const byId = new Map(v.participants.map((p) => [p.id, p]));
  const patch = (body: Record<string, unknown>) =>
    api.patch(`/api/rooms/${roomId}`, body).then(reload).catch(fail);

  return (
    <section className="room">
      <div className="room-head">
        <b className="room-title">{v.room.title}</b>
        <select
          className="room-mode"
          value={v.room.mode}
          disabled={readOnly}
          onChange={(e) => void patch({ mode: e.target.value })}
          title="Who answers a message that @mentions nobody"
        >
          {MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <RoomUsage roomId={roomId} busy={v.busy} />
        <span className="spacer" />
        {!readOnly && (
          <button
            className="btn btn-ghost btn-xs"
            onClick={() => set({ seedRoomId: roomId, modal: 'import' })}
          >
            Seed from import…
          </button>
        )}
        {!readOnly && v.busy && (
          <button
            className="btn btn-xs room-stop"
            onClick={() => api.post(`/api/rooms/${roomId}/stop`).catch(fail)}
          >
            Stop
          </button>
        )}
        {!readOnly && (
          <button
            className="icon-btn"
            title="Delete room"
            aria-label="Delete room"
            onClick={() => {
              if (window.confirm(`Delete “${v.room.title}” and its transcript?`))
                api.del(`/api/rooms/${roomId}`).catch(fail);
            }}
          >
            ✕
          </button>
        )}
      </div>
      <div className="room-people">
        {v.participants.map((p) => (
          <span key={p.id} className="person" title={p.error ?? undefined}>
            <span className="person-dot" style={{ background: color(p.id) }} />
            {p.displayName}
            <HarnessBadge harness={p.harness} />
            {p.yolo && <span className="badge badge-yolo">YOLO</span>}
            {p.working && (
              <span className="chip chip-working">
                <span className="dot" />
                answering
              </span>
            )}
            {p.error && !p.working && <span className="error small">⚠ {p.error.slice(0, 60)}</span>}
            {!readOnly && (
              <button
                className="icon-btn"
                aria-label={`Remove ${p.displayName}`}
                onClick={() =>
                  api.del(`/api/rooms/${roomId}/participants/${p.id}`).then(reload).catch(fail)
                }
              >
                ✕
              </button>
            )}
          </span>
        ))}
        {!readOnly && <AddParticipant roomId={roomId} taken={v.participants} onAdded={reload} />}
      </div>
      <div className="room-scroll" ref={scroller}>
        {v.messages.length === 0 && (
          <div className="muted small pad">
            {v.participants.length
              ? 'Say something. @name a participant to ask only them.'
              : 'Add a participant above to start.'}
          </div>
        )}
        {groupImports(v.messages).map((m) =>
          Array.isArray(m) ? (
            <ImportGroup key={m[0]!.id} lines={m} />
          ) : (
            <div
              key={m.id}
              // Your own lines reuse the chat's user bubble, so both themes already style them.
              className={`rmsg rmsg-${m.authorKind}${m.authorKind === 'human' ? ' msg msg-user' : ''}`}
            >
              <div className="rmsg-head">
                <span
                  className="person-dot"
                  style={{
                    background:
                      m.authorKind === 'human'
                        ? 'var(--text)'
                        : m.authorKind === 'agent'
                          ? 'var(--warn)'
                          : color(m.authorId),
                  }}
                />
                <b>{m.authorKind === 'human' ? 'You' : m.authorName}</b>
                {m.authorKind === 'participant' && byId.get(m.authorId ?? '') && (
                  <HarnessBadge harness={byId.get(m.authorId!)!.harness} />
                )}
                {m.authorKind === 'agent' && <span className="badge">canvas agent</span>}
                <span className="muted small">{timeAgo(m.createdAt)}</span>
              </div>
              {m.authorKind === 'participant' ? (
                <div className="md">
                  <LazyMd>{m.text}</LazyMd>
                </div>
              ) : (
                <div className="pre">{m.text}</div>
              )}
            </div>
          ),
        )}
        {Object.entries(streams).map(([id, s]) => {
          const p = byId.get(s.participantId);
          return (
            <div key={id} className="rmsg rmsg-participant rmsg-streaming">
              <div className="rmsg-head">
                <span className="person-dot" style={{ background: color(s.participantId) }} />
                <b>{p?.displayName ?? '…'}</b>
                {p && <HarnessBadge harness={p.harness} />}
              </div>
              <div className="pre">{s.text || '…'}</div>
            </div>
          );
        })}
      </div>
      <Composer roomId={roomId} participants={v.participants} />
    </section>
  );
}

function HarnessBadge({ harness }: { harness: string }) {
  return <span className={`badge badge-${harness}`}>{harnessLabel(harness)}</span>;
}

/** Consecutive imported lines fold into one collapsed block. */
function groupImports(ms: RoomMessage[]): (RoomMessage | RoomMessage[])[] {
  const out: (RoomMessage | RoomMessage[])[] = [];
  for (const m of ms) {
    const last = out.at(-1);
    if (m.authorKind !== 'import') out.push(m);
    else if (Array.isArray(last)) last.push(m);
    else out.push([m]);
  }
  return out;
}

function ImportGroup({ lines }: { lines: RoomMessage[] }) {
  const [open, setOpen] = useState(false);
  const [head, ...rest] = lines;
  return (
    <div className="room-import">
      <button className="link small" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} {head!.text}
      </button>
      {open &&
        rest.map((m) => (
          <div key={m.id} className="room-import-line">
            <b>{m.authorName}:</b> <span className="pre">{m.text.slice(0, 4000)}</span>
          </div>
        ))}
    </div>
  );
}

function RoomUsage({ roomId, busy }: { roomId: string; busy: boolean }) {
  const [u, setU] = useState<UsageTotals | null>(null);
  useEffect(() => {
    if (busy) return;
    let live = true;
    api
      .get<{ total: UsageTotals }>(`/api/usage?roomId=${roomId}`)
      .then((r) => live && setU(r.total))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [roomId, busy]);
  if (!u?.turns) return null;
  return (
    <span className="badge badge-usage" title={`${u.turns} turns in this room`}>
      {usageLabel(u)}
    </span>
  );
}

function AddParticipant({
  roomId,
  taken,
  onAdded,
}: {
  roomId: string;
  taken: RoomParticipant[];
  onAdded: () => void;
}) {
  const drivable = useStore((s) => s.drivable);
  const detections = useStore((s) => s.detections);
  const usable = (h: string) => detections[h as HarnessId]?.installed !== false;
  const [harness, setHarness] = useState('');
  const [name, setName] = useState('');
  const pick = harness && drivable.includes(harness) ? harness : (drivable.find(usable) ?? '');
  const base = harnessLabel(pick);
  const names = new Set(taken.map((p) => p.displayName.toLowerCase()));
  let fallback = base;
  for (let i = 2; names.has(fallback.toLowerCase()); i++) fallback = `${base} ${i}`;
  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post(`/api/rooms/${roomId}/participants`, {
        harness: pick,
        displayName: name.trim() || fallback,
      });
      setName('');
      onAdded();
    } catch (err) {
      fail(err);
    }
  };
  return (
    <form className="add-person" onSubmit={add}>
      <select value={pick} onChange={(e) => setHarness(e.target.value)} aria-label="Harness">
        {drivable.map((h) => {
          const d = detections[h as HarnessId];
          return (
            <option key={h} value={h} disabled={!usable(h)} title={d?.installHint}>
              {harnessLabel(h)}
              {usable(h) ? '' : ' (not installed)'}
            </option>
          );
        })}
      </select>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={fallback}
        aria-label="Participant name"
        maxLength={40}
      />
      <button className="btn btn-xs" type="submit" disabled={!pick}>
        Add
      </button>
    </form>
  );
}

function Composer({ roomId, participants }: { roomId: string; participants: RoomParticipant[] }) {
  const [draft, setDraft] = useState('');
  const [caret, setCaret] = useState(0);
  const [hi, setHi] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  // After picking a name, put the caret behind it in the same commit, before the next keystroke
  // lands (a later requestAnimationFrame moved it back under fast typing and scrambled the text).
  const caretTo = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (caretTo.current === null || !ta.current) return;
    ta.current.focus();
    ta.current.setSelectionRange(caretTo.current, caretTo.current);
    caretTo.current = null;
  }, [draft]);
  // "@Mo|" → offer the participants whose name starts with "Mo" (names may contain spaces).
  const q = /@([^@\n]{0,40})$/.exec(draft.slice(0, caret));
  const query = q?.[1]?.toLowerCase() ?? '';
  const options =
    q && !dismissed && !participants.some((p) => p.displayName.toLowerCase() === query)
      ? participants.filter((p) => p.displayName.toLowerCase().startsWith(query)).slice(0, 6)
      : [];

  const pickOption = (p: RoomParticipant) => {
    const before = draft.slice(0, caret - (q?.[1]?.length ?? 0) - 1);
    const next = `${before}@${p.displayName} `;
    setDraft(next + draft.slice(caret));
    setCaret(next.length);
    setHi(0);
    caretTo.current = next.length;
  };

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    setCaret(0);
    try {
      await api.post(`/api/rooms/${roomId}/messages`, { text });
    } catch (err) {
      fail(err);
      setDraft(text);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (options.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setHi((h) => (h + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickOption(options[Math.min(hi, options.length - 1)]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <form className="composer room-composer" onSubmit={send}>
      {options.length > 0 && (
        <div className="menu mention-menu" role="listbox">
          {options.map((p, i) => (
            <button
              type="button"
              key={p.id}
              role="option"
              aria-selected={i === hi}
              className={i === hi ? 'on' : ''}
              onMouseDown={(e) => {
                e.preventDefault(); // keep the textarea focused
                pickOption(p);
              }}
            >
              <span>@{p.displayName}</span>
              <span className="muted small">{harnessLabel(p.harness)}</span>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={ta}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setCaret(e.target.selectionStart);
          setDismissed(false);
          setHi(0);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={onKey}
        placeholder="Message the room (@name to ask one participant; Enter to send)"
        rows={2}
      />
      <div className="composer-actions">
        <MicButton onText={(t) => setDraft((d) => (d ? `${d} ${t}` : t))} />
        <button type="submit" className="btn" disabled={!draft.trim()}>
          Send
        </button>
      </div>
    </form>
  );
}
