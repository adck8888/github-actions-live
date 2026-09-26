import * as vscode from 'vscode';
import { CheckRun, CommitStatusEntry } from './checks';
import { Annotation, Job, Run } from './model';
import { apiBase, isDotCom, RepoRef } from './remote';

const USER_AGENT = 'github-actions-live';
// The same scopes as other GitHub extensions ask for, so one sign-in serves them all.
const SCOPES = ['repo'];

export interface RunFilter {
  branch?: string;
  headSha?: string;
  actor?: string;
  status?: string;
  workflowId?: number;
  perPage?: number;
  page?: number;
}

export interface PullRequest {
  number: number;
  title: string;
  html_url: string;
  draft?: boolean;
  state: string;
  mergeable_state?: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  user?: { login: string } | null;
}

export interface Artifact {
  id: number;
  name: string;
  size_in_bytes: number;
  expired: boolean;
  archive_download_url: string;
}

export interface PendingDeployment {
  environment: { id: number; name: string; html_url?: string };
  wait_timer: number;
  current_user_can_approve: boolean;
  reviewers: Array<{ type: string; reviewer: { login?: string; name?: string } }>;
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** When the rate limit opens again, for a 429 or a limited 403. */
    readonly resetAt?: number
  ) {
    super(message);
  }
}

/**
 * Talks to the REST API of one host with the GitHub sign-in built into VS
 * Code. GET answers are remembered with their ETag, so polling an unchanged
 * list costs a 304 that GitHub does not count against the rate limit.
 */
export class GitHubClient {
  private readonly etags = new Map<string, { etag: string; body: unknown }>();
  /** Requests left in the current rate-limit window, as last reported. */
  remaining: number | undefined;

  constructor(readonly repo: RepoRef) {}

  get provider(): string {
    return isDotCom(this.repo.host) ? 'github' : 'github-enterprise';
  }

  private get base(): string {
    return `${apiBase(this.repo.host)}/repos/${encodeURIComponent(this.repo.owner)}/${encodeURIComponent(this.repo.repo)}`;
  }

  async session(createIfNone = false): Promise<vscode.AuthenticationSession | undefined> {
    try {
      return await vscode.authentication.getSession(this.provider, SCOPES, createIfNone ? { createIfNone: true } : { silent: true });
    } catch {
      return undefined;
    }
  }

  async runs(options: RunFilter = {}): Promise<Run[]> {
    const query = new URLSearchParams({ per_page: String(options.perPage ?? 30) });
    if (options.branch) {
      query.set('branch', options.branch);
    }
    if (options.headSha) {
      query.set('head_sha', options.headSha);
    }
    if (options.actor) {
      query.set('actor', options.actor);
    }
    if (options.status) {
      query.set('status', options.status);
    }
    if (options.page && options.page > 1) {
      query.set('page', String(options.page));
    }
    const path = options.workflowId ? `/actions/workflows/${options.workflowId}/runs` : '/actions/runs';
    const body = await this.get<{ workflow_runs: Run[] }>(`${path}?${query}`);
    return body.workflow_runs ?? [];
  }

  /** Check runs of a commit: Actions jobs and the checks of every other app. */
  async checkRuns(sha: string): Promise<CheckRun[]> {
    const body = await this.get<{ check_runs: CheckRun[] }>(`/commits/${sha}/check-runs?per_page=100&filter=latest`);
    return body.check_runs ?? [];
  }

  /** Commit statuses, the older API some CI services report through. */
  async statuses(sha: string): Promise<CommitStatusEntry[]> {
    const body = await this.get<{ statuses: CommitStatusEntry[] }>(`/commits/${sha}/status?per_page=100`);
    return body.statuses ?? [];
  }

  /** The open pull request whose head is this branch of this repository, if any. */
  async pullForBranch(branch: string): Promise<PullRequest | undefined> {
    const query = new URLSearchParams({ state: 'open', head: `${this.repo.owner}:${branch}`, per_page: '5' });
    const list = await this.get<PullRequest[]>(`/pulls?${query}`);
    if (!list?.length) {
      return undefined;
    }
    // The list leaves out mergeable_state; the pull itself has it.
    return this.get<PullRequest>(`/pulls/${list[0].number}`);
  }

  async artifacts(runId: number): Promise<Artifact[]> {
    const body = await this.get<{ artifacts: Artifact[] }>(`/actions/runs/${runId}/artifacts?per_page=100`);
    return body.artifacts ?? [];
  }

  /** The zip of an artifact. GitHub redirects to a short-lived storage URL. */
  async downloadArtifact(artifactId: number): Promise<Uint8Array> {
    const response = await this.fetch(`${this.base}/actions/artifacts/${artifactId}/zip`, 'GET', undefined, {});
    return new Uint8Array(await response.arrayBuffer());
  }

  async pendingDeployments(runId: number): Promise<PendingDeployment[]> {
    return (await this.get<PendingDeployment[]>(`/actions/runs/${runId}/pending_deployments`)) ?? [];
  }

  reviewDeployments(runId: number, environmentIds: number[], state: 'approved' | 'rejected', comment: string): Promise<void> {
    return this.post(`/actions/runs/${runId}/pending_deployments`, { environment_ids: environmentIds, state, comment });
  }

  /** Commits between two shas, oldest first, and the files they touched. */
  async compare(base: string, head: string): Promise<{
    commits: Array<{ sha: string; html_url: string; commit: { message: string; author?: { name?: string } | null } }>;
    files?: Array<{ filename: string; status: string; additions: number; deletions: number }>;
    total_commits: number;
    html_url: string;
  }> {
    return this.get(`/compare/${base}...${head}`);
  }

  async jobsOfAttempt(runId: number, attempt: number): Promise<Job[]> {
    const body = await this.get<{ jobs: Job[] }>(`/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`);
    return body.jobs ?? [];
  }

  async run(id: number): Promise<Run> {
    return this.get<Run>(`/actions/runs/${id}`);
  }

  async jobs(runId: number): Promise<Job[]> {
    const body = await this.get<{ jobs: Job[] }>(`/actions/runs/${runId}/jobs?per_page=100&filter=latest`);
    return body.jobs ?? [];
  }

  async job(id: number): Promise<Job> {
    return this.get<Job>(`/actions/jobs/${id}`);
  }

  /**
   * The plain-text log of a finished job. GitHub redirects to a short-lived blob URL; the API
   * answers 415 to any Accept header other than its own, so the default one stays.
   */
  async log(jobId: number): Promise<string> {
    const response = await this.fetch(`${this.base}/actions/jobs/${jobId}/logs`, 'GET', undefined, {});
    return response.text();
  }

  async annotations(jobId: number): Promise<Annotation[]> {
    return this.get<Annotation[]>(`/check-runs/${jobId}/annotations?per_page=100`);
  }

  async workflows(): Promise<Array<{ id: number; name: string; path: string; state: string }>> {
    const body = await this.get<{ workflows: Array<{ id: number; name: string; path: string; state: string }> }>('/actions/workflows?per_page=100');
    return body.workflows ?? [];
  }

  rerun(runId: number): Promise<void> {
    return this.post(`/actions/runs/${runId}/rerun`);
  }

  rerunFailed(runId: number): Promise<void> {
    return this.post(`/actions/runs/${runId}/rerun-failed-jobs`);
  }

  cancel(runId: number): Promise<void> {
    return this.post(`/actions/runs/${runId}/cancel`);
  }

  dispatch(workflowId: number | string, ref: string, inputs: Record<string, string>): Promise<void> {
    return this.post(`/actions/workflows/${encodeURIComponent(String(workflowId))}/dispatches`, { ref, inputs });
  }

  private async get<T>(path: string): Promise<T> {
    const url = `${this.base}${path}`;
    const cached = this.etags.get(url);
    const response = await this.fetch(url, 'GET', undefined, cached ? { 'If-None-Match': cached.etag } : {});
    if (response.status === 304 && cached) {
      return cached.body as T;
    }
    const body = (await response.json()) as T;
    const etag = response.headers.get('etag');
    if (etag) {
      this.etags.set(url, { etag, body });
    }
    return body;
  }

  private async post(path: string, body?: unknown): Promise<void> {
    await this.fetch(`${this.base}${path}`, 'POST', body, {}, true);
  }

  private async fetch(url: string, method: string, body: unknown, headers: Record<string, string>, interactive = false): Promise<Response> {
    const session = await this.session(interactive);
    if (!session) {
      throw new GitHubError(401, 'Sign in to GitHub to see the runs of this repository.');
    }
    const response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': USER_AGENT,
        Authorization: `Bearer ${session.accessToken}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const remaining = Number(response.headers.get('x-ratelimit-remaining'));
    if (Number.isFinite(remaining) && response.headers.has('x-ratelimit-remaining')) {
      this.remaining = remaining;
    }
    if (!response.ok && response.status !== 304) {
      const reset = Number(response.headers.get('x-ratelimit-reset'));
      const limited = response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0');
      throw new GitHubError(response.status, await explain(response, this.repo), limited && reset ? reset * 1000 : undefined);
    }
    return response;
  }
}

/** A readable reason for a failed request, instead of a bare status code. */
async function explain(response: Response, repo: RepoRef): Promise<string> {
  const slug = `${repo.owner}/${repo.repo}`;
  let detail = '';
  try {
    detail = ((await response.json()) as { message?: string }).message ?? '';
  } catch {
    // Not JSON.
  }
  if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    const at = reset ? ` after ${new Date(reset * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : ' later';
    return `GitHub's API rate limit is used up. Runs will update again${at}.`;
  }
  if (response.status === 401) {
    return 'GitHub did not accept the sign-in. Sign out of GitHub in VS Code (Accounts menu) and sign in again.';
  }
  if (response.status === 403) {
    return detail
      ? `GitHub refused: ${detail}. If ${slug} belongs to an organization with SSO, authorize the VS Code sign-in for it on GitHub.`
      : `GitHub refused access to ${slug}. If it belongs to an organization with SSO, authorize the VS Code sign-in for it on GitHub.`;
  }
  if (response.status === 404) {
    return `GitHub cannot find ${slug}, or this account cannot see it.`;
  }
  if (response.status === 410) {
    return 'GitHub no longer keeps this log: logs are deleted after the repository’s retention period.';
  }
  return `GitHub answered ${response.status}${detail ? `: ${detail}` : ` ${response.statusText}`}`;
}
