import * as vscode from 'vscode';
import { formatDuration, Run, runDuration, toneOf, workflowName } from './model';
import { RunsService } from './runsService';
import { notifySystem } from './systemNotify';

export interface FinishedActions {
  openRun(run: Run): void;
  rerunFailed(run: Run): void;
  showProblems(run: Run): void;
  reviewDeployments(run: Run): void;
}

/**
 * Pro: says when CI finishes on your branch or on a run you started, and
 * when a deployment waits for your review, so you can do something else after
 * a push. With VS Code in the background it uses the system's notifications.
 * Failed runs of the current commit can also put their errors straight into
 * the Problems panel.
 */
export class Notifier implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly service: RunsService,
    private readonly isPro: () => boolean,
    private readonly actions: FinishedActions
  ) {
    this.subscriptions = [service.onDidFinish((runs) => this.finished(runs)), service.onDidStartWaiting((runs) => this.waiting(runs))];
  }

  dispose(): void {
    this.subscriptions.forEach((item) => item.dispose());
  }

  private mine(runs: Run[]): Run[] {
    const repo = this.service.workspace;
    return runs.filter(
      (run) =>
        run.head_sha === repo?.head ||
        (repo?.remoteBranch !== undefined && run.head_branch === repo.remoteBranch) ||
        (this.service.login !== undefined && run.triggering_actor?.login === this.service.login)
    );
  }

  /** Also tells the system when VS Code is not the window in front. */
  private system(title: string, body: string): void {
    const config = vscode.workspace.getConfiguration('actionsLive');
    if (!vscode.window.state.focused && config.get<boolean>('systemNotifications', true)) {
      notifySystem(title, body);
    }
  }

  private waiting(runs: Run[]): void {
    const mode = vscode.workspace.getConfiguration('actionsLive').get<string>('notifications', 'mine');
    if (!this.isPro() || mode === 'off') {
      return;
    }
    for (const run of this.mine(runs)) {
      const what = `${workflowName(run)} on ${run.head_branch ?? run.head_sha.slice(0, 7)}`;
      this.system('Deployment waits for review', what);
      void vscode.window.showWarningMessage(`⏸ ${what} waits for a deployment review.`, 'Review…', 'Open on GitHub').then((choice) => {
        if (choice === 'Review…') {
          this.actions.reviewDeployments(run);
        } else if (choice === 'Open on GitHub') {
          void vscode.env.openExternal(vscode.Uri.parse(run.html_url));
        }
      });
    }
  }

  private finished(runs: Run[]): void {
    if (!this.isPro()) {
      return;
    }
    const config = vscode.workspace.getConfiguration('actionsLive');
    const mode = config.get<'mine' | 'failures' | 'off'>('notifications', 'mine');
    const repo = this.service.workspace;
    const mine = this.mine(runs);

    const failedOnHead = mine.filter((run) => toneOf(run) === 'failure' && run.head_sha === repo?.head);
    if (failedOnHead.length && config.get<boolean>('problemsOnFailure', true)) {
      this.actions.showProblems(failedOnHead[0]);
    }

    if (mode === 'off') {
      return;
    }
    for (const run of mine) {
      const tone = toneOf(run);
      if (tone === 'cancelled' || tone === 'skipped' || tone === 'attention' || (mode === 'failures' && tone !== 'failure')) {
        continue;
      }
      const took = runDuration(run);
      const what = `${workflowName(run)} on ${run.head_branch ?? run.head_sha.slice(0, 7)}`;
      const when = took !== undefined ? ` in ${formatDuration(took)}` : '';
      if (tone === 'failure') {
        this.system(`✖ ${workflowName(run)} failed`, `${run.display_title ?? what}${when}`);
        void vscode.window.showErrorMessage(`✖ ${what} failed${when}.`, 'Show Failure', 'Re-run failed jobs', 'Open on GitHub').then((choice) => {
          if (choice === 'Show Failure') {
            this.actions.openRun(run);
          } else if (choice === 'Re-run failed jobs') {
            this.actions.rerunFailed(run);
          } else if (choice === 'Open on GitHub') {
            void vscode.env.openExternal(vscode.Uri.parse(run.html_url));
          }
        });
      } else {
        this.system(`✓ ${workflowName(run)} passed`, `${run.display_title ?? what}${when}`);
        void vscode.window.showInformationMessage(`✓ ${what} passed${when}.`, 'Open Run', 'Open on GitHub').then((choice) => {
          if (choice === 'Open Run') {
            this.actions.openRun(run);
          } else if (choice) {
            void vscode.env.openExternal(vscode.Uri.parse(run.html_url));
          }
        });
      }
    }
  }
}
