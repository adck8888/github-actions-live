import { elapsed, Job, Run, toneOf } from './model';

/** A matrix job family: `test (ubuntu, 18)` and `test (windows, 20)` share `test`. */
export type JobEntry = { kind: 'job'; job: Job } | { kind: 'group'; name: string; jobs: Job[] };

/** Folds the jobs of a matrix under one entry, keeping the order GitHub lists them in. */
export function groupJobs(jobs: Job[]): JobEntry[] {
  const prefixOf = (name: string): string | undefined => /^(.+?) \(.+\)$/.exec(name)?.[1];
  const counts = new Map<string, number>();
  for (const job of jobs) {
    const prefix = prefixOf(job.name);
    if (prefix) {
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
  }
  const entries: JobEntry[] = [];
  const groups = new Map<string, Extract<JobEntry, { kind: 'group' }>>();
  for (const job of jobs) {
    const prefix = prefixOf(job.name);
    if (prefix && (counts.get(prefix) ?? 0) >= 2) {
      let group = groups.get(prefix);
      if (!group) {
        group = { kind: 'group', name: prefix, jobs: [] };
        groups.set(prefix, group);
        entries.push(group);
      }
      group.jobs.push(job);
    } else {
      entries.push({ kind: 'job', job });
    }
  }
  return entries;
}

export interface StepTrend {
  job: string;
  step: string;
  recentMs: number;
  previousMs: number;
}

export interface WorkflowHealth {
  runs: number;
  finished: number;
  successRate: number | undefined;
  medianMs: number | undefined;
  recentMedianMs: number | undefined;
  previousMedianMs: number | undefined;
  /** Runs that failed and then passed on the same commit, by re-run or by another run. */
  flaky: Array<{ sha: string; branch: string | null; failedRun: Run | undefined; passedRun: Run; reason: 'rerun' | 'same-commit' }>;
  /** Steps that failed most often. */
  failingSteps: Array<{ job: string; step: string; count: number }>;
  /** Steps that got clearly slower in the most recent runs. */
  slower: StepTrend[];
}

/** How many of the newest runs count as "recent" when looking for slowdowns. */
const RECENT = 5;
const SLOWER_RATIO = 1.5;
const SLOWER_MIN_MS = 20_000;

export function median(values: number[]): number | undefined {
  if (!values.length) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function runMs(run: Run): number | undefined {
  return elapsed(run.run_started_at ?? run.created_at, run.updated_at, false);
}

/**
 * Reads a workflow's recent history: how often it passes, how long it takes,
 * which failures went away without a code change, and which steps slowed down.
 * `runs` are newest first; `jobs` are known for some of them.
 */
export function workflowHealth(runs: Run[], jobs: Map<number, Job[]>): WorkflowHealth {
  const finished = runs.filter((run) => run.status === 'completed' && toneOf(run) !== 'cancelled' && toneOf(run) !== 'skipped');
  const passed = finished.filter((run) => toneOf(run) === 'success');
  const durations = passed.map(runMs).filter((ms): ms is number => ms !== undefined);

  const flaky: WorkflowHealth['flaky'] = [];
  const bySha = new Map<string, Run[]>();
  for (const run of finished) {
    const list = bySha.get(run.head_sha) ?? [];
    list.push(run);
    bySha.set(run.head_sha, list);
  }
  for (const run of passed) {
    if ((run.run_attempt ?? 1) > 1) {
      // A later attempt passed: an earlier one did not.
      flaky.push({ sha: run.head_sha, branch: run.head_branch, failedRun: undefined, passedRun: run, reason: 'rerun' });
      continue;
    }
    const failedTwin = bySha.get(run.head_sha)?.find((other) => other.id !== run.id && toneOf(other) === 'failure' && other.event === run.event);
    if (failedTwin && Date.parse(failedTwin.created_at) < Date.parse(run.created_at)) {
      flaky.push({ sha: run.head_sha, branch: run.head_branch, failedRun: failedTwin, passedRun: run, reason: 'same-commit' });
    }
  }

  const failingCounts = new Map<string, { job: string; step: string; count: number }>();
  const stepTimes = new Map<string, { job: string; step: string; recent: number[]; previous: number[] }>();
  finished.forEach((run, index) => {
    for (const job of jobs.get(run.id) ?? []) {
      for (const step of job.steps ?? []) {
        const key = `${job.name}\u0000${step.name}`;
        if (step.conclusion === 'failure') {
          const entry = failingCounts.get(key) ?? { job: job.name, step: step.name, count: 0 };
          entry.count++;
          failingCounts.set(key, entry);
        }
        if (step.conclusion === 'success') {
          const ms = elapsed(step.started_at, step.completed_at, false);
          if (ms !== undefined) {
            const entry = stepTimes.get(key) ?? { job: job.name, step: step.name, recent: [], previous: [] };
            (index < RECENT ? entry.recent : entry.previous).push(ms);
            stepTimes.set(key, entry);
          }
        }
      }
    }
  });

  const slower: StepTrend[] = [];
  for (const entry of stepTimes.values()) {
    const recentMs = median(entry.recent);
    const previousMs = median(entry.previous);
    if (recentMs !== undefined && previousMs !== undefined && entry.recent.length >= 2 && entry.previous.length >= 2) {
      if (recentMs >= previousMs * SLOWER_RATIO && recentMs - previousMs >= SLOWER_MIN_MS) {
        slower.push({ job: entry.job, step: entry.step, recentMs, previousMs });
      }
    }
  }
  slower.sort((a, b) => b.recentMs - b.previousMs - (a.recentMs - a.previousMs));

  const recentRuns = passed.slice(0, RECENT).map(runMs).filter((ms): ms is number => ms !== undefined);
  const previousRuns = passed.slice(RECENT).map(runMs).filter((ms): ms is number => ms !== undefined);
  return {
    runs: runs.length,
    finished: finished.length,
    successRate: finished.length ? passed.length / finished.length : undefined,
    medianMs: median(durations),
    recentMedianMs: median(recentRuns),
    previousMedianMs: median(previousRuns),
    flaky,
    failingSteps: [...failingCounts.values()].sort((a, b) => b.count - a.count).slice(0, 10),
    slower: slower.slice(0, 10)
  };
}
