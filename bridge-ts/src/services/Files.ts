import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Context, Effect, Layer } from 'effect';
import { Snapshots } from './Snapshot.ts';

/**
 * The files a conversation points at.
 *
 * An agent's replies are full of paths — what it read, what it wrote, the
 * screenshot it just made — and every one of them should be something the
 * reader can open on the phone. This turns a path as it appears in a
 * transcript into a file on this PC, or refuses.
 */

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.svg']);
const VIDEO = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi']);
const AUDIO = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.flac']);
const TEXT = new Set([
  '.txt', '.md', '.markdown', '.log', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml',
  '.toml', '.ini', '.cfg', '.env', '.xml', '.html', '.css', '.scss', '.sql', '.diff', '.patch',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java', '.kt', '.rb',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.swift', '.sh', '.ps1', '.bat', '.gradle', '.properties',
]);

/**
 * Node has no mime table of its own and Windows' registry does not know every
 * kind the phone cares about, so the table is here. It has to cover the
 * ordinary types too: the app picks its viewer from what this says, and a
 * screenshot announced as application/octet-stream is offered as a download
 * instead of being shown.
 */
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.apk': 'application/vnd.android.package-archive',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.xml': 'application/xml',
  '.diff': 'text/x-diff',
  '.patch': 'text/x-diff',
};

/** Source and config files: shown as text, whatever their extension claims. */
const TEXT_MIME = 'text/plain; charset=utf-8';

/** How the app should offer the file: it decides the viewer from this alone. */
export type FileKind = 'image' | 'video' | 'audio' | 'text' | 'pdf' | 'file';

export interface FileInfo {
  readonly path: string;
  readonly name: string;
  readonly size: number;
  readonly mtime: number;
  readonly mime: string;
  readonly kind: FileKind;
}

const classify = (ext: string): FileKind => {
  if (IMAGE.has(ext)) return 'image';
  if (VIDEO.has(ext)) return 'video';
  if (AUDIO.has(ext)) return 'audio';
  if (ext === '.pdf') return 'pdf';
  if (TEXT.has(ext)) return 'text';
  return 'file';
};

export class Files extends Context.Tag('Files')<
  Files,
  {
    /** The file a path points at, or null when it is not there or not ours to serve. */
    readonly resolve: (
      raw: string,
      workspaceId: string | undefined,
      paneId: string | undefined,
    ) => Effect.Effect<string | null>;
    readonly describe: (full: string) => Effect.Effect<FileInfo | null>;
    /** Where an upload for this pane belongs, and the reference the agent will understand. */
    readonly uploadDir: (
      workspaceId: string | undefined,
      paneId: string | undefined,
    ) => Effect.Effect<string | null>;
  }
>() {}

export const layer: Layer.Layer<Files, never, Snapshots> = Layer.effect(
  Files,
  Effect.gen(function* () {
    const snapshots = yield* Snapshots;

    /**
     * Directories a file may be served from: the user's own profile and every
     * directory a pane is working in.
     *
     * The phone can already type any command into any terminal, so this is not
     * a boundary against the phone. It keeps a stray path in some output from
     * turning the bridge into a file server for the whole disk.
     */
    const servedRoots = Effect.gen(function* () {
      const snapshot = yield* snapshots.current;
      const roots = [os.homedir()];
      for (const pane of snapshot.panes) {
        const cwd = (pane as { cwd?: unknown }).cwd;
        if (typeof cwd === 'string' && cwd) roots.push(cwd);
      }
      return roots.map((root) => path.resolve(root).replace(/[\\/]+$/, '').toLowerCase());
    });

    /**
     * The directory an upload should land in and a relative path resolve
     * against. The pane being written to wins: panes in one workspace can sit
     * in different directories, and dropping the file next to the wrong one
     * hands the agent a reference pointing at nothing.
     */
    const contextCwd = (workspaceId: string | undefined, paneId: string | undefined) =>
      Effect.gen(function* () {
        const snapshot = yield* snapshots.current;
        const panes = snapshot.panes as ReadonlyArray<Record<string, unknown>>;
        if (paneId) {
          const exact = panes.find((p) => p.pane_id === paneId && p.cwd);
          if (exact) return String(exact.cwd);
        }
        if (workspaceId) {
          const inWorkspace = panes.find((p) => p.workspace_id === workspaceId && p.cwd);
          if (inWorkspace) return String(inWorkspace.cwd);
        }
        return null;
      });

    const resolve = (
      raw: string,
      workspaceId: string | undefined,
      paneId: string | undefined,
    ): Effect.Effect<string | null> =>
      Effect.gen(function* () {
        let candidate = raw.trim().replace(/^["']|["']$/g, '');
        // "@uploads/photo.jpg" is how the app hands a file to an agent; the
        // agent resolves it from its own directory, so this does the same.
        if (candidate.startsWith('@')) candidate = candidate.slice(1);
        if (candidate.startsWith('~')) candidate = path.join(os.homedir(), candidate.slice(1));
        if (!candidate) return null;

        if (!path.isAbsolute(candidate)) {
          const cwd = yield* contextCwd(workspaceId, paneId);
          if (!cwd) return null;
          candidate = path.join(cwd, candidate);
        }
        const full = path.resolve(candidate);

        const isFile = yield* Effect.tryPromise(() => fs.stat(full)).pipe(
          Effect.map((stat) => stat.isFile()),
          Effect.orElseSucceed(() => false),
        );
        if (!isFile) return null;

        const roots = yield* servedRoots;
        const check = full.toLowerCase();
        return roots.some((root) => check.startsWith(root + path.sep) || check === root)
          ? full
          : null;
      });

    return {
      resolve,
      uploadDir: (workspaceId, paneId) =>
        contextCwd(workspaceId, paneId).pipe(
          Effect.map((cwd) => (cwd ? path.join(cwd, 'uploads') : null)),
        ),
      describe: (full) =>
        Effect.tryPromise(async () => {
          const stat = await fs.stat(full);
          const ext = path.extname(full).toLowerCase();
          const kind = classify(ext);
          return {
            path: full,
            name: path.basename(full),
            size: stat.size,
            mtime: Math.floor(stat.mtimeMs / 1000),
            mime: MIME[ext] ?? (kind === 'text' ? TEXT_MIME : 'application/octet-stream'),
            kind,
          } satisfies FileInfo;
        }).pipe(Effect.orElseSucceed(() => null)),
    };
  }),
);
