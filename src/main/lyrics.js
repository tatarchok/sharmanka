// Lyrics lookup via LRCLIB (https://lrclib.net) — an open lyrics database with a public JSON API
// that often has time-synced (LRC) lyrics. Genius has no official API for lyrics text, so it is
// not used here. Requests run in the main process to avoid renderer CORS issues.
const { net } = require('electron');

const API_BASE = 'https://lrclib.net/api';
const USER_AGENT = 'Sharmanka/1.0 (desktop music player)';
const REQUEST_TIMEOUT_MS = 10000;
const cache = new Map();

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await net.fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Lrclib-Client': USER_AGENT },
      signal: controller.signal
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`LRCLIB HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// Strip decorations that rarely match a lyrics database entry
function cleanTitle(title) {
  return String(title || '')
    .replace(/\s*[\(\[【][^\)\]】]*(prod|feat|ft\.|remaster|official|video|audio|lyric|visuali[sz]er|hd|hq|clip|премьера|клип|speed|slowed|sped)[^\)\]】]*[\)\]】]/gi, '')
    .replace(/\s+(feat\.?|ft\.)\s+.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanArtist(artist) {
  // "A, B" / "A & B" / "A feat. B" -> first artist
  return String(artist || '').split(/\s*(?:,|&|\bfeat\.?|\bft\.|\bx\b|;)\s*/i)[0].trim();
}

function buildCandidates(artist, title) {
  const list = [];
  const push = (a, t) => {
    a = (a || '').trim();
    t = (t || '').trim();
    if (!t) return;
    const key = `${a.toLowerCase()}|${t.toLowerCase()}`;
    if (!list.some(c => c.key === key)) list.push({ key, artist: a, title: t });
  };

  push(artist, title);
  push(cleanArtist(artist), cleanTitle(title));

  // SoundCloud titles are often "Artist - Title" while the uploader is a label or channel
  const dash = String(title || '').split(/\s+[-–—]\s+/);
  if (dash.length >= 2) {
    const left = dash[0];
    const right = dash.slice(1).join(' - ');
    push(left, right);
    push(cleanArtist(left), cleanTitle(right));
  }
  return list;
}

function pickBest(results, duration) {
  const withLyrics = (results || []).filter(r => r && !r.instrumental && (r.syncedLyrics || r.plainLyrics));
  if (withLyrics.length === 0) return null;
  const score = (r) => {
    let s = 0;
    if (duration > 0 && r.duration) s += Math.abs(r.duration - duration);
    if (!r.syncedLyrics) s += 5;
    return s;
  };
  const best = withLyrics.slice().sort((a, b) => score(a) - score(b))[0];
  // Reject clearly different recordings when the duration is known
  if (duration > 0 && best.duration && Math.abs(best.duration - duration) > 15) return null;
  return best;
}

function parseSyncedLyrics(lrc) {
  if (!lrc) return [];
  const lines = [];
  lrc.split(/\r?\n/).forEach(raw => {
    const stamps = [...raw.matchAll(/\[(\d{1,2}):(\d{1,2}(?:\.\d{1,3})?)\]/g)];
    if (stamps.length === 0) return;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    stamps.forEach(m => {
      lines.push({ time: Number(m[1]) * 60 + Number(m[2]), text });
    });
  });
  return lines.sort((a, b) => a.time - b.time);
}

function toResult(record) {
  if (!record) return { found: false };
  return {
    found: true,
    source: 'LRCLIB',
    trackName: record.trackName || '',
    artistName: record.artistName || '',
    synced: parseSyncedLyrics(record.syncedLyrics),
    plain: record.plainLyrics || ''
  };
}

async function lookup({ artist, title, duration }) {
  const dur = Math.round(Number(duration) || 0);
  const candidates = buildCandidates(artist, title);

  for (const c of candidates) {
    // Exact signature match first (duration must be within ~2s on LRCLIB's side)
    if (c.artist && dur > 0) {
      const params = new URLSearchParams({ artist_name: c.artist, track_name: c.title, duration: String(dur) });
      const exact = await fetchJson(`${API_BASE}/get?${params}`).catch(() => null);
      if (exact && !exact.instrumental && (exact.syncedLyrics || exact.plainLyrics)) return exact;
    }

    const params = new URLSearchParams({ track_name: c.title });
    if (c.artist) params.set('artist_name', c.artist);
    const found = pickBest(await fetchJson(`${API_BASE}/search?${params}`).catch(() => []), dur);
    if (found) return found;
  }

  // Last resort: free-text search
  const q = `${cleanArtist(artist)} ${cleanTitle(title)}`.trim();
  if (q) {
    const found = pickBest(await fetchJson(`${API_BASE}/search?${new URLSearchParams({ q })}`).catch(() => []), dur);
    if (found) return found;
  }
  return null;
}

async function getLyrics(query) {
  const title = (query && query.title || '').trim();
  if (!title) return { found: false };
  const key = `${(query.artist || '').toLowerCase()}|${title.toLowerCase()}|${Math.round(Number(query.duration) || 0)}`;
  if (cache.has(key)) return cache.get(key);

  try {
    const result = toResult(await lookup(query));
    cache.set(key, result);
    return result;
  } catch (e) {
    // Network errors are not cached so a retry can succeed later
    return { found: false, error: e.message };
  }
}

module.exports = { getLyrics };
