// Accent color from album artwork ("цвет интерфейса из обложки").
// Runs in the main process: artwork comes from atom://, data:, file:// and remote CDNs, which
// would taint a canvas in the renderer. The image is decoded with nativeImage, downscaled,
// and the most vivid well-represented hue is picked, then tuned to read well on a dark UI.
const fs = require('fs');
const path = require('path');
const { nativeImage, net } = require('electron');

const cache = new Map();

async function loadImageBuffer(src, artCacheDir) {
  if (!src || typeof src !== 'string') return null;
  if (src.startsWith('data:')) {
    const m = src.match(/^data:[^;,]*(;base64)?,(.*)$/);
    if (!m) return null;
    return m[1] ? Buffer.from(m[2], 'base64') : Buffer.from(decodeURIComponent(m[2]));
  }
  if (src.startsWith('atom://art/')) {
    const file = decodeURI(src.replace(/^atom:\/\/art\//, '').split('?')[0]);
    const full = path.join(artCacheDir, file);
    return fs.existsSync(full) ? fs.readFileSync(full) : null;
  }
  if (src.startsWith('file://')) {
    const p = decodeURIComponent(new URL(src).pathname).replace(/^\/([a-zA-Z]:)/, '$1');
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  }
  if (/^https?:\/\//i.test(src)) {
    const res = await net.fetch(src, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  }
  return null;
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return { h, s, l };
}

function hslToHex(h, s, l) {
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const to = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
  return '#' + to(hue2rgb(p, q, h + 1 / 3)) + to(hue2rgb(p, q, h)) + to(hue2rgb(p, q, h - 1 / 3));
}

// Returns '#rrggbb' or null when the artwork has no usable color (grayscale / unreadable)
function pickAccent(bitmap, width, height) {
  // 24 hue buckets; each pixel votes with weight favouring saturated, mid-bright pixels
  const buckets = Array.from({ length: 24 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  let colorful = 0;
  const total = width * height;
  for (let i = 0; i < total; i++) {
    const b = bitmap[i * 4], g = bitmap[i * 4 + 1], r = bitmap[i * 4 + 2]; // BGRA
    const { h, s, l } = rgbToHsl(r, g, b);
    if (s < 0.22 || l < 0.12 || l > 0.9) continue;
    colorful++;
    const weight = s * s * (1 - Math.abs(l - 0.5) * 1.4);
    if (weight <= 0) continue;
    const bucket = buckets[Math.floor(h * 24) % 24];
    bucket.w += weight;
    bucket.r += r * weight;
    bucket.g += g * weight;
    bucket.b += b * weight;
  }
  if (colorful < total * 0.03) return null;

  // Merge neighbouring buckets so a hue split across a boundary still wins
  let best = -1, bestScore = 0;
  for (let i = 0; i < 24; i++) {
    const score = buckets[i].w + 0.5 * (buckets[(i + 23) % 24].w + buckets[(i + 1) % 24].w);
    if (score > bestScore) { bestScore = score; best = i; }
  }
  const bk = buckets[best];
  if (!bk || bk.w <= 0) return null;
  const { h, s } = rgbToHsl(bk.r / bk.w, bk.g / bk.w, bk.b / bk.w);
  // Readable on the dark UI: vivid enough, lightness in a comfortable band
  return hslToHex(h, Math.min(0.9, Math.max(0.5, s)), 0.62);
}

async function accentFromCover(src, artCacheDir) {
  if (!src) return null;
  if (cache.has(src)) return cache.get(src);
  let color = null;
  try {
    const buffer = await loadImageBuffer(src, artCacheDir);
    if (buffer && buffer.length) {
      const img = nativeImage.createFromBuffer(buffer);
      if (!img.isEmpty()) {
        const small = img.resize({ width: 48, height: 48, quality: 'good' });
        const { width, height } = small.getSize();
        color = pickAccent(small.toBitmap(), width, height);
      }
    }
  } catch (e) {
    color = null;
  }
  cache.set(src, color);
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return color;
}

module.exports = { accentFromCover };
