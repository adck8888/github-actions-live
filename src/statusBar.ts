import * as vscode from 'vscode';
import { describeMergeState } from './checks';
import { commitStatus, formatDuration, runDuration, workflowName } from './model';
import { RunsService } from './runsService';

const ICONS: Record<string, string> = {
  queued: '$(clock)',
  running: '$(sync~spin)',
  success: '$(pass)',
  failure: '$(error)',
  cancelled: '$(circle-slash)',
  skipped: '$(debug-step-over)',
  attention: '$(shield)',
  neutral: '$(circle-large-outline)'
};

/**
 * CI of the commit you are on, in the status bar: running, green or red.
 * It counts every check of the commit — Actions jobs, other apps' checks and
 * commit statuses — like the checks box of a pull request does.
 */
export class CiStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('actionsLive.ci', vscode.StatusBarAlignment.Left, 49);
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly service: RunsService) {
    this.item.name = 'GitHub Actions CI';
    this.item.command = 'actionsLive.openBranchRun';
    this.disposables.push(
      service.onDidChange(() => this.update()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('actionsLive.statusBar')) {
          this.update();
        }
      })
    );
    this.update();
  }

  dispose(): void {
    this.disposables.forEach((item) => item.dispose());
    this.item.dispose();
  }

  update(): void {
    const enabled = vscode.workspace.getConfiguration('actionsLive').get<boolean>('statusBar', true);
    const head = this.service.workspace?.head;
    if (!enabled || this.service.state !== 'ready' || !head) {
      this.item.hide();
      return;
    }
    const checks = this.service.headChecks;
    const status = checks && checks.total ? checks : commitStatus(this.service.headRuns);
    if (status.tone === 'none' || !status.total) {
      this.item.text = '$(circle-large-outline) CI';
      this.item.tooltip = 'No checks for this commit yet. Push it to start CI.';
      this.item.backgroundColor = undefined;
      this.item.show();
      return;
    }
    let text = `${ICONS[status.tone]} CI`;
    if (status.tone === 'failure') {
      text += ` ${status.failed.length} failed`;
    } else if (status.tone === 'running' || status.tone === 'queued') {
      text += ` ${status.done}/${status.total}`;
    } else if (status.tone === 'attention') {
      text += ' needs approval';
    }
    this.item.text = text;
    this.item.backgroundColor = status.tone === 'failure' ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;

    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**CI of \`${head.slice(0, 7)}\`** · ${status.done}/${status.total} done\n\n`);
    const pull = this.service.pull;
    if (pull) {
      const merge = describeMergeState(pull.mergeable_state, pull.draft);
      md.appendMarkdown(`$(git-pull-request) #${pull.number} ${escape(pull.title)}${merge ? ` — ${merge}` : ''}\n\n`);
    }
    if (checks && checks.total) {
      const shown = checks.items.slice(0, 15);
      for (const check of shown) {
        const source = check.source === 'github-actions' ? '' : ` · _${escape(check.source === 'status' ? 'status' : check.source)}_`;
        md.appendMarkdown(`${ICONS[check.tone]} ${escape(check.name)}${source}\n\n`);
      }
      if (checks.items.length > shown.length) {
        md.appendMarkdown(`…and ${checks.items.length - shown.length} more\n\n`);
      }
    } else {
      for (const run of this.service.headRuns) {
        const took = runDuration(run);
        md.appendMarkdown(`${ICONS[run.conclusion === 'success' ? 'success' : run.conclusion === 'failure' ? 'failure' : 'running']} ${escape(workflowName(run))}${took !== undefined ? ` · ${formatDuration(took)}` : ''}\n\n`);
      }
    }
    md.appendMarkdown('Click to show it in Actions Live.');
    this.item.tooltip = md;
    this.item.show();
  }
}

function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
