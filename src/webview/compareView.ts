import { Run, workflowName } from '../model';
import { ago, button, esc, glyph, toneIcon } from './html';

export interface CompareView {
  green: Run;
  red: Run;
  compare:
    | {
        commits: Array<{ sha: string; html_url: string; commit: { message: string; author?: { name?: string } | null } }>;
        files?: Array<{ filename: string; status: string; additions: number; deletions: number }>;
        total_commits: number;
        html_url: string;
      }
    | undefined;
  /** The failed job whose log can be diffed with the same job of the green run, if both exist. */
  logJob: string | undefined;
  missingJob: string | undefined;
  now: number;
}

const FILES = 100;
const COMMITS = 50;

function side(run: Run, tone: 'success' | 'failure', label: string, now: number): string {
  return `<div class="card" style="border-top:3px solid var(--al-${tone === 'success' ? 'green' : 'red'})">
  <div class="label">${toneIcon(tone, 14)}${label}</div>
  <div class="value"><a data-cmd="openRun" data-run="${run.id}">#${run.run_number}</a></div>
  <div class="sub">${glyph('branch')} <span class="mono">${esc(run.head_branch ?? '?')}</span> · ${glyph('commit')} <span class="mono">${esc(run.head_sha.slice(0, 7))}</span> · ${ago(
    run.created_at,
    now
  )}</div>
</div>`;
}

/** What changed between the last green run of a workflow and a red one. */
export function renderCompare(view: CompareView): string {
  const { green, red, compare } = view;
  const files = compare?.files ?? [];
  const workflowChanged = files.some((file) => file.filename.startsWith('.github/workflows/'));
  const buttons = [
    view.logJob ? button({ cmd: 'logDiff', label: `Diff logs of “${view.logJob}”`, icon: 'diff', kind: 'primary' }) : '',
    compare ? button({ cmd: 'openUrl', label: 'Full comparison on GitHub', icon: 'external', kind: 'ghost', data: { url: compare.html_url } }) : ''
  ].join('');

  let banners = '';
  if (green.head_sha === red.head_sha) {
    banners += `<div class="banner info">${glyph('warning', 18)}<div class="grow"><b>Same commit.</b> The code did not change between the green run and this one, so the failure is likely flaky or caused by something outside the repository: a dependency release, a service, the runner image. Re-running the failed jobs may be enough.</div>${button(
      { cmd: 'rerunFailed', label: 'Re-run failed jobs', icon: 'rerun' }
    )}</div>`;
  } else if (!compare) {
    banners += `<div class="banner warn">${glyph('warning', 18)}<div class="grow">GitHub could not compare the two commits; one may have been force-pushed away.</div></div>`;
  }
  if (workflowChanged) {
    banners += `<div class="banner warn">${glyph('warning', 18)}<div class="grow"><b>A workflow file changed in between.</b> Check it first.</div></div>`;
  }
  if (view.missingJob) {
    banners += `<div class="banner info">${glyph('log', 18)}<div class="grow">The green run has no job named “${esc(view.missingJob)}”, so there is no log to diff.</div></div>`;
  }

  const header = `<header class="header">
  <div class="title-row"><span class="pill t-failure">${glyph('diff')}Since last green</span><h1>${esc(workflowName(red))}</h1></div>
  <div class="meta"><span>${glyph('commit')}${compare ? `${compare.total_commits} commit${compare.total_commits === 1 ? '' : 's'}, ${files.length}${files.length >= 300 ? '+' : ''} file${files.length === 1 ? '' : 's'} changed` : 'no comparison'}</span></div>
  <div class="actions">${buttons}</div>
</header>
<div class="split">${side(green, 'success', 'Last green', view.now)}<div class="arrow">→</div>${side(red, 'failure', 'This run', view.now)}</div>`;

  let commits = '';
  if (compare?.commits.length) {
    commits = `<h2>Commits <span class="count">${compare.total_commits}</span></h2><div class="list">${compare.commits
      .slice(-COMMITS)
      .reverse()
      .map(
        (commit) =>
          `<div class="item">${glyph('commit')}<a class="mono" data-cmd="openUrl" data-url="${esc(commit.html_url)}">${esc(commit.sha.slice(0, 7))}</a><span class="grow">${esc(
            commit.commit.message.split('\n')[0]
          )}</span><span class="muted">${esc(commit.commit.author?.name ?? '')}</span></div>`
      )
      .join('')}</div>`;
  }

  let fileList = '';
  if (files.length) {
    const most = Math.max(1, ...files.map((file) => file.additions + file.deletions));
    fileList = `<h2>Files <span class="count">${files.length}${files.length >= 300 ? '+' : ''}</span></h2><div class="list"><table><tbody>${files
      .slice(0, FILES)
      .map((file) => {
        const total = file.additions + file.deletions;
        const width = Math.round((total / most) * 100);
        const green = total ? Math.round((file.additions / total) * width) : 0;
        const workflow = file.filename.startsWith('.github/workflows/');
        return `<tr><td>${glyph(workflow ? 'warning' : 'file')} <a class="mono" data-cmd="openFile" data-path="${esc(file.filename)}">${esc(file.filename)}</a></td><td class="muted">${esc(
          file.status
        )}</td><td style="width:22%"><div class="meter" style="display:flex"><div style="width:${green}%;background:var(--al-green);border-radius:0"></div><div style="width:${
          width - green
        }%;background:var(--al-red);border-radius:0"></div></div></td><td class="num"><span class="t-success">+${file.additions}</span> <span class="t-failure">−${file.deletions}</span></td></tr>`;
      })
      .join('')}</tbody></table>${files.length > FILES && compare ? `<div class="empty"><a data-cmd="openUrl" data-url="${esc(compare.html_url)}">…and more on GitHub</a></div>` : ''}</div>`;
  }

  return header + banners + commits + fileList;
}
