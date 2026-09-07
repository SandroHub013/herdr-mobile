import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Linking,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextStyle,
  View,
} from 'react-native';
import { colors, radius, space, type } from '../theme';
import { IconChevron, IconClose, IconExpand, StatusDot } from '../icons';
import { EmptyState, IconButton } from './Primitives';
import { LineKind, OutputLine, segmentOutput } from '../ansi';
import { isBusy, Pane, paneTitle } from '../types';

const BOTTOM_THRESHOLD_PX = 48;

function openUrl(url: string) {
  Linking.openURL(url).catch(() => undefined);
}

export function TerminalPane({
  pane,
  index,
  text,
  focused,
  showControls,
  wrap,
  onToggleWrap,
  onFocus,
  onZoom,
  onClose,
}: {
  pane: Pane;
  index: number;
  text: string;
  focused: boolean;
  showControls: boolean;
  wrap: boolean;
  onToggleWrap: () => void;
  onFocus: () => void;
  onZoom: () => void;
  onClose: () => void;
}) {
  const scrollRef = useRef<ScrollView | null>(null);
  const pinnedToBottomRef = useRef(true);
  const [showJumpButton, setShowJumpButton] = useState(false);

  /**
   * Herdr resends the whole recent buffer on every update, so applying it while
   * the reader is scrolled up moves the ground under them: the content is
   * replaced, the offset no longer points at the same line, and the view lands
   * at the end. Hold the last rendering until they are back at the bottom.
   */
  const [displayedText, setDisplayedText] = useState(text);
  const latestTextRef = useRef(text);
  const displayedRef = useRef(text);
  latestTextRef.current = text;
  displayedRef.current = displayedText;

  const applyPendingOutput = useCallback(() => {
    if (displayedRef.current !== latestTextRef.current) {
      displayedRef.current = latestTextRef.current;
      setDisplayedText(latestTextRef.current);
    }
  }, []);

  useEffect(() => {
    if (pinnedToBottomRef.current) applyPendingOutput();
  }, [text, applyPendingOutput]);

  const lines = useMemo(() => segmentOutput(displayedText), [displayedText]);
  const busy = isBusy(pane.agent_status);
  const hasPendingOutput = displayedText !== text;

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
      const atBottom = layoutMeasurement.height + contentOffset.y >= contentSize.height - BOTTOM_THRESHOLD_PX;
      pinnedToBottomRef.current = atBottom;
      setShowJumpButton((previous) => (previous === !atBottom ? previous : !atBottom));
      if (atBottom) applyPendingOutput();
    },
    [applyPendingOutput],
  );

  const handleContentSizeChange = useCallback(() => {
    if (pinnedToBottomRef.current) {
      scrollRef.current?.scrollToEnd({ animated: false });
      setShowJumpButton(false);
    }
  }, []);

  const jumpToEnd = useCallback(() => {
    pinnedToBottomRef.current = true;
    setShowJumpButton(false);
    applyPendingOutput();
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [applyPendingOutput]);

  const isEmpty = lines.length === 0;

  const renderSegments = (line: OutputLine) =>
    line.segments.length === 0
      ? ' '
      : line.segments.map((segment, position) =>
          segment.url ? (
            <Text key={position} style={styles.link} onPress={() => openUrl(segment.url as string)}>
              {segment.text}
            </Text>
          ) : (
            segment.text
          ),
        );

  const outputText = (
    <View style={styles.lines}>
      {lines.map((line, lineIndex) =>
        line.kind === 'user' ? (
          // The reader's own turn sits on the right in its own shape, so the
          // conversation reads as one even though the agent's side is plain.
          <View key={lineIndex} style={styles.userRow}>
            <View style={styles.userBubble}>
              <Text selectable style={styles.userText}>
                {renderSegments(line)}
              </Text>
            </View>
          </View>
        ) : (
          <Text key={lineIndex} selectable style={lineStyles[line.kind]}>
            {renderSegments(line)}
          </Text>
        ),
      )}
    </View>
  );

  return (
    // Deliberately not a Pressable: a pressable wrapper wins the touch responder
    // before the ScrollView can claim it, so a slow drag over the output did
    // nothing and the window only scrolled after the keyboard had been opened.
    // Selecting a window is done from its title bar instead.
    <View style={[styles.card, showControls && focused && styles.cardFocused]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Seleziona la finestra ${paneTitle(pane, index)}`}
        onPress={onFocus}
        style={({ pressed }) => [styles.head, pressed && showControls && { backgroundColor: colors.surface }]}
      >
        <View style={styles.headLeft}>
          {busy ? <StatusDot size={6} color={colors.online} /> : null}
          <Text numberOfLines={1} style={[styles.headTitle, focused && styles.headTitleFocused]}>
            {paneTitle(pane, index)}
          </Text>
          {busy ? <Text style={styles.headState}>in esecuzione</Text> : null}
        </View>

        <View style={styles.headRight}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={wrap ? 'Disattiva il ritorno a capo' : 'Attiva il ritorno a capo'}
            onPress={onToggleWrap}
            style={({ pressed }) => [styles.wrapToggle, pressed && { backgroundColor: colors.surfaceActive }]}
          >
            <Text style={[styles.wrapLabel, wrap && styles.wrapLabelActive]}>A capo</Text>
          </Pressable>

          {showControls ? (
            <>
              <IconButton accessibilityLabel="Ingrandisci la finestra" onPress={onZoom} size={28}>
                <IconExpand size={13} color={colors.textMuted} />
              </IconButton>
              <IconButton accessibilityLabel="Chiudi la finestra" onPress={onClose} size={28}>
                <IconClose size={13} color={colors.textMuted} />
              </IconButton>
            </>
          ) : null}
        </View>
      </Pressable>

      <View style={styles.bodyWrapper}>
        <ScrollView
          ref={scrollRef}
          style={styles.body}
          contentContainerStyle={styles.bodyContent}
          onScroll={handleScroll}
          onContentSizeChange={handleContentSizeChange}
          scrollEventThrottle={64}
          keyboardShouldPersistTaps="handled"
        >
          {isEmpty ? (
            <EmptyState title="Nessun output" detail="Questa finestra non ha ancora prodotto testo." />
          ) : wrap ? (
            outputText
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.wideContent}>
              {outputText}
            </ScrollView>
          )}
        </ScrollView>

        {showJumpButton ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={hasPendingOutput ? 'Mostra il nuovo output' : "Vai alla fine dell'output"}
            onPress={jumpToEnd}
            style={styles.jumpButton}
          >
            <IconChevron size={12} direction="down" color={colors.text} />
            <Text style={styles.jumpLabel}>{hasPendingOutput ? 'Nuovo output' : 'In fondo'}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // No frame around the transcript: the reference for this screen is a reading
  // surface, and a border around every window turned the phone into a stack of
  // boxes. A focused window is marked by its title instead.
  card: {
    flex: 1,
    overflow: 'hidden',
  },
  cardFocused: {},
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    paddingLeft: 2,
    paddingRight: 6,
    height: 34,
  },
  headLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    flex: 1,
  },
  headTitle: {
    ...type.mono,
    fontSize: 12,
    color: colors.textMuted,
    flexShrink: 1,
  },
  headTitleFocused: {
    color: colors.text,
  },
  headState: {
    ...type.caption,
    fontSize: 10.5,
    color: colors.textFaint,
  },
  headRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  wrapToggle: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: radius.sm,
  },
  wrapLabel: {
    ...type.caption,
    fontSize: 10.5,
    color: colors.textFaint,
  },
  wrapLabelActive: {
    color: colors.textMuted,
  },
  bodyWrapper: {
    flex: 1,
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    paddingHorizontal: 2,
    paddingTop: 2,
    paddingBottom: space.lg,
    flexGrow: 1,
  },
  wideContent: {
    paddingRight: space.xl,
  },
  lines: {
    alignSelf: 'stretch',
  },
  prose: {
    ...type.prose,
    color: colors.text,
  },
  output: {
    ...type.output,
    color: colors.terminalText,
  },
  meta: {
    ...type.meta,
    color: colors.textMuted,
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
  link: {
    color: colors.link,
    textDecorationLine: 'underline',
  },
  jumpButton: {
    position: 'absolute',
    right: space.md,
    bottom: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceActive,
  },
  jumpLabel: {
    ...type.caption,
    color: colors.text,
  },
});

const lineStyles: Record<LineKind, TextStyle> = {
  prose: styles.prose,
  mono: styles.output,
  meta: styles.meta,
  user: styles.userText,
};
