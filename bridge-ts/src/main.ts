import { createServer } from 'node:http';
import os from 'node:os';
import { HttpLayerRouter } from '@effect/platform';
import { NodeContext, NodeHttpServer, NodeRuntime } from '@effect/platform-node';
import { Effect, Layer, Logger, LogLevel } from 'effect';
import * as Adapter from './adapters/Adapter.ts';
import * as ClaudeCode from './adapters/ClaudeCode.ts';
import * as Terminal from './adapters/Terminal.ts';
import * as FileRoutes from './FileRoutes.ts';
import * as ReleaseRoutes from './ReleaseRoutes.ts';
import * as Routes from './Routes.ts';
import * as Socket from './Socket.ts';
import * as Config from './services/Config.ts';
import * as Files from './services/Files.ts';
import * as HerdrRpc from './services/HerdrRpc.ts';
import * as Snapshot from './services/Snapshot.ts';
import * as Transcript from './services/Transcript.ts';

/**
 * The bridge.
 *
 * It listens on the Tailscale address by default, because a port that lets
 * anyone type into every terminal on this PC has no business being on the
 * open network. `--lan` is the deliberate way to widen that, and it has to be
 * asked for.
 */

interface Args {
  readonly host?: string;
  readonly lan: boolean;
  readonly port: number;
  readonly socketPath: string;
}

function parseArgs(argv: ReadonlyArray<string>): Args {
  let host: string | undefined;
  let lan = false;
  // Overridable so this bridge can run beside the one already serving a
  // phone, on its own port, until the phone has a build that speaks to it.
  let port = Config.PORT;
  let socketPath = Config.DEFAULT_SOCKET_PATH;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--lan') lan = true;
    else if (argv[i] === '--host') host = argv[++i];
    else if (argv[i] === '--port') port = Number(argv[++i]) || Config.PORT;
    else if (argv[i] === '--socket') socketPath = argv[++i];
  }
  return { host, lan, port, socketPath };
}

/** The Tailscale address of this machine, when it is on a tailnet. */
function tailscaleIp(): string | undefined {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && address.address.startsWith('100.')) {
        return address.address;
      }
    }
  }
  return undefined;
}

function chooseBind(args: Args): { host: string; note: string } {
  if (args.host) return { host: args.host, note: 'indirizzo scelto a mano' };
  if (args.lan) return { host: '0.0.0.0', note: 'rete locale compresa' };
  const tailscale = tailscaleIp();
  if (tailscale) return { host: tailscale, note: 'solo Tailscale' };
  return { host: '127.0.0.1', note: 'solo questo PC — Tailscale non trovato' };
}

const args = parseArgs(process.argv.slice(2));
const bind = chooseBind(args);

const ConfigLive = Config.layer({
  host: bind.host,
  port: args.port,
  socketPath: args.socketPath,
});
const RpcLive = HerdrRpc.layer(args.socketPath);
const TranscriptLive = Transcript.layer;

/**
 * The registry, in the order that decides which adapter speaks for a pane. The
 * structured ones get first refusal and the terminal fallback is last, because
 * it can read any pane and would otherwise claim every session.
 */
const AdaptersLive = Layer.effect(
  Adapter.Adapters,
  Effect.gen(function* () {
    const claudeCode = yield* ClaudeCode.make;
    const terminal = yield* Terminal.make;
    const structured = [claudeCode];
    return {
      all: [...structured, terminal],
      forPane: (pane) =>
        Effect.gen(function* () {
          for (const adapter of structured) {
            if (yield* adapter.detect(pane)) return adapter;
          }
          return terminal;
        }),
    };
  }),
).pipe(Layer.provide(Layer.mergeAll(RpcLive, TranscriptLive)));

const SnapshotLive = Snapshot.layer.pipe(Layer.provide(RpcLive));
const FilesLive = Files.layer.pipe(Layer.provide(SnapshotLive));

const Services = Layer.mergeAll(
  ConfigLive,
  RpcLive,
  TranscriptLive,
  AdaptersLive,
  SnapshotLive,
  FilesLive,
  // Serving a file and taking a multipart upload both want the platform's
  // filesystem and path services.
  NodeContext.layer,
);

const banner = Effect.gen(function* () {
  const config = yield* Config.BridgeConfig;
  yield* Effect.logInfo(
    [
      '',
      `  Herdr Mobile bridge`,
      `  In ascolto su  http://${config.host}:${config.port}  (${bind.note})`,
      `  Token          ${config.token}`,
      `  File del token ${config.tokenFile}`,
      '',
    ].join('\n'),
  );
}).pipe(Effect.provide(ConfigLive));

/**
 * The routes carry their requirements as per-request ones, which only `serve`
 * unwraps — so the services are provided to the served layer, not to the
 * routes. Providing them earlier typechecks as a no-op and leaves the server
 * asking for services nobody handed it.
 */
const Application = Layer.mergeAll(
  Routes.layer,
  FileRoutes.layer,
  ReleaseRoutes.layer,
  Socket.layer,
  Layer.effectDiscard(banner),
).pipe(Layer.provide(HttpLayerRouter.cors({ allowedOrigins: ['*'], allowedHeaders: ['*'] })));

HttpLayerRouter.serve(Application).pipe(
  Layer.provide(Services),
  Layer.provide(NodeHttpServer.layer(createServer, { port: args.port, host: bind.host })),
  Layer.launch,
  Logger.withMinimumLogLevel(LogLevel.Info),
  NodeRuntime.runMain,
);
