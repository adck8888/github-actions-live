import { workflowHealth } from '../health';
import { Job, Run, Step } from '../model';
import { CompareView } from '../webview/compareView';
import { HealthView } from '../webview/healthView';
import { RunView } from '../webview/runView';

/** Sample data for the page tests and for previewing the pages in a browser. */
export const NOW = Date.parse('2026-09-26T12:10:00Z');

function at(minutes: number, seconds = 0): string {
  return new Date(Date.parse('2026-09-26T12:00:00Z') + (minutes * 60 + seconds) * 1000).toISOString();
}

export function sampleRun(extra: Partial<Run> = {}): Run {
  return {
    id: 901,
    name: 'CI',
    display_title: 'Speed up the log parser',
    run_number: 412,
    run_attempt: 1,
    event: 'pull_request',
    status: 'completed',
    conclusion: 'failure',
    head_branch: 'feature/faster-logs',
    head_sha: 'a1b2c3d4e5f6',
    workflow_id: 7,
    html_url: 'https://github.com/acme/app/actions/runs/901',
    created_at: at(0),
    updated_at: at(7, 40),
    run_started_at: at(0),
    actor: { login: 'octocat' },
    triggering_actor: { login: 'octocat' },
    ...extra
  };
}

function step(number: number, name: string, from: [number, number], to: [number, number], conclusion = 'success', status = 'completed'): Step {
  return { number, name, status, conclusion: status === 'completed' ? conclusion : null, started_at: at(...from), completed_at: status === 'completed' ? at(...to) : null };
}

export function sampleJobs(): Job[] {
  const job = (id: number, name: string, steps: Step[], conclusion: string | null, status = 'completed'): Job => ({
    id,
    run_id: 901,
    name,
    status,
    conclusion,
    html_url: `https://github.com/acme/app/actions/runs/901/job/${id}`,
    started_at: steps[0]?.started_at ?? null,
    completed_at: status === 'completed' ? (steps[steps.length - 1]?.completed_at ?? null) : null,
    steps
  });
  return [
    job(1, 'lint', [step(1, 'Set up job', [0, 12], [0, 15]), step(2, 'Checkout', [0, 15], [0, 20]), step(3, 'npm ci', [0, 20], [1, 5]), step(4, 'eslint', [1, 5], [1, 40])], 'success'),
    job(
      2,
      'test (ubuntu-latest, 20)',
      [step(1, 'Set up job', [0, 14], [0, 18]), step(2, 'npm ci', [0, 18], [1, 10]), step(3, 'npm test', [1, 10], [4, 2], 'failure'), step(4, 'Post checkout', [4, 2], [4, 4])],
      'failure'
    ),
    job(3, 'test (windows-latest, 20)', [step(1, 'Set up job', [0, 40], [0, 50]), step(2, 'npm ci', [0, 50], [2, 30]), step(3, 'npm test', [2, 30], [6, 55])], 'success'),
    job(4, 'test (macos-latest, 20)', [step(1, 'Set up job', [1, 30], [1, 38]), step(2, 'npm ci', [1, 38], [2, 50]), step(3, 'npm test', [2, 50], [5, 20])], 'success'),
    job(5, 'build', [step(1, 'Set up job', [0, 10], [0, 14]), step(2, 'npm run build', [0, 14], [2, 48]), step(3, 'Upload artifact', [2, 48], [3, 5])], 'success'),
    job(6, 'deploy preview', [], 'skipped')
  ];
}

export function sampleRunView(extra: Partial<RunView> = {}): RunView {
  const lines = [
    '> app@1.4.0 test',
    '> mocha "out/test/**/*.test.js"',
    '',
    '  log parser',
    '    ✔ strips timestamps',
    '    ✔ folds groups',
    '    1) keeps the error line in view',
    '  line map',
    '    ✔ follows edits',
    '',
    '  3 passing (412ms)',
    '  1 failing',
    '',
    '  1) log parser',
    '       keeps the error line in view:',
    '     AssertionError [ERR_ASSERTION]: Expected 42 to equal 41',
    '      at Context.<anonymous> (src/test/logs.test.ts:88:12)',
    '      at process.processImmediate (node:internal/timers:483:21)',
    '',
    'Error: Process completed with exit code 1.'
  ];
  return {
    run: sampleRun(),
    jobs: sampleJobs(),
    artifacts: [
      { id: 71, name: 'dist', size_in_bytes: 3_482_112, expired: false },
      { id: 72, name: 'coverage-report', size_in_bytes: 842_000, expired: false },
      { id: 73, name: 'old-logs', size_in_bytes: 1200, expired: true }
    ],
    failures: new Map([[2, { stepNumber: 3, stepName: 'npm test', lines, firstLine: 118, errorIndex: 15 }]]),
    annotations: new Map([
      [
        2,
        [
          { path: 'src/test/logs.test.ts', start_line: 88, end_line: 88, annotation_level: 'failure', title: 'AssertionError', message: 'Expected 42 to equal 41' },
          { path: '.github', start_line: 1, end_line: 1, annotation_level: 'failure', message: 'Process completed with exit code 1.' },
          { path: 'src/logParser.ts', start_line: 12, end_line: 12, annotation_level: 'warning', message: 'Unused variable <tmp>' }
        ]
      ]
    ]),
    local: true,
    pro: false,
    now: NOW,
    ...extra
  };
}

export function sampleHealthView(): HealthView {
  const runs: Run[] = [];
  const jobs = new Map<number, Job[]>();
  for (let index = 0; index < 30; index++) {
    const id = 1000 - index;
    const failed = [3, 4, 11, 17, 25].includes(index);
    const minutes = 5 + (index < 5 ? 3 : 0) + ((index * 7) % 5) / 2;
    const created = new Date(NOW - index * 5 * 3600_000).toISOString();
    const sha = index === 4 ? 'shared0000' : index === 3 ? 'feedbeef01' : `sha${index}`.padEnd(10, '0');
    runs.push(
      sampleRun({
        id,
        run_number: 400 - index,
        conclusion: failed ? 'failure' : index === 2 ? 'success' : 'success',
        head_sha: index === 2 ? 'feedbeef01' : sha,
        created_at: created,
        run_started_at: created,
        updated_at: new Date(Date.parse(created) + minutes * 60_000).toISOString(),
        run_attempt: index === 8 ? 2 : 1
      })
    );
    jobs.set(id, [
      {
        id: id * 10,
        run_id: id,
        name: 'test',
        status: 'completed',
        conclusion: failed ? 'failure' : 'success',
        html_url: null,
        started_at: created,
        completed_at: created,
        steps: [
          {
            number: 1,
            name: 'npm ci',
            status: 'completed',
            conclusion: 'success',
            started_at: created,
            completed_at: new Date(Date.parse(created) + (index < 5 ? 150 : 60) * 1000).toISOString()
          },
          { number: 2, name: index % 2 ? 'npm test' : 'e2e', status: 'completed', conclusion: failed ? 'failure' : 'success', started_at: created, completed_at: created }
        ]
      }
    ]);
  }
  return { workflow: 'CI', branch: 'main', runs, health: workflowHealth(runs, jobs), jobRuns: 20, now: NOW };
}

export function sampleCompareView(extra: Partial<CompareView> = {}): CompareView {
  return {
    green: sampleRun({ id: 880, run_number: 405, conclusion: 'success', head_sha: '0f9e8d7c6b5a', created_at: new Date(NOW - 26 * 3600_000).toISOString() }),
    red: sampleRun(),
    compare: {
      total_commits: 3,
      html_url: 'https://github.com/acme/app/compare/0f9e8d7...a1b2c3d',
      commits: [
        { sha: '1111111aaaa', html_url: 'https://github.com/acme/app/commit/1111111', commit: { message: 'Bump mocha to 11', author: { name: 'Dependabot' } } },
        { sha: '2222222bbbb', html_url: 'https://github.com/acme/app/commit/2222222', commit: { message: 'Speed up the log parser\n\nDetails', author: { name: 'Octo Cat' } } },
        { sha: 'a1b2c3d4e5f6', html_url: 'https://github.com/acme/app/commit/a1b2c3d', commit: { message: 'Run tests on macOS too', author: { name: 'Octo Cat' } } }
      ],
      files: [
        { filename: 'src/logParser.ts', status: 'modified', additions: 64, deletions: 31 },
        { filename: 'src/test/logs.test.ts', status: 'modified', additions: 12, deletions: 2 },
        { filename: '.github/workflows/ci.yml', status: 'modified', additions: 3, deletions: 1 },
        { filename: 'package-lock.json', status: 'modified', additions: 140, deletions: 138 }
      ]
    },
    logJob: 'test (ubuntu-latest, 20)',
    missingJob: undefined,
    now: NOW,
    ...extra
  };
}
