import * as vscode from 'vscode';
import { Run } from './model';
import { lastRunLabel, passRate } from './workflowStats';
import { RunsService } from './runsService';
import { dispatchInputs } from './workflowInputs';

const REFETCH_MS = 60_000;

/** Runs of one workflow file, fetched when the view has none of them loaded. */
interface Fetched {
  runs: Run[];
  at: number;
}

/** The workflow's last run, pass rate and actions, on the first line of its file. */
export class WorkflowLens implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private readonly fetched = new Map<string, Fetched | 'loading'>();
  private workflows: Array<{ id: number; path: string }> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly service: RunsService) {
    this.disposables.push(
      service.onDidChange(() => {
        this.fetched.clear();
        this.changed.fire();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('actionsLive.codeLens')) {
          this.changed.fire();
        }
      })
    );
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration('actionsLive').get<boolean>('codeLens', true)) {
      return [];
    }
    const repo = this.service.workspace;
    const path = repo ? workflowPath(document.uri, repo.root) : undefined;
    if (!repo || !path || !this.service.github) {
      return [];
    }
    const range = new vscode.Range(titleLine(document), 0, titleLine(document), 0);
    const lens = (title: string, command: string, args: unknown[] = [], tooltip?: string): vscode.CodeLens =>
      new vscode.CodeLens(range, { title, command, arguments: args, tooltip });

    const runs = this.runsOf(path);
    const lenses: vscode.CodeLens[] = [];
    if (runs === 'loading') {
      lenses.push(lens('$(loading~spin) Actions Live', 'actionsLive.refresh'));
    } else if (!runs.length) {
      lenses.push(lens('$(circle-slash) No runs yet', 'actionsLive.runs.focus', [], 'This workflow has not run on GitHub yet'));
    } else {
      const last = runs[0];
      lenses.push(lens(lastRunLabel(last), 'actionsLive.openRun', [{ kind: 'run', runId: last.id }], `${last.display_title ?? ''}\nClick to open the run`));
      const stats = passRate(runs);
      if (stats) {
        lenses.push(lens(stats, 'actionsLive.workflowHealth', [{ kind: 'run', runId: last.id }], 'Workflow Health (Pro): pass rate, flaky runs, slow steps'));
      }
    }
    if (dispatchInputs(document.getText())) {
      lenses.push(lens('$(play) Run workflow', 'actionsLive.runWorkflow', [path], `Start ${path.split('/').pop()} on ${repo.remoteBranch ?? 'the current branch'}`));
    }
    const workflowId = runs !== 'loading' && runs[0] ? runs[0].workflow_id : this.workflows?.find((workflow) => workflow.path === path)?.id;
    if (workflowId !== undefined) {
      lenses.push(lens('$(list-unordered) All runs', 'actionsLive.showWorkflowRuns', [workflowId, document.uri.path.split('/').pop()]));
    }
    return lenses;
  }

  /** The loaded runs of the file, newest first, or what a fetch of them returned. */
  private runsOf(path: string): Run[] | 'loading' {
    const loaded = [...this.service.runs, ...this.service.headRuns].filter((run) => run.path === path);
    if (loaded.length >= 3 || this.service.state !== 'ready') {
      return dedupe(loaded);
    }
    const cached = this.fetched.get(path);
    if (cached === 'loading') {
      return loaded.length ? dedupe(loaded) : 'loading';
    }
    if (cached && Date.now() - cached.at < REFETCH_MS) {
      return dedupe([...loaded, ...cached.runs]);
    }
    void this.fetch(path);
    return loaded.length ? dedupe(loaded) : 'loading';
  }

  private async fetch(path: string): Promise<void> {
    const client = this.service.github;
    if (!client) {
      return;
    }
    this.fetched.set(path, 'loading');
    try {
      this.workflows ??= await client.workflows();
      const workflow = this.workflows.find((candidate) => candidate.path === path);
      const runs = workflow ? await client.runs({ workflowId: workflow.id, perPage: 30 }) : [];
      this.fetched.set(path, { runs, at: Date.now() });
    } catch {
      this.fetched.set(path, { runs: [], at: Date.now() });
    }
    this.changed.fire();
  }

  dispose(): void {
    this.disposables.forEach((item) => item.dispose());
    this.changed.dispose();
  }
}

/** `.github/workflows/ci.yml` for a file inside the repository's workflows folder, else undefined. */
export function workflowPath(uri: vscode.Uri, root: vscode.Uri): string | undefined {
  const relative = uri.path.startsWith(`${root.path}/`) ? uri.path.slice(root.path.length + 1) : undefined;
  return relative && /^\.github\/workflows\/[^/]+\.ya?ml$/.test(relative) ? relative : undefined;
}

/** The `name:` line of the workflow, or the first line that is not a comment. */
function titleLine(document: vscode.TextDocument): number {
  let first: number | undefined;
  for (let line = 0; line < Math.min(document.lineCount, 50); line++) {
    const text = document.lineAt(line).text;
    if (/^name:/.test(text)) {
      return line;
    }
    if (first === undefined && text.trim() && !text.startsWith('#')) {
      first = line;
    }
  }
  return first ?? 0;
}

function dedupe(runs: Run[]): Run[] {
  const seen = new Map<number, Run>();
  runs.forEach((run) => seen.set(run.id, run));
  return [...seen.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
}
