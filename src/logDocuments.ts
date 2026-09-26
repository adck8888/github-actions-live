import * as vscode from 'vscode';
import { GitHubClient } from './github';
import { findLocations } from './errorLocations';
import { RenderedLog, renderLog } from './logParser';
import { Job } from './model';
import { RepoRef } from './remote';

export const LOG_SCHEME = 'actions-log';
export const LOG_LANGUAGE = 'actions-log';

export interface LoadedLog {
  ref: RepoRef;
  job: Job;
  log: RenderedLog;
}

/** Builds the URI a job's log opens under; its last segment is the tab title. */
export function logUri(ref: RepoRef, job: { id: number; name: string; run_id: number }): vscode.Uri {
  const name = job.name.replace(/[\\/:*?"<>|#%]+/g, ' ').trim() || `job ${job.id}`;
  return vscode.Uri.from({
    scheme: LOG_SCHEME,
    path: `/${ref.owner}/${ref.repo}/${name}.log`,
    query: new URLSearchParams({ host: ref.host, job: String(job.id), run: String(job.run_id) }).toString()
  });
}

export function parseLogUri(uri: vscode.Uri): { ref: RepoRef; jobId: number; runId: number } | undefined {
  const query = new URLSearchParams(uri.query);
  const [, owner, repo] = uri.path.split('/');
  const jobId = Number(query.get('job'));
  if (!owner || !repo || !jobId) {
    return undefined;
  }
  return { ref: { host: query.get('host') ?? 'github.com', owner, repo }, jobId, runId: Number(query.get('run')) };
}

/**
 * Serves job logs as read-only documents and remembers how each was rendered,
 * for folding, links and the lens at the top.
 */
export class LogStore implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly loaded = new Map<string, LoadedLog>();
  private readonly clients = new Map<string, GitHubClient>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  dispose(): void {
    this.changed.dispose();
  }

  client(ref: RepoRef): GitHubClient {
    const key = `${ref.host}/${ref.owner}/${ref.repo}`;
    let client = this.clients.get(key);
    if (!client) {
      client = new GitHubClient(ref);
      this.clients.set(key, client);
    }
    return client;
  }

  get(uri: vscode.Uri): LoadedLog | undefined {
    return this.loaded.get(uri.toString());
  }

  /** Downloads and renders a finished job's log, or returns the copy already open. */
  async load(ref: RepoRef, jobId: number, uri?: vscode.Uri): Promise<LoadedLog> {
    const cached = uri && this.loaded.get(uri.toString());
    if (cached) {
      return cached;
    }
    const client = this.client(ref);
    const [job, raw] = await Promise.all([client.job(jobId), client.log(jobId)]);
    const timestamps = vscode.workspace.getConfiguration('actionsLive').get<boolean>('showTimestamps', false);
    const loaded = { ref, job, log: renderLog(raw, job.steps, { timestamps }) };
    this.loaded.set((uri ?? logUri(ref, job)).toString(), loaded);
    return loaded;
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const target = parseLogUri(uri);
    if (!target) {
      return '';
    }
    try {
      return (await this.load(target.ref, target.jobId, uri)).log.text;
    } catch (error) {
      return `Could not load this log.\n\n${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** Throws away a rendered copy so the next open downloads it again. */
  forget(uri: vscode.Uri): void {
    this.loaded.delete(uri.toString());
    this.changed.fire(uri);
  }

  forgetAll(): void {
    for (const key of [...this.loaded.keys()]) {
      this.forget(vscode.Uri.parse(key));
    }
  }
}

const errorLine = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: new vscode.ThemeColor('inputValidation.errorBackground'),
  overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.errorForeground'),
  overviewRulerLane: vscode.OverviewRulerLane.Full
});
const warningLine = vscode.window.createTextEditorDecorationType({
  overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.warningForeground'),
  overviewRulerLane: vscode.OverviewRulerLane.Right
});
const stepLine = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  fontWeight: 'bold',
  overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.infoForeground'),
  overviewRulerLane: vscode.OverviewRulerLane.Left
});

/**
 * Opens a job's log: on the step asked for, or on the first error of a failed
 * job with the lines that led to it in view. Set-up groups start folded.
 */
export async function showLog(store: LogStore, ref: RepoRef, job: Job, stepNumber?: number): Promise<void> {
  const uri = logUri(ref, job);
  let loaded: LoadedLog;
  try {
    loaded = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Loading log of ${job.name}…` },
      () => store.load(ref, job.id, uri)
    );
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not load the log of ${job.name}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  let document = await vscode.workspace.openTextDocument(uri);
  if (document.languageId !== LOG_LANGUAGE) {
    document = await vscode.languages.setTextDocumentLanguage(document, LOG_LANGUAGE);
  }
  const editor = await vscode.window.showTextDocument(document, { preview: true });
  decorate(editor, loaded.log);

  const { log } = loaded;
  let target: number | undefined;
  let top: number | undefined;
  const stepStart = stepNumber !== undefined ? log.stepLines.get(stepNumber) : undefined;
  const failureInStep = log.failures.find((failure) => failure.stepNumber === stepNumber);
  if (stepStart !== undefined && !failureInStep) {
    target = top = stepStart;
  } else if (failureInStep) {
    target = failureInStep.errorLine;
    top = Math.max(failureInStep.startLine, failureInStep.errorLine - 25);
  } else if (log.focus) {
    target = log.focus.line;
    top = log.focus.contextStart;
  }

  // Fold the set-up groups, except the one holding the line we open on.
  const groups = log.folds
    .filter((fold) => fold.start < document.lineCount && !document.lineAt(fold.start).text.startsWith('━━'))
    .filter((fold) => target === undefined || target < fold.start || target > fold.end)
    .map((fold) => fold.start);
  if (groups.length) {
    await vscode.commands.executeCommand('editor.fold', { levels: 1, selectionLines: groups });
  }
  if (target !== undefined) {
    const position = new vscode.Position(target, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(top ?? target, 0, top ?? target, 0), vscode.TextEditorRevealType.AtTop);
  }
}

export function decorate(editor: vscode.TextEditor, log: RenderedLog): void {
  const lines = (numbers: number[]): vscode.Range[] => numbers.filter((line) => line < editor.document.lineCount).map((line) => new vscode.Range(line, 0, line, 0));
  editor.setDecorations(errorLine, lines(log.errors));
  editor.setDecorations(warningLine, lines(log.warnings));
  editor.setDecorations(stepLine, lines([...log.stepLines.values()]));
}

export class LogFolding implements vscode.FoldingRangeProvider {
  constructor(private readonly store: LogStore) {}

  provideFoldingRanges(document: vscode.TextDocument): vscode.FoldingRange[] {
    const loaded = this.store.get(document.uri);
    return (loaded?.log.folds ?? [])
      .filter((fold) => fold.end < document.lineCount)
      .map((fold) => new vscode.FoldingRange(fold.start, fold.end, vscode.FoldingRangeKind.Region));
  }
}

/** Makes `src/app.ts:12:5` and friends in a log open that file of the workspace. */
export class LogLinks implements vscode.DocumentLinkProvider {
  private readonly exists = new Map<string, Promise<boolean>>();

  constructor(private readonly root: () => vscode.Uri | undefined) {}

  async provideDocumentLinks(document: vscode.TextDocument): Promise<vscode.DocumentLink[]> {
    const root = this.root();
    if (!root) {
      return [];
    }
    const candidates: Array<{ range: vscode.Range; target: vscode.Uri; path: string }> = [];
    for (let line = 0; line < document.lineCount && candidates.length < 3000; line++) {
      const text = document.lineAt(line).text;
      if (!/[:(]\d|line \d/.test(text)) {
        continue;
      }
      for (const location of findLocations(text)) {
        const file = vscode.Uri.joinPath(root, location.path);
        const fragment = `L${location.line}${location.column ? `,${location.column}` : ''}`;
        candidates.push({ range: new vscode.Range(line, location.start, line, location.end), target: file.with({ fragment }), path: file.toString() });
      }
    }
    const links: vscode.DocumentLink[] = [];
    for (const candidate of candidates) {
      if (await this.fileExists(candidate.path)) {
        const link = new vscode.DocumentLink(candidate.range, candidate.target);
        link.tooltip = 'Open in the editor';
        links.push(link);
      }
    }
    return links;
  }

  private fileExists(uri: string): Promise<boolean> {
    let known = this.exists.get(uri);
    if (!known) {
      known = Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.parse(uri))).then(
        (stat) => (stat.type & vscode.FileType.File) !== 0,
        () => false
      );
      this.exists.set(uri, known);
    }
    return known;
  }
}

/** The line at the top of a log: what failed, and what to do about it. */
export class LogLens implements vscode.CodeLensProvider {
  constructor(private readonly store: LogStore) {}

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const loaded = this.store.get(document.uri);
    if (!loaded) {
      return [];
    }
    const { job, log } = loaded;
    const top = new vscode.Range(0, 0, 0, 0);
    const node = { kind: 'job', runId: job.run_id, jobId: job.id };
    const lenses: vscode.CodeLens[] = [];
    const failure = log.failures[0];
    if (job.conclusion === 'failure' || failure) {
      const where = failure?.stepName ? `Failed at step ${failure.stepNumber}: ${failure.stepName}` : 'Failed';
      lenses.push(
        new vscode.CodeLens(top, {
          title: `$(error) ${where}`,
          command: 'actionsLive.revealFailure',
          arguments: [document.uri]
        }),
        new vscode.CodeLens(top, { title: '$(debug-rerun) Re-run failed jobs', command: 'actionsLive.rerunFailed', arguments: [{ kind: 'run', runId: job.run_id }, loaded.ref] }),
        new vscode.CodeLens(top, { title: '$(sparkle) Fix in Chat', command: 'actionsLive.fixInChat', arguments: [node, loaded.ref] }),
        new vscode.CodeLens(top, { title: '$(warning) Show in Problems', command: 'actionsLive.showErrorsInProblems', arguments: [node, loaded.ref] }),
        new vscode.CodeLens(top, { title: '$(diff) Compare with Last Green', command: 'actionsLive.compareWithLastGreen', arguments: [node, loaded.ref] })
      );
    } else {
      lenses.push(new vscode.CodeLens(top, { title: `$(pass) ${job.name} ${job.conclusion ?? job.status}`, command: '' }));
    }
    if (job.html_url) {
      lenses.push(new vscode.CodeLens(top, { title: '$(link-external) Open on GitHub', command: 'vscode.open', arguments: [vscode.Uri.parse(job.html_url)] }));
    }
    return lenses;
  }
}
