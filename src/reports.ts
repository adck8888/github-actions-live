import * as vscode from 'vscode';
import { GitHubClient } from './github';
import { workflowHealth } from './health';
import { openFile, openUrl, Page } from './panels';
import { LOG_LANGUAGE, LogStore } from './logDocuments';
import { normalizeForCompare } from './logParser';
import { Job, Run, toneOf, workflowName } from './model';
import { RepoRef } from './remote';
import { renderCompare } from './webview/compareView';
import { renderHealth } from './webview/healthView';

export const REPORT_SCHEME = 'actions-report';
/** Runs to read for a health report, and how many of them to read the jobs of. */
const HEALTH_RUNS = 30;
const HEALTH_JOB_RUNS = 20;

/** Read-only documents the reports are written to. */
export class Reports implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly texts = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  dispose(): void {
    this.changed.dispose();
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.texts.get(uri.toString()) ?? '';
  }

  set(path: string, text: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: REPORT_SCHEME, path });
    this.texts.set(uri.toString(), text);
    this.changed.fire(uri);
    return uri;
  }
}

function safe(text: string): string {
  return text.replace(/[\\/:*?"<>|]/g, ' ');
}

export interface ReportActions {
  openRun: (runId: number) => unknown;
  rerunFailed: (runId: number) => unknown;
  root: () => vscode.Uri | undefined;
}

/**
 * Pro: what changed between the last green run of a workflow and this red
 * one — the commits and files in between — and a diff of the two logs of the
 * same job with times, ids and durations taken out so only real differences show.
 */
export async function compareWithLastGreen(
  reports: Reports,
  logs: LogStore,
  client: GitHubClient,
  ref: RepoRef,
  run: Run,
  job: Job | undefined,
  actions: ReportActions
): Promise<void> {
  const found = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Finding the last green run…' }, async () => {
    const before = (candidates: Run[]): Run | undefined =>
      candidates.find((candidate) => candidate.id !== run.id && Date.parse(candidate.created_at) < Date.parse(run.created_at));
    const onBranch = run.head_branch ? before(await client.runs({ workflowId: run.workflow_id, branch: run.head_branch, status: 'success', perPage: 30 })) : undefined;
    const green = onBranch ?? before(await client.runs({ workflowId: run.workflow_id, status: 'success', perPage: 30 }));
    if (!green) {
      return undefined;
    }
    const [compare, failed] = await Promise.all([
      green.head_sha === run.head_sha ? undefined : client.compare(green.head_sha, run.head_sha).catch(() => undefined),
      job ? job : client.jobs(run.id).then((jobs) => jobs.find((candidate) => toneOf(candidate) === 'failure'))
    ]);
    const twin = failed ? (await client.jobs(green.id).catch(() => [] as Job[])).find((candidate) => candidate.name === failed.name) : undefined;
    return { green, compare, failed, twin };
  });
  if (!found) {
    void vscode.window.showInformationMessage(`${workflowName(run)} has no green run before this one to compare with.`);
    return;
  }
  const { green, compare, failed, twin } = found;

  const logDiff = async (): Promise<void> => {
    if (!failed || !twin) {
      return;
    }
    const [left, right] = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Downloading both logs…' }, () =>
      Promise.all([logs.load(ref, twin.id), logs.load(ref, failed.id)])
    );
    const leftUri = reports.set(`/green/${safe(failed.name)} #${green.run_number}.log`, normalizeForCompare(left.log.text));
    const rightUri = reports.set(`/red/${safe(failed.name)} #${run.run_number}.log`, normalizeForCompare(right.log.text));
    for (const uri of [leftUri, rightUri]) {
      await vscode.languages.setTextDocumentLanguage(await vscode.workspace.openTextDocument(uri), LOG_LANGUAGE);
    }
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, `${failed.name}: last green #${green.run_number} ↔ #${run.run_number}`, {
      viewColumn: vscode.ViewColumn.Beside
    });
  };

  const body = renderCompare({
    green,
    red: run,
    compare,
    logJob: failed && twin ? failed.name : undefined,
    missingJob: failed && !twin ? failed.name : undefined,
    now: Date.now()
  });
  Page.create('actionsLive.compare', `${workflowName(run)} #${run.run_number} since green`, body, async (message) => {
    switch (message.cmd) {
      case 'logDiff':
        return logDiff();
      case 'openRun':
        return message.run && actions.openRun(Number(message.run));
      case 'rerunFailed':
        return actions.rerunFailed(run.id);
      case 'openFile':
        return openFile(actions.root(), message.path);
      case 'openUrl':
        return openUrl(message.url);
    }
    return undefined;
  });
}

/**
 * Pro: how a workflow has been doing — pass rate, how long it takes and
 * whether that is growing, which failures went away on re-run (flaky), which
 * steps fail most and which got slower.
 */
export async function workflowHealthReport(
  client: GitHubClient,
  workflow: { id: number; name: string },
  branch: string | undefined,
  actions: ReportActions
): Promise<void> {
  const read = (): Thenable<string> =>
    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Reading the history of ${workflow.name}…` }, async (progress) => {
      const runs = await client.runs({ workflowId: workflow.id, branch, perPage: HEALTH_RUNS });
      const finished = runs.filter((candidate) => candidate.status === 'completed').slice(0, HEALTH_JOB_RUNS);
      const jobs = new Map<number, Job[]>();
      for (let index = 0; index < finished.length; index += 5) {
        progress.report({ message: `jobs of ${index}/${finished.length} runs` });
        const batch = finished.slice(index, index + 5);
        const results = await Promise.all(batch.map((candidate) => client.jobs(candidate.id).catch(() => [] as Job[])));
        batch.forEach((candidate, position) => jobs.set(candidate.id, results[position]));
      }
      return renderHealth({ workflow: workflow.name, branch, runs, health: workflowHealth(runs, jobs), jobRuns: finished.length, now: Date.now() });
    });
  const title = `Health: ${workflow.name}`;
  const page: Page = Page.create('actionsLive.health', title, await read(), async (message) => {
    switch (message.cmd) {
      case 'refresh':
        return page.render(title, await read());
      case 'openRun':
        return message.run && actions.openRun(Number(message.run));
    }
    return undefined;
  });
}
