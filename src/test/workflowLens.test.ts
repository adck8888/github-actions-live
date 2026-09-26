import * as assert from 'assert';
import { commitStatus, noJobs, toneOf } from '../model';
import { lastRunLabel, passRate } from '../workflowStats';
import { NOW, sampleRun } from './webviewFixtures';

describe('workflow code lens', () => {
  it('describes the last run', () => {
    assert.strictEqual(lastRunLabel(sampleRun({ conclusion: 'success', status: 'completed', updated_at: new Date(NOW - 7_200_000).toISOString() }), NOW).startsWith('$(check) Passed 2h ago · #'), true);
    assert.match(lastRunLabel(sampleRun({ status: 'in_progress', conclusion: null, run_started_at: new Date(NOW - 65_000).toISOString() }), NOW), /^\$\(sync~spin\) Running 1m 05s · #/);
    assert.match(lastRunLabel(sampleRun({ status: 'waiting', conclusion: null }), NOW), /^\$\(sync~spin\) Waiting for review/);
    assert.match(lastRunLabel(sampleRun({ status: 'completed', conclusion: 'cancelled' }), NOW), /^\$\(circle-slash\) Cancelled/);
  });

  it('computes the pass rate and the median duration of green runs', () => {
    const runs = [
      sampleRun({ id: 1, conclusion: 'success', run_started_at: new Date(NOW - 60_000).toISOString(), updated_at: new Date(NOW).toISOString() }),
      sampleRun({ id: 2, conclusion: 'failure' }),
      sampleRun({ id: 3, conclusion: 'success', run_started_at: new Date(NOW - 180_000).toISOString(), updated_at: new Date(NOW).toISOString() }),
      sampleRun({ id: 4, conclusion: 'cancelled' }),
      sampleRun({ id: 5, conclusion: 'success', run_started_at: new Date(NOW - 120_000).toISOString(), updated_at: new Date(NOW).toISOString() })
    ];
    assert.strictEqual(passRate(runs, NOW), '75% pass of 4 · 2m 00s');
    assert.strictEqual(passRate(runs.slice(0, 2), NOW), undefined);
  });
});

describe('runs that need approval', () => {
  it('are told apart from failures', () => {
    const run = sampleRun({ status: 'completed', conclusion: 'action_required' });
    assert.strictEqual(toneOf(run), 'attention');
    assert.strictEqual(commitStatus([run]).tone, 'attention');
    assert.strictEqual(commitStatus([run, sampleRun({ id: 2, workflow_id: 8, conclusion: 'failure' })]).tone, 'failure');
    assert.strictEqual(noJobs(run), 'Waiting for a maintainer to approve this run');
  });
});
