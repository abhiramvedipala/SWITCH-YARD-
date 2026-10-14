import type { Store } from '../store.js';
import { hub } from '../events.js';
import { randomId } from '../auth/token.js';
import { getSetting } from '../db/index.js';
import { harnesses, isHarnessId } from '../harness/index.js';
import { PEER_NOT_PERMISSION } from '../harness/util.js';
import { DEFAULT_ALLOWED_TOOLS } from '../chat/service.js';
import { recordUsage } from '../usage/index.js';
import { assertSafeCwd } from '../paths.js';

export type RoomMode = 'all' | 'mention' | 'round';
export type AuthorKind = 'human' | 'participant' | 'agent' | 'import';

export interface Room {
  id: string;
  workspaceId: string;
  title: string;
  mode: RoomMode;
  allowOwnFolder: boolean;
  createdAt: number;
}

export interface Participant {
  id: string;
  roomId: string;
  harness: string;
  displayName: string;
  sessionRef: string | null;
  nodeId: string | null;
  yolo: boolean;
  /** rowid of the newest room message already put in this participant's prompt. */
  seenSeq: number;
  createdAt: number;
}

export interface RoomMessage {
  id: string;
  roomId: string;
  seq: number;
  authorKind: AuthorKind;
  authorId: string | null;
  authorName: string;
  text: string;
  replyTo: string | null;
  createdAt: number;
}

/** Replies one post may cause through participants @mentioning each other, so two AIs can never loop. */
export const CHAIN_CAP = 2;
/** Imported conversations go into a participant's first turn, cut to their last this many characters. */
export const IMPORT_BUDGET = 20_000;
/** Same idea for the room lines a participant has not seen (someone added late to a long room). */
const LINES_BUDGET = 60_000;
export const HUMAN_NAME = 'Human';

/** Every harness that can run a headless turn can sit in a room; nothing here names a specific one. */
export function drivableHarnesses(): string[] {
  return Object.values(harnesses)
    .filter((h) => !!h.runTurn)
    .map((h) => h.id);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentionRe = (name: string) => new RegExp(`@${escapeRe(name)}(?![\\p{L}\\p{N}_-])`, 'giu');

/** Participants @mentioned in text. Longest names first, so "@Mock AB" never also counts as "@Mock A". */
export function mentionsIn(text: string, ps: Participant[]): Participant[] {
  let rest = text;
  const hit: Participant[] = [];
  for (const p of [...ps].sort((a, b) => b.displayName.length - a.displayName.length)) {
    const re = mentionRe(p.displayName);
    if (!re.test(rest)) continue;
    hit.push(p);
    rest = rest.replace(re, ' ');
  }
  return hit;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `(Cut to fit: showing the last ${max} of ${text.length} characters.)\n…${text.slice(-max)}`;
}

function line(m: RoomMessage): string {
  return m.authorKind === 'agent'
    ? `[${m.authorName} (canvas agent)]: ${m.text}`
    : `[${m.authorName}]: ${m.text}`;
}

export function systemPrompt(p: Participant, all: Participant[]): string {
  const others = all.filter((o) => o.id !== p.id);
  return [
    `You are "${p.displayName}", one participant in a Switchyard Room: a group conversation between a human (shown as [${HUMAN_NAME}]) and several AI participants. Agents from the human's canvas may post too (shown as [Name (canvas agent)]).`,
    `Other participants: ${others.length ? others.map((o) => `@${o.displayName} (${o.harness})`).join(', ') : 'none yet'}.`,
    'Each turn you receive only the lines added since your last turn, formatted as "[Name]: text". Reply with your own message only, without a "[Name]:" prefix.',
    'Address someone with @Name. Mention another participant only when you need their answer: a mention asks them to reply, and automatic follow-ups are capped.',
    `Speak only as ${p.displayName}: never write lines for, or claim to be, another participant or the human.`,
    PEER_NOT_PERMISSION,
  ].join('\n');
}

/** One post's budget of chained replies, and who is already lined up to answer it. */
interface Exchange {
  budget: number;
  queued: Set<string>;
}

type Row = Record<string, unknown>;
const toRoom = (r: Row): Room => ({
  id: r.id as string,
  workspaceId: r.workspace_id as string,
  title: r.title as string,
  mode: r.mode as RoomMode,
  allowOwnFolder: r.allow_own_folder === 1,
  createdAt: r.created_at as number,
});
const toParticipant = (r: Row): Participant => ({
  id: r.id as string,
  roomId: r.room_id as string,
  harness: r.harness as string,
  displayName: r.display_name as string,
  sessionRef: (r.session_ref as string | null) ?? null,
  nodeId: (r.node_id as string | null) ?? null,
  yolo: r.yolo === 1,
  seenSeq: r.seen_seq as number,
  createdAt: r.created_at as number,
});
const toMessage = (r: Row): RoomMessage => ({
  id: r.id as string,
  roomId: r.room_id as string,
  seq: r.seq as number,
  authorKind: r.author_kind as AuthorKind,
  authorId: (r.author_id as string | null) ?? null,
  authorName: r.author_name as string,
  text: r.text as string,
  replyTo: (r.reply_to as string | null) ?? null,
  createdAt: r.created_at as number,
});

/**
 * Rooms: the human, AI participants (any drivable harness) and canvas agents in one transcript.
 * Each participant keeps its own CLI session and per turn gets only the lines it has not seen.
 */
export class RoomService {
  /** Per room: the signal every in-flight and queued turn listens to. Stop aborts it; the next post gets a new one. */
  private ctrls = new Map<string, AbortController>();
  /** Per participant: the tail of its turn queue, so one participant never runs two turns at once. */
  private tails = new Map<string, Promise<void>>();
  /** Per room: turns running or queued. */
  private pending = new Map<string, number>();
  private working = new Set<string>();
  private errors = new Map<string, string>();

  constructor(private store: Store) {}

  private get db() {
    return this.store.db;
  }

  // ---------------------------------------------------------------- reads
  get(id: string): Room | undefined {
    const r = this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as Row | undefined;
    return r && toRoom(r);
  }

  private must(id: string): Room {
    const r = this.get(id);
    if (!r) throw new Error('unknown room');
    return r;
  }

  list(workspaceId: string): (Room & { participants: number; busy: boolean })[] {
    return (
      this.db
        .prepare(
          'SELECT r.*, (SELECT COUNT(*) FROM room_participants p WHERE p.room_id = r.id) n FROM rooms r WHERE workspace_id = ? ORDER BY created_at',
        )
        .all(workspaceId) as Row[]
    ).map((r) => ({ ...toRoom(r), participants: r.n as number, busy: this.busy(r.id as string) }));
  }

  participants(roomId: string): Participant[] {
    return (
      this.db
        .prepare('SELECT * FROM room_participants WHERE room_id = ? ORDER BY created_at, rowid')
        .all(roomId) as Row[]
    ).map(toParticipant);
  }

  private participant(id: string): Participant | undefined {
    const r = this.db.prepare('SELECT * FROM room_participants WHERE id = ?').get(id) as
      Row | undefined;
    return r && toParticipant(r);
  }

  /** Messages after `sinceId` (all when omitted), oldest first, at most the newest `limit`. */
  messages(roomId: string, sinceId?: string, limit = 500): RoomMessage[] {
    const after = sinceId
      ? ((
          this.db
            .prepare('SELECT rowid seq FROM room_messages WHERE id = ? AND room_id = ?')
            .get(sinceId, roomId) as { seq: number } | undefined
        )?.seq ?? 0)
      : 0;
    return (
      this.db
        .prepare(
          'SELECT * FROM (SELECT rowid seq, * FROM room_messages WHERE room_id = ? AND rowid > ? ORDER BY rowid DESC LIMIT ?) ORDER BY seq',
        )
        .all(roomId, after, limit) as Row[]
    ).map(toMessage);
  }

  busy(roomId: string): boolean {
    return (this.pending.get(roomId) ?? 0) > 0;
  }

  /** Everything the Rooms view shows for one room. */
  view(roomId: string) {
    const room = this.must(roomId);
    return {
      room,
      busy: this.busy(roomId),
      participants: this.participants(roomId).map(({ seenSeq: _s, ...p }) => ({
        ...p,
        working: this.working.has(p.id),
        error: this.errors.get(p.id) ?? null,
      })),
      messages: this.messages(roomId),
    };
  }

  // ---------------------------------------------------------------- writes
  private changed(workspaceId: string, id?: string) {
    hub.emitHub({ t: 'change', entity: 'rooms', workspaceId, id });
  }

  private emit(roomId: string, event: Record<string, unknown>) {
    hub.emitHub({ t: 'room', roomId, event });
  }

  create(
    workspaceId: string,
    input: { title?: string; mode?: RoomMode; allowOwnFolder?: boolean },
  ): Room {
    if (!this.store.getWorkspace(workspaceId)) throw new Error('unknown workspace');
    const n = this.list(workspaceId).length;
    const room: Room = {
      id: randomId(9),
      workspaceId,
      title: input.title?.trim() || `Room ${n + 1}`,
      mode: input.mode ?? 'all',
      allowOwnFolder: !!input.allowOwnFolder,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        'INSERT INTO rooms(id, workspace_id, title, mode, allow_own_folder, created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(
        room.id,
        workspaceId,
        room.title,
        room.mode,
        room.allowOwnFolder ? 1 : 0,
        room.createdAt,
      );
    this.changed(workspaceId, room.id);
    return room;
  }

  update(id: string, patch: { title?: string; mode?: RoomMode }): Room {
    const room = this.must(id);
    if (patch.title !== undefined)
      this.db.prepare('UPDATE rooms SET title = ? WHERE id = ?').run(patch.title.trim(), id);
    if (patch.mode !== undefined)
      this.db.prepare('UPDATE rooms SET mode = ? WHERE id = ?').run(patch.mode, id);
    this.changed(room.workspaceId, id);
    return this.must(id);
  }

  delete(id: string): void {
    const room = this.must(id);
    this.stop(id);
    this.db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
    this.changed(room.workspaceId, id);
  }

  addParticipant(
    roomId: string,
    input: { harness: string; displayName: string; yolo?: boolean },
  ): Participant {
    const room = this.must(roomId);
    if (!isHarnessId(input.harness) || !harnesses[input.harness].runTurn)
      throw new Error(
        `${input.harness} cannot take part in a room (pick one of: ${drivableHarnesses().join(', ')})`,
      );
    const name = input.displayName.trim();
    if (!name || name.length > 40 || /[@,[\]\n\r]/.test(name))
      throw new Error('a participant name is 1–40 characters, without @ , [ ] or line breaks');
    if (name.toLowerCase() === HUMAN_NAME.toLowerCase()) throw new Error(`"${name}" is reserved`);
    if (this.participants(roomId).some((p) => p.displayName.toLowerCase() === name.toLowerCase()))
      throw new Error(`there is already a participant called ${name} in this room`);
    if (input.harness !== 'mock')
      assertSafeCwd(this.store.getWorkspace(room.workspaceId)!.rootDir, room.allowOwnFolder);
    const p: Participant = {
      id: randomId(9),
      roomId,
      harness: input.harness,
      displayName: name,
      sessionRef: null,
      nodeId: null,
      yolo: !!input.yolo,
      seenSeq: 0,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        'INSERT INTO room_participants(id, room_id, harness, display_name, session_ref, node_id, yolo, seen_seq, created_at) VALUES (?,?,?,?,NULL,NULL,?,0,?)',
      )
      .run(p.id, roomId, p.harness, name, p.yolo ? 1 : 0, p.createdAt);
    this.changed(room.workspaceId, roomId);
    this.emit(roomId, { type: 'participants' });
    return p;
  }

  removeParticipant(roomId: string, participantId: string): void {
    const room = this.must(roomId);
    this.db
      .prepare('DELETE FROM room_participants WHERE id = ? AND room_id = ?')
      .run(participantId, roomId);
    this.errors.delete(participantId);
    this.changed(room.workspaceId, roomId);
    this.emit(roomId, { type: 'participants' });
  }

  private insert(
    roomId: string,
    m: {
      kind: AuthorKind;
      authorId: string | null;
      authorName: string;
      text: string;
      quiet?: boolean;
    },
  ): RoomMessage {
    const id = randomId(9);
    const at = Date.now();
    const { lastInsertRowid } = this.db
      .prepare(
        'INSERT INTO room_messages(id, room_id, author_kind, author_id, author_name, text, reply_to, created_at) VALUES (?,?,?,?,?,?,NULL,?)',
      )
      .run(id, roomId, m.kind, m.authorId, m.authorName, m.text, at);
    const msg: RoomMessage = {
      id,
      roomId,
      seq: Number(lastInsertRowid),
      authorKind: m.kind,
      authorId: m.authorId,
      authorName: m.authorName,
      text: m.text,
      replyTo: null,
      createdAt: at,
    };
    if (!m.quiet) this.emit(roomId, { type: 'message', message: msg });
    return msg;
  }

  /** Seed a room with an imported conversation: stored as `import` lines, given to each participant once. */
  seed(
    roomId: string,
    conv: { title: string; source: string; turns: { role: string; text: string }[] },
  ): number {
    this.must(roomId);
    this.db.transaction(() => {
      this.insert(roomId, {
        kind: 'import',
        authorId: conv.source,
        authorName: 'Import',
        text: `Imported conversation "${conv.title}" from ${conv.source} (${conv.turns.length} turns).`,
        quiet: true,
      });
      for (const t of conv.turns)
        this.insert(roomId, {
          kind: 'import',
          authorId: conv.source,
          authorName: t.role === 'user' ? 'User' : t.role === 'assistant' ? 'Assistant' : t.role,
          text: t.text,
          quiet: true,
        });
    })();
    this.emit(roomId, { type: 'reload' });
    return conv.turns.length;
  }

  // ---------------------------------------------------------------- orchestration
  /**
   * Post a message and start whoever should answer it. A human message with @mentions goes to those
   * participants only; without one: `all` → everyone in parallel, `mention` → the first participant,
   * `round` → everyone one after another. An agent's post starts only the participants it @mentions.
   */
  post(
    roomId: string,
    author: { kind: 'human' | 'agent'; id: string | null; name: string },
    text: string,
  ): RoomMessage {
    const room = this.must(roomId);
    const msg = this.insert(roomId, {
      kind: author.kind,
      authorId: author.id,
      authorName: author.name,
      text,
    });
    const ps = this.participants(roomId);
    const mentioned = mentionsIn(text, ps);
    const first =
      author.kind === 'agent' || mentioned.length
        ? mentioned
        : room.mode === 'mention'
          ? ps.slice(0, 1)
          : ps;
    const ex: Exchange = { budget: CHAIN_CAP, queued: new Set() };
    let ctrl = this.ctrls.get(roomId);
    if (!ctrl || ctrl.signal.aborted) this.ctrls.set(roomId, (ctrl = new AbortController()));
    const signal = ctrl.signal;
    if (room.mode === 'round' && author.kind === 'human') {
      for (const p of first) ex.queued.add(p.id);
      void (async () => {
        for (const p of first) {
          if (signal.aborted) break;
          await this.schedule(roomId, p.id, ex, signal);
        }
      })();
    } else for (const p of first) void this.schedule(roomId, p.id, ex, signal);
    return msg;
  }

  /** Abort every running turn in the room and drop the queued ones. */
  stop(roomId: string): void {
    this.ctrls.get(roomId)?.abort();
    this.ctrls.delete(roomId);
  }

  private bump(roomId: string, by: number) {
    const n = (this.pending.get(roomId) ?? 0) + by;
    if (n > 0) this.pending.set(roomId, n);
    else this.pending.delete(roomId);
    this.emit(roomId, { type: 'busy', busy: n > 0 });
  }

  private schedule(roomId: string, pid: string, ex: Exchange, signal: AbortSignal): Promise<void> {
    ex.queued.add(pid);
    this.bump(roomId, 1);
    const next = (this.tails.get(pid) ?? Promise.resolve())
      .then(() => this.turn(roomId, pid, ex, signal))
      .catch(() => undefined)
      .finally(() => {
        if (this.tails.get(pid) === next) this.tails.delete(pid);
        this.bump(roomId, -1);
      });
    this.tails.set(pid, next);
    return next;
  }

  /** The prompt for p's next turn: only the lines it has not seen, its own lines left out. */
  promptFor(p: Participant): { prompt: string; seq: number } | null {
    const rows = (
      this.db
        .prepare(
          'SELECT rowid seq, * FROM room_messages WHERE room_id = ? AND rowid > ? ORDER BY rowid',
        )
        .all(p.roomId, p.seenSeq) as Row[]
    ).map(toMessage);
    const seq = rows.at(-1)?.seq ?? p.seenSeq;
    const fresh = rows.filter((m) => !(m.authorKind === 'participant' && m.authorId === p.id));
    if (fresh.length === 0) return null;
    const imports = fresh.filter((m) => m.authorKind === 'import');
    const lines = fresh.filter((m) => m.authorKind !== 'import');
    const parts: string[] = [];
    if (imports.length)
      parts.push(
        `Earlier conversation the human imported into this room (context only):\n${clip(imports.map(line).join('\n'), IMPORT_BUDGET)}`,
      );
    if (lines.length)
      parts.push(
        `New in the room since your last turn:\n${clip(lines.map(line).join('\n'), LINES_BUDGET)}`,
      );
    return { prompt: parts.join('\n\n'), seq };
  }

  private async turn(roomId: string, pid: string, ex: Exchange, signal: AbortSignal) {
    ex.queued.delete(pid);
    if (signal.aborted) return;
    const room = this.get(roomId);
    const p = this.participant(pid);
    const h = p && isHarnessId(p.harness) ? harnesses[p.harness] : undefined;
    if (!room || !p || !h?.runTurn) return;
    const next = this.promptFor(p);
    if (!next) return;
    this.db.prepare('UPDATE room_participants SET seen_seq = ? WHERE id = ?').run(next.seq, pid);
    const replyId = randomId(6);
    let text = '';
    this.working.add(pid);
    this.errors.delete(pid);
    this.emit(roomId, { type: 'start', participantId: pid, replyId });
    let error: string | undefined;
    try {
      const cwd = this.store.getWorkspace(room.workspaceId)!.rootDir;
      if (p.harness !== 'mock') assertSafeCwd(cwd, room.allowOwnFolder);
      const res = await h.runTurn({
        prompt: next.prompt,
        cwd,
        nodeId: p.nodeId ?? undefined,
        sessionId: p.sessionRef,
        yolo: p.yolo,
        allowedTools: getSetting(this.db, 'allowedTools', DEFAULT_ALLOWED_TOOLS),
        appendSystemPrompt: systemPrompt(p, this.participants(roomId)),
        signal,
        onEvent: (e) => {
          if (e.kind !== 'text') return;
          text += e.delta;
          this.emit(roomId, { type: 'delta', participantId: pid, replyId, delta: e.delta });
        },
      });
      recordUsage(this.db, { harness: p.harness, roomId, participantId: pid }, res);
      if (res.sessionId)
        this.db
          .prepare('UPDATE room_participants SET session_ref = ? WHERE id = ?')
          .run(res.sessionId, pid);
      if (!res.ok) error = res.error ?? 'turn failed';
      const said = (res.ok ? res.text || text : text)
        .replace(new RegExp(`^\\s*\\[${escapeRe(p.displayName)}\\]:\\s*`), '')
        .trim();
      if (said) {
        const msg = this.insert(roomId, {
          kind: 'participant',
          authorId: pid,
          authorName: p.displayName,
          text: error ? `${said}\n\n(${signal.aborted ? 'stopped' : 'turn failed'})` : said,
        });
        if (!error) this.chain(roomId, p, msg.text, ex, signal);
      }
    } catch (err) {
      error = String((err as Error).message ?? err);
    } finally {
      this.working.delete(pid);
      if (error) this.errors.set(pid, error.slice(0, 500));
      this.emit(roomId, { type: 'end', participantId: pid, replyId, error: error ?? null });
    }
  }

  /** A reply that @mentions other participants asks them to answer, within the post's chain budget. */
  private chain(
    roomId: string,
    from: Participant,
    text: string,
    ex: Exchange,
    signal: AbortSignal,
  ) {
    for (const t of mentionsIn(text, this.participants(roomId))) {
      if (t.id === from.id || ex.queued.has(t.id)) continue;
      if (ex.budget <= 0) return;
      ex.budget--;
      void this.schedule(roomId, t.id, ex, signal);
    }
  }
}
