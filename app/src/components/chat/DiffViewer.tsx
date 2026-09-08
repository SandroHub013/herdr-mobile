import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Diff, DiffHunk } from '../../domain/events';
import { colors, radius, space, type } from '../../theme';

/**
 * What an edit changed.
 *
 * Two rules decide the whole design. Code must not reflow, because a wrapped
 * line is a different line — so it scrolls sideways rather than wrapping. And
 * the numbers down the side are the file's own where the bridge could recover
 * them, so the reader can go and find the change; where it could not, the hunk
 * starts at 1 and says so rather than inventing a position.
 */

/** Long hunks open closed: a thousand-line rewrite should not cost a thousand rows to scroll past. */
const PREVIEW_LINES = 14;

const GUTTER = 44;

export function DiffStat({ added, removed }: { added: number; removed: number }) {
  return (
    <View style={styles.stat}>
      {added > 0 && <Text style={styles.added}>+{added}</Text>}
      {removed > 0 && <Text style={styles.removed}>−{removed}</Text>}
    </View>
  );
}

function Hunk({ hunk, anchored }: { hunk: DiffHunk; anchored: boolean }) {
  const [open, setOpen] = useState(hunk.lines.length <= PREVIEW_LINES);
  const shown = open ? hunk.lines : hunk.lines.slice(0, PREVIEW_LINES);
  const hidden = hunk.lines.length - shown.length;

  // Only the lines that were there before advance the numbering; an added line
  // has no number of its own yet.
  let line = hunk.startLine;

  return (
    <View style={styles.hunk}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View>
          {shown.map((row, index) => {
            const number = row.kind === 'added' ? null : line++;
            return (
              <View
                key={index}
                style={[
                  styles.row,
                  row.kind === 'added' && styles.rowAdded,
                  row.kind === 'removed' && styles.rowRemoved,
                ]}
              >
                <Text style={styles.gutter}>{anchored && number !== null ? number : ''}</Text>
                <Text style={styles.sign}>
                  {row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ' '}
                </Text>
                <Text style={styles.codeLine}>{row.text || ' '}</Text>
              </View>
            );
          })}
        </View>
      </ScrollView>

      {hidden > 0 && (
        <Pressable style={styles.expand} onPress={() => setOpen(true)}>
          <Text style={styles.expandText}>
            Espandi · altre {hidden} righe
          </Text>
        </Pressable>
      )}
    </View>
  );
}

export function DiffViewer({ diff }: { diff: Diff }) {
  const anchored = diff.hunks.some((hunk) => hunk.startLine > 1);

  return (
    <View>
      <View style={styles.header}>
        <Text style={styles.path} numberOfLines={1} ellipsizeMode="head">
          {diff.path}
        </Text>
        <DiffStat added={diff.added} removed={diff.removed} />
      </View>

      {diff.truncated ? (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>
            Modifica troppo grande per essere mostrata riga per riga: {diff.added} righe
            aggiunte, {diff.removed} tolte. Apri il file per vederlo.
          </Text>
        </View>
      ) : diff.hunks.length === 0 ? (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>Nessuna riga cambiata.</Text>
        </View>
      ) : (
        diff.hunks.map((hunk, index) => <Hunk key={index} hunk={hunk} anchored={anchored} />)
      )}

      {!anchored && diff.hunks.length > 0 && !diff.truncated && (
        <Text style={styles.footnote}>
          Numerazione relativa: il file è cambiato da quando la modifica è stata fatta.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    paddingBottom: space.md,
  },
  path: { ...type.mono, fontSize: 13, color: colors.textMuted, flex: 1 },

  stat: { flexDirection: 'row', gap: space.sm },
  added: { ...type.caption, color: colors.online, fontVariant: ['tabular-nums'] },
  removed: { ...type.caption, color: colors.danger, fontVariant: ['tabular-nums'] },

  hunk: {
    backgroundColor: colors.terminal,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    overflow: 'hidden',
    marginBottom: space.md,
  },
  row: { flexDirection: 'row', alignItems: 'flex-start', paddingRight: space.lg },
  rowAdded: { backgroundColor: 'rgba(78, 169, 107, 0.13)' },
  rowRemoved: { backgroundColor: 'rgba(224, 108, 96, 0.13)' },

  gutter: {
    ...type.output,
    color: colors.textFaint,
    width: GUTTER,
    textAlign: 'right',
    paddingRight: space.sm,
    fontVariant: ['tabular-nums'],
  },
  sign: { ...type.output, color: colors.textFaint, width: 14 },
  codeLine: { ...type.output, color: colors.terminalText },

  expand: {
    paddingVertical: space.sm,
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  expandText: { ...type.caption, color: colors.textMuted },

  notice: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md,
    padding: space.md,
  },
  noticeText: { ...type.body, color: colors.textMuted, lineHeight: 20 },

  footnote: { ...type.caption, color: colors.textFaint, marginTop: space.xs },
});
