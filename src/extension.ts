import { homedir } from 'os';
import * as vscode from 'vscode';
import { runWorkflow } from './dispatch';
import { CiFailuresTool, fixInChat } from './chat';
import { GitHubClient } from './github';
import { GitWatcher, sameRepo } from './git';
import { License, offerPro, openCheckout, PRO } from './license';
import { decorate, LOG_LANGUAGE, LOG_SCHEME, LogFolding, LogLens, LogLinks, LogStore, parseLogUri, showLog } from './logDocuments';
import { isActive, Job, Run, toneOf, workflowName } from './model';
import { Notifier } from './notifier';
import { RunPanel } from './panels';
import { CiProblems } from './problems';
import { compareWithLastGreen, REPORT_SCHEME, Reports, workflowHealthReport } from './reports';
import { RepoRef } from './remote';
import { RunFilters, RunsService } from './runsService';
import { Node, RunsTree } from './runsTree';
import { CiStatusBar } from './statusBar';
import { WorkflowLens } from './workflowLens';

type Target = Node | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const license = new License(context);
  const service = new RunsService(context.globalState);
  const tree = new RunsTree(service);
  const logs = new LogStore();
  const reports = new Reports();
  const problems = new CiProblems(logs);
  const git = new GitWatcher();
  const view = vscode.window.createTreeView('actionsLive.runs', { treeDataProvider: tree, showCollapseAll: true });
  const workflowLens = new WorkflowLens(service);

  const root = (): vscode.Uri | undefined => service.workspace?.root;
  const clientFor = (ref?: RepoRef): GitHubClient | undefined =>
    ref && !sameRepo(ref, service.workspace?.ref) ? logs.client(ref) : service.github;
  const refOf = (ref?: RepoRef): RepoRef | undefined => ref ?? service.workspace?.ref;

  const panel = new RunPanel({ service, logs, isPro: () => license.isPro, clientFor, root });
  const reportActions = (ref?: RepoRef) => ({
    openRun: (runId: number) => panel.show(runId, ref),
    rerunFailed: (runId: number) => vscode.commands.executeCommand('actionsLive.rerunFailed', { kind: 'run', runId }, ref),
    root
  });

  const runOf = async (target: Target, ref?: RepoRef): Promise<Run | undefined> => {
    if (!target || !('runId' in target)) {
      return undefined;
    }
    const known = service.findRun(target.runId);
    if (known) {
      return known;
    }
    return clientFor(ref)?.run(target.runId).catch(() => undefined);
  };

  const jobsOfRun = async (run: Run, ref?: RepoRef): Promise<Job[]> => {
    if (!ref || sameRepo(ref, service.workspace?.ref)) {
      return service.jobsOf(run) ?? (await service.loadJobs(run));
    }
    return (await clientFor(ref)?.jobs(run.id).catch(() => [])) ?? [];
  };

  /** The job a command is about: the job node itself, or a run's first failed job. */
  const jobOf = async (target: Target, ref?: RepoRef): Promise<Job | undefined> => {
    if (!target || !('runId' in target) || target.kind === 'loading') {
      return undefined;
    }
    if (target.kind === 'job' || target.kind === 'step') {
      return tree.job(target.runId, target.jobId) ?? (await clientFor(ref)?.job(target.jobId).catch(() => undefined));
    }
    const run = await runOf(target, ref);
    if (!run) {
      return undefined;
    }
    const jobs = await jobsOfRun(run, ref);
    return jobs.find((job) => toneOf(job) === 'failure') ?? jobs[0];
  };

  /** Jobs whose log someone asked for while they were running: opened when they finish. */
  const pendingLogs = new Map<number, { runId: number; ref: RepoRef }>();
  const openPendingLogs = (): void => {
    for (const [jobId, pending] of pendingLogs) {
      const run = service.findRun(pending.runId);
      const job = tree.job(pending.runId, jobId);
      if (job && !isActive(job)) {
        pendingLogs.delete(jobId);
        void showLog(logs, pending.ref, job);
      } else if (run) {
        service.jobsOf(run);
      }
    }
  };

  const openJobLog = async (job: Job, ref: RepoRef, step?: number): Promise<void> => {
    if (isActive(job)) {
      if (pendingLogs.has(job.id)) {
        void vscode.window.setStatusBarMessage(`$(watch) The log of ${job.name} opens when the job finishes`, 4000);
        return;
      }
      const ownRepo = sameRepo(ref, service.workspace?.ref);
      const choice = await vscode.window.showInformationMessage(
        `${job.name} is still ${job.status === 'in_progress' ? 'running' : 'waiting'}. GitHub serves a job's log only once the job finishes; until then its steps update live in the Runs view.`,
        ...(ownRepo ? ['Open When It Finishes'] : []),
        'Open on GitHub'
      );
      if (choice === 'Open When It Finishes') {
        pendingLogs.set(job.id, { runId: job.run_id, ref });
        openPendingLogs();
      } else if (choice === 'Open on GitHub' && job.html_url) {
        void vscode.env.openExternal(vscode.Uri.parse(job.html_url));
      }
      return;
    }
    await showLog(logs, ref, job, step);
  };

  const showProblems = async (run: Run, ref?: RepoRef, quiet = false): Promise<void> => {
    const workspaceRoot = root();
    const repo = refOf(ref);
    if (!workspaceRoot || !repo || !sameRepo(repo, service.workspace?.ref)) {
      if (!quiet) {
        void vscode.window.showWarningMessage('CI errors can be shown only for runs of the repository open in this window.');
      }
      return;
    }
    const jobs = await jobsOfRun(run, repo);
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Collecting CI errors…' }, () =>
      problems.show(repo, workspaceRoot, run, jobs, (sha, paths) => git.diffSince(workspaceRoot, sha, paths))
    );
    const count = result.count;
    if (count) {
      if (!quiet) {
        void vscode.commands.executeCommand('workbench.actions.view.problems');
      }
      void vscode.window.setStatusBarMessage(`$(warning) ${count} CI error${count === 1 ? '' : 's'} in Problems`, 5000);
      if (result.commitMissing && !quiet) {
        void vscode.window.showWarningMessage(
          `CI ran on ${run.head_sha.slice(0, 7)}, which is not in your clone, so error lines are as CI saw them. Fetch to have them follow your edits.`
        );
      }
    } else if (!quiet) {
      void vscode.window.showInformationMessage('The failed jobs do not point to lines of files in this workspace. Open the log to see what failed.');
    }
  };

  const reviewDeployments = async (run: Run, ref?: RepoRef): Promise<void> => {
    const client = clientFor(ref);
    if (!client) {
      return;
    }
    const pending = (await client.pendingDeployments(run.id)).filter((deployment) => deployment.current_user_can_approve);
    if (!pending.length) {
      const choice = await vscode.window.showInformationMessage(`${workflowName(run)} #${run.run_number} has no deployment you can review.`, 'Open on GitHub');
      if (choice) {
        void vscode.env.openExternal(vscode.Uri.parse(run.html_url));
      }
      return;
    }
    const environments =
      pending.length === 1
        ? pending
        : (
            await vscode.window.showQuickPick(
              pending.map((deployment) => ({ label: deployment.environment.name, picked: true, deployment })),
              { canPickMany: true, title: `Review deployments of ${workflowName(run)} #${run.run_number}` }
            )
          )?.map((item) => item.deployment);
    if (!environments?.length) {
      return;
    }
    const names = environments.map((deployment) => deployment.environment.name).join(', ');
    const decision = await vscode.window.showQuickPick(
      [
        { label: '$(check) Approve and deploy', state: 'approved' as const },
        { label: '$(close) Reject', state: 'rejected' as const }
      ],
      { title: `Deploy ${workflowName(run)} #${run.run_number} to ${names}?` }
    );
    if (!decision) {
      return;
    }
    const comment = await vscode.window.showInputBox({
      title: 'Comment (optional)',
      prompt: `Shown on the run next to your ${decision.state === 'approved' ? 'approval' : 'rejection'}`
    });
    if (comment === undefined) {
      return;
    }
    await client.reviewDeployments(
      run.id,
      environments.map((deployment) => deployment.environment.id),
      decision.state,
      comment
    );
    void vscode.window.setStatusBarMessage(`$(${decision.state === 'approved' ? 'check' : 'close'}) ${decision.state === 'approved' ? 'Approved' : 'Rejected'} ${names}`, 5000);
    service.boost();
    service.refresh();
  };

  const setState = (): void => {
    let state: string = service.state;
    if (service.state === 'ready' && !service.runs.length && !service.message) {
      state = service.branchOnly ? 'empty-branch' : 'empty';
    }
    void vscode.commands.executeCommand('setContext', 'actionsLive.state', state);
    const active = service.runs.filter(isActive).length;
    view.badge = active ? { value: active, tooltip: `${active} run${active === 1 ? '' : 's'} in progress` } : undefined;
    const repo = service.workspace;
    const filters = service.filters;
    const filtered = [filters.mine ? 'mine' : undefined, filters.failed ? 'failed' : undefined, filters.workflowName].filter(Boolean).join(', ');
    view.description = repo
      ? `${repo.ref.owner}/${repo.ref.repo}${service.branchOnly && repo.branch ? ` · ${repo.branch}` : ''}${filtered ? ` · ${filtered}` : ''}`
      : undefined;
  };

  const redecorate = (editors: readonly vscode.TextEditor[]): void => {
    for (const editor of editors) {
      const loaded = editor.document.uri.scheme === LOG_SCHEME ? logs.get(editor.document.uri) : undefined;
      if (loaded) {
        decorate(editor, loaded.log);
      }
    }
  };

  const command = (id: string, handler: (...args: never[]) => unknown): vscode.Disposable =>
    vscode.commands.registerCommand(id, async (...args: never[]) => {
      try {
        await handler(...args);
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    });

  const runAction = async (target: Target, ref: RepoRef | undefined, action: 'rerun' | 'rerunFailed' | 'cancel'): Promise<void> => {
    const run = await runOf(target, ref);
    const client = clientFor(ref);
    if (!run || !client) {
      return;
    }
    await client[action](run.id);
    const done = { rerun: 'Re-running all jobs', rerunFailed: 'Re-running failed jobs', cancel: 'Cancelling the run' }[action];
    void vscode.window.setStatusBarMessage(`$(sync) ${done}…`, 4000);
    service.boost();
    service.refresh();
  };

  const urlOf = async (target: Target, ref?: RepoRef): Promise<string | undefined> => {
    if (target?.kind === 'job' || target?.kind === 'step') {
      return (await jobOf(target, ref))?.html_url ?? undefined;
    }
    return (await runOf(target, ref))?.html_url;
  };

  context.subscriptions.push(
    license,
    service,
    tree,
    logs,
    reports,
    problems,
    git,
    view,
    panel,
    workflowLens,
    new CiStatusBar(service),
    new Notifier(service, () => license.isPro, {
      openRun: (run) => void panel.show(run.id),
      rerunFailed: (run) => void runAction({ kind: 'run', runId: run.id }, undefined, 'rerunFailed'),
      showProblems: (run) => void showProblems(run, undefined, true),
      reviewDeployments: (run) => void reviewDeployments(run)
    }),
    vscode.workspace.registerTextDocumentContentProvider(LOG_SCHEME, logs),
    vscode.workspace.registerTextDocumentContentProvider(REPORT_SCHEME, reports),
    vscode.languages.registerFoldingRangeProvider({ scheme: LOG_SCHEME }, new LogFolding(logs)),
    vscode.languages.registerDocumentLinkProvider({ scheme: LOG_SCHEME }, new LogLinks(root)),
    vscode.languages.registerCodeLensProvider({ scheme: LOG_SCHEME }, new LogLens(logs)),
    vscode.languages.registerCodeLensProvider({ scheme: 'file', pattern: '**/.github/workflows/*.{yml,yaml}' }, workflowLens),
    vscode.window.onDidChangeVisibleTextEditors(redecorate),
    git.onDidChange((repo) => service.setRepo(repo)),
    git.onDidNudge(() => service.nudge()),
    service.onDidChange(setState),
    service.onDidChange(openPendingLogs),
    service.onDidChangeJobs(openPendingLogs),
    view.onDidCollapseElement((event) => {
      if (event.element.kind === 'run') {
        service.release(event.element.runId);
      }
    }),
    license.onDidChange(() => void vscode.commands.executeCommand('setContext', 'actionsLive.pro', license.isPro)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('actionsLive.showTimestamps')) {
        logs.forgetAll();
      }
    }),

    command('actionsLive.refresh', () => service.refresh()),
    command('actionsLive.showCurrentBranch', () => service.setBranchOnly(true)),
    command('actionsLive.showAllBranches', () => service.setBranchOnly(false)),
    command('actionsLive.signIn', async () => {
      if (service.github) {
        await service.github.session(true);
      } else {
        await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
      }
      service.refresh();
    }),
    command('actionsLive.runWorkflow', async (only?: unknown) => {
      const repo = service.workspace;
      if (!repo || !service.github) {
        void vscode.window.showWarningMessage('Open a folder cloned from GitHub to run its workflows.');
        return;
      }
      // A code lens passes the workflow file's path; menus pass nothing useful.
      if (await runWorkflow(service.github, repo.root, repo.remoteBranch, typeof only === 'string' ? only : undefined)) {
        service.boost();
        service.refresh();
      }
    }),
    command('actionsLive.openLog', async (target: Target, ref?: RepoRef) => {
      const repo = refOf(ref);
      const job = await jobOf(target, ref);
      if (job && repo) {
        await openJobLog(job, repo, target?.kind === 'step' ? target.number : undefined);
      }
    }),
    command('actionsLive.openRun', async (target: Target | number, ref?: RepoRef) => {
      const runId = typeof target === 'number' ? target : target && 'runId' in target ? target.runId : undefined;
      if (runId !== undefined) {
        await panel.show(runId, ref, typeof target !== 'number');
      }
    }),
    command('actionsLive.openBranchRun', async () => {
      const runs = service.headRuns.length ? service.headRuns : service.runs;
      const run = runs.find((candidate) => toneOf(candidate) === 'failure') ?? runs.find(isActive) ?? runs[0];
      if (!run) {
        await vscode.commands.executeCommand('actionsLive.runs.focus');
        return;
      }
      await panel.show(run.id);
      if (service.runs.some((candidate) => candidate.id === run.id)) {
        await view.reveal(tree.runNode(run.id), { select: true, focus: false, expand: true });
      }
    }),
    command('actionsLive.rerun', (target: Target, ref?: RepoRef) => runAction(target, ref, 'rerun')),
    command('actionsLive.rerunFailed', (target: Target, ref?: RepoRef) => runAction(target, ref, 'rerunFailed')),
    command('actionsLive.cancel', (target: Target, ref?: RepoRef) => runAction(target, ref, 'cancel')),
    command('actionsLive.openOnGitHub', async (target: Target, ref?: RepoRef) => {
      const url = await urlOf(target, ref);
      if (url) {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      }
    }),
    command('actionsLive.copyUrl', async (target: Target, ref?: RepoRef) => {
      const url = await urlOf(target, ref);
      if (url) {
        await vscode.env.clipboard.writeText(url);
        void vscode.window.setStatusBarMessage('$(copy) Link copied', 3000);
      }
    }),
    command('actionsLive.revealFailure', async (uri: vscode.Uri) => {
      const loaded = logs.get(uri);
      const editor = vscode.window.visibleTextEditors.find((candidate) => candidate.document.uri.toString() === uri.toString());
      const focus = loaded?.log.focus;
      if (editor && focus) {
        const position = new vscode.Position(focus.line, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(focus.contextStart, 0, focus.contextStart, 0), vscode.TextEditorRevealType.AtTop);
      }
    }),
    command('actionsLive.fixInChat', async (target: Target, ref?: RepoRef) => {
      const repo = refOf(ref);
      const job = await jobOf(target, ref);
      if (job && repo) {
        await fixInChat(logs, repo, job, sameRepo(repo, service.workspace?.ref) ? root() : undefined);
      }
    }),
    command('actionsLive.compareWithLastGreen', async (target: Target, ref?: RepoRef) => {
      if (!(await offerPro(license, 'Comparing with the last green run'))) {
        return;
      }
      const repo = refOf(ref);
      const client = clientFor(ref);
      const run = await runOf(target, ref);
      if (!repo || !client || !run) {
        return;
      }
      const job = target?.kind === 'job' || target?.kind === 'step' ? await jobOf(target, ref) : undefined;
      await compareWithLastGreen(reports, logs, client, repo, run, job, reportActions(ref));
    }),
    command('actionsLive.workflowHealth', async (target: Target) => {
      if (!(await offerPro(license, 'Workflow health'))) {
        return;
      }
      const client = service.github;
      if (!client) {
        return;
      }
      const run = await runOf(target);
      let workflow = run ? { id: run.workflow_id, name: workflowName(run) } : undefined;
      if (!workflow) {
        const workflows = (await client.workflows()).filter((candidate) => candidate.state === 'active');
        const picked = await vscode.window.showQuickPick(
          workflows.map((candidate) => ({ label: candidate.name, description: candidate.path, workflow: candidate })),
          { title: 'Workflow Health', placeHolder: 'Which workflow?' }
        );
        workflow = picked?.workflow;
      }
      if (workflow) {
        await workflowHealthReport(client, workflow, service.branchOnly ? service.workspace?.remoteBranch : undefined, reportActions());
      }
    }),
    command('actionsLive.filter', async () => {
      const client = service.github;
      const current = service.filters;
      type Item = vscode.QuickPickItem & { apply: (filters: RunFilters) => Promise<RunFilters | undefined> };
      const items: Item[] = [
        { label: `${current.mine ? '$(check)' : '$(blank)'} Started by me`, apply: async (filters) => ({ ...filters, mine: !filters.mine }) },
        { label: `${current.failed ? '$(check)' : '$(blank)'} Failed only`, apply: async (filters) => ({ ...filters, failed: !filters.failed }) },
        {
          label: `$(blank) Workflow: ${current.workflowName ?? 'all'}`,
          apply: async (filters) => {
            const workflows = client ? await client.workflows() : [];
            const picked = await vscode.window.showQuickPick(
              [
                { label: 'All workflows', id: undefined as number | undefined },
                ...workflows.map((workflow) => ({ label: workflow.name, description: workflow.path, id: workflow.id as number | undefined }))
              ],
              { title: 'Show runs of' }
            );
            return picked ? { ...filters, workflowId: picked.id, workflowName: picked.id ? picked.label : undefined } : undefined;
          }
        },
        { label: '$(clear-all) Clear filters', apply: async () => ({}) }
      ];
      const choice = await vscode.window.showQuickPick(items, { title: 'Filter Runs', placeHolder: 'For the branch, use the branch button in the view title' });
      const next = choice ? await choice.apply(current) : undefined;
      if (next) {
        await service.setFilters(next);
      }
    }),
    command('actionsLive.clearFilters', () => service.setFilters({})),
    command('actionsLive.showWorkflowRuns', async (workflowId: number, workflowName: string) => {
      await service.setFilters({ ...service.filters, workflowId, workflowName });
      await vscode.commands.executeCommand('actionsLive.runs.focus');
    }),
    command('actionsLive.loadMore', () => service.loadMore()),
    command('actionsLive.downloadArtifact', async (target: Target) => {
      const client = service.github;
      if (target?.kind !== 'artifact' || !client) {
        return;
      }
      const run = service.findRun(target.runId);
      const artifact = run ? service.artifactsOf(run)?.find((candidate) => candidate.id === target.artifactId) : undefined;
      if (!artifact) {
        return;
      }
      const destination = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(root() ?? vscode.Uri.file(homedir()), `${artifact.name}.zip`),
        filters: { 'Zip archive': ['zip'] },
        title: `Download artifact ${artifact.name}`
      });
      if (!destination) {
        return;
      }
      const bytes = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Downloading ${artifact.name}…` }, () =>
        client.downloadArtifact(artifact.id)
      );
      await vscode.workspace.fs.writeFile(destination, bytes);
      const choice = await vscode.window.showInformationMessage(`Saved ${artifact.name}.zip.`, 'Reveal');
      if (choice) {
        void vscode.commands.executeCommand('revealFileInOS', destination);
      }
    }),
    command('actionsLive.reviewDeployments', async (target: Target, ref?: RepoRef) => {
      const run = await runOf(target, ref);
      if (run) {
        await reviewDeployments(run, ref);
      }
    }),
    command('actionsLive.showErrorsInProblems', async (target: Target, ref?: RepoRef) => {
      if (!(await offerPro(license, 'Showing CI errors in Problems'))) {
        return;
      }
      const run = await runOf(target, ref);
      if (run) {
        await showProblems(run, ref);
      }
    }),
    command('actionsLive.clearProblems', () => problems.clear()),
    command('actionsLive.getPro', async () => {
      if (license.isLicensed) {
        void vscode.window.showInformationMessage(`Actions Live Pro is active${license.plan ? ` (${license.plan})` : ''}. Thank you!`);
        return;
      }
      const items: Array<vscode.QuickPickItem & { action: () => Promise<boolean> }> = [
        { label: `$(credit-card) Monthly · ${PRO.monthlyPrice}`, detail: 'Cancel any time.', action: () => openCheckout(license, 'monthly') },
        { label: `$(star-full) Lifetime · ${PRO.lifetimePrice}`, detail: 'Pay once, keep Pro.', action: () => openCheckout(license, 'lifetime') },
        { label: '$(key) Enter licence key', action: () => license.enterKey() }
      ];
      if (!license.trialStarted) {
        items.unshift({ label: `$(gift) Try Pro free for ${PRO.trialDays} days`, detail: 'No card, no sign-up.', action: () => license.startTrial() });
      }
      const left = license.trialDaysLeft;
      const choice = await vscode.window.showQuickPick(items, {
        title: left ? `Actions Live Pro — trial, ${left} day${left === 1 ? '' : 's'} left` : 'Actions Live Pro',
        placeHolder: 'CI errors in Problems on the right lines, system notifications, compare with last green, workflow health'
      });
      await choice?.action();
    }),
    command('actionsLive.enterLicenseKey', () => license.enterKey()),
    command('actionsLive.removeLicense', () => license.remove())
  );

  // Logs opened from a link or restored with the window get their language and marks too.
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (document.uri.scheme === LOG_SCHEME && document.languageId !== LOG_LANGUAGE && parseLogUri(document.uri)) {
        void vscode.languages.setTextDocumentLanguage(document, LOG_LANGUAGE);
      }
    })
  );

  // #ciFailures for chat and agents: what failed in CI, without a copy and paste.
  if (typeof vscode.lm?.registerTool === 'function') {
    context.subscriptions.push(
      vscode.lm.registerTool(
        'actionsLive_ciFailures',
        new CiFailuresTool(async (runId) => {
          const repo = service.workspace;
          const client = service.github;
          if (!repo || !client) {
            return 'No GitHub repository is open in this window.';
          }
          const run =
            (runId ? (service.findRun(runId) ?? (await client.run(runId).catch(() => undefined))) : undefined) ??
            service.headRuns.find((candidate) => toneOf(candidate) === 'failure') ??
            service.runs.find((candidate) => toneOf(candidate) === 'failure' && candidate.head_branch === repo.remoteBranch);
          if (!run) {
            return `No failed GitHub Actions run for ${repo.head ? `commit ${repo.head.slice(0, 7)}` : 'this branch'}${
              repo.remoteBranch ? ` on ${repo.remoteBranch}` : ''
            }. CI of the current commit: ${service.headChecks?.tone ?? 'no checks yet'}.`;
          }
          return { ref: repo.ref, run, jobs: await jobsOfRun(run), root: repo.root };
        }, logs)
      )
    );
  }

  void vscode.commands.executeCommand('setContext', 'actionsLive.branchOnly', service.branchOnly);
  void vscode.commands.executeCommand('setContext', 'actionsLive.filtered', service.isFiltered);
  void vscode.commands.executeCommand('setContext', 'actionsLive.pro', license.isPro);
  setState();
  void license.refresh();
  await git.start();
  if (!service.workspace) {
    setState();
  }
}

export function deactivate(): void {
  // Everything is disposed through the context's subscriptions.
}
