#!/usr/bin/env node
'use strict';

/**
 * Icon-Generator: roter Laserpointer-Glow.
 * Erzeugt:
 *   build-resources/icon.png       (512x512, App-Icon-Quelle)
 *   build-resources/icon.ico       (Multi-Size .ico für Windows-Build)
 *   build-resources/tray-active.png    (32x32, Tray "Presenter aktiv")
 *   build-resources/tray-inactive.png  (32x32, Tray "Presenter aus")
 *   build-resources/tray-active@2x.png    (64x64)
 *   build-resources/tray-inactive@2x.png  (64x64)
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- CRC32 (für PNG-Chunks) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- Minimaler PNG-Encoder ----------
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function encodePNG(rgba, width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  const rowBytes = width * 4;
  const filtered = Buffer.alloc(height * (1 + rowBytes));
  for (let y = 0; y < height; y++) {
    filtered[y * (1 + rowBytes)] = 0;
    rgba.copy(filtered, y * (1 + rowBytes) + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const idat = zlib.deflateSync(filtered, { level: 9 });
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------- ICO-Encoder (PNG-eingebettet) ----------
function encodeICO(images) {
  // images: [{ size, png: Buffer }]
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);     // reserved
  header.writeUInt16LE(1, 2);     // type: 1 = ICO
  header.writeUInt16LE(count, 4); // count

  const dirEntries = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  const dataChunks = [];
  for (let i = 0; i < count; i++) {
    const { size, png } = images[i];
    const off = i * 16;
    dirEntries[off + 0] = size >= 256 ? 0 : size; // width (0 = 256)
    dirEntries[off + 1] = size >= 256 ? 0 : size; // height
    dirEntries[off + 2] = 0; // palette
    dirEntries[off + 3] = 0; // reserved
    dirEntries.writeUInt16LE(1, off + 4);  // color planes
    dirEntries.writeUInt16LE(32, off + 6); // bpp
    dirEntries.writeUInt32LE(png.length, off + 8);
    dirEntries.writeUInt32LE(offset, off + 12);
    dataChunks.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, dirEntries, ...dataChunks]);
}

// ---------- Drawing-Helpers ----------
function makeBuffer(w, h) {
  return Buffer.alloc(w * h * 4); // alle Pixel transparent (alpha=0)
}
function setPx(buf, w, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= w) return;
  const i = (y * w + x) * 4;
  if (i < 0 || i + 3 >= buf.length) return;
  // src-over composit
  const sa = a / 255;
  const da = buf[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  buf[i + 0] = Math.round((r * sa + buf[i + 0] * da * (1 - sa)) / oa);
  buf[i + 1] = Math.round((g * sa + buf[i + 1] * da * (1 - sa)) / oa);
  buf[i + 2] = Math.round((b * sa + buf[i + 2] * da * (1 - sa)) / oa);
  buf[i + 3] = Math.round(oa * 255);
}

function drawLaser(buf, w, h, opts) {
  const cx = w / 2;
  const cy = h / 2;
  const maxR = Math.min(w, h) / 2;

  const core = opts.core;       // Kern-Farbe (rot)
  const glow = opts.glow;       // Glow-Farbe (rot, gleicher Ton)
  const rayColor = opts.rays;   // Strahlen-Farbe (oder null)
  const rayCount = opts.rayCount || 8;
  const rayPower = opts.rayPower || 24;
  const rayHalf = rayCount / 2;

  const coreR = maxR * (opts.coreScale || 0.22);
  const glowR = maxR * (opts.glowScale || 0.70);
  const rayR = maxR * (opts.rayScale || 0.96);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx + 0.5;
      const dy = y - cy + 0.5;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > rayR + 1) continue;

      // Schicht 1: Strahlen (nur außerhalb von glowR, nicht vom Glow überlagert)
      if (rayColor && d > glowR * 0.85 && d < rayR) {
        const angle = Math.atan2(dy, dx);
        const angFactor = Math.pow(Math.abs(Math.cos(rayHalf * angle)), rayPower);
        const tDist = (d - glowR * 0.85) / (rayR - glowR * 0.85);
        const distFactor = Math.pow(1 - tDist, 1.4);
        const aRay = Math.round(255 * angFactor * distFactor);
        if (aRay > 0) setPx(buf, w, x, y, rayColor[0], rayColor[1], rayColor[2], aRay);
      }

      // Schicht 2: Glow (weicher radialer Falloff, von 0 bis glowR)
      if (d <= glowR) {
        const t = d / glowR;
        // Plateau im Kern-Bereich, danach starkes Falloff
        let alpha;
        if (d <= coreR) {
          alpha = 255;
        } else {
          const tt = (d - coreR) / (glowR - coreR);
          alpha = Math.round(255 * Math.pow(1 - tt, 2.2));
        }
        if (alpha > 0) setPx(buf, w, x, y, glow[0], glow[1], glow[2], alpha);
      }

      // Schicht 3: Kern (kräftiger gefüllter Punkt)
      if (d <= coreR + 1) {
        const t = Math.min(1, d / coreR);
        const aCore = Math.round(255 * (1 - Math.pow(t, 6)));
        if (aCore > 0) setPx(buf, w, x, y, core[0], core[1], core[2], aCore);
      }

      // Schicht 4: Highlight (weißer Glanz, leicht oben-links, simuliert Lichtreflex)
      if (opts.highlight) {
        const hx = cx - coreR * 0.30;
        const hy = cy - coreR * 0.32;
        const dh = Math.sqrt((x - hx + 0.5) ** 2 + (y - hy + 0.5) ** 2);
        const hR = coreR * 0.55;
        if (dh < hR) {
          const aH = Math.round(Math.pow(1 - dh / hR, 2.2) * 230);
          if (aH > 0) setPx(buf, w, x, y, 255, 255, 255, aH);
        }
      }
    }
  }
}

// ---------- Konkrete Icons ----------
// App-Icon (256+ px): aufwändig mit Strahlen
function renderApp(size) {
  const buf = makeBuffer(size, size);
  drawLaser(buf, size, size, {
    core: [255, 90, 95],
    glow: [255, 30, 50],
    rays: [255, 70, 80],
    highlight: true,
    coreScale: 0.22,
    glowScale: 0.62,
    rayScale: 0.96
  });
  return buf;
}

// Tray-Icon: kompakter Punkt, der den ganzen verfügbaren Platz nutzt.
// In kleinen Größen (16/32px) verschwinden Strahlen + Glow im Hintergrund.
// Daher: großer gefüllter Kreis mit kräftigem Glow drumherum, dünner Highlight.
function renderTray(size, active) {
  const buf = makeBuffer(size, size);
  const cx = size / 2;
  const cy = size / 2;
  const maxR = size / 2 - 0.5;

  // Anteile ans Icon: Kern füllt etwa 60% der Fläche, Glow den Rest.
  const coreR = maxR * 0.55;
  const glowR = maxR * 0.98;

  const core = active ? [255, 70, 80]   : [150, 150, 155];
  const glow = active ? [255, 30, 50]   : [110, 110, 115];
  const high = active ? [255, 220, 220] : [220, 220, 225];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx + 0.5;
      const dy = y - cy + 0.5;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > glowR) continue;

      // Glow-Schicht (überall außerhalb des Kerns)
      if (d > coreR) {
        const t = (d - coreR) / (glowR - coreR);
        const aGlow = Math.round(220 * Math.pow(1 - t, 1.8));
        if (aGlow > 0) setPx(buf, size, x, y, glow[0], glow[1], glow[2], aGlow);
      }

      // Kern (voll gesättigt, leichtes Anti-Aliasing am Rand)
      if (d <= coreR + 0.7) {
        const aCore = Math.round(255 * Math.min(1, coreR + 0.7 - d));
        if (aCore > 0) setPx(buf, size, x, y, core[0], core[1], core[2], aCore);
      }

      // Highlight (kleiner heller Punkt oben-links, 3D-Effekt)
      const hx = cx - coreR * 0.40;
      const hy = cy - coreR * 0.42;
      const dh = Math.sqrt((x - hx + 0.5) ** 2 + (y - hy + 0.5) ** 2);
      const hR = coreR * 0.55;
      if (dh < hR) {
        const aH = Math.round(Math.pow(1 - dh / hR, 2.4) * (active ? 200 : 140));
        if (aH > 0) setPx(buf, size, x, y, high[0], high[1], high[2], aH);
      }
    }
  }

  // Inaktive: Gesamt-Opazität deutlich reduzieren — wirkt "ausgegraut"
  if (!active) {
    for (let i = 3; i < buf.length; i += 4) {
      buf[i] = Math.round(buf[i] * 0.65);
    }
  }
  return buf;
}

// ---------- Schreiben ----------
const outDir = __dirname;
function write(name, buf) {
  const p = path.join(outDir, name);
  fs.writeFileSync(p, buf);
  console.log(`  ${name}  ${buf.length.toLocaleString()} bytes`);
}

console.log('Generating icons in', outDir);

// App-Icon: in der ICO mischen wir kleine (Tray-Stil, ohne Strahlen) mit großen (App-Stil mit Strahlen).
// Bei kleinen Größen (<=48px) sehen Strahlen schlecht aus, daher dort den kompakten Look nehmen.
const appSizes = [16, 24, 32, 48, 64, 128, 256];
const appPngs = appSizes.map((s) => {
  const buf = s <= 48 ? renderTray(s, true) : renderApp(s);
  return { size: s, png: encodePNG(buf, s, s) };
});
write('icon.ico', encodeICO(appPngs));
write('icon.png', encodePNG(renderApp(512), 512, 512));

// Tray (zwei States, 16/32/64 — der Tray nutzt automatisch die passende Größe)
write('tray-active.png',      encodePNG(renderTray(32, true),  32, 32));
write('tray-active@2x.png',   encodePNG(renderTray(64, true),  64, 64));
write('tray-inactive.png',    encodePNG(renderTray(32, false), 32, 32));
write('tray-inactive@2x.png', encodePNG(renderTray(64, false), 64, 64));

console.log('Done.');
