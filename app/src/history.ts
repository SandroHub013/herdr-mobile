/**
 * The conversation behind an agent pane.
 *
 * The pane itself holds one screen: the agent's interface redraws in place
 * and leaves no scrollback. The bridge reads the transcript the agent writes
 * as it works and hands it back as turns, so the reader can scroll up from
 * the live screen through everything that came before it.
 */

export interface HistoryTurn {
  readonly seq: number;
  readonly role: 'user' | 'assistant' | 'tool';
  readonly text: string;
  /** Pictures the reader pasted with the message; the transcript keeps their bytes, not their names. */
  readonly images?: number;
  readonly name?: string;
  readonly time?: string;
}

export interface HistoryPage {
  readonly session: string | null;
  /** How the bridge matched the file: exact by session or process, or the newest for the directory. */
  readonly match: 'session' | 'process' | 'cwd';
  readonly total: number;
  readonly turns: HistoryTurn[];
}

/**
 * The turns that come before what the screen already shows.
 *
 * The live screen is the tail of the same conversation, so the transcript
 * stops where the screen begins. The newest sent message whose opening words
 * are on screen marks that point; if none is, the screen holds only the end
 * of a long reply, and the whole transcript stays.
 */
export function beforeScreen(turns: readonly HistoryTurn[], screen: string): HistoryTurn[] {
  const flat = screen.replace(/\s+/g, ' ');
  const recentUsers = turns
    .map((turn, index) => ({ turn, index }))
    .filter(({ turn }) => turn.role === 'user')
    .slice(-5)
    .reverse();
  for (const { turn, index } of recentUsers) {
    const head = turn.text.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (head.length >= 12 && flat.includes(head)) return turns.slice(0, index);
  }
  return [...turns];
}

/** A run of consecutive tool calls, shown as one quiet line. */
export type HistoryBlock =
  | { readonly kind: 'turn'; readonly turn: HistoryTurn }
  | { readonly kind: 'tools'; readonly seq: number; readonly lines: string[] };

export function groupTools(turns: readonly HistoryTurn[]): HistoryBlock[] {
  const blocks: HistoryBlock[] = [];
  for (const turn of turns) {
    const last = blocks[blocks.length - 1];
    if (turn.role === 'tool') {
      if (last && last.kind === 'tools') last.lines.push(turn.text);
      else blocks.push({ kind: 'tools', seq: turn.seq, lines: [turn.text] });
    } else {
      blocks.push({ kind: 'turn', turn });
    }
  }
  return blocks;
}

/** "Letto App.tsx · Modificato ansi.ts · e altri 3" */
export function describeTools(lines: readonly string[]): string {
  const shown = lines.slice(0, 2);
  const rest = lines.length - shown.length;
  return rest > 0 ? `${shown.join(' · ')} · e ${rest === 1 ? 'un altro' : `altri ${rest}`}` : shown.join(' · ');
}

/** The agent's text, in the two kinds of block a reply has: sentences, and code kept as written. */
export type ReplyBlock = { readonly kind: 'prose'; readonly text: string } | { readonly kind: 'code'; readonly text: string };

const EMPHASIS = /(\*\*|__)(.+?)\1/g;
const INLINE_CODE = /`([^`\n]+)`/g;
const HEADING = /^#{1,6}\s+/gm;

/**
 * Splits a reply into paragraphs and code fences. Markdown is not rendered,
 * only relieved of the marks that would read as noise in a transcript.
 */
export function replyBlocks(text: string): ReplyBlock[] {
  const blocks: ReplyBlock[] = [];
  const pieces = text.split(/^```[^\n]*\n?/m);
  pieces.forEach((piece, index) => {
    if (index % 2 === 1) {
      const code = piece.replace(/\n?```\s*$/, '').replace(/\s+$/, '');
      if (code) blocks.push({ kind: 'code', text: code });
      return;
    }
    const cleaned = piece.replace(HEADING, '').replace(EMPHASIS, '$2').replace(INLINE_CODE, '$1');
    for (const paragraph of cleaned.split(/\n\s*\n/)) {
      const trimmed = paragraph.trim();
      if (trimmed) blocks.push({ kind: 'prose', text: trimmed });
    }
  });
  return blocks;
}
