import * as vscode from 'vscode';
import { GitHubClient } from './github';
import { dispatchInputs, WorkflowInput } from './workflowInputs';

/**
 * Asks which runnable workflow to start and its inputs, then dispatches it on
 * the current branch. Resolves to true when GitHub accepted it.
 */
export async function runWorkflow(client: GitHubClient, root: vscode.Uri, branch: string | undefined, only?: string): Promise<boolean> {
  if (!branch) {
    void vscode.window.showWarningMessage('Check out a branch that exists on GitHub to run a workflow on it.');
    return false;
  }
  const workflows = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Loading workflows…' }, async () => {
    const list = await client.workflows();
    const runnable: Array<{ id: number; name: string; path: string; inputs: WorkflowInput[] }> = [];
    for (const workflow of list.filter((item) => item.state === 'active' && (!only || item.path === only))) {
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, workflow.path));
        const inputs = dispatchInputs(new TextDecoder().decode(bytes));
        if (inputs) {
          runnable.push({ ...workflow, inputs });
        }
      } catch {
        // Not in this checkout (another branch has it): skip.
      }
    }
    return runnable;
  });
  if (!workflows.length) {
    void vscode.window.showInformationMessage(
      only
        ? `${only.split('/').pop()} is not on GitHub yet or has no \`workflow_dispatch\` trigger. Push it first.`
        : 'No workflow in this checkout has a `workflow_dispatch` trigger, so none can be run by hand.'
    );
    return false;
  }
  const picked =
    workflows.length === 1
      ? workflows[0]
      : (
          await vscode.window.showQuickPick(
            workflows.map((workflow) => ({ label: workflow.name, description: workflow.path, workflow })),
            { title: `Run workflow on ${branch}`, placeHolder: 'Workflow to run' }
          )
        )?.workflow;
  if (!picked) {
    return false;
  }

  const values: Record<string, string> = {};
  for (const input of picked.inputs) {
    const title = `${picked.name}: ${input.name}${input.required ? '' : ' (optional)'}`;
    const fallback = input.default === undefined || input.default === null ? '' : String(input.default);
    let value: string | undefined;
    if (input.type === 'boolean') {
      value = (
        await vscode.window.showQuickPick(
          ['true', 'false'].map((label) => ({ label, description: label === fallback ? 'default' : undefined })),
          { title, placeHolder: input.description }
        )
      )?.label;
    } else if (input.type === 'choice' && input.options?.length) {
      value = (
        await vscode.window.showQuickPick(
          input.options.map((option) => ({ label: String(option), description: String(option) === fallback ? 'default' : undefined })),
          { title, placeHolder: input.description }
        )
      )?.label;
    } else {
      value = await vscode.window.showInputBox({
        title,
        prompt: input.description,
        value: fallback,
        ignoreFocusOut: true,
        validateInput: (text) => (input.required && !text.trim() ? 'This input is required.' : undefined)
      });
    }
    if (value === undefined) {
      return false;
    }
    if (value !== '' || input.required) {
      values[input.name] = value;
    }
  }

  try {
    await client.dispatch(picked.id, branch, values);
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not run ${picked.name}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  void vscode.window.setStatusBarMessage(`$(play) ${picked.name} started on ${branch}`, 5000);
  return true;
}
