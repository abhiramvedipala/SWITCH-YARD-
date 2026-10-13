import { useState, type FormEvent } from 'react';
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { api } from '../lib/api.js';
import type { Task } from '../lib/types.js';
import { useStore } from '../store.js';

const COLUMNS: { status: Task['status']; label: string }[] = [
  { status: 'open', label: 'Open' },
  { status: 'claimed', label: 'In progress' },
  { status: 'done', label: 'Done' },
];

function Card({ task }: { task: Task }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
    data: { task },
  });
  const nodes = useStore((s) => s.nodes);
  const tasks = useStore((s) => s.tasks);
  const notify = useStore((s) => s.notify);
  const readOnly = useStore((s) => s.readOnly);
  const owner = nodes.find((n) => n.id === task.ownerNode);
  const agents = nodes.filter((n) => n.type === 'agent-terminal' || n.type === 'agent-chat');
  const style = transform
    ? { transform: `translate(${transform.x}px, ${transform.y}px)`, zIndex: 10 }
    : undefined;
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`card ${isDragging ? 'dragging' : ''} ${task.blocked && task.status !== 'done' ? 'blocked' : ''}`}
    >
      <div className="card-grip" {...listeners} {...attributes} title="Drag to move">
        <span className="card-title">{task.title}</span>
        <span className="muted small mono">#{task.id}</span>
      </div>
      {task.body && <div className="card-body small">{task.body}</div>}
      <div className="card-meta">
        {task.dependsOn.map((d) => {
          const dep = tasks.find((t) => t.id === d);
          return (
            <span
              key={d}
              className={`badge ${dep?.status === 'done' ? 'badge-ok' : 'badge-wait'}`}
              title={dep ? `depends on: ${dep.title}` : d}
            >
              ⛓ {dep ? dep.title.slice(0, 24) : d}
            </span>
          );
        })}
        {task.blocked && task.status !== 'done' && (
          <span className="badge badge-wait">blocked</span>
        )}
        {owner && <span className="badge">@ {owner.title}</span>}
        {task.createdBy && !owner && (
          <span className="muted small">
            by {nodes.find((n) => n.id === task.createdBy)?.title ?? 'agent'}
          </span>
        )}
      </div>
      {task.result && <div className="card-result small">✓ {task.result}</div>}
      {!readOnly && (
        <div className="card-actions">
          {task.status === 'open' && agents.length > 0 && (
            <select
              value=""
              onChange={(e) => {
                const nodeId = e.target.value;
                if (!nodeId) return;
                api
                  .post(`/api/tasks/${task.id}/assign`, { nodeId })
                  .then(() => notify('Sent as a request to that agent’s inbox'))
                  .catch((err) => notify(String(err.message), 'error'));
              }}
            >
              <option value="">Assign to…</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title}
                </option>
              ))}
            </select>
          )}
          <button
            className="icon-btn"
            title="Delete task"
            onClick={() => confirm('Delete this task?') && api.del(`/api/tasks/${task.id}`)}
          >
            🗑
          </button>
        </div>
      )}
    </div>
  );
}

function Column({
  status,
  label,
  tasks,
}: {
  status: Task['status'];
  label: string;
  tasks: Task[];
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <div ref={setNodeRef} className={`column ${isOver ? 'over' : ''}`}>
      <div className="column-head">
        {label} <span className="muted">{tasks.length}</span>
      </div>
      <div className="column-body">
        {tasks.map((t) => (
          <Card key={t.id} task={t} />
        ))}
        {tasks.length === 0 && <div className="muted small pad">Nothing here.</div>}
      </div>
    </div>
  );
}

export function Board() {
  const tasks = useStore((s) => s.tasks);
  const wsId = useStore((s) => s.wsId);
  const notify = useStore((s) => s.notify);
  const readOnly = useStore((s) => s.readOnly);
  const [title, setTitle] = useState('');
  const [deps, setDeps] = useState<string[]>([]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !wsId) return;
    try {
      await api.post(`/api/workspaces/${wsId}/tasks`, { title: title.trim(), dependsOn: deps });
      setTitle('');
      setDeps([]);
    } catch (err) {
      notify(String((err as Error).message), 'error');
    }
  };

  const onDragEnd = (e: DragEndEvent) => {
    const task = (e.active.data.current as { task: Task } | undefined)?.task;
    const to = e.over?.id as Task['status'] | undefined;
    if (!task || !to || to === task.status) return;
    api
      .patch(`/api/tasks/${task.id}`, { status: to })
      .catch((err) => notify(String(err.message), 'error'));
  };

  return (
    <div className="board">
      {!readOnly && (
        <form className="board-add" onSubmit={add}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="New task title…"
          />
          {tasks.filter((t) => t.status !== 'done').length > 0 && (
            <select
              multiple
              value={deps}
              onChange={(e) => setDeps([...e.target.selectedOptions].map((o) => o.value))}
              title="Depends on (optional, ⌘-click for several)"
              className="deps-select"
            >
              {tasks
                .filter((t) => t.status !== 'done')
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    after: {t.title}
                  </option>
                ))}
            </select>
          )}
          <button className="btn" disabled={!title.trim()}>
            Add task
          </button>
        </form>
      )}
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="columns">
          {COLUMNS.map((c) => (
            <Column
              key={c.status}
              status={c.status}
              label={c.label}
              tasks={tasks.filter((t) => t.status === c.status)}
            />
          ))}
        </div>
      </DndContext>
      <p className="muted small pad">
        Agents see these through list_tasks / claim_task / complete_task. “Assign to…” sends the
        agent a request in its inbox.
      </p>
    </div>
  );
}
