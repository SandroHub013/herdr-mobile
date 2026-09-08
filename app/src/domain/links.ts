/**
 * The things in a message the reader can tap.
 *
 * Lifted out of the old terminal renderer, which is gone. Two of its jobs
 * survive the move to a conversation: a URL should open, and a file the agent
 * names should be something the reader can look at rather than a string they
 * have to go and find on the PC themselves.
 *
 * The rest of that file — recognising a shell prompt, a box, a table, a line
 * gutter — went with the terminal it was reading. What remains of the ANSI
 * work now runs on the bridge, next to the fallback adapter that is the only
 * thing still looking at a screen.
 */

export interface TextSegment {
  readonly text: string;
  readonly url?: string;
}

const URL_RE = /(https?:\/\/[^\s"'<>)\]]+|file:\/\/[^\s"'<>)\]]+)/g;
const TRAILING_PUNCTUATION = [',', '.', ';', ':', ')', ']', '>', '"', "'"];

/** Splits text into plain runs and link runs, so a view can render both. */
export function segmentLinks(text: string): TextSegment[] {
  if (!text) return [];
  const segments: TextSegment[] = [];
  let lastIndex = 0;

  URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null = URL_RE.exec(text);
  while (match !== null) {
    if (match.index > lastIndex) segments.push({ text: text.slice(lastIndex, match.index) });

    let url = match[0];
    let suffix = '';
    // A sentence's full stop is not part of the address it ends.
    while (url.length > 0 && TRAILING_PUNCTUATION.includes(url[url.length - 1])) {
      suffix = url[url.length - 1] + suffix;
      url = url.slice(0, -1);
    }

    if (url.length > 0) segments.push({ text: url, url });
    if (suffix) segments.push({ text: suffix });

    lastIndex = match.index + match[0].length;
    match = URL_RE.exec(text);
  }

  if (lastIndex < text.length) segments.push({ text: text.slice(lastIndex) });
  return segments;
}

/**
 * Kinds of file worth bringing to the phone when a message names one: images
 * are shown, the rest offered. Source files are deliberately absent, or every
 * edit the agent reports would arrive with a card attached — and an edit
 * already has its diff.
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
 * The file paths a message names. In the reader's own message every
 * attachment counts; in the agent's, only the kinds above, since a path there
 * is a mention rather than a delivery.
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
