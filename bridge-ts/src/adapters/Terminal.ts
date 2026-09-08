import { Effect } from 'effect';
import { Capabilities } from '../domain/Capabilities.ts';
import { ConversationPage, MessageEvent } from '../domain/Event.ts';
import { stripAnsi } from '../domain/ansi.ts';
import { HerdrRpc } from '../services/HerdrRpc.ts';
import { type Adapter } from './Adapter.ts';

/**
 * The adapter of last resort: a pane nobody else claimed.
 *
 * There is no record to read, only the screen the program is drawing, so this
 * can offer one thing — what is on it, with the escape codes taken out. No
 * tool cards, no diffs, no history before the top of the screen. The manifest
 * says `structured: false`, and the app is expected to believe it and hide
 * everything it would otherwise be inventing.
 */

/** Herdr keeps a thousand lines of scrollback per pane and hands back all of it. */
const READ_LINES = 1000;

const capabilities = new Capabilities({
  id: 'terminal',
  label: 'Terminale',
  structured: false,
  slashCommands: false,
  backgroundTasks: false,
  toolResults: false,
  diffs: false,
  fileReference: 'bare-path',
  interruptKeys: ['C-c'],
  controls: [],
});

export const make: Effect.Effect<Adapter, never, HerdrRpc> = Effect.gen(function* () {
  const rpc = yield* HerdrRpc;

  const screen = (paneId: string) =>
    Effect.gen(function* () {
      const result: any = yield* rpc.callOption('pane.read', {
        pane_id: paneId,
        source: 'recent',
        format: 'ansi',
        lines: READ_LINES,
      });
      const raw = String(result?.read?.text ?? result?.text ?? '');
      return stripAnsi(raw).replace(/\n{3,}/g, '\n\n').trim();
    });

  return {
    id: 'terminal',
    label: 'Terminale',
    // Claims anything, which is why the registry keeps it last.
    detect: () => Effect.succeed(true),
    capabilities: () => Effect.succeed(capabilities),
    conversation: (pane) =>
      Effect.gen(function* () {
        const text = yield* screen(pane.paneId);
        // Always the same single event, resent every time. The screen has no
        // past to page through and no revisions to track: it is simply what is
        // on it now, and the app replaces what it held.
        const events = text
          ? [new MessageEvent({ seq: 0, role: 'assistant', text: '```\n' + text + '\n```' })]
          : [];
        return new ConversationPage({
          paneId: pane.paneId,
          agent: 'terminal',
          session: null,
          match: 'screen',
          total: events.length,
          rev: 0,
          events,
        });
      }),
  };
});
