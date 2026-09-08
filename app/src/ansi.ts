/**
 * Terminal text sanitising.
 *
 * Herdr streams raw terminal buffers. Two things have to happen before the text
 * can be shown: escape sequences must go, and the sequences whose ESC byte was
 * lost in transport (they arrive as a bare "[0m") must go too — those are what
 * produced the "[0m[38;5;2m" noise visible in the terminal view.
 */

// eslint-disable-next-line no-control-regex
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const CHARSET = /\x1b[()#][0-9A-Za-z]/g;
// eslint-disable-next-line no-control-regex
const SINGLE = /\x1b[=><NOM78]/g;
// eslint-disable-next-line no-control-regex
const LONE_ESC = /\x1b/g;
// eslint-disable-next-line no-control-regex
const BELL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
/** A glyph that did not survive the trip from the agent to Herdr: noise, not text. */
const REPLACEMENT = /�/g;

/**
 * Sequences that reached us without their ESC byte. Digits are required so that
 * ordinary bracketed text ("[y/n]", "array[i]") survives untouched.
 */
const ORPHAN_SGR = /\[\??\d{1,4}(?:;\d{1,4})*[A-Za-z]/g;

export function stripAnsi(input: string): string {
  if (!input) return '';
  return input
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(CHARSET, '')
    .replace(SINGLE, '')
    .replace(ORPHAN_SGR, '')
    .replace(LONE_ESC, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '')
    .replace(BELL, '')
    .replace(REPLACEMENT, '');
}

/** Vertical frame characters a TUI draws down the sides of a box. */
const BOX_SIDES = /[│┃┆┇┊┋╎╏║]/;
const LEADING_BOX_SIDE = /^\s*[│┃┆┇┊┋╎╏║][ \t]?/;
const TRAILING_BOX_SIDE = /[ \t]?[│┃┆┇┊┋╎╏║]\s*$/;

/**
 * A line made only of drawing: a rule ("____", "─────", "- - - -"), a box
 * edge ("╭────╮", "├───┤", "╹────"), a bar of block elements. The box-drawing
 * and block-element ranges are taken whole, since each interface picks its
 * own corners and weights.
 */
const DECORATIVE_LINE = /^[─-▟_\-=~‾–—―⎯⏤ \t]+$/;

function isDecorative(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 3) return false;
  return DECORATIVE_LINE.test(trimmed);
}

const isBlank = (row: string) => row.trim() === '';

// ----------------------------------------------------------------- sidebar

/** What an interface draws down a divider: box sides and solid bars. */
const DIVIDER = /[│┃┆┇┊┋╎╏║▌▐█▏▕]/;
/** A panel starts past this column; anything nearer is the text itself. */
const SIDEBAR_MIN_COLUMN = 40;
/** Rows a panel must occupy to count as one. */
const SIDEBAR_MIN_ROWS = 5;
/** Empty columns that must separate the text from a panel. */
const SIDEBAR_MIN_GAP = 2;

/**
 * Rows with text past `from` and, on some of them, nothing before `to`: a
 * panel beside the conversation. A table has something in every column of
 * every row and never passes.
 */
function panelShape(content: string[], to: number, from: number): boolean {
  let right = 0;
  let rightOnly = 0;
  for (const row of content) {
    if (row.slice(from).trim() === '') continue;
    right++;
    if (row.slice(0, to).trim() === '') rightOnly++;
  }
  return right >= SIDEBAR_MIN_ROWS && rightOnly >= 2;
}

/** A divider drawn at the same column on most rows, with a panel past it. */
function dividerColumn(content: string[], width: number): number | null {
  const needed = Math.max(SIDEBAR_MIN_ROWS, Math.ceil(content.length / 2));
  for (let x = width - 1; x >= SIDEBAR_MIN_COLUMN; x--) {
    let hits = 0;
    for (const row of content) {
      if (x < row.length && DIVIDER.test(row[x])) hits++;
    }
    if (hits >= needed && panelShape(content, x, x + 1)) return x;
  }
  return null;
}

/** Whether a row has text at `column` with an empty gap just before it. */
function beginsAt(row: string, column: number): boolean {
  return row.length > column && row[column] !== ' ' && row.slice(Math.max(0, column - SIDEBAR_MIN_GAP), column).trim() === '';
}

/**
 * A panel with no divider: found where text begins on the rows that hold
 * nothing else, then confirmed by enough rows whose text begins at that same
 * column after a gap. A table lines its columns up too, but every row of it
 * has something before them.
 */
function panelColumn(content: string[]): number | null {
  const starts = content.map((row) => row.search(/\S/)).filter((start) => start >= SIDEBAR_MIN_COLUMN);
  if (starts.length < 2) return null;
  const column = Math.min(...starts);
  const rows = content.filter((row) => beginsAt(row, column)).length;
  return rows >= SIDEBAR_MIN_ROWS ? column : null;
}

/**
 * Some interfaces keep a panel down the right of a wide terminal: session
 * name, token counts, cost, language servers. Read row by row on a phone, that
 * panel interleaves with the conversation, a fragment of it after every line.
 * The panel is found by its geometry, a divider column or a column where text
 * begins on rows that hold nothing else, and everything from there on goes.
 */
function dropSidebar(rows: string[]): string[] {
  const content = rows.filter((row) => !isBlank(row) && !isDecorative(row));
  if (content.length <= SIDEBAR_MIN_ROWS) return rows;
  const width = Math.max(...content.map((row) => row.trimEnd().length));
  if (width < 2 * SIDEBAR_MIN_COLUMN) return rows;

  const divider = dividerColumn(content, width);
  if (divider !== null) return rows.map((row) => (row.length > divider ? row.slice(0, divider) : row));

  const panel = panelColumn(content);
  if (panel === null) return rows;
  // Only rows that reach the panel across a gap are cut: a line that runs
  // through that column is text, whatever the panel does elsewhere.
  return rows.map((row) => (beginsAt(row, panel) ? row.slice(0, panel) : row));
}

// ------------------------------------------------------------------ header

/** Rows the tab bar of an interface may take at the top of the screen. */
const HEADER_REACH = 4;

/** Drops a tab bar drawn across the top of the screen, down to its rule. */
function dropTopChrome(rows: string[]): string[] {
  for (let i = 0; i < Math.min(rows.length, HEADER_REACH); i++) {
    if (isDecorative(rows[i])) return rows.slice(i + 1);
  }
  return rows;
}

// ------------------------------------------------------------------ footer

/** The interface's own prompt, empty or with a hint or a line typed into it. */
const PROMPT_ROW = /^\s*[❯>]\s*(?:\S.*)?$/;
/** A status bar: key hints, context and quota counters. */
const STATUS_ROW = /ctrl\+|\bctx\b|\bcontext \d+%|\d+%\)|\bquota\b/i;
/** A row of the input box, framed down its left side. */
const BORDERED_ROW = /^\s*[│┃║▌▐█▏]/;
/** Rows the input box may take. */
const INPUT_BOX_ROWS = 8;

/**
 * Drops the foot of an agent's interface when it has no "❯" prompt to find it
 * by: the status bar, the rule over it, and the prompt or the framed input
 * box above that. Read from the bottom, each part is taken only in its place
 * and only once, so a table that happens to end the conversation stays.
 */
function dropAgentFooter(rows: string[]): string[] {
  const out = [...rows];
  const trim = () => {
    while (out.length > 0 && isBlank(out[out.length - 1])) out.pop();
  };
  const take = (matches: (row: string) => boolean, limit: number) => {
    let taken = 0;
    while (out.length > 0 && taken < limit) {
      const last = out[out.length - 1];
      if (isBlank(last)) {
        out.pop();
        continue;
      }
      if (!matches(last)) break;
      out.pop();
      taken++;
    }
    return taken;
  };
  const isStatus = (row: string) => STATUS_ROW.test(row) || COLUMNAR.test(row) || isDecorative(row);

  trim();
  take(isStatus, 2);
  take(isDecorative, 1);
  if (take((row) => PROMPT_ROW.test(row), 1) > 0) take(isDecorative, 1);
  else take((row) => BORDERED_ROW.test(row), INPUT_BOX_ROWS);
  trim();
  return out;
}

/**
 * The agent's own input prompt at the foot of its interface, whether empty
 * ("❯") or with a line typed into it ("❯ ciao"). Both are the live input box,
 * not conversation: on the desktop that box is where you edit, and it must not
 * be frozen into the transcript as if it were a sent message.
 */
const PROMPT_LINE = /^\s*❯(?:\s.*)?\s*$/;
/** Rotating hints attached to the spinner. */
const TIP_LINE = /^\s*(?:[⎿└│|]\s*)?Tip:\s/;
/**
 * Text pushed to the far right of a wide terminal. Real output does not begin
 * forty columns in; the interface's own hints do, and on a phone they arrive as
 * a lone fragment with no visible reason for being there.
 */
const RIGHT_ALIGNED_CHROME = /^ {40,}\S/;
/**
 * How far from the end the prompt may sit and still count as the foot of the
 * interface rather than a prompt that happens to appear inside the output.
 */
const FOOTER_REACH = 10;

/**
 * Drops the agent's input prompt and the status bar underneath it.
 *
 * Those are the desktop interface's own composer and footer. This app already
 * has both, drawn natively at the bottom of the screen, so keeping the terminal
 * copy shows the reader two of everything and pushes the actual conversation off
 * the top of a phone screen.
 */
function dropTrailingChrome(lines: string[]): string[] | null {
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - FOOTER_REACH); i--) {
    if (PROMPT_LINE.test(lines[i])) return lines.slice(0, i);
  }
  return null;
}

/**
 * The desktop TUI frames its output in boxes and separates sections with rules.
 * On a phone those turn into pages of stray lines that carry no information, so
 * the view drops them: this is a readable transcript, not a faithful terminal.
 *
 * For a window an agent runs in, its interface is taken apart first: the panel
 * some of them keep down the right of the screen, and the input box and status
 * bar at the foot. Which agent does not matter; the shapes are read from the
 * screen itself.
 */
export function tidyTerminalText(input: string, agent?: string): string {
  let rows = stripAnsi(input).split('\n');
  rows = dropTrailingChrome(rows) ?? (agent ? dropAgentFooter(rows) : rows);
  if (agent) rows = dropSidebar(dropTopChrome(rows));

  const cleaned = rows
    .map((line) => {
      const unframed = BOX_SIDES.test(line)
        ? line.replace(LEADING_BOX_SIDE, '').replace(TRAILING_BOX_SIDE, '')
        : line;
      const trimmed = unframed.replace(/[ \t]+$/, '');
      return isDecorative(trimmed) ? '' : trimmed;
    });

  const lines = cleaned.filter((line) => !TIP_LINE.test(line) && !RIGHT_ALIGNED_CHROME.test(line));

  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

  const out: string[] = [];
  let blank = false;
  for (const line of lines) {
    const isBlank = line.trim() === '';
    if (isBlank && blank) continue;
    blank = isBlank;
    out.push(line);
  }
  return out.join('\n');
}

export interface TextSegment {
  text: string;
  url?: string;
}

const URL_RE = /(https?:\/\/[^\s"'<>)\]]+|file:\/\/[^\s"'<>)\]]+)/g;
const TRAILING_PUNCTUATION = [',', '.', ';', ':', ')', ']', '>', '"', "'"];

/**
 * Splits terminal text into plain runs and link runs so the view can render
 * links without re-scanning the buffer on every frame.
 */
export function segmentLinks(text: string): TextSegment[] {
  if (!text) return [];
  const segments: TextSegment[] = [];
  let lastIndex = 0;

  URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null = URL_RE.exec(text);
  while (match !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index) });
    }

    let url = match[0];
    let suffix = '';
    while (url.length > 0 && TRAILING_PUNCTUATION.includes(url[url.length - 1])) {
      suffix = url[url.length - 1] + suffix;
      url = url.slice(0, -1);
    }

    if (url.length > 0) segments.push({ text: url, url });
    if (suffix) segments.push({ text: suffix });

    lastIndex = match.index + match[0].length;
    match = URL_RE.exec(text);
  }

  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex) });
  }
  return segments;
}

/**
 * How a line should be set.
 *
 * `prose` is a sentence and is set proportionally. `mono` keeps its columns.
 * `meta` is the agent reporting on itself, which the reader glances at rather
 * than reads, so it is quieter than either. `user` is a message the reader
 * sent, shown as their own turn in the conversation rather than as output.
 */
export type LineKind = 'prose' | 'mono' | 'meta' | 'user';

export interface OutputLine {
  readonly kind: LineKind;
  readonly segments: TextSegment[];
  /** Files the line names by path, as written, for the bridge to resolve. */
  readonly files: string[];
}

/**
 * Kinds of file worth bringing to the phone when the transcript names one:
 * images are shown, the rest offered. Source files are deliberately absent,
 * or every edit the agent reports would come with a card.
 */
const IMAGE_EXTENSIONS = 'png|jpe?g|gif|webp|bmp';
const DELIVERABLE_EXTENSIONS = 'apk|pdf|zip|7z|rar|csv|docx?|xlsx?|pptx?|mp4|mp3|m4a|wav';
const FILE_TOKEN = new RegExp(
  `^@?(?:[A-Za-z]:[\\\\/]|~[\\\\/]|\\.{1,2}[\\\\/])?(?:[^\\\\/<>|"'*?]+[\\\\/])*[^\\\\/<>|"'*?]+\\.(?:${IMAGE_EXTENSIONS}|${DELIVERABLE_EXTENSIONS})$`,
  'i',
);
/** Something the reader attached, whatever its kind: the app itself wrote the reference. */
const ATTACHED_TOKEN = /^@\S+\.[A-Za-z0-9]+$/;
const TOKEN_BOUNDARY = /[\s"'`()[\]{}<>,;]+/;
const TRAILING_STOP = /[.,:;!?]+$/;

/**
 * The file paths a line names. In the reader's own message every attachment
 * counts; in output only the kinds listed above, since a path there is a
 * mention, not a delivery.
 */
export function findFileReferences(text: string, ownMessage = false): string[] {
  const found: string[] = [];
  for (const raw of text.split(TOKEN_BOUNDARY)) {
    const token = raw.replace(TRAILING_STOP, '');
    if (!token || /^[a-z]+:\/\//i.test(token)) continue;
    if (!FILE_TOKEN.test(token) && !(ownMessage && ATTACHED_TOKEN.test(token))) continue;
    if (!found.includes(token)) found.push(token);
  }
  return found;
}

/** A sent message without its attachment references: those are shown as the files themselves. */
function withoutAttachments(text: string): string {
  return text
    .split(/\s+/)
    .filter((word) => !ATTACHED_TOKEN.test(word.replace(TRAILING_STOP, '')))
    .join(' ')
    .trim();
}

/**
 * A shell prompt, a tree branch, a table, the line-number gutter of a file
 * listing: anything whose columns carry meaning. The agent's own message
 * markers are deliberately absent, because the line that follows one of them is
 * a sentence.
 *
 * The gutter alternative requires the number to be indented and followed by a
 * space, so "  1. primo passo" stays an ordinary list item while "   42 set -u"
 * is recognised as source being quoted back.
 */
const STRUCTURAL =
  /[│┃⎿└├─╭╰┌┐]|^\s*[$>❯#]\s|^\s*\d+\s*[|:]|^\s{2,}\d{1,5}\s|\S\s{3,}\S/;
/** Two or more runs of multiple spaces: a table, not a sentence. */
const COLUMNAR = /\S {2,}\S.* {2,}\S/;

/**
 * A line that opens something of its own: a list item, or one of the agent's
 * message markers. It must never be folded into the paragraph above it, or a
 * list of three points arrives as one run-on sentence.
 */
const BLOCK_START = /^\s*(?:[-*•‣▪◦●○※]|\d+[.)])\s/;

/**
 * A message the reader sent, echoed back by the agent's interface with its
 * prompt marker in front. The live, still-editable prompt at the foot of the
 * interface looks the same and is removed before this is ever consulted.
 */
const USER_LINE = /^\s*❯\s+\S/;
const USER_MARKER = /^\s*❯\s+/;
/**
 * The same, for interfaces that echo the message behind a plain ">". Only an
 * agent's window reads that way: in a shell, ">" is a quote or a redirect.
 */
const AGENT_USER_LINE = /^\s*[❯>]\s+\S/;
const AGENT_USER_MARKER = /^\s*[❯>]\s+/;

/** "Ran 2 shell commands", "Running 1 shell command · 1m 20s…", "Thought · 1.5s". */
const ACTIVITY = /^(?:Ran|Running|Read|Searched|Listed|Wrote|Edited|Thought|Thinking)\b.*$/;
/** The working indicator and its counters. */
const SPINNER = /^[✳✻✶✽*·]\s+\S+…/;
/** The model line some interfaces print under each reply: "▣ Build · Muse Spark · 15.8s". */
const MODEL_LINE = /^[▣■◼]\s+\S/;

/**
 * A single ordinary word on a line of its own, lightly indented: how the last
 * word of a wrapped paragraph arrives. On its own it cannot be told from a
 * lone identifier, so it counts as prose only when a paragraph precedes it.
 */
const LONE_WORD = /^\s{0,3}[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’]*[.,:;!?]?\s*$/;

/**
 * Decides how a line should be set.
 *
 * The reference for this screen is a chat, not a console: sentences belong in a
 * proportional face at a readable size. But terminal output also carries trees,
 * tables and command echoes whose meaning is in the alignment, and setting those
 * proportionally destroys them. So each line is judged on its own.
 */
function classify(line: string, agent?: string): LineKind {
  const trimmed = line.trim();
  if (trimmed.length === 0) return 'prose';
  if ((agent ? AGENT_USER_LINE : USER_LINE).test(line)) return 'user';
  if (ACTIVITY.test(trimmed) || SPINNER.test(trimmed) || MODEL_LINE.test(trimmed)) return 'meta';
  if (STRUCTURAL.test(line) || COLUMNAR.test(line)) return 'mono';

  // A list bullet or a message marker is punctuation that says nothing about
  // the words after it, so it is not counted among them: "- prima" and
  // "● Fatto." are one word of sentence each, not half a sentence.
  const marked = BLOCK_START.test(trimmed);
  const body = marked ? trimmed.replace(BLOCK_START, '') : trimmed;

  // Two words is enough: a wrapped paragraph often ends on a very short line,
  // and setting that one line in a different face is worse than getting it wrong.
  const words = body.split(/\s+/);
  if (!marked && words.length < 2) return 'mono';

  // A sentence is mostly ordinary words; a command line is mostly punctuation,
  // flags and paths.
  const wordy = words.filter((word) => /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’]*[.,:;!?]?$/.test(word)).length;
  const ratio = wordy / words.length;

  // A deep indent usually means a code or tool block, but it is also how the
  // second line of a wrapped list item arrives. Demand a stronger sentence
  // before calling an indented line prose, rather than switching face midway
  // through somebody's paragraph.
  if (line.startsWith('    ')) return ratio >= 0.8 ? 'prose' : 'mono';

  return ratio >= 0.6 ? 'prose' : 'mono';
}

/**
 * Splits the buffer into lines ready to render, each with its links resolved.
 *
 * Consecutive sentences are joined back into one paragraph first. The terminal
 * wrapped them to its own width when it drew them, and a phone is narrower, so
 * keeping those breaks wraps text that is already wrapped and leaves a trail of
 * two-word lines. Paragraphs are separated by a blank line, which survives.
 */
export function segmentOutput(text: string, agent?: string): OutputLine[] {
  if (!text) return [];

  const blocks: { kind: LineKind; text: string }[] = [];
  const userMarker = agent ? AGENT_USER_MARKER : USER_MARKER;

  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      blocks.push({ kind: 'prose', text: '' });
      continue;
    }

    const previous = blocks[blocks.length - 1];
    const afterParagraph = (previous?.kind === 'prose' || previous?.kind === 'user') && previous.text !== '';
    const judged = classify(line, agent);
    const kind = judged === 'mono' && afterParagraph && LONE_WORD.test(line) ? 'prose' : judged;

    // A sent message wraps like any paragraph, so its second line is a plain
    // indented sentence and belongs to the message above it.
    const continuesParagraph = kind === 'prose' && afterParagraph && !BLOCK_START.test(line);

    if (continuesParagraph) {
      previous.text = `${previous.text} ${line.trim()}`;
      continue;
    }

    if (kind === 'user') {
      blocks.push({ kind, text: line.replace(userMarker, '').trim() });
      continue;
    }

    blocks.push({ kind, text: kind === 'prose' ? line.trim() : line });
  }

  // A file is shown where it first comes up; later mentions stay text, or a
  // screenshot the agent keeps referring to would repeat down the page.
  const seen = new Set<string>();
  const firstMentions = (files: string[]) =>
    files.filter((file) => {
      const key = file.replace(/^@/, '').replace(/\\/g, '/').toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  return blocks.map((block) => {
    if (block.kind === 'user') {
      return {
        kind: block.kind,
        segments: segmentLinks(withoutAttachments(block.text)),
        files: firstMentions(findFileReferences(block.text, true)),
      };
    }
    return {
      kind: block.kind,
      segments: segmentLinks(block.text),
      files: block.text ? firstMentions(findFileReferences(block.text)) : [],
    };
  });
}
