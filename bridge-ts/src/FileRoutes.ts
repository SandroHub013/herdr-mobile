import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  HttpLayerRouter,
  HttpServerRequest,
  HttpServerResponse,
  Multipart,
} from '@effect/platform';
import { Effect, Layer } from 'effect';
import { BridgeConfig, TOKEN_HEADER, isPublicPath } from './services/Config.ts';
import { Files } from './services/Files.ts';

/**
 * Files, both directions.
 *
 * A path an agent mentions should be something the reader can open, look at
 * and keep; a photo on the phone should be something the agent can be pointed
 * at. Neither is a side feature of a chat about code — most of what is worth
 * saying about a change is in a file somewhere.
 */

const fail = (status: number, detail: string) =>
  HttpServerResponse.json({ detail }).pipe(
    Effect.map(HttpServerResponse.setStatus(status)),
    Effect.orDie,
  );

const json = (value: unknown) => HttpServerResponse.json(value).pipe(Effect.orDie);

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

const guarded = <A, E, R>(body: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.gen(function* () {
    if (!(yield* authorized)) return yield* fail(401, 'Token del bridge mancante o sbagliato');
    return yield* body;
  });

/** The three things every file route needs off the query string. */
const target = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const params = new URL(request.url, 'http://bridge').searchParams;
  return {
    path: params.get('path') ?? '',
    workspaceId: params.get('workspace_id') ?? undefined,
    paneId: params.get('pane_id') ?? undefined,
    width: Number(params.get('w') ?? 512),
  };
});

/** Resolves and describes, or gives the caller the 404 to return. */
const located = Effect.gen(function* () {
  const files = yield* Files;
  const asked = yield* target;
  if (!asked.path) return null;
  const full = yield* files.resolve(asked.path, asked.workspaceId, asked.paneId);
  if (!full) return null;
  const info = yield* files.describe(full);
  return info ? { info, asked } : null;
});

const Meta = HttpLayerRouter.add(
  'GET',
  '/api/files/meta',
  guarded(
    Effect.gen(function* () {
      const found = yield* located;
      return found ? yield* json(found.info) : yield* fail(404, 'File non trovato');
    }),
  ),
);

const Raw = HttpLayerRouter.add(
  'GET',
  '/api/files',
  guarded(
    Effect.gen(function* () {
      const found = yield* located;
      if (!found) return yield* fail(404, 'File non trovato');
      return yield* HttpServerResponse.file(found.info.path, {
        contentType: found.info.mime,
        headers: {
          // Named, so a download lands under the name the agent used rather
          // than a query string.
          'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(found.info.name)}`,
          'cache-control': 'private, max-age=60',
        },
      }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 404 })));
    }),
  ),
);

/**
 * A reduced copy of an image: a strip of screenshots must not cost a strip of
 * screenshots' worth of bytes over a phone link. Falls back to the original if
 * the resizer is missing or the file is not one it understands, because a
 * heavy picture beats a broken one.
 */
const THUMB_MAX = 1024;

const resize = (file: string, width: number) =>
  Effect.tryPromise(async () => {
    const { default: sharp } = await import('sharp');
    const bounded = Math.max(64, Math.min(width, THUMB_MAX));
    const image = sharp(file, { failOn: 'none' }).rotate().resize({
      width: bounded,
      height: bounded,
      fit: 'inside',
      withoutEnlargement: true,
    });
    const meta = await sharp(file, { failOn: 'none' }).metadata();
    return meta.hasAlpha
      ? { body: await image.png({ compressionLevel: 8 }).toBuffer(), mime: 'image/png' }
      : { body: await image.jpeg({ quality: 82 }).toBuffer(), mime: 'image/jpeg' };
  });

const Thumb = HttpLayerRouter.add(
  'GET',
  '/api/files/thumb',
  guarded(
    Effect.gen(function* () {
      const found = yield* located;
      if (!found) return yield* fail(404, 'File non trovato');
      if (found.info.kind !== 'image') return yield* fail(415, "Non è un'immagine");

      const reduced = yield* resize(found.info.path, found.asked.width).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (!reduced) {
        return yield* HttpServerResponse.file(found.info.path, {
          contentType: found.info.mime,
        }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 404 })));
      }
      return HttpServerResponse.uint8Array(reduced.body, {
        contentType: reduced.mime,
        headers: { 'cache-control': 'private, max-age=3600' },
      });
    }),
  ),
);

/** A name that cannot climb out of the uploads directory. */
const safeName = (raw: string): string => {
  const base = path.basename(raw.replace(/[\\/]+/g, '/')).replace(/[<>:"|?*\x00-\x1f]/g, '_');
  return base && base !== '.' && base !== '..' ? base : `allegato-${Date.now()}`;
};

/** A name nobody is using yet, so an upload never quietly replaces an earlier one. */
const freeName = (dir: string, name: string) =>
  Effect.tryPromise(async () => {
    const ext = path.extname(name);
    const stem = path.basename(name, ext);
    for (let n = 0; n < 500; n++) {
      const candidate = n === 0 ? name : `${stem}-${n}${ext}`;
      if (!fsSync.existsSync(path.join(dir, candidate))) return candidate;
    }
    return `${stem}-${Date.now()}${ext}`;
  }).pipe(Effect.orElseSucceed(() => name));

const Upload = HttpLayerRouter.add(
  'POST',
  '/api/upload',
  guarded(
    Effect.gen(function* () {
      const files = yield* Files;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const form = yield* request.multipart.pipe(
        Effect.mapError(() => 'illeggibile' as const),
      );

      const first = <T,>(value: unknown): T | undefined =>
        Array.isArray(value) ? (value[0] as T) : undefined;
      const field = (key: string): string | undefined => {
        const value = form[key];
        if (typeof value === 'string') return value;
        const one = first<unknown>(value);
        return typeof one === 'string' ? one : undefined;
      };

      const uploaded = first<Multipart.PersistedFile>(form['file']);
      if (!uploaded || !Multipart.isPersistedFile(uploaded)) {
        return yield* fail(400, 'Nessun file nella richiesta');
      }

      const dir = yield* files.uploadDir(field('workspace_id'), field('pane_id'));
      if (!dir) return yield* fail(409, 'Nessuna cartella di lavoro per questa finestra');

      // The multipart filename is percent-encoded on the way out, so the app
      // sends the real one as its own field and that is what gets saved.
      const wanted = safeName(field('filename') ?? uploaded.name);
      yield* Effect.tryPromise(() => fs.mkdir(dir, { recursive: true })).pipe(Effect.orDie);
      const name = yield* freeName(dir, wanted);
      const destination = path.join(dir, name);

      yield* Effect.tryPromise(() => fs.rename(uploaded.path, destination)).pipe(
        // Across drives a rename fails; a copy is the same outcome, slower.
        Effect.orElse(() => Effect.tryPromise(() => fs.copyFile(uploaded.path, destination))),
        Effect.mapError(() => 'salvataggio fallito' as const),
      );
      const size = yield* Effect.tryPromise(() => fs.stat(destination).then((s) => s.size)).pipe(
        Effect.orElseSucceed(() => 0),
      );

      return yield* json({
        filename: name,
        path: destination,
        // What the agent is handed: it resolves this from its own directory.
        rel_ref: `@uploads/${name}`,
        size,
      });
    }).pipe(
      Effect.catchAll((cause) =>
        fail(400, typeof cause === 'string' ? `Caricamento ${cause}` : 'Caricamento fallito'),
      ),
    ),
  ),
);

export const layer = Layer.mergeAll(Meta, Raw, Thumb, Upload);
