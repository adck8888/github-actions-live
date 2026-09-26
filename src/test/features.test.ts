import * as assert from 'assert';
import { ciSummary, CheckRun, describeMergeState } from '../checks';
import { groupJobs, median, workflowHealth } from '../health';
import { mapLine, parseDiff } from '../lineMap';
import { normalizeForCompare } from '../logParser';
import { Job, Run } from '../model';

function check(id: number, name: string, status: string, conclusion: string | null, startedAt = '2026-09-26T10:00:00Z', app = 'github-actions'): CheckRun {
  return { id, name, status, conclusion, started_at: startedAt, completed_at: null, html_url: null, app: { slug: app } };
}

function run(id: number, sha: string, conclusion: string, extra: Partial<Run> = {}): Run {
  const created = new Date(Date.UTC(2026, 8, 1) + id * 3600_000).toISOString();
  const updated = new Date(Date.parse(created) + 300_000).toISOString();
  return {
    id,
    run_number: id,
    event: 'push',
    status: 'completed',
    conclusion,
    head_branch: 'main',
    head_sha: sha,
    workflow_id: 1,
    html_url: '',
    created_at: created,
    updated_at: updated,
    ...extra
  };
}

let nextJob = 1;
function job(name: string, steps: Array<[string, string, number]> = []): Job {
  return {
    id: nextJob++,
    run_id: 1,
    name,
    status: 'completed',
    conclusion: 'success',
    html_url: null,
    started_at: null,
    completed_at: null,
    steps: steps.map(([stepName, conclusion, seconds], index) => ({
      name: stepName,
      number: index + 1,
      status: 'completed',
      conclusion,
      started_at: '2026-09-01T00:00:00Z',
      completed_at: new Date(Date.UTC(2026, 8, 1) + seconds * 1000).toISOString()
    }))
  };
}

describe('ciSummary', () => {
  it('counts checks of other apps and commit statuses, not only Actions', () => {
    const summary = ciSummary(
      [check(1, 'build', 'completed', 'success'), check(2, 'Vercel', 'completed', 'failure', undefined, 'vercel')],
      [{ context: 'codecov/project', state: 'success', target_url: null }]
    );
    assert.strictEqual(summary.tone, 'failure');
    assert.strictEqual(summary.total, 3);
    assert.deepStrictEqual(
      summary.failed.map((item) => item.name),
      ['Vercel']
    );
  });

  it('lets a re-run replace the failed check of the same name', () => {
    const summary = ciSummary(
      [check(1, 'test', 'completed', 'failure', '2026-09-26T10:00:00Z'), check(2, 'test', 'completed', 'success', '2026-09-26T10:05:00Z')],
      []
    );
    assert.strictEqual(summary.tone, 'success');
    assert.strictEqual(summary.total, 1);
  });

  it('is running while a status is pending, and ignores skipped checks', () => {
    const summary = ciSummary(
      [check(1, 'deploy', 'completed', 'skipped'), check(2, 'lint', 'completed', 'success')],
      [{ context: 'ci/jenkins', state: 'pending', target_url: null }]
    );
    assert.strictEqual(summary.tone, 'running');
    assert.strictEqual(summary.total, 2);
    assert.strictEqual(summary.done, 1);
  });

  it('describes merge states', () => {
    assert.strictEqual(describeMergeState('dirty'), 'has merge conflicts');
    assert.strictEqual(describeMergeState('clean', true), 'draft');
  });
});

describe('line mapping', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -3,0 +4,2 @@ context',
    '+one',
    '+two',
    '@@ -10,2 +12 @@',
    '-old',
    '-old',
    '+new',
    'diff --git a/src/gone.ts b/src/gone.ts',
    '--- a/src/gone.ts',
    '+++ /dev/null',
    '@@ -1,3 +0,0 @@'
  ].join('\n');

  it('moves lines past insertions and deletions', () => {
    const hunks = parseDiff(diff).get('src/a.ts')!;
    assert.deepStrictEqual(mapLine(hunks, 2), { line: 2, changed: false });
    assert.deepStrictEqual(mapLine(hunks, 5), { line: 7, changed: false });
    assert.deepStrictEqual(mapLine(hunks, 10), { line: 12, changed: true });
    assert.deepStrictEqual(mapLine(hunks, 20), { line: 21, changed: false });
  });

  it('skips deleted files and keeps untouched ones untouched', () => {
    const files = parseDiff(diff);
    assert.strictEqual(files.has('src/gone.ts'), false);
    assert.deepStrictEqual(mapLine([], 42), { line: 42, changed: false });
  });
});

describe('groupJobs', () => {
  it('folds matrix jobs and leaves lone jobs alone', () => {
    const entries = groupJobs([job('lint'), job('test (ubuntu, 18)'), job('test (windows, 20)'), job('deploy (prod)')]);
    assert.deepStrictEqual(
      entries.map((entry) => (entry.kind === 'group' ? `${entry.name}×${entry.jobs.length}` : entry.job.name)),
      ['lint', 'test×2', 'deploy (prod)']
    );
  });
});

describe('workflowHealth', () => {
  it('finds re-runs and same-commit retries that passed', () => {
    const runs = [run(5, 'c', 'success', { run_attempt: 2 }), run(4, 'b', 'success'), run(3, 'b', 'failure'), run(2, 'a', 'success'), run(1, 'z', 'cancelled')];
    const health = workflowHealth(runs, new Map());
    assert.deepStrictEqual(
      health.flaky.map((item) => [item.sha, item.reason]),
      [
        ['c', 'rerun'],
        ['b', 'same-commit']
      ]
    );
    assert.strictEqual(health.finished, 4);
    assert.strictEqual(health.successRate, 0.75);
  });

  it('spots steps that got slower and steps that fail most', () => {
    const runs = Array.from({ length: 10 }, (_, index) => run(100 - index, `s${index}`, 'success'));
    const jobs = new Map<number, Job[]>();
    runs.forEach((item, index) => {
      jobs.set(item.id, [
        job('build', [
          ['Install', 'success', index < 5 ? 90 : 30],
          ['Test', index === 7 ? 'failure' : 'success', 10]
        ])
      ]);
    });
    const health = workflowHealth(runs, jobs);
    assert.deepStrictEqual(
      health.slower.map((item) => [item.step, item.recentMs, item.previousMs]),
      [['Install', 90_000, 30_000]]
    );
    assert.deepStrictEqual(
      health.failingSteps.map((item) => [item.step, item.count]),
      [['Test', 1]]
    );
    assert.strictEqual(median([3, 1, 2, 10]), 2.5);
  });
});

describe('normalizeForCompare', () => {
  it('drops what changes between runs of the same job', () => {
    const a = normalizeForCompare('━━ ✓ 3. Run tests · 1m 05s ━━\nTests: 12 passed in 3.2s\nsha 0123456789abcdef0123456789abcdef01234567');
    const b = normalizeForCompare('━━ ✓ 3. Run tests · 58s ━━\nTests: 12 passed in 2.9s\nsha fedcba9876543210fedcba9876543210fedcba98');
    assert.strictEqual(a, b);
  });
});
