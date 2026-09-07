import { Effect } from 'effect';
import * as Application from 'expo-application';
import * as Device from 'expo-device';
import { Directory, File, Paths } from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import { CorruptDownload, DownloadError, InstallError } from './errors';

/**
 * Updating the app from the bridge.
 *
 * There is no store between the PC and the phone: release.mjs publishes an
 * APK next to the bridge, the bridge describes it, and the app fetches and
 * hands it to the Android installer. The user confirms the install; the app
 * never installs anything on its own.
 */

export interface ReleaseApk {
  readonly file: string;
  readonly size: number;
  readonly md5: string;
  /** Path on the bridge, relative to its base URL. */
  readonly url: string;
}

export interface Release {
  readonly version: string;
  /** Grows by one with every release; the only number that is compared. */
  readonly versionCode: number;
  readonly date: string;
  readonly notes: string;
  readonly apks: Readonly<Record<string, ReleaseApk>>;
}

const ARM64 = 'arm64-v8a';
const UNIVERSAL = 'universal';
const INSTALL_PACKAGE = 'android.intent.action.INSTALL_PACKAGE';
const APK_MIME = 'application/vnd.android.package-archive';
/** Intent.FLAG_GRANT_READ_URI_PERMISSION: lets the installer read our cache file. */
const GRANT_READ_URI = 1;

export function installedVersion(): string {
  return Application.nativeApplicationVersion ?? '0.0.0';
}

export function installedBuild(): number {
  return Number(Application.nativeBuildVersion ?? '0') || 0;
}

export function isNewer(release: Release): boolean {
  return release.versionCode > installedBuild();
}

/**
 * The smallest package this device actually runs natively.
 *
 * Nearly every phone is arm64. The list is ordered by preference, and only
 * its first entry is the processor itself: an x86 emulator lists arm64 too,
 * through translation, and an arm64 package installed there starts and dies
 * without its native libraries. So arm64 is chosen only when it comes first.
 */
export function pickApk(release: Release): ReleaseApk | null {
  const [primary] = Device.supportedCpuArchitectures ?? [];
  if (primary === ARM64 && release.apks[ARM64]) return release.apks[ARM64];
  return release.apks[UNIVERSAL] ?? release.apks[ARM64] ?? null;
}

export function formatSize(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1).replace('.', ',')} MB`;
}

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Where packages land. Cleared before each download: they are large. */
const packagesDirectory = (): Directory => {
  const directory = new Directory(Paths.cache, 'aggiornamenti');
  directory.create({ intermediates: true, idempotent: true });
  return directory;
};

/**
 * Fetches the package and checks it against what the bridge published, so a
 * download cut short by a dropped VPN is never handed to the installer.
 */
export const downloadApk = (
  url: string,
  apk: ReleaseApk,
  onProgress: (fraction: number) => void,
): Effect.Effect<File, DownloadError | CorruptDownload> =>
  Effect.gen(function* () {
    const file = yield* Effect.tryPromise({
      try: async () => {
        const directory = packagesDirectory();
        for (const stale of directory.list()) {
          if (stale instanceof File) stale.delete();
        }
        const destination = new File(directory, apk.file);
        const task = File.createDownloadTask(url, destination, {
          onProgress: ({ bytesWritten, totalBytes }) => {
            const total = totalBytes > 0 ? totalBytes : apk.size;
            if (total > 0) onProgress(Math.min(1, bytesWritten / total));
          },
        });
        const downloaded = await task.downloadAsync();
        if (!downloaded) throw new Error('scaricamento interrotto');
        return downloaded;
      },
      catch: (cause) => new DownloadError({ url, reason: describeCause(cause) }),
    });

    const actual = file.md5 ?? '';
    if (actual.toLowerCase() !== apk.md5.toLowerCase()) {
      return yield* Effect.fail(new CorruptDownload({ expected: apk.md5, actual }));
    }
    return file;
  });

/** Opens the Android installer on the package. Resolves as soon as it is open. */
export const installApk = (file: File): Effect.Effect<void, InstallError> =>
  Effect.tryPromise({
    try: async () => {
      await IntentLauncher.startActivityAsync(INSTALL_PACKAGE, {
        data: file.contentUri,
        type: APK_MIME,
        flags: GRANT_READ_URI,
      });
    },
    catch: (cause) => new InstallError({ reason: describeCause(cause) }),
  });
