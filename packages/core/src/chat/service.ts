import { recordUsage } from '../usage/index.js';
import type { Store, NodeRec } from '../store.js';
import type { Bus } from '../bus/service.js';
import { getHarness } from '../harness/index.js';
import { coordinationBlurb } from '../harness/util.js';
import { hub } from '../events.js';
import { randomId } from '../auth/token.js';
import { getSetting } from '../db/index.js';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  tools?: { name: string; input?: unknown; output?: string }[];
  at: number;
  error?: string;
}

const MAX_MESSAGES = 300;

export const DEFAULT_ALLOWED_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Bash(git diff *)',
  'Bash(git status *)',
  'Bash(git log *)',
  'Bash(ls *)',
  'Bash(python3 -m pytest *)',
  'Bash(pytest *)',
  'Bash(npm test *)',
  'Bash(npm run test *)',
  'mcp__switchyard',
];

/** Drives agent-chat nodes (and the workspace's Project Chat) one headless turn at a time. */
export class ChatService {
  private running = new Map<string, AbortController>();

  constructor(
    private store: Store,
    private bus: Bus,
  ) {}

  isBusy(nodeId: string): boolean {
    return this.running.has(nodeId);
  }

  private messages(n: NodeRec): ChatMessage[] {
    return (Array.isArray(n.data.messages) ? n.data.messages : []) as ChatMessage[];
  }

  private save(nodeId: string, msgs: ChatMessage[], extra: Partial<NodeRec> = {}): void {
    const n = this.store.getNode(nodeId);
    if (!n) return;
    this.store.updateNode(
      nodeId,
      { ...extra, data: { ...n.data, messages: msgs.slice(-MAX_MESSAGES) } },
      { silent: true },
    );
  }

  /** Project Chat lives in a hidden agent-chat node, one per workspace. */
  projectChatNode(workspaceId: string, harness?: string): NodeRec {
    const existing = this.store
      .listNodes(workspaceId)
      .find((n) => n.type === 'agent-chat' && n.data.project === true);
    if (existing) {
      if (harness && existing.harness !== harness) {
        return this.store.updateNode(existing.id, { harness, sessionRef: null })!;
      }
      return existing;
    }
    const ws = this.store.getWorkspace(workspaceId)!;
    return this.store.insertNode({
      workspaceId,
      type: 'agent-chat',
      harness: harness ?? getSetting(this.store.db, 'projectChatHarness', 'agy'),
      title: 'Ask Switchyard',
      cwd: ws.rootDir,
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      state: 'idle',
      sessionRef: null,
      yolo: false,
      data: { project: true, messages: [] },
      summary: '',
    });
  }

  private workspaceSnapshot(workspaceId: string): string {
    const nodes = this.store.listNodes(workspaceId).filter((n) => !n.data.project);
    const edges = this.store.listEdges(workspaceId);
    const tasks = this.bus.listTasks(workspaceId);
    const title = (id: string) => nodes.find((n) => n.id === id)?.title ?? id;
    const lines = [
      'Current Switchyard workspace snapshot (read-only context, refreshed each turn):',
      'Nodes:',
      ...nodes.map(
        (n) =>
          `- ${n.title} [${n.type}${n.harness ? `/${n.harness}` : ''}] state=${n.state}${n.summary ? ` summary="${n.summary}"` : ''}`,
      ),
      'Connections:',
      ...edges.map((e) => `- ${title(e.from)} <-> ${title(e.to)}`),
      'Tasks:',
      ...tasks.map(
        (t) =>
          `- [${t.status}${t.blocked ? ', blocked' : ''}] ${t.title}${t.ownerNode ? ` (owner: ${title(t.ownerNode)})` : ''}`,
      ),
    ];
    return lines.join('\n');
  }

  async send(nodeId: string, text: string): Promise<{ ok: boolean; error?: string }> {
    const node = this.store.getNode(nodeId);
    if (!node || node.type !== 'agent-chat') throw new Error('not a chat node');
    if (this.running.has(nodeId)) throw new Error('this agent is still answering');
    const h = getHarness(node.harness);
    if (!h.runTurn) throw new Error('harness cannot be driven');
    const msgs = this.messages(node);
    const userMsg: ChatMessage = { id: randomId(6), role: 'user', text, at: Date.now() };
    const reply: ChatMessage = {
      id: randomId(6),
      role: 'assistant',
      text: '',
      tools: [],
      at: Date.now(),
    };
    msgs.push(userMsg, reply);
    this.save(nodeId, msgs);
    const ctrl = new AbortController();
    this.running.set(nodeId, ctrl);
    this.bus.setStatus(nodeId, 'working');
    hub.emitHub({
      t: 'chat',
      nodeId,
      event: { type: 'start', message: userMsg, replyId: reply.id },
    });
    const isProject = node.data.project === true;
    const prompt = isProject
      ? `${this.workspaceSnapshot(node.workspaceId)}\n\n---\n\nUser: ${text}`
      : text;
    const system = isProject
      ? 'You are "Ask Switchyard", the assistant for a local workspace where several coding agents run side by side. Answer questions about the workspace and the code in it. Be concise.'
      : coordinationBlurb(node.id, node.title);
    let lastFlush = 0;
    try {
      const res = await h.runTurn({
        prompt,
        cwd: node.cwd ?? this.store.getWorkspace(node.workspaceId)!.rootDir,
        nodeId: isProject ? undefined : node.id,
        sessionId: node.sessionRef,
        yolo: node.yolo,
        allowedTools: getSetting(this.store.db, 'allowedTools', DEFAULT_ALLOWED_TOOLS),
        appendSystemPrompt: system,
        signal: ctrl.signal,
        onEvent: (e) => {
          if (e.kind === 'text') {
            reply.text += e.delta;
            hub.emitHub({
              t: 'chat',
              nodeId,
              event: { type: 'delta', replyId: reply.id, delta: e.delta },
            });
          } else if (e.kind === 'tool') {
            reply.tools!.push({ name: e.name, input: e.input, output: e.output });
            hub.emitHub({
              t: 'chat',
              nodeId,
              event: {
                type: 'tool',
                replyId: reply.id,
                tool: { name: e.name, output: e.output?.slice(0, 500) },
              },
            });
          } else if (e.kind === 'status' && e.state === 'needs_input') {
            this.bus.setStatus(nodeId, 'needs_input');
          }
          if (Date.now() - lastFlush > 2000) {
            lastFlush = Date.now();
            this.save(nodeId, msgs);
          }
        },
      });
      recordUsage(this.store.db, { harness: node.harness ?? 'unknown', nodeId: isProject ? null : nodeId }, res);
      if (!reply.text && res.text) reply.text = res.text;
      if (!res.ok) reply.error = res.error ?? 'turn failed';
      this.save(nodeId, msgs, { sessionRef: res.sessionId ?? node.sessionRef });
      return { ok: res.ok, error: res.error };
    } catch (err) {
      reply.error = String((err as Error).message ?? err);
      this.save(nodeId, msgs);
      return { ok: false, error: reply.error };
    } finally {
      this.running.delete(nodeId);
      this.bus.setStatus(nodeId, 'idle');
      hub.emitHub({ t: 'chat', nodeId, event: { type: 'end', replyId: reply.id } });
      hub.emitHub({ t: 'change', entity: 'nodes', workspaceId: node.workspaceId, id: nodeId });
    }
  }

  stop(nodeId: string): void {
    this.running.get(nodeId)?.abort();
  }

  clear(nodeId: string): void {
    const n = this.store.getNode(nodeId);
    if (!n) return;
    this.store.updateNode(nodeId, { sessionRef: null, data: { ...n.data, messages: [] } });
  }
}
