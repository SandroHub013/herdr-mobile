import React, { useMemo } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { colors, radius, space, type } from '../theme';
import { HerdrApi } from '../api';
import { findFileReferences, segmentLinks, TextSegment } from '../ansi';
import { beforeScreen, describeTools, groupTools, HistoryTurn, replyBlocks } from '../history';
import { useSessionHistory } from '../hooks/useSessionHistory';
import { Pane } from '../types';
import { SessionFiles } from './SessionFiles';
import { Divider, TextButton } from './Primitives';

/**
 * The conversation before the live screen, above it in the same scroll.
 *
 * Closed by default: one quiet line offers it. Open, it shows the reader's
 * messages on the right and the agent's replies as prose, with the files
 * either side named as thumbnails and cards, and ends where the screen takes
 * over. It grows as the session does.
 */
export function SessionHistory({
  api,
  pane,
  screenText,
  onOpenLink,
  notify,
}: {
  api: HerdrApi;
  pane: Pane;
  screenText: string;
  onOpenLink: (url: string) => void;
  notify: (message: string) => void;
}) {
  const history = useSessionHistory(api, pane.pane_id);
  const visible = useMemo(() => beforeScreen(history.turns, screenText), [history.turns, screenText]);
  const blocks = useMemo(() => groupTools(visible), [visible]);

  if (history.status === 'idle') {
    return (
      <View style={styles.offer}>
        <TextButton label="Carica la cronologia della sessione" onPress={history.load} />
      </View>
    );
  }
  if (history.status === 'loading') {
    return (
      <View style={styles.offer}>
        <ActivityIndicator size="small" color={colors.textMuted} />
      </View>
    );
  }
  if (history.status === 'missing') {
    return <Text style={styles.note}>Nessuna trascrizione per questa finestra.</Text>;
  }
  if (history.status === 'failed') {
    return (
      <View style={styles.offer}>
        <Text style={styles.note}>Cronologia non caricata.</Text>
        <TextButton label="Riprova" onPress={history.load} />
      </View>
    );
  }

  return (
    <View>
      {history.match === 'cwd' ? (
        <Text style={styles.note}>La trascrizione più recente di questa cartella.</Text>
      ) : null}
      {blocks.map((block) =>
        block.kind === 'tools' ? (
          <Text key={`tools-${block.seq}`} style={styles.tools} numberOfLines={2}>
            {describeTools(block.lines)}
          </Text>
        ) : block.turn.role === 'user' ? (
          <UserTurn key={block.turn.seq} api={api} pane={pane} turn={block.turn} onOpenLink={onOpenLink} notify={notify} />
        ) : (
          <AssistantTurn key={block.turn.seq} api={api} pane={pane} turn={block.turn} onOpenLink={onOpenLink} notify={notify} />
        ),
      )}
      <View style={styles.seam}>
        <View style={styles.seamRule}>
          <Divider />
        </View>
        <Text style={styles.seamLabel}>SCHERMO</Text>
        <View style={styles.seamRule}>
          <Divider />
        </View>
      </View>
    </View>
  );
}

function renderSegments(segments: TextSegment[], onOpenLink: (url: string) => void) {
  return segments.map((segment, position) =>
    segment.url ? (
      <Text key={position} style={styles.link} onPress={() => onOpenLink(segment.url as string)}>
        {segment.text}
      </Text>
    ) : (
      segment.text
    ),
  );
}

function UserTurn({
  api,
  pane,
  turn,
  onOpenLink,
  notify,
}: {
  api: HerdrApi;
  pane: Pane;
  turn: HistoryTurn;
  onOpenLink: (url: string) => void;
  notify: (message: string) => void;
}) {
  const files = useMemo(() => findFileReferences(turn.text, true), [turn.text]);
  const text = useMemo(
    () =>
      turn.text
        .split(/\s+/)
        .filter((word) => !files.includes(word.replace(/[.,:;!?]+$/, '')))
        .join(' ')
        .trim(),
    [turn.text, files],
  );
  return (
    <View>
      {files.length > 0 ? (
        <SessionFiles api={api} paneId={pane.pane_id} workspaceId={pane.workspace_id} paths={files} align="right" notify={notify} />
      ) : null}
      {turn.images ? (
        <Text style={styles.imagesNote}>{turn.images === 1 ? "Un'immagine allegata" : `${turn.images} immagini allegate`}</Text>
      ) : null}
      {text ? (
        <View style={styles.userRow}>
          <View style={styles.userBubble}>
            <Text selectable style={styles.userText}>
              {renderSegments(segmentLinks(text), onOpenLink)}
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function AssistantTurn({
  api,
  pane,
  turn,
  onOpenLink,
  notify,
}: {
  api: HerdrApi;
  pane: Pane;
  turn: HistoryTurn;
  onOpenLink: (url: string) => void;
  notify: (message: string) => void;
}) {
  const blocks = useMemo(() => replyBlocks(turn.text), [turn.text]);
  const files = useMemo(() => findFileReferences(turn.text), [turn.text]);
  return (
    <View style={styles.reply}>
      {blocks.map((block, index) =>
        block.kind === 'code' ? (
          <View key={index} style={styles.code}>
            <Text selectable style={styles.codeText}>
              {block.text}
            </Text>
          </View>
        ) : (
          <Text key={index} selectable style={styles.prose}>
            {renderSegments(segmentLinks(block.text), onOpenLink)}
          </Text>
        ),
      )}
      {files.length > 0 ? (
        <SessionFiles api={api} paneId={pane.pane_id} workspaceId={pane.workspace_id} paths={files} align="left" notify={notify} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  offer: {
    alignItems: 'center',
    paddingVertical: space.sm,
    gap: space.xs,
  },
  note: {
    ...type.caption,
    fontWeight: '400',
    color: colors.textFaint,
    textAlign: 'center',
    paddingVertical: space.sm,
  },
  tools: {
    ...type.meta,
    color: colors.textFaint,
    marginVertical: space.xs,
  },
  reply: {
    gap: space.sm,
    marginVertical: space.xs,
  },
  prose: {
    ...type.prose,
    color: colors.text,
  },
  code: {
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  codeText: {
    ...type.output,
    color: colors.terminalText,
  },
  link: {
    color: colors.link,
    textDecorationLine: 'underline',
  },
  userRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: space.sm,
    marginBottom: space.md,
  },
  userBubble: {
    maxWidth: '88%',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceRaised,
  },
  userText: {
    ...type.prose,
    color: colors.text,
  },
  imagesNote: {
    ...type.caption,
    fontWeight: '400',
    color: colors.textFaint,
    textAlign: 'right',
    marginTop: space.xs,
  },
  seam: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.md,
    marginBottom: space.md,
  },
  seamRule: {
    flex: 1,
  },
  seamLabel: {
    ...type.section,
    color: colors.textFaint,
  },
});
