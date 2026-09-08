import {
  HttpLayerRouter,
  HttpServerRequest,
  HttpServerResponse,
} from '@effect/platform';
import { Effect, Layer } from 'effect';
import { Adapters } from './adapters/Adapter.ts';
import { AgentInfo } from './domain/Capabilities.ts';
import { BridgeConfig, TOKEN_HEADER, isPublicPath } from './services/Config.ts';
import { HerdrRpc } from './services/HerdrRpc.ts';
import { Snapshots } from './services/Snapshot.ts';

/**
 * The bridge's surface.
 *
 * There is no terminal route any more. The app asks a pane what agent is in it
 * and reads the conversation; the screen behind that conversation is the
 * fallback adapter's business, not the app's.
 */

/** Every failure the phone sees is a sentence it can show, not a stack trace. */
const fail = (status: number, detail: string) =>
  HttpServerResponse.json({ detail }).pipe(
    Effect.map(HttpServerResponse.setStatus(status)),
    Effect.orDie,
  );

const json = (value: unknown) => HttpServerResponse.json(value).pipe(Effect.orDie);

/**
 * Whoever reaches this port can type into every terminal on the PC, so each
 * request carries the shared token. Checked here rather than in a middleware
 * so a route that forgets to ask simply does not exist.
 */
const authorized = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const config = yield* BridgeConfig;
  const url = new URL(request.url, 'http://bridge');
  if (isPublicPath(url.pathname)) return true;

  const header = request.headers[TOKEN_HEADER];
  const bearer = request.headers['authorization'];
  const presented =
    (typeof header === 'string' && header) ||
    (typeof bearer === 'string' && bearer.toLowerCase().startsWith('bearer ')
      ? bearer.slice(7).trim()
      : undefined);
  return config.accepts(presented || undefined);
});

/** Runs the body only for a caller that presented the token. */
const guarded = <A, E, R>(
  body: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  R | HttpServerRequest.HttpServerRequest | BridgeConfig
> =>
  Effect.gen(function* () {
    if (!(yield* authorized)) return yield* fail(401, 'Token del bridge mancante o sbagliato');
    return yield* body;
  });

const paneParam = Effect.gen(function* () {
  const params = yield* HttpLayerRouter.params;
  return decodeURIComponent(String(params.paneId ?? ''));
});

const bodyJson = HttpServerRequest.HttpServerRequest.pipe(
  Effect.flatMap((request) => request.json),
  Effect.map((value) => (value ?? {}) as Record<string, unknown>),
  Effect.orElseSucceed(() => ({}) as Record<string, unknown>),
);

const query = (name: string) =>
  HttpServerRequest.HttpServerRequest.pipe(
    Effect.map((request) => new URL(request.url, 'http://bridge').searchParams.get(name)),
  );

// ------------------------------------------------------------------- routes

const Status = HttpLayerRouter.add(
  'GET',
  '/api/status',
  guarded(
    Effect.gen(function* () {
      const rpc = yield* HerdrRpc;
      const alive = yield* rpc
        .call('session.snapshot')
        .pipe(Effect.as(true), Effect.orElseSucceed(() => false));
      return yield* json({ status: 'ok', herdr_alive: alive });
    }),
  ),
);

const SnapshotRoute = HttpLayerRouter.add(
  'GET',
  '/api/snapshot',
  guarded(
    Effect.gen(function* () {
      const snapshots = yield* Snapshots;
      return yield* json(yield* snapshots.current);
    }),
  ),
);

/** What is running in this pane and what it can be asked to do. */
const Agent = HttpLayerRouter.add(
  'GET',
  '/api/panes/:paneId/agent',
  guarded(
    Effect.gen(function* () {
      const paneId = yield* paneParam;
      const snapshots = yield* Snapshots;
      const adapters = yield* Adapters;
      const pane = yield* snapshots.pane(paneId);
      if (!pane) return yield* fail(404, 'Finestra sconosciuta');

      const adapter = yield* adapters.forPane(pane);
      const capabilities = yield* adapter.capabilities(pane);
      const page = yield* adapter
        .conversation(pane, 0)
        .pipe(Effect.orElseSucceed(() => null));

      return yield* json(
        new AgentInfo({ paneId, capabilities, session: page?.session ?? null }),
      );
    }),
  ),
);

/** The conversation itself, from `after` onward. */
const Conversation = HttpLayerRouter.add(
  'GET',
  '/api/panes/:paneId/conversation',
  guarded(
    Effect.gen(function* () {
      const paneId = yield* paneParam;
      const since = Number((yield* query('since')) ?? 0) || 0;
      const snapshots = yield* Snapshots;
      const adapters = yield* Adapters;
      const pane = yield* snapshots.pane(paneId);
      if (!pane) return yield* fail(404, 'Finestra sconosciuta');

      const adapter = yield* adapters.forPane(pane);
      const page = yield* adapter.conversation(pane, since);
      return yield* json(page);
    }).pipe(Effect.catchTag('AdapterError', (cause) => fail(404, cause.reason))),
  ),
);

/** Typing into the pane: a prompt, or a control the manifest declared. */
const SendText = HttpLayerRouter.add(
  'POST',
  '/api/panes/:paneId/send-text',
  guarded(
    Effect.gen(function* () {
      const paneId = yield* paneParam;
      const body = yield* bodyJson;
      const text = String(body.text ?? '');
      if (!text) return yield* fail(400, 'Niente da inviare');
      const rpc = yield* HerdrRpc;
      yield* rpc.call('pane.send_text', { pane_id: paneId, text });
      return yield* json({ status: 'ok' });
    }).pipe(Effect.catchTag('HerdrRpcError', (cause) => fail(502, cause.message))),
  ),
);

const SendKeys = HttpLayerRouter.add(
  'POST',
  '/api/panes/:paneId/send-keys',
  guarded(
    Effect.gen(function* () {
      const paneId = yield* paneParam;
      const body = yield* bodyJson;
      const keys = Array.isArray(body.keys) ? body.keys : [];
      if (keys.length === 0) return yield* fail(400, 'Nessun tasto');
      const rpc = yield* HerdrRpc;
      yield* rpc.call('pane.send_keys', { pane_id: paneId, keys });
      return yield* json({ status: 'ok' });
    }).pipe(Effect.catchTag('HerdrRpcError', (cause) => fail(502, cause.message))),
  ),
);

/**
 * Stops whatever the agent is doing, with the keys its own manifest names —
 * Escape for Claude Code, C-c for a shell. Guessing one interrupt for every
 * agent is how you kill a build instead of cancelling a reply.
 */
const Interrupt = HttpLayerRouter.add(
  'POST',
  '/api/panes/:paneId/interrupt',
  guarded(
    Effect.gen(function* () {
      const paneId = yield* paneParam;
      const snapshots = yield* Snapshots;
      const adapters = yield* Adapters;
      const rpc = yield* HerdrRpc;
      const pane = yield* snapshots.pane(paneId);
      if (!pane) return yield* fail(404, 'Finestra sconosciuta');
      const adapter = yield* adapters.forPane(pane);
      const capabilities = yield* adapter.capabilities(pane);
      for (const key of capabilities.interruptKeys) {
        yield* rpc.callOption('pane.send_keys', { pane_id: paneId, keys: [key] });
      }
      return yield* json({ status: 'ok', keys: capabilities.interruptKeys });
    }),
  ),
);

/** The pane and workspace commands the app still needs, each a straight pass-through. */
const passThrough = (
  method: 'POST',
  path: `/${string}`,
  build: (
    params: Record<string, string | undefined>,
    body: Record<string, unknown>,
  ) => { readonly method: string; readonly params: Record<string, unknown> },
) =>
  HttpLayerRouter.add(
    method,
    path,
    guarded(
      Effect.gen(function* () {
        const params = yield* HttpLayerRouter.params;
        const body = yield* bodyJson;
        const call = build(params as Record<string, string | undefined>, body);
        const rpc = yield* HerdrRpc;
        const result = yield* rpc.call(call.method, call.params);
        return yield* json({ status: 'ok', result });
      }).pipe(Effect.catchTag('HerdrRpcError', (cause) => fail(502, cause.message))),
    ),
  );

const decode = (value: string | undefined) => decodeURIComponent(String(value ?? ''));

const PaneCommands = Layer.mergeAll(
  passThrough('POST', '/api/panes/:paneId/focus', (p) => ({
    method: 'pane.focus',
    params: { pane_id: decode(p.paneId) },
  })),
  passThrough('POST', '/api/panes/:paneId/close', (p) => ({
    method: 'pane.close',
    params: { pane_id: decode(p.paneId) },
  })),
  passThrough('POST', '/api/panes/:paneId/split', (p, body) => ({
    method: 'pane.split',
    params: { pane_id: decode(p.paneId), direction: body.direction ?? 'right' },
  })),
  passThrough('POST', '/api/workspaces', (_p, body) => ({
    method: 'workspace.create',
    params: { label: body.label, cwd: body.cwd, focus: true },
  })),
  passThrough('POST', '/api/workspaces/:workspaceId/focus', (p) => ({
    method: 'workspace.focus',
    params: { workspace_id: decode(p.workspaceId) },
  })),
  passThrough('POST', '/api/tabs', (_p, body) => ({
    method: 'tab.create',
    params: { workspace_id: body.workspace_id, focus: true },
  })),
  passThrough('POST', '/api/tabs/:tabId/focus', (p) => ({
    method: 'tab.focus',
    params: { tab_id: decode(p.tabId) },
  })),
  passThrough('POST', '/api/tabs/:tabId/close', (p) => ({
    method: 'tab.close',
    params: { tab_id: decode(p.tabId) },
  })),
);

export const layer = Layer.mergeAll(
  Status,
  SnapshotRoute,
  Agent,
  Conversation,
  SendText,
  SendKeys,
  Interrupt,
  PaneCommands,
);
