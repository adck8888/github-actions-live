import { execFile } from 'child_process';
import * as vscode from 'vscode';
import { enterpriseHostOf, pickRemote, RepoRef } from './remote';

/** The slice of the built-in Git extension's API this extension uses. */
interface GitApi {
  git: { path: string };
  repositories: GitRepository[];
  onDidOpenRepository: vscode.Event<GitRepository>;
  onDidCloseRepository: vscode.Event<GitRepository>;
  getRepository(uri: vscode.Uri): GitRepository | null;
}

interface GitRepository {
  rootUri: vscode.Uri;
  state: {
    HEAD?: { name?: string; commit?: string; upstream?: { remote: string; name: string }; ahead?: number; behind?: number };
    remotes: Array<{ name: string; fetchUrl?: string; pushUrl?: string }>;
    onDidChange: vscode.Event<void>;
  };
}

/** Where the workspace stands: which GitHub repository, branch and commit. */
export interface WorkspaceRepo {
  ref: RepoRef;
  root: vscode.Uri;
  branch?: string;
  /** The branch's name on the remote, when it tracks one. */
  remoteBranch?: string;
  head?: string;
}

/**
 * Follows the repository of the active editor (or the only one open) through
 * the built-in Git extension and reports when its remote, branch or commit
 * changes.
 */
export class GitWatcher implements vscode.Disposable {
  private api: GitApi | undefined;
  private current: WorkspaceRepo | undefined;
  private readonly listeners: vscode.Disposable[] = [];
  private readonly repoListeners = new Map<GitRepository, vscode.Disposable>();
  private readonly syncState = new Map<GitRepository, string>();
  private readonly changed = new vscode.EventEmitter<WorkspaceRepo | undefined>();
  readonly onDidChange = this.changed.event;
  private readonly nudged = new vscode.EventEmitter<void>();
  /** Anything happened in the followed repository: a push, a fetch, a commit. */
  readonly onDidNudge = this.nudged.event;

  async start(): Promise<void> {
    const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
    if (!extension) {
      return;
    }
    const exports = extension.isActive ? extension.exports : await extension.activate();
    this.api = exports.getAPI(1);
    this.listeners.push(
      this.api.onDidOpenRepository((repo) => {
        this.watch(repo);
        this.update();
      }),
      this.api.onDidCloseRepository((repo) => {
        this.repoListeners.get(repo)?.dispose();
        this.repoListeners.delete(repo);
        this.syncState.delete(repo);
        this.update();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('github-enterprise.uri')) {
          this.update(true);
        }
      })
    );
    this.api.repositories.forEach((repo) => this.watch(repo));
    this.update();
  }

  get repo(): WorkspaceRepo | undefined {
    return this.current;
  }

  /**
   * `git diff -U0` from a commit to the files as they are on disk, for the
   * given paths. Undefined when the commit is not in the local clone.
   */
  async diffSince(root: vscode.Uri, sha: string, paths: string[]): Promise<string | undefined> {
    const gitPath = this.api?.git.path;
    if (!gitPath || !paths.length) {
      return undefined;
    }
    const cwd = root.fsPath;
    if ((await runGit(gitPath, cwd, ['cat-file', '-e', `${sha}^{commit}`])) === undefined) {
      return undefined;
    }
    return runGit(gitPath, cwd, ['diff', '-U0', '--no-color', '--no-ext-diff', sha, '--', ...paths]);
  }

  dispose(): void {
    this.listeners.forEach((listener) => listener.dispose());
    this.repoListeners.forEach((listener) => listener.dispose());
    this.changed.dispose();
    this.nudged.dispose();
  }

  private watch(repo: GitRepository): void {
    if (!this.repoListeners.has(repo)) {
      this.repoListeners.set(
        repo,
        repo.state.onDidChange(() => {
          this.update();
          // A push shows as `ahead` dropping, a fetch as `behind` moving; plain edits change neither.
          const head = repo.state.HEAD;
          const sync = `${head?.commit}:${head?.ahead}:${head?.behind}`;
          const before = this.syncState.get(repo);
          this.syncState.set(repo, sync);
          if (before !== undefined && before !== sync && this.current?.root.toString() === repo.rootUri.toString()) {
            this.nudged.fire();
          }
        })
      );
    }
  }

  private pick(): GitRepository | undefined {
    const api = this.api;
    if (!api || !api.repositories.length) {
      return undefined;
    }
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active && active.scheme === 'file') {
      const owner = api.getRepository(active);
      if (owner) {
        return owner;
      }
    }
    // Keep following the same repository while the editor shows something outside any.
    const previous = this.current && api.repositories.find((repo) => repo.rootUri.toString() === this.current!.root.toString());
    return previous ?? api.repositories[0];
  }

  private update(force = false): void {
    const repo = this.pick();
    let next: WorkspaceRepo | undefined;
    if (repo) {
      const head = repo.state.HEAD;
      const enterprise = enterpriseHostOf(vscode.workspace.getConfiguration('github-enterprise').get<string>('uri'));
      const ref = pickRemote(
        repo.state.remotes.map((remote) => ({ name: remote.name, url: remote.fetchUrl ?? remote.pushUrl ?? '' })),
        head?.upstream?.remote,
        enterprise
      );
      if (ref) {
        next = {
          ref,
          root: repo.rootUri,
          branch: head?.name,
          remoteBranch: head?.upstream?.name ?? head?.name,
          head: head?.commit
        };
      }
    }
    if (force || !same(this.current, next)) {
      this.current = next;
      this.changed.fire(next);
    }
  }
}

/** Runs git in a repository and returns its output, or undefined when git fails. */
function runGit(gitPath: string, cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(gitPath, args, { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout) => resolve(error ? undefined : stdout));
  });
}

function same(a: WorkspaceRepo | undefined, b: WorkspaceRepo | undefined): boolean {
  return (
    a?.ref.host === b?.ref.host &&
    a?.ref.owner === b?.ref.owner &&
    a?.ref.repo === b?.ref.repo &&
    a?.root.toString() === b?.root.toString() &&
    a?.branch === b?.branch &&
    a?.remoteBranch === b?.remoteBranch &&
    a?.head === b?.head
  );
}

export function sameRepo(a: RepoRef | undefined, b: RepoRef | undefined): boolean {
  return a?.host === b?.host && a?.owner === b?.owner && a?.repo === b?.repo;
}
