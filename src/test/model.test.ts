import * as assert from 'assert';
import { apiBase, enterpriseHostOf, parseRemote, pickRemote, webBase } from '../remote';
import { commitStatus, finishedSince, formatAgo, formatDuration, Run, toneOf } from '../model';

function run(id: number, status: string, conclusion: string | null, extra: Partial<Run> = {}): Run {
  return {
    id,
    run_number: id,
    event: 'push',
    status,
    conclusion,
    head_branch: 'main',
    head_sha: 'abc',
    workflow_id: id,
    html_url: `https://github.com/o/r/actions/runs/${id}`,
    created_at: '2026-09-26T10:00:00Z',
    updated_at: '2026-09-26T10:03:00Z',
    ...extra
  };
}

describe('parseRemote', () => {
  it('reads every remote form git accepts', () => {
    const expected = { host: 'github.com', owner: 'adck8888', repo: 'app' };
    for (const url of [
      'https://github.com/adck8888/app.git',
      'https://github.com/adck8888/app',
      'https://token@github.com/adck8888/app.git',
      'git@github.com:adck8888/app.git',
      'ssh://git@github.com/adck8888/app.git',
      'ssh://git@ssh.github.com:443/adck8888/app.git',
      'git://github.com/adck8888/app'
    ]) {
      assert.deepStrictEqual(parseRemote(url), expected, url);
    }
    assert.deepStrictEqual(parseRemote('git@github.acme.com:team/svc.git'), { host: 'github.acme.com', owner: 'team', repo: 'svc' });
    assert.strictEqual(parseRemote('/local/path/repo'), undefined);
    assert.strictEqual(parseRemote('https://gitlab.com/group/sub/repo.git'), undefined);
  });

  it('knows each flavour of GitHub API', () => {
    assert.strictEqual(apiBase('github.com'), 'https://api.github.com');
    assert.strictEqual(apiBase('acme.ghe.com'), 'https://api.acme.ghe.com');
    assert.strictEqual(apiBase('github.acme.com'), 'https://github.acme.com/api/v3');
    assert.strictEqual(webBase('github.acme.com'), 'https://github.acme.com');
    assert.strictEqual(enterpriseHostOf('https://GitHub.Acme.com/'), 'github.acme.com');
    assert.strictEqual(enterpriseHostOf('github.acme.com'), 'github.acme.com');
  });

  it('follows the upstream remote, then origin, and skips hosts it cannot reach', () => {
    const remotes = [
      { name: 'gitlab', url: 'https://gitlab.com/o/r.git' },
      { name: 'origin', url: 'git@github.com:me/fork.git' },
      { name: 'upstream', url: 'git@github.com:org/main.git' },
      { name: 'corp', url: 'https://github.acme.com/team/svc.git' }
    ];
    assert.strictEqual(pickRemote(remotes, 'upstream', undefined)?.owner, 'org');
    assert.strictEqual(pickRemote(remotes, undefined, undefined)?.owner, 'me');
    assert.strictEqual(pickRemote([remotes[0], remotes[3]], undefined, undefined), undefined);
    assert.strictEqual(pickRemote([remotes[0], remotes[3]], undefined, 'github.acme.com')?.owner, 'team');
  });
});

describe('commitStatus', () => {
  it('is red when any workflow failed, even while others run', () => {
    const status = commitStatus([run(1, 'completed', 'failure'), run(2, 'in_progress', null), run(3, 'completed', 'success')]);
    assert.strictEqual(status.tone, 'failure');
    assert.strictEqual(status.total, 3);
    assert.strictEqual(status.done, 2);
  });

  it('is running until every workflow finished, then green', () => {
    assert.strictEqual(commitStatus([run(1, 'queued', null), run(2, 'completed', 'success')]).tone, 'queued');
    assert.strictEqual(commitStatus([run(1, 'in_progress', null), run(2, 'queued', null)]).tone, 'running');
    assert.strictEqual(commitStatus([run(1, 'completed', 'success'), run(2, 'completed', 'skipped')]).tone, 'success');
    assert.strictEqual(commitStatus([]).tone, 'none');
  });

  it('lets a newer run of the same workflow replace a failed one', () => {
    const failed = run(1, 'completed', 'failure', { workflow_id: 7 });
    const retried = run(2, 'completed', 'success', { workflow_id: 7, created_at: '2026-09-26T11:00:00Z' });
    assert.strictEqual(commitStatus([failed, retried]).tone, 'success');
  });
});

describe('toneOf', () => {
  it('maps GitHub statuses and conclusions', () => {
    assert.strictEqual(toneOf({ status: 'waiting', conclusion: null }), 'queued');
    assert.strictEqual(toneOf({ status: 'completed', conclusion: 'timed_out' }), 'failure');
    assert.strictEqual(toneOf({ status: 'completed', conclusion: 'startup_failure' }), 'failure');
    assert.strictEqual(toneOf({ status: 'completed', conclusion: 'neutral' }), 'neutral');
  });
});

describe('finishedSince', () => {
  it('reports runs that were active last time and are done now, including re-runs', () => {
    const before = new Map<number, Run>([
      [1, run(1, 'in_progress', null)],
      [2, run(2, 'completed', 'success')],
      [3, run(3, 'completed', 'failure', { run_attempt: 1 })]
    ]);
    const after = [
      run(1, 'completed', 'failure'),
      run(2, 'completed', 'success'),
      run(3, 'completed', 'success', { run_attempt: 2 }),
      run(4, 'completed', 'success')
    ];
    assert.deepStrictEqual(finishedSince(before, after).map((item) => item.id), [1, 3]);
  });
});

describe('formatting', () => {
  it('writes durations and ages compactly', () => {
    assert.strictEqual(formatDuration(42_000), '42s');
    assert.strictEqual(formatDuration(185_000), '3m 05s');
    assert.strictEqual(formatDuration(4_320_000), '1h 12m');
    const now = Date.parse('2026-09-26T12:00:00Z');
    assert.strictEqual(formatAgo('2026-09-26T11:59:40Z', now), 'just now');
    assert.strictEqual(formatAgo('2026-09-26T11:55:00Z', now), '5m ago');
    assert.strictEqual(formatAgo('2026-09-24T12:00:00Z', now), '2d ago');
  });
});
