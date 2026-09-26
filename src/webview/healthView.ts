import { WorkflowHealth } from '../health';
import { elapsed, formatDuration, Run, toneOf } from '../model';
import { ago, button, esc, glyph, toneIcon } from './html';

export interface HealthView {
  workflow: string;
  branch: string | undefined;
  runs: Run[];
  health: WorkflowHealth;
  jobRuns: number;
  now: number;
}

const TONE_FILL: Record<string, string> = {
  success: 'var(--al-green)',
  failure: 'var(--al-red)',
  running: 'var(--al-yellow)',
  queued: 'var(--al-yellow)'
};

/** A dashboard of how a workflow has been doing lately. */
export function renderHealth(view: HealthView): string {
  const { health } = view;
  const header = `<header class="header">
  <div class="title-row"><span class="pill t-neutral">${glyph('pulse')}Workflow health</span><h1>${esc(view.workflow)}</h1></div>
  <div class="meta"><span>${glyph('branch')}${view.branch ? `<span class="mono">${esc(view.branch)}</span>` : 'all branches'}</span><span>${glyph('clock')}last ${health.runs} runs · step details from ${view.jobRuns} finished</span></div>
  <div class="actions">${button({ cmd: 'refresh', label: 'Refresh', icon: 'rerun' })}</div>
</header>`;
  if (!health.runs) {
    return `${header}<div class="empty" style="margin-top:24px">No runs yet.</div>`;
  }
  return header + kpis(view) + chart(view) + failing(view) + slower(view) + flaky(view);
}

function kpis(view: HealthView): string {
  const { health } = view;
  const rate = health.successRate;
  const rateTone = rate === undefined ? '' : rate >= 0.9 ? 't-success' : rate >= 0.7 ? 't-running' : 't-failure';
  let trend = '<div class="value">—</div><div class="sub">needs 6+ passing runs</div>';
  if (health.recentMedianMs !== undefined && health.previousMedianMs !== undefined && health.previousMedianMs > 0) {
    const change = Math.round(((health.recentMedianMs - health.previousMedianMs) / health.previousMedianMs) * 100);
    const tone = change >= 15 ? 't-failure' : change <= -10 ? 't-success' : '';
    trend = `<div class="value ${tone}">${change > 0 ? '+' : ''}${change}%</div><div class="sub">last 5: ${esc(formatDuration(health.recentMedianMs))} vs ${esc(
      formatDuration(health.previousMedianMs)
    )}</div>`;
  }
  return `<div class="cards">
  <div class="card"><div class="label">${glyph('star')}Pass rate</div><div class="value ${rateTone}">${rate === undefined ? '—' : `${Math.round(rate * 100)}%`}</div><div class="sub">of ${
    health.finished
  } finished runs</div></div>
  <div class="card"><div class="label">${glyph('clock')}Typical duration</div><div class="value">${esc(
    health.medianMs !== undefined ? formatDuration(health.medianMs) : '—'
  )}</div><div class="sub">median of passing runs</div></div>
  <div class="card"><div class="label">${glyph('pulse')}Trend</div>${trend}</div>
  <div class="card"><div class="label">${glyph('warning')}Flaky</div><div class="value${health.flaky.length ? ' t-running' : ''}">${health.flaky.length}</div><div class="sub">failed, then passed on the same commit</div></div>
</div>`;
}

/** The runs as bars, oldest on the left: height is how long, colour is how it ended. */
function chart(view: HealthView): string {
  const runs = [...view.runs].reverse();
  const values = runs.map((run) => elapsed(run.run_started_at ?? run.created_at, run.updated_at, run.status !== 'completed', view.now) ?? 0);
  const max = Math.max(1, ...values);
  const width = 1000;
  const height = 150;
  const gap = 4;
  const slot = width / Math.max(runs.length, 12);
  const median = view.health.medianMs;
  const bars = runs
    .map((run, index) => {
      const tone = toneOf(run);
      const h = Math.max(3, (values[index] / max) * (height - 8));
      const x = index * slot + gap / 2;
      const fill = TONE_FILL[tone] ?? 'var(--al-gray)';
      const label = `#${run.run_number} · ${tone} · ${formatDuration(values[index])} · ${run.head_branch ?? ''} ${run.head_sha.slice(0, 7)} · ${new Date(run.created_at).toLocaleString()}`;
      return `<g class="bar-hit" data-cmd="openRun" data-run="${run.id}"><title>${esc(label)}</title><rect x="${x}" y="0" width="${slot - gap}" height="${height}" fill="transparent"/><rect class="b" x="${x}" y="${
        height - h
      }" width="${slot - gap}" height="${h}" rx="2" fill="${fill}" fill-opacity="${tone === 'success' ? 0.75 : 1}"/></g>`;
    })
    .join('');
  const medianLine =
    median !== undefined && median <= max
      ? `<line x1="0" x2="${width}" y1="${height - (median / max) * (height - 8)}" y2="${height - (median / max) * (height - 8)}" stroke="var(--al-muted)" stroke-dasharray="4 4" stroke-width="1" vector-effect="non-scaling-stroke"/>`
      : '';
  return `<h2>Runs <span class="count">${runs.length}</span></h2>
<div class="chart">
  <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Duration of recent runs">${medianLine}${bars}</svg>
  <div class="chart-foot"><span>${runs.length ? ago(runs[0].created_at, view.now) : ''}</span><span>bar height = duration${
    median !== undefined ? ` · dashed = typical ${esc(formatDuration(median))}` : ''
  } · click a bar to open the run</span><span>${runs.length ? ago(runs[runs.length - 1].created_at, view.now) : ''}</span></div>
</div>`;
}

function failing(view: HealthView): string {
  const steps = view.health.failingSteps;
  const body = steps.length
    ? `<table><thead><tr><th>Job</th><th>Step</th><th style="width:30%"></th><th class="num">Failures</th></tr></thead><tbody>${steps
        .map(
          (item) =>
            `<tr><td>${esc(item.job)}</td><td>${esc(item.step)}</td><td><div class="meter"><div style="width:${Math.round(
              (item.count / steps[0].count) * 100
            )}%;background:var(--al-red)"></div></div></td><td class="num">${item.count}</td></tr>`
        )
        .join('')}</tbody></table>`
    : `<div class="empty">${toneIcon('success', 14)} No failed steps in the runs read.</div>`;
  return `<h2>Steps that fail most</h2><div class="list">${body}</div>`;
}

function slower(view: HealthView): string {
  const steps = view.health.slower;
  const body = steps.length
    ? `<table><thead><tr><th>Job</th><th>Step</th><th class="num">Before</th><th class="num">Last 5 runs</th><th class="num">Change</th></tr></thead><tbody>${steps
        .map(
          (item) =>
            `<tr><td>${esc(item.job)}</td><td>${esc(item.step)}</td><td class="num muted">${esc(formatDuration(item.previousMs))}</td><td class="num">${esc(
              formatDuration(item.recentMs)
            )}</td><td class="num t-failure">×${(item.recentMs / item.previousMs).toFixed(1)}</td></tr>`
        )
        .join('')}</tbody></table>`
    : `<div class="empty">No step got clearly slower (at least 1.5× and 20 s).</div>`;
  return `<h2>Steps that got slower</h2><div class="list">${body}</div>`;
}

function flaky(view: HealthView): string {
  const items = view.health.flaky;
  const body = items.length
    ? items
        .map((item) => {
          const how =
            item.reason === 'rerun'
              ? `passed on attempt ${item.passedRun.run_attempt}`
              : `failed in <a data-cmd="openRun" data-run="${item.failedRun?.id}">#${item.failedRun?.run_number}</a>, passed in the next run`;
          return `<div class="item">${toneIcon('queued', 14)}<span class="mono">${esc(item.sha.slice(0, 7))}</span><span class="grow">${
            item.branch ? `<span class="muted">${esc(item.branch)}</span> · ` : ''
          }${how}</span>${button({ cmd: 'openRun', label: `#${item.passedRun.run_number}`, kind: 'ghost', data: { run: item.passedRun.id } })}</div>`;
        })
        .join('')
    : `<div class="empty">None found.</div>`;
  return `<h2>Flaky: failed, then passed on the same commit <span class="count">${items.length}</span></h2><div class="list">${body}</div>`;
}
