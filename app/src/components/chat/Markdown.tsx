import React, { useMemo } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, radius, space, type } from '../../theme';

/**
 * Markdown, rendered.
 *
 * The old transcript view stripped the marks and showed what was left, which
 * turned every list into a wall and every heading into another sentence. An
 * agent writes in markdown because the structure carries meaning — this reads
 * the structure back out.
 *
 * Deliberately not a full parser. It covers what agents actually write:
 * headings, emphasis, inline code, fenced code, lists, quotes, rules, links
 * and tables. Anything else is shown as the text it is, which is the right
 * failure: unrecognised markdown reads as slightly noisy prose rather than
 * disappearing.
 */

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; language: string; text: string }
  | { kind: 'item'; text: string; ordered: boolean; marker: string; depth: number }
  | { kind: 'quote'; text: string }
  | { kind: 'table'; rows: string[][]; header: boolean }
  | { kind: 'rule' };

const FENCE = /^\s*```(\S*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
/** Three or more of the same mark, spaced or not: `---`, `***`, `- - -`. */
const RULE = /^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
const TABLE_RULE = /^\s*\|[\s:|-]+\|\s*$/;

function parse(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    const text = paragraph.join('\n').trim();
    if (text) blocks.push({ kind: 'paragraph', text });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      blocks.push({ kind: 'code', language: fence[1] ?? '', text: body.join('\n') });
      continue;
    }

    if (line.trim() === '') {
      flush();
      continue;
    }

    if (RULE.test(line)) {
      flush();
      blocks.push({ kind: 'rule' });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] });
      continue;
    }

    // A table is only a table with a rule under its first row; without one
    // these are just lines that happen to contain pipes.
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      flush();
      const cells = (row: string) =>
        row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const rows = [cells(line)];
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i])) rows.push(cells(lines[i++]));
      i--;
      blocks.push({ kind: 'table', rows, header: true });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      flush();
      blocks.push({ kind: 'quote', text: quote[1] });
      continue;
    }

    const ordered = ORDERED.exec(line);
    if (ordered) {
      flush();
      blocks.push({
        kind: 'item',
        ordered: true,
        marker: `${ordered[2]}.`,
        text: ordered[3],
        depth: Math.floor(ordered[1].length / 2),
      });
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      flush();
      blocks.push({
        kind: 'item',
        ordered: false,
        marker: '•',
        text: bullet[2],
        depth: Math.floor(bullet[1].length / 2),
      });
      continue;
    }

    paragraph.push(line);
  }
  flush();
  return blocks;
}

// ------------------------------------------------------------------- inline

type Span =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'em'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string };

/**
 * One pass, longest marks first, so `**bold**` is never read as two italics.
 * Nesting is not supported and is not worth the parser it would take: agents
 * write bold or italic, rarely bold inside italic.
 */
const INLINE =
  /(`[^`\n]+`)|(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)/g;

function spans(text: string): Span[] {
  const out: Span[] = [];
  let at = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > at) out.push({ kind: 'text', text: text.slice(at, start) });
    const token = match[0];
    if (token.startsWith('`')) {
      out.push({ kind: 'code', text: token.slice(1, -1) });
    } else if (token.startsWith('[')) {
      const split = token.indexOf('](');
      out.push({
        kind: 'link',
        text: token.slice(1, split),
        href: token.slice(split + 2, -1),
      });
    } else if (token.startsWith('**') || token.startsWith('__')) {
      out.push({ kind: 'strong', text: token.slice(2, -2) });
    } else {
      out.push({ kind: 'em', text: token.slice(1, -1) });
    }
    at = start + token.length;
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) });
  return out;
}

function Inline({ text, style }: { text: string; style?: object }) {
  const parts = useMemo(() => spans(text), [text]);
  return (
    <>
      {parts.map((span, index) => {
        if (span.kind === 'code') {
          return (
            <Text key={index} style={[style, styles.inlineCode]}>
              {span.text}
            </Text>
          );
        }
        if (span.kind === 'link') {
          return (
            <Text
              key={index}
              style={[style, styles.link]}
              onPress={() => void Linking.openURL(span.href).catch(() => {})}
            >
              {span.text}
            </Text>
          );
        }
        const weight =
          span.kind === 'strong'
            ? styles.strong
            : span.kind === 'em'
              ? styles.em
              : undefined;
        return (
          <Text key={index} style={[style, weight]}>
            {span.text}
          </Text>
        );
      })}
    </>
  );
}

// ------------------------------------------------------------------ rendering

const HEADING_SIZE = [23, 20, 18, 17, 16, 16];

export function Markdown({ source, tint }: { source: string; tint?: string }) {
  const blocks = useMemo(() => parse(source), [source]);
  const prose = tint ? [styles.prose, { color: tint }] : styles.prose;

  return (
    <View>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'heading':
            return (
              <Text
                key={index}
                style={[
                  styles.heading,
                  { fontSize: HEADING_SIZE[block.level - 1], marginTop: index === 0 ? 0 : space.lg },
                ]}
              >
                <Inline text={block.text} />
              </Text>
            );

          case 'code':
            return (
              <View key={index} style={styles.codeBlock}>
                {/* Code must not reflow: a wrapped command is a different command. */}
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <Text style={styles.code}>{block.text}</Text>
                </ScrollView>
              </View>
            );

          case 'item':
            return (
              <View key={index} style={[styles.item, { paddingLeft: space.md + block.depth * space.lg }]}>
                <Text style={[styles.marker, block.ordered && styles.markerOrdered]}>
                  {block.marker}
                </Text>
                <Text style={[prose, styles.itemText]}>
                  <Inline text={block.text} style={prose} />
                </Text>
              </View>
            );

          case 'quote':
            return (
              <View key={index} style={styles.quote}>
                <Text style={[prose, styles.quoteText]}>
                  <Inline text={block.text} style={prose} />
                </Text>
              </View>
            );

          case 'table':
            return (
              <ScrollView
                key={index}
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.tableScroll}
              >
                <View style={styles.table}>
                  {block.rows.map((row, r) => (
                    <View key={r} style={[styles.tableRow, r === 0 && styles.tableHead]}>
                      {row.map((cell, c) => (
                        <Text
                          key={c}
                          style={[styles.tableCell, r === 0 && styles.tableCellHead]}
                          numberOfLines={4}
                        >
                          <Inline text={cell} />
                        </Text>
                      ))}
                    </View>
                  ))}
                </View>
              </ScrollView>
            );

          case 'rule':
            return <View key={index} style={styles.rule} />;

          default:
            return (
              <Text key={index} style={[prose, index > 0 && styles.paragraphGap]}>
                <Inline text={block.text} style={prose} />
              </Text>
            );
        }
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  prose: { ...type.prose, color: colors.text },
  paragraphGap: { marginTop: space.md },
  heading: {
    color: colors.text,
    fontWeight: '600',
    letterSpacing: -0.3,
    marginBottom: space.xs,
  },
  strong: { fontWeight: '700' },
  em: { fontStyle: 'italic' },
  inlineCode: {
    ...type.mono,
    fontSize: 14,
    color: colors.link,
    backgroundColor: colors.surfaceRaised,
  },
  link: { color: colors.link, textDecorationLine: 'underline' },

  codeBlock: {
    backgroundColor: colors.terminal,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    marginTop: space.md,
  },
  code: { ...type.output, color: colors.terminalText },

  item: { flexDirection: 'row', marginTop: space.sm },
  marker: {
    ...type.prose,
    color: colors.textFaint,
    width: 22,
    lineHeight: 26,
  },
  markerOrdered: { fontSize: 14, color: colors.textMuted },
  itemText: { flex: 1 },

  quote: {
    borderLeftWidth: 2,
    borderLeftColor: colors.border,
    paddingLeft: space.md,
    marginTop: space.md,
  },
  quoteText: { color: colors.textMuted },

  tableScroll: { marginTop: space.md },
  table: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  tableRow: { flexDirection: 'row' },
  tableHead: { backgroundColor: colors.surfaceRaised },
  tableCell: {
    ...type.body,
    color: colors.text,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    minWidth: 96,
    maxWidth: 220,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
  tableCellHead: { fontWeight: '600', color: colors.textMuted, borderTopWidth: 0 },

  rule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginVertical: space.lg,
  },
});
