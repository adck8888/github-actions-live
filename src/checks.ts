import { Tone } from './model';

/** A check run: every Actions job is one, and so is each check of apps such as Vercel or CodeQL. */
export interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string | null;
  details_url?: string | null;
  app?: { slug?: string; name?: string } | null;
}

/** A commit status, the older API that some CI services still report through. */
export interface CommitStatusEntry {
  context: string;
  state: 'success' | 'pending' | 'failure' | 'error' | string;
  target_url: string | null;
  description?: string | null;
  updated_at?: string;
}

export interface CheckItem {
  name: string;
  tone: Tone;
  url?: string;
  /** "github-actions" for Actions jobs, or the app / status context that reported it. */
  source: string;
}

/** Everything that reports on one commit, folded into one verdict. */
export interface CiSummary {
  tone: Tone | 'none';
  items: CheckItem[];
  total: number;
  done: number;
  failed: CheckItem[];
  running: CheckItem[];
}

const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

function checkTone(check: CheckRun): Tone {
  if (check.status === 'in_progress') {
    return 'running';
  }
  if (check.status !== 'completed') {
    return 'queued';
  }
  if (check.conclusion === 'success') {
    return 'success';
  }
  if (FAILED.has(check.conclusion ?? '')) {
    return 'failure';
  }
  if (check.conclusion === 'action_required') {
    return 'attention';
  }
  if (check.conclusion === 'cancelled') {
    return 'cancelled';
  }
  if (check.conclusion === 'skipped') {
    return 'skipped';
  }
  return 'neutral';
}

function statusTone(status: CommitStatusEntry): Tone {
  switch (status.state) {
    case 'success':
      return 'success';
    case 'pending':
      return 'running';
    case 'failure':
    case 'error':
      return 'failure';
    default:
      return 'neutral';
  }
}

/**
 * The CI verdict of a commit from its check runs and commit statuses: red if
 * anything failed, running while anything is pending, green when all passed.
 * A re-run adds a new check run under the same name; only the newest counts.
 */
export function ciSummary(checks: CheckRun[], statuses: CommitStatusEntry[]): CiSummary {
  const newest = new Map<string, CheckRun>();
  for (const check of checks) {
    const key = `${check.app?.slug ?? ''}/${check.name}`;
    const current = newest.get(key);
    if (!current || (Date.parse(check.started_at ?? '') || 0) > (Date.parse(current.started_at ?? '') || 0) || (check.started_at === current.started_at && check.id > current.id)) {
      newest.set(key, check);
    }
  }
  const items: CheckItem[] = [...newest.values()].map((check) => ({
    name: check.name,
    tone: checkTone(check),
    url: check.html_url ?? check.details_url ?? undefined,
    source: check.app?.slug ?? 'check'
  }));
  const contexts = new Map<string, CommitStatusEntry>();
  for (const status of statuses) {
    const current = contexts.get(status.context);
    if (!current || (status.updated_at ?? '') > (current.updated_at ?? '')) {
      contexts.set(status.context, status);
    }
  }
  for (const status of contexts.values()) {
    items.push({ name: status.context, tone: statusTone(status), url: status.target_url ?? undefined, source: 'status' });
  }

  // Skipped and neutral checks neither pass nor fail a commit.
  const counted = items.filter((item) => item.tone !== 'skipped' && item.tone !== 'neutral');
  const failed = counted.filter((item) => item.tone === 'failure');
  const running = counted.filter((item) => item.tone === 'running' || item.tone === 'queued');
  let tone: CiSummary['tone'] = 'none';
  if (counted.length) {
    if (failed.length) {
      tone = 'failure';
    } else if (running.length) {
      tone = running.some((item) => item.tone === 'running') ? 'running' : 'queued';
    } else if (counted.some((item) => item.tone === 'attention')) {
      tone = 'attention';
    } else if (counted.every((item) => item.tone === 'cancelled')) {
      tone = 'cancelled';
    } else {
      tone = 'success';
    }
  } else if (items.length) {
    tone = 'neutral';
  }
  items.sort((a, b) => order(a.tone) - order(b.tone) || a.name.localeCompare(b.name));
  return { tone, items, total: counted.length, done: counted.length - running.length, failed, running };
}

function order(tone: Tone): number {
  return ['failure', 'attention', 'running', 'queued', 'cancelled', 'success', 'neutral', 'skipped'].indexOf(tone);
}

/** What GitHub's `mergeable_state` of a pull request means, in a few words. */
export function describeMergeState(state: string | undefined, draft = false): string | undefined {
  if (draft) {
    return 'draft';
  }
  switch (state) {
    case 'clean':
      return 'ready to merge';
    case 'unstable':
      return 'mergeable, some checks failing';
    case 'blocked':
      return 'blocked (reviews or required checks)';
    case 'behind':
      return 'behind the base branch';
    case 'dirty':
      return 'has merge conflicts';
    case 'has_hooks':
      return 'ready to merge';
    default:
      return undefined;
  }
}
