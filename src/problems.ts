import * as vscode from 'vscode';
import { CiProblem, problemsFromAnnotations, problemsFromExcerpt } from './errorLocations';
import { Hunk, mapLine, parseDiff } from './lineMap';
import { LogStore } from './logDocuments';
import { Job, Run, toneOf, workflowName } from './model';
import { RepoRef } from './remote';

/** Diff from a commit to the working tree for some paths; undefined when the commit is not local. */
export type DiffSince = (sha: string, paths: string[]) => Promise<string | undefined>;

export interface ProblemsResult {
  count: number;
  /** Problems whose line was edited since the commit CI ran on. */
  changed: number;
  /** The commit CI ran on is not in the local clone, so lines could not be carried over. */
  commitMissing: boolean;
}

/**
 * Puts the errors of failed CI jobs in the Problems panel, on the lines of the
 * workspace's files they point to: check-run annotations first, then file
 * references found in the failing part of each log. Lines are carried from
 * the commit CI ran on to the files as they are now, through `git diff`.
 */
export class CiProblems implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('GitHub Actions');
  /** Run whose errors are shown, so a newer run of the same commit can replace them. */
  shownRun: number | undefined;

  constructor(private readonly logs: LogStore) {}

  dispose(): void {
    this.collection.dispose();
  }

  clear(): void {
    this.collection.clear();
    this.shownRun = undefined;
  }

  /** The problems of the given failed jobs, on files that exist in the workspace. */
  async collect(ref: RepoRef, root: vscode.Uri, jobs: Job[]): Promise<CiProblem[]> {
    const client = this.logs.client(ref);
    const failed = jobs.filter((job) => toneOf(job) === 'failure');
    const problems: CiProblem[] = [];
    await Promise.all(
      failed.map(async (job) => {
        const source = `CI · ${job.name}`;
        const annotations = await client.annotations(job.id).catch(() => []);
        problems.push(...problemsFromAnnotations(annotations, source));
        try {
          const loaded = await this.logs.load(ref, job.id);
          for (const failure of loaded.log.failures) {
            problems.push(...problemsFromExcerpt(failure, source));
          }
        } catch {
          // Logs can be gone (retention) while annotations remain.
        }
      })
    );
    const unique: CiProblem[] = [];
    const seen = new Set<string>();
    for (const problem of problems) {
      const path = problem.path.replace(/\\/g, '/');
      const key = `${path}:${problem.line}:${problem.message}`;
      if (!seen.has(key) && (await isFile(vscode.Uri.joinPath(root, path)))) {
        seen.add(key);
        unique.push({ ...problem, path });
      }
    }
    return unique;
  }

  /** Collects the problems of the given failed jobs and says how many landed on files. */
  async show(ref: RepoRef, root: vscode.Uri, run: Run, jobs: Job[], diffSince?: DiffSince): Promise<ProblemsResult> {
    const problems = await this.collect(ref, root, jobs);

    // CI saw the files of its commit; the editor shows them as they are now.
    let hunks: Map<string, Hunk[]> | undefined;
    let commitMissing = false;
    if (diffSince && problems.length) {
      const diff = await diffSince(run.head_sha, [...new Set(problems.map((problem) => problem.path))]);
      commitMissing = diff === undefined;
      hunks = diff === undefined ? undefined : parseDiff(diff);
    }

    const byFile = new Map<string, vscode.Diagnostic[]>();
    let changed = 0;
    for (const problem of problems) {
      const uri = vscode.Uri.joinPath(root, problem.path);
      const mapped = hunks ? mapLine(hunks.get(problem.path) ?? [], problem.line) : { line: problem.line, changed: false };
      const shift = mapped.line - problem.line;
      const line = Math.max(0, mapped.line - 1);
      let range: vscode.Range;
      if (mapped.changed) {
        changed++;
        range = new vscode.Range(line, 0, line, 1000);
      } else {
        const column = Math.max(0, (problem.column ?? 1) - 1);
        const endLine = Math.max(line, (problem.endLine ?? problem.line) + shift - 1);
        const endColumn = problem.endColumn && endLine === line && problem.endColumn - 1 > column ? problem.endColumn - 1 : problem.column ? column + 1 : 1000;
        range = new vscode.Range(line, column, endLine, endColumn);
      }
      const diagnostic = new vscode.Diagnostic(
        range,
        mapped.changed ? `${problem.message} (reported on line ${problem.line} of the commit CI ran on; that line has been edited since)` : problem.message,
        problem.severity === 'error' ? vscode.DiagnosticSeverity.Error : problem.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information
      );
      diagnostic.source = `${problem.source} (${workflowName(run)} #${run.run_number})`;
      if (run.html_url) {
        diagnostic.code = { value: 'run', target: vscode.Uri.parse(run.html_url) };
      }
      const list = byFile.get(uri.toString()) ?? [];
      list.push(diagnostic);
      byFile.set(uri.toString(), list);
    }

    this.collection.clear();
    let count = 0;
    for (const [uri, diagnostics] of byFile) {
      this.collection.set(vscode.Uri.parse(uri), diagnostics);
      count += diagnostics.length;
    }
    this.shownRun = count ? run.id : undefined;
    return { count, changed, commitMissing };
  }
}

async function isFile(uri: vscode.Uri): Promise<boolean> {
  try {
    return ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.File) !== 0;
  } catch {
    return false;
  }
}
