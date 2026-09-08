import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';
import {
  runningInBackground,
  toBlocks,
  type Block,
  type MessageEvent,
  type NoticeEvent,
  type ToolCall,
} from '../../domain/events';
import type { useConversation } from '../../hooks/useConversation';
import { colors, radius, space, type } from '../../theme';
import { BackgroundBadge, BackgroundSheet } from './BackgroundSheet';
import { Markdown } from './Markdown';
import { ToolGroupRow } from './ToolGroup';

/**
 * The session, as a conversation.
 *
 * There is no terminal here and no way to reach one. What the agent is doing
 * arrives as events and is drawn as messages, tool runs and notices. A pane
 * running something that keeps no transcript falls back to its screen, shown
 * as one block of monospace, and says so plainly rather than dressing it up as
 * a conversation it could not reconstruct.
 *
 * The state comes from above: the composer needs the same manifest to know
 * which pills to show, and two copies of one conversation would be one too
 * many.
 */

export type Conversation = ReturnType<typeof useConversation>;

function UserMessage({ event }: { event: MessageEvent }) {
  return (
    <View style={styles.userRow}>
      <View style={styles.userBubble}>
        <Text style={styles.userText}>{event.text}</Text>
        {event.images ? (
          <Text style={styles.userImages}>
            {event.images === 1 ? '1 immagine' : `${event.images} immagini`}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const NOTICE_LABEL: Record<NoticeEvent['kind'], string> = {
  compaction: 'Contesto riassunto',
  limit: 'Limite',
  interrupted: 'Interrotto',
  error: 'Errore',
};

function Notice({ event }: { event: NoticeEvent }) {
  return (
    <View style={styles.notice}>
      <View style={styles.noticeRule} />
      <Text style={styles.noticeText}>
        <Text style={styles.noticeLabel}>{NOTICE_LABEL[event.kind]} · </Text>
        {event.text}
      </Text>
      <View style={styles.noticeRule} />
    </View>
  );
}

export function ChatFeed({
  conversation,
  onStopTask,
}: {
  conversation: Conversation;
  onStopTask?: (call: ToolCall) => void;
}) {
  const { status, events, agent, match } = conversation;
  const [tasksOpen, setTasksOpen] = useState(false);
  const list = useRef<FlatList<Block>>(null);

  const blocks = useMemo(() => toBlocks(events), [events]);
  const background = useMemo(() => runningInBackground(events), [events]);
  const running = background.filter((call) => !call.background?.endedAt).length;

  const renderBlock = useCallback(({ item }: { item: Block }) => {
    if (item.kind === 'tools') return <ToolGroupRow calls={item.calls} />;
    if (item.kind === 'notice') return <Notice event={item.event} />;
    if (item.event.role === 'user') return <UserMessage event={item.event} />;
    return (
      <View style={styles.assistant}>
        <Markdown source={item.event.text} />
      </View>
    );
  }, []);

  if (status === 'loading' && blocks.length === 0) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={colors.textFaint} />
      </View>
    );
  }

  if (status === 'missing' || status === 'failed') {
    return (
      <View style={styles.centre}>
        <Text style={styles.emptyTitle}>
          {status === 'missing' ? 'Nessuna conversazione qui' : 'Il bridge non risponde'}
        </Text>
        <Text style={styles.emptyBody}>
          {status === 'missing'
            ? 'Questa finestra non ha un agente con una trascrizione da leggere.'
            : 'Controlla che il bridge sia in esecuzione sul PC.'}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      {agent && !agent.capabilities.structured && (
        <View style={styles.fallback}>
          <Text style={styles.fallbackText}>
            Questa finestra non tiene una trascrizione: quello che vedi è lo schermo, senza
            cronologia né dettaglio degli strumenti.
          </Text>
        </View>
      )}

      {match === 'cwd' && (
        <View style={styles.fallback}>
          <Text style={styles.fallbackText}>
            Sessione dedotta dalla cartella: potrebbe non essere quella aperta in questa
            finestra.
          </Text>
        </View>
      )}

      <FlatList
        ref={list}
        data={blocks}
        keyExtractor={(block) => (block.kind === 'tools' ? `t${block.seq}` : `e${block.event.seq}`)}
        renderItem={renderBlock}
        style={styles.feed}
        contentContainerStyle={styles.feedContent}
        showsVerticalScrollIndicator={false}
        // Newest at the bottom, as a conversation reads. Not animated: a reply
        // arriving every second would keep the feed permanently in motion.
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
        ListFooterComponent={
          agent?.capabilities.backgroundTasks ? (
            <BackgroundBadge running={running} onPress={() => setTasksOpen(true)} />
          ) : null
        }
      />

      <BackgroundSheet
        visible={tasksOpen}
        calls={background}
        onClose={() => setTasksOpen(false)}
        onStop={onStopTask}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xxl,
  },
  emptyTitle: { ...type.title, color: colors.text, marginBottom: space.sm },
  emptyBody: { ...type.body, color: colors.textFaint, textAlign: 'center', lineHeight: 20 },

  fallback: {
    backgroundColor: colors.surfaceRaised,
    marginHorizontal: space.lg,
    marginTop: space.md,
    padding: space.md,
    borderRadius: radius.md,
  },
  fallbackText: { ...type.caption, color: colors.textMuted, lineHeight: 17 },

  feed: { flex: 1 },
  feedContent: { paddingHorizontal: space.lg, paddingVertical: space.lg, gap: space.md },

  assistant: { paddingRight: space.sm },

  userRow: { alignItems: 'flex-end' },
  userBubble: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.lg,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    maxWidth: '88%',
  },
  userText: { ...type.prose, fontSize: 16, lineHeight: 24, color: colors.text },
  userImages: { ...type.caption, color: colors.textFaint, marginTop: space.xs },

  notice: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm },
  noticeRule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  noticeText: { ...type.caption, color: colors.textFaint, flexShrink: 1 },
  noticeLabel: { color: colors.textMuted },
});
