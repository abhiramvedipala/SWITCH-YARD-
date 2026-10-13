import { mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../store.js';
import { randomId } from '../auth/token.js';
import { hub } from '../events.js';
import { getHarness, isHarnessId } from '../harness/index.js';
import type { HarnessId, TurnResult } from '../harness/types.js';
import { REPO_ROOT } from '../paths.js';
import { getSetting } from '../db/index.js';
import { DEFAULT_ALLOWED_TOOLS } from '../chat/service.js';
import {
  snapshot,
  diffSnapshots,
  gitEvidence,
  changedFilesExcerpt,
  runTests,
  type Snapshot,
} from './evidence.js';

export type RunStatus =
  'planning' | 'awaiting_approval' | 'running' | 'paused' | 'done' | 'failed' | 'stopped';
export type StepRole = 'plan' | 'build' | 'review' | 'verify';
export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'stopped' | 'skipped';

export interface Finding {
  severity: string;
  file: string;
  line?: number;
  note: string;
}

export interface RunStep {
  id: string;
  runId: string;
  idx: number;
  key: string;
  agentNode: string | null;
  harness: HarnessId;
  role: StepRole;
  instruction: string;
  dependsOn: string[];
  status: StepStatus;
  output: string | null;
  evidence: unknown;
  log: { at: number; text: string }[];
  round: number;
  sessionRef: string | null;
}

export interface RunRec {
  id: string;
  workspaceId: string;
  goal: string;
  status: RunStatus;
  plan: { summary: string; steps: unknown[] } | null;
  cwd: string;
  result: RunResult | null;
  createdAt: number;
  updatedAt: number;
  steps: RunStep[];
}

export interface RunResult {
  summary: string;
  approved: boolean | null;
  reviewRounds: number;
  files: { added: string[]; modified: string[]; deleted: string[] };
  git: { diffStat: string; status: string } | null;
  tests: Awaited<ReturnType<typeof runTests>>;
  findings: Finding[];
  stepOutputs: { key: string; role: string; harness: string; status: string; output: string }[];
  errors: string[];
}

export const PLAN_SCHEMA_BASE = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          role: { type: 'string', enum: ['plan', 'build', 'review', 'verify'] },
          harness: { type: 'string' },
          instruction: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'role', 'harness', 'instruction', 'dependsOn'],
      },
    },
  },
  required: ['summary', 'steps'],
};

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    approve: { type: 'boolean' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          note: { type: 'string' },
        },
        required: ['severity', 'file', 'note'],
      },
    },
  },
  required: ['approve', 'findings'],
};

const MAX_REVIEW_ROUNDS = 3;

interface RunRow {
  id: string;
  workspace_id: string;
  goal: string;
  status: RunStatus;
  plan_json: string | null;
  cwd: string;
  result_json: string | null;
  created_at: number;
  updated_at: number;
}

interface StepRow {
  id: string;
  run_id: string;
  idx: number;
  step_key: string;
  agent_node: string | null;
  harness: HarnessId;
  role: StepRole;
  instruction: string;
  depends_on_json: string;
  status: StepStatus;
  output: string | null;
  evidence_json: string | null;
  log_json: string;
  round: number;
  session_ref: string | null;
}

const toStep = (r: StepRow): RunStep => ({
  id: r.id,
  runId: r.run_id,
  idx: r.idx,
  key: r.step_key,
  agentNode: r.agent_node,
  harness: r.harness,
  role: r.role,
  instruction: r.instruction,
  dependsOn: JSON.parse(r.depends_on_json) as string[],
  status: r.status,
  output: r.output,
  evidence: r.evidence_json ? JSON.parse(r.evidence_json) : null,
  log: JSON.parse(r.log_json) as { at: number; text: string }[],
  round: r.round,
  sessionRef: r.session_ref,
});

export interface CreateRunInput {
  goal: string;
  location?: 'workspace' | 'scratch';
  cwd?: string;
  planner?: string;
  builder?: string;
  reviewer?: string;
}

export class RunEngine {
  private controllers = new Map<string, Set<AbortController>>();
  private snapshots = new Map<string, Snapshot>();
  private loops = new Set<string>();
  /** Which harnesses are usable; refreshed by the server from detection. */
  available: HarnessId[] = ['mock'];

  constructor(private store: Store) {}

  private get db() {
    return this.store.db;
  }

  // ------------------------------------------------------------ persistence
  get(runId: string): RunRec | undefined {
    const r = this.db.prepare('SELECT * FROM runs WHERE id=?').get(runId) as RunRow | undefined;
    if (!r) return undefined;
    const steps = (
      this.db.prepare('SELECT * FROM run_steps WHERE run_id=? ORDER BY idx').all(runId) as StepRow[]
    ).map(toStep);
    return {
      id: r.id,
      workspaceId: r.workspace_id,
      goal: r.goal,
      status: r.status,
      plan: r.plan_json ? JSON.parse(r.plan_json) : null,
      cwd: r.cwd,
      result: r.result_json ? JSON.parse(r.result_json) : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      steps,
    };
  }

  list(workspaceId: string): RunRec[] {
    const rows = this.db
      .prepare('SELECT id FROM runs WHERE workspace_id=? ORDER BY created_at DESC')
      .all(workspaceId) as { id: string }[];
    return rows.map((r) => this.get(r.id)!);
  }

  private setRun(
    runId: string,
    patch: { status?: RunStatus; plan?: unknown; result?: unknown },
  ): void {
    const cur = this.db.prepare('SELECT * FROM runs WHERE id=?').get(runId) as RunRow | undefined;
    if (!cur) return;
    this.db
      .prepare('UPDATE runs SET status=?, plan_json=?, result_json=?, updated_at=? WHERE id=?')
      .run(
        patch.status ?? cur.status,
        patch.plan !== undefined ? JSON.stringify(patch.plan) : cur.plan_json,
        patch.result !== undefined ? JSON.stringify(patch.result) : cur.result_json,
        Date.now(),
        runId,
      );
    this.emit(runId, { type: 'run', status: patch.status ?? cur.status });
  }

  private setStep(
    stepId: string,
    patch: Partial<
      Pick<
        RunStep,
        'status' | 'output' | 'evidence' | 'round' | 'sessionRef' | 'instruction' | 'harness'
      >
    >,
  ): void {
    const cur = this.db.prepare('SELECT * FROM run_steps WHERE id=?').get(stepId) as
      StepRow | undefined;
    if (!cur) return;
    this.db
      .prepare(
        'UPDATE run_steps SET status=?, output=?, evidence_json=?, round=?, session_ref=?, instruction=?, harness=?, updated_at=? WHERE id=?',
      )
      .run(
        patch.status ?? cur.status,
        patch.output !== undefined ? patch.output : cur.output,
        patch.evidence !== undefined ? JSON.stringify(patch.evidence) : cur.evidence_json,
        patch.round ?? cur.round,
        patch.sessionRef !== undefined ? patch.sessionRef : cur.session_ref,
        patch.instruction ?? cur.instruction,
        patch.harness ?? cur.harness,
        Date.now(),
        stepId,
      );
    this.emit(cur.run_id, { type: 'step', stepId, status: patch.status ?? cur.status });
  }

  private log(stepId: string, text: string): void {
    const cur = this.db.prepare('SELECT run_id, log_json FROM run_steps WHERE id=?').get(stepId) as
      { run_id: string; log_json: string } | undefined;
    if (!cur) return;
    const log = JSON.parse(cur.log_json) as { at: number; text: string }[];
    log.push({ at: Date.now(), text: text.slice(0, 4000) });
    this.db
      .prepare('UPDATE run_steps SET log_json=? WHERE id=?')
      .run(JSON.stringify(log.slice(-400)), stepId);
    this.emit(cur.run_id, { type: 'log', stepId, text: text.slice(0, 4000) });
  }

  private emit(runId: string, event: unknown): void {
    hub.emitHub({ t: 'run', runId, event });
  }

  private pickHarness(wanted: string | undefined, fallbacks: HarnessId[]): HarnessId {
    if (
      wanted &&
      isHarnessId(wanted) &&
      this.available.includes(wanted) &&
      getHarness(wanted).runTurn
    )
      return wanted;
    for (const f of fallbacks) if (this.available.includes(f)) return f;
    return 'mock';
  }

  // ------------------------------------------------------------ lifecycle
  async create(workspaceId: string, input: CreateRunInput): Promise<RunRec> {
    const ws = this.store.getWorkspace(workspaceId);
    if (!ws) throw new Error('unknown workspace');
    const goal = input.goal.trim();
    if (!goal) throw new Error('goal is required');
    const id = randomId(8);
    let cwd: string;
    if (input.location === 'scratch') {
      cwd = join(REPO_ROOT, 'scratch', 'runs', id);
      mkdirSync(cwd, { recursive: true });
    } else {
      cwd = input.cwd || ws.rootDir;
      if (!existsSync(cwd) || !statSync(cwd).isDirectory())
        throw new Error(`folder does not exist: ${cwd}`);
    }
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO runs(id, workspace_id, goal, status, plan_json, cwd, result_json, created_at, updated_at) VALUES (?,?,?,?,NULL,?,NULL,?,?)',
      )
      .run(id, workspaceId, goal, 'planning', cwd, now, now);
    hub.emitHub({ t: 'change', entity: 'runs', workspaceId, id });
    void this.plan(id, input);
    return this.get(id)!;
  }

  private async plan(runId: string, input: CreateRunInput): Promise<void> {
    const run = this.get(runId)!;
    const planner = this.pickHarness(input.planner, ['claude', 'agy', 'mock']);
    const builder = this.pickHarness(input.builder, ['claude', 'agy', 'mock']);
    const reviewer = this.pickHarness(
      input.reviewer,
      this.available.filter((h) => h !== builder).concat([builder]),
    );
    const harnessEnum = [
      ...new Set([...this.available.filter((h) => getHarness(h).runTurn), 'mock']),
    ];
    const schema = JSON.parse(JSON.stringify(PLAN_SCHEMA_BASE));
    schema.properties.steps.items.properties.harness.enum = harnessEnum;
    const prompt = [
      'You are the PLANNER for a Switchyard run. Break the goal into a short plan of steps for coding agents.',
      `Goal: ${run.goal}`,
      `Working directory for every step: ${run.cwd}`,
      `Available harnesses: ${harnessEnum.join(', ')}. Prefer "${builder}" for build steps and "${reviewer}" for review steps so a different agent reviews the work.`,
      'Roles: "plan" (think/write a design note), "build" (edit files), "review" (inspect the changes and approve or list findings), "verify" (run tests/commands and report).',
      'Use 2-5 steps. Step ids are short slugs. dependsOn lists ids of earlier steps. Every build step should be followed by a review step that depends on it.',
      'Do not do the work yourself; only return the plan as JSON matching the schema.',
    ].join('\n');
    const logPlan = (t: string) => this.emit(runId, { type: 'planner', text: t });
    logPlan(`planning with ${planner}…`);
    const res = await this.turn(runId, planner, {
      prompt,
      cwd: run.cwd,
      schema,
      onText: (d) => this.emit(runId, { type: 'planner-delta', delta: d }),
    });
    const plan = res.structured as
      { summary?: string; steps?: Array<Record<string, unknown>> } | undefined;
    if (!res.ok || !plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
      this.setRun(runId, {
        status: 'failed',
        result: {
          summary: `Planner failed: ${res.error ?? 'no valid plan returned'}`,
          errors: [res.error ?? 'invalid plan'],
        },
      });
      return;
    }
    const keys = new Set<string>();
    const steps = plan.steps.slice(0, 12).map((s, i) => {
      let key =
        String(s.id ?? `step-${i + 1}`)
          .replace(/[^a-zA-Z0-9_-]/g, '-')
          .slice(0, 40) || `step-${i + 1}`;
      while (keys.has(key)) key = `${key}-${i}`;
      keys.add(key);
      const role = (
        ['plan', 'build', 'review', 'verify'].includes(String(s.role)) ? s.role : 'build'
      ) as StepRole;
      const fallback = role === 'review' ? reviewer : builder;
      return {
        key,
        role,
        harness: this.pickHarness(String(s.harness ?? ''), [fallback]),
        instruction: String(s.instruction ?? '').slice(0, 4000),
        dependsOn: (Array.isArray(s.dependsOn) ? s.dependsOn : []).map(String),
      };
    });
    for (const s of steps) s.dependsOn = s.dependsOn.filter((d) => keys.has(d) && d !== s.key);
    const insert = this.db.prepare(
      `INSERT INTO run_steps(id, run_id, idx, step_key, agent_node, harness, role, instruction, depends_on_json, status, output, evidence_json, log_json, round, session_ref, updated_at)
       VALUES (?,?,?,?,NULL,?,?,?,?,'pending',NULL,NULL,'[]',0,NULL,?)`,
    );
    this.db.transaction(() => {
      steps.forEach((s, i) =>
        insert.run(
          randomId(8),
          runId,
          i,
          s.key,
          s.harness,
          s.role,
          s.instruction,
          JSON.stringify(s.dependsOn),
          Date.now(),
        ),
      );
    })();
    this.setRun(runId, {
      status: 'awaiting_approval',
      plan: { summary: plan.summary ?? '', steps },
    });
  }

  updateStep(
    runId: string,
    stepId: string,
    patch: { instruction?: string; harness?: string },
  ): RunStep {
    const run = this.get(runId);
    if (!run) throw new Error('unknown run');
    const step = run.steps.find((s) => s.id === stepId);
    if (!step) throw new Error('unknown step');
    if (step.status !== 'pending') throw new Error('only pending steps can be edited');
    if (patch.harness !== undefined && !isHarnessId(patch.harness))
      throw new Error('unknown harness');
    this.setStep(stepId, {
      instruction: patch.instruction,
      harness: patch.harness as HarnessId | undefined,
    });
    return this.get(runId)!.steps.find((s) => s.id === stepId)!;
  }

  addStep(
    runId: string,
    input: { role: StepRole; harness: string; instruction: string; dependsOn?: string[] },
  ): RunRec {
    const run = this.get(runId);
    if (!run || run.status !== 'awaiting_approval')
      throw new Error('steps can only be added before the run starts');
    if (!isHarnessId(input.harness)) throw new Error('unknown harness');
    const key = `step-${run.steps.length + 1}`;
    this.db
      .prepare(
        `INSERT INTO run_steps(id, run_id, idx, step_key, agent_node, harness, role, instruction, depends_on_json, status, output, evidence_json, log_json, round, session_ref, updated_at)
         VALUES (?,?,?,?,NULL,?,?,?,?,'pending',NULL,NULL,'[]',0,NULL,?)`,
      )
      .run(
        randomId(8),
        runId,
        run.steps.length,
        key,
        input.harness,
        input.role,
        input.instruction,
        JSON.stringify(input.dependsOn ?? []),
        Date.now(),
      );
    this.emit(runId, { type: 'plan-edited' });
    return this.get(runId)!;
  }

  removeStep(runId: string, stepId: string): RunRec {
    const run = this.get(runId);
    if (!run || run.status !== 'awaiting_approval')
      throw new Error('steps can only be removed before the run starts');
    const step = run.steps.find((s) => s.id === stepId);
    if (!step) throw new Error('unknown step');
    this.db.prepare('DELETE FROM run_steps WHERE id=?').run(stepId);
    for (const s of run.steps) {
      if (s.dependsOn.includes(step.key)) {
        this.db
          .prepare('UPDATE run_steps SET depends_on_json=? WHERE id=?')
          .run(JSON.stringify(s.dependsOn.filter((d) => d !== step.key)), s.id);
      }
    }
    this.emit(runId, { type: 'plan-edited' });
    return this.get(runId)!;
  }

  start(runId: string): void {
    const run = this.get(runId);
    if (!run) throw new Error('unknown run');
    if (run.status !== 'awaiting_approval' && run.status !== 'paused' && run.status !== 'stopped') {
      throw new Error(`cannot start a run that is ${run.status}`);
    }
    if (!this.snapshots.has(runId)) this.snapshots.set(runId, snapshot(run.cwd));
    for (const s of run.steps)
      if (s.status === 'stopped' || s.status === 'running')
        this.setStep(s.id, { status: 'pending' });
    this.setRun(runId, { status: 'running' });
    void this.loop(runId);
  }

  pause(runId: string): void {
    const run = this.get(runId);
    if (run?.status === 'running') this.setRun(runId, { status: 'paused' });
  }

  resume(runId: string): void {
    this.start(runId);
  }

  stop(runId: string): void {
    const run = this.get(runId);
    if (!run || ['done', 'failed', 'stopped'].includes(run.status)) return;
    this.setRun(runId, { status: 'stopped' });
    for (const c of this.controllers.get(runId) ?? []) c.abort();
  }

  /** On boot, anything mid-flight was interrupted by the restart. */
  onBoot(): void {
    this.db.prepare(`UPDATE runs SET status='paused' WHERE status='running'`).run();
    this.db
      .prepare(`UPDATE runs SET status='failed', result_json=? WHERE status='planning'`)
      .run(
        JSON.stringify({
          summary: 'Interrupted by a core restart while planning',
          errors: ['restart'],
        }),
      );
    this.db.prepare(`UPDATE run_steps SET status='pending' WHERE status='running'`).run();
  }

  // ------------------------------------------------------------ execution
  private async loop(runId: string): Promise<void> {
    if (this.loops.has(runId)) return;
    this.loops.add(runId);
    try {
      const inflight = new Map<string, Promise<void>>();
      for (;;) {
        const run = this.get(runId);
        if (!run) return;
        if (run.status !== 'running') {
          await Promise.all(inflight.values());
          return;
        }
        const done = new Set(
          run.steps.filter((s) => s.status === 'done' || s.status === 'skipped').map((s) => s.key),
        );
        const failed = run.steps.filter((s) => s.status === 'failed');
        const ready = run.steps.filter(
          (s) =>
            s.status === 'pending' && !inflight.has(s.id) && s.dependsOn.every((d) => done.has(d)),
        );
        for (const s of ready) {
          const p = this.execStep(runId, s.id).finally(() => inflight.delete(s.id));
          inflight.set(s.id, p);
        }
        if (inflight.size === 0) {
          const pending = run.steps.filter((s) => s.status === 'pending');
          if (pending.length > 0 && failed.length > 0) {
            for (const s of pending) {
              this.setStep(s.id, { status: 'skipped' });
              this.log(s.id, 'skipped: an upstream step failed');
            }
          }
          await this.finish(runId);
          return;
        }
        await Promise.race(inflight.values());
      }
    } finally {
      this.loops.delete(runId);
    }
  }

  private async turn(
    runId: string,
    harness: HarnessId,
    opts: {
      prompt: string;
      cwd: string;
      schema?: Record<string, unknown>;
      sessionId?: string | null;
      onText?: (d: string) => void;
      onTool?: (name: string) => void;
    },
  ): Promise<TurnResult> {
    const h = getHarness(harness);
    if (!h.runTurn)
      return { ok: false, text: '', sessionId: null, error: `${harness} cannot be driven` };
    const ctrl = new AbortController();
    const set = this.controllers.get(runId) ?? new Set();
    set.add(ctrl);
    this.controllers.set(runId, set);
    try {
      return await h.runTurn({
        prompt: opts.prompt,
        cwd: opts.cwd,
        schema: opts.schema,
        sessionId: opts.sessionId,
        allowedTools: getSetting(this.store.db, 'allowedTools', DEFAULT_ALLOWED_TOOLS),
        signal: ctrl.signal,
        timeoutMs: 30 * 60_000,
        onEvent: (e) => {
          if (e.kind === 'text') opts.onText?.(e.delta);
          if (e.kind === 'tool' && e.name !== 'result') opts.onTool?.(e.name);
        },
      });
    } finally {
      set.delete(ctrl);
    }
  }

  private depOutputs(run: RunRec, step: RunStep): string {
    return step.dependsOn
      .map((k) => run.steps.find((s) => s.key === k))
      .filter((s): s is RunStep => !!s && !!s.output)
      .map(
        (s) =>
          `### Output of step "${s.key}" (${s.role}, ${s.harness})\n${(s.output ?? '').slice(0, 6000)}`,
      )
      .join('\n\n');
  }

  private async execStep(runId: string, stepId: string): Promise<void> {
    const run = this.get(runId)!;
    const step = run.steps.find((s) => s.id === stepId)!;
    this.setStep(stepId, { status: 'running' });
    this.log(stepId, `started on ${step.harness}`);
    try {
      if (step.role === 'review') await this.execReview(run, step);
      else await this.execWork(run, step);
    } catch (err) {
      this.log(stepId, `error: ${(err as Error).message}`);
      this.setStep(stepId, { status: 'failed' });
    }
  }

  private stepWasStopped(runId: string): boolean {
    return this.get(runId)?.status === 'stopped';
  }

  private async execWork(run: RunRec, step: RunStep): Promise<void> {
    const ctx = this.depOutputs(run, step);
    const prompt = [
      `You are the ${step.role.toUpperCase()} step of a Switchyard run.`,
      `Overall goal: ${run.goal}`,
      `Your instruction: ${step.instruction}`,
      `Work in: ${run.cwd} (edit files there directly).`,
      ctx ? `\nContext from earlier steps:\n${ctx}` : '',
      '\nWhen finished, reply with a short summary of exactly what you did and which files you touched.',
    ].join('\n');
    let buffered = '';
    const res = await this.turn(run.id, step.harness, {
      prompt,
      cwd: run.cwd,
      onText: (d) => {
        buffered += d;
        if (buffered.length > 400 || d.includes('\n')) {
          this.log(step.id, buffered);
          buffered = '';
        }
      },
      onTool: (name) => this.log(step.id, `tool: ${name}`),
    });
    if (buffered) this.log(step.id, buffered);
    if (this.stepWasStopped(run.id)) {
      this.setStep(step.id, {
        status: 'stopped',
        output: res.text || null,
        sessionRef: res.sessionId,
      });
      return;
    }
    this.setStep(step.id, {
      status: res.ok ? 'done' : 'failed',
      output: res.ok ? res.text : `${res.text}\n\n[error] ${res.error}`,
      sessionRef: res.sessionId,
    });
    this.log(step.id, res.ok ? 'done' : `failed: ${res.error}`);
  }

  private reviewPrompt(run: RunRec, step: RunStep, round: number): string {
    const before = this.snapshots.get(run.id) ?? new Map();
    const changes = diffSnapshots(before, snapshot(run.cwd));
    const files = [...changes.added, ...changes.modified, ...changes.deleted];
    return [
      `You are the REVIEW step of a Switchyard run (round ${round + 1} of at most ${MAX_REVIEW_ROUNDS}).`,
      `Overall goal: ${run.goal}`,
      `Review instruction: ${step.instruction}`,
      `Working directory: ${run.cwd}`,
      `Files changed during this run: ${files.length ? files.join(', ') : '(none detected)'}`,
      '\nCurrent contents of the changed files:',
      changedFilesExcerpt(run.cwd, files) || '(no changes)',
      this.depOutputs(run, step) ? `\nBuilder reports:\n${this.depOutputs(run, step)}` : '',
      '\nReturn JSON: approve=true only if the work meets the goal with no blocker/major issues. List concrete findings (severity, file, line, note). Do not edit files yourself.',
    ].join('\n');
  }

  private async execReview(run: RunRec, step: RunStep): Promise<void> {
    let round = step.round;
    let reviewerSession = step.sessionRef;
    const builders = step.dependsOn
      .map((k) => run.steps.find((s) => s.key === k))
      .filter((s): s is RunStep => !!s && s.role === 'build');
    const allFindings: { round: number; approve: boolean; findings: Finding[] }[] =
      (
        step.evidence as {
          rounds?: { round: number; approve: boolean; findings: Finding[] }[];
        } | null
      )?.rounds ?? [];
    for (;;) {
      const fresh = this.get(run.id)!;
      const res = await this.turn(run.id, step.harness, {
        prompt: this.reviewPrompt(fresh, step, round),
        cwd: run.cwd,
        schema: REVIEW_SCHEMA,
        sessionId: reviewerSession,
      });
      if (this.stepWasStopped(run.id)) {
        this.setStep(step.id, { status: 'stopped', round, evidence: { rounds: allFindings } });
        return;
      }
      reviewerSession = res.sessionId ?? reviewerSession;
      const verdict = res.structured as { approve?: boolean; findings?: Finding[] } | undefined;
      if (!res.ok || !verdict || typeof verdict.approve !== 'boolean') {
        this.setStep(step.id, {
          status: 'failed',
          output: `Reviewer did not return a verdict: ${res.error ?? res.text.slice(0, 500)}`,
          round,
          evidence: { rounds: allFindings },
        });
        this.log(step.id, 'failed: no valid review verdict');
        return;
      }
      const findings = (verdict.findings ?? []).slice(0, 50);
      allFindings.push({ round: round + 1, approve: verdict.approve, findings });
      this.log(
        step.id,
        `round ${round + 1}: ${verdict.approve ? 'approved' : `changes requested (${findings.length} findings)`}`,
      );
      for (const f of findings)
        this.log(step.id, `  [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''} — ${f.note}`);
      round += 1;
      this.setStep(step.id, {
        round,
        sessionRef: reviewerSession,
        evidence: { rounds: allFindings },
      });
      if (verdict.approve || round >= MAX_REVIEW_ROUNDS || builders.length === 0) {
        const summary = verdict.approve
          ? `Approved after ${round} round${round === 1 ? '' : 's'}.`
          : builders.length === 0
            ? `Not approved; no build step to send findings to.`
            : `Not approved after ${MAX_REVIEW_ROUNDS} rounds.`;
        this.setStep(step.id, {
          status: 'done',
          output: `${summary}\n${findings.map((f) => `- [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''}: ${f.note}`).join('\n')}`,
        });
        return;
      }
      // Send findings back to each builder, in its own session so it keeps its context.
      for (const b of builders) {
        const cur = this.get(run.id)!.steps.find((s) => s.id === b.id)!;
        this.log(b.id, `review round ${round}: fixing ${findings.length} findings`);
        const fix = await this.turn(run.id, cur.harness, {
          prompt: [
            `The reviewer requested changes (round ${round}). Fix these findings in ${run.cwd}:`,
            ...findings.map(
              (f) => `- [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''}: ${f.note}`,
            ),
            `Overall goal: ${run.goal}`,
            'Reply with a short summary of the fixes.',
          ].join('\n'),
          cwd: run.cwd,
          sessionId: cur.sessionRef,
          onTool: (name) => this.log(b.id, `tool: ${name}`),
        });
        if (this.stepWasStopped(run.id)) {
          this.setStep(step.id, { status: 'stopped' });
          return;
        }
        this.setStep(b.id, {
          output: `${cur.output ?? ''}\n\n[review round ${round} fixes]\n${fix.text}`,
          sessionRef: fix.sessionId ?? cur.sessionRef,
        });
        this.log(b.id, fix.ok ? 'fixes applied' : `fix turn failed: ${fix.error}`);
      }
    }
  }

  private async finish(runId: string): Promise<void> {
    const run = this.get(runId)!;
    if (run.status !== 'running') return;
    const before = this.snapshots.get(runId) ?? new Map();
    const files = diffSnapshots(before, snapshot(run.cwd));
    const git = await gitEvidence(run.cwd);
    const tests = getSetting(this.store.db, 'runTestsForEvidence', true)
      ? await runTests(run.cwd)
      : { unverified: 'Test run for evidence is turned off in Settings' };
    const reviews = run.steps.filter((s) => s.role === 'review');
    const lastRounds = reviews.map(
      (r) =>
        (r.evidence as { rounds?: { approve: boolean; findings: Finding[] }[] } | null)?.rounds ??
        [],
    );
    const approved =
      reviews.length === 0
        ? null
        : lastRounds.every((rs) => rs.length > 0 && rs[rs.length - 1]!.approve);
    const errors = run.steps
      .filter((s) => s.status === 'failed')
      .map((s) => `${s.key}: ${(s.output ?? '').split('\n').pop()}`);
    const result: RunResult = {
      summary:
        errors.length > 0
          ? `Finished with ${errors.length} failed step${errors.length === 1 ? '' : 's'}.`
          : approved === false
            ? 'Finished, but the reviewer did not approve.'
            : approved
              ? 'Finished and approved by review.'
              : 'Finished (no review step).',
      approved,
      reviewRounds: reviews.reduce((n, r) => n + r.round, 0),
      files,
      git,
      tests,
      findings: lastRounds.flatMap((rs) => rs[rs.length - 1]?.findings ?? []),
      stepOutputs: run.steps.map((s) => ({
        key: s.key,
        role: s.role,
        harness: s.harness,
        status: s.status,
        output: (s.output ?? '').slice(0, 3000),
      })),
      errors,
    };
    this.setRun(runId, { status: errors.length > 0 ? 'failed' : 'done', result });
    this.snapshots.delete(runId);
  }

  delete(runId: string): void {
    this.stop(runId);
    const run = this.get(runId);
    this.db.prepare('DELETE FROM runs WHERE id=?').run(runId);
    if (run) hub.emitHub({ t: 'change', entity: 'runs', workspaceId: run.workspaceId });
  }
}
