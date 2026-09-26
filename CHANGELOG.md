# Changelog

## 0.3.0

- A run page: status, summary cards, why it failed (the error in context, clickable file
  references, annotations), a timeline of jobs and steps, artifacts and every action on the run.
  It updates live and opens with a click on a run, from the status bar or from a notification.
- Workflow Health (Pro) is now a dashboard: pass rate, duration trend, a chart of recent runs,
  flaky runs, steps that fail most and steps that got slower.
- Compare with Last Green Run (Pro) is now a page with both runs side by side, the commits and
  files in between, and a button for the log diff.
- A Get Started walkthrough.
- Workflow files show their last run, pass rate, Run workflow and All runs as code lenses.
- When GitHub's rate limit is hit, polling pauses until the limit resets instead of retrying.

## 0.2.0

- The status bar and a new pull request row count every check of your commit: Actions jobs,
  other apps' checks and commit statuses, plus whether the pull request can merge.
- Fix in Chat on failed jobs, and a `#ciFailures` tool for chat and agent mode. It replaces
  the Pro "Explain this failure".
- Open When It Finishes: a running job's log opens by itself once GitHub has it.
- Matrix jobs grouped, artifacts downloadable, deployments waiting for review can be approved or
  rejected, filters for your runs, failed runs and one workflow, and older runs on demand.
- Pro: errors in Problems follow your edits since the commit CI ran on (through `git diff`).
- Pro: system notifications while VS Code is in the background, also for deployments waiting
  for review.
- Pro: Compare with Last Green Run, with a diff of the two logs of the same job.
- Pro: Workflow Health: pass rate, duration trend, flaky runs, steps that fail most or got slower.
- Needs VS Code 1.95 or later.

## 0.1.0

- Live list of workflow runs with their jobs and steps, updating while they run.
- CI status of the current commit in the status bar.
- Readable job logs that open on the failing line, with folding, step headers and links to files.
- Re-run failed jobs, re-run all, cancel, and run `workflow_dispatch` workflows with their inputs.
- Pro: CI errors in the Problems panel, notifications when CI finishes, AI explanation of a failure.
