import * as vscode from 'vscode';
import { findLocations } from './errorLocations';
import { LogStore } from './logDocuments';
import { Job, Run, toneOf, workflowName } from './model';
import { RepoRef } from './remote';

/** Lines of each referenced source file to show around the line the log points to. */
const SOURCE_CONTEXT = 12;
const MAX_FILES = 4;
const MAX_EXCERPT_LINES = 120;
const MAX_JOBS = 3;

/**
 * What a chat model needs to fix a failed job: the failing part of the log
 * (not the 5,000 lines of set-up above it), the annotations, and the lines of
 * the local files they point to.
 */
export async function failureContext(logs: LogStore, ref: RepoRef, job: Job, root: vscode.Uri | undefined): Promise<string> {
  const loaded = await logs.load(ref, job.id);
  const client = logs.client(ref);
  const annotations = await client.annotations(job.id).catch(() => []);
  const parts: string[] = [`Job "${job.name}" of ${ref.owner}/${ref.repo} failed${job.html_url ? ` (${job.html_url})` : ''}.`];

  const failures = loaded.log.failures;
  if (failures.length) {
    for (const failure of failures.slice(0, 3)) {
      parts.push(`Failing step: ${failure.stepName ?? 'unknown'}\n\`\`\`\n${failure.lines.slice(-MAX_EXCERPT_LINES).join('\n')}\n\`\`\``);
    }
  } else {
    parts.push(`End of the log:\n\`\`\`\n${loaded.log.text.split('\n').slice(-MAX_EXCERPT_LINES).join('\n')}\n\`\`\``);
  }

  const useful = annotations.filter((annotation) => annotation.path !== '.github');
  if (useful.length) {
    parts.push(
      'Annotations:\n' +
        useful
          .slice(0, 20)
          .map((annotation) => `- ${annotation.path}:${annotation.start_line} ${annotation.annotation_level}: ${annotation.title ? `${annotation.title}: ` : ''}${annotation.message}`)
          .join('\n')
    );
  }

  if (root) {
    const excerpt = failures.flatMap((failure) => failure.lines).join('\n');
    const places = [
      ...useful.map((annotation) => ({ path: annotation.path, line: annotation.start_line })),
      ...findLocations(excerpt).filter((location) => !location.path.startsWith('/') && !location.path.includes('node_modules'))
    ];
    const seen = new Set<string>();
    for (const place of places) {
      if (seen.size >= MAX_FILES || seen.has(place.path)) {
        continue;
      }
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, place.path));
        const source = new TextDecoder().decode(bytes).split('\n');
        const from = Math.max(0, place.line - 1 - SOURCE_CONTEXT);
        const to = Math.min(source.length, place.line + SOURCE_CONTEXT);
        const numbered = source.slice(from, to).map((line, index) => `${from + index + 1}${from + index + 1 === place.line ? '>' : ' '} ${line}`);
        parts.push(`${place.path} around line ${place.line} (local copy, may differ from the commit CI ran on):\n\`\`\`\n${numbered.join('\n')}\n\`\`\``);
        seen.add(place.path);
      } catch {
        // Not in this checkout.
      }
    }
  }
  return parts.join('\n\n');
}

/** The failure context of every failed job of a run, for the language model tool. */
export async function runFailureContext(logs: LogStore, ref: RepoRef, run: Run, jobs: Job[], root: vscode.Uri | undefined): Promise<string> {
  const failed = jobs.filter((job) => toneOf(job) === 'failure');
  const header = `${workflowName(run)} #${run.run_number} on ${run.head_branch ?? '?'} (commit ${run.head_sha.slice(0, 7)}, ${run.html_url}) — ${
    failed.length ? `${failed.length} of ${jobs.length} jobs failed` : `concluded ${run.conclusion ?? run.status}`
  }.`;
  if (!failed.length) {
    return header;
  }
  const parts = [header];
  for (const job of failed.slice(0, MAX_JOBS)) {
    try {
      parts.push(await failureContext(logs, ref, job, root));
    } catch (error) {
      parts.push(`Job "${job.name}" failed; its log could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failed.length > MAX_JOBS) {
    parts.push(`${failed.length - MAX_JOBS} more failed jobs are not shown: ${failed.slice(MAX_JOBS).map((job) => job.name).join(', ')}.`);
  }
  return parts.join('\n\n---\n\n');
}

/**
 * Hands a failure to the chat of the editor (Copilot or any other), with the
 * failing part of the log and the code it points to already in the prompt.
 * Without a chat, the prompt goes to the clipboard for any AI tool.
 */
export async function fixInChat(logs: LogStore, ref: RepoRef, job: Job, root: vscode.Uri | undefined): Promise<void> {
  const context = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Reading the failed log…' }, () =>
    failureContext(logs, ref, job, root)
  );
  const prompt = `A GitHub Actions job failed. Find the cause and fix it in this workspace; if the log does not show the cause, say what to check.\n\n${context}`;
  try {
    await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
    return;
  } catch {
    // No chat in this editor.
  }
  await vscode.env.clipboard.writeText(prompt);
  void vscode.window.showInformationMessage('No chat is available in this editor. The failure and the code it points to are on the clipboard: paste them into any AI assistant.');
}

export interface ToolInput {
  runId?: number;
}

/**
 * `#ciFailures` in chat and agent mode: what failed in CI for the current
 * commit (or a given run), so the agent can fix it without a copy and paste.
 */
export class CiFailuresTool implements vscode.LanguageModelTool<ToolInput> {
  constructor(private readonly resolve: (runId?: number) => Promise<{ ref: RepoRef; run: Run; jobs: Job[]; root: vscode.Uri | undefined } | string>, private readonly logs: LogStore) {}

  prepareInvocation(): vscode.PreparedToolInvocation {
    return { invocationMessage: 'Reading the failed GitHub Actions run' };
  }

  async invoke(options: vscode.LanguageModelToolInvocationOptions<ToolInput>): Promise<vscode.LanguageModelToolResult> {
    const target = await this.resolve(options.input?.runId);
    const text = typeof target === 'string' ? target : await runFailureContext(this.logs, target.ref, target.run, target.jobs, target.root);
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
  }
}
