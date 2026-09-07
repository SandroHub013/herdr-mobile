import { Effect } from 'effect';
import { File, Paths } from 'expo-file-system';
import { StorageError } from './errors';

/**
 * Connection settings survive a restart. Typing an IP address on a phone once
 * per session is exactly the kind of friction that makes a remote control
 * useless from the sofa.
 */

export interface ConnectionSettings {
  host: string;
  port: string;
}

export const DEFAULT_SETTINGS: ConnectionSettings = {
  host: '192.168.1.10',
  port: '43737',
};

const FILE_NAME = 'herdr-connection.json';

const settingsFile = () => new File(Paths.document, FILE_NAME);

const sanitise = (parsed: Partial<ConnectionSettings>): ConnectionSettings => ({
  host: typeof parsed.host === 'string' && parsed.host.trim() ? parsed.host.trim() : DEFAULT_SETTINGS.host,
  port: typeof parsed.port === 'string' && parsed.port.trim() ? parsed.port.trim() : DEFAULT_SETTINGS.port,
});

export const readSettings: Effect.Effect<ConnectionSettings, StorageError> = Effect.try({
  try: () => {
    const file = settingsFile();
    if (!file.exists) return DEFAULT_SETTINGS;
    return sanitise(JSON.parse(file.textSync()) as Partial<ConnectionSettings>);
  },
  catch: () => new StorageError({ operation: 'read' }),
});

/** Reading is best effort: a missing or corrupt file just means the defaults. */
export const loadSettings: Effect.Effect<ConnectionSettings> = readSettings.pipe(
  Effect.orElseSucceed(() => DEFAULT_SETTINGS),
);

export const writeSettings = (settings: ConnectionSettings): Effect.Effect<void, StorageError> =>
  Effect.try({
    try: () => {
      const file = settingsFile();
      if (!file.exists) file.create();
      file.write(JSON.stringify(settings));
    },
    catch: () => new StorageError({ operation: 'write' }),
  });

/** Persisting is a convenience; the session still works without it. */
export const saveSettings = (settings: ConnectionSettings): Effect.Effect<void> =>
  writeSettings(settings).pipe(Effect.ignore);
