import { Step } from './model';

/**
 * Turns the raw log GitHub serves for a job into something a person can read
 * in an editor: timestamps and colour codes gone, `##[group]` blocks folded,
 * errors marked, and a header line where each step starts.
 */
export interface RenderedLog {
  text: string;
  lineCount: number;
  /** Line ranges the editor can fold: groups and whole steps. */
  folds: Array<{ start: number; end: number }>;
  /** Header line of each step, by step number. */
  stepLines: Map<number, number>;
  /** Lines that were `##[error]`. */
  errors: number[];
  warnings: number[];
  /** The line to open the log on and the line above it to scroll to, when the job failed. */
  focus?: { line: number; contextStart: number; stepNumber?: number };
  /** Every failed step's lines leading up to its error, for explanations and the Problems panel. */
  failures: FailureExcerpt[];
}

export interface FailureExcerpt {
  stepNumber?: number;
  stepName?: string;
  startLine: number;
  errorLine: number;
  lines: string[];
}

export interface RenderOptions {
  timestamps?: boolean;
  /** Formats a line's time when `timestamps` is on; local HH:MM:SS by default. */
  formatTime?: (date: Date) => string;
}

const TIMESTAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) ?/;
// Colour and cursor codes, and OSC sequences such as hyperlinks.
// eslint-disable-next-line no-control-regex -- matching escape codes is the point.
const ESCAPES = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
const COMMAND = /^##\[([a-z-]+)\](.*)$/;
/** How far above an error the excerpt reaches. */
const EXCERPT_LINES = 80;
/** How far below an error the excerpt reaches. */
const AFTER_LINES = 20;
/** How much context to keep visible above the error when a log opens. */
const CONTEXT_LINES = 25;

export function stripEscapes(text: string): string {
  return text.replace(ESCAPES, '');
}

export function renderLog(raw: string, steps: Step[] = [], options: RenderOptions = {}): RenderedLog {
  const out: string[] = [];
  const folds: Array<{ start: number; end: number }> = [];
  const stepLines = new Map<number, number>();
  const errors: number[] = [];
  const warnings: number[] = [];
  const openGroups: number[] = [];
  const formatTime = options.formatTime ?? localTime;

  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') {
    lines.pop();
  }

  const starts = stepStarts(lines, steps);
  let stepStartLine: number | undefined;
  let lastTime: Date | undefined;

  const closeStep = (): void => {
    if (stepStartLine !== undefined && out.length - 1 > stepStartLine) {
      folds.push({ start: stepStartLine, end: out.length - 1 });
    }
  };

  lines.forEach((rawLine, index) => {
    for (const step of starts.get(index) ?? []) {
      closeGroups(openGroups, folds, out.length - 1);
      closeStep();
      stepStartLine = out.length;
      stepLines.set(step.number, out.length);
      out.push(stepHeader(step));
    }

    const stamp = TIMESTAMP.exec(rawLine);
    let body = stamp ? rawLine.slice(stamp[0].length) : rawLine;
    if (stamp) {
      lastTime = new Date(stamp[1]);
    }
    body = stripEscapes(body);
    const prefix = options.timestamps && lastTime ? `${formatTime(lastTime)}  ` : '';

    const command = COMMAND.exec(body);
    if (command) {
      const [, name, rest] = command;
      switch (name) {
        case 'group':
          openGroups.push(out.length);
          out.push(`${prefix}▾ ${rest.trim()}`);
          return;
        case 'endgroup': {
          const start = openGroups.pop();
          if (start !== undefined && out.length - 1 > start) {
            folds.push({ start, end: out.length - 1 });
          }
          return;
        }
        case 'error':
          errors.push(out.length);
          out.push(`${prefix}✖ ${rest}`);
          return;
        case 'warning':
          warnings.push(out.length);
          out.push(`${prefix}⚠ ${rest}`);
          return;
        case 'notice':
          out.push(`${prefix}ℹ ${rest}`);
          return;
        case 'command':
          out.push(`${prefix}$ ${rest}`);
          return;
        case 'debug':
          out.push(`${prefix}· ${rest}`);
          return;
        case 'start-action':
        case 'end-action':
          return;
        default:
          out.push(`${prefix}${rest}`);
          return;
      }
    }
    out.push(`${prefix}${body}`);
  });
  closeGroups(openGroups, folds, out.length - 1);
  closeStep();

  const failures = findFailures(out, steps, stepLines, errors, folds);
  const first = failures[0];
  const focus = first
    ? {
        line: first.errorLine,
        contextStart: Math.max(first.startLine, first.errorLine - CONTEXT_LINES),
        stepNumber: first.stepNumber
      }
    : undefined;

  folds.sort((a, b) => a.start - b.start || b.end - a.end);
  return { text: out.join('\n'), lineCount: out.length, folds, stepLines, errors, warnings, focus, failures };
}

function closeGroups(open: number[], folds: Array<{ start: number; end: number }>, end: number): void {
  while (open.length) {
    const start = open.pop()!;
    if (end > start) {
      folds.push({ start, end });
    }
  }
}

function stepHeader(step: Step): string {
  const mark =
    step.conclusion === 'failure' ? '✖' : step.conclusion === 'success' ? '✓' : step.conclusion === 'cancelled' ? '⊘' : step.conclusion === 'skipped' ? '↷' : '●';
  const took =
    step.started_at && step.completed_at ? ` · ${seconds(Date.parse(step.completed_at) - Date.parse(step.started_at))}` : '';
  return `━━ ${mark} ${step.number}. ${step.name}${took} ━━`;
}

function seconds(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '';
  }
  const total = Math.round(ms / 1000);
  return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
}

function localTime(date: Date): string {
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, '0')).join(':');
}

/** Lines the runner prints where a step begins: the job set-up, `Run …`, post steps, the final clean-up. */
const STEP_OPENERS = /^(##\[group\]Run |Post job cleanup\.|Cleaning up orphan processes)/;

/**
 * Finds the raw line where each step begins. GitHub gives step times only to
 * the second, and neighbouring steps often share one, so time alone cannot
 * split them: a step starts at the first line the runner opens steps with
 * (`##[group]Run …`, `Post job cleanup.`) logged within its time span, and
 * only a step that prints no such line falls back to its first line in time.
 */
export function stepStarts(lines: string[], steps: Step[]): Map<number, Step[]> {
  const result = new Map<number, Step[]>();
  const times: number[] = [];
  const openers: boolean[] = [];
  let last = NaN;
  lines.forEach((line, index) => {
    const stamp = TIMESTAMP.exec(line);
    last = stamp ? Date.parse(stamp[1]) : last;
    times.push(last);
    openers.push(index === 0 || (stamp !== null && STEP_OPENERS.test(line.slice(stamp[0].length))));
  });
  const ordered = steps
    .filter((step) => step.started_at && step.conclusion !== 'skipped')
    .sort((a, b) => a.number - b.number);
  let previous = -1;
  for (const step of ordered) {
    const start = Date.parse(step.started_at as string);
    // The completion second covers the whole second it names.
    const end = step.completed_at ? Date.parse(step.completed_at) + 1000 : Infinity;
    let index = -1;
    for (let i = previous + 1; i < lines.length; i++) {
      if (openers[i] && times[i] >= start) {
        index = times[i] <= end ? i : -1;
        break;
      }
    }
    if (index === -1) {
      index = times.findIndex((time, i) => i > previous && time >= start);
    }
    if (index === -1) {
      break;
    }
    result.set(index, [...(result.get(index) ?? []), step]);
    previous = index;
  }
  return result;
}

function findFailures(
  out: string[],
  steps: Step[],
  stepLines: Map<number, number>,
  errors: number[],
  folds: Array<{ start: number; end: number }>
): FailureExcerpt[] {
  if (!errors.length) {
    return [];
  }
  const headers = [...stepLines.entries()].sort((a, b) => a[1] - b[1]);
  const stepAt = (line: number): { number: number; start: number } | undefined => {
    let found: { number: number; start: number } | undefined;
    for (const [number, start] of headers) {
      if (start <= line) {
        found = { number, start };
      }
    }
    return found;
  };

  const failedSteps = new Set(steps.filter((step) => step.conclusion === 'failure').map((step) => step.number));
  const seen = new Set<number | undefined>();
  const result: FailureExcerpt[] = [];
  for (const errorLine of errors) {
    const step = stepAt(errorLine);
    // Errors inside steps that passed (continue-on-error, retries) are noise.
    if (step && failedSteps.size && !failedSteps.has(step.number)) {
      continue;
    }
    if (seen.has(step?.number)) {
      continue;
    }
    seen.add(step?.number);
    // Skip the step's own header block (the command and its env) when it is folded away.
    let startLine = step ? step.start + 1 : 0;
    const header = folds.find((fold) => fold.start === startLine);
    if (header && header.end < errorLine) {
      startLine = header.end + 1;
    }
    startLine = Math.max(startLine, errorLine - EXCERPT_LINES);
    // Compilers print the code and the hint after the error line: keep them, up to the step's end.
    const nextStep = headers.find(([, start]) => start > errorLine)?.[1] ?? out.length;
    const nextError = errors.find((line) => line > errorLine) ?? out.length;
    const endLine = Math.min(nextStep - 1, nextError - 1, errorLine + AFTER_LINES);
    const name = steps.find((candidate) => candidate.number === step?.number)?.name;
    result.push({
      stepNumber: step?.number,
      stepName: name,
      startLine,
      errorLine,
      lines: out.slice(startLine, Math.max(errorLine, endLine) + 1)
    });
  }
  // A job with errors only in passed steps still failed somewhere: fall back to its first error.
  if (!result.length) {
    const errorLine = errors[0];
    const startLine = Math.max(0, errorLine - EXCERPT_LINES);
    result.push({ startLine, errorLine, lines: out.slice(startLine, errorLine + 1) });
  }
  return result;
}

/**
 * Takes out what differs between any two runs of the same job (durations,
 * times, ids, temp paths) so a diff of a red and a green log shows what
 * actually went differently.
 */
export function normalizeForCompare(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(/^(━━ \S+ \d+\. .*?) · [\dhms ]+ ━━$/, '$1 ━━')
        .replace(/^\d\d:\d\d:\d\d /, '')
        .replace(/\b\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?Z?\b/g, '<time>')
        .replace(/\b\d\d:\d\d:\d\d(?:\.\d+)?\b/g, '<time>')
        .replace(/\b[0-9a-f]{40}\b/g, '<sha>')
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
        .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|seconds|m|min)\b/g, '<t>')
        .replace(/(\/tmp\/|\\Temp\\|runner\/_temp\/)[\w.\-/\\]+/g, '$1<tmp>')
    )
    .join('\n');
}
