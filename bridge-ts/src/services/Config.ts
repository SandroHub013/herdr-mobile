import crypto from 'node:crypto';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context, Layer } from 'effect';

/**
 * What the bridge was started with, and the token that guards it.
 *
 * Whoever reaches this port can type into every terminal on the PC, so the
 * network alone is not enough of a lock: every client presents a shared token.
 * It is created on first start and kept outside any repository; the app asks
 * for it once, in the connection panel.
 */

export const PORT = 43737;
export const TOKEN_HEADER = 'x-herdr-token';

const KEYS_DIR =
  process.env.HERDR_MOBILE_KEYS || path.join(os.homedir(), '.herdr-mobile');
const TOKEN_FILE = path.join(KEYS_DIR, 'bridge.token');

/**
 * Reachable without the token: the web shell and the release packages, which
 * are public on GitHub anyway. A phone running a build older than the token
 * still sees the update that would bring it up to date.
 */
const PUBLIC_PATHS = new Set(['/', '/api/app/latest', '/download/apk']);
const PUBLIC_PREFIXES = ['/static/', '/app/'];

export const isPublicPath = (pathname: string): boolean =>
  PUBLIC_PATHS.has(pathname) || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));

function loadToken(): string {
  const fromEnv = (process.env.HERDR_BRIDGE_TOKEN ?? '').trim();
  if (fromEnv) return fromEnv;
  try {
    const saved = fsSync.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (saved) return saved;
  } catch {
    // No token yet: the next lines make one.
  }
  const token = crypto.randomBytes(24).toString('base64url');
  fsSync.mkdirSync(KEYS_DIR, { recursive: true });
  fsSync.writeFileSync(TOKEN_FILE, token + '\n', 'utf8');
  return token;
}

/** Constant-time, so a wrong token cannot be found one character at a time. */
const sameToken = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

export class BridgeConfig extends Context.Tag('BridgeConfig')<
  BridgeConfig,
  {
    readonly token: string;
    readonly tokenFile: string;
    readonly host: string;
    readonly port: number;
    readonly socketPath: string;
    readonly accepts: (candidate: string | undefined) => boolean;
  }
>() {}

export const layer = (options: {
  readonly host: string;
  readonly port?: number;
  readonly socketPath: string;
}): Layer.Layer<BridgeConfig> =>
  Layer.sync(BridgeConfig, () => {
    const token = loadToken();
    return {
      token,
      tokenFile: TOKEN_FILE,
      host: options.host,
      port: options.port ?? PORT,
      socketPath: options.socketPath,
      accepts: (candidate) => !!candidate && sameToken(candidate, token),
    };
  });

export const DEFAULT_SOCKET_PATH = path.join(
  process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
  'herdr',
  'herdr.sock',
);
