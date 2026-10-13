import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api.js';
import { socket } from '../lib/ws.js';
import type { HarnessId, Run, RunStep } from '../lib/types.js';
import { harnessLabel, useStore } from '../store.js';
import { timeAgo } from '../components/bits.js';

const DRIVABLE: HarnessId[] = ['claude', 'agy', 'mock'];

function HarnessSelect({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: HarnessId) => void;
  disabled?: boolean;
}) {
  const available = useStore((s) => s.available);
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as HarnessId)}
      disabled={disabled}
    >
      {DRIVABLE.map((h) => (
        <option key={h} value={h} disabled={!available.includes(h) && h !== 'mock'}>
          {harnessLabel(h)}
          {!available.includes(h) && h !== 'mock' ? ' (not installed)' : ''}
        </option>
      ))}
    </select>
  );
}

function NewRun({ onCreated }: { onCreated: (id: string) => void }) {
  const wsId = useStore((s) => s.wsId);
  const settings = useStore((s) => s.settings);
  const available = useStore((s) => s.available);
  const notify = useStore((s) => s.notify);
  const [goal, setGoal] = useState('');
  const [location, setLocation] = useState<'scratch' | 'workspace'>('scratch');
  const pick = (h: HarnessId | undefined, fallback: HarnessId) =>
    h && available.includes(h) ? h : (available.find((a) => a !== 'mock') ?? fallback);
  const [planner, setPlanner] = useState<HarnessId>(pick('claude', 'mock'));
  const [builder, setBuilder] = useState<HarnessId>(pick(settings?.defaultBuilder, 'mock'));
  const [reviewer, setReviewer] = useState<HarnessId>(pick(settings?.defaultReviewer, 'mock'));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!goal.trim() || !wsId) return;
    try {
      const run = await api.post<Run>(`/api/workspaces/${wsId}/runs`, {
        goal: goal.trim(),
        location,
        planner,
        builder,
        reviewer,
      });
      setGoal('');
      onCreated(run.id);
    } catch (err) {
      notify(String((err as Error).message), 'error');
    }
  };
  return (
    <form className="new-run" onSubmit={submit}>
      <textarea
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        placeholder="Goal — e.g. “Create hello.py with a function that reverses a string and pytest tests; have the other agent review”"
        rows={3}
      />
      <div className="row wrap">
        <label>
          Where
          <select
            value={location}
            onChange={(e) => setLocation(e.target.value as 'scratch' | 'workspace')}
          >
            <option value="scratch">scratch folder (safe)</option>
            <option value="workspace">this workspace’s folder</option>
          </select>
        </label>
        <label>
          Planner <HarnessSelect value={planner} onChange={setPlanner} />
        </label>
        <label>
          Builder <HarnessSelect value={builder} onChange={setBuilder} />
        </label>
        <label>
          Reviewer <HarnessSelect value={reviewer} onChange={setReviewer} />
        </label>
        <span className="spacer" />
        <button className="btn" disabled={!goal.trim()}>
          Plan run
        </button>
      </div>
    </form>
  );
}

function StepRow({ run, step }: { run: Run; step: RunStep }) {
  const editable = run.status === 'awaiting_approval' && step.status === 'pending';
  const [instr, setInstr] = useState(step.instruction);
  const [open, setOpen] = useState(step.status === 'running');
  const notify = useStore((s) => s.notify);
  useEffect(() => setInstr(step.instruction), [step.instruction]);
  useEffect(() => {
    if (step.status === 'running') setOpen(true);
  }, [step.status]);
  const save = (patch: Record<string, unknown>) =>
    api
      .patch(`/api/runs/${run.id}/steps/${step.id}`, patch)
      .catch((e) => notify(String(e.message), 'error'));
  const rounds = step.evidence?.rounds ?? [];
  return (
    <div className={`step step-${step.status}`}>
      <div className="step-head" onClick={() => setOpen(!open)}>
        <span className={`role role-${step.role}`}>{step.role}</span>
        <span className="mono small">{step.key}</span>
        {step.dependsOn.length > 0 && (
          <span className="muted small">after {step.dependsOn.join(', ')}</span>
        )}
        <span className="spacer" />
        {editable ? (
          <span onClick={(e) => e.stopPropagation()}>
            <HarnessSelect value={step.harness} onChange={(h) => save({ harness: h })} />
          </span>
        ) : (
          <span className={`badge badge-${step.harness}`}>{harnessLabel(step.harness)}</span>
        )}
        <span className={`step-status st-${step.status}`}>{step.status}</span>
        {step.role === 'review' && step.round > 0 && (
          <span className="muted small">
            {step.round} round{step.round === 1 ? '' : 's'}
          </span>
        )}
      </div>
      {editable ? (
        <div className="step-edit">
          <textarea
            value={instr}
            onChange={(e) => setInstr(e.target.value)}
            onBlur={() => instr !== step.instruction && save({ instruction: instr })}
            rows={2}
          />
          <button
            className="icon-btn"
            title="Remove step"
            onClick={() => api.del(`/api/runs/${run.id}/steps/${step.id}`)}
          >
            🗑
          </button>
        </div>
      ) : (
        <div className="step-instr small">{step.instruction}</div>
      )}
      {open && (step.log.length > 0 || rounds.length > 0) && (
        <div className="step-log">
          {rounds.map((r) => (
            <div key={r.round} className="round">
              <b>Review round {r.round}:</b> {r.approve ? '✅ approved' : `changes requested`}
              {r.findings.map((f, i) => (
                <div key={i} className={`finding sev-${f.severity}`}>
                  [{f.severity}] {f.file}
                  {f.line ? `:${f.line}` : ''} — {f.note}
                </div>
              ))}
            </div>
          ))}
          <pre>
            {step.log
              .map((l) => l.text)
              .join('\n')
              .slice(-6000)}
          </pre>
        </div>
      )}
    </div>
  );
}

function ResultCard({ run }: { run: Run }) {
  const r = run.result;
  if (!r) return null;
  const files = r.files;
  return (
    <div
      className={`result-card ${r.approved === false || (r.errors?.length ?? 0) > 0 ? 'warn' : 'ok'}`}
    >
      <h4>{r.summary}</h4>
      <div className="evidence">
        <div>
          <b>Review:</b>{' '}
          {r.approved === null ? 'no review step' : r.approved ? `approved` : 'not approved'} ·{' '}
          {r.reviewRounds} round{r.reviewRounds === 1 ? '' : 's'}
        </div>
        {files && (
          <div>
            <b>Files touched:</b>{' '}
            {[
              ...files.added.map((f) => `+${f}`),
              ...files.modified.map((f) => `~${f}`),
              ...files.deleted.map((f) => `-${f}`),
            ].join('  ') || 'none detected'}
          </div>
        )}
        {r.git && (
          <details>
            <summary>
              <b>git diff --stat</b>
            </summary>
            <pre>
              {r.git.diffStat || '(no tracked changes)'}
              {r.git.status ? `\n\n${r.git.status}` : ''}
            </pre>
          </details>
        )}
        {r.tests &&
          (r.tests.unverified ? (
            <div>
              <b>Tests:</b> <span className="warn-text">unverified</span> — {r.tests.unverified}
            </div>
          ) : (
            <details open={r.tests.exitCode !== 0}>
              <summary>
                <b>Tests:</b> <code>{r.tests.command}</code> →{' '}
                {r.tests.exitCode === 0 ? (
                  <span className="ok-text">passed</span>
                ) : (
                  <span className="warn-text">exit {r.tests.exitCode}</span>
                )}
              </summary>
              <pre>{r.tests.output}</pre>
            </details>
          ))}
        {r.findings && r.findings.length > 0 && (
          <div>
            <b>Open findings:</b>
            {r.findings.map((f, i) => (
              <div key={i} className={`finding sev-${f.severity}`}>
                [{f.severity}] {f.file}
                {f.line ? `:${f.line}` : ''} — {f.note}
              </div>
            ))}
          </div>
        )}
        {r.denials && r.denials.length > 0 && (
          <div className="warn-text">
            <b>Denied tool calls</b> (no one was there to approve them):
            {r.denials.map((d, i) => (
              <div key={i} className="small mono">
                {d}
              </div>
            ))}
            <div className="muted small">
              Add them to the allow-list in Settings if you want agents to do this unattended.
            </div>
          </div>
        )}
        {r.errors && r.errors.length > 0 && (
          <div className="error small">
            {r.errors.map((e, i) => (
              <div key={i}>{e}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function RunCard({ run, compact }: { run: Run; compact?: boolean }) {
  const notify = useStore((s) => s.notify);
  const readOnly = useStore((s) => s.readOnly);
  const [planText, setPlanText] = useState('');
  useEffect(() => {
    if (run.status !== 'planning') return;
    return socket.on((e) => {
      if (e.t === 'run' && e.runId === run.id) {
        const ev = e.event as { type: string; delta?: string; text?: string };
        if (ev.type === 'planner-delta') setPlanText((t) => (t + (ev.delta ?? '')).slice(-600));
        if (ev.type === 'planner') setPlanText(ev.text ?? '');
      }
    });
  }, [run.id, run.status]);
  const act = (a: string) =>
    api.post(`/api/runs/${run.id}/${a}`).catch((e) => notify(String(e.message), 'error'));
  return (
    <div className={`run-card run-${run.status}`}>
      <div className="run-head">
        <span className={`run-status rs-${run.status}`}>{run.status.replace('_', ' ')}</span>
        <span className="run-goal">{run.goal}</span>
        <span className="muted small">{timeAgo(run.createdAt)}</span>
      </div>
      {!compact && <div className="muted small mono">{run.cwd}</div>}
      {run.status === 'planning' && (
        <div className="muted small pre">{planText || 'Planning…'}</div>
      )}
      {run.plan?.summary && <div className="small">{run.plan.summary}</div>}
      {run.steps.length > 0 && (
        <div className="steps">
          {run.steps.map((s) => (
            <StepRow key={s.id} run={run} step={s} />
          ))}
        </div>
      )}
      {!readOnly && (
        <div className="row run-actions">
          {run.status === 'awaiting_approval' && (
            <>
              <button
                className="btn btn-ghost"
                onClick={() =>
                  api
                    .post(`/api/runs/${run.id}/steps`, {
                      role: 'verify',
                      harness: run.steps[0]?.harness ?? 'mock',
                      instruction: 'Run the tests and report the result.',
                      dependsOn: run.steps.map((s) => s.key),
                    })
                    .catch((e) => notify(String(e.message), 'error'))
                }
              >
                + verify step
              </button>
              <button className="btn" onClick={() => act('start')}>
                Approve & start
              </button>
            </>
          )}
          {run.status === 'running' && (
            <>
              <button className="btn btn-ghost" onClick={() => act('pause')}>
                Pause
              </button>
              <button className="btn btn-danger" onClick={() => act('stop')}>
                Stop
              </button>
            </>
          )}
          {(run.status === 'paused' || run.status === 'stopped') && (
            <button className="btn" onClick={() => act('resume')}>
              Resume
            </button>
          )}
          {run.status === 'paused' && (
            <button className="btn btn-danger" onClick={() => act('stop')}>
              Stop
            </button>
          )}
          <span className="spacer" />
          {['done', 'failed', 'stopped', 'awaiting_approval'].includes(run.status) && (
            <button
              className="icon-btn"
              title="Delete run"
              onClick={() => confirm('Delete this run record?') && api.del(`/api/runs/${run.id}`)}
            >
              🗑
            </button>
          )}
        </div>
      )}
      <ResultCard run={run} />
    </div>
  );
}

export function Runs() {
  const runs = useStore((s) => s.runs);
  const readOnly = useStore((s) => s.readOnly);
  const [, setLast] = useState<string | null>(null);
  return (
    <div className="runs">
      {!readOnly && <NewRun onCreated={setLast} />}
      {runs.length === 0 && (
        <p className="muted pad">
          No runs yet. A run takes a goal, has a planner draft steps you can edit, then builder and
          reviewer agents work it through up to 3 review rounds.
        </p>
      )}
      {runs.map((r) => (
        <RunCard key={r.id} run={r} />
      ))}
    </div>
  );
}
