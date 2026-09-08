import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { countLines, describeCalls, type ToolCall, type ToolKind } from '../../domain/events';
import { colors, radius, space, type } from '../../theme';
import { DiffStat, DiffViewer } from './DiffViewer';
import { Sheet } from './Sheet';

/**
 * A run of tool calls, shown as one quiet line.
 *
 * Reading a session back, what matters is the shape of what happened — the
 * agent searched, then changed four files — not forty rows of `Letto x`. So a
 * run collapses to a sentence and a count of lines, and opens when the reader
 * wants the detail. Everything is one tap away and nothing is in the way.
 */

/** A glyph per kind. Text rather than an icon set: no font to ship, nothing to go missing. */
const GLYPH: Record<ToolKind, string> = {
  read: '▤',
  edit: '✎',
  write: '✚',
  shell: '›_',
  search: '⌕',
  web: '◍',
  task: '◈',
  other: '●',
};

const statusColour = (call: ToolCall) =>
  call.status === 'error'
    ? colors.danger
    : call.status === 'running'
      ? colors.busy
      : colors.textFaint;

/** The collapsed line in the feed. */
export function ToolGroupRow({ calls }: { calls: readonly ToolCall[] }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<ToolCall | null>(null);
  const { added, removed } = countLines(calls);
  const running = calls.some((call) => call.status === 'running');
  const failed = calls.filter((call) => call.status === 'error').length;

  return (
    <>
      <Pressable style={styles.row} onPress={() => setOpen(true)}>
        <Text style={[styles.rowGlyph, running && styles.rowGlyphBusy]}>
          {GLYPH[calls[0].kind]}
        </Text>
        <Text style={styles.rowText} numberOfLines={1}>
          {describeCalls(calls)}
        </Text>
        {failed > 0 && <Text style={styles.failed}>{failed} fallit{failed === 1 ? 'o' : 'i'}</Text>}
        <DiffStat added={added} removed={removed} />
        <Text style={styles.chevron}>›</Text>
      </Pressable>

      <Sheet
        visible={open}
        title={
          calls.length === 1 ? 'Uno strumento' : `Utilizzati ${calls.length} strumenti`
        }
        onClose={() => setOpen(false)}
      >
        {calls.map((call, index) => (
          <Pressable
            key={call.id || index}
            style={styles.call}
            onPress={() => setDetail(call)}
          >
            {/* The line down the left ties a run together, the way the desktop draws it. */}
            <View style={styles.rail}>
              <Text style={[styles.callGlyph, { color: statusColour(call) }]}>
                {GLYPH[call.kind]}
              </Text>
              {index < calls.length - 1 && <View style={styles.railLine} />}
            </View>

            <View style={styles.callBody}>
              <View style={styles.callHead}>
                <Text style={styles.callTitle} numberOfLines={2}>
                  {call.title}
                </Text>
                {call.diff && <DiffStat added={call.diff.added} removed={call.diff.removed} />}
              </View>
              <Text style={styles.callMeta} numberOfLines={1}>
                {call.name}
                {call.status === 'running'
                  ? ' · in corso'
                  : call.status === 'error'
                    ? ' · fallito'
                    : ''}
              </Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        ))}
      </Sheet>

      <ToolDetail call={detail} onClose={() => setDetail(null)} />
    </>
  );
}

/** One call in full: its diff if it changed a file, otherwise what it was given. */
export function ToolDetail({ call, onClose }: { call: ToolCall | null; onClose: () => void }) {
  if (!call) return null;

  const status =
    call.status === 'running' ? 'In corso' : call.status === 'error' ? 'Fallito' : 'Completato';

  return (
    <Sheet visible title={call.name} subtitle={status} onClose={onClose}>
      <Text style={styles.detailTitle}>{call.title}</Text>

      {call.error ? (
        <View style={styles.error}>
          <Text style={styles.errorText}>{call.error}</Text>
        </View>
      ) : null}

      {call.diff ? (
        <View style={styles.detailSection}>
          <DiffViewer diff={call.diff} />
        </View>
      ) : null}

      {Object.keys(call.params).length > 0 && (
        <View style={styles.detailSection}>
          <Text style={styles.sectionLabel}>ARGOMENTI</Text>
          {Object.entries(call.params).map(([key, value]) => (
            <View key={key} style={styles.param}>
              <Text style={styles.paramKey}>{key}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <Text style={styles.paramValue}>
                  {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
                </Text>
              </ScrollView>
            </View>
          ))}
        </View>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.xs,
  },
  rowGlyph: { ...type.caption, color: colors.textFaint, width: 16 },
  rowGlyphBusy: { color: colors.busy },
  rowText: { ...type.meta, color: colors.textMuted, flex: 1 },
  failed: { ...type.caption, color: colors.danger },
  chevron: { fontSize: 18, color: colors.textFaint, paddingLeft: space.xs },

  call: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    paddingVertical: space.sm,
  },
  rail: { width: 20, alignItems: 'center' },
  callGlyph: { fontSize: 13 },
  railLine: {
    position: 'absolute',
    top: 20,
    bottom: -space.sm,
    width: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
  },
  callBody: { flex: 1 },
  callHead: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  callTitle: { ...type.label, color: colors.text, flex: 1 },
  callMeta: { ...type.caption, color: colors.textFaint, marginTop: 2 },

  detailTitle: { ...type.title, color: colors.text, marginBottom: space.md },
  detailSection: { marginTop: space.lg },
  sectionLabel: { ...type.section, color: colors.textFaint, marginBottom: space.sm },

  error: {
    backgroundColor: 'rgba(224, 108, 96, 0.12)',
    borderRadius: radius.md,
    padding: space.md,
  },
  errorText: { ...type.body, color: colors.danger, lineHeight: 20 },

  param: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.sm,
    padding: space.md,
    marginBottom: space.sm,
  },
  paramKey: { ...type.caption, color: colors.textMuted, marginBottom: space.xs },
  paramValue: { ...type.output, color: colors.terminalText },
});
