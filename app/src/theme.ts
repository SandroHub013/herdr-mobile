import { Platform } from 'react-native';

/**
 * Design tokens for Herdr Mobile.
 *
 * Neutral, near-black surfaces with a single indigo accent.
 * Colour is information, never decoration: an accent means "focused",
 * a coloured dot means "state". Everything else is greyscale.
 */
export const colors = {
  background: '#0B0B0D',
  surface: '#141418',
  surfaceRaised: '#1B1B21',
  surfaceActive: '#26262F',
  terminal: '#0A0A0C',

  border: '#24242C',
  borderSubtle: '#191920',
  /** Focus ring for a pane: readable, but never the loudest thing on screen. */
  borderFocus: '#3A3A48',

  text: '#ECECEF',
  textMuted: '#9B9BA6',
  textFaint: '#65656F',

  accent: '#7F84EE',
  accentSoft: 'rgba(127, 132, 238, 0.16)',

  online: '#4EA96B',
  busy: '#D2A24C',
  danger: '#E06C60',

  terminalText: '#DCDCE2',
  link: '#8AAEF5',

  scrim: 'rgba(0, 0, 0, 0.62)',
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 999,
} as const;

/** Families that actually exist on each platform (no glyph fallbacks, no tofu). */
export const monoFamily = Platform.select({ ios: 'Menlo', default: 'monospace' }) as string;
export const serifFamily = Platform.select({ ios: 'Georgia', default: 'serif' }) as string;

export const type = {
  title: { fontSize: 16, fontWeight: '600' as const, letterSpacing: -0.2 },
  body: { fontSize: 14, fontWeight: '400' as const },
  label: { fontSize: 13, fontWeight: '500' as const },
  caption: { fontSize: 11.5, fontWeight: '500' as const },
  section: { fontSize: 11, fontWeight: '600' as const, letterSpacing: 0.9 },
  mono: { fontSize: 12, fontFamily: monoFamily },
  /** Reading size for sentences: a transcript, not a console. */
  prose: { fontSize: 16.5, lineHeight: 26, fontFamily: serifFamily },
  /** Output whose columns carry meaning, kept small enough to fit a phone. */
  output: { fontSize: 12.5, lineHeight: 19, fontFamily: monoFamily },
  /** The agent reporting on itself: present, but never competing with the text. */
  meta: { fontSize: 13, lineHeight: 22, fontWeight: '500' as const },
} as const;

/** Minimum touch target recommended by both Material and HIG. */
export const HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 } as const;
