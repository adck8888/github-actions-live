import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { renderLog, stepStarts, stripEscapes } from '../logParser';
import { findLocations, problemsFromAnnotations, problemsFromExcerpt, relativeToCheckout } from '../errorLocations';
import { Job } from '../model';

// Compiled tests run from out/test; the fixtures stay in src.
const FIXTURES = path.join(__dirname, '..', '..', 'src', 'test', 'fixtures');

function fixture(name: string): { raw: string; job: Job } {
  return {
    raw: fs.readFileSync(path.join(FIXTURES, `${name}.log`), 'utf8'),
    job: JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.job.json`), 'utf8')) as Job
  };
}

describe('renderLog on real GitHub logs', () => {
  it('drops timestamps, colour codes and group markers', () => {
    const { raw, job } = fixture('cli-cli');
    const log = renderLog(raw, job.steps);
    assert.ok(!/^\d{4}-\d\d-\d\dT\d\d:/m.test(log.text), 'timestamps left');
    assert.ok(!log.text.includes('\x1b'), 'escape codes left');
    assert.ok(!log.text.includes('##['), 'workflow commands left');
    assert.ok(log.text.includes('▾ Run gh issue edit'));
  });

  it('opens a failed job on the error of the failing step', () => {
    const { raw, job } = fixture('cli-cli');
    const log = renderLog(raw, job.steps);
    const lines = log.text.split('\n');
    assert.ok(log.focus);
    assert.strictEqual(lines[log.focus.line], '✖ Process completed with exit code 1.');
    const failedStep = job.steps!.find((step) => step.conclusion === 'failure')!;
    assert.strictEqual(log.focus.stepNumber, failedStep.number);
    // The real reason is printed just above the generic exit code line.
    const excerpt = log.failures[0].lines.join('\n');
    assert.match(excerpt, /Could not resolve to an issue or pull request/);
    assert.doesNotMatch(excerpt, /GH_TOKEN/, 'the step header (command and env) belongs to the fold, not the excerpt');
  });

  it('puts a header line at every step that ran, in order', () => {
    for (const name of ['cli-cli', 'microsoft-TypeScript', 'vitejs-vite', 'rust-lang-rust-analyzer']) {
      const { raw, job } = fixture(name);
      const log = renderLog(raw, job.steps);
      const lines = log.text.split('\n');
      const ran = job.steps!.filter((step) => step.started_at && step.conclusion !== 'skipped');
      const positions = ran.map((step) => log.stepLines.get(step.number));
      assert.ok(positions.every((line) => line !== undefined), `${name}: every step has a header`);
      for (let i = 1; i < positions.length; i++) {
        assert.ok(positions[i]! > positions[i - 1]!, `${name}: step headers in order`);
      }
      for (const step of ran) {
        assert.match(lines[log.stepLines.get(step.number)!], new RegExp(`^━━ . ${step.number}\\. `));
      }
    }
  });

  it('lands the step "Run npm ci" on its own group', () => {
    const { raw, job } = fixture('microsoft-TypeScript');
    const log = renderLog(raw, job.steps);
    const lines = log.text.split('\n');
    const step = job.steps!.find((candidate) => candidate.name === 'Run npm ci')!;
    const header = log.stepLines.get(step.number)!;
    assert.strictEqual(lines[header + 1], '▾ Run npm ci');
  });

  it('keeps the vitest failure in the excerpt of a long log', () => {
    const { raw, job } = fixture('vitejs-vite');
    const log = renderLog(raw, job.steps);
    const excerpt = log.failures[0].lines.join('\n');
    assert.match(excerpt, /AssertionError: expected/);
    assert.match(excerpt, /legacy-styles-only-entry-watch\.spec\.ts:31:40/);
    // Warnings about the cache are not errors.
    assert.ok(log.warnings.length >= 1);
  });

  it('folds groups and whole steps', () => {
    const { raw, job } = fixture('microsoft-TypeScript');
    const log = renderLog(raw, job.steps);
    const lines = log.text.split('\n');
    assert.ok(log.folds.some((fold) => lines[fold.start].startsWith('▾ Run actions/checkout')));
    assert.ok(log.folds.some((fold) => lines[fold.start].startsWith('━━')));
    assert.ok(log.folds.every((fold) => fold.end > fold.start && fold.end < log.lineCount));
  });

  it('can keep the time of each line', () => {
    const { raw, job } = fixture('cli-cli');
    const log = renderLog(raw, job.steps, { timestamps: true, formatTime: (date) => date.toISOString().slice(11, 19) });
    assert.ok(log.text.split('\n').includes('17:45:48  ✖ Process completed with exit code 1.'));
  });
});

describe('stepStarts', () => {
  it('gives two steps that start in the same second their own Run groups', () => {
    const lines = [
      '2026-01-01T00:00:01.100Z ##[group]Run a',
      '2026-01-01T00:00:01.200Z a',
      '2026-01-01T00:00:01.300Z ##[endgroup]',
      '2026-01-01T00:00:01.400Z ##[group]Run b',
      '2026-01-01T00:00:01.500Z b'
    ];
    const starts = stepStarts(lines, [
      { name: 'Run a', number: 1, status: 'completed', conclusion: 'success', started_at: '2026-01-01T00:00:01Z' },
      { name: 'Run b', number: 2, status: 'completed', conclusion: 'success', started_at: '2026-01-01T00:00:01Z' }
    ]);
    assert.deepStrictEqual([...starts.entries()].map(([line, steps]) => [line, steps.map((step) => step.number)]), [
      [0, [1]],
      [3, [2]]
    ]);
  });
});

describe('stripEscapes', () => {
  it('removes colours and hyperlinks', () => {
    assert.strictEqual(stripEscapes('\x1b[36;1mgh\x1b[0m \x1b]8;;http://x\x07link\x1b]8;;\x07'), 'gh link');
  });
});

describe('findLocations', () => {
  it('reads the common compiler and test runner formats', () => {
    const cases: Array<[string, string, number, number | undefined]> = [
      [' ❯ playground/a/__tests__/b.spec.ts:31:40', 'playground/a/__tests__/b.spec.ts', 31, 40],
      ['src/index.ts(12,5): error TS2322: Type', 'src/index.ts', 12, 5],
      ['✖     --> crates/hir-ty/src/mir/eval.rs:1685:17', 'crates/hir-ty/src/mir/eval.rs', 1685, 17],
      ['/home/runner/work/app/app/src/x.go:7: undefined: y', 'src/x.go', 7, undefined],
      ['D:\\a\\app\\app\\lib\\mod.py:3:1: E302', 'lib/mod.py', 3, 1],
      ['  File "/github/workspace/pkg/t.py", line 44, in test', 'pkg/t.py', 44, undefined],
      ['./tests/unit.test.js:9', 'tests/unit.test.js', 9, undefined]
    ];
    for (const [text, file, line, column] of cases) {
      const [found] = findLocations(text);
      assert.ok(found, text);
      assert.deepStrictEqual([found.path, found.line, found.column], [file, line, column], text);
    }
  });

  it('ignores times, versions and URLs', () => {
    for (const text of [
      '   Start at  08:06:26',
      '  Downloaded thiserror v2.0.18',
      'fetching https://registry.npmjs.org:443/pkg',
      'Listening on localhost:3000',
      'Node.js v20.1:',
      'connect to github.com:22'
    ]) {
      assert.deepStrictEqual(findLocations(text), [], text);
    }
  });

  it('knows the checkout folders of hosted and self-hosted runners', () => {
    assert.strictEqual(relativeToCheckout('/home/runner/work/r/r/a/b.ts'), 'a/b.ts');
    assert.strictEqual(relativeToCheckout('/Users/runner/work/r/r/a.swift'), 'a.swift');
    assert.strictEqual(relativeToCheckout('/__w/r/r/a.c'), 'a.c');
    assert.strictEqual(relativeToCheckout('/opt/actions-runner/_work/r/r/x.ts'), 'x.ts');
    assert.strictEqual(relativeToCheckout('C:\\a\\r\\r\\src\\x.cs'), 'src/x.cs');
    assert.strictEqual(relativeToCheckout('~/work/TypeScript/TypeScript/Herebyfile.mjs'), 'Herebyfile.mjs');
  });
});

describe('problems', () => {
  it('turns the vitest failure into a problem on the spec file with the assertion as message', () => {
    const { raw, job } = fixture('vitejs-vite');
    const problems = problemsFromExcerpt(renderLog(raw, job.steps).failures[0], 'CI · test');
    const spec = problems.find((problem) => problem.path.endsWith('legacy-styles-only-entry-watch.spec.ts'));
    assert.ok(spec, JSON.stringify(problems, null, 1));
    assert.strictEqual(spec.line, 31);
    assert.strictEqual(spec.column, 40);
    assert.match(spec.message, /AssertionError: expected/);
  });

  it('borrows the clippy message for the rust location line', () => {
    const { raw, job } = fixture('rust-lang-rust-analyzer');
    const problems = problemsFromExcerpt(renderLog(raw, job.steps).failures[0], 'CI');
    const eval_ = problems.find((problem) => problem.path === 'crates/hir-ty/src/mir/eval.rs');
    assert.ok(eval_, JSON.stringify(problems, null, 1));
    assert.strictEqual(eval_.line, 1685);
    assert.match(eval_.message, /unneeded `return` statement/);
  });

  it('keeps file annotations and drops the exit-code one', () => {
    const problems = problemsFromAnnotations(
      [
        { path: '.github', start_line: 1, end_line: 1, annotation_level: 'failure', message: 'Process completed with exit code 1.' },
        { path: 'src/a.ts', start_line: 4, end_line: 4, start_column: 2, end_column: 9, annotation_level: 'warning', title: 'no-unused-vars', message: "'x' is unused" }
      ],
      'CI'
    );
    assert.deepStrictEqual(problems, [
      { path: 'src/a.ts', line: 4, column: 2, endLine: 4, endColumn: 9, severity: 'warning', message: "no-unused-vars: 'x' is unused", source: 'CI' }
    ]);
  });
});
