import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { Store, NodeRec, NodeType } from '../store.js';
import type { Bus } from '../bus/service.js';
import type { Capabilities } from '../auth/capability.js';
import { ptys } from '../pty/manager.js';
import { getHarness, isHarnessId } from '../harness/index.js';
import { closeAgySessions } from '../harness/agy.js';
import { customSpec, customTitle } from '../harness/custom.js';
import { hub } from '../events.js';
import { assertSafeCwd } from '../paths.js';

const PTY_TYPES: NodeType[] = ['terminal', 'agent-terminal'];
export const DEFAULT_SIZE: Record<NodeType, [number, number]> = {
  terminal: [560, 360],
  'agent-terminal': [640, 420],
  'agent-chat': [460, 520],
  note: [280, 220],
  doc: [460, 420],
  browser: [640, 460],
  files: [720, 480],
  external: [260, 130],
};

export interface CreateNodeInput {
  type: NodeType;
  harness?: string;
  title?: string;
  cwd?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  yolo?: boolean;
  data?: Record<string, unknown>;
  resumeRef?: string | null;
  sessionRef?: string | null;
  allowOwnFolder?: boolean;
  /** Terminal agents only: the prompt the session starts with. */
  initialPrompt?: string;
}

export class NodeService {
  constructor(
    private store: Store,
    private bus: Bus,
    private caps: Capabilities,
  ) {
    ptys.onExit((id) => {
      if (!this.store.getNode(id)) return;
      // A dead process keeps nothing: the next start() issues fresh credentials.
      this.caps.revoke(id);
      this.bus.setStatus(id, 'exited');
    });
  }

  isPtyNode(n: NodeRec): boolean {
    return PTY_TYPES.includes(n.type);
  }

  resolveCwd(wsRoot: string, cwd?: string | null): string {
    const c = cwd ? (isAbsolute(cwd) ? cwd : resolve(wsRoot, cwd)) : wsRoot;
    if (!existsSync(c) || !statSync(c).isDirectory())
      throw new Error(`folder does not exist: ${c}`);
    return c;
  }

  create(workspaceId: string, input: CreateNodeInput): NodeRec {
    const ws = this.store.getWorkspace(workspaceId);
    if (!ws) throw new Error('unknown workspace');
    const type = input.type;
    if (!DEFAULT_SIZE[type]) throw new Error(`unknown node type ${type}`);
    let harness: string | null = null;
    if (type === 'terminal') harness = 'shell';
    if (type === 'agent-terminal' || type === 'agent-chat') {
      const h = isHarnessId(input.harness) ? getHarness(input.harness) : null;
      // Chat-only harnesses (API-key models) can back a chat node, never a terminal.
      const chatOnly = type === 'agent-chat' && !!h?.runTurn;
      if (!h || (!h.isAgent && !chatOnly)) {
        throw new Error('agent nodes need a harness: claude, agy, codex, custom or mock');
      }
      if (type === 'agent-chat' && !h.runTurn) throw new Error('harness cannot be driven');
      if (h.id === 'custom') {
        const { preset } = customSpec(input.data); // throws when there is no command to run
        if (type === 'agent-chat' && !preset.turn)
          throw new Error(
            `${preset.label} has no documented non-interactive mode; add it as a terminal agent instead`,
          );
      }
      harness = h.id;
    }
    const cwd =
      PTY_TYPES.includes(type) || type === 'agent-chat'
        ? this.resolveCwd(ws.rootDir, input.cwd)
        : null;
    // Chat-only harnesses never touch files, so the app's-own-folder guard does not apply to them.
    if (cwd && harness && harness !== 'mock' && getHarness(harness).isAgent) {
      assertSafeCwd(cwd, input.allowOwnFolder);
    }
    const data = { ...input.data };
    if (type === 'files') {
      // A Files block edits the workspace folder, so it gets the same own-folder confirmation as an agent.
      // The confirmation is remembered on the node: PUT /api/fs/write checks it before writing.
      assertSafeCwd(ws.rootDir, input.allowOwnFolder);
      if (input.allowOwnFolder) data.allowOwnFolder = true;
    }
    const [dw, dh] = DEFAULT_SIZE[type];
    const existing = this.store.listNodes(workspaceId).filter((n) => !n.data.project);
    const count = existing.length;
    const slot =
      input.x === undefined || input.y === undefined
        ? freeSlot(existing, input.w ?? dw, input.h ?? dh)
        : null;
    const node = this.store.insertNode({
      workspaceId,
      type,
      harness,
      title: input.title?.trim() || defaultTitle(type, harness, count, input.data),
      cwd,
      x: input.x ?? slot!.x,
      y: input.y ?? slot!.y,
      w: input.w ?? dw,
      h: input.h ?? dh,
      state: PTY_TYPES.includes(type) ? 'starting' : 'idle',
      sessionRef: input.sessionRef ?? null,
      yolo: !!input.yolo,
      data,
      summary: '',
    });
    if (harness && getHarness(harness).isAgent) this.caps.issue(node.id, workspaceId, cwd);
    if (PTY_TYPES.includes(type))
      this.start(node.id, {
        resumeRef: input.resumeRef ?? null,
        initialPrompt: input.initialPrompt,
      });
    return this.store.getNode(node.id)!;
  }

  start(
    nodeId: string,
    opts: { resumeRef?: string | null; initialPrompt?: string; cols?: number; rows?: number } = {},
  ): void {
    const node = this.store.getNode(nodeId);
    if (!node || !this.isPtyNode(node)) throw new Error('not a terminal node');
    const ws = this.store.getWorkspace(node.workspaceId)!;
    const cwd = this.resolveCwd(ws.rootDir, node.cwd);
    const h = getHarness(node.harness);
    if (h.isAgent) this.caps.issue(node.id, node.workspaceId, cwd);
    const launch = h.terminalLaunch({
      node,
      workspace: ws,
      cwd,
      resumeRef: opts.resumeRef ?? null,
      initialPrompt: opts.initialPrompt,
      hookUrl: h.isAgent ? this.caps.hookUrl(node.id) : undefined,
    });
    ptys.spawn(node.id, { ...launch, cols: opts.cols, rows: opts.rows });
    this.bus.setStatus(node.id, h.isAgent ? 'idle' : 'idle');
    hub.emitHub({ t: 'change', entity: 'nodes', workspaceId: node.workspaceId, id: node.id });
  }

  /** Restart a dead terminal; agent terminals resume their last known session when we have one. */
  restart(nodeId: string, opts: { fresh?: boolean } = {}): void {
    const node = this.store.getNode(nodeId);
    if (!node) throw new Error('unknown node');
    const resumeRef = !opts.fresh && node.type === 'agent-terminal' ? node.sessionRef : null;
    this.onReset(nodeId);
    this.start(nodeId, { resumeRef });
  }

  /** Called when a node's process is replaced or stopped, so anything waiting on it can be dropped. */
  onReset: (nodeId: string) => void = () => {};

  stop(nodeId: string): void {
    this.onReset(nodeId);
    ptys.kill(nodeId); // drops the session first, so the exit listener above does not fire for it
    const node = this.store.getNode(nodeId);
    if (!node) return;
    if (this.isPtyNode(node)) this.caps.revoke(nodeId); // chat nodes keep theirs: nothing restarts them
    this.bus.setStatus(nodeId, 'exited');
  }

  remove(nodeId: string): void {
    this.onReset(nodeId);
    ptys.kill(nodeId);
    closeAgySessions(nodeId);
    this.caps.revoke(nodeId);
    this.store.deleteNode(nodeId);
  }

  /**
   * After a core restart no PTY survives: mark terminal nodes exited and revoke their caps (restart reissues);
   * driven chat nodes have no process to restart, so their caps stay valid.
   */
  onBoot(): void {
    const all = this.store.allNodes();
    const isAgent = (n: NodeRec) => isHarnessId(n.harness) && getHarness(n.harness).isAgent;
    this.caps.restore(all.filter((n) => isAgent(n) && !this.isPtyNode(n)).map((n) => n.id));
    for (const n of all) {
      if (this.isPtyNode(n) && !ptys.isAlive(n.id)) {
        this.store.updateNode(n.id, { state: 'exited' }, { silent: true });
        if (isAgent(n)) this.caps.revoke(n.id);
      }
      if (n.type === 'agent-chat' && n.state === 'working')
        this.store.updateNode(n.id, { state: 'idle' }, { silent: true });
      // Claude Desktop's identity: rotate on every boot, so a copy of an older run file stops working.
      // Its bus-mcp re-reads the same path on 401 and keeps going.
      if (n.type === 'external') this.caps.issue(n.id, n.workspaceId);
    }
  }
}

/** First grid slot (left-to-right, top-to-bottom) where a w×h node overlaps nothing on the canvas. */
export function freeSlot(nodes: NodeRec[], w: number, h: number): { x: number; y: number } {
  const GAP = 40;
  const COL = 680;
  const ROW = 480;
  const hits = (x: number, y: number) =>
    nodes.some(
      (n) => x < n.x + n.w + GAP && x + w + GAP > n.x && y < n.y + n.h + GAP && y + h + GAP > n.y,
    );
  for (let i = 0; i < 80; i++) {
    const x = 60 + (i % 4) * COL;
    const y = 60 + Math.floor(i / 4) * ROW;
    if (!hits(x, y)) return { x, y };
  }
  return { x: 60 + nodes.length * 30, y: 60 + nodes.length * 30 };
}

function defaultTitle(
  type: NodeType,
  harness: string | null,
  count: number,
  data?: Record<string, unknown>,
): string {
  const n = count + 1;
  switch (type) {
    case 'terminal':
      return `Terminal ${n}`;
    case 'agent-terminal':
    case 'agent-chat':
      return `${harness === 'claude' ? 'Claude' : harness === 'agy' ? 'Antigravity' : harness === 'codex' ? 'Codex' : harness === 'mock' ? 'Mock' : harness === 'custom' ? customTitle(data) : getHarness(harness).label} ${n}`;
    case 'note':
      return 'Note';
    case 'doc':
      return 'Doc';
    case 'browser':
      return 'Preview';
    case 'files':
      return 'Files';
    case 'external':
      return 'Claude Desktop';
  }
}
