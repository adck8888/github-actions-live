import * as assert from 'assert';
import { renderCompare } from '../webview/compareView';
import { esc } from '../webview/html';
import { renderHealth } from '../webview/healthView';
import { renderRun } from '../webview/runView';
import { sampleCompareView, sampleHealthView, sampleJobs, sampleRun, sampleRunView } from './webviewFixtures';

describe('pages', () => {
  it('escapes everything that comes from GitHub', () => {
    assert.strictEqual(esc(`<img src=x onerror="a('b')">&`), '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
    const jobs = sampleJobs();
    jobs[1].name = '<script>alert(1)</script>';
    const html = renderRun(sampleRunView({ jobs, run: sampleRun({ display_title: '<b onclick=x>', head_branch: '"><svg onload=1>' }) }));
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('<b onclick'));
    assert.ok(!html.includes('<svg onload'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  });

  it('shows why a run failed: the error line, file links and annotations', () => {
    const html = renderRun(sampleRunView());
    assert.match(html, /Why it failed <span class="count">1<\/span>/);
    assert.match(html, /failed at step 3: npm test/);
    assert.match(html, /<div class="ln err"><span class="no">134<\/span>/);
    assert.match(html, /data-cmd="openFile" data-path="src\/test\/logs\.test\.ts" data-line="88" data-column="12"/);
    // The annotation GitHub puts on `.github` for every failure is noise.
    assert.ok(!html.includes('data-path=".github"'));
    assert.ok(html.includes('Unused variable &lt;tmp&gt;'));
  });

  it('does not link files of a repository that is not open', () => {
    const html = renderRun(sampleRunView({ local: false }));
    assert.ok(!html.includes('data-cmd="openFile"'));
    assert.ok(!html.includes('data-cmd="health"'));
  });

  it('offers the actions that fit the state of the run', () => {
    const failed = renderRun(sampleRunView());
    assert.ok(failed.includes('data-cmd="rerunFailed"'));
    assert.ok(failed.includes('data-cmd="compare"'));
    assert.ok(!failed.includes('data-cmd="cancel"'));
    assert.match(failed, /Compare with last green<\/span><span class="pro">PRO/);
    const running = renderRun(sampleRunView({ run: sampleRun({ status: 'in_progress', conclusion: null }) }));
    assert.ok(running.includes('data-cmd="cancel"'));
    assert.ok(!running.includes('data-cmd="rerunFailed"'));
    assert.ok(running.includes('data-since'));
    const waiting = renderRun(sampleRunView({ run: sampleRun({ status: 'waiting', conclusion: null }) }));
    assert.ok(waiting.includes('A deployment is waiting for review'));
  });

  it('draws the jobs on one time axis, with matrix jobs grouped', () => {
    const html = renderRun(sampleRunView());
    assert.match(html, /test <span class="muted">· matrix of 3, <span class="t-failure">1 failed/);
    assert.strictEqual((html.match(/class="tl-row child"/g) ?? []).length, 3);
    assert.ok(html.includes('data-step="3"'));
    assert.ok(html.includes('>skipped<'));
    assert.ok(html.includes('class="tick"'));
  });

  it('shows placeholders while jobs load', () => {
    const html = renderRun(sampleRunView({ jobs: undefined, artifacts: undefined }));
    assert.ok(html.includes('skeleton'));
    assert.ok(!html.includes('Why it failed'));
  });

  it('lists artifacts and hides the download of expired ones', () => {
    const html = renderRun(sampleRunView());
    assert.strictEqual((html.match(/data-cmd="download"/g) ?? []).length, 2);
    assert.ok(html.includes('3.3 MB'));
  });

  it('renders a workflow health dashboard', () => {
    const view = sampleHealthView();
    const html = renderHealth(view);
    assert.strictEqual((html.match(/class="bar-hit"/g) ?? []).length, 30);
    assert.match(html, /Pass rate/);
    assert.match(html, /83%/);
    assert.ok(html.includes('Steps that got slower'));
    assert.ok(view.health.slower.length > 0);
    assert.ok(html.includes('×2.5'));
  });

  it('compares with the last green run', () => {
    const html = renderCompare(sampleCompareView());
    assert.ok(html.includes('A workflow file changed in between'));
    assert.ok(html.includes('data-cmd="logDiff"'));
    assert.match(html, /Commits <span class="count">3/);
    const same = renderCompare(sampleCompareView({ compare: undefined, green: sampleRun({ id: 1, conclusion: 'success' }) }));
    assert.ok(same.includes('Same commit.'));
  });
});
