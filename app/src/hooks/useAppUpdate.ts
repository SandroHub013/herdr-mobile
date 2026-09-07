import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { Effect, Either } from 'effect';
import { File } from 'expo-file-system';
import { HerdrApi } from '../api';
import { describeError } from '../errors';
import {
  downloadApk,
  firstRunAfterUpdate,
  installApk,
  installedVersion,
  isNewer,
  pickApk,
  Release,
  ReleaseApk,
} from '../updates';

/** How long a check stays fresh. Releases are not that frequent. */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

export type UpdateState =
  | { readonly status: 'idle' }
  | { readonly status: 'available'; readonly release: Release; readonly apk: ReleaseApk }
  | { readonly status: 'downloading'; readonly release: Release; readonly apk: ReleaseApk; readonly progress: number }
  | { readonly status: 'ready'; readonly release: Release; readonly apk: ReleaseApk; readonly file: File }
  | { readonly status: 'failed'; readonly release: Release; readonly apk: ReleaseApk; readonly message: string };

/** What the last look at the bridge found, whoever asked for it. */
export type LastCheck =
  | { readonly status: 'checking' }
  | { readonly status: 'latest'; readonly at: number }
  | { readonly status: 'newer'; readonly at: number; readonly release: Release }
  | { readonly status: 'unreachable'; readonly at: number };

/**
 * Watches the bridge for a newer build and drives the download and install.
 *
 * A check runs when the connection comes up and when the app returns to the
 * foreground, at most once an hour; the connection dialog can ask for one at
 * any time. Nothing is downloaded until the user asks: the package is tens of
 * megabytes and the phone may be on mobile data.
 */
export function useAppUpdate(api: HerdrApi, connected: boolean, notify: (message: string) => void) {
  const [state, setState] = useState<UpdateState>({ status: 'idle' });
  const [lastCheck, setLastCheck] = useState<LastCheck | null>(null);
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
      // Asking by hand also forgives a dismissal: it means "show me again".
      if (force) dismissedRef.current = null;
      setLastCheck({ status: 'checking' });

      // An unreachable bridge is not news for the banner, which simply stays
      // away; the dialog row is the place that says so.
      void Effect.runPromise(Effect.either(api.latestRelease())).then((result) => {
        const at = Date.now();
        if (Either.isLeft(result)) {
          setLastCheck({ status: 'unreachable', at });
          return;
        }
        const release = result.right;
        const apk = pickApk(release);
        if (!isNewer(release) || !apk) {
          setLastCheck({ status: 'latest', at });
          return;
        }
        setLastCheck({ status: 'newer', at, release });
        if (dismissedRef.current === release.versionCode) return;
        setState((previous) =>
          previous.status !== 'idle' && previous.release.versionCode === release.versionCode
            ? previous
            : { status: 'available', release, apk },
        );
      });
    },
    [api],
  );

  const checkNow = useCallback(() => check(true), [check]);

  useEffect(() => {
    if (connected) check();
  }, [connected, check]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active' && connected) check();
    });
    return () => subscription.remove();
  }, [connected, check]);

  // The first start after an update says so. Nothing else on screen tells
  // the user that the install they confirmed actually went through.
  const announcedRef = useRef(false);
  useEffect(() => {
    if (announcedRef.current) return;
    announcedRef.current = true;
    void Effect.runPromise(firstRunAfterUpdate).then((updated) => {
      if (updated) notify(`Aggiornata alla versione ${installedVersion()}`);
    });
  }, [notify]);

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

  return { state, lastCheck, update, dismiss, checkNow };
}
