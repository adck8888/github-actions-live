/**
 * CI reports lines of the commit it ran on; the file in the editor may have
 * moved on since. These helpers carry a line through `git diff -U0` output.
 */
export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

/** Hunks per file (new path, relative to the repository) from `git diff -U0` output. */
export function parseDiff(diff: string): Map<string, Hunk[]> {
  const files = new Map<string, Hunk[]>();
  let current: Hunk[] | undefined;
  for (const line of diff.split('\n')) {
    const file = /^\+\+\+ (?:b\/(.*)|\/dev\/null)$/.exec(line.trimEnd());
    if (file) {
      current = [];
      if (file[1] !== undefined) {
        files.set(file[1], current);
      }
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && current) {
      current.push({
        oldStart: Number(hunk[1]),
        oldCount: hunk[2] === undefined ? 1 : Number(hunk[2]),
        newStart: Number(hunk[3]),
        newCount: hunk[4] === undefined ? 1 : Number(hunk[4])
      });
    }
  }
  return files;
}

/**
 * Where a line of the old file is now. `changed` is true when that line
 * itself was edited or removed, in which case `line` is where its hunk now starts.
 */
export function mapLine(hunks: Hunk[], line: number): { line: number; changed: boolean } {
  let shift = 0;
  for (const hunk of hunks) {
    if (hunk.oldCount === 0) {
      // Pure insertion after line oldStart.
      if (hunk.oldStart < line) {
        shift += hunk.newCount;
        continue;
      }
      break;
    }
    const oldEnd = hunk.oldStart + hunk.oldCount - 1;
    if (oldEnd < line) {
      shift += hunk.newCount - hunk.oldCount;
      continue;
    }
    if (hunk.oldStart <= line) {
      return { line: Math.max(1, hunk.newStart), changed: true };
    }
    break;
  }
  return { line: line + shift, changed: false };
}
