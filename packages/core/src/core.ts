import { openDb, getSetting, type Db } from './db/index.js';
import { Store } from './store.js';
import { Bus } from './bus/service.js';
import { Capabilities } from './auth/capability.js';
import { NodeService } from './nodes/service.js';
import { StatusMonitor } from './status/monitor.js';
import { MacNotifier } from './status/notify.js';
import { HookRouter } from './bus/hooks.js';
import { PermissionBroker } from './status/permissions.js';
import { ChatService } from './chat/service.js';
import { RunEngine } from './runs/engine.js';
import { RoomService } from './rooms/service.js';
import { harnesses } from './harness/index.js';
import { bindApiHistory } from './harness/api.js';
import type { Detection, HarnessId } from './harness/types.js';

export interface Core {
  db: Db;
  store: Store;
  bus: Bus;
  caps: Capabilities;
  nodes: NodeService;
  monitor: StatusMonitor;
  /** Inert until the server entry point calls start(), so tests never post a real notification. */
  notifier: MacNotifier;
  hooks: HookRouter;
  permissions: PermissionBroker;
  chat: ChatService;
  runs: RunEngine;
  rooms: RoomService;
  coreUrl: string;
  detections: Partial<Record<HarnessId, Detection>>;
  refreshDetections(): Promise<Partial<Record<HarnessId, Detection>>>;
}

export function createCore(opts: { dbPath?: string; coreUrl: string }): Core {
  const db = openDb(opts.dbPath);
  bindApiHistory(db);
  const store = new Store(db);
  const bus = new Bus(store);
  const caps = new Capabilities(opts.coreUrl);
  const nodes = new NodeService(store, bus, caps);
  const monitor = new StatusMonitor(store, bus);
  const permissions = new PermissionBroker();
  monitor.permissions = permissions;
  nodes.onReset = (id) => permissions.cancelNode(id);
  const hooks = new HookRouter(store, bus, monitor, permissions);
  const chat = new ChatService(store, bus);
  const runs = new RunEngine(store);
  const rooms = new RoomService(store);
  const notifier = new MacNotifier({
    attention: () => monitor.attention(),
    enabled: () => getSetting<unknown>(db, 'macNotifications', false) === true,
  });
  const core: Core = {
    db,
    store,
    bus,
    caps,
    nodes,
    monitor,
    notifier,
    hooks,
    permissions,
    chat,
    runs,
    rooms,
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
        // Runs need agents that can edit files; chat-only API harnesses and per-node-configured ones stay out.
        .filter(
          ([id, d]) =>
            d.installed &&
            harnesses[id].runTurn &&
            harnesses[id].isAgent &&
            !harnesses[id].perNodeConfig,
        )
        .map(([id]) => id);
      return core.detections;
    },
  };
  nodes.onBoot();
  runs.onBoot();
  return core;
}
