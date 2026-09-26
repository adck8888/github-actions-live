import { Annotation } from './model';
import { FailureExcerpt } from './logParser';

/** A place in a source file that a log line points to. */
export interface LogLocation {
  /** Relative to the repository root when the runner's checkout prefix could be removed. */
  path: string;
  line: number;
  column?: number;
  /** Where the reference sits in the log line, for links. */
  start: number;
  end: number;
}

export interface CiProblem {
  path: string;
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  source: string;
}

const EXT = String.raw`[A-Za-z][A-Za-z0-9]{0,9}`;
const PATH = String.raw`(?:[A-Za-z]:[\\/]|~?[\\/]|\.{1,2}[\\/])?(?:[\w@+~.\-]+[\\/])*[\w@+~.\-]*[\w\-]\.${EXT}`;
const PATTERNS: RegExp[] = [
  // path:12:5 and path:12
  new RegExp(String.raw`(?<![\w/.:\\-])(${PATH}):(\d+)(?::(\d+))?(?![\d:]*\d)`, 'g'),
  // tsc and MSBuild: path(12,5)
  new RegExp(String.raw`(?<![\w/.\\-])(${PATH})\((\d+)(?:,(\d+))?\)`, 'g'),
  // Python tracebacks: File "path", line 12
  /File "([^"]+)", line (\d+)()/g
];

/** Where runners check the repository out, so paths can be made relative. */
const CHECKOUT_PREFIXES: RegExp[] = [
  /^(?:\/home\/runner\/work|\/Users\/runner\/work|\/__w|~\/work|[A-Za-z]:[\\/]a|\/opt\/actions-runner\/_work|\/actions-runner\/_work|[^\s]*?[\\/]_work)[\\/][^\\/]+[\\/][^\\/]+[\\/]/,
  /^\/github\/workspace\//
];

export function relativeToCheckout(path: string): string {
  let result = path;
  for (const prefix of CHECKOUT_PREFIXES) {
    result = result.replace(prefix, '');
  }
  return result.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Every file reference in one line of a rendered log. */
export function findLocations(text: string): LogLocation[] {
  const found: LogLocation[] = [];
  const taken: Array<[number, number]> = [];
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      const start = match.index + match[0].indexOf(match[1]);
      const end = match.index + match[0].length;
      if (taken.some(([a, b]) => start < b && end > a)) {
        continue;
      }
      const before = text.slice(Math.max(0, start - 8), start);
      // Hosts and URLs look like paths with a port.
      if (/:\/\/[^\s]*$/.test(before) || /^[\w.-]+\.(com|org|net|io|dev)$/i.test(match[1])) {
        continue;
      }
      const line = Number(match[2]);
      if (!line) {
        continue;
      }
      taken.push([start, end]);
      found.push({
        path: relativeToCheckout(match[1]),
        line,
        column: match[3] ? Number(match[3]) : undefined,
        start,
        end
      });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/** Lines that state what went wrong, strongest first: an error or failure, then weaker hints. */
const MESSAGES = [
  /(\w*Error\b|\berror(\[\w+\])?:|\bFAIL|\bfailed\b|\bassert\w*|\bexception\b|\bpanick?ed\b|\bTS\d{3,5}\b)/i,
  /\b(cannot|undefined|not found|expected|unexpected)\b/i
];
const MARKERS = /^[\s✖⚠ℹ❯›>→\-|:*]*(-->)?\s*/;

/**
 * Turns the lines leading up to a failure into problems on source files.
 * A line that is only a location (`❯ src/a.ts:3:1`, `--> src/lib.rs:9:4`)
 * borrows its message from the error line printed above it.
 */
export function problemsFromExcerpt(excerpt: FailureExcerpt, source: string): CiProblem[] {
  const problems: CiProblem[] = [];
  excerpt.lines.forEach((text, index) => {
    for (const location of findLocations(text)) {
      if (/(^|\/)node_modules\//.test(location.path) || location.path.startsWith('/')) {
        continue;
      }
      const rest = (text.slice(0, location.start) + text.slice(location.end)).replace(MARKERS, '').trim();
      let message = rest.length > 3 ? text.replace(MARKERS, '').trim() : '';
      for (const pattern of MESSAGES) {
        for (let back = index - 1; !message && back >= Math.max(0, index - 15); back--) {
          if (pattern.test(excerpt.lines[back])) {
            message = excerpt.lines[back].replace(MARKERS, '').trim();
          }
        }
      }
      problems.push({
        path: location.path,
        line: location.line,
        column: location.column,
        severity: 'error',
        message: message || `Failed in CI${excerpt.stepName ? ` (${excerpt.stepName})` : ''}`,
        source
      });
    }
  });
  return dedupe(problems);
}

/** Check-run annotations, which linters and problem matchers attach to the job. */
export function problemsFromAnnotations(annotations: Annotation[], source: string): CiProblem[] {
  return dedupe(
    annotations
      // "Process completed with exit code 1." is annotated on `.github`, not on a file.
      .filter((annotation) => annotation.path && annotation.path !== '.github' && annotation.start_line > 0)
      .map((annotation) => ({
        path: relativeToCheckout(annotation.path),
        line: annotation.start_line,
        column: annotation.start_column ?? undefined,
        endLine: annotation.end_line,
        endColumn: annotation.end_column ?? undefined,
        severity: annotation.annotation_level === 'failure' ? 'error' : annotation.annotation_level === 'warning' ? 'warning' : 'info',
        message: annotation.title && !annotation.message.includes(annotation.title) ? `${annotation.title}: ${annotation.message}` : annotation.message,
        source
      }))
  );
}

function dedupe(problems: CiProblem[]): CiProblem[] {
  const seen = new Set<string>();
  return problems.filter((problem) => {
    const key = `${problem.path}:${problem.line}:${problem.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
