import { Duration, Effect } from 'effect';
import { Directory, File, Paths } from 'expo-file-system';
import { SessionFile } from './files';
import { HistoryPage } from './history';
import { Release } from './updates';
import {
  BridgeError,
  DecodeError,
  FileError,
  HttpError,
  NetworkError,
  TimeoutError,
  UploadError,
} from './errors';

/**
 * REST client for the Herdr bridge.
 *
 * Every call is an Effect that declares how it can fail. The timeout is not a
 * hand-rolled abort controller any more: interrupting the fiber aborts the
 * underlying request, because the signal is handed straight to fetch.
 */

const DEFAULT_TIMEOUT = Duration.seconds(7);
const UPLOAD_TIMEOUT = Duration.seconds(60);

/** Effect wraps the thrown value; the useful part is usually the message. */
const describeCause = (cause: unknown): string => {
  const unwrapped = cause instanceof Error && 'error' in cause ? (cause as { error: unknown }).error : cause;
  if (unwrapped instanceof Error) return unwrapped.message;
  return String(unwrapped);
};

export interface UploadResult {
  filename: string;
  path: string;
  rel_ref: string;
  size: number;
}

const request = <A>(
  url: string,
  init: RequestInit | undefined,
  timeout: Duration.Duration,
): Effect.Effect<A, BridgeError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) => fetch(url, { ...init, signal }),
      catch: (cause) => new NetworkError({ url, cause: describeCause(cause) }),
    });

    if (!response.ok) {
      return yield* new HttpError({ url, status: response.status, statusText: response.statusText });
    }

    const body = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) => new NetworkError({ url, cause: describeCause(cause) }),
    });

    return yield* Effect.try({
      try: () => (body ? (JSON.parse(body) as A) : ({} as A)),
      catch: (cause) => new DecodeError({ url, reason: String(cause) }),
    });
  }).pipe(
    Effect.timeoutFail({
      duration: timeout,
      onTimeout: () => new TimeoutError({ url, millis: Duration.toMillis(timeout) }),
    }),
  );

/**
 * Prepares a picked file so the multipart body can actually be built.
 *
 * Expo replaces the global fetch with its own, and that one assembles the
 * multipart body in JavaScript. It rejects React Native's {uri, name, type}
 * part outright: it only accepts a string, a Blob, or an object able to hand
 * over its own bytes. An expo-file-system File is the third kind.
 *
 * The picked file lives in the cache under a generated name, and that name is
 * what would end up in the Content-Disposition header and then on the PC. So it
 * is copied under its real name first, and the copy is what gets uploaded.
 */
const stageForUpload = (file: { uri: string; name: string }): Effect.Effect<File, FileError> =>
  Effect.try({
    try: () => {
      const staging = new Directory(Paths.cache, 'herdr-allegati');
      staging.create({ intermediates: true, idempotent: true });

      const target = new File(staging, file.name);
      if (target.exists) target.delete();
      new File(file.uri).copySync(target);
      return target;
    },
    catch: (cause) => new FileError({ name: file.name, reason: describeCause(cause) }),
  });

/**
 * Removes the staged copy once the upload has ended either way. The picked
 * file stays: the composer shows it as a thumbnail until the message is sent
 * or the attachment removed, and discards it then. Failing to delete leaves a
 * stale file in the cache, nothing worse, so it is not reported.
 */
const discardStaged = (staged: File): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      if (staged.exists) staged.delete();
    } catch {
      // See above.
    }
  });

/** The header the bridge reads the shared token from. */
const TOKEN_HEADER = 'X-Herdr-Token';

export function createApi(baseUrl: string, token = '') {
  /**
   * Sent with every request, and handed to whatever else fetches from the
   * bridge outside this client: images and downloads.
   */
  const headers: Record<string, string> = token ? { [TOKEN_HEADER]: token } : {};

  const get = <A>(path: string) => request<A>(`${baseUrl}${path}`, { headers }, DEFAULT_TIMEOUT);

  const post = <A>(path: string, body?: unknown) =>
    request<A>(
      `${baseUrl}${path}`,
      {
        method: 'POST',
        headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      DEFAULT_TIMEOUT,
    );

  const pane = (paneId: string) => encodeURIComponent(paneId);

  /** A file the transcript names, resolved by the bridge in the pane's working directory. */
  const fileQuery = (paneId: string, workspaceId: string, path: string) =>
    `path=${encodeURIComponent(path)}&pane_id=${pane(paneId)}&workspace_id=${encodeURIComponent(workspaceId)}`;

  return {
    baseUrl,
    headers,

    status: () => get<{ status: string; herdr_alive: boolean; local_ip: string }>('/api/status'),

    /** The build published last on the PC. 404 until the first release. */
    latestRelease: () => get<Release>('/api/app/latest'),

    /** 404 when the path points at nothing, which for a path found in output is the usual case. */
    fileMeta: (paneId: string, workspaceId: string, path: string) =>
      get<SessionFile>(`/api/files/meta?${fileQuery(paneId, workspaceId, path)}`),

    fileUrl: (paneId: string, workspaceId: string, path: string) =>
      `${baseUrl}/api/files?${fileQuery(paneId, workspaceId, path)}`,

    /** A reduced copy; `version` changes when the file does, so the image cache lets go of the old one. */
    thumbUrl: (paneId: string, workspaceId: string, path: string, width: number, version: number) =>
      `${baseUrl}/api/files/thumb?${fileQuery(paneId, workspaceId, path)}&w=${width}&v=${version}`,

    /** Everything Herdr still holds for the pane: its scrollback is a thousand lines. */
    readPane: (paneId: string, lines = 1000) =>
      get<{ text?: string }>(`/api/panes/${pane(paneId)}/read?lines=${lines}`),

    /** The conversation behind an agent pane, from its transcript; `after` skips turns already held. 404 for a plain shell. */
    history: (paneId: string, after = 0) =>
      get<HistoryPage>(`/api/panes/${pane(paneId)}/history?after=${after}`),

    focusPane: (paneId: string) => post<unknown>(`/api/panes/${pane(paneId)}/focus`),

    splitPane: (paneId: string, direction: 'right' | 'down') =>
      post<{ pane?: { pane_id?: string } }>(`/api/panes/${pane(paneId)}/split`, { direction }),

    closePane: (paneId: string) => post<unknown>(`/api/panes/${pane(paneId)}/close`),

    zoomPane: (paneId: string) => post<unknown>(`/api/panes/${pane(paneId)}/zoom`),

    interruptPane: (paneId: string) => post<unknown>(`/api/panes/${pane(paneId)}/interrupt`),

    sendText: (paneId: string, text: string) =>
      post<unknown>(`/api/panes/${pane(paneId)}/send-text`, { text }),

    sendKeys: (paneId: string, keys: string[]) =>
      post<unknown>(`/api/panes/${pane(paneId)}/send-keys`, { keys }),

    createWorkspace: (label: string, cwd?: string) =>
      post<unknown>('/api/workspaces', cwd ? { label, cwd, focus: true } : { label, focus: true }),

    focusWorkspace: (workspaceId: string) =>
      post<unknown>(`/api/workspaces/${encodeURIComponent(workspaceId)}/focus`),

    createTab: (workspaceId: string) =>
      post<{ tab?: { tab_id?: string }; root_pane?: { pane_id?: string } }>('/api/tabs', {
        workspace_id: workspaceId,
        focus: true,
      }),

    focusTab: (tabId: string) => post<unknown>(`/api/tabs/${encodeURIComponent(tabId)}/focus`),

    closeTab: (tabId: string) => post<unknown>(`/api/tabs/${encodeURIComponent(tabId)}/close`),

    upload: (
      file: { uri: string; name: string; mimeType?: string },
      workspaceId: string | null,
      paneId: string | null,
    ): Effect.Effect<UploadResult, UploadError> =>
      Effect.gen(function* () {
        const staged = yield* stageForUpload(file);

        const form = new FormData();
        form.append('file', staged as unknown as Blob);
        // The multipart filename is percent-encoded on the way out, so the real
        // name travels as its own field and the bridge saves under that one.
        form.append('filename', file.name);
        if (workspaceId) form.append('workspace_id', workspaceId);
        // The pane decides the directory: its working directory is what the agent
        // resolves the returned reference against.
        if (paneId) form.append('pane_id', paneId);

        return yield* request<UploadResult>(
          `${baseUrl}/api/upload`,
          { method: 'POST', body: form, headers: { ...headers, Accept: 'application/json' } },
          UPLOAD_TIMEOUT,
        ).pipe(Effect.ensuring(discardStaged(staged)));
      }),
  };
}

export type HerdrApi = ReturnType<typeof createApi>;
