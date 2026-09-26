import * as vscode from 'vscode';
import { sameRepo } from './git';
import { Artifact, GitHubClient } from './github';
import { LogStore } from './logDocuments';
import { Annotation, isActive, Job, Run, toneOf, workflowName } from './model';
import { RepoRef } from './remote';
import { RunsService } from './runsService';
import { page } from './webview/html';
import { FailureView, renderRun } from './webview/runView';

/** What the pages need from the rest of the extension. */
export interface PanelHost {
  service: RunsService;
  logs: LogStore;
  isPro: () => boolean;
  clientFor: (ref?: RepoRef) => GitHubClient | undefined;
  root: () => vscode.Uri | undefined;
}

export type Message = Record<string, string | undefined> & { cmd?: string };

function nonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let index = 0; index < 32; index++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

function number(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return value && Number.isFinite(parsed) ? parsed : undefined;
}

/** A webview tab showing one of the extension's pages, re-rendered in place. */
export class Page implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly closed = new vscode.EventEmitter<void>();
  readonly onDidClose = this.closed.event;
  private title: string;
  private body: string;

  constructor(
    readonly panel: vscode.WebviewPanel,
    title: string,
    body: string,
    onMessage: (message: Message) => unknown
  ) {
    this.title = title;
    this.body = body;
    this.load();
    this.disposables.push(
      // A hidden tab loses its page; it is built again from the latest content when it comes back.
      panel.onDidChangeViewState((event) => {
        if (event.webviewPanel.visible) {
          this.load();
        }
      }),
      panel.webview.onDidReceiveMessage(async (message: Message) => {
        try {
          await onMessage(message);
        } catch (error) {
          void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        }
      }),
      panel.onDidDispose(() => {
        this.closed.fire();
        this.dispose();
      })
    );
  }

  static create(viewType: string, title: string, body: string, onMessage: (message: Message) => unknown, preserveFocus = false): Page {
    const panel = vscode.window.createWebviewPanel(viewType, title, { viewColumn: vscode.ViewColumn.Active, preserveFocus }, { enableScripts: true, retainContextWhenHidden: false });
    panel.iconPath = new vscode.ThemeIcon('github-action');
    return new Page(panel, title, body, onMessage);
  }

  private load(): void {
    this.panel.title = this.title;
    this.panel.webview.html = page({ title: this.title, body: this.body, cspSource: this.panel.webview.cspSource, nonce: nonce() });
  }

  render(title: string, body: string): void {
    this.title = title;
    this.body = body;
    this.panel.title = title;
    if (this.panel.visible) {
      void this.panel.webview.postMessage({ type: 'render', html: body });
    }
  }

  dispose(): void {
    this.closed.dispose();
    this.disposables.forEach((disposable) => disposable.dispose());
    this.disposables.length = 0;
  }
}

/** Opens a `http(s)` link from a page; anything else is ignored. */
export function openUrl(url: string | undefined): void {
  if (url && /^https?:\/\//.test(url)) {
    void vscode.env.openExternal(vscode.Uri.parse(url));
  }
}

/** Opens a file of the workspace at a line, when the file is there. */
export async function openFile(root: vscode.Uri | undefined, path: string | undefined, line?: number, column?: number): Promise<void> {
  if (!root || !path || path.includes('..')) {
    return;
  }
  const uri = vscode.Uri.joinPath(root, path);
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    void vscode.window.showWarningMessage(`${path} is not in this workspace.`);
    return;
  }
  const position = new vscode.Position(Math.max(0, (line ?? 1) - 1), Math.max(0, (column ?? 1) - 1));
  await vscode.window.showTextDocument(uri, { selection: new vscode.Range(position, position), viewColumn: vscode.ViewColumn.One });
}

/**
 * One tab for the run someone is looking at: what failed and why, where the
 * time went, and every action on the run. It follows the run live and is
 * reused when another run is opened.
 */
export class RunPanel implements vscode.Disposable {
  private page: Page | undefined;
  private runId: number | undefined;
  private ref: RepoRef | undefined;
  private run: Run | undefined;
  /** Jobs of runs of another repository, which the Runs view does not follow. */
  private foreignJobs: Job[] | undefined;
  private artifacts: Artifact[] | undefined;
  private readonly failures = new Map<number, FailureView | 'loading' | 'none'>();
  private readonly annotations = new Map<number, Annotation[]>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly host: PanelHost) {
    this.disposables.push(
      host.service.onDidChange(() => this.schedule()),
      host.service.onDidChangeJobs((runId) => {
        if (runId === this.runId) {
          this.schedule();
        }
      })
    );
  }

  dispose(): void {
    this.stop();
    this.page?.panel.dispose();
    this.disposables.forEach((disposable) => disposable.dispose());
  }

  get openRunId(): number | undefined {
    return this.page ? this.runId : undefined;
  }

  /** Opens the run's tab; `preserveFocus` keeps the keyboard where it is, for clicks in the Runs view. */
  async show(runId: number, ref?: RepoRef, preserveFocus = false): Promise<void> {
    const own = !ref || sameRepo(ref, this.host.service.workspace?.ref);
    if (this.runId !== runId || !sameRepo(ref ?? this.host.service.workspace?.ref, this.ref)) {
      // A render or poll of the previous run must not draw while the new one loads.
      this.stop();
      if (this.runId !== undefined) {
        this.host.service.release(this.runId);
      }
      this.runId = runId;
      this.ref = own ? this.host.service.workspace?.ref : ref;
      this.run = undefined;
      this.foreignJobs = undefined;
      this.artifacts = undefined;
      this.failures.clear();
      this.annotations.clear();
    }
    const run = (own ? this.host.service.findRun(runId) : undefined) ?? (await this.host.clientFor(this.ref)?.run(runId));
    if (!run || runId !== this.runId) {
      return;
    }
    this.run = run;
    const title = this.title();
    const body = this.body();
    if (this.page) {
      this.page.render(title, body);
      this.page.panel.reveal(undefined, preserveFocus);
    } else {
      this.page = Page.create('actionsLive.run', title, body, (message) => this.onMessage(message), preserveFocus);
      this.page.onDidClose(() => {
        this.stop();
        if (this.runId !== undefined) {
          this.host.service.release(this.runId);
        }
        this.page = undefined;
      });
    }
    this.startPolling();
  }

  private title(): string {
    return this.run ? `${toneOf(this.run) === 'failure' ? '✖' : toneOf(this.run) === 'success' ? '✓' : '●'} ${workflowName(this.run)} #${this.run.run_number}` : 'Run';
  }

  private get own(): boolean {
    return sameRepo(this.ref, this.host.service.workspace?.ref);
  }

  private stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.poll) {
      clearInterval(this.poll);
      this.poll = undefined;
    }
  }

  /** Runs of another repository are not refreshed by the Runs view, so the panel asks GitHub itself. */
  private startPolling(): void {
    if (this.poll || this.own) {
      return;
    }
    this.poll = setInterval(() => {
      if (!this.page || !this.run || this.own || !isActive(this.run)) {
        return;
      }
      const client = this.host.clientFor(this.ref);
      void Promise.all([client?.run(this.run.id), client?.jobs(this.run.id)])
        .then(([run, jobs]) => {
          if (run && run.id === this.runId) {
            this.run = run;
            this.foreignJobs = jobs;
            this.schedule();
          }
        })
        .catch(() => undefined);
    }, 8000);
  }

  private schedule(): void {
    if (!this.page || this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.page || this.runId === undefined || !this.run) {
        return;
      }
      if (this.own) {
        this.run = this.host.service.findRun(this.runId) ?? this.run;
      }
      this.page.render(this.title(), this.body());
    }, 150);
  }

  private jobs(): Job[] | undefined {
    if (!this.run) {
      return undefined;
    }
    if (this.own) {
      return this.host.service.jobsOf(this.run);
    }
    if (!this.foreignJobs) {
      const runId = this.run.id;
      void this.host
        .clientFor(this.ref)
        ?.jobs(runId)
        .then((jobs) => {
          if (runId === this.runId) {
            this.foreignJobs = jobs;
            this.schedule();
          }
        })
        .catch(() => undefined);
    }
    return this.foreignJobs;
  }

  private body(): string {
    const run = this.run!;
    const jobs = this.jobs();
    if (!isActive(run) && this.artifacts === undefined) {
      // Artifacts are downloaded through the Runs view's repository only.
      this.artifacts = this.own ? this.host.service.artifactsOf(run) : [];
    }
    for (const job of jobs ?? []) {
      if (toneOf(job) === 'failure' && !isActive(job) && !this.failures.has(job.id)) {
        this.loadFailure(run.id, job);
      }
    }
    return renderRun({
      run,
      jobs,
      artifacts: this.artifacts,
      failures: this.failures,
      annotations: this.annotations,
      local: this.own && !!this.host.root(),
      pro: this.host.isPro(),
      now: Date.now()
    });
  }

  /** Downloads a failed job's log for the excerpt around its error, and its annotations. */
  private loadFailure(runId: number, job: Job): void {
    const ref = this.ref;
    if (!ref) {
      return;
    }
    this.failures.set(job.id, 'loading');
    const client = this.host.clientFor(ref);
    void Promise.all([this.host.logs.load(ref, job.id).catch(() => undefined), client?.annotations(job.id).catch(() => [] as Annotation[])]).then(([loaded, annotations]) => {
      if (runId !== this.runId) {
        return;
      }
      const failure = loaded?.log.failures[0];
      this.failures.set(
        job.id,
        failure
          ? {
              stepNumber: failure.stepNumber,
              stepName: failure.stepName,
              lines: failure.lines,
              firstLine: failure.startLine,
              errorIndex: Math.max(0, Math.min(failure.lines.length - 1, failure.errorLine - failure.startLine))
            }
          : 'none'
      );
      this.annotations.set(job.id, annotations ?? []);
      this.schedule();
    });
  }

  private async onMessage(message: Message): Promise<void> {
    const runId = this.runId;
    if (runId === undefined) {
      return;
    }
    const run = { kind: 'run' as const, runId };
    const jobId = number(message.job);
    const ref = this.own ? undefined : this.ref;
    switch (message.cmd) {
      case 'openLog': {
        if (jobId === undefined) {
          return;
        }
        const step = number(message.step);
        const target = step !== undefined ? { kind: 'step' as const, runId, jobId, number: step } : { kind: 'job' as const, runId, jobId };
        await vscode.commands.executeCommand('actionsLive.openLog', target, ref);
        return;
      }
      case 'fixInChat':
        await vscode.commands.executeCommand('actionsLive.fixInChat', jobId !== undefined ? { kind: 'job', runId, jobId } : run, ref);
        return;
      case 'rerun':
      case 'rerunFailed':
      case 'cancel':
        await vscode.commands.executeCommand(`actionsLive.${message.cmd}`, run, ref);
        return;
      case 'review':
        await vscode.commands.executeCommand('actionsLive.reviewDeployments', run, ref);
        return;
      case 'compare':
        await vscode.commands.executeCommand('actionsLive.compareWithLastGreen', run, ref);
        return;
      case 'health':
        await vscode.commands.executeCommand('actionsLive.workflowHealth', this.own ? run : undefined);
        return;
      case 'download': {
        const artifactId = number(message.artifact);
        if (artifactId !== undefined) {
          await vscode.commands.executeCommand('actionsLive.downloadArtifact', { kind: 'artifact', runId, artifactId }, ref);
        }
        return;
      }
      case 'openFile':
        if (this.own) {
          await openFile(this.host.root(), message.path, number(message.line), number(message.column));
        }
        return;
      case 'openUrl':
        openUrl(message.url);
        return;
    }
  }
}
