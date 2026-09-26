import * as vscode from 'vscode';
import { CheckItem, describeMergeState } from './checks';
import { groupJobs } from './health';
import { elapsed, formatAgo, formatDuration, isActive, Job, noJobs, Run, runDuration, Step, Tone, toneOf, workflowName } from './model';
import { RunsService } from './runsService';

export type Node =
  | { kind: 'message'; text: string; tone: 'error' | 'info' }
  | { kind: 'pull' }
  | { kind: 'check'; name: string }
  | { kind: 'run'; runId: number }
  | { kind: 'group'; runId: number; name: string }
  | { kind: 'job'; runId: number; jobId: number }
  | { kind: 'step'; runId: number; jobId: number; number: number }
  | { kind: 'artifacts'; runId: number }
  | { kind: 'artifact'; runId: number; artifactId: number }
  | { kind: 'loading'; runId: number }
  | { kind: 'more' };

const ICONS: Record<Tone, [string, string | undefined]> = {
  queued: ['clock', 'charts.yellow'],
  running: ['sync~spin', 'charts.yellow'],
  success: ['pass', 'testing.iconPassed'],
  failure: ['error', 'testing.iconFailed'],
  cancelled: ['circle-slash', 'disabledForeground'],
  skipped: ['debug-step-over', 'disabledForeground'],
  neutral: ['circle-large-outline', undefined],
  attention: ['shield', 'charts.yellow']
};

export function toneIcon(tone: Tone): vscode.ThemeIcon {
  const [id, color] = ICONS[tone];
  return new vscode.ThemeIcon(id, color ? new vscode.ThemeColor(color) : undefined);
}

/** The pull request of the branch, then runs with their jobs and steps, in the Actions Live side bar. */
export class RunsTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly runNodes = new Map<number, Node>();
  private readonly jobNodes = new Map<number, Node>();
  private readonly groupNodes = new Map<string, Node>();
  private readonly pullNode: Node = { kind: 'pull' };
  private readonly moreNode: Node = { kind: 'more' };
  private readonly disposables: vscode.Disposable[] = [];
  private readonly ticker: ReturnType<typeof setInterval>;

  constructor(private readonly service: RunsService) {
    this.disposables.push(
      service.onDidChange(() => this.changed.fire(undefined)),
      service.onDidChangeJobs((runId) => {
        const node = this.runNodes.get(runId);
        this.changed.fire(node);
      })
    );
    // Elapsed times of running jobs move even when GitHub has nothing new to say.
    this.ticker = setInterval(() => {
      if (service.runs.some(isActive) && vscode.window.state.focused) {
        this.changed.fire(undefined);
      }
    }, 5000);
  }

  dispose(): void {
    clearInterval(this.ticker);
    this.disposables.forEach((item) => item.dispose());
    this.changed.dispose();
  }

  runNode(runId: number): Node {
    let node = this.runNodes.get(runId);
    if (!node) {
      node = { kind: 'run', runId };
      this.runNodes.set(runId, node);
    }
    return node;
  }

  private jobNode(runId: number, jobId: number): Node {
    let node = this.jobNodes.get(jobId);
    if (!node) {
      node = { kind: 'job', runId, jobId };
      this.jobNodes.set(jobId, node);
    }
    return node;
  }

  private groupNode(runId: number, name: string): Node {
    const key = `${runId}/${name}`;
    let node = this.groupNodes.get(key);
    if (!node) {
      node = { kind: 'group', runId, name };
      this.groupNodes.set(key, node);
    }
    return node;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const rows: Node[] = [];
      if (this.service.message) {
        rows.push({ kind: 'message', text: this.service.message, tone: 'error' });
      }
      if (this.service.pull) {
        rows.push(this.pullNode);
      }
      rows.push(...this.service.runs.map((run) => this.runNode(run.id)));
      if (this.service.hasMore) {
        rows.push(this.moreNode);
      }
      return rows;
    }
    switch (node.kind) {
      case 'pull':
        return (this.service.headChecks?.items ?? []).map((item) => ({ kind: 'check', name: item.name }));
      case 'run': {
        const run = this.service.findRun(node.runId);
        if (!run) {
          return [];
        }
        const jobs = this.service.jobsOf(run);
        if (!jobs) {
          return [{ kind: 'loading', runId: run.id }];
        }
        const rows: Node[] = groupJobs(jobs).map((entry) => (entry.kind === 'group' ? this.groupNode(run.id, entry.name) : this.jobNode(run.id, entry.job.id)));
        if (!jobs.length) {
          rows.push({ kind: 'message', text: noJobs(run), tone: 'info' });
        }
        if (!isActive(run)) {
          const artifacts = this.service.artifactsOf(run);
          if (artifacts?.length) {
            rows.push({ kind: 'artifacts', runId: run.id });
          }
        }
        return rows;
      }
      case 'group': {
        const entry = this.groupEntry(node.runId, node.name);
        return (entry?.jobs ?? []).map((job) => this.jobNode(node.runId, job.id));
      }
      case 'job': {
        const job = this.job(node.runId, node.jobId);
        return (job?.steps ?? []).map((step) => ({ kind: 'step', runId: node.runId, jobId: node.jobId, number: step.number }));
      }
      case 'artifacts': {
        const run = this.service.findRun(node.runId);
        return (run ? this.service.artifactsOf(run) ?? [] : []).map((artifact) => ({ kind: 'artifact', runId: node.runId, artifactId: artifact.id }));
      }
      default:
        return [];
    }
  }

  getParent(node: Node): Node | undefined {
    switch (node.kind) {
      case 'job': {
        const run = this.service.findRun(node.runId);
        const jobs = run ? this.service.jobsOf(run) : undefined;
        const job = jobs?.find((candidate) => candidate.id === node.jobId);
        const group = job && jobs ? groupJobs(jobs).find((entry) => entry.kind === 'group' && entry.jobs.includes(job)) : undefined;
        return group?.kind === 'group' ? this.groupNode(node.runId, group.name) : this.runNode(node.runId);
      }
      case 'group':
      case 'loading':
      case 'artifacts':
        return this.runNode(node.runId);
      case 'artifact':
        return { kind: 'artifacts', runId: node.runId };
      case 'step':
        return this.jobNode(node.runId, node.jobId);
      case 'check':
        return this.pullNode;
      default:
        return undefined;
    }
  }

  job(runId: number, jobId: number): Job | undefined {
    const run = this.service.findRun(runId);
    return run ? this.service.jobsOf(run)?.find((job) => job.id === jobId) : undefined;
  }

  private groupEntry(runId: number, name: string): { jobs: Job[] } | undefined {
    const run = this.service.findRun(runId);
    const jobs = run ? this.service.jobsOf(run) : undefined;
    const entry = jobs ? groupJobs(jobs).find((candidate) => candidate.kind === 'group' && candidate.name === name) : undefined;
    return entry?.kind === 'group' ? entry : undefined;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'message': {
        const item = new vscode.TreeItem(node.text);
        item.iconPath = new vscode.ThemeIcon(node.tone === 'error' ? 'warning' : 'info', new vscode.ThemeColor(node.tone === 'error' ? 'problemsWarningIcon.foreground' : 'foreground'));
        item.tooltip = node.text;
        item.command = { command: 'actionsLive.refresh', title: 'Retry' };
        return item;
      }
      case 'loading': {
        const item = new vscode.TreeItem('Loading jobs…');
        item.iconPath = new vscode.ThemeIcon('loading~spin');
        return item;
      }
      case 'more': {
        const item = new vscode.TreeItem('Load more runs');
        item.iconPath = new vscode.ThemeIcon('ellipsis');
        item.command = { command: 'actionsLive.loadMore', title: 'Load More' };
        return item;
      }
      case 'pull':
        return this.pullItem();
      case 'check':
        return this.checkItem(node);
      case 'run':
        return this.runItem(node);
      case 'group':
        return this.groupItem(node);
      case 'job':
        return this.jobItem(node);
      case 'step':
        return this.stepItem(node);
      case 'artifacts': {
        const run = this.service.findRun(node.runId);
        const count = run ? this.service.artifactsOf(run)?.length ?? 0 : 0;
        const item = new vscode.TreeItem('Artifacts', vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `artifacts-${node.runId}`;
        item.iconPath = new vscode.ThemeIcon('package');
        item.description = String(count);
        return item;
      }
      case 'artifact':
        return this.artifactItem(node);
    }
  }

  private pullItem(): vscode.TreeItem {
    const pull = this.service.pull!;
    const checks = this.service.headChecks;
    const item = new vscode.TreeItem(`#${pull.number} ${pull.title}`, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `pull-${pull.number}`;
    item.iconPath = checks && checks.tone !== 'none' ? toneIcon(checks.tone) : new vscode.ThemeIcon('git-pull-request');
    const merge = describeMergeState(pull.mergeable_state, pull.draft);
    const counts = checks && checks.total ? (checks.failed.length ? `${checks.failed.length} of ${checks.total} checks failing` : `${checks.done}/${checks.total} checks`) : undefined;
    item.description = [counts, merge].filter(Boolean).join(' · ');
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`$(git-pull-request) **${escape(pull.title)}** #${pull.number}\n\n`);
    md.appendMarkdown(`${escape(pull.head.ref)} → ${escape(pull.base.ref)}${merge ? ` · ${merge}` : ''}\n\n`);
    if (checks) {
      md.appendMarkdown(`All checks of the head commit, including those of other apps: ${checks.done}/${checks.total} done, ${checks.failed.length} failing.`);
    }
    item.tooltip = md;
    item.contextValue = 'pull';
    return item;
  }

  private checkItem(node: Extract<Node, { kind: 'check' }>): vscode.TreeItem {
    const check = this.service.headChecks?.items.find((candidate) => candidate.name === node.name);
    const item = new vscode.TreeItem(node.name);
    if (!check) {
      return item;
    }
    item.id = `check-${check.source}-${check.name}`;
    item.iconPath = toneIcon(check.tone);
    item.description = sourceLabel(check);
    item.tooltip = `${check.name} — ${label(check.tone)}${check.url ? '\n\nClick to open it.' : ''}`;
    if (check.url) {
      item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.parse(check.url)] };
    }
    return item;
  }

  private runItem(node: Extract<Node, { kind: 'run' }>): vscode.TreeItem {
    const run = this.service.findRun(node.runId);
    if (!run) {
      return new vscode.TreeItem('Run no longer listed');
    }
    const tone = toneOf(run);
    const onHead = run.head_sha === this.service.workspace?.head;
    const item = new vscode.TreeItem(
      run.display_title || workflowName(run),
      // The run of the commit you are on opens by itself while it is going, so its steps show.
      isActive(run) && onHead ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
    );
    item.id = `run-${run.id}-${run.run_attempt ?? 1}`;
    item.iconPath = run.status === 'waiting' ? new vscode.ThemeIcon('shield', new vscode.ThemeColor('charts.yellow')) : toneIcon(tone);
    const duration = runDuration(run);
    const time = isActive(run) ? (duration !== undefined ? formatDuration(duration) : '') : formatAgo(run.updated_at);
    item.description = [run.status === 'waiting' ? 'waiting for review' : tone === 'attention' ? 'needs approval' : undefined, workflowName(run), run.head_branch, time]
      .filter(Boolean)
      .join(' · ');
    item.tooltip = runTooltip(run, onHead);
    item.contextValue = run.status === 'waiting' ? 'run-active-waiting' : isActive(run) ? 'run-active' : tone === 'failure' ? 'run-failed' : 'run-done';
    item.command = { command: 'actionsLive.openRun', title: 'Open Run', arguments: [node] };
    return item;
  }

  private groupItem(node: Extract<Node, { kind: 'group' }>): vscode.TreeItem {
    const jobs = this.groupEntry(node.runId, node.name)?.jobs ?? [];
    const tones = jobs.map(toneOf);
    const tone: Tone = tones.includes('failure')
      ? 'failure'
      : tones.includes('running')
        ? 'running'
        : tones.includes('queued')
          ? 'queued'
          : tones.every((value) => value === 'skipped')
            ? 'skipped'
            : tones.every((value) => value === 'cancelled')
              ? 'cancelled'
              : 'success';
    const failed = tones.filter((value) => value === 'failure').length;
    const done = jobs.filter((job) => !isActive(job)).length;
    const item = new vscode.TreeItem(node.name, tone === 'failure' || tone === 'running' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `group-${node.runId}-${node.name}`;
    item.iconPath = toneIcon(tone);
    item.description = `matrix · ${failed ? `${failed} failed · ` : ''}${done}/${jobs.length}`;
    return item;
  }

  private jobItem(node: Extract<Node, { kind: 'job' }>): vscode.TreeItem {
    const job = this.job(node.runId, node.jobId);
    if (!job) {
      return new vscode.TreeItem('Job');
    }
    const tone = toneOf(job);
    const active = isActive(job);
    const item = new vscode.TreeItem(
      job.name,
      job.steps?.length ? (active ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed) : vscode.TreeItemCollapsibleState.None
    );
    item.id = `job-${job.id}`;
    item.iconPath = toneIcon(tone);
    const took = elapsed(job.started_at, job.completed_at, active);
    item.description = job.status === 'queued' || job.status === 'waiting' ? job.status : took !== undefined ? formatDuration(took) : '';
    if (active) {
      const current = job.steps?.find((step) => step.status === 'in_progress');
      if (current) {
        item.description = `${item.description} · ${current.name}`;
      }
    }
    item.tooltip = `${job.name} — ${label(tone)}${took !== undefined ? ` in ${formatDuration(took)}` : ''}${
      active ? '\n\nGitHub serves a job’s log once the job finishes. Click to have it open by itself then.' : '\n\nClick to open the log.'
    }`;
    item.contextValue = active ? 'job-active' : tone === 'failure' ? 'job-failed' : 'job-done';
    item.command = { command: 'actionsLive.openLog', title: 'Open Log', arguments: [node] };
    return item;
  }

  private stepItem(node: Extract<Node, { kind: 'step' }>): vscode.TreeItem {
    const job = this.job(node.runId, node.jobId);
    const step = job?.steps?.find((candidate) => candidate.number === node.number);
    if (!job || !step) {
      return new vscode.TreeItem('Step');
    }
    const tone = toneOf(step);
    const item = new vscode.TreeItem(step.name);
    item.id = `step-${job.id}-${step.number}`;
    item.iconPath = toneIcon(tone);
    const took = elapsed(step.started_at, step.completed_at, isActive(step));
    item.description = tone === 'skipped' ? 'skipped' : took !== undefined ? formatDuration(took) : '';
    item.tooltip = stepTooltip(step, tone, took);
    item.contextValue = 'step';
    if (tone !== 'skipped') {
      item.command = { command: 'actionsLive.openLog', title: 'Open Log', arguments: [node] };
    }
    return item;
  }

  private artifactItem(node: Extract<Node, { kind: 'artifact' }>): vscode.TreeItem {
    const run = this.service.findRun(node.runId);
    const artifact = run ? this.service.artifactsOf(run)?.find((candidate) => candidate.id === node.artifactId) : undefined;
    const item = new vscode.TreeItem(artifact?.name ?? 'Artifact');
    if (!artifact) {
      return item;
    }
    item.id = `artifact-${artifact.id}`;
    item.iconPath = new vscode.ThemeIcon(artifact.expired ? 'trash' : 'file-zip');
    item.description = artifact.expired ? 'expired' : formatBytes(artifact.size_in_bytes);
    item.tooltip = artifact.expired ? 'GitHub has deleted this artifact.' : 'Click to download and unzip it.';
    item.contextValue = artifact.expired ? 'artifact-expired' : 'artifact';
    if (!artifact.expired) {
      item.command = { command: 'actionsLive.downloadArtifact', title: 'Download', arguments: [node] };
    }
    return item;
  }
}

function sourceLabel(check: CheckItem): string {
  if (check.source === 'github-actions') {
    return 'Actions';
  }
  return check.source === 'status' ? 'status' : check.source;
}

function label(tone: Tone): string {
  return {
    queued: 'queued',
    running: 'in progress',
    success: 'succeeded',
    failure: 'failed',
    cancelled: 'cancelled',
    skipped: 'skipped',
    neutral: 'finished',
    attention: 'waiting for a maintainer to approve it'
  }[tone];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function runTooltip(run: Run, onHead: boolean): vscode.MarkdownString {
  const tone = toneOf(run);
  const duration = runDuration(run);
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**${escape(run.display_title || workflowName(run))}**\n\n`);
  md.appendMarkdown(`${escape(workflowName(run))} #${run.run_number}${(run.run_attempt ?? 1) > 1 ? ` (attempt ${run.run_attempt})` : ''} — ${run.status === 'waiting' ? 'waiting for a deployment review' : label(tone)}`);
  if (duration !== undefined && tone !== 'attention') {
    md.appendMarkdown(` ${isActive(run) ? 'for' : 'in'} ${formatDuration(duration)}`);
  }
  md.appendMarkdown(`\n\n$(git-branch) ${escape(run.head_branch ?? '')} · $(git-commit) \`${run.head_sha.slice(0, 7)}\`${onHead ? ' (your current commit)' : ''}`);
  md.appendMarkdown(`\n\n$(zap) ${escape(run.event)}${run.triggering_actor ? ` by ${escape(run.triggering_actor.login)}` : ''} · ${formatAgo(run.created_at)}`);
  return md;
}

function stepTooltip(step: Step, tone: Tone, took: number | undefined): string {
  return `${step.number}. ${step.name} — ${label(tone)}${took !== undefined ? ` in ${formatDuration(took)}` : ''}`;
}

function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
