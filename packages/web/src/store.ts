import { create } from 'zustand';
import { api } from './lib/api.js';
import type {
  AttentionItem,
  Detection,
  Run,
  SEdge,
  SNode,
  Settings,
  Task,
  Workspace,
  HarnessId,
} from './lib/types.js';

export interface AgyConfig {
  mcpEntry: boolean;
  hooks: boolean;
  permissions: { bus: boolean; testCommands: boolean; writeDirs: string[] };
}

export type View = 'canvas' | 'board' | 'runs' | 'rooms';
export type Panel = 'none' | 'needs' | 'chat';
export type Modal = 'none' | 'settings' | 'import' | 'workspace' | 'palette' | 'worktree';

interface State {
  remote: boolean;
  readOnly: boolean;
  workspaces: Workspace[];
  wsId: string | null;
  nodes: SNode[];
  edges: SEdge[];
  tasks: Task[];
  runs: Run[];
  attention: AttentionItem[];
  detections: Partial<Record<HarnessId, Detection>>;
  available: HarnessId[];
  /** Harnesses that can run a headless turn (and so can be Room participants), installed or not. */
  drivable: string[];
  /** When set, the import dialog seeds this room instead of opening nodes. */
  seedRoomId: string | null;
  agyConfig: AgyConfig;
  settings: Settings | null;
  view: View;
  panel: Panel;
  modal: Modal;
  focusId: string | null;
  selectedId: string | null;
  toast: { text: string; kind: 'info' | 'error' } | null;

  set: (p: Partial<State>) => void;
  notify: (text: string, kind?: 'info' | 'error') => void;
  loadWorkspaces: () => Promise<void>;
  selectWorkspace: (id: string | null) => Promise<void>;
  loadGraph: () => Promise<void>;
  loadTasks: () => Promise<void>;
  loadRuns: () => Promise<void>;
  loadAttention: () => Promise<void>;
  loadSettings: () => Promise<void>;
  loadHarnesses: (refresh?: boolean) => Promise<void>;
  patchNodeLocal: (id: string, patch: Partial<SNode>) => void;
}

const LAST_WS = 'switchyard_last_ws';

export const useStore = create<State>((set, get) => ({
  remote: false,
  readOnly: false,
  workspaces: [],
  wsId: null,
  nodes: [],
  edges: [],
  tasks: [],
  runs: [],
  attention: [],
  detections: {},
  available: ['mock'],
  drivable: ['mock'],
  seedRoomId: null,
  agyConfig: {
    mcpEntry: false,
    hooks: false,
    permissions: { bus: false, testCommands: false, writeDirs: [] },
  },
  settings: null,
  view: 'canvas',
  panel: 'none',
  modal: 'none',
  focusId: null,
  selectedId: null,
  toast: null,

  set: (p) => set(p),
  notify: (text, kind = 'info') => {
    set({ toast: { text, kind } });
    setTimeout(
      () => {
        if (get().toast?.text === text) set({ toast: null });
      },
      kind === 'error' ? 6000 : 3000,
    );
  },

  loadWorkspaces: async () => {
    const { workspaces } = await api.get<{ workspaces: Workspace[] }>('/api/workspaces');
    set({ workspaces });
    const cur = get().wsId;
    if (!cur || !workspaces.find((w) => w.id === cur)) {
      let last: string | null = null;
      try {
        last = localStorage.getItem(LAST_WS);
      } catch {
        last = null;
      }
      const pick = workspaces.find((w) => w.id === last) ?? workspaces[0];
      await get().selectWorkspace(pick?.id ?? null);
    }
  },

  selectWorkspace: async (id) => {
    set({ wsId: id, nodes: [], edges: [], tasks: [], runs: [], focusId: null, selectedId: null });
    try {
      if (id) localStorage.setItem(LAST_WS, id);
    } catch {
      // ignore
    }
    if (!id) return;
    await Promise.all([
      get().loadGraph(),
      get().loadTasks(),
      get().loadRuns(),
      get().loadAttention(),
    ]);
  },

  loadGraph: async () => {
    const id = get().wsId;
    if (!id) return;
    const g = await api.get<{ nodes: SNode[]; edges: SEdge[] }>(`/api/workspaces/${id}/graph`);
    if (get().wsId === id) set({ nodes: g.nodes, edges: g.edges });
  },
  loadTasks: async () => {
    const id = get().wsId;
    if (!id) return;
    const { tasks } = await api.get<{ tasks: Task[] }>(`/api/workspaces/${id}/tasks`);
    if (get().wsId === id) set({ tasks });
  },
  loadRuns: async () => {
    const id = get().wsId;
    if (!id) return;
    const { runs } = await api.get<{ runs: Run[] }>(`/api/workspaces/${id}/runs`);
    if (get().wsId === id) set({ runs });
  },
  loadAttention: async () => {
    const { items } = await api.get<{ items: AttentionItem[] }>('/api/attention');
    set({ attention: items });
  },
  loadSettings: async () => {
    set({ settings: await api.get<Settings>('/api/settings') });
  },
  loadHarnesses: async (refresh = false) => {
    const r = await api.get<{
      detections: Partial<Record<HarnessId, Detection>>;
      available: HarnessId[];
      drivable?: string[];
      agy: AgyConfig;
    }>(`/api/harnesses${refresh ? '?refresh=1' : ''}`);
    set({
      detections: r.detections,
      available: r.available,
      drivable: r.drivable ?? get().drivable,
      agyConfig: r.agy,
    });
  },
  patchNodeLocal: (id, patch) =>
    set({ nodes: get().nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }),
}));

/** Debounced re-fetch so a burst of change events costs one request. */
const timers = new Map<string, ReturnType<typeof setTimeout>>();
export function refetch(kind: 'graph' | 'tasks' | 'runs' | 'attention', ms = 120): void {
  const prev = timers.get(kind);
  if (prev) clearTimeout(prev);
  timers.set(
    kind,
    setTimeout(() => {
      timers.delete(kind);
      const s = useStore.getState();
      const fn = {
        graph: s.loadGraph,
        tasks: s.loadTasks,
        runs: s.loadRuns,
        attention: s.loadAttention,
      }[kind];
      fn().catch(() => undefined);
    }, ms),
  );
}

const API_LABELS: Record<string, string> = {
  'api-anthropic': 'Claude API',
  'api-openai': 'OpenAI API',
  'api-gemini': 'Gemini API',
};

export function harnessLabel(h: string | null | undefined): string {
  if (h && API_LABELS[h]) return API_LABELS[h];
  return h === 'claude'
    ? 'Claude Code'
    : h === 'agy'
      ? 'Antigravity'
      : h === 'codex'
        ? 'Codex (ChatGPT)'
        : h === 'mock'
          ? 'Mock'
          : h === 'shell'
            ? 'Shell'
            : h === 'claude-desktop'
              ? 'Claude Desktop'
              : (h ?? '');
}
