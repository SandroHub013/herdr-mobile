import { Diff, DiffHunk } from './Event.ts';

/**
 * The change an edit made, as lines the app can paint red and green.
 *
 * Agents record an edit as the text before and the text after, not as a patch,
 * so the patch has to be worked out here. The numbers down the side are the
 * file's own, recovered by finding the old text in the file as it stands; when
 * that fails — the file moved on, or was never readable — the hunk says so by
 * numbering from zero rather than inventing a position.
 */

/** Past this, an edit is a rewrite: report the size, do not ship the body. */
const MAX_LINES = 1500;
/** Untouched lines kept either side of a change, so it reads in context. */
const CONTEXT = 3;

type Op = { kind: 'context' | 'added' | 'removed'; text: string };

/**
 * Longest common subsequence over lines. Quadratic, which is why MAX_LINES
 * exists: 1500 x 1500 is a couple of million cells and runs in a blink, while
 * a 50k-line rewrite would stall the bridge for everyone.
 */
function lcsOps(before: string[], after: string[]): Op[] {
  const n = before.length;
  const m = after.length;
  // One row of the table per line of `before`, built bottom-up.
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] =
        before[i] === after[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ kind: 'context', text: before[i] });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ kind: 'removed', text: before[i] });
      i++;
    } else {
      ops.push({ kind: 'added', text: after[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: 'removed', text: before[i++] });
  while (j < m) ops.push({ kind: 'added', text: after[j++] });
  return ops;
}

/** Groups the changed lines into hunks, dropping the long quiet stretches between them. */
function toHunks(ops: Op[], firstLine: number): DiffHunk[] {
  const changed = ops.map((op) => op.kind !== 'context');
  if (!changed.some(Boolean)) return [];

  const hunks: DiffHunk[] = [];
  let cursor = 0;
  // Line number of ops[k] in the original file, counting only what was there before.
  const lineAt: number[] = [];
  let line = firstLine;
  for (const op of ops) {
    lineAt.push(line);
    if (op.kind !== 'added') line++;
  }

  while (cursor < ops.length) {
    if (!changed[cursor]) {
      cursor++;
      continue;
    }
    let start = cursor;
    let end = cursor;
    // Walk to the end of this run, joining runs closer than twice the context
    // so two nearby edits read as one hunk instead of two stuttering ones.
    while (end < ops.length) {
      if (changed[end]) {
        cursor = end + 1;
        end++;
        continue;
      }
      let gap = 0;
      while (end + gap < ops.length && !changed[end + gap]) gap++;
      if (gap <= CONTEXT * 2 && end + gap < ops.length) {
        end += gap;
        continue;
      }
      break;
    }
    const from = Math.max(0, start - CONTEXT);
    const to = Math.min(ops.length, end + CONTEXT);
    hunks.push(
      new DiffHunk({
        startLine: lineAt[from] ?? 0,
        lines: ops.slice(from, to).map((op) => ({ kind: op.kind, text: op.text })),
      }),
    );
    cursor = Math.max(cursor, to);
  }
  return hunks;
}

/**
 * Where `oldText` sits in the file right now, as a 1-based line number.
 * Zero when it cannot be placed, which the app reads as "no real numbering".
 */
export function anchorLine(fileText: string | undefined, oldText: string): number {
  if (!fileText || !oldText) return 0;
  const at = fileText.indexOf(oldText);
  if (at === -1) return 0;
  let line = 1;
  for (let i = 0; i < at; i++) if (fileText.charCodeAt(i) === 10) line++;
  return line;
}

/** Splits into lines without inventing a trailing empty one. */
const lines = (text: string): string[] => {
  if (text === '') return [];
  const split = text.split('\n');
  if (split[split.length - 1] === '') split.pop();
  return split;
};

export function buildDiff(options: {
  readonly path: string;
  readonly before: string;
  readonly after: string;
  /** The file as it stands, when it could be read: only used to number the lines. */
  readonly fileText?: string;
  /** Where the old text sat, when the agent said so itself. Beats searching for it. */
  readonly startLine?: number;
}): Diff {
  const before = lines(options.before);
  const after = lines(options.after);

  if (before.length > MAX_LINES || after.length > MAX_LINES) {
    return new Diff({
      path: options.path,
      added: after.length,
      removed: before.length,
      hunks: [],
      truncated: true,
    });
  }

  const ops = lcsOps(before, after);
  const added = ops.filter((op) => op.kind === 'added').length;
  const removed = ops.filter((op) => op.kind === 'removed').length;
  const firstLine =
    options.startLine && options.startLine > 0
      ? options.startLine
      : anchorLine(options.fileText, options.before);

  return new Diff({
    path: options.path,
    added,
    removed,
    hunks: toHunks(ops, firstLine || 1),
    truncated: false,
  });
}

/** Several edits to one file, reported as one change. */
export function mergeDiffs(path: string, parts: ReadonlyArray<Diff>): Diff {
  return new Diff({
    path,
    added: parts.reduce((sum, part) => sum + part.added, 0),
    removed: parts.reduce((sum, part) => sum + part.removed, 0),
    hunks: parts.flatMap((part) => part.hunks),
    truncated: parts.some((part) => part.truncated),
  });
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * A patch the agent already wrote out, read back into hunks.
 *
 * Some agents record what they changed as a unified diff rather than as the
 * text before and after; the numbering is then theirs, taken from the hunk
 * headers, and nothing has to be searched for.
 */
export function parseUnifiedDiff(path: string, patch: string): Diff {
  const hunks: DiffHunk[] = [];
  let current: { startLine: number; lines: Array<{ kind: 'context' | 'added' | 'removed'; text: string }> } | null = null;
  let added = 0;
  let removed = 0;
  let total = 0;

  const close = () => {
    if (current && current.lines.length > 0) {
      hunks.push(new DiffHunk({ startLine: current.startLine, lines: current.lines }));
    }
    current = null;
  };

  for (const raw of patch.replace(/\r\n/g, '\n').split('\n')) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      close();
      current = { startLine: Number(header[1]) || 1, lines: [] };
      continue;
    }
    if (!current) continue;
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('\\')) continue;
    total++;
    if (raw.startsWith('+')) {
      added++;
      current.lines.push({ kind: 'added', text: raw.slice(1) });
    } else if (raw.startsWith('-')) {
      removed++;
      current.lines.push({ kind: 'removed', text: raw.slice(1) });
    } else {
      current.lines.push({ kind: 'context', text: raw.startsWith(' ') ? raw.slice(1) : raw });
    }
  }
  close();

  if (total > MAX_LINES) return new Diff({ path, added, removed, hunks: [], truncated: true });
  return new Diff({ path, added, removed, hunks, truncated: false });
}

/** A file created from nothing: every line is an addition. */
export function wholeFileDiff(path: string, text: string): Diff {
  const body = lines(text);
  if (body.length > MAX_LINES) {
    return new Diff({ path, added: body.length, removed: 0, hunks: [], truncated: true });
  }
  return new Diff({
    path,
    added: body.length,
    removed: 0,
    hunks: [
      new DiffHunk({ startLine: 1, lines: body.map((text) => ({ kind: 'added' as const, text })) }),
    ],
    truncated: false,
  });
}
