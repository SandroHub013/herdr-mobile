#!/usr/bin/env node
/**
 * Draws the Herdr Mobile logo and writes every size Android and Expo need.
 *
 *   node logo.mjs
 *
 * The mark is a phone with an H lit on its screen, set in ordered dithering:
 * two colours per layer and nothing in between, mixed by an 8x8 Bayer matrix
 * on a coarse pixel grid, so the gradient is made of dots you can see. No
 * anti-aliasing anywhere, on purpose.
 *
 * Output:
 *   app/android/app/src/main/res/mipmap-*    launcher, round, adaptive layers
 *   app/android/app/src/main/res/drawable-*  splash logo
 *   app/assets/                              the same for Expo's config
 *
 * The .webp files those folders used to hold are removed, since a resource
 * may exist once per name.
 */
import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const RES = join(ROOT, 'app', 'android', 'app', 'src', 'main', 'res');
const ASSETS = join(ROOT, 'app', 'assets');

// ------------------------------------------------------------------ palette

const BG = [11, 11, 13]; // the app's own background
const GLOW = [24, 28, 46]; // a cold lift behind the mark
const LIGHT = [222, 233, 255]; // the chevron's lit edge
const BLUE = [43, 111, 230]; // Herdr's blue
const WHITE = [255, 255, 255];

// ------------------------------------------------------------------- design

/**
 * The mark: a phone, seen face on, with an H lit on its screen.
 *
 * Everything is measured in a unit square so one description serves every
 * size, from a 48px launcher icon to the 1024px store image. The numbers are
 * chosen for the smallest of those: at 32 cells across, the phone is fourteen
 * cells wide and the H's bars are not quite two, which is the least that
 * survives being dithered.
 */
/** Cells across the canvas. Fewer cells, bigger dots. */
const CELLS = 32;
/** One cell, in design units. Every measurement below is a whole number of these. */
const C = 1 / CELLS;

/**
 * Measured in whole cells, which is the only way the H comes out straight.
 * A bar 0.031 wide is 0.99 cells: sampled at cell centres it catches one
 * column here and two there, and the letter arrives with a limp. On the grid,
 * both uprights are two cells and the thing is symmetric by construction.
 */
const PHONE = { cx: 0.5, cy: 0.5, halfW: 7 * C, halfH: 10 * C, radius: 2 * C };
/** The bezel. Thick enough to stay a frame rather than a hairline. */
const BEZEL = 2 * C;
/** The H, centred on the screen: two cells thick, six across, eight tall. */
const GLYPH = { halfW: 3 * C, halfH: 4 * C, bar: 2 * C };

const BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
].map((n) => (n + 0.5) / 64);

/**
 * Distance from a point to a rounded rectangle: negative inside, positive out.
 * One function draws both the phone and its screen, which is what keeps the
 * bezel an even thickness all the way round the corners.
 */
function roundedRect(p, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(p.x - cx) - (halfW - radius);
  const dy = Math.abs(p.y - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/** The H: two uprights and the bar between them. */
function insideGlyph(p) {
  const x = p.x - PHONE.cx;
  const y = p.y - PHONE.cy;
  if (Math.abs(y) > GLYPH.halfH) return false;
  const upright = Math.abs(Math.abs(x) - (GLYPH.halfW - GLYPH.bar / 2)) <= GLYPH.bar / 2;
  const crossbar = Math.abs(y) <= GLYPH.bar / 2 && Math.abs(x) <= GLYPH.halfW;
  return upright || crossbar;
}

/**
 * Which part of the mark a point falls in, and how far down the mark it is
 * (0 at the top, 1 at the bottom) — the gradient the dithering resolves into
 * dots. Null means the point is outside the phone altogether.
 */
function mark(p, scale) {
  const q = { x: 0.5 + (p.x - 0.5) / scale, y: 0.5 + (p.y - 0.5) / scale };
  if (roundedRect(q, PHONE.cx, PHONE.cy, PHONE.halfW, PHONE.halfH, PHONE.radius) > 0) return null;

  const top = PHONE.cy - PHONE.halfH;
  const depth = Math.max(0, Math.min(1, (q.y - top) / (PHONE.halfH * 2)));

  if (insideGlyph(q)) return { part: 'glyph', depth };

  const inScreen =
    roundedRect(
      q,
      PHONE.cx,
      PHONE.cy,
      PHONE.halfW - BEZEL,
      PHONE.halfH - BEZEL,
      Math.max(0.012, PHONE.radius - BEZEL),
    ) <= 0;
  return { part: inScreen ? 'screen' : 'frame', depth };
}

// ----------------------------------------------------------------- drawing

/**
 * Renders one layer at one size.
 *
 * `layer` is 'foreground' (chevron on transparent), 'background' (glow on
 * the app colour), 'full' (both), 'round' (both under a circle) or
 * 'monochrome' (white chevron whose density fades, for themed icons).
 */
function render(size, layer, scale = 1) {
  const cell = Math.max(1, Math.round(size / CELLS));
  const pixels = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = Math.floor(x / cell);
      const j = Math.floor(y / cell);
      const threshold = BAYER[(j % 8) * 8 + (i % 8)];
      const p = { x: ((i + 0.5) * cell) / size, y: ((j + 0.5) * cell) / size };

      let rgb = null;
      let alpha = 0;

      if (layer === 'background' || layer === 'full' || layer === 'round') {
        const dist = Math.hypot(p.x - 0.5, p.y - 0.5);
        const glow = Math.pow(Math.max(0, 1 - dist / 0.62), 1.6) * 0.95;
        rgb = glow > threshold ? GLOW : BG;
        alpha = 255;
      }

      if (layer !== 'background') {
        const hit = mark(p, scale);
        if (hit !== null) {
          const { part, depth } = hit;
          if (layer === 'monochrome') {
            // A themed icon is one colour on nothing, so the screen is left
            // empty: what remains is the phone's outline with the H inside it.
            if (part !== 'screen') {
              rgb = WHITE;
              alpha = 1 - depth * 0.62 > threshold ? 255 : 0;
            }
          } else if (part === 'glyph') {
            rgb = 1 - depth * 0.5 > threshold ? WHITE : LIGHT;
            alpha = 255;
          } else if (part === 'screen') {
            // Dark, so the H reads as lit rather than cut out, and dithered
            // so it does not go flat against the frame.
            rgb = 0.42 - depth * 0.22 > threshold ? GLOW : BG;
            alpha = 255;
          } else {
            rgb = 1 - depth * 0.88 > threshold ? LIGHT : BLUE;
            alpha = 255;
          }
        }
      }

      if (layer === 'round') {
        const px = (x + 0.5) / size;
        const py = (y + 0.5) / size;
        if (Math.hypot(px - 0.5, py - 0.5) > 0.5) alpha = 0;
      }

      const at = (y * size + x) * 4;
      if (rgb && alpha > 0) {
        pixels[at] = rgb[0];
        pixels[at + 1] = rgb[1];
        pixels[at + 2] = rgb[2];
        pixels[at + 3] = alpha;
      }
    }
  }
  return pixels;
}

// --------------------------------------------------------------------- png

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size, pixels) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------ output

function write(path, size, layer, scale) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, png(size, render(size, layer, scale)));
  const twin = path.replace(/\.png$/, '.webp');
  if (existsSync(twin)) unlinkSync(twin);
  console.log(`${path.replace(ROOT, '').replace(/^[\\/]/, '')}  ${size}px`);
}

/** Android density buckets and the dp they multiply. */
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

const LEGACY_DP = 48;
const ADAPTIVE_DP = 108;
const SPLASH_DP = 96;
/** The legacy icon has no mask of its own to leave room for, so the mark sits larger. */
const LEGACY_SCALE = 1.3;

for (const [bucket, factor] of Object.entries(DENSITIES)) {
  const mipmap = join(RES, `mipmap-${bucket}`);
  write(join(mipmap, 'ic_launcher.png'), LEGACY_DP * factor, 'full', LEGACY_SCALE);
  write(join(mipmap, 'ic_launcher_round.png'), LEGACY_DP * factor, 'round', LEGACY_SCALE);
  write(join(mipmap, 'ic_launcher_foreground.png'), ADAPTIVE_DP * factor, 'foreground');
  write(join(mipmap, 'ic_launcher_background.png'), ADAPTIVE_DP * factor, 'background');
  write(join(mipmap, 'ic_launcher_monochrome.png'), ADAPTIVE_DP * factor, 'monochrome');
  write(join(RES, `drawable-${bucket}`, 'splashscreen_logo.png'), SPLASH_DP * factor, 'foreground', 1.5);
}

write(join(ASSETS, 'icon.png'), 1024, 'full', LEGACY_SCALE);
write(join(ASSETS, 'android-icon-foreground.png'), 1024, 'foreground');
write(join(ASSETS, 'android-icon-background.png'), 1024, 'background');
write(join(ASSETS, 'android-icon-monochrome.png'), 1024, 'monochrome');
write(join(ASSETS, 'splash-icon.png'), 512, 'foreground', 1.5);
write(join(ASSETS, 'favicon.png'), 48, 'full', LEGACY_SCALE);
write(join(ROOT, 'releases', 'logo-1024.png'), 1024, 'full', LEGACY_SCALE);
