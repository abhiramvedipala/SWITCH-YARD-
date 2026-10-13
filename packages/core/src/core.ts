import { openDb, type Db } from './db/index.js';
import { Store } from './store.js';
import { Bus } from './bus/service.js';
import { Capabilities } from './auth/capability.js';
import { NodeService } from './nodes/service.js';
import { StatusMonitor } from './status/monitor.js';
import { ChatService } from './chat/service.js';
import { RunEngine } from './runs/engine.js';
import { harnesses } from './harness/index.js';
import type { Detection, HarnessId } from './harness/types.js';

export interface Core {
  db: Db;
  store: Store;
  bus: Bus;
  caps: Capabilities;
  nodes: NodeService;
  monitor: StatusMonitor;
  chat: ChatService;
  runs: RunEngine;
  coreUrl: string;
  detections: Partial<Record<HarnessId, Detection>>;
  refreshDetections(): Promise<Partial<Record<HarnessId, Detection>>>;
}

export function createCore(opts: { dbPath?: string; coreUrl: string }): Core {
  const db = openDb(opts.dbPath);
  const store = new Store(db);
  const bus = new Bus(store);
  const caps = new Capabilities(opts.coreUrl);
  const nodes = new NodeService(store, bus, caps);
  const monitor = new StatusMonitor(store, bus);
  const chat = new ChatService(store, bus);
  const runs = new RunEngine(store);
  const core: Core = {
    db,
    store,
    bus,
    caps,
    nodes,
    monitor,
    chat,
    runs,
    coreUrl: opts.coreUrl,
    detections: {},
    async refreshDetections() {
      const entries = await Promise.all(
        (Object.keys(harnesses) as HarnessId[]).map(
          async (id) => [id, await harnesses[id].detect()] as const,
        ),
      );
      core.detections = Object.fromEntries(entries);
      runs.available = entries
        .filter(([id, d]) => d.installed && harnesses[id].runTurn)
        .map(([id]) => id);
      return core.detections;
    },
  };
  nodes.onBoot();
  runs.onBoot();
  return core;
}
