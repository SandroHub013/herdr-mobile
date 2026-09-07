import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { Effect, Either } from 'effect';
import { File } from 'expo-file-system';
import { HerdrApi } from '../api';
import { describeError } from '../errors';
import { downloadApk, installApk, isNewer, pickApk, Release, ReleaseApk } from '../updates';

/** How long a check stays fresh. Releases are not that frequent. */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

export type UpdateState =
  | { readonly status: 'idle' }
  | { readonly status: 'available'; readonly release: Release; readonly apk: ReleaseApk }
  | { readonly status: 'downloading'; readonly release: Release; readonly apk: ReleaseApk; readonly progress: number }
  | { readonly status: 'ready'; readonly release: Release; readonly apk: ReleaseApk; readonly file: File }
  | { readonly status: 'failed'; readonly release: Release; readonly apk: ReleaseApk; readonly message: string };

/**
 * Watches the bridge for a newer build and drives the download and install.
 *
 * A check runs when the connection comes up and when the app returns to the
 * foreground, at most once an hour. Nothing is downloaded until the user asks:
 * the package is tens of megabytes and the phone may be on mobile data.
 */
export function useAppUpdate(api: HerdrApi, connected: boolean, notify: (message: string) => void) {
  const [state, setState] = useState<UpdateState>({ status: 'idle' });
  const lastCheckRef = useRef(0);
  const dismissedRef = useRef<number | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const check = useCallback(
    (force = false) => {
      const now = Date.now();
      if (!force && now - lastCheckRef.current < CHECK_INTERVAL_MS) return;
      // A download in flight is not interrupted by a routine check.
      if (stateRef.current.status === 'downloading') return;
      lastCheckRef.current = now;

      // A missing or unreachable release is not news: the banner simply stays away.
      void Effect.runPromise(Effect.either(api.latestRelease())).then((result) => {
        if (Either.isLeft(result)) return;
        const release = result.right;
        if (!isNewer(release) || dismissedRef.current === release.versionCode) return;
        const apk = pickApk(release);
        if (!apk) return;
        setState((previous) =>
          previous.status !== 'idle' && previous.release.versionCode === release.versionCode
            ? previous
            : { status: 'available', release, apk },
        );
      });
    },
    [api],
  );

  useEffect(() => {
    if (connected) check();
  }, [connected, check]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active' && connected) check();
    });
    return () => subscription.remove();
  }, [connected, check]);

  const update = useCallback(() => {
    const current = stateRef.current;
    if (current.status === 'idle' || current.status === 'downloading') return;
    const { release, apk } = current;

    // Already on disk and verified: only the installer needs opening again.
    if (current.status === 'ready') {
      void Effect.runPromise(Effect.either(installApk(current.file))).then((result) => {
        if (Either.isLeft(result)) notify(describeError(result.left));
      });
      return;
    }

    setState({ status: 'downloading', release, apk, progress: 0 });
    const url = apk.url.startsWith('/') ? `${api.baseUrl}${apk.url}` : apk.url;

    const flow = Effect.gen(function* () {
      const file = yield* downloadApk(url, apk, (progress) =>
        setState((previous) => (previous.status === 'downloading' ? { ...previous, progress } : previous)),
      );
      setState({ status: 'ready', release, apk, file });
      yield* installApk(file);
    });

    void Effect.runPromise(Effect.either(flow)).then((result) => {
      if (Either.isLeft(result)) {
        const message = describeError(result.left);
        setState((previous) =>
          previous.status === 'ready' ? previous : { status: 'failed', release, apk, message },
        );
        notify(message);
      }
    });
  }, [api.baseUrl, notify]);

  const dismiss = useCallback(() => {
    const current = stateRef.current;
    if (current.status === 'idle') return;
    dismissedRef.current = current.release.versionCode;
    setState({ status: 'idle' });
  }, []);

  return { state, update, dismiss, check };
}
