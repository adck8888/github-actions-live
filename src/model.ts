/** The parts of GitHub's REST objects the extension reads. */

export interface Run {
  id: number;
  name?: string | null;
  display_title?: string;
  run_number: number;
  run_attempt?: number;
  event: string;
  status: string | null;
  conclusion: string | null;
  head_branch: string | null;
  head_sha: string;
  path?: string;
  workflow_id: number;
  html_url: string;
  created_at: string;
  updated_at: string;
  run_started_at?: string;
  actor?: { login: string } | null;
  triggering_actor?: { login: string } | null;
}

export interface Step {
  name: string;
  status: string;
  conclusion: string | null;
  number: number;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface Job {
  id: number;
  run_id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
  started_at: string | null;
  completed_at: string | null;
  steps?: Step[];
}

export interface Annotation {
  path: string;
  start_line: number;
  end_line: number;
  start_column?: number | null;
  end_column?: number | null;
  annotation_level: 'notice' | 'warning' | 'failure' | string;
  title?: string | null;
  message: string;
}

/** One state a run, job or step can be drawn in. */
export type Tone = 'queued' | 'running' | 'success' | 'failure' | 'cancelled' | 'skipped' | 'neutral' | 'attention';

const ACTIVE = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

export function isActive(item: { status: string | null }): boolean {
  return ACTIVE.has(item.status ?? '');
}

export function toneOf(item: { status: string | null; conclusion: string | null }): Tone {
  if (item.status === 'in_progress') {
    return 'running';
  }
  if (isActive(item)) {
    return 'queued';
  }
  switch (item.conclusion) {
    case 'success':
      return 'success';
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
      return 'failure';
    // A fork's pull request whose workflows wait for a maintainer to approve them.
    case 'action_required':
      return 'attention';
    case 'cancelled':
      return 'cancelled';
    case 'skipped':
      return 'skipped';
    default:
      return 'neutral';
  }
}

/**
 * The CI state of one commit across all of its workflow runs: failing if any
 * run failed, running while any is still going, green when all passed.
 */
export interface CommitStatus {
  tone: Tone | 'none';
  total: number;
  done: number;
  failed: Run[];
  running: Run[];
}

export function commitStatus(runs: Run[]): CommitStatus {
  // A re-run replaces the earlier attempt: keep the newest run per workflow and event.
  const latest = new Map<string, Run>();
  for (const run of runs) {
    const key = `${run.workflow_id}:${run.event}`;
    const current = latest.get(key);
    if (!current || Date.parse(run.created_at) > Date.parse(current.created_at) || (run.id === current.id && (run.run_attempt ?? 1) > (current.run_attempt ?? 1))) {
      latest.set(key, run);
    }
  }
  const all = [...latest.values()];
  const tones = all.map(toneOf);
  const failed = all.filter((_, index) => tones[index] === 'failure');
  const running = all.filter((_, index) => tones[index] === 'running' || tones[index] === 'queued');
  let tone: CommitStatus['tone'] = 'none';
  if (all.length) {
    if (failed.length) {
      tone = 'failure';
    } else if (running.length) {
      tone = running.some((run) => toneOf(run) === 'running') ? 'running' : 'queued';
    } else if (tones.includes('attention')) {
      tone = 'attention';
    } else if (tones.every((value) => value === 'cancelled')) {
      tone = 'cancelled';
    } else {
      tone = 'success';
    }
  }
  return { tone, total: all.length, done: all.length - running.length, failed, running };
}

/** `42s`, `3m 05s`, `1h 12m`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '';
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** `just now`, `5m ago`, `3h ago`, `2d ago`. */
export function formatAgo(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) {
    return '';
  }
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

/** How long a run, job or step took, or has been going for. */
export function elapsed(
  started: string | null | undefined,
  finished: string | null | undefined,
  active: boolean,
  now = Date.now()
): number | undefined {
  if (!started) {
    return undefined;
  }
  const end = active ? now : finished ? Date.parse(finished) : NaN;
  const ms = end - Date.parse(started);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

export function runDuration(run: Run, now = Date.now()): number | undefined {
  return elapsed(run.run_started_at ?? run.created_at, run.updated_at, isActive(run), now);
}

/** Why a finished run has no jobs. */
export function noJobs(run: Run): string {
  if (run.conclusion === 'action_required') {
    return 'Waiting for a maintainer to approve this run';
  }
  if (run.conclusion === 'startup_failure') {
    return 'The run could not start: check the workflow file';
  }
  if (run.conclusion === 'failure') {
    return 'The run failed before any job started. Open it on GitHub to see why';
  }
  return isActive(run) ? 'No jobs yet' : 'No jobs ran';
}

/** The workflow's name: GitHub's, or the file name when a run has none. */
export function workflowName(run: Run): string {
  return run.name || run.path?.split('/').pop() || `workflow ${run.workflow_id}`;
}

/** Runs that just went from queued/in progress to finished. */
export function finishedSince(before: Map<number, Run>, after: Run[]): Run[] {
  return after.filter((run) => {
    const previous = before.get(run.id);
    return previous !== undefined && (isActive(previous) || (previous.run_attempt ?? 1) < (run.run_attempt ?? 1)) && !isActive(run);
  });
}
