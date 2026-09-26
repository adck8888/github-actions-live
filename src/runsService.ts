import * as vscode from 'vscode';
import { CheckRun, ciSummary, CiSummary, CommitStatusEntry } from './checks';
import { Artifact, GitHubClient, GitHubError, PullRequest } from './github';
import { sameRepo, WorkspaceRepo } from './git';
import { finishedSince, isActive, Job, Run } from './model';

export type ServiceState = 'no-repo' | 'signin' | 'loading' | 'ready' | 'error';

/** After a push, new runs show up within seconds: poll fast for this long. */
const BOOST_MS = 90_000;
const IDLE_FACTOR = 6;
const BACKGROUND_FACTOR = 4;
const ERROR_DELAY_MS = 60_000;
const PAGE = 30;
const MAX_RUNS = 100;

export interface RunFilters {
  /** Only runs this account started. */
  mine?: boolean;
  /** Only failed runs. */
  failed?: boolean;
  workflowId?: number;
  workflowName?: string;
}

/**
 * Keeps the workflow runs of the current repository up to date. It polls
 * fast while something is queued or running and slowly otherwise, fetches the
 * jobs of the runs someone is looking at, and says when a run finishes.
 */
export class RunsService implements vscode.Disposable {
  private client: GitHubClient | undefined;
  private repo: WorkspaceRepo | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private polling = false;
  private boostUntil = 0;
  private generation = 0;
  private known = new Map<number, Run>();
  private readonly jobs = new Map<number, { jobs: Job[]; runUpdatedAt: string; attempt: number }>();
  private readonly wanted = new Set<number>();
  private readonly artifactCache = new Map<number, Artifact[] | 'loading'>();
  private readonly disposables: vscode.Disposable[] = [];

  state: ServiceState = 'no-repo';
  message: string | undefined;
  runs: Run[] = [];
  headRuns: Run[] = [];
  login: string | undefined;
  branchOnly: boolean;
  filters: RunFilters;
  limit = PAGE;
  /** Every check and status of the current commit, Actions or not. */
  headChecks: CiSummary | undefined;
  /** The open pull request of the current branch. */
  pull: PullRequest | undefined;

  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly jobsChanged = new vscode.EventEmitter<number>();
  readonly onDidChangeJobs = this.jobsChanged.event;
  private readonly finished = new vscode.EventEmitter<Run[]>();
  /** Runs that were queued or running at the previous check and are done now. */
  readonly onDidFinish = this.finished.event;
  private readonly waiting = new vscode.EventEmitter<Run[]>();
  /** Runs that just stopped to wait for a deployment review. */
  readonly onDidStartWaiting = this.waiting.event;

  constructor(private readonly memento: vscode.Memento) {
    this.branchOnly = memento.get<boolean>('actionsLive.branchOnly', false);
    this.filters = memento.get<RunFilters>('actionsLive.filters', {});
    this.disposables.push(
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) {
          this.schedule(0);
        }
      }),
      vscode.authentication.onDidChangeSessions((event) => {
        if (this.client && event.provider.id === this.client.provider) {
          this.schedule(0);
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('actionsLive.pollSeconds')) {
          this.schedule(0);
        }
      })
    );
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.disposables.forEach((item) => item.dispose());
    this.changed.dispose();
    this.jobsChanged.dispose();
    this.finished.dispose();
    this.waiting.dispose();
  }

  get github(): GitHubClient | undefined {
    return this.client;
  }

  get workspace(): WorkspaceRepo | undefined {
    return this.repo;
  }

  /** Called when the repository, branch or commit of the workspace changes. */
  setRepo(repo: WorkspaceRepo | undefined): void {
    const previous = this.repo;
    this.repo = repo;
    if (!repo) {
      this.client = undefined;
      this.reset('no-repo');
      return;
    }
    if (!sameRepo(previous?.ref, repo.ref)) {
      this.client = new GitHubClient(repo.ref);
      this.reset('loading');
    } else if (previous?.head !== repo.head) {
      // A new commit is about to be pushed or was just pulled: its runs come soon.
      this.headRuns = [];
      this.headChecks = undefined;
      this.boost();
    } else if (previous?.branch !== repo.branch && this.branchOnly) {
      this.runs = [];
    }
    this.schedule(0);
  }

  /** Something happened in git (a push, a fetch): runs may be on their way. */
  nudge(): void {
    this.boost();
    this.schedule(1500);
  }

  async setBranchOnly(value: boolean): Promise<void> {
    this.branchOnly = value;
    await this.memento.update('actionsLive.branchOnly', value);
    await vscode.commands.executeCommand('setContext', 'actionsLive.branchOnly', value);
    this.runs = [];
    this.changed.fire();
    this.schedule(0);
  }

  async setFilters(filters: RunFilters): Promise<void> {
    this.filters = filters;
    this.limit = PAGE;
    await this.memento.update('actionsLive.filters', filters);
    await vscode.commands.executeCommand('setContext', 'actionsLive.filtered', this.isFiltered);
    this.runs = [];
    this.changed.fire();
    this.schedule(0);
  }

  get isFiltered(): boolean {
    return Boolean(this.filters.mine || this.filters.failed || this.filters.workflowId);
  }

  /** Whether the list may have older runs beyond what is shown. */
  get hasMore(): boolean {
    return this.runs.length >= this.limit && this.limit < MAX_RUNS;
  }

  loadMore(): void {
    this.limit = Math.min(MAX_RUNS, this.limit + PAGE);
    this.schedule(0);
  }

  refresh(): void {
    this.jobs.clear();
    this.artifactCache.clear();
    this.schedule(0);
  }

  boost(): void {
    this.boostUntil = Date.now() + BOOST_MS;
  }

  /** Cached jobs of a run; fetches them when missing or out of date. */
  jobsOf(run: Run): Job[] | undefined {
    this.wanted.add(run.id);
    const cached = this.jobs.get(run.id);
    if (!cached || cached.runUpdatedAt !== run.updated_at || cached.attempt !== (run.run_attempt ?? 1)) {
      void this.loadJobs(run);
    }
    return cached?.jobs;
  }

  /** Artifacts of a finished run; fetched once, the first time someone looks. */
  artifactsOf(run: Run): Artifact[] | undefined {
    const cached = this.artifactCache.get(run.id);
    if (cached === 'loading') {
      return undefined;
    }
    if (!cached && this.client) {
      const client = this.client;
      this.artifactCache.set(run.id, 'loading');
      void client
        .artifacts(run.id)
        .catch(() => [] as Artifact[])
        .then((artifacts) => {
          if (client === this.client) {
            this.artifactCache.set(run.id, artifacts);
            this.jobsChanged.fire(run.id);
          }
        });
      return undefined;
    }
    return cached;
  }

  /** Forgets that a run is expanded, so its jobs stop being refreshed. */
  release(runId: number): void {
    this.wanted.delete(runId);
  }

  async loadJobs(run: Run): Promise<Job[]> {
    const client = this.client;
    if (!client) {
      return [];
    }
    const jobs = await client.jobs(run.id).catch(() => undefined);
    if (!jobs || client !== this.client) {
      return this.jobs.get(run.id)?.jobs ?? [];
    }
    const before = this.jobs.get(run.id);
    this.jobs.set(run.id, { jobs, runUpdatedAt: run.updated_at, attempt: run.run_attempt ?? 1 });
    if (!before || JSON.stringify(before.jobs) !== JSON.stringify(jobs)) {
      this.jobsChanged.fire(run.id);
    }
    return jobs;
  }

  findRun(id: number): Run | undefined {
    return this.runs.find((run) => run.id === id) ?? this.headRuns.find((run) => run.id === id) ?? this.known.get(id);
  }

  private reset(state: ServiceState): void {
    this.generation++;
    this.state = state;
    this.message = undefined;
    this.runs = [];
    this.headRuns = [];
    this.headChecks = undefined;
    this.pull = undefined;
    this.limit = PAGE;
    this.known = new Map();
    this.jobs.clear();
    this.artifactCache.clear();
    this.wanted.clear();
    this.changed.fire();
  }

  private schedule(delay: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.poll(), delay);
  }

  private nextDelay(): number {
    const base = Math.max(3, vscode.workspace.getConfiguration('actionsLive').get<number>('pollSeconds', 5)) * 1000;
    const active =
      [...this.runs, ...this.headRuns].some(isActive) || (this.headChecks?.running.length ?? 0) > 0 || Date.now() < this.boostUntil;
    let delay = active ? base : base * IDLE_FACTOR;
    if (!vscode.window.state.focused) {
      delay *= BACKGROUND_FACTOR;
    }
    // Leave headroom when the rate limit runs low.
    const remaining = this.client?.remaining;
    if (remaining !== undefined && remaining < 200) {
      delay = Math.max(delay, 60_000);
    }
    return delay;
  }

  private async poll(): Promise<void> {
    if (this.polling) {
      return;
    }
    const client = this.client;
    const repo = this.repo;
    if (!client || !repo) {
      return;
    }
    this.polling = true;
    const generation = this.generation;
    try {
      const session = await client.session();
      if (!session) {
        this.state = 'signin';
        this.message = undefined;
        this.changed.fire();
        return;
      }
      this.login = session.account.label;
      const branch = this.branchOnly ? repo.remoteBranch : undefined;
      const filters = this.filters;
      const [runs, headRuns, checks, statuses, pull] = await Promise.all([
        this.branchOnly && !branch
          ? Promise.resolve([])
          : client.runs({
              branch,
              perPage: this.limit,
              actor: filters.mine ? this.login : undefined,
              status: filters.failed ? 'failure' : undefined,
              workflowId: filters.workflowId
            }),
        repo.head ? client.runs({ headSha: repo.head, perPage: 50 }) : Promise.resolve([]),
        repo.head ? client.checkRuns(repo.head).catch(() => [] as CheckRun[]) : Promise.resolve([] as CheckRun[]),
        repo.head ? client.statuses(repo.head).catch(() => [] as CommitStatusEntry[]) : Promise.resolve([] as CommitStatusEntry[]),
        repo.remoteBranch ? client.pullForBranch(repo.remoteBranch).catch(() => undefined) : Promise.resolve(undefined)
      ]);
      if (generation !== this.generation) {
        return;
      }

      const all = new Map<number, Run>();
      [...runs, ...headRuns].forEach((run) => all.set(run.id, run));
      const done = finishedSince(this.known, [...all.values()]);
      const nowWaiting = [...all.values()].filter((run) => run.status === 'waiting' && this.known.get(run.id)?.status !== 'waiting' && this.known.size > 0);
      this.known = all;
      const headChecks = checks.length || statuses.length ? ciSummary(checks, statuses) : undefined;

      const changed =
        this.state !== 'ready' ||
        JSON.stringify(runs) !== JSON.stringify(this.runs) ||
        JSON.stringify(headRuns) !== JSON.stringify(this.headRuns) ||
        JSON.stringify(headChecks) !== JSON.stringify(this.headChecks) ||
        JSON.stringify(pull) !== JSON.stringify(this.pull);
      this.runs = runs;
      this.headRuns = headRuns;
      this.headChecks = headChecks;
      this.pull = pull;
      this.state = 'ready';
      this.message = undefined;
      if (changed) {
        this.changed.fire();
      }

      // Keep the jobs of expanded, still running runs moving.
      for (const id of this.wanted) {
        const run = all.get(id);
        if (run && (isActive(run) || this.jobs.get(id)?.runUpdatedAt !== run.updated_at)) {
          void this.loadJobs(run);
        }
      }
      if (done.length) {
        this.finished.fire(done);
      }
      if (nowWaiting.length) {
        this.waiting.fire(nowWaiting);
      }
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }
      if (error instanceof GitHubError && error.status === 401) {
        this.state = 'signin';
        this.message = undefined;
      } else {
        this.state = this.runs.length ? 'ready' : 'error';
        this.message = error instanceof Error ? error.message : String(error);
      }
      this.changed.fire();
      this.polling = false;
      // Limited: no point asking again before GitHub opens the door.
      const untilReset = error instanceof GitHubError && error.resetAt ? error.resetAt - Date.now() + 2000 : 0;
      this.schedule(Math.max(ERROR_DELAY_MS, Math.min(untilReset, 3600_000)));
      return;
    } finally {
      this.polling = false;
    }
    if (generation === this.generation) {
      this.schedule(this.nextDelay());
    }
  }
}
