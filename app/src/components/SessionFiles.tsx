import React, { useCallback, useState } from 'react';
import { Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Effect, Either } from 'effect';
import { colors, radius, space, type } from '../theme';
import { IconClose } from '../icons';
import { HerdrApi } from '../api';
import { describeError } from '../errors';
import { downloadFile, extensionLabel, openFile, SessionFile, shareFile } from '../files';
import { formatSize } from '../updates';
import { useSessionFile } from '../hooks/useSessionFile';
import { IconButton, TextButton } from './Primitives';

const THUMB_SIZE = 116;
const THUMB_PIXELS = 512;

/**
 * The files a line of the transcript names, once the bridge confirms they
 * exist: images as thumbnails that open full screen, everything else as a
 * card that downloads and opens on tap. A path that resolves to nothing
 * takes no space at all.
 */
export function SessionFiles({
  api,
  paneId,
  workspaceId,
  paths,
  align,
  notify,
}: {
  api: HerdrApi;
  paneId: string;
  workspaceId: string;
  paths: string[];
  align: 'left' | 'right';
  notify: (message: string) => void;
}) {
  return (
    <View style={[styles.row, align === 'right' && styles.rowRight]}>
      {paths.map((path) => (
        <SessionFileItem key={path} api={api} paneId={paneId} workspaceId={workspaceId} path={path} notify={notify} />
      ))}
    </View>
  );
}

function SessionFileItem({
  api,
  paneId,
  workspaceId,
  path,
  notify,
}: {
  api: HerdrApi;
  paneId: string;
  workspaceId: string;
  path: string;
  notify: (message: string) => void;
}) {
  const file = useSessionFile(api, paneId, workspaceId, path);
  if (!file) return null;
  return file.kind === 'image' ? (
    <ImageTile api={api} paneId={paneId} workspaceId={workspaceId} file={file} notify={notify} />
  ) : (
    <FileCard api={api} paneId={paneId} workspaceId={workspaceId} file={file} notify={notify} />
  );
}

function ImageTile({
  api,
  paneId,
  workspaceId,
  file,
  notify,
}: {
  api: HerdrApi;
  paneId: string;
  workspaceId: string;
  file: SessionFile;
  notify: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const thumb = api.thumbUrl(paneId, workspaceId, file.path, THUMB_PIXELS, file.mtime);
  const full = api.fileUrl(paneId, workspaceId, file.path);

  return (
    <>
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={`Apri l'immagine ${file.name}`}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
      >
        <Image source={{ uri: thumb, headers: api.headers }} style={styles.thumb} resizeMode="cover" />
      </Pressable>
      {open ? (
        <ImageViewer file={file} uri={full} headers={api.headers} onClose={() => setOpen(false)} notify={notify} />
      ) : null}
    </>
  );
}

/** The image on its own, over black, with a way to send it elsewhere. */
function ImageViewer({
  file,
  uri,
  headers,
  onClose,
  notify,
}: {
  file: SessionFile;
  uri: string;
  headers: Record<string, string>;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);

  const share = useCallback(() => {
    if (busy) return;
    setBusy(true);
    const flow = downloadFile(uri, file.name, file.size, () => undefined, headers).pipe(
      Effect.flatMap((saved) => shareFile(saved, file.mime)),
    );
    void Effect.runPromise(Effect.either(flow)).then((result) => {
      setBusy(false);
      if (Either.isLeft(result)) notify(describeError(result.left));
    });
  }, [busy, file, headers, notify, uri]);

  return (
    <Modal visible animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
      <View style={styles.viewer}>
        <Image source={{ uri, headers }} style={styles.viewerImage} resizeMode="contain" />
        <View style={[styles.viewerBar, { paddingTop: insets.top + space.xs }]}>
          <IconButton accessibilityLabel="Chiudi l'immagine" onPress={onClose}>
            <IconClose size={16} color={colors.text} />
          </IconButton>
          <Text numberOfLines={1} style={styles.viewerName}>
            {file.name}
          </Text>
          <TextButton label={busy ? 'Un momento' : 'Condividi'} onPress={share} />
        </View>
      </View>
    </Modal>
  );
}

function FileCard({
  api,
  paneId,
  workspaceId,
  file,
  notify,
}: {
  api: HerdrApi;
  paneId: string;
  workspaceId: string;
  file: SessionFile;
  notify: (message: string) => void;
}) {
  const [progress, setProgress] = useState<number | null>(null);
  const url = api.fileUrl(paneId, workspaceId, file.path);

  const receive = useCallback(() => {
    if (progress !== null) return;
    setProgress(0);
    const flow = downloadFile(url, file.name, file.size, setProgress, api.headers).pipe(
      Effect.flatMap((saved) => openFile(saved, file.mime)),
    );
    void Effect.runPromise(Effect.either(flow)).then((result) => {
      setProgress(null);
      if (Either.isLeft(result)) notify(describeError(result.left));
    });
  }, [api.headers, file, notify, progress, url]);

  const percent = progress === null ? null : Math.round(progress * 100);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Scarica ${file.name}`}
      accessibilityState={{ busy: progress !== null }}
      onPress={receive}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <View style={styles.badge}>
        <Text style={styles.badgeText}>{extensionLabel(file.name)}</Text>
      </View>
      <Text numberOfLines={2} style={styles.cardName}>
        {file.name}
      </Text>
      <Text style={styles.cardSize}>{percent === null ? formatSize(file.size) : `Scaricamento, ${percent}%`}</Text>
      {percent !== null ? (
        <View style={styles.track} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: percent }}>
          <View style={[styles.fill, { width: `${percent}%` }]} />
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    marginTop: space.xs,
    marginBottom: space.md,
  },
  rowRight: {
    justifyContent: 'flex-end',
  },
  pressed: {
    opacity: 0.8,
  },
  tile: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: colors.surfaceRaised,
  },
  thumb: {
    width: '100%',
    height: '100%',
  },
  card: {
    width: 168,
    padding: space.md,
    gap: 6,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 6,
  },
  badgeText: {
    ...type.section,
    color: colors.textMuted,
  },
  cardName: {
    ...type.label,
    color: colors.text,
  },
  cardSize: {
    ...type.caption,
    fontWeight: '400',
    color: colors.textFaint,
  },
  track: {
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.surfaceActive,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    backgroundColor: colors.accent,
  },
  viewer: {
    flex: 1,
    backgroundColor: '#000000',
  },
  viewerImage: {
    flex: 1,
  },
  viewerBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.sm,
    paddingBottom: space.sm,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
  },
  viewerName: {
    ...type.label,
    color: colors.text,
    flex: 1,
  },
});
