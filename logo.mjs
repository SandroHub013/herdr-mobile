#!/usr/bin/env node
/**
 * Draws the Herdr Mobile logo and writes every size Android and Expo need.
 *
 *   node logo.mjs
 *
 * The mark is Herdr's chevron, set in ordered dithering: two colours per
 * layer and nothing in between, mixed by an 8x8 Bayer matrix on a coarse
 * pixel grid, so the gradient is made of dots you can see. No anti-aliasing
 * anywhere, on purpose.
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

/** Herdr's chevron: two capsules meeting at the apex, in a unit square. */
const APEX = { x: 0.5, y: 0.3 };
const FOOT_LEFT = { x: 0.28, y: 0.665 };
const FOOT_RIGHT = { x: 0.72, y: 0.665 };
const HALF_WIDTH = 0.072;

/** Cells across the canvas. Fewer cells, bigger dots. */
const CELLS = 32;

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

function distanceToSegment(p, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / (abx * abx + aby * aby)));
  const dx = p.x - (a.x + t * abx);
  const dy = p.y - (a.y + t * aby);
  return Math.sqrt(dx * dx + dy * dy);
}

/** Whether a design point sits inside the chevron, and how far down it it is (0 top, 1 feet). */
function chevron(p, scale) {
  const q = { x: 0.5 + (p.x - 0.5) / scale, y: 0.5 + (p.y - 0.5) / scale };
  const d = Math.min(distanceToSegment(q, APEX, FOOT_LEFT), distanceToSegment(q, APEX, FOOT_RIGHT));
  if (d > HALF_WIDTH) return null;
  const depth = Math.max(0, Math.min(1, (q.y - (APEX.y - HALF_WIDTH)) / (FOOT_LEFT.y + HALF_WIDTH - (APEX.y - HALF_WIDTH))));
  return depth;
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
        const depth = chevron(p, scale);
        if (depth !== null) {
          if (layer === 'monochrome') {
            rgb = WHITE;
            alpha = 1 - depth * 0.62 > threshold ? 255 : 0;
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
