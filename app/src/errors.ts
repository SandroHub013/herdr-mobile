import { Data } from 'effect';

/**
 * Failures the bridge can produce, as data rather than exceptions.
 *
 * The point of naming them is that the compiler now carries them in the type of
 * every call, so a new failure mode cannot be forgotten at the place that has to
 * tell the user about it.
 */

export class NetworkError extends Data.TaggedError('NetworkError')<{
  readonly url: string;
  /** What the platform actually said. Without it a failure is undiagnosable. */
  readonly cause: string;
}> {}

export class TimeoutError extends Data.TaggedError('TimeoutError')<{
  readonly url: string;
  readonly millis: number;
}> {}

export class HttpError extends Data.TaggedError('HttpError')<{
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
}> {}

export class DecodeError extends Data.TaggedError('DecodeError')<{
  readonly url: string;
  readonly reason: string;
}> {}

export class SocketError extends Data.TaggedError('SocketError')<{
  readonly reason: 'closed' | 'failed' | 'silent';
}> {}

export class StorageError extends Data.TaggedError('StorageError')<{
  readonly operation: 'read' | 'write';
}> {}

export class FileError extends Data.TaggedError('FileError')<{
  readonly name: string;
  readonly reason: string;
}> {}

/** The update package could not be fetched from the bridge. */
export class DownloadError extends Data.TaggedError('DownloadError')<{
  readonly url: string;
  readonly reason: string;
}> {}

/** The package arrived, but it is not the one the bridge described. */
export class CorruptDownload extends Data.TaggedError('CorruptDownload')<{
  readonly expected: string;
  readonly actual: string;
}> {}

/** Android refused to open the installer. */
export class InstallError extends Data.TaggedError('InstallError')<{
  readonly reason: string;
}> {}

/** Nothing on the phone would open the file, not even the share sheet. */
export class OpenError extends Data.TaggedError('OpenError')<{
  readonly name: string;
  readonly reason: string;
}> {}

export type BridgeError = NetworkError | TimeoutError | HttpError | DecodeError;

/** Uploading can also fail before the network is involved, on the file itself. */
export type UploadError = BridgeError | FileError;

/** Updating fails on the network, on the package, or at the installer. */
export type UpdateError = BridgeError | DownloadError | CorruptDownload | InstallError;

/** Receiving a file from the PC fails on the download or at the app meant to open it. */
export type ReceiveError = DownloadError | OpenError;

/** Short Italian wording for the toast. Exhaustive by construction. */
export function describeError(error: UploadError | UpdateError | ReceiveError): string {
  switch (error._tag) {
    case 'FileError':
      return `file non leggibile: ${error.reason}`;
    case 'OpenError':
      return `${error.name} non si apre: ${error.reason}`;
    case 'DownloadError':
      return `scaricamento interrotto: ${error.reason}`;
    case 'CorruptDownload':
      return 'il pacchetto scaricato non corrisponde a quello pubblicato';
    case 'InstallError':
      return `installazione non avviata: ${error.reason}`;
    case 'TimeoutError':
      return 'il PC non ha risposto in tempo';
    case 'NetworkError':
      return error.cause ? `rete: ${error.cause}` : 'host irraggiungibile';
    case 'HttpError':
      return `il bridge ha risposto ${error.status}`;
    case 'DecodeError':
      return 'risposta del bridge non leggibile';
  }
}
