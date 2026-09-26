import { findLocations } from '../errorLocations';
import { groupJobs } from '../health';
import { Annotation, elapsed, isActive, Job, noJobs, Run, Step, toneOf, workflowName } from '../model';
import { ago, button, esc, formatBytes, glyph, liveDuration, toneIcon, toneLabel } from './html';

export interface FailureView {
  stepNumber?: number;
  stepName?: string;
  /** Lines of the rendered log, and where in them the error is. */
  lines: string[];
  firstLine: number;
  errorIndex: number;
}

export interface RunView {
  run: Run;
  jobs: Job[] | undefined;
  artifacts: Array<{ id: number; name: string; size_in_bytes: number; expired: boolean }> | undefined;
  /** Per failed job: its excerpt, or that it is still loading, or that the log has none. */
  failures: Map<number, FailureView | 'loading' | 'none'>;
  annotations: Map<number, Annotation[]>;
  /** The run belongs to the repository open in the window, so files can be opened. */
  local: boolean;
  pro: boolean;
  now: number;
}

const BEFORE_ERROR = 14;
const AFTER_ERROR = 6;

function ms(iso: string | null | undefined): number | undefined {
  const value = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(value) ? value : undefined;
}

/** The whole page of one run. */
export function renderRun(view: RunView): string {
  return [header(view), summary(view), waiting(view), failures(view), timeline(view), artifacts(view)].join('');
}

function header(view: RunView): string {
  const { run } = view;
  const tone = toneOf(run);
  const active = isActive(run);
  const started = ms(run.run_started_at ?? run.created_at);
  const took = elapsed(run.run_started_at ?? run.created_at, run.updated_at, false);
  const actor = run.triggering_actor?.login ?? run.actor?.login;
  const attempt = (run.run_attempt ?? 1) > 1 ? ` · attempt ${run.run_attempt}` : '';
  const buttons: string[] = [];
  if (run.status === 'waiting') {
    buttons.push(button({ cmd: 'review', label: 'Review deployments…', icon: 'shield', kind: 'primary' }));
  }
  if (active) {
    buttons.push(button({ cmd: 'cancel', label: 'Cancel run', icon: 'stop' }));
  } else if (tone === 'failure') {
    buttons.push(button({ cmd: 'rerunFailed', label: 'Re-run failed jobs', icon: 'rerun', kind: 'primary' }));
    buttons.push(button({ cmd: 'rerun', label: 'Re-run all', icon: 'rerun' }));
    buttons.push(button({ cmd: 'fixInChat', label: 'Fix in Chat', icon: 'sparkle' }));
    buttons.push(button({ cmd: 'compare', label: 'Compare with last green', icon: 'diff', pro: !view.pro }));
  } else {
    buttons.push(button({ cmd: 'rerun', label: 'Re-run all', icon: 'rerun' }));
  }
  if (view.local) {
    buttons.push(button({ cmd: 'health', label: 'Workflow health', icon: 'pulse', kind: 'ghost', pro: !view.pro }));
  }
  buttons.push(button({ cmd: 'openUrl', label: 'Open on GitHub', icon: 'external', kind: 'ghost', data: { url: run.html_url } }));

  return `<header class="header">
  <div class="title-row">
    <span class="pill t-${tone}">${toneIcon(tone)}${esc(run.status === 'waiting' ? 'Waiting for review' : toneLabel(tone))}</span>
    <h1>${esc(run.display_title || workflowName(run))}</h1>
  </div>
  <div class="meta">
    <span>${glyph('zap')}<b>${esc(workflowName(run))}</b>&nbsp;#${run.run_number}${attempt}</span>
    <span>${glyph('branch')}<span class="mono">${esc(run.head_branch ?? '—')}</span></span>
    <span>${glyph('commit')}<span class="mono">${esc(run.head_sha.slice(0, 7))}</span></span>
    <span>${glyph('person')}${esc(run.event)}${actor ? ` by ${esc(actor)}` : ''}</span>
    <span>${glyph('clock')}${ago(run.created_at, view.now)} · ${active ? 'running for ' : 'took '}${liveDuration(started, took, active)}</span>
  </div>
  <div class="actions">${buttons.join('')}</div>
</header>`;
}

function summary(view: RunView): string {
  const jobs = view.jobs;
  if (!jobs) {
    return `<div class="cards">${[1, 2, 3].map(() => '<div class="card"><div class="skeleton" style="width:40%"></div><div class="skeleton" style="width:70%;margin-top:10px;height:22px"></div></div>').join('')}</div>`;
  }
  const count = (tone: string): number => jobs.filter((job) => toneOf(job) === tone).length;
  const passed = count('success');
  const failed = count('failure');
  const running = count('running') + count('queued');
  const skipped = count('skipped') + count('cancelled');
  const parts = [
    passed ? `<b class="t-success">${passed} passed</b>` : '',
    failed ? `<b class="t-failure">${failed} failed</b>` : '',
    running ? `<b class="t-running">${running} running</b>` : '',
    skipped ? `${skipped} skipped` : ''
  ].filter(Boolean);

  const created = ms(view.run.created_at);
  const firstStart = Math.min(...jobs.map((job) => ms(job.started_at) ?? Infinity));
  const queued = created !== undefined && Number.isFinite(firstStart) ? Math.max(0, firstStart - created) : undefined;
  const busiest = jobs
    .map((job) => ({ job, took: elapsed(job.started_at, job.completed_at, isActive(job), view.now) ?? 0 }))
    .sort((a, b) => b.took - a.took)[0];
  const active = isActive(view.run);

  const cards = [
    `<div class="card"><div class="label">${glyph('log')}Jobs</div><div class="value">${jobs.length}</div><div class="sub">${parts.join(' · ') || '—'}</div></div>`,
    `<div class="card"><div class="label">${glyph('clock')}Duration</div><div class="value">${liveDuration(
      ms(view.run.run_started_at ?? view.run.created_at),
      elapsed(view.run.run_started_at ?? view.run.created_at, view.run.updated_at, false),
      active
    )}</div><div class="sub">${queued !== undefined ? `waited ${esc(fmt(queued))} for a runner` : '&nbsp;'}</div></div>`,
    busiest && busiest.took
      ? `<div class="card"><div class="label">${glyph('pulse')}Longest job</div><div class="value" style="font-size:1.15em;margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(busiest.job.name)}">${esc(
          busiest.job.name
        )}</div><div class="sub">${esc(fmt(busiest.took))}</div></div>`
      : '',
    view.artifacts?.length
      ? `<div class="card"><div class="label">${glyph('package')}Artifacts</div><div class="value">${view.artifacts.length}</div><div class="sub">${esc(
          formatBytes(view.artifacts.reduce((sum, item) => sum + item.size_in_bytes, 0))
        )} in total</div></div>`
      : ''
  ];
  return `<div class="cards">${cards.join('')}</div>`;
}

function waiting(view: RunView): string {
  if (view.run.status !== 'waiting') {
    if (isActive(view.run) && (view.jobs ?? []).some(isActive)) {
      return `<div class="banner info">${glyph('log', 18)}<div class="grow">GitHub serves a job's log only once the job finishes. Steps update live below; click a running job to have its log open by itself when it is done.</div></div>`;
    }
    return '';
  }
  return `<div class="banner warn">${glyph('shield', 18)}<div class="grow"><b>A deployment is waiting for review.</b> <span class="muted">The run continues once a reviewer approves it.</span></div>${button({
    cmd: 'review',
    label: 'Review…',
    kind: 'primary'
  })}</div>`;
}

function failures(view: RunView): string {
  const failed = (view.jobs ?? []).filter((job) => toneOf(job) === 'failure');
  if (!failed.length) {
    return '';
  }
  const cards = failed.map((job) => {
    const failure = view.failures.get(job.id);
    const step = typeof failure === 'object' ? failure : undefined;
    const failedStep = job.steps?.find((candidate) => candidate.conclusion === 'failure');
    const stepLabel = step?.stepName ?? failedStep?.name;
    const stepNumber = step?.stepNumber ?? failedStep?.number;
    let body = '';
    if (failure === 'loading' || failure === undefined) {
      body = `<div class="excerpt" style="padding:12px 14px">${[70, 90, 55, 80].map((width) => `<div class="skeleton" style="width:${width}%;margin:6px 0"></div>`).join('')}</div>`;
    } else if (step) {
      body = excerpt(step, view.local);
    }
    const notes = (view.annotations.get(job.id) ?? []).filter((annotation) => annotation.path !== '.github').slice(0, 8);
    const noteList = notes.length
      ? `<ul class="annotations">${notes
          .map((annotation) => {
            const level = annotation.annotation_level === 'failure' ? 'failure' : annotation.annotation_level === 'warning' ? 'queued' : 'neutral';
            const where = `${annotation.path}:${annotation.start_line}`;
            const link = view.local
              ? `<a class="mono" data-cmd="openFile" data-path="${esc(annotation.path)}" data-line="${annotation.start_line}">${esc(where)}</a>`
              : `<span class="mono">${esc(where)}</span>`;
            return `<li>${level === 'queued' ? `<span class="t-running">${glyph('warning')}</span>` : toneIcon(level as 'failure' | 'neutral', 14)}${link}<span>${esc(
              annotation.title ? `${annotation.title}: ${annotation.message}` : annotation.message
            )}</span></li>`;
          })
          .join('')}</ul>`
      : '';
    return `<section class="failure">
  <div class="failure-head">
    ${toneIcon('failure')}
    <div class="grow"><b>${esc(job.name)}</b>${stepLabel ? ` <span class="step">failed at step ${stepNumber}: ${esc(stepLabel)}</span>` : ''}</div>
    ${button({ cmd: 'openLog', label: 'Open log', icon: 'log', data: { job: job.id, step: stepNumber } })}
    ${button({ cmd: 'fixInChat', label: 'Fix in Chat', icon: 'sparkle', data: { job: job.id } })}
  </div>
  ${body}${noteList}
</section>`;
  });
  return `<h2>Why it failed <span class="count">${failed.length}</span></h2>${cards.join('')}`;
}

function excerpt(failure: FailureView, local: boolean): string {
  const from = Math.max(0, failure.errorIndex - BEFORE_ERROR);
  const to = Math.min(failure.lines.length, failure.errorIndex + AFTER_ERROR + 1);
  const rows = failure.lines.slice(from, to).map((line, offset) => {
    const index = from + offset;
    const number = failure.firstLine + index + 1;
    return `<div class="ln${index === failure.errorIndex ? ' err' : ''}"><span class="no">${number}</span><span>${local ? linkify(line) : esc(line)}</span></div>`;
  });
  return `<div class="excerpt">${rows.join('')}</div>`;
}

/** Turns `src/a.ts:12:3` in a log line into a link that opens the file. */
function linkify(line: string): string {
  const locations = findLocations(line).filter((location) => !location.path.startsWith('/') && !/^[A-Za-z]:/.test(location.path));
  if (!locations.length) {
    return esc(line);
  }
  let out = '';
  let last = 0;
  for (const location of locations.sort((a, b) => a.start - b.start)) {
    if (location.start < last) {
      continue;
    }
    out += esc(line.slice(last, location.start));
    out += `<a data-cmd="openFile" data-path="${esc(location.path)}" data-line="${location.line}"${location.column ? ` data-column="${location.column}"` : ''}>${esc(
      line.slice(location.start, location.end)
    )}</a>`;
    last = location.end;
  }
  return out + esc(line.slice(last));
}

const TICKS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200].map((seconds) => seconds * 1000);

function fmt(value: number): string {
  const seconds = Math.round(value / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return seconds % 60 ? `${minutes}m ${String(seconds % 60).padStart(2, '0')}s` : `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function tickLabel(value: number): string {
  if (value === 0) {
    return '0';
  }
  const seconds = Math.round(value / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = seconds / 60;
  return minutes < 60 ? `${Math.round(minutes * 10) / 10}m` : `${Math.round((minutes / 60) * 10) / 10}h`;
}

/** Jobs and their steps on one time axis: where the time of the run went. */
function timeline(view: RunView): string {
  const jobs = view.jobs;
  if (!jobs) {
    return `<h2>Jobs</h2><div class="timeline" style="padding:14px">${[1, 2, 3].map(() => '<div class="skeleton" style="margin:10px 0"></div>').join('')}</div>`;
  }
  if (!jobs.length) {
    return `<h2>Jobs</h2><div class="timeline"><div class="empty">${esc(noJobs(view.run))}.</div></div>`;
  }
  const starts = jobs.map((job) => ms(job.started_at)).filter((value): value is number => value !== undefined);
  const origin = Math.min(ms(view.run.run_started_at ?? view.run.created_at) ?? Infinity, ...starts);
  const endOf = (job: Job): number | undefined => (isActive(job) ? (ms(job.started_at) !== undefined ? view.now : undefined) : ms(job.completed_at));
  const ends = jobs.map(endOf).filter((value): value is number => value !== undefined);
  const span = Math.max(1000, (ends.length ? Math.max(...ends) : view.now) - origin);
  const step = TICKS.find((candidate) => span / candidate <= 6) ?? TICKS[TICKS.length - 1];
  const ticks: number[] = [];
  for (let at = 0; at <= span; at += step) {
    ticks.push(at);
  }
  const pct = (value: number): number => Math.max(0, Math.min(100, (value / span) * 100));
  const grid = ticks.map((at) => `<div class="grid-line" style="left:${pct(at)}%"></div>`).join('');

  const row = (job: Job, child: boolean): string => {
    const tone = toneOf(job);
    const start = ms(job.started_at);
    const end = endOf(job);
    const took = elapsed(job.started_at, job.completed_at, isActive(job), view.now);
    let track = grid;
    if (start === undefined || end === undefined) {
      track += `<div class="tl-note">${tone === 'skipped' ? 'skipped' : job.status === 'waiting' ? 'waiting' : 'queued'}</div>`;
    } else {
      const left = pct(start - origin);
      const width = Math.max(0.4, pct(end - origin) - left);
      if (left > 0.5) {
        track += `<div class="wait" style="left:0;width:${left}%" title="Waited ${esc(fmt(Math.max(0, start - origin)))}"></div>`;
      }
      track += `<div class="bar" style="left:${left}%;width:${width}%">${segments(job, start, end)}</div>`;
    }
    const time = isActive(job) && start !== undefined ? liveDuration(start, undefined, true) : took !== undefined ? esc(fmt(took)) : '';
    return `<div class="tl-row${child ? ' child' : ''}">
  <div class="tl-name" data-cmd="openLog" data-job="${job.id}" title="${esc(`${job.name} — ${toneLabel(tone)}`)}">${toneIcon(tone, 14)}<span>${esc(job.name)}</span></div>
  <div class="track">${track}</div>
  <div class="tl-time">${time}</div>
</div>`;
  };

  const rows = groupJobs(jobs)
    .map((entry) => {
      if (entry.kind === 'job') {
        return row(entry.job, false);
      }
      const failed = entry.jobs.filter((job) => toneOf(job) === 'failure').length;
      return `<div class="tl-row group"><div>${esc(entry.name)} <span class="muted">· matrix of ${entry.jobs.length}${failed ? `, <span class="t-failure">${failed} failed</span>` : ''}</span></div><div></div><div></div></div>${entry.jobs
        .map((job) => row(job, true))
        .join('')}`;
    })
    .join('');

  const axis = `<div class="tl-axis"><div></div><div class="track">${ticks
    .map((at) => `<span class="tick" style="left:${pct(at)}%">${tickLabel(at)}</span>`)
    .join('')}</div><div></div></div>`;
  const legend = `<div class="legend"><span><i style="background:color-mix(in srgb,var(--al-green) 70%,transparent)"></i>passed step</span><span><i style="background:var(--al-red)"></i>failed step</span><span><i style="background:var(--al-yellow)"></i>running</span><span><i style="background:repeating-linear-gradient(90deg,var(--al-gray) 0 3px,transparent 3px 6px);height:2px;vertical-align:3px"></i>waiting for a runner</span><span class="grow"></span><span>Click a job or a step to open its log</span></div>`;
  return `<h2>Timeline <span class="count">${jobs.length}</span></h2><div class="timeline">${axis}${rows}${legend}</div>`;
}

function segments(job: Job, start: number, end: number): string {
  const steps = (job.steps ?? []).filter((candidate) => candidate.conclusion !== 'skipped' && ms(candidate.started_at) !== undefined);
  const total = Math.max(1, end - start);
  if (!steps.length) {
    return `<div class="seg t-${toneOf(job)}" style="width:100%" data-cmd="openLog" data-job="${job.id}"></div>`;
  }
  return steps
    .map((candidate: Step) => {
      const tone = toneOf(candidate);
      const from = ms(candidate.started_at)!;
      const to = isActive(candidate) ? end : (ms(candidate.completed_at) ?? from);
      const width = Math.max(0.5, ((to - from) / total) * 100);
      return `<div class="seg t-${tone}" style="flex:${width} 0 0" data-cmd="openLog" data-job="${job.id}" data-step="${candidate.number}" title="${esc(
        `${candidate.number}. ${candidate.name} — ${toneLabel(tone)} · ${fmt(Math.max(0, to - from))}`
      )}"></div>`;
    })
    .join('');
}

function artifacts(view: RunView): string {
  if (!view.artifacts?.length) {
    return '';
  }
  const rows = view.artifacts
    .map(
      (artifact) => `<div class="item">${glyph('package', 16)}<span class="grow">${esc(artifact.name)}</span><span class="muted">${
        artifact.expired ? 'expired' : esc(formatBytes(artifact.size_in_bytes))
      }</span>${artifact.expired ? '' : button({ cmd: 'download', label: 'Download', icon: 'download', kind: 'ghost', data: { artifact: artifact.id } })}</div>`
    )
    .join('');
  return `<h2>Artifacts <span class="count">${view.artifacts.length}</span></h2><div class="list">${rows}</div>`;
}
