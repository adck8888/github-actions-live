import { formatAgo, formatDuration, isActive, Run, runDuration, toneOf } from './model';

const SAMPLE = 30;

/** The one-line summary of a workflow's last run, as the code lens shows it. */
export function lastRunLabel(run: Run, now = Date.now()): string {
  const branch = run.head_branch ? ` on ${run.head_branch}` : '';
  if (isActive(run)) {
    const started = runDuration(run, now);
    return `$(sync~spin) ${run.status === 'waiting' ? 'Waiting for review' : run.status === 'queued' ? 'Queued' : 'Running'}${
      started !== undefined ? ` ${formatDuration(started)}` : ''
    } · #${run.run_number}${branch}`;
  }
  const tone = toneOf(run);
  const icon = { success: '$(check)', failure: '$(x)', cancelled: '$(circle-slash)', skipped: '$(debug-step-over)' }[tone as string] ?? '$(circle-outline)';
  const word = { success: 'Passed', failure: 'Failed', cancelled: 'Cancelled', skipped: 'Skipped' }[tone as string] ?? run.conclusion ?? 'Finished';
  return `${icon} ${word} ${formatAgo(run.updated_at, now)} · #${run.run_number}${branch}`;
}

/** "94% pass · 3m 10s" over the recent finished runs, or undefined with fewer than three. */
export function passRate(runs: Run[], now = Date.now()): string | undefined {
  const finished = runs.slice(0, SAMPLE).filter((run) => run.conclusion === 'success' || run.conclusion === 'failure');
  if (finished.length < 3) {
    return undefined;
  }
  const passed = finished.filter((run) => run.conclusion === 'success');
  const rate = Math.round((passed.length / finished.length) * 100);
  const durations = passed.map((run) => runDuration(run, now)).filter((value): value is number => value !== undefined).sort((a, b) => a - b);
  const median = durations.length ? durations[Math.floor(durations.length / 2)] : undefined;
  return `${rate}% pass of ${finished.length}${median !== undefined ? ` · ${formatDuration(median)}` : ''}`;
}
