import type { Db } from './db/index.js';
import { randomId } from './auth/token.js';
import { hub } from './events.js';

export type NodeType =
  | 'terminal'
  | 'agent-terminal'
  | 'agent-chat'
  | 'note'
  | 'doc'
  | 'browser'
  /** Claude Desktop's identity: an agent Switchyard did not start (no PTY, no driven turns). */
  | 'external';

export type NodeState = 'working' | 'idle' | 'needs_input' | 'exited' | 'starting' | 'external';

export interface Workspace {
  id: string;
  name: string;
  rootDir: string;
  createdAt: number;
}

export interface NodeRec {
  id: string;
  workspaceId: string;
  type: NodeType;
  harness: string | null;
  title: string;
  cwd: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  state: NodeState;
  sessionRef: string | null;
  yolo: boolean;
  data: Record<string, unknown>;
  summary: string;
  createdAt: number;
}

export interface EdgeRec {
  id: string;
  workspaceId: string;
  from: string;
  to: string;
  kind: string;
}

interface NodeRow {
  id: string;
  workspace_id: string;
  type: NodeType;
  harness: string | null;
  title: string;
  cwd: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  state: NodeState;
  session_ref: string | null;
  yolo: number;
  data_json: string;
  summary: string;
  created_at: number;
}

function toNode(r: NodeRow): NodeRec {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(r.data_json) as Record<string, unknown>;
  } catch {
    data = {};
  }
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    type: r.type,
    harness: r.harness,
    title: r.title,
    cwd: r.cwd,
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
    state: r.state,
    sessionRef: r.session_ref,
    yolo: r.yolo === 1,
    data,
    summary: r.summary,
    createdAt: r.created_at,
  };
}

/** The few columns the attention feed needs. Skips data_json (chat nodes keep whole transcripts there). */
export interface NodeBrief {
  id: string;
  workspaceId: string;
  type: NodeType;
  title: string;
  state: NodeState;
}

export class Store {
  constructor(public db: Db) {}

  // ---- workspaces
  listWorkspaces(): Workspace[] {
    return (
      this.db.prepare('SELECT * FROM workspaces ORDER BY created_at').all() as {
        id: string;
        name: string;
        root_dir: string;
        created_at: number;
      }[]
    ).map((r) => ({ id: r.id, name: r.name, rootDir: r.root_dir, createdAt: r.created_at }));
  }

  getWorkspace(id: string): Workspace | undefined {
    return this.listWorkspaces().find((w) => w.id === id);
  }

  createWorkspace(name: string, rootDir: string): Workspace {
    const ws = { id: randomId(9), name, rootDir, createdAt: Date.now() };
    this.db
      .prepare('INSERT INTO workspaces(id, name, root_dir, created_at) VALUES (?,?,?,?)')
      .run(ws.id, ws.name, ws.rootDir, ws.createdAt);
    hub.emitHub({ t: 'change', entity: 'workspaces' });
    return ws;
  }

  updateWorkspace(id: string, patch: { name?: string; rootDir?: string }): void {
    if (patch.name !== undefined)
      this.db.prepare('UPDATE workspaces SET name=? WHERE id=?').run(patch.name, id);
    if (patch.rootDir !== undefined)
      this.db.prepare('UPDATE workspaces SET root_dir=? WHERE id=?').run(patch.rootDir, id);
    hub.emitHub({ t: 'change', entity: 'workspaces' });
  }

  deleteWorkspace(id: string): void {
    this.db.prepare('DELETE FROM workspaces WHERE id=?').run(id);
    hub.emitHub({ t: 'change', entity: 'workspaces' });
  }

  // ---- nodes
  listNodes(workspaceId: string): NodeRec[] {
    return (
      this.db
        .prepare('SELECT * FROM nodes WHERE workspace_id=? ORDER BY created_at')
        .all(workspaceId) as NodeRow[]
    ).map(toNode);
  }

  listNodeBriefs(workspaceId?: string): NodeBrief[] {
    const sql = `SELECT id, workspace_id, type, title, state FROM nodes${workspaceId ? ' WHERE workspace_id=?' : ''} ORDER BY created_at`;
    const rows = (
      workspaceId ? this.db.prepare(sql).all(workspaceId) : this.db.prepare(sql).all()
    ) as { id: string; workspace_id: string; type: NodeType; title: string; state: NodeState }[];
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      type: r.type,
      title: r.title,
      state: r.state,
    }));
  }

  allNodes(): NodeRec[] {
    return (this.db.prepare('SELECT * FROM nodes').all() as NodeRow[]).map(toNode);
  }

  getNode(id: string): NodeRec | undefined {
    const r = this.db.prepare('SELECT * FROM nodes WHERE id=?').get(id) as NodeRow | undefined;
    return r ? toNode(r) : undefined;
  }

  insertNode(n: Omit<NodeRec, 'id' | 'createdAt'> & { id?: string }): NodeRec {
    const id = n.id ?? randomId(9);
    const createdAt = Date.now();
    this.db
      .prepare(
        `INSERT INTO nodes(id, workspace_id, type, harness, title, cwd, x, y, w, h, state, session_ref, yolo, data_json, summary, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        n.workspaceId,
        n.type,
        n.harness,
        n.title,
        n.cwd,
        n.x,
        n.y,
        n.w,
        n.h,
        n.state,
        n.sessionRef,
        n.yolo ? 1 : 0,
        JSON.stringify(n.data ?? {}),
        n.summary ?? '',
        createdAt,
      );
    hub.emitHub({ t: 'change', entity: 'nodes', workspaceId: n.workspaceId, id });
    return this.getNode(id)!;
  }

  updateNode(
    id: string,
    patch: Partial<
      Pick<
        NodeRec,
        | 'title'
        | 'x'
        | 'y'
        | 'w'
        | 'h'
        | 'state'
        | 'sessionRef'
        | 'yolo'
        | 'data'
        | 'summary'
        | 'cwd'
        | 'harness'
      >
    >,
    opts: { silent?: boolean } = {},
  ): NodeRec | undefined {
    const cur = this.getNode(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch };
    this.db
      .prepare(
        `UPDATE nodes SET title=?, x=?, y=?, w=?, h=?, state=?, session_ref=?, yolo=?, data_json=?, summary=?, cwd=?, harness=? WHERE id=?`,
      )
      .run(
        next.title,
        next.x,
        next.y,
        next.w,
        next.h,
        next.state,
        next.sessionRef,
        next.yolo ? 1 : 0,
        JSON.stringify(next.data ?? {}),
        next.summary,
        next.cwd,
        next.harness,
        id,
      );
    if (!opts.silent)
      hub.emitHub({ t: 'change', entity: 'nodes', workspaceId: cur.workspaceId, id });
    return next;
  }

  deleteNode(id: string): void {
    const cur = this.getNode(id);
    this.db.prepare('DELETE FROM nodes WHERE id=?').run(id);
    if (cur) hub.emitHub({ t: 'change', entity: 'nodes', workspaceId: cur.workspaceId, id });
  }

  // ---- edges
  listEdges(workspaceId: string): EdgeRec[] {
    return (
      this.db.prepare('SELECT * FROM edges WHERE workspace_id=?').all(workspaceId) as {
        id: string;
        workspace_id: string;
        from_node: string;
        to_node: string;
        kind: string;
      }[]
    ).map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      from: r.from_node,
      to: r.to_node,
      kind: r.kind,
    }));
  }

  createEdge(workspaceId: string, from: string, to: string, kind = 'link'): EdgeRec {
    if (from === to) throw new Error('cannot connect a node to itself');
    const existing = this.listEdges(workspaceId).find(
      (e) => (e.from === from && e.to === to) || (e.from === to && e.to === from),
    );
    if (existing) return existing;
    const a = this.getNode(from);
    const b = this.getNode(to);
    if (!a || !b || a.workspaceId !== workspaceId || b.workspaceId !== workspaceId) {
      throw new Error('both nodes must exist in this workspace');
    }
    const e = { id: randomId(9), workspaceId, from, to, kind };
    this.db
      .prepare('INSERT INTO edges(id, workspace_id, from_node, to_node, kind) VALUES (?,?,?,?,?)')
      .run(e.id, workspaceId, from, to, kind);
    hub.emitHub({ t: 'change', entity: 'edges', workspaceId });
    return e;
  }

  deleteEdge(id: string): void {
    const row = this.db.prepare('SELECT workspace_id FROM edges WHERE id=?').get(id) as
      { workspace_id: string } | undefined;
    this.db.prepare('DELETE FROM edges WHERE id=?').run(id);
    if (row) hub.emitHub({ t: 'change', entity: 'edges', workspaceId: row.workspace_id });
  }

  /** Nodes sharing an edge with nodeId, in either direction. Edges are the only scoping rule for the bus. */
  connectedNodeIds(nodeId: string): string[] {
    const rows = this.db
      .prepare('SELECT from_node, to_node FROM edges WHERE from_node=? OR to_node=?')
      .all(nodeId, nodeId) as { from_node: string; to_node: string }[];
    const ids = new Set<string>();
    for (const r of rows) ids.add(r.from_node === nodeId ? r.to_node : r.from_node);
    return [...ids];
  }

  areConnected(a: string, b: string): boolean {
    return this.connectedNodeIds(a).includes(b);
  }
}
