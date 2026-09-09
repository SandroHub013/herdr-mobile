import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpLayerRouter, HttpServerResponse } from '@effect/platform';
import { Effect, Layer } from 'effect';

/**
 * How a phone gets the next build.
 *
 * These three routes are the only ones that answer without a token, and they
 * have to: an app carrying an older token, or none, still has to be able to
 * see and fetch the build that would fix it. The packages are on GitHub
 * anyway.
 *
 * That matters more than usual right now. The app has moved to the new
 * conversation API, so a phone running an older build cannot talk to this
 * bridge at all — the one thing it must still be able to do is notice there
 * is a newer APK and download it. If these routes were behind the token, or
 * missing, that phone would simply be stranded.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RELEASES_DIR = path.resolve(HERE, '..', '..', 'releases');
const APK_MEDIA_TYPE = 'application/vnd.android.package-archive';

interface Apk {
  file: string;
  url?: string;
}

/**
 * The release published last by release.mjs, with a download path per APK.
 *
 * The path is relative on purpose: the phone reaches this bridge by whichever
 * address it has configured, over the LAN or over Tailscale, and only the
 * phone knows which one that is.
 */
const readLatest = Effect.tryPromise(async () => {
  const raw = await fs.readFile(path.join(RELEASES_DIR, 'latest.json'), 'utf8');
  const release = JSON.parse(raw) as { apks?: Record<string, Apk> };
  for (const apk of Object.values(release.apks ?? {})) apk.url = `/app/${apk.file}`;
  return release;
}).pipe(Effect.orElseSucceed(() => null));

const missing = (detail: string) =>
  HttpServerResponse.json({ detail }).pipe(
    Effect.map(HttpServerResponse.setStatus(404)),
    Effect.orDie,
  );

const sendApk = (file: string, name: string) =>
  HttpServerResponse.file(file, {
    contentType: APK_MEDIA_TYPE,
    headers: { 'content-disposition': `attachment; filename="${name}"` },
  }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 404 })));

const exists = (file: string) =>
  Effect.tryPromise(() => fs.access(file)).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

const Latest = HttpLayerRouter.add(
  'GET',
  '/api/app/latest',
  Effect.gen(function* () {
    const release = yield* readLatest;
    if (!release) return yield* missing('Nessuna release pubblicata');
    return yield* HttpServerResponse.json(release).pipe(Effect.orDie);
  }),
);

const Download = HttpLayerRouter.add(
  'GET',
  '/app/:filename',
  Effect.gen(function* () {
    const params = yield* HttpLayerRouter.params;
    const asked = decodeURIComponent(String(params.filename ?? ''));
    // Only names of files that live in the releases folder, nothing with a
    // path in it: this route answers without a token.
    const name = path.basename(asked);
    if (name !== asked || !name.endsWith('.apk')) return yield* missing('APK non trovata');

    const file = path.join(RELEASES_DIR, name);
    if (!(yield* exists(file))) return yield* missing('APK non trovata');
    return yield* sendApk(file, name);
  }),
);

/** The newest arm64 release, or whatever Gradle built last if nothing is published yet. */
const Newest = HttpLayerRouter.add(
  'GET',
  '/download/apk',
  Effect.gen(function* () {
    const release = yield* readLatest;
    const apks = release?.apks ?? {};
    const chosen = apks['arm64-v8a'] ?? Object.values(apks)[0];
    if (chosen) {
      const file = path.join(RELEASES_DIR, chosen.file);
      if (yield* exists(file)) return yield* sendApk(file, chosen.file);
    }

    const built = path.resolve(HERE, '..', '..', 'app', 'android', 'app', 'build', 'outputs', 'apk');
    for (const candidate of [
      path.join(built, 'release', 'app-release.apk'),
      path.join(built, 'debug', 'app-debug.apk'),
    ]) {
      if (yield* exists(candidate)) return yield* sendApk(candidate, 'HerdrMobile.apk');
    }
    return yield* missing('Nessuna APK disponibile');
  }),
);

export const layer = Layer.mergeAll(Latest, Download, Newest);
