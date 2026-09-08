/**
 * Terminal text sanitising, moved to where it belongs.
 *
 * Herdr streams raw terminal buffers. Two things have to happen before the
 * text can be shown: escape sequences must go, and the sequences whose ESC
 * byte was lost in transport — they arrive as a bare "[0m" — must go too.
 *
 * This used to run on the phone, once per render, over every pane. It runs
 * here now because only the fallback adapter needs it at all: an agent with a
 * real transcript never goes near a terminal buffer.
 *
 * Ported from app/src/ansi.ts. The heavier work in that file — recognising a
 * TUI's boxes and side panels and lifting the text out of them — has not moved
 * yet; until it does, the fallback shows a cleaned screen, not a cleaned
 * conversation.
 */

/* eslint-disable no-control-regex */
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const CHARSET = /\x1b[()#][0-9A-Za-z]/g;
const SINGLE = /\x1b[=><NOM78]/g;
const LONE_ESC = /\x1b/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
/* eslint-enable no-control-regex */

/** A glyph that did not survive the trip from the agent to Herdr: noise, not text. */
const REPLACEMENT = /�/g;

/**
 * Sequences that reached us without their ESC byte. Digits are required so
 * that ordinary bracketed text ("[y/n]", "array[i]") survives untouched.
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
    .replace(CONTROL, '')
    .replace(REPLACEMENT, '');
}
