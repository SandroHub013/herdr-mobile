import { Effect } from 'effect';
import { Platform } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';
import { DownloadError, OpenError } from './errors';

/**
 * Files the session names, brought to the phone.
 *
 * The transcript refers to files by path: a screenshot the agent took, a
 * package it built, something the reader sent it. The bridge resolves each
 * path in the pane's working directory and serves it, so the app can show
 * an image where the text only had its name, and hand any other file to
 * whichever app on the phone opens that kind.
 */

export interface SessionFile {
  /** Absolute, as the bridge resolved it. */
  readonly path: string;
  readonly name: string;
  readonly size: number;
  /** Seconds. Part of the thumbnail address, so a rewritten file is fetched again. */
  readonly mtime: number;
  readonly mime: string;
  readonly kind: 'image' | 'file';
}

const VIEW = 'android.intent.action.VIEW';
/** Intent.FLAG_GRANT_READ_URI_PERMISSION: lets the other app read our cache file. */
const GRANT_READ_URI = 1;

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Where received files land. A file with the same name is replaced. */
const receivedDirectory = (): Directory => {
  const directory = new Directory(Paths.cache, 'ricevuti');
  directory.create({ intermediates: true, idempotent: true });
  return directory;
};

export const downloadFile = (
  url: string,
  name: string,
  size: number,
  onProgress: (fraction: number) => void,
  headers: Record<string, string> = {},
): Effect.Effect<File, DownloadError> =>
  Effect.tryPromise({
    try: async () => {
      const destination = new File(receivedDirectory(), name);
      if (destination.exists) destination.delete();
      const task = File.createDownloadTask(url, destination, {
        headers,
        onProgress: ({ bytesWritten, totalBytes }) => {
          const total = totalBytes > 0 ? totalBytes : size;
          if (total > 0) onProgress(Math.min(1, bytesWritten / total));
        },
      });
      const downloaded = await task.downloadAsync();
      if (!downloaded) throw new Error('scaricamento interrotto');
      return downloaded;
    },
    catch: (cause) => new DownloadError({ url, reason: describeCause(cause) }),
  });

/**
 * Hands the file to the app Android has for its kind: a package goes to the
 * installer, a document to a viewer. When nothing claims it, the share sheet
 * lets the reader choose where it goes. iOS has no intents: the share sheet
 * is the way a file reaches another app, and it offers the viewers too.
 */
export const openFile = (file: File, mime: string): Effect.Effect<void, OpenError> =>
  Effect.tryPromise({
    try: async () => {
      if (Platform.OS === 'android') {
        try {
          await IntentLauncher.startActivityAsync(VIEW, { data: file.contentUri, type: mime, flags: GRANT_READ_URI });
          return;
        } catch {
          // Nothing on the phone claims this kind: fall through to the sheet.
        }
      }
      await Sharing.shareAsync(file.uri, { mimeType: mime });
    },
    catch: (cause) => new OpenError({ name: file.name, reason: describeCause(cause) }),
  });

export const shareFile = (file: File, mime: string): Effect.Effect<void, OpenError> =>
  Effect.tryPromise({
    try: () => Sharing.shareAsync(file.uri, { mimeType: mime }),
    catch: (cause) => new OpenError({ name: file.name, reason: describeCause(cause) }),
  });

/**
 * Removes the picker's copy of a file once the composer is done with it. A
 * file opened from the reader's own storage is not in the cache and stays.
 */
export function discardLocalCopy(uri: string): void {
  if (!uri.startsWith(Paths.cache.uri)) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // A stale file in the cache, nothing worse.
  }
}

/** "APK", "PDF": the badge on a file card. */
export function extensionLabel(name: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(name);
  return match ? match[1].toUpperCase() : 'FILE';
}
